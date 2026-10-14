import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRun, decodeWorkspace, describeRun} from '../lib/run-state.js';

function fixture() {
  const flow = {packetId: 'packet-0', requestId: 'request-0', dataKey: 'shared-A', kind: 'read-response', bytes: 64,
    originId: 'hbm', destinationId: 'sm-0', shared: true};
  return {schemaVersion: 1, meta: {producer: 'transport fixture', evidenceKind: 'simulation', timeUnit: 'cycle',
    capabilities: ['tile_tasks', 'noc_transfers'], trafficSchemaVersion: 1,
    topology: {nodes: [{id: 'hbm'}, {id: 'l2'}, {id: 'sm-0'}], links: [
      {id: 'hbm-l2', sourceId: 'hbm', targetId: 'l2', bytesPerCycle: 16, latencyCycles: 2, capacity: 1},
      {id: 'l2-sm', sourceId: 'l2', targetId: 'sm-0', bytesPerCycle: 16, latencyCycles: 2, capacity: 1},
    ]}}, components: ['hbm', 'l2', 'sm-0', 'hbm-l2', 'l2-sm'].map(id => ({id, label: id})), events: [
      {id: 'hop-0', name: 'HBM return', componentId: 'hbm-l2', start: 0, end: 6, dependencies: [],
        args: {stage: 'transfer', hopIndex: 0, linkId: 'hbm-l2', flow: {...flow, sourceId: 'hbm', targetId: 'l2'}}},
      {id: 'hop-1', name: 'L2 distribute', componentId: 'l2-sm', start: 6, end: 12, dependencies: ['hop-0'],
        args: {stage: 'transfer', hopIndex: 1, linkId: 'l2-sm', flow: {...flow, sourceId: 'l2', targetId: 'sm-0'}}},
    ]};
}

test('transport import preserves route, payload, timestamps and independent macro run', () => {
  const trace = fixture(), before = structuredClone(trace);
  assert.equal(normalizeRun(trace), trace);
  assert.deepEqual(trace, before);
  assert.equal(describeRun(trace).granularity, '数据包 / Tile');
  assert.equal(decodeWorkspace({kind: 'gpu-sim-workspace', version: 1, trace}).activeRun, 'macro');
});

test('a declared network capability cannot bypass topology and packet validation', () => {
  for (const change of [
    trace => delete trace.meta.topology,
    trace => delete trace.meta.trafficSchemaVersion,
    trace => trace.meta.topology.links[0].targetId = 'unknown',
    trace => trace.events[0].args.flow.bytes = -1,
    trace => trace.events[1].args.flow.sourceId = 'hbm',
  ]) {
    const trace = fixture(); change(trace);
    assert.throws(() => normalizeRun(trace), /数据流记录/);
  }
});

test('packet paths cannot change payload identity, skip hops or exceed link capacity', () => {
  for (const change of [
    trace => trace.events[1].args.flow.bytes = 32,
    trace => trace.events[1].args.flow.requestId = 'another-request',
    trace => trace.events[1].args.hopIndex = 3,
    trace => trace.events[0].end = 2,
    trace => trace.events.push({...structuredClone(trace.events[0]), id: 'conflict', start: 1, end: 7,
      args: {...structuredClone(trace.events[0].args), flow: {...structuredClone(trace.events[0].args.flow), packetId: 'another-packet', destinationId: 'l2'}}}),
  ]) {
    const trace = fixture(); change(trace);
    assert.throws(() => normalizeRun(trace), /数据流记录/);
  }
});

test('explicit excerpts retain known endpoints without manufacturing missing hops', () => {
  const trace = fixture(); trace.events.shift(); trace.events[0].dependencies = [];
  assert.throws(() => normalizeRun(trace), /完整路由/);
  trace.meta.trafficComplete = false;
  assert.equal(normalizeRun(trace).events.length, 1);
  assert.equal(trace.events[0].args.flow.originId, 'hbm');
});

function pipelinedFixture() {
  const trace = fixture(), first = trace.events[0];
  first.args.issueReleaseCycle = 4;
  first.args.serializationCycles = 4;
  first.args.propagationCycles = 2;
  trace.meta.topology.links[0].occupancy = 'serialization-only';
  trace.events.push({...structuredClone(first), id: 'next-packet', start: 4, end: 10,
    dependencies: [], args: {...structuredClone(first.args), issueReleaseCycle: 8,
      issueDependencies: [first.id], flow: {...structuredClone(first.args.flow), packetId: 'packet-1', destinationId: 'l2'}}});
  return trace;
}

test('serializer release permits overlapping in-flight tails without rewriting old full-occupancy records', () => {
  const trace = pipelinedFixture(), before = structuredClone(trace);
  assert.equal(normalizeRun(trace), trace);
  assert.deepEqual(trace, before);
  assert.ok(trace.events[2].start < trace.events[0].end);
  const old = fixture(), oldBefore = structuredClone(old);
  assert.equal(normalizeRun(old), old);
  assert.deepEqual(old, oldBefore);
  assert.equal(old.events[0].args.issueReleaseCycle, undefined);
});

test('serialization release, payload bandwidth and tail propagation must all agree', () => {
  for (const change of [
    trace => trace.events[0].args.issueReleaseCycle = 3,
    trace => trace.events[0].args.issueReleaseCycle = 7,
    trace => { trace.events[0].args.issueReleaseCycle = 5; trace.events[0].args.serializationCycles = 5; trace.events[0].args.propagationCycles = 1; },
    trace => trace.events[0].args.issueReleaseCycle = NaN,
    trace => trace.events[0].args.serializationCycles = 2,
    trace => trace.events[0].args.propagationCycles = 8,
    trace => delete trace.events[0].args.issueReleaseCycle,
    trace => { trace.events[2].start = 3; trace.events[2].end = 9; trace.events[2].args.issueReleaseCycle = 7; },
  ]) {
    const trace = pipelinedFixture(); change(trace);
    assert.throws(() => normalizeRun(trace));
  }
});

test('undeclared legacy links retain full occupancy even when an importer supplies an early release field', () => {
  const trace = pipelinedFixture();
  delete trace.meta.topology.links[0].occupancy;
  delete trace.events[0].args.serializationCycles;
  delete trace.events[0].args.propagationCycles;
  delete trace.events[2].args.serializationCycles;
  delete trace.events[2].args.propagationCycles;
  assert.throws(() => normalizeRun(trace), /串行化占用发生重叠/);
});
