import {validateTrace} from './trace.js';

/** H100 SXM's SM/stack counts, with deliberately abstract routing and timings. */
export const DEFAULT_TRAFFIC_CONFIG = Object.freeze({
  numSms: 132, numClusters: 8, l2Banks: 8, hbmStacks: 5, rounds: 3,
  gridBlocks: null, threadsPerBlock: 256, registersPerThread: 64,
  sharedMemBytesPerBlock: 65536, maxResidentBlocksPerSm: 2,
  nocTopology: 'partitioned-crossbar', nocBytesPerCycle: 256, nocLatencyCycles: 8,
  crossPartitionBytesPerCycle: 512, crossPartitionLatencyCycles: 16,
  hbmBytesPerCycle: 128, hbmLatencyCycles: 180,
  l2BytesPerCycle: 256, l2LatencyCycles: 12,
  sharedBytes: 4096, privateBytes: 2048, writeBytes: 1024,
  requestBytes: 32, computeCycles: 240, coalesceShared: true
});

const integerBounds = {
  numSms: [1, 256], numClusters: [1, 256], l2Banks: [1, 32], hbmStacks: [1, 16], rounds: [1, 8],
  gridBlocks: [1, 4096], threadsPerBlock: [32, 1024], registersPerThread: [1, 255],
  sharedMemBytesPerBlock: [0, 227 * 1024], maxResidentBlocksPerSm: [1, 32],
  nocBytesPerCycle: [1, 65536], nocLatencyCycles: [0, 100000],
  crossPartitionBytesPerCycle: [1, 65536], crossPartitionLatencyCycles: [0, 100000],
  hbmBytesPerCycle: [1, 65536], hbmLatencyCycles: [0, 100000],
  l2BytesPerCycle: [1, 65536], l2LatencyCycles: [0, 100000],
  sharedBytes: [1, 1048576], privateBytes: [1, 1048576], writeBytes: [1, 1048576],
  requestBytes: [1, 4096], computeCycles: [1, 1000000]
};

function configuration(overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new TypeError('Traffic config must be an object.');
  for (const key of Object.keys(overrides)) if (!Object.hasOwn(DEFAULT_TRAFFIC_CONFIG, key)) throw new TypeError(`Unknown traffic parameter: ${key}`);
  const config = {...DEFAULT_TRAFFIC_CONFIG, ...overrides};
  if (config.gridBlocks == null) config.gridBlocks = config.numSms * config.rounds;
  if (overrides.numClusters == null) config.numClusters = Math.min(config.numSms, config.numClusters);
  for (const [key, [min, max]] of Object.entries(integerBounds)) {
    if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) throw new RangeError(`${key} must be an integer in [${min}, ${max}].`);
  }
  if (config.numClusters > config.numSms) throw new RangeError('numClusters cannot exceed numSms.');
  if (!['partitioned-crossbar', 'uniform-star'].includes(config.nocTopology)) throw new TypeError('nocTopology must be partitioned-crossbar or uniform-star.');
  if (config.nocTopology === 'partitioned-crossbar' && config.numSms > 1 && (config.numClusters < 2 || config.l2Banks < 2)) {
    throw new RangeError('Multiple-SM partitioned topology needs at least two logical router groups and L2 banks.');
  }
  if (typeof config.coalesceShared !== 'boolean') throw new TypeError('coalesceShared must be boolean.');
  if (config.threadsPerBlock % 32 !== 0) throw new RangeError('threadsPerBlock must be a multiple of 32 in this teaching model.');
  if (!trafficResidency(config).residentBlockLimit) throw new RangeError('Per-block resources exceed one SM; no CTA can be resident.');
  return config;
}

/** Hopper's public limits bound a deliberately simplified occupancy calculation.
 * Register allocation granularity and the real driver launch policy are omitted. */
export function trafficResidency(config) {
  const warpsPerBlock = config.threadsPerBlock / 32;
  const limits = {configured: config.maxResidentBlocksPerSm, blocks: 32,
    warps: Math.floor(64 / warpsPerBlock),
    registers: Math.floor(65536 / (config.threadsPerBlock * config.registersPerThread)),
    sharedMemory: Math.floor((228 * 1024) / (config.sharedMemBytesPerBlock + 1024))};
  const residentBlockLimit = Math.min(...Object.values(limits));
  return {warpsPerBlock, limits, residentBlockLimit,
    maxResidentWarpsPerSm: residentBlockLimit * warpsPerBlock,
    occupancyUpperBound: residentBlockLimit * warpsPerBlock / 64,
    hardwareLimits: {warpsPerSm: 64, registers32BitPerSm: 65536, blocksPerSm: 32,
      sharedBytesPerSm: 228 * 1024, reservedSharedBytesPerBlock: 1024},
    calculation: 'resource-count upper bound; register allocation granularity and real scheduling omitted',
    source: 'https://docs.nvidia.com/cuda/hopper-tuning-guide/index.html#occupancy'};
}

/** Pure snapshot of CTA residency, separate from instantaneous compute activity.
 * SM counts for compute/ready/wait overlap when different CTAs share one SM.
 * State precedence is compute > ready > memory-wait > idle. */
export function trafficSmSnapshot(trace, time) {
  if (!Number.isFinite(time)) throw new RangeError('Traffic snapshot time must be finite.');
  const sms = (trace.meta?.topology?.nodes ?? []).filter(node => node.kind === 'sm')
    .map(node => ({smId: node.smId, componentId: node.componentId ?? node.id,
      state: 'idle', residentBlocks: 0, computingBlocks: 0, readyBlocks: 0,
      waitingBlocks: 0, inputWaitingBlocks: 0, outputWaitingBlocks: 0}));
  const bySm = new Map(sms.map(sm => [sm.smId, sm]));
  const blocks = trace.meta?.scheduling?.blocks ?? legacyBlockLifetimes(trace);
  let pendingBlocks = 0, completedBlocks = 0, committedBlocks = 0, residentBlocks = 0;
  for (const block of blocks) {
    if (block.start > time) { pendingBlocks++; continue; }
    if (block.retired <= time) completedBlocks++;
    if (block.committed <= time) committedBlocks++;
    if (!(block.start <= time && time < block.retired)) continue;
    const sm = bySm.get(block.smId); if (!sm) continue;
    sm.residentBlocks++; residentBlocks++;
    if (block.computeStart <= time && time < block.computeEnd) sm.computingBlocks++;
    else if (time < block.inputsReady) { sm.waitingBlocks++; sm.inputWaitingBlocks++; }
    else if (time < block.computeStart) sm.readyBlocks++;
    else { sm.waitingBlocks++; sm.outputWaitingBlocks++; }
  }
  for (const sm of sms) sm.state = sm.computingBlocks ? 'compute' : sm.readyBlocks ? 'ready'
    : sm.residentBlocks ? 'memory-wait' : 'idle';
  return {sms, residentBlocks, pendingBlocks, completedBlocks, committedBlocks,
    residentSms: sms.filter(sm => sm.residentBlocks).length,
    computingSms: sms.filter(sm => sm.computingBlocks).length,
    readySms: sms.filter(sm => sm.readyBlocks).length,
    waitingSms: sms.filter(sm => sm.waitingBlocks).length,
    memoryOnlySms: sms.filter(sm => sm.state === 'memory-wait').length,
    idleSms: sms.filter(sm => !sm.residentBlocks).length,
    totalBlocks: blocks.length,
    residentBlockLimit: trace.meta?.scheduling?.residentBlockLimit ?? 1};
}

function legacyBlockLifetimes(trace) {
  const blocks = new Map();
  for (const event of trace.events ?? []) {
    const {threadBlockId, smId, stage} = event.args ?? {};
    if (threadBlockId == null || smId == null) continue;
    if (!blocks.has(threadBlockId)) blocks.set(threadBlockId, {threadBlockId, smId,
      start: Infinity, inputsReady: Infinity, computeStart: Infinity, computeEnd: Infinity,
      retired: Infinity, committed: Infinity});
    const block = blocks.get(threadBlockId);
    if (stage === 'issue') block.start = event.start;
    if (stage === 'compute') { block.inputsReady = event.start; block.computeStart = event.start; block.computeEnd = event.end; }
    if (stage === 'complete') { block.retired = event.end; block.committed = event.end; }
  }
  return [...blocks.values()];
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
  const residency = trafficResidency(config), blocks = [];
  const h100Counts = config.numSms === 132 && config.hbmStacks === 5;
  const scenarioId = `gpu-city-traffic-v4-${hash(JSON.stringify(config)).toString(16)}`;
  const clock = new Clock();
  const components = [{id: 'gpu', label: 'H100 SXM · 132 SM 基准', kind: 'gpu'}];
  components[0].label = h100Counts ? 'H100 SXM · 132 SM 基准' : `教学架构 · ${config.numSms} SM / ${config.hbmStacks} HBM 端点`;
  const partitioned = config.nocTopology === 'partitioned-crossbar';
  const partitionCount = partitioned ? 2 : 1;
  const partitionOf = (ordinal, count) => partitioned ? Math.floor(ordinal * 2 / count) : 0;
  const fabricFor = partitionId => partitioned ? `fabric-${partitionId}` : 'fabric';
  const topology = {nodes: [], links: [], kind: config.nocTopology, partitionCount,
    routing: partitioned ? 'SM → local logical router → local crossbar → local L2; miss → home HBM, directed bridge if remote' : 'logical cluster → shared fabric → L2 bank → HBM stack endpoint',
    partitionMapping: 'ordinal halves are a teaching assignment, not a recovered NVIDIA GPC/L2/HBM physical mapping'};
  const resources = new Map(), nodes = new Map(), edges = new Map();
  const events = [];
  const traffic = {
    requests: 0, readRequests: 0, writeRequests: 0, mergedMisses: 0, l2Hits: 0,
    sharedReadRequests: 0, sharedHbmReads: 0, sharedReadSavings: 0,
    hbmReadBytes: 0, hbmWriteBytes: 0, deliveredReadBytes: 0, deliveredWriteBytes: 0,
    packets: 0, linkBytes: 0, computeTasks: 0, completedTasks: 0,
    queueWaitCycles: 0, maxQueueDepth: 0, makespan: 0
  };
  Object.assign(traffic, {bridgeTransfers: 0, bridgeBytes: 0, localHbmReads: 0, remoteHbmReads: 0,
    sharedHbmReadsByPartition: Array(partitionCount).fill(0),
    bridgeQueueWaitCycles: 0, l2QueueWaitCycles: 0, hbmQueueWaitCycles: 0,
    linkSerializationCycles: 0, linkPropagationCycles: 0, l2OccupancyCycles: 0, hbmOccupancyCycles: 0});
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
    const partitionId = partitionOf(smId, config.numSms);
    const candidates = Array.from({length: config.numClusters}, (_, i) => i).filter(i => partitionOf(i, config.numClusters) === partitionId);
    const localSms = Array.from({length: config.numSms}, (_, i) => i).filter(i => partitionOf(i, config.numSms) === partitionId);
    const localOrdinal = localSms.indexOf(smId);
    const clusterIndex = candidates[Math.floor(localOrdinal * candidates.length / localSms.length)];
    const clusterId = `router-${clusterIndex}`;
    addNode(`sm-${smId}`, 'sm', `SM ${smId}`, {smId, clusterId, partitionId});
    const id = `sm-${smId}-compute`;
    components.push({id, label: `SM ${smId} · tile compute`, kind: 'compute', parentId: `sm-${smId}`, smId});
    resources.set(id, {id, queue: [], busy: false, lastEvent: null});
  }
  for (let i = 0; i < config.numClusters; i++) addNode(`router-${i}`, 'router', `逻辑路由组 ${i}`, {clusterIndex: i, partitionId: partitionOf(i, config.numClusters)});
  for (let partitionId = 0; partitionId < partitionCount; partitionId++) addNode(fabricFor(partitionId), 'fabric', partitioned ? `NoC 分区 ${partitionId} · 逻辑交叉开关` : '共享 NoC fabric', {partitionId});
  for (let i = 0; i < config.l2Banks; i++) addNode(`l2-${i}`, 'l2', `L2 bank ${i}（逻辑端点）`, {bankId: i, partitionId: partitionOf(i, config.l2Banks)});
  for (let i = 0; i < config.hbmStacks; i++) addNode(`hbm-${i}`, 'hbm', `HBM3 stack ${i} 服务端点`, {stackId: i, partitionId: partitionOf(i, config.hbmStacks)});
  function link(sourceId, targetId, bridge = false) {
    const id = `link:${sourceId}>${targetId}`;
    const edge = {id, sourceId, targetId,
      bytesPerCycle: bridge ? config.crossPartitionBytesPerCycle : config.nocBytesPerCycle,
      latencyCycles: bridge ? config.crossPartitionLatencyCycles : config.nocLatencyCycles,
      capacity: 1, occupancy: 'serialization-only', bridge,
      sourcePartitionId: nodes.get(sourceId).partitionId, targetPartitionId: nodes.get(targetId).partitionId};
    topology.links.push(edge); edges.set(`${sourceId}>${targetId}`, edge);
    components.push({id, label: `${sourceId} → ${targetId}`, kind: 'link', parentId: 'gpu'});
    resources.set(id, {id, queue: [], busy: false, lastEvent: null});
  }
  function pair(a, b, bridge = false) { link(a, b, bridge); link(b, a, bridge); }
  for (let smId = 0; smId < config.numSms; smId++) pair(`sm-${smId}`, nodes.get(`sm-${smId}`).clusterId);
  for (let i = 0; i < config.numClusters; i++) pair(`router-${i}`, fabricFor(nodes.get(`router-${i}`).partitionId));
  for (let i = 0; i < config.l2Banks; i++) {
    pair(fabricFor(nodes.get(`l2-${i}`).partitionId), `l2-${i}`);
    if (!partitioned) pair(`l2-${i}`, `hbm-${i % config.hbmStacks}`);
  }
  if (partitioned) {
    pair('fabric-0', 'fabric-1', true);
    for (let i = 0; i < config.hbmStacks; i++) pair(fabricFor(nodes.get(`hbm-${i}`).partitionId), `hbm-${i}`);
  } else {
    // All stack endpoints need a route, also for custom bank counts.
    for (let i = config.l2Banks; i < config.hbmStacks; i++) pair(`l2-${i % config.l2Banks}`, `hbm-${i}`);
  }

  function enqueue(componentId, arrival, duration, name, args, dependencies, onComplete, category, occupancyDuration = duration) {
    const resource = resources.get(componentId);
    clock.schedule(arrival, time => {
      const depth = resource.queue.length + (resource.busy ? 1 : 0);
      traffic.maxQueueDepth = Math.max(traffic.maxQueueDepth, depth);
      resource.queue.push({arrival: time, duration, occupancyDuration, name, args, dependencies, onComplete, category, queueDepth: depth});
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
      if (resource.id.startsWith('link:') && edges.get(resource.id.slice(5))?.bridge) traffic.bridgeQueueWaitCycles += time - job.arrival;
      if (resource.id.startsWith('l2-')) traffic.l2QueueWaitCycles += time - job.arrival;
      if (resource.id.startsWith('hbm-')) traffic.hbmQueueWaitCycles += time - job.arrival;
      dependencies = [wait.id];
    }
    const issueDependencies = [];
    if (resource.lastEvent) {
      if (job.args.stage === 'transfer' || resource.lastEvent.args?.issueReleaseCycle < resource.lastEvent.end) issueDependencies.push(resource.lastEvent.id);
      else dependencies = [...dependencies, resource.lastEvent.id];
    }
    const service = event(job.name, resource.id, time, time + job.duration, dependencies,
      {...job.args, ...((job.args.stage === 'transfer' || job.occupancyDuration < job.duration) ? {
        issueReleaseCycle: time + job.occupancyDuration,
        ...(job.args.stage === 'transfer' ? {serializationCycles: job.occupancyDuration, propagationCycles: job.duration - job.occupancyDuration} :
          {serviceOccupancyCycles: job.occupancyDuration, fixedLatencyCycles: job.duration - job.occupancyDuration}),
        ...(issueDependencies.length ? {issueDependencies} : {})
      } : {})}, job.category);
    if (resource.id.startsWith('l2-')) traffic.l2OccupancyCycles += job.occupancyDuration;
    if (resource.id.startsWith('hbm-')) traffic.hbmOccupancyCycles += job.occupancyDuration;
    resource.busy = true;
    clock.schedule(time + job.occupancyDuration, released => {
      resource.busy = false; resource.lastEvent = service;
      if (job.occupancyDuration === job.duration) job.onComplete(released, service);
      startResource(resource, released);
    });
    if (job.occupancyDuration < job.duration) clock.schedule(service.end, end => job.onComplete(end, service));
  }

  const adjacency = new Map([...nodes.keys()].map(id => [id, []]));
  for (const edge of topology.links) adjacency.get(edge.sourceId).push(edge.targetId);
  const routes = new Map();
  function route(originId, destinationId) {
    const key = `${originId}>${destinationId}`;
    if (routes.has(key)) return routes.get(key);
    const parents = new Map([[originId, null]]), queue = [originId];
    for (let i = 0; i < queue.length && !parents.has(destinationId); i++) {
      for (const next of adjacency.get(queue[i])) {
        if (parents.has(next)) continue;
        parents.set(next, queue[i]); queue.push(next);
      }
    }
    if (!parents.has(destinationId)) throw new Error(`No traffic route: ${originId} → ${destinationId}`);
    const path = [];
    for (let current = destinationId; current != null; current = parents.get(current)) path.push(current);
    path.reverse(); routes.set(key, path); return path;
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
      const flow = {...baseFlow, packetId, sourceId, targetId, originId, destinationId,
        originPartitionId: nodes.get(originId).partitionId, destinationPartitionId: nodes.get(destinationId).partitionId};
      const args = {...taskArgs, stage: 'transfer', linkId: edge.id, hopIndex, hopCount: path.length - 1, flow};
      const serialization = Math.ceil(flow.bytes / edge.bytesPerCycle), duration = serialization + edge.latencyCycles;
      traffic.linkBytes += flow.bytes;
      traffic.linkSerializationCycles += serialization; traffic.linkPropagationCycles += edge.latencyCycles;
      if (edge.bridge) { traffic.bridgeTransfers++; traffic.bridgeBytes += flow.bytes; }
      enqueue(edge.id, time, duration, `${flow.kind} · ${flow.bytes} B`, args, deps,
        (end, transfer) => visit(hopIndex + 1, end, [transfer.id]), 'transfer', serialization);
    };
    visit(0, ready, dependencies);
  }

  const pending = new Map(), cache = new Map();
  function bankFor(smId, key) {
    const local = partitioned ? topology.nodes.filter(n => n.kind === 'l2' && n.partitionId === nodes.get(`sm-${smId}`).partitionId) :
      topology.nodes.filter(n => n.kind === 'l2');
    return local[hash(key) % local.length].id;
  }
  function stackFor(key, bankId) {
    return `hbm-${partitioned ? hash(key) % config.hbmStacks : Number(bankId.slice(3)) % config.hbmStacks}`;
  }
  function response(waiter, ready, dataEvent) {
    const {requestId, dataKey, shared, bytes, bankId, smId, taskArgs, lookupId, onInput} = waiter;
    send(bankId, `sm-${smId}`, ready,
      {requestId, dataKey, shared, bytes, kind: 'read-response'}, taskArgs, [dataEvent, lookupId],
      (end, arrivalId) => { traffic.deliveredReadBytes += bytes; onInput(end, arrivalId); });
  }
  function load(taskArgs, shared, ready, issue, onInput) {
    const {smId, round, threadBlockId} = taskArgs;
    traffic.requests++; traffic.readRequests++;
    if (shared) traffic.sharedReadRequests++;
    const dataKey = shared ? `shared:${round}` : `tile:${threadBlockId}`;
    const requestId = `read:${threadBlockId}:${shared ? 'shared' : 'private'}`;
    const bytes = shared ? config.sharedBytes : config.privateBytes;
    const bankId = bankFor(smId, dataKey), cacheKey = `${bankId}/${dataKey}`;
    send(`sm-${smId}`, bankId, ready,
      {requestId, dataKey, shared, bytes: config.requestBytes, kind: 'read-request'}, taskArgs, [issue.id],
      (arrival, requestArrivalId) => {
        enqueue(bankId, arrival, config.l2LatencyCycles + Math.ceil(config.requestBytes / config.l2BytesPerCycle),
          'L2 lookup', {...taskArgs, stage: 'service', requestId, dataKey, shared, operation: 'lookup'}, [requestArrivalId],
          (lookupEnd, lookup) => {
            const waiter = {requestId, dataKey, shared, bytes, bankId, smId, taskArgs, lookupId: lookup.id, onInput};
            if (shared && config.coalesceShared && cache.has(cacheKey)) {
              lookup.args.cacheOutcome = 'hit';
              traffic.l2Hits++; response(waiter, lookupEnd, cache.get(cacheKey)); return;
            }
            if (shared && config.coalesceShared && pending.has(cacheKey)) {
              lookup.args.cacheOutcome = 'merged-miss';
              traffic.mergedMisses++; pending.get(cacheKey).push(waiter); return;
            }
            const waiters = [waiter];
            lookup.args.cacheOutcome = 'miss';
            if (shared && config.coalesceShared) pending.set(cacheKey, waiters);
            if (shared) { traffic.sharedHbmReads++; traffic.sharedHbmReadsByPartition[nodes.get(bankId).partitionId]++; }
            const stackId = stackFor(dataKey, bankId);
            if (nodes.get(bankId).partitionId === nodes.get(stackId).partitionId) traffic.localHbmReads++;
            else traffic.remoteHbmReads++;
            send(bankId, stackId, lookupEnd,
              {requestId, dataKey, shared, bytes: config.requestBytes, kind: 'read-request'}, taskArgs, [lookup.id],
              (hbmArrival, hbmRequestId) => {
                traffic.hbmReadBytes += bytes;
                enqueue(stackId, hbmArrival, config.hbmLatencyCycles + Math.ceil(bytes / config.hbmBytesPerCycle),
                  `HBM read · ${bytes} B`, {...taskArgs, stage: 'service', requestId, dataKey, shared, bytes, operation: 'read'}, [hbmRequestId],
                  (hbmEnd, read) => send(stackId, bankId, hbmEnd,
                    {requestId, dataKey, shared, bytes, kind: 'read-response'}, taskArgs, [read.id],
                    (returned, dataEvent) => {
                      if (shared && config.coalesceShared) { cache.set(cacheKey, dataEvent); pending.delete(cacheKey); }
                      for (const waiting of waiters) response(waiting, returned, dataEvent);
                    }), 'memory', Math.ceil(bytes / config.hbmBytesPerCycle));
              });
          }, 'memory', Math.ceil(config.requestBytes / config.l2BytesPerCycle));
      });
  }

  function store(taskArgs, ready, computed, onAccepted, onStored) {
    const {smId, threadBlockId} = taskArgs;
    traffic.requests++; traffic.writeRequests++;
    const dataKey = `output:${threadBlockId}`, requestId = `write:${threadBlockId}`;
    const bankId = bankFor(smId, dataKey);
    const stackId = stackFor(dataKey, bankId);
    const flow = {requestId, dataKey, shared: false, bytes: config.writeBytes, kind: 'writeback'};
    send(`sm-${smId}`, bankId, ready, flow, taskArgs, [computed.id],
      (arrival, arrivalId) => enqueue(bankId, arrival,
        config.l2LatencyCycles + Math.ceil(config.writeBytes / config.l2BytesPerCycle), 'L2 writeback',
        {...taskArgs, stage: 'service', requestId, dataKey, shared: false, bytes: config.writeBytes, operation: 'write'}, [arrivalId],
        (l2End, l2Write) => {
          // Accept into the modeled L2 write path before releasing the CTA. The
          // downstream write keeps its causal chain and may commit much later.
          send(bankId, stackId, l2End, flow, taskArgs, [l2Write.id],
            (hbmArrival, hbmArrivalId) => enqueue(stackId, hbmArrival,
              config.hbmLatencyCycles + Math.ceil(config.writeBytes / config.hbmBytesPerCycle), 'HBM write commit',
              {...taskArgs, stage: 'service', requestId, dataKey, shared: false, bytes: config.writeBytes, operation: 'write'}, [hbmArrivalId],
              (end, committed) => {
                traffic.hbmWriteBytes += config.writeBytes; traffic.deliveredWriteBytes += config.writeBytes;
                onStored(end, committed);
              }, 'memory', Math.ceil(config.writeBytes / config.hbmBytesPerCycle)));
          onAccepted(l2End, l2Write);
        }, 'memory', Math.ceil(config.writeBytes / config.l2BytesPerCycle)));
  }

  let nextBlock = 0;
  const occupied = Array(config.numSms).fill(0);
  function dispatch(smId, ready, priorId = null) {
    if (nextBlock === config.gridBlocks || occupied[smId] === residency.residentBlockLimit) return;
    const threadBlockId = nextBlock++, round = Math.floor(threadBlockId / config.numSms);
    occupied[smId]++;
    const taskArgs = {smId, threadBlockId, round, tileId: `tile:${threadBlockId}`};
    const block = {threadBlockId, smId, start: ready}; blocks.push(block);
    const issue = event(`CTA ${threadBlockId} · input requests`, `sm-${smId}`, ready, ready, priorId ? [priorId] : [], {...taskArgs, stage: 'issue'}, 'task');
    const inputs = [];
    const onInput = (time, id) => {
      inputs.push({time, id});
      if (inputs.length !== 2) return;
      const start = Math.max(...inputs.map(input => input.time));
      block.inputsReady = start;
      event(`CTA ${threadBlockId} · waiting for input`, `sm-${smId}`, ready, start, [issue.id],
        {...taskArgs, stage: 'memory-wait', phase: 'input'}, 'scheduling');
      enqueue(`sm-${smId}-compute`, start, config.computeCycles, `CTA ${threadBlockId} · compute`,
        {...taskArgs, stage: 'compute', inputRequestIds: [`read:${threadBlockId}:shared`, `read:${threadBlockId}:private`]},
        inputs.map(input => input.id), (end, computed) => {
          traffic.computeTasks++;
          block.computeStart = computed.start; block.computeEnd = end;
          store(taskArgs, end, computed, (accepted, l2Write) => {
            block.retired = accepted;
            const retired = event(`CTA ${threadBlockId} · retire`, `sm-${smId}`, accepted, accepted,
              [l2Write.id], {...taskArgs, stage: 'retire', completionScope: 'output-accepted-by-l2'}, 'task');
            event(`CTA ${threadBlockId} · resident`, `sm-${smId}`, ready, accepted, [issue.id],
              {...taskArgs, stage: 'resident', threads: config.threadsPerBlock,
                warps: residency.warpsPerBlock, inputsReadyCycle: start,
                computeStartCycle: computed.start, computeEndCycle: end}, 'residency');
            event(`CTA ${threadBlockId} · output acceptance wait`, `sm-${smId}`, end, accepted, [computed.id],
              {...taskArgs, stage: 'memory-wait', phase: 'output'}, 'scheduling');
            occupied[smId]--;
            dispatch(smId, accepted, retired.id);
          }, (stored, committed) => {
            block.committed = stored;
            traffic.completedTasks++; traffic.makespan = Math.max(traffic.makespan, stored);
            event(`CTA ${threadBlockId} · output committed`, `sm-${smId}`, stored, stored, [committed.id],
              {...taskArgs, stage: 'complete', completionScope: 'output-committed-to-hbm'}, 'task');
          });
        }, 'compute');
    };
    load(taskArgs, true, ready, issue, onInput);
    load(taskArgs, false, ready, issue, onInput);
  }
  // Spread the first CTA across SMs before filling second and later slots.
  // This deterministic work-conserving policy is not NVIDIA's launch order.
  for (let slot = 0; slot < residency.residentBlockLimit; slot++) {
    for (let smId = 0; smId < config.numSms; smId++) dispatch(smId, 0);
  }
  clock.run();
  traffic.sharedReadSavings = traffic.sharedReadRequests - traffic.sharedHbmReads;
  events.sort((a, b) => a.start - b.start || a.end - b.end || Number(a.id.slice(8)) - Number(b.id.slice(8)));
  return validateTrace({
    schemaVersion: 1,
    meta: {
      title: h100Counts ? 'H100 SXM · 132 SM 数据流沙盘' : `教学架构 · ${config.numSms} SM / ${config.hbmStacks} HBM 数据流沙盘`, producer: 'GPU City Traffic Model', backend: 'GPU City Traffic Model',
      backendVersion: '0.4.0', scenarioId, timeDomain: `${scenarioId}:cycle`,
      evidenceKind: 'simulation', timeUnit: 'cycle', granularity: 'tile', trafficSchemaVersion: 1,
      description: '可重播的教学性离散事件模型：分区内L2共享输入合并、独立HBM home、跨分区桥、逐跳串行化/传播分离、SM计算与写回。参数化周期不是GPU实测或cycle-accurate结果。',
      capabilities: ['tile_tasks', 'cta_residency', 'memory_requests', 'noc_transfers'], config, topology,
      scheduling: {...residency, gridBlocks: config.gridBlocks,
        dispatchPolicy: 'deterministic spread-first, refill the freed SM slot from a global CTA queue',
        launchTiming: 'initial resident set starts at model cycle 0; real launch ramp is not modeled',
        completionScope: 'CTA retires after modeled L2 output acceptance; HBM commit is tracked separately',
        stateIntervals: '[start, retired); compute, ready and memory wait are separate CTA phases', blocks},
      hardwareReference: {name: 'NVIDIA H100 SXM', smCount: 132, hbm3Stacks: 5,
        source: 'https://developer.nvidia.com/blog/nvidia-hopper-architecture-in-depth/'},
      nocModel: {topologyProfile: config.nocTopology, evidence: 'H100-inspired topology; teaching routing/timing, not recovered physical netlist',
        packetGranularity: 'whole tile packets', forwarding: 'store-and-forward after packet tail arrival',
        linkOccupancy: 'serialization only: ceil(bytes/bytesPerCycle)', linkArrival: 'start + serialization + propagation',
        l2Service: 'pipelined fixed lookup/write latency; serializer occupancy = ceil(bytes/l2BytesPerCycle)',
        hbmService: 'pipelined aggregate teaching endpoint; fixed hbmLatency + ceil(bytes/hbmBytesPerCycle); serializer occupancy excludes fixed latency; no DRAM banks/commands',
        nominalL2PortBudget: config.l2Banks * config.nocBytesPerCycle,
        nominalHbmPortBudget: config.hbmStacks * config.hbmBytesPerCycle,
        nominalBudgetRatio: config.l2Banks * config.nocBytesPerCycle / (config.hbmStacks * config.hbmBytesPerCycle),
        latencyCalibration: 'none; published total L2 RTT is not assigned to every hop',
        cachePolicy: 'ideal whole-tile shared-input cache and pending merge keyed by local bank and data key; no sector/MSHR limit'},
      assumptions: [
        '132 SM、5 HBM3堆栈参考H100 SXM；自定义SM数时为教学架构变体。默认8逻辑路由组、8 L2 bank是教学聚合端点，本运行数量以config为准；不是物理GPC/80个L2 slice/真实控制器数量。双partition的ordinal分半是教学映射，不是NVIDIA物理netlist。',
        '全局grid中的每CTA对应一个tile；按spread-first教学策略占用SM驻留槽，空槽即时补派。资源上限参考Hopper的warp/register/shared-memory容量，但未模拟register分配粒度、真实派发顺序或launch ramp；初始驻留集合在模型cycle 0派发，不保证真实GPU同周期启动。',
        'shared与private输入全部返回后才能计算；同SM多CTA共享一个tile级计算服务端点，可隐藏部分等待，不模拟逐warp发射。CTA在输出被L2路径接受后退休释放槽，不等待HBM写提交；HBM提交单独统计，未实现CUDA fence、atomic或跨CTA同步/GEMM数值。',
        'partitioned-crossbar下请求选择本partition内L2 bank；shared缓存/pending按(bankId,dataKey)合并，各partition独立fill；HBMhome由dataKey独立hash，远端miss经bridge。uniform-star保留单fabric全芯片key映射。返回逐目标单播，这不是HBM原生广播或硬件NoC multicast。',
        'L2仅缓存共享tile（本工作负载内无驱逐），私有输入为首次读取。tile传输为整包，不模拟cache line、coalescing或一致性协议。',
        '有向NoC链路是单注入FCFS serializer；传播中的包不阻塞下一包注入。L2与HBM端点按序接收，固定服务latency可在途重叠，字节串行化资源提前释放；HBM为聚合吞吐教学端点，未执行DRAM bank/命令或实机时序。所有排队在实际到达时发生，fabric是理想非阻塞交叉开关。',
        'NoC每跳占用ceil(bytes/bytesPerCycle)，尾包到达再加latencyCycles；下跳等尾包才启动，是packet store-and-forward而非flit/wormhole。issueReleaseCycle保留串行化释放点，完成依赖仍等真实尾包到达。',
        '默认8×256 B/cycle与5×128 B/cycle的3.2倍是名义端口budget参数层级；不能据此声称达到真实峰值或拟合MICRO论文。总L2 RTT绝不直接当每hop延迟。',
        '等待队列无界；本版未模拟有限buffer、credit/backpressure、丢包或死锁；HBM写提交通知为零开销控制事件，不单独模拟ACK包。带宽、延迟与计算周期是可编辑教学参数，不是NVIDIA硬件校准值。'
      ]
    },
    components, events, metrics: {traffic, omittedNodes: []}
  });
}
