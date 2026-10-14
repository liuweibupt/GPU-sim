import test from 'node:test';
import assert from 'node:assert/strict';
import {describeRun, decodeWorkspace, normalizeRun} from '../lib/run-state.js';

function trace(capabilities = ['tile_tasks']) {
  const instruction = capabilities.some(capability => capability.startsWith('instruction_'));
  const point = capabilities.includes('instruction_observations') && !capabilities.includes('instruction_spans');
  return {schemaVersion: 1, meta: {producer: 'test', evidenceKind: 'illustration', timeUnit: 'cycle', capabilities,
      runId: instruction ? 'illustrative-detail' : 'illustrative-macro', timeDomain: instruction ? 'fixture-detail-cycle' : 'fixture-macro-cycle'},
    components: [{id: 'sm-0', label: 'SM 0', kind: 'sm'}],
    events: [{id: 'e', name: 'test', componentId: 'sm-0', start: 2, end: point ? 2 : 9, dependencies: [],
      args: instruction ? {granularity: 'instruction', smId: 0, warpId: 1, pc: '0x100', opcode: 'IADD3', stage: point ? 'ISSUE' : 'issue-to-complete'} : {granularity: 'tile'}}], metrics: {}};
}

test('unknown runtime is distinct from a measured zero; instruction points stay points', () => {
  const detail = trace(['instruction_observations']);
  assert.equal(describeRun(detail).granularity, '指令观测点');
  assert.equal(describeRun(detail).wallTimeSeconds, null);
  detail.metrics.wallTimeSeconds = 0;
  assert.equal(describeRun(detail).wallTimeSeconds, 0);
  assert.equal(describeRun(trace()).granularity, 'Tile 操作');
});

test('two independent runs restore their own clocks, rates, selections and camera views', () => {
  const input = {kind: 'gpu-sim-workspace', version: 2, activeRun: 'detail', runs: {
    macro: {trace: trace(), view: {time: 8, rate: 4, selectedEventId: 'e', world: {zoom: 1.5}}},
    detail: {trace: trace(['instruction_spans']), view: {time: 2, rate: .25, selectedEventId: null, world: {smComponentId: 'sm-0'}}},
  }};
  const before = JSON.stringify(input), decoded = decodeWorkspace(input);
  assert.equal(decoded.activeRun, 'detail');
  assert.equal(decoded.runs.macro.view.time, 8);
  assert.equal(decoded.runs.detail.view.time, 2);
  assert.equal(decoded.runs.macro.view.rate, 4);
  assert.equal(decoded.runs.detail.view.rate, .25);
  assert.equal(decoded.runs.macro.view.world.zoom, 1.5);
  assert.equal(decoded.runs.macro.trace.meta.timeDomain, 'fixture-macro-cycle');
  assert.equal(decoded.runs.detail.trace.meta.timeDomain, 'fixture-detail-cycle');
  assert.equal(JSON.stringify(input), before);
});

test('declared instruction capabilities cannot fall back to tile validation', () => {
  const claimedDetail = trace();
  claimedDetail.meta.capabilities = ['instruction_spans'];
  assert.throws(() => normalizeRun(claimedDetail), /没有指令观测/);
  assert.throws(() => decodeWorkspace({kind: 'gpu-sim-workspace', version: 1, trace: claimedDetail}), /没有指令观测/);
  const workspace = {kind: 'gpu-sim-workspace', version: 2, activeRun: 'macro', runs: {
    macro: {trace: trace()}, detail: {trace: claimedDetail},
  }};
  const before = structuredClone(workspace);
  assert.throws(() => decodeWorkspace(workspace), /没有指令观测/);
  assert.deepEqual(workspace, before);
});

test('malformed capability fields and observer payloads fail before generic normalization', () => {
  for (const capabilities of ['instruction_spans', null, 7, ['instruction_spans', 7]]) {
    const input = trace();
    input.meta.capabilities = capabilities;
    assert.throws(() => normalizeRun(input), /meta.capabilities/);
  }
  const observer = {...trace(), format: 'gpu-sim-instruction-observer-v1'};
  assert.throws(() => normalizeRun(observer), /缺少 instruction_spans/);
  const validDetail = normalizeRun(trace(['instruction_spans']));
  assert.equal(validDetail.events[0].args.granularity, 'instruction');
  assert.equal(validDetail.meta.runId, 'illustrative-detail');
});

test('legacy single-run workspaces remain readable and invalid secondary runs reject before replacement', () => {
  assert.equal(decodeWorkspace({kind: 'gpu-sim-workspace', version: 1, trace: trace(), view: {time: 3}}).runs.macro.view.time, 3);
  const input = {kind: 'gpu-sim-workspace', version: 2, activeRun: 'macro', runs: {
    macro: {trace: trace()}, detail: {trace: trace()},
  }};
  assert.throws(() => decodeWorkspace(input), /粒度/);
  input.runs.detail.trace = trace(['instruction_spans']);
  input.runs.detail.trace.events[0].end = -1;
  assert.throws(() => decodeWorkspace(input), /起止时间/);
});
