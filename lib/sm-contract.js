import {TraceError, validateTrace} from './trace.js';
import {SM_ARCHITECTURE, instantiateSmArchitecture} from './sm-architecture.js?v=sm-residency-3';

function requireSm(condition, message) {
  if (!condition) throw new TraceError(`SM 流水线契约：${message}`);
}
const text = value => typeof value === 'string' && value.length > 0;
const cycle = value => Number.isInteger(value) && value >= 0;

/** Modeled pipeline evidence has its own contract, distinct from SASS observers.
 * Validation never fills in stages, completion times, registers or transfers.
 */
export function validateSmTrace(trace) {
  validateTrace(trace);
  const {meta, metrics} = trace, config = meta.config, caps = meta.capabilities ?? [];
  requireSm(meta.smModelSchemaVersion === 1, '需要 smModelSchemaVersion: 1。');
  requireSm(caps.includes('sm_pipeline') && caps.includes('modeled_instruction_spans'), '缺少教学流水线能力声明。');
  requireSm(!caps.some(cap => ['instruction_spans', 'instruction_observations'].includes(cap)), '教学阶段不能同时声明为原生指令 observer。');
  requireSm(meta.evidenceKind !== 'measurement' && meta.timeUnit === 'cycle', '教学模型使用独立的 cycle 时间域，不能声明为测量。');
  requireSm(text(meta.timeDomain), '缺少独立 timeDomain。');
  requireSm(meta.smPipeline?.schemaVersion === 1 && meta.smPipeline.id === SM_ARCHITECTURE.id, '缺少受支持的版本化组件规格。');
  requireSm(config && Number.isInteger(config.smId) && config.smId >= 0 && config.smId < 132, 'smId 必须在 0–131 之间。');
  requireSm(Number.isInteger(config.warpCount) && config.warpCount >= 1 && config.warpCount <= 128, '提交的 warpCount 必须在 1–128 之间。');
  requireSm(Array.isArray(metrics?.instructions) && metrics.instructions.length > 0, '缺少指令生命周期记录。');
  const components = new Map(trace.components.map(component => [component.id, component]));
  const architecture = instantiateSmArchitecture(config.smId);
  const typedLinks = new Set(architecture.links.map(link => `${link.source}|${link.target}|${link.type}`));
  for (const expected of architecture.components) {
    const actual = components.get(expected.id);
    requireSm(actual?.args?.localComponentId === expected.args.localComponentId && actual.parentId === expected.parentId, `缺少规格组件 ${expected.id}。`);
  }
  const events = new Map(trace.events.map(event => [event.id, event]));
  const hasResidency = caps.includes('sm_residency') || metrics?.residency != null;
  const instructions = new Map();
  for (const instruction of metrics.instructions) {
    requireSm(text(instruction.id) && !instructions.has(instruction.id), '指令 ID 无效或重复。');
    requireSm(instruction.smId === config.smId && Number.isInteger(instruction.warpId) && instruction.warpId >= 0 && instruction.warpId < config.warpCount, `指令 ${instruction.id} 的 SM / warp 归属无效。`);
    requireSm(instruction.partitionId === instruction.warpId % 4, `指令 ${instruction.id} 的分区归属无效。`);
    requireSm(cycle(instruction.start) && cycle(instruction.issue) && cycle(instruction.end) && instruction.start <= instruction.issue && instruction.issue <= instruction.end, `指令 ${instruction.id} 的生命周期无效。`);
    requireSm(instruction.asyncEnd == null || (cycle(instruction.asyncEnd) && instruction.asyncEnd >= instruction.end), `指令 ${instruction.id} 的异步完成时间无效。`);
    requireSm(text(instruction.opcode) && Array.isArray(instruction.srcRegisters) && Array.isArray(instruction.dstRegisters), `指令 ${instruction.id} 缺少操作数。`);
    requireSm(Array.isArray(instruction.eventIds) && instruction.eventIds.length > 0 && new Set(instruction.eventIds).size === instruction.eventIds.length, `指令 ${instruction.id} 的阶段列表无效。`);
    instructions.set(instruction.id, instruction);
  }
  for (const event of trace.events) {
    const args = event.args, instruction = instructions.get(args?.instructionId);
    requireSm(instruction && args.smId === instruction.smId && args.warpId === instruction.warpId && args.partitionId === instruction.partitionId, `事件 ${event.id} 的指令归属无效。`);
    requireSm(cycle(event.start) && cycle(event.end) && text(args.stage), `事件 ${event.id} 的模型阶段或周期无效。`);
    requireSm(event.start >= instruction.start && event.end <= (instruction.asyncEnd ?? instruction.end), `事件 ${event.id} 超出指令生命周期。`);
    requireSm(instruction.eventIds.includes(event.id), `事件 ${event.id} 没有列入指令阶段。`);
    requireSm(args.opcode === instruction.opcode && Array.isArray(args.srcRegisters) && Array.isArray(args.dstRegisters), `事件 ${event.id} 的 opcode / 操作数无效。`);
    const component = components.get(event.componentId);
    requireSm(text(args.localComponentId) && component.args?.localComponentId === args.localComponentId, `事件 ${event.id} 的组件规格不匹配。`);
    if (args.stage === 'stall') requireSm(text(args.stallReason), `事件 ${event.id} 缺少等待原因。`);
    const transfer = args.smPipelineTransfer;
    if (transfer) {
      requireSm(components.has(transfer.sourceId) && components.has(transfer.targetId) && transfer.sourceId !== transfer.targetId, `事件 ${event.id} 的通路端点无效。`);
      requireSm(SM_ARCHITECTURE.linkTypes.includes(transfer.kind), `事件 ${event.id} 的通路类型无效。`);
      requireSm(typedLinks.has(`${transfer.sourceId}|${transfer.targetId}|${transfer.kind}`), `事件 ${event.id} 不符合组件端口的通路类型。`);
      requireSm(transfer.bytes == null || (Number.isInteger(transfer.bytes) && transfer.bytes > 0), `事件 ${event.id} 的字节数无效。`);
    }
  }
  for (const instruction of instructions.values()) for (const id of instruction.eventIds) {
    requireSm(events.get(id)?.args?.instructionId === instruction.id, `指令 ${instruction.id} 引用了不存在或他人的阶段 ${id}。`);
  }
  if (hasResidency) {
    requireSm(caps.includes('sm_residency'), 'CTA 驻留记录需要 sm_residency 能力声明。');
    validateResidency(trace, instructions, events);
  }
  return trace;
}

function validateResidency(trace, instructions, events) {
  const {config} = trace.meta, {residency, ctas, warps} = trace.metrics;
  const facts = SM_ARCHITECTURE.hardwareFacts;
  requireSm(residency?.schemaVersion === 1 && residency.policy === 'whole-cta-fifo', 'CTA 驻留版本或策略无效。');
  requireSm(Number.isInteger(config.warpsPerCta) && config.warpsPerCta >= 1 && config.warpsPerCta <= 32 &&
    Number.isInteger(config.registersPerThread) && config.registersPerThread >= 1 && config.registersPerThread <= 255, 'CTA/寄存器配置无效。');
  const limits = residency.limits;
  requireSm(limits && limits.warps === config.residentWarpLimit && cycle(limits.warps) && limits.warps >= 1 && limits.warps <= facts.maxResidentWarpsPerSm &&
    limits.ctas === config.residentCtaLimit && cycle(limits.ctas) && limits.ctas >= 1 && limits.ctas <= facts.maxResidentCtasPerSm &&
    limits.registers === facts.registers32BitPerSm && limits.registersPerPartition === facts.registers32BitPerSm / 4 &&
    cycle(limits.sharedBytes) && limits.sharedBytes <= facts.maxSharedBytesPerSm &&
    limits.sharedBytes + config.l1CapacityLines * 128 <= facts.unifiedL1SharedBytesPerSm, 'CTA 驻留资源上限无效。');
  const supportedCarveouts = SM_ARCHITECTURE.components.find(c => c.localId === 'shared-memory').resources.supportedCarveoutKiB;
  requireSm(supportedCarveouts.includes(limits.sharedBytes / 1024), 'SMEM carveout 必须来自公开支持的配置。');
  requireSm(Array.isArray(ctas) && ctas.length === Math.ceil(config.warpCount / config.warpsPerCta) &&
    Array.isArray(warps) && warps.length === config.warpCount, '缺少完整 CTA / warp 生命周期。');
  const sharedPerWarp = config.tmaBytes + ((31 * config.sharedBankStrideWords) + 1) * 4;
  for (let id = 0; id < ctas.length; id++) {
    const cta = ctas[id], expectedWarps = Array.from({length: Math.min(config.warpsPerCta, config.warpCount - id * config.warpsPerCta)}, (_, i) => id * config.warpsPerCta + i);
    const partitionRegisters = Array.from({length: 4}, (_, p) => expectedWarps.filter(warpId => warpId % 4 === p).length * 32 * config.registersPerThread);
    requireSm(cta.ctaId === id && cta.threadBlockId === id && JSON.stringify(cta.warpIds) === JSON.stringify(expectedWarps), `CTA ${id} 的 warp 归属无效。`);
    requireSm(cycle(cta.admitted) && cycle(cta.retired) && cta.admitted < cta.retired &&
      cta.registers === expectedWarps.length * 32 * config.registersPerThread &&
      JSON.stringify(cta.partitionRegisters) === JSON.stringify(partitionRegisters) && cta.userSharedBytes === expectedWarps.length * sharedPerWarp &&
      cta.reservedSharedBytes === facts.reservedSharedBytesPerCta && cta.sharedBytes === cta.userSharedBytes + cta.reservedSharedBytes &&
      cta.userSharedBytes <= facts.maxSharedBytesPerCta && cycle(cta.sharedOffsetBytes) &&
      cta.sharedOffsetBytes + cta.sharedBytes <= limits.sharedBytes, `CTA ${id} 的生命周期或资源需求无效。`);
  }
  const states = ['queued', 'fetching', 'waiting', 'ready', 'eligible', 'draining', 'retired'];
  for (let id = 0; id < warps.length; id++) {
    const warp = warps[id], cta = ctas[Math.floor(id / config.warpsPerCta)];
    requireSm(warp.warpId === id && warp.ctaId === cta.ctaId && warp.partitionId === id % 4 &&
      warp.admitted === cta.admitted && warp.retired === cta.retired && Array.isArray(warp.history) && warp.history.length > 0, `warp ${id} 的驻留归属无效。`);
    let previous = -1;
    for (const [historyIndex, entry] of warp.history.entries()) {
      requireSm(cycle(entry.time) && entry.time > previous && entry.time <= warp.retired && states.includes(entry.state), `warp ${id} 的状态时间序列无效。`);
      requireSm(typeof entry.ready === 'boolean' && typeof entry.eligible === 'boolean' &&
        entry.ready === ['ready', 'eligible'].includes(entry.state) && entry.eligible === (entry.state === 'eligible'), `warp ${id} 的 ready / eligible 状态不一致。`);
      requireSm((entry.time < warp.admitted) === (entry.state === 'queued') &&
        (entry.time === warp.retired) === (entry.state === 'retired'), `warp ${id} 的状态超出驻留生命周期。`);
      requireSm(entry.instructionId == null || instructions.get(entry.instructionId)?.warpId === id, `warp ${id} 的状态引用了其他指令。`);
      requireSm(entry.waitReason == null || text(entry.waitReason), `warp ${id} 的等待原因无效。`);
      if (['ready', 'eligible', 'waiting'].includes(entry.state)) {
        const instruction = instructions.get(entry.instructionId);
        const decoded = instruction?.eventIds.map(eventId => events.get(eventId)).find(event => event.args.stage === 'decode');
        const stateEnd = warp.history[historyIndex + 1]?.time ?? warp.retired;
        requireSm(decoded && decoded.end <= entry.time && stateEnd <= instruction.selected,
          `warp ${id} 的已译码head状态早于decode或晚于选择。`);
        if (entry.ready) {
          const previousInstructions = [...instructions.values()].filter(other => other.warpId === id && other.selected < instruction.selected);
          for (const register of [...instruction.srcRegisters, ...instruction.dstRegisters]) {
            const producer = previousInstructions.findLast(other => other.dstRegisters.includes(register));
            requireSm(!producer || producer.end <= entry.time, `warp ${id} 的ready状态早于寄存器生产者完成。`);
          }
          requireSm((instruction.waitFor ?? []).every(dependencyId => instructions.get(dependencyId)?.end <= entry.time), `warp ${id} 的ready状态早于完成依赖。`);
          if (instruction.opcode === 'MBAR.WAIT' || instruction.opcode === 'LDS') {
            const producer = previousInstructions.find(other => other.opcode === 'TMA.LOAD' && other.barrierId === instruction.barrierId);
            requireSm(producer?.asyncEnd <= entry.time, `warp ${id} 的ready状态早于异步barrier。`);
          }
        }
      } else requireSm(entry.instructionId == null, `warp ${id} 的非head状态不应引用已译码指令。`);
      previous = entry.time;
    }
    requireSm(warp.history[0].time === 0 && warp.history.at(-1).state === 'retired', `warp ${id} 的状态缺少起点或退场。`);
  }
  for (const instruction of instructions.values()) {
    const warp = warps[instruction.warpId], spans = instruction.eventIds.map(id => events.get(id));
    const issueEvent = spans.find(event => event.args.stage === 'issue'), selection = spans.find(event => event.args.stage === 'scoreboard');
    requireSm(instruction.threadBlockId === warp.ctaId && instruction.start >= warp.admitted &&
      Math.max(instruction.end, instruction.asyncEnd ?? instruction.end) <= warp.retired &&
      cycle(instruction.selected) && instruction.selected === selection?.start && instruction.selected <= instruction.issue &&
      instruction.issue === issueEvent?.start && instruction.issueEnd === issueEvent?.end, `指令 ${instruction.id} 的 CTA 驻留或 issue 区间无效。`);
    for (const id of instruction.eventIds) requireSm(events.get(id).args.threadBlockId === warp.ctaId, `事件 ${id} 的 CTA 归属无效。`);
  }
  requireSm(Array.isArray(residency.history) && residency.history.length === ctas.length * 2, 'CTA 驻留资源历史不完整。');
  const active = new Set(), retired = new Set();
  let previous = 0;
  for (const entry of residency.history) {
    const cta = ctas[entry.ctaId];
    requireSm(cta && cycle(entry.time) && entry.time >= previous, 'CTA 资源历史时间或引用无效。');
    if (entry.action === 'admit') {
      requireSm(!active.has(cta.ctaId) && !retired.has(cta.ctaId) && entry.time === cta.admitted, 'CTA 重复准入或准入时间不一致。');
      active.add(cta.ctaId);
    } else {
      requireSm(entry.action === 'retire' && active.has(cta.ctaId) && entry.time === cta.retired, 'CTA 退场无匹配准入。');
      active.delete(cta.ctaId); retired.add(cta.ctaId);
    }
    const selected = [...active].map(id => ctas[id]);
    const sharedRanges = [...selected].sort((a, b) => a.sharedOffsetBytes - b.sharedOffsetBytes);
    requireSm(sharedRanges.every((cta, index) => !index || sharedRanges[index - 1].sharedOffsetBytes + sharedRanges[index - 1].sharedBytes <= cta.sharedOffsetBytes), '驻留CTA的SMEM地址范围重叠。');
    const expected = {ctas: active.size, warps: selected.reduce((sum, cta) => sum + cta.warpIds.length, 0),
      registers: selected.reduce((sum, cta) => sum + cta.registers, 0), sharedBytes: selected.reduce((sum, cta) => sum + cta.sharedBytes, 0)};
    requireSm(Object.entries(expected).every(([key, value]) => entry[key] === value && value <= limits[key]) &&
      Array.isArray(entry.partitionRegisters) && entry.partitionRegisters.length === 4 &&
      entry.partitionRegisters.every((value, p) => value === selected.reduce((sum, cta) => sum + cta.partitionRegisters[p], 0) && value <= limits.registersPerPartition), 'CTA 资源占用记录不一致或超出预算。');
    previous = entry.time;
  }
  requireSm(active.size === 0 && retired.size === ctas.length, 'CTA 资源未完全退场。');
}
