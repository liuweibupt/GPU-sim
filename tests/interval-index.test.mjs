import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createIntervalIndex, initializeIntervalWasm, intervalEngine} from '../lib/interval-index.js';

function verify(factory) {
  const values = [
    {id: 'later', start: 5, end: 20}, {id: 'negative', start: -2, end: 1},
    {id: 'wide', start: 0, end: 100}, {id: 'point', start: 5, end: 5},
    {id: 'early', start: 0, end: 5}, {id: 'tie', start: 5, end: 20},
    {id: 'fraction', start: .125, end: .25},
  ];
  const before = structuredClone(values), index = factory(values);
  for (const time of [-3, -2, 0, .125, .2, .25, 1, 4.999, 5, 10, 20, 100, 5, 0]) {
    assert.deepEqual(index.at(time), values.filter(event => event.start <= time && time < event.end), `time ${time}`);
    assert.equal(index.countStarted(time), values.filter(event => event.end > event.start && event.start <= time).length);
    assert.equal(index.countEnded(time), values.filter(event => event.end > event.start && event.end <= time).length);
  }
  for (const time of [NaN, Infinity, -Infinity]) assert.deepEqual(index.at(time), []);
  assert.deepEqual(values, before);
  assert.equal(index.size, 6);
  return index;
}

test('indexed JS matches exhaustive half-open scans in source order and after rewind', () => {
  assert.equal(verify(createIntervalIndex).engine, 'javascript');
  assert.deepEqual(createIntervalIndex([]).at(0), []);
  const wrapped = [{event: {start: 2, end: 3}}, {event: {start: NaN, end: 4}}];
  assert.deepEqual(createIntervalIndex(wrapped, {start: value => value.event.start, end: value => value.event.end}).at(2), [wrapped[0]]);
});

test('actual compiled WASM upgrades existing indexes and matches the JS query', async () => {
  const existing = createIntervalIndex([{start: 0, end: 10}]);
  existing.at(1);
  const bytes = await readFile(new URL('../lib/interval-query.wasm', import.meta.url));
  assert.equal(await initializeIntervalWasm({bytes}), true);
  assert.equal(intervalEngine(), 'wasm');
  assert.equal(verify(createIntervalIndex).engine, 'wasm');
  assert.equal(existing.at(1).length, 1);
  assert.equal(existing.engine, 'wasm');
  const values = Array.from({length: 20000}, (_, i) => ({start: (i * 13007) % 20000 / 2, end: (i * 13007) % 20000 / 2 + i % 80 + 1}));
  const index = createIntervalIndex(values);
  for (const time of [0, .5, 10, 50, 500, 9990, 10080, 500]) {
    assert.deepEqual(index.at(time), values.filter(event => event.start <= time && time < event.end));
  }
  assert.equal(index.engine, 'wasm', 'large index grows WASM linear memory');
});

test('blocked or missing WASM keeps the indexed JS path working', async () => {
  const fallback = await import('../lib/interval-index.js?missing-wasm');
  assert.equal(await fallback.initializeIntervalWasm({bytes: new Uint8Array([1, 2, 3])}), false);
  assert.equal(verify(fallback.createIntervalIndex).engine, 'javascript');
});
