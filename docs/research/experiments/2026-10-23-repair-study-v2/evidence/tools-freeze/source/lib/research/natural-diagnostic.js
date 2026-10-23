/** Pure, bounded queries over archived natural-bug facts. No filesystem or network. */
const insist = (condition, message) => { if (!condition) throw Error(`Natural diagnostic: ${message}`); };
const clone = value => JSON.parse(JSON.stringify(value));
const unique = (items, label) => {
  insist(Array.isArray(items), `${label} must be an array`);
  const map = new Map();
  for (const item of items) {
    insist(item && typeof item.id === 'string' && item.id && !map.has(item.id), `duplicate/missing ${label} id`);
    map.set(item.id, item);
  }
  return map;
};
export function validateDiagnostic(data) {
  insist(data?.format === 'natural-gpu-diagnostic-v1', 'unsupported format');
  insist(['full', 'before-only'].includes(data.scope), 'explicit scope required');
  const cases = unique(data.cases, 'case'), sources = unique(data.sources, 'source'), evidence = unique(data.evidence, 'evidence');
  for (const source of sources.values()) {
    insist(typeof source.text === 'string' && /^[0-9a-f]{64}$/.test(source.sha256), 'source text/hash required');
  }
  for (const item of cases.values()) {
    insist(['cutlass', 'tmem'].includes(item.family), 'unknown family');
    insist(['passed', 'wrong_value', 'timeout', 'execution_error'].includes(item.status), 'unknown observed status');
    insist(item.parameters && Array.isArray(item.sourceRefs) && Array.isArray(item.evidenceRefs), 'case references required');
    for (const id of item.sourceRefs) insist(sources.has(id), `missing source ${id}`);
    for (const id of item.evidenceRefs) insist(evidence.has(id), `missing evidence ${id}`);
    if (data.scope === 'before-only') insist(item.version === 'input', 'benchmark contains another version');
  }
  for (const fact of evidence.values()) {
    insist(typeof fact.kind === 'string' && Array.isArray(fact.rawRefs) && fact.rawRefs.length, 'fact provenance required');
    for (const ref of fact.rawRefs) insist(typeof ref.id === 'string' && /^[0-9a-f]{64}$/.test(ref.sha256), 'raw reference required');
    if (fact.sourceId) insist(sources.has(fact.sourceId), 'fact source is missing');
  }
  return data;
}

function filtered(data, request) {
  return data.cases.filter(item => ['family', 'version', 'status'].every(key => request[key] == null || item[key] === request[key]) &&
    Object.entries(request.parameters || {}).every(([key, value]) => JSON.stringify(item.parameters[key]) === JSON.stringify(value)));
}

/** Reparse the provided MLIR; never reuse a saved diagnosis/repair label. */
export function parseAllocationIR(text) {
  insist(text.includes('colStride = 1'), 'unsupported allocation layout');
  const allocations = [], stores = [], loads = [], selects = {}, constants = {};
  text.split('\n').forEach((raw, index) => {
    const line = index + 1;
    let m = raw.match(/(%[\w.$]+) = arith.constant dense<([\d.eE+\-]+)> : tensor<\d+x\d+xf32/);
    if (m) constants[m[1]] = Number(m[2]);
    m = raw.match(/(%[\w.$]+) = ttng.tmem_alloc .*tensor_memory_col_offset = (\d+) : i32, tensor_memory_row_offset = (\d+) : i32.*!ttg.memdesc<(\d+)x(\d+)xf32/);
    if (m) {
      insist(Number(m[3]) === 0 && Number(m[4]) === 128, 'only 128-row, row-zero layouts are supported');
      allocations.push({ssa: m[1], line, rows: Number(m[4]), columns: Number(m[5]), interval: [Number(m[2]), Number(m[2]) + Number(m[5])], raw});
    }
    m = raw.match(/ttng.tmem_store (%[\w.$]+), (%[\w.$]+),/);
    if (m) stores.push({line, destination: m[2], value: constants[m[1]] ?? null, raw});
    m = raw.match(/(%[\w.$]+) = arith.select %[^,]+, (%[\w.$]+), (%[\w.$]+) : !ttg.memdesc/);
    if (m) selects[m[1]] = [m[2], m[3]];
    m = raw.match(/ = ttng.tmem_load (%[\w.$]+)/);
    if (m) loads.push({line, source: m[1], raw});
  });
  insist(allocations.length > 0, 'no allocation found');
  return {allocations, stores, loads, selects};
}

function overlap(data, item) {
  const facts = item.evidenceRefs.map(id => data.evidence.find(fact => fact.id === id));
  const ir = facts.find(fact => fact.kind === 'compiler-ir');
  if (!ir) return {caseId: item.id, supported: false, reason: 'No compiler allocation IR in this capture.', rawRefs: facts.flatMap(fact => fact.rawRefs)};
  const source = data.sources.find(entry => entry.id === ir.sourceId), parsed = parseAllocationIR(source.text);
  const byId = new Map(parsed.allocations.map(entry => [entry.ssa, entry]));
  const roots = (id, visited = []) => {
    insist(!visited.includes(id), 'cyclic descriptor select');
    if (byId.has(id)) return [id];
    insist(parsed.selects[id], 'unsupported selected descriptor');
    return [...new Set(parsed.selects[id].flatMap(next => roots(next, [...visited, id])))];
  };
  const candidates = [];
  for (const load of parsed.loads) {
    if (!parsed.selects[load.source]) continue;
    for (const id of roots(load.source)) {
      const allocation = byId.get(id), own = parsed.stores.filter(store => store.destination === id && store.line < load.line);
      insist(own.length === 1, 'unsupported source store multiplicity');
      for (const store of parsed.stores) {
        if (store.destination === id || !(allocation.line < store.line && store.line < load.line)) continue;
        const other = byId.get(store.destination);
        insist(other, 'store allocation absent');
        const lo = Math.max(allocation.interval[0], other.interval[0]), hi = Math.min(allocation.interval[1], other.interval[1]);
        if (lo < hi) candidates.push({selectedSource: id, selectedSourceValue: own[0].value, overwritingAllocation: other.ssa,
          overwritingValue: store.value, interval: [lo, hi], storeLine: store.line, loadLine: load.line,
          rawRefs: [{id: source.id, sha256: source.sha256, lines: [allocation.line, own[0].line, other.line, store.line, load.line]}]});
      }
    }
  }
  return {caseId: item.id, supported: true, sourceId: source.id, ...parsed, candidates,
    scope: 'Possible selected-source overlap in this straight-line 128-row compiler IR. No sampled hardware ordering or generic alias analysis.',
    rawRefs: [{id: source.id, sha256: source.sha256}, ...ir.rawRefs]};
}

/** Request ops: cases/list_cases, case, evidence, source, overlap, contrast. */
export function queryDiagnostic(data, request) {
  validateDiagnostic(data);
  insist(request && typeof request.op === 'string', 'query op required');
  let result;
  if (['cases', 'list_cases'].includes(request.op)) result = {cases: filtered(data, request)};
  else if (request.op === 'source') {
    const source = data.sources.find(item => item.id === request.id);
    insist(source, 'source not found');
    const lines = source.text.split('\n');
    const start = request.start ?? 1, end = request.end ?? lines.length;
    insist(Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start, 'invalid source range');
    if (request.search != null) insist(typeof request.search === 'string' && request.search.length > 0, 'nonempty literal search required');
    result = {...source, text: lines.slice(start - 1, end).join('\n'), start, end: Math.min(end, lines.length),
      matches: request.search == null ? [] : lines.flatMap((text, index) => text.includes(request.search) ? [{line: index + 1, text}] : [])};
  } else if (request.op === 'evidence') {
    result = data.evidence.find(item => item.id === request.id); insist(result, 'evidence not found');
  } else if (request.op === 'case' || request.op === 'overlap') {
    const item = data.cases.find(entry => entry.id === request.id); insist(item, 'case not found');
    result = request.op === 'overlap' ? overlap(data, item) : {case: item, evidence: item.evidenceRefs.map(id => data.evidence.find(fact => fact.id === id))};
  } else if (request.op === 'contrast') {
    const cases = filtered(data, request), keys = request.groupBy ?? ['version'];
    insist(Array.isArray(keys) && keys.length > 0 && keys.every(key => typeof key === 'string'), 'groupBy required');
    const groups = new Map();
    for (const item of cases) {
      const values = Object.fromEntries(keys.map(key => [key, key === 'hasZeroK' ? item.parameters.k?.includes(0) ?? null : item[key] ?? item.parameters[key] ?? null]));
      const key = JSON.stringify(values); if (!groups.has(key)) groups.set(key, {values, counts: {}, caseIds: [], rawRefs: []});
      const row = groups.get(key); row.counts[item.status] = (row.counts[item.status] ?? 0) + 1; row.caseIds.push(item.id);
      row.rawRefs.push(...item.evidenceRefs.flatMap(id => data.evidence.find(fact => fact.id === id).rawRefs));
    }
    result = {groups: [...groups.values()], scope: 'Descriptive grouping of supplied cases; association is not a causal diagnosis.'};
  } else throw Error(`Natural diagnostic: unsupported op ${request.op}`);
  return clone(result);
}

export const query = queryDiagnostic;
