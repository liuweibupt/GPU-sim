import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {normalizeRun} from '../lib/run-state.js';
import {instantiateSmArchitecture} from '../lib/sm-architecture.js';
import {indexSmPipelineEvidence, smPipelineTransferMarks, smPipelineStageMarks} from '../web/sm-pipeline-scene.js';

const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const hash = input => createHash('sha256').update(input).digest('hex');

test('native SM lights retain capture integrity and every recorded partition has measured movement', async () => {
  const [json, raw, manifestJson, patch, baselineJson] = await Promise.all([
    read('examples/flashgpu-vectoradd-pipeline.json'), read('examples/flashgpu-vectoradd-pipeline.log'),
    read('examples/flashgpu-vectoradd-pipeline.manifest.json'), read('tools/detailed/flashgpu-pipeline-observer.patch'),
    read('examples/flashgpu-vectoradd.manifest.json')]);
  const trace = normalizeRun(JSON.parse(json)), manifest = JSON.parse(manifestJson), baseline = JSON.parse(baselineJson);
  assert.equal(trace.source.raw, raw);
  assert.equal(hash(json), manifest.capture.normalizedTraceSha256);
  assert.equal(hash(raw), manifest.capture.nativeLogSha256);
  assert.equal(hash(patch), manifest.backend.observerPatchSha256);
  assert.equal(manifest.backend.baseTrackedSourcesClean, true);
  assert.equal(manifest.backend.trackedSourcesRestoredAfterCapture, true);
  assert.equal(manifest.backend.observer.timingStateMutations, false);
  assert.equal(manifest.capture.simulatedCycles, baseline.capture.simulatedCycles);
  assert.equal(manifest.validation.exactElementsChecked, 256);
  assert.equal(manifest.validation.passed, true);
  assert.ok(raw.includes(manifest.validation.marker));
  assert.equal(trace.events.length, manifest.capture.observedEventCount);
  const counts = {};
  for (const event of trace.events) counts[event.args.stage] = (counts[event.args.stage] ?? 0) + 1;
  assert.deepEqual(counts, manifest.capture.eventCounts);
  assert.equal(counts.ISSUE, counts.COMPLETE);
  assert.equal(counts.COMPLETE, manifest.capture.observer.completedInstructionCount);
  assert.equal(trace.events.filter(event => event.args.smPipelineTransfer).length, manifest.capture.observer.movementSpanCount);
  assert.equal(trace.events.filter(event => event.end > event.start).length, manifest.capture.observer.nonzeroSpanCount);

  const movingUids = new Set(trace.events.filter(event => event.args.smPipelineTransfer).map(event => event.args.dynamicInstructionId));
  const issuedUids = new Set(trace.events.filter(event => event.args.nativeEvent === 'ISSUE' && event.start === event.end).map(event => event.args.dynamicInstructionId));
  assert.deepEqual(movingUids, issuedUids);
  const before = hash(JSON.stringify(trace.events));
  for (const smId of manifest.capture.observedSmIds) {
    const events = trace.events.filter(event => event.args.smId === smId);
    const evidence = indexSmPipelineEvidence(instantiateSmArchitecture(smId), events, trace.components);
    assert.deepEqual(evidence.unresolvedTransfers, []);
    assert.deepEqual(evidence.unmapped, []);
    for (const partitionId of [0, 1, 2, 3]) {
      const flow = events.find(event => event.args.partitionId === partitionId && event.args.smPipelineTransfer && event.end > event.start);
      assert.ok(flow, `SM ${smId} / P${partitionId}`);
      const t1 = flow.start + (flow.end - flow.start) / 4, t2 = flow.start + (flow.end - flow.start) * 3 / 4;
      const at = time => smPipelineTransferMarks(evidence, time).find(mark => mark.event.id === flow.id);
      assert.equal(at(t1).progress, .25);
      assert.equal(at(t2).progress, .75);
      assert.deepEqual(at(t1), at(t1));
      assert.equal(at(flow.end), undefined);
    }
    const residence = events.find(event => event.args.observationRole === 'residence');
    assert.ok(residence);
    assert.ok(smPipelineStageMarks(evidence, (residence.start + residence.end) / 2).some(mark => mark.event.id === residence.id));
  }
  assert.equal(hash(JSON.stringify(trace.events)), before);
});
