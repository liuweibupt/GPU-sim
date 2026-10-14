import {TraceError} from './trace.js';

const fail = message => { throw new TraceError(`数据流记录：${message}`); };
const id = value => typeof value === 'string' && value.length > 0;
const positive = value => Number.isFinite(value) && value > 0;

/** Version 1 represents complete, unicast packet routes. Shared-data fanout uses
 * separate destination packets; it must not duplicate a packet on a branch.
 * Canonical timestamp/dependency validation runs before this transport contract.
 */
export function validateTrafficTrace(trace) {
  const topology = trace?.meta?.topology;
  if (!topology || !Array.isArray(topology.nodes) || !Array.isArray(topology.links)) fail('缺少 topology.nodes / links。');
  if (topology.nodes.length + topology.links.length > 2000) fail('拓扑超过 2,000 个组件。');
  if (trace.meta.trafficSchemaVersion !== 1) fail('需要 trafficSchemaVersion: 1。');
  const components = new Set(trace.components.map(component => component.id));
  const nodes = new Map(), links = new Map();
  for (const node of topology.nodes) {
    if (!node || !id(node.id) || nodes.has(node.id) || !components.has(node.id)) fail('节点 ID 重复、无效或没有对应组件。');
    nodes.set(node.id, node);
  }
  for (const link of topology.links) {
    if (!link || !id(link.id) || links.has(link.id) || nodes.has(link.id) || !components.has(link.id)) fail('链路 ID 重复、无效或没有对应组件。');
    if (!nodes.has(link.sourceId) || !nodes.has(link.targetId) || link.sourceId === link.targetId) fail(`链路 ${link.id} 的端点无效。`);
    if (!positive(link.bytesPerCycle) || !Number.isFinite(link.latencyCycles) || link.latencyCycles < 0) fail(`链路 ${link.id} 的带宽或延迟无效。`);
    if (link.capacity != null && (!Number.isInteger(link.capacity) || link.capacity < 1)) fail(`链路 ${link.id} 的容量无效。`);
    if (link.occupancy != null && link.occupancy !== 'serialization-only') fail(`链路 ${link.id} 的占用语义无效。`);
    links.set(link.id, link);
  }
  const packets = new Map(), services = new Map();
  for (const event of trace.events) {
    const flow = event.args?.flow;
    if (event.args?.stage !== 'transfer') continue;
    const link = links.get(event.args.linkId);
    if (!flow || !link || event.componentId !== link.id) fail(`事件 ${event.id} 缺少有效的数据包或链路。`);
    if (!id(flow.packetId) || !id(flow.requestId) || !id(flow.dataKey) || !id(flow.kind) ||
        !Number.isSafeInteger(flow.bytes) || flow.bytes <= 0) fail(`事件 ${event.id} 的数据包身份或字节数无效。`);
    if (flow.sourceId !== link.sourceId || flow.targetId !== link.targetId ||
        !nodes.has(flow.originId) || !nodes.has(flow.destinationId)) fail(`事件 ${event.id} 的数据包端点与拓扑不符。`);
    if (!Number.isInteger(event.args.hopIndex) || event.args.hopIndex < 0) fail(`事件 ${event.id} 缺少有效 hopIndex。`);
    const pipelined = link.occupancy === 'serialization-only';
    const release = pipelined ? event.args.issueReleaseCycle : event.end;
    const serialization = Math.ceil(flow.bytes / link.bytesPerCycle);
    if (!Number.isFinite(release) || release < event.start || release > event.end || release - event.start < serialization) fail(`事件 ${event.id} 超过链路带宽或释放时间无效。`);
    if (pipelined && release - event.start !== serialization) fail(`事件 ${event.id} 的流水链路占用不等于串行化时长。`);
    if (pipelined && event.end < release + (link.latencyCycles ?? 0)) fail(`事件 ${event.id} 的尾包到达早于传播延迟。`);
    if (event.args.serializationCycles != null && event.args.serializationCycles !== release - event.start) fail(`事件 ${event.id} 的串行化时长不一致。`);
    if (event.args.propagationCycles != null && event.args.propagationCycles !== event.end - release) fail(`事件 ${event.id} 的传播时长不一致。`);
    if (!packets.has(flow.packetId)) packets.set(flow.packetId, []);
    packets.get(flow.packetId).push(event);
    if (!services.has(link.id)) services.set(link.id, []);
    services.get(link.id).push(event);
  }
  for (const [packetId, hops] of packets) {
    hops.sort((a, b) => a.args.hopIndex - b.args.hopIndex);
    const first = hops[0].args.flow;
    for (let index = 0; index < hops.length; index++) {
      const event = hops[index], flow = event.args.flow;
      for (const key of ['requestId', 'dataKey', 'kind', 'bytes', 'originId', 'destinationId']) {
        if (flow[key] !== first[key]) fail(`数据包 ${packetId} 在途中改变了 ${key}。`);
      }
      if (index) {
        const previous = hops[index - 1];
        if (event.args.hopIndex !== previous.args.hopIndex + 1 ||
            flow.sourceId !== previous.args.flow.targetId || event.start < previous.end) fail(`数据包 ${packetId} 的路由不连续或违反到达时序。`);
      }
    }
    if (trace.meta.trafficComplete !== false && (hops[0].args.hopIndex !== 0 ||
        first.sourceId !== first.originId || hops.at(-1).args.flow.targetId !== first.destinationId)) fail(`数据包 ${packetId} 的完整路由与起终点不符。`);
  }
  for (const [linkId, spans] of services) {
    if (links.get(linkId).capacity !== 1) continue;
    spans.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let index = 1; index < spans.length; index++) {
      const previousRelease = links.get(linkId).occupancy === 'serialization-only' ? spans[index - 1].args.issueReleaseCycle : spans[index - 1].end;
      if (spans[index].start < previousRelease) fail(`单注入链路 ${linkId} 的串行化占用发生重叠。`);
    }
  }
  return trace;
}
