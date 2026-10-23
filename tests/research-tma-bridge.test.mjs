import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {captureTmaRecord, ablateTma, verifyRawBinding, verifyHash} from '../tools/research/bridge-tma-probe.mjs';
import {checkProtocol} from '../lib/research/protocol.js';
import {sliceEvidence} from '../lib/research/evidence.js';

const sites = {CONTRACT_TENSOR_TMA_ISSUE: 10, CONTRACT_EXPECT_TX: 20, CONTRACT_ACQUIRE_WAIT: 30,
  CONTRACT_TMA_VISIBILITY_BARRIER: 40, CONTRACT_CONSUMER_LOAD: 50, CONTRACT_PROXY_FENCE: 60,
  CONTRACT_READER_COMPLETION_BARRIER: 70, EVENT_TMA_ISSUED: 80, EVENT_WAIT_RETURNED_TRUE: 90,
  EVENT_CONSUMER_SAMPLE: 100, EVENT_REUSE_READY: 110};
const sourceHashes = {'tma_version_probe.cu': 'fixture-source', 'tma_run_probe.py': 'fixture-validator'};
const hash = data => createHash('sha256').update(data).digest('hex');

function fixture(variant = 'correct') {
  const original = {format: 'gpu-tensor-tma-version-probe-v1', shape: [1, 1], generations: 3, seed: 1,
    variant, device: 'CPU fixture; no hardware claim', output: [1, 2, 3],
    correctness: {passed: variant !== 'wrong-slot', value_mismatches: variant === 'wrong-slot' ? 3 : 0,
      version_mismatches: variant === 'wrong-slot' ? 3 : 0}, events: []};
  const roles = ['tma_issued', 'wait_returned_true', 'consumer_sample', 'reuse_ready'];
  const marker = ['EVENT_TMA_ISSUED', 'EVENT_WAIT_RETURNED_TRUE', 'EVENT_CONSUMER_SAMPLE', 'EVENT_REUSE_READY'];
  for (let transfer = 0; transfer < 5; transfer++) {
    const g = transfer < 2 ? -1 : transfer - 2;
    for (let role = 0; role < (transfer < 2 ? 2 : 4); role++) {
      const index = original.events.length, observed = role === 1 || role === 2;
      const wrong = role === 2 && variant === 'wrong-slot';
      original.events.push({id: `event-${index}`, transfer, iteration: g, role: roles[role],
        slot: (transfer < 2 ? transfer : g % 2) ^ Number(wrong), observed_generation: observed ? g - Number(wrong) : null,
        phase_parity: transfer < 2 ? 0 : (1 + Math.floor(g / 2)) % 2, wait_success: role === 1,
        wait_polls: Number(role === 1), representative_value: observed ? 1 : null, source_line: sites[marker[role]]});
    }
  }
  const raw = Buffer.from('========= sanitizer banner\n' + JSON.stringify(original) + '\n');
  const record = structuredClone(original);
  record.measurement_id = 'fixture'; record.source_hashes = sourceHashes;
  record.exit_code = variant === 'wrong-slot' ? 2 : 0;
  record.recordRef = {path: 'fixture.stdout.txt', sha256: hash(raw), json_line: 2};
  record.events.forEach((event, index) => {event.recordRef = {...record.recordRef,
    json_pointer: `/events/${index}`, source_sha256: sourceHashes['tma_version_probe.cu'], source_line: event.source_line};});
  return {record, raw};
}

test('completed wrong-slot value violates identity while synchronization remains satisfied', () => {
  for (const variant of ['correct', 'wrong-slot', 'repaired']) {
    const capture = captureTmaRecord(fixture(variant).record, sites), result = checkProtocol(capture);
    assert.equal(result.obligations.filter(o => o.status === 'violated').length, variant === 'wrong-slot' ? 3 : 0);
    assert.ok(result.obligations.filter(o => o.kind !== 'value-generation').every(o => o.status === 'satisfied'));
    for (const obligation of result.obligations) {
      const slice = sliceEvidence(result, obligation.subjectIds);
      assert.deepEqual(slice.obligations.find(o => o.id === obligation.id), obligation);
      for (const id of obligation.positiveWitnessRefs) assert.ok(slice.evidence.some(f => f.id === id));
    }
  }
});

test('initial completed buffer and next actual overwrite use consumer slot', () => {
  const bad = captureTmaRecord(fixture('wrong-slot').record, sites), good = captureTmaRecord(fixture().record, sites);
  assert.equal(bad.obligations.find(o => o.id === 'ready:0').beforeId, 'event-3'); // initial slot1 wait
  assert.equal(good.obligations.find(o => o.id === 'ready:0').beforeId, 'event-5'); // current slot0 wait
  assert.equal(bad.obligations.find(o => o.id === 'reuse:0').afterId, 'derived:tma-issue:3');
  assert.equal(good.obligations.find(o => o.id === 'reuse:0').afterId, 'derived:tma-issue:4');
  const boundary = bad.events.find(e => e.id === 'derived:all-readers-done:0');
  assert.equal(boundary.token.resourceId, 'slot:1'); assert.equal(boundary.token.generation, '0');
  assert.ok(bad.facts.filter(f => f.kind.startsWith('source-derived-') && 'sampledDeviceEvent' in f)
    .every(f => f.sampledDeviceEvent === false));
  assert.ok(bad.hb.every(edge => bad.facts.find(f => f.id === edge.evidenceRef).sampledDeviceTiming === false));
});

test('phase parity is not substituted for full transported generation', () => {
  const record = fixture('wrong-slot').record;
  record.events.forEach(event => {event.phase_parity = 0;});
  const run = checkProtocol(captureTmaRecord(record, sites));
  assert.equal(run.obligations.filter(o => o.kind === 'value-generation' && o.status === 'violated').length, 3);
});

test('masking token interfaces or HB yields unknown with retained witnesses', () => {
  const capture = captureTmaRecord(fixture('wrong-slot').record, sites);
  for (const [mode, predicate] of [
    ['mask-consumer-value-token', o => o.kind === 'value-generation'],
    ['mask-successful-wait-token', o => o.id.startsWith('ready:')],
    ['remove-HB-edges', o => ['completion-before-consume', 'reader-before-reuse'].includes(o.kind)]]) {
    const run = checkProtocol(ablateTma(capture, mode));
    assert.ok(run.obligations.filter(predicate).every(o => o.status === 'unknown'));
    for (const obligation of run.obligations.filter(predicate)) {
      assert.ok(obligation.unknownRefs.length > 0);
      const slice = sliceEvidence(run, obligation.subjectIds);
      assert.ok(obligation.unknownRefs.every(id => slice.evidence.some(f => f.id === id)));
    }
  }
});

test('source/hash/record-pointer tampering and raw truncation are rejected', () => {
  const {record, raw} = fixture();
  assert.equal(verifyRawBinding(record, raw, sourceHashes, sites).variant, 'correct');
  assert.throws(() => verifyHash(raw, '0'.repeat(64), 'source'), /SHA256 mismatch/);
  const corrupt = structuredClone(record); corrupt.events[1].recordRef.json_pointer = '/events/0';
  assert.throws(() => verifyRawBinding(corrupt, raw, sourceHashes, sites), /reference mismatch/);
  const falsePayload = structuredClone(record); falsePayload.events[1].wait_success = false;
  assert.throws(() => verifyRawBinding(falsePayload, raw, sourceHashes, sites), /differs from raw/);
  assert.throws(() => verifyRawBinding(record, raw.subarray(0, raw.length - 3), sourceHashes, sites));
});

test('missing success, duplicate event, and absent completed source cannot be promoted to proof', () => {
  for (const mutate of [r => {r.events[1].wait_success = false;},
    r => {r.events[0] = structuredClone(r.events[1]);},
    r => {r.events[6].observed_generation = 99;}]) {
    const record = fixture().record; mutate(record);
    assert.throws(() => captureTmaRecord(record, sites));
  }
});
