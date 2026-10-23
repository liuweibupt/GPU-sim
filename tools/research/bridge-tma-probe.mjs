#!/usr/bin/env node
/** Source-bound tensor-TMA observations; not a general PTX memory-model decoder. */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, join, dirname, basename} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {gzipSync} from 'node:zlib';
import {checkProtocol} from '../../lib/research/protocol.js';
import {sliceEvidence} from '../../lib/research/evidence.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_HASHES = {
  'tma_version_probe.cu': 'f0ec084c034c73f073e96f1230ddb96df9bd4d51c9e254f2860a67898bd4bc4f',
  'tma_run_probe.py': 'a5352785d2274f206d52340d9e093621f8ba5dbdcaeec1ea02e4d2ef453ce508',
};
const sha = data => createHash('sha256').update(data).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const check = (value, message) => {if (!value) throw Error(message);};
const equal = (a, b, message) => check(isDeepStrictEqual(a, b), message);
const unknown = reason => ({status: 'unknown', reason});
const MODES = ['mask-consumer-value-token', 'mask-successful-wait-token', 'remove-HB-edges'];

export function verifyHash(bytes, expected, label) {
  check(sha(bytes) === expected, `${label}: SHA256 mismatch`);
}

export function verifyRawBinding(record, raw, suiteHashes, sites) {
  const lines = raw.toString('utf8').split('\n');
  const records = lines.flatMap((line, index) => {
    if (!line.trim().startsWith('{')) return [];
    const value = JSON.parse(line);
    return value.format === 'gpu-tensor-tma-version-probe-v1' ? [{value, line: index + 1}] : [];
  });
  check(records.length === 1, 'expected exactly one raw tensor-TMA record');
  const {value: original, line: jsonLine} = records[0];
  check(/^[A-Za-z0-9_.-]+$/.test(record.measurement_id), 'unsafe measurement ID');
  const path = `${record.measurement_id}.stdout.txt`, hash = sha(raw);
  equal(record.recordRef, {path, sha256: hash, json_line: jsonLine}, 'run raw reference mismatch');
  equal(record.source_hashes, suiteHashes, 'mixed source hashes');
  check(original.events.length === record.events.length, 'summary event count differs from raw');
  for (const [key, value] of Object.entries(original)) {
    if (key !== 'events') equal(record[key], value, `summary differs from raw: ${key}`);
  }
  const marker = {tma_issued: 'EVENT_TMA_ISSUED', wait_returned_true: 'EVENT_WAIT_RETURNED_TRUE',
    consumer_sample: 'EVENT_CONSUMER_SAMPLE', reuse_ready: 'EVENT_REUSE_READY'};
  for (const [index, event] of record.events.entries()) {
    const {recordRef, ...payload} = event;
    equal(payload, original.events[index], 'summary event differs from raw');
    equal(recordRef, {path, sha256: hash, json_line: jsonLine, json_pointer: `/events/${index}`,
      source_sha256: suiteHashes['tma_version_probe.cu'], source_line: event.source_line}, 'event reference mismatch');
    check(event.source_line === sites[marker[event.role]], 'event source line mismatch');
  }
  check(record.exit_code === (record.variant === 'wrong-slot' ? 2 : 0), 'unexpected application exit');
  return original;
}

export function captureTmaRecord(record, sourceSites, namespace = 'suite') {
  const scopeId = `${namespace}:${record.measurement_id}:cta:0`;
  const sourceSha256 = record.source_hashes['tma_version_probe.cu'];
  const actual = new Map(record.events.map(event => [`${event.transfer}:${event.role}`, event]));
  check(actual.size === record.events.length && record.events.length === 4 + 4 * record.generations,
    'incomplete or duplicate TMA events');
  const get = (transfer, role) => {const result = actual.get(`${transfer}:${role}`); check(result, `missing ${transfer}:${role}`); return result;};
  const facts = [{id: 'source-contract', kind: 'audited-source-contract', sourceSha256, sourceSites,
    semantics: 'Exact audited tensor-TMA probe source, rank-2 descriptor, arrival count 1 and expected tile byte count.',
    generationMapping: 'actual transported tag -1 -> logical generation 0; full integer tag g -> g+1; phase is auxiliary only.',
    orderingScope: 'Source-bound uniform CTA barriers, explicit successful acquire waits and same-thread program order; never clocks/array order.'},
    {id: 'all-output-oracle', kind: 'independently-validated-full-output', ...record.recordRef,
      checkedElements: record.output.length, shape: record.shape, generations: record.generations,
      valueMismatches: record.correctness.value_mismatches, tagMismatches: record.correctness.version_mismatches,
      interpretation: 'Every valid output payload and transported tag checked by independent Python integer oracle; event token is per shared slot.'}];
  const events = [], hb = [], obligations = [];
  const token = (id, slot, generation, domain, extra = {}) => {
    check(Number.isSafeInteger(generation) && generation >= -1 && [0,1].includes(slot), 'invalid full generation/slot');
    const value = {status: 'known', scopeId, resourceId: `slot:${slot}`, generation: String(generation + 1), domain, evidenceRef: id};
    facts.push({id, kind: 'source-bound-identity', scopeId, resourceId: value.resourceId,
      generation: value.generation, rawGeneration: generation, domain, ...extra});
    return value;
  };
  const edge = (from, to, rule, lines) => {
    const id = `hb:${hb.length}`, evidenceRef = `hb-proof:${hb.length}`;
    facts.push({id: evidenceRef, kind: 'source-derived-order', sourceContractRef: 'source-contract',
      sourceSha256, sourceLines: lines, rule, sampledDeviceTiming: false});
    hb.push({id, from, to, verified: true, evidenceRef});
  };
  for (const event of record.events) {
    const id = `record:${event.id}`;
    facts.push({id, kind: 'hardware-event', ...event.recordRef, role: event.role, transfer: event.transfer,
      rawObservedGeneration: event.observed_generation, slot: event.slot, phaseParity: event.phase_parity,
      waitReturnedTrue: event.wait_success, waitPolls: event.wait_polls,
      representativeValue: event.representative_value, interpretation: event.role === 'wait_returned_true'
        ? 'Recorded after acquire wait true return; tag/value subsequently loaded from the completed shared buffer.'
        : 'Actual instrumented callback; storage index does not establish temporal order.'});
    const isWait = event.role === 'wait_returned_true', consumer = event.role === 'consumer_sample';
    if (isWait) check(event.wait_success === true && event.wait_polls > 0 && Number.isInteger(event.observed_generation), 'missing positive successful wait evidence');
    events.push({id: event.id, scopeId, recordRef: id,
      role: isWait ? 'producer-completion' : consumer ? 'consumer' : 'marker',
      token: isWait || consumer ? token(`token:${event.id}`, event.slot, event.observed_generation,
        isWait ? 'producer_result_ready' : 'value', {recordRef: id, allOutputOracleRef: 'all-output-oracle'})
        : unknown('This log contains no observed completion/value identity.')});
  }
  for (let transfer = 0; transfer < record.generations + 2; transfer++) {
    const issue = get(transfer, 'tma_issued'), wait = get(transfer, 'wait_returned_true');
    const issueId = `derived:tma-issue:${transfer}`, factId = `issue-boundary:${transfer}`;
    facts.push({id: factId, kind: 'source-derived-instruction-boundary', sourceContractRef: 'source-contract',
      sourceSha256, sourceLine: sourceSites.CONTRACT_TENSOR_TMA_ISSUE,
      basedOnRecord: `record:${issue.id}`, transfer, slot: issue.slot, sampledDeviceEvent: false,
      logicalPoint: 'Actual cp.async.bulk.tensor.2d issuance in source before tma_issued callback, not the callback timestamp.'});
    events.push({id: issueId, scopeId, recordRef: factId, role: 'reuse',
      token: unknown('A transfer issue is not proof of completion or a transported value.')});
    edge(issueId, issue.id, 'Same-thread source order: TMA instruction before its issue callback.',
      [sourceSites.CONTRACT_TENSOR_TMA_ISSUE, issue.source_line]);
    edge(issue.id, wait.id, 'Same-thread source order: issue callback, arrive.expect_tx, acquire wait true, then wait callback.',
      [issue.source_line, sourceSites.CONTRACT_EXPECT_TX, sourceSites.CONTRACT_ACQUIRE_WAIT, wait.source_line]);
    if (transfer > 0) {
      const prior = get(transfer - 1, transfer <= 2 ? 'wait_returned_true' : 'reuse_ready');
      edge(prior.id, issueId, 'Thread0 program order from the previous completed initialization or reader barrier return to the next TMA issuance.',
        [prior.source_line, sourceSites.CONTRACT_TENSOR_TMA_ISSUE]);
    }
  }
  for (let g = 0; g < record.generations; g++) {
    const transfer = g + 2, consumer = get(transfer, 'consumer_sample'), currentWait = get(transfer, 'wait_returned_true');
    const reuse = get(transfer, 'reuse_ready');
    edge(currentWait.id, consumer.id, 'Acquire-wait callback before uniform visibility CTA barrier; consumer loads/callback after return.',
      [currentWait.source_line, sourceSites.CONTRACT_TMA_VISIBILITY_BARRIER, sourceSites.CONTRACT_CONSUMER_LOAD, consumer.source_line]);
    const doneId = `derived:all-readers-done:${g}`, doneFact = `readers-boundary:${g}`;
    facts.push({id: doneFact, kind: 'source-derived-barrier-boundary', sourceContractRef: 'source-contract',
      sourceSha256, sourceLine: sourceSites.CONTRACT_READER_COMPLETION_BARRIER, basedOnRecord: `record:${reuse.id}`,
      consumerRecordRef: `record:${consumer.id}`, sampledDeviceEvent: false,
      logicalPoint: `Thread0 returns from uniform reader-completion CTA barrier at iteration ${g}; all valid consumer loads precede it.`});
    events.push({id: doneId, scopeId, role: 'reader-completion', recordRef: doneFact,
      token: token(`readers-token:${g}`, consumer.slot, consumer.observed_generation, 'reader_done', {boundaryRef: doneFact})});
    edge(consumer.id, doneId, 'All consumer loads plus thread32 sample precede per-thread proxy fence and uniform reader completion barrier return in thread0.',
      [consumer.source_line, sourceSites.CONTRACT_PROXY_FENCE, sourceSites.CONTRACT_READER_COMPLETION_BARRIER]);
    edge(doneId, reuse.id, 'Thread0 program order after returning from reader completion barrier.',
      [sourceSites.CONTRACT_READER_COMPLETION_BARRIER, reuse.source_line]);
    const observed = events.find(event => event.id === consumer.id).token;
    obligations.push({id: `value:${g}`, kind: 'value-generation', consumerId: consumer.id, requirementRef: 'source-contract',
      expected: token(`expected-value:${g}`, g % 2, g, 'value', {sourceContractRef: 'source-contract'}), observed});
    // The ordering query concerns the actually READ buffer: a wrong but completed buffer is not a synchronization failure.
    const matchingWait = record.events.filter(event => event.role === 'wait_returned_true' &&
      event.transfer <= transfer && event.slot === consumer.slot && event.observed_generation === consumer.observed_generation).at(-1);
    check(matchingWait, 'consumer has no matching successful transfer wait');
    obligations.push({id: `ready:${g}`, kind: 'completion-before-consume', beforeId: matchingWait.id,
      afterId: consumer.id, requirementRef: 'source-contract', requiredToken: token(`expected-ready:${g}`,
        consumer.slot, consumer.observed_generation, 'producer_result_ready', {consumerRecordRef: `record:${consumer.id}`})});
    const next = record.events.find(event => event.role === 'tma_issued' && event.transfer > transfer && event.slot === consumer.slot);
    if (next) obligations.push({id: `reuse:${g}`, kind: 'reader-before-reuse', beforeId: doneId,
      afterId: `derived:tma-issue:${next.transfer}`, requirementRef: 'source-contract', requiredToken: token(`expected-readers:${g}`,
        consumer.slot, consumer.observed_generation, 'reader_done', {consumerRecordRef: `record:${consumer.id}`})});
  }
  return {id: scopeId, scopeId, provenance: {kind: 'derived', sourceKind: 'hardware-measurement',
    measurementId: record.measurement_id, variant: record.variant, device: record.device,
    claim: 'Actual tensor-TMA data tags and after-success waits plus manually audited fixed-source ordering.'},
    identity: {specId: 'int32-tensor-tma-double-buffer-v1', specHash: sha('TMA copies padded [payload,tag]; consume requested full generation'),
      inputId: sha(json({shape: record.shape, generations: record.generations, seed: record.seed})),
      semanticsId: 'source-bound-tensor-tma-wait-and-cta-barriers-v1'},
    resources: [0,1].map(slot => ({id: `slot:${slot}`, scopeId})), facts, events, hb, obligations};
}

export function ablateTma(capture, mode) {
  const value = structuredClone(capture); value.id += `:${mode}`;
  if (mode === 'mask-consumer-value-token') {
    for (const event of value.events) if (event.role === 'consumer') event.token = unknown('Consumer value-token interface deliberately masked; raw facts retained.');
    for (const obligation of value.obligations) if (obligation.kind === 'value-generation') obligation.observed = unknown('Consumer value-token interface deliberately masked; raw facts retained.');
  } else if (mode === 'mask-successful-wait-token') {
    for (const event of value.events) if (event.role === 'producer-completion') event.token = unknown('Successful-wait completion-token interface masked; raw facts retained.');
  } else if (mode === 'remove-HB-edges') value.hb = [];
  else throw Error('unknown TMA ablation');
  return value;
}

function preserved(run) {
  return run.obligations.map(obligation => {
    const slice = sliceEvidence(run, obligation.subjectIds);
    equal(slice.obligations.find(item => item.id === obligation.id), obligation, 'slice changed obligation');
    for (const id of [...obligation.positiveWitnessRefs, ...obligation.unknownRefs])
      check(slice.evidence.some(fact => fact.id === id), 'slice dropped witness/boundary');
    return {obligationId: obligation.id, status: obligation.status, fullNodes: run.nodes.length,
      retainedNodes: slice.nodes.length, run: slice};
  });
}

async function loadSuite(input) {
  const summaryBytes = await readFile(join(input, 'summary.json')), suite = JSON.parse(summaryBytes);
  check(suite.format === 'gpu-tensor-tma-version-suite-v1' && suite.status === 'completed', 'completed tensor-TMA suite required');
  equal(suite.source_hashes, SOURCE_HASHES, 'suite is not the audited source snapshot');
  for (const [name, hash] of Object.entries(SOURCE_HASHES)) {
    verifyHash(await readFile(join(input, name)), hash, name);
    verifyHash(await readFile(join(ROOT, 'tools/research/cuda', name)), hash, `current ${name}`);
  }
  for (const name of ['tma_version_probe.ptx', 'tma_version_probe.sass', 'contract.json']) {
    const raw = await readFile(join(input, name)), metadata = suite.artifacts[name];
    check(metadata && metadata.bytes === raw.length, `${name}: byte length mismatch`);
    verifyHash(raw, metadata.sha256, name);
  }
  let binaryBinding;
  try {
    const raw = await readFile(join(input, 'tma_version_probe')), metadata = suite.artifacts.tma_version_probe;
    check(metadata.bytes === raw.length, 'binary byte length mismatch');
    verifyHash(raw, metadata.sha256, 'binary');
    binaryBinding = {method: 'local-byte-rehash', ...metadata};
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const manifestPath = join(dirname(dirname(input)), 'summary.json');
    const manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes);
    check(manifest.format === 'modal-gpu-evidence-job-v1' && manifest.status === 'completed' &&
      manifest.execution?.status === 'completed', 'omitted binary needs completed Modal manifest');
    const prefix = basename(input) + '/';
    const entry = manifest.execution.artifacts.filter(a => a.path === prefix + 'tma_version_probe');
    check(entry.length === 1 && entry[0].omitted === 'compiled executable; binary hash retained', 'binary omission is not declared by remote collector');
    equal({sha256: entry[0].sha256, bytes: entry[0].bytes}, suite.artifacts.tma_version_probe, 'remote binary hash/size differs from suite');
    const suiteEntry = manifest.execution.artifacts.filter(a => a.path === prefix + 'summary.json');
    check(suiteEntry.length === 1 && suiteEntry[0].bytes === summaryBytes.length, 'suite does not bind remote artifact manifest');
    verifyHash(summaryBytes, suiteEntry[0].sha256, 'suite remote manifest');
    binaryBinding = {method: 'remote-hash-only', sha256: entry[0].sha256, bytes: entry[0].bytes,
      remoteManifestPath: manifestPath, remoteManifestSha256: sha(manifestBytes),
      limitation: 'ELF omitted by remote collector; retained remote binary hash compared across two manifests, not locally recomputed.'};
  }
  equal(JSON.parse(await readFile(join(input, 'contract.json'), 'utf8')), suite.operator_contract, 'contract artifact differs from summary');
  const source = (await readFile(join(input, 'tma_version_probe.cu'), 'utf8')).split('\n');
  const sourceSites = Object.fromEntries(source.flatMap((line, index) =>
    [...line.matchAll(/\b(?:CONTRACT|EVENT|CONTROLLED)_[A-Z_]+/g)].map(match => [match[0], index + 1])));
  equal(sourceSites, suite.operator_contract.source_sites, 'contract sites do not bind source');
  check(new Set(suite.runs.map(record => record.measurement_id)).size === suite.runs.length, 'duplicate measurement ID');
  const originals = [];
  for (const record of suite.runs) {
    check(/^[A-Za-z0-9_.-]+$/.test(record.measurement_id), 'unsafe measurement ID');
    const raw = await readFile(join(input, `${record.measurement_id}.stdout.txt`));
    originals.push(verifyRawBinding(record, raw, suite.source_hashes, sourceSites));
    const commands = suite.commands.filter(command => command.name === record.measurement_id);
    check(commands.length === 1 && commands[0].stdout_sha256 === sha(raw) && commands[0].exit_code === record.exit_code,
      'raw stdout/exit does not bind to command manifest');
  }
  const helper = join(ROOT, 'tools/research/cuda/tma_run_probe.py');
  const script = `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('bound_tma',sys.argv[1])\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nprint(json.dumps([m.check_record(r) for r in json.load(sys.stdin)]))\n`;
  const validation = JSON.parse(execFileSync('python3', ['-B', '-c', script, helper],
    {input: JSON.stringify(originals), encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024}));
  for (const [index, record] of suite.runs.entries()) equal(record.independent_checks, validation[index], 'fresh CPU validation differs from saved checks');
  verifyHash(await readFile(helper), SOURCE_HASHES['tma_run_probe.py'], 'validator changed during validation');
  return {input, suite, sourceSites, inputSummarySha256: sha(summaryBytes), freshPythonOracleRuns: validation.length, binaryBinding};
}

async function main() {
  const inputs = []; let output;
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--input') inputs.push(resolve(process.argv[++i]));
    else if (process.argv[i] === '--output') output = resolve(process.argv[++i]);
    else throw Error(`unknown argument ${process.argv[i]}`);
  }
  check(inputs.length > 0 && output && new Set(inputs).size === inputs.length, 'unique --input directories and --output required');
  const loaded = [];
  for (const input of inputs) loaded.push(await loadSuite(input));
  await mkdir(output, {recursive: false});
  const rows = [], ablations = [], counts = {satisfied: 0, violated: 0, unknown: 0};
  for (const [suiteIndex, {suite, sourceSites}] of loaded.entries()) {
    for (const record of suite.runs) {
      const capture = captureTmaRecord(record, sourceSites, `suite-${suiteIndex}`);
      const run = checkProtocol(capture), slices = preserved(run);
      const values = run.obligations.filter(o => o.kind === 'value-generation');
      check(values.every(o => o.status === (record.variant === 'wrong-slot' ? 'violated' : 'satisfied')), 'value conclusion differs from actual output verdict');
      check(run.obligations.filter(o => o.kind !== 'value-generation').every(o => o.status === 'satisfied'), 'legal completed-buffer read/reuse not established');
      for (const o of run.obligations) counts[o.status]++;
      const ablationRuns = [];
      for (const mode of MODES) {
        const ablated = checkProtocol(ablateTma(capture, mode)), ablationSlices = preserved(ablated);
        const relevant = ablated.obligations.filter(o => mode === 'mask-consumer-value-token' ? o.kind === 'value-generation'
          : mode === 'mask-successful-wait-token' ? o.id.startsWith('ready:')
          : ['completion-before-consume', 'reader-before-reuse'].includes(o.kind));
        check(relevant.length > 0 && relevant.every(o => o.status === 'unknown'), 'masked interface produced unsupported conclusion');
        const entry = {suiteIndex, measurement: record.measurement_id, mode, relevantUnknown: relevant.length,
          obligationCounts: Object.fromEntries(['satisfied','violated','unknown'].map(status => [status, ablated.obligations.filter(o => o.status === status).length])),
          allSlicesPreserved: true};
        ablations.push(entry); ablationRuns.push({mode, run: ablated, slices: ablationSlices});
      }
      const file = `suite-${suiteIndex}-${record.measurement_id}.json.gz`, bytes = json({capture, run, slices, ablations: ablationRuns});
      const compressed = gzipSync(Buffer.from(bytes), {level: 9});
      await writeFile(join(output, file), compressed);
      rows.push({suiteIndex, measurement: record.measurement_id, device: record.device, computeCapability: record.compute_capability,
        shape: record.shape, generations: record.generations, seed: record.seed, variant: record.variant,
        file, resultSha256: sha(compressed), resultBytes: compressed.length,
        uncompressedSha256: sha(bytes), uncompressedBytes: Buffer.byteLength(bytes), outputElements: record.output.length,
        valueMismatches: record.correctness.value_mismatches, versionMismatches: record.correctness.version_mismatches,
        obligations: run.obligations.length, valueSatisfied: values.filter(o => o.status === 'satisfied').length,
        valueViolated: values.filter(o => o.status === 'violated').length,
        successfulWaitObservations: record.independent_checks.successful_wait_observations, allSlicesPreserved: true});
    }
  }
  const summary = {format: 'tensor-tma-protocol-bridge-v1', hardwareRuns: rows.length, ctaCaptures: rows.length,
    inputs: loaded.map(({input, suite, inputSummarySha256, freshPythonOracleRuns, binaryBinding}) => ({path: input, inputSummarySha256,
      compileTarget: suite.compile_target, counts: suite.counts, freshPythonOracleRuns, binaryBinding})),
    outputElements: rows.reduce((n,r) => n + r.outputElements, 0),
    valueMismatches: rows.reduce((n,r) => n + r.valueMismatches, 0), versionMismatches: rows.reduce((n,r) => n + r.versionMismatches, 0),
    successfulWaitObservations: rows.reduce((n,r) => n + r.successfulWaitObservations, 0), obligationCounts: counts,
    valueObligations: {satisfied: rows.reduce((n,r) => n + r.valueSatisfied, 0), violated: rows.reduce((n,r) => n + r.valueViolated, 0)},
    rows, ablations, sourceHashes: SOURCE_HASHES,
    bridgeSourceHashes: Object.fromEntries(await Promise.all(['tools/research/bridge-tma-probe.mjs', 'lib/research/protocol.js',
      'lib/research/evidence.js'].map(async path => [path, sha(await readFile(join(ROOT,path)))]))),
    limitations: ['Controlled completed-buffer selector fault and repair, not naturally occurring AI errors.',
      'Wrong-slot value-generation violations are not synchronization or address violations.',
      'Only this exact rank-2 tensor-TMA kernel; no general PTX/TMA correctness proof, tcgen05, or TMEM claim.',
      'Actual successful wait callbacks are observed after acquire success; source-derived issuance/reader boundary nodes are explicitly not sampled events.',
      'HB derives only from fixed source contract and per-thread program order, never phase parity, array order, or clocks.',
      'Ablations mask checker interfaces or remove HB edges; original raw tags/wait facts remain. They are not additional hardware faults.',
      'One run is one CTA; per-generation obligations and repeated architecture configurations are correlated, not independent diagnosis cases.',
      'All-output exact CPU oracle and witness-preserving slices do not measure human understanding or diagnostic accuracy.',
      'Hashes bind retained artifacts, not a cryptographic attestation of remote hardware.']};
  await writeFile(join(output, 'summary.json'), json(summary));
  console.log(json({hardwareRuns: summary.hardwareRuns, counts, valueObligations: summary.valueObligations,
    outputElements: summary.outputElements, successfulWaitObservations: summary.successfulWaitObservations}));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
