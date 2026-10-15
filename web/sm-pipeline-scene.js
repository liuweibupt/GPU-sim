// Formal SM floorplan. The architecture is a definition, while activity is only
// evidence explicitly mapped by a source trace. Tile names never imply stages.
import {instantiateSmArchitecture, SM_ARCHITECTURE} from "../lib/sm-architecture.js?v=sm-residency-3";
import {createSmComponentBox, smBoxPortAnchor, smComponentBoxGeometry} from "./sm-component-box.js?v=sm-residency-3";
import {observationSnapshot} from "../lib/instruction-view.js?v=browser-perf-1";
import {createIntervalIndex} from "../lib/interval-index.js";

const NS = "http://www.w3.org/2000/svg";
const FLOW_TYPES = ["control", "instruction", "operand", "memory", "completion"];
const FLOW_LABELS = {control: "控制", instruction: "指令", operand: "操作数", memory: "内存", completion: "完成 / 唤醒"};
const LABELS = {
  "l0-icache": ["L0 I-Cache", "分区指令缓存"], fetch: ["Fetch", "指令取指"], decode: ["Decode", "指令译码"],
  "warp-scheduler": ["Warp Scheduler", "就绪 warp 选择"], scoreboard: ["Scoreboard", "寄存器依赖跟踪"], issue: ["Issue", "发射与资源准入"], dispatch: ["Dispatch", "执行端口分派"],
  "register-file": ["Register File", "寄存器读 / 写"], "operand-collector": ["Operand Collector", "操作数收集"],
  fp32: ["FP32 / FPU", "单精度浮点"], fp64: ["FP64 / FPU", "双精度浮点"], int32: ["INT32 ALU", "整数运算"], sfu: ["SFU", "特殊函数"],
  tensor: ["Tensor Core", "矩阵乘累加"], lsu: ["LSU", "访存地址 / 合并"], branch: ["Branch Unit", "分支 / 掩码"], writeback: ["Writeback", "结果回写 / 完成"],
  icache: ["SM I-Cache", "共享指令存储"], "constant-cache": ["Constant Cache", "只读常量路径"],
  "l1-cache": ["L1 Data Cache", "硬件管理的缓存"], "shared-memory": ["Shared Memory", "软件显式管理 / SMEM"],
  tma: ["TMA", "异步张量数据搬运"], mbarrier: ["mbarrier", "异步完成 / 字节计数"], texture: ["Texture Unit", "纹理访问路径"], "noc-interface": ["NoC Interface", "SM ↔ L2 外部边界"],
};
const SHORT_LABELS = {'warp-scheduler':'Sched', scoreboard:'SB', 'register-file':'RF',
  'operand-collector':'Operands', 'constant-cache':'Constant', 'l1-cache':'L1 Cache',
  'shared-memory':'SMEM', 'noc-interface':'NoC', 'l0-icache':'L0 I$',
  'icache':'SM I$', fp32:'FP32', fp64:'FP64', int32:'INT32', tensor:'Tensor',
  branch:'Branch', writeback:'WB'};
const OVERVIEW_LABELS = {...SHORT_LABELS, 'operand-collector':'OC', decode:'Dec', dispatch:'Disp',
  tensor:'Tensor', int32:'I32', branch:'BR', 'constant-cache':'C$', texture:'Tex', mbarrier:'mbar'};
// NVIDIA GH100 Figure 4 supplies functional hierarchy, not a physical area
// scale. Explicit trace stages remain individually selectable logical nodes.
const HARDWARE_ROWS = [
  ["sm-control-band", ["l0-icache", "warp-scheduler", "dispatch"]],
  ["sm-register-band", ["register-file"]],
  ["sm-execution-bank", ["int32", "fp32", "fp64", "tensor"]],
  ["sm-service-band", ["lsu", "sfu"]],
];
const LOGICAL_STAGES = ["fetch", "decode", "scoreboard", "issue", "operand-collector", "branch", "writeback"];
const HARDWARE_WEIGHTS = {"warp-scheduler": 2, dispatch: 1, int32: 2, fp32: 4, fp64: 2, tensor: 3, lsu: 4, sfu: 1};
let nextSceneId = 0;
const evidenceQueries = new WeakMap();

function countThrough(sorted, time, value = item => item) {
  let low = 0, high = sorted.length;
  while (low < high) {const middle = (low + high) >>> 1; if (value(sorted[middle]) <= time) low = middle + 1; else high = middle;}
  return low;
}
function queriesFor(evidence) {
  let queries = evidenceQueries.get(evidence);
  if (!queries) {
    const mapped = [...evidence.byComponent].flatMap(([componentId, events]) => events.map(event => ({event, componentId})));
    queries = {transfers: createIntervalIndex(evidence.transfers),
      mapped: createIntervalIndex(mapped, {start: item => item.event.start, end: item => item.event.end}), scopes: new Map()};
    evidenceQueries.set(evidence, queries);
  }
  return queries;
}
function scopedSummaryRows(evidence, scope) {
  const queries = queriesFor(evidence), key = JSON.stringify([scope?.threadBlockId == null ? null : String(scope.threadBlockId), scope?.warpId == null ? null : String(scope.warpId)]);
  if (queries.scopes.has(key)) return queries.scopes.get(key);
  const rows = new Map();
  for (const [id, source] of evidence.byComponent) {
    const events = source.filter(event => sourceEventsMatch(event, scope));
    const starts = [...events].sort((a, b) => a.start - b.start);
    const points = starts.filter(event => event.start === event.end), pointGroups = new Map();
    for (const event of points) {if (!pointGroups.has(event.start)) pointGroups.set(event.start, []); pointGroups.get(event.start).push(event);}
    rows.set(id, {events, starts, points, pointGroups, ends: events.map(event => event.end).sort((a, b) => a - b),
      spanEnds: events.filter(event => event.end > event.start).map(event => event.end).sort((a, b) => a - b)});
  }
  // Scope changes are infrequent. Bound retained indexes during long sessions.
  if (queries.scopes.size >= 8) queries.scopes.delete(queries.scopes.keys().next().value);
  queries.scopes.set(key, rows); return rows;
}

function dom(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function svg(tag, attributes = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}
function attribute(node, name, value) {const text = String(value); if (node.getAttribute(name) !== text) node.setAttribute(name, text);}
function content(node, value) {if (node.textContent !== value) node.textContent = value;}
function toggle(node, name, enabled) {if (node.classList.contains(name) !== Boolean(enabled)) node.classList.toggle(name, Boolean(enabled));}
function action(label, className, callback) {
  const node = dom("button", className, label); node.type = "button"; node.addEventListener("click", callback); return node;
}
function localId(component) {return component.localId ?? component.args?.localComponentId ?? component.args?.componentRole;}
function partitionId(component) {return component.partitionId ?? component.args?.partitionId;}
function sourceEventsMatch(event, scope) {
  return !scope || (scope.threadBlockId == null || String(scope.threadBlockId) === String(event.args?.threadBlockId)) &&
    (scope.warpId == null || String(scope.warpId) === String(event.args?.warpId));
}
function eventState(event) {
  if (event.args?.stage === "stall" || event.args?.stallReason || event.args?.state === "stalled") return "stall";
  if (event.args?.stage === "queue" || event.args?.state === "queued" || event.category === "queue") return "queue";
  if (event.args?.smPipelineTransfer || event.args?.stage === "transfer") return "transfer";
  return "active";
}

/** A route may cross several formal links; its measured interval stays intact. */
export function smPipelineTransferRoute(transfer = {}) {
  const route = transfer.route ?? [transfer.sourceId, transfer.targetId];
  return Array.isArray(route) && route.length >= 2 && route[0] === transfer.sourceId && route.at(-1) === transfer.targetId ? route : [];
}

/** Distance-weighted interpolation does not invent intermediate stage times. */
export function smPipelineRoutePosition(lengths, progress) {
  if (!Array.isArray(lengths) || !lengths.length || lengths.some(length => !Number.isFinite(length) || length < 0) || !Number.isFinite(progress)) return null;
  const total = lengths.reduce((sum, length) => sum + length, 0); if (!total) return null;
  let distance = Math.max(0, Math.min(1, progress)) * total;
  for (let index = 0; index < lengths.length; index++) {
    if (distance < lengths[index] || index === lengths.length - 1) return {index, distance: Math.min(lengths[index], distance)};
    distance -= lengths[index];
  }
  return null;
}

/** Exact IDs or explicit source mappings are the only admissible evidence. */
export function indexSmPipelineEvidence(architecture, events = [], components = []) {
  const ids = new Set(architecture.components.map(component => component.id));
  const typedLinks = new Set(architecture.links.map(link => `${link.source}|${link.target}|${link.type}`));
  const explicit = new Map();
  for (const component of components) {
    const target = component.args?.architectureComponentId ?? component.architectureComponentId;
    if (ids.has(target)) explicit.set(component.id, target);
  }
  const byComponent = new Map(architecture.components.map(component => [component.id, []]));
  const transfers = [], unmapped = [], unresolvedTransfers = [];
  for (const event of events) {
    const explicitId = event.args?.architectureComponentId;
    const id = ids.has(explicitId) ? explicitId : ids.has(event.componentId) ? event.componentId : explicit.get(event.componentId);
    if (id) byComponent.get(id).push(event); else unmapped.push(event);
    const transfer = event.args?.smPipelineTransfer;
    if (transfer) {
      const route = smPipelineTransferRoute(transfer);
      if (route.length && route.slice(1).every((id, index) => typedLinks.has(`${route[index]}|${id}|${transfer.kind}`))) transfers.push(event);
      else unresolvedTransfers.push(event);
    }
  }
  const evidence = {byComponent, transfers, unmapped, unresolvedTransfers};
  queriesFor(evidence);
  return evidence;
}

/** Pure half-open snapshots make pause / seek / rewind independent of playback. */
export function summarizeSmPipelineEvidence(evidence, time, scope = null) {
  if (Number.isFinite(time)) {
    const result = new Map();
    for (const [id, row] of scopedSummaryRows(evidence, scope)) {
      const observed = countThrough(row.points, time, event => event.start), latest = countThrough(row.starts, time, event => event.start);
      const cycle = observed ? row.points[observed - 1].start : null;
      result.set(id, {id, observed: row.events.length > 0, total: row.events.length, completed: countThrough(row.ends, time),
        pointTotal: row.points.length, observedPoints: observed, observationCycle: cycle,
        pointsAtCursor: cycle !== null && cycle === time, points: cycle === null ? [] : row.pointGroups.get(cycle).slice(0, 6),
        endedSpans: countThrough(row.spanEnds, time), active: [], queue: [], stall: [], transfer: [], latest: latest ? row.starts[latest - 1] : null});
    }
    for (const {event, componentId} of queriesFor(evidence).mapped.at(time)) {
      if (sourceEventsMatch(event, scope)) result.get(componentId)[eventState(event)].push(event);
    }
    return result;
  }
  const result = new Map();
  for (const [id, source] of evidence.byComponent) {
    const events = source.filter(event => sourceEventsMatch(event, scope));
    const points = observationSnapshot(events, time, {limit: 6});
    const value = {id, observed: events.length > 0, total: events.length, completed: 0,
      pointTotal: points.total, observedPoints: points.observed, observationCycle: points.cycle,
      pointsAtCursor: points.atCursor, points: points.events, endedSpans: 0,
      active: [], queue: [], stall: [], transfer: [], latest: null};
    for (const event of events) {
      if (event.end <= time) value.completed++;
      if (event.end > event.start && event.end <= time) value.endedSpans++;
      if (event.start <= time && (!value.latest || event.start >= value.latest.start)) value.latest = event;
      if (event.start <= time && time < event.end) value[eventState(event)].push(event);
    }
    result.set(id, value);
  }
  return result;
}

/** A token exists only for a source-supplied, nonzero typed transfer interval. */
export function smPipelineTransferMarks(evidence, time, scope = null, limit = 64) {
  const result = [];
  if (!Number.isFinite(time) || limit <= 0) return result;
  for (const event of queriesFor(evidence).transfers.at(time)) {
    if (!sourceEventsMatch(event, scope)) continue;
    result.push({event, ...event.args.smPipelineTransfer, progress: (time - event.start) / (event.end - event.start)});
    if (result.length >= limit) break;
  }
  return result;
}

/** Residency lights require explicit, nonzero component intervals as well. */
export function smPipelineStageMarks(evidence, time, scope = null, limit = 64) {
  const marks = [];
  if (!Number.isFinite(time) || limit <= 0) return marks;
  for (const {componentId, event} of queriesFor(evidence).mapped.at(time)) {
    if (event.args?.smPipelineTransfer || !sourceEventsMatch(event, scope)) continue;
    marks.push({event, componentId, state: eventState(event), progress: (time - event.start) / (event.end - event.start)});
    if (marks.length >= limit) return marks;
  }
  return marks;
}

/** Roof positions are visual slots, never assertions about physical FU lanes. */
export function smPipelineStagePoint(width, height, progress, slot = 0) {
  if (!Number.isFinite(progress) || !Number.isFinite(slot)) throw new RangeError("Light progress and slot must be finite");
  const {front, dx, dy} = smComponentBoxGeometry(width, height);
  const u = .18 + Math.max(0, Math.min(1, progress)) * .64;
  const v = .28 + ((Math.floor(slot) % 3 + 3) % 3) * .22;
  return {x: front.x + front.width * u + dx * v, y: front.y - dy * v};
}

function display(value) {
  if (value == null) return "来源未定义";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.length ? value.map(display).join("\n") : "[]";
  const entries = Object.entries(value); return entries.length ? entries.map(([key, item]) => `${key}: ${display(item)}`).join("\n") : "{}";
}
function palette(component) {
  const id = localId(component);
  if (id === "tensor") return "tensor";
  if (["fp32", "fp64", "int32", "sfu", "branch"].includes(id)) return "alu";
  if (["lsu", "l1-cache", "shared-memory", "texture", "noc-interface"].includes(id)) return "memory";
  if (["tma", "mbarrier"].includes(id)) return "async";
  if (["register-file", "operand-collector"].includes(id)) return "operand";
  return "control";
}



export function createSmPipelineScene({trace, sm, events = [], onSelectEvent = () => {}, onSelectComponent = () => {}, onResize = () => {}}) {
  const suppliedNumber = sm.args?.smId ?? sm.smId ?? /^sm[-:]?(\d+)$/.exec(sm.id)?.[1];
  const smNumber = suppliedNumber != null && Number.isSafeInteger(Number(suppliedNumber)) && Number(suppliedNumber) >= 0 ? Number(suppliedNumber) : 0;
  const architecture = instantiateSmArchitecture(smNumber);
  const evidence = indexSmPipelineEvidence(architecture, events, trace.components);
  const formalById = new Map(architecture.components.map(component => [component.id, component]));
  const formalIdByEvent = new Map([...evidence.byComponent].flatMap(([id, source]) => source.map(event => [event.id, id])));
  const nativeById = new Map(trace.components.map(component => [component.id, component]));
  function mappedSource(component) {return nativeById.get(component.id) ?? [...nativeById.values()].find(item => item.args?.architectureComponentId === component.id);}
  const root = dom("section", "sm-pipeline-scene"); root.setAttribute("aria-label", `${sm.label} 的指令光点与正式组件`);
  const style = dom("link"); style.rel = "stylesheet"; style.href = new URL("./sm-pipeline.css?v=browser-perf-1", import.meta.url).href; style.addEventListener("load", () => {queueGeometry(); onResize();}); root.append(style);
  const header = dom("div", "sm-pipeline-head"), title = dom("div");
  const teaching = trace.meta.capabilities?.includes('sm_pipeline');
  title.append(dom("strong", "", `SM ${smNumber} / ${teaching ? '教学流水线' : '原生指令流水线'}`), dom("small", "", teaching
    ? '独立教学运行 · 与 GPU 全景分别计时 · 光点随真实模型区间移动'
    : `独立原生运行 · 记录 ${trace.components.filter(component => component.kind === 'sm').length} 个 SM · 光点来自指令阶段记录`));
  const reference = dom("a", "sm-architecture-reference", "GH100 · NVIDIA Fig. 4");
  reference.href = SM_ARCHITECTURE.references.find(item => item.id === "hopper-blog").url;
  reference.target = "_blank"; reference.rel = "noopener noreferrer";
  reference.title = "参考 NVIDIA 官方功能框图；组件尺寸不代表芯片物理面积"; title.append(reference);
  const tabs = dom("div", "sm-partition-tabs"); tabs.setAttribute("aria-label", "选择 SM 分区"); header.append(title, tabs); root.append(header);
  const explanation = dom("p", "sm-pipeline-explanation"), explanationCount = dom("b"), explanationText = document.createTextNode(""); explanation.append(explanationCount, explanationText); root.append(explanation);
  const legend = dom("div", "sm-flow-legend"); legend.append(dom("span", "", "类型化连接")); root.append(legend);
  const activity = dom("div", "sm-light-status"); activity.setAttribute("aria-label", "当前指令光点数量"); root.append(activity);
  const boardScroll = dom("div", "sm-pipeline-scroll");
  const board = dom("div", "sm-pipeline-board"); boardScroll.append(board); root.append(boardScroll);
  const footer = dom("p", "sm-pipeline-footer"); root.append(footer);
  const dialog = dom("dialog", "sm-formal-dialog"); dialog.setAttribute("aria-label", "SM 组件正式规格"); root.append(dialog);
  const recordedComponents = new Set([...evidence.byComponent].filter(([, source]) => source.some(event => event.end > event.start)).map(([id]) => id));
  for (const event of evidence.transfers) for (const id of smPipelineTransferRoute(event.args.smPipelineTransfer)) recordedComponents.add(id);
  let partition = window.matchMedia?.("(max-width: 700px)").matches ? 0 : "all", layout = recordedComponents.size ? "observed" : "full";
  let selectedFormalId = null, time = 0, scope = null, selectedEventId = null, destroyed = false, geometryFrame = null;
  let snapshot = summarizeSmPipelineEvidence(evidence, 0), tokenLayer, tokenOverlay, wires, evidenceSummary, evidenceList, lastEvidenceSignature = "";
  const markerPrefix = `sm-wire-${smNumber}-${nextSceneId++}`;
  const enabledTypes = new Set(FLOW_TYPES), cards = new Map(), paths = new Map(), pathByPair = new Map(), tabNodes = new Map(), lights = new Map(), componentLocations = new Map();
  const eventById = new Map(events.map(event => [event.id, event]));
  const layoutToggle = action("", "sm-layout-toggle", () => {layout = layout === "observed" ? "full" : "observed"; renderBoard();});
  layoutToggle.disabled = !recordedComponents.size; legend.append(layoutToggle);

  for (const type of FLOW_TYPES) {
    const toggle = action("", "sm-flow-toggle", () => {enabledTypes.has(type) ? enabledTypes.delete(type) : enabledTypes.add(type); toggle.setAttribute("aria-pressed", String(enabledTypes.has(type))); patchWires(); patchTokens();});
    toggle.dataset.type = type; toggle.style.setProperty("--flow-color", `var(--sm-${type})`); toggle.setAttribute("aria-pressed", "true");
    toggle.append(dom("i"), document.createTextNode(FLOW_LABELS[type])); legend.append(toggle);
  }
  for (const value of [0, 1, 2, 3, "all"]) {
    const tab = action(value === "all" ? "四分区总览" : `P${value}`, "sm-partition-tab", () => {partition = value; renderBoard();});
    tab.dataset.smPartition = String(value); tabNodes.set(value, tab); tabs.append(tab);
  }
  function makeCard(component) {
    const id = localId(component), label = LABELS[id] ?? [component.label ?? id, component.purpose ?? "正式结构定义"];
    const card = action("", "sm-component", () => openSpec(component.id));
    card.dataset.smFormalId = component.id; card.dataset.family = palette(component); card.dataset.localId = id;
    card.dataset.physical = String(component.evidenceClass === "public-architecture");
    card.setAttribute("aria-pressed", String(component.id === selectedFormalId));
    const box = createSmComponentBox({localId: id, family: palette(component)});
    const hardwareCount = component.resources?.hardwareLanes != null ? `${component.resources.hardwareLanes} lanes · ` : component.resources?.hardwareTensorCores != null ? `${component.resources.hardwareTensorCores} core · ` : "";
    const face = dom("span", "sm-component-front"), state = dom("span", "sm-component-state", "未观测 / 结构定义");
    const name = dom('strong', 'sm-component-name');
    name.append(dom('span', 'sm-component-full-name', label[0]), dom('span', 'sm-component-short-name', SHORT_LABELS[id] ?? label[0]),
      dom('span', 'sm-component-overview-name', OVERVIEW_LABELS[id] ?? label[0]));
    const capacity = id === "register-file" ? "64 KiB · 16K × 32-bit" : component.resources?.hardwareLanes ? `${component.resources.hardwareLanes} CUDA cores` : id === "tensor" ? "4th GEN · 1 core" : null;
    face.append(name);
    if (capacity) face.append(dom("span", "sm-component-capacity", capacity));
    face.append(dom("span", "sm-component-subtitle", `${hardwareCount}${label[1]}`), state);
    card.append(box.element, face);
    card.title = `${label[0]} · ${component.purpose ?? "点击查看正式组件契约"}`;
    cards.set(component.id, {card, box, face, state}); return card;
  }
  function makeGroup(components, label, className = "sm-shared-grid", stageNumber = null) {
    const group = dom("div", "sm-stage-row");
    if (label) {
      const title = dom("div", "sm-stage-title");
      if (stageNumber != null) title.append(dom("b", "sm-stage-index", String(stageNumber).padStart(2, "0")));
      title.append(dom("span", "", label), dom("i", "sm-stage-direction", "↓")); group.append(title);
    }
    const grid = dom("div", className); for (const component of components) grid.append(makeCard(component)); group.append(grid); return group;
  }
  function hardwareGroup(components, className) {
    const group = makeGroup(components, null, `sm-hardware-grid ${className}`);
    group.lastElementChild.style.gridTemplateColumns = components.map(component => `${HARDWARE_WEIGHTS[localId(component)] ?? 1}fr`).join(" ");
    return group;
  }
  function renderBoard() {
    cards.clear(); paths.clear(); pathByPair.clear(); lights.clear(); componentLocations.clear(); board.replaceChildren();
    board.dataset.layout = layout; layoutToggle.textContent = layout === "observed" ? "显示完整架构" : "聚焦来源路径";
    layoutToggle.setAttribute("aria-pressed", String(layout === "observed"));
    wires = svg("svg", {class: "sm-pipeline-links", "aria-hidden": "true"}); board.append(wires);
    const defs = svg("defs");
    for (const type of FLOW_TYPES) {
      const marker = svg("marker", {id: `${markerPrefix}-${type}`, viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto", markerUnits: "userSpaceOnUse"});
      marker.append(svg("path", {d: "M1 1 L7 4 L1 7", fill: "none", stroke: `var(--sm-${type})`, "stroke-width": 1.4, "stroke-linecap": "round", "stroke-linejoin": "round"})); defs.append(marker);
    }
    wires.append(defs);
    const shared = architecture.components.filter(component => partitionId(component) == null && (layout === "full" || recordedComponents.has(component.id)));
    const instructionCache = shared.find(component => localId(component) === "icache");
    if (instructionCache) board.append(makeGroup([instructionCache], null, "sm-sm-icache-grid"));
    const partitionContainer = dom("div", `sm-partitions${partition === "all" ? " sm-all-partitions" : ""}`);
    for (const value of partition === "all" ? [0, 1, 2, 3] : [partition]) {
      const container = dom("section", "sm-partition"); container.setAttribute("aria-label", `SM 分区 P${value}`);
      const heading = dom("div", "sm-partition-heading"); heading.append(dom("span", "", `PARTITION ${value} / SMSP`), dom("small", "", "实线：公开硬件 · 虚线：逻辑阶段")); container.append(heading);
      const components = architecture.components.filter(component => Number(partitionId(component)) === value && partitionId(component) != null && (layout === "full" || recordedComponents.has(component.id)));
      const used = new Set();
      for (const [className, ids] of HARDWARE_ROWS) {
        const group = ids.map(id => components.find(component => localId(component) === id)).filter(Boolean); if (!group.length) continue;
        group.forEach(component => used.add(component.id)); container.append(hardwareGroup(group, className));
      }
      const logical = LOGICAL_STAGES.map(id => components.find(component => localId(component) === id)).filter(Boolean);
      if (logical.length) {
        logical.forEach(component => used.add(component.id));
        const group = makeGroup(logical, null, "sm-logical-grid");
        group.classList.add("sm-logical-row"); group.setAttribute("aria-label", "Trace 逻辑阶段"); group.lastElementChild.style.gridTemplateColumns = `repeat(${logical.length},minmax(0,1fr))`; container.append(group);
      }
      const remaining = components.filter(component => !used.has(component.id)); if (remaining.length) container.append(makeGroup(remaining, "OTHER DEFINED RESOURCES", "sm-logical-grid"));
      if (!components.length) container.append(dom("p", "sm-partition-unobserved", `P${value} 没有映射的非零阶段区间。选择完整架构可查看结构定义。`));
      partitionContainer.append(container);
    }
    board.append(partitionContainer);
    const zone = dom("section", "sm-shared-zone"); zone.setAttribute("aria-label", "SM 共享存储与异步数据路径"); zone.append(dom("h4", "", "SM SHARED RESOURCES / ASYNC DATA PATH"));
    const pool = shared.filter(component => ["l1-cache", "shared-memory"].includes(localId(component)));
    const barrier = shared.find(component => localId(component) === "mbarrier");
    const tma = shared.find(component => localId(component) === "tma");
    if (tma) zone.append(makeGroup([tma], null, "sm-tma-grid"));
    if (pool.length || barrier) {
      const poolContainer = dom("div", "sm-shared-pool"), poolHeading = dom("div", "sm-pool-heading");
      poolHeading.append(dom("p", "sm-shared-pool-label", pool.length ? "256 KiB · 统一 L1 / SMEM 物理存储池" : "SMEM 同步对象"));
      if (barrier) {const group = makeGroup([barrier], null, "sm-barrier-grid"); group.title = "mbarrier 是存放于 SMEM 的逻辑屏障对象"; poolHeading.append(group);}
      poolContainer.append(poolHeading);
      if (pool.length) poolContainer.append(makeGroup(pool, null, "sm-pool-grid")); zone.append(poolContainer);
    }
    const boundary = ["constant-cache", "texture", "noc-interface"].map(id => shared.find(component => localId(component) === id)).filter(Boolean);
    if (boundary.length) {const group = makeGroup(boundary, null, "sm-boundary-grid"); group.lastElementChild.style.gridTemplateColumns = boundary.map(component => localId(component) === "texture" ? "2fr" : "1fr").join(" "); zone.append(group);}
    if (shared.some(component => localId(component) !== "icache")) board.append(zone);
    tokenOverlay = svg("svg", {class: "sm-pipeline-token-overlay", "aria-label": "来源区间驱动的指令阶段光点"});
    tokenLayer = svg("g", {class: "sm-pipeline-tokens"}); tokenOverlay.append(tokenLayer); board.append(tokenOverlay);
    for (const [value, tab] of tabNodes) tab.setAttribute("aria-pressed", String(value === partition));
    patchCards(); queueGeometry(); onResize();
  }
  function queueGeometry() {
    if (geometryFrame !== null || destroyed) return;
    geometryFrame = requestAnimationFrame(() => {geometryFrame = null; drawGeometry();});
  }
  function drawGeometry() {
    if (destroyed || !root.isConnected || !board.clientWidth) return;
    const bounds = board.getBoundingClientRect(), scale = bounds.width / board.offsetWidth || 1;
    const locations = componentLocations; locations.clear();
    for (const [id, {card, box, face}] of cards) {
      const rect = card.getBoundingClientRect(), width = rect.width / scale, height = rect.height / scale;
      box.updateGeometry(width, height);
      const front = box.geometry.front;
      Object.assign(face.style, {left: `${front.x}px`, top: `${front.y}px`, width: `${front.width}px`, height: `${front.height}px`, right: "auto", bottom: "auto"});
      const group = card.closest(".sm-stage-row"), section = card.closest(".sm-partition, .sm-shared-zone") ?? board;
      const groupRect = group.getBoundingClientRect(), sectionRect = section.getBoundingClientRect();
      locations.set(id, {x: (rect.left - bounds.left) / scale, y: (rect.top - bounds.top) / scale, width, height,
        row: group, section, rowTop: (groupRect.top - bounds.top) / scale, rowBottom: (groupRect.bottom - bounds.top) / scale,
        rowIndex: [...section.querySelectorAll(".sm-stage-row")].indexOf(group),
        sectionLeft: (sectionRect.left - bounds.left) / scale, sectionRight: (sectionRect.right - bounds.left) / scale});
    }
    for (const node of paths.values()) node.remove(); paths.clear(); pathByPair.clear();
    const viewBox = `0 0 ${board.offsetWidth} ${board.offsetHeight}`;
    wires.setAttribute("viewBox", viewBox); tokenOverlay.setAttribute("viewBox", viewBox);
    for (const [linkIndex, link] of architecture.links.entries()) {
      const source = locations.get(link.source), target = locations.get(link.target); if (!source || !target) continue;
      const dy = target.y + target.height / 2 - source.y - source.height / 2;
      const port = (location, side) => {const anchor = smBoxPortAnchor(location.width, location.height, side); return {x: location.x + anchor.x, y: location.y + anchor.y};};
      let d;
      if (source.row === target.row) {
        if (Math.abs(target.x - source.x) > source.width * 1.6) {
          const from = port(source, "bottom"), to = port(target, "bottom"), lane = Math.max(source.rowBottom, target.rowBottom) + 4;
          d = `M${from.x},${from.y} L${from.x},${lane} L${to.x},${lane} L${to.x},${to.y}`;
        } else {
          const right = target.x >= source.x, from = port(source, right ? "right" : "left"), to = port(target, right ? "left" : "right");
          d = `M${from.x},${from.y} C${(from.x + to.x) / 2},${from.y} ${(from.x + to.x) / 2},${to.y} ${to.x},${to.y}`;
        }
      } else if (source.section === target.section && target.rowIndex === source.rowIndex + 1 && Math.abs(source.rowBottom - source.y - source.height) < 4 && target.y - source.rowBottom < 70 && dy > 0) {
        const from = port(source, "bottom"), to = port(target, "top"), middle = (source.rowBottom + target.y) / 2;
        d = `M${from.x},${from.y} L${from.x},${middle} L${to.x},${middle} L${to.x},${to.y}`;
      } else {
        // Nonadjacent / feedback routes use the side street rather than running
        // through unrelated front faces. This is a logical contract, not wiring.
        const left = link.type === "completion" || link.type === "control";
        const from = port(source, dy > 0 ? "bottom" : "top"), to = port(target, dy > 0 ? "top" : "bottom");
        const sourceLane = dy > 0 ? source.rowBottom + 4 : source.rowTop - 4;
        const targetLane = dy > 0 ? target.rowTop - 4 : target.rowBottom + 4;
        const gutter = left ? Math.min(source.sectionLeft, target.sectionLeft) + 7 + linkIndex % 3 * 2 : Math.max(source.sectionRight, target.sectionRight) - 7 - linkIndex % 3 * 2;
        d = `M${from.x},${from.y} L${from.x},${sourceLane} L${gutter},${sourceLane} L${gutter},${targetLane} L${to.x},${targetLane} L${to.x},${to.y}`;
      }
      const path = svg("path", {d, class: "sm-formal-link", "data-type": link.type, "data-sm-link-id": link.id, "marker-end": `url(#${markerPrefix}-${link.type})`}); path.style.setProperty("--flow-color", `var(--sm-${link.type})`);
      paths.set(link.id, path); wires.append(path);
      let length = 0; try {length = path.getTotalLength();} catch {}
      pathByPair.set(`${link.source}|${link.target}|${link.type}`, {path, link, length});
    }
    patchWires(); patchTokens();
  }
  function patchCards() {
    for (const [id, {card, state}] of cards) {
      const value = snapshot.get(id);
      attribute(card, "aria-pressed", id === selectedFormalId);
      for (const kind of ["active", "stall", "queue", "transfer"]) toggle(card, `sm-evidence-${kind}`, value[kind].length > 0);
      const status = value.stall.length ? `STALL ${value.stall.length} · ${value.stall[0].args?.stallReason ?? "source"}`
        : value.queue.length ? `QUEUE ${value.queue.length}` : value.active.length ? `ACTIVE ${value.active.length} · ${value.active[0].args?.stage ?? "span"}`
        : value.transfer.length ? `TRANSFER ${value.transfer.length}`
        : value.pointTotal ? `${value.observedPoints} / ${value.pointTotal} 点已观测${value.observationCycle == null ? '' : ` · ${value.pointsAtCursor ? '当前' : '最近'} @ ${value.observationCycle}`}`
        : value.observed ? `${value.endedSpans} / ${value.total} 源区间已结束` : "未观测 / 结构定义";
      content(state, formalById.get(id).simulationCoverage === "timing-only" && value.observed ? `仅时序 · ${status}` : status);
      attribute(card, "aria-label", `${LABELS[localId(formalById.get(id))]?.[0] ?? formalById.get(id).label}，${status}，查看正式规格`);
    }
    const count = [...snapshot.values()].filter(value => value.observed).length;
    const rows = scopedSummaryRows(evidence, scope);
    if (rows.typedTransfers == null) rows.typedTransfers = evidence.transfers.filter(event => sourceEventsMatch(event, scope)).length;
    content(explanationCount, `${count} / ${architecture.components.length} 个正式组件有当前范围的原始事件证据。`);
    content(explanationText, count ? " 其余节点保留结构定义；未观测不等于空闲。" : " 当前来源只提供 tile / 任务或未映射的指令记录；Fetch、Issue 等状态保持未观测。");
    content(footer, `${rows.typedTransfers} 个显式类型化阶段转移 · ${evidence.unmapped.length} 个来源事件未映射${evidence.unresolvedTransfers.length ? ` · ${evidence.unresolvedTransfers.length} 个转移没有匹配正式连接，未绘制` : ""}。光点仅在原始非零区间内存在；道路上按区间进度插值，屋顶上表示组件驻留，不代表物理连线延迟或真实执行 lane。${layout === "observed" ? "来源路径隐藏未观测组件，可切换完整架构。" : "未观测组件保持结构定义。"}暂停、单步和回退均由同一 trace 时间驱动。`);
  }
  function patchWires() {
    const activeLinks = new Set(smPipelineTransferMarks(evidence, time, scope, Infinity).flatMap(mark => {
      const route = smPipelineTransferRoute(mark); return route.slice(1).map((id, index) => `${route[index]}|${id}|${mark.kind}`);
    }));
    for (const link of architecture.links) {
      const path = paths.get(link.id); if (!path) continue;
      const display = enabledTypes.has(link.type) ? "" : "none"; if (path.style.display !== display) path.style.display = display;
      toggle(path, "sm-link-selected", selectedFormalId === link.source || selectedFormalId === link.target);
      toggle(path, "sm-link-active", activeLinks.has(`${link.source}|${link.target}|${link.type}`));
    }
  }
  function patchTokens() {
    if (!tokenLayer) return;
    const transfers = smPipelineTransferMarks(evidence, time, scope, Infinity), stages = smPipelineStageMarks(evidence, time, scope, Infinity);
    const selected = eventById.get(selectedEventId), instructionId = event => event?.args?.dynamicInstructionId ?? event?.args?.instructionId;
    const selectedInstruction = instructionId(selected);
    const isSelected = mark => mark.event.id === selectedEventId || selectedInstruction != null && instructionId(mark.event) === selectedInstruction;
    const requested = [
      ...transfers.filter(mark => enabledTypes.has(mark.kind)).map(mark => ({...mark, type: "transfer"})),
      ...stages.map(mark => ({...mark, type: "stage"})),
    ];
    // Filter before the drawing cap: another partition cannot starve this one.
    const visible = requested.filter(mark => mark.type === "stage" ? componentLocations.has(mark.componentId) : smPipelineTransferRoute(mark).slice(1).every((id, index) => pathByPair.has(`${smPipelineTransferRoute(mark)[index]}|${id}|${mark.kind}`)));
    visible.sort((a, b) => Number(isSelected(b)) - Number(isSelected(a)));
    const drawn = visible.slice(0, 96), keep = new Set();
    for (const mark of drawn) {
      const key = `${mark.type}:${mark.event.id}`; keep.add(key);
      const route = mark.type === "transfer" ? smPipelineTransferRoute(mark) : [];
      let light = lights.get(key);
      if (!light) {
        const token = svg("g", {class: "sm-pipeline-token", role: "button", tabindex: 0, "data-sm-light-kind": mark.type,
          [mark.type === "transfer" ? "data-sm-transfer-event-id" : "data-sm-stage-event-id"]: mark.event.id,
          "aria-label": `${mark.event.name}，W${mark.event.args?.warpId ?? "?"}，${mark.type === "transfer" ? `${FLOW_LABELS[mark.kind]}阶段转移` : `${mark.event.args?.stage ?? mark.state}组件区间`}`});
        const trail = svg("polyline", {class: "sm-light-trail", fill: "none"});
        const halo = svg("circle", {class: "sm-light-halo", r: 12});
        const glow = svg("circle", {class: "sm-light-glow", r: 8});
        const ring = svg("circle", {class: "sm-light-ring", r: 8.5});
        const core = svg("circle", {class: "sm-light-core", r: 4.5});
        const hit = svg("circle", {class: "sm-light-hit", r: 14});
        // A bent trail can have a distant bounding-box center. Keep it outside
        // the interactive group so pointer/keyboard focus targets the light.
        const title = svg("title"); token.append(halo, glow, ring, core, hit, title);
        title.textContent = `${mark.event.args?.opcode ?? mark.event.name}\nPC ${mark.event.args?.pc ?? "未提供"} · W${mark.event.args?.warpId ?? "?"} · ${instructionId(mark.event) ?? mark.event.id}\n${mark.type === "transfer" ? route.join(" → ") : mark.componentId}\n${mark.event.start} → ${mark.event.end} ${trace.meta.timeUnit}`;
        const color = mark.type === "transfer" ? `var(--sm-${mark.kind})` : mark.state === "stall" ? "#ffb071" : mark.state === "queue" ? "#ffe094" : "#9effdc";
        token.style.setProperty("--flow-color", color); trail.style.setProperty("--flow-color", color);
        const choose = () => onSelectEvent(mark.event.id);
        token.addEventListener("click", choose); token.addEventListener("keydown", event => {if (event.key === "Enter" || event.key === " ") {event.preventDefault(); choose();}});
        light = {token, trail, title}; lights.set(key, light); tokenLayer.append(trail, token);
      }
      const segments = route.slice(1).map((id, index) => pathByPair.get(`${route[index]}|${id}|${mark.kind}`));
      const location = componentLocations.get(mark.componentId), slot = Number(mark.event.args?.warpId) || 0;
      const at = progress => {
        if (mark.type === "stage") {const p = smPipelineStagePoint(location.width, location.height, progress, slot); return {x: location.x + p.x, y: location.y + p.y};}
        const position = smPipelineRoutePosition(segments.map(segment => segment.length), progress);
        return position ? segments[position.index].path.getPointAtLength(position.distance) : null;
      };
      let point, trail; try {
        point = at(mark.progress); if (!point) {light.token.style.display = "none"; light.trail.style.display = "none"; continue;}
        trail = [.09, .065, .04, .02, 0].map(delta => at(Math.max(0, mark.progress - delta))).filter(Boolean);
      } catch {light.token.style.display = "none"; light.trail.style.display = "none"; continue;}
      if (light.token.style.display) light.token.style.display = "";
      if (light.trail.style.display) light.trail.style.display = "";
      attribute(light.token, "aria-pressed", isSelected(mark));
      attribute(light.token, "transform", `translate(${point.x},${point.y})`);
      attribute(light.trail, "points", trail.map(p => `${p.x},${p.y}`).join(" "));
    }
    for (const [key, light] of lights) if (!keep.has(key)) {light.token.remove(); light.trail.remove(); lights.delete(key);}
    const partitionCounts = new Map([0, 1, 2, 3].map(value => [value, 0]));
    for (const mark of requested) {
      const component = formalById.get(mark.componentId ?? mark.sourceId), value = partitionId(component ?? {});
      if (value != null) partitionCounts.set(Number(value), (partitionCounts.get(Number(value)) ?? 0) + 1);
    }
    for (const [value, tab] of tabNodes) {
      const count = value === "all" ? requested.length : partitionCounts.get(value);
      content(tab, `${value === "all" ? "四分区" : `P${value}`}${count ? ` · ${count}` : ""}`);
      toggle(tab, "sm-partition-has-lights", count > 0);
    }
    const status = `t=${time.toLocaleString(undefined, {maximumFractionDigits: 2})} ${trace.meta.timeUnit} · 当前视图 ${drawn.length} 光点${visible.length > drawn.length ? ` / ${visible.length}（最多绘制 96）` : ""} · SM 全部 ${transfers.length} 转移 / ${stages.length} 组件区间`;
    attribute(activity, "data-active", drawn.length > 0);
    if (activity.textContent !== status) activity.textContent = status;
  }
  function definitionSection(label, value) {
    const section = dom("section", "sm-formal-section"); section.append(dom("h4", "", label), dom("pre", "sm-formal-definition", display(value))); return section;
  }
  function portSection(label, ports = []) {
    const section = dom("section", "sm-formal-section"); section.append(dom("h4", "", label));
    const list = dom("ul", "sm-formal-ports");
    for (const port of ports) {const item = dom("li"); item.append(dom("b", "", port.name), dom("code", "", `: ${port.type}`)); list.append(item);}
    if (!ports.length) list.append(dom("li", "", "无显式端口")); section.append(list); return section;
  }
  function openSpec(id) {
    selectedFormalId = id; lastEvidenceSignature = ""; const component = formalById.get(id); if (!component) return;
    dialog.replaceChildren();
    const heading = dom("header", "sm-formal-header"), titles = dom("div");
    titles.append(dom("h3", "", LABELS[localId(component)]?.[0] ?? component.label), dom("p", "", `${component.id} · ${component.evidenceClass ?? "formal model"}`));
    heading.append(titles, action("×", "sm-formal-close", () => dialog.close())); heading.lastElementChild.setAttribute("aria-label", "关闭组件规格");
    const content = dom("div", "sm-formal-content"); content.append(dom("p", "sm-formal-purpose", component.purpose));
    const sourceComponent = mappedSource(component), timing = sourceComponent?.timing ?? component.timing;
    const effectiveTiming = {...timing, ...(timing?.queueCapacity == null ? {queueCapacity: "未单独建模；由上游 credit / 模型准入约束"} : {})};
    const coverage = component.simulationCoverage === "timing-only" ? "仅时序服务；缓存 tag / miss 或真实 PC / 掩码功能未建模。"
      : component.simulationCoverage === "structural-only" ? "结构定义；当前教学后端不执行此组件。" : "可执行教学路径；只实现后端声明的功能子集。";
    content.append(dom("p", "sm-formal-timing-warning", `建模覆盖：${coverage} ${component.physicalNote ?? ""}`));
    const sections = dom("div", "sm-formal-sections");
    sections.append(portSection("INPUT PORTS / 类型化输入", component.ports?.inputs), portSection("OUTPUT PORTS / 类型化输出", component.ports?.outputs),
      definitionSection("STATE / 状态变量", component.stateFields), definitionSection("RESOURCES / 资源与容量", component.resources),
      definitionSection(sourceComponent?.timing ? "RUN TIMING / 本次运行有效时序" : "TIMING / 默认教学时序", effectiveTiming), definitionSection("READY / STALL / TRANSITIONS", component.transitions),
      definitionSection("INVARIANTS / 不变量", component.invariants), definitionSection("FORMAL READY / ISSUE 条件", {ready: SM_ARCHITECTURE.formalModel.ready, issue: SM_ARCHITECTURE.formalModel.issue, effect: SM_ARCHITECTURE.formalModel.effect, release: SM_ARCHITECTURE.formalModel.release, scope: SM_ARCHITECTURE.formalModel.contractScope}));
    const referenceSection = dom("section", "sm-formal-section"); referenceSection.append(dom("h4", "", "REFERENCE / 证据来源"));
    for (const id of component.referenceIds ?? []) {
      const reference = SM_ARCHITECTURE.references.find(item => item.id === id); if (!reference) continue;
      const paragraph = dom("p"), link = dom("a", "", reference.title); link.href = reference.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.style.color = "#a9dace"; paragraph.append(link); referenceSection.append(paragraph);
    }
    sections.append(referenceSection);
    content.append(sections);
    const proof = dom("section", "sm-formal-evidence"); proof.append(dom("h4", "", "SOURCE EVIDENCE / 当前原始阶段证据"));
    evidenceSummary = dom("div", "sm-formal-evidence-summary"); evidenceList = dom("div", "sm-evidence-events"); proof.append(evidenceSummary, evidenceList);
    const nativeId = sourceComponent?.id;
    if (nativeId) proof.append(action("选择来源组件并联动主时间线", "sm-formal-native", () => {dialog.close(); onSelectComponent(nativeId);}));
    content.append(proof, dom("p", "sm-formal-timing-warning", "公开架构事实、形式化教学选择与 trace 观测属于不同证据层。结构连线和默认模型参数不能当作 NVIDIA 未公开的真实流水线延迟、物理面积或完整端口数量。"));
    dialog.append(heading, content);
    if (!dialog.open) dialog.showModal();
    patchCards(); patchWires(); patchDialog();
  }
  function patchDialog() {
    if (!dialog.open || !selectedFormalId || !evidenceSummary || !evidenceList) return;
    const value = snapshot.get(selectedFormalId); if (!value) return;
    content(evidenceSummary, value.observed ? `t=${time.toLocaleString(undefined, {maximumFractionDigits: 2})} ${trace.meta.timeUnit} · ACTIVE ${value.active.length} / QUEUE ${value.queue.length} / STALL ${value.stall.length} / TRANSFER ${value.transfer.length}${value.pointTotal ? ` · ${value.observedPoints} / ${value.pointTotal} 点已观测${value.observationCycle == null ? '' : ` · ${value.pointsAtCursor ? '当前' : '最近已观测'}周期 ${value.observationCycle}`}` : ` · ${value.endedSpans} / ${value.total} 源区间已结束`}`
      : "当前来源没有此组件的映射事件；状态、占用率、队列深度与延迟均未观测。");
    const relevant = [...value.stall, ...value.queue, ...value.active, ...value.transfer, ...value.points];
    const selected = evidence.byComponent.get(selectedFormalId)?.find(event => event.id === selectedEventId && sourceEventsMatch(event, scope));
    if (selected && !relevant.includes(selected)) relevant.unshift(selected);
    if (!relevant.length && value.latest) relevant.push(value.latest);
    const signature = relevant.slice(0, 6).map(event => event.id).join("|") + selectedEventId;
    if (signature === lastEvidenceSignature) return; lastEvidenceSignature = signature; evidenceList.replaceChildren();
    for (const event of relevant.slice(0, 6)) {
      const choice = action(`${event.args?.stage ?? event.category ?? "span"} · W${event.args?.warpId ?? "?"} · ${event.args?.opcode ?? event.name} · ${event.start === event.end ? `观测点 @ ${event.start}` : `${event.start} → ${event.end}`}${event.args?.stallReason ? ` · ${event.args.stallReason}` : ""}`, "sm-evidence-event", () => onSelectEvent(event.id));
      choice.dataset.smEvidenceEventId = event.id; choice.setAttribute("aria-pressed", String(event.id === selectedEventId)); evidenceList.append(choice);
    }
  }
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => {queueGeometry(); onResize();}) : null; observer?.observe(board);
  renderBoard();
  return {element: root,
    update(view = {}) {
      time = Number.isFinite(view.time) ? view.time : time; scope = view.scope ?? null;
      const nextSelected = view.selectedEventId ?? null, changedSelection = nextSelected !== selectedEventId; selectedEventId = nextSelected;
      let reveal = false;
      if (changedSelection && partition !== "all") {
        const event = eventById.get(selectedEventId), target = formalIdByEvent.get(selectedEventId) ?? event?.args?.smPipelineTransfer?.sourceId;
        const nativePartition = partitionId(formalById.get(target) ?? {});
        if (nativePartition != null && Number(nativePartition) !== partition) {partition = Number(nativePartition); reveal = true;}
      }
      snapshot = summarizeSmPipelineEvidence(evidence, time, scope);
      if (reveal) renderBoard(); else {patchCards(); patchWires(); patchTokens();}
      patchDialog();
    },
    animate(view = {}) {if (Number.isFinite(view.time)) {time = view.time; patchTokens();}},
    getView() {return {smComponentId: sm.id, partition, selectedFormalId, layout};},
    setView(view = {}) {if ([0, 1, 2, 3, "all"].includes(view.partition)) partition = view.partition; if (formalById.has(view.selectedFormalId)) selectedFormalId = view.selectedFormalId; if (["observed", "full"].includes(view.layout)) layout = view.layout; renderBoard();},
    destroy() {destroyed = true; observer?.disconnect(); if (geometryFrame !== null) cancelAnimationFrame(geometryFrame); if (dialog.open) dialog.close(); root.remove();},
  };
}
