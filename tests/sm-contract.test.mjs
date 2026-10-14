import test from 'node:test';
import assert from 'node:assert/strict';
import {simulateSm} from '../lib/sm-model.js';
import {normalizeRun, describeRun, decodeWorkspace} from '../lib/run-state.js';

const fixture = () => simulateSm({smId: 131, warpCount: 4});

test('SM teaching runs round trip in the detail slot with a separate macro clock', () => {
  const detailed = normalizeRun(fixture());
  assert.equal(describeRun(detailed).kind, 'detail');
  assert.match(describeRun(detailed).granularity, /教学/);
  assert(!detailed.meta.capabilities.includes('instruction_spans'));
  const macro = {schemaVersion: 1, meta: {producer: 'macro fixture', evidenceKind: 'illustration', timeUnit: 'cycle', timeDomain: 'macro-only'},
    components: [{id: 'sm-131', label: 'SM 131', kind: 'sm'}], events: [], metrics: {}};
  const workspace = {kind: 'gpu-sim-workspace', version: 2, activeRun: 'detail', runs: {
    macro: {trace: macro, view: {time: 1000}},
    detail: {trace: detailed, view: {time: 20, world: {smComponentId: 'sm-131', smPipeline: {partition: 3}}}},
  }};
  const restored = decodeWorkspace(JSON.parse(JSON.stringify(workspace)));
  assert.equal(restored.runs.detail.view.world.smPipeline.partition, 3);
  assert.equal(restored.runs.macro.view.time, 1000);
  assert.notEqual(restored.runs.detail.trace.meta.timeDomain, restored.runs.macro.trace.meta.timeDomain);
});

test('teaching claims reject missing schema, components, lifetimes and mixed observer evidence', () => {
  for (const mutate of [
    trace => delete trace.meta.smModelSchemaVersion,
    trace => {trace.meta.smPipeline.id = 'invented';},
    trace => {trace.meta.evidenceKind = 'measurement';},
    trace => {trace.meta.capabilities.push('instruction_spans');},
    trace => {trace.events[0].args.localComponentId = 'tensor';},
    trace => {trace.metrics.instructions[0].partitionId = 3;},
    trace => {trace.metrics.instructions[0].eventIds.pop();},
    trace => {trace.metrics.instructions[0].end = trace.metrics.instructions[0].start;},
    trace => {const id = trace.components.find(c => c.args?.localComponentId === 'constant-cache').id; trace.components = trace.components.filter(c => c.id !== id);},
  ]) {
    const trace = fixture(); mutate(trace);
    assert.throws(() => normalizeRun(trace), /SM 流水线契约/);
  }
});

test('SM transfer endpoints, bytes and causal dependencies cannot be fabricated on import', () => {
  const original = fixture();
  const index = original.events.findIndex(event => event.args.smPipelineTransfer);
  assert(index >= 0);
  for (const mutate of [
    flow => {flow.targetId = 'missing-sm-unit';},
    flow => {flow.bytes = -32;},
    flow => {flow.kind = 'magic-broadcast';},
  ]) {
    const trace = structuredClone(original); mutate(trace.events[index].args.smPipelineTransfer);
    assert.throws(() => normalizeRun(trace), /SM 流水线契约/);
  }
  const broken = structuredClone(original);
  const consumer = broken.events.find(event => event.dependencies.length > 0 && event.start > 0);
  const producer = broken.events.find(event => event.id === consumer.dependencies[0]);
  consumer.start = producer.end - 1;
  assert.throws(() => normalizeRun(broken), /完成依赖违反时序/);
});

test('an invalid secondary SM run rejects a workspace atomically', () => {
  const trace = fixture();
  trace.events[0].args.instructionId = 'unknown-instruction';
  const input = {kind: 'gpu-sim-workspace', version: 2, activeRun: 'detail', runs: {macro: null, detail: {trace}}};
  const before = structuredClone(input);
  assert.throws(() => decodeWorkspace(input), /指令归属/);
  assert.deepEqual(input, before);
});
