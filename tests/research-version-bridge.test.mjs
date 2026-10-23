import test from 'node:test';
import assert from 'node:assert/strict';
import {captureProbeCTA, ablateProbe} from '../tools/research/bridge-version-probe.mjs';
import {checkProtocol} from '../lib/research/protocol.js';

function record(wrong = false) {
  const roles = ['producer_write', 'producer_complete', 'consumer_read', 'reader_done', 'reuse_ready'];
  return {measurement_id: 'fixture', generations: 3, shape: [17], seed: 42, variant: wrong ? 'wrong-slot' : 'correct',
    source_hashes: {'version_probe.cu': 'fixture-source'}, source_barrier_sites: {CONTRACT_PRODUCER_VISIBILITY_BARRIER: 1, CONTRACT_READER_COMPLETION_REUSE_BARRIER: 2},
    events: Array.from({length: 3}, (_, g) => roles.map(role => {
      const consumer = ['consumer_read', 'reader_done'].includes(role);
      return {id: `${g}:${role}`, cta: [0,0,0], iteration: g, role, slot: (g % 2) ^ Number(wrong && consumer),
        observed_generation: g - Number(wrong && consumer), representative_value: 123, valid_elements: 17,
        recordRef: {path: 'fixture', json_pointer: 'fixture'}};
    })).flat()};
}

test('observed post-barrier callbacks do not assert cross-warp HB', () => {
  const capture = captureProbeCTA(record(), 0);
  for (const edge of capture.hb) {
    assert.ok(!edge.from.endsWith(':producer_complete'));
    assert.ok(!edge.from.endsWith(':reader_done'));
    assert.ok(!edge.to.endsWith(':reuse_ready'));
  }
  assert.ok(capture.facts.filter(f => f.kind === 'source-derived-barrier-boundary').every(f => f.sampledDeviceEvent === false));
  assert.ok(checkProtocol(capture).obligations.every(o => o.status === 'satisfied'));
});

test('slot reuse follows actual read slot and explicitly maps initialized prehistory', () => {
  const good = captureProbeCTA(record(), 0), bad = captureProbeCTA(record(true), 0);
  assert.equal(good.obligations.find(o => o.id === 'reuse:0').afterId, '2:producer_write');
  assert.equal(bad.obligations.find(o => o.id === 'reuse:0').afterId, '1:producer_write');
  assert.equal(bad.events.find(e => e.id === '0:consumer_read').token.generation, '0');
  const result = checkProtocol(bad);
  assert.equal(result.obligations.filter(o => o.status === 'violated').length, 3);
  assert.ok(result.obligations.filter(o => o.kind !== 'value-generation').every(o => o.status === 'satisfied'));
});

test('masked consumer tokens and removed HB edges produce unknown, not new GPU outcomes', () => {
  const capture = captureProbeCTA(record(true), 0);
  const tags = checkProtocol(ablateProbe(capture, 'mask-consumer-value-token'));
  assert.ok(tags.obligations.filter(o => o.kind === 'value-generation').every(o => o.status === 'unknown'));
  const order = checkProtocol(ablateProbe(capture, 'remove-HB-edges'));
  assert.ok(order.obligations.filter(o => ['completion-before-consume', 'reader-before-reuse'].includes(o.kind)).every(o => o.status === 'unknown'));
  assert.equal(order.obligations.filter(o => o.status === 'violated').length, 3);
});

test('duplicate or missing selected CTA observations are rejected', () => {
  const input = record(); input.events[0] = input.events[1];
  assert.throws(() => captureProbeCTA(input, 0), /duplicate/);
  assert.throws(() => captureProbeCTA(record(), 1), /incomplete/);
});
