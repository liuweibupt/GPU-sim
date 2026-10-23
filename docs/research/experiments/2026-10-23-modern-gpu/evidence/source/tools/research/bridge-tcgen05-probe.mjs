#!/usr/bin/env node
/** Fixed-source SM100 probe -> evidence-backed obligations. No generic ISA inference. */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, join, basename, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {checkProtocol} from '../../lib/research/protocol.js';
import {sliceEvidence} from '../../lib/research/evidence.js';

const PINNED_SOURCE = '76a8b4f7c11d1e5c20540ce01414d131bf17a72171256f9ef1b0a11f6ef072a8';
const PINNED_VALIDATOR = 'b81ff55503f24c588e8bf80de976113572f8f60dfa7baaf1d9cb38c6244b416b';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const requireThat = (condition, message) => {if (!condition) throw Error(message);};
const unknown = reason => ({status: 'unknown', reason});
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);

export function captureTcgen05Probe(record, binding) {
  requireThat(record.format === 'tcgen05-probe-v1' && record.events.length === record.iterations * 11, 'incomplete tcgen05 record');
  requireThat(binding.sourceSha256 === PINNED_SOURCE, 'unaudited source contract');
  const scopeId = `${binding.measurementId}:cta:0`, resourceId = `tmem:${record.lifecycle.tmem_base}:columns:32`;
  const facts = [{id: 'source-contract', kind: 'audited-fixed-source-contract', sourceSha256: binding.sourceSha256,
    sourceSites: binding.sourceSites,
    semantics: 'Single SM100 CTA, full MMA commit and successful acquire wait, explicit TMEM wait::ld and reader CTA barrier.',
    generationProvenance: 'Observed generation was read from selected input_tags, NOT loaded as a tag from TMEM. Binding to result is a manually audited source association and independent whole-output integer oracle.',
    tokenRequirements: 'Value generation must match the requested input. Completion/reuse requirements refer to the ACTUALLY SELECTED result generation independently of whether that selected value meets the request.',
    ordering: 'No ordering is inferred from clocks, event storage indices, or missing observations.'}];
  const events = [], hb = [], obligations = [];
  const byId = new Map(record.events.map(e => [e.id, e]));
  requireThat(byId.size === record.events.length, 'duplicate observation');
  const observation = e => ({path: binding.rawPath, sha256: binding.rawSha256,
    jsonPointer: `/events/${e.event_layout_index}`, sourceSha256: binding.sourceSha256,
    sourceLine: e.source_line, payload: e});
  const token = (id, generation, domain, extra = {}) => {
    requireThat(decimal(generation), 'full generation must be a decimal string');
    facts.push({id, kind: 'source-bound-provenance-or-completion', scopeId, resourceId, generation, domain,
      sourceContractRef: 'source-contract', ...extra});
    return {status: 'known', scopeId, resourceId, generation, domain, evidenceRef: id};
  };
  const edge = (from, to, rule, sourceSite) => {
    const n = hb.length, evidenceRef = `order-proof:${n}`;
    facts.push({id: evidenceRef, kind: 'source-derived-order', sourceContractRef: 'source-contract',
      sourceSha256: binding.sourceSha256, rule, sourceSite, sampledDeviceEvent: false});
    hb.push({id: `order:${n}`, from, to, evidenceRef, verified: true});
  };
  const get = (iteration, offset) => {
    const event = record.events[iteration * 11 + offset];
    requireThat(event?.id === `i${iteration}:e${offset}` && event.iteration === iteration, 'invalid event layout identity');
    return event;
  };
  for (const [index, e] of record.events.entries()) {
    const recordRef = `record:${e.id}`;
    facts.push({id: recordRef, kind: 'hardware-instrumentation-record', path: binding.rawPath,
      sha256: binding.rawSha256, jsonPointer: `/events/${index}`, sourceSha256: binding.sourceSha256,
      sourceLine: e.source_line, payload: e});
    const isWait = e.role === 'mma_wait_success', isReader = e.role === 'tmem_reader_done';
    if (isWait) requireThat(e.wait_success === true && e.domain === 'producer_result_ready', 'missing full-MMA wait-success facet');
    if (isReader) requireThat(e.domain === 'reader_done', 'wrong reader completion facet');
    events.push({id: e.id, scopeId, recordRef,
      role: isWait ? 'producer-completion' : 'marker',
      token: isWait ? token(`identity:${e.id}`, e.observed_generation,
        'producer_result_ready', {recordRef,
          barrierGeneration: e.barrier_generation, barrierPhase: e.barrier_phase,
          selectedInputObservation: observation(record.events[e.iteration * 11])}) :
        unknown(isReader ? 'Only the warp leader recorded its own reader completion; this is not a full-TMEM-resource reader-completion token.' :
          'This record marks input selection, commit issuance, or reuse readiness; it is not a completion token.')});
  }
  const issueIds = [];
  for (let i = 0; i < record.iterations; i++) {
    const selected = get(i, 0), issueId = `derived:mma-issue:${i}`, issueFact = `boundary:mma-issue:${i}`;
    issueIds.push(issueId);
    facts.push({id: issueFact, kind: 'source-derived-operation-boundary', sourceContractRef: 'source-contract',
      sourceLine: binding.sourceSites.mmaIssue, basedOnRecords: [`record:${selected.id}`, `record:${get(i, 1).id}`],
      sourceObservations: [observation(selected), observation(get(i, 1))],
      description: 'Actual MMA issue lies between these same-thread observations; this is NOT a sampled instruction timestamp.', sampledDeviceEvent: false});
    events.push({id: issueId, scopeId, role: 'reuse', recordRef: issueFact,
      token: unknown('Write-issue point is not a completion observation.')});
    edge(selected.id, issueId, 'issuing-thread program order: selected-source record before MMA issue', 'mmaIssue');
    edge(issueId, get(i, 1).id, 'issuing-thread program order: MMA issue before commit-issued record', 'mmaIssue');
    for (let warp = 0; warp < 4; warp++) {
      const wait = get(i, 2 + warp), read = get(i, 6 + warp), consumerId = `derived:consumer:${i}:${warp}`;
      requireThat(wait.role === 'mma_wait_success' && read.role === 'tmem_reader_done' &&
        wait.thread === warp * 32 && read.thread === warp * 32, 'missing expected warp observation');
      requireThat(wait.observed_generation === selected.observed_generation && read.observed_generation === selected.observed_generation,
        'inconsistent source identity within MMA');
      const consumerFact = `boundary:consumer:${i}:${warp}`;
      facts.push({id: consumerFact, kind: 'source-derived-read-boundary', sourceContractRef: 'source-contract',
        sourceLine: binding.sourceSites.tmemLoad, basedOnRecords: [`record:${wait.id}`, `record:${read.id}`],
        sourceObservations: [observation(wait), observation(read)],
        representativeTmemValue: read.representative_value,
        description: 'TMEM read begins after successful wait and before recorded post-wait::ld reader completion. Generation is input-tag provenance, not a TMEM tag observation.', sampledDeviceEvent: false});
      const actualValue = token(`value-token:${i}:${warp}`, selected.observed_generation, 'value',
        {recordRef: `record:${read.id}`, selectedInputObservation: observation(selected),
          tmemReaderObservation: observation(read), boundaryRef: consumerFact});
      events.push({id: consumerId, scopeId, role: 'consumer', recordRef: consumerFact, token: actualValue});
      edge(issueId, wait.id, 'full tcgen05.commit completion observed by successful acquire wait; matched source iteration/barrier', 'fullCommit');
      // The commit-issued RECORD is not ordered before other warps' wait records:
      // they may return while the issuing thread is still writing that record.
      edge(wait.id, consumerId, 'same-thread post-success wait record, fence-after, then first TMEM load', 'tmemLoad');
      edge(consumerId, read.id, 'same-thread TMEM loads + wait::ld precede reader-done record', 'readerDone');
      obligations.push({id: `value:${i}:${warp}`, kind: 'value-generation', consumerId,
        requirementRef: 'source-contract', observed: actualValue,
        expected: token(`expected-value:${i}:${warp}`, selected.expected_generation, 'value', {requirement: 'requested input generation'})});
      obligations.push({id: `completion:${i}:${warp}`, kind: 'completion-before-consume', beforeId: wait.id,
        afterId: consumerId, requirementRef: 'source-contract',
        requiredToken: token(`expected-completion:${i}:${warp}`, selected.observed_generation, 'producer_result_ready',
          {requirement: 'complete the actually selected MMA result before reading it'})});
    }
    const doneId = `derived:all-readers-done:${i}`, doneFact = `boundary:all-readers-done:${i}`;
    facts.push({id: doneFact, kind: 'source-derived-all-readers-barrier-boundary', sourceContractRef: 'source-contract',
      sourceLine: binding.sourceSites.readerBarrier, sampledDeviceEvent: false,
      sourceObservations: [0, 1, 2, 3].map(w => observation(get(i, 6 + w))).concat(observation(get(i, 10))),
      description: 'Thread0 returns from the uniform 128-thread reader CTA barrier. Every thread executed all 32 TMEM loads, wait::ld and fence-before before this barrier. The four lane0 records are representative observations, not proof that lane0 alone completed the full resource.',
      resourceCoverage: {tmemColumns: 32, tmemRows: 128, readerThreads: 128}});
    events.push({id: doneId, scopeId, role: 'reader-completion', recordRef: doneFact,
      token: token(`all-readers-token:${i}`, selected.observed_generation, 'reader_done', {boundaryRef: doneFact,
        completionScope: 'entire allocated 128-row by 32-column TMEM resource; source-derived from uniform CTA barrier'})});
    for (let warp = 0; warp < 4; warp++) edge(get(i, 6 + warp).id, doneId,
      'representative reader observation before uniform CTA barrier; every thread has executed all TMEM waits before barrier return', 'readerBarrier');
    edge(doneId, get(i, 10).id, 'thread0 program order from reader CTA barrier return to reuse-ready record', 'readerBarrier');
  }
  const deallocationId = 'derived:deallocation', deallocationFact = 'boundary:deallocation';
  requireThat(record.lifecycle.deallocated === true, 'deallocation did not return');
  facts.push({id: deallocationFact, kind: 'source-derived-operation-boundary', sourceContractRef: 'source-contract',
    sourceLine: binding.sourceSites.deallocation, sampledDeviceEvent: false,
    basedOnRecord: {path: binding.rawPath, sha256: binding.rawSha256, jsonPointer: '/lifecycle', payload: record.lifecycle},
    description: 'Deallocation issue point; host-visible lifecycle flag was written only after collective deallocation returned.'});
  events.push({id: deallocationId, scopeId, role: 'reuse', recordRef: deallocationFact,
    token: unknown('Deallocation is an endpoint, not a result-completion token.')});
  for (let i = 0; i < record.iterations; i++) {
    const next = i + 1 < record.iterations ? issueIds[i + 1] : deallocationId;
    edge(get(i, 10).id, next, i + 1 < record.iterations ?
      'issuing-thread reuse-ready record precedes next MMA write through next operand-publication barrier' :
      'thread0 reuse-ready precedes final CTA barrier and warp0 collective deallocation', i + 1 < record.iterations ? 'mmaIssue' : 'deallocation');
    obligations.push({id: `reuse:${i}`, kind: 'reader-before-reuse', beforeId: `derived:all-readers-done:${i}`,
      afterId: next, requirementRef: 'source-contract',
      requiredToken: token(`expected-all-readers:${i}`, get(i, 0).observed_generation, 'reader_done',
        {requirement: 'all 128 TMEM readers complete before overwrite/free of the full allocation'})});
  }
  return {id: scopeId, scopeId, resources: [{id: resourceId, scopeId}], facts, events, hb, obligations,
    provenance: {kind: 'derived', sourceKind: 'hardware-measurement', measurementId: binding.measurementId,
      variant: record.variant, sourceSha256: binding.sourceSha256,
      claim: 'Instrumented B200 probe plus fixed-source contract; input-tag provenance and numerical readback are separate evidence.'},
    identity: {specId: 'tcgen05-fixed-gemm-128x32x16-v1', specHash: sha('D=FP16(A)*FP16(B), FP32 exact small-integer accumulation'),
      inputId: sha(json({iterations: record.iterations, seed: record.seed, base: record.generation_base})),
      semanticsId: 'tcgen05-full-commit-wait-tmem-reader-source-contract-v1'}};
}

export function ablateTcgen05(capture, mode) {
  const result = structuredClone(capture); result.id += `:${mode}`;
  if (mode === 'remove-HB-edges') result.hb = [];
  else if (mode === 'mask-selected-input-provenance') {
    for (const e of result.events) if (e.role === 'consumer') e.token = unknown('selected input provenance interface deliberately masked');
    for (const o of result.obligations) if (o.kind === 'value-generation') o.observed = unknown('selected input provenance interface deliberately masked');
  } else if (mode === 'mask-post-success-completion') {
    for (const e of result.events) if (e.role === 'producer-completion') e.token = unknown('post-success full-MMA completion interface deliberately masked');
  } else throw Error('unsupported ablation');
  return result;
}

export function verifyTcgen05Slices(run) {
  return run.obligations.map(o => {
    const sliced = sliceEvidence(run, o.subjectIds);
    requireThat(json(sliced.obligations.find(item => item.id === o.id)) === json(o), 'slice changed an obligation');
    for (const id of [...o.positiveWitnessRefs, ...o.unknownRefs]) requireThat(sliced.evidence.some(f => f.id === id), 'slice lost witness evidence');
    for (const id of o.witnessNodeIds) requireThat(sliced.nodes.some(n => n.id === id), 'slice lost witness endpoint');
    for (const id of o.witnessEdgeIds) requireThat(sliced.edges.some(e => e.id === id), 'slice lost HB path');
    const serialized = Buffer.from(json(sliced));
    return {id: o.id, status: o.status, fullNodes: run.nodes.length, retainedNodes: sliced.nodes.length,
      retainedEdges: sliced.edges.length, retainedEvidence: sliced.evidence.length,
      sliceSha256: sha(serialized), sliceBytes: serialized.length,
      regeneration: 'sliceEvidence(retained run, obligation.subjectIds); UTF-8 JSON.stringify(slice,null,2) + newline'};
  });
}

async function main() {
  const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
  requireThat(args.includes('--input') && args.includes('--output'), '--input and --output required');
  const input = resolve(value('--input')), output = resolve(value('--output'));
  const rawSummary = await readFile(join(input, 'summary.json')), suite = JSON.parse(rawSummary);
  requireThat(suite.format === 'tcgen05-probe-suite-v1' && suite.status === 'completed', 'completed tcgen05 suite required');
  let modalBinding = null, remoteArtifacts = new Map();
  if (args.includes('--modal-root')) {
    const modalRoot = resolve(value('--modal-root')), modalRaw = await readFile(join(modalRoot, 'summary.json'));
    const modal = JSON.parse(modalRaw);
    requireThat(modal.format === 'modal-gpu-evidence-job-v1' && modal.status === 'completed' && modal.execution.status === 'completed', 'completed Modal envelope required');
    requireThat(modal.requested_gpu === 'B200', 'expected B200 allocation');
    requireThat(sha(await readFile(join(modalRoot, 'run_gpu_evidence.py'))) === modal.runner_sha256, 'Modal runner snapshot hash mismatch');
    remoteArtifacts = new Map(modal.execution.artifacts.map(a => [a.path, a]));
    requireThat(remoteArtifacts.size === modal.execution.artifacts.length, 'duplicate Modal artifact path');
    const prefix = basename(input), manifestEntry = remoteArtifacts.get(`${prefix}/summary.json`);
    requireThat(manifestEntry?.sha256 === sha(rawSummary) && manifestEntry.bytes === rawSummary.length, 'suite summary not bound to Modal artifact');
    for (const [name, hash] of Object.entries(suite.source_hashes)) {
      requireThat(modal.source_sha256[name] === hash, 'uploaded source differs from compiled suite snapshot');
    }
    modalBinding = {summarySha256: sha(modalRaw), appId: modal.app_id, imageId: modal.image_id,
      requestedGpu: modal.requested_gpu, artifactPrefix: prefix,
      method: 'Local returned artifacts checked against remote manifest; omitted ELF receives remote-hash-only binding.'};
  }
  const source = await readFile(join(input, 'tcgen05_probe.cu'));
  requireThat(sha(source) === PINNED_SOURCE && suite.source_hashes['tcgen05_probe.cu'] === PINNED_SOURCE, 'source contract is not audited source');
  requireThat(sha(await readFile(join(input, 'tcgen05_validate.py'))) === PINNED_VALIDATOR, 'unexpected CPU validator');
  for (const [name, hash] of Object.entries(suite.source_hashes)) {
    requireThat(basename(name) === name && sha(await readFile(join(input, name))) === hash, 'source snapshot hash mismatch');
  }
  let artifactChecks = 0;
  const omissions = [];
  for (const [name, entry] of Object.entries(suite.artifacts)) {
    requireThat(basename(name) === name, 'artifact path escape');
    if (modalBinding) {
      const remote = remoteArtifacts.get(`${modalBinding.artifactPrefix}/${name}`);
      requireThat(remote?.sha256 === entry.sha256 && remote.bytes === entry.bytes, `remote artifact binding failed: ${name}`);
    }
    let bytes;
    try {bytes = await readFile(join(input, name));}
    catch (error) {
      if (error.code === 'ENOENT' && name === 'tcgen05_probe' && entry.kind === 'compiled-executable') {
        requireThat(modalBinding && remoteArtifacts.get(`${modalBinding.artifactPrefix}/${name}`)?.omitted, 'missing executable lacks remote omission binding; pass --modal-root');
        omissions.push({path: name, sha256: entry.sha256, bytes: entry.bytes, method: 'remote-hash-only',
          reason: 'Modal runner omits ELF; source, compile command, static PTX/SASS and executable hash retained. No local ELF byte revalidation.'});
        continue;
      }
      throw error;
    }
    requireThat(bytes.length === entry.bytes && sha(bytes) === entry.sha256, `artifact integrity failed: ${name}`); artifactChecks++;
  }
  const sourceLines = source.toString('utf8').split('\n');
  const findLine = needle => {const matches = sourceLines.flatMap((line, i) => line.includes(needle) ? [i + 1] : []);
    requireThat(matches.length === 1, `source site ambiguous: ${needle}`); return matches[0];};
  const sourceSites = {mmaIssue: findLine('ptx::tcgen05_mma('), fullCommit: findLine('ptx::tcgen05_commit('),
    tmemLoad: findLine('ptx::tcgen05_ld_32x32b('), readerDone: findLine('emit(events, iteration, 6 + warp'),
    readerBarrier: findLine('CONTRACT_ALL_READERS_DONE_BEFORE_TMEM_REUSE'), deallocation: findLine('ptx::tcgen05_dealloc(')};
  const rawPaths = suite.runs.map(row => {
    requireThat(basename(row.path) === row.path && /^[A-Za-z0-9_.-]+$/.test(row.name), 'run path escape'); return join(input, row.path);
  });
  requireThat(new Set(suite.runs.map(r => r.name)).size === suite.runs.length && new Set(rawPaths).size === rawPaths.length, 'duplicate hardware run');
  await mkdir(dirname(output), {recursive: true});
  await mkdir(output, {recursive: false});
  const python = execFileSync('python3', [join(input, 'tcgen05_validate.py'), ...rawPaths, '--source', join(input, 'tcgen05_probe.cu')], {maxBuffer: 5 * 1024 * 1024});
  await writeFile(join(output, 'independent-cpu-validation.json'), python);
  const cpu = JSON.parse(python);
  const counts = {satisfied: 0, violated: 0, unknown: 0}, rows = [], ablations = [];
  for (const [index, row] of suite.runs.entries()) {
    const raw = await readFile(rawPaths[index]);
    requireThat(raw.length === row.bytes && sha(raw) === row.sha256 && cpu.results[index].sha256 === row.sha256, 'raw observation hash mismatch');
    const record = JSON.parse(raw);
    requireThat(json(record.correctness) === json(row.correctness), 'suite numerical summary differs from raw');
    const commands = suite.commands.filter(command => command.name === row.name);
    requireThat(commands.length === 1 && commands[0].stdout.sha256 === sha(raw) && commands[0].stdout.bytes === raw.length &&
      commands[0].exit_code === row.exit_code && row.exit_code === (record.variant === 'wrong-version' ? 2 : 0), 'run output/exit differs from command manifest');
    const binding = {measurementId: row.name, rawPath: row.path, rawSha256: sha(raw), sourceSha256: PINNED_SOURCE, sourceSites};
    const capture = captureTcgen05Probe(record, binding), run = checkProtocol(capture), slices = verifyTcgen05Slices(run);
    for (const o of run.obligations) counts[o.status]++;
    const result = {capture, run, slices, ablations: [],
      sliceStorage: 'All exact witness-bearing source runs retained. Slices are reproducible from each run and query with per-slice byte count/SHA, avoiding quadratic duplicate storage.'};
    const count = status => run.obligations.filter(o => o.status === status).length;
    const resultRow = {measurementId: row.name, variant: record.variant, iterations: record.iterations,
      rawSha256: sha(raw),
      satisfied: count('satisfied'), violated: count('violated'), unknown: count('unknown'),
      valueSatisfied: run.obligations.filter(o => o.kind === 'value-generation' && o.status === 'satisfied').length,
      valueViolated: run.obligations.filter(o => o.kind === 'value-generation' && o.status === 'violated').length,
      allSlicesPreserved: true};
    for (const mode of ['remove-HB-edges', 'mask-selected-input-provenance', 'mask-post-success-completion']) {
      const masked = checkProtocol(ablateTcgen05(capture, mode)), maskedSlices = verifyTcgen05Slices(masked);
      const relevant = masked.obligations.filter(o => mode === 'remove-HB-edges' ? ['completion-before-consume', 'reader-before-reuse'].includes(o.kind) :
        mode === 'mask-selected-input-provenance' ? o.kind === 'value-generation' : o.id.startsWith('completion:'));
      requireThat(relevant.length > 0 && relevant.every(o => o.status === 'unknown'), 'withheld interface did not yield unknown');
      result.ablations.push({mode, run: masked, slices: maskedSlices});
      ablations.push({measurementId: row.name, mode, targetedUnknown: relevant.length, allSlicesPreserved: true});
    }
    const filename = `${row.name}.json.gz`, bytes = Buffer.from(json(result)), compressed = gzipSync(bytes, {level: 9});
    await writeFile(join(output, filename), compressed);
    rows.push({...resultRow, result: filename, encoding: 'gzip', resultSha256: sha(compressed), resultBytes: compressed.length,
      uncompressedSha256: sha(bytes), uncompressedBytes: bytes.length});
  }
  const summary = {format: 'tcgen05-protocol-bridge-v1', inputSummarySha256: sha(rawSummary),
    sourceContractSha256: PINNED_SOURCE, artifactChecks, omissions, modalBinding, hardwareRuns: rows.length,
    obligationCounts: counts, rows, ablations, sourceSites,
    independentCpuValidationSha256: sha(python),
    sourceSha256: Object.fromEntries(await Promise.all(['tools/research/bridge-tcgen05-probe.mjs', 'lib/research/protocol.js', 'lib/research/evidence.js']
      .map(async name => [name, sha(await readFile(name))]))),
    limitations: ['Fixed authored B200 GEMM selector defect and repair; not natural AI-generated bug detection.',
      'Value generations are selected-input software tag provenance associated with the result by audited source and whole-output oracle; tags are not read from TMEM.',
      'Successful waits and reader-done values are runtime observations. MMA issue/read-begin/deallocation points and HB are source-derived.',
      'Completion is checked for the actually selected generation separately from requested-generation correctness; an incorrect value can be fully synchronized.',
      'Four warp value/completion queries and one full-resource reader/reuse query per iteration are correlated observations, not independent bug samples.',
      'Ablations mask checker interfaces or HB edges while raw facts remain; not physical trace removal or new GPU outcomes.',
      'Exact baseline/ablation runs are stored; individual slices are deterministically regenerated and checked against retained per-slice SHA/byte counts instead of duplicating quadratic payloads.',
      'Slice preservation checks interface integrity, not human comprehension or diagnostic novelty.']};
  await writeFile(join(output, 'summary.json'), json(summary));
  console.log(json({hardwareRuns: rows.length, obligationCounts: counts, artifactChecks}));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
