#!/usr/bin/env node
/** Source-bound controlled SM89 observations -> bounded protocol obligations.
 * Barrier boundary nodes are derived from the audited kernel contract, never
 * presented as sampled device events or inferred from event-array order. */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {checkProtocol} from '../../lib/research/protocol.js';
import {sliceEvidence} from '../../lib/research/evidence.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const unknown = reason => ({status: 'unknown', reason});
const check = (condition, message) => {if (!condition) throw Error(message);};

export function captureProbeCTA(record, cta) {
  const scopeId = `${record.measurement_id}:cta:${cta}`;
  const actual = record.events.filter(event => event.cta[0] === cta);
  check(actual.length === record.generations * 5, 'incomplete selected CTA');
  const index = new Map(actual.map(event => [`${event.iteration}:${event.role}`, event]));
  check(index.size === actual.length, 'duplicate probe event');
  const get = (g, role) => {
    const event = index.get(`${g}:${role}`);
    check(event, `missing ${g}:${role}`); return event;
  };
  const facts = [{id: 'source-contract', kind: 'audited-source-contract',
    sourceSha256: record.source_hashes['version_probe.cu'], barrierSites: record.source_barrier_sites,
    semantics: 'Uniform CTA barriers in the fixed version_probe kernel; not automatic arbitrary CUDA analysis.',
    generationMapping: 'raw initialization tag -1 -> logical generation 0; raw iteration g -> g+1',
    tagScope: 'Event tags refer to a shared slot. Numerical output of every valid element was separately checked.'}];
  const token = (id, slot, generation, domain, extra = {}) => {
    check(Number.isSafeInteger(generation) && generation >= -1, 'invalid probe generation');
    const value = {status: 'known', scopeId, resourceId: `slot:${slot}`, generation: String(generation + 1), domain, evidenceRef: id};
    facts.push({id, kind: 'source-bound-identity', scopeId, resourceId: value.resourceId,
      generation: value.generation, domain, rawGeneration: generation, ...extra});
    return value;
  };
  const events = [], hb = [], obligations = [];
  for (const event of actual) {
    const id = `record:${event.id}`;
    facts.push({id, kind: 'hardware-event', ...event.recordRef, role: event.role,
      rawObservedGeneration: event.observed_generation, slot: event.slot,
      representativeValue: event.representative_value, validElements: event.valid_elements});
    events.push({id: event.id, scopeId, recordRef: id,
      role: event.role === 'consumer_read' ? 'consumer' : event.role === 'producer_write' ? 'reuse' : 'marker',
      token: event.role === 'consumer_read' ? token(`value:${event.id}`, event.slot, event.observed_generation, 'value', {recordRef: id}) :
        unknown('This sampled callback is not used as an asynchronous completion token.')});
  }
  const edge = (from, to, rule, g) => {
    const id = `hb:${hb.length}`, evidenceRef = `hb-proof:${hb.length}`;
    facts.push({id: evidenceRef, kind: 'source-derived-order', sourceContractRef: 'source-contract',
      sourceSha256: record.source_hashes['version_probe.cu'], iteration: g, rule,
      observation: 'Source/barrier derivation; no sampled clock or array-order assumption.'});
    hb.push({id, from, to, verified: true, evidenceRef});
  };
  for (let g = 0; g < record.generations; g++) {
    const consumer = get(g, 'consumer_read'), producer = get(g, 'producer_write');
    const readyId = `derived:producer-ready:${g}`, doneId = `derived:reader-done:${g}`;
    const readyFact = `boundary:producer:${g}`, doneFact = `boundary:reader:${g}`;
    facts.push({id: readyFact, kind: 'source-derived-barrier-boundary', sourceContractRef: 'source-contract',
      sourceSha256: record.source_hashes['version_probe.cu'], sourceLine: record.source_barrier_sites.CONTRACT_PRODUCER_VISIBILITY_BARRIER,
      logicalPoint: `consumer thread 32 returns from producer visibility barrier at iteration ${g}`,
      basedOnRecord: `record:${consumer.id}`, sampledDeviceEvent: false});
    facts.push({id: doneFact, kind: 'source-derived-barrier-boundary', sourceContractRef: 'source-contract',
      sourceSha256: record.source_hashes['version_probe.cu'], sourceLine: record.source_barrier_sites.CONTRACT_READER_COMPLETION_REUSE_BARRIER,
      logicalPoint: `producer thread 0 returns from reader completion barrier at iteration ${g}`,
      basedOnRecord: `record:${get(g, 'reuse_ready').id}`, sampledDeviceEvent: false});
    const readyToken = token(`ready-token:${g}`, producer.slot, producer.observed_generation, 'producer_result_ready', {boundaryRef: readyFact});
    const doneToken = token(`done-token:${g}`, consumer.slot, consumer.observed_generation, 'reader_done', {boundaryRef: doneFact});
    events.push({id: readyId, scopeId, role: 'producer-completion', recordRef: readyFact, token: readyToken},
      {id: doneId, scopeId, role: 'reader-completion', recordRef: doneFact, token: doneToken});
    edge(producer.id, readyId, 'producer write -> uniform visibility barrier return in consumer thread', g);
    edge(readyId, consumer.id, 'consumer-thread program order after producer visibility barrier', g);
    edge(consumer.id, doneId, 'all consumer accesses -> uniform reader barrier return in producer thread', g);
    if (g + 1 < record.generations) edge(doneId, get(g + 1, 'producer_write').id,
      'producer-thread program order from reader barrier return to next producer write', g);
    const expected = token(`expected-value:${g}`, g % 2, g, 'value', {sourceContractRef: 'source-contract'});
    obligations.push({id: `value:${g}`, kind: 'value-generation', consumerId: consumer.id,
      requirementRef: 'source-contract', expected, observed: events.find(event => event.id === consumer.id).token});
    obligations.push({id: `ready:${g}`, kind: 'completion-before-consume', beforeId: readyId, afterId: consumer.id,
      requirementRef: 'source-contract', requiredToken: token(`expected-ready:${g}`, g % 2, g, 'producer_result_ready', {sourceContractRef: 'source-contract'})});
    // Query the next actual overwrite of the READ slot, not the next loop by default.
    const next = Array.from({length: record.generations - g - 1}, (_, i) => g + 1 + i)
      .find(iteration => get(iteration, 'producer_write').slot === consumer.slot);
    if (next != null) obligations.push({id: `reuse:${g}`, kind: 'reader-before-reuse', beforeId: doneId,
      afterId: get(next, 'producer_write').id, requirementRef: 'source-contract',
      requiredToken: token(`expected-reader:${g}`, consumer.slot, consumer.observed_generation, 'reader_done', {sourceContractRef: 'source-contract'})});
  }
  return {id: scopeId, scopeId, provenance: {kind: 'derived', sourceKind: 'hardware-measurement',
      measurementId: record.measurement_id, variant: record.variant,
      claim: 'Observed tags plus manually audited fixed-kernel source contract; no general ISA extractor.'},
    identity: {specId: 'int32-double-buffer-payload-v1', specHash: sha('payload(seed,g,index); output[g,index]=payload(seed,g,index)'),
      inputId: sha(json({count: record.shape[0], generations: record.generations, seed: record.seed, cta})),
      semanticsId: 'source-bound-uniform-cta-barriers-v1'},
    resources: [0,1].map(slot => ({id: `slot:${slot}`, scopeId})), facts, events, hb, obligations};
}

function preserved(run) {
  return run.obligations.map(obligation => {
    const slice = sliceEvidence(run, obligation.subjectIds);
    const retained = slice.obligations.find(o => o.id === obligation.id);
    check(JSON.stringify(obligation) === JSON.stringify(retained), 'obligation changed during slicing');
    for (const ref of obligation.positiveWitnessRefs) check(slice.evidence.some(fact => fact.id === ref), 'missing positive witness');
    for (const ref of obligation.unknownRefs) check(slice.evidence.some(fact => fact.id === ref), 'missing unknown boundary');
    return {obligationId: obligation.id, fullNodes: run.nodes.length, retainedNodes: slice.nodes.length,
      status: obligation.status, run: slice};
  });
}

export function ablateProbe(capture, mode) {
  const result = structuredClone(capture); result.id += `:${mode}`;
  if (mode === 'mask-consumer-value-token') {
    for (const event of result.events) if (event.role === 'consumer') event.token = unknown('consumer value-token interface deliberately masked');
    for (const obligation of result.obligations) if (obligation.kind === 'value-generation') obligation.observed = unknown('consumer value-token interface deliberately masked');
  } else if (mode === 'remove-HB-edges') result.hb = [];
  else throw Error('unsupported ablation');
  return result;
}

async function main() {
  const args = process.argv.slice(2), get = flag => args[args.indexOf(flag) + 1];
  check(args.includes('--input') && args.includes('--output'), '--input and --output required');
  const input = resolve(get('--input')), output = resolve(get('--output'));
  const bytes = await readFile(join(input, 'summary.json')), suite = JSON.parse(bytes);
  check(suite.status === 'completed' && suite.format === 'gpu-version-probe-suite-v1', 'completed probe suite required');
  // A manually audited source contract is valid only for this exact source snapshot.
  for (const name of ['version_probe.cu', 'run_version_probe.py']) {
    const snapshot = await readFile(join(input, name));
    check(sha(snapshot) === suite.source_hashes[name], `snapshot hash mismatch: ${name}`);
    check(sha(await readFile(join('tools/research/cuda', name))) === sha(snapshot), `current contract source mismatch: ${name}`);
  }
  const sourceLines = (await readFile(join(input, 'version_probe.cu'), 'utf8')).split('\n');
  const barrierSites = Object.fromEntries(sourceLines.flatMap((line, index) => {
    const match = line.match(/\/\/ (CONTRACT_\w+)/); return match ? [[match[1], index + 1]] : [];
  }));
  const sameSites = sites => Object.keys(barrierSites).length === Object.keys(sites).length &&
    Object.entries(barrierSites).every(([key, value]) => sites[key] === value);
  check(sameSites(suite.operator_contract.source_barrier_sites), 'suite barrier sites do not bind to source');
  await mkdir(output, {recursive: false});
  const rows = [], counts = {satisfied: 0, violated: 0, unknown: 0}, ablations = [];
  let outputElements = 0, valueMismatches = 0, versionMismatches = 0;
  for (const record of suite.runs) {
    check(record.independent_checks.independent_python_oracle === 'pass', 'independent oracle did not pass');
    check(json(record.source_hashes) === json(suite.source_hashes), 'mixed probe source');
    check(sameSites(record.source_barrier_sites), 'record barrier sites do not bind to source');
    const raw = await readFile(join(input, `${record.measurement_id}.stdout.txt`));
    const jsonLines = raw.toString('utf8').split('\n').filter(line => line.trim().startsWith('{'));
    check(jsonLines.length === 1, 'expected one saved hardware JSON record');
    const original = JSON.parse(jsonLines[0]);
    for (const key of ['shape', 'generations', 'seed', 'variant', 'output', 'reference', 'observed_generations', 'expected_generations', 'correctness']) {
      check(json(original[key]) === json(record[key]), `summary differs from hardware stdout: ${key}`);
    }
    check(original.events.length === record.events.length, 'event log changed in summary');
    const payload = (generation, index) => (record.seed ^ Math.imul(generation + 1, 2654435769) ^ Math.imul(index + 11, 2246822507)) & 8388607;
    check(record.output.length === record.shape[0] * record.generations, 'output dimensions mismatch');
    let actualValueMismatches = 0, actualVersionMismatches = 0;
    for (let i = 0; i < record.output.length; i++) {
      const generation = Math.floor(i / record.shape[0]), index = i % record.shape[0];
      const expected = payload(generation, index);
      check(record.reference[i] === expected && record.expected_generations[i] === generation, 'independent bridge reference mismatch');
      actualValueMismatches += Number(record.output[i] !== expected);
      actualVersionMismatches += Number(record.observed_generations[i] !== generation);
    }
    check(actualValueMismatches === record.correctness.value_mismatches && actualVersionMismatches === record.correctness.version_mismatches,
      'saved mismatch counts differ from independent bridge oracle');
    for (const [eventIndex, event] of record.events.entries()) {
      check(sha(raw) === event.recordRef.sha256, 'hardware stdout binding failed');
      check(event.recordRef.path === `${record.measurement_id}.stdout.txt` && event.recordRef.source_sha256 === suite.source_hashes['version_probe.cu'] &&
        event.recordRef.source_line === event.source_line, 'event source/file reference mismatch');
      check(event.recordRef.json_pointer === `/events/${eventIndex}`, 'event JSON pointer mismatch');
      for (const [key, value] of Object.entries(original.events[eventIndex])) {
        check(key === 'id' ? event.id === `${record.measurement_id}:${value}` : json(event[key]) === json(value), 'event payload differs from hardware stdout');
      }
      if (event.role === 'consumer_read') {
        const offset = event.iteration * record.shape[0] + event.cta[0] * 32;
        check(event.observed_generation === record.observed_generations[offset] && event.representative_value === record.output[offset],
          'consumer event differs from observed output/tag');
      }
    }
    outputElements += record.output.length; valueMismatches += record.correctness.value_mismatches;
    versionMismatches += record.correctness.version_mismatches;
    for (let cta = 0; cta < Math.ceil(record.shape[0] / 32); cta++) {
      const capture = captureProbeCTA(record, cta), run = checkProtocol(capture), slices = preserved(run);
      const values = run.obligations.filter(o => o.kind === 'value-generation');
      check(values.every(o => o.status === (record.variant === 'correct' ? 'satisfied' : 'violated')), 'hardware value outcome disagrees');
      check(run.obligations.filter(o => o.kind !== 'value-generation').every(o => o.status === 'satisfied'), 'source-proven order did not hold');
      for (const obligation of run.obligations) counts[obligation.status]++;
      const name = `${record.measurement_id}-cta${cta}.json`;
      const encoded = json({capture, run, slices});
      await writeFile(join(output, name), encoded);
      const row = {measurement: record.measurement_id, variant: record.variant, count: record.shape[0],
        generations: record.generations, seed: record.seed, cta, file: name,
        resultSha256: sha(encoded), resultBytes: Buffer.byteLength(encoded), obligations: run.obligations.length,
        valueSatisfied: values.filter(o => o.status === 'satisfied').length,
        valueViolated: values.filter(o => o.status === 'violated').length, allSlicesPreserved: true};
      rows.push(row);
      for (const mode of ['mask-consumer-value-token', 'remove-HB-edges']) {
        const result = checkProtocol(ablateProbe(capture, mode)); preserved(result);
        const relevant = result.obligations.filter(o => mode === 'mask-consumer-value-token' ? o.kind === 'value-generation' :
          ['completion-before-consume', 'reader-before-reuse'].includes(o.kind));
        check(relevant.every(o => o.status === 'unknown'), 'withheld evidence produced an unsupported conclusion');
        ablations.push({measurement: record.measurement_id, cta, mode, unknown: relevant.length, allSlicesPreserved: true});
      }
    }
  }
  const summary = {format: 'version-probe-protocol-bridge-v1', inputSummarySha256: sha(bytes), hardwareRuns: suite.runs.length,
    ctaCaptures: rows.length, outputElements, valueMismatches, versionMismatches, obligationCounts: counts,
    valueObligations: {satisfied: rows.reduce((sum, row) => sum + row.valueSatisfied, 0), violated: rows.reduce((sum, row) => sum + row.valueViolated, 0)},
    rows, ablations, sourceSha256: Object.fromEntries(await Promise.all(['tools/research/bridge-version-probe.mjs',
      'lib/research/protocol.js', 'lib/research/evidence.js'].map(async path => [path, sha(await readFile(path))]))),
    limitations: ['Controlled wrong-slot faults, not naturally occurring AI errors or SM100 async bugs.',
      'Per-CTA/per-generation obligations are correlated observations, not independent evaluation cases.',
      'Barrier boundary nodes and HB are source-derived for this fixed kernel, not sampled hardware completions.',
      'The numerical arrays cover all valid outputs; event-level version queries use the shared slot tag.',
      'Ablations mask the consumer-token interface or remove HB edges; original facts and source observations remain. This tests checker interface sensitivity, not physical data removal.',
      'No additional GPU fault is injected by these offline ablations.',
      'Slice preservation checks interface integrity, not independent diagnostic accuracy or human understanding.']};
  await writeFile(join(output, 'summary.json'), json(summary));
  console.log(json({hardwareRuns: summary.hardwareRuns, ctaCaptures: rows.length, counts, valueObligations: summary.valueObligations}));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
