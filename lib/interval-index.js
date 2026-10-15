// Immutable trace intervals: build once, visit only branches that can be active.
// The same index/query semantics run in JS when WASM is unavailable or blocked.
let wasmModule = null;
let wasmLoading = null;

export function initializeIntervalWasm({bytes, url = new URL('./interval-query.wasm', import.meta.url)} = {}) {
  if (wasmModule) return Promise.resolve(true);
  if (wasmLoading) return wasmLoading;
  wasmLoading = (async () => {
    try {
      if (typeof WebAssembly === 'undefined') return false;
      if (!bytes) {
        const response = await fetch(url);
        if (!response.ok) return false;
        bytes = await response.arrayBuffer();
      }
      wasmModule = await WebAssembly.compile(bytes);
      return true;
    } catch { return false; }
  })();
  return wasmLoading;
}

export function intervalEngine() { return wasmModule ? 'wasm' : 'javascript'; }

export function countThrough(sorted, time) {
  let low = 0, high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] <= time) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function createIntervalIndex(values, {start = value => value.start, end = value => value.end} = {}) {
  const records = values.map((value, order) => ({value, order, start: start(value), end: end(value)}))
    .filter(record => Number.isFinite(record.start) && Number.isFinite(record.end) && record.end > record.start)
    .sort((a, b) => a.start - b.start || a.order - b.order);
  const size = records.length;
  let leaves = 1;
  while (leaves < size) leaves *= 2;
  const starts = Float64Array.from(records, record => record.start);
  const ends = Float64Array.from(records, record => record.end).sort();
  const maxEnds = new Float64Array(leaves * 2).fill(-Infinity);
  for (let i = 0; i < size; i++) maxEnds[leaves + i] = records[i].end;
  for (let i = leaves - 1; i > 0; i--) maxEnds[i] = Math.max(maxEnds[i * 2], maxEnds[i * 2 + 1]);
  let wasm = null, attempted = false;
  function upgrade() {
    if (!wasmModule || attempted || !size) return;
    attempted = true;
    try {
      // Each index owns its memory, so replacement traces are garbage collected.
      const memory = new WebAssembly.Memory({initial: 1});
      const instance = new WebAssembly.Instance(wasmModule, {env: {memory}});
      const startsAt = Number(instance.exports.__heap_base.value);
      const treeAt = startsAt + starts.byteLength;
      const outputAt = treeAt + maxEnds.byteLength;
      const required = outputAt + size * 4;
      if (required > memory.buffer.byteLength) memory.grow(Math.ceil(required / 65536) - 1);
      new Float64Array(memory.buffer, startsAt, size).set(starts);
      new Float64Array(memory.buffer, treeAt, maxEnds.length).set(maxEnds);
      wasm = {query: instance.exports.query_intervals, startsAt, treeAt, outputAt,
        output: new Uint32Array(memory.buffer, outputAt, size)};
    } catch { /* Indexed JS remains available if allocation/CSP blocks WASM. */ }
  }
  return {
    get engine() { return wasm ? 'wasm' : 'javascript'; },
    get size() { return size; },
    countStarted(time) { return Number.isFinite(time) ? countThrough(starts, time) : 0; },
    countEnded(time) { return Number.isFinite(time) ? countThrough(ends, time) : 0; },
    at(time) {
      if (!Number.isFinite(time) || !size) return [];
      upgrade();
      const found = [];
      if (wasm) {
        const count = wasm.query(wasm.startsAt, size, wasm.treeAt, leaves, time, wasm.outputAt);
        for (let i = 0; i < count; i++) found.push(records[wasm.output[i]]);
      } else {
        const through = countThrough(starts, time);
        function visit(node, left, right) {
          if (left >= through || maxEnds[node] <= time) return;
          if (right - left === 1) { found.push(records[left]); return; }
          const middle = (left + right) >>> 1;
          visit(node * 2, left, middle); visit(node * 2 + 1, middle, right);
        }
        visit(1, 0, leaves);
      }
      found.sort((a, b) => a.order - b.order);
      return found.map(record => record.value);
    },
  };
}
