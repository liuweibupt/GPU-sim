import test from 'node:test';
import assert from 'node:assert/strict';
import {captureTcgen05Probe, ablateTcgen05, verifyTcgen05Slices} from '../tools/research/bridge-tcgen05-probe.mjs';
import {checkProtocol} from '../lib/research/protocol.js';
import {sliceEvidence} from '../lib/research/evidence.js';

// Synthetic CPU fixture, not claimed to be a GPU capture. Numerical hardware
// validation is separately performed by the pinned Python oracle in the CLI.
function fixture(wrong = false, iterations = 2) {
  const base = 9007199254740992n;
  const roles = ['input_selected', 'mma_committed', ...Array(4).fill('mma_wait_success'),
    ...Array(4).fill('tmem_reader_done'), 'reuse_ready'];
  const domains = ['value', 'commit_issued', ...Array(4).fill('producer_result_ready'),
    ...Array(4).fill('reader_done'), 'reuse_ready'];
  const threads = [0, 0, 0, 32, 64, 96, 0, 32, 64, 96, 0];
  return {format: 'tcgen05-probe-v1', iterations, seed: 7, generation_base: String(base),
    variant: wrong ? 'wrong-version' : 'correct', lifecycle: {tmem_base: 0, deallocated: true},
    events: Array.from({length: iterations}, (_, i) => roles.map((role, n) => ({
      id: `i${i}:e${n}`, event_layout_index: i * 11 + n, iteration: i, role, domain: domains[n],
      thread: threads[n], expected_generation: String(base + BigInt(i + 2)),
      observed_generation: String(base + BigInt(i + (wrong ? 0 : 2))),
      barrier_generation: String(i), barrier_phase: i % 2, wait_success: n >= 2,
      representative_value: n >= 6 ? 123 : 0, source_line: 10 + n,
    }))).flat()};
}
const binding = {measurementId: 'synthetic-fixture', rawPath: 'fixture.json', rawSha256: 'synthetic-only',
  sourceSha256: '76a8b4f7c11d1e5c20540ce01414d131bf17a72171256f9ef1b0a11f6ef072a8',
  sourceSites: {mmaIssue: 1, fullCommit: 2, tmemLoad: 3, readerDone: 4, readerBarrier: 5, deallocation: 6}};

test('full-generation wrong source has correct synchronization but wrong requested values', () => {
  for (const wrong of [false, true]) {
    const capture = captureTcgen05Probe(fixture(wrong), binding), run = checkProtocol(capture);
    assert.equal(run.obligations.length, 28);
    assert.equal(run.obligations.filter(o => o.status === 'violated').length, wrong ? 8 : 0);
    assert.ok(run.obligations.filter(o => o.kind !== 'value-generation').every(o => o.status === 'satisfied'));
    const values = capture.obligations.filter(o => o.kind === 'value-generation');
    assert.ok(values.every(o => BigInt(o.expected.generation) % 2n === BigInt(o.observed.generation) % 2n));
  }
});

test('commit-issued callback is not a cross-warp completion or ordering witness', () => {
  const capture = captureTcgen05Probe(fixture(), binding);
  assert.ok(capture.hb.every(e => !/^i\d+:e1$/.test(e.from)));
  assert.ok(capture.events.filter(e => /^i\d+:e1$/.test(e.id)).every(e => e.token.status === 'unknown'));
  assert.ok(capture.facts.filter(f => f.kind === 'source-derived-read-boundary').every(f => f.sampledDeviceEvent === false));
});

test('TMEM reader completion precedes next actual overwrite or final deallocation point', () => {
  const capture = captureTcgen05Probe(fixture(), binding);
  assert.equal(capture.obligations.find(o => o.id === 'reuse:0').afterId, 'derived:mma-issue:1');
  assert.equal(capture.obligations.find(o => o.id === 'reuse:1').afterId, 'derived:deallocation');
  assert.equal(capture.obligations.find(o => o.id === 'reuse:0').beforeId, 'derived:all-readers-done:0');
  assert.equal(capture.events.find(e => e.id === 'i0:e9').token.status, 'unknown');
  assert.equal(capture.events.find(e => e.id === 'derived:all-readers-done:0').token.domain, 'reader_done');
  assert.equal(capture.facts.find(f => f.id === 'boundary:all-readers-done:0').resourceCoverage.readerThreads, 128);
});

test('all three interface ablations yield unknown without inventing new hardware failures', () => {
  const capture = captureTcgen05Probe(fixture(true), binding);
  for (const mode of ['remove-HB-edges', 'mask-selected-input-provenance', 'mask-post-success-completion']) {
    const run = checkProtocol(ablateTcgen05(capture, mode));
    const relevant = run.obligations.filter(o => mode === 'remove-HB-edges' ?
      ['completion-before-consume', 'reader-before-reuse'].includes(o.kind) :
      mode === 'mask-selected-input-provenance' ? o.kind === 'value-generation' : o.id.startsWith('completion:'));
    assert.ok(relevant.length > 0 && relevant.every(o => o.status === 'unknown'));
    assert.equal(run.obligations.filter(o => o.status === 'violated').length, mode === 'mask-selected-input-provenance' ? 0 : 8);
    assert.equal(verifyTcgen05Slices(run).length, 28);
  }
});

test('value slice retains selected-input provenance separately from actual TMEM value', () => {
  const run = checkProtocol(captureTcgen05Probe(fixture(true), binding));
  assert.equal(verifyTcgen05Slices(run).length, 28);
  const value = run.obligations.find(o => o.id === 'value:0:0');
  const sliced = sliceEvidence(run, value.subjectIds);
  const fact = sliced.evidence.find(f => f.id === 'value-token:0:0');
  assert.equal(fact.selectedInputObservation.payload.role, 'input_selected');
  assert.equal(fact.tmemReaderObservation.payload.role, 'tmem_reader_done');
  assert.equal(fact.tmemReaderObservation.payload.representative_value, 123);
  assert.notEqual(fact.selectedInputObservation.jsonPointer, fact.tmemReaderObservation.jsonPointer);
});

test('missing post-success record stays unknown in checker, and incompatible facets are rejected', () => {
  const capture = captureTcgen05Probe(fixture(), binding);
  capture.events = capture.events.filter(e => e.id !== 'i0:e2');
  capture.hb = capture.hb.filter(e => e.from !== 'i0:e2' && e.to !== 'i0:e2');
  const run = checkProtocol(capture);
  assert.ok(run.obligations.filter(o => o.id.startsWith('completion:0:0')).every(o => o.status === 'unknown'));
  const input = fixture(); input.events[2].domain = 'smem_read_complete';
  assert.throws(() => captureTcgen05Probe(input, binding), /facet/);
});

test('source mismatch, incomplete observations and conflicting generation are refused', () => {
  assert.throws(() => captureTcgen05Probe(fixture(), {...binding, sourceSha256: 'unreviewed'}), /source/);
  const missing = fixture(); missing.events.pop();
  assert.throws(() => captureTcgen05Probe(missing, binding), /incomplete/);
  const inconsistent = fixture(); inconsistent.events[2].observed_generation = '0';
  assert.throws(() => captureTcgen05Probe(inconsistent, binding), /inconsistent/);
});
