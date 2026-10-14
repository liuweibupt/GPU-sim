import {createGpuBoxScene, GPU_BOX_SCENE_CSS} from "./gpu-box-scene.js";

// Interactive, trace-backed structure view. Geometry and artwork are illustrative;
// only native component identities and event intervals drive counters/highlights.
const SVG_NS = "http://www.w3.org/2000/svg";
const ASSET_BASE = new URL("./assets/gpu/", import.meta.url);

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
  const intervals = new Map(components.map(component => [component.id, {starts: [], ends: [], events: []}]));
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
      id = byId.get(id).parentId;
    }
  }
  for (const interval of intervals.values()) {
    interval.starts.sort((a, b) => a - b); interval.ends.sort((a, b) => a - b);
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
    byId.set(component.id, {...component, total: interval.events.length, completed,
      active: countThrough(interval.starts, time) - completed});
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
export function worldCameraScale({width, height, naturalWidth, naturalHeight, detail = false, wholeMap = false, zoom = 1}) {
  const widthScale = Math.min(1, Math.max(1, width) / Math.max(1, naturalWidth));
  const heightScale = Math.min(1, Math.max(1, height) / Math.max(1, naturalHeight));
  const fitted = wholeMap ? Math.min(widthScale, heightScale)
    : detail ? widthScale : Math.min(widthScale, heightScale);
  return (wholeMap ? fitted : Math.max(.85, fitted)) * zoom;
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

function vector(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

function icon(type) {
  const graphic = vector("svg", {viewBox: "0 0 120 90", "aria-hidden": "true", class: "gpu-vector-art"});
  const outline = (x, y, width, height, color, rx = 3) => vector("rect", {x, y, width, height, rx, fill: color, stroke: "currentColor", "stroke-width": 1});
  if (type === "hbm") {
    for (let layer = 4; layer >= 0; layer--) graphic.append(outline(28, 10 + layer * 12, 64, 22, "#192d38"));
    for (let pin = 0; pin < 8; pin++) graphic.append(vector("line", {x1: 34 + pin * 7, x2: 34 + pin * 7, y1: 79, y2: 86, stroke: "currentColor", "stroke-width": 2}));
  } else if (type === "cache") {
    graphic.append(outline(10, 15, 100, 60, "#143131", 6));
    for (let row = 0; row < 3; row++) for (let col = 0; col < 8; col++) graphic.append(outline(17 + col * 11, 22 + row * 16, 7, 11, "#286b61", 1));
  } else if (type === "scheduler") {
    graphic.append(outline(12, 15, 29, 60, "#342c20", 4));
    for (let row = 0; row < 4; row++) graphic.append(outline(18, 22 + row * 12, 17, 5, "#9c7c45", 1));
    for (let row = 0; row < 3; row++) {
      graphic.append(vector("path", {d: `M 45 45 H 58 V ${25 + row * 23} H 76`, fill: "none", stroke: "currentColor", "stroke-width": 1.5}));
      graphic.append(outline(79, 17 + row * 23, 25, 15, "#342c20"));
    }
  } else if (type === "warp") {
    for (let row = 0; row < 4; row++) for (let col = 0; col < 8; col++) graphic.append(outline(13 + col * 12, 20 + row * 13, 8, 8, "#4b624c", 1));
  } else {
    graphic.append(outline(10, 10, 100, 70, type === "tensor" ? "#2b2546" : "#353026", 8));
    for (let row = 0; row < 3; row++) for (let col = 0; col < 4; col++) graphic.append(outline(19 + col * 22, 19 + row * 18, 16, 12, type === "tensor" ? "#68548c" : "#79633f", 2));
    for (let pin = 0; pin < 8; pin++) {
      graphic.append(vector("line", {x1: 20 + pin * 11, x2: 20 + pin * 11, y1: 4, y2: 9, stroke: "currentColor", "stroke-width": 2}));
      graphic.append(vector("line", {x1: 20 + pin * 11, x2: 20 + pin * 11, y1: 81, y2: 86, stroke: "currentColor", "stroke-width": 2}));
    }
  }
  return graphic;
}

function artwork(type, className = "") {
  const frame = element("span", `gpu-art gpu-art-${type} ${className}`);
  const fallback = icon(type);
  const picture = element("img", "gpu-generated-art");
  picture.src = new URL(`${type}.png`, ASSET_BASE).href;
  picture.alt = ""; picture.draggable = false; picture.setAttribute("aria-hidden", "true");
  picture.addEventListener("load", () => fallback.hidden = true);
  picture.addEventListener("error", () => picture.remove());
  frame.append(fallback, picture);
  return frame;
}

function pipelineType(component) {
  const name = `${component.id} ${component.label}`.toLowerCase();
  if (name.includes("tensor")) return "tensor";
  if (/(?:\bld\b|load|\bst\b|store)/.test(name)) return "memory";
  return "compute";
}

const CSS = `
.gpu-world{--gpu-bg:#121b23;--gpu-surface:#1b2731;--gpu-line:#35444e;--gpu-text:#e5edf2;--gpu-muted:#8ca2ae;--gpu-amber:#d7a761;--gpu-cyan:#6ac8d7;--gpu-teal:#68baa9;--gpu-purple:#bb9ae4;color:var(--gpu-text);font:13px/1.5 system-ui,sans-serif;min-width:0;min-height:0;height:100%;display:flex;flex-direction:column;isolation:isolate}
.gpu-world *{box-sizing:border-box}.gpu-world button{font:inherit;color:inherit;cursor:pointer}.gpu-world button:focus-visible{outline:2px solid #a7e6ef;outline-offset:4px}.gpu-world button:disabled{opacity:.35;cursor:default}.gpu-world button:hover:not(:disabled){filter:brightness(1.12)}.gpu-world button:active:not(:disabled){transform:translateY(1px)}
.gpu-toolbar{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:0 0 14px}.gpu-breadcrumb{display:flex;align-items:center;gap:10px;min-width:0}.gpu-back,.gpu-tool{border:1px solid var(--gpu-line);background:#1d2a34;border-radius:7px;padding:5px 10px}.gpu-back{width:32px;padding:5px}.gpu-crumb-root{background:transparent;border:0;padding:4px 0;color:var(--gpu-muted)!important}.gpu-crumb-current{font-weight:600;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gpu-controls{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.gpu-switch{font-size:11px!important;padding:6px 9px;white-space:nowrap}.gpu-switch[aria-pressed=true]{border-color:#508f88;background:#233d3d;color:#a2ded2}.gpu-zoom-label{font:10px ui-monospace,monospace;color:var(--gpu-muted);min-width:40px;text-align:center}.gpu-tool-small{width:27px;padding:4px}.gpu-stage{position:relative;border:1px solid #34434d;border-radius:12px;background:radial-gradient(ellipse at 50% 50%,#26323d 0,#16212b 70%);overflow:auto;min-height:410px;max-height:850px;scrollbar-color:#536471 #18232e}
.gpu-scene{padding:20px;min-width:590px;width:100%;transition:width .15s ease}.gpu-layout-label{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--gpu-muted);margin-bottom:12px}.gpu-layout-label strong{font-weight:500;color:#a4bac7}.gpu-layout-label span:last-child{text-align:right}.gpu-die-layout{display:grid;grid-template-columns:86px minmax(360px,1fr) 86px;gap:13px;align-items:stretch}.gpu-hbm-rail{display:flex;flex-direction:column;justify-content:space-around;gap:14px}.gpu-unobserved{border:1px dashed #45525a;border-radius:8px;background:#18252e;position:relative;color:var(--gpu-muted);overflow:hidden}.gpu-hbm{padding:8px 3px;text-align:center;min-height:135px}.gpu-hbm .gpu-art{height:77px;width:73px;margin:0 auto}.gpu-hbm b{font:11px ui-monospace,monospace;display:block;color:#8aaebd}.gpu-unobserved small{display:block;font-size:9px;letter-spacing:.02em;line-height:1.4;color:#93a2aa}.gpu-die{padding:18px;border:1px solid #596b74;border-radius:10px;background:linear-gradient(145deg,#27343d,#1a2631 60%);box-shadow:inset 0 0 0 5px #1b2931,0 8px 28px #07101950;position:relative}.gpu-die:before,.gpu-die:after{content:"";position:absolute;width:5px;height:5px;border:1px solid #657984;border-radius:50%;top:8px}.gpu-die:before{left:8px}.gpu-die:after{right:8px}.gpu-die-header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:16px}.gpu-die-name{font:600 13px ui-monospace,monospace;letter-spacing:.02em;color:#d2e2ec}.gpu-chip-label{font:9px ui-monospace,monospace;padding:3px 6px;border:1px solid #49606d;border-radius:4px;white-space:nowrap;color:#afc3cd}.gpu-sm-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.gpu-component{width:100%;border:1px solid #6c604c;border-radius:8px;background:linear-gradient(145deg,#3d392e,#242c2e);text-align:left;position:relative;padding:12px;min-width:0;box-shadow:0 4px 10px #0b111a25;transition:border-color .15s,box-shadow .15s}.gpu-component.gpu-running{border-color:#dcaf66;box-shadow:inset 0 0 18px #cba05a12,0 0 0 1px #cba05a28}.gpu-component.gpu-selected{outline:2px solid #93d8df;outline-offset:2px}.gpu-component-head{display:flex;gap:9px;align-items:center;justify-content:space-between}.gpu-component-title{font:600 12px ui-monospace,monospace;color:#ead0a8}.gpu-component-id{display:block;font:9px ui-monospace,monospace;color:#aaadab;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}.gpu-component .gpu-art{width:82px;height:72px;margin:7px auto 4px;display:block}.gpu-dot{width:6px;height:6px;border-radius:50%;background:#6b797a;flex-shrink:0}.gpu-running .gpu-dot{background:#edbd73;box-shadow:0 0 7px #e9b46e88}.gpu-component-counts{display:flex;justify-content:space-between;gap:6px;margin-top:6px;font-size:10px;color:#a9babf}.gpu-component-counts b{font:600 15px ui-monospace,monospace;color:#f0d9b4;margin-right:3px}.gpu-component-counts span:last-child b{color:#b6c9cf;font-size:12px}.gpu-component-hint{font-size:9px;color:#c0aa8d;margin-top:8px;display:flex;justify-content:space-between}.gpu-component-hint span:last-child{font-size:13px;line-height:1}.gpu-idle-bank{margin-top:12px;padding:11px 12px;display:flex;gap:12px;align-items:center;min-height:57px}.gpu-ghost-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:3px;width:94px;flex-shrink:0}.gpu-ghost-grid i{display:block;width:8px;height:8px;border:1px solid #46545c;border-radius:1px;background:#26343c}.gpu-idle-bank b{display:block;font-size:10px;color:#a5b5bd;font-weight:500}.gpu-cache-band{margin-top:13px;padding:9px 12px;border-color:#385f59;display:flex;align-items:center;gap:12px;color:var(--gpu-teal)}.gpu-cache-band .gpu-art{width:71px;height:39px;flex-shrink:0}.gpu-cache-band b{font:11px ui-monospace,monospace;color:#9dcfc3}.gpu-cache-banks{display:flex;gap:3px;margin-left:auto}.gpu-cache-banks i{display:block;width:7px;height:21px;border:1px solid #447268;border-radius:2px;background:#203c38}.gpu-art{display:block;position:relative;pointer-events:none;color:var(--gpu-amber);overflow:hidden}.gpu-art img,.gpu-art svg{width:100%;height:100%;object-fit:contain;display:block;position:absolute;inset:0}.gpu-art svg[hidden]{display:none}.gpu-art-hbm{color:#72b8cc}.gpu-art-cache{color:var(--gpu-teal)}.gpu-art-tensor{color:var(--gpu-purple)}.gpu-art-warp{color:#a8c89c}
.gpu-legend{display:flex;gap:14px;flex-wrap:wrap;margin:10px 0 0;color:var(--gpu-muted);font-size:10px;flex-shrink:0}.gpu-legend span{display:flex;gap:5px;align-items:center}.gpu-legend i{width:7px;height:7px;border:1px solid #bfa070;background:#5a4d37;border-radius:2px}.gpu-legend span:nth-child(2) i{background:#244647;border-color:#72b8bc}.gpu-legend span:nth-child(3) i{background:transparent;border:1px dashed #8b9ba6}.gpu-footnote{font-size:10px;color:var(--gpu-muted);margin:7px 1px 0;line-height:1.6;flex-shrink:0}.gpu-scope-stats{display:flex;gap:20px;margin:0 0 16px;padding-bottom:12px;border-bottom:1px solid #34454f}.gpu-stat{font-size:10px;color:var(--gpu-muted)}.gpu-stat b{font:500 21px ui-monospace,monospace;display:block;color:#e4d0ad;margin-bottom:1px}.gpu-stat:nth-child(2) b{color:#a9d3ce}.gpu-stat:nth-child(3) b{color:#a7bcc8}.gpu-sm-interior{padding:16px}.gpu-sm-interior .gpu-die-header{margin-bottom:12px}.gpu-sm-banner{display:flex;gap:15px;align-items:center;margin-bottom:15px}.gpu-sm-banner .gpu-art{width:80px;height:64px;flex-shrink:0}.gpu-sm-banner p{color:#a1b4bd;font-size:10px;margin:4px 0}.gpu-sm-banner strong{font:12px ui-monospace,monospace;color:#d7bc91}.gpu-schematic-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px}.gpu-schematic-card{padding:8px 10px;display:flex;gap:10px;align-items:center;min-height:68px}.gpu-schematic-card .gpu-art{width:60px;height:47px;flex-shrink:0}.gpu-schematic-card b{font:10px ui-monospace,monospace;color:#a9b9c2}.gpu-section-label{display:flex;align-items:center;gap:8px;color:#9aafbc;font:10px ui-monospace,monospace;letter-spacing:.06em;margin:0 0 9px}.gpu-section-label:after{content:"";height:1px;background:#3c4e59;flex:1}.gpu-pipeline-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.gpu-pipeline-grid .gpu-component{min-height:170px}.gpu-pipeline-grid .gpu-component-title{font-size:11px}.gpu-pipeline-grid .gpu-component-counts{flex-direction:column;gap:3px}.gpu-type-tensor{border-color:#655779;background:linear-gradient(145deg,#373148,#232b35)}.gpu-type-tensor .gpu-component-title,.gpu-type-tensor .gpu-component-counts b{color:#d1b6ec}.gpu-type-tensor.gpu-running{border-color:#b89adc;box-shadow:inset 0 0 18px #b89adc12,0 0 0 1px #b89adc28}.gpu-type-memory{border-color:#426975;background:linear-gradient(145deg,#263d47,#1d2a34)}.gpu-type-memory .gpu-component-title,.gpu-type-memory .gpu-component-counts b{color:#a1d8e2}.gpu-type-memory.gpu-running{border-color:#78c8d8;box-shadow:inset 0 0 18px #78c8d812,0 0 0 1px #78c8d828}.gpu-type-memory .gpu-art{color:#79bfcf}.gpu-task-dock{margin-top:9px;border-top:1px solid #33444e;padding-top:9px;max-height:128px;overflow:auto;flex-shrink:0}.gpu-task-heading{display:flex;align-items:center;justify-content:space-between;color:#a5b9c4;font-size:11px;margin:0 0 8px}.gpu-task-heading small{font:10px ui-monospace,monospace;color:#74939b}.gpu-task-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}.gpu-task{border:1px solid #3b5660;border-radius:6px;background:#192c35;text-align:left;padding:8px 9px;min-width:0;position:relative;overflow:hidden}.gpu-task.gpu-task-selected{border-color:#9ddbe3;box-shadow:inset 0 0 0 1px #9ddbe3}.gpu-task b{display:block;font:10px ui-monospace,monospace;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;font-weight:500;color:#c9e0e7}.gpu-task small{display:block;color:#8aa9b5;font-size:9px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.gpu-task-progress{position:absolute;bottom:0;left:0;height:2px;background:#75c5c7;max-width:100%}.gpu-task-empty{font-size:11px;color:#829eab;padding:6px 1px;margin:0}.gpu-extra-note{font-size:10px;color:#8aa2af;margin:8px 0 0}.gpu-track-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.gpu-track-grid .gpu-component{min-height:110px;background:#23333e;border-color:#496472}.gpu-track-grid .gpu-component-title{color:#b4d2e2}.gpu-track-grid .gpu-component-counts b{color:#b4d2e2}.gpu-track-process{grid-column:1/-1;font:11px ui-monospace,monospace;color:#9fb7c6;border-bottom:1px solid #3a4e5c;padding:12px 0 5px}.gpu-track-grid .gpu-component-id{white-space:normal;word-break:break-word}.gpu-world.gpu-hide-structure .gpu-schematic-card,.gpu-world.gpu-hide-structure .gpu-hbm-rail,.gpu-world.gpu-hide-structure .gpu-cache-band,.gpu-world.gpu-hide-structure .gpu-idle-bank,.gpu-world.gpu-hide-structure .gpu-noc{display:none}.gpu-world.gpu-hide-structure .gpu-die-layout{grid-template-columns:minmax(360px,1fr)}.gpu-world.gpu-hide-structure .gpu-schematic-row{display:none}.gpu-empty{padding:40px 20px;text-align:center;color:#8ba6b6;font-size:12px}
.gpu-toolbar{flex-shrink:0;padding-bottom:10px}.gpu-stage{flex:1;min-height:190px;max-height:none;scrollbar-gutter:stable}.gpu-noc{margin:12px 0 0;border-top:1px dashed #5b7580;text-align:center;position:relative;height:18px;color:#8da7ae;font:9px ui-monospace,monospace}.gpu-noc:before,.gpu-noc:after{content:"";position:absolute;top:-10px;height:10px;border-left:1px dashed #5b7580}.gpu-noc:before{left:25%}.gpu-noc:after{right:25%}.gpu-noc span{position:relative;top:3px;background:#1f2c35;padding:0 8px}.gpu-cache-band{margin-top:4px}.gpu-cache-band small{font-size:9px}.gpu-sm-grid .gpu-component-hint span:first-child:before{content:"SM 城市 · ";color:#e2c18d}.gpu-cta-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin-top:10px}.gpu-cta-card{border:1px solid #62745c;background:linear-gradient(145deg,#2d3c33,#253036);padding:11px;border-radius:8px;text-align:left}.gpu-cta-card strong{font:12px ui-monospace,monospace;color:#c0d7a9}.gpu-cta-card small{display:block;font-size:10px;color:#9cb3a8;margin-top:4px}.gpu-cta-card.gpu-cta-active{border-color:#a7c48e;box-shadow:inset 0 0 15px #9cbf7710}.gpu-cta-card .gpu-component-counts{margin-top:7px}.gpu-cta-card .gpu-component-counts b{color:#bfd7ad}.gpu-cta-scope{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}.gpu-cta-scope .gpu-tool{font-size:10px;padding:4px 8px}.gpu-cta-scope .gpu-tool[aria-pressed=true]{color:#d3eac4;border-color:#a3c28f;background:#344638}.gpu-cta-trace{width:100%;height:auto;display:block;border:1px solid #3f535e;border-radius:7px;background:#192832}.gpu-cta-trace text{font:9px ui-monospace,monospace;fill:#93b0bf}.gpu-cta-trace .gpu-lane-label{fill:#b7ccd6}.gpu-cta-trace .gpu-warp-event{cursor:pointer;stroke-width:.8;stroke:#1b2b34}.gpu-cta-trace .gpu-warp-event[aria-pressed=true]{stroke:#d4f5ff;stroke-width:2}.gpu-cta-trace .gpu-warp-event:focus-visible{outline:0;stroke:#d4f5ff;stroke-width:2}.gpu-cta-cursor{stroke:#f0cc8c;stroke-width:1;pointer-events:none}.gpu-producer{border:1px solid #445a65;border-radius:6px;padding:8px 10px;margin:12px 0;color:#9db4c0;font-size:10px;background:#1b2c37}.gpu-producer strong{color:#cadce6;font-weight:500}.gpu-cta-workload-label{font:10px ui-monospace,monospace;color:#abc8b6;margin:12px 0 8px}.gpu-depth-hint{font-size:9px;color:#85a0ad;margin:0 0 8px}
.gpu-camera{position:relative;margin:0 auto}.gpu-scene{position:absolute;top:0;left:0;transform-origin:top left;transition:none;min-width:0}.gpu-stage{min-height:140px;scrollbar-gutter:auto}.gpu-layout-label{margin-bottom:10px}.gpu-legend{gap:10px;font-size:9px}.gpu-footnote{font-size:9px;line-height:1.45}.gpu-sm-grid .gpu-component .gpu-art{height:68px}.gpu-world:not(.gpu-hide-structure) .gpu-cache-band .gpu-art{width:60px}
.gpu-world:fullscreen{padding:24px;background:#101922;width:100vw;height:100vh;overflow:hidden}.gpu-world:fullscreen .gpu-stage{min-height:300px}.gpu-world .gpu-component-title,.gpu-world .gpu-pipeline-grid .gpu-component-title{font-size:14px}.gpu-world .gpu-component-counts{font-size:13px}.gpu-world .gpu-component-counts b{font-size:16px}.gpu-world .gpu-component-counts span:last-child b{font-size:14px}.gpu-world .gpu-component-id{font-size:12px}.gpu-world .gpu-component-hint{font-size:13px}.gpu-world .gpu-die-name{font-size:14px}.gpu-world .gpu-chip-label{font-size:12px}.gpu-world .gpu-layout-label{font-size:11px;letter-spacing:.03em}.gpu-world .gpu-footnote{font-size:11px;line-height:1.5;max-height:50px;overflow:auto}.gpu-world .gpu-legend{font-size:11px;gap:9px}.gpu-world .gpu-cache-band b{font-size:14px}.gpu-world .gpu-cache-band small{font-size:13px}.gpu-world .gpu-hbm b{font-size:13px}.gpu-world .gpu-hbm small{font-size:12px}.gpu-world .gpu-schematic-card b{font-size:13px}.gpu-world .gpu-schematic-card small{font-size:13px}.gpu-world .gpu-sm-banner strong{font-size:14px}.gpu-world .gpu-sm-banner p{font-size:13px}.gpu-world .gpu-section-label{font-size:13px;letter-spacing:.02em}.gpu-world .gpu-producer,.gpu-world .gpu-extra-note{font-size:13px}.gpu-world .gpu-cta-card strong{font-size:14px}.gpu-world .gpu-cta-card small{font-size:13px}.gpu-world .gpu-cta-scope .gpu-tool{font-size:13px}.gpu-world .gpu-cta-trace text{font-size:13px}.gpu-world .gpu-cta-workload-label{font-size:13px}.gpu-world .gpu-stat{font-size:13px}.gpu-world .gpu-task b{font-size:12px}.gpu-world .gpu-task small{font-size:11px}.gpu-world .gpu-task-heading{font-size:12px}.gpu-world .gpu-task-empty{font-size:13px}
.gpu-world.gpu-overview .gpu-scene{padding:13px}.gpu-world.gpu-overview .gpu-die-layout{grid-template-columns:66px minmax(0,1fr) 66px;gap:9px}.gpu-world.gpu-overview .gpu-die{padding:12px}.gpu-world.gpu-overview .gpu-die-header{margin-bottom:10px;flex-wrap:wrap;gap:4px}.gpu-world.gpu-overview .gpu-sm-grid{gap:8px}.gpu-world.gpu-overview .gpu-component{display:grid;grid-template-columns:55px minmax(0,1fr);gap:2px 7px;padding:9px;min-height:106px}.gpu-world.gpu-overview .gpu-component-head{grid-column:2;align-items:flex-start}.gpu-world.gpu-overview .gpu-component .gpu-art{grid-column:1;grid-row:1/4;width:55px;height:64px;margin:8px 0 0}.gpu-world.gpu-overview .gpu-component-counts{grid-column:2;flex-direction:column;gap:0;margin-top:2px;white-space:nowrap}.gpu-world.gpu-overview .gpu-component-hint{grid-column:2;font-size:12px;margin-top:2px}.gpu-world.gpu-overview .gpu-component-hint span:first-child:before{content:""}.gpu-world.gpu-overview .gpu-component-hint span:first-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.gpu-world.gpu-overview .gpu-component-id{font-size:11px}.gpu-world.gpu-overview .gpu-ghost-grid{display:none}.gpu-world.gpu-overview .gpu-idle-bank{padding:7px 9px;min-height:0;margin-top:8px}.gpu-world.gpu-overview .gpu-idle-bank b{font-size:13px}.gpu-world.gpu-overview .gpu-idle-bank small{display:none}.gpu-world.gpu-overview .gpu-hbm{min-height:0;padding:9px 2px}.gpu-world.gpu-overview .gpu-hbm .gpu-art{width:59px;height:85px}.gpu-world.gpu-overview .gpu-hbm small{font-size:11px}.gpu-world.gpu-overview .gpu-cache-band{padding:6px 9px;gap:8px}.gpu-world.gpu-overview .gpu-cache-band .gpu-art{height:35px;width:46px}.gpu-world.gpu-overview .gpu-cache-band small{display:none}.gpu-world.gpu-overview .gpu-cache-banks{display:none}.gpu-world.gpu-overview .gpu-noc{height:16px;margin-top:11px;font-size:11px}.gpu-world.gpu-overview .gpu-noc span{top:1px}.gpu-world.gpu-overview .gpu-layout-label span:last-child{display:none}.gpu-world.gpu-overview .gpu-layout-label{margin-bottom:8px}.gpu-world .gpu-sm-interior .gpu-pipeline-grid .gpu-component .gpu-art{height:57px}.gpu-world .gpu-sm-interior .gpu-pipeline-grid .gpu-component{min-height:180px}
@media(max-width:760px){.gpu-toolbar{gap:8px}.gpu-scene{padding:13px}.gpu-controls{gap:4px}.gpu-switch{font-size:10px!important;padding:5px 7px}.gpu-task-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.gpu-crumb-current{max-width:170px}}
@media(prefers-reduced-motion:reduce){.gpu-world *{transition:none!important}}
`;

/** container owns the world; callbacks receive native ids (or null to clear).
 * update is safe on every playback tick and preserves camera/DOM focus. */
export function createGpuWorld(container, {onSelectComponent = () => {}, onSelectEvent = () => {}, onSelectScope = () => {}} = {}) {
  const root = element("div", "gpu-world");
  const style = element("style"); style.textContent = CSS + GPU_BOX_SCENE_CSS;
  const toolbar = element("div", "gpu-toolbar");
  const breadcrumb = element("nav", "gpu-breadcrumb"); breadcrumb.setAttribute("aria-label", "GPU 结构层级");
  const controls = element("div", "gpu-controls");
  const stage = element("div", "gpu-stage"); stage.setAttribute("aria-label", "GPU 结构示意与原生事件状态，向下滚动深入、向上返回，也可使用层级按钮"); stage.tabIndex = 0;
  const scene = element("div", "gpu-scene");
  const camera = element("div", "gpu-camera");
  const legend = element("div", "gpu-legend");
  for (const text of ["实线模块 · Trace 组件", "任务计数 · 原生事件区间", "虚线模块 · 未观测示意"]) {
    const item = element("span"); item.append(element("i"), document.createTextNode(text)); legend.append(item);
  }
  const footnote = element("p", "gpu-footnote");
  const dock = element("div", "gpu-task-dock");
  camera.append(scene); stage.append(camera); toolbar.append(breadcrumb, controls);
  root.append(style, toolbar, stage, legend, footnote, dock); container.replaceChildren(root);

  let trace = null, index = indexComponents(null), view = {time: 0, selectedComponentId: null, selectedEventId: null, scope: null};
  let drillSmId = null, cta = null, zoom = 1, wholeMap = false, showStructure = true, showTasks = false, stats = null, lastWheel = -Infinity, cursor = null;
  let presentation = "boxes", boxScene = null;
  const statNodes = new Map();
  const zoomLevels = [.75, 1, 1.25, 1.5, 2];
  const zoomLabel = element("span", "gpu-zoom-label", "100%");
  const presentationControls = element("div", "gpu-presentation");
  presentationControls.setAttribute("role", "group"); presentationControls.setAttribute("aria-label", "GPU 可视化形式");
  const boxSwitch = button("立体盒子", "gpu-tool gpu-switch", () => setPresentation("boxes"), "等距盒子 GPU 城市：组件、源事件活动与进度");
  const flatSwitch = button("结构图", "gpu-tool gpu-switch", () => setPresentation("structure"), "查看平面组件结构与美术素材");
  boxSwitch.dataset.gpuPresentationChoice = "boxes"; flatSwitch.dataset.gpuPresentationChoice = "structure";
  presentationControls.append(boxSwitch, flatSwitch);
  function setPresentation(value) {
    presentation = value; wholeMap = false; zoom = 1;
    renderScene(); stage.scrollTo({top: 0, left: 0});
  }
  const structureSwitch = button("结构注释", "gpu-tool gpu-switch", () => {
    showStructure = !showStructure; root.classList.toggle("gpu-hide-structure", !showStructure);
    structureSwitch.setAttribute("aria-pressed", String(showStructure));
    fitScene();
  }, "显示或隐藏未观测的结构示意，不改变 Trace 数据");
  structureSwitch.setAttribute("aria-pressed", "true");
  const taskSwitch = button("进行中任务", "gpu-tool gpu-switch", () => {
    showTasks = !showTasks; taskSwitch.setAttribute("aria-pressed", String(showTasks)); renderTasks();
  }, "显示或隐藏当前范围内的进行中事件");
  taskSwitch.setAttribute("aria-pressed", "false");
  const zoomOut = button("−", "gpu-tool gpu-tool-small", () => setZoom(zoomLevels[Math.max(0, zoomLevels.indexOf(zoom) - 1)]), "缩小 GPU 视图");
  const zoomIn = button("+", "gpu-tool gpu-tool-small", () => setZoom(zoomLevels[Math.min(zoomLevels.length - 1, zoomLevels.indexOf(zoom) + 1)]), "放大 GPU 视图");
  const fit = button("复位", "gpu-tool gpu-switch", () => { wholeMap = false; setZoom(1); stage.scrollTo({top: 0, left: 0}); }, "恢复可读比例，较高的细节图可纵向滚动");
  const mapFit = button("全图", "gpu-tool gpu-switch", () => {wholeMap = true; setZoom(1); stage.scrollTo({top: 0, left: 0});}, "将完整画布缩至可见范围；复位可恢复可读比例");
  const fullscreen = button("展开", "gpu-tool gpu-switch", async () => {
    try {
      if (document.fullscreenElement === root) await document.exitFullscreen();
      else await root.requestFullscreen();
    } catch (error) {fullscreen.title = `浏览器未允许全屏：${error.message}`;}
  }, "全屏展开画布，按 Esc 或再次点击退出");
  fullscreen.disabled = typeof root.requestFullscreen !== "function";
  function fullscreenChanged() {fullscreen.textContent = document.fullscreenElement === root ? "收起" : "展开"; fitScene();}
  document.addEventListener("fullscreenchange", fullscreenChanged);
  controls.append(presentationControls, structureSwitch, taskSwitch, zoomOut, zoomLabel, zoomIn, fit, mapFit, fullscreen);

  function setZoom(value) {
    zoom = value; fitScene();
    zoomLabel.textContent = `${Math.round(value * 100)}%`;
    zoomOut.disabled = value === zoomLevels[0]; zoomIn.disabled = value === zoomLevels.at(-1);
  }

  function fitScene() {
    if (!stage.clientWidth || !stage.clientHeight) return;
    const nativeBoxes = presentation === "boxes" && index.mode === "architecture" && !cta && index.sms.length > 0;
    const naturalWidth = Math.max(nativeBoxes ? 280 : 590, stage.clientWidth - 2);
    scene.style.width = `${naturalWidth}px`;
    const naturalHeight = Math.max(1, scene.offsetHeight);
    const scale = worldCameraScale({width: stage.clientWidth - 2, height: stage.clientHeight - 2,
      naturalWidth, naturalHeight, detail: nativeBoxes || Boolean(drillSmId) || index.mode === "tracks", wholeMap, zoom});
    scene.style.transform = `scale(${scale})`;
    camera.style.width = `${naturalWidth * scale}px`; camera.style.height = `${naturalHeight * scale}px`;
  }

  const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(fitScene) : null;
  resizeObserver?.observe(stage);

  function nearestSm(id) {
    const visited = new Set();
    while (index.byId.has(id) && !visited.has(id)) {
      visited.add(id);
      if (index.byId.get(id).kind === "sm") return id;
      id = index.byId.get(id).parentId;
    }
    return null;
  }

  function chooseComponent(id, drill = true) {
    view.selectedComponentId = id;
    if (drill) {drillSmId = nearestSm(id); cta = null; view.scope = null; wholeMap = false; zoom = 1;}
    renderScene(); renderTasks();
    if (drill) stage.scrollTo({top: 0, left: 0});
    onSelectComponent(id);
    if (drill) onSelectScope(null);
  }

  function chooseCta(group, warpId = undefined) {
    drillSmId = group.smComponentId;
    cta = group;
    wholeMap = false; zoom = 1;
    view.selectedComponentId = group.smComponentId;
    view.scope = {smId: group.smId ?? group.smComponentId, threadBlockId: group.threadBlockId};
    if (warpId !== undefined) view.scope.warpId = warpId;
    const scope = {...view.scope};
    renderScene(); renderTasks();
    stage.scrollTo({top: 0, left: 0});
    onSelectComponent(group.smComponentId); onSelectScope(scope);
  }

  function parentLevel() {
    if (cta) chooseComponent(drillSmId);
    else if (drillSmId) chooseComponent(null);
  }

  function childLevel(target) {
    if (index.mode !== "architecture" || cta) return false;
    if (!drillSmId) {
      const hovered = target.closest("[data-gpu-component-id]")?.dataset.gpuComponentId;
      const selected = nearestSm(view.selectedComponentId);
      const first = index.sms.find(sm => stats.byId.get(sm.id)?.active > 0) ?? index.sms[0];
      const id = nearestSm(hovered) ?? selected ?? first?.id;
      if (id) {chooseComponent(id); return true;}
    } else {
      const groups = groupCtas(index, drillSmId, view.time);
      const hovered = target.closest("[data-gpu-cta-id]")?.dataset.gpuCtaId;
      const group = groups.find(group => String(group.threadBlockId) === hovered) ?? groups.find(group => group.active > 0) ?? groups[0];
      if (group) {chooseCta(group); return true;}
    }
    return false;
  }

  function wheel(event) {
    if (event.ctrlKey || event.metaKey || event.altKey || index.mode !== "architecture" || !trace || !event.deltaY) return;
    // Native scrolling remains available when content overflows. At its boundary,
    // one deliberate gesture changes the observation level, never the timing model.
    const downward = event.deltaY > 0;
    const canScroll = downward ? stage.scrollTop + stage.clientHeight < stage.scrollHeight - 2 : stage.scrollTop > 2;
    const onPortal = event.target.closest("[data-gpu-component-id], [data-gpu-cta-id]");
    if (canScroll && !onPortal) return;
    const canChange = downward ? !cta && (!drillSmId ? index.sms.length : groupCtas(index, drillSmId, view.time).length) : Boolean(drillSmId);
    if (!canChange) return;
    event.preventDefault();
    const now = performance.now();
    if (now - lastWheel < 750) return;
    lastWheel = now;
    if (downward) childLevel(event.target); else parentLevel();
    stage.scrollTop = 0;
  }
  stage.addEventListener("wheel", wheel, {passive: false});

  function counters(id, classes = "gpu-component-counts") {
    const row = element("div", classes), active = element("b"), completed = element("b");
    const left = element("span"), right = element("span");
    left.append(active, document.createTextNode("进行中")); right.append(completed, document.createTextNode("区间已结束"));
    row.append(left, right);
    if (!statNodes.has(id)) statNodes.set(id, []);
    statNodes.get(id).push({active, completed});
    return row;
  }

  function componentCard(component, kind = "sm") {
    const type = kind === "pipeline" ? pipelineType(component) : kind;
    const card = button("", `gpu-component gpu-type-${type}`, () => chooseComponent(component.id, kind !== "pipeline"));
    card.dataset.gpuComponentId = component.id;
    card.setAttribute("aria-pressed", String(view.selectedComponentId === component.id));
    const header = element("div", "gpu-component-head"), titles = element("span");
    const name = kind === "pipeline" ? component.label.split("/").at(-1).trim() : component.label;
    titles.append(element("span", "gpu-component-title", name), element("span", "gpu-component-id", component.id));
    header.append(titles, element("i", "gpu-dot"));
    card.append(header);
    if (kind !== "track") card.append(artwork(type === "tensor" ? "tensor" : type === "memory" ? "warp" : "sm"));
    card.append(counters(component.id));
    const hint = element("div", "gpu-component-hint");
    hint.append(element("span", "", kind === "sm" ? "进入 SM · 检查流水线" : "选择组件 · 联动时间线"), element("span", "", "↗"));
    card.append(hint);
    return card;
  }

  function unobservedCard(type, title, detail, className = "gpu-schematic-card") {
    const card = element("div", `gpu-unobserved ${className}`);
    card.append(artwork(type));
    const text = element("div"); text.append(element("b", "", title), element("small", "", detail)); card.append(text);
    card.title = "结构示意：当前 Trace 没有提供该组件的独立事件或计数";
    return card;
  }

  function makeBreadcrumb() {
    breadcrumb.replaceChildren();
    if (drillSmId) breadcrumb.append(button("←", "gpu-back", parentLevel, cta ? "返回 SM 城市" : "返回 GPU 总览"));
    breadcrumb.append(button(index.mode === "tracks" ? "Profile 轨道" : "GPU 总览", "gpu-crumb-root", () => chooseComponent(null)));
    if (drillSmId) {
      breadcrumb.append(element("span", "", "/"));
      if (cta) breadcrumb.append(button(index.byId.get(drillSmId)?.label ?? drillSmId, "gpu-crumb-root", () => chooseComponent(drillSmId)), element("span", "", "/"), element("span", "gpu-crumb-current", `CTA ${cta.threadBlockId}`));
      else breadcrumb.append(element("span", "gpu-crumb-current", index.byId.get(drillSmId)?.label ?? drillSmId));
    }
    else breadcrumb.append(element("span", "gpu-crumb-current", index.mode === "tracks" ? "原生层级" : "Die Explorer"));
  }

  function scopeStats(id) {
    const row = element("div", "gpu-scope-stats");
    for (const [label, key] of [["进行中事件", "active"], ["区间已结束", "completed"], ["记录内总事件", "total"]]) {
      const item = element("div", "gpu-stat"), value = element("b");
      item.append(value, document.createTextNode(label)); row.append(item);
      if (!statNodes.has(id)) statNodes.set(id, []);
      statNodes.get(id).push({[key]: value});
    }
    return row;
  }

  function boxEvents() {
    return new Map([...index.intervals].map(([id, interval]) => [id, interval.events]));
  }
  function renderBoxOverview() {
    const gpu = index.gpus[0];
    const label = element("div", "gpu-layout-label");
    label.append(element("strong", "", gpu?.label ?? "GPU / COMPUTE DISTRICT"),
      element("span", "gpu-box-level-tag", `已记录 ${index.sms.length} SM${index.physicalSms === null ? "" : ` / 配置 ${index.physicalSms} SM`}`));
    scene.append(label);
    boxScene = createGpuBoxScene({components: index.sms, eventsById: boxEvents(), configuredSms: index.physicalSms,
      title: gpu?.label ?? "GPU", onSelectComponent: id => chooseComponent(id)});
    scene.append(boxScene.element);
    footnote.textContent = "点击 SM 城市深入；滚轮向下进入、向上返回。盒子的布局、尺寸与屋顶格子为示意，外围 HBM 与共享 L2 没有独立观测。光点只回放源事件自己的区间进度，连线不表示请求流量。";
  }
  function appendCtaCards(parent, sm) {
    const groups = groupCtas(index, sm.id, view.time);
    parent.append(element("div", presentation === "boxes" ? "gpu-box-sm-cta-label" : "gpu-section-label", "CTA / 调度到城市的工作负载"));
    if (groups.length) {
      const ctas = element("div", "gpu-cta-grid");
      for (const group of groups) {
        const card = button("", "gpu-cta-card", () => chooseCta(group));
        card.dataset.gpuCtaId = String(group.threadBlockId);
        card.classList.toggle("gpu-cta-active", group.active > 0);
        card.append(element("strong", "", `CTA ${group.threadBlockId}  ↗`),
          element("small", "", `${group.warpIds.length} 个原生 warp ID · ${group.total} 个操作区间`));
        const counts = element("div", "gpu-component-counts");
        const active = element("span"), completed = element("span");
        active.append(element("b", "", String(group.active)), document.createTextNode("进行中"));
        completed.append(element("b", "", String(group.completed)), document.createTextNode("区间已结束"));
        counts.append(active, completed); card.append(counts); ctas.append(card);
      }
      parent.append(ctas);
    } else parent.append(element("p", "gpu-task-empty", "当前 Trace 没有提供 threadBlockId，保留已有流水线粒度。"));
  }
  function renderBoxSm() {
    const sm = index.byId.get(drillSmId);
    const label = element("div", "gpu-layout-label");
    label.append(element("strong", "", `${sm.label} / EXECUTION DISTRICT`), element("span", "", "实线盒子 · 原生流水线分组")); scene.append(label, scopeStats(sm.id));
    boxScene = createGpuBoxScene({components: index.children.get(sm.id) ?? [], eventsById: boxEvents(), level: "sm", title: sm.label,
      onSelectComponent: id => chooseComponent(id, false)});
    scene.append(boxScene.element);
    appendCtaCards(scene, sm);
    footnote.textContent = "实线盒子对应来源中的 LD / ST / Tensor 等流水线分组；亮边与进度标记按原始 [start, end) 区间更新。Scheduler、L1 / Shared 仅为静态结构示意。选择 CTA 可继续检查 warp 与 tile 操作。";
  }

  function renderOverview() {
    if (presentation === "boxes" && index.sms.length) {renderBoxOverview(); return;}
    const gpu = index.gpus[0];
    const label = element("div", "gpu-layout-label");
    label.append(element("strong", "", "GPU PACKAGE / STRUCTURAL MAP"), element("span", "", "布局与美术为示意"));
    scene.append(label);
    const layout = element("div", "gpu-die-layout");
    for (const side of ["left", "right"]) {
      const rail = element("div", `gpu-hbm-rail gpu-rail-${side}`);
      // Repeated HBM artwork decorates the package; it does not assert a stack count.
      rail.append(unobservedCard("hbm", "HBM 仓库", "结构示意\n未观测", "gpu-hbm"));
      if (side === "left") layout.append(rail);
      else {
        const die = element("div", "gpu-die");
        const header = element("div", "gpu-die-header");
        header.append(element("span", "gpu-die-name", gpu?.label ?? "GPU trace topology"),
          element("span", "gpu-chip-label", `${index.sms.length} SM 已列出${index.physicalSms === null ? "" : ` / 配置 ${index.physicalSms}`}`));
        die.append(header);
        const grid = element("div", "gpu-sm-grid");
        for (const sm of index.sms) grid.append(componentCard(sm));
        if (!index.sms.length) grid.append(element("p", "gpu-task-empty", "当前记录没有独立 SM 组件；下方显示其原生组件。"));
        die.append(grid);
        if (index.physicalSms !== null && index.physicalSms > index.sms.length) {
          const bank = element("div", "gpu-idle-bank gpu-unobserved");
          const ghost = element("div", "gpu-ghost-grid"); ghost.setAttribute("aria-hidden", "true");
          for (let tile = 0; tile < 24; tile++) ghost.append(element("i"));
          const message = element("div"); message.append(element("b", "", `其余 ${index.physicalSms - index.sms.length} 个配置 SM 未列入记录`),
            element("small", "", "仅展示数量关系 · 不推断其活动状态或物理位置")); bank.append(ghost, message); die.append(bank);
        }
        const noc = element("div", "gpu-noc"); noc.append(element("span", "", "NoC · 共享物流连接示意 / 未观测请求")); die.append(noc);
        const cache = unobservedCard("cache", "L2 · 共享集装箱物流中心", "结构示意 · 未提供独立 cache 事件、流量或命中率", "gpu-cache-band");
        const banks = element("div", "gpu-cache-banks"); banks.setAttribute("aria-hidden", "true");
        for (let cell = 0; cell < 6; cell++) banks.append(element("i")); cache.append(banks); die.append(cache);
        if (!index.sms.length) for (const component of index.children.get(gpu?.id) ?? []) die.append(componentCard(component, "track"));
        layout.append(die, rail);
      }
    }
    scene.append(layout);
    footnote.textContent = "SM 城市共享 L2 物流中心与 HBM 仓库；NoC 连线为结构示意。点击 SM 深入，滚动到边界可切换层级。计数按原始 [start, end) 事件区间计算，不表示利用率或观测到的请求流量。";
  }

  function renderSm() {
    if (presentation === "boxes") {renderBoxSm(); return;}
    const sm = index.byId.get(drillSmId);
    const label = element("div", "gpu-layout-label");
    label.append(element("strong", "", "STREAMING MULTIPROCESSOR / PIPELINE VIEW"), element("span", "", "Trace 原生组件")); scene.append(label, scopeStats(sm.id));
    const die = element("div", "gpu-die gpu-sm-interior");
    const banner = element("div", "gpu-sm-banner"); const text = element("div");
    text.append(element("strong", "", `${sm.label} · ${sm.id}`), element("p", "", "下方实线模块对应当前记录的流水线分组。事件为发射至完成的区间，不是单条数据包轨迹。"));
    banner.append(artwork("sm"), text); die.append(banner);
    const structural = element("div", "gpu-schematic-row");
    structural.append(unobservedCard("scheduler", "WARP SCHEDULER", "结构示意 · 调度状态未观测"), unobservedCard("cache", "L1 / SHARED MEMORY", "结构示意 · 访问与占用未观测")); die.append(structural);
    die.append(element("div", "gpu-section-label", "OBSERVED PIPELINE GROUPS"));
    const pipelines = element("div", "gpu-pipeline-grid");
    for (const component of index.children.get(sm.id) ?? []) pipelines.append(componentCard(component, "pipeline"));
    if (!pipelines.childElementCount) pipelines.append(element("p", "gpu-task-empty", "当前 SM 没有更细粒度的组件。原始事件仍可在时间线检查。"));
    die.append(pipelines);
    appendCtaCards(die, sm);
    scene.append(die);
    footnote.textContent = "SM 是执行城市，CTA 是派到城市的工作负载，tile 是操作的数据窗口。点击 CTA 查看 warp / tile 操作；LD / ST 区间不展开成推测的 cache 或 HBM 事务。";
  }

  function renderCta() {
    const group = groupCtas(index, drillSmId, view.time).find(group => group.threadBlockId === cta.threadBlockId);
    if (!group) {cta = null; renderSm(); return;}
    cta = group;
    const label = element("div", "gpu-layout-label");
    label.append(element("strong", "", "CTA WORKLOAD / WARP & TILE OPERATIONS"), element("span", "", "按原始归属分组")); scene.append(label);
    const die = element("div", "gpu-die gpu-sm-interior");
    const banner = element("div", "gpu-sm-banner"), title = element("div");
    title.append(element("strong", "", `${index.byId.get(drillSmId)?.label ?? drillSmId} / CTA ${group.threadBlockId}`), element("p", "", `${group.total} 个原生操作区间 · ${group.warpIds.length} 个 warp ID；CTA 不是独立硬件组件，tile 不等同于 CTA。`));
    banner.append(artwork("warp"), title); die.append(banner);
    const producer = element("div", "gpu-producer");
    producer.append(element("strong", "", trace.meta.producer), document.createTextNode(" · 当前展示来源的操作区间；CTA / warp 由 args 归属分组。Accel-Sim / GPGPU-Sim 的逐周期执行后端尚未接入。")); die.append(producer);
    const warpControls = element("div", "gpu-cta-scope");
    warpControls.append(element("span", "gpu-cta-workload-label", "WARP SCOPE"));
    const all = button("全部 warp", "gpu-tool", () => chooseCta(group));
    all.setAttribute("aria-pressed", String(view.scope?.warpId === undefined)); warpControls.append(all);
    for (const warpId of group.warpIds) {
      const choice = button(`warp ${warpId}`, "gpu-tool", () => chooseCta(group, warpId));
      choice.setAttribute("aria-pressed", String(view.scope?.warpId === warpId)); warpControls.append(choice);
    }
    die.append(warpControls);
    const events = group.events.filter(event => view.scope?.warpId === undefined || event.args?.warpId === view.scope.warpId);
    const lanes = new Map();
    for (const event of events) {
      const key = `warp ${event.args?.warpId ?? "?"} / ${event.category ?? index.byId.get(event.componentId)?.label ?? event.componentId}`;
      if (!lanes.has(key)) lanes.set(key, []);
      lanes.get(key).push(event);
    }
    const laneEntries = [...lanes.entries()].slice(0, 24);
    const width = 660, left = 128, plotWidth = 510, top = 35, rowHeight = 31, height = top + laneEntries.length * rowHeight + 16;
    const chart = vector("svg", {viewBox: `0 0 ${width} ${height}`, class: "gpu-cta-trace", role: "group", "aria-label": "CTA 原生操作区间，按 warp 和类别分轨"});
    const start = group.events.reduce((value, event) => Math.min(value, event.start), Infinity);
    const end = group.events.reduce((value, event) => Math.max(value, event.end), -Infinity);
    const x = value => left + (value - start) / (end - start || 1) * plotWidth;
    for (let tick = 0; tick <= 4; tick++) {
      const value = start + (end - start) * tick / 4;
      chart.append(vector("line", {x1: x(value), x2: x(value), y1: 24, y2: height - 8, stroke: "#334a58", "stroke-width": .6}));
      const text = vector("text", {x: x(value), y: 16, "text-anchor": tick === 4 ? "end" : "start"}); text.textContent = value.toLocaleString(undefined, {maximumFractionDigits: 2}); chart.append(text);
    }
    laneEntries.forEach(([key, lane], laneIndex) => {
      const y = top + rowHeight * laneIndex;
      const text = vector("text", {x: 9, y: y + 13, class: "gpu-lane-label"}); text.textContent = key.length > 22 ? `${key.slice(0, 21)}…` : key;
      chart.append(text, vector("line", {x1: 0, x2: width, y1: y + 24, y2: y + 24, stroke: "#2b3e4a", "stroke-width": .6}));
      for (const event of lane.slice(0, 400)) {
        const type = pipelineType(index.byId.get(event.componentId) ?? {id: "", label: event.category ?? ""});
        const span = vector("rect", {x: x(event.start), y, width: Math.max(2, x(event.end) - x(event.start)), height: 17, rx: 2,
          fill: type === "tensor" ? "#9273b9" : type === "memory" ? "#5695a7" : "#ab8b58", class: "gpu-warp-event", tabindex: 0, role: "button",
          "data-gpu-warp-event-id": event.id, "aria-label": `${event.name}，${event.start} 至 ${event.end} ${trace.meta.timeUnit}`, "aria-pressed": String(view.selectedEventId === event.id)});
        const tip = vector("title"); tip.textContent = `${event.name}\n${event.start} → ${event.end} ${trace.meta.timeUnit}`; span.append(tip);
        const choose = () => {view.selectedEventId = event.id; patchCounters(); onSelectEvent(event.id);};
        span.addEventListener("click", choose); span.addEventListener("keydown", event => {if (event.key === "Enter" || event.key === " ") {event.preventDefault(); choose();}}); chart.append(span);
      }
    });
    cursor = vector("line", {x1: x(view.time), x2: x(view.time), y1: 24, y2: height - 8, class: "gpu-cta-cursor"});
    cursor.dataset.start = start; cursor.dataset.end = end; chart.append(cursor); die.append(chart);
    die.append(element("p", "gpu-extra-note", `原始时间单位：${trace.meta.timeUnit}；同一轨道的重叠区间可能遮叠，精确事件与依赖请在下方时间线检查。每轨最多展示 400 个区间。`));
    const tileWindows = new Set(events.filter(event => event.args?.tile).map(event => {
      const tile = event.args.tile; return `${tile.rows}×${tile.cols} @ (${tile.rowOffset}, ${tile.colOffset})`;
    }));
    if (tileWindows.size) {
      die.append(element("div", "gpu-cta-workload-label", `${tileWindows.size} 个不同 TILE 数据窗口（原始 args.tile）`), element("p", "gpu-extra-note", [...tileWindows].slice(0, 8).join(" · ") + (tileWindows.size > 8 ? " …" : "")));
    }
    scene.append(die);
    footnote.textContent = "这一级仍回放同一份来源数据，改变观测范围不改变时序。CTA / warp 分组不构成可重启的逐周期模型；下一阶段可接入保留完整机器状态与语义的仿真后端。";
  }

  function renderTracks() {
    const label = element("div", "gpu-layout-label");
    label.append(element("strong", "", "PROFILE / NATIVE TRACKS"), element("span", "", "保留 process / thread 层级")); scene.append(label);
    const grid = element("div", "gpu-track-grid");
    let count = 0;
    const queue = [...(index.children.get(null) ?? [])];
    const visited = new Set();
    while (queue.length && count < 120) {
      const component = queue.shift();
      if (visited.has(component.id)) continue; visited.add(component.id);
      const nested = index.children.get(component.id) ?? [];
      if (nested.length) {
        grid.append(element("div", "gpu-track-process", `${component.label} · ${component.id}`));
        if (index.intervals.get(component.id).events.some(event => event.componentId === component.id)) grid.append(componentCard(component, "track"));
        queue.unshift(...nested);
      } else grid.append(componentCard(component, "track"));
      count++;
    }
    scene.append(grid);
    if (index.components.length > count) scene.append(element("p", "gpu-extra-note", `结构视图显示前 ${count} / ${index.components.length} 个组件，全部事件仍保留在时间线与左侧树。`));
    footnote.textContent = "Profile 轨道不等同于物理 SM。这里保留来源中的组件、process 与 thread 标识，不把 stream、kernel 或 CPU 轨道映射成推测的 GPU 硬件单元。";
  }

  function renderScene() {
    const focused = scene.contains(document.activeElement) ? document.activeElement.dataset.gpuComponentId : null;
    statNodes.clear(); cursor = null; boxScene = null; scene.replaceChildren(); makeBreadcrumb();
    root.classList.toggle("gpu-overview", index.mode === "architecture" && !drillSmId);
    root.classList.toggle("gpu-box-mode", presentation === "boxes" && index.mode === "architecture" && !cta);
    root.dataset.gpuPresentation = presentation;
    root.dataset.gpuLevel = cta ? "cta" : drillSmId ? "sm" : index.mode === "tracks" ? "tracks" : "gpu";
    boxSwitch.setAttribute("aria-pressed", String(presentation === "boxes"));
    flatSwitch.setAttribute("aria-pressed", String(presentation === "structure"));
    boxSwitch.disabled = flatSwitch.disabled = index.mode === "tracks";
    if (!trace) scene.append(element("p", "gpu-empty", "加载 Trace 后，在这里探索 GPU 结构与进行中的任务。"));
    else if (index.mode === "tracks") renderTracks();
    else if (cta && drillSmId && index.byId.has(drillSmId)) renderCta();
    else if (drillSmId && index.byId.has(drillSmId)) renderSm();
    else renderOverview();
    patchCounters();
    setZoom(zoom);
    if (focused) [...scene.querySelectorAll("[data-gpu-component-id]")].find(node => node.dataset.gpuComponentId === focused)?.focus({preventScroll: true});
  }

  function patchCounters() {
    if (!stats) return;
    boxScene?.update({byId: stats.byId, time: view.time, selectedComponentId: view.selectedComponentId});
    for (const [id, nodes] of statNodes) {
      const value = stats.byId.get(id);
      if (value) for (const group of nodes) for (const key of ["active", "completed", "total"]) if (group[key]) group[key].textContent = value[key].toLocaleString();
    }
    for (const node of scene.querySelectorAll("[data-gpu-component-id]")) {
      const id = node.dataset.gpuComponentId, value = stats.byId.get(id);
      node.classList.toggle("gpu-running", value?.active > 0);
      node.classList.toggle("gpu-selected", view.selectedComponentId === id);
      node.setAttribute("aria-pressed", String(view.selectedComponentId === id));
      node.setAttribute("aria-label", `${index.byId.get(id)?.label ?? id}，${value?.active ?? 0} 个进行中，${value?.completed ?? 0} 个区间已结束，${index.byId.get(id)?.kind === "sm" ? "进入 SM" : "选择组件"}`);
    }
    if (drillSmId && !cta) {
      const groups = groupCtas(index, drillSmId, view.time);
      for (const node of scene.querySelectorAll("[data-gpu-cta-id]")) {
        const group = groups.find(group => String(group.threadBlockId) === node.dataset.gpuCtaId);
        if (!group) continue;
        node.classList.toggle("gpu-cta-active", group.active > 0);
        const values = node.querySelectorAll(".gpu-component-counts b");
        values[0].textContent = group.active.toLocaleString(); values[1].textContent = group.completed.toLocaleString();
      }
    }
    if (cursor) {
      const start = Number(cursor.dataset.start), end = Number(cursor.dataset.end);
      const x = 128 + (view.time - start) / (end - start || 1) * 510;
      cursor.setAttribute("x1", x); cursor.setAttribute("x2", x);
      cursor.hidden = view.time < start || view.time > end;
    }
    for (const span of scene.querySelectorAll("[data-gpu-warp-event-id]")) span.setAttribute("aria-pressed", String(view.selectedEventId === span.dataset.gpuWarpEventId));
  }

  function renderTasks() {
    const focused = dock.contains(document.activeElement) ? document.activeElement.dataset.gpuEventId : null;
    dock.hidden = !showTasks || !trace;
    if (!showTasks || !trace) return;
    const scopeId = view.selectedComponentId ?? drillSmId;
    const scopedEvents = scopeId ? index.intervals.get(scopeId)?.events ?? [] : trace.events;
    const events = view.scope ? scopedEvents.filter(event => event.args?.threadBlockId === view.scope.threadBlockId &&
      (view.scope.warpId === undefined || event.args?.warpId === view.scope.warpId)) : scopedEvents;
    const active = events.filter(event => event.start <= view.time && view.time < event.end);
    dock.replaceChildren();
    const heading = element("div", "gpu-task-heading");
    heading.append(element("span", "", `${scopeId ? index.byId.get(scopeId)?.label ?? scopeId : "全部组件"} · ${active.length.toLocaleString()} 个进行中`), element("small", "", "NATIVE EVENT INTERVALS")); dock.append(heading);
    if (!active.length) dock.append(element("p", "gpu-task-empty", "当前时间没有进行中的事件。可用单步或时间滑块探索执行阶段。"));
    else {
      const grid = element("div", "gpu-task-grid");
      for (const event of active.slice(0, 6)) {
        const item = button("", "gpu-task", () => { view.selectedEventId = event.id; renderTasks(); onSelectEvent(event.id); });
        item.dataset.gpuEventId = event.id;
        item.setAttribute("aria-pressed", String(view.selectedEventId === event.id));
        item.classList.toggle("gpu-task-selected", view.selectedEventId === event.id);
        item.title = `${event.name}\n${event.componentId}\n${event.start} → ${event.end} ${trace.meta.timeUnit}`;
        item.append(element("b", "", event.name), element("small", "", `${event.componentId} · ${event.start} → ${event.end} ${trace.meta.timeUnit}`));
        const progress = element("span", "gpu-task-progress"); progress.style.width = `${100 * (view.time - event.start) / (event.end - event.start)}%`; progress.setAttribute("aria-hidden", "true");
        item.append(progress); grid.append(item);
      }
      dock.append(grid);
      if (active.length > 6) dock.append(element("p", "gpu-extra-note", `此处展示前 6 个，右侧任务列表保留更多事件。`));
    }
    if (focused) [...dock.querySelectorAll("[data-gpu-event-id]")].find(node => node.dataset.gpuEventId === focused)?.focus({preventScroll: true});
  }

  function setTrace(nextTrace) {
    trace = nextTrace; index = indexComponents(trace); drillSmId = null; cta = null; wholeMap = false;
    view = {time: 0, selectedComponentId: null, selectedEventId: null, scope: null};
    stats = snapshot(index, trace, view.time); setZoom(1); renderScene(); renderTasks();
  }

  function update(nextView = {}) {
    if (!trace) return;
    const previousSelection = view.selectedComponentId;
    const previousScope = JSON.stringify(view.scope);
    Object.assign(view, nextView);
    if (!Number.isFinite(view.time)) view.time = 0;
    if (view.selectedComponentId && !index.byId.has(view.selectedComponentId)) view.selectedComponentId = null;
    const newDrill = nearestSm(view.selectedComponentId);
    let drillChanged = previousSelection !== view.selectedComponentId && newDrill !== drillSmId;
    if (drillChanged) drillSmId = newDrill;
    const scopeChanged = previousScope !== JSON.stringify(view.scope);
    if (scopeChanged || drillChanged) {
      cta = null;
      if (view.scope) {
        for (const sm of index.sms) {
          const group = groupCtas(index, sm.id, view.time).find(group => group.threadBlockId === view.scope.threadBlockId &&
            (group.smId === view.scope.smId || sm.id === view.scope.smId));
          if (group) {drillSmId = sm.id; cta = group; break;}
        }
      }
      drillChanged = true;
    }
    stats = snapshot(index, trace, view.time);
    if (drillChanged) {wholeMap = false; renderScene(); stage.scrollTo({top: 0, left: 0});} else patchCounters();
    renderTasks();
  }

  setZoom(1); renderScene();
  return {setTrace, update,
    getView() {return {smComponentId: drillSmId, scope: view.scope ? {...view.scope} : null, zoom, wholeMap, showStructure, showTasks, presentation};},
    setView(saved = {}) {
      presentation = saved.presentation === "structure" ? "structure" : "boxes";
      drillSmId = index.byId.get(saved.smComponentId)?.kind === "sm" ? saved.smComponentId : null;
      wholeMap = saved.wholeMap === true;
      if (zoomLevels.includes(saved.zoom)) setZoom(saved.zoom);
      if (typeof saved.showStructure === "boolean") {showStructure = saved.showStructure; root.classList.toggle("gpu-hide-structure", !showStructure); structureSwitch.setAttribute("aria-pressed", String(showStructure));}
      if (typeof saved.showTasks === "boolean") {showTasks = saved.showTasks; taskSwitch.setAttribute("aria-pressed", String(showTasks));}
      update({scope: saved.scope ?? null}); wholeMap = saved.wholeMap === true; renderScene(); renderTasks();
    }, destroy() {stage.removeEventListener("wheel", wheel); document.removeEventListener("fullscreenchange", fullscreenChanged); resizeObserver?.disconnect(); root.remove();}};
}
