import test from "node:test";
import assert from "node:assert/strict";
import {smComponentBoxGeometry, smBoxPortAnchor} from "../web/sm-component-box.js";

test("responsive SM packages retain three shared faces and a positive label surface", () => {
  for (const [width, height] of [[150, 116], [260, 140], [100, 148], [75, 300], [320, 230], [40, 40], [70, 24], [900, 48], [140, 80]]) {
    const shape = smComponentBoxGeometry(width, height);
    const {front, top, right} = shape.faces;
    assert.strictEqual(front[0], top[0]);
    assert.strictEqual(front[1], top[3]);
    assert.strictEqual(front[1], right[0]);
    assert.strictEqual(top[2], right[1]);
    assert.strictEqual(front[2], right[3]);
    assert.ok(shape.front.width > 0 && shape.front.height > 0);
    assert.ok(top[1].y < front[0].y && right[1].x > front[1].x);
    for (const point of [...shape.silhouette, ...Object.values(shape.ports)]) {
      assert.ok(point.x >= 0 && point.x <= width, `${width}×${height}: x=${point.x}`);
      assert.ok(point.y >= 0 && point.y <= height, `${width}×${height}: y=${point.y}`);
    }
    assert.deepEqual(front, [
      {x: shape.front.x, y: shape.front.y},
      {x: shape.front.x + shape.front.width, y: shape.front.y},
      {x: shape.front.x + shape.front.width, y: shape.front.y + shape.front.height},
      {x: shape.front.x, y: shape.front.y + shape.front.height},
    ].map(({x, y}) => ({x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000})));
  }
});

test("SM route anchors track physical package contacts as labels resize", () => {
  for (const [width, height] of [[150, 116], [192, 180], [320, 128], [70, 24], [900, 48], [140, 80]]) {
    const shape = smComponentBoxGeometry(width, height);
    for (const side of ["top", "right", "bottom", "left"]) assert.deepEqual(smBoxPortAnchor(width, height, side), shape.ports[side]);
    assert.ok(shape.ports.bottom.y > shape.faces.front[2].y);
    assert.ok(shape.ports.left.x < shape.faces.front[0].x);
    assert.equal(shape.ports.right.x, shape.faces.right[1].x);
    assert.ok(shape.ports.right.y > shape.faces.right[1].y && shape.ports.right.y < shape.faces.right[2].y);
    assert.ok(shape.ports.top.y > shape.faces.top[1].y && shape.ports.top.y < shape.faces.top[0].y);
  }
  assert.throws(() => smBoxPortAnchor(150, 116, "unknown"), RangeError);
  for (const dimensions of [[0, 116], [-1, 116], [150, NaN], [Infinity, 116]]) assert.throws(() => smComponentBoxGeometry(...dimensions), RangeError);
});
