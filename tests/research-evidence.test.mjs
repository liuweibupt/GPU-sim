import test from 'node:test';
import assert from 'node:assert/strict';
import {validateEvidenceRun, matchLogicalRegions, sliceEvidence} from '../lib/research/evidence.js';

function operation(id, lo = [0, 0], hi = [4, 4]) {
  return {id, type: 'consume', role: 'gemm', sourceLocation: 'kernel:12', logical: {
    tensor: 'C', region: {lo, hi}, reduction: {lo: [0], hi: [8]}, iteration: 0,
    mappingStatus: 'known', version: {expected: 'A:0', actual: {status: 'known', value: 'A:0'}}}};
}
function run(id = 'r') {
  return {id, provenance: {kind: 'synthetic-model', model: 'unit-fixture-v1'},
    identity: {specId: 'matmul', specHash: 'fixture-spec', inputId: 'input:1', semanticsId: 'fixed-order-fp32'},
    capabilities: {logicalMapping: 'complete', accesses: 'complete', sync: 'complete'},
    nodes: [operation('a')], edges: [], obligations: [], evidence: []};
}
function graph() {
  const r = run();
  r.nodes = ['load', 'consumer', 'overwrite', 'completion', 'unrelated', 'tail'].map(id => ({id, type: 'event'}));
  r.evidence = [{id: 'obs', kind: 'model-observation'}, {id: 'rule', kind: 'model-rule'},
    {id: 'missing', kind: 'unknown-boundary'}];
  r.edges = [
    {id: 'data', from: 'load', to: 'consumer', type: 'data', evidenceRefs: ['obs']},
    {id: 'done', from: 'consumer', to: 'completion', type: 'completion', evidenceRefs: ['obs']},
    {id: 'after', from: 'consumer', to: 'tail', type: 'data', evidenceRefs: ['obs']}];
  r.obligations = [{id: 'safe-reuse', kind: 'storage-reuse', ruleId: 'toy-rule-v1',
    subjectIds: ['consumer'], witnessNodeIds: ['consumer', 'overwrite', 'completion'], witnessEdgeIds: ['done'],
    positiveWitnessRefs: ['obs', 'rule'], unknownRefs: [], status: 'violated'}];
  return r;
}

test('many-to-many region correspondence preserves intersections', () => {
  const a = run('left'), b = run('right');
  a.nodes = [operation('left0', [0, 0], [4, 2]), operation('left1', [0, 2], [4, 4])];
  b.nodes = [operation('right0', [0, 0], [2, 4]), operation('right1', [2, 0], [4, 4])];
  const matches = matchLogicalRegions(a, b);
  assert.equal(matches.length, 4);
  assert.deepEqual(matches.map(x => x.region), [
    {lo: [0, 0], hi: [2, 2]}, {lo: [2, 0], hi: [4, 2]},
    {lo: [0, 2], hi: [2, 4]}, {lo: [2, 2], hi: [4, 4]}]);
});

test('erroneous actual source remains paired; unknown is never equality', () => {
  const a = run('left'), b = run('right');
  b.nodes[0].logical.version.actual.value = 'A:1';
  assert.equal(matchLogicalRegions(a, b)[0].actualVersion, 'different');
  b.nodes[0].logical.version.actual = {status: 'unknown'};
  assert.equal(matchLogicalRegions(a, b)[0].actualVersion, 'unknown');
  a.nodes[0].logical.version.actual = {status: 'unknown'};
  assert.equal(matchLogicalRegions(a, b)[0].actualVersion, 'unknown');
});

test('intended iteration, role, version, and reduction are identity constraints', () => {
  const a = run();
  const changes = [b => b.nodes[0].logical.iteration = 2,
    b => b.nodes[0].role = 'epilogue', b => b.nodes[0].logical.version.expected = 'A:2',
    b => b.nodes[0].logical.reduction.hi = [16]];
  for (const mutate of changes) {
    const b = run('other'); mutate(b);
    assert.deepEqual(matchLogicalRegions(a, b), []);
    assert.equal(matchLogicalRegions(a, b, {mode: 'region'}).length, 1);
  }
});

test('half-open touching boundaries and incompatible run identities do not pair', () => {
  const a = run(), b = run('other');
  b.nodes[0].logical.region = {lo: [4, 0], hi: [8, 4]};
  assert.deepEqual(matchLogicalRegions(a, b), []);
  for (const key of Object.keys(a.identity)) {
    const c = run('other'); c.identity[key] += ':changed';
    for (const mode of ['semantic', 'region', 'source']) assert.deepEqual(matchLogicalRegions(a, c, {mode}), []);
  }
});

test('partial mapping preserves known region and leaves unknown node unmatched', () => {
  const a = run(), b = run('other');
  const unknown = operation('unknown'); unknown.logical.mappingStatus = 'unknown';
  unknown.logical.region = null;
  b.nodes.push(unknown); b.capabilities.logicalMapping = 'partial';
  assert.equal(matchLogicalRegions(a, b).length, 1);
  b.capabilities.logicalMapping = 'complete';
  assert.throws(() => validateEvidenceRun(b), /partial/);
});

test('source baseline can miss semantically identical renamed operations', () => {
  const a = run(), b = run('other');
  b.nodes[0].sourceLocation = 'generated:99';
  assert.deepEqual(matchLogicalRegions(a, b, {mode: 'source'}), []);
  assert.equal(matchLogicalRegions(a, b).length, 1);
});

test('interval prefilter equals scan with nested intervals, shuffled order, and multiple dimensions', () => {
  const a = run(), b = run('other');
  a.nodes = [operation('x', [4, 3], [5, 7]), operation('y', [99, 0], [100, 1]),
    operation('z', [1, 8], [3, 9])];
  b.nodes = [operation('short', [3, 1], [5, 2]), operation('long', [0, 0], [100, 10]),
    operation('touch', [5, 3], [6, 7]), operation('middle', [4, 2], [9, 10]),
    operation('early', [0, 7], [4, 10])];
  const normalized = matches => matches.map(x => JSON.stringify(x)).sort();
  for (const mode of ['semantic', 'region', 'source']) {
    assert.deepEqual(normalized(matchLogicalRegions(a, b, {mode, strategy: 'interval'})),
      normalized(matchLogicalRegions(a, b, {mode, strategy: 'scan'})));
    assert.deepEqual(normalized(matchLogicalRegions(a, b, {mode, strategy: 'adaptive'})),
      normalized(matchLogicalRegions(a, b, {mode, strategy: 'scan'})));
  }
  assert.deepEqual(matchLogicalRegions(a, b).map(x => `${x.leftId}:${x.rightId}`).sort(),
    ['x:long', 'x:middle', 'y:long', 'z:early', 'z:long']);
});

test('adaptive axis handles transposed distributions and mixed ranks conservatively', () => {
  const a = run(), b = run('other');
  a.nodes = [operation('q', [0, 100], [1, 102]), operation('rank1', [0], [1])];
  b.nodes = [operation('low', [0, 0], [1, 2]), operation('high', [0, 101], [1, 103])];
  const expected = [{leftId: 'q', rightId: 'high', region: {lo: [0, 101], hi: [1, 102]}, actualVersion: 'equal'}];
  assert.deepEqual(matchLogicalRegions(a, b), expected);
  assert.deepEqual(matchLogicalRegions(a, b, {strategy: 'scan'}), expected);
  b.nodes.push(operation('rank1match', [0], [1]));
  const normalized = value => value.map(x => JSON.stringify(x)).sort();
  assert.deepEqual(normalized(matchLogicalRegions(a, b)), normalized(matchLogicalRegions(a, b, {strategy: 'scan'})));
});

test('large zero-output group does not exceed JavaScript argument limits', () => {
  const a = run(), b = run('large');
  a.nodes[0].logical.region = {lo: [10, 10], hi: [11, 11]};
  const prototype = operation('template');
  b.nodes = Array.from({length: 150000}, (_, i) => ({...prototype, id: `n${i}`}));
  assert.deepEqual(matchLogicalRegions(a, b), []);
});

test('slicing preserves supplied witness outside data ancestors without changing status', () => {
  const r = graph(), original = JSON.stringify(r);
  const slice = sliceEvidence(r, ['consumer']);
  assert.deepEqual(slice.nodes.map(x => x.id), ['load', 'consumer', 'overwrite', 'completion']);
  assert.equal(slice.obligations[0].status, 'violated');
  assert.deepEqual(slice.obligations[0], r.obligations[0]);
  assert.equal(slice.sliceMetadata.boundaryEdges[0].id, 'after');
  assert.equal(slice.capabilities.sync, 'partial');
  assert.equal(slice.sliceMetadata.sourceCapabilities.sync, 'complete');
  assert.equal(JSON.stringify(r), original);
  assert.equal(sliceEvidence(r, ['consumer'], {mode: 'data-ancestors'}).obligations.length, 0);
  validateEvidenceRun(slice);
  slice.obligations[0].status = 'unknown';
  assert.equal(r.obligations[0].status, 'violated', 'output must not alias input');
});

test('missing evidence remains unknown and is not upgraded to a violation', () => {
  const r = graph();
  r.capabilities.sync = 'partial';
  Object.assign(r.obligations[0], {status: 'unknown', positiveWitnessRefs: [], unknownRefs: ['missing']});
  const slice = sliceEvidence(r, ['consumer']);
  assert.equal(slice.obligations[0].status, 'unknown');
  assert.deepEqual(slice.sliceMetadata.unknownRefs, ['missing']);
  assert.ok(slice.evidence.some(x => x.id === 'missing'));
});

test('cycles terminate; resource-wait and alias context are retained', () => {
  const r = graph();
  r.edges.push({id: 'competition', from: 'unrelated', to: 'consumer', type: 'resource-wait', evidenceRefs: ['obs']},
    {id: 'alias', from: 'consumer', to: 'overwrite', type: 'storage-alias', evidenceRefs: ['obs']},
    {id: 'cycle', from: 'consumer', to: 'load', type: 'data', evidenceRefs: ['obs']});
  const slice = sliceEvidence(r, ['consumer']);
  assert.ok(slice.nodes.some(x => x.id === 'unrelated'));
  assert.ok(slice.edges.some(x => x.id === 'alias'));
  assert.ok(!slice.nodes.some(x => x.id === 'tail'));
});

test('no diagnosis is invented when no obligation was supplied', () => {
  const r = graph(); r.obligations = [];
  assert.deepEqual(sliceEvidence(r, ['consumer']).obligations, []);
});

test('re-slicing a projection cannot erase external boundaries or claim completeness', () => {
  const first = sliceEvidence(graph(), ['consumer'], {mode: 'data-ancestors'});
  assert.ok(first.sliceMetadata.boundaryEdges.length > 0);
  for (const mode of ['evidence', 'data-ancestors', 'full']) {
    assert.throws(() => sliceEvidence(first, ['consumer'], {mode}), /complete parent run/);
  }
  // A complete copy remains a valid source; only projections need retrieval.
  const full = sliceEvidence(graph(), ['consumer'], {mode: 'full'});
  assert.equal(sliceEvidence(full, ['consumer']).obligations[0].status, 'violated');
});

test('full graph baseline preserves all evidence and original capabilities', () => {
  const r = graph(), slice = sliceEvidence(r, ['consumer'], {mode: 'full'});
  for (const key of ['nodes', 'edges', 'obligations', 'evidence', 'capabilities']) assert.deepEqual(slice[key], r[key]);
});

test('invalid references, provenance and numeric bounds fail closed', () => {
  const cases = [r => r.provenance.kind = 'gpu-simulation-as-real',
    r => r.nodes.push(structuredClone(r.nodes[0])),
    r => r.nodes[0].logical.region.hi = [0, 4],
    r => r.nodes[0].logical.region.hi = [Number.MAX_SAFE_INTEGER, 4],
    r => r.nodes[0].logical.version.actual = {status: 'known'},
    r => r.edges.push({id: 'bad', from: 'a', to: 'missing', type: 'data', evidenceRefs: []})];
  for (const change of cases) { const r = run(); change(r); assert.throws(() => validateEvidenceRun(r)); }
  const r = graph(); r.obligations[0].positiveWitnessRefs = [];
  assert.throws(() => validateEvidenceRun(r), /positive evidence/);
  assert.throws(() => sliceEvidence(graph(), ['missing']), /missing/);
  assert.throws(() => sliceEvidence(graph(), []), /at least one/);
});
