#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { matchLogicalRegions, sliceEvidence } from '../../lib/research/evidence.js';
import { makeCorrespondenceCases, makeSliceCases, makeScaleCases } from './corpus.mjs';
import { atomicCorrespondenceOracle } from './oracle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourcePaths = ['tools/research/run-model-experiments.mjs', 'tools/research/corpus.mjs',
  'tools/research/oracle.mjs', 'lib/research/evidence.js'];
const matchConfigurations = {
  source: { mode: 'source', strategy: 'adaptive' },
  region: { mode: 'region', strategy: 'adaptive' },
  'semantic-scan': { mode: 'semantic', strategy: 'scan' },
  'semantic-fixed-axis': { mode: 'semantic', strategy: 'interval' },
  semantic: { mode: 'semantic', strategy: 'adaptive' },
};
const matchModes = Object.keys(matchConfigurations);
const sliceModes = ['full', 'data-ancestors', 'evidence'];
const provenance = 'synthetic-model';

function argumentsFrom(argv) {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  const options = { output: path.join(root, 'out/research/model', timestamp), seed: 20261023, samples: 30, warmups: 5 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help') {
      console.log('node tools/research/run-model-experiments.mjs [--output DIR] [--seed INTEGER] [--samples 30] [--warmups 5]');
      process.exit(0);
    }
    if (!['--output', '--seed', '--samples', '--warmups'].includes(flag) || argv[index + 1] === undefined) {
      throw new Error(`Unknown option or missing value: ${flag}`);
    }
    const value = argv[++index];
    const key = flag.slice(2);
    options[key] = key === 'output' ? path.resolve(value) : Number(value);
    if (key !== 'output' && (!Number.isSafeInteger(options[key]) || options[key] < (key === 'samples' ? 1 : 0))) {
      throw new Error(`${flag} must be a ${key === 'samples' ? 'positive' : 'nonnegative'} safe integer`);
    }
  }
  return options;
}

const ratio = (numerator, denominator) => denominator === 0 ? null : numerator / denominator;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const unique = (values) => [...new Set(values)];
const intersection = (a, b) => [...a].filter((entry) => b.has(entry));

function integerCoordinates(region) {
  const { lo, hi } = region;
  if (!Array.isArray(lo) || lo.length === 0 || lo.length !== hi?.length || lo.some((v, i) => !Number.isSafeInteger(v) || !Number.isSafeInteger(hi[i]) || hi[i] <= v)) {
    throw new Error(`Invalid integer half-open region: ${JSON.stringify(region)}`);
  }
  const count = lo.reduce((product, value, i) => product * (hi[i] - value), 1);
  if (!Number.isSafeInteger(count) || count > 1_000_000) throw new Error(`Atomic scoring bound exceeded: ${count}`);
  const result = [];
  function enumerate(prefix, dimension) {
    if (dimension === lo.length) { result.push(prefix); return; }
    for (let value = lo[dimension]; value < hi[dimension]; value += 1) enumerate([...prefix, value], dimension + 1);
  }
  enumerate([], 0);
  return result;
}

function atomKey(atom) { return JSON.stringify([atom.leftId, atom.rightId, atom.coordinate]); }

function correspondenceTopology(atoms) {
  if (atoms.length === 0) return 'no-known-correspondence';
  const leftPartners = new Map(), rightPartners = new Map();
  for (const atom of atoms) {
    if (!leftPartners.has(atom.leftId)) leftPartners.set(atom.leftId, new Set());
    if (!rightPartners.has(atom.rightId)) rightPartners.set(atom.rightId, new Set());
    leftPartners.get(atom.leftId).add(atom.rightId);
    rightPartners.get(atom.rightId).add(atom.leftId);
  }
  const leftBranches = [...leftPartners.values()].some((partners) => partners.size > 1);
  const rightBranches = [...rightPartners.values()].some((partners) => partners.size > 1);
  return leftBranches ? (rightBranches ? 'many-to-many' : 'one-to-many') : (rightBranches ? 'many-to-one' : 'one-to-one');
}

function scoreCorrespondence(relations, oracle, left, right) {
  const predicted = new Map();
  let expandedCount = 0;
  for (const relation of relations) {
    for (const coordinate of integerCoordinates(relation.region)) {
      const atom = { leftId: relation.leftId, rightId: relation.rightId, coordinate, actualVersion: relation.actualVersion };
      const key = atomKey(atom);
      if (predicted.has(key) && predicted.get(key).actualVersion !== atom.actualVersion) throw new Error(`Contradictory duplicate relation: ${key}`);
      predicted.set(key, atom);
      expandedCount += 1;
    }
  }
  const expected = new Map(oracle.atoms.map((atom) => [atomKey(atom), atom]));
  if (expected.size !== oracle.atoms.length) throw new Error('Oracle emitted duplicate atomic relations');
  const correctKeys = intersection(new Set(predicted.keys()), new Set(expected.keys()));
  const classNames = ['equal', 'different', 'unknown'];
  const confusion = Object.fromEntries(classNames.map((actual) => [actual, Object.fromEntries(classNames.map((predictedClass) => [predictedClass, 0]))]));
  let correctVersions = 0;
  for (const key of correctKeys) {
    const actual = expected.get(key).actualVersion;
    const predictedClass = predicted.get(key).actualVersion;
    if (!classNames.includes(actual) || !classNames.includes(predictedClass)) throw new Error('Unrecognized actual-version class');
    confusion[actual][predictedClass] += 1;
    if (actual === predictedClass) correctVersions += 1;
  }
  const sideCoverage = {};
  for (const side of ['left', 'right']) {
    const idField = `${side}Id`;
    const expectedUnits = new Set([...expected.values()].map((a) => JSON.stringify([a[idField], a.coordinate])));
    const recoveredUnits = new Set(correctKeys.map((key) => expected.get(key)).map((a) => JSON.stringify([a[idField], a.coordinate])));
    const unknownNodeIds = oracle.metadata?.unknownNodeIds?.[side] ?? [];
    const allNodeIds = (side === 'left' ? left : right).nodes.map((node) => node.id);
    const matchedNodeIds = new Set([...predicted.values()].map((a) => a[idField]));
    sideCoverage[side] = {
      expectedNodeCoordinateUnits: expectedUnits.size, recoveredNodeCoordinateUnits: recoveredUnits.size,
      coverage: ratio(recoveredUnits.size, expectedUnits.size), nodeCount: allNodeIds.length,
      unmatchedNodeIds: allNodeIds.filter((id) => !matchedNodeIds.has(id)),
      unmatchedNodeRate: ratio(allNodeIds.filter((id) => !matchedNodeIds.has(id)).length, allNodeIds.length),
      unknownMappingNodeIds: unknownNodeIds,
      unknownMappingNodeRate: ratio(unknownNodeIds.length, allNodeIds.length),
    };
  }
  const logicalKeysAvailable = oracle.atoms.every((atom) => typeof atom.logicalKey === 'string');
  const expectedLogical = new Set(oracle.atoms.map((atom) => atom.logicalKey));
  const recoveredLogical = new Set(correctKeys.map((key) => expected.get(key).logicalKey));
  return {
    predictedAtomicRelations: predicted.size, expectedAtomicRelations: expected.size,
    correctAtomicRelations: correctKeys.length, falsePositiveAtomicRelations: predicted.size - correctKeys.length,
    falseNegativeAtomicRelations: expected.size - correctKeys.length,
    precision: ratio(correctKeys.length, predicted.size), recall: ratio(correctKeys.length, expected.size),
    emittedRegionRelations: relations.length, duplicateAtomicRelations: expandedCount - predicted.size,
    versionClassCorrect: correctVersions, versionClassEvaluated: correctKeys.length,
    versionClassAccuracy: ratio(correctVersions, correctKeys.length), versionConfusion: confusion,
    expectedVersionClasses: Object.fromEntries(classNames.map((name) => [name, oracle.atoms.filter((a) => a.actualVersion === name).length])),
    predictedVersionClasses: Object.fromEntries(classNames.map((name) => [name, [...predicted.values()].filter((a) => a.actualVersion === name).length])),
    unknownVersionFalseCertaintyCount: confusion.unknown.equal + confusion.unknown.different,
    sideCoverage,
    logicalElementCoverage: logicalKeysAvailable ? { expected: expectedLogical.size, recovered: recoveredLogical.size, ratio: ratio(recoveredLogical.size, expectedLogical.size) } : null,
    falsePositiveExamples: [...predicted.keys()].filter((key) => !expected.has(key)).slice(0, 20),
    falseNegativeExamples: [...expected.keys()].filter((key) => !predicted.has(key)).slice(0, 20),
  };
}

function scoreRequired(expected, retained) {
  const required = new Set(expected.map(canonical));
  const actual = new Set(retained.map(canonical));
  const recovered = intersection(required, actual);
  return { required: required.size, retained: recovered.length, recall: ratio(recovered.length, required.size), missing: [...required].filter((value) => !actual.has(value)) };
}

function scoreSlice(testCase, sliced) {
  const expected = testCase.expected;
  const ids = (items) => (items ?? []).map((item) => item.id);
  const evidence = sliced.evidence ?? [];
  const evidenceIds = ids(evidence);
  const expectedObligations = testCase.run.obligations.filter((item) => expected.obligationIds.includes(item.id));
  const expectedPositiveRefs = unique(expectedObligations.flatMap((item) => item.positiveWitnessRefs));
  const retainedUnknownRefs = (sliced.sliceMetadata?.unknownRefs ?? []).filter((ref) => evidenceIds.includes(ref));
  const categories = {
    nodes: scoreRequired(expected.nodeIds ?? [], ids(sliced.nodes)),
    edges: scoreRequired(expected.edgeIds ?? [], ids(sliced.edges)),
    obligations: scoreRequired(expected.obligationIds ?? [], ids(sliced.obligations)),
    unknown: scoreRequired(expected.unknownRefs ?? [], retainedUnknownRefs),
    positiveEvidence: scoreRequired(expectedPositiveRefs, evidenceIds),
    obligationStatuses: scoreRequired(expectedObligations.map((item) => [item.id, item.status]),
      (sliced.obligations ?? []).map((item) => [item.id, item.status])),
  };
  const originalBytes = Buffer.byteLength(JSON.stringify(testCase.run));
  const slicedBytes = Buffer.byteLength(JSON.stringify(sliced));
  const requiredTotal = Object.values(categories).reduce((sum, category) => sum + category.required, 0);
  const retainedTotal = Object.values(categories).reduce((sum, category) => sum + category.retained, 0);
  return {
    categories, requiredTotal, retainedTotal, evidenceRetention: ratio(retainedTotal, requiredTotal),
    completeWitnessRetained: expectedObligations.length === 0 ? null : retainedTotal === requiredTotal,
    nodes: { original: testCase.run.nodes.length, retained: sliced.nodes.length, ratio: ratio(sliced.nodes.length, testCase.run.nodes.length) },
    edges: { original: testCase.run.edges.length, retained: sliced.edges.length, ratio: ratio(sliced.edges.length, testCase.run.edges.length) },
    obligations: { original: (testCase.run.obligations ?? []).length, retained: (sliced.obligations ?? []).length, ratio: ratio((sliced.obligations ?? []).length, (testCase.run.obligations ?? []).length) },
    bytes: { original: originalBytes, retained: slicedBytes, ratio: ratio(slicedBytes, originalBytes) },
    byteScope: 'UTF-8 JSON serialization including sliceMetadata; not process memory',
  };
}

function quantile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low);
}

function makeRandom(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 0x100000000; };
}

function measureMethods(methods, options, random) {
  const timings = Object.fromEntries(Object.keys(methods).map((method) => [method, []]));
  const errors = {};
  let checksum = 0;
  for (let repeat = -options.warmups; repeat < options.samples; repeat += 1) {
    const order = Object.keys(methods);
    for (let index = order.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [order[index], order[swap]] = [order[swap], order[index]];
    }
    for (const method of order) {
      if (errors[method]) continue;
      try {
        const start = performance.now();
        const result = methods[method]();
        const elapsed = performance.now() - start;
        checksum += Array.isArray(result) ? result.length : result.nodes.length;
        if (repeat >= 0) timings[method].push(elapsed);
      } catch (error) { errors[method] = { message: error.message, stack: error.stack }; }
    }
  }
  return Object.fromEntries(Object.entries(timings).map(([method, values]) => [method, {
    ...(errors[method] ? { error: errors[method] } : {}),
    unit: 'ms', scope: 'host-wall-core-call', samples: values, median: quantile(values, 0.5),
    p95: quantile(values, 0.95), minimum: values.length ? Math.min(...values) : null, maximum: values.length ? Math.max(...values) : null,
    warmupCallsRequested: options.warmups, measuredCallsRequested: options.samples, measuredCalls: values.length, checksum,
  }]));
}

function sum(records, key) { return records.reduce((total, record) => total + (record.metrics[key] ?? 0), 0); }

function aggregate(records) {
  const groups = new Map();
  for (const record of records) {
    for (const [dimension, value] of [['all', 'all'], ['family', record.family], ['split', record.split], ['family/split', `${record.family}/${record.split}`],
      ...(record.experiment === 'E1' ? [['topology', record.topology]] : []),
      ...(record.experiment === 'E7' ? [['distribution', record.distribution]] : [])]) {
      const key = JSON.stringify([record.experiment, record.method, dimension, value]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);
    }
  }
  return [...groups.entries()].map(([key, members]) => {
    const [experiment, method, dimension, value] = JSON.parse(key);
    const valid = members.filter((record) => record.status === 'ok');
    const base = { experiment, method, dimension, value, caseCount: members.length,
      evaluatedCaseCount: valid.length, failedCaseCount: members.length - valid.length,
      templateLabels: unique(members.map((record) => record.template)),
      independentRealBugCount: 0,
      cpuMedianOfCaseMediansMs: quantile(valid.map((record) => record.timing.median), 0.5),
      cpuP95OfCaseMediansMs: quantile(valid.map((record) => record.timing.median), 0.95) };
    if (experiment === 'E7') return { ...base, functionKinds: unique(members.map((record) => record.functionKind)),
      inputNodeCounts: unique(members.map((record) => record.inputNodeCount)).sort((a, b) => a - b) };
    if (experiment === 'E1') {
      const correct = sum(valid, 'correctAtomicRelations');
      const predicted = sum(valid, 'predictedAtomicRelations');
      const expected = sum(valid, 'expectedAtomicRelations');
      return { ...base, correctAtomicRelations: correct, predictedAtomicRelations: predicted,
        expectedAtomicRelations: expected, microPrecision: ratio(correct, predicted), microRecall: ratio(correct, expected),
        versionClassAccuracy: ratio(sum(valid, 'versionClassCorrect'), sum(valid, 'versionClassEvaluated')),
        unknownVersionFalseCertaintyCount: sum(valid, 'unknownVersionFalseCertaintyCount') };
    }
    const withWitness = valid.filter((record) => record.metrics.completeWitnessRetained !== null);
    return { ...base, witnessEligibleCases: withWitness.length,
      completeWitnessCases: withWitness.filter((record) => record.metrics.completeWitnessRetained).length,
      witnessRetention: ratio(withWitness.filter((record) => record.metrics.completeWitnessRetained).length, withWitness.length),
      microEvidenceRetention: ratio(sum(valid, 'retainedTotal'), sum(valid, 'requiredTotal')),
      nodeRetentionMedian: quantile(valid.map((record) => record.metrics.nodes.ratio).filter((value) => value !== null), 0.5),
      edgeRetentionMedian: quantile(valid.map((record) => record.metrics.edges.ratio).filter((value) => value !== null), 0.5) };
  });
}

function csv(rows) {
  const fields = unique(rows.flatMap((row) => Object.keys(row)));
  const cell = (value) => value == null ? '' : `"${String(typeof value === 'object' ? JSON.stringify(value) : value).replaceAll('"', '""')}"`;
  return `${fields.map(cell).join(',')}\n${rows.map((row) => fields.map((field) => cell(row[field])).join(',')).join('\n')}\n`;
}

function markdown(results) {
  const number = (value) => value == null ? 'n/a' : value.toFixed(4);
  const all = results.aggregates.filter((group) => group.dimension === 'all');
  return `# Synthetic model experiment report\n\nProvenance: **synthetic-model**. Generated ${results.manifest.createdAt}.\n\n` +
    `These are bounded executable model checks, not GPU hardware measurements, real defect discovery, AI output evaluation, or a human study. E2 tests preservation of already specified diagnostic witnesses, not discovery of new violations.\n\n` +
    `Status: **${results.status}**; ${results.failures.length} failures retained. Corpus: ${results.corpus.correspondenceCases} correspondence cases and ${results.corpus.sliceCases} slicing cases; **0 independently observed real GPU bugs**. Template labels and family/split breakdowns are in results.json. All fixtures were developed during this implementation pilot; validation labels do not designate a frozen, independent holdout.\n\n` +
    `## E1: atomic correspondence\n\n| Method | Cases evaluated / total | Precision | Recall | Actual-version accuracy |\n| --- | ---: | ---: | ---: | ---: |\n` +
    all.filter((group) => group.experiment === 'E1').map((group) => `| ${group.method} | ${group.evaluatedCaseCount} / ${group.caseCount} | ${number(group.microPrecision)} | ${number(group.microRecall)} | ${number(group.versionClassAccuracy)} |`).join('\n') +
    `\n\nSource, region and semantic use a conventional interval prefilter with a per-group axis choice; semantic-fixed-axis always indexes the first axis; semantic-scan uses the same semantic constraints with pairwise scanning. These implementation optimizations are not novelty claims. All modes share the same run-identity checks. Precision/recall use deduplicated (left node, right node, integer coordinate) relations from an independently enumerated oracle; empty denominators are null/n/a. Actual-version classification is evaluated only on correctly paired atoms; unmatched atoms are included in correspondence recall. Logical element and per-side coverage, unknown mappings, false-certainty counts, and raw outputs are retained per case.\n\n` +
    `## E2: specified witness preservation\n\n| Method | Complete witness cases / eligible | Required evidence retained | Median node fraction | Median edge fraction |\n| --- | ---: | ---: | ---: | ---: |\n` +
    all.filter((group) => group.experiment === 'E2').map((group) => `| ${group.method} | ${group.completeWitnessCases} / ${group.witnessEligibleCases} | ${number(group.microEvidenceRetention)} | ${number(group.nodeRetentionMedian)} | ${number(group.edgeRetentionMedian)} |`).join('\n') +
    `\n\nNodes, edges, obligations, obligation statuses, positive evidence records, and unknown boundaries are scored separately. Unknown references must survive in both slice metadata and evidence records. The complete-witness denominator excludes cases with no supplied diagnostic obligation. Data-ancestor slicing is an intentionally limited baseline, not a validated explanation. JSON bytes include metadata; they are not memory usage.\n\n` +
    `## E7: CPU analysis cost\n\n${results.manifest.configuration.warmups} warmup calls then ${results.manifest.configuration.samples} samples per case and method; method order is deterministically shuffled. Durations are host wall time of the core function only, excluding oracle scoring, JSON serialization, and filesystem I/O. These are warm calls on reused in-memory input, not cold queries or GPU timings. Individual cases contain all samples and interpolated p50/p95.\n\n| Experiment / method | Median of case medians (ms) | P95 of case medians (ms) |\n| --- | ---: | ---: |\n` +
    all.map((group) => `| ${group.experiment} / ${group.method} | ${number(group.cpuMedianOfCaseMediansMs)} | ${number(group.cpuP95OfCaseMediansMs)} |`).join('\n') +
    `\n\nThe table below reports each scaling input separately. E7 scale instances are excluded from E1/E2 accuracy denominators; their independently checked correctness summaries and raw timings remain in per-case JSON.\n\n| Function / method | Distribution | Input nodes | Median (ms) | P95 (ms) |\n| --- | --- | ---: | ---: | ---: |\n` +
    results.records.filter((record) => record.experiment === 'E7' && record.status === 'ok').map((record) =>
      `| ${record.functionKind} / ${record.method} | ${record.distribution} | ${record.inputNodeCount} | ${number(record.timing.median)} | ${number(record.timing.p95)} |`).join('\n') +
    `\n\nQuantiles across cases do not express independent statistical replications or confidence intervals. No performance speedup claim is made. Source hashes, git state, CPU/Node identity, configuration, inputs, per-case errors, and raw samples are retained in this output directory.\n\n## Failures\n\n` +
    (results.failures.length ? results.failures.map((failure) => `- ${failure.caseId ?? 'runner'} / ${failure.method ?? failure.stage}: ${failure.message}`).join('\n') : 'None.') + '\n';
}

async function environment(options) {
  const git = (args) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); } catch { return null; } };
  const sources = {};
  for (const source of sourcePaths) {
    try { sources[source] = hash(await readFile(path.join(root, source))); }
    catch (error) { sources[source] = { error: error.message }; }
  }
  return {
    createdAt: new Date().toISOString(), provenance, gitCommit: git(['rev-parse', 'HEAD']),
    gitStatus: git(['status', '--short']), sourceSha256: sources, node: process.version,
    platform: process.platform, architecture: process.arch, osRelease: os.release(),
    cpuModel: os.cpus()[0]?.model ?? null, logicalCpuCount: os.cpus().length,
    loadAverageAtStart: os.loadavg(), totalMemoryBytes: os.totalmem(),
    configuration: { ...options, matchModes, matchConfigurations, sliceModes, timingUnit: 'ms', timingScope: 'host-wall-core-call',
      methodOrder: 'seeded shuffle per sample', atomicScoringLimitPerRegion: 1_000_000 },
    timingLimitations: ['No process affinity, CPU frequency pinning or exclusive machine reservation.',
      'Core allocations, JIT and garbage collection may affect samples.', 'No GPU execution or instrumentation overhead was measured.'],
  };
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  await mkdir(path.dirname(options.output), { recursive: true });
  try { await mkdir(options.output); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Output path already exists; choose a new directory to preserve prior evidence: ${options.output}`);
    throw error;
  }
  await mkdir(path.join(options.output, 'cases'), { recursive: true });
  const manifest = await environment(options);
  const results = { schemaVersion: 1, provenance, status: 'running', manifest, corpus: {}, caseFiles: [], records: [], aggregates: [], failures: [] };
  const random = makeRandom(options.seed);
  let correspondenceCases = [];
  let sliceCases = [];
  let scaleCases = { correspondence: [], slicing: [] };
  try {
    correspondenceCases = makeCorrespondenceCases({ seed: options.seed });
    sliceCases = makeSliceCases({ seed: options.seed });
    scaleCases = makeScaleCases({ seed: options.seed });
  } catch (error) { results.failures.push({ stage: 'corpus-generation', message: error.message, stack: error.stack }); }
  results.corpus = { correspondenceCases: correspondenceCases.length, sliceCases: sliceCases.length,
    scaleCorrespondenceCases: scaleCases.correspondence.length, scaleSlicingCases: scaleCases.slicing.length,
    correspondenceSha256: hash(canonical(correspondenceCases)), sliceSha256: hash(canonical(sliceCases)),
    scaleSha256: hash(canonical(scaleCases)),
    independentRealBugCount: 0, source: provenance,
    independence: 'Seeds and repeated configurations are instances, not independent real defects. Family/template breakdown is descriptive.' };
  for (const [experiment, cases, modes] of [['E1', correspondenceCases, matchModes], ['E2', sliceCases, sliceModes]]) {
    for (const testCase of cases) {
      const caseRecords = [];
      const base = { experiment, caseId: testCase.id, family: testCase.family, split: testCase.split,
        template: testCase.rootCauseTemplate ?? testCase.mechanism ?? testCase.family, provenance,
        inputSha256: hash(canonical(testCase)) };
      let oracle;
      let timing;
      try {
        if (experiment === 'E1') {
          oracle = atomicCorrespondenceOracle(testCase.left, testCase.right);
          base.topology = correspondenceTopology(oracle.atoms);
        }
        const methods = Object.fromEntries(modes.map((mode) => [mode, () => experiment === 'E1'
          ? matchLogicalRegions(testCase.left, testCase.right, matchConfigurations[mode])
          : sliceEvidence(testCase.run, testCase.seeds, { mode })]));
        timing = measureMethods(methods, options, random);
      } catch (error) {
        results.failures.push({ ...base, stage: 'oracle-or-timing', message: error.message, stack: error.stack });
      }
      for (const method of modes) {
        const record = { ...base, method, status: 'failed' };
        try {
          if (!timing) throw new Error('Oracle or timing failed; see retained case failure');
          if (timing[method].error) throw new Error(`Timed core call failed: ${timing[method].error.message}`);
          const output = experiment === 'E1' ? matchLogicalRegions(testCase.left, testCase.right, matchConfigurations[method])
            : sliceEvidence(testCase.run, testCase.seeds, { mode: method });
          record.metrics = experiment === 'E1' ? scoreCorrespondence(output, oracle, testCase.left, testCase.right) : scoreSlice(testCase, output);
          record.output = output;
          record.timing = timing[method];
          record.status = 'ok';
          const correctnessFailure = experiment === 'E1' && matchConfigurations[method].mode === 'semantic' &&
            (record.metrics.falsePositiveAtomicRelations !== 0 || record.metrics.falseNegativeAtomicRelations !== 0 || record.metrics.versionClassCorrect !== record.metrics.versionClassEvaluated);
          const retentionFailure = experiment === 'E2' && method !== 'data-ancestors' && record.metrics.retainedTotal !== record.metrics.requiredTotal;
          if (correctnessFailure || retentionFailure) results.failures.push({ ...base, method, stage: 'oracle-check',
            message: correctnessFailure ? 'Semantic correspondence differs from atomic oracle' : 'Evidence slice lost independently specified witness evidence' });
        } catch (error) {
          record.error = { message: error.message, stack: error.stack };
          results.failures.push({ ...base, method, stage: 'case-evaluation', ...record.error });
        }
        results.records.push(record);
        caseRecords.push(record);
      }
      const filename = `${experiment}-${testCase.id.replaceAll(/[^a-zA-Z0-9._-]/g, '_')}-${base.inputSha256.slice(0, 8)}.json`;
      results.caseFiles.push(`cases/${filename}`);
      await writeFile(path.join(options.output, 'cases', filename), `${JSON.stringify({ provenance, input: testCase, oracle, records: caseRecords }, null, 2)}\n`);
    }
  }
  for (const [functionKind, cases, modes] of [['correspondence', scaleCases.correspondence, matchModes], ['slicing', scaleCases.slicing, sliceModes]]) {
    for (const testCase of cases) {
      const records = [];
      const base = { experiment: 'E7', functionKind, caseId: testCase.id, family: testCase.family,
        split: testCase.split, template: testCase.rootCauseTemplate ?? testCase.family, provenance,
        distribution: testCase.metadata?.distribution ?? testCase.metadata?.topology ?? testCase.family,
        inputSha256: hash(canonical(testCase)),
        inputNodeCount: functionKind === 'correspondence' ? testCase.left.nodes.length + testCase.right.nodes.length : testCase.run.nodes.length,
        leftNodeCount: testCase.left?.nodes.length, rightNodeCount: testCase.right?.nodes.length,
        inputEdgeCount: functionKind === 'correspondence' ? testCase.left.edges.length + testCase.right.edges.length : testCase.run.edges.length };
      let oracle, timings;
      try {
        if (functionKind === 'correspondence') oracle = atomicCorrespondenceOracle(testCase.left, testCase.right);
        const methods = Object.fromEntries(modes.map((mode) => [mode, () => functionKind === 'correspondence'
          ? matchLogicalRegions(testCase.left, testCase.right, matchConfigurations[mode]) : sliceEvidence(testCase.run, testCase.seeds, { mode })]));
        timings = measureMethods(methods, options, random);
      } catch (error) { results.failures.push({ ...base, stage: 'scale-oracle-or-timing', message: error.message, stack: error.stack }); }
      for (const method of modes) {
        const record = { ...base, method, status: 'failed' };
        try {
          if (!timings) throw new Error('Scale oracle or timing failed; see retained case failure');
          if (timings[method].error) throw new Error(`Timed core call failed: ${timings[method].error.message}`);
          const output = functionKind === 'correspondence' ? matchLogicalRegions(testCase.left, testCase.right, matchConfigurations[method])
            : sliceEvidence(testCase.run, testCase.seeds, { mode: method });
          record.metrics = functionKind === 'correspondence' ? scoreCorrespondence(output, oracle, testCase.left, testCase.right)
            : scoreSlice(testCase, output);
          record.outputSummary = { sha256: hash(canonical(output)), ...(functionKind === 'correspondence'
            ? { regionRelationCount: output.length } : { nodeCount: output.nodes.length, edgeCount: output.edges.length,
              obligationCount: output.obligations.length, evidenceCount: output.evidence.length }) };
          record.timing = timings[method];
          record.status = 'ok';
          const failedMatch = functionKind === 'correspondence' && matchConfigurations[method].mode === 'semantic' &&
            (record.metrics.falsePositiveAtomicRelations || record.metrics.falseNegativeAtomicRelations || record.metrics.versionClassCorrect !== record.metrics.versionClassEvaluated);
          const failedSlice = functionKind === 'slicing' && method !== 'data-ancestors' && record.metrics.retainedTotal !== record.metrics.requiredTotal;
          if (failedMatch || failedSlice) results.failures.push({ ...base, method, stage: 'scale-oracle-check', message: 'Scale input failed independent correctness check' });
        } catch (error) {
          record.error = { message: error.message, stack: error.stack };
          results.failures.push({ ...base, method, stage: 'scale-evaluation', ...record.error });
        }
        records.push(record);
        results.records.push(record);
      }
      const filename = `E7-${testCase.id.replaceAll(/[^a-zA-Z0-9._-]/g, '_')}-${base.inputSha256.slice(0, 8)}.json`;
      results.caseFiles.push(`cases/${filename}`);
      await writeFile(path.join(options.output, 'cases', filename), `${JSON.stringify({ provenance, input: testCase, records }, null, 2)}\n`);
    }
  }
  results.aggregates = aggregate(results.records);
  results.manifest.sourceSha256AtEnd = {};
  for (const source of sourcePaths) {
    try {
      results.manifest.sourceSha256AtEnd[source] = hash(await readFile(path.join(root, source)));
      if (results.manifest.sourceSha256AtEnd[source] !== results.manifest.sourceSha256[source]) {
        results.failures.push({ stage: 'source-stability', message: `Source changed during execution: ${source}` });
      }
    } catch (error) { results.failures.push({ stage: 'source-stability', message: `Cannot rehash ${source}: ${error.message}` }); }
  }
  results.status = results.failures.length ? 'failed' : 'passed';
  results.manifest.completedAt = new Date().toISOString();
  results.manifest.loadAverageAtEnd = os.loadavg();
  results.manifest.processMemoryAtEnd = process.memoryUsage();
  await writeFile(path.join(options.output, 'manifest.json'), `${JSON.stringify(results.manifest, null, 2)}\n`);
  await writeFile(path.join(options.output, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  await writeFile(path.join(options.output, 'cases.csv'), csv(results.records.map(({ output, metrics, timing, ...record }) => ({ ...record,
    ...(metrics ? { precision: metrics.precision, recall: metrics.recall, versionClassAccuracy: metrics.versionClassAccuracy,
      witnessRetention: metrics.completeWitnessRetained, evidenceRetention: metrics.evidenceRetention,
      nodesRetained: metrics.nodes?.retained, nodesOriginal: metrics.nodes?.original, bytesRetained: metrics.bytes?.retained } : {}),
    cpuMedianMs: timing?.median, cpuP95Ms: timing?.p95 }))));
  await writeFile(path.join(options.output, 'aggregates.csv'), csv(results.aggregates));
  await writeFile(path.join(options.output, 'report.md'), markdown(results));
  console.log(JSON.stringify({ status: results.status, provenance, output: options.output,
    correspondenceCases: correspondenceCases.length, sliceCases: sliceCases.length, failures: results.failures.length }, null, 2));
  if (results.failures.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error.stack ?? error); process.exitCode = 1; });
