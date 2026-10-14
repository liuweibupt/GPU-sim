import {TraceError, validateTrace} from './trace.js';
import {SM_ARCHITECTURE, instantiateSmArchitecture} from './sm-architecture.js';

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
  requireSm(Number.isInteger(config.warpCount) && config.warpCount >= 1 && config.warpCount <= 32, 'warpCount 必须在 1–32 之间。');
  requireSm(Array.isArray(metrics?.instructions) && metrics.instructions.length > 0, '缺少指令生命周期记录。');
  const components = new Map(trace.components.map(component => [component.id, component]));
  const architecture = instantiateSmArchitecture(config.smId);
  const typedLinks = new Set(architecture.links.map(link => `${link.source}|${link.target}|${link.type}`));
  for (const expected of architecture.components) {
    const actual = components.get(expected.id);
    requireSm(actual?.args?.localComponentId === expected.args.localComponentId && actual.parentId === expected.parentId, `缺少规格组件 ${expected.id}。`);
  }
  const events = new Map(trace.events.map(event => [event.id, event]));
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
  return trace;
}
