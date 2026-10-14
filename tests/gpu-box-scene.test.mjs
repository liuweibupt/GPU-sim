import test from "node:test";
import assert from "node:assert/strict";
import {projectIso, prismGeometry, activeIntervalMarks} from "../web/gpu-box-scene.js";

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
