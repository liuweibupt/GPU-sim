import test from "node:test";
import assert from "node:assert/strict";
import {instantiateSmArchitecture, smComponentId} from "../lib/sm-architecture.js";
import {simulateSm} from "../lib/sm-model.js";
import {indexSmPipelineEvidence, summarizeSmPipelineEvidence, smPipelineTransferMarks} from "../web/sm-pipeline-scene.js";

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
