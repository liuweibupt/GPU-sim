import test from 'node:test';
import assert from 'node:assert/strict';
import {makeCorrespondenceCases, makeSliceCases, makeScaleCases} from '../tools/research/corpus.mjs';
import {atomicCorrespondenceOracle, checkDeclaredSliceWitness} from '../tools/research/oracle.mjs';

const fixture = id => makeCorrespondenceCases().find(item => item.id === id);

test('independent enumerator agrees with hand-counted partition fixtures', () => {
  for (const [id, atomCount, pairCount] of [
    ['same-work-renamed', 16, 1], ['one-to-two-rows', 16, 2],
    ['crossing-partitions', 16, 4], ['nondivisible-tail', 35, 2],
    ['touching-half-open-regions', 0, 0], ['role-iteration-reduction', 24, 6],
  ]) {
    const {left, right} = fixture(id);
    const result = atomicCorrespondenceOracle(left, right);
    assert.equal(result.atoms.length, atomCount, id);
    assert.equal(new Set(result.atoms.map(atom => `${atom.leftId}/${atom.rightId}`)).size, pairCount, id);
    assert.equal(result.metadata.evidenceKind, 'synthetic-model');
  }
});

test('wrong or unknown actual source remains matched to intended work', () => {
  for (const [id, status] of [['wrong-actual-version-still-matches', 'different'], ['unknown-actual-still-matches', 'unknown']]) {
    const {left, right} = fixture(id);
    const result = atomicCorrespondenceOracle(left, right);
    assert.equal(result.atoms.length, 16);
    assert.ok(result.atoms.every(atom => atom.actualVersion === status));
  }
});

test('iteration and expected generation disambiguate repeated address/parity', () => {
  const {left, right} = fixture('same-parity-different-generation');
  const result = atomicCorrespondenceOracle(left, right);
  assert.equal(result.atoms.length, 8);
  assert.equal(result.atoms.filter(atom => atom.actualVersion === 'different').length, 4);
  assert.ok(result.atoms.every(atom => atom.leftId.slice(1) === atom.rightId.slice(1)));
});

test('partial mapping is abstention, distinct from unknown actual source', () => {
  const {left, right} = fixture('partial-logical-mapping');
  const result = atomicCorrespondenceOracle(left, right);
  assert.equal(result.atoms.length, 8);
  assert.deepEqual(result.metadata.unknownNodeIds, {left: [], right: ['unknown']});
});

test('incompatible identities never produce confident matches', () => {
  for (const item of makeCorrespondenceCases().filter(item => item.family === 'incompatible-identity')) {
    const result = atomicCorrespondenceOracle(item.left, item.right);
    assert.equal(result.metadata.compatible, false);
    assert.equal(result.atoms.length, 0);
  }
});

test('seeded variants are reproducible and cover the independently counted domain', () => {
  assert.deepEqual(makeCorrespondenceCases({seed: 42}), makeCorrespondenceCases({seed: 42}));
  for (const item of makeCorrespondenceCases().filter(item => item.metadata.dimensions)) {
    const [rows, columns] = item.metadata.dimensions;
    assert.equal(atomicCorrespondenceOracle(item.left, item.right).atoms.length, rows * columns);
    assert.equal(item.metadata.independentRootCause, false);
  }
});

test('declared slice truth references existing facts and witnesses outside data ancestry', () => {
  for (const item of makeSliceCases()) {
    const nodeIds = new Set(item.run.nodes.map(node => node.id));
    const edgeIds = new Set(item.run.edges.map(edge => edge.id));
    const evidenceIds = new Set(item.run.evidence.map(record => record.id));
    assert.ok(item.expected.nodeIds.every(id => nodeIds.has(id)));
    assert.ok(item.expected.edgeIds.every(id => edgeIds.has(id)));
    assert.ok(item.expected.unknownRefs.every(id => evidenceIds.has(id)));
    for (const obligation of item.run.obligations) {
      assert.ok(obligation.positiveWitnessRefs.every(id => evidenceIds.has(id)));
      assert.ok(obligation.witnessNodeIds.every(id => nodeIds.has(id)));
      assert.ok(obligation.witnessEdgeIds.every(id => edgeIds.has(id)));
    }
    assert.equal(item.metadata.expertReviewed, false);
    assert.equal(checkDeclaredSliceWitness(item.expected, item.expected).preserved, true);
  }
  const conflict = makeSliceCases().find(item => item.family === 'storage-witness');
  assert.ok(conflict.expected.nodeIds.includes('writer-next'));
  assert.ok(!conflict.run.edges.some(edge => edge.type === 'data' && edge.from === 'writer-next'));
});

test('witness oracle rejects loss of conflict evidence or unknown boundary', () => {
  for (const [family, field, id] of [
    ['storage-witness', 'nodeIds', 'writer-next'],
    ['storage-witness', 'edgeIds', 'alias'],
    ['unknown-boundary', 'unknownRefs', 'completion-gap'],
    ['resource-witness', 'nodeIds', 'competitor'],
  ]) {
    const item = makeSliceCases().find(item => item.family === family);
    const corrupted = structuredClone(item.expected);
    corrupted[field] = corrupted[field].filter(value => value !== id);
    const result = checkDeclaredSliceWitness(corrupted, item.expected);
    assert.equal(result.preserved, false);
    assert.ok(result.missing[field].includes(id));
  }
});

test('scale corpus bounds atomic work and keeps fixed witnesses unchanged', () => {
  const scales = makeScaleCases();
  assert.equal(scales.correspondence.length, 8);
  assert.equal(scales.slicing.length, 4);
  for (const item of scales.correspondence) {
    assert.equal(item.left.nodes.length, item.metadata.nodesPerRun);
    assert.equal(item.right.nodes.length, item.metadata.nodesPerRun);
    const result = atomicCorrespondenceOracle(item.left, item.right);
    assert.equal(result.atoms.length, 2 * item.metadata.nodesPerRun);
    assert.equal(new Set(result.atoms.map(atom => atom.logicalKey)).size, result.atoms.length);
    assert.equal(item.metadata.evaluationStatus, 'development-scale-only');
    const firstAxisSpans = new Set(item.left.nodes.map(node => JSON.stringify([node.logical.region.lo[0], node.logical.region.hi[0]])));
    assert.equal(firstAxisSpans.size, item.metadata.distribution === 'overlapping-first-axis' ? 1 : item.metadata.nodesPerRun);
  }
  const fixed = makeSliceCases().find(item => item.family === 'storage-witness');
  for (const item of scales.slicing) {
    assert.deepEqual(item.expected, fixed.expected);
    assert.deepEqual(item.run.obligations, fixed.run.obligations);
    assert.equal(item.run.nodes.length, item.metadata.additionalUnrelatedNodes + fixed.run.nodes.length);
    assert.equal(item.metadata.realGpuMeasurement, false);
  }
});
