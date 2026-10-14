import {validateTrace} from './trace.js';

/** H100 SXM's SM/stack counts, with deliberately abstract routing and timings. */
export const DEFAULT_TRAFFIC_CONFIG = Object.freeze({
  numSms: 132, numClusters: 12, l2Banks: 8, hbmStacks: 5, rounds: 3,
  nocBytesPerCycle: 64, nocLatencyCycles: 8,
  hbmBytesPerCycle: 128, hbmLatencyCycles: 180,
  l2BytesPerCycle: 128, l2LatencyCycles: 12,
  sharedBytes: 4096, privateBytes: 2048, writeBytes: 1024,
  requestBytes: 32, computeCycles: 240, coalesceShared: true
});

const integerBounds = {
  numSms: [1, 256], numClusters: [1, 256], l2Banks: [1, 32], hbmStacks: [1, 16], rounds: [1, 8],
  nocBytesPerCycle: [1, 65536], nocLatencyCycles: [0, 100000],
  hbmBytesPerCycle: [1, 65536], hbmLatencyCycles: [0, 100000],
  l2BytesPerCycle: [1, 65536], l2LatencyCycles: [0, 100000],
  sharedBytes: [1, 1048576], privateBytes: [1, 1048576], writeBytes: [1, 1048576],
  requestBytes: [1, 4096], computeCycles: [1, 1000000]
};

function configuration(overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new TypeError('Traffic config must be an object.');
  for (const key of Object.keys(overrides)) if (!Object.hasOwn(DEFAULT_TRAFFIC_CONFIG, key)) throw new TypeError(`Unknown traffic parameter: ${key}`);
  const config = {...DEFAULT_TRAFFIC_CONFIG, ...overrides};
  if (overrides.numClusters == null) config.numClusters = Math.min(config.numSms, config.numClusters);
  for (const [key, [min, max]] of Object.entries(integerBounds)) {
    if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) throw new RangeError(`${key} must be an integer in [${min}, ${max}].`);
  }
  if (config.numClusters > config.numSms) throw new RangeError('numClusters cannot exceed numSms.');
  if (typeof config.coalesceShared !== 'boolean') throw new TypeError('coalesceShared must be boolean.');
  return config;
}

/** A stable min-heap. Equal-time arrivals retain their deterministic insertion order. */
class Clock {
  jobs = [];
  serial = 0;
  schedule(time, callback) {
    const item = {time, serial: this.serial++, callback};
    let index = this.jobs.length;
    this.jobs.push(item);
    while (index) {
      const parent = (index - 1) >> 1;
      if (!this.before(item, this.jobs[parent])) break;
      this.jobs[index] = this.jobs[parent]; index = parent;
    }
    this.jobs[index] = item;
  }
  before(a, b) { return a.time < b.time || (a.time === b.time && a.serial < b.serial); }
  run() {
    while (this.jobs.length) {
      const next = this.jobs[0], last = this.jobs.pop();
      if (this.jobs.length) {
        let index = 0;
        while (index * 2 + 1 < this.jobs.length) {
          let child = index * 2 + 1;
          if (child + 1 < this.jobs.length && this.before(this.jobs[child + 1], this.jobs[child])) child++;
          if (!this.before(this.jobs[child], last)) break;
          this.jobs[index] = this.jobs[child]; index = child;
        }
        this.jobs[index] = last;
      }
      next.callback(next.time);
    }
  }
}

function hash(value) {
  let n = 2166136261;
  for (let i = 0; i < value.length; i++) n = Math.imul(n ^ value.charCodeAt(i), 16777619) >>> 0;
  return n;
}

/**
 * Replays an explicit discrete-event, store-and-forward traffic model.
 * Its cycles and routes are simulated teaching parameters, not NVIDIA measurements.
 * Queue space is unbounded: contention is modeled, finite-buffer backpressure is not.
 */
export function simulateTraffic(overrides = {}) {
  const config = configuration(overrides);
  const h100Counts = config.numSms === 132 && config.hbmStacks === 5;
  const scenarioId = `gpu-city-traffic-v1-${hash(JSON.stringify(config)).toString(16)}`;
  const clock = new Clock();
  const components = [{id: 'gpu', label: 'H100 SXM · 132 SM 基准', kind: 'gpu'}];
  components[0].label = h100Counts ? 'H100 SXM · 132 SM 基准' : `教学架构 · ${config.numSms} SM / ${config.hbmStacks} HBM 端点`;
  const topology = {nodes: [], links: [], routing: 'logical cluster → shared fabric → L2 bank → HBM stack endpoint'};
  const resources = new Map(), nodes = new Map(), edges = new Map();
  const events = [];
  const traffic = {
    requests: 0, readRequests: 0, writeRequests: 0, mergedMisses: 0, l2Hits: 0,
    sharedReadRequests: 0, sharedHbmReads: 0, sharedReadSavings: 0,
    hbmReadBytes: 0, hbmWriteBytes: 0, deliveredReadBytes: 0, deliveredWriteBytes: 0,
    packets: 0, linkBytes: 0, computeTasks: 0, completedTasks: 0,
    queueWaitCycles: 0, maxQueueDepth: 0, makespan: 0
  };
  let eventSerial = 0, packetSerial = 0;
  const event = (name, componentId, start, end, dependencies, args, category = 'memory') => {
    const e = {id: `traffic:${eventSerial++}`, name, category, componentId, start, end,
      dependencies: [...new Set(dependencies)], args};
    events.push(e); return e;
  };
  function addNode(id, kind, label, extra = {}) {
    const node = {id, kind, componentId: id, ...extra};
    topology.nodes.push(node); nodes.set(id, node);
    components.push({id, kind, label, parentId: 'gpu', ...extra});
    resources.set(id, {id, queue: [], busy: false, lastEvent: null});
  }
  for (let smId = 0; smId < config.numSms; smId++) {
    const clusterId = `router-${Math.floor(smId * config.numClusters / config.numSms)}`;
    addNode(`sm-${smId}`, 'sm', `SM ${smId}`, {smId, clusterId});
    const id = `sm-${smId}-compute`;
    components.push({id, label: `SM ${smId} · tile compute`, kind: 'compute', parentId: `sm-${smId}`, smId});
    resources.set(id, {id, queue: [], busy: false, lastEvent: null});
  }
  for (let i = 0; i < config.numClusters; i++) addNode(`router-${i}`, 'router', `逻辑路由组 ${i}`, {clusterIndex: i});
  addNode('fabric', 'fabric', '共享 NoC fabric');
  for (let i = 0; i < config.l2Banks; i++) addNode(`l2-${i}`, 'l2', `L2 bank ${i}（逻辑分区）`, {bankId: i});
  for (let i = 0; i < config.hbmStacks; i++) addNode(`hbm-${i}`, 'hbm', `HBM3 stack ${i} 服务端点`, {stackId: i});
  function link(sourceId, targetId) {
    const id = `link:${sourceId}>${targetId}`;
    const edge = {id, sourceId, targetId, bytesPerCycle: config.nocBytesPerCycle, latencyCycles: config.nocLatencyCycles, capacity: 1};
    topology.links.push(edge); edges.set(`${sourceId}>${targetId}`, edge);
    components.push({id, label: `${sourceId} → ${targetId}`, kind: 'link', parentId: 'gpu'});
    resources.set(id, {id, queue: [], busy: false, lastEvent: null});
  }
  function pair(a, b) { link(a, b); link(b, a); }
  for (let smId = 0; smId < config.numSms; smId++) pair(`sm-${smId}`, nodes.get(`sm-${smId}`).clusterId);
  for (let i = 0; i < config.numClusters; i++) pair(`router-${i}`, 'fabric');
  for (let i = 0; i < config.l2Banks; i++) {
    pair('fabric', `l2-${i}`);
    pair(`l2-${i}`, `hbm-${i % config.hbmStacks}`);
  }
  // All five SXM stack endpoints must have a route, also for custom bank counts.
  for (let i = config.l2Banks; i < config.hbmStacks; i++) pair(`l2-${i % config.l2Banks}`, `hbm-${i}`);

  function enqueue(componentId, arrival, duration, name, args, dependencies, onComplete, category) {
    const resource = resources.get(componentId);
    clock.schedule(arrival, time => {
      const depth = resource.queue.length + (resource.busy ? 1 : 0);
      traffic.maxQueueDepth = Math.max(traffic.maxQueueDepth, depth);
      resource.queue.push({arrival: time, duration, name, args, dependencies, onComplete, category, queueDepth: depth});
      startResource(resource, time);
    });
  }
  function startResource(resource, time) {
    if (resource.busy || !resource.queue.length) return;
    const job = resource.queue.shift();
    let dependencies = job.dependencies;
    if (time > job.arrival) {
      const wait = event(`排队 · ${job.name}`, resource.id, job.arrival, time, dependencies,
        {...job.args, stage: 'queue', queueDepth: job.queueDepth}, 'queue');
      traffic.queueWaitCycles += time - job.arrival;
      dependencies = [wait.id];
    }
    if (resource.lastEvent) dependencies = [...dependencies, resource.lastEvent.id];
    const service = event(job.name, resource.id, time, time + job.duration, dependencies, job.args, job.category);
    resource.busy = true;
    clock.schedule(service.end, end => {
      resource.busy = false; resource.lastEvent = service;
      job.onComplete(end, service);
      startResource(resource, end);
    });
  }

  function route(originId, destinationId) {
    if (originId.startsWith('sm-') && destinationId.startsWith('l2-')) return [originId, nodes.get(originId).clusterId, 'fabric', destinationId];
    if (originId.startsWith('l2-') && destinationId.startsWith('sm-')) return [originId, 'fabric', nodes.get(destinationId).clusterId, destinationId];
    if ((originId.startsWith('l2-') && destinationId.startsWith('hbm-')) || (originId.startsWith('hbm-') && destinationId.startsWith('l2-'))) return [originId, destinationId];
    throw new Error(`No traffic route: ${originId} → ${destinationId}`);
  }
  function send(originId, destinationId, ready, baseFlow, taskArgs, dependencies, onArrive) {
    const packetId = `packet:${packetSerial++}`;
    traffic.packets++;
    const path = route(originId, destinationId);
    const visit = (hopIndex, time, deps) => {
      if (hopIndex === path.length - 1) { onArrive(time, deps[0]); return; }
      const sourceId = path[hopIndex], targetId = path[hopIndex + 1];
      const edge = edges.get(`${sourceId}>${targetId}`);
      if (!edge) throw new Error(`Missing modeled link ${sourceId} → ${targetId}`);
      const flow = {...baseFlow, packetId, sourceId, targetId, originId, destinationId};
      const args = {...taskArgs, stage: 'transfer', linkId: edge.id, hopIndex, hopCount: path.length - 1, flow};
      const duration = Math.ceil(flow.bytes / edge.bytesPerCycle) + edge.latencyCycles;
      traffic.linkBytes += flow.bytes;
      enqueue(edge.id, time, duration, `${flow.kind} · ${flow.bytes} B`, args, deps,
        (end, transfer) => visit(hopIndex + 1, end, [transfer.id]), 'transfer');
    };
    visit(0, ready, dependencies);
  }

  const pending = new Map(), cache = new Map();
  function response(waiter, ready, dataEvent) {
    const {requestId, dataKey, shared, bytes, bankId, smId, taskArgs, lookupId, onInput} = waiter;
    send(bankId, `sm-${smId}`, ready,
      {requestId, dataKey, shared, bytes, kind: 'read-response'}, taskArgs, [dataEvent, lookupId],
      (end, arrivalId) => { traffic.deliveredReadBytes += bytes; onInput(end, arrivalId); });
  }
  function load(smId, round, shared, ready, issue, onInput) {
    traffic.requests++; traffic.readRequests++;
    if (shared) traffic.sharedReadRequests++;
    const dataKey = shared ? `shared:${round}` : `tile:${round}:sm:${smId}`;
    const requestId = `read:${round}:${smId}:${shared ? 'shared' : 'private'}`;
    const bytes = shared ? config.sharedBytes : config.privateBytes;
    const bankId = `l2-${hash(dataKey) % config.l2Banks}`;
    const taskArgs = {smId, threadBlockId: round * config.numSms + smId, round, tileId: `tile:${round}:${smId}`};
    send(`sm-${smId}`, bankId, ready,
      {requestId, dataKey, shared, bytes: config.requestBytes, kind: 'read-request'}, taskArgs, [issue.id],
      (arrival, requestArrivalId) => {
        enqueue(bankId, arrival, config.l2LatencyCycles + Math.ceil(config.requestBytes / config.l2BytesPerCycle),
          'L2 lookup', {...taskArgs, stage: 'service', requestId, dataKey, shared, operation: 'lookup'}, [requestArrivalId],
          (lookupEnd, lookup) => {
            const waiter = {requestId, dataKey, shared, bytes, bankId, smId, taskArgs, lookupId: lookup.id, onInput};
            if (shared && config.coalesceShared && cache.has(dataKey)) {
              traffic.l2Hits++; response(waiter, lookupEnd, cache.get(dataKey)); return;
            }
            if (shared && config.coalesceShared && pending.has(dataKey)) {
              traffic.mergedMisses++; pending.get(dataKey).push(waiter); return;
            }
            const waiters = [waiter];
            if (shared && config.coalesceShared) pending.set(dataKey, waiters);
            if (shared) traffic.sharedHbmReads++;
            const stackId = `hbm-${Number(bankId.slice(3)) % config.hbmStacks}`;
            send(bankId, stackId, lookupEnd,
              {requestId, dataKey, shared, bytes: config.requestBytes, kind: 'read-request'}, taskArgs, [lookup.id],
              (hbmArrival, hbmRequestId) => {
                traffic.hbmReadBytes += bytes;
                enqueue(stackId, hbmArrival, config.hbmLatencyCycles + Math.ceil(bytes / config.hbmBytesPerCycle),
                  `HBM read · ${bytes} B`, {...taskArgs, stage: 'service', requestId, dataKey, shared, bytes, operation: 'read'}, [hbmRequestId],
                  (hbmEnd, read) => send(stackId, bankId, hbmEnd,
                    {requestId, dataKey, shared, bytes, kind: 'read-response'}, taskArgs, [read.id],
                    (returned, dataEvent) => {
                      if (shared && config.coalesceShared) { cache.set(dataKey, dataEvent); pending.delete(dataKey); }
                      for (const waiting of waiters) response(waiting, returned, dataEvent);
                    }));
              });
          });
      });
  }

  function store(smId, round, ready, computed, onStored) {
    traffic.requests++; traffic.writeRequests++;
    const dataKey = `output:${round}:sm:${smId}`, requestId = `write:${round}:${smId}`;
    const bankId = `l2-${hash(dataKey) % config.l2Banks}`;
    const stackId = `hbm-${Number(bankId.slice(3)) % config.hbmStacks}`;
    const taskArgs = {smId, threadBlockId: round * config.numSms + smId, round, tileId: `tile:${round}:${smId}`};
    const flow = {requestId, dataKey, shared: false, bytes: config.writeBytes, kind: 'writeback'};
    send(`sm-${smId}`, bankId, ready, flow, taskArgs, [computed.id],
      (arrival, arrivalId) => enqueue(bankId, arrival,
        config.l2LatencyCycles + Math.ceil(config.writeBytes / config.l2BytesPerCycle), 'L2 writeback',
        {...taskArgs, stage: 'service', requestId, dataKey, shared: false, bytes: config.writeBytes, operation: 'write'}, [arrivalId],
        (l2End, l2Write) => send(bankId, stackId, l2End, flow, taskArgs, [l2Write.id],
          (hbmArrival, hbmArrivalId) => enqueue(stackId, hbmArrival,
            config.hbmLatencyCycles + Math.ceil(config.writeBytes / config.hbmBytesPerCycle), 'HBM write commit',
            {...taskArgs, stage: 'service', requestId, dataKey, shared: false, bytes: config.writeBytes, operation: 'write'}, [hbmArrivalId],
            (end, committed) => {
              traffic.hbmWriteBytes += config.writeBytes; traffic.deliveredWriteBytes += config.writeBytes;
              onStored(end, committed);
            }))));
  }

  function task(smId, round, ready, priorId) {
    const taskArgs = {smId, threadBlockId: round * config.numSms + smId, round, tileId: `tile:${round}:${smId}`};
    const issue = event(`Tile ${round} · input requests`, `sm-${smId}`, ready, ready, priorId ? [priorId] : [], {...taskArgs, stage: 'issue'}, 'task');
    const inputs = [];
    const onInput = (time, id) => {
      inputs.push({time, id});
      if (inputs.length !== 2) return;
      const start = Math.max(...inputs.map(input => input.time));
      enqueue(`sm-${smId}-compute`, start, config.computeCycles, `Tile ${round} · compute`,
        {...taskArgs, stage: 'compute', inputRequestIds: [`read:${round}:${smId}:shared`, `read:${round}:${smId}:private`]},
        inputs.map(input => input.id), (end, computed) => {
          traffic.computeTasks++;
          store(smId, round, end, computed, (stored, committed) => {
            traffic.completedTasks++; traffic.makespan = Math.max(traffic.makespan, stored);
            const done = event(`Tile ${round} · complete`, `sm-${smId}`, stored, stored, [committed.id], {...taskArgs, stage: 'complete'}, 'task');
            if (round + 1 < config.rounds) task(smId, round + 1, stored, done.id);
          });
        }, 'compute');
    };
    load(smId, round, true, ready, issue, onInput);
    load(smId, round, false, ready, issue, onInput);
  }
  for (let smId = 0; smId < config.numSms; smId++) task(smId, 0, 0, null);
  clock.run();
  traffic.sharedReadSavings = traffic.sharedReadRequests - traffic.sharedHbmReads;
  events.sort((a, b) => a.start - b.start || a.end - b.end || Number(a.id.slice(8)) - Number(b.id.slice(8)));
  return validateTrace({
    schemaVersion: 1,
    meta: {
      title: h100Counts ? 'H100 SXM · 132 SM 数据流沙盘' : `教学架构 · ${config.numSms} SM / ${config.hbmStacks} HBM 数据流沙盘`, producer: 'GPU City Traffic Model', backend: 'GPU City Traffic Model',
      backendVersion: '0.1.0', scenarioId, timeDomain: `${scenarioId}:cycle`,
      evidenceKind: 'simulation', timeUnit: 'cycle', granularity: 'tile', trafficSchemaVersion: 1,
      description: '可重播的教学性离散事件模型：共享输入合并、HBM服务、逐跳NoC排队、SM计算与写回。参数化周期不是GPU实测或cycle-accurate结果。',
      capabilities: ['tile_tasks', 'memory_requests', 'noc_transfers'], config, topology,
      hardwareReference: {name: 'NVIDIA H100 SXM', smCount: 132, hbm3Stacks: 5,
        source: 'https://developer.nvidia.com/blog/nvidia-hopper-architecture-in-depth/'},
      assumptions: [
        '132 SM、5 HBM3堆栈参考H100 SXM；自定义SM数时为教学架构变体。12逻辑路由组、8 L2 bank与连线均为抽象拓扑，不代表NVIDIA物理GPC、交换网络或真实控制器数量。',
        '每SM固定分配每轮一个tile，并给该任务一个唯一逻辑CTA编号用于界面归属；shared与private输入全部返回后才能计算，写回HBM后开始下一轮。不模拟真实CTA调度、指令、warp或GEMM数值。',
        '共享key映射同一L2 bank；pending miss合并成一次HBM读取，L2返回后逐目标单播分发；这不是HBM原生广播或硬件NoC multicast。关闭合并时每请求独立读取HBM。',
        'L2仅缓存共享tile（本工作负载内无驱逐），私有输入为首次读取。tile传输为整包，不模拟cache line、coalescing或一致性协议。',
        '有向NoC链路、L2 bank、HBM stack服务端点和SM计算均为单服务FCFS资源；所有排队在实际到达时发生。fabric为理想非阻塞交换节点，仅相邻链路施加带宽约束。',
        'NoC store-and-forward每跳独占时间为ceil(bytes/bytesPerCycle)+latencyCycles；不模拟流水flit、传播与串行化重叠。',
        '等待队列无界；本版未模拟有限buffer、credit/backpressure、丢包或死锁；HBM写提交通知为零开销控制事件，不单独模拟ACK包。带宽、延迟与计算周期是可编辑教学参数，不是NVIDIA硬件校准值。'
      ]
    },
    components, events, metrics: {traffic, omittedNodes: []}
  });
}
