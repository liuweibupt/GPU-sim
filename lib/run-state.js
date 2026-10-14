import {normalizeTrace, TraceError} from './trace.js';
import {normalizeDetailedTrace} from './detailed-trace.js';

/** Route declared detailed inputs before validation so an invalid claim cannot
 * fall back to the more permissive activity/tile schema.
 */
export function normalizeRun(input) {
  const capabilities = input?.meta?.capabilities;
  if (capabilities !== undefined && (!Array.isArray(capabilities) ||
      capabilities.some(capability => typeof capability !== 'string' || !capability))) {
    throw new TraceError('meta.capabilities 必须是非空能力名称的数组。');
  }
  const detailed = input?.format === 'gpu-sim-instruction-observer-v1' ||
    capabilities?.some(capability => ['instruction_spans', 'instruction_observations'].includes(capability));
  return detailed ? normalizeDetailedTrace(input) : normalizeTrace(input);
}

/** A view never converts tile intervals to instructions or shares a run's clock. */
export function runKind(trace) {
  const caps = trace?.meta?.capabilities ?? [];
  if (caps.includes('instruction_spans') || caps.includes('instruction_observations')) return 'detail';
  return 'macro';
}

export function describeRun(trace) {
  const caps = trace?.meta?.capabilities ?? [];
  const detail = runKind(trace) === 'detail';
  const tiles = caps.includes('tile_tasks') || (trace?.meta?.producer?.includes('GTSim') && trace.events.some(e => e.args?.tile));
  return {
    kind: detail ? 'detail' : 'macro',
    granularity: detail ? (caps.includes('instruction_spans') ? '指令区间' : '指令观测点') : tiles ? 'Tile 操作' : 'Profile 区间',
    backend: trace?.meta?.backend ?? trace?.meta?.producer ?? '未载入',
    version: trace?.meta?.backendVersion ?? null,
    wallTimeSeconds: Number.isFinite(trace?.metrics?.wallTimeSeconds) && trace.metrics.wallTimeSeconds >= 0 ? trace.metrics.wallTimeSeconds : null,
    timingScope: trace?.metrics?.timingScope ?? null,
    timeDomain: trace?.meta?.timeDomain ?? '当前 Trace 的独立时间域',
  };
}

/** Validate every run before replacing a workspace; a bad secondary run is atomic. */
export function decodeWorkspace(input, normalize = normalizeRun) {
  if (input?.kind !== 'gpu-sim-workspace') throw new TraceError('这不是 GPU 工作区文件。');
  if (input.version === 1) {
    const trace = normalize(input.trace), slot = runKind(trace);
    return {activeRun: slot, runs: {macro: null, detail: null, [slot]: {trace, view: input.view ?? null}}};
  }
  if (input.version !== 2 || !input.runs || !['macro', 'detail'].includes(input.activeRun)) throw new TraceError('不受支持的工作区；需要 version 1 或 2。');
  const runs = {macro: null, detail: null};
  for (const slot of ['macro', 'detail']) {
    if (!input.runs[slot]) continue;
    const trace = normalize(input.runs[slot].trace);
    if (runKind(trace) !== slot) throw new TraceError(`${slot} 运行的粒度与运行槽不一致。`);
    runs[slot] = {trace, view: input.runs[slot].view ?? null};
  }
  if (!runs[input.activeRun]) throw new TraceError('工作区的当前运行不存在。');
  return {runs, activeRun: input.activeRun};
}
