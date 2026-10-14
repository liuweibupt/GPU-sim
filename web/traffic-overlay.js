// Presentation of explicit interconnect events. This module never generates a
// route, packet, queue, cache hit, or simulated time from compute activity.
const NS = "http://www.w3.org/2000/svg";

export const FLOW_COLORS = Object.freeze({
  "read-request": "#61aaff", "read-response": "#4ef1ce", shared: "#d9a1ff", writeback: "#ffad65",
});

export function flowColor(flow) {
  return flow?.kind === "writeback" ? FLOW_COLORS.writeback
    : flow?.kind === "read-response" && flow.shared ? FLOW_COLORS.shared
    : FLOW_COLORS[flow?.kind] ?? "#b5eaff";
}

/** Prefer the declared link endpoints; end-to-end origin/destination metadata
 * is deliberately not used as a shortcut across a multi-hop path. */
export function indexTraffic(topology, events = []) {
  const nodes = new Map((topology?.nodes ?? []).map(node => [node.id, node]));
  const links = new Map((topology?.links ?? []).map(link => [link.id, link]));
  const transfers = [], queues = [], services = [], byRequest = new Map();
  let omittedTransfers = 0;
  for (const event of events) {
    const flow = event.args?.flow;
    if (!Number.isFinite(event.start) || !Number.isFinite(event.end) || event.end <= event.start) continue;
    const stage = event.args?.stage;
    const link = links.get(event.args?.linkId ?? event.componentId);
    if (stage === "transfer") {
      if (!flow) {omittedTransfers++; continue;}
      if (!link || !nodes.has(link.sourceId) || !nodes.has(link.targetId)) {omittedTransfers++; continue;}
      const item = {event, flow, link}; transfers.push(item);
      if (!byRequest.has(flow.requestId)) byRequest.set(flow.requestId, []);
      byRequest.get(flow.requestId).push(item);
    } else if (stage === "queue" && link) queues.push({event, flow, link, metadata: event.args});
    else if (stage === "queue" && nodes.has(event.componentId)) queues.push({event, metadata: event.args, nodeId: event.componentId});
    else if (stage === "service" && nodes.has(event.componentId)) services.push({event, flow, metadata: event.args, nodeId: event.componentId});
  }
  return {nodes, links, transfers, queues, services, byRequest, omittedTransfers};
}

/** Half-open source intervals and pure interpolation make pause/seek/rewind
 * identical to playback. Zero-duration records never invent moving packets. */
export function trafficAt(index, time) {
  const active = values => values.filter(({event}) => event.start <= time && time < event.end);
  if (!Number.isFinite(time)) return {transfers: [], queues: [], services: []};
  return {transfers: active(index.transfers).map(item => ({...item, progress: (time - item.event.start) / (item.event.end - item.event.start)})),
    queues: active(index.queues), services: active(index.services)};
}

export function pointAlongRoute(route, progress) {
  if (!route?.length) return null;
  if (route.length === 1) return {...route[0], angle: 0};
  const distances = route.slice(1).map((point, index) => Math.hypot(point.x - route[index].x, point.y - route[index].y));
  let remaining = Math.max(0, Math.min(1, progress)) * distances.reduce((sum, value) => sum + value, 0);
  for (let i = 0; i < distances.length; i++) {
    if (remaining <= distances[i] || i === distances.length - 1) {
      const fraction = distances[i] ? remaining / distances[i] : 0, from = route[i], to = route[i + 1];
      return {x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction,
        angle: Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI};
    }
    remaining -= distances[i];
  }
  return {...route.at(-1), angle: 0};
}

export const TRAFFIC_OVERLAY_CSS = `
.gpu-traffic-wire{fill:none;stroke:#426574;stroke-width:1.15;opacity:.2;pointer-events:stroke}.gpu-traffic-wire:hover{stroke:#91d1db;opacity:.75;stroke-width:2}.gpu-traffic-active-wire{fill:none;stroke-width:2.3;opacity:.52;pointer-events:none}.gpu-traffic-selection{fill:none;stroke:#f0d7ff;stroke-width:3;opacity:.8;stroke-dasharray:6 4;pointer-events:none}.gpu-traffic-packet{cursor:pointer;outline:none}.gpu-traffic-packet .gpu-traffic-payload{stroke:#efffff;stroke-width:.7;filter:drop-shadow(0 0 5px var(--packet-color))}.gpu-traffic-packet .gpu-traffic-halo{fill:var(--packet-color);opacity:.16}.gpu-traffic-packet:hover .gpu-traffic-payload,.gpu-traffic-packet:focus-visible .gpu-traffic-payload,.gpu-traffic-packet[aria-pressed=true] .gpu-traffic-payload{stroke:#fff;stroke-width:2;filter:drop-shadow(0 0 9px var(--packet-color))}.gpu-traffic-tail{stroke:var(--packet-color);stroke-width:3;opacity:.65}.gpu-traffic-queue{cursor:pointer;outline:none}.gpu-traffic-queue rect{fill:#523516;stroke:#ffd18a;stroke-width:1}.gpu-traffic-queue text{fill:#fff1c5;font:600 10px ui-monospace,monospace;pointer-events:none}.gpu-traffic-service{fill:none;stroke:#e2b3ff;stroke-width:3;opacity:.7;pointer-events:none}.gpu-traffic-legend{display:flex;gap:12px;align-items:center;flex-wrap:wrap;font:11px/1.5 ui-monospace,monospace;color:#9ab9c9;padding:4px 10px 10px}.gpu-traffic-legend span{display:flex;align-items:center;gap:5px}.gpu-traffic-legend i{display:block;width:12px;height:5px;border-radius:1px;background:var(--packet-color);box-shadow:0 0 6px color-mix(in srgb,var(--packet-color) 40%,transparent)}.gpu-traffic-summary{margin-left:auto;color:#bddfe5}.gpu-traffic-evidence{display:flex;align-items:flex-start;gap:9px;min-height:42px;padding:9px 12px;margin:0 10px 10px;border:1px solid #345564;border-radius:6px;background:#102530;color:#91b4c5;font:11px/1.6 ui-monospace,monospace;overflow-wrap:anywhere}.gpu-traffic-evidence strong{color:#d4f5f1;font-weight:500}.gpu-traffic-evidence .gpu-traffic-detail{flex:1;min-width:0}.gpu-traffic-evidence .gpu-traffic-request{display:block;color:#c3a9eb}.gpu-traffic-evidence .gpu-traffic-hint{color:#7194a5}.gpu-traffic-evidence button{background:#183846;border:1px solid #456c7d;border-radius:5px;padding:3px 7px;color:#c8edf1;font:inherit;cursor:pointer;flex-shrink:0}.gpu-traffic-evidence button:hover{border-color:#a3dedf}.gpu-traffic-overflow{fill:#b9dce7;font:12px ui-monospace,monospace;paint-order:stroke;stroke:#0b1923;stroke-width:3px}
@media(max-width:600px){.gpu-traffic-legend{font-size:10px;gap:8px;padding-left:5px;padding-right:5px}.gpu-traffic-evidence{font-size:10px;margin-left:4px;margin-right:4px;padding:7px 8px}.gpu-traffic-summary{margin-left:0;width:100%}}
@media(prefers-reduced-motion:reduce){.gpu-traffic-packet *{filter:none!important}.gpu-traffic-selection{stroke-dasharray:none}}
`;

function svg(tag, attributes = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
function routeData(route) {return route.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(" ");}
function activate(node, action) {
  node.addEventListener("click", action);
  node.addEventListener("keydown", event => {if (event.key === "Enter" || event.key === " ") {event.preventDefault(); action();}});
}
function linkDescription(link) {return `${link.sourceId} → ${link.targetId}\n${link.bytesPerCycle ?? "?"} bytes/cycle · 延迟 ${link.latencyCycles ?? "?"} cycle${link.capacity == null ? "" : ` · 容量 ${link.capacity}`}`;}

/** The host supplies positions/routes for topology nodes. A rendered polyline
 * changes no simulated path or latency; event.args.linkId is authoritative. */
export function createTrafficOverlay({graphic, topology, events = [], positions = new Map(), routes = new Map(),
  onSelectEvent = () => {}, onInspect = () => {}} = {}) {
  const index = indexTraffic(topology, events), eventsById = new Map(events.map(event => [event.id, event])), base = svg("g", {class: "gpu-traffic-links"}), selection = svg("g"), activity = svg("g"), packets = svg("g"), queues = svg("g"), services = svg("g");
  const renderedRoutes = new Map();
  for (const link of index.links.values()) {
    const from = positions.get(link.sourceId), to = positions.get(link.targetId);
    const route = routes.get(link.id) ?? (from && to ? [from, to] : null);
    if (!route || route.length < 2) continue;
    renderedRoutes.set(link.id, route);
    const path = svg("path", {d: routeData(route), class: "gpu-traffic-wire", "data-gpu-link-id": link.id});
    path.append(svg("title", {}, linkDescription(link))); base.append(path);
  }
  graphic.append(base, selection, activity, services, queues, packets);
  const packetNodes = new Map(), activePaths = new Map(), queueNodes = new Map(), serviceNodes = new Map();
  let selectedRequest = null, lastRequest = null;
  function inspect(item) {onInspect(item.event);}
  function choose(item) {selectedRequest = item.flow?.requestId ?? item.metadata?.requestId ?? null; inspect(item); onSelectEvent(item.event.id);}
  function patchRequest(requestId) {
    if (requestId === lastRequest) return; lastRequest = requestId; selection.replaceChildren();
    const seen = new Set();
    for (const item of index.byRequest.get(requestId) ?? []) {
      if (seen.has(item.link.id)) continue; seen.add(item.link.id);
      const route = renderedRoutes.get(item.link.id); if (!route) continue;
      selection.append(svg("path", {d: routeData(route), class: "gpu-traffic-selection", "data-gpu-request-link": item.link.id}));
    }
  }
  return {index, element: packets, update({time = 0, selectedEventId = null} = {}) {
    const selected = eventsById.get(selectedEventId);
    selectedRequest = selected?.args?.flow?.requestId ?? selected?.args?.requestId ?? null; patchRequest(selectedRequest);
    const state = trafficAt(index, time), live = new Set(), liveLinks = new Set(), liveQueues = new Set(), liveServices = new Set();
    for (const item of state.transfers) {
      const route = renderedRoutes.get(item.link.id); if (!route) continue;
      const point = pointAlongRoute(route, item.progress); if (!point) continue;
      live.add(item.event.id); liveLinks.add(item.link.id);
      if (!activePaths.has(item.link.id)) {const path = svg("path", {d: routeData(route), class: "gpu-traffic-active-wire"}); activity.append(path); activePaths.set(item.link.id, path);}
      activePaths.get(item.link.id).setAttribute("stroke", flowColor(item.flow));
      let node = packetNodes.get(item.event.id);
      if (!node) {
        node = svg("g", {class: "gpu-traffic-packet", tabindex: 0, role: "button", "data-gpu-flow-event-id": item.event.id, "data-gpu-packet-id": item.flow.packetId, "data-gpu-request-id": item.flow.requestId});
        node.style.setProperty("--packet-color", flowColor(item.flow));
        node.append(svg("circle", {r: 18, class: "gpu-traffic-halo"}), svg("line", {x1: -24, y1: 0, x2: -7, y2: 0, class: "gpu-traffic-tail"}),
          svg("rect", {x: -9, y: -5, width: 18, height: 10, rx: 2, fill: flowColor(item.flow), class: "gpu-traffic-payload"}),
          svg("path", {d: "M-1 -2L3 0-1 2", fill: "none", stroke: "#092733", "stroke-width": 1}),
          svg("title", {}, `${item.flow.kind} · ${item.flow.bytes} bytes\n${item.flow.packetId} / ${item.flow.requestId}\n${linkDescription(item.link)}\n${item.event.start} → ${item.event.end} cycle\n数据 ${item.flow.dataKey}${item.flow.shared ? " · 共享输入" : ""}`));
        activate(node, () => choose(item)); node.addEventListener("pointerenter", () => inspect(item)); node.addEventListener("focus", () => inspect(item)); packets.append(node); packetNodes.set(item.event.id, node);
      }
      node.setAttribute("transform", `translate(${point.x} ${point.y}) rotate(${point.angle})`);
      node.setAttribute("aria-pressed", String(selectedEventId === item.event.id));
      node.setAttribute("aria-label", `${item.flow.kind} ${item.flow.bytes} bytes，${item.link.sourceId} 至 ${item.link.targetId}，请求 ${item.flow.requestId}`);
    }
    // Group only explicit queue spans at their contended link's source port.
    const groups = new Map();
    for (const item of state.queues) {const id = item.link?.id ?? item.nodeId; if (!groups.has(id)) groups.set(id, []); groups.get(id).push(item);}
    for (const [id, values] of groups) {
      const item = values[0], position = positions.get(item.link?.sourceId ?? item.nodeId); if (!position) continue; liveQueues.add(id);
      let node = queueNodes.get(id);
      if (!node) {node = svg("g", {class: "gpu-traffic-queue", tabindex: 0, role: "button", "data-gpu-queue-link": id}); node.append(svg("rect", {x: -13, y: -10, width: 26, height: 15, rx: 3}), svg("text", {x: 0, y: 1, "text-anchor": "middle"}), svg("title")); queues.append(node); queueNodes.set(id, node); activate(node, () => {if (node.queueItem) choose(node.queueItem);});}
      node.queueItem = item;
      const sourceKind = index.nodes.get(item.link?.sourceId ?? item.nodeId)?.kind;
      const offset = sourceKind === "hbm" ? {x: 65, y: item.link ? -18 : 20} : sourceKind === "l2" ? {x: 57, y: -17} : {x: 14, y: -10};
      node.setAttribute("transform", `translate(${position.x + offset.x} ${position.y + offset.y})`); node.querySelector("text").textContent = String(values.length);
      node.querySelector("title").textContent = `${values.length} 个显式等待区间\n${item.link ? linkDescription(item.link) : `${item.nodeId} 服务队列`}\n${values.map(value => `${value.flow?.packetId ?? value.metadata?.requestId ?? value.event.id}: ${value.event.start} → ${value.event.end}`).slice(0, 6).join("\n")}`;
      node.setAttribute("aria-label", `${id}，${values.length} 个显式等待区间，查看原始queue事件`);
    }
    const activeServiceNodeIds = new Set(state.services.map(item => item.nodeId));
    for (const id of activeServiceNodeIds) {const position = positions.get(id); if (!position) continue; liveServices.add(id); if (!serviceNodes.has(id)) {const circle = svg("circle", {cx: position.x, cy: position.y, r: 13, class: "gpu-traffic-service", "data-gpu-service-node": id}); services.append(circle); serviceNodes.set(id, circle);}}
    for (const [id, node] of packetNodes) if (!live.has(id)) {node.remove(); packetNodes.delete(id);}
    for (const [id, node] of activePaths) if (!liveLinks.has(id)) {node.remove(); activePaths.delete(id);}
    for (const [id, node] of queueNodes) if (!liveQueues.has(id)) {node.remove(); queueNodes.delete(id);}
    for (const [id, node] of serviceNodes) if (!liveServices.has(id)) {node.remove(); serviceNodes.delete(id);}
    return {...state, renderedTransfers: live.size, omittedTransfers: index.omittedTransfers};
  }, destroy() {for (const layer of [base, selection, activity, services, packets, queues]) layer.remove();}};
}
