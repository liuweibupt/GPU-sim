import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {summarizeComponents, summarizeWorkloads, worldCameraScale} from "../web/gpu-world.js";
import {normalizeTrace} from "../lib/trace.js";

function fixture() {
  return {meta: {config: {numSms: 132}}, components: [
    {id: "gpu", kind: "gpu"}, {id: "sm-0", kind: "sm", parentId: "gpu"},
    {id: "sm-0.LD", kind: "pipeline-group", parentId: "sm-0"},
    {id: "sm-1", kind: "sm", parentId: "gpu"},
  ], events: [
    {id: "load", componentId: "sm-0.LD", start: 1, end: 4, args: {smId: 0, threadBlockId: 0, warpId: 8}},
    {id: "instant", componentId: "sm-0", start: 4, end: 4, args: {smId: 0, threadBlockId: 0, warpId: 8}},
    {id: "next", componentId: "sm-1", start: 4, end: 8, args: {smId: 1, threadBlockId: 0, warpId: 0}},
  ]};
}

test("world counts aggregate descendants once and respect half-open interval boundaries", () => {
  const trace = fixture(), before = JSON.stringify(trace);
  const atOne = summarizeComponents(trace, 1);
  assert.equal(atOne.byId.get("gpu").active, 1);
  assert.equal(atOne.byId.get("sm-0").active, 1);
  assert.equal(atOne.byId.get("sm-0.LD").active, 1);
  const atFour = summarizeComponents(trace, 4);
  assert.equal(atFour.byId.get("gpu").active, 1);
  assert.equal(atFour.byId.get("gpu").completed, 2);
  assert.equal(atFour.byId.get("sm-0").active, 0);
  assert.equal(atFour.activeTotal, 1);
  assert.equal(atFour.byId.get("gpu").total, 3);
  assert.equal(summarizeComponents(trace, 8).activeTotal, 0);
  assert.equal(summarizeComponents(trace, 1).activeTotal, 1);
  assert.equal(JSON.stringify(trace), before);
});

test("configured SM count is distinct from listed components and never implies activity", () => {
  const trace = fixture(), summary = summarizeComponents(trace, 1);
  assert.equal(summary.observedSms, 2);
  assert.equal(summary.physicalSms, 132);
  assert.equal(summary.unobservedSms, 130);
  delete trace.meta.config;
  assert.equal(summarizeComponents(trace, 1).physicalSms, null);
  trace.meta.config = {numSms: 1};
  assert.equal(summarizeComponents(trace, 1).unobservedSms, null);
});

test("Chrome profile track names do not become SM hardware", () => {
  const trace = normalizeTrace({traceEvents: [
    {ph: "M", pid: 1, tid: 2, name: "thread_name", args: {name: "SM 0 Tensor"}},
    {ph: "X", pid: 1, tid: 2, name: "gemm", ts: 10, dur: 20},
  ]});
  const summary = summarizeComponents(trace, 12);
  assert.equal(summary.mode, "tracks");
  assert.equal(summary.observedSms, 0);
  assert.equal(summary.physicalSms, null);
  assert.equal(summary.byId.get("p:1/t:2").active, 1);
});

test("CTA grouping uses native threadBlockId and keeps same-numbered blocks on different SMs separate", () => {
  const trace = fixture();
  trace.events.push({id: "tile-without-cta", componentId: "sm-0.LD", start: 1, end: 2,
    args: {tile: {rows: 16, cols: 16, rowOffset: 0, colOffset: 0}}});
  const first = summarizeWorkloads(trace, "sm-0", 4);
  assert.equal(first.length, 1);
  assert.equal(first[0].threadBlockId, 0);
  assert.equal(first[0].smId, 0);
  assert.equal(first[0].total, 2);
  assert.equal(first[0].completed, 2);
  assert.equal(first[0].active, 0);
  assert.deepEqual(first[0].warpIds, [8]);
  const second = summarizeWorkloads(trace, "sm-1", 4);
  assert.equal(second[0].smId, 1);
  assert.equal(second[0].total, 1);
  assert.equal(second[0].active, 1);
});

test("GTSim overview and CTA counts preserve all native event identities", async () => {
  const trace = JSON.parse(await readFile(new URL("../examples/gtsim-gemm.json", import.meta.url), "utf8"));
  const summary = summarizeComponents(trace, trace.metrics.totalCycles);
  assert.equal(summary.observedSms, 2);
  assert.equal(summary.physicalSms, 132);
  assert.equal(summary.completedTotal, 796);
  assert.equal(summary.byId.get("gpu").completed, 796);
  const groups = ["sm-0", "sm-1"].flatMap(sm => summarizeWorkloads(trace, sm, trace.metrics.totalCycles));
  assert.equal(groups.reduce((total, group) => total + group.completed, 0), 796);
  assert.equal(new Set(groups.flatMap(group => group.events.map(event => event.id))).size, 796);
  assert.equal(summary.activeTotal, 0);
});

test("default camera preserves readable labels while detail views scroll vertically", () => {
  const compact = {width: 500, height: 220, naturalWidth: 590, naturalHeight: 620};
  assert.equal(worldCameraScale(compact), .85);
  assert.equal(worldCameraScale({...compact, width: 590, detail: true}), 1);
  assert.equal(worldCameraScale({...compact, width: 590, naturalHeight: 2500, detail: true}), 1);
  assert.ok(worldCameraScale({...compact, wholeMap: true}) < .4);
  assert.equal(worldCameraScale({...compact, width: 590, detail: true, zoom: 1.5}), 1.5);
  // At the default minimum scale, important 13 px labels remain above 11 px.
  assert.ok(13 * worldCameraScale(compact) >= 11);
});
