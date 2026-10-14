import {TraceError, validateTrace} from './trace.js';

// This identifies the inspected output grammar, not the version of an imported run.
export const FLASHGPU_FORMAT_REVISION = '291fbe172332eb481556632a79eb9cfc93cf46bf';
const OBSERVER_FORMAT = 'gpu-sim-instruction-observer-v1';
const DETAIL_CAPABILITIES = ['instruction_spans', 'instruction_observations'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const pc = value => typeof value === 'string' && /^0x[\da-f]+$/i.test(value);
function requireValue(condition, message) { if (!condition) throw new TraceError(message); }

function metadata(meta = {}) {
  requireValue(record(meta), '指令 trace 的 meta 必须是对象。');
  const result = {
    title: 'SM 指令观测', producer: 'unknown', producerRevision: 'unknown',
    backendVersion: 'unknown', runId: 'unknown', timeDomain: 'unknown',
    evidenceKind: 'simulation', timeUnit: 'cycle', ...meta
  };
  for (const key of ['producer', 'producerRevision', 'backendVersion', 'runId', 'timeDomain']) {
    requireValue(text(result[key]), `指令 trace 的 meta.${key} 必须是非空字符串；未知请填 unknown。`);
  }
  requireValue(['simulation', 'illustration'].includes(result.evidenceKind), '指令 observer 输出必须声明 simulation 或 illustration。');
  requireValue(result.timeUnit === 'cycle', '当前指令 observer 只支持显式单一 cycle 时间域。');
  return result;
}

function timingMetrics(metrics = {}, meta = {}) {
  requireValue(record(metrics), '指令 trace 的 metrics 必须是对象。');
  const result = {...metrics};
  if (meta.wallTimeSeconds != null) result.wallTimeSeconds = meta.wallTimeSeconds;
  if (meta.timingScope != null) result.timingScope = meta.timingScope;
  requireValue(result.wallTimeSeconds == null || (finite(result.wallTimeSeconds) && result.wallTimeSeconds >= 0), 'wallTimeSeconds 必须为实际测量的非负秒数。');
  requireValue(result.timingScope == null || text(result.timingScope), 'timingScope 必须说明墙钟耗时的测量范围。');
  requireValue(result.wallTimeSeconds == null || text(result.timingScope), '提供 wallTimeSeconds 时必须声明 timingScope。');
  return result;
}

function validateInstruction(event) {
  const args = event.args;
  requireValue(record(args) && args.granularity === 'instruction', `事件 ${event.id} 不是明确的 instruction 观测。`);
  requireValue(integer(args.smId) && integer(args.warpId), `指令 ${event.id} 需要实际 smId 和 warpId。`);
  requireValue(pc(args.pc), `指令 ${event.id} 需要保留为十六进制字符串的 PC。`);
  requireValue(text(args.opcode) || text(args.instructionText), `指令 ${event.id} 缺少 opcode / 原始 instructionText。`);
  requireValue(text(args.stage), `指令 ${event.id} 缺少实际观测 stage。`);
  for (const key of ['threadBlockId', 'dynamicWarpId', 'schedulerId']) {
    requireValue(args[key] == null || integer(args[key]), `指令 ${event.id} 的 ${key} 无效。`);
  }
  requireValue(args.activeMask == null || /^0x[\da-f]+$/i.test(args.activeMask), `指令 ${event.id} 的 activeMask 必须是十六进制字符串。`);
}

function validateDetailed(trace) {
  validateTrace(trace);
  const capabilities = trace.meta.capabilities;
  requireValue(Array.isArray(capabilities) && capabilities.some(c => DETAIL_CAPABILITIES.includes(c)), '缺少 instruction_spans / instruction_observations 能力声明；tile 节点不能当作指令。');
  const instructions = trace.events.filter(e => e.args?.granularity === 'instruction');
  requireValue(instructions.length > 0, '详细 trace 没有指令观测。');
  for (const event of instructions) {
    validateInstruction(event);
    requireValue(event.end > event.start ? capabilities.includes('instruction_spans') : capabilities.includes('instruction_observations'), `指令 ${event.id} 的区间/观测点与能力声明不一致。`);
  }
  requireValue(!capabilities.includes('instruction_spans') || instructions.some(e => e.end > e.start), 'instruction_spans 声明需要真实非零指令区间。');
  requireValue(!capabilities.includes('instruction_observations') || instructions.some(e => e.end === e.start), 'instruction_observations 声明需要真实时间点。');
  return trace;
}

function componentRecords(instructions) {
  const components = new Map([['gpu', {id: 'gpu', label: 'GPU instruction trace', kind: 'gpu'}]]);
  for (const entry of instructions) {
    const args = entry.args;
    const sm = `sm-${args.smId}`;
    const warp = `${sm}.warp-${args.warpId}${args.dynamicWarpId == null ? '' : `.dyn-${args.dynamicWarpId}`}`;
    if (!components.has(sm)) components.set(sm, {id: sm, label: `SM ${args.smId}`, kind: 'sm', parentId: 'gpu'});
    if (!components.has(warp)) components.set(warp, {id: warp, label: `SM ${args.smId} / warp ${args.warpId}${args.dynamicWarpId == null ? '' : ` (dynamic ${args.dynamicWarpId})`}`, kind: 'warp', parentId: sm});
    entry.componentId = warp;
  }
  return [...components.values()];
}

/** Strict custom observer output, or an already-normalized instruction trace.
 * Raw Accel-Sim input .tracez/.traceg is deliberately not accepted here.
 */
export function normalizeDetailedTrace(input) {
  requireValue(record(input), '指令 trace 必须是 JSON 对象。');
  if (input.schemaVersion === 1 && !Array.isArray(input.traceEvents)) {
    return validateDetailed({...input, meta: metadata(input.meta), metrics: timingMetrics(input.metrics)});
  }
  requireValue(input.format === OBSERVER_FORMAT, `需要 ${OBSERVER_FORMAT} 的后端观测输出，或带指令能力声明的统一 trace；SASS 输入不含仿真时序。`);
  requireValue(Array.isArray(input.instructions) && input.instructions.length > 0 && input.instructions.length <= 250000, 'instructions 需要 1–250,000 条实际观测。');
  const events = input.instructions.map(entry => {
    requireValue(record(entry) && text(entry.id), '指令观测需要唯一非空 id。');
    const {id, start, end, dependencies = [], ...observed} = entry;
    const args = {...observed, granularity: 'instruction'};
    if (args.instructionId != null) {
      requireValue(text(args.instructionId), `指令 ${id} 的 instructionId 无效。`);
      args.dynamicInstructionId = args.instructionId;
      delete args.instructionId;
    }
    const event = {id, name: args.opcode ?? args.instructionText, category: args.op ?? 'instruction', start, end, dependencies, args};
    validateInstruction(event);
    return event;
  });
  const capabilities = [];
  if (events.some(e => e.end > e.start)) capabilities.push('instruction_spans');
  if (events.some(e => e.end === e.start)) capabilities.push('instruction_observations');
  const meta = metadata(input.meta);
  delete meta.wallTimeSeconds;
  delete meta.timingScope;
  return validateDetailed({
    schemaVersion: 1, meta: {...meta, capabilities}, components: componentRecords(events), events,
    metrics: timingMetrics(input.metrics, input.meta), source: {format: OBSERVER_FORMAT, raw: input}
  });
}

/** Native FlashGPU-Sim scheduler output contains points, never durations. */
export function normalizeFlashGpuLog(log, suppliedMeta = {}) {
  requireValue(typeof log === 'string' && log.length <= 64 * 1024 * 1024, 'FlashGPU 日志必须是文本，最多 64 MiB；请先截取一个运行窗口。');
  const lines = log.split(/\r?\n/);
  requireValue(lines.length <= 500000, '日志最多 500,000 行；请先截取一个运行窗口。');
  const expression = /^\s*GPGPU-Sim Cycle (\d+): INSTRUCTION_ISSUE - Core (\d+) - Scheduler (\d+) - warp=(\d+) dyn=(\d+) event=(ISSUE|STALL_SCOREBOARD|STALL_READY_NO_ISSUE) op=(\S+) pc=(0x[\da-f]+) prod=(\S+) \| (.*)$/i;
  const events = [];
  let ignoredLines = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    const match = line.match(expression);
    if (!match) {
      requireValue(!/^\s*GPGPU-Sim Cycle .*: INSTRUCTION_ISSUE\s*-/.test(line), `第 ${index + 1} 行 INSTRUCTION_ISSUE 格式不受支持；未猜测其字段。`);
      ignoredLines++;
      continue;
    }
    const [, cycleText, smText, schedulerText, warpText, dynamicText, stage, op, address, producer, instructionText] = match;
    const [cycle, smId, schedulerId, warpId, dynamicWarpId] = [cycleText, smText, schedulerText, warpText, dynamicText].map(Number);
    requireValue([cycle, smId, schedulerId, warpId, dynamicWarpId].every(integer), `第 ${index + 1} 行整数超过精确表示范围。`);
    requireValue(instructionText.trim().length > 0, `第 ${index + 1} 行缺少指令文本，无法标为指令观测。`);
    requireValue(events.length < 250000, '日志最多导入 250,000 条指令观测；请先截取事件窗口。');
    events.push({
      id: `flashgpu:line-${index + 1}`, name: instructionText, category: op,
      start: cycle, end: cycle, dependencies: [],
      args: {granularity: 'instruction', stage, op, pc: address, instructionText, smId, schedulerId, warpId, dynamicWarpId, scoreboardProducer: producer, sourceLine: index + 1}
    });
  }
  requireValue(events.length > 0, '没有受支持的 FlashGPU INSTRUCTION_ISSUE 观测；需在后端启用 runtime tracing。');
  const meta = metadata({
    producer: 'FlashGPU-Sim', title: 'FlashGPU-Sim / SM 指令观测', timeDomain: 'flashgpu.gpu_total_cycle',
    description: '用户提供的 FlashGPU runtime 日志，来源未经核验。ISSUE/STALL 是周期观测点，没有指令完成时间；不保证覆盖多发射迭代中的每条指令，也不覆盖全部 stall 原因。未导入 cache/NoC 子阶段，未推断 CTA、active mask 或跨后端时间映射。',
    ...suppliedMeta
  });
  delete meta.wallTimeSeconds;
  delete meta.timingScope;
  return validateDetailed({
    schemaVersion: 1, meta: {...meta, capabilities: ['instruction_observations']},
    components: componentRecords(events), events,
    metrics: {...timingMetrics({}, suppliedMeta), observedEventCount: events.length, importSummary: {inputLines: lines.length, importedObservations: events.length, ignoredLines}},
    source: {format: 'flashgpu-runtime-log', formatReferenceRevision: FLASHGPU_FORMAT_REVISION, raw: log}
  });
}

export function isDetailedTrace(input) {
  try { normalizeDetailedTrace(input); return true; } catch { return false; }
}

/** Capability claims are backed by validated event shape, not backend names. */
export function detailCapabilities(trace) {
  if (!isDetailedTrace(trace)) return {instructions: false, instructionSpans: false, instructionObservations: false, pipelineStages: false, runId: null, timeDomain: null, backendVersion: null, wallTimeSeconds: null, observedEventCount: 0};
  const normalized = normalizeDetailedTrace(trace);
  const instructionEvents = normalized.events.filter(e => e.args?.granularity === 'instruction');
  return {
    instructions: true,
    instructionSpans: normalized.meta.capabilities.includes('instruction_spans'),
    instructionObservations: normalized.meta.capabilities.includes('instruction_observations'),
    // Neither adapter establishes complete pipeline-stage coverage.
    pipelineStages: false,
    runId: normalized.meta.runId, timeDomain: normalized.meta.timeDomain,
    backendVersion: normalized.meta.backendVersion,
    wallTimeSeconds: normalized.metrics.wallTimeSeconds ?? null,
    observedEventCount: instructionEvents.length
  };
}
