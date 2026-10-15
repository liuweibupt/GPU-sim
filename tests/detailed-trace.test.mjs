import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeDetailedTrace, normalizeFlashGpuLog, isDetailedTrace, detailCapabilities, FLASHGPU_FORMAT_REVISION} from '../lib/detailed-trace.js';

// Hand-written protocol fixtures. These are illustrations, never simulator results.
const line = (cycle, overrides = {}) => {
  const values = {sm: 1, scheduler: 0, warp: 3, dynamic: 7, stage: 'ISSUE', op: 'INT', pc: '0x123456789abcdef0', producer: '-', instruction: 'add.u32 %r1, %r2, %r3;', ...overrides};
  return `GPGPU-Sim Cycle ${cycle}: INSTRUCTION_ISSUE - Core ${values.sm} - Scheduler ${values.scheduler} - warp=${values.warp} dyn=${values.dynamic} event=${values.stage} op=${values.op} pc=${values.pc} prod=${values.producer} | ${values.instruction}`;
};
const fixtureMeta = {evidenceKind: 'illustration', runId: 'hand-written-test-only', backendVersion: 'fixture-format-only'};
const observer = () => ({
  format: 'gpu-sim-instruction-observer-v1',
  meta: {title: 'Illustrative observer contract test', producer: 'Test fixture; not Accel-Sim output', evidenceKind: 'illustration', backendVersion: 'fixture-v1', runId: 'fixture-run', timeDomain: 'fixture.core'},
  instructions: [{id: 'instruction-0', instructionId: 'dynamic-0', smId: 0, warpId: 2, threadBlockId: 4, pc: '0x100', opcode: 'IADD3', activeMask: '0xffffffff', start: 10, end: 14, stage: 'observed-issue-to-complete'}]
});

test('native FlashGPU observations retain cycles, IDs and text without synthetic spans', () => {
  const log = ['simulator banner', line(20, {stage: 'STALL_SCOREBOARD', producer: 'MEM_GLOBAL'}), line(21), line(21), 'GPGPU-Sim: INTERCONNECT - Core 1 - NoC icnt_cycle=500 event=INJECT'].join('\n');
  const trace = normalizeFlashGpuLog(log, fixtureMeta);
  assert.equal(trace.meta.evidenceKind, 'illustration');
  assert.deepEqual(trace.meta.capabilities, ['instruction_observations']);
  assert.equal(trace.meta.timeDomain, 'flashgpu.gpu_total_cycle');
  assert.deepEqual(trace.events.map(e => [e.start, e.end]), [[20,20],[21,21],[21,21]]);
  assert.equal(new Set(trace.events.map(e => e.id)).size, 3); // Repeated PCs are distinct observations.
  assert.equal(trace.events[0].args.pc, '0x123456789abcdef0'); // Never Number(address).
  assert.equal(trace.events[0].args.stage, 'STALL_SCOREBOARD');
  assert.equal(trace.events[0].category, 'STALL_SCOREBOARD');
  assert.equal(trace.events[0].args.op, 'INT');
  assert.equal(trace.events[0].args.scoreboardProducer, 'MEM_GLOBAL');
  assert.equal(trace.events[0].args.smId, 1);
  assert.equal(trace.events[0].args.warpId, 3);
  assert.equal(trace.events[0].args.dynamicWarpId, 7);
  assert.equal(trace.events[0].args.schedulerId, 0);
  assert.equal(trace.events[0].args.sourceLine, 2);
  assert.equal(trace.events[0].args.threadBlockId, undefined);
  assert.equal(trace.events[0].args.activeMask, undefined);
  assert.deepEqual(trace.events[0].dependencies, []); // Producer class is not a dependency ID.
  assert.equal(trace.source.raw, log);
  assert.equal(trace.source.formatReferenceRevision, FLASHGPU_FORMAT_REVISION);
  assert.equal(trace.metrics.importSummary.ignoredLines, 2);
  assert.equal(detailCapabilities(trace).instructionSpans, false);
});

test('native warp slot reuse remains distinct and unknown metadata remains unknown', () => {
  const trace = normalizeFlashGpuLog([line(2), line(4, {dynamic: 8})].join('\n'), {evidenceKind:'illustration'});
  assert.notEqual(trace.events[0].componentId, trace.events[1].componentId);
  assert.equal(trace.meta.runId, 'unknown');
  assert.equal(trace.meta.backendVersion, 'unknown');
  assert.equal(trace.meta.producerRevision, 'unknown');
  assert.equal(detailCapabilities(trace).wallTimeSeconds, null);
});

test('actual instruction interval contract preserves observed endpoints and identity', () => {
  const input = observer();
  const before = structuredClone(input);
  const trace = normalizeDetailedTrace(input);
  assert.deepEqual(input, before);
  assert.equal(trace.events[0].start, 10);
  assert.equal(trace.events[0].end, 14);
  assert.equal(trace.events[0].args.dynamicInstructionId, 'dynamic-0');
  assert.equal(trace.events[0].args.granularity, 'instruction');
  assert.deepEqual(trace.meta.capabilities, ['instruction_spans']);
  assert.equal(trace.source.raw, input);
  assert.equal(isDetailedTrace(trace), true);
  assert.equal(detailCapabilities(trace).instructionSpans, true);
  assert.equal(detailCapabilities(trace).pipelineStages, false);
  assert.deepEqual(normalizeDetailedTrace(trace).events, trace.events);
});

test('tile timing, backend names and raw SASS inputs do not imply detailed execution', async () => {
  const tile = JSON.parse(await readFile(new URL('../examples/gtsim-gemm.json', import.meta.url), 'utf8'));
  assert.equal(isDetailedTrace(tile), false);
  tile.meta.capabilities = ['instruction_spans'];
  assert.equal(isDetailedTrace(tile), false);
  assert.equal(isDetailedTrace({producer: 'Accel-Sim 2.0', tracez: 'input-only'}), false);
  assert.throws(() => normalizeDetailedTrace({format: 'traceg', instructions: []}), /SASS 输入/);
  assert.throws(() => normalizeFlashGpuLog('kernel-0.tracez'), /没有受支持/);
});

test('partial records, unsafe cycles and unsupported detailed grammar fail visibly', () => {
  assert.throws(() => normalizeFlashGpuLog(line('9007199254740992'), fixtureMeta), /精确表示/);
  assert.throws(() => normalizeFlashGpuLog(line(4).replace('warp=3', 'warp=?'), fixtureMeta), /第 1 行/);
  assert.throws(() => normalizeFlashGpuLog(line(4).replace('event=ISSUE', 'event=UNSUPPORTED'), fixtureMeta), /格式不受支持/);
  const input = observer();
  delete input.instructions[0].end;
  assert.throws(() => normalizeDetailedTrace(input), /起止时间无效/);
  const missingIdentity = observer();
  delete missingIdentity.instructions[0].smId;
  assert.throws(() => normalizeDetailedTrace(missingIdentity), /smId/);
});

test('detailed capability claims must match interval and point semantics', () => {
  const span = normalizeDetailedTrace(observer());
  span.meta.capabilities = ['instruction_observations'];
  assert.throws(() => normalizeDetailedTrace(span), /区间\/观测点/);
  const point = normalizeFlashGpuLog(line(3), fixtureMeta);
  point.meta.capabilities = ['instruction_spans'];
  assert.throws(() => normalizeDetailedTrace(point), /区间\/观测点/);
  const malformedPc = observer();
  malformedPc.instructions[0].pc = 256;
  assert.throws(() => normalizeDetailedTrace(malformedPc), /PC/);
});

test('simulation wall time is optional and requires a declared measurement scope', () => {
  const timed = normalizeFlashGpuLog(line(3), {...fixtureMeta, wallTimeSeconds: 2.4, timingScope: 'captured simulator process, excludes build'});
  assert.equal(timed.metrics.wallTimeSeconds, 2.4);
  assert.equal(timed.metrics.timingScope, 'captured simulator process, excludes build');
  assert.equal(timed.meta.wallTimeSeconds, undefined);
  assert.throws(() => normalizeFlashGpuLog(line(3), {...fixtureMeta, wallTimeSeconds: 2.4}), /timingScope/);
  assert.throws(() => normalizeFlashGpuLog(line(3), {...fixtureMeta, wallTimeSeconds: -1, timingScope: 'bad'}), /非负秒数/);
});
