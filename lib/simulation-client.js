function namedError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** Run the deterministic teaching models without blocking the browser UI.
 * Replacing a pending request terminates its worker, since a worker cannot
 * process a cancellation message while its synchronous model is still running.
 */
export function createSimulationClient({
  WorkerClass = globalThis.Worker,
  workerUrl = new URL('../web/simulation-worker.js', import.meta.url)
} = {}) {
  let worker = null, pending = null, nextId = 0, destroyed = false;

  function release(record) {
    if (!record) return;
    if (worker === record) worker = null;
    for (const [type, handler] of Object.entries(record.handlers)) {
      try { record.instance.removeEventListener(type, handler); } catch { /* Continue cleanup. */ }
    }
    try { record.instance.terminate(); } catch { /* Pending promises still settle. */ }
  }

  function fail(record, error) {
    const request = pending?.worker === record ? pending : null;
    if (request) pending = null;
    release(record);
    request?.reject(error);
  }

  function getWorker() {
    if (worker) return worker;
    if (typeof WorkerClass !== 'function') {
      throw namedError('NotSupportedError', 'This browser does not support simulation Web Workers.');
    }
    const record = {instance: new WorkerClass(workerUrl, {type: 'module'}), handlers: {}};
    record.handlers.message = event => {
      if (worker !== record || pending?.worker !== record) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || !Object.hasOwn(data, 'id')) {
        fail(record, new Error('Invalid simulation worker response.'));
        return;
      }
      if (data.id !== pending.id) return;
      const request = pending;
      if (data.error && typeof data.error === 'object') {
        pending = null;
        request.reject(namedError(data.error.name || 'Error', data.error.message || 'Simulation failed.'));
      } else if (data.trace && typeof data.trace === 'object' && !Array.isArray(data.trace)) {
        pending = null;
        request.resolve(data.trace);
      } else {
        fail(record, new Error('Invalid simulation worker response.'));
      }
    };
    record.handlers.error = event => {
      if (worker !== record) return;
      event.preventDefault?.();
      fail(record, event.error instanceof Error ? event.error : new Error(event.message || 'Simulation worker failed.'));
    };
    record.handlers.messageerror = () => {
      if (worker !== record) return;
      fail(record, namedError('DataCloneError', 'Could not read the simulation worker response.'));
    };
    worker = record;
    try {
      for (const [type, handler] of Object.entries(record.handlers)) record.instance.addEventListener(type, handler);
    } catch (error) {
      release(record);
      throw error;
    }
    return record;
  }

  function cancel() {
    const request = pending;
    pending = null;
    release(worker);
    request?.reject(namedError('AbortError', 'Simulation was cancelled.'));
  }

  function run(kind, config) {
    if (destroyed) return Promise.reject(namedError('InvalidStateError', 'Simulation client has been destroyed.'));
    if (kind !== 'traffic' && kind !== 'sm') return Promise.reject(new TypeError(`Unknown simulation kind: ${kind}`));
    if (pending) cancel();
    return new Promise((resolve, reject) => {
      let record;
      try {
        record = getWorker();
        const id = ++nextId;
        pending = {id, worker: record, resolve, reject};
        record.instance.postMessage({id, kind, config});
      } catch (error) {
        if (record && pending?.worker === record) fail(record, error);
        else reject(error);
      }
    });
  }

  return {
    run,
    cancel,
    destroy() { destroyed = true; cancel(); }
  };
}
