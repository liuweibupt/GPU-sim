import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_TRAFFIC_CONFIG, simulateTraffic} from '../lib/traffic-model.js';
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
  assert.equal(baseline.meta.topology.nodes.filter(n => n.kind === 'router').length, 12);
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
  assert.equal(reads.length, tasks + config.rounds);
  assert.equal(reads.reduce((sum, e) => sum + e.args.bytes, 0), stats.hbmReadBytes);
  assert.equal(stats.hbmReadBytes, tasks * config.privateBytes + config.rounds * config.sharedBytes);
  const committed = baseline.events.filter(e => e.args.stage === 'service' && e.args.operation === 'write' && e.componentId.startsWith('hbm-'));
  assert.equal(committed.length, tasks);
  assert.equal(committed.reduce((sum, e) => sum + e.args.bytes, 0), tasks * config.writeBytes);
  assert.equal(stats.hbmWriteBytes, stats.deliveredWriteBytes);
  assert.equal(stats.requests, stats.readRequests + stats.writeRequests);
  assert.equal(transfers(baseline).reduce((sum, e) => sum + e.args.flow.bytes, 0), stats.linkBytes);
});

test('a shared key issues one HBM read and fans out distinct L2 response packets', () => {
  const {config} = baseline.meta;
  const finalPackets = endpointPackets(baseline);
  for (let round = 0; round < config.rounds; round++) {
    const dataKey = `shared:${round}`;
    const hbmReads = baseline.events.filter(e => e.args.stage === 'service' && e.args.dataKey === dataKey && e.args.operation === 'read');
    assert.equal(hbmReads.length, 1);
    const incoming = finalPackets.filter(e => e.args.flow.dataKey === dataKey && e.args.flow.kind === 'read-response' && e.args.flow.originId.startsWith('hbm-'));
    assert.equal(incoming.length, 1);
    const outgoing = finalPackets.filter(e => e.args.flow.dataKey === dataKey && e.args.flow.kind === 'read-response' && e.args.flow.destinationId.startsWith('sm-'));
    assert.equal(outgoing.length, config.numSms);
    assert.equal(new Set(outgoing.map(e => e.args.flow.packetId)).size, config.numSms);
    assert.equal(new Set(outgoing.map(e => e.args.flow.destinationId)).size, config.numSms);
    assert.ok(outgoing.every(e => e.start >= incoming[0].end));
  }
  assert.ok(baseline.metrics.traffic.mergedMisses > 0);
  assert.equal(baseline.metrics.traffic.mergedMisses + baseline.metrics.traffic.l2Hits, baseline.metrics.traffic.sharedReadSavings);
});

test('compute waits for both modeled input responses, and the next tile waits for its write commit', () => {
  const byId = new Map(baseline.events.map(e => [e.id, e]));
  for (const computed of baseline.events.filter(e => e.args.stage === 'compute')) {
    const inputs = computed.dependencies.map(id => byId.get(id)).filter(e => e.args.stage === 'transfer' && e.args.flow.kind === 'read-response');
    assert.equal(inputs.length, 2);
    assert.deepEqual(new Set(inputs.map(e => e.args.flow.requestId)), new Set(computed.args.inputRequestIds));
    assert.ok(inputs.every(e => e.end <= computed.start && e.args.flow.destinationId === `sm-${computed.args.smId}`));
  }
  for (const issue of baseline.events.filter(e => e.args.stage === 'issue' && e.args.round > 0)) {
    assert.equal(issue.dependencies.length, 1);
    const done = byId.get(issue.dependencies[0]);
    assert.equal(done.args.stage, 'complete');
    const committed = byId.get(done.dependencies[0]);
    assert.equal(committed.args.operation, 'write');
    assert.ok(committed.componentId.startsWith('hbm-'));
    assert.equal(issue.start, committed.end);
  }
});

test('link serialization respects bandwidth and FCFS waiting occurs at actual arrival times', () => {
  const topology = new Map(baseline.meta.topology.links.map(l => [l.id, l]));
  const byId = new Map(baseline.events.map(e => [e.id, e]));
  const byLink = new Map();
  for (const transfer of transfers(baseline)) {
    const link = topology.get(transfer.componentId);
    assert.equal(transfer.end - transfer.start, Math.ceil(transfer.args.flow.bytes / link.bytesPerCycle) + link.latencyCycles);
    if (!byLink.has(link.id)) byLink.set(link.id, []);
    byLink.get(link.id).push(transfer);
  }
  for (const spans of byLink.values()) {
    spans.sort((a, b) => a.start - b.start);
    for (let i = 1; i < spans.length; i++) assert.ok(spans[i].start >= spans[i - 1].end);
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
