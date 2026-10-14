// Decorative three-face packages for formal SM components. Geometry is local
// to each accessible HTML button: its name, formal contract and source-derived
// activity remain in the scene. Roof cells / pins are visual motifs, never a
// count of physical lanes, banks, ports, capacity, or observed transactions.
const NS = "http://www.w3.org/2000/svg";

const PALETTES = {
  control: {top: "#4e543b", front: "#293c3d", right: "#192c30", edge: "#d4c07e", pin: "#b6a46e"},
  operand: {top: "#286263", front: "#1b3d48", right: "#132c38", edge: "#79d3ca", pin: "#73b6b5"},
  alu: {top: "#2b6152", front: "#1d3e42", right: "#132e33", edge: "#81d9b0", pin: "#72b99b"},
  tensor: {top: "#4e476f", front: "#2c3550", right: "#20273d", edge: "#b9a1ee", pin: "#9e91c7"},
  memory: {top: "#315a77", front: "#1c3c50", right: "#142a3e", edge: "#85c6f1", pin: "#7babc8"},
  async: {top: "#65513e", front: "#3a3b3e", right: "#2b2c32", edge: "#e1ac7e", pin: "#b99675"},
};
const round = value => Math.round(value * 1000) / 1000;
const point = (x, y) => ({x: round(x), y: round(y)});
const points = values => values.map(({x, y}) => `${x},${y}`).join(" ");

/** A rectangular, readable front face with a receding roof and right wall. */
export function smComponentBoxGeometry(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new RangeError("SM box dimensions must be finite and positive");
  const margin = Math.min(5, width * .035, height * .035);
  const dx = Math.min(18, width * .11), dy = Math.min(27, height * .21);
  const bottom = Math.min(10, height * .08);
  const left = margin, right = width - margin - dx, top = margin + dy, base = height - bottom;
  const a = point(left, top), b = point(right, top), c = point(right, base), d = point(left, base);
  const backLeft = point(left + dx, margin), backRight = point(right + dx, margin), backBottom = point(right + dx, base - dy);
  const front = {x: a.x, y: a.y, width: round(b.x - a.x), height: round(d.y - a.y)};
  return {
    width, height, dx, dy, front,
    faces: {front: [a, b, c, d], top: [a, backLeft, backRight, b], right: [b, backRight, backBottom, c]},
    silhouette: [a, backLeft, backRight, backBottom, c, d],
    // Anchors terminate on the package pins, not the button's bounding box.
    ports: {
      top: point((left + right + dx) / 2, margin + dy / 2),
      bottom: point((left + right) / 2, base + bottom * .65),
      left: point(Math.max(0, left - margin * .65), (top + base) / 2),
      right: point(right + dx, (margin + base - dy) / 2),
    },
  };
}

export function smBoxPortAnchor(width, height, side = "bottom") {
  const ports = smComponentBoxGeometry(width, height).ports;
  if (!Object.hasOwn(ports, side)) throw new RangeError(`Unknown SM box port side: ${side}`);
  return ports[side];
}

function svg(tag, attributes = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function motifKind(localId, family) {
  if (localId === "tensor" || family === "tensor") return "matrix";
  if (["register-file", "shared-memory", "l1-cache", "l0-icache", "icache", "constant-cache", "texture"].includes(localId)) return "racks";
  if (["tma", "lsu", "noc-interface", "dispatch"].includes(localId)) return "transfer";
  if (localId === "mbarrier" || localId === "scoreboard") return "gate";
  if (family === "alu") return "alu";
  if (localId === "warp-scheduler" || localId === "issue") return "switch";
  return "pipeline";
}

/** No timers, animation, activity inference or source mutation in this helper. */
export function createSmComponentBox({localId, family = "control"} = {}) {
  const colors = PALETTES[family] ?? PALETTES.control;
  const element = svg("svg", {class: "sm-component-box-art", "aria-hidden": "true", focusable: "false", width: "100%", height: "100%", preserveAspectRatio: "none", "data-decorative": "true", "data-motif": motifKind(localId, family)});
  // Critical layout rules travel with the helper; the scene owns visual states.
  Object.assign(element.style, {position: "absolute", inset: "0", overflow: "visible", pointerEvents: "none"});
  let geometry;
  function updateGeometry(width, height) {
    geometry = smComponentBoxGeometry(width, height);
    const {front, dx, dy, faces, silhouette, ports} = geometry;
    const x = front.x, y = front.y, w = front.width, h = front.height, base = y + h;
    const roof = (u, v) => point(x + w * u + dx * v, y - dy * v);
    element.setAttribute("viewBox", `0 0 ${width} ${height}`);
    element.replaceChildren();
    // The low platform and offset shadow ground every package in the same
    // visual language as the outside SM city. All points stay inside its slot.
    const ground = [point(x + 1, base), point(x + w, base), point(x + w + dx, base - dy), point(x + w + dx, base - dy + 5), point(x + w, Math.min(height, base + 5)), point(x + 1, Math.min(height, base + 5))];
    element.append(svg("polygon", {points: points(ground), fill: "#020c15", opacity: ".72", class: "sm-box-foundation"}));
    for (const [side, fallback] of [["right", colors.right], ["front", colors.front], ["top", colors.top]]) {
      element.append(svg("polygon", {points: points(faces[side]), fill: `var(--sm-box-${side},${fallback})`, stroke: `var(--sm-box-edge,${colors.edge})`, "stroke-width": ".9", "stroke-opacity": side === "top" ? ".8" : ".6", "stroke-linejoin": "round", class: `sm-box-face-${side}`}));
    }
    const motif = svg("g", {class: "sm-box-roof-motif", fill: "none", stroke: `var(--sm-box-edge,${colors.edge})`, "stroke-width": ".9", "stroke-linecap": "round", "stroke-linejoin": "round", opacity: ".6"});
    const line = (from, to, extra = {}) => motif.append(svg("line", {x1: from.x, y1: from.y, x2: to.x, y2: to.y, ...extra}));
    const polygon = (coordinates, extra = {}) => motif.append(svg("polygon", {points: points(coordinates), ...extra}));
    const kind = motifKind(localId, family);
    if (kind === "matrix") {
      for (let row = 0; row < 2; row++) for (let column = 0; column < 6; column++) {
        const u = .12 + column * .125, v = .19 + row * .35;
        polygon([roof(u, v), roof(u + .082, v), roof(u + .082, v + .22), roof(u, v + .22)], {fill: colors.edge, "fill-opacity": ".12"});
      }
    } else if (kind === "racks") {
      for (let index = 0; index < 5; index++) {
        const u = .12 + index * .155;
        polygon([roof(u, .17), roof(u + .105, .17), roof(u + .105, .83), roof(u, .83)], {fill: "#081b28", "fill-opacity": ".3"});
        line(roof(u + .02, .38), roof(u + .085, .38)); line(roof(u + .02, .62), roof(u + .085, .62));
      }
    } else if (kind === "transfer") {
      for (const v of [.31, .7]) {
        const reverse = v > .5;
        line(roof(reverse ? .8 : .17, v), roof(reverse ? .17 : .8, v), {"stroke-width": "1.4"});
        const u = reverse ? .17 : .8, back = reverse ? u + .07 : u - .07;
        motif.append(svg("polyline", {points: points([roof(back, v - .11), roof(u, v), roof(back, v + .11)])}));
      }
    } else if (kind === "alu") {
      polygon([roof(.16, .5), roof(.3, .18), roof(.46, .5), roof(.3, .82)]);
      polygon([roof(.51, .5), roof(.65, .18), roof(.81, .5), roof(.65, .82)]);
      line(roof(.24, .5), roof(.36, .5)); line(roof(.3, .33), roof(.3, .67));
      line(roof(.59, .5), roof(.71, .5));
    } else if (kind === "gate") {
      line(roof(.14, .5), roof(.35, .5)); line(roof(.64, .5), roof(.84, .5));
      polygon([roof(.35, .2), roof(.64, .2), roof(.64, .8), roof(.35, .8)]);
      line(roof(.43, .34), roof(.43, .66), {"stroke-width": "1.6"});
      line(roof(.55, .34), roof(.55, .66), {"stroke-width": "1.6"});
    } else if (kind === "switch") {
      for (const v of [.2, .5, .8]) {
        motif.append(svg("polyline", {points: points([roof(.13, v), roof(.37, v), roof(.55, .5), roof(.83, .5)])}));
      }
      polygon([roof(.5, .34), roof(.61, .34), roof(.61, .66), roof(.5, .66)], {fill: colors.edge, "fill-opacity": ".18"});
    } else {
      line(roof(.12, .5), roof(.87, .5));
      for (const u of [.2, .45, .7]) polygon([roof(u, .22), roof(u + .1, .22), roof(u + .1, .78), roof(u, .78)], {fill: colors.top});
    }
    element.append(motif);
    // Side grooves and a narrow bezel leave the front clear for HTML labels.
    const bezel = svg("g", {class: "sm-box-bezel", fill: "none", stroke: colors.edge, opacity: ".18", "stroke-width": "1"});
    bezel.append(svg("path", {d: `M${round(x + 5)} ${round(y + 8)}V${round(base - 7)} M${round(x + 8)} ${round(base - 4)}H${round(x + w - 8)}`}));
    for (const v of [.23, .45, .67]) bezel.append(svg("line", {x1: round(x + w + dx * .22), y1: round(y + h * v - dy * .22), x2: round(x + w + dx * .78), y2: round(y + h * v - dy * .78)}));
    element.append(bezel);
    const pins = svg("g", {class: "sm-box-pins", fill: "#10222b", stroke: colors.pin, "stroke-width": "1.6", "stroke-linecap": "square"});
    for (const u of [.3, .5, .7]) {
      const px = x + w * u;
      pins.append(svg("line", {x1: round(px), y1: round(base), x2: round(px), y2: ports.bottom.y}));
    }
    pins.append(svg("line", {x1: x, y1: ports.left.y, x2: ports.left.x, y2: ports.left.y}));
    pins.append(svg("rect", {x: round(ports.right.x - 2.2), y: round(ports.right.y - 2.2), width: 4.4, height: 4.4, "stroke-width": ".8", transform: `rotate(-20 ${ports.right.x} ${ports.right.y})`}));
    element.append(pins);
    element.append(svg("polygon", {class: "sm-box-edge", points: points(silhouette), fill: "none", stroke: `var(--sm-box-edge,${colors.edge})`, "stroke-width": "1.1", "stroke-linejoin": "round", opacity: ".7"}));
    return geometry;
  }
  updateGeometry(150, 116);
  return {element, updateGeometry, get geometry() {return geometry;}};
}
