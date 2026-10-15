import {TraceError} from './trace.js';
import {instantiateSmArchitecture, smComponentId, SM_ARCHITECTURE} from './sm-architecture.js';

export const FLASHGPU_PIPELINE_PREFIX = 'FLASHGPU_PIPELINE';
const CONFIG_PREFIX = 'FLASHGPU_PIPELINE_CONFIG';
const EVENTS = ['ISSUE', 'OPERAND_COLLECT', 'OPERAND_READY', 'EXECUTE', 'EXECUTE_END', 'WRITEBACK', 'COMPLETE'];
// Native functional-unit names, never instruction/opcode classifications. These
// are logical drawing placements, not a claim that this simulator models H100.
const UNIT_COMPONENTS = {SP: 'fp32', DP: 'fp64', INT: 'int32', SFU: 'sfu', TENSOR_CORE: 'tensor', MEM: 'lsu'};
const PAIRS = [
  ['ISSUE', 'OPERAND_COLLECT', 'instruction'],
  ['OPERAND_COLLECT', 'OPERAND_READY', null],
  ['OPERAND_READY', 'EXECUTE', 'instruction'],
  ['EXECUTE', 'EXECUTE_END', null],
  ['EXECUTE_END', 'WRITEBACK', 'completion'],
  // Native LSU loads can write back without the arithmetic EXECUTE_END hook.
  // This interval includes memory service/wait, not a physical wire latency.
  ['EXECUTE', 'WRITEBACK', 'completion'],
  ['WRITEBACK', 'COMPLETE', null],
  // Loads completing inside the LSU / stores have no observed RF writeback.
  ['EXECUTE', 'COMPLETE', null],
];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
function requireNative(condition, message) { if (!condition) throw new TraceError(`原生 SM observer：${message}`); }
function identity(entry) { return `${entry.smId}|${entry.dynamicInstructionId}`; }
const sameUnitMap = value => record(value) && JSON.stringify(Object.entries(value).sort()) === JSON.stringify(Object.entries(UNIT_COMPONENTS).sort());

function validateConfig(config) {
  requireNative(record(config) && config.schemaVersion === 1 && integer(config.smId), 'CONFIG 需要 schemaVersion: 1 和实际 smId。');
  requireNative(config.subCoreModel === true && config.schedulerCount === 4,
    '当前四分区映射只支持实际启用 subCoreModel 的 4 scheduler 配置。');
  requireNative(integer(config.registerBankCount) && config.registerBankCount > 0 && integer(config.genericCollectorCount) && config.genericCollectorCount > 0,
    'CONFIG 缺少实际 registerBankCount / genericCollectorCount。');
  const partitions = config.schedulerPartitionMap;
  requireNative(Array.isArray(partitions) && partitions.length === 4 && new Set(partitions).size === 4 && partitions.every(p => integer(p) && p < 4),
    'CONFIG 需要显式且一一对应的 schedulerPartitionMap。');
  requireNative(sameUnitMap(config.unitComponentMap), 'CONFIG 缺少受支持的显式 native unitComponentMap。');
  requireNative(Array.isArray(config.nativeUnits) && config.nativeUnits.length > 0, 'CONFIG 缺少实际 nativeUnits。');
  const unitIndexes = new Set();
  for (const unit of config.nativeUnits) {
    requireNative(record(unit) && integer(unit.index) && !unitIndexes.has(unit.index) && text(unit.name) && typeof unit.issuePartitioned === 'boolean',
      'CONFIG nativeUnits 的实际索引、名称或分区标志无效。');
    requireNative(unit.issuePartitioned ? integer(unit.issuePartitionId) && unit.issuePartitionId < 4 : unit.issuePartitionId == null,
      'CONFIG nativeUnits 的实际分区无效。');
    unitIndexes.add(unit.index);
  }
  return config;
}

function validatePoint(entry, config) {
  requireNative(record(entry) && entry.schemaVersion === 1 && EVENTS.includes(entry.event), '不支持的 PIPELINE schemaVersion / event。');
  for (const key of ['cycle', 'smId', 'warpId', 'dynamicWarpId', 'schedulerId', 'partitionId']) {
    requireNative(integer(entry[key]), `PIPELINE.${key} 必须是精确非负整数。`);
  }
  requireNative(config && config.smId === entry.smId, `SM ${entry.smId} 缺少 CONFIG。`);
  requireNative(entry.schedulerId < config.schedulerCount && config.schedulerPartitionMap[entry.schedulerId] === entry.partitionId,
    '指令分区必须匹配该 SM 实际 schedulerPartitionMap。');
  requireNative(text(entry.dynamicInstructionId) && /^0x[\da-f]+$/i.test(entry.pc) && text(entry.instructionText) && text(entry.nativeOp),
    'PIPELINE 缺少动态 UID、原始十六进制 PC、指令文本或 nativeOp。');
  for (const key of ['nativeUnitIndex', 'nativeIssuePartitionId', 'collectorId']) {
    requireNative(entry[key] == null || integer(entry[key]), `PIPELINE.${key} 无效。`);
  }
  requireNative(entry.collectorId == null || entry.collectorId < config.genericCollectorCount, 'collectorId 超出实际 collector 配置。');
  requireNative(entry.activeMask == null || (typeof entry.activeMask === 'string' && /^0x[\da-f]+$/i.test(entry.activeMask)), 'activeMask 需要原始十六进制字符串。');
  requireNative(entry.nativeIssuePartitioned == null || typeof entry.nativeIssuePartitioned === 'boolean', 'nativeIssuePartitioned 必须是布尔值。');
  if (entry.nativeIssuePartitioned === true) {
    requireNative(entry.nativeIssuePartitionId === entry.partitionId, '实际执行寄存器分区与 scheduler 分区不一致。');
  } else requireNative(entry.nativeIssuePartitionId == null, '未声明分区执行时不能提供 nativeIssuePartitionId。');
  if (entry.nativeUnit != null) requireNative(text(entry.nativeUnit) && Object.hasOwn(UNIT_COMPONENTS, entry.nativeUnit.trim()), `不支持的实际 nativeUnit：${entry.nativeUnit}`);
  if (entry.event === 'EXECUTE') requireNative(text(entry.nativeUnit) && integer(entry.nativeUnitIndex) && typeof entry.nativeIssuePartitioned === 'boolean',
    'EXECUTE 必须记录实际执行单元、索引和实际分区执行标志。');
  if (entry.nativeUnitIndex != null) {
    const unit = config.nativeUnits.find(unit => unit.index === entry.nativeUnitIndex);
    requireNative(unit && unit.name === entry.nativeUnit && unit.issuePartitioned === entry.nativeIssuePartitioned && unit.issuePartitionId === entry.nativeIssuePartitionId,
      '执行单元索引、原始名称和实际分区必须匹配 CONFIG.nativeUnits。');
  }
}

function groupsFor(points) {
  const groups = new Map(), uidSms = new Map();
  for (const point of points) {
    requireNative(!uidSms.has(point.dynamicInstructionId) || uidSms.get(point.dynamicInstructionId) === point.smId,
      `原生全局动态 UID ${point.dynamicInstructionId} 不能在多个 SM 重用。`);
    uidSms.set(point.dynamicInstructionId, point.smId);
    const key = identity(point);
    if (!groups.has(key)) groups.set(key, new Map());
    const group = groups.get(key);
    requireNative(!group.has(point.event), `动态指令 ${key} 重复 ${point.event} 观测。`);
    const first = group.values().next().value;
    if (first) for (const field of ['warpId', 'dynamicWarpId', 'schedulerId', 'partitionId', 'pc', 'instructionText', 'nativeOp']) {
      requireNative(point[field] === first[field], `动态指令 ${key} 的 ${field} 在阶段间发生变化。`);
    }
    group.set(point.event, point);
  }
  for (const [key, group] of groups) {
    let last = -1;
    for (const event of EVENTS) {
      const point = group.get(event);
      if (!point) continue;
      requireNative(point.cycle >= last, `动态指令 ${key} 的实际阶段周期次序无效。`);
      last = point.cycle;
    }
    const executed = group.get('EXECUTE')?.nativeUnit?.trim();
    const ended = group.get('EXECUTE_END')?.nativeUnit?.trim();
    requireNative(!executed || !ended || executed === ended, `动态指令 ${key} 的实际执行单元发生变化。`);
    const collected = group.get('OPERAND_COLLECT')?.collectorId;
    const ready = group.get('OPERAND_READY')?.collectorId;
    requireNative(collected == null || ready == null || collected === ready, `动态指令 ${key} 的实际 collector 发生变化。`);
  }
  return groups;
}

function mappedComponent(point, group) {
  let local;
  if (point.event === 'ISSUE') local = 'dispatch';
  if (['OPERAND_COLLECT', 'OPERAND_READY'].includes(point.event)) local = 'operand-collector';
  if (['EXECUTE', 'EXECUTE_END'].includes(point.event)) local = UNIT_COMPONENTS[point.nativeUnit?.trim() ?? group.get('EXECUTE')?.nativeUnit?.trim()];
  if (point.event === 'WRITEBACK') local = 'writeback';
  if (point.event === 'COMPLETE') {
    // Native store completion has no RF writeback. A completion without an
    // observed writeback is never automatically placed in the writeback box.
    if (group.has('WRITEBACK')) local = 'writeback';
    else if (group.get('EXECUTE')?.nativeUnit?.trim() === 'MEM') local = 'lsu';
  }
  return local ? smComponentId(point.smId, local, point.partitionId) : null;
}

function pointInstruction(point, group) {
  const {cycle, event, schemaVersion, id, ...observed} = point;
  const architectureComponentId = mappedComponent(point, group);
  return {id, start: cycle, end: cycle, ...observed, stage: event, nativeEvent: event,
    observationRole: 'point', ...(architectureComponentId ? {architectureComponentId} : {})};
}

/** Parse instrumented native JSONL. Other simulator diagnostics are retained in
 * source.raw, while malformed/unknown observer records fail visibly. */
export function flashGpuPipelineObserver(log, suppliedMeta = {}) {
  requireNative(typeof log === 'string' && log.length <= 64 * 1024 * 1024, '日志必须是文本且不超过 64 MiB。');
  const lines = log.split(/\r?\n/);
  requireNative(lines.length <= 500000, '日志最多 500,000 行。');
  const configurations = new Map(), points = [];
  let ignoredLines = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    const config = line.startsWith(CONFIG_PREFIX);
    if (!config && !line.startsWith(FLASHGPU_PIPELINE_PREFIX)) { ignoredLines++; continue; }
    const prefix = config ? CONFIG_PREFIX : FLASHGPU_PIPELINE_PREFIX;
    requireNative(line.startsWith(`${prefix} {`), `第 ${index + 1} 行 observer 前缀/格式不受支持。`);
    let entry;
    try { entry = JSON.parse(line.slice(prefix.length + 1)); }
    catch { throw new TraceError(`原生 SM observer：第 ${index + 1} 行不是完整 JSON。`); }
    requireNative(record(entry), `第 ${index + 1} 行 observer 记录必须是 JSON 对象。`);
    if (config) {
      validateConfig(entry);
      requireNative(!configurations.has(entry.smId), `SM ${entry.smId} 重复 CONFIG。`);
      configurations.set(entry.smId, entry);
    } else {
      validatePoint(entry, configurations.get(entry.smId));
      requireNative(points.length < 250000, '原生观测超过 250,000 条；请截取窗口。');
      points.push({...entry, id: `flashgpu:pipeline:line-${index + 1}`, sourceLine: index + 1});
    }
  }
  requireNative(points.length > 0, '没有 FLASHGPU_PIPELINE 观测；需启用 instrumented native observer。');
  const groups = groupsFor(points);
  const instructions = points.map(point => pointInstruction(point, groups.get(identity(point))));
  const byId = new Map(instructions.map(instruction => [instruction.id, instruction]));
  let transferCount = 0, residenceCount = 0;
  for (const group of groups.values()) for (const [first, last, kind] of PAIRS) {
    if (first === 'EXECUTE' && last === 'WRITEBACK' && group.has('EXECUTE_END')) continue;
    const opening = group.get(first), closing = group.get(last);
    if (!opening || !closing || closing.cycle <= opening.cycle) continue;
    const start = byId.get(opening.id), end = byId.get(closing.id);
    if (!start.architectureComponentId || !end.architectureComponentId) continue;
    if (!kind && start.architectureComponentId !== end.architectureComponentId) continue;
    instructions.push({...start, id: `${start.id}:${last}`, start: opening.cycle, end: closing.cycle,
      stage: kind ? 'native-stage-transition' : 'native-stage-residence', observationRole: kind ? 'transition' : 'residence',
      observedEndpoints: {startEventId: start.id, endEventId: end.id},
      ...(kind ? {smPipelineTransfer: {sourceId: start.architectureComponentId, targetId: end.architectureComponentId, kind}} : {})});
    if (kind) transferCount++; else residenceCount++;
  }
  requireNative(instructions.length <= 250000, '观测及实际阶段区间超过 250,000 条；请截取窗口。');
  return {
    format: 'gpu-sim-instruction-observer-v1',
    meta: {title: 'FlashGPU-Sim / 原生 SM 流水线', producer: 'FlashGPU-Sim', timeDomain: 'flashgpu.gpu_total_cycle',
      description: '原生后端观测。光点位置在同一动态指令实际阶段时间戳之间插值；区间包含等待/执行，并非物理连线传输延迟。未观测的取指、译码、缓存子阶段保持无活动。组件是示意布局，不代表该 native 配置是 H100。',
      ...suppliedMeta,
      pipelineObserver: {schemaVersion: 1, backend: 'FlashGPU-Sim', architectureId: SM_ARCHITECTURE.id,
        configurations: [...configurations.values()], unitComponentMap: {...UNIT_COMPONENTS},
        transitionTiming: 'observed-stage-endpoints', drawingScope: 'logical-native-unit-placement'}},
    instructions,
    metrics: {nativeObservationCount: points.length, nativeDynamicInstructionCount: groups.size,
      nativeTransferCount: transferCount, nativeResidenceCount: residenceCount,
      nativeCompletedInstructionCount: [...groups.values()].filter(group => group.has('COMPLETE')).length,
      importSummary: {inputLines: lines.length, importedObservations: points.length, ignoredLines}},
  };
}

/** Reject unbacked architecture/transition claims, including on normalized
 * JSON imports. Every interval names two retained native observations. */
export function validateNativePipelineTrace(trace) {
  const mapped = trace.events.filter(event => event.args?.architectureComponentId || event.args?.smPipelineTransfer);
  const claims = trace.meta.capabilities ?? [];
  const observer = trace.meta.pipelineObserver;
  if (!observer && !claims.some(c => ['instruction_pipeline_stages', 'observed_stage_transitions'].includes(c))) {
    // Other explicit instruction observers may map to the same formal drawing.
    // Validate their declared IDs/links without requiring a FlashGPU header or
    // imposing FlashGPU's native lifecycle/UID conventions on another backend.
    const genericArchitectures = new Map();
    for (const event of mapped) {
      const args = event.args;
      if (!genericArchitectures.has(args.smId)) genericArchitectures.set(args.smId, instantiateSmArchitecture(args.smId));
      const architecture = genericArchitectures.get(args.smId);
      const ids = new Set(architecture.components.map(component => component.id));
      requireNative(!args.architectureComponentId || ids.has(args.architectureComponentId), `事件 ${event.id} 的组件映射无效。`);
      const flow = args.smPipelineTransfer;
      if (!flow) continue;
      const topology = new Set(architecture.links.map(link => `${link.source}|${link.target}|${link.type}`));
      const route = flow.route ?? [flow.sourceId, flow.targetId];
      requireNative(record(flow) && event.end > event.start && Array.isArray(route) && route.length >= 2 && new Set(route).size === route.length &&
        route[0] === flow.sourceId && route.at(-1) === flow.targetId && route.slice(1).every((target, index) => topology.has(`${route[index]}|${target}|${flow.kind}`)),
      `事件 ${event.id} 的显式通路不在同一 SM 的正式类型连接中。`);
    }
    return trace;
  }
  requireNative(record(observer) && observer.schemaVersion === 1 && observer.backend === 'FlashGPU-Sim' && observer.architectureId === SM_ARCHITECTURE.id,
    '缺少受支持的 pipelineObserver 来源/组件映射契约。');
  requireNative(Array.isArray(observer.configurations) && observer.configurations.length > 0, '缺少实际 native CONFIG。');
  const configs = new Map();
  for (const config of observer.configurations) {
    validateConfig(config);
    requireNative(!configs.has(config.smId), '重复的 native CONFIG。');
    configs.set(config.smId, config);
  }
  requireNative(sameUnitMap(observer.unitComponentMap),
    'native 执行单元映射不受支持；不能按 opcode 猜测执行单元。');
  requireNative(observer.transitionTiming === 'observed-stage-endpoints', '缺少实际阶段端点时间声明。');
  const points = trace.events.filter(event => event.args?.observationRole === 'point');
  requireNative(points.length > 0 && claims.includes('instruction_pipeline_stages'), '流水线能力需要实际阶段观测点。');
  const nativePoints = points.map(event => {
    requireNative(event.start === event.end, `观测点 ${event.id} 不得扩展成区间。`);
    const point = {...event.args, id: event.id, schemaVersion: 1, cycle: event.start, event: event.args.nativeEvent};
    validatePoint(point, configs.get(point.smId));
    requireNative(event.args.stage === point.event, `观测点 ${event.id} 的原生 stage 被改写。`);
    return point;
  });
  const groups = groupsFor(nativePoints), pointEvents = new Map(points.map(event => [event.id, event]));
  const architectures = new Map([...configs.keys()].map(smId => [smId, instantiateSmArchitecture(smId)]));
  const topology = new Map([...architectures].map(([smId, architecture]) => [smId, new Set(architecture.links.map(link => `${link.source}|${link.target}|${link.type}`))]));
  const componentIds = new Map([...architectures].map(([smId, architecture]) => [smId, new Set(architecture.components.map(component => component.id))]));
  let spans = 0, transfers = 0;
  const spanEndpoints = new Set();
  for (const event of trace.events) {
    const args = event.args, group = groups.get(identity(args ?? {}));
    requireNative(group && ['point', 'transition', 'residence'].includes(args.observationRole), `事件 ${event.id} 缺少原生动态指令归属。`);
    requireNative(integer(args.partitionId) && configs.get(args.smId)?.schedulerPartitionMap[args.schedulerId] === args.partitionId,
      `事件 ${event.id} 的实际分区映射无效。`);
    requireNative(!args.architectureComponentId || componentIds.get(args.smId)?.has(args.architectureComponentId), `事件 ${event.id} 的组件映射无效。`);
    if (args.observationRole === 'point') {
      const expected = mappedComponent({...args, event: args.nativeEvent}, group);
      requireNative((args.architectureComponentId ?? null) === expected && !args.smPipelineTransfer && !args.observedEndpoints,
        `观测点 ${event.id} 的原生组件映射无效。`);
      continue;
    }
    spans++;
    const endpoints = args.observedEndpoints;
    const start = pointEvents.get(endpoints?.startEventId), end = pointEvents.get(endpoints?.endEventId);
    requireNative(start && end && event.end > event.start && event.start === start.start && event.end === end.start,
      `事件 ${event.id} 必须精确保留两个实际观测端点。`);
    for (const point of [start, end]) for (const field of ['smId', 'warpId', 'dynamicWarpId', 'schedulerId', 'partitionId', 'dynamicInstructionId', 'pc', 'instructionText', 'nativeOp']) {
      requireNative(args[field] === point.args[field], `事件 ${event.id} 的 ${field} 与实际端点不一致。`);
    }
    const pair = PAIRS.find(([first, last]) => first === start.args.nativeEvent && last === end.args.nativeEvent);
    requireNative(pair, `事件 ${event.id} 不是受支持的实际相邻阶段区间。`);
    requireNative(!(pair[0] === 'EXECUTE' && pair[1] === 'WRITEBACK' && group.has('EXECUTE_END')),
      `事件 ${event.id} 跳过已观测 EXECUTE_END 阶段。`);
    const endpointKey = `${start.id}|${end.id}`;
    requireNative(!spanEndpoints.has(endpointKey), `事件 ${event.id} 重复同一组实际阶段端点。`);
    spanEndpoints.add(endpointKey);
    requireNative(args.stage === (pair[2] ? 'native-stage-transition' : 'native-stage-residence'), `事件 ${event.id} 的区间类型与实际阶段不一致。`);
    requireNative(args.architectureComponentId === start.args.architectureComponentId, `事件 ${event.id} 的组件与起点不一致。`);
    if (args.observationRole === 'residence') {
      requireNative(pair[2] === null && !args.smPipelineTransfer && start.args.architectureComponentId === end.args.architectureComponentId,
        `事件 ${event.id} 的驻留区间跨越组件。`);
    } else {
      const flow = args.smPipelineTransfer;
      requireNative(pair[2] && record(flow) && flow.sourceId === start.args.architectureComponentId && flow.targetId === end.args.architectureComponentId && flow.kind === pair[2],
        `事件 ${event.id} 的通路不匹配实际阶段端点。`);
      const route = flow.route ?? [flow.sourceId, flow.targetId];
      requireNative(Array.isArray(route) && route.length >= 2 && new Set(route).size === route.length && route[0] === flow.sourceId && route.at(-1) === flow.targetId &&
        route.slice(1).every((target, index) => topology.get(args.smId).has(`${route[index]}|${target}|${flow.kind}`)),
      `事件 ${event.id} 的通路不在同一 SM 的正式类型连接中。`);
      transfers++;
    }
  }
  requireNative(claims.includes('observed_stage_transitions') === (transfers > 0), '阶段移动能力必须匹配实际端点区间。');
  requireNative(!spans || claims.includes('instruction_spans'), '实际阶段区间需要 instruction_spans。');
  return trace;
}
