/**
 * Bounded, synthetic-model oracle. This module deliberately does not import any
 * production matcher or slicer. It enumerates integer work atoms, rather than
 * computing rectangle intersections. It does not validate real compiler maps.
 */
const IDENTITY_FIELDS = ['specId', 'specHash', 'inputId', 'semanticsId'];
const MAX_ATOMS_PER_NODE = 100_000;

function coordinates(region) {
  if (!region || !Array.isArray(region.lo) || !Array.isArray(region.hi) ||
      region.lo.length === 0 || region.lo.length !== region.hi.length) {
    throw new TypeError('Oracle regions require equal, nonempty lo/hi arrays.');
  }
  let size = 1;
  for (let d = 0; d < region.lo.length; d++) {
    const lo = region.lo[d], hi = region.hi[d];
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo < 0 || hi < lo) {
      throw new RangeError('Oracle bounds must be nonnegative half-open integers.');
    }
    size *= hi - lo;
  }
  if (size > MAX_ATOMS_PER_NODE) throw new RangeError('Synthetic oracle atom limit exceeded.');
  const result = [];
  function visit(d, prefix) {
    if (d === region.lo.length) { result.push(prefix); return; }
    for (let value = region.lo[d]; value < region.hi[d]; value++) visit(d + 1, [...prefix, value]);
  }
  visit(0, []);
  return result;
}

function workKey(node, coordinate) {
  const logical = node.logical;
  return JSON.stringify([node.role, logical.tensor, logical.iteration,
    logical.reduction?.lo ?? null, logical.reduction?.hi ?? null,
    logical.version.expected, coordinate]);
}

function actualVersion(left, right) {
  const a = left.logical.version.actual, b = right.logical.version.actual;
  if (a?.status !== 'known' || b?.status !== 'known') return 'unknown';
  return a.value === b.value ? 'equal' : 'different';
}

function enumerateRun(run) {
  const atoms = new Map(), unknown = [];
  for (const node of run.nodes ?? []) {
    if (!node.logical) continue; // Non-work evidence nodes are not work atoms.
    if (node.logical.mappingStatus !== 'known') { unknown.push(node.id); continue; }
    if (typeof node.role !== 'string' || typeof node.logical.tensor !== 'string' ||
        !Number.isSafeInteger(node.logical.iteration) ||
        typeof node.logical.version?.expected !== 'string') {
      throw new TypeError(`Incomplete known logical mapping for ${node.id}.`);
    }
    for (const coordinate of coordinates(node.logical.region)) {
      const key = workKey(node, coordinate);
      const entries = atoms.get(key) ?? [];
      entries.push({node, coordinate});
      atoms.set(key, entries);
    }
  }
  return {atoms, unknown};
}

export function atomicCorrespondenceOracle(left, right) {
  const l = enumerateRun(left), r = enumerateRun(right);
  const completeIdentity = [left, right].every(run => IDENTITY_FIELDS.every(field =>
    typeof run.identity?.[field] === 'string' && run.identity[field].length > 0));
  const compatible = completeIdentity && IDENTITY_FIELDS.every(field => left.identity[field] === right.identity[field]);
  const metadata = {
    compatible,
    incompatibility: compatible ? null : completeIdentity ? 'identity-mismatch' : 'missing-identity',
    unknownNodeIds: {left: l.unknown.sort(), right: r.unknown.sort()},
    evidenceKind: 'synthetic-model',
    oracle: 'integer-enumeration-v1',
    validates: 'declared-logical-mapping-only',
  };
  const atoms = [];
  if (compatible) {
    for (const [key, leftEntries] of l.atoms) {
      for (const a of leftEntries) for (const b of r.atoms.get(key) ?? []) {
        atoms.push({leftId: a.node.id, rightId: b.node.id, coordinate: a.coordinate,
          logicalKey: JSON.stringify([IDENTITY_FIELDS.map(field => left.identity[field]), JSON.parse(key)]),
          actualVersion: actualVersion(a.node, b.node)});
      }
    }
  }
  atoms.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return {atoms, metadata};
}

/** Independently checks hand-declared slice obligations, not detector accuracy. */
export function checkDeclaredSliceWitness(slice, expected) {
  const fields = ['nodeIds', 'edgeIds', 'obligationIds', 'unknownRefs'];
  const missing = Object.fromEntries(fields.map(field => {
    const present = new Set(slice[field] ?? []);
    return [field, (expected[field] ?? []).filter(id => !present.has(id))];
  }));
  return {preserved: fields.every(field => missing[field].length === 0), missing,
    metadata: {oracle: 'hand-declared-witness-v1', evidenceKind: 'synthetic-model',
      validates: 'input-witness-retention-not-new-detection'}};
}
