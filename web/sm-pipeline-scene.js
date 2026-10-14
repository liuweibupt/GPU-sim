// Formal SM floorplan. The architecture is a definition, while activity is only
// evidence explicitly mapped by a source trace. Tile names never imply stages.
import {instantiateSmArchitecture, SM_ARCHITECTURE} from "../lib/sm-architecture.js";

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
const ROWS = [
  ["FETCH / DECODE", ["l0-icache", "fetch", "decode"]],
  ["WARP CONTROL / ISSUE", ["warp-scheduler", "scoreboard", "issue", "dispatch"]],
  ["OPERAND DELIVERY", ["register-file", "operand-collector"]],
  ["EXECUTION UNITS", ["fp32", "fp64", "int32", "sfu", "tensor", "lsu", "branch"]],
  ["COMPLETION", ["writeback"]],
];

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
      if (typedLinks.has(`${transfer.sourceId}|${transfer.targetId}|${transfer.kind}`)) transfers.push(event);
      else unresolvedTransfers.push(event);
    }
  }
  return {byComponent, transfers, unmapped, unresolvedTransfers};
}

/** Pure half-open snapshots make pause / seek / rewind independent of playback. */
export function summarizeSmPipelineEvidence(evidence, time, scope = null) {
  const result = new Map();
  for (const [id, source] of evidence.byComponent) {
    const events = source.filter(event => sourceEventsMatch(event, scope));
    const value = {id, observed: events.length > 0, total: events.length, completed: 0, active: [], queue: [], stall: [], transfer: [], latest: null};
    for (const event of events) {
      if (event.end <= time) value.completed++;
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
  for (const event of evidence.transfers) {
    if (!sourceEventsMatch(event, scope) || event.end <= event.start || event.start > time || time >= event.end) continue;
    result.push({event, ...event.args.smPipelineTransfer, progress: (time - event.start) / (event.end - event.start)});
    if (result.length >= limit) break;
  }
  return result;
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
  const nativeById = new Map(trace.components.map(component => [component.id, component]));
  function mappedSource(component) {return nativeById.get(component.id) ?? [...nativeById.values()].find(item => item.args?.architectureComponentId === component.id);}
  const root = dom("section", "sm-pipeline-scene"); root.setAttribute("aria-label", `${sm.label} 的正式流水线与组件定义`);
  const style = dom("link"); style.rel = "stylesheet"; style.href = new URL("./sm-pipeline.css", import.meta.url).href; style.addEventListener("load", () => {queueGeometry(); onResize();}); root.append(style);
  const header = dom("div", "sm-pipeline-head"), title = dom("div");
  title.append(dom("strong", "", "SM MICROARCHITECTURE / 4 PARTITIONS"), dom("small", "", "结构定义与 trace 证据分开展示 · 点击每个组件查看正式契约"));
  const tabs = dom("div", "sm-partition-tabs"); tabs.setAttribute("aria-label", "选择 SM 分区"); header.append(title, tabs); root.append(header);
  const explanation = dom("p", "sm-pipeline-explanation"); root.append(explanation);
  const legend = dom("div", "sm-flow-legend"); legend.append(dom("span", "", "类型化连接")); root.append(legend);
  const board = dom("div", "sm-pipeline-board"); root.append(board);
  const footer = dom("p", "sm-pipeline-footer"); root.append(footer);
  const dialog = dom("dialog", "sm-formal-dialog"); dialog.setAttribute("aria-label", "SM 组件正式规格"); root.append(dialog);
  let partition = 0, selectedFormalId = null, time = 0, scope = null, selectedEventId = null, destroyed = false, geometryFrame = null;
  let snapshot = summarizeSmPipelineEvidence(evidence, 0), tokenLayer, wires, evidenceSummary, evidenceList, lastEvidenceSignature = "";
  const enabledTypes = new Set(FLOW_TYPES), cards = new Map(), paths = new Map(), pathByPair = new Map(), tabNodes = new Map();

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
    card.dataset.smFormalId = component.id; card.dataset.family = palette(component); card.setAttribute("aria-pressed", String(component.id === selectedFormalId));
    const hardwareCount = component.resources?.hardwareLanes != null ? `${component.resources.hardwareLanes} lanes · ` : component.resources?.hardwareTensorCores != null ? `${component.resources.hardwareTensorCores} core · ` : "";
    card.append(dom("strong", "sm-component-name", label[0]), dom("span", "sm-component-subtitle", `${hardwareCount}${label[1]}`), dom("span", "sm-component-state", "未观测 / 结构定义"));
    card.title = `${label[0]} · ${component.purpose ?? "点击查看正式组件契约"}`;
    cards.set(component.id, {card, state: card.lastElementChild}); return card;
  }
  function makeGroup(components, label, className = "sm-shared-grid") {
    const group = dom("div", "sm-stage-row");
    if (label) group.append(dom("div", "sm-stage-title", label));
    const grid = dom("div", className); for (const component of components) grid.append(makeCard(component)); group.append(grid); return group;
  }
  function renderBoard() {
    cards.clear(); paths.clear(); pathByPair.clear(); board.replaceChildren();
    wires = svg("svg", {class: "sm-pipeline-links", "aria-hidden": "true"}); board.append(wires);
    const partitionContainer = dom("div", `sm-partitions${partition === "all" ? " sm-all-partitions" : ""}`);
    for (const value of partition === "all" ? [0, 1, 2, 3] : [partition]) {
      const container = dom("section", "sm-partition"); container.setAttribute("aria-label", `SM 分区 P${value}`);
      const heading = dom("div", "sm-partition-heading"); heading.append(dom("span", "", `PARTITION ${value} / SMSP`), dom("small", "", "独立调度 / 执行资源")); container.append(heading);
      const components = architecture.components.filter(component => Number(partitionId(component)) === value && partitionId(component) != null);
      const used = new Set();
      for (const [label, ids] of ROWS) {
        const group = ids.map(id => components.find(component => localId(component) === id)).filter(Boolean); if (!group.length) continue;
        group.forEach(component => used.add(component.id)); container.append(makeGroup(group, label, `sm-stage-grid sm-row-${Math.min(4, group.length)}`));
      }
      const remaining = components.filter(component => !used.has(component.id)); if (remaining.length) container.append(makeGroup(remaining, "OTHER DEFINED RESOURCES", "sm-stage-grid"));
      partitionContainer.append(container);
    }
    board.append(partitionContainer);
    const shared = architecture.components.filter(component => partitionId(component) == null);
    const zone = dom("section", "sm-shared-zone"); zone.setAttribute("aria-label", "SM 共享存储与异步数据路径"); zone.append(dom("h4", "", "SM SHARED RESOURCES / ASYNC DATA PATH"));
    const pool = shared.filter(component => ["l1-cache", "shared-memory"].includes(localId(component)));
    const other = shared.filter(component => !pool.includes(component)); zone.append(makeGroup(other, null));
    const poolContainer = dom("div", "sm-shared-pool"); poolContainer.append(dom("p", "sm-shared-pool-label", "统一物理存储池 · 两种独立语义：L1 自动缓存，SMEM 由程序显式寻址与同步"), makeGroup(pool, null)); zone.append(poolContainer);
    board.append(zone);
    tokenLayer = svg("g", {class: "sm-pipeline-tokens"}); wires.append(tokenLayer);
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
    const locations = new Map();
    for (const [id, {card}] of cards) {
      const rect = card.getBoundingClientRect(); locations.set(id, {x: (rect.left - bounds.left + rect.width / 2) / scale, y: (rect.top - bounds.top) / scale, width: rect.width / scale, height: rect.height / scale});
    }
    for (const node of paths.values()) node.remove(); paths.clear(); pathByPair.clear();
    wires.setAttribute("viewBox", `0 0 ${board.offsetWidth} ${board.offsetHeight}`);
    for (const link of architecture.links) {
      const source = locations.get(link.source), target = locations.get(link.target); if (!source || !target) continue;
      const dy = target.y - source.y;
      let d;
      if (Math.abs(dy) < source.height / 2) {
        const direction = target.x >= source.x ? 1 : -1;
        const sx = source.x + direction * source.width / 2, tx = target.x - direction * target.width / 2, sy = source.y + source.height / 2, ty = target.y + target.height / 2;
        d = `M${sx},${sy} C${(sx + tx) / 2},${sy} ${(sx + tx) / 2},${ty} ${tx},${ty}`;
      } else {
        const sy = dy >= 0 ? source.y + source.height : source.y, ty = dy >= 0 ? target.y : target.y + target.height;
        const middle = (sy + ty) / 2; d = `M${source.x},${sy} C${source.x},${middle} ${target.x},${middle} ${target.x},${ty}`;
      }
      const path = svg("path", {d, class: "sm-formal-link", "data-type": link.type}); path.style.setProperty("--flow-color", `var(--sm-${link.type})`);
      paths.set(link.id, path); pathByPair.set(`${link.source}|${link.target}|${link.type}`, {path, link}); wires.insertBefore(path, tokenLayer);
    }
    patchWires(); patchTokens();
  }
  function patchCards() {
    for (const [id, {card, state}] of cards) {
      const value = snapshot.get(id);
      card.setAttribute("aria-pressed", String(id === selectedFormalId));
      for (const kind of ["active", "stall", "queue"]) card.classList.toggle(`sm-evidence-${kind}`, value[kind].length > 0);
      const status = value.stall.length ? `STALL ${value.stall.length} · ${value.stall[0].args?.stallReason ?? "source"}`
        : value.queue.length ? `QUEUE ${value.queue.length}` : value.active.length ? `ACTIVE ${value.active.length} · ${value.active[0].args?.stage ?? "span"}`
        : value.transfer.length ? `TRANSFER ${value.transfer.length}` : value.observed ? `${value.completed} / ${value.total} 源区间已结束` : "未观测 / 结构定义";
      state.textContent = status;
      if (formalById.get(id).simulationCoverage === "timing-only" && value.observed) state.textContent = `仅时序 · ${status}`;
      card.setAttribute("aria-label", `${LABELS[localId(formalById.get(id))]?.[0] ?? formalById.get(id).label}，${status}，查看正式规格`);
    }
    const count = [...snapshot.values()].filter(value => value.observed).length;
    const typedTransfers = evidence.transfers.filter(event => sourceEventsMatch(event, scope)).length;
    explanation.replaceChildren(dom("b", "", `${count} / ${architecture.components.length} 个正式组件有当前范围的原始事件证据。`), document.createTextNode(count ? " 其余节点保留结构定义；未观测不等于空闲。" : " 当前来源只提供 tile / 任务或未映射的指令记录；Fetch、Issue 等状态保持未观测。"));
    footer.textContent = `${typedTransfers} 个显式类型化传输区间 · ${evidence.unmapped.length} 个来源区间未映射到正式组件${evidence.unresolvedTransfers.length ? ` · ${evidence.unresolvedTransfers.length} 个传输没有匹配正式连接，未绘制 token` : ""}。连线表示组件契约；移动 token 仅代表来源实际记录的 transfer。四分区结构参考 Hopper，译码、队列与延迟按教学模型形式化，未宣称 NVIDIA 私有实现。`;
  }
  function patchWires() {
    const activeLinks = new Set(smPipelineTransferMarks(evidence, time, scope).map(mark => `${mark.sourceId}|${mark.targetId}|${mark.kind}`));
    for (const link of architecture.links) {
      const path = paths.get(link.id); if (!path) continue;
      path.style.display = enabledTypes.has(link.type) ? "" : "none";
      path.classList.toggle("sm-link-selected", selectedFormalId === link.source || selectedFormalId === link.target);
      path.classList.toggle("sm-link-active", activeLinks.has(`${link.source}|${link.target}|${link.type}`));
    }
  }
  function patchTokens() {
    if (!tokenLayer) return;
    tokenLayer.replaceChildren();
    for (const mark of smPipelineTransferMarks(evidence, time, scope)) {
      if (!enabledTypes.has(mark.kind)) continue;
      const geometry = pathByPair.get(`${mark.sourceId}|${mark.targetId}|${mark.kind}`); if (!geometry) continue;
      let point; try {point = geometry.path.getPointAtLength(geometry.path.getTotalLength() * mark.progress);} catch {continue;}
      const token = svg("g", {class: "sm-pipeline-token", transform: `translate(${point.x},${point.y})`, role: "button", tabindex: 0, "data-sm-transfer-event-id": mark.event.id, "aria-label": `${mark.event.name}，${FLOW_LABELS[mark.kind]}传输`});
      token.style.setProperty("--flow-color", `var(--sm-${mark.kind})`); token.append(svg("circle", {r: selectedEventId === mark.event.id ? 5 : 3.5}));
      const title = svg("title"); title.textContent = `${mark.event.name}\n${mark.sourceId} → ${mark.targetId}\n${mark.event.start} → ${mark.event.end} ${trace.meta.timeUnit}`; token.append(title);
      const choose = () => onSelectEvent(mark.event.id); token.addEventListener("click", choose); token.addEventListener("keydown", event => {if (event.key === "Enter" || event.key === " ") {event.preventDefault(); choose();}}); tokenLayer.append(token);
    }
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
    dialog.append(heading, content); patchCards(); patchWires(); patchDialog();
    if (!dialog.open) dialog.showModal();
  }
  function patchDialog() {
    if (!selectedFormalId || !evidenceSummary || !evidenceList) return;
    const value = snapshot.get(selectedFormalId); if (!value) return;
    evidenceSummary.textContent = value.observed ? `t=${time.toLocaleString(undefined, {maximumFractionDigits: 2})} ${trace.meta.timeUnit} · ACTIVE ${value.active.length} / QUEUE ${value.queue.length} / STALL ${value.stall.length} / TRANSFER ${value.transfer.length} · ${value.completed} / ${value.total} 源区间已结束`
      : "当前来源没有此组件的映射事件；状态、占用率、队列深度与延迟均未观测。";
    const relevant = [...value.stall, ...value.queue, ...value.active, ...value.transfer];
    if (!relevant.length && value.latest) relevant.push(value.latest);
    const signature = relevant.slice(0, 6).map(event => event.id).join("|") + selectedEventId;
    if (signature === lastEvidenceSignature) return; lastEvidenceSignature = signature; evidenceList.replaceChildren();
    for (const event of relevant.slice(0, 6)) {
      const choice = action(`${event.args?.stage ?? event.category ?? "span"} · W${event.args?.warpId ?? "?"} · ${event.args?.opcode ?? event.name} · ${event.start} → ${event.end}${event.args?.stallReason ? ` · ${event.args.stallReason}` : ""}`, "sm-evidence-event", () => onSelectEvent(event.id));
      choice.dataset.smEvidenceEventId = event.id; choice.setAttribute("aria-pressed", String(event.id === selectedEventId)); evidenceList.append(choice);
    }
  }
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => {queueGeometry(); onResize();}) : null; observer?.observe(board);
  renderBoard();
  return {element: root,
    update(view = {}) {time = Number.isFinite(view.time) ? view.time : time; scope = view.scope ?? null; selectedEventId = view.selectedEventId ?? null; snapshot = summarizeSmPipelineEvidence(evidence, time, scope); patchCards(); patchWires(); patchTokens(); patchDialog();},
    animate(view = {}) {if (Number.isFinite(view.time)) {time = view.time; patchTokens();}},
    getView() {return {smComponentId: sm.id, partition, selectedFormalId};},
    setView(view = {}) {if ([0, 1, 2, 3, "all"].includes(view.partition)) partition = view.partition; if (formalById.has(view.selectedFormalId)) selectedFormalId = view.selectedFormalId; renderBoard();},
    destroy() {destroyed = true; observer?.disconnect(); if (geometryFrame !== null) cancelAnimationFrame(geometryFrame); if (dialog.open) dialog.close(); root.remove();},
  };
}
