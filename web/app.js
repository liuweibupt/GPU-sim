import { normalizeTrace, validateTrace } from "../lib/trace.js";

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 80;
const MAX_COMPONENTS = 400;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const SVG_NS = "http://www.w3.org/2000/svg";
const state = {
  trace: null, time: 0, playing: false, rate: 1, selectedEventId: null,
  selectedComponentId: null, query: "", category: "", page: 0,
};
let eventById = new Map();
let omittedById = new Map();
let componentById = new Map();
let children = new Map();
let successors = new Map();
let boundaries = [];
let startTime = 0;
let totalTime = 0;
let frame = null;
let lastFrame = null;
let cursorLine = null;
let visibleEvents = [];
let descendantIds = null;
let loadSequence = 0;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function svg(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function announce(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}

function unit() { return state.trace?.meta.timeUnit ?? ""; }
function number(value) {
  return Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 4 });
}
function timeText(value) { return `${number(value)} ${unit()}`.trim(); }
function componentName(id) { return componentById.get(id)?.label ?? id; }
function eventName(id) { return eventById.get(id)?.name ?? id; }
function categoryName(event) { return String(event.category ?? "uncategorized"); }
function activeAt(event) { return event.start <= state.time && state.time < event.end; }
function categoryColor(category) {
  let hash = 0;
  for (const char of category) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 44% 54%)`;
}

function descendants(id) {
  if (!id) return null;
  const ids = new Set([id]);
  const stack = [id];
  while (stack.length) {
    for (const child of children.get(stack.pop()) ?? []) {
      if (!ids.has(child.id)) { ids.add(child.id); stack.push(child.id); }
    }
  }
  return ids;
}

function filteredEvents() {
  if (!state.trace) return [];
  const query = state.query.toLocaleLowerCase();
  return state.trace.events.filter((event) =>
    (!descendantIds || descendantIds.has(event.componentId)) &&
    (!state.category || categoryName(event) === state.category) &&
    (!query || `${event.id} ${event.name} ${componentName(event.componentId)}`.toLocaleLowerCase().includes(query))
  );
}

function indexTrace() {
  eventById = new Map(state.trace.events.map((event) => [event.id, event]));
  const omitted = state.trace.metrics?.omittedNodes;
  omittedById = new Map((Array.isArray(omitted) ? omitted : []).map((node) => [node.id, node]));
  componentById = new Map(state.trace.components.map((component) => [component.id, component]));
  children = new Map();
  successors = new Map();
  for (const component of state.trace.components) {
    const parent = component.parentId ?? null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(component);
  }
  for (const event of state.trace.events) {
    for (const predecessor of new Set([...event.dependencies, ...(event.args?.issueDependencies ?? [])])) {
      if (!successors.has(predecessor)) successors.set(predecessor, []);
      successors.get(predecessor).push(event.id);
    }
  }
  boundaries = [...new Set(state.trace.events.flatMap((event) => [event.start, event.end]))].sort((a, b) => a - b);
  startTime = boundaries[0] ?? 0;
  totalTime = boundaries.at(-1) ?? 0;
  descendantIds = descendants(state.selectedComponentId);
}

function setTrace(input, savedView = null) {
  const trace = normalizeTrace(input);
  validateTrace(trace);
  pause();
  state.trace = trace;
  Object.assign(state, {
    time: 0, selectedEventId: null, selectedComponentId: null,
    query: "", category: "", page: 0, rate: 1,
  });
  indexTrace();
  state.time = startTime;
  if (savedView && typeof savedView === "object") {
    state.time = Math.max(startTime, Math.min(totalTime, Number(savedView.time) || 0));
    state.selectedEventId = eventById.has(savedView.selectedEventId) ? savedView.selectedEventId : null;
    state.selectedComponentId = componentById.has(savedView.selectedComponentId) ? savedView.selectedComponentId : null;
    state.query = typeof savedView.query === "string" ? savedView.query : "";
    state.category = typeof savedView.category === "string" ? savedView.category : "";
    state.rate = [0.25, 1, 4].includes(savedView.rate) ? savedView.rate : 1;
    state.page = Math.max(0, Math.floor(Number(savedView.page) || 0));
    descendantIds = descendants(state.selectedComponentId);
  }
  $("event-search").value = state.query;
  $("playback-rate").value = String(state.rate);
  const categorySelect = $("category-filter");
  categorySelect.replaceChildren(new Option("全部类别", ""));
  for (const category of [...new Set(trace.events.map(categoryName))].sort()) {
    categorySelect.add(new Option(category, category));
  }
  if (![...categorySelect.options].some((option) => option.value === state.category)) state.category = "";
  categorySelect.value = state.category;
  renderSummary();
  renderComponents();
  renderTimeline();
  renderDetails();
  renderAtTime();
  for (const id of ["export-trace", "save-workspace", "clear-component"]) $(id).disabled = false;
  $("time-slider").min = String(startTime);
  $("time-slider").max = String(totalTime === startTime ? startTime + 1 : totalTime);
  $("time-slider").value = String(state.time);
  $("time-slider").disabled = totalTime === startTime;
  $("play").disabled = totalTime === startTime;
  $("step").disabled = totalTime === startTime;
  $("step-back").disabled = totalTime === startTime;
}

function renderSummary() {
  const { meta, events, components, metrics } = state.trace;
  $("trace-title").textContent = meta.title || "未命名执行记录";
  $("trace-description").textContent = meta.description || "这份记录未提供描述。点击事件查看原始字段。";
  const measured = meta.evidenceKind === "measurement";
  $("evidence-badge").textContent = measured
    ? `${meta.producer} · 测量记录（以来源说明为准）`
    : `${meta.producer} ${meta.evidenceKind === "illustration" ? "示意模型" : "仿真"} · 非实机 profile`;
  $("evidence-badge").classList.toggle("measurement", measured);
  const facts = $("trace-facts");
  facts.replaceChildren();
  for (const [label, value] of [["事件 / 组件", `${number(events.length)} / ${number(components.length)}`], ["时间范围", `${number(startTime)} – ${timeText(totalTime)}`], ["Producer", meta.producer]]) {
    const group = el("div");
    group.append(el("dt", label), el("dd", value));
    facts.append(group);
  }
  $("trace-metadata").textContent = JSON.stringify({ meta, metrics }, null, 2);
}

function renderComponents() {
  const tree = $("component-tree");
  tree.replaceChildren();
  if (!state.trace.components.length) { tree.append(el("p", "这份记录没有组件。", "empty")); return; }
  const eventCounts = new Map();
  const activeCounts = new Map();
  for (const event of state.trace.events) {
    eventCounts.set(event.componentId, (eventCounts.get(event.componentId) ?? 0) + 1);
    if (activeAt(event)) activeCounts.set(event.componentId, (activeCounts.get(event.componentId) ?? 0) + 1);
  }
  // Aggregate bottom-up, without walking every event through an arbitrarily deep hierarchy.
  const pendingChildren = new Map(state.trace.components.map((component) => [component.id, children.get(component.id)?.length ?? 0]));
  const leaves = state.trace.components.filter((component) => pendingChildren.get(component.id) === 0);
  for (let index = 0; index < leaves.length; index++) {
    const component = leaves[index], parent = component.parentId;
    if (parent == null) continue;
    eventCounts.set(parent, (eventCounts.get(parent) ?? 0) + (eventCounts.get(component.id) ?? 0));
    activeCounts.set(parent, (activeCounts.get(parent) ?? 0) + (activeCounts.get(component.id) ?? 0));
    pendingChildren.set(parent, pendingChildren.get(parent) - 1);
    if (pendingChildren.get(parent) === 0) leaves.push(componentById.get(parent));
  }
  let rendered = 0;
  function componentNode(component, depth = 0) {
    rendered++;
    const box = el("div", undefined, "component-unit");
    const button = el("button", undefined, "component-button");
    button.type = "button";
    button.dataset.componentId = component.id;
    button.classList.toggle("selected", state.selectedComponentId === component.id);
    button.classList.toggle("running", (activeCounts.get(component.id) ?? 0) > 0);
    button.setAttribute("aria-pressed", String(state.selectedComponentId === component.id));
    const name = el("span");
    name.append(el("span", component.label, "component-name"), el("span", `${component.kind} · ${component.id}`, "component-kind"));
    button.append(name, el("span", `${eventCounts.get(component.id) ?? 0} 事件`, "component-count"));
    button.addEventListener("click", () => selectComponent(component.id));
    box.append(button);
    // The validated schema rejects parent cycles. Limit DOM nesting for unusual imported hierarchies.
    if (depth < 12) for (const child of children.get(component.id) ?? []) {
      if (rendered >= MAX_COMPONENTS) break;
      box.append(componentNode(child, depth + 1));
    }
    else if (children.get(component.id)?.length) box.append(el("p", "更深层组件仍可通过事件查找。", "muted"));
    return box;
  }
  for (const root of children.get(null) ?? []) {
    if (rendered >= MAX_COMPONENTS) break;
    tree.append(componentNode(root));
  }
  if (rendered < state.trace.components.length) tree.append(el("p", `组件视图显示 ${rendered} / ${number(state.trace.components.length)} 个（最多 ${MAX_COMPONENTS} 个，12 层）。事件搜索仍覆盖全部记录；大型 Trace 建议先截取窗口。`, "muted"));
}

function selectComponent(id) {
  state.selectedComponentId = id;
  descendantIds = descendants(id);
  state.page = 0;
  renderComponents();
  renderTimeline();
  renderActiveTasks();
}

function renderTimeline() {
  const timeline = $("timeline");
  const scrollTop = timeline.scrollTop, scrollLeft = timeline.scrollLeft;
  const focusedEventId = timeline.contains(document.activeElement) ? document.activeElement.dataset.eventId : null;
  timeline.replaceChildren();
  cursorLine = null;
  visibleEvents = filteredEvents().sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  const pageCount = Math.ceil(visibleEvents.length / PAGE_SIZE);
  state.page = Math.min(state.page, Math.max(0, pageCount - 1));
  $("event-count").textContent = `${number(visibleEvents.length)} / ${number(state.trace.events.length)} 个事件`;
  $("page-label").textContent = `第 ${pageCount ? state.page + 1 : 0} / ${pageCount} 页`;
  $("previous-page").disabled = state.page === 0;
  $("next-page").disabled = state.page + 1 >= pageCount;
  const component = state.selectedComponentId ? componentName(state.selectedComponentId) : "全部组件";
  $("timeline-context").textContent = `${component} · 原始单位：${unit()} · 金色：完成依赖；绿色虚线：发射依赖；紫色：后继；蓝色：选中。`;
  if (!visibleEvents.length) {
    timeline.append(el("p", state.trace.events.length ? "没有匹配的事件。可清除搜索、类别或组件筛选。" : "这份记录没有事件，可导入包含执行事件的 Trace。", "empty"));
    return;
  }
  const pageEvents = visibleEvents.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
  const left = 242, plotWidth = 690, width = 950, rowHeight = 27, top = 35;
  const height = top + pageEvents.length * rowHeight + 14;
  const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, width, height, role: "group", "aria-label": `事件时间线，单位 ${unit()}，第 ${state.page + 1} 页` });
  const x = (time) => left + ((time - startTime) / (totalTime - startTime || 1)) * plotWidth;
  for (let tick = 0; tick <= 5; tick++) {
    const value = startTime + (totalTime - startTime) * tick / 5;
    chart.append(svg("line", { x1: x(value), x2: x(value), y1: 26, y2: height, class: "grid-line" }));
    const label = svg("text", { x: x(value), y: 17, "text-anchor": tick === 5 ? "end" : "start", class: "tick" });
    label.textContent = number(value);
    chart.append(label);
  }
  const selected = eventById.get(state.selectedEventId);
  const predecessors = new Set(selected?.dependencies ?? []);
  const issuePredecessors = new Set(selected?.args?.issueDependencies ?? []);
  const after = new Set(successors.get(state.selectedEventId) ?? []);
  pageEvents.forEach((event, index) => {
    const y = top + index * rowHeight;
    chart.append(svg("line", { x1: 0, x2: width, y1: y + 23, y2: y + 23, class: "row-rule" }));
    const label = svg("text", { x: 9, y: y + 14, class: "row-label" });
    const title = `${componentName(event.componentId)} · ${event.name}`;
    label.textContent = title.length > 32 ? `${title.slice(0, 31)}…` : title;
    const labelTitle = svg("title"); labelTitle.textContent = title; label.append(labelTitle);
    label.addEventListener("click", () => selectEvent(event.id));
    chart.append(label);
    const classes = ["event-span"];
    if (event.id === state.selectedEventId) classes.push("selected");
    else if (predecessors.has(event.id)) classes.push("dependency");
    else if (issuePredecessors.has(event.id)) classes.push("issue-dependency");
    else if (after.has(event.id)) classes.push("successor");
    if (event.start === event.end) classes.push("instant-event");
    const span = svg("rect", {
      x: Math.min(x(event.start), left + plotWidth - 3), y, width: Math.max(3, x(event.end) - x(event.start)), height: 18, rx: 3,
      fill: categoryColor(categoryName(event)), class: classes.join(" "), tabindex: 0, role: "button", "data-event-id": event.id,
      "aria-label": `${event.name}，${componentName(event.componentId)}，${timeText(event.start)} 至 ${timeText(event.end)}，查看详情`,
      "aria-pressed": String(event.id === state.selectedEventId),
    });
    const spanTitle = svg("title"); spanTitle.textContent = `${event.name}\n${categoryName(event)}\n${timeText(event.start)} → ${timeText(event.end)}`; span.append(spanTitle);
    span.addEventListener("click", () => selectEvent(event.id));
    span.addEventListener("keydown", (key) => {
      if (key.code === "Enter" || key.code === "Space") { key.preventDefault(); key.stopPropagation(); selectEvent(event.id); }
    });
    chart.append(span);
  });
  cursorLine = svg("line", { x1: x(state.time), x2: x(state.time), y1: 26, y2: height, class: "time-cursor" });
  chart.append(cursorLine);
  timeline.append(chart);
  timeline.scrollTop = scrollTop; timeline.scrollLeft = scrollLeft;
  if (focusedEventId) [...chart.querySelectorAll("[data-event-id]")].find((node) => node.dataset.eventId === focusedEventId)?.focus({ preventScroll: true });
}

function renderActiveTasks() {
  const active = filteredEvents().filter(activeAt);
  $("active-count").textContent = `${number(active.length)} 个进行中`;
  const list = $("active-tasks");
  const scrollTop = list.scrollTop;
  const focusedEventId = list.contains(document.activeElement) ? document.activeElement.dataset.eventId : null;
  list.replaceChildren();
  if (!active.length) {
    const text = totalTime > 0 && state.time >= totalTime ? "已到记录终点。可回到起点播放，或选择时间线中的事件。" : "当前时间与筛选范围内没有进行中任务。试试下一事件边界，或在时间线选择事件。";
    list.append(el("p", text, "empty"));
    return;
  }
  for (const event of active.slice(0, 200)) {
    const button = el("button", undefined, "task-button");
    button.type = "button";
    button.dataset.eventId = event.id;
    button.classList.toggle("selected", event.id === state.selectedEventId);
    button.setAttribute("aria-pressed", String(event.id === state.selectedEventId));
    button.append(el("span", event.name, "task-name"), el("span", `${componentName(event.componentId)} · ${categoryName(event)} · ${timeText(event.start)} → ${timeText(event.end)}`, "task-meta"));
    button.addEventListener("click", () => selectEvent(event.id));
    list.append(button);
  }
  if (active.length > 200) list.append(el("p", `显示前 200 / ${number(active.length)} 个进行中任务。请选择具体组件缩小范围。`, "muted"));
  list.scrollTop = scrollTop;
  if (focusedEventId) [...list.querySelectorAll("[data-event-id]")].find((node) => node.dataset.eventId === focusedEventId)?.focus({ preventScroll: true });
}

function selectEvent(id) {
  state.selectedEventId = id;
  renderTimeline();
  renderActiveTasks();
  renderDetails();
}

function renderDetails() {
  const panel = $("event-details");
  panel.replaceChildren();
  const event = eventById.get(state.selectedEventId);
  $("jump-to-event").disabled = !event;
  if (!event) { panel.append(el("p", "选择时间线或当前任务中的事件。这里保留原始名称、时间与参数。", "empty")); return; }
  panel.append(el("h3", event.name, "detail-title"));
  const facts = el("dl", undefined, "detail-facts");
  for (const [label, value] of [["ID", event.id], ["组件", `${componentName(event.componentId)} (${event.componentId})`], ["类别", categoryName(event)], ["start", timeText(event.start)], ["end", timeText(event.end)], ["duration", timeText(event.end - event.start)]]) facts.append(el("dt", label), el("dd", value));
  panel.append(facts);
  for (const [label, ids] of [["完成依赖 · 前置事件完成后开始", event.dependencies], ["发射依赖 · 不要求前置事件完成", event.args?.issueDependencies ?? []], ["后继事件 · 含完成与发射边", successors.get(event.id) ?? []]]) {
    panel.append(el("h4", label, "dependency-title"));
    const list = el("div", undefined, "dependency-list");
    if (!ids.length) list.append(el("span", "未提供相关依赖。", "muted"));
    for (const id of ids) {
      if (!eventById.has(id)) {
        const omitted = omittedById.get(id);
        const knownStart = Number.isFinite(omitted?.start) ? `start ${timeText(omitted.start)}` : "start 未知";
        const status = omitted?.status === "started-incomplete" ? "已发射未完成" : "未提供完整区间";
        list.append(el("span", `${id} · ${status} · ${knownStart} · end 未知；不生成时间线区间。`, "muted"));
        continue;
      }
      const button = el("button", `${eventName(id)} · ${id}`);
      button.type = "button";
      button.addEventListener("click", () => {
        state.selectedEventId = id;
        // Dependency navigation stays usable even when the current filters hide its target.
        state.selectedComponentId = null; descendantIds = null; state.query = ""; state.category = "";
        $("event-search").value = ""; $("category-filter").value = "";
        const all = filteredEvents().sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
        state.page = Math.max(0, Math.floor(all.findIndex((item) => item.id === id) / PAGE_SIZE));
        renderComponents(); selectEvent(id);
      });
      list.append(button);
    }
    panel.append(list);
  }
  panel.append(el("h4", "原始 args", "dependency-title"), el("pre", JSON.stringify(event.args ?? {}, null, 2)));
}

function renderAtTime() {
  $("time-label").textContent = timeText(state.time);
  $("time-slider").value = String(state.time);
  $("time-slider").setAttribute("aria-valuetext", timeText(state.time));
  if (cursorLine) {
    const x = 242 + (state.time - startTime) / (totalTime - startTime || 1) * 690;
    cursorLine.setAttribute("x1", String(x)); cursorLine.setAttribute("x2", String(x));
  }
  // Keep the hierarchy DOM stable during playback to retain keyboard focus and scroll.
  const activeComponents = new Set();
  if (state.trace) for (const event of state.trace.events) if (activeAt(event)) {
    let id = event.componentId;
    while (id && !activeComponents.has(id)) { activeComponents.add(id); id = componentById.get(id)?.parentId; }
  }
  for (const button of document.querySelectorAll("[data-component-id]")) button.classList.toggle("running", activeComponents.has(button.dataset.componentId));
  renderActiveTasks();
}

function seek(time) {
  state.time = Math.max(startTime, Math.min(totalTime, time));
  renderAtTime();
}

function pause() {
  state.playing = false;
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null; lastFrame = null;
  $("play").textContent = "播放";
  $("play").setAttribute("aria-pressed", "false");
}

function togglePlay() {
  if (!state.trace || totalTime === startTime) return;
  if (state.playing) { pause(); return; }
  if (state.time >= totalTime) seek(startTime);
  state.playing = true;
  $("play").textContent = "暂停";
  $("play").setAttribute("aria-pressed", "true");
  let lastRender = 0;
  function tick(now) {
    if (!state.playing) return;
    if (lastFrame !== null) state.time = Math.min(totalTime, state.time + (now - lastFrame) / 15000 * (totalTime - startTime) * state.rate);
    lastFrame = now;
    // Limit expensive active-list updates; no animation is needed for understanding individual steps.
    if (now - lastRender >= 100 || state.time >= totalTime) { renderAtTime(); lastRender = now; }
    if (state.time >= totalTime) { pause(); return; }
    frame = requestAnimationFrame(tick);
  }
  frame = requestAnimationFrame(tick);
}

function step(direction) {
  if (!state.trace) return;
  pause();
  const target = direction > 0 ? boundaries.find((time) => time > state.time) : boundaries.findLast((time) => time < state.time);
  if (target !== undefined) seek(target);
}

function download(data, suffix) {
  // Compact output avoids inflating a small Chrome input into an unreadable workspace.
  // Keep the same limit for reading and writing, including preserved source.raw evidence.
  const blob = new Blob([JSON.stringify(data)], { type: "application/json;charset=utf-8" });
  if (blob.size > MAX_FILE_BYTES) {
    announce(`无法导出：文件为 ${number(blob.size / 1024 / 1024)} MiB，超过本原型 32 MiB 的导入/导出上限。原始来源未删减；请在外部工具裁剪后重新导入。当前工作区保持可用。`, true);
    return false;
  }
  const url = URL.createObjectURL(blob);
  const link = el("a");
  link.href = url;
  link.download = `${(state.trace.meta.title || "gpu-world").replace(/[\\/:*?"<>|]/g, "-").slice(0, 70)}.${suffix}.json`;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

async function importFile(file, workspaceOnly) {
  if (!file) return;
  const sequence = ++loadSequence;
  announce(`正在读取 ${file.name}…`);
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error("原型最多导入 32 MiB JSON。请先截取需要观察的事件窗口。");
    const input = JSON.parse(await file.text());
    if (sequence !== loadSequence) return;
    if (input?.kind === "gpu-sim-workspace") {
      if (input.version !== 1) throw new Error("工作区版本不受支持；当前支持 version 1。");
      setTrace(input.trace, input.view);
      announce(`已打开工作区：${file.name}。文件只在浏览器本地处理。`);
    } else {
      if (workspaceOnly) throw new Error("这不是工作区文件。请使用“导入 Trace”打开执行记录。");
      setTrace(input);
      const warnings = state.trace.meta.importSummary?.warnings ?? [];
      announce(`已导入 ${file.name}，共 ${number(state.trace.events.length)} 个事件。文件只在浏览器本地处理。${warnings.length ? ` 导入说明：${warnings.join(" ")}` : ""}`);
    }
  } catch (error) {
    if (sequence === loadSequence) announce(`无法打开 ${file.name}：${error.message}。原工作区保持可用。`, true);
  }
}

async function loadExample() {
  const sequence = ++loadSequence;
  announce("正在加载 GTSim GEMM 仿真示例…");
  try {
    const response = await fetch(new URL("../examples/gtsim-gemm.json", import.meta.url));
    if (!response.ok) throw new Error(`示例请求失败（HTTP ${response.status}）`);
    const input = await response.json();
    if (sequence !== loadSequence) return;
    setTrace(input);
    announce(`已加载 GTSim 仿真示例，共 ${number(state.trace.events.length)} 个事件。可单步、选择组件或检查依赖。`);
  } catch (error) {
    if (sequence === loadSequence) announce(`默认示例暂不可用：${error.message}。请通过 HTTP 启动仓库，或导入本地 JSON 执行记录。`, true);
  }
}

$("play").addEventListener("click", togglePlay);
$("step").addEventListener("click", () => step(1));
$("step-back").addEventListener("click", () => step(-1));
$("time-slider").addEventListener("input", (event) => { pause(); seek(Number(event.target.value)); });
$("playback-rate").addEventListener("change", (event) => { state.rate = Number(event.target.value); });
$("event-search").addEventListener("input", (event) => { state.query = event.target.value; state.page = 0; if (state.trace) { renderTimeline(); renderActiveTasks(); } });
$("category-filter").addEventListener("change", (event) => { state.category = event.target.value; state.page = 0; if (state.trace) { renderTimeline(); renderActiveTasks(); } });
$("clear-component").addEventListener("click", () => selectComponent(null));
$("previous-page").addEventListener("click", () => { state.page--; renderTimeline(); });
$("next-page").addEventListener("click", () => { state.page++; renderTimeline(); });
$("jump-to-event").addEventListener("click", () => { pause(); const event = eventById.get(state.selectedEventId); if (event) seek(event.start); });
$("load-example").addEventListener("click", loadExample);
$("import-trace").addEventListener("click", () => $("trace-file").click());
$("import-workspace").addEventListener("click", () => $("workspace-file").click());
$("trace-file").addEventListener("change", (event) => { importFile(event.target.files[0], false); event.target.value = ""; });
$("workspace-file").addEventListener("change", (event) => { importFile(event.target.files[0], true); event.target.value = ""; });
$("export-trace").addEventListener("click", () => { if (state.trace && download(state.trace, "trace")) announce("Trace 已导出，原始时间单位、指标与事件保留。未上传任何文件。"); });
$("save-workspace").addEventListener("click", () => {
  if (!state.trace) return;
  const { time, rate, selectedEventId, selectedComponentId, query, category, page } = state;
  if (download({ kind: "gpu-sim-workspace", version: 1, trace: state.trace, view: { time, rate, selectedEventId, selectedComponentId, query, category, page } }, "workspace")) announce("工作区已保存，包含 Trace、当前时间、选择与筛选。未上传任何文件。");
});
document.addEventListener("keydown", (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.target.closest("input, select, textarea, button, a, [contenteditable='true']")) return;
  if (event.code === "Space") { event.preventDefault(); togglePlay(); }
  else if (event.code === "ArrowRight") { event.preventDefault(); step(1); }
  else if (event.code === "ArrowLeft") { event.preventDefault(); step(-1); }
  else if (event.code === "Home" && state.trace) { event.preventDefault(); pause(); seek(startTime); }
  else if (event.code === "End" && state.trace) { event.preventDefault(); pause(); seek(totalTime); }
});
document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); });
loadExample();
