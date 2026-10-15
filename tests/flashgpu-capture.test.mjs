import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {normalizeRun, decodeWorkspace, runKind} from '../lib/run-state.js';
import {normalizeFlashGpuLog, FLASHGPU_FORMAT_REVISION} from '../lib/detailed-trace.js';
import {observationSnapshot, laneWindow} from '../lib/instruction-view.js';

const read = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');
const hash = text => createHash('sha256').update(text).digest('hex');

test('bundled instruction sample is backed by the original validated native run', async () => {
  const [raw, json, manifestJson, workload] = await Promise.all([
    read('examples/flashgpu-vectoradd.log'), read('examples/flashgpu-vectoradd.json'),
    read('examples/flashgpu-vectoradd.manifest.json'), read('tools/detailed/vector-add.cu')]);
  const trace = normalizeRun(JSON.parse(json)), manifest = JSON.parse(manifestJson);
  assert.equal(runKind(trace), 'detail');
  assert.equal(trace.meta.evidenceKind, 'simulation');
  assert.equal(trace.meta.producerRevision, FLASHGPU_FORMAT_REVISION);
  assert.equal(manifest.backend.revision, FLASHGPU_FORMAT_REVISION);
  assert.equal(manifest.backend.trackedSourcesClean, true);
  assert.equal(trace.source.raw, raw);
  assert.equal(trace.source.sha256, hash(raw));
  assert.equal(manifest.capture.nativeLogSha256, hash(raw));
  assert.equal(manifest.capture.normalizedTraceSha256, hash(json));
  assert.equal(manifest.workload.sourceSha256, hash(workload));
  assert.equal(manifest.capture.nativeLogBytes, Buffer.byteLength(raw));
  assert.ok(raw.includes(manifest.validation.marker));
  assert.equal(manifest.validation.exactElementsChecked, manifest.workload.elements);
  assert.equal(manifest.validation.passed, true);
  assert.equal(manifest.validation.processExitCode, 0);
  assert.equal(manifest.capture.simulatedCycles, Number(raw.match(/gpu_tot_sim_cycle\s*=\s*(\d+)/)[1]));
  assert.equal(trace.metrics.wallTimeSeconds, manifest.capture.wallTimeSeconds);
  assert.ok(trace.metrics.wallTimeSeconds > 0);
  assert.equal(trace.metrics.timingScope, manifest.capture.timingScope);
  assert.equal(manifest.capture.samplingCore, -1);
  assert.equal(manifest.toolchain.openMpThreads, 1);

  // Regenerating from the unmodified native log preserves every observation.
  const parsed = normalizeFlashGpuLog(raw);
  assert.deepEqual(trace.events, parsed.events);
  assert.equal(trace.events.length, manifest.capture.observedEventCount);
  assert.ok(trace.events.length > 100);
  assert.deepEqual(trace.meta.capabilities, ['instruction_observations']);
  const counts = {};
  for (const event of trace.events) {
    counts[event.args.stage] = (counts[event.args.stage] ?? 0) + 1;
    assert.equal(event.start, event.end);
    assert.ok(event.end <= manifest.capture.simulatedCycles);
    assert.equal(event.category, event.args.stage);
    assert.ok(event.args.instructionText);
    assert.equal(event.args.threadBlockId, undefined);
    assert.equal(event.args.architectureComponentId, undefined);
    assert.equal(event.args.dynamicInstructionId, undefined);
    assert.deepEqual(event.dependencies, []);
  }
  assert.deepEqual(counts, manifest.capture.eventCounts);
  assert.ok(counts.ISSUE > 0 && counts.STALL_SCOREBOARD > 0);
  assert.deepEqual([...new Set(trace.events.map(event => event.args.smId))], manifest.capture.observedSmIds);
  assert.equal(trace.components.filter(component => component.kind === 'warp').length, manifest.capture.observedWarpCount);

  const finalPoint = trace.events.at(-1), window = laneWindow(trace.events, finalPoint.start, finalPoint.id);
  assert.ok(window.events.some(event => event.id === finalPoint.id));
  const snapshot = observationSnapshot(trace.events, manifest.capture.simulatedCycles);
  assert.equal(snapshot.observed, trace.events.length);
  assert.equal(snapshot.issue, counts.ISSUE);
  const macro = JSON.parse(await read('examples/gtsim-gemm.json'));
  const decoded = decodeWorkspace({kind: 'gpu-sim-workspace', version: 2, activeRun: 'detail',
    runs: {macro: {trace: macro, view: {time: 1000}}, detail: {trace, view: {time: finalPoint.start}}}});
  assert.equal(decoded.runs.macro.view.time, 1000);
  assert.equal(decoded.runs.detail.view.time, finalPoint.start);
});
