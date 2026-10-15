import {simulateTraffic} from '../lib/traffic-model.js';
import {simulateSm} from '../lib/sm-model.js';

globalThis.addEventListener('message', ({data}) => {
  const {id, kind, config} = data ?? {};
  try {
    let trace;
    if (kind === 'traffic') trace = simulateTraffic(config);
    else if (kind === 'sm') trace = simulateSm(config);
    else throw new TypeError(`Unknown simulation kind: ${kind}`);
    globalThis.postMessage({id, trace});
  } catch (error) {
    globalThis.postMessage({id, error: {name: error?.name || 'Error', message: error?.message || String(error)}});
  }
});
