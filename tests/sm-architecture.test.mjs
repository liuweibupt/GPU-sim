import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SM_ARCHITECTURE, instantiateSmArchitecture, instantiateSmComponents,
  createSmComponents, smComponentId, validateSmArchitecture,
} from '../lib/sm-architecture.js';
import {validateTrace} from '../lib/trace.js';

test('formal SM graph resolves every typed port in every partition, including SM 0', () => {
  assert.equal(validateSmArchitecture(), SM_ARCHITECTURE);
  for (const smId of [0, 131]) {
    const graph = instantiateSmArchitecture(smId);
    assert.equal(validateSmArchitecture(graph), graph);
    assert.equal(graph.components.length, 76);
    assert.equal(new Set(graph.components.map(c => c.id)).size, 76);
    assert.ok(graph.links.length > 200);
    assert.equal(graph.components.filter(c => c.localId === 'fetch').length, 4);
    assert.equal(graph.components.filter(c => c.localId === 'tma').length, 1);
    assert.deepEqual([...new Set(graph.components.filter(c => c.scope === 'partition').map(c => c.partitionId))], [0, 1, 2, 3]);
    validateTrace({schemaVersion: 1, meta: {producer: 'SM architecture test', evidenceKind: 'illustration', timeUnit: 'cycle'},
      components: [graph.smComponent, ...graph.components], events: []});
  }
});

test('official partition resources sum to the selected H100 SM facts without double counting shared storage', () => {
  const graph = instantiateSmArchitecture(0);
  const sum = (id, resource) => graph.components.filter(c => c.localId === id).reduce((n, c) => n + c.resources[resource], 0);
  assert.equal(sum('fp32', 'hardwareLanes'), 128);
  assert.equal(sum('fp64', 'hardwareLanes'), 64);
  assert.equal(sum('int32', 'hardwareLanes'), 64);
  assert.equal(sum('tensor', 'hardwareTensorCores'), 4);
  assert.equal(sum('register-file', 'registers32Bit'), 65536);
  assert.equal(sum('warp-scheduler', 'hardwareSchedulersPerInstance'), 4);
  assert.equal(SM_ARCHITECTURE.hardwareFacts.gpuSmCount, 132);
  const l1 = graph.components.find(c => c.localId === 'l1-cache');
  const shared = graph.components.find(c => c.localId === 'shared-memory');
  assert.equal(l1.resources.physicalResource, shared.resources.physicalResource);
  assert.equal(l1.resources.capacityBytes, null);
  assert.equal(graph.physicalResources.length, 1);
  assert.equal(graph.physicalResources[0].capacityBytes, 256 * 1024);
  assert.equal(shared.resources.maxCapacityBytes, 228 * 1024);
  assert.equal(shared.resources.perCtaMaxBytes, 227 * 1024);
});

test('all timing is explicitly a model and distinguishes latency, initiation interval, capacity and queue depth', () => {
  for (const c of SM_ARCHITECTURE.components) {
    assert.equal(c.timing.evidenceClass, 'teaching-model');
    assert.ok(['latencyCycles', 'initiationIntervalCycles', 'capacity', 'queueCapacity'].every(key => c.timing[key] > 0));
    assert.ok(c.stateFields.length && c.transitions.every(t => t.guard && t.effect && t.release));
  }
  assert.notEqual(SM_ARCHITECTURE.defaultTiming.fp32.latencyCycles, SM_ARCHITECTURE.defaultTiming.fp32.initiationIntervalCycles);
  for (const id of ['texture', 'constant-cache']) {
    assert.equal(SM_ARCHITECTURE.components.find(c => c.localId === id).simulationCoverage, 'structural-only');
  }
  for (const id of ['icache', 'l0-icache', 'branch']) {
    assert.equal(SM_ARCHITECTURE.components.find(c => c.localId === id).simulationCoverage, 'timing-only');
  }
  assert.equal(SM_ARCHITECTURE.components.find(c => c.localId === 'tma').resources.hardwareEngineCount, null);
});

test('memory paths distinguish normal RF loads, shared accesses, TMA and asynchronous readiness', () => {
  const edges = SM_ARCHITECTURE.links;
  const has = (source, target, type) => edges.some(e => e.source === source && e.target === target && e.type === type);
  assert.ok(has('lsu', 'l1-cache', 'memory'));
  assert.ok(has('lsu', 'shared-memory', 'memory'));
  assert.ok(has('tma', 'noc-interface', 'memory'));
  assert.ok(has('noc-interface', 'tma', 'memory'));
  assert.ok(has('tma', 'shared-memory', 'memory'));
  assert.ok(has('shared-memory', 'tma', 'completion'));
  assert.ok(has('tma', 'mbarrier', 'completion'));
  assert.ok(has('mbarrier', 'tensor', 'control'));
  assert.ok(has('shared-memory', 'tensor', 'operand'));
  assert.equal(edges.some(e => e.source === 'tma' && e.target === 'register-file' && e.type === 'memory'), false);
  assert.equal(edges.some(e => e.source === 'l1-cache' && e.target === 'shared-memory' && e.type === 'memory'), false);
});

test('stable SM IDs preserve partition zero and instantiated nodes cannot mutate the shared specification', () => {
  assert.equal(smComponentId(0, 'fetch', 0), 'sm-0/p0/fetch');
  assert.equal(smComponentId(131, 'tensor', 3), 'sm-131/p3/tensor');
  assert.equal(smComponentId(0, 'shared-memory', 3), 'sm-0/shared-memory');
  assert.equal(createSmComponents, instantiateSmComponents);
  const first = instantiateSmComponents(0), second = instantiateSmComponents(0);
  first[0].ports.inputs[0].name = 'corrupted';
  first[0].resources.capacityBytes = 1;
  assert.notEqual(second[0].ports.inputs[0].name, 'corrupted');
  assert.equal(SM_ARCHITECTURE.components[0].resources.capacityBytes, null);
  assert.throws(() => smComponentId(0, 'fetch', 4), /partitionId/);
  assert.throws(() => smComponentId(-1, 'fetch'), /smId/);
  assert.throws(() => smComponentId(0, 'nonexistent'), /Unknown/);
});

test('formal validation rejects broken topology, type mismatches, invented timing provenance and omitted coverage', () => {
  const broken = instantiateSmArchitecture(0);
  broken.links[0].targetPort = 'nonexistent';
  assert.throws(() => validateSmArchitecture(broken), /port\/type mismatch/);
  const mismatched = instantiateSmArchitecture(0);
  mismatched.links[0].type = 'memory';
  assert.throws(() => validateSmArchitecture(mismatched), /port\/type mismatch/);
  const timing = instantiateSmArchitecture(0);
  timing.components[0].timing.evidenceClass = 'public-architecture';
  assert.throws(() => validateSmArchitecture(timing), /Timing cannot masquerade/);
  const coverage = instantiateSmArchitecture(0);
  delete coverage.components[0].simulationCoverage;
  assert.throws(() => validateSmArchitecture(coverage), /Missing simulation coverage/);
});
