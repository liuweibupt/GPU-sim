/**
 * Bounded research prototype: rectangular intended-work correspondence and
 * preservation of supplied diagnostic evidence. This is NOT an ISA checker,
 * race detector, GPU simulator, or an equivalence proof.
 */
const EDGE_TYPES = new Set(['data', 'storage-alias', 'happens-before', 'completion',
  'visibility', 'reuse', 'resource-wait']);
const IDENTITY_FIELDS = ['specId', 'specHash', 'inputId', 'semanticsId'];
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = value => typeof value === 'string' && value.length > 0;
function requireThat(condition, message) {
  if (!condition) throw new Error(`Research evidence: ${message}`);
}
function uniqueMap(items, label) {
  requireThat(Array.isArray(items), `${label} must be an array`);
  const map = new Map();
  for (const item of items) {
    requireThat(isRecord(item) && isId(item.id), `${label} needs nonempty IDs`);
    requireThat(!map.has(item.id), `duplicate ${label} ID ${item.id}`);
    map.set(item.id, item);
  }
  return map;
}
function references(ids, map, label) {
  requireThat(Array.isArray(ids), `${label} must be an array`);
  requireThat(new Set(ids).size === ids.length, `${label} contains duplicate references`);
  for (const id of ids) requireThat(map.has(id), `${label}: missing ${id}`);
}
function validateRegion(region, label) {
  requireThat(isRecord(region) && Array.isArray(region.lo) && Array.isArray(region.hi), `${label}: expected rectangle`);
  requireThat(region.lo.length > 0 && region.lo.length === region.hi.length, `${label}: rank mismatch`);
  let volume = 1;
  for (let i = 0; i < region.lo.length; i++) {
    const lo = region.lo[i], hi = region.hi[i];
    requireThat(Number.isSafeInteger(lo) && Number.isSafeInteger(hi) && hi > lo, `${label}: invalid half-open bounds`);
    volume *= hi - lo;
    requireThat(Number.isSafeInteger(volume), `${label}: volume exceeds exact integer range`);
  }
}

export function validateEvidenceRun(run) {
  requireThat(isRecord(run) && isId(run.id), 'run needs an ID');
  requireThat(isRecord(run.provenance) && ['synthetic-model', 'measurement', 'derived'].includes(run.provenance.kind), 'explicit provenance required');
  requireThat(isRecord(run.identity), 'run identity required');
  for (const key of IDENTITY_FIELDS) requireThat(isId(run.identity[key]), `identity.${key} required`);
  requireThat(isRecord(run.capabilities), 'capture capabilities required');
  for (const key of ['logicalMapping', 'accesses', 'sync']) {
    requireThat(['complete', 'partial'].includes(run.capabilities[key]), `capabilities.${key} must be complete/partial`);
  }
  const nodes = uniqueMap(run.nodes, 'nodes');
  const edges = uniqueMap(run.edges, 'edges');
  const evidence = uniqueMap(run.evidence, 'evidence');
  const obligations = uniqueMap(run.obligations, 'obligations');
  for (const item of evidence.values()) requireThat(isId(item.kind), `evidence ${item.id} needs kind`);
  for (const node of nodes.values()) {
    if (node.evidenceRefs != null) references(node.evidenceRefs, evidence, `node ${node.id} evidence`);
    if (!node.logical) continue;
    const logical = node.logical;
    requireThat(isId(node.role) && isId(logical.tensor), `node ${node.id}: role/tensor required`);
    requireThat(['known', 'unknown'].includes(logical.mappingStatus), `node ${node.id}: mappingStatus required`);
    if (logical.mappingStatus === 'unknown') {
      requireThat(run.capabilities.logicalMapping === 'partial', 'unknown mapping requires partial capability');
    } else {
      validateRegion(logical.region, `node ${node.id} region`);
      if (logical.reduction != null) validateRegion(logical.reduction, `node ${node.id} reduction`);
      requireThat(isId(logical.version?.expected), `node ${node.id}: expected version required`);
      requireThat(isId(logical.iteration) || Number.isSafeInteger(logical.iteration), `node ${node.id}: iteration required`);
    }
    requireThat(['known', 'unknown'].includes(logical.version?.actual?.status), `node ${node.id}: explicit actual source status required`);
    if (logical.version.actual.status === 'known') requireThat(isId(logical.version.actual.value), `node ${node.id}: actual version required`);
  }
  for (const edge of edges.values()) {
    requireThat(nodes.has(edge.from) && nodes.has(edge.to), `edge ${edge.id}: missing endpoint`);
    requireThat(EDGE_TYPES.has(edge.type), `edge ${edge.id}: unsupported type`);
    references(edge.evidenceRefs, evidence, `edge ${edge.id} evidence`);
  }
  for (const obligation of obligations.values()) {
    requireThat(isId(obligation.kind) && isId(obligation.ruleId), `obligation ${obligation.id}: kind/rule required`);
    requireThat(['satisfied', 'violated', 'unknown'].includes(obligation.status), `obligation ${obligation.id}: invalid status`);
    references(obligation.subjectIds, nodes, `obligation ${obligation.id} subjects`);
    requireThat(obligation.subjectIds.length > 0, `obligation ${obligation.id}: no subjects`);
    references(obligation.witnessNodeIds, nodes, `obligation ${obligation.id} witness nodes`);
    references(obligation.witnessEdgeIds, edges, `obligation ${obligation.id} witness edges`);
    references(obligation.positiveWitnessRefs, evidence, `obligation ${obligation.id} positive evidence`);
    references(obligation.unknownRefs, evidence, `obligation ${obligation.id} unknown evidence`);
    if (obligation.status === 'unknown') {
      requireThat(obligation.unknownRefs.length > 0, `obligation ${obligation.id}: unknown needs explicit boundary`);
    } else {
      requireThat(obligation.positiveWitnessRefs.length > 0, `obligation ${obligation.id}: supplied conclusion needs positive evidence`);
    }
  }
  return run;
}

function intersection(a, b) {
  if (a.lo.length !== b.lo.length) return null;
  const lo = a.lo.map((v, i) => Math.max(v, b.lo[i]));
  const hi = a.hi.map((v, i) => Math.min(v, b.hi[i]));
  if (lo.some((v, i) => hi[i] <= v)) return null;
  return {lo, hi};
}
function sourceKey(node) {
  return node.sourceLocation ?? node.source?.location ?? node.name ?? node.id;
}
function groupKey(node, mode) {
  const logical = node.logical;
  if (mode === 'source') return JSON.stringify([logical.tensor, sourceKey(node)]);
  if (mode === 'region') return JSON.stringify([logical.tensor]);
  // The intended version is an identity constraint. The observed version is
  // deliberately excluded: erroneous reads must remain comparable.
  return JSON.stringify([logical.tensor, node.role, logical.iteration,
    logical.version.expected, logical.reduction?.lo ?? null, logical.reduction?.hi ?? null]);
}
function actualDifference(left, right) {
  if (left.status !== 'known' || right.status !== 'known') return 'unknown';
  return left.value === right.value ? 'equal' : 'different';
}

function firstGreater(values, threshold) {
  let lo = 0, hi = values.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (values[mid] > threshold) hi = mid; else lo = mid + 1;
  }
  return lo;
}
function firstAtLeast(items, upper) {
  let lo = 0, hi = items.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (items[mid].logical.region.lo[0] >= upper) hi = mid; else lo = mid + 1;
  }
  return lo;
}

/** Exact reduction domains only; changed reduction partitioning is unsupported. */
export function matchLogicalRegions(left, right, {mode = 'semantic', strategy = 'interval'} = {}) {
  validateEvidenceRun(left); validateEvidenceRun(right);
  requireThat(['semantic', 'region', 'source'].includes(mode), 'unknown correspondence mode');
  requireThat(['scan', 'interval'].includes(strategy), 'unknown correspondence strategy');
  if (IDENTITY_FIELDS.some(key => left.identity[key] !== right.identity[key])) return [];
  const groups = new Map();
  for (const node of right.nodes) {
    if (node.logical?.mappingStatus !== 'known') continue;
    const key = groupKey(node, mode);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  const indexes = new Map();
  if (strategy === 'interval') for (const [key, items] of groups) {
    // Conventional one-axis interval prefilter, not a new matching semantics.
    // Prefix maxima retain long overlapping intervals; exact N-D intersection
    // below is still required. Adversarial overlap can remain quadratic.
    items.sort((a, b) => a.logical.region.lo[0] - b.logical.region.lo[0]);
    let maximum = -Infinity;
    const prefixHigh = items.map(node => maximum = Math.max(maximum, node.logical.region.hi[0]));
    indexes.set(key, prefixHigh);
  }
  const matches = [];
  for (const a of left.nodes) {
    if (a.logical?.mappingStatus !== 'known') continue;
    const key = groupKey(a, mode), candidates = groups.get(key) ?? [];
    const start = strategy === 'interval' ? firstGreater(indexes.get(key) ?? [], a.logical.region.lo[0]) : 0;
    const end = strategy === 'interval' ? firstAtLeast(candidates, a.logical.region.hi[0]) : candidates.length;
    for (let i = start; i < end; i++) {
      const b = candidates[i];
      const region = intersection(a.logical.region, b.logical.region);
      if (region) matches.push({leftId: a.id, rightId: b.id, region,
        actualVersion: actualDifference(a.logical.version.actual, b.logical.version.actual)});
    }
  }
  return matches;
}

/**
 * Preserve supplied obligations and their evidence. The prototype does not
 * infer an obligation's truth from timestamps or from a missing edge.
 */
export function sliceEvidence(run, seedIds, {mode = 'evidence'} = {}) {
  validateEvidenceRun(run);
  requireThat(run.sliceMetadata?.isProjection !== true,
    'cannot slice a projection: retrieve the complete parent run to preserve external boundaries');
  requireThat(['evidence', 'data-ancestors', 'full'].includes(mode), 'unknown slicing mode');
  const nodes = new Map(run.nodes.map(node => [node.id, node]));
  const edges = new Map(run.edges.map(edge => [edge.id, edge]));
  references(seedIds, nodes, 'slice seeds');
  requireThat(seedIds.length > 0, 'at least one slice seed required');
  const selected = new Set(mode === 'full' ? nodes.keys() : seedIds);
  const obligationIds = new Set();
  if (mode === 'full') for (const item of run.obligations) obligationIds.add(item.id);
  if (mode !== 'full') {
    let changed = true;
    while (changed) {
      changed = false;
      const add = id => { if (!selected.has(id)) { selected.add(id); changed = true; } };
      for (const edge of run.edges) {
        if (mode === 'data-ancestors' && edge.type !== 'data') continue;
        if (selected.has(edge.to)) add(edge.from);
        if (mode === 'evidence' && edge.type === 'storage-alias' && selected.has(edge.from)) add(edge.to);
      }
      if (mode === 'evidence') for (const item of run.obligations) {
        if (!item.subjectIds.some(id => selected.has(id))) continue;
        if (!obligationIds.has(item.id)) { obligationIds.add(item.id); changed = true; }
        for (const id of [...item.subjectIds, ...item.witnessNodeIds]) add(id);
        for (const id of item.witnessEdgeIds) { add(edges.get(id).from); add(edges.get(id).to); }
      }
    }
  }
  const keptEdges = run.edges.filter(edge => selected.has(edge.from) && selected.has(edge.to));
  const keptEdgeIds = new Set(keptEdges.map(edge => edge.id));
  if (mode === 'data-ancestors') {
    // This comparison baseline can only retain a supplied diagnostic when its
    // entire witness survived. It cannot silently present a truncated witness.
    for (const item of run.obligations) {
      if ([...item.subjectIds, ...item.witnessNodeIds].every(id => selected.has(id)) &&
          item.witnessEdgeIds.every(id => keptEdgeIds.has(id))) obligationIds.add(item.id);
    }
  }
  const obligations = run.obligations.filter(item => obligationIds.has(item.id));
  const evidenceIds = new Set();
  if (mode === 'full') for (const item of run.evidence) evidenceIds.add(item.id);
  for (const node of run.nodes) if (selected.has(node.id)) for (const id of node.evidenceRefs ?? []) evidenceIds.add(id);
  for (const edge of keptEdges) for (const id of edge.evidenceRefs) evidenceIds.add(id);
  for (const item of obligations) {
    for (const id of [...item.positiveWitnessRefs, ...item.unknownRefs]) evidenceIds.add(id);
  }
  const boundaryEdges = run.edges.filter(edge => selected.has(edge.from) !== selected.has(edge.to));
  for (const edge of boundaryEdges) for (const id of edge.evidenceRefs) evidenceIds.add(id);
  // Keep source capabilities in metadata; the projection itself is partial.
  // Missing edges are never evidence of absent synchronization.
  return structuredClone({...run, nodes: run.nodes.filter(node => selected.has(node.id)),
    edges: keptEdges, obligations, evidence: run.evidence.filter(item => evidenceIds.has(item.id)),
    capabilities: mode === 'full' ? run.capabilities : {logicalMapping: 'partial', accesses: 'partial', sync: 'partial'},
    sliceMetadata: {mode, parentRunId: run.id, seedIds: [...seedIds],
      boundaryEdges, sourceNodeCount: run.nodes.length, sourceEdgeCount: run.edges.length,
      isProjection: mode !== 'full', infersNewDiagnosis: false,
      sourceCapabilities: run.capabilities,
      unknownRefs: [...new Set(obligations.flatMap(item => item.unknownRefs))]}});
}
