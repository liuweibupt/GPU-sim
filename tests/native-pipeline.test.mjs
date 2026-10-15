import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {normalizeDetailedTrace, normalizeFlashGpuPipelineLog, detailCapabilities} from '../lib/detailed-trace.js';
import {normalizeRun, describeRun, decodeWorkspace} from '../lib/run-state.js';

// Protocol illustrations only. The checked-in native capture is tested below.
const unitComponentMap = {SP: 'fp32', INT: 'int32', DP: 'fp64', SFU: 'sfu', TENSOR_CORE: 'tensor', MEM: 'lsu'};
const meta = {evidenceKind: 'illustration', runId: 'native-protocol-test', backendVersion: 'fixture-only'};
const config = (smId = 0) => ({schemaVersion: 1, smId, subCoreModel: true, schedulerCount: 4,
  registerBankCount: 16, genericCollectorCount: 16, schedulerPartitionMap: [0, 1, 2, 3], unitComponentMap,
  nativeUnits: [
    ...[0, 1, 2, 3].map(p => ({index: p, name: 'SP ', issuePartitioned: true, issuePartitionId: p})),
    ...[0, 1, 2, 3].map(p => ({index: 8 + p, name: 'INT ', issuePartitioned: true, issuePartitionId: p})),
    {index: 22, name: 'MEM ', issuePartitioned: false},
    // Merely being configured never lights an unobserved component.
    {index: 23, name: 'CP_ASYNC', issuePartitioned: false},
  ]});
const point = (event, cycle, overrides = {}) => ({schemaVersion: 1, cycle, smId: 0, warpId: 2,
  dynamicWarpId: 8, dynamicInstructionId: 'uid-90071992547409931234', schedulerId: 0, partitionId: 0,
  pc: '0x123456789abcdef0', instructionText: 'add.u32 %r1, %r2, %r3;', nativeOp: 'INT', event,
  ...(['EXECUTE', 'EXECUTE_END'].includes(event) ? {nativeUnit: 'INT '} : {}),
  ...(event === 'EXECUTE' ? {nativeUnitIndex: 8, nativeIssuePartitioned: true, nativeIssuePartitionId: 0} : {}),
  ...(['OPERAND_COLLECT', 'OPERAND_READY'].includes(event) ? {collectorId: 3} : {}), ...overrides});
const lifecycle = (overrides = {}, offset = 0) => ['ISSUE', 'OPERAND_COLLECT', 'OPERAND_READY', 'EXECUTE', 'EXECUTE_END', 'WRITEBACK', 'COMPLETE']
  .map((event, index) => point(event, offset + [10, 12, 16, 18, 22, 24, 25][index], overrides));
const log = (points = lifecycle(), configs = [config()]) => [
  'unrelated native simulator diagnostic', ...configs.map(c => `FLASHGPU_PIPELINE_CONFIG ${JSON.stringify(c)}`),
  ...points.map(p => `FLASHGPU_PIPELINE ${JSON.stringify(p)}`)].join('\n');

test('native observer keeps actual point endpoints and derives only measured stage intervals', () => {
  const raw = log(), trace = normalizeFlashGpuPipelineLog(raw, meta);
  assert.deepEqual(trace.meta.capabilities, ['instruction_spans', 'instruction_observations', 'instruction_pipeline_stages', 'observed_stage_transitions']);
  assert.equal(trace.source.raw, raw);
  assert.equal(trace.source.format, 'flashgpu-pipeline-runtime-log');
  assert.equal(trace.metrics.nativeObservationCount, 7);
  assert.equal(trace.metrics.nativeDynamicInstructionCount, 1);
  assert.equal(trace.metrics.nativeCompletedInstructionCount, 1);
  assert.equal(trace.metrics.nativeTransferCount, 3);
  assert.equal(trace.metrics.nativeResidenceCount, 3);
  assert.equal(trace.metrics.importSummary.ignoredLines, 1);
  assert.equal(detailCapabilities(trace).pipelineStages, true);
  assert.equal(describeRun(trace).granularity, '原生指令 / 流水线阶段');
  const points = trace.events.filter(e => e.args.observationRole === 'point');
  assert.equal(points.length, 7);
  assert.ok(points.every(e => e.start === e.end && e.args.pc === '0x123456789abcdef0' && e.args.dynamicInstructionId === 'uid-90071992547409931234'));
  const moving = trace.events.filter(e => e.args.smPipelineTransfer);
  assert.deepEqual(moving.map(e => [e.start, e.end, e.args.smPipelineTransfer.sourceId, e.args.smPipelineTransfer.targetId, e.args.smPipelineTransfer.kind]), [
    [10, 12, 'sm-0/p0/dispatch', 'sm-0/p0/operand-collector', 'instruction'],
    [16, 18, 'sm-0/p0/operand-collector', 'sm-0/p0/int32', 'instruction'],
    [22, 24, 'sm-0/p0/int32', 'sm-0/p0/writeback', 'completion'],
  ]);
  const byId = new Map(points.map(e => [e.id, e]));
  for (const event of trace.events.filter(e => e.end > e.start)) {
    assert.equal(event.start, byId.get(event.args.observedEndpoints.startEventId).start);
    assert.equal(event.end, byId.get(event.args.observedEndpoints.endEventId).start);
  }
  assert.deepEqual(normalizeDetailedTrace(trace), trace);
  assert.equal(decodeWorkspace({kind: 'gpu-sim-workspace', version: 1, trace}).activeRun, 'detail');
});

test('repeated PCs and reused warp slots stay distinct by actual dynamic UID in every SM', () => {
  const second = lifecycle({dynamicInstructionId: 'uid-second', dynamicWarpId: 9}, 30);
  const otherSm = lifecycle({smId: 1, dynamicInstructionId: 'uid-other-sm', schedulerId: 2, partitionId: 2, nativeUnitIndex: 10, nativeIssuePartitionId: 2}, 5)
    .map(p => p.event === 'EXECUTE' ? p : (() => { const q = {...p}; delete q.nativeUnitIndex; delete q.nativeIssuePartitionId; return q; })());
  const trace = normalizeFlashGpuPipelineLog(log([...lifecycle(), ...second, ...otherSm], [config(), config(1)]), meta);
  assert.equal(trace.metrics.nativeDynamicInstructionCount, 3);
  assert.equal(trace.metrics.nativeCompletedInstructionCount, 3);
  assert.deepEqual([...new Set(trace.events.map(e => e.args.smId))], [0, 1]);
  assert.ok(trace.events.filter(e => e.args.smId === 1).every(e => e.args.architectureComponentId?.startsWith('sm-1/p2/')));
  const pointGroups = new Map();
  for (const event of trace.events.filter(e => e.args.observationRole === 'point')) {
    const key = `${event.args.smId}|${event.args.dynamicInstructionId}`;
    pointGroups.set(key, (pointGroups.get(key) ?? 0) + 1);
  }
  assert.deepEqual([...pointGroups.values()], [7, 7, 7]);
});

test('native execution unit and actual scheduler config choose drawing placement, never opcode or warp modulo', () => {
  const points = lifecycle().map(p => ['EXECUTE', 'EXECUTE_END'].includes(p.event)
    ? {...p, nativeUnit: 'SP ', ...(p.event === 'EXECUTE' ? {nativeUnitIndex: 0} : {})} : p);
  const trace = normalizeFlashGpuPipelineLog(log(points), meta);
  const execute = trace.events.find(e => e.args.nativeEvent === 'EXECUTE' && e.args.observationRole === 'point');
  assert.equal(execute.args.nativeOp, 'INT');
  assert.equal(execute.args.warpId, 2);
  assert.equal(execute.args.partitionId, 0);
  assert.equal(execute.args.architectureComponentId, 'sm-0/p0/fp32');
  assert.ok(!trace.events.some(e => /\/int32$/.test(e.args.architectureComponentId)));
});

test('partial windows never gain synthetic completion, missing stages or nonzero zero-cycle transfers', () => {
  const single = normalizeFlashGpuPipelineLog(log([point('ISSUE', 10)]), meta);
  assert.equal(single.events.length, 1);
  assert.equal(single.metrics.nativeCompletedInstructionCount, 0);
  assert.deepEqual(single.meta.capabilities, ['instruction_observations', 'instruction_pipeline_stages']);
  const truncated = normalizeFlashGpuPipelineLog(log(lifecycle().slice(0, 4)), meta);
  assert.ok(!truncated.events.some(e => e.args.nativeEvent === 'COMPLETE'));
  assert.ok(truncated.events.every(e => e.end <= 18));
  const missing = normalizeFlashGpuPipelineLog(log(lifecycle().filter(p => p.event !== 'OPERAND_READY')), meta);
  assert.ok(!missing.events.some(e => e.args.smPipelineTransfer?.targetId.endsWith('/int32')));
  const instant = normalizeFlashGpuPipelineLog(log([point('ISSUE', 10), point('OPERAND_COLLECT', 10)]), meta);
  assert.equal(instant.events.length, 2);
  assert.ok(!instant.events.some(e => e.args.smPipelineTransfer));
});

test('native memory completion without RF writeback remains observed LSU residence', () => {
  const points = lifecycle().filter(p => !['EXECUTE_END', 'WRITEBACK'].includes(p.event)).map(p => ({...p, nativeOp: 'STORE',
    ...(p.event === 'EXECUTE' ? {nativeUnit: 'MEM ', nativeUnitIndex: 22, nativeIssuePartitioned: false, nativeIssuePartitionId: undefined} : {})}));
  const trace = normalizeFlashGpuPipelineLog(log(points), meta);
  assert.ok(!trace.events.some(e => e.args.architectureComponentId.endsWith('/writeback')));
  const complete = trace.events.find(e => e.args.nativeEvent === 'COMPLETE');
  assert.equal(complete.args.architectureComponentId, 'sm-0/p0/lsu');
  const residence = trace.events.find(e => e.args.observationRole === 'residence' && e.args.architectureComponentId.endsWith('/lsu'));
  assert.deepEqual([residence.start, residence.end], [18, 25]);
  assert.equal(residence.args.smPipelineTransfer, undefined);
});

test('native load writeback without EXECUTE_END keeps measured memory-wait progression', () => {
  const points = lifecycle().filter(p => p.event !== 'EXECUTE_END').map(p => ({...p, nativeOp: 'LOAD',
    ...(p.event === 'EXECUTE' ? {nativeUnit: 'MEM ', nativeUnitIndex: 22, nativeIssuePartitioned: false, nativeIssuePartitionId: undefined} : {})}));
  const trace = normalizeFlashGpuPipelineLog(log(points), meta);
  const memory = trace.events.find(e => e.args.smPipelineTransfer?.sourceId.endsWith('/lsu'));
  assert.deepEqual([memory.start, memory.end, memory.args.smPipelineTransfer.targetId, memory.args.smPipelineTransfer.kind],
    [18, 24, 'sm-0/p0/writeback', 'completion']);
  const ordinary = normalizeFlashGpuPipelineLog(log(), meta);
  assert.ok(!ordinary.events.some(e => e.start === 18 && e.end === 24));
});

test('unsupported grammar, config, identity and lifecycle corruption reject visibly', () => {
  assert.throws(() => normalizeFlashGpuPipelineLog('FLASHGPU_PIPELINE {'), /完整 JSON/);
  assert.throws(() => normalizeFlashGpuPipelineLog('FLASHGPU_PIPELINE null'), /前缀\/格式/);
  assert.throws(() => normalizeFlashGpuPipelineLog('FLASHGPU_PIPELINE_V2 {}'), /前缀\/格式/);
  assert.throws(() => normalizeFlashGpuPipelineLog(log([point('UNKNOWN', 10)])), /event/);
  assert.throws(() => normalizeFlashGpuPipelineLog(log(lifecycle(), [])), /缺少 CONFIG/);
  assert.throws(() => normalizeFlashGpuPipelineLog(log(lifecycle(), [{...config(), subCoreModel: false}])), /subCoreModel/);
  assert.throws(() => normalizeFlashGpuPipelineLog(log(lifecycle(), [{...config(), schedulerPartitionMap: [0, 0, 2, 3]}])), /一一对应/);
  assert.throws(() => normalizeFlashGpuPipelineLog(log([point('ISSUE', Number.MAX_SAFE_INTEGER + 1)])), /精确非负整数/);
  assert.throws(() => normalizeFlashGpuPipelineLog(log([point('ISSUE', 10), point('ISSUE', 11)])), /重复 ISSUE/);
  assert.throws(() => normalizeFlashGpuPipelineLog(log([point('ISSUE', 10), point('OPERAND_COLLECT', 9)])), /周期次序/);
  assert.throws(() => normalizeFlashGpuPipelineLog(log([point('ISSUE', 10), point('OPERAND_COLLECT', 12, {pc: '0x102'})])), /pc.*变化/);
  assert.throws(() => normalizeFlashGpuPipelineLog(log([point('EXECUTE', 10, {nativeUnitIndex: 9})])), /匹配 CONFIG/);
  assert.throws(() => normalizeFlashGpuPipelineLog(log([point('EXECUTE', 10, {nativeUnit: 'CP_ASYNC', nativeUnitIndex: 23})])), /不支持的实际 nativeUnit/);
  assert.throws(() => normalizeFlashGpuPipelineLog(log([point('ISSUE', 10), point('ISSUE', 12, {smId: 1})], [config(), config(1)])), /多个 SM 重用/);
});

test('explicit custom observer mappings from other backends retain their supported integration', () => {
  const input = {format: 'gpu-sim-instruction-observer-v1', meta: {...meta, producer: 'Other native backend'}, instructions: [
    {id: 'other-point', smId: 0, warpId: 1, pc: '0x100', opcode: 'ADD', stage: 'native-dispatch', start: 10, end: 10,
      architectureComponentId: 'sm-0/p0/dispatch'},
    {id: 'other-transfer', smId: 0, warpId: 1, pc: '0x100', opcode: 'ADD', stage: 'native-transition', start: 10, end: 12,
      architectureComponentId: 'sm-0/p0/dispatch',
      smPipelineTransfer: {sourceId: 'sm-0/p0/dispatch', targetId: 'sm-0/p0/operand-collector', kind: 'instruction'}},
  ]};
  const trace = normalizeRun(input);
  assert.equal(trace.events.length, 2);
  assert.equal(trace.meta.pipelineObserver, undefined);
  assert.equal(detailCapabilities(trace).pipelineStages, false);
  assert.deepEqual(normalizeRun(trace), trace);
  const invalid = structuredClone(input);
  invalid.instructions[1].smPipelineTransfer.targetId = 'sm-1/p0/operand-collector';
  assert.throws(() => normalizeRun(invalid), /同一 SM/);
});

test('normalized imports reject unbacked stage timing, cross-SM edges and capability fallback', () => {
  const original = normalizeFlashGpuPipelineLog(log(), meta);
  const mutations = [
    t => {t.events.find(e => e.args.smPipelineTransfer).end++;},
    t => {t.events.find(e => e.args.smPipelineTransfer).args.smPipelineTransfer.targetId = 'sm-1/p0/operand-collector';},
    t => {t.events.find(e => e.args.smPipelineTransfer).args.observedEndpoints.endEventId = 'missing';},
    t => {t.events.find(e => e.args.smPipelineTransfer).args.smPipelineTransfer.kind = 'memory';},
    t => {t.events.find(e => e.args.observationRole === 'point').args.architectureComponentId = 'sm-0/p0/issue';},
    t => {const copy = structuredClone(t.events.find(e => e.args.smPipelineTransfer)); copy.id += ':duplicate'; t.events.push(copy);},
    t => {delete t.meta.pipelineObserver;},
    t => {t.meta.capabilities = ['instruction_pipeline_stages'];},
  ];
  for (const mutate of mutations) {
    const input = structuredClone(original); mutate(input);
    assert.throws(() => normalizeRun(input));
  }
  const pointOnly = normalizeFlashGpuPipelineLog(log([point('ISSUE', 10)]), meta);
  pointOnly.meta.capabilities.push('observed_stage_transitions');
  assert.throws(() => normalizeRun(pointOnly), /阶段移动能力/);
});

test('bundled native pipeline sample reimports exactly and every moving light has actual UID endpoints', async () => {
  const [raw, json] = await Promise.all(['log', 'json'].map(ext => readFile(new URL(`../examples/flashgpu-vectoradd-pipeline.${ext}`, import.meta.url), 'utf8')));
  const bundled = normalizeRun(JSON.parse(json)), parsed = normalizeFlashGpuPipelineLog(raw);
  const digest = events => createHash('sha256').update(JSON.stringify(events)).digest('hex');
  assert.equal(digest(parsed.events), digest(bundled.events));
  assert.equal(bundled.meta.evidenceKind, 'simulation');
  assert.equal(bundled.metrics.nativeDynamicInstructionCount, 176);
  assert.equal(bundled.metrics.nativeCompletedInstructionCount, 176);
  assert.equal(bundled.metrics.nativeObservationCount, 1136);
  const byId = new Map(bundled.events.map(e => [e.id, e]));
  const moving = bundled.events.filter(e => e.args.smPipelineTransfer);
  assert.ok(moving.length > 400);
  for (const event of moving) {
    const start = byId.get(event.args.observedEndpoints.startEventId), end = byId.get(event.args.observedEndpoints.endEventId);
    assert.equal(event.start, start.start); assert.equal(event.end, end.start);
    assert.equal(start.args.dynamicInstructionId, end.args.dynamicInstructionId);
    assert.equal(start.args.smId, end.args.smId);
  }
  assert.equal(new Set(moving.map(e => e.args.dynamicInstructionId)).size, 176);
});
