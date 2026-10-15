import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker as NodeWorker} from 'node:worker_threads';
import {createSimulationClient} from '../lib/simulation-client.js';
import {simulateTraffic} from '../lib/traffic-model.js';
import {simulateSm} from '../lib/sm-model.js';

function fakeWorkers() {
  const instances = [];
  class FakeWorker {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.listeners = new Map();
      this.messages = [];
      this.terminated = false;
      instances.push(this);
    }
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(handler);
    }
    removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    emit(type, event = {}) { for (const handler of this.listeners.get(type) ?? []) handler(event); }
    reply(data) { this.emit('message', {data}); }
    listenerCount() { return [...this.listeners.values()].reduce((count, handlers) => count + handlers.size, 0); }
  }
  return {FakeWorker, instances};
}

test('simulation client uses a module worker and reuses it after successful runs', async () => {
  const {FakeWorker, instances} = fakeWorkers();
  const workerUrl = new URL('https://example.test/subdirectory/web/simulation-worker.js');
  const client = createSimulationClient({WorkerClass: FakeWorker, workerUrl});
  const config = {numSms: 12};
  const first = client.run('traffic', config);
  const worker = instances[0];
  assert.equal(worker.url, workerUrl);
  assert.deepEqual(worker.options, {type: 'module'});
  assert.deepEqual(worker.messages, [{id: 1, kind: 'traffic', config}]);
  const trace = {events: [], meta: {title: 'worker result'}};
  worker.reply({id: 1, trace});
  assert.equal(await first, trace);
  const second = client.run('sm', {warpCount: 8});
  assert.equal(instances.length, 1);
  worker.reply({id: 2, trace});
  assert.equal(await second, trace);
  client.destroy();
  assert.equal(worker.terminated, true);
  assert.equal(worker.listenerCount(), 0);
});

test('replacement aborts and terminates expensive work and ignores stale worker responses', async () => {
  const {FakeWorker, instances} = fakeWorkers();
  const client = createSimulationClient({WorkerClass: FakeWorker});
  const oldRun = client.run('traffic', {});
  const oldRejected = assert.rejects(oldRun, {name: 'AbortError'});
  const oldWorker = instances[0];
  const queuedMessage = [...oldWorker.listeners.get('message')][0];
  const queuedError = [...oldWorker.listeners.get('error')][0];
  const nextRun = client.run('sm', {});
  await oldRejected;
  assert.equal(oldWorker.terminated, true);
  assert.equal(oldWorker.listenerCount(), 0);
  assert.equal(instances.length, 2);
  queuedMessage({data: {id: 1, trace: {stale: true}}});
  queuedError({message: 'stale error'});
  const nextWorker = instances[1], trace = {fresh: true};
  nextWorker.reply({id: 1, trace: {wrongId: true}});
  nextWorker.reply({id: 2, trace});
  assert.equal(await nextRun, trace);
  client.destroy();
});

test('cancel settles pending work, is idempotent, and the next request gets a fresh worker', async () => {
  const {FakeWorker, instances} = fakeWorkers();
  const client = createSimulationClient({WorkerClass: FakeWorker});
  const run = client.run('traffic', {});
  const rejected = assert.rejects(run, {name: 'AbortError'});
  client.cancel();
  client.cancel();
  await rejected;
  const fresh = client.run('traffic', {});
  instances[1].reply({id: 2, trace: {fresh: true}});
  assert.deepEqual(await fresh, {fresh: true});
  client.destroy();
});

test('destroy aborts pending work, prevents later requests, and releases all listeners', async () => {
  const {FakeWorker, instances} = fakeWorkers();
  const client = createSimulationClient({WorkerClass: FakeWorker});
  const run = client.run('traffic', {});
  const rejected = assert.rejects(run, {name: 'AbortError'});
  client.destroy();
  client.destroy();
  await rejected;
  await assert.rejects(client.run('sm', {}), {name: 'InvalidStateError'});
  assert.equal(instances.length, 1);
  assert.equal(instances[0].terminated, true);
  assert.equal(instances[0].listenerCount(), 0);
});

test('model errors retain their name and message without discarding a healthy worker', async () => {
  const {FakeWorker, instances} = fakeWorkers();
  const client = createSimulationClient({WorkerClass: FakeWorker});
  const run = client.run('sm', {warpCount: 0});
  instances[0].reply({id: 1, error: {name: 'RangeError', message: 'warpCount out of range'}});
  await assert.rejects(run, {name: 'RangeError', message: 'warpCount out of range'});
  assert.equal(instances[0].terminated, false);
  const retry = client.run('sm', {});
  instances[0].reply({id: 2, trace: {ok: true}});
  assert.deepEqual(await retry, {ok: true});
  client.destroy();
});

for (const [type, event, expected] of [
  ['error', {message: 'module load failed'}, {name: 'Error', message: 'module load failed'}],
  ['error', {error: new SyntaxError('invalid module')}, {name: 'SyntaxError', message: 'invalid module'}],
  ['messageerror', {}, {name: 'DataCloneError'}],
  ['message', {data: {id: 1}}, {message: 'Invalid simulation worker response.'}],
  ['message', {data: null}, {message: 'Invalid simulation worker response.'}]
]) {
  test(`worker ${type} failure settles the run and releases its worker (${expected.name ?? expected.message})`, async () => {
    const {FakeWorker, instances} = fakeWorkers();
    const client = createSimulationClient({WorkerClass: FakeWorker});
    const run = client.run('traffic', {});
    instances[0].emit(type, event);
    await assert.rejects(run, expected);
    assert.equal(instances[0].terminated, true);
    assert.equal(instances[0].listenerCount(), 0);
    const retry = client.run('traffic', {});
    instances[1].reply({id: 2, trace: {ok: true}});
    assert.deepEqual(await retry, {ok: true});
    client.destroy();
  });
}

test('postMessage cloning failure rejects the run and terminates its worker', async () => {
  const {FakeWorker, instances} = fakeWorkers();
  class BrokenPostWorker extends FakeWorker {
    postMessage() { throw Object.assign(new Error('cannot clone config'), {name: 'DataCloneError'}); }
  }
  const client = createSimulationClient({WorkerClass: BrokenPostWorker});
  await assert.rejects(client.run('traffic', {}), {name: 'DataCloneError', message: 'cannot clone config'});
  assert.equal(instances[0].terminated, true);
  assert.equal(instances[0].listenerCount(), 0);
  client.destroy();
});

test('unsupported workers and construction failures reject without running a model on the caller', async () => {
  const unavailable = createSimulationClient({WorkerClass: null});
  await assert.rejects(unavailable.run('traffic', {}), {name: 'NotSupportedError'});
  unavailable.destroy();
  const broken = createSimulationClient({WorkerClass: class {
    constructor() { throw new Error('worker blocked'); }
  }});
  await assert.rejects(broken.run('sm', {}), {message: 'worker blocked'});
  broken.destroy();
});

test('invalid simulation kind rejects without interrupting a valid pending run', async () => {
  const {FakeWorker, instances} = fakeWorkers();
  const client = createSimulationClient({WorkerClass: FakeWorker});
  const run = client.run('traffic', {});
  await assert.rejects(client.run('unknown', {}), {name: 'TypeError'});
  instances[0].reply({id: 1, trace: {ok: true}});
  assert.deepEqual(await run, {ok: true});
  client.destroy();
});

// Provide just the browser Worker event surface around a real Node thread. The
// production worker entrypoint is imported unchanged, exercising its real models.
class BrowserWorkerThread {
  constructor(url) {
    this.handlers = new Map();
    this.thread = new NodeWorker(new URL(`data:text/javascript,${encodeURIComponent(`
      import {parentPort} from 'node:worker_threads';
      globalThis.addEventListener = (type, callback) => {
        if (type === 'message') parentPort.on('message', data => callback({data}));
      };
      globalThis.postMessage = data => parentPort.postMessage(data);
      await import(${JSON.stringify(url.href)});
    `)}`));
  }
  addEventListener(type, callback) {
    const wrapper = type === 'message' ? data => callback({data})
      : type === 'error' ? error => callback({error, message: error.message}) : callback;
    this.handlers.set(callback, wrapper);
    this.thread.on(type, wrapper);
  }
  removeEventListener(type, callback) {
    this.thread.off(type, this.handlers.get(callback));
    this.handlers.delete(callback);
  }
  postMessage(data) { this.thread.postMessage(data); }
  terminate() { this.thread.terminate(); }
}

test('actual worker traffic and SM traces exactly match synchronous deterministic models', {timeout: 15000}, async () => {
  const client = createSimulationClient({WorkerClass: BrowserWorkerThread});
  try {
    const trafficConfig = {numSms: 4, numClusters: 2, l2Banks: 2, hbmStacks: 2, rounds: 2};
    assert.deepEqual(await client.run('traffic', trafficConfig), simulateTraffic(trafficConfig));
    const smConfig = {warpCount: 4, rounds: 2, sharedBankStrideWords: 2};
    assert.deepEqual(await client.run('sm', smConfig), simulateSm(smConfig));
    await assert.rejects(client.run('sm', {warpCount: 0}), {name: 'RangeError'});
    assert.deepEqual(await client.run('sm', {warpCount: 1}), simulateSm({warpCount: 1}));
  } finally {
    client.destroy();
  }
});
