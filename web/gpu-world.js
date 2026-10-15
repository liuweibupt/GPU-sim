// Interactive, trace-backed structure view. Geometry and artwork are illustrative;
// only native component identities and event intervals drive counters/highlights.
import {createGpuBoxScene, GPU_BOX_SCENE_CSS} from "./gpu-box-scene.js?v=sm-residency-3";
import {createSmPipelineScene} from "./sm-pipeline-scene.js?v=sm-residency-3";
import {observationSnapshot, laneWindow} from "../lib/instruction-view.js";
const SVG_NS = "http://www.w3.org/2000/svg";

function countThrough(sorted, time) {
  let low = 0, high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function indexComponents(trace) {
  const components = trace?.components ?? [];
  const byId = new Map(components.map(component => [component.id, component]));
  const children = new Map();
  const intervals = new Map(components.map(component => [component.id, {starts: [], ends: [], events: [], pointStarts: [], issueStarts: [], stallStarts: []}]));
  for (const component of components) {
    const parent = component.parentId ?? null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(component);
  }
  for (const event of trace?.events ?? []) {
    const visited = new Set();
    let id = event.componentId;
    while (byId.has(id) && !visited.has(id)) {
      visited.add(id);
      const interval = intervals.get(id);
      interval.starts.push(event.start); interval.ends.push(event.end); interval.events.push(event);
      if (event.start === event.end) {
        interval.pointStarts.push(event.start);
        if (event.args?.stage === 'ISSUE') interval.issueStarts.push(event.start);
        if (event.args?.stage?.startsWith('STALL_')) interval.stallStarts.push(event.start);
      }
      id = byId.get(id).parentId;
    }
  }
  for (const interval of intervals.values()) {
    for (const key of ['starts', 'ends', 'pointStarts', 'issueStarts', 'stallStarts']) interval[key].sort((a, b) => a - b);
  }
  const sms = components.filter(component => component.kind === "sm");
  const gpus = components.filter(component => component.kind === "gpu");
  const configuredSms = trace?.meta?.config?.numSms;
  // A count does not establish an SM floorplan or activity for omitted SMs.
  const physicalSms = Number.isInteger(configuredSms) && configuredSms >= sms.length ? configuredSms : null;
  return {components, byId, children, intervals, sms, gpus, physicalSms,
    mode: sms.length || gpus.length ? "architecture" : "tracks"};
}

function snapshot(index, trace, time) {
  const byId = new Map();
  for (const component of index.components) {
    const interval = index.intervals.get(component.id);
    const completed = countThrough(interval.ends, time);
    const observed = countThrough(interval.pointStarts, time);
    byId.set(component.id, {...component, total: interval.events.length, completed,
      active: countThrough(interval.starts, time) - completed, observed,
      issue: countThrough(interval.issueStarts, time), stall: countThrough(interval.stallStarts, time), pointTotal: interval.pointStarts.length,
      endedSpans: completed - observed});
  }
  const events = trace?.events ?? [];
  return {byId, components: [...byId.values()], mode: index.mode,
    observedSms: index.sms.length, physicalSms: index.physicalSms,
    unobservedSms: index.physicalSms === null ? null : index.physicalSms - index.sms.length,
    activeTotal: events.filter(event => event.start <= time && time < event.end).length,
    completedTotal: events.filter(event => event.end <= time).length, totalEvents: events.length};
}

/** Counts use half-open [start, end) intervals, aggregate descendants once, and
 * do not estimate occupancy, cache traffic, utilization, or missing components. */
export function summarizeComponents(trace, time = 0) {
  return snapshot(indexComponents(trace), trace, Number.isFinite(time) ? time : 0);
}

function groupCtas(index, smComponentId, time) {
  const groups = new Map();
  for (const event of index.intervals.get(smComponentId)?.events ?? []) {
    const threadBlockId = event.args?.threadBlockId;
    if (threadBlockId === undefined || threadBlockId === null) continue;
    if (!groups.has(threadBlockId)) groups.set(threadBlockId, {threadBlockId,
      smId: event.args?.smId, smComponentId, events: [], active: 0, completed: 0, warpIds: new Set()});
    const group = groups.get(threadBlockId);
    group.events.push(event);
    if (event.start <= time && time < event.end) group.active++;
    if (event.end <= time) group.completed++;
    if (event.args?.warpId !== undefined && event.args?.warpId !== null) group.warpIds.add(event.args.warpId);
  }
  return [...groups.values()].map(group => ({...group, warpIds: [...group.warpIds], total: group.events.length}));
}

/** CTA identity comes only from source args; tile extents do not create CTAs. */
export function summarizeWorkloads(trace, smComponentId, time = 0) {
  return groupCtas(indexComponents(trace), smComponentId, time);
}

/** Default camera bounds preserve label readability. A deliberate "whole map"
 * command may fit more tightly; detail views otherwise scroll vertically. */
export function worldCameraScale({width, height, naturalWidth, naturalHeight, detail = false, wholeMap = false, autoFit = false, zoom = 1}) {
  const widthScale = Math.min(1, Math.max(1, width) / Math.max(1, naturalWidth));
  const heightScale = Math.min(1, Math.max(1, height) / Math.max(1, naturalHeight));
  const fitted = wholeMap || autoFit ? Math.min(widthScale, heightScale)
    : detail ? widthScale : Math.min(widthScale, heightScale);
  return (wholeMap || autoFit ? fitted : Math.max(.85, fitted)) * zoom;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, className, action, title) {
  const node = element("button", className, text);
  node.type = "button";
  if (title) node.title = title;
  node.addEventListener("click", action);
  return node;
}

function vector(tag, attributes = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function pipelineType(component) {
  const name = `${component?.id ?? ""} ${component?.label ?? ""}`.toLowerCase();
  if (name.includes("tensor") || name.includes("mma")) return "tensor";
  if (/(?:\bld\b|load|\bst\b|store|memory)/.test(name)) return "memory";
  return "compute";
}

const COLORS = {
  compute: {top: "#205348", left: "#17372f", right: "#102c28", line: "#55bfa3", light: "#a5f0d7"},
  memory: {top: "#204957", left: "#163641", right: "#102a35", line: "#67b8d0", light: "#b2e6f4"},
  tensor: {top: "#45345e", left: "#302743", right: "#241e35", line: "#a68bd1", light: "#ddc9fb"},
  structure: {top: "#182b37", left: "#10212d", right: "#0c1a25", line: "#415e71", light: "#849ead"},
};

const CSS = `
.gpu-world{--gpu-muted:#8ba7b8;--gpu-text:#dbeaf2;--gpu-line:#2c4354;height:100%;min-height:0;min-width:0;display:flex;flex-direction:column;color:var(--gpu-text);font:12px/1.5 system-ui,sans-serif;isolation:isolate}
.gpu-world *{box-sizing:border-box}.gpu-world button{font:inherit;color:inherit;cursor:pointer}.gpu-world button:disabled{opacity:.35;cursor:default}.gpu-world button:focus-visible{outline:2px solid #99e4d3;outline-offset:3px}.gpu-world button:hover:not(:disabled){border-color:#719aab;background:#203746}.gpu-toolbar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;flex-shrink:0;padding:0 0 10px}.gpu-breadcrumb,.gpu-controls{display:flex;align-items:center;gap:6px}.gpu-breadcrumb{min-width:0;font-size:12px}.gpu-crumb-root{border:0;background:transparent;color:#8dabbb!important;padding:4px}.gpu-crumb-current{font-weight:600;color:#d5eee7;white-space:nowrap}.gpu-back,.gpu-tool{border:1px solid #30495b;background:#152835;border-radius:6px;padding:5px 8px;white-space:nowrap}.gpu-back{width:28px}.gpu-switch{font-size:10px!important}.gpu-switch[aria-pressed=true]{border-color:#438c7f;background:#163a35;color:#b3e9dc}.gpu-zoom-label{font:10px ui-monospace,monospace;color:#8cabbe;min-width:35px;text-align:center}.gpu-tool-small{width:25px;padding:4px}.gpu-stage{flex:1;position:relative;border:1px solid #2b4354;border-radius:10px;background:radial-gradient(ellipse at 50% 47%,#142d3a 0%,#0d1c29 68%,#0a1722 100%);overflow:auto;min-height:140px;scrollbar-color:#3b596a #10212e}.gpu-camera{position:relative;margin:0 auto}.gpu-scene{position:absolute;left:0;top:0;transform-origin:top left;padding:14px 16px 18px;min-width:0}.gpu-layout-label{display:flex;justify-content:space-between;align-items:center;gap:12px;font:10px ui-monospace,monospace;letter-spacing:.1em;color:#789bac;margin-bottom:3px}.gpu-layout-label strong{font-weight:500;color:#b4d3df}.gpu-layout-label span:last-child{letter-spacing:0;color:#718f9e}.gpu-city-svg{width:100%;height:auto;display:block;overflow:visible}.gpu-city-svg text{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;pointer-events:none}.gpu-city-grid{stroke:#294756;stroke-width:.75;opacity:.5}.gpu-city-structural{stroke-dasharray:4 4}.gpu-city-item{cursor:pointer;outline:0}.gpu-city-item .gpu-building-top,.gpu-city-item .gpu-building-edge{transition:stroke .15s,fill .15s}.gpu-city-item:hover .gpu-building-top,.gpu-city-item:focus-visible .gpu-building-top{stroke:#b7f1e1;stroke-width:2}.gpu-city-item.gpu-selected .gpu-building-top{stroke:#d2f8ed;stroke-width:2.5}.gpu-city-item.gpu-running .gpu-building-top{fill:#286958;stroke:#73d7b6;stroke-width:1.5}.gpu-city-item.gpu-type-memory.gpu-running .gpu-building-top{fill:#285f73;stroke:#8bd3e8}.gpu-city-item.gpu-type-tensor.gpu-running .gpu-building-top{fill:#5a4676;stroke:#c7a8ec}.gpu-city-selection{fill:none;stroke:#9ae5d2;stroke-width:2;stroke-dasharray:5 4;pointer-events:none;opacity:0}.gpu-selected .gpu-city-selection{opacity:1}.gpu-city-token{cursor:pointer;outline:0}.gpu-city-token rect{fill:#153c3a;stroke:#63c6b3;stroke-width:.8}.gpu-city-token text{fill:#bdeedf;font-size:10px}.gpu-city-token[data-type=memory] rect{fill:#173847;stroke:#70bfd7}.gpu-city-token[data-type=tensor] rect{fill:#392e4b;stroke:#b39ad4}.gpu-city-token.gpu-event-selected rect,.gpu-city-token:focus-visible rect{stroke:#e5fff7;stroke-width:2}.gpu-city-token.gpu-event-selected rect{fill:#345e58}.gpu-city-caption{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 1px 0;border-top:1px solid #253d4d;font-size:11px;color:#7e9dab}.gpu-city-caption strong{color:#b7cfd9;font-weight:500}.gpu-caption-native{display:flex;align-items:center;gap:6px}.gpu-caption-native:before{content:"";height:6px;width:6px;background:#68c4a8;display:block;border-radius:50%;box-shadow:0 0 8px #6cd0b344}.gpu-legend{display:flex;gap:14px;flex-wrap:wrap;margin:9px 0 0;font-size:10px;color:#91aaba;flex-shrink:0}.gpu-legend span{display:flex;gap:5px;align-items:center}.gpu-legend i{width:8px;height:8px;background:#286355;border:1px solid #68c4a8;display:block;border-radius:2px}.gpu-legend span:nth-child(2) i{background:#214d5f;border-color:#75c8dc}.gpu-legend span:nth-child(3) i{background:none;border:1px dashed #607c90}.gpu-footnote{font-size:10px;color:#7896a8;margin:6px 1px 0;line-height:1.5;flex-shrink:0;max-height:32px;overflow:auto}.gpu-scope-stats{display:flex;align-items:center;gap:22px;margin:9px 0 4px}.gpu-stat{font-size:10px;color:#8da7b6}.gpu-stat b{font:500 20px ui-monospace,monospace;display:inline-block;color:#a7e5d3;margin-right:6px}.gpu-stat:nth-child(2) b{color:#9ecadf}.gpu-stat:nth-child(3) b{color:#b7a5d8}.gpu-sm-execution{border-top:1px solid #2a4455;padding-top:14px;margin-top:0}.gpu-section-label{display:flex;justify-content:space-between;align-items:center;gap:12px;color:#bbd9e3;font:11px ui-monospace,monospace;letter-spacing:.04em;margin-bottom:10px}.gpu-section-label small{font:10px system-ui,sans-serif;color:#809daf;letter-spacing:0}.gpu-cta-scope{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 10px}.gpu-filter-label{color:#7c9bac;font:10px ui-monospace,monospace;margin-right:2px}.gpu-cta-scope .gpu-tool{font-size:10px;padding:4px 7px}.gpu-cta-scope .gpu-tool[aria-pressed=true]{border-color:#5ba994;background:#183d37;color:#baeddd}.gpu-cta-trace{width:100%;height:auto;display:block;border:1px solid #2a4355;border-radius:6px;background:#0f2231}.gpu-cta-trace text{font:10px ui-monospace,monospace;fill:#8fadbF;pointer-events:none}.gpu-cta-trace .gpu-lane-label{fill:#bfd5df}.gpu-cta-trace .gpu-warp-event{cursor:pointer;stroke:#102331;stroke-width:1;outline:0;opacity:.68}.gpu-cta-trace .gpu-warp-event.gpu-event-active{opacity:1}.gpu-cta-trace .gpu-warp-event[aria-pressed=true],.gpu-cta-trace .gpu-warp-event:focus-visible{stroke:#e0fff5;stroke-width:2;opacity:1}.gpu-cta-cursor{stroke:#c6efdf;stroke-width:1.2;pointer-events:none}.gpu-instruction-empty{display:flex;gap:12px;align-items:flex-start;padding:16px 17px;border:1px dashed #40596c;background:#122735;border-radius:7px;margin:13px 0 0}.gpu-instruction-mark{width:30px;height:30px;flex-shrink:0;display:grid;place-items:center;border:1px solid #4b6478;border-radius:6px;color:#8eacbc;font:14px ui-monospace,monospace}.gpu-instruction-empty strong{display:block;color:#bbd0dc;font-size:12px;font-weight:500}.gpu-instruction-empty p{font-size:11px;line-height:1.65;color:#809dae;margin:4px 0 0}.gpu-instruction-list{margin:10px 0 0;border:1px solid #30475b;border-radius:6px;overflow:hidden}.gpu-instruction-row{display:grid;grid-template-columns:75px 95px minmax(0,1fr) 100px;gap:10px;width:100%;border:0;border-bottom:1px solid #233b4d;background:#102331;text-align:left;padding:7px 10px;font:10px ui-monospace,monospace!important;color:#a5c1d1!important}.gpu-instruction-row:last-child{border-bottom:0}.gpu-instruction-row[aria-pressed=true]{background:#1c423b;color:#daf5e9!important}.gpu-instruction-row .gpu-opcode{color:#cbb3e6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gpu-instruction-row small{font:9px ui-monospace,monospace;color:#779aaa;text-align:right}.gpu-extra-note{font-size:10px;color:#7e9bab;line-height:1.6;margin:8px 0 0}.gpu-task-dock{border-top:1px solid #2b4354;margin-top:9px;padding-top:8px;max-height:116px;overflow:auto;flex-shrink:0}.gpu-task-heading{display:flex;justify-content:space-between;gap:10px;font-size:11px;color:#a4bfce;margin-bottom:6px}.gpu-task-heading small{font:9px ui-monospace,monospace;color:#7494a6}.gpu-task-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.gpu-task{position:relative;overflow:hidden;min-width:0;border:1px solid #345364;border-radius:5px;background:#132e3b;padding:7px 8px;text-align:left}.gpu-task b,.gpu-task small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gpu-task b{font:10px ui-monospace,monospace;color:#c4e5df}.gpu-task small{font-size:9px;color:#7eacba;margin-top:2px}.gpu-task-selected{border-color:#b7eede}.gpu-task-progress{position:absolute;height:2px;background:#74d3b9;bottom:0;left:0}.gpu-task-empty,.gpu-empty{color:#89a6b8;font-size:12px;padding:14px}.gpu-empty{text-align:center;padding:80px 20px}.gpu-track-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:15px 0}.gpu-track{border:1px solid #345367;border-radius:7px;background:#142c3b;text-align:left;padding:14px}.gpu-track strong{color:#c1d7e3;font:12px ui-monospace,monospace}.gpu-track small{display:block;color:#7e9fb2;font:10px ui-monospace,monospace;margin-top:4px}.gpu-track.gpu-running{border-color:#6abfa7}.gpu-track.gpu-selected{outline:2px solid #9ce5d3;outline-offset:1px}.gpu-world.gpu-hide-structure .gpu-city-structure{display:none}.gpu-world:fullscreen{padding:24px;background:#091723;width:100vw;height:100vh;overflow:hidden}.gpu-world:fullscreen .gpu-stage{min-height:300px}
@media(max-width:760px){.gpu-toolbar{gap:6px}.gpu-controls{gap:4px;flex-wrap:wrap}.gpu-scene{padding:11px}.gpu-layout-label{font-size:9px;letter-spacing:.04em}.gpu-layout-label span:last-child{display:none}.gpu-crumb-current{max-width:150px;overflow:hidden;text-overflow:ellipsis}.gpu-task-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.gpu-legend{font-size:9px;gap:9px}.gpu-instruction-row{grid-template-columns:65px 85px minmax(0,1fr) 85px}}
@media(prefers-reduced-motion:reduce){.gpu-world *{transition:none!important}}
`;

let nextWorldId = 0;

/** Two observation levels share native identities, but never manufacture a detailed
 * simulator state from tile events. Callbacks report source ids, not scene objects. */
export function createGpuWorld(container, {onSelectComponent = () => {}, onSelectEvent = () => {}, onSelectScope = () => {}, onLevelChange = () => {}, onExitSm = null} = {}) {
  const worldId = `gpu-city-${++nextWorldId}`;
  const root = element("div", "gpu-world");
  const style = element("style"); style.textContent = CSS + GPU_BOX_SCENE_CSS;
  const toolbar = element("div", "gpu-toolbar");
  const breadcrumb = element("nav", "gpu-breadcrumb"); breadcrumb.setAttribute("aria-label", "GPU 与 SM 两级视图");
  const controls = element("div", "gpu-controls");
  const stage = element("div", "gpu-stage"); stage.tabIndex = 0;
  stage.setAttribute("aria-label", "交互 GPU 城市。点击 SM 进入内部，使用返回按钮回到 GPU。画布可缩放与滚动。");
  const camera = element("div", "gpu-camera"), scene = element("div", "gpu-scene");
  const footnote = element("p", "gpu-footnote");
  camera.append(scene); stage.append(camera); toolbar.append(breadcrumb, controls);
  root.append(style, toolbar, stage, footnote); container.replaceChildren(root);

  let trace = null, index = indexComponents(null), stats = null;
  let view = {time: 0, selectedComponentId: null, selectedEventId: null, scope: null};
  let drillSmId = null, zoom = 1, wholeMap = false;
  let presentation = "boxes", boxScene = null, smPipelineScene = null;
  const smPipelineViews = new Map();
  let cursor = null, lastLevel = "", lastTokenSignature = "", instructionRows = null, instructionRowEvents = [], lastInstructionSignature = "";
  let laneHost = null, laneSource = [], laneInstruction = false, lastLaneSignature = "";
  const statNodes = new Map(), tokenSites = [], eventNodes = new Map();
  const zoomLevels = [.75, 1, 1.25, 1.5, 2];
  const zoomLabel = element("span", "gpu-zoom-label", "100%");
  const zoomOut = button("−", "gpu-tool gpu-tool-small", () => setZoom(zoomLevels[Math.max(0, zoomLevels.indexOf(zoom) - 1)]), "缩小画布");
  const zoomIn = button("+", "gpu-tool gpu-tool-small", () => setZoom(zoomLevels[Math.min(zoomLevels.length - 1, zoomLevels.indexOf(zoom) + 1)]), "放大画布");
  const fit = button("全图", "gpu-tool gpu-switch", () => {wholeMap = true; setZoom(1); scrollHome();}, "将整个场景缩至可见范围");
  const fullscreen = button("展开", "gpu-tool gpu-switch", async () => {
    try {
      if (document.fullscreenElement === root) await document.exitFullscreen(); else await root.requestFullscreen();
    } catch (error) {fullscreen.title = `浏览器未允许全屏：${error.message}`;}
  }, "全屏展开画布");
  fullscreen.disabled = typeof root.requestFullscreen !== "function";
  function fullscreenChanged() {fullscreen.textContent = document.fullscreenElement === root ? "收起" : "展开"; fitScene();}
  document.addEventListener("fullscreenchange", fullscreenChanged);
  controls.append(zoomOut, zoomLabel, zoomIn, fit, fullscreen);

  function scrollHome() {stage.scrollTo({top: 0, left: 0});}
  function setZoom(value) {
    zoom = value; zoomLabel.textContent = `${Math.round(value * 100)}%`;
    zoomOut.disabled = value === zoomLevels[0]; zoomIn.disabled = value === zoomLevels.at(-1); fitScene();
  }
  function fitScene() {
    if (!stage.clientWidth || !stage.clientHeight) return;
    const fitSm = Boolean(drillSmId && (trace?.meta.capabilities?.includes('instruction_pipeline_stages') || trace?.meta.capabilities?.includes('sm_pipeline')));
    const fitSmToViewport = fitSm && stage.clientWidth > 700;
    const panel = root.closest('.world-panel'), inspector = panel?.parentElement?.querySelector('.inspector');
    if (panel && !document.fullscreenElement && fitSmToViewport) {
      const available = Math.max(280, window.innerHeight - Math.max(0, panel.getBoundingClientRect().top) - 12);
      const height = `${Math.floor(available)}px`;
      if (panel.style.height !== height) panel.style.height = height;
      if (inspector && inspector.style.height !== height) inspector.style.height = height;
    } else if (panel) {panel.style.removeProperty('height'); inspector?.style.removeProperty('height');}
    const naturalWidth = Math.max(drillSmId ? 260 : 650, stage.clientWidth - 2);
    scene.style.width = `${naturalWidth}px`;
    const overviewBoxes = !drillSmId && index.mode === "architecture" && (presentation === "boxes" || index.physicalSms > 12 || index.sms.length > 12);
    const overviewGraphic = overviewBoxes ? scene.querySelector(".gpu-box-full .gpu-box-svg") : null;
    if (overviewGraphic) overviewGraphic.style.height = `${Math.max(230, stage.clientHeight - 34)}px`;
    let naturalHeight = Math.max(1, scene.offsetHeight);
    const fitScale = height => overviewBoxes && stage.clientWidth > 600 && !wholeMap
      ? Math.min(1, (stage.clientWidth - 2) / naturalWidth) * zoom
      : Math.max(fitSmToViewport && !wholeMap ? .85 * zoom : 0,
        worldCameraScale({width: stage.clientWidth - 2, height: stage.clientHeight - 2, naturalWidth, naturalHeight: height, detail: Boolean(drillSmId) || index.mode === "tracks", wholeMap, autoFit: fitSmToViewport && !scene.querySelector('.gpu-sm-execution[open]'), zoom}));
    let scale = fitScale(naturalHeight);
    // The chip can fit a large SM count while its ordinary HTML evidence and
    // navigation text retain an actual 11 px reading size after camera scaling.
    for (let attempt = 0; attempt < 4; attempt++) {
      scene.style.setProperty("--gpu-readable-scale", String(1 / Math.max(.05, scale)));
      naturalHeight = Math.max(1, scene.offsetHeight); scale = fitScale(naturalHeight);
    }
    scene.style.transform = `scale(${scale})`;
    camera.style.width = `${naturalWidth * scale}px`; camera.style.height = `${naturalHeight * scale}px`;
  }
  const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(fitScene) : null;
  resizeObserver?.observe(stage);
  for (const header of document.querySelectorAll('.app-header, .trace-summary, .scale-bar, #status')) resizeObserver?.observe(header);
  window.addEventListener('resize', fitScene);

  function nearestSm(id) {
    const visited = new Set();
    while (index.byId.has(id) && !visited.has(id)) {
      visited.add(id);
      if (index.byId.get(id).kind === "sm") return id;
      id = index.byId.get(id).parentId;
    }
    return null;
  }
  function detailedEvents(smId = drillSmId) {
    const capabilities = trace?.meta?.capabilities ?? [];
    if (!capabilities.includes("instruction_spans") && !capabilities.includes("instruction_observations") && !capabilities.includes("modeled_instruction_spans")) return [];
    return (index.intervals.get(smId)?.events ?? []).filter(event => event.args?.granularity === "instruction" || capabilities.includes("sm_pipeline") && event.args?.instructionId != null);
  }
  function reportLevel() {
    const instructionAvailable = detailedEvents().length > 0;
    const level = drillSmId ? "sm" : "gpu", granularity = drillSmId && instructionAvailable ? "instruction" : "tile";
    const signature = `${level}:${drillSmId}:${granularity}`;
    if (lastLevel !== signature) {lastLevel = signature; onLevelChange(level, {smComponentId: drillSmId, granularity, instructionAvailable});}
  }
  function chooseComponent(id, drill = true) {
    view.selectedComponentId = id;
    if (drill) {drillSmId = nearestSm(id); view.scope = null; wholeMap = false; zoom = 1;}
    renderScene();  if (drill) scrollHome();
    onSelectComponent(id); if (drill) onSelectScope(null);
  }
  function chooseScope(group = null, warpId = undefined) {
    view.scope = group ? {smId: group.smId ?? drillSmId, threadBlockId: group.threadBlockId} : null;
    if (group && warpId !== undefined) view.scope.warpId = warpId;
    if (!group && warpId !== undefined) {
      const nativeSmId = (index.intervals.get(drillSmId)?.events ?? []).find(event => event.args?.smId != null)?.args.smId;
      view.scope = {smId: nativeSmId ?? drillSmId, warpId};
    }
    renderScene();  onSelectScope(view.scope ? {...view.scope} : null);
  }
  function chooseEvent(event) {view.selectedEventId = event.id; patchCounters();  onSelectEvent(event.id);}
  function accessible(node, label, action) {
    node.setAttribute("tabindex", "0"); node.setAttribute("role", "button"); node.setAttribute("aria-label", label);
    node.addEventListener("click", action);
    node.addEventListener("keydown", event => {if (event.key === "Enter" || event.key === " ") {event.preventDefault(); action();}});
    return node;
  }
  function registerStat(id, key, node) {
    if (!statNodes.has(id)) statNodes.set(id, []);
    statNodes.get(id).push({[key]: node}); return node;
  }
  function makeBreadcrumb() {
    breadcrumb.replaceChildren();
    if (drillSmId) breadcrumb.append(button("←", "gpu-back", () => onExitSm ? onExitSm() : chooseComponent(null), "返回 GPU 全景运行"));
    breadcrumb.append(button(index.mode === "tracks" ? "原生轨道" : "GPU", "gpu-crumb-root", () => onExitSm ? onExitSm() : chooseComponent(null)), element("span", "", "/"),
      element("span", "gpu-crumb-current", drillSmId ? `${index.byId.get(drillSmId)?.label ?? drillSmId} 内部` : "Tile 城市"));
  }
  function heading(title, detail) {
    const row = element("div", "gpu-layout-label"); row.append(element("strong", "", title), element("span", "", detail)); scene.append(row);
  }

  function citySvg(height, label) {
    const svg = vector("svg", {viewBox: `0 0 1000 ${height}`, class: "gpu-city-svg", role: "group", "aria-label": label});
    const defs = vector("defs");
    const gradient = vector("linearGradient", {id: `${worldId}-ground`, x1: "0", y1: "0", x2: "1", y2: "1"});
    gradient.append(vector("stop", {offset: "0", "stop-color": "#1c3946"}), vector("stop", {offset: "1", "stop-color": "#142734"}));
    const shadow = vector("filter", {id: `${worldId}-shadow`, x: "-20%", y: "-20%", width: "160%", height: "180%"});
    shadow.append(vector("feDropShadow", {dx: "0", dy: "14", stdDeviation: "10", "flood-color": "#020c13", "flood-opacity": ".6"}));
    defs.append(gradient, shadow); svg.append(defs); return svg;
  }
  function projector(originX = 500, originY = 176, scaleX = .94, scaleY = .43) {
    return (u, v, z = 0) => ({x: originX + (u - v) * scaleX, y: originY + (u + v) * scaleY - z});
  }
  function points(...values) {return values.map(point => `${point.x},${point.y}`).join(" ");}
  function slab(svg, project, u, v, width, depth, height, color, className = "") {
    const group = vector("g", {class: className});
    const a = project(u, v, height), b = project(u + width, v, height), c = project(u + width, v + depth, height), d = project(u, v + depth, height);
    const aa = project(u, v), bb = project(u + width, v), cc = project(u + width, v + depth), dd = project(u, v + depth);
    group.append(vector("polygon", {points: points(d, c, cc, dd), fill: color.left, stroke: color.line, "stroke-width": .8, class: "gpu-building-edge"}),
      vector("polygon", {points: points(b, c, cc, bb), fill: color.right, stroke: color.line, "stroke-width": .8, class: "gpu-building-edge"}),
      vector("polygon", {points: points(a, b, c, d), fill: color.top, stroke: color.line, "stroke-width": 1, class: "gpu-building-top"}));
    svg.append(group); return group;
  }
  function ground(svg, project, width, depth) {
    const groundColor = {top: `url(#${worldId}-ground)`, left: "#142733", right: "#0e202d", line: "#3d6172"};
    const platform = slab(svg, project, 0, 0, width, depth, 0, groundColor);
    // Package thickness and etched traces are decorative geometry, not a traffic model.
    const edge = vector("polygon", {points: points(project(0, depth), project(width, depth), {...project(width, depth), y: project(width, depth).y + 18}, {...project(0, depth), y: project(0, depth).y + 18}), fill: "#0d202c", stroke: "#2b4a5c"});
    const right = vector("polygon", {points: points(project(width, 0), project(width, depth), {...project(width, depth), y: project(width, depth).y + 18}, {...project(width, 0), y: project(width, 0).y + 18}), fill: "#0a1925", stroke: "#2b4a5c"});
    svg.insertBefore(edge, platform); svg.insertBefore(right, platform);
    for (let step = 25; step < width; step += 25) svg.append(vector("line", {x1: project(step, 0).x, y1: project(step, 0).y, x2: project(step, depth).x, y2: project(step, depth).y, class: "gpu-city-grid"}));
    for (let step = 25; step < depth; step += 25) svg.append(vector("line", {x1: project(0, step).x, y1: project(0, step).y, x2: project(width, step).x, y2: project(width, step).y, class: "gpu-city-grid"}));
  }
  function etched(svg, project, u, v, width, depth) {
    const group = vector("g", {"aria-hidden": "true", opacity: ".55"});
    for (let row = 0; row < 4; row++) {
      const a = project(u + 8, v + 9 + row * (depth - 18) / 4), b = project(u + width - 8, v + 9 + row * (depth - 18) / 4);
      group.append(vector("path", {d: `M${a.x} ${a.y}L${b.x} ${b.y}`, fill: "none", stroke: "#527b81", "stroke-width": 1}));
    }
    svg.append(group);
  }
  function schematic(svg, project, u, v, width, depth, height, title, subtitle, type = "structure") {
    const group = slab(svg, project, u, v, width, depth, height, COLORS[type], "gpu-city-structure gpu-city-structural");
    group.setAttribute("aria-label", `${title}，结构示意，未观测`);
    const center = project(u + width / 2, v + depth / 2, height);
    group.append(vector("text", {x: center.x, y: center.y - 3, fill: COLORS[type].light, "font-size": 12, "text-anchor": "middle"}, title),
      vector("text", {x: center.x, y: center.y + 14, fill: "#67899b", "font-size": 9, "text-anchor": "middle"}, subtitle));
    return group;
  }
  function nativeBuilding(svg, project, component, u, v, width, depth, height, type = "compute") {
    const color = COLORS[type];
    const building = slab(svg, project, u, v, width, depth, height, color, `gpu-city-item gpu-type-${type}`);
    building.dataset.gpuComponentId = component.id;
    accessible(building, `${component.label}，进入 SM 内部`, () => chooseComponent(component.id, component.kind === "sm"));
    const outline = [project(u - 5, v - 5), project(u + width + 5, v - 5), project(u + width + 5, v + depth + 5), project(u - 5, v + depth + 5)];
    building.insertBefore(vector("polygon", {points: points(...outline), class: "gpu-city-selection"}), building.firstChild);
    // The roof lattice depicts a compute block; its cells are not warp/lane counts.
    const roof = vector("g", {"aria-hidden": "true", opacity: ".38"});
    for (let row = 0; row < 3; row++) {
      const a = project(u + 11, v + 15 + row * (depth - 25) / 3, height + 1), b = project(u + width - 11, v + 15 + row * (depth - 25) / 3, height + 1);
      roof.append(vector("line", {x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: color.line, "stroke-width": 2}));
    }
    building.append(roof);
    const center = project(u + width / 2, v + depth / 2, height);
    building.append(vector("text", {x: center.x, y: center.y - 10, fill: color.light, "font-size": component.kind === "sm" ? 19 : 14, "font-weight": 600, "text-anchor": "middle"}, component.label.split("/").at(-1).trim()),
      vector("text", {x: center.x, y: center.y + 8, fill: "#8abaaa", "font-size": 9, "text-anchor": "middle"}, component.kind === "sm" ? "STREAMING MULTIPROCESSOR" : "NATIVE PIPELINE"));
    const front = project(u + width * .5, v + depth, height * .34);
    const active = registerStat(component.id, "active", vector("text", {x: front.x, y: front.y, fill: color.light, "font-size": 15, "text-anchor": "middle"}));
    building.append(active, vector("text", {x: front.x, y: front.y + 14, fill: "#719f9a", "font-size": 8, "text-anchor": "middle"}, "ACTIVE SPANS"));
    const tokens = vector("g", {class: "gpu-city-tokens"}); svg.append(tokens);
    tokenSites.push({id: component.id, group: tokens, x: center.x, y: center.y + 22, capacity: width > 100 ? 2 : 1});
    return building;
  }

  function renderOverview() {
    heading("GPU PACKAGE / TILE OBSERVATION", `${trace.meta.producer} · ${trace.meta.timeUnit}`);
    if (presentation === "boxes" || index.physicalSms > 12 || index.sms.length > 12) {
      boxScene = createGpuBoxScene({components: index.sms, eventsById: new Map([...index.intervals].map(([id, value]) => [id, value.events])),
        configuredSms: index.physicalSms, title: index.gpus[0]?.label ?? "GPU COMPUTE CITY", trace, flat: presentation === "structure",
        onSelectComponent: id => chooseComponent(id, index.byId.get(id)?.kind === "sm"), onSelectEvent: id => {const event = trace.events.find(event => event.id === id); if (event) chooseEvent(event);}});
      scene.append(boxScene.element);
      footnote.textContent = trace.meta.topology ? "全部配置 SM 均绘制；光包只由显式 transfer 区间驱动，数字等待标记只来自 queue。NoC、L2、HBM 的逻辑位置不代表芯片物理布线。点击光包追踪同一请求，点击 SM 进入内部。" : "全部配置 SM 均绘制，虚线盒子表示来源未记录活动。当前 trace 无 NoC/HBM 传输区间，因此不推断车流。点击实线 SM 进入内部。";
      return;
    }
    const svg = citySvg(575, "GPU 外部 tile 颗粒度城市，SM 建筑可进入。L2 与 HBM 为未观测结构示意。");
    const p = projector(500, 154, .98, .43);
    svg.append(vector("ellipse", {cx: 500, cy: 385, rx: 350, ry: 142, fill: "#020d16", opacity: ".35"}));
    ground(svg, p, 360, 360);
    // Dashed infrastructure never animates requests unless a source supplies them.
    const infrastructure = vector("g", {class: "gpu-city-structure", fill: "none", stroke: "#426375", "stroke-width": 1.5, "stroke-dasharray": "4 5", opacity: ".75"});
    const a = p(12, 260), b = p(348, 260), c = p(348, 340), d = p(12, 340);
    infrastructure.append(vector("path", {d: `M${a.x} ${a.y}L${b.x} ${b.y}L${c.x} ${c.y}L${d.x} ${d.y}`})); svg.append(infrastructure);
    for (const [u, v] of [[-87, 143], [380, 143]]) {
      for (let layer = 0; layer < 3; layer++) schematic(svg, p, u, v, 66, 90, 16 + layer * 12, layer === 2 ? "HBM" : "", layer === 2 ? "未观测 · 示意" : "");
    }
    schematic(svg, p, 45, 284, 270, 48, 28, "SHARED L2", "共享缓存 · 结构示意 / 未观测");
    const shown = index.sms, columns = shown.length <= 2 ? Math.max(1, shown.length) : Math.ceil(Math.sqrt(shown.length));
    const rows = Math.ceil(shown.length / columns), gap = 16;
    const blockWidth = (294 - (columns - 1) * gap) / columns, blockDepth = (215 - (rows - 1) * gap) / Math.max(1, rows);
    for (const [position, sm] of shown.entries()) {
      const u = 33 + position % columns * (blockWidth + gap), v = 32 + Math.floor(position / columns) * (blockDepth + gap);
      const center = p(u + blockWidth / 2, v + blockDepth / 2);
      svg.append(vector("path", {d: `M${center.x} ${center.y + 7}L${p(u + blockWidth / 2, 268).x} ${p(u + blockWidth / 2, 268).y}`, fill: "none", stroke: "#3e6472", "stroke-width": 3, opacity: ".4", class: "gpu-city-structure"}));
      nativeBuilding(svg, p, sm, u, v, blockWidth, blockDepth, Math.max(45, 81 - rows * 6));
    }
    for (const site of tokenSites) svg.append(site.group);
    const gpu = index.gpus[0];
    svg.append(vector("text", {x: 500, y: 32, fill: "#cae5e7", "font-size": 17, "text-anchor": "middle", "letter-spacing": 2}, gpu?.label ?? "GPU TILE CITY"),
      vector("text", {x: 500, y: 53, fill: "#6f94a6", "font-size": 10, "text-anchor": "middle", "letter-spacing": 1}, "CLICK A COMPUTE DISTRICT TO EXPLORE"));
    const count = `${index.sms.length} SM 已观测${index.physicalSms === null ? "" : ` / 配置 ${index.physicalSms}`}`;
    svg.append(vector("text", {x: 500, y: 527, fill: "#9ebdcc", "font-size": 12, "text-anchor": "middle"}, count));
    if (index.unobservedSms || index.physicalSms > index.sms.length) svg.append(vector("text", {x: 500, y: 548, fill: "#607f92", "font-size": 10, "text-anchor": "middle"}, `其余 ${index.physicalSms - index.sms.length} 个配置 SM 未列入记录；不推断布局或活动`));
    if (index.sms.length > shown.length) svg.append(vector("text", {x: 500, y: 567, fill: "#779aaa", "font-size": 10, "text-anchor": "middle"}, `画布显示前 ${shown.length} 个原生 SM；完整组件可在左侧选择`));
    if (!shown.length) svg.append(vector("text", {x: 500, y: 300, fill: "#8dabbc", "font-size": 15, "text-anchor": "middle"}, "当前 Trace 没有独立 SM 组件"));
    scene.append(svg);
    const caption = element("div", "gpu-city-caption"); caption.append(element("span", "gpu-caption-native", "原生 tile 区间驱动建筑状态"), element("strong", "", "01 / GPU EXTERIOR")); scene.append(caption);
    footnote.textContent = "建筑布局为示意，活动与标记仅来自原始 [start, end) 区间。点击 SM 进入内部；L2、HBM 及连线不表示观测到的内存请求。";
  }

  function renderSm() {
    const sm = index.byId.get(drillSmId), instructions = detailedEvents(sm.id);
    const modeledPipeline = trace.meta.capabilities?.includes("sm_pipeline");
    const mappedPipeline = modeledPipeline || trace.meta.capabilities?.includes('instruction_pipeline_stages');
    const instructionPoints = instructions.length > 0 && instructions.every(event => event.start === event.end);
    if (!mappedPipeline) heading("SM INTERIOR / FORMAL MICROARCHITECTURE", `${sm.label} · ${instructions.length ? instructionPoints ? "指令观测点 observer" : "指令区间 observer" : "tile 级 observer"}`);
    const navigation = mappedPipeline ? element('div', 'gpu-sm-navigation') : null;
    if (index.sms.length > 1) {
      const switcher = element('div', 'gpu-sm-switcher'); switcher.setAttribute('aria-label', '切换记录中的 SM');
      switcher.append(element('span', 'gpu-filter-label', 'SM INTERIORS'));
      const select = element('select', 'gpu-sm-select'); select.setAttribute('aria-label', '选择 SM 内部');
      for (const component of index.sms) {
        const option = element('option', '', component.label); option.value = component.id; select.append(option);
      }
      select.value = sm.id; select.addEventListener('change', () => chooseComponent(select.value)); switcher.append(select);
      (navigation ?? scene).append(switcher);
    }
    if (mappedPipeline) {renderFilters(navigation, sm.id); scene.append(navigation);}
    smPipelineScene = createSmPipelineScene({trace, sm, events: index.intervals.get(sm.id)?.events ?? [],
      onSelectComponent: id => chooseComponent(id, false), onSelectEvent: id => {const event = trace.events.find(event => event.id === id); if (event) chooseEvent(event);}, onResize: fitScene});
    if (mappedPipeline) scene.append(smPipelineScene.element);
    const execution = element(mappedPipeline ? 'details' : 'section', "gpu-sm-execution"); execution.setAttribute("aria-label", "SM 原生工作负载与指令轨迹");
    if (mappedPipeline) execution.append(element('summary', 'gpu-instruction-summary', '指令列表与阶段轨迹'));
    const header = element("div", "gpu-section-label"); header.append(element("span", "", instructions.length ? instructionPoints ? "WARP / INSTRUCTION OBSERVATIONS" : "WARP / INSTRUCTION SPANS" : trace.meta.trafficSchemaVersion ? "TASK / TILE OPERATIONS" : "WARP / TILE OPERATIONS"), element("small", "", trace.meta.trafficSchemaVersion ? "CTA 资源准入 / Tile 执行；无指令时序" : "CTA 与 warp 为筛选范围")); execution.append(header);
    if (instructionPoints) execution.append(element('p', 'gpu-extra-note', '绿色菱形：ISSUE · 琥珀菱形：STALL · 只记录观测时点，未记录指令执行时长或完成时间。'));
    if (!mappedPipeline) renderFilters(execution, sm.id);
    const nativeEvents = instructions.length ? instructions : index.intervals.get(sm.id)?.events ?? [];
    const events = scoped(nativeEvents);
    if (instructions.length) renderInstructionRows(execution, events);
    renderEventLanes(execution, events, Boolean(instructions.length));
    scene.append(execution);
    if (!mappedPipeline) scene.append(smPipelineScene.element);
    execution.addEventListener('toggle', fitScene);
    if (smPipelineViews.has(sm.id)) smPipelineScene.setView(smPipelineViews.get(sm.id));
    footnote.textContent = modeledPipeline ? "SM 教学模型的 Fetch / Issue / 执行 / 写回 / 异步内存阶段来自独立运行；组件时序与资源参数为显式教学配置，未宣称 NVIDIA cycle accurate。未使用的结构组件保持未观测。" : mappedPipeline ? '光点关联同一条原生动态指令：在观测阶段内停留，在实际端点周期之间沿示意通路移动。位置表示回放进度；未记录阶段保持未观测。' : instructions.length ? instructionPoints ? "菱形仅表示原生日志的 ISSUE / STALL 等观测时点；不推断执行时长，观测点不计入进行中区间。PC 与指令文本保留来源语义。" : "原生指令只有明确的 architectureComponentId 映射才能驱动正式组件；未映射阶段不从 opcode 推断。零时长菱形表示观测点。" : "当前保留来源的粗粒度任务、CTA 或 warp 归属；正式 SM 图只定义组件与类型化连接，Fetch / Issue 等状态不从 tile 推断。运行 SM 教学模型或载入映射详细 trace 才显示对应阶段证据。";
  }
  function scoped(events) {
    if (!view.scope) return events;
    return events.filter(event => (view.scope.threadBlockId == null || String(event.args?.threadBlockId) === String(view.scope.threadBlockId)) && (view.scope.warpId == null || String(event.args?.warpId) === String(view.scope.warpId)));
  }
  function renderFilters(parent, smId) {
    const groups = groupCtas(index, smId, view.time), row = element("div", "gpu-cta-scope");
    row.append(element("span", "gpu-filter-label", trace?.meta?.trafficSchemaVersion ? "任务" : "CTA"));
    const all = button("全部", "gpu-tool", () => chooseScope()); all.setAttribute("aria-pressed", String(!view.scope)); row.append(all);
    for (const group of groups.slice(0, 12)) {
      const choice = button(String(group.threadBlockId), "gpu-tool", () => chooseScope(group));
      choice.dataset.gpuCtaId = String(group.threadBlockId); choice.setAttribute("aria-pressed", String(view.scope?.threadBlockId === group.threadBlockId)); row.append(choice);
    }
    if (!groups.length) row.append(element("span", "gpu-filter-label", "来源未提供 threadBlockId"));
    if (groups.length || !trace.meta.capabilities?.some(capability => ['instruction_pipeline_stages', 'sm_pipeline'].includes(capability))) parent.append(row);
    const group = groups.find(group => group.threadBlockId === view.scope?.threadBlockId);
    const warpIds = group?.warpIds ?? [...new Set((index.intervals.get(smId)?.events ?? []).map(event => event.args?.warpId).filter(id => id != null))];
    if (warpIds.length) {
      const warpRow = element("div", "gpu-cta-scope"); warpRow.append(element("span", "gpu-filter-label", "WARP"));
      const allWarps = button("全部", "gpu-tool", () => chooseScope(group)); allWarps.setAttribute("aria-pressed", String(view.scope?.warpId === undefined)); warpRow.append(allWarps);
      for (const warpId of warpIds.slice(0, 16)) {
        const choice = button(String(warpId), "gpu-tool", () => chooseScope(group, warpId)); choice.setAttribute("aria-pressed", String(view.scope?.warpId === warpId)); warpRow.append(choice);
      }
      parent.append(warpRow);
    }
  }
  function renderEventLanes(parent, events, instruction) {
    laneHost = element('div', 'gpu-native-lanes'); laneSource = events; laneInstruction = instruction;
    parent.append(laneHost); patchEventLanes();
  }
  function patchEventLanes() {
    if (!laneHost) return;
    const events = laneSource, instruction = laneInstruction;
    if (!events.length) {laneHost.replaceChildren(element("p", "gpu-task-empty", "当前范围没有原生事件。")); return;}
    const options = trace.meta.trafficSchemaVersion ? {laneKey: event => `T${event.args?.round ?? "?"} / ${event.category ?? "task"}`} : {};
    const window = laneWindow(events, view.time, view.selectedEventId, options);
    const signature = window.events.map(event => event.id).join('|');
    if (signature === lastLaneSignature) return;
    lastLaneSignature = signature;
    const focused = laneHost.contains(document.activeElement) ? document.activeElement.dataset.gpuWarpEventId : null;
    laneHost.replaceChildren(); eventNodes.clear();
    const entries = window.lanes, width = 960, left = 195, plotWidth = 743, rowHeight = 29, top = 31, height = top + entries.length * rowHeight + 12;
    const chart = vector("svg", {viewBox: `0 0 ${width} ${height}`, class: "gpu-cta-trace", role: "group", "aria-label": instruction ? "按 warp 与观测阶段分轨的原生指令轨迹；菱形为观测点" : "按 warp 与类别分轨的原生 tile 区间"});
    const start = window.start, end = window.end;
    const x = value => left + (value - start) / (end - start || 1) * plotWidth;
    const tickCount = end === start ? 0 : 4;
    for (let tick = 0; tick <= tickCount; tick++) {
      const value = start + (end - start) * tick / (tickCount || 1);
      chart.append(vector("line", {x1: x(value), x2: x(value), y1: 22, y2: height - 6, stroke: "#2d4759", "stroke-width": .7}), vector("text", {x: x(value), y: 15, "text-anchor": tick === 4 ? "end" : "start"}, value.toLocaleString(undefined, {maximumFractionDigits: 2})));
    }
    let count = 0;
    for (const [rowIndex, [key, lane]] of entries.entries()) {
      const y = top + rowIndex * rowHeight;
      const label = vector("text", {x: 12, y: y + 13, class: "gpu-lane-label"}, key.length > 29 ? `${key.slice(0, 28)}…` : key);
      label.append(vector('title', {}, key));
      chart.append(label, vector("line", {x1: 0, x2: width, y1: y + 23, y2: y + 23, stroke: "#203b4c", "stroke-width": .7}));
      for (const event of lane) {
        const type = pipelineType(index.byId.get(event.componentId)), point = event.start === event.end;
        const stage = event.args?.stage, color = stage === 'ISSUE' ? '#69d3aa' : stage?.startsWith('STALL_') ? '#e4b368' : COLORS[type].line;
        const shape = point ? {d: `M${x(event.start)} ${y + 2}l5 6.5-5 6.5-5-6.5z`} : {x: x(event.start), y, width: Math.max(2, x(event.end) - x(event.start)), height: 17, rx: 2};
        const span = vector(point ? "path" : "rect", {...shape, fill: color, class: "gpu-warp-event", "data-gpu-warp-event-id": event.id, "aria-pressed": String(view.selectedEventId === event.id)});
        accessible(span, `${event.name}，${point ? `观测点 @ ${event.start}` : `${event.start} 至 ${event.end}`} ${trace.meta.timeUnit}`, () => chooseEvent(event));
        span.append(vector("title", {}, `${event.name}\n${point ? `${event.args?.stage ?? "观测点"} @ ${event.start}` : `${event.start} → ${event.end}`} ${trace.meta.timeUnit}${instruction ? `\nPC ${event.args?.pc ?? "未提供"} · ${event.args?.opcode ?? event.args?.instructionText ?? event.args?.op ?? "未提供指令文本"}` : ""}`));
        chart.append(span); eventNodes.set(event.id, {node: span, event}); count++;
      }
    }
    cursor = vector("line", {x1: x(view.time), x2: x(view.time), y1: 22, y2: height - 6, class: "gpu-cta-cursor"});
    cursor.dataset.start = start; cursor.dataset.end = end; cursor.dataset.left = left; cursor.dataset.width = plotWidth;
    chart.append(cursor);
    const laneScroll = element("div", "gpu-lane-scroll"); laneScroll.tabIndex = 0;
    laneScroll.setAttribute("aria-label", "可横向滚动的原始事件轨道"); laneScroll.append(chart);
    laneHost.append(laneScroll, element("p", "gpu-extra-note", `来源时间：${trace.meta.timeUnit} · 游标附近及所选事件 ${count} / ${events.length} 个 · ${entries.length} / ${window.totalLanes} 条轨道。菱形为观测点；完整事件保留在主时间线。`));
    if (focused) [...laneHost.querySelectorAll('[data-gpu-warp-event-id]')].find(node => node.dataset.gpuWarpEventId === focused)?.focus({preventScroll: true});
  }
  function renderInstructionRows(parent, events) {
    parent.append(element('p', 'gpu-extra-note', '游标附近与所选指令 · 行末保留原始阶段与周期，含前后相邻观测。'));
    const list = element("div", "gpu-instruction-list"); list.setAttribute("aria-label", "原生指令 PC 与 opcode");
    instructionRows = list; instructionRowEvents = events; parent.append(list); patchInstructionRows();
  }
  function patchInstructionRows() {
    if (!instructionRows) return;
    const events = instructionRowEvents;
    const selected = events.find(event => event.id === view.selectedEventId);
    const active = [], nearest = [];
    const byDistance = (a, b) => Math.abs(a.start - view.time) - Math.abs(b.start - view.time) || a.start - b.start || a.id.localeCompare(b.id);
    for (const event of events) {
      if (event === selected) continue;
      if (event.start <= view.time && view.time < event.end) {if (active.length < 6) active.push(event);}
      else if (nearest.length < 6 || byDistance(event, nearest.at(-1)) < 0) {nearest.push(event); nearest.sort(byDistance); if (nearest.length > 6) nearest.pop();}
    }
    const visible = [...(selected ? [selected] : []), ...active, ...nearest].slice(0, 6).sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    const signature = visible.map(event => event.id).join("|") + view.selectedEventId;
    if (signature === lastInstructionSignature) return; lastInstructionSignature = signature;
    const focused = instructionRows.contains(document.activeElement) ? document.activeElement.dataset.gpuInstructionEventId : null;
    instructionRows.replaceChildren();
    for (const event of visible) {
      const row = button("", "gpu-instruction-row", () => chooseEvent(event)); row.dataset.gpuInstructionEventId = event.id;
      row.setAttribute("aria-pressed", String(view.selectedEventId === event.id));
      const instruction = event.args?.instructionText ?? event.args?.opcode ?? event.args?.op ?? "指令文本未提供";
      row.title = `${event.args?.stage ?? "instruction"} · ${instruction}`;
      row.append(element("span", "", `W${event.args?.warpId ?? "?"}${event.args?.dynamicWarpId == null ? '' : ` D${event.args.dynamicWarpId}`}`), element("span", "", `PC ${event.args?.pc ?? "未提供"}`), element("span", "gpu-opcode", instruction), element("small", "", event.start === event.end ? `${event.args?.stage ?? "POINT"} @ ${event.start}` : `${event.start} → ${event.end}`));
      instructionRows.append(row);
    }
    if (focused) [...instructionRows.querySelectorAll("[data-gpu-instruction-event-id]")].find(row => row.dataset.gpuInstructionEventId === focused)?.focus({preventScroll: true});
  }
  function renderTracks() {
    heading("PROFILE / NATIVE TRACKS", "保留来源层级");
    const grid = element("div", "gpu-track-grid");
    for (const component of index.components.slice(0, 60)) {
      const card = button("", "gpu-track", () => chooseComponent(component.id, false)); card.dataset.gpuComponentId = component.id;
      card.append(element("strong", "", component.label), element("small", "", component.id));
      const counter = element("small"); counter.append(registerStat(component.id, "active", element("b")), document.createTextNode(" 个进行中区间")); card.append(counter); grid.append(card);
    }
    scene.append(grid); footnote.textContent = "Profile process / thread 是来源轨道，不映射为推测的 SM。原生事件与层级保持不变。";
  }
  function renderScene() {
    const activeElement = document.activeElement;
    const focused = scene.contains(activeElement) ? activeElement.dataset.gpuComponentId : null;
    boxScene?.destroy?.(); boxScene = null;
    if (smPipelineScene) {const previousSm = smPipelineScene.getView().smComponentId; if (previousSm) smPipelineViews.set(previousSm, smPipelineScene.getView()); smPipelineScene.destroy(); smPipelineScene = null;}
    statNodes.clear(); tokenSites.length = 0; eventNodes.clear(); cursor = null; lastTokenSignature = ""; instructionRows = null; instructionRowEvents = []; lastInstructionSignature = "";
    laneHost = null; laneSource = []; lastLaneSignature = '';
    scene.replaceChildren(); makeBreadcrumb();
    root.classList.add("gpu-box-mode");
    root.classList.toggle("gpu-overview", index.mode === "architecture" && !drillSmId);
    root.classList.toggle("gpu-sm-detail", Boolean(drillSmId));
    if (!trace) scene.append(element("p", "gpu-empty", "载入 Trace 后，探索 GPU tile 城市与 SM 内部执行。"));
    else if (index.mode === "tracks") renderTracks();
    else if (drillSmId && index.byId.has(drillSmId)) renderSm();
    else renderOverview();
    patchCounters(); setZoom(zoom); reportLevel();
    if (focused) [...scene.querySelectorAll("[data-gpu-component-id]")].find(node => node.dataset.gpuComponentId === focused)?.focus({preventScroll: true});
  }
  function patchTokens() {
    const selected = trace?.events.find(event => event.id === view.selectedEventId);
    const data = tokenSites.map(site => {
      const events = index.intervals.get(site.id)?.events ?? [];
      const active = events.filter(event => event.start <= view.time && view.time < event.end);
      const chosen = selected && events.includes(selected) ? [selected, ...active.filter(event => event !== selected)] : active;
      return {site, events: chosen.slice(0, site.capacity)};
    });
    const signature = JSON.stringify(data.map(item => [item.site.id, item.events.map(event => event.id)])) + view.selectedEventId;
    if (signature === lastTokenSignature) return; lastTokenSignature = signature;
    for (const {site, events} of data) {
      site.group.replaceChildren();
      for (const [i, event] of events.entries()) {
        const token = vector("g", {class: `gpu-city-token${event.id === view.selectedEventId ? " gpu-event-selected" : ""}`, transform: `translate(${site.x - 54},${site.y + i * 24})`, "data-type": pipelineType(index.byId.get(event.componentId)), "data-gpu-event-id": event.id, "aria-pressed": String(view.selectedEventId === event.id)});
        accessible(token, `${event.name}，原生事件 ${event.id}`, () => chooseEvent(event));
        const tile = event.args?.tile, label = event.args?.granularity === "instruction" ? event.args?.opcode ?? event.args?.op ?? event.args?.stage ?? event.category ?? "instruction" : `${event.category ?? "tile"}${tile ? ` ${tile.rows}×${tile.cols}` : ""}`;
        token.append(vector("rect", {width: 108, height: 20, rx: 4}), vector("text", {x: 54, y: 13, "text-anchor": "middle"}, String(label).slice(0, 18)), vector("title", {}, `${event.name}\n${event.start} → ${event.end} ${trace.meta.timeUnit}`));
        site.group.append(token);
      }
    }
  }
  function patchCounters() {
    if (!stats) return;
    boxScene?.update({byId: stats.byId, time: view.time, selectedComponentId: view.selectedComponentId, selectedEventId: view.selectedEventId});
    smPipelineScene?.update({time: view.time, selectedEventId: view.selectedEventId, scope: view.scope});
    for (const [id, nodes] of statNodes) {
      const value = stats.byId.get(id);
      if (value) for (const group of nodes) for (const key of ["active", "completed", "total", "observed", "issue", "stall", "pointTotal", "endedSpans"]) if (group[key]) group[key].textContent = value[key].toLocaleString();
    }
    for (const node of scene.querySelectorAll("[data-gpu-component-id]")) {
      if (node.classList.contains("gpu-box-sm-micro")) continue;
      const id = node.dataset.gpuComponentId, value = stats.byId.get(id), component = index.byId.get(id);
      const pointOnly = detailedEvents(id).length > 0 && (index.intervals.get(id)?.events ?? []).every(event => event.start === event.end);
      node.classList.toggle("gpu-running", value?.active > 0); node.classList.toggle("gpu-selected", view.selectedComponentId === id);
      node.setAttribute("aria-pressed", String(view.selectedComponentId === id));
      node.setAttribute("aria-label", `${component?.label ?? id}，${value?.active ?? 0} 个进行中区间，${value?.completed ?? 0} ${pointOnly ? "个观测已发生" : "个区间已结束"}，${component?.kind === "sm" ? "进入 SM 内部" : "选择组件"}`);
    }
    patchEventLanes();
    for (const {node, event} of eventNodes.values()) {
      node.setAttribute("aria-pressed", String(event.id === view.selectedEventId)); node.classList.toggle("gpu-event-active", event.start === event.end ? event.start <= view.time : event.start <= view.time && view.time < event.end);
    }
    for (const row of scene.querySelectorAll("[data-gpu-instruction-event-id]")) row.setAttribute("aria-pressed", String(row.dataset.gpuInstructionEventId === view.selectedEventId));
    if (cursor) {
      const start = Number(cursor.dataset.start), end = Number(cursor.dataset.end), x = Number(cursor.dataset.left) + (view.time - start) / (end - start || 1) * Number(cursor.dataset.width);
      cursor.setAttribute("x1", x); cursor.setAttribute("x2", x); cursor.setAttribute("visibility", view.time < start || view.time > end ? "hidden" : "visible");
    }
    patchTokens(); patchInstructionRows();
  }
  function setTrace(nextTrace) {
    smPipelineScene?.destroy(); smPipelineScene = null; smPipelineViews.clear();
    trace = nextTrace; index = indexComponents(trace); drillSmId = null; wholeMap = false; zoom = 1; lastLevel = "";
    view = {time: 0, selectedComponentId: null, selectedEventId: null, scope: null};
    stats = snapshot(index, trace, 0); renderScene();
  }
  function update(nextView = {}) {
    if (!trace) return;
    const previousSelection = view.selectedComponentId, previousScope = JSON.stringify(view.scope);
    Object.assign(view, nextView); if (!Number.isFinite(view.time)) view.time = 0;
    if (view.selectedComponentId && !index.byId.has(view.selectedComponentId)) view.selectedComponentId = null;
    const newDrill = nearestSm(view.selectedComponentId);
    let changed = previousSelection !== view.selectedComponentId && newDrill !== drillSmId;
    if (changed) drillSmId = newDrill;
    if (previousScope !== JSON.stringify(view.scope)) {
      if (view.scope) {
        for (const sm of index.sms) {
          const matching = (index.intervals.get(sm.id)?.events ?? []).some(event => String(event.args?.smId) === String(view.scope.smId));
          if (matching || sm.id === view.scope.smId) {drillSmId = sm.id; break;}
        }
      }
      changed = true;
    }
    stats = snapshot(index, trace, view.time);
    if (changed) {wholeMap = false; renderScene(); scrollHome();} else patchCounters();

  }

  setZoom(1); renderScene();
  return {setTrace, update, resize: fitScene,
    animate(time) {if (Number.isFinite(time)) {view.time = time; boxScene?.animate?.({time, selectedEventId: view.selectedEventId}); smPipelineScene?.animate({time, selectedEventId: view.selectedEventId});}},
    getView() {return {smComponentId: drillSmId, scope: view.scope ? {...view.scope} : null, zoom, wholeMap, presentation, smPipeline: smPipelineScene?.getView() ?? null};},
    setView(saved = {}) {
      drillSmId = index.byId.get(saved.smComponentId)?.kind === "sm" ? saved.smComponentId : null;
      if (zoomLevels.includes(saved.zoom)) zoom = saved.zoom;
      presentation = "boxes";
      if (drillSmId && saved.smPipeline) smPipelineViews.set(drillSmId, saved.smPipeline);
      update({scope: saved.scope ?? null}); wholeMap = saved.wholeMap === true; renderScene();
    },
    destroy() {document.removeEventListener("fullscreenchange", fullscreenChanged); window.removeEventListener('resize', fitScene); resizeObserver?.disconnect(); boxScene?.destroy?.(); smPipelineScene?.destroy?.(); root.remove();},
  };
}
