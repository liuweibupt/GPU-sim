import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {createIntervalIndex, initializeIntervalWasm} from '../lib/interval-index.js';

const trace = JSON.parse(await readFile(new URL('../examples/h100-traffic.json', import.meta.url)));
const events = trace.events, end = Math.max(...events.map(event => event.end));
const times = Array.from({length: 2000}, (_, i) => end * ((i * 7919) % 2000) / 2000);
const index = createIntervalIndex(events);
const scan = time => events.filter(event => event.start <= time && time < event.end);
for (const time of times.slice(0, 100)) assert.deepEqual(index.at(time), scan(time));
function measure(query) {
  for (const time of times.slice(0, 200)) query(time);
  const start = performance.now();
  let matches = 0;
  for (const time of times) matches += query(time).length;
  return {milliseconds: +(performance.now() - start).toFixed(3), matches};
}
const scanResult = measure(scan), js = measure(time => index.at(time));
assert.equal(js.matches, scanResult.matches);
await initializeIntervalWasm({bytes: await readFile(new URL('../lib/interval-query.wasm', import.meta.url))});
const wasm = measure(time => index.at(time));
assert.equal(index.engine, 'wasm');
assert.equal(wasm.matches, scanResult.matches);
console.log(JSON.stringify({events: events.length, queries: times.length, scan: scanResult, indexedJs: js, indexedWasm: wasm,
  note: 'Query time only; excludes initialization, DOM, SVG paint and simulation. WASM shares the indexed algorithm with JS.'}, null, 2));
