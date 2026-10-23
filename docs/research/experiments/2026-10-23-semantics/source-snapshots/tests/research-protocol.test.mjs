import test from 'node:test';
import assert from 'node:assert/strict';
import {checkProtocol, validateProtocolCapture} from '../lib/research/protocol.js';
import {sliceEvidence, validateEvidenceRun} from '../lib/research/evidence.js';
import {baseProtocolCapture, enumerateProtocolOracle, invalidProtocolCaptures, protocolCorpus} from '../tools/research/protocol-corpus.mjs';

const fixtures = protocolCorpus();
const byId = id => structuredClone(fixtures.find(item => item.id === id).capture);
const statuses = run => Object.fromEntries(run.obligations.map(item => [item.id, item.status]));

test('derived three-valued verdicts agree with independent exhaustive total orders', () => {
  for (const {id, capture} of fixtures) {
    const oracle = enumerateProtocolOracle(capture);
    assert.deepEqual(statuses(checkProtocol(capture)), Object.fromEntries(oracle.results.map(result => [result.id, result.status])), id);
  }
});

test('transitive positive HB and explicit reverse HB have distinct verdicts and witnesses', () => {
  const forward = checkProtocol(byId('completion-transitive')).obligations.find(item => item.id === 'ordering');
  const reverse = checkProtocol(byId('completion-reverse')).obligations.find(item => item.id === 'ordering');
  assert.equal(forward.status, 'satisfied'); assert.deepEqual(forward.witnessEdgeIds, ['e0', 'e1']);
  assert.equal(reverse.status, 'violated'); assert.deepEqual(reverse.witnessEdgeIds, ['e0']);
});

test('lack of ordering and absence of an event are unknown, not races', () => {
  for (const id of ['completion-unordered-overlap', 'completion-missing-record', 'reuse-unordered', 'reuse-missing-reader']) {
    const run = checkProtocol(byId(id));
    assert.equal(statuses(run).ordering, 'unknown', id);
    assert.ok(run.obligations.find(item => item.id === 'ordering').unknownRefs.length > 0);
  }
});

test('same parity cannot substitute for unbounded generation equality', () => {
  assert.equal(statuses(checkProtocol(byId('value-same-parity-wrong-generation'))).value, 'violated');
  assert.equal(statuses(checkProtocol(byId('value-huge-generation-equal'))).value, 'satisfied');
  assert.deepEqual(statuses(checkProtocol(byId('completion-same-parity-old-token'))), {'ordering:token': 'violated', ordering: 'unknown'});
});

test('read-complete facet is not whole producer-result completion', () => {
  assert.deepEqual(statuses(checkProtocol(byId('completion-wrong-facet-same-generation'))), {'ordering:token': 'violated', ordering: 'unknown'});
});

test('unknown resource identity is not guessed from event names', () => {
  assert.equal(statuses(checkProtocol(byId('value-unknown-observed'))).value, 'unknown');
  assert.equal(statuses(checkProtocol(byId('value-wrong-resource'))).value, 'violated');
});

test('reordering the event array does not invent HB', () => {
  const a = byId('completion-unordered-overlap'), b = structuredClone(a);
  b.events.reverse();
  assert.deepEqual(statuses(checkProtocol(a)), statuses(checkProtocol(b)));
});

test('unsafe contracts including cycles, shadowed scope and unverified HB are rejected', () => {
  for (const {capture, id} of invalidProtocolCaptures()) assert.throws(() => checkProtocol(capture), undefined, id);
});

test('known token domain is mandatory', () => {
  const capture = byId('completion-forward'); delete capture.events[0].token.domain;
  assert.throws(() => validateProtocolCapture(capture), /explicit completion\/value domain/);
});

test('input verdicts are forbidden, rather than trusted as labels', () => {
  const capture = byId('completion-reverse'); capture.obligations[0].status = 'satisfied';
  assert.throws(() => checkProtocol(capture), /input verdicts are forbidden/);
});

test('value source cannot contradict or upgrade the consumer token record', () => {
  const contradiction = byId('value-equal'); contradiction.obligations[0].observed.generation = '3';
  assert.throws(() => checkProtocol(contradiction), /contradictory token|contradicts structured evidence|must bind/);
  const upgrade = byId('value-equal'); upgrade.events.find(event => event.id === 'read').token = {status: 'unknown', reason: 'not-observed'};
  assert.throws(() => checkProtocol(upgrade), /must bind/);
  const differentRef = byId('value-equal'); differentRef.obligations[0].observed.evidenceRef = 'observed-token';
  assert.throws(() => checkProtocol(differentRef), /must bind/);
});

test('one atomic token fact cannot support incompatible generations or domains', () => {
  const capture = byId('completion-forward');
  capture.events.find(event => event.id === 'readerDone').token.evidenceRef = capture.events[0].token.evidenceRef;
  assert.throws(() => checkProtocol(capture), /contradictory token identities share evidence|contradicts structured evidence/);
});

test('structured token evidence cannot contradict the referring token', () => {
  const capture = byId('value-equal');
  capture.facts.find(fact => fact.id === capture.obligations[0].expected.evidenceRef).generation = '17';
  assert.throws(() => checkProtocol(capture), /contradicts structured evidence field generation/);
});

test('every definite verdict has positive observation proof and survives evidence slicing', () => {
  for (const {capture} of fixtures) {
    const run = checkProtocol(capture);
    validateEvidenceRun(run);
    for (const obligation of run.obligations) {
      const slice = sliceEvidence(run, [`protocol:query:${obligation.derivation.sourceRequestId}`]);
      validateEvidenceRun(slice);
      const retained = slice.obligations.find(item => item.id === obligation.id);
      assert.deepEqual(retained, obligation);
      const retainedFacts = new Set(slice.evidence.map(item => item.id));
      for (const ref of [...obligation.positiveWitnessRefs, ...obligation.unknownRefs]) assert.ok(retainedFacts.has(ref));
      if (obligation.status !== 'unknown') assert.ok(obligation.positiveWitnessRefs.length > 0);
    }
  }
});

test('missing evidence reference and colliding derived IDs are rejected', () => {
  const missing = byId('completion-forward'); missing.hb[0].evidenceRef = 'absent';
  assert.throws(() => checkProtocol(missing), /missing evidence/);
  const collision = byId('completion-forward');
  collision.obligations.push({...byId('value-equal').obligations[0], id: 'ordering:token'});
  assert.throws(() => checkProtocol(collision), /colliding derived obligation ID/);
});

test('empty captures are valid but do not imply any completed work', () => {
  const capture = baseProtocolCapture('empty'); capture.events = [];
  assert.equal(checkProtocol(capture).obligations.length, 0);
  assert.equal(enumerateProtocolOracle(capture).legalLinearExtensions, 1);
});
