// Native SVG isometric scenery. The package floorplan is illustrative; highlights,
// counters and progress marks are derived exclusively from source event intervals.
const NS = "http://www.w3.org/2000/svg";
const PALETTES = {
  sm: {top: "#254951", left: "#122a35", right: "#173943", edge: "#72e2d1", dim: "#3e8d87"},
  tensor: {top: "#514477", left: "#28233f", right: "#393055", edge: "#c2a5ff", dim: "#8a72b2"},
  memory: {top: "#24475d", left: "#112b3f", right: "#163a4e", edge: "#74d6ff", dim: "#4e99be"},
  cache: {top: "#214d48", left: "#12312e", right: "#193e3a", edge: "#75d5b2", dim: "#488d79"},
  hbm: {top: "#383f53", left: "#1b2231", right: "#272e40", edge: "#a3b7db", dim: "#667b9c"},
  scheduler: {top: "#51462e", left: "#302b20", right: "#403723", edge: "#ecc681", dim: "#a68e5b"},
  board: {top: "#14252c", left: "#0b151d", right: "#10202a", edge: "#4b7d89", dim: "#325663"},
};

export function projectIso(x, y, z = 0, {originX = 550, originY = 135, scaleX = .8, scaleY = .4} = {}) {
  return {x: originX + (x - y) * scaleX, y: originY + (x + y) * scaleY - z};
}

/** Three exact shared faces, with z measured above the package floor. */
export function prismGeometry({x, y, width, depth, height, base = 0}, projection) {
  const p = (dx, dy, z) => projectIso(x + dx, y + dy, z, projection);
  const top = [p(0, 0, height + base), p(width, 0, height + base), p(width, depth, height + base), p(0, depth, height + base)];
  return {top, left: [top[3], top[2], p(width, depth, base), p(0, depth, base)],
    right: [top[1], top[2], p(width, depth, base), p(width, 0, base)]};
}

/** Each mark is a real active interval, not a fabricated interconnect packet. */
export function activeIntervalMarks(events, time, limit = 5) {
  const marks = [];
  if (!Number.isFinite(time) || limit <= 0) return marks;
  for (const event of events ?? []) {
    if (event.start <= time && time < event.end) {
      marks.push({id: event.id, progress: (time - event.start) / (event.end - event.start)});
      if (marks.length >= limit) break;
    }
  }
  return marks;
}

function svg(tag, attributes = {}, text) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
function html(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function points(values) { return values.map(point => `${point.x},${point.y}`).join(" "); }
function line(a, b, attributes = {}) { return svg("line", {x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...attributes}); }
function nativeKind(component) {
  const value = `${component.id} ${component.label}`.toLowerCase();
  if (value.includes("tensor")) return "tensor";
  if (/(?:\bld\b|load|\bst\b|store)/.test(value)) return "memory";
  return "sm";
}

export const GPU_BOX_SCENE_CSS = `
.gpu-world.gpu-box-mode .gpu-layout-label{flex-wrap:wrap;gap:4px}
.gpu-world.gpu-box-mode .gpu-layout-label span:last-child{display:block;font-size:11px;color:#8bb7c3}
.gpu-box-scene{position:relative;width:100%;min-width:0;isolation:isolate;--box-ink:#dceff4;--box-muted:#849aa6}
.gpu-box-visual{position:relative;overflow:hidden;border-radius:10px;background:radial-gradient(ellipse at 50% 43%,#183c465c,transparent 58%);min-width:0}
.gpu-box-svg{display:block;width:100%;height:clamp(260px,35vh,360px);overflow:visible;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;isolation:isolate}
.gpu-box-grid line{stroke:#37606b;stroke-width:1;opacity:.28}.gpu-box-trace{fill:none;stroke:#426a72;stroke-width:2;stroke-dasharray:5 7;opacity:.55}.gpu-box-base-face{stroke:#456573;stroke-width:1.5}.gpu-box-floor-label{fill:#6e96a3;font-size:14px;letter-spacing:2px}.gpu-box-component{cursor:pointer;outline:none;--box-edge:#72e2d1}
.gpu-box-component .gpu-box-edges{fill:none;stroke:var(--box-edge);stroke-width:1.25;opacity:.56;transition:opacity .2s,stroke-width .2s}.gpu-box-component .gpu-box-top{transition:filter .25s}.gpu-box-component:hover .gpu-box-edges,.gpu-box-component:focus-visible .gpu-box-edges{opacity:1;stroke-width:2.8}.gpu-box-component:hover .gpu-box-top,.gpu-box-component:focus-visible .gpu-box-top{filter:brightness(1.22)}
.gpu-box-component.gpu-running .gpu-box-edges{opacity:1;stroke-width:2;filter:drop-shadow(0 0 5px var(--box-edge))}.gpu-box-component.gpu-selected .gpu-box-edges{stroke:#e1faff;opacity:1;stroke-width:3;filter:drop-shadow(0 0 5px #8ceaff)}.gpu-box-component .gpu-box-label{fill:#d4f5f0;font-size:28px;font-weight:600;letter-spacing:.5px;paint-order:stroke;stroke:#0b1b23;stroke-width:5px;stroke-linejoin:round}.gpu-box-component .gpu-box-count{fill:#95c7cd;font-size:21px;paint-order:stroke;stroke:#0c1c24;stroke-width:4px;stroke-linejoin:round}.gpu-box-component .gpu-box-status-dot{fill:#4b7380}.gpu-box-component.gpu-running .gpu-box-status-dot{fill:var(--box-edge);filter:drop-shadow(0 0 4px var(--box-edge))}
.gpu-box-static{pointer-events:none;opacity:.86}.gpu-box-static .gpu-box-edges{fill:none;stroke:var(--box-edge);stroke-width:1.1;opacity:.65}.gpu-box-static-label{fill:#a6c5d0;font-size:24px;letter-spacing:1px;paint-order:stroke;stroke:#0d1b24;stroke-width:5px}.gpu-box-static-note{fill:#7199a7;font-size:19px;paint-order:stroke;stroke:#0d1b24;stroke-width:4px}.gpu-box-static-leader{stroke:#527784;stroke-width:1.2;fill:none}.gpu-box-front-slats{stroke:#87b9c9;stroke-width:1;opacity:.18}.gpu-box-surface-cell{stroke:var(--box-edge);stroke-width:.8;fill:var(--box-edge);fill-opacity:.04;stroke-opacity:.32}.gpu-box-mark-rail{fill:#091c25;stroke:var(--box-edge);stroke-width:1;stroke-opacity:.3}.gpu-box-mark-fill{fill:var(--box-edge);opacity:.9}.gpu-box-mark-dot{fill:#ddfcff;filter:drop-shadow(0 0 3px var(--box-edge))}.gpu-box-edge-ticks{fill:none;stroke:#71a7b6;stroke-width:1.4;opacity:.6}
.gpu-box-caption{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:-8px;padding:0 12px 12px;color:#8db2bd;font:11px/1.5 ui-monospace,monospace;letter-spacing:.03em}.gpu-box-caption b{font-weight:500;color:#a6d5da}.gpu-box-caption span:last-child{color:#6e929f;text-align:right}.gpu-box-native-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0 10px 9px}.gpu-box-native-list.gpu-box-two{grid-template-columns:repeat(2,minmax(0,1fr))}.gpu-box-native-item{min-width:0;padding:11px 13px;border:1px solid #2e4854;border-radius:7px;background:linear-gradient(130deg,#16313a99,#12242d);text-align:left;cursor:pointer;transition:border-color .2s,background .2s;--box-edge:#72e2d1}.gpu-box-native-item:hover,.gpu-box-native-item:focus-visible{border-color:#72b5bb;background:#17343e;outline:none}.gpu-box-native-item.gpu-running{border-color:color-mix(in srgb,var(--box-edge) 55%,#233b43);box-shadow:inset 3px 0 var(--box-edge)}.gpu-box-native-item.gpu-selected{outline:1px solid #9ff1f1;outline-offset:2px}.gpu-box-native-item .gpu-box-native-head{display:flex;gap:7px;align-items:center;justify-content:space-between;font:600 13px ui-monospace,monospace;color:#c7e6e9}.gpu-box-native-item .gpu-box-native-id{display:block;font:10px ui-monospace,monospace;color:#6e98a7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:5px}.gpu-box-native-item .gpu-box-native-state{font:11px ui-monospace,monospace;color:#8faeb8;margin-top:7px;display:flex;gap:10px;flex-wrap:wrap}.gpu-box-native-state b{color:#bce9e7;font-weight:600}.gpu-box-native-item .gpu-box-native-arrow{font:15px system-ui,sans-serif;color:#76c8c5}.gpu-box-native-item .gpu-box-native-mini{display:block;height:2px;background:#27444e;margin-top:8px;overflow:hidden}.gpu-box-native-mini span{display:block;height:100%;width:0;background:var(--box-edge)}
.gpu-box-missing{margin:2px 10px 8px;padding:9px 12px;border:1px dashed #36515e;border-radius:6px;display:flex;align-items:center;justify-content:space-between;gap:10px;font:11px/1.5 ui-monospace,monospace;color:#7496a5}.gpu-box-missing b{font-weight:500;color:#9bb9c4}.gpu-box-sm-cta-label{font:12px ui-monospace,monospace;letter-spacing:.06em;color:#7fadb8;margin:18px 10px 10px}.gpu-world.gpu-hide-structure .gpu-box-static,.gpu-world.gpu-hide-structure .gpu-box-trace,.gpu-world.gpu-hide-structure .gpu-box-missing{display:none}
.gpu-world.gpu-box-mode .gpu-stage{background:radial-gradient(ellipse at 50% 35%,#0e2631 0,#08141d 70%);border-color:#27414e;box-shadow:inset 0 1px #8cb8c314,inset 0 0 100px #030b1480}.gpu-world.gpu-box-mode .gpu-scene{padding:12px 10px 10px}.gpu-world.gpu-box-mode .gpu-layout-label{padding:0 10px;margin-bottom:0}.gpu-world.gpu-box-mode .gpu-legend{color:#83a6b3}.gpu-presentation{display:flex;align-items:center;padding:3px;border:1px solid #324a56;background:#0c1b25;border-radius:8px;gap:2px}.gpu-presentation .gpu-tool{border:0;border-radius:5px;background:transparent;padding:4px 9px;color:#88a7b5}.gpu-presentation .gpu-tool[aria-pressed=true]{background:#213d48;color:#b8f0ed;box-shadow:inset 0 1px #92d9dc25}.gpu-box-level-tag{font:10px ui-monospace,monospace;color:#77a8b2;letter-spacing:.1em}
@media(max-width:600px){.gpu-box-native-list{grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin:0 4px 7px}.gpu-box-native-item{padding:10px}.gpu-box-native-item .gpu-box-native-head{font-size:12px}.gpu-box-native-item .gpu-box-native-state{font-size:11px;gap:5px}.gpu-box-caption{margin-top:0;padding:5px 5px 12px;font-size:10px}.gpu-box-caption span:last-child{display:none}.gpu-box-missing{margin-left:4px;margin-right:4px;font-size:10px;display:block}.gpu-box-missing span{display:block;margin-top:2px}.gpu-box-sm-cta-label{margin-left:5px}.gpu-world.gpu-box-mode .gpu-scene{padding:9px 4px}.gpu-world.gpu-box-mode .gpu-layout-label{padding:0 5px;font-size:10px}.gpu-box-visual{min-height:180px}.gpu-box-svg{min-width:0;height:auto}.gpu-box-component .gpu-box-label{font-size:28px}.gpu-box-component .gpu-box-count{font-size:21px}.gpu-box-static-label{font-size:24px}.gpu-box-static-note{font-size:20px}}
.gpu-world:fullscreen .gpu-box-svg{height:clamp(360px,56vh,620px)}
@media(prefers-reduced-motion:reduce){.gpu-box-scene *{animation:none!important;transition:none!important}}
`;

function makePrism(group, shape, palette, {texture = false, layers = 0, projection} = {}) {
  const geometry = prismGeometry(shape, projection);
  group.style.setProperty("--box-edge", palette.edge);
  // The drop shadow is a static layer, not a running-state glow.
  const shadow = geometry.top.map(point => ({x: point.x + 10, y: point.y + shape.height + 11}));
  group.append(svg("polygon", {points: points(shadow), fill: "#020a13", opacity: .4}));
  group.append(svg("polygon", {points: points(geometry.left), fill: palette.left}),
    svg("polygon", {points: points(geometry.right), fill: palette.right}),
    svg("polygon", {points: points(geometry.top), fill: palette.top, class: "gpu-box-top"}));
  if (texture) {
    const columns = Math.min(7, Math.max(3, Math.floor(shape.width / 34))), rows = Math.min(5, Math.max(2, Math.floor(shape.depth / 40)));
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const inset = 12, gap = 7, width = (shape.width - inset * 2 - gap * (columns - 1)) / columns, depth = (shape.depth - inset * 2 - gap * (rows - 1)) / rows;
      const cell = prismGeometry({x: shape.x + inset + column * (width + gap), y: shape.y + inset + row * (depth + gap), width, depth, height: shape.height + (shape.base ?? 0) + .5}, projection).top;
      group.append(svg("polygon", {points: points(cell), class: "gpu-box-surface-cell"}));
    }
  }
  if (layers) for (let layer = 1; layer < layers; layer++) {
    const z = (shape.base ?? 0) + shape.height * layer / layers;
    const a = projectIso(shape.x, shape.y + shape.depth, z, projection), b = projectIso(shape.x + shape.width, shape.y + shape.depth, z, projection), c = projectIso(shape.x + shape.width, shape.y, z, projection);
    group.append(svg("polyline", {points: points([a, b, c]), fill: "none", stroke: palette.edge, "stroke-width": 1.3, opacity: .55}));
  }
  for (let pin = 0; pin < Math.floor(shape.width / 17); pin++) {
    const x = shape.x + 10 + pin * 17, y = shape.y + shape.depth;
    group.append(line(projectIso(x, y, (shape.base ?? 0) + 5, projection), projectIso(x, y, (shape.base ?? 0) + Math.min(shape.height - 8, 24), projection), {class: "gpu-box-front-slats"}));
  }
  const edges = svg("g", {class: "gpu-box-edges"});
  edges.append(svg("polygon", {points: points(geometry.top)}),
    svg("polyline", {points: points([geometry.top[3], geometry.left[3], geometry.left[2], geometry.right[3], geometry.top[1]])}),
    line(geometry.top[2], geometry.left[2]));
  group.append(edges);
  return geometry;
}

function attachActivation(node, action) {
  node.addEventListener("click", action);
  node.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {event.preventDefault(); action();}
  });
}

/** The SVG is paired with ordinary HTML controls for readable labels at all sizes.
 * No resource routes animate: source spans advance only their own roof markers. */
export function createGpuBoxScene({components = [], eventsById = new Map(), level = "gpu", title = "GPU", configuredSms = null,
  onSelectComponent = () => {}} = {}) {
  const root = html("section", "gpu-box-scene");
  const visual = html("div", "gpu-box-visual");
  const graphic = svg("svg", {viewBox: "0 0 1100 650", class: "gpu-box-svg", role: "group", "aria-label": `${title} 等距盒子结构示意；实线盒子可选择，虚线与外围仓库未观测`});
  const description = svg("desc", {}, "盒子的布置、尺寸、屋顶格子和 HBM 分层均为美术示意，不表示物理楼层、核心个数、容量或拓扑。只有原生组件和事件驱动活动状态。下方有相同功能的文字按钮。");
  graphic.append(description);
  const definitions = svg("defs");
  const gradient = svg("linearGradient", {id: `gpu-box-floor-${level}`, x1: "0", y1: "0", x2: "0", y2: "1"});
  gradient.append(svg("stop", {offset: "0", "stop-color": "#1c343d"}), svg("stop", {offset: "1", "stop-color": "#11222d"}));
  definitions.append(gradient); graphic.append(definitions);
  const floorShape = {x: -65, y: -40, width: 720, depth: 600, height: 18, base: -30};
  const floor = svg("g");
  const floorGeometry = makePrism(floor, floorShape, PALETTES.board);
  floor.querySelector(".gpu-box-top").setAttribute("fill", `url(#gpu-box-floor-${level})`);
  graphic.append(floor);
  const grid = svg("g", {class: "gpu-box-grid", "aria-hidden": "true"});
  for (let x = -45; x <= 640; x += 38) grid.append(line(projectIso(x, -25, -11), projectIso(x, 545, -11)));
  for (let y = -25; y <= 545; y += 38) grid.append(line(projectIso(-45, y, -11), projectIso(640, y, -11)));
  graphic.append(grid);
  const floorLabelPosition = projectIso(85, 505, -9);
  graphic.append(svg("text", {x: floorLabelPosition.x, y: floorLabelPosition.y, transform: `rotate(26.565 ${floorLabelPosition.x} ${floorLabelPosition.y})`, class: "gpu-box-floor-label"}, level === "gpu" ? "GPU // COMPUTE DISTRICT" : "SM // EXECUTION DISTRICT"));
  const connectionLayer = svg("g", {class: "gpu-box-trace", "aria-hidden": "true"});
  // Routes are static structural guides. They do not assert an observed request.
  for (const offset of [125, 375]) {
    const path = [projectIso(offset, 285, -9), projectIso(offset, 338, -9), projectIso(290, 338, -9), projectIso(290, 383, -9)];
    connectionLayer.append(svg("polyline", {points: points(path)}));
  }
  graphic.append(connectionLayer);

  const nativeRows = [], nativeGroups = [], positions = [];
  const list = html("div", "gpu-box-native-list");
  list.setAttribute("aria-label", "原生组件与当前区间计数");
  const maximum = 8, shown = components.slice(0, maximum);
  list.classList.toggle("gpu-box-two", shown.length === 2);
  const columns = shown.length < 4 ? shown.length || 1 : Math.min(4, Math.ceil(Math.sqrt(shown.length)));
  const rows = Math.ceil(shown.length / columns) || 1;
  const gap = shown.length <= 3 ? 35 : 20;
  const availableWidth = level === "gpu" ? 505 : 560;
  const availableDepth = 295;
  const width = (availableWidth - gap * (columns - 1)) / columns, depth = (availableDepth - gap * (rows - 1)) / rows;
  for (let index = 0; index < shown.length; index++) {
    const component = shown[index], kind = level === "gpu" ? "sm" : nativeKind(component), palette = PALETTES[kind];
    const shape = {x: (level === "gpu" ? 30 : 0) + (index % columns) * (width + gap), y: 40 + Math.floor(index / columns) * (depth + gap),
      width, depth, height: shown.length <= 3 ? kind === "tensor" ? 110 : kind === "memory" ? 65 : 85 : 52};
    positions.push({component, shape, palette, kind});
  }
  // Painters' order follows depth; native component order is retained in controls.
  for (const {component, shape, palette, kind} of [...positions].sort((a, b) => a.shape.x + a.shape.y - b.shape.x - b.shape.y)) {
    const group = svg("g", {class: "gpu-box-component", role: "button", tabindex: 0, "data-gpu-component-id": component.id, "aria-pressed": "false"});
    makePrism(group, shape, palette, {texture: true});
    const name = level === "gpu" ? component.label ?? component.id : component.label?.split("/").at(-1).trim() || component.id;
    const labelPoint = projectIso(shape.x + shape.width / 2, shape.y + shape.depth / 2, shape.height + 28);
    const label = svg("text", {x: labelPoint.x, y: labelPoint.y, "text-anchor": "middle", class: "gpu-box-label"}, name);
    const count = svg("text", {x: labelPoint.x, y: labelPoint.y + 25, "text-anchor": "middle", class: "gpu-box-count"}, "0 ACTIVE");
    const dot = svg("circle", {cx: labelPoint.x - Math.min(64, name.length * 7.5 + 12), cy: labelPoint.y - 7, r: 3.5, class: "gpu-box-status-dot"});
    group.append(label, count, dot);
    const tip = svg("title", {}, `${name} · ${component.id}\n${level === "gpu" ? "进入 SM 城市" : "选择组件并联动时间线"}`); group.append(tip);
    attachActivation(group, () => onSelectComponent(component.id));
    const marks = svg("g", {"aria-hidden": "true"});
    const markPoint = projectIso(shape.x + shape.width / 2, shape.y + shape.depth, shape.height / 2);
    const markSlots = [];
    for (let mark = 0; mark < 4; mark++) {
      const x = markPoint.x - 42, y = markPoint.y + mark * 6 - 9;
      const rail = svg("rect", {x, y, width: 84, height: 3, rx: 1.5, class: "gpu-box-mark-rail"});
      const fill = svg("rect", {x, y, width: 0, height: 3, rx: 1.5, class: "gpu-box-mark-fill"});
      const marker = svg("circle", {cx: x, cy: y + 1.5, r: 2, class: "gpu-box-mark-dot"});
      const slot = svg("g"); slot.append(rail, fill, marker); slot.style.display = "none"; marks.append(slot);
      markSlots.push({slot, fill, marker, x});
    }
    group.append(marks); graphic.append(group); nativeGroups.push({id: component.id, group, count, markSlots});
  }

  function staticBox(shape, type, title, note, labelPosition) {
    const palette = PALETTES[type];
    const group = svg("g", {class: "gpu-box-static", "aria-hidden": "true"});
    makePrism(group, shape, palette, {texture: type === "cache", layers: type === "hbm" ? 6 : 0});
    const tip = svg("title", {}, `${title}：${note}，尺寸与分层为美术示意`); group.append(tip);
    if (labelPosition) {
      const roof = projectIso(shape.x + shape.width / 2, shape.y + shape.depth / 2, shape.height);
      const middle = {x: labelPosition.x, y: roof.y};
      group.append(svg("polyline", {points: points([roof, middle, {x: labelPosition.x, y: labelPosition.y - 9}]), class: "gpu-box-static-leader"}));
      group.append(svg("text", {x: labelPosition.x, y: labelPosition.y, "text-anchor": labelPosition.anchor ?? "middle", class: "gpu-box-static-label"}, title),
        svg("text", {x: labelPosition.x, y: labelPosition.y + 24, "text-anchor": labelPosition.anchor ?? "middle", class: "gpu-box-static-note"}, note));
    }
    graphic.append(group);
  }

  if (level === "gpu") {
    staticBox({x: -40, y: 350, width: 90, depth: 145, height: 105}, "hbm", "HBM", "仓库 · 未观测", {x: 125, y: 130});
    staticBox({x: 555, y: 20, width: 90, depth: 145, height: 105}, "hbm", "HBM", "仓库 · 未观测", {x: 977, y: 166});
    staticBox({x: 65, y: 382, width: 455, depth: 70, height: 33}, "cache", "L2 / SHARED LOGISTICS", "共享物流中心 · 未观测", {x: 527, y: 595});
  } else {
    staticBox({x: -40, y: 390, width: 220, depth: 65, height: 30}, "scheduler", "WARP SCHEDULER", "调度状态未观测", {x: 172, y: 523});
    staticBox({x: 305, y: 390, width: 240, depth: 65, height: 30}, "cache", "L1 / SHARED", "访问与占用未观测", {x: 710, y: 578});
  }

  // Chip corner fiducials and board pins are decorative rather than countable units.
  const ticks = svg("g", {class: "gpu-box-edge-ticks", "aria-hidden": "true"});
  for (const point of floorGeometry.top) ticks.append(svg("path", {d: `M${point.x - 9},${point.y - 9}h-9v9 M${point.x + 9},${point.y + 9}h9v-9`}));
  graphic.append(ticks);
  visual.append(graphic); root.append(visual);
  const caption = html("div", "gpu-box-caption");
  caption.append(html("b", "", level === "gpu" ? "SM 城市 / L2 物流中心 / HBM 仓库" : "原生流水线 / EXECUTION BLOCKS"),
    html("span", "", "盒子布局与尺寸为示意 · 光点仅表示源事件进度")); root.append(caption);

  for (const component of shown) {
    const item = html("button", "gpu-box-native-item"); item.type = "button";
    item.dataset.gpuComponentId = component.id; item.style.setProperty("--box-edge", PALETTES[level === "gpu" ? "sm" : nativeKind(component)].edge);
    const head = html("span", "gpu-box-native-head"); head.append(html("span", "", component.label?.split("/").at(-1).trim() || component.id), html("span", "gpu-box-native-arrow", level === "gpu" ? "↗" : "→"));
    const id = html("span", "gpu-box-native-id", component.id);
    const state = html("span", "gpu-box-native-state"), active = html("b", "", "0"), completed = html("b", "", "0");
    const activeText = html("span"), completedText = html("span"); activeText.append(active, document.createTextNode(" 进行中")); completedText.append(completed, document.createTextNode(" 区间结束")); state.append(activeText, completedText);
    const mini = html("span", "gpu-box-native-mini"), progress = html("span"); mini.append(progress);
    item.append(head, id, state, mini); item.addEventListener("click", () => onSelectComponent(component.id)); list.append(item);
    nativeRows.push({id: component.id, item, active, completed, progress});
  }
  root.append(list);
  if (level === "gpu" && configuredSms !== null && configuredSms > components.length) {
    const missing = html("div", "gpu-box-missing"); missing.append(html("b", "", `${configuredSms - components.length} 个配置 SM 未列入记录`), html("span", "", "不推断位置、空闲或活动状态")); root.append(missing);
  }
  if (components.length > maximum) {
    const missing = html("div", "gpu-box-missing"); missing.textContent = `立体图显示前 ${maximum} / ${components.length} 个原生组件，完整组件可在左侧层级树与时间线选择。`; root.append(missing);
  }
  if (!components.length) root.append(html("p", "gpu-task-empty", "当前层级没有独立原生组件，事件仍保留在时间线。"));
  return {element: root, update({byId = new Map(), time = 0, selectedComponentId = null} = {}) {
    for (const {id, item, active, completed, progress} of nativeRows) {
      const value = byId.get(id);
      active.textContent = (value?.active ?? 0).toLocaleString(); completed.textContent = (value?.completed ?? 0).toLocaleString();
      item.classList.toggle("gpu-running", value?.active > 0); item.classList.toggle("gpu-selected", selectedComponentId === id);
      const marks = activeIntervalMarks(eventsById.get(id), time, 1);
      progress.style.width = marks.length ? `${marks[0].progress * 100}%` : "0%";
    }
    for (const {id, group, count, markSlots} of nativeGroups) {
      const value = byId.get(id);
      count.textContent = `${value?.active ?? 0} ACTIVE`;
      group.classList.toggle("gpu-running", value?.active > 0); group.classList.toggle("gpu-selected", selectedComponentId === id);
      const marks = activeIntervalMarks(eventsById.get(id), time, markSlots.length);
      markSlots.forEach(({slot, fill, marker, x}, index) => {
        const mark = marks[index]; slot.style.display = mark ? "" : "none";
        if (mark) {fill.setAttribute("width", mark.progress * 84); marker.setAttribute("cx", x + mark.progress * 84);}
      });
    }
  }};
}
