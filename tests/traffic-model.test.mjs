import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_TRAFFIC_CONFIG, simulateTraffic, trafficResidency, trafficSmSnapshot} from '../lib/traffic-model.js';
import {validateTrace} from '../lib/trace.js';
import {validateTrafficTrace} from '../lib/traffic-contract.js';

const baseline = simulateTraffic();
const transfers = trace => trace.events.filter(e => e.args.stage === 'transfer');
const endpointPackets = trace => transfers(trace).filter(e => e.args.hopIndex === e.args.hopCount - 1);
const small = {numSms: 12, numClusters: 3, l2Banks: 3, hbmStacks: 2, rounds: 2};

test('default traffic uses all 132 SMs and five H100 SXM stack endpoints, with honest model provenance', () => {
  assert.equal(DEFAULT_TRAFFIC_CONFIG.numSms, 132);
  assert.equal(baseline.meta.config.hbmStacks, 5);
  assert.equal(baseline.meta.backend, 'GPU City Traffic Model');
  assert.equal(baseline.meta.evidenceKind, 'simulation');
  assert.equal(baseline.meta.granularity, 'tile');
  assert.equal(baseline.meta.trafficSchemaVersion, 1);
  assert.equal(baseline.meta.topology.nodes.filter(n => n.kind === 'sm').length, 132);
  assert.equal(baseline.meta.topology.nodes.filter(n => n.kind === 'hbm').length, 5);
  assert.equal(baseline.meta.topology.nodes.filter(n => n.kind === 'router').length, 8);
  assert.equal(baseline.meta.topology.nodes.filter(n => n.kind === 'fabric').length, 2);
  assert.equal(baseline.meta.topology.links.filter(l => l.bridge).length, 2);
  assert.equal(baseline.meta.nocModel.nominalBudgetRatio, 3.2);
  assert.equal(baseline.metrics.traffic.completedTasks, 132 * 3);
  assert.equal(new Set(baseline.events.filter(e => e.args.stage === 'complete').map(e => e.args.threadBlockId)).size, 132 * 3);
  assert.deepEqual(new Set(baseline.events.filter(e => e.args.stage === 'complete').map(e => e.args.smId)), new Set(Array.from({length: 132}, (_, i) => i)));
  assert.ok(baseline.meta.assumptions.some(s => s.includes('等待队列无界')));
  assert.ok(baseline.meta.assumptions.some(s => s.includes('不是HBM原生广播')));
  assert.equal(validateTrace(baseline), baseline);
  assert.equal(validateTrafficTrace(baseline), baseline);
});

test('read requests, returned data, and write commits conserve endpoint bytes', () => {
  const {config} = baseline.meta, stats = baseline.metrics.traffic;
  const tasks = config.numSms * config.rounds;
  const packets = endpointPackets(baseline);
  const smRequests = packets.filter(e => e.args.flow.kind === 'read-request' && e.args.flow.originId.startsWith('sm-'));
  const smResponses = packets.filter(e => e.args.flow.kind === 'read-response' && e.args.flow.destinationId.startsWith('sm-'));
  assert.equal(smRequests.length, tasks * 2);
  assert.equal(new Set(smRequests.map(e => e.args.flow.requestId)).size, tasks * 2);
  assert.deepEqual(new Set(smResponses.map(e => e.args.flow.requestId)), new Set(smRequests.map(e => e.args.flow.requestId)));
  assert.equal(smResponses.length, tasks * 2);
  assert.equal(smResponses.reduce((sum, e) => sum + e.args.flow.bytes, 0), tasks * (config.sharedBytes + config.privateBytes));
  assert.equal(stats.deliveredReadBytes, tasks * (config.sharedBytes + config.privateBytes));
  const reads = baseline.events.filter(e => e.args.stage === 'service' && e.args.operation === 'read' && e.componentId.startsWith('hbm-'));
  assert.equal(reads.length, tasks + config.rounds * 2);
  assert.equal(reads.reduce((sum, e) => sum + e.args.bytes, 0), stats.hbmReadBytes);
  assert.equal(stats.hbmReadBytes, tasks * config.privateBytes + config.rounds * 2 * config.sharedBytes);
  const committed = baseline.events.filter(e => e.args.stage === 'service' && e.args.operation === 'write' && e.componentId.startsWith('hbm-'));
  assert.equal(committed.length, tasks);
  assert.equal(committed.reduce((sum, e) => sum + e.args.bytes, 0), tasks * config.writeBytes);
  assert.equal(stats.hbmWriteBytes, stats.deliveredWriteBytes);
  assert.equal(stats.requests, stats.readRequests + stats.writeRequests);
  assert.equal(transfers(baseline).reduce((sum, e) => sum + e.args.flow.bytes, 0), stats.linkBytes);
});

test('a shared key fills once per local L2 partition and fans out distinct local response packets', () => {
  const {config} = baseline.meta;
  const finalPackets = endpointPackets(baseline);
  for (let round = 0; round < config.rounds; round++) {
    const dataKey = `shared:${round}`;
    const hbmReads = baseline.events.filter(e => e.args.stage === 'service' && e.args.dataKey === dataKey && e.args.operation === 'read');
    assert.equal(hbmReads.length, 2);
    const incoming = finalPackets.filter(e => e.args.flow.dataKey === dataKey && e.args.flow.kind === 'read-response' && e.args.flow.originId.startsWith('hbm-'));
    assert.equal(incoming.length, 2);
    assert.equal(new Set(incoming.map(e => e.args.flow.destinationPartitionId)).size, 2);
    const outgoing = finalPackets.filter(e => e.args.flow.dataKey === dataKey && e.args.flow.kind === 'read-response' && e.args.flow.destinationId.startsWith('sm-'));
    assert.equal(outgoing.length, config.numSms);
    assert.equal(new Set(outgoing.map(e => e.args.flow.packetId)).size, config.numSms);
    assert.equal(new Set(outgoing.map(e => e.args.flow.requestId)).size, config.numSms);
    const fills = new Map(incoming.map(e => [e.args.flow.destinationId, e]));
    assert.ok(outgoing.every(e => e.start >= fills.get(e.args.flow.originId).end));
    assert.ok(outgoing.every(e => e.args.flow.originPartitionId === e.args.flow.destinationPartitionId));
  }
  assert.ok(baseline.metrics.traffic.mergedMisses > 0);
  assert.equal(baseline.metrics.traffic.mergedMisses + baseline.metrics.traffic.l2Hits, baseline.metrics.traffic.sharedReadSavings);
});

test('compute waits for both inputs and freed CTA slots refill after L2 acceptance without waiting for HBM', () => {
  const byId = new Map(baseline.events.map(e => [e.id, e]));
  for (const computed of baseline.events.filter(e => e.args.stage === 'compute')) {
    const ready = computed.dependencies.flatMap(id => {
      const dependency = byId.get(id);
      return dependency.args.stage === 'queue' ? dependency.dependencies.map(id => byId.get(id)) : [dependency];
    });
    const inputs = ready.filter(e => e.args.stage === 'transfer' && e.args.flow.kind === 'read-response');
    assert.equal(inputs.length, 2);
    assert.deepEqual(new Set(inputs.map(e => e.args.flow.requestId)), new Set(computed.args.inputRequestIds));
    assert.ok(inputs.every(e => e.end <= computed.start && e.args.flow.destinationId === `sm-${computed.args.smId}`));
  }
  for (const issue of baseline.events.filter(e => e.args.stage === 'issue' && e.start > 0)) {
    assert.equal(issue.dependencies.length, 1);
    const retired = byId.get(issue.dependencies[0]);
    assert.equal(retired.args.stage, 'retire');
    assert.equal(retired.args.smId, issue.args.smId);
    const accepted = byId.get(retired.dependencies[0]);
    assert.equal(accepted.args.operation, 'write');
    assert.ok(accepted.componentId.startsWith('l2-'));
    assert.equal(issue.start, accepted.end);
    const oldBlock = baseline.meta.scheduling.blocks.find(block => block.threadBlockId === retired.args.threadBlockId);
    assert.ok(issue.start < oldBlock.committed);
  }
});

test('link serialization respects bandwidth and FCFS waiting occurs at actual arrival times', () => {
  const topology = new Map(baseline.meta.topology.links.map(l => [l.id, l]));
  const byId = new Map(baseline.events.map(e => [e.id, e]));
  const byLink = new Map();
  for (const transfer of transfers(baseline)) {
    const link = topology.get(transfer.componentId);
    assert.equal(transfer.end - transfer.start, Math.ceil(transfer.args.flow.bytes / link.bytesPerCycle) + link.latencyCycles);
    assert.equal(transfer.args.issueReleaseCycle - transfer.start, Math.ceil(transfer.args.flow.bytes / link.bytesPerCycle));
    if (!byLink.has(link.id)) byLink.set(link.id, []);
    byLink.get(link.id).push(transfer);
  }
  for (const spans of byLink.values()) {
    spans.sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i++) assert.ok(spans[i].start >= spans[i - 1].args.issueReleaseCycle);
  }
  const queues = baseline.events.filter(e => e.args.stage === 'queue');
  assert.ok(queues.length > 0);
  assert.equal(queues.reduce((sum, e) => sum + e.end - e.start, 0), baseline.metrics.traffic.queueWaitCycles);
  for (const wait of queues.filter(e => e.args.flow)) {
    assert.ok(wait.args.queueDepth > 0);
    assert.equal(Math.max(...wait.dependencies.map(id => byId.get(id).end)), wait.start);
  }
});

test('each packet retains its byte count and follows a continuous, causal sequence of hops', () => {
  const packets = new Map();
  for (const e of transfers(baseline)) {
    if (!packets.has(e.args.flow.packetId)) packets.set(e.args.flow.packetId, []);
    packets.get(e.args.flow.packetId).push(e);
  }
  assert.equal(packets.size, baseline.metrics.traffic.packets);
  for (const hops of packets.values()) {
    hops.sort((a, b) => a.args.hopIndex - b.args.hopIndex);
    const first = hops[0].args.flow;
    assert.equal(hops.length, hops[0].args.hopCount);
    for (let index = 0; index < hops.length; index++) {
      const e = hops[index], flow = e.args.flow;
      assert.equal(e.args.hopIndex, index);
      for (const key of ['packetId', 'requestId', 'dataKey', 'bytes', 'kind', 'originId', 'destinationId']) assert.equal(flow[key], first[key]);
      if (index) {
        assert.equal(flow.sourceId, hops[index - 1].args.flow.targetId);
        assert.ok(e.start >= hops[index - 1].end);
      }
    }
  }
});

test('lower NoC or HBM bandwidth lengthens the run without dropping work or data', () => {
  const normal = simulateTraffic(small);
  const slowNoc = simulateTraffic({...small, nocBytesPerCycle: 8});
  const slowHbm = simulateTraffic({...small, hbmBytesPerCycle: 8});
  for (const slower of [slowNoc, slowHbm]) {
    assert.ok(slower.metrics.traffic.makespan > normal.metrics.traffic.makespan);
    for (const key of ['completedTasks', 'readRequests', 'writeRequests', 'hbmReadBytes', 'hbmWriteBytes', 'deliveredReadBytes']) assert.equal(slower.metrics.traffic[key], normal.metrics.traffic[key]);
    validateTrafficTrace(slower);
  }
});

test('disabling shared merging performs an independent HBM fetch for every shared request', () => {
  const merged = simulateTraffic(small), separate = simulateTraffic({...small, coalesceShared: false});
  assert.equal(separate.metrics.traffic.sharedHbmReads, small.numSms * small.rounds);
  assert.equal(separate.metrics.traffic.mergedMisses, 0);
  assert.equal(separate.metrics.traffic.l2Hits, 0);
  assert.equal(separate.metrics.traffic.sharedReadSavings, 0);
  assert.ok(separate.metrics.traffic.hbmReadBytes > merged.metrics.traffic.hbmReadBytes);
  assert.equal(separate.metrics.traffic.deliveredReadBytes, merged.metrics.traffic.deliveredReadBytes);
});

test('repeated runs are deterministic and custom small SM counts keep valid routes', () => {
  assert.deepEqual(simulateTraffic(small), simulateTraffic(small));
  const one = simulateTraffic({numSms: 1, l2Banks: 1, hbmStacks: 1, rounds: 1});
  assert.equal(one.meta.config.numClusters, 1);
  assert.equal(one.metrics.traffic.completedTasks, 1);
  validateTrafficTrace(one);
});

test('invalid model parameters fail before scheduling', () => {
  for (const invalid of [null, [], '132', {numSms: 0}, {numSms: 2.5}, {numSms: 257}, {numSms: NaN}, {numSms: 1, numClusters: 2}, {rounds: 0}, {nocBytesPerCycle: 0}, {hbmLatencyCycles: -1}, {sharedBytes: Infinity}, {coalesceShared: 1}, {madeUpParameter: 1}, {toString: 1}]) {
    assert.throws(() => simulateTraffic(invalid));
  }
});

test('custom physical counts do not retain the H100 SXM identity', () => {
  const variant = simulateTraffic({hbmStacks: 4, rounds: 1});
  assert.match(variant.meta.title, /教学架构/);
  assert.match(variant.components[0].label, /132 SM \/ 4 HBM/);
  assert.equal(variant.meta.hardwareReference.hbm3Stacks, 5);
  validateTrafficTrace(variant);
});

test('propagation changes zero-load arrival, while same-link packet injection remains bandwidth-limited', () => {
  const config = {numSms: 8, numClusters: 2, l2Banks: 2, hbmStacks: 2, rounds: 1, requestBytes: 32, nocBytesPerCycle: 64};
  const immediate = simulateTraffic({...config, nocLatencyCycles: 0});
  const delayed = simulateTraffic({...config, nocLatencyCycles: 25});
  const arrivals = trace => transfers(trace).filter(e => e.args.flow.kind === 'read-request' && e.args.flow.sourceId === 'router-0' && e.args.flow.targetId === 'fabric-0').sort((a, b) => a.start - b.start);
  const zero = arrivals(immediate), slow = arrivals(delayed);
  assert.equal(zero.length, 8);
  assert.equal(slow.length, 8);
  for (let index = 1; index < zero.length; index++) {
    assert.equal(zero[index].start - zero[index - 1].start, 1);
    assert.equal(slow[index].start - slow[index - 1].start, 1);
  }
  assert.equal(slow[0].start - zero[0].start, 25);
  assert.equal(slow[0].end - zero[0].end, 50, 'two hops each add propagation; injection cadence does not add it');
  assert.ok(slow[1].start < slow[0].end, 'tails in flight may overlap after serializer release');
  assert.ok(slow[1].args.issueDependencies.includes(slow[0].id));
  assert.ok(!slow[1].dependencies.includes(slow[0].id));
});

test('partition-local cache hits never cross the bridge, while remote HBM miss request and return do', () => {
  const nodes = new Map(baseline.meta.topology.nodes.map(node => [node.id, node]));
  const bridgeLinks = new Set(baseline.meta.topology.links.filter(link => link.bridge).map(link => link.id));
  const packets = new Map();
  for (const e of transfers(baseline)) {
    if (!packets.has(e.args.flow.packetId)) packets.set(e.args.flow.packetId, []);
    packets.get(e.args.flow.packetId).push(e);
  }
  let remote = 0, local = 0;
  for (const hops of packets.values()) {
    const flow = hops[0].args.flow;
    if (flow.kind === 'read-request' && flow.originId.startsWith('l2-') && flow.destinationId.startsWith('hbm-')) {
      const crossed = hops.filter(e => bridgeLinks.has(e.args.linkId));
      if (nodes.get(flow.originId).partitionId === nodes.get(flow.destinationId).partitionId) {
        local++; assert.equal(crossed.length, 0);
      } else {
        remote++; assert.equal(crossed.length, 1);
        const returnPath = [...packets.values()].find(path => path[0].args.flow.requestId === flow.requestId &&
          path[0].args.flow.originId === flow.destinationId && path[0].args.flow.destinationId === flow.originId);
        assert.equal(returnPath.filter(e => bridgeLinks.has(e.args.linkId)).length, 1);
      }
    }
  }
  assert.ok(remote > 0 && local > 0);
  const later = simulateTraffic({...small, rounds: 3, hbmLatencyCycles: 1, hbmBytesPerCycle: 4096, maxResidentBlocksPerSm: 1});
  const hitPackets = new Map();
  for (const event of transfers(later)) {
    if (!hitPackets.has(event.args.flow.packetId)) hitPackets.set(event.args.flow.packetId, []);
    hitPackets.get(event.args.flow.packetId).push(event);
  }
  const hits = later.events.filter(e => e.args.cacheOutcome === 'hit');
  assert.ok(hits.length > 0);
  for (const lookup of hits) {
    const response = [...hitPackets.values()].find(path => path[0].args.flow.requestId === lookup.args.requestId && path[0].args.flow.originId === lookup.componentId);
    assert.ok(response);
    assert.ok(response.every(e => !bridgeLinks.has(e.args.linkId)));
  }
  assert.deepEqual(baseline.metrics.traffic.sharedHbmReadsByPartition, [3, 3]);
});

test('contending remote traffic shares finite bridge injection bandwidth and queues causally', () => {
  const config = {l2Banks: 4, hbmStacks: 2, rounds: 1, crossPartitionBytesPerCycle: 16, hbmLatencyCycles: 1, hbmBytesPerCycle: 4096};
  const low = simulateTraffic({...config, numSms: 2, numClusters: 2});
  const high = simulateTraffic({...config, numSms: 32, numClusters: 4});
  const wide = simulateTraffic({...config, numSms: 32, numClusters: 4, crossPartitionBytesPerCycle: 512});
  assert.ok(high.metrics.traffic.bridgeQueueWaitCycles > low.metrics.traffic.bridgeQueueWaitCycles);
  assert.ok(high.metrics.traffic.bridgeQueueWaitCycles / high.metrics.traffic.bridgeTransfers >
    low.metrics.traffic.bridgeQueueWaitCycles / low.metrics.traffic.bridgeTransfers);
  assert.ok(high.metrics.traffic.makespan > wide.metrics.traffic.makespan);
  assert.equal(high.metrics.traffic.deliveredReadBytes, wide.metrics.traffic.deliveredReadBytes);
  assert.equal(high.metrics.traffic.bridgeBytes, wide.metrics.traffic.bridgeBytes);
  validateTrafficTrace(high);
});

test('L2 fixed lookup latency is pipelined independently of its serialized byte occupancy', () => {
  const lookups = baseline.events.filter(e => e.args.stage === 'service' && e.args.operation === 'lookup');
  assert.ok(lookups.every(e => e.args.issueReleaseCycle - e.start === 1));
  assert.ok(lookups.every(e => e.end - e.args.issueReleaseCycle === DEFAULT_TRAFFIC_CONFIG.l2LatencyCycles));
  assert.ok(lookups.some((e, i) => lookups.slice(0, i).some(previous => previous.componentId === e.componentId && previous.end > e.start)));

});

test('uniform-star keeps single-fabric cache semantics, and odd partition counts keep SM/router locality', () => {
  const old = simulateTraffic({...small, nocTopology: 'uniform-star'});
  assert.equal(old.meta.topology.nodes.filter(n => n.kind === 'fabric').length, 1);
  assert.equal(old.meta.topology.nodes.find(n => n.kind === 'fabric').id, 'fabric');
  assert.equal(old.meta.topology.links.filter(l => l.bridge).length, 0);
  assert.equal(old.metrics.traffic.sharedHbmReads, small.rounds);
  const odd = simulateTraffic({numSms: 5, numClusters: 3, l2Banks: 3, hbmStacks: 3, rounds: 1});
  const nodes = new Map(odd.meta.topology.nodes.map(n => [n.id, n]));
  for (const sm of odd.meta.topology.nodes.filter(n => n.kind === 'sm')) assert.equal(sm.partitionId, nodes.get(sm.clusterId).partitionId);
  validateTrafficTrace(odd);
});

test('invalid topology profiles, bridge settings and impossible local partition endpoints are rejected', () => {
  for (const invalid of [{nocTopology: 'mesh'}, {nocTopology: null}, {crossPartitionBytesPerCycle: 0},
    {crossPartitionLatencyCycles: -1}, {crossPartitionBytesPerCycle: 2.5}, {numSms: 2, numClusters: 1},
    {numSms: 2, l2Banks: 1}]) assert.throws(() => simulateTraffic(invalid));
});

test('all 132 SMs begin with resident work while input waits remain distinct from compute', () => {
  const initial = trafficSmSnapshot(baseline, 0);
  assert.equal(initial.residentSms, 132);
  assert.equal(initial.idleSms, 0);
  assert.equal(initial.residentBlocks, 264);
  assert.equal(initial.pendingBlocks, 132);
  assert.equal(initial.computingSms, 0);
  assert.equal(initial.memoryOnlySms, 132);
  assert.ok(initial.sms.every(sm => sm.residentBlocks === 2 && sm.state === 'memory-wait'));
  const duringCompute = trafficSmSnapshot(baseline, baseline.meta.scheduling.blocks[0].computeStart);
  assert.ok(duringCompute.computingSms > 0);
  assert.ok(duringCompute.sms.some(sm => sm.computingBlocks && sm.waitingBlocks));
  assert.equal(duringCompute.residentSms + duringCompute.idleSms, 132);
  assert.ok(duringCompute.sms.every(sm => sm.state !== 'idle' || sm.residentBlocks === 0));
});

test('small grids leave only unscheduled SMs idle; larger grids refill without exceeding residency resources', () => {
  const tiny = simulateTraffic({...small, gridBlocks: 3});
  const initial = trafficSmSnapshot(tiny, 0);
  assert.equal(initial.totalBlocks, 3);
  assert.equal(initial.residentSms, 3);
  assert.equal(initial.idleSms, 9);
  assert.equal(tiny.metrics.traffic.completedTasks, 3);
  const refilled = simulateTraffic({...small, gridBlocks: 37});
  const changes = new Set(refilled.meta.scheduling.blocks.flatMap(block => [block.start, block.retired, block.committed]));
  for (const time of changes) {
    const snapshot = trafficSmSnapshot(refilled, time);
    assert.equal(snapshot.pendingBlocks + snapshot.residentBlocks + snapshot.completedBlocks, 37);
    assert.ok(snapshot.committedBlocks <= snapshot.completedBlocks);
    assert.ok(snapshot.sms.every(sm => sm.residentBlocks <= refilled.meta.scheduling.residentBlockLimit));
  }
  const finished = trafficSmSnapshot(refilled, refilled.metrics.traffic.makespan);
  assert.equal(finished.residentBlocks, 0);
  assert.equal(finished.completedBlocks, 37);
  assert.equal(finished.committedBlocks, 37);
  assert.equal(finished.idleSms, 12);
});

test('warp, register, shared memory and configured block limits bound CTA residency independently', () => {
  const base = {...baseline.meta.config, maxResidentBlocksPerSm: 32, threadsPerBlock: 256,
    registersPerThread: 16, sharedMemBytesPerBlock: 0};
  assert.equal(trafficResidency(base).residentBlockLimit, 8);
  assert.equal(trafficResidency({...base, registersPerThread: 128}).residentBlockLimit, 2);
  assert.equal(trafficResidency({...base, sharedMemBytesPerBlock: 114 * 1024}).residentBlockLimit, 1,
    'the 1 KiB per-block reservation is part of the shared-memory budget');
  assert.equal(trafficResidency({...base, maxResidentBlocksPerSm: 3}).residentBlockLimit, 3);
  assert.equal(trafficResidency({...base, threadsPerBlock: 1024}).residentBlockLimit, 2);
  for (const invalid of [{threadsPerBlock: 33}, {gridBlocks: 0}, {gridBlocks: 4097},
    {maxResidentBlocksPerSm: 0}, {registersPerThread: 256}, {sharedMemBytesPerBlock: 228 * 1024},
    {threadsPerBlock: 1024, registersPerThread: 255}]) assert.throws(() => simulateTraffic(invalid));
});

test('resident snapshots distinguish ready queues and honor half-open retirement and legacy traces', () => {
  const trace = simulateTraffic({numSms: 1, numClusters: 1, l2Banks: 1, hbmStacks: 1, gridBlocks: 4,
    computeCycles: 1000, sharedBytes: 1, privateBytes: 1, hbmLatencyCycles: 1, nocLatencyCycles: 0});
  const queued = trace.meta.scheduling.blocks.find(block => block.inputsReady < block.computeStart);
  assert.ok(queued);
  const snapshot = trafficSmSnapshot(trace, queued.inputsReady);
  assert.equal(snapshot.sms[0].state, 'compute');
  assert.ok(snapshot.sms[0].readyBlocks > 0);
  assert.equal(snapshot.readySms, 1);
  const last = trace.meta.scheduling.blocks.at(-1);
  assert.equal(trafficSmSnapshot(trace, last.retired).residentBlocks, 0);
  const legacy = structuredClone(trace);
  delete legacy.meta.scheduling;
  assert.equal(trafficSmSnapshot(legacy, 0).residentBlocks, 2);
  assert.equal(trafficSmSnapshot(legacy, trace.metrics.traffic.makespan).residentBlocks, 0);
  assert.throws(() => trafficSmSnapshot(trace, NaN));
});


test('HBM fixed latency overlaps while its byte serializer and completions remain causal', () => {
  const services = baseline.events.filter(event => event.componentId.startsWith('hbm-') && event.args.stage === 'service');
  const byEndpoint = new Map();
  for (const event of services) {
    assert.equal(event.args.issueReleaseCycle - event.start, Math.ceil(event.args.bytes / DEFAULT_TRAFFIC_CONFIG.hbmBytesPerCycle));
    assert.equal(event.end - event.args.issueReleaseCycle, DEFAULT_TRAFFIC_CONFIG.hbmLatencyCycles);
    if (!byEndpoint.has(event.componentId)) byEndpoint.set(event.componentId, []);
    byEndpoint.get(event.componentId).push(event);
  }
  let overlappingLatency = false;
  for (const spans of byEndpoint.values()) {
    spans.sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i++) {
      assert.ok(spans[i].start >= spans[i - 1].args.issueReleaseCycle);
      if (spans[i].start < spans[i - 1].end) overlappingLatency = true;
    }
  }
  assert.ok(overlappingLatency, 'Aggregate endpoints must admit another transfer before the earlier latency tail finishes.');
  const byId = new Map(baseline.events.map(event => [event.id, event]));
  for (const event of baseline.events) if (event.args.flow?.kind === 'read-response' && event.args.flow.originId.startsWith('hbm-') && event.args.hopIndex === 0) {
    assert.ok(event.dependencies.some(id => byId.get(id)?.args.operation === 'read' && byId.get(id).end <= event.start));
  }
  for (const block of baseline.meta.scheduling.blocks) {
    const write = services.find(event => event.args.operation === 'write' && event.args.threadBlockId === block.threadBlockId);
    assert.equal(block.committed, write.end);
  }
  assert.match(baseline.meta.nocModel.hbmService, /pipelined aggregate/);
  validateTrafficTrace(baseline);
});
