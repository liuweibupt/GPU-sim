/**
 * Hand-authored synthetic contracts plus seeded integer-grid variants.
 * These are model fixtures, not GPU observations or independent expert reviews.
 * Expected witnesses are declared here, never obtained from a production slice.
 */
const IDENTITY = {specId: 'tile-copy-v1', specHash: 'synthetic-spec-v1',
  inputId: 'synthetic-input-v1', semanticsId: 'toy-async-v1'};
const clone = value => structuredClone(value);

function run(id, nodes = []) {
  return {id, provenance: {kind: 'synthetic-model', model: 'toy-async-v1'},
    identity: {...IDENTITY}, capabilities: {logicalMapping: 'complete', accesses: 'complete', sync: 'complete'},
    nodes, edges: [], evidence: [], obligations: []};
}

function work(id, lo, hi, overrides = {}) {
  const {actual = 'A@0', expected = 'A@0', role = 'consume-A', iteration = 0,
    reduction = {lo: [0], hi: [4]}, mappingStatus = 'known', generation = 0} = overrides;
  return {id, type: 'operation', role, sourceLocation: role === 'epilogue' ? 'toy-kernel:80' : 'toy-kernel:40',
    logical: {tensor: 'A', region: {lo, hi}, iteration, reduction, mappingStatus,
      version: {expected, actual: actual === null ? {status: 'unknown'} : {status: 'known', value: actual}}},
    storage: {allocationId: 'smem-slot0', space: 'smem', lo: 0, hi: 128, generation}};
}

function correspondence(id, family, split, leftNodes, rightNodes) {
  return {id, family, rootCauseTemplate: family, split, left: run(`${id}:left`, leftNodes), right: run(`${id}:right`, rightNodes),
    metadata: {evidenceKind: 'synthetic-model', evaluationStatus: 'development-structural-coverage',
      preregistered: false, blinded: false, expertReviewed: false, realGpuMeasurement: false,
      generatedFrom: 'hand-authored-contract',
      claimScope: 'correspondence-given-declared-logical-mapping'}};
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
}

export function makeCorrespondenceCases({seed = 20261023} = {}) {
  const cases = [
    correspondence('same-work-renamed', 'identity-invariance', 'development',
      [work('old-id', [0, 0], [4, 4])], [work('new-id', [0, 0], [4, 4])]),
    correspondence('one-to-two-rows', 'row-retile', 'development',
      [work('whole', [0, 0], [4, 4])], [work('top', [0, 0], [2, 4]), work('bottom', [2, 0], [4, 4])]),
    correspondence('crossing-partitions', 'cross-retile', 'validation',
      [work('left', [0, 0], [4, 2]), work('right', [0, 2], [4, 4])],
      [work('top', [0, 0], [2, 4]), work('bottom', [2, 0], [4, 4])]),
    correspondence('wrong-actual-version-still-matches', 'actual-source-difference', 'development',
      [work('before', [0, 0], [4, 4])], [work('after', [0, 0], [4, 4], {actual: 'A@1'})]),
    correspondence('unknown-actual-still-matches', 'unknown-actual', 'validation',
      [work('before', [0, 0], [4, 4])], [work('after', [0, 0], [4, 4], {actual: null})]),
    correspondence('touching-half-open-regions', 'region-boundary', 'validation',
      [work('left', [0, 0], [2, 3])], [work('right', [2, 0], [4, 3])]),
    correspondence('nondivisible-tail', 'tail-retile', 'validation',
      [work('whole', [0, 0], [5, 7])],
      [work('top', [0, 0], [3, 7]), work('tail', [3, 0], [5, 7])]),
    correspondence('role-iteration-reduction', 'logical-context', 'development',
      [work('l0', [0, 0], [2, 2]),
        work('l1', [0, 0], [2, 2], {iteration: 1, expected: 'A@1', actual: 'A@1', generation: 1}),
        work('l-iteration-only', [0, 0], [2, 2], {iteration: 3}),
        work('l-version-only', [0, 0], [2, 2], {expected: 'A@1', actual: 'A@1'}),
        work('l-role', [0, 0], [2, 2], {role: 'epilogue'}),
        work('l-k', [0, 0], [2, 2], {reduction: {lo: [4], hi: [8]}})],
      [work('r-k', [0, 0], [2, 2], {reduction: {lo: [4], hi: [8]}}),
        work('r-role', [0, 0], [2, 2], {role: 'epilogue'}),
        work('r-version-only', [0, 0], [2, 2], {expected: 'A@1', actual: 'A@1'}),
        work('r-iteration-only', [0, 0], [2, 2], {iteration: 3}),
        work('r1', [0, 0], [2, 2], {iteration: 1, expected: 'A@1', actual: 'A@1', generation: 1}),
        work('r0', [0, 0], [2, 2])]),
    correspondence('same-parity-different-generation', 'generation-reuse', 'validation',
      [work('l-phase0', [0, 0], [2, 2]),
        work('l-phase2', [0, 0], [2, 2], {iteration: 2, expected: 'A@2', actual: 'A@2', generation: 2})],
      [work('r-phase2', [0, 0], [2, 2], {iteration: 2, expected: 'A@2', actual: 'A@0', generation: 2}),
        work('r-phase0', [0, 0], [2, 2])]),
    correspondence('partial-logical-mapping', 'partial-mapping', 'validation',
      [work('whole', [0, 0], [4, 4])],
      [work('known', [0, 0], [2, 4]), work('unknown', [2, 0], [4, 4], {mappingStatus: 'unknown'})]),
  ];
  // A source-line shift is a declared edit; other cases retain source locations
  // so the source-location baseline is not artificially reduced to ID matching.
  cases[0].right.nodes[0].sourceLocation = 'toy-kernel:44';
  cases.at(-1).right.capabilities.logicalMapping = 'partial';
  for (const field of ['specId', 'specHash', 'inputId', 'semanticsId']) {
    const fixture = correspondence(`incompatible-${field}`, 'incompatible-identity', 'validation',
      [work('left', [0, 0], [2, 2])], [work('right', [0, 0], [2, 2])]);
    fixture.right.identity[field] += '-other';
    cases.push(fixture);
  }
  const random = seededRandom(seed);
  for (let i = 0; i < 12; i++) {
    const rows = 3 + Math.floor(random() * 7), columns = 3 + Math.floor(random() * 7);
    const cutRow = 1 + Math.floor(random() * (rows - 1)), cutColumn = 1 + Math.floor(random() * (columns - 1));
    const fixture = correspondence(`seeded-cross-${i}`, 'cross-retile', 'validation',
      [work(`l${i}a`, [0, 0], [rows, cutColumn]), work(`l${i}b`, [0, cutColumn], [rows, columns])],
      [work(`r${i}a`, [0, 0], [cutRow, columns]), work(`r${i}b`, [cutRow, 0], [rows, columns])]);
    fixture.metadata = {...fixture.metadata, generatedFrom: 'seeded-integer-grid', seed, variant: i,
      dimensions: [rows, columns], independentRootCause: false};
    cases.push(fixture);
  }
  return cases;
}

function evidence(id, kind, fields = {}) { return {id, kind, ...fields}; }
function node(id, type = 'operation') { return {id, type}; }
function edge(id, from, to, type, evidenceRefs = []) { return {id, from, to, type, evidenceRefs}; }

function sliceCase(id, family, nodes, edges, evidenceRecords, obligations, seeds, expected, split = 'development') {
  const fixtureRun = run(id, nodes);
  fixtureRun.edges = edges;
  fixtureRun.evidence = evidenceRecords;
  fixtureRun.obligations = obligations;
  return {id, family, rootCauseTemplate: family, split, run: fixtureRun, seeds, expected,
    metadata: {evidenceKind: 'synthetic-model', evaluationStatus: 'development-structural-coverage',
      preregistered: false, blinded: false, realGpuMeasurement: false,
      truthMethod: 'hand-declared-required-witness',
      expertReviewed: false, claimScope: 'preservation-of-supplied-diagnostics-not-detection'}};
}

export function makeSliceCases() {
  const conflict = sliceCase('storage-conflict-outside-data-ancestors', 'storage-witness',
    [node('output'), node('reader'), node('writer-next'), node('allocation', 'storage'), node('distractor')],
    [edge('reader-output', 'reader', 'output', 'data'),
      edge('alias', 'reader', 'writer-next', 'storage-alias', ['overlap']),
      edge('allocation-reader', 'allocation', 'reader', 'storage-alias', ['allocation-generation'])],
    [evidence('overlap', 'model-read-write-overlap', {readerInterval: [2, 8], writerStart: 5}),
      evidence('allocation-generation', 'model-storage-identity', {allocationId: 'slot', readerGeneration: 0, writerGeneration: 1}),
      evidence('rule-live-reader', 'model-rule', {ruleId: 'toy.no-overwrite-live-reader'})],
    [{id: 'reuse-check', kind: 'safe-reuse', subjectIds: ['reader', 'writer-next'], ruleId: 'toy.no-overwrite-live-reader',
      status: 'violated', positiveWitnessRefs: ['overlap', 'allocation-generation', 'rule-live-reader'],
      witnessNodeIds: ['reader', 'writer-next', 'allocation'], witnessEdgeIds: ['alias', 'allocation-reader'], unknownRefs: []}],
    ['output'], {nodeIds: ['output', 'reader', 'writer-next', 'allocation'],
      edgeIds: ['reader-output', 'alias', 'allocation-reader'], obligationIds: ['reuse-check'], unknownRefs: []});
  const missing = sliceCase('missing-completion-remains-unknown', 'unknown-boundary',
    [node('output'), node('consumer'), node('producer'), node('distractor')],
    [edge('consumer-output', 'consumer', 'output', 'data'), edge('producer-consumer', 'producer', 'consumer', 'data')],
    [evidence('completion-gap', 'missing-observation', {scope: 'producer completion / consumer handoff'}),
      evidence('rule-handoff', 'model-rule', {ruleId: 'toy.consumer-needs-observed-handoff'})],
    [{id: 'handoff-check', kind: 'visibility', subjectIds: ['consumer'], ruleId: 'toy.consumer-needs-observed-handoff',
      status: 'unknown', positiveWitnessRefs: ['rule-handoff'], witnessNodeIds: ['producer', 'consumer'],
      witnessEdgeIds: ['producer-consumer'], unknownRefs: ['completion-gap']}],
    ['output'], {nodeIds: ['output', 'consumer', 'producer'], edgeIds: ['consumer-output', 'producer-consumer'],
      obligationIds: ['handoff-check'], unknownRefs: ['completion-gap']}, 'validation');
  missing.run.capabilities.sync = 'partial';
  const resource = sliceCase('resource-competitor-outside-data-ancestors', 'resource-witness',
    [node('output'), node('waiting'), node('competitor'), node('release'), node('distractor')],
    [edge('waiting-output', 'waiting', 'output', 'data'),
      edge('competitor-release', 'competitor', 'release', 'completion', ['lease']),
      edge('release-waiting', 'release', 'waiting', 'resource-wait', ['wait-record'])],
    [evidence('lease', 'model-resource-lease', {resource: 'toy-channel', owner: 'competitor'}),
      evidence('wait-record', 'model-scheduler-wait', {releasedBy: 'release'}),
      evidence('rule-resource', 'model-rule', {ruleId: 'toy.single-capacity-resource'})],
    [{id: 'wait-explanation', kind: 'resource-wait', subjectIds: ['waiting'], ruleId: 'toy.single-capacity-resource',
      status: 'satisfied', positiveWitnessRefs: ['lease', 'wait-record', 'rule-resource'],
      witnessNodeIds: ['waiting', 'competitor', 'release'], witnessEdgeIds: ['competitor-release', 'release-waiting'], unknownRefs: []}],
    ['output'], {nodeIds: ['output', 'waiting', 'competitor', 'release'],
      edgeIds: ['waiting-output', 'competitor-release', 'release-waiting'], obligationIds: ['wait-explanation'], unknownRefs: []}, 'validation');
  const phase = sliceCase('same-parity-different-phase-witness', 'phase-witness',
    [node('output'), node('consumer'), node('phase0', 'token'), node('phase2', 'token'), node('distractor')],
    [edge('consumer-output', 'consumer', 'output', 'data'),
      edge('phase0-consumer', 'phase0', 'consumer', 'completion', ['phase-expectation']),
      edge('phase2-consumer', 'phase2', 'consumer', 'completion', ['phase-observed'])],
    [evidence('phase-expectation', 'model-expected-token', {epoch: 0, parity: 0}),
      evidence('phase-observed', 'model-observed-token', {epoch: 2, parity: 0}),
      evidence('rule-phase', 'model-rule', {ruleId: 'toy.match-full-phase'})],
    [{id: 'phase-check', kind: 'completion-phase', subjectIds: ['consumer'], ruleId: 'toy.match-full-phase',
      status: 'violated', positiveWitnessRefs: ['phase-expectation', 'phase-observed', 'rule-phase'],
      witnessNodeIds: ['consumer', 'phase0', 'phase2'], witnessEdgeIds: ['phase0-consumer', 'phase2-consumer'], unknownRefs: []}],
    ['output'], {nodeIds: ['output', 'consumer', 'phase0', 'phase2'],
      edgeIds: ['consumer-output', 'phase0-consumer', 'phase2-consumer'], obligationIds: ['phase-check'], unknownRefs: []}, 'validation');
  const safe = sliceCase('completed-reader-before-reuse', 'satisfied-obligation',
    [node('output'), node('reader'), node('release'), node('writer-next'), node('distractor')],
    [edge('writer-output', 'writer-next', 'output', 'data'), edge('reader-release', 'reader', 'release', 'completion', ['completed']),
      edge('release-reuse', 'release', 'writer-next', 'reuse', ['reuse-order'])],
    [evidence('completed', 'model-completion', {at: 4}), evidence('reuse-order', 'model-order', {reuseAt: 5}),
      evidence('rule-safe', 'model-rule', {ruleId: 'toy.release-before-reuse'})],
    [{id: 'safe-check', kind: 'safe-reuse', subjectIds: ['writer-next'], ruleId: 'toy.release-before-reuse',
      status: 'satisfied', positiveWitnessRefs: ['completed', 'reuse-order', 'rule-safe'],
      witnessNodeIds: ['reader', 'release', 'writer-next'], witnessEdgeIds: ['reader-release', 'release-reuse'], unknownRefs: []}],
    ['output'], {nodeIds: ['output', 'reader', 'release', 'writer-next'],
      edgeIds: ['writer-output', 'reader-release', 'release-reuse'], obligationIds: ['safe-check'], unknownRefs: []});
  const noDiagnosis = sliceCase('no-diagnosis-does-not-invent-one', 'no-diagnostic',
    [node('output'), node('producer'), node('distractor')], [edge('producer-output', 'producer', 'output', 'data')],
    [], [], ['output'], {nodeIds: ['output', 'producer'], edgeIds: ['producer-output'], obligationIds: [], unknownRefs: []}, 'validation');
  return [conflict, missing, resource, phase, safe, noDiagnosis].map(clone);
}

/** Development-only CPU analysis sizes, excluded from E1/E2 case denominators. */
export function makeScaleCases() {
  const correspondenceCases = [], slicing = [];
  for (const count of [16, 64, 256, 1024]) {
    for (const distribution of ['disjoint-first-axis', 'overlapping-first-axis']) {
      const left = [], right = [];
      const disjoint = distribution === 'disjoint-first-axis';
      for (let i = 0; i < count; i++) {
        const start = i === 0 ? 0 : 2 * i - 1;
        const end = i === count - 1 ? 2 * count : 2 * i + 1;
        left.push(work(`left-${i}`, disjoint ? [2 * i, 0] : [0, 2 * i],
          disjoint ? [2 * i + 2, 1] : [1, 2 * i + 2]));
        right.push(work(`right-${i}`, disjoint ? [start, 0] : [0, start],
          disjoint ? [end, 1] : [1, end]));
      }
      const suffix = disjoint ? `${count}` : `overlap-${count}`;
      const matching = correspondence(`scale-correspondence-${suffix}`, 'scale-grid-retile', 'scaling', left, right);
      matching.metadata = {...matching.metadata, evaluationStatus: 'development-scale-only', scaleOnly: true,
        measurementScope: 'synthetic-CPU-analysis-not-GPU-execution', nodesPerRun: count,
        totalInputNodes: count * 2, logicalElementCount: count * 2, elementsPerNode: [1, 3], distribution,
        candidateFilterScope: 'one-axis-interval',
        expectedCandidateBehavior: disjoint ? 'local-interval-candidates' : 'quadratic-candidates-linear-output'};
      correspondenceCases.push(matching);
    }

    const fixed = makeSliceCases().find(item => item.family === 'storage-witness');
    const originalNodes = fixed.run.nodes.length;
    fixed.id = `scale-slicing-${count}`;
    fixed.family = 'scale-fixed-witness';
    fixed.rootCauseTemplate = 'storage-witness';
    fixed.split = 'scaling';
    fixed.run.id = fixed.id;
    for (let i = 0; i < count; i++) fixed.run.nodes.push(node(`unrelated-${i}`, 'unrelated-model-record'));
    fixed.metadata = {...fixed.metadata, evaluationStatus: 'development-scale-only', scaleOnly: true,
      measurementScope: 'synthetic-CPU-analysis-not-GPU-execution', additionalUnrelatedNodes: count,
      fixedBaselineNodes: originalNodes, totalInputNodes: count + originalNodes,
      topology: 'fixed-witness-plus-disconnected-nodes'};
    slicing.push(fixed);
  }
  return {correspondence: correspondenceCases, slicing};
}
