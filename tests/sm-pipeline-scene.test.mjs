import test from "node:test";
import assert from "node:assert/strict";
import {instantiateSmArchitecture, smComponentId} from "../lib/sm-architecture.js";
import {simulateSm} from "../lib/sm-model.js";
import {indexSmPipelineEvidence, summarizeSmPipelineEvidence, smPipelineTransferMarks, smPipelineStageMarks, smPipelineStagePoint, smPipelineTransferRoute, smPipelineRoutePosition} from "../web/sm-pipeline-scene.js";

const architecture = instantiateSmArchitecture(0);
const fetch = smComponentId(0, "fetch", 0), decode = smComponentId(0, "decode", 0), issue = smComponentId(0, "issue", 0);
const stage = (id, componentId, start, end, args = {}) => ({id, componentId, name: id, start, end, args: {smId: 0, threadBlockId: 0, warpId: 0, ...args}});

test("formal scene maps exact source identities and explicit adapters, never tile/opcode guesses", () => {
  const source = [stage("fetch", fetch, 1, 3, {stage: "fetch"}),
    stage("tile", "sm-0.compute", 1, 50, {op: "fetch", opcode: "ISSUE", stage: "issue"}),
    stage("explicit-event", "native-stage", 2, 4, {architectureComponentId: decode}),
    stage("explicit-component", "backend-issue", 3, 5)];
  const evidence = indexSmPipelineEvidence(architecture, source, [{id: "backend-issue", args: {architectureComponentId: issue}}]);
  assert.deepEqual(evidence.byComponent.get(fetch).map(event => event.id), ["fetch"]);
  assert.deepEqual(evidence.byComponent.get(decode).map(event => event.id), ["explicit-event"]);
  assert.deepEqual(evidence.byComponent.get(issue).map(event => event.id), ["explicit-component"]);
  assert.deepEqual(evidence.unmapped.map(event => event.id), ["tile"]);
  assert.equal(evidence.byComponent.get(smComponentId(0, "fp32", 0)).length, 0);
});

test("formal stage states are half-open and seek/rewind deterministic", () => {
  const source = [stage("work", fetch, 2, 5, {stage: "fetch"}), stage("stall", issue, 5, 8, {stage: "stall", stallReason: "RAW"}), stage("point", decode, 5, 5, {stage: "decode"})];
  const evidence = indexSmPipelineEvidence(architecture, source);
  const first = summarizeSmPipelineEvidence(evidence, 3);
  assert.equal(first.get(fetch).active.length, 1);
  assert.equal(first.get(issue).stall.length, 0);
  const atFive = summarizeSmPipelineEvidence(evidence, 5);
  assert.equal(atFive.get(fetch).active.length, 0);
  assert.equal(atFive.get(fetch).completed, 1);
  assert.equal(atFive.get(issue).stall.length, 1);
  assert.equal(atFive.get(issue).active.length, 0);
  assert.equal(atFive.get(decode).active.length, 0);
  assert.equal(atFive.get(decode).completed, 1);
  assert.equal(atFive.get(decode).endedSpans, 0);
  assert.equal(atFive.get(decode).observedPoints, 1);
  assert.equal(atFive.get(decode).pointsAtCursor, true);
  assert.deepEqual(atFive.get(decode).points.map(event => event.id), ['point']);
  assert.equal(summarizeSmPipelineEvidence(evidence, 6).get(decode).pointsAtCursor, false);
  assert.equal(summarizeSmPipelineEvidence(evidence, 6).get(decode).observationCycle, 5);
  summarizeSmPipelineEvidence(evidence, 100);
  assert.deepEqual(summarizeSmPipelineEvidence(evidence, 3), first);
});

test("queue and transfer evidence are not counted as execution activity", () => {
  const source = [stage("queued", fetch, 1, 4, {stage: "queue"}), stage("wire", fetch, 1, 4, {stage: "transfer", smPipelineTransfer: {sourceId: fetch, targetId: decode, kind: "instruction"}})];
  const value = summarizeSmPipelineEvidence(indexSmPipelineEvidence(architecture, source), 2).get(fetch);
  assert.equal(value.active.length, 0); assert.equal(value.queue.length, 1); assert.equal(value.transfer.length, 1); assert.equal(value.stall.length, 0);
});

test("warp and CTA zero identifiers are preserved in evidence scopes", () => {
  const source = [stage("zero", fetch, 1, 5), stage("one", fetch, 1, 5, {warpId: 1}), stage("other-cta", fetch, 1, 5, {threadBlockId: 1})];
  const value = summarizeSmPipelineEvidence(indexSmPipelineEvidence(architecture, source), 2, {threadBlockId: 0, warpId: 0}).get(fetch);
  assert.deepEqual(value.active.map(event => event.id), ["zero"]);
  assert.equal(value.total, 1);
});

test("moving tokens require explicit typed source transfer spans with valid endpoints", () => {
  const transfer = {sourceId: fetch, targetId: decode, kind: "instruction"};
  const source = [stage("hop", fetch, 10, 14, {stage: "transfer", smPipelineTransfer: transfer}),
    stage("zero", fetch, 12, 12, {smPipelineTransfer: transfer}),
    stage("invalid-kind", fetch, 10, 14, {smPipelineTransfer: {...transfer, kind: "guessed"}}),
    stage("invalid-endpoint", fetch, 10, 14, {smPipelineTransfer: {...transfer, targetId: "other-sm"}}),
    stage("invalid-link", fetch, 10, 14, {smPipelineTransfer: {...transfer, targetId: smComponentId(0, "fp32", 0)}}),
    stage("plain-execute", fetch, 10, 14, {stage: "execute"})];
  const evidence = indexSmPipelineEvidence(architecture, source);
  assert.equal(evidence.transfers.length, 2);
  assert.equal(evidence.unresolvedTransfers.length, 3);
  const marks = smPipelineTransferMarks(evidence, 12);
  assert.equal(marks.length, 1); assert.equal(marks[0].event.id, "hop"); assert.equal(marks[0].progress, .5);
  assert.equal(smPipelineTransferMarks(evidence, 14).length, 0);
  assert.equal(smPipelineTransferMarks(evidence, 12, null, 0).length, 0);
  assert.equal(smPipelineTransferMarks(evidence, NaN).length, 0);
  assert.equal(smPipelineTransferMarks(evidence, 12, {warpId: 1}).length, 0);
});

test("sources and the formal architecture stay unchanged during summaries", () => {
  const source = [stage("fetch", fetch, 1, 5, {stage: "fetch"})];
  const before = JSON.stringify({source, architecture});
  const evidence = indexSmPipelineEvidence(architecture, source);
  for (const time of [0, 2, 10, 2]) {summarizeSmPipelineEvidence(evidence, time); smPipelineTransferMarks(evidence, time);}
  assert.equal(JSON.stringify({source, architecture}), before);
});

test("every teaching-model transfer has a formally typed route, including async TMA completion", () => {
  const trace = simulateSm({smId: 131});
  const fullArchitecture = instantiateSmArchitecture(131);
  const evidence = indexSmPipelineEvidence(fullArchitecture, trace.events, trace.components);
  const transfers = trace.events.filter(event => event.args?.smPipelineTransfer);
  assert.ok(transfers.length > 0);
  assert.equal(evidence.transfers.length, transfers.length);
  assert.deepEqual(evidence.unresolvedTransfers, []);
  assert.equal(evidence.unmapped.length, 0);
  const async = transfers.filter(event => /\/tma$/.test(event.args.smPipelineTransfer.sourceId) || /\/tma$/.test(event.args.smPipelineTransfer.targetId));
  assert.ok(async.length > 0);
  assert.ok(async.every(event => !/register-file|operand-collector/.test(event.args.smPipelineTransfer.sourceId + event.args.smPipelineTransfer.targetId)));
  assert.ok(async.some(event => event.args.smPipelineTransfer.kind === "completion"));
  const sample = transfers.find(event => event.end > event.start && /p0\//.test(event.args.smPipelineTransfer.sourceId));
  const time = (sample.start + sample.end) / 2;
  const marks = smPipelineTransferMarks(evidence, time);
  assert.ok(marks.some(mark => mark.event.id === sample.id && mark.progress === .5));
  assert.deepEqual(smPipelineTransferMarks(evidence, time), marks);
});

test("component lights use only mapped residency intervals and keep their exact half-open boundaries", () => {
  const transfer = {sourceId: fetch, targetId: decode, kind: "instruction"};
  const source = [stage("work", fetch, 2, 6, {stage: "fetch"}), stage("waiting", issue, 3, 8, {stage: "stall", stallReason: "RAW"}),
    stage("point", fetch, 4, 4), stage("hop", fetch, 2, 6, {smPipelineTransfer: transfer}), stage("unmapped", "sm-0.compute", 2, 6),
    stage("other-warp", decode, 2, 6, {warpId: 1})];
  const evidence = indexSmPipelineEvidence(architecture, source);
  const marks = smPipelineStageMarks(evidence, 4, {warpId: 0});
  assert.deepEqual(marks.map(mark => [mark.event.id, mark.state, mark.progress]), [["work", "active", .5], ["waiting", "stall", .2]]);
  assert.equal(smPipelineStageMarks(evidence, 6, {warpId: 0}).some(mark => mark.event.id === "work"), false);
  assert.equal(smPipelineStageMarks(evidence, 4, null, 1).length, 1);
  assert.deepEqual(smPipelineStageMarks(evidence, 4, null, 0), []);
  assert.deepEqual(smPipelineStageMarks(evidence, NaN), []);
  smPipelineStageMarks(evidence, 100); assert.deepEqual(smPipelineStageMarks(evidence, 4, {warpId: 0}), marks);
});

test("multi-link light routes require every typed connection and preserve the supplied interval", () => {
  const dispatch = smComponentId(0, "dispatch", 0), collector = smComponentId(0, "operand-collector", 0);
  const transfer = {sourceId: issue, targetId: collector, kind: "instruction", route: [issue, dispatch, collector]};
  const events = [stage("valid-route", issue, 10, 20, {smPipelineTransfer: transfer}),
    stage("bad-hop", issue, 10, 20, {smPipelineTransfer: {...transfer, route: [issue, fetch, collector]}}),
    stage("bad-end", issue, 10, 20, {smPipelineTransfer: {...transfer, route: [dispatch, collector]}})];
  const evidence = indexSmPipelineEvidence(architecture, events);
  assert.deepEqual(evidence.transfers.map(event => event.id), ["valid-route"]);
  assert.equal(evidence.unresolvedTransfers.length, 2);
  assert.equal(smPipelineTransferMarks(evidence, 15)[0].progress, .5);
  assert.deepEqual(smPipelineTransferRoute(transfer), [issue, dispatch, collector]);
  assert.deepEqual(smPipelineTransferRoute({sourceId: issue, targetId: dispatch}), [issue, dispatch]);
  assert.deepEqual(smPipelineRoutePosition([20, 80], .5), {index: 1, distance: 30});
  assert.deepEqual(smPipelineRoutePosition([20, 80], .2), {index: 1, distance: 0});
  assert.deepEqual(smPipelineRoutePosition([20, 80], 1), {index: 1, distance: 80});
  assert.deepEqual(smPipelineRoutePosition([0, 80], 0), {index: 1, distance: 0});
  assert.equal(smPipelineRoutePosition([0, 0], .5), null);
  assert.equal(smPipelineRoutePosition([20, -1], .5), null);
});

test("residency light positions stay on the decorative roof and are deterministic during seek", () => {
  for (const [width, height] of [[100, 99], [300, 112], [72, 122]]) for (const slot of [0, 1, 2, 7]) {
    const start = smPipelineStagePoint(width, height, 0, slot), end = smPipelineStagePoint(width, height, 1, slot);
    assert.ok(start.x >= 0 && end.x < width && start.y > 0 && start.y < height);
    assert.equal(start.y, end.y); assert.ok(end.x > start.x);
    assert.deepEqual(smPipelineStagePoint(width, height, .5, slot), smPipelineStagePoint(width, height, .5, slot));
  }
  assert.deepEqual(smPipelineStagePoint(100, 99, -1), smPipelineStagePoint(100, 99, 0));
  assert.deepEqual(smPipelineStagePoint(100, 99, 2), smPipelineStagePoint(100, 99, 1));
  assert.throws(() => smPipelineStagePoint(100, 99, NaN), RangeError);
});
