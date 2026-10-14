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
