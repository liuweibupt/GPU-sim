import test from "node:test";
import assert from "node:assert/strict";
import {projectIso, prismGeometry, activeIntervalMarks, sceneSmComponents, trafficCityLayout} from "../web/gpu-box-scene.js";

test("isometric boxes have joined top/side faces and preserve their declared height", () => {
  const shape = {x: 20, y: 40, width: 120, depth: 80, height: 35, base: 7};
  const geometry = prismGeometry(shape);
  assert.equal(geometry.top.length, 4);
  assert.deepEqual(geometry.top[3], geometry.left[0]);
  assert.deepEqual(geometry.top[1], geometry.right[0]);
  assert.deepEqual(geometry.top[2], geometry.left[1]);
  assert.deepEqual(geometry.left[2], geometry.right[2]);
  assert.equal(geometry.left[2].y - geometry.top[2].y, 35);
  const floorCorner = projectIso(140, 120, 7);
  assert.deepEqual(geometry.left[2], floorCorner);
});

test("box progress marks preserve source identity, half-open boundaries and deterministic rewind", () => {
  const events = [
    {id: "first", start: 10, end: 30},
    {id: "instant", start: 20, end: 20},
    {id: "next", start: 30, end: 50},
    {id: "parallel", start: 10, end: 50},
  ];
  const before = JSON.stringify(events);
  assert.deepEqual(activeIntervalMarks(events, 10), [{id: "first", progress: 0}, {id: "parallel", progress: 0}]);
  assert.deepEqual(activeIntervalMarks(events, 20, 1), [{id: "first", progress: .5}]);
  assert.deepEqual(activeIntervalMarks(events, 30), [{id: "next", progress: 0}, {id: "parallel", progress: .5}]);
  assert.deepEqual(activeIntervalMarks(events, 50), []);
  assert.deepEqual(activeIntervalMarks(events, 20, 0), []);
  assert.deepEqual(activeIntervalMarks(events, NaN), []);
  assert.deepEqual(activeIntervalMarks(events, 10)[0], {id: "first", progress: 0});
  assert.equal(JSON.stringify(events), before);
});

test("all 132 configured SMs are visible, while missing trace components remain explicit placeholders", () => {
  const components = [{id: "sm-131", label: "last", kind: "sm"}, {id: "sm-0", label: "first", kind: "sm"}];
  const before = JSON.stringify(components), shown = sceneSmComponents(components, 132);
  assert.equal(shown.length, 132);
  assert.equal(shown[0].id, "sm-0");
  assert.equal(shown[131].id, "sm-131");
  assert.equal(shown.filter(component => component.configuredOnly).length, 130);
  assert.equal(shown[1].id, "__configured-sm-1");
  assert.equal(shown[1].sceneNumber, 1);
  assert.equal(JSON.stringify(components), before);
  const all = sceneSmComponents(Array.from({length: 132}, (_, i) => ({id: `sm-${i}`, kind: "sm"})), 132);
  assert.equal(all.filter(component => component.configuredOnly).length, 0);
  assert.equal(new Set(all.map(component => component.id)).size, 132);
});

test("logical city routes preserve exact topology endpoints and keep every SM selectable", () => {
  const sms = sceneSmComponents(Array.from({length: 132}, (_, i) => ({id: `sm-${i}`, kind: "sm"})), 132);
  const nodes = [...sms.map((sm, i) => ({id: sm.id, kind: "sm", componentId: sm.id, clusterId: `router-${Math.floor(i / 11)}`})),
    ...Array.from({length: 12}, (_, i) => ({id: `router-${i}`, kind: "router"})),
    {id: "fabric", kind: "fabric"}, {id: "l2-0", kind: "l2"}, {id: "hbm-0", kind: "hbm"}];
  const links = [
    {id: "sm-router", sourceId: "sm-131", targetId: "router-11"},
    {id: "router-sm", sourceId: "router-11", targetId: "sm-131"},
    {id: "fabric-l2", sourceId: "fabric", targetId: "l2-0"},
    {id: "l2-hbm", sourceId: "l2-0", targetId: "hbm-0"},
  ];
  const layout = trafficCityLayout(sms, {nodes, links});
  assert.equal(layout.shapes.size, 132);
  assert.equal(layout.columns, 12); assert.equal(layout.rows, 11);
  assert.ok(layout.positions.get("sm-131").x > layout.positions.get("sm-0").x);
  assert.ok(layout.positions.get("sm-10").y > layout.positions.get("sm-0").y);
  assert.equal(layout.positions.get("sm-0").x, layout.positions.get("sm-10").x);
  for (const link of links) {
    const route = layout.routes.get(link.id);
    assert.deepEqual(route[0], layout.positions.get(link.sourceId));
    assert.deepEqual(route.at(-1), layout.positions.get(link.targetId));
  }
  assert.deepEqual(layout.routes.get("sm-router"), [...layout.routes.get("router-sm")].reverse());
});
