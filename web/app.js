import { validateTrace } from "../lib/trace.js";
import { timeWindow, eventInScope, intersectsWindow } from "../lib/view-state.js";
import {runKind, describeRun, decodeWorkspace, normalizeRun} from "../lib/run-state.js?v=sm-1";
import {normalizeFlashGpuLog} from "../lib/detailed-trace.js";
import {simulateTraffic, DEFAULT_TRAFFIC_CONFIG} from "../lib/traffic-model.js?v=sm-1";
import {simulateSm, DEFAULT_SM_CONFIG} from "../lib/sm-model.js?v=sm-1";
import { createGpuWorld } from "./gpu-world.js?v=sm-1";
import { createDataflow } from "./dataflow.js?v=traffic-1";

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 80;
const MAX_COMPONENTS = 400;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const SVG_NS = "http://www.w3.org/2000/svg";
const state = {
  trace: null, time: 0, playing: false, rate: 1, selectedEventId: null,
  selectedComponentId: null, query: "", category: "", page: 0,
  scope: null, timelineZoom: 1, timelineCenter: null,
};
let runs = {macro: null, detail: null};
let activeRun = 'macro';
let observationLevel = 'gpu';
const world = createGpuWorld($("gpu-world"), {
  onSelectComponent: (id) => selectComponent(id, {preserveScope: true}),
  onSelectEvent: (id) => { if (eventById.has(id)) selectEvent(id); },
  onSelectScope: (scope) => selectScope(scope),
  onLevelChange: (level) => { observationLevel = level; renderRunBar(); },
});
const dataflow = createDataflow($("dataflow"), (id) => {
  pause();
  state.selectedComponentId = null; descendantIds = null;
  state.scope = null; state.query = ""; state.category = "";
  $("event-search").value = ""; $("category-filter").value = "";
  renderComponents(); selectEvent(id);
}, (time) => { pause(); seek(time); });
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
let timelineRange = {start:0,end:0};
let trafficPackets = [];

function isTraffic(trace = state.trace) {
  return trace?.meta?.backend === 'GPU City Traffic Model';
}

function isSmModel(trace = state.trace) {
  return trace?.meta?.capabilities?.includes('sm_pipeline') === true;
}

const smControls = [
  ['sm-warps', 'warpCount'], ['sm-issue-interval', 'issueIntervalCycles'],
  ['sm-memory-latency', 'globalMemoryLatencyCycles'], ['sm-tensor-latency', 'tensorLatencyCycles'],
  ['sm-bank-stride', 'sharedBankStrideWords'],
];

function syncSmTarget(id) {
  let component = componentById.get(id);
  while (component && component.kind !== 'sm') component = componentById.get(component.parentId);
  if (!component) return;
  const smId = component.args?.smId ?? component.smId ?? /^sm-(\d+)$/.exec(component.id)?.[1];
  if (Number.isInteger(Number(smId)) && Number(smId) >= 0 && Number(smId) < 132) {
    $('sm-target').value = String(smId);
    $('sm-config-label').textContent = `目标 SM ${smId} · 4 分区 · ${$('sm-warps').value} warps`;
  }
}

function smConfig() {
  return {...DEFAULT_SM_CONFIG, smId: Number($('sm-target').value),
    ...Object.fromEntries(smControls.map(([id,key]) => [key, Number($(id).value)]))};
}

function showSmConfig(config) {
  if (!config) return;
  $('sm-target').value = String(config.smId);
  for (const [id,key] of smControls) {
    const control = $(id), value = String(config[key]);
    control.querySelector('option[data-imported]')?.remove();
    if (![...control.options].some(option => option.value === value)) {
      const option = new Option(value, value); option.dataset.imported = 'true'; control.add(option);
    }
    control.value = value;
  }
  $('sm-config-label').textContent = `SM ${config.smId} · 4 分区 · ${config.warpCount} warps`;
  $('sm-config-note').textContent = '当前运行的参数已恢复。修改后点击“运行 SM 流水线”生成新记录；宏观运行保留。';
}

function runInfo(trace) {
  return describeRun(trace);
}

function trafficConfig() {
  return {...DEFAULT_TRAFFIC_CONFIG, numSms: 132,
    nocTopology: $('noc-topology').value,
    nocBytesPerCycle: Number($('noc-bandwidth').value),
    crossPartitionBytesPerCycle: Number($('noc-cross-bandwidth').value),
    crossPartitionLatencyCycles: Number($('noc-cross-latency').value),
    hbmBytesPerCycle: Number($('hbm-bandwidth').value),
    coalesceShared: $('coalesce-shared').checked};
}

function showTrafficConfig(config) {
  if (!config) return;
  for (const [id, key] of [['noc-bandwidth','nocBytesPerCycle'],['hbm-bandwidth','hbmBytesPerCycle'],['noc-cross-bandwidth','crossPartitionBytesPerCycle']]) {
    const control = $(id), value = String(config[key] ?? DEFAULT_TRAFFIC_CONFIG[key]);
    control.querySelector('option[data-imported]')?.remove();
    if (![...control.options].some(option => option.value === value)) {
      const option = new Option(`${value} B / cycle`, value);
      option.dataset.imported = 'true'; control.add(option);
    }
    control.value = value;
  }
  $('noc-topology').value = config.nocTopology ?? 'uniform-star';
  $('noc-cross-latency').value = String(config.crossPartitionLatencyCycles ?? DEFAULT_TRAFFIC_CONFIG.crossPartitionLatencyCycles);
  const partitioned = $('noc-topology').value === 'partitioned-crossbar';
  $('noc-cross-bandwidth').disabled = !partitioned;
  $('noc-cross-latency').disabled = !partitioned;
  $('coalesce-shared').checked = config.coalesceShared !== false;
  $('traffic-config-label').textContent = `${config.numSms === 132 && config.hbmStacks === 5 ? 'H100 SXM' : '教学变体'} · ${number(config.numSms)} SM · ${partitioned ? '双分区' : '单 Fabric'} · ${number(config.nocBytesPerCycle)} B/cycle`;
  $('traffic-config-note').textContent = '参数只用于下一次仿真；当前记录的时间不会改变。普通读取逐 SM 单播返回，未执行 TMA cluster multicast。';
}

function normalizeImported(input) {
  return normalizeRun(input);
}

function captureView() {
  const {time, rate, selectedEventId, selectedComponentId, query, category, page, scope, timelineZoom, timelineCenter} = state;
  return {time, rate, selectedEventId, selectedComponentId, query, category, page, scope, timelineZoom, timelineCenter,
    immersive: $('immersive-view')?.checked ?? true, world: world.getView?.()};
}

function rememberRun() {
  if (state.trace) runs[activeRun] = {trace: state.trace, view: captureView()};
}

function playbackDuration() {
  if (isTraffic()) return observationLevel === 'sm' ? 120000 : 90000;
  return activeRun === 'detail' || state.scope?.threadBlockId != null ? 60000 : observationLevel === 'sm' ? 30000 : 15000;
}

function renderRunBar() {
  if (!state.trace) return;
  const info = runInfo(state.trace), detail = activeRun === 'detail', traffic = isTraffic();
  $('macro-view').setAttribute('aria-pressed', String(!detail && observationLevel === 'gpu'));
  $('micro-view').setAttribute('aria-pressed', String(detail || observationLevel === 'sm'));
  $('macro-view').disabled = !runs.macro && detail;
  const detailedInfo = runs.detail && describeRun(runs.detail.trace);
  const macroInfo = runs.macro && runInfo(runs.macro.trace);
  $('macro-backend').textContent = macroInfo ? `${isTraffic(runs.macro.trace) ? '教学模型' : macroInfo.backend} · ${macroInfo.granularity}` : '宏观运行 · 待载入';
  $('micro-backend').textContent = detailedInfo ? `${isSmModel(runs.detail.trace) ? '教学模型' : detailedInfo.backend} · ${detailedInfo.granularity}` : '组件规格 · 可运行流水线模型';
  $('run-granularity').textContent = info.granularity;
  $('simulation-runtime').textContent = info.wallTimeSeconds === null ? '未记录' : `${number(info.wallTimeSeconds)} s`;
  $('simulation-runtime').title = info.timingScope ?? '来源未记录仿真墙钟耗时；播放速度不代表仿真吞吐。';
  $('clock-scope').textContent = detail ? '详细运行 · 独立时钟' : '宏观运行 · 独立时钟';
  $('clock-scope').title = info.timeDomain;
  $('world-level-tag').textContent = isSmModel() ? 'SM / PIPELINE MODEL' : detail ? 'SM / INSTRUCTION' : traffic ? `${observationLevel === 'sm' ? 'SM' : 'GPU'} / DATA FLOW` : observationLevel === 'sm' ? 'SM / TILE' : 'GPU / TILE';
  $('playback-scope').textContent = `${detail ? '指令慢放' : observationLevel === 'sm' ? 'SM 慢放' : '全景'} · ${number(playbackDuration() / 1000 / state.rate)}s / 遍`;
  $('run-context').textContent = isSmModel()
    ? `SM ${state.trace.meta.config.smId} 流水线教学模型 · 4 分区，显式执行 Fetch / Decode / Issue、RAW 等待、执行和写回；TMA 异步完成后释放 mbarrier。与城市模型分别运行，时序未按实机校准。`
    : detail
    ? `${info.backend}${info.version ? ` ${info.version}` : ''} · ${info.granularity}。与宏观模型分别运行，各自保留时钟与选择；不自动对齐或拼接 cycle。`
    : traffic
      ? `GPU City 教学模型 · ${state.trace.meta.config.numSms === 132 && state.trace.meta.config.hbmStacks === 5 ? 'H100 SXM 132 SM 配置' : `${number(state.trace.meta.config.numSms)} SM 教学变体`}。${state.trace.meta.config.nocTopology === 'partitioned-crossbar' ? '双分区 Crossbar / 局部 L2，远端内存 miss 经桥；链路串行化与传播分开。' : '单 Fabric 与理想共享缓存对照。'}${state.trace.meta.config.coalesceShared ? '同缓存域内共享 Tile 复用后逐 SM 单播；不是全 GPU 广播。' : '已禁用共享缓存与请求合并；每请求独立访问 HBM。'}时序未按实机校准。`
    : observationLevel === 'sm'
      ? `当前 SM 展示 ${info.backend} 的 ${info.granularity}。载入详细运行后可查看指令观测；两份运行独立保存。`
      : '外层观察 Tile 任务在 SM 上的执行与依赖；点击 SM 进入内部。详细后端单独运行，回放速度与仿真耗时分别显示。';
}

function activateRun(slot) {
  if (!runs[slot]) return false;
  if (slot !== activeRun) {
    ++loadSequence;
    const next = runs[slot];
    setTrace(next.trace, next.view, slot);
    announce(`已切换到${slot === 'detail' ? '详细指令' : '宏观'}运行，恢复它自己的时钟与观察位置。`);
  }
  return true;
}

function enterSm() {
  const savedId = world.getView?.().smComponentId;
  const sm = state.trace?.components.find(component => component.kind === 'sm' && component.id === savedId)
    ?? state.trace?.components.find(component => component.kind === 'sm');
  if (!sm) { announce('这份记录没有原生 SM 归属，保留 Profile 轨道。'); return; }
  selectComponent(sm.id);
  observationLevel = 'sm'; renderRunBar();
}

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
  const key = category.toLowerCase();
  if (key.includes('queue')) return '#e4b368';
  if (key.includes('response') || key.includes('fanout')) return '#48e2c0';
  if (key.includes('request') || key.includes('noc') || key.includes('hbm')) return '#57b9e9';
  if (key === 'transfer') return '#57b9e9';
  if (key.includes('tensor') || key.includes('mma')) return '#a78bfa';
  if (key === 'ld' || key.includes('memory')) return '#57b9e9';
  if (key === 'st') return '#48c9ae';
  if (key.includes('compute')) return '#e4b368';
  if (key.includes('sync')) return '#ed8d9e';
  return '#8295ab';
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
    eventInComponent(event) &&
    eventInScope(event, state.scope) &&
    (!state.category || categoryName(event) === state.category) &&
    (!query || `${event.id} ${event.name} ${componentName(event.componentId)}`.toLocaleLowerCase().includes(query))
  );
}

function eventInComponent(event) {
  if (!descendantIds || descendantIds.has(event.componentId)) return true;
  const component = componentById.get(state.selectedComponentId);
  // Packet intervals belong to links, while their task ownership remains on the SM.
  return isTraffic() && component?.kind === 'sm' && event.args?.smId === component.smId;
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
  const packets = new Map();
  if (isTraffic()) for (const event of state.trace.events) {
    const packetId = event.args?.flow?.packetId;
    if (!packetId) continue;
    if (!packets.has(packetId)) packets.set(packetId, {start: event.start, end: event.end, transfers: []});
    const packet = packets.get(packetId);
    packet.start = Math.min(packet.start, event.start);
    packet.end = Math.max(packet.end, event.end);
    if (event.args.stage === 'transfer') packet.transfers.push(event);
  }
  trafficPackets = [...packets.values()];
}

function setTrace(input, savedView = null, slot = null, remember = true) {
  const trace = normalizeImported(input);
  validateTrace(trace);
  if (remember) rememberRun();
  pause();
  activeRun = slot ?? runKind(trace);
  runs[activeRun] = {trace, view: savedView};
  observationLevel = 'gpu';
  state.trace = trace;
  Object.assign(state, {
    time: 0, selectedEventId: null, selectedComponentId: null,
    query: "", category: "", page: 0, rate: 1,
    scope: null, timelineZoom: 1, timelineCenter: null,
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
    state.scope = savedView.scope && typeof savedView.scope === 'object'
      ? Object.fromEntries(['smId','threadBlockId','warpId'].filter(key => ['string','number'].includes(typeof savedView.scope[key])).map(key => [key,savedView.scope[key]])) : null;
    state.timelineZoom = Math.max(1, Math.min(16, Number(savedView.timelineZoom) || 1));
    state.timelineCenter = Number.isFinite(savedView.timelineCenter) ? savedView.timelineCenter : null;
    if (typeof savedView.immersive === "boolean" && $("immersive-view")) $("immersive-view").checked = savedView.immersive;
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
  $("timeline-zoom").value = String(state.timelineZoom);
  $("timeline-zoom-label").textContent = `${number(state.timelineZoom)}×`;
  $("time-input").min = String(startTime);
  $("time-input").max = String(totalTime);
  $("time-input").value = String(state.time);
  const sampleSelect = $("sample-select");
  sampleSelect.querySelector('option[value="custom"]')?.remove();
  if (isTraffic(trace)) {
    sampleSelect.value = 'traffic'; showTrafficConfig(trace.meta.config);
  } else if (isSmModel(trace)) {
    sampleSelect.value = 'sm'; showSmConfig(trace.meta.config);
  } else if (/GTSim/.test(trace.meta.producer) && trace.meta.config?.M === 256 && trace.meta.config?.N === 256 && trace.meta.config?.K === 128) {
    sampleSelect.value = trace.meta.config.l2BandwidthBytesPerCycle === 128 ? 'slow-l2' : 'standard';
  } else {
    const custom = new Option('自定义导入', 'custom'); custom.disabled = true;
    sampleSelect.add(custom); sampleSelect.value = 'custom';
  }
  world.setTrace(trace);
  if (savedView?.world && world.setView) world.setView(savedView.world);
  if (activeRun === 'detail' && !savedView?.world?.smComponentId) {
    const sm = trace.components.find(component => component.kind === 'sm');
    if (sm) {state.selectedComponentId = sm.id; descendantIds = descendants(sm.id); world.setView({smComponentId: sm.id});}
  }
  observationLevel = world.getView?.().smComponentId ? 'sm' : 'gpu';
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
  $("time-input").disabled = !trace.events.length;
  $("seek-time").disabled = !trace.events.length;
  $("timeline-zoom").disabled = totalTime === startTime;
  $('traffic-play').hidden = !isTraffic();
  $('traffic-play').disabled = totalTime === startTime;
  $('traffic-counters').hidden = !isTraffic();
  const traffic = trace.metrics?.traffic;
  $('shared-read-savings').textContent = number(traffic?.sharedReadSavings ?? 0);
  $('shared-gain-detail').textContent = `整次运行：合并 ${number(traffic?.mergedMisses ?? 0)} · 命中 ${number(traffic?.l2Hits ?? 0)}`;
  renderRunBar();
}

function renderSummary() {
  const { meta, events, components, metrics } = state.trace;
  $("trace-title").textContent = meta.title || "未命名执行记录";
  $("trace-description").textContent = meta.description || "这份记录未提供描述。点击事件查看原始字段。";
  $('source-boundary').textContent = isSmModel()
    ? '组件规格引用 NVIDIA Hopper/CUDA 公开资料；Fetch/Decode 等显式阶段、资源队列与周期参数由本教学模型定义。演示指令不是真实 SASS；无数值执行，也未校准真实 H100 时序。'
    : isTraffic()
    ? '132 SM 对应 H100 SXM 公开规格；双分区与局部缓存参考 NVIDIA 白皮书和 Jin 等 MICRO 2024。SM 编号映射、聚合节点、带宽/延迟是教学定义，未拟合论文往返测量。普通读取不等于广播；TMA cluster multicast 尚未执行。'
    : '时间与依赖来自执行记录；未记录的硬件状态与传输路径不作推断。不同后端的运行分别保存。';
  const measured = meta.evidenceKind === "measurement";
  $("evidence-badge").textContent = measured
    ? `${meta.producer} · 测量记录（以来源说明为准）`
    : isSmModel() ? 'SM 流水线教学模型 · 非真实芯片时序' : isTraffic() ? 'GPU City 教学模型 · 非真实芯片时序' : `${meta.producer} ${meta.evidenceKind === "illustration" ? "示意模型" : "仿真"} · 非实机 profile`;
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

function selectComponent(id, {preserveScope = false} = {}) {
  if (!preserveScope) state.scope = null;
  state.selectedComponentId = id;
  syncSmTarget(id);
  descendantIds = descendants(id);
  state.page = 0;
  renderComponents();
  renderTimeline();
  renderActiveTasks();
  renderComponentInfo();
  world.update(state);
  observationLevel = world.getView?.().smComponentId ? 'sm' : 'gpu'; renderRunBar();
  dataflow.update(state);
}

function selectScope(scope) {
  state.scope = scope;
  state.page = 0;
  if (scope) {
    const event = state.trace?.events.find(event => eventInScope(event,scope));
    let component = event && componentById.get(event.componentId);
    while (component?.parentId && component.kind !== 'sm') component = componentById.get(component.parentId);
    if (component?.kind === 'sm') state.selectedComponentId = component.id;
  }
  descendantIds = descendants(state.selectedComponentId);
  renderComponents(); renderTimeline(); renderActiveTasks(); renderComponentInfo();
  world.update(state);
  renderRunBar();
  dataflow.update(state);
}

function renderComponentInfo() {
  const panel = $("selected-component-info");
  panel.replaceChildren();
  if (!state.trace) return;
  const component = componentById.get(state.selectedComponentId);
  const scopeLabel = state.scope ? ['smId','threadBlockId','warpId'].filter(key => state.scope[key] != null).map(key => `${({smId:'SM',threadBlockId:isTraffic() ? '模型 CTA ID' : 'CTA',warpId:'Warp'})[key]} ${state.scope[key]}`).join(' / ') : null;
  panel.append(el('h3', scopeLabel || component?.label || 'GPU 全局观察', 'detail-title'));
  const scopeEvents = state.trace.events.filter(event => eventInComponent(event) && eventInScope(event,state.scope));
  const active = scopeEvents.filter(activeAt).length;
  const completed = scopeEvents.filter(event => event.end <= state.time).length;
  panel.append(el('p', `${number(scopeEvents.length)} 个任务区间 · ${number(active)} 进行中 · ${number(completed)} 已完成`, 'muted'));
  if (/GTSim/i.test(state.trace.meta.producer)) panel.append(el('p', '当前后端：GTSim tile 操作图。CTA / warp 按任务归属查看；进行中区间数不等于硬件利用率。', 'muted'));
  else panel.append(el('p', `当前后端：${runInfo(state.trace).backend} · ${runInfo(state.trace).granularity}。${isTraffic() ? '运输、排队与计算均来自本次教学仿真。' : '按来源记录展示。'}`, 'muted'));
  if (state.scope) {
    const clear = el('button',isTraffic() ? '清除任务范围' : '清除 CTA / warp 范围'); clear.type='button';
    clear.addEventListener('click',()=>selectScope(null)); panel.append(clear);
  }
}

function renderTimeline() {
  const timeline = $("timeline");
  const scrollTop = timeline.scrollTop, scrollLeft = timeline.scrollLeft;
  const focusedEventId = timeline.contains(document.activeElement) ? document.activeElement.dataset.eventId : null;
  timeline.replaceChildren();
  cursorLine = null;
  timelineRange = timeWindow({start:startTime,end:totalTime}, state.timelineZoom, state.timelineCenter);
  visibleEvents = filteredEvents().filter(event => intersectsWindow(event,timelineRange)).sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  const pageCount = Math.ceil(visibleEvents.length / PAGE_SIZE);
  state.page = Math.min(state.page, Math.max(0, pageCount - 1));
  $("event-count").textContent = `${number(visibleEvents.length)} / ${number(state.trace.events.length)} 个事件`;
  $("page-label").textContent = `第 ${pageCount ? state.page + 1 : 0} / ${pageCount} 页`;
  $("previous-page").disabled = state.page === 0;
  $("next-page").disabled = state.page + 1 >= pageCount;
  const component = state.selectedComponentId ? componentName(state.selectedComponentId) : "全部组件";
  $("timeline-context").textContent = `${component} · ${timeText(timelineRange.start)} — ${timeText(timelineRange.end)} · 刻度为窗口起点的偏移 · 金色：完成依赖；绿色虚线：发射依赖；紫色：后继。`;
  if (!visibleEvents.length) {
    timeline.append(el("p", state.trace.events.length ? "没有匹配的事件。可清除搜索、类别或组件筛选。" : "这份记录没有事件，可导入包含执行事件的 Trace。", "empty"));
    return;
  }
  const pageEvents = visibleEvents.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);
  const left = 242, plotWidth = 690, width = 950, rowHeight = 27, top = 35;
  const height = top + pageEvents.length * rowHeight + 14;
  const chart = svg("svg", { viewBox: `0 0 ${width} ${height}`, width, height, role: "group", "aria-label": `事件时间线，单位 ${unit()}，第 ${state.page + 1} 页` });
  const x = (time) => left + ((time - timelineRange.start) / (timelineRange.end - timelineRange.start || 1)) * plotWidth;
  for (let tick = 0; tick <= 5; tick++) {
    const value = timelineRange.start + (timelineRange.end - timelineRange.start) * tick / 5;
    chart.append(svg("line", { x1: x(value), x2: x(value), y1: 26, y2: height, class: "grid-line" }));
    const label = svg("text", { x: x(value), y: 17, "text-anchor": tick === 5 ? "end" : "start", class: "tick" });
    label.textContent = `+${number(value - timelineRange.start)}`;
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
      x: Math.min(x(Math.max(event.start,timelineRange.start)), left + plotWidth - 3), y, width: Math.max(3, x(Math.min(event.end,timelineRange.end)) - x(Math.max(event.start,timelineRange.start))), height: 18, rx: 3,
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
  chart.addEventListener('click',(event)=>{
    if (event.target.closest('[data-event-id]') || event.target.classList.contains('row-label')) return;
    const rectangle = chart.getBoundingClientRect();
    const position = (event.clientX - rectangle.left) / rectangle.width * width;
    if (position < left || position > left + plotWidth) return;
    pause(); seek(timelineRange.start + (position - left) / plotWidth * (timelineRange.end - timelineRange.start));
  });
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
  const event = eventById.get(id);
  if (event && !intersectsWindow(event,timelineRange)) state.timelineCenter = (event.start+event.end)/2;
  const range = timeWindow({start:startTime,end:totalTime},state.timelineZoom,state.timelineCenter);
  const within = filteredEvents().filter(event=>intersectsWindow(event,range)).sort((a,b)=>a.start-b.start||a.end-b.end||a.id.localeCompare(b.id));
  const index = within.findIndex(event=>event.id===id);
  if(index >= 0) state.page=Math.floor(index/PAGE_SIZE);
  renderTimeline();
  renderActiveTasks();
  renderDetails();
  world.update(state);
  dataflow.update(state);
}

function renderDetails() {
  const panel = $("event-details");
  panel.replaceChildren();
  const event = eventById.get(state.selectedEventId);
  $("jump-to-event").disabled = !event;
  $("timeline-focus-selection").disabled = !event;
  if (!event) { panel.append(el("p", "选择时间线或当前任务中的事件。这里保留原始名称、时间与参数。", "empty")); return; }
  panel.append(el("h3", event.name, "detail-title"));
  const facts = el("dl", undefined, "detail-facts");
  for (const [label, value] of [["ID", event.id], ["组件", `${componentName(event.componentId)} (${event.componentId})`], ["类别", categoryName(event)], ["start", timeText(event.start)], ["end", timeText(event.end)], ["duration", timeText(event.end - event.start)]]) facts.append(el("dt", label), el("dd", value));
  for (const [key,label] of [['smId','SM'],['threadBlockId',isTraffic() || isSmModel() ? '模型 CTA ID' : 'CTA'],['round','任务轮次'],['warpId','Warp'],['partitionId','分区'],['instructionId','指令 ID'],['op','操作'],['pc','PC'],['opcode','Opcode'],['stage',isSmModel() ? '模型阶段' : '观测阶段'],['stallReason','等待原因'],['instructionText','指令']]) if(event.args?.[key] != null) facts.append(el('dt',label),el('dd',String(event.args[key])));
  if (isTraffic()) for (const [key,label] of [['issueReleaseCycle','串行化资源释放'],['serializationCycles','串行化周期'],['propagationCycles','传播周期']]) {
    if (event.args?.[key] != null) facts.append(el('dt',label),el('dd',timeText(event.args[key])));
  }
  if (event.args?.smPipelineTransfer) for (const [key,label] of [['sourceId','通路起点'],['targetId','通路终点'],['kind','通路类型'],['bytes','字节数']]) {
    const value = event.args.smPipelineTransfer[key];
    if (value != null) facts.append(el('dt',label),el('dd',componentById.has(value) ? componentName(value) : String(value)));
  }
  if (event.args?.flow) for (const [key, label] of [['packetId','数据包'],['requestId','请求'],['kind','运输类型'],['sourceId','本跳起点'],['targetId','本跳终点'],['originPartitionId','起点缓存域'],['destinationPartitionId','终点缓存域'],['bytes','字节数'],['dataKey','数据标识']]) {
    const value = event.args.flow[key];
    if (value != null) facts.append(el('dt',label),el('dd',key.endsWith('Id') && componentById.has(value) ? componentName(value) : String(value)));
  }
  panel.append(facts);
  for (const [label, ids] of [["完成依赖 · 前置事件完成后开始", event.dependencies], ["发射依赖 · 不要求前置事件完成", event.args?.issueDependencies ?? []], ["后继事件 · 含完成与发射边", successors.get(event.id) ?? []]]) {
    panel.append(el("h4", label, "dependency-title"));
    const list = el("div", undefined, "dependency-list");
    if (!ids.length) list.append(el("span", "未提供相关依赖。", "muted"));
    function relationNode(id) {
      if (!eventById.has(id)) {
        const omitted = omittedById.get(id);
        const knownStart = Number.isFinite(omitted?.start) ? `start ${timeText(omitted.start)}` : "start 未知";
        const status = omitted?.status === "started-incomplete" ? "已发射未完成" : "未提供完整区间";
        return el("span", `${id} · ${status} · ${knownStart} · end 未知；不生成时间线区间。`, "muted");
      }
      const button = el("button", `${eventName(id)} · ${id}`);
      button.type = "button";
      button.addEventListener("click", () => {
        state.selectedEventId = id;
        // Dependency navigation stays usable even when the current filters hide its target.
        state.selectedComponentId = null; descendantIds = null; state.query = ""; state.category = "";
        state.scope = null; state.timelineCenter = (eventById.get(id).start + eventById.get(id).end) / 2;
        $("event-search").value = ""; $("category-filter").value = "";
        const range = timeWindow({start:startTime,end:totalTime},state.timelineZoom,state.timelineCenter);
        const all = filteredEvents().filter(event=>intersectsWindow(event,range)).sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
        state.page = Math.max(0, Math.floor(all.findIndex((item) => item.id === id) / PAGE_SIZE));
        renderComponents(); selectEvent(id);
      });
      return button;
    }
    for (const id of ids.slice(0,8)) list.append(relationNode(id));
    if(ids.length > 8) {
      const more = el('details',undefined,'dependency-overflow');
      more.append(el('summary',`展开其余 ${number(ids.length-8)} 条关联`));
      const expanded = el('div',undefined,'dependency-list');
      more.append(expanded);
      let loaded = false;
      more.addEventListener('toggle',()=>{
        if(more.open && !loaded){loaded=true; for(const id of ids.slice(8))expanded.append(relationNode(id));}
      });
      list.append(more);
    }
    panel.append(list);
  }
  panel.append(el("h4", "原始 args", "dependency-title"), el("pre", JSON.stringify(event.args ?? {}, null, 2)));
}

function renderAtTime() {
  $("time-label").textContent = timeText(state.time);
  $("time-slider").value = String(state.time);
  $("time-slider").setAttribute("aria-valuetext", timeText(state.time));
  if (document.activeElement !== $("time-input")) $("time-input").value = String(state.time);
  if (cursorLine) {
    const x = 242 + (state.time - timelineRange.start) / (timelineRange.end - timelineRange.start || 1) * 690;
    cursorLine.setAttribute("x1", String(x)); cursorLine.setAttribute("x2", String(x));
    cursorLine.style.display = x < 242 || x > 932 ? 'none' : '';
  }
  // Keep the hierarchy DOM stable during playback to retain keyboard focus and scroll.
  const activeComponents = new Set();
  if (state.trace) for (const event of state.trace.events) if (activeAt(event)) {
    let id = event.componentId;
    while (id && !activeComponents.has(id)) { activeComponents.add(id); id = componentById.get(id)?.parentId; }
  }
  for (const button of document.querySelectorAll("[data-component-id]")) button.classList.toggle("running", activeComponents.has(button.dataset.componentId));
  renderActiveTasks();
  renderComponentInfo();
  renderTrafficCounters();
  world.update(state);
  dataflow.update(state);
}

function renderTrafficCounters() {
  if (!isTraffic()) return;
  let moving = 0, waiting = 0, completed = 0;
  for (const packet of trafficPackets) {
    if (packet.end <= state.time) completed++;
    else if (packet.start <= state.time) {
      if (packet.transfers.some(event => event.start <= state.time && state.time < event.end)) moving++;
      else waiting++;
    }
  }
  $('packets-moving').textContent = number(moving);
  $('packets-waiting').textContent = number(waiting);
  $('packets-completed').textContent = number(completed);
}

function seek(time) {
  state.time = Math.max(startTime, Math.min(totalTime, time));
  if (state.time < timelineRange.start || state.time > timelineRange.end) {
    state.timelineCenter = state.time; renderTimeline();
  }
  renderAtTime();
}

function pause() {
  state.playing = false;
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null; lastFrame = null;
  $("play").textContent = "播放";
  $("play").setAttribute("aria-pressed", "false");
  $('traffic-play').textContent = '开始数据流';
  $('traffic-play').setAttribute('aria-pressed', 'false');
}

function togglePlay() {
  if (!state.trace || totalTime === startTime) return;
  if (state.playing) { pause(); return; }
  if (state.time >= totalTime) seek(startTime);
  state.playing = true;
  $("play").textContent = "暂停";
  $("play").setAttribute("aria-pressed", "true");
  $('traffic-play').textContent = '暂停数据流';
  $('traffic-play').setAttribute('aria-pressed', 'true');
  let lastRender = 0;
  function tick(now) {
    if (!state.playing) return;
    const inspectionDuration = playbackDuration();
    if (lastFrame !== null) state.time = Math.min(totalTime, state.time + (now - lastFrame) / inspectionDuration * (totalTime - startTime) * state.rate);
    lastFrame = now;
    world.animate?.(state.time);
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
      const decoded = decodeWorkspace(input, normalizeImported);
      runs = decoded.runs;
      const next = runs[decoded.activeRun];
      setTrace(next.trace, next.view, decoded.activeRun, false);
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

async function importDetail(file) {
  if (!file) return;
  const sequence = ++loadSequence;
  announce(`正在读取详细指令运行 ${file.name}…`);
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error('最多读取 32 MiB；请先截取指令窗口。');
    const contents = await file.text();
    const trace = /^\s*[\[{]/.test(contents) ? normalizeRun(JSON.parse(contents)) : normalizeFlashGpuLog(contents);
    if (runKind(trace) !== 'detail') throw new Error('需要指令 observer 或 SM 流水线教学运行；宏观 Trace 请使用“导入 Trace”。');
    if (sequence !== loadSequence) return;
    setTrace(trace, null, 'detail');
    announce(`已载入 ${describeRun(trace).backend} 详细运行，共 ${number(trace.events.length)} 个${describeRun(trace).granularity}；宏观运行已保留。`);
  } catch (error) {
    if (sequence === loadSequence) announce(`详细运行未载入：${error.message}。当前运行保持可用。`, true);
  }
}

async function loadExample(sample = $("sample-select").value) {
  if (sample === 'traffic') return runTraffic();
  if (sample === 'sm') return runSmModel();
  const sequence = ++loadSequence;
  announce("正在加载 GTSim GEMM 仿真示例…");
  try {
    const filename = sample === 'slow-l2' ? 'gtsim-gemm-slow-l2' : 'gtsim-gemm';
    const response = await fetch(new URL(`../examples/${filename}.json`, import.meta.url));
    if (!response.ok) throw new Error(`示例请求失败（HTTP ${response.status}）`);
    const input = await response.json();
    if (sequence !== loadSequence) return;
    setTrace(input);
    announce(`已加载 GTSim 仿真示例，共 ${number(state.trace.events.length)} 个事件。可单步、选择组件或检查依赖。`);
  } catch (error) {
    if (sequence === loadSequence) announce(`默认示例暂不可用：${error.message}。请通过 HTTP 启动仓库，或导入本地 JSON 执行记录。`, true);
  }
}

async function runTraffic() {
  if (!$('traffic-config').reportValidity()) return;
  const sequence = ++loadSequence;
  const button = $('simulate-traffic');
  button.disabled = true;
  announce('正在运行 H100 SXM 132 SM 教学数据流仿真…');
  try {
    // Give the running status a frame before the synchronous, deterministic model.
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (sequence !== loadSequence) return;
    const trace = simulateTraffic(trafficConfig());
    if (sequence !== loadSequence) return;
    setTrace(trace, null, 'macro');
    const firstTransfer = trace.events.find(event => event.args?.stage === 'transfer' && event.args.flow?.kind === 'read-response')
      ?? trace.events.find(event => event.args?.stage === 'transfer');
    if (firstTransfer) seek(firstTransfer.start + (firstTransfer.end - firstTransfer.start) / 2);
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reducedMotion) togglePlay();
    announce(`已生成 132 SM 的独立数据流运行：${number(trace.metrics?.traffic?.packets ?? trafficPackets.length)} 个端到端包。${reducedMotion ? '已暂停，可点“开始数据流”或单步查看。' : '正在回放，随时可暂停；右侧可检查运输与排队事件。'}`);
  } catch (error) {
    if (sequence === loadSequence) announce(`数据流仿真未完成：${error.message}。当前运行保持可用。`, true);
  } finally {
    button.disabled = false;
  }
}

async function runSmModel() {
  if (!$('sm-config').reportValidity()) return;
  const sequence = ++loadSequence, button = $('simulate-sm');
  const config = smConfig();
  button.disabled = true;
  announce(`正在运行 SM ${config.smId} 的独立流水线教学仿真…`);
  try {
    await new Promise(resolve => requestAnimationFrame(resolve));
    if (sequence !== loadSequence) return;
    const trace = simulateSm(config);
    if (sequence !== loadSequence) return;
    setTrace(trace, null, 'detail');
    // Start with execution and queues visible; seeking keeps the original clock.
    const firstExecution = trace.events.find(event => event.args?.stage === 'execute');
    if (firstExecution) seek(firstExecution.start);
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) togglePlay();
    announce(`SM ${config.smId} 流水线运行已生成：${number(trace.metrics.sm.completedInstructions)} 条教学指令，${number(trace.metrics.sm.makespan)} 模型周期。点选组件查看形式化规格，暂停或单步检查事件与依赖。`);
  } catch (error) {
    if (sequence === loadSequence) announce(`SM 仿真未完成：${error.message}。当前运行保持可用。`, true);
  } finally {
    button.disabled = false;
  }
}

$("play").addEventListener("click", togglePlay);
$('traffic-play').addEventListener('click', togglePlay);
$('traffic-config').addEventListener('submit', event => {event.preventDefault(); runTraffic();});
$('sm-config').addEventListener('submit', event => {event.preventDefault(); runSmModel();});
for (const id of ['sm-target', ...smControls.map(([id]) => id)]) $(id).addEventListener('change', () => {
  $('sm-config-note').textContent = '参数已修改。点击“运行 SM 流水线”生成新运行；当前事件的原始时间保持不变。';
});
showSmConfig(DEFAULT_SM_CONFIG);
for (const id of ['noc-topology','noc-bandwidth','hbm-bandwidth','coalesce-shared','noc-cross-bandwidth','noc-cross-latency']) $(id).addEventListener('change', () => {
  const partitioned = $('noc-topology').value === 'partitioned-crossbar';
  $('noc-cross-bandwidth').disabled = !partitioned;
  $('noc-cross-latency').disabled = !partitioned;
  $('traffic-config-note').textContent = '参数已修改，点击“重新仿真”生成新运行。当前回放仍使用原参数。';
});
$("step").addEventListener("click", () => step(1));
$("step-back").addEventListener("click", () => step(-1));
$("time-slider").addEventListener("input", (event) => { pause(); seek(Number(event.target.value)); });
$("playback-rate").addEventListener("change", (event) => { state.rate = Number(event.target.value); renderRunBar(); });
$("event-search").addEventListener("input", (event) => { state.query = event.target.value; state.page = 0; if (state.trace) { renderTimeline(); renderActiveTasks(); } });
$("category-filter").addEventListener("change", (event) => { state.category = event.target.value; state.page = 0; if (state.trace) { renderTimeline(); renderActiveTasks(); } });
$("clear-component").addEventListener("click", () => selectComponent(null));
$("previous-page").addEventListener("click", () => { state.page--; renderTimeline(); });
$("next-page").addEventListener("click", () => { state.page++; renderTimeline(); });
$("jump-to-event").addEventListener("click", () => { pause(); const event = eventById.get(state.selectedEventId); if (event) seek(event.start); });
$("load-example").addEventListener("click", ()=>loadExample());
$("sample-select").addEventListener("change",()=>loadExample());
$("timeline-zoom").addEventListener('input',(event)=>{
  state.timelineZoom = Number(event.target.value); state.timelineCenter = state.time; state.page = 0;
  $("timeline-zoom-label").textContent = `${number(state.timelineZoom)}×`; renderTimeline();
});
$("timeline-focus-selection").addEventListener('click',()=>{
  const event = eventById.get(state.selectedEventId);
  if(!event) { announce('请先选择一个任务，再聚焦它的时间区间。'); return; }
  state.timelineCenter = (event.start + event.end) / 2;
  state.timelineZoom = Math.max(1,Math.min(16,(totalTime-startTime)/Math.max((event.end-event.start)*2,(totalTime-startTime)/16 || 1)));
  $("timeline-zoom").value=String(state.timelineZoom); $("timeline-zoom-label").textContent=`${number(state.timelineZoom)}×`; state.page=0; renderTimeline();
});
function seekInput() {
  const value = $("time-input").valueAsNumber;
  if(!Number.isFinite(value) || value < startTime || value > totalTime) { announce(`请输入 ${number(startTime)} 至 ${timeText(totalTime)} 范围内的时间。`,true); return; }
  pause(); seek(value);
}
$("seek-time").addEventListener('click',seekInput);
$("time-input").addEventListener('keydown',event=>{if(event.key==='Enter')seekInput();});
$("import-trace").addEventListener("click", () => $("trace-file").click());
$("import-workspace").addEventListener("click", () => $("workspace-file").click());
$("import-detail").addEventListener('click', () => $('detail-file').click());
$("detail-file").addEventListener('change', event => { importDetail(event.target.files[0]); event.target.value = ''; });
$("macro-view").addEventListener('click', () => {
  ++loadSequence;
  if (activeRun !== 'macro') { activateRun('macro'); return; }
  selectComponent(null); world.setView({smComponentId: null, scope: null}); observationLevel = 'gpu'; renderRunBar();
});
$("micro-view").addEventListener('click', () => {
  ++loadSequence;
  if (runs.detail && activeRun !== 'detail') { activateRun('detail'); return; }
  enterSm();
  if (!runs.detail) announce(`已进入 SM。可点选组件查阅规格，点击“运行 SM 流水线”生成独立教学运行，或载入详细后端的指令记录。`);
});
$("trace-file").addEventListener("change", (event) => { importFile(event.target.files[0], false); event.target.value = ""; });
$("workspace-file").addEventListener("change", (event) => { importFile(event.target.files[0], true); event.target.value = ""; });
$("export-trace").addEventListener("click", () => { if (state.trace && download(state.trace, "trace")) announce("Trace 已导出，原始时间单位、指标与事件保留。未上传任何文件。"); });
$("save-workspace").addEventListener("click", () => {
  if (!state.trace) return;
  rememberRun();
  if (download({kind: 'gpu-sim-workspace', version: 2, activeRun, runs}, 'workspace')) announce('工作区已保存，包含两份运行及各自的时钟、播放速度、选择与镜头。');
});
document.addEventListener("keydown", (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey || event.target.closest("input, select, textarea, button, a, summary, [role='button'], [contenteditable='true']")) return;
  if (event.code === "Space") { event.preventDefault(); togglePlay(); }
  else if (event.code === "ArrowRight") { event.preventDefault(); step(1); }
  else if (event.code === "ArrowLeft") { event.preventDefault(); step(-1); }
  else if (event.code === "Home" && state.trace) { event.preventDefault(); pause(); seek(startTime); }
  else if (event.code === "End" && state.trace) { event.preventDefault(); pause(); seek(totalTime); }
});
document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); });
showTrafficConfig(DEFAULT_TRAFFIC_CONFIG);
loadExample();
