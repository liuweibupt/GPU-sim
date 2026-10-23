#!/usr/bin/env node
/** Finite-model validation, not hardware bug accuracy or an ISA validation. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {checkProtocol} from '../../lib/research/protocol.js';
import {sliceEvidence, validateEvidenceRun} from '../../lib/research/evidence.js';
import {enumerateProtocolOracle, invalidProtocolCaptures, protocolCorpus} from './protocol-corpus.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const stamp = new Date().toISOString().replaceAll(':', '-');
const outputArg = process.argv.indexOf('--output');
const out = path.resolve(outputArg >= 0 ? process.argv[outputArg + 1] : path.join(root, 'out/research/protocol', stamp));
fs.mkdirSync(path.dirname(out), {recursive: true});
fs.mkdirSync(out, {recursive: false});
const sourceFiles = ['lib/research/protocol.js', 'lib/research/evidence.js', 'tools/research/protocol-corpus.mjs',
  'tools/research/run-protocol-experiments.mjs', 'tests/research-protocol.test.mjs'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = {};
for (const relative of sourceFiles) {
  const bytes = fs.readFileSync(path.join(root, relative)); sourceHashes[relative] = sha(bytes);
  const dest = path.join(out, 'source-snapshots', relative); fs.mkdirSync(path.dirname(dest), {recursive: true}); fs.writeFileSync(dest, bytes);
}
const writeJson = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
function writeCsv(name, rows) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const cell = value => JSON.stringify(value != null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''));
  fs.writeFileSync(path.join(out, name), [keys.map(cell).join(','), ...rows.map(row => keys.map(key => cell(row[key])).join(','))].join('\n') + '\n');
}

// Deliberately unsafe ablation: no positive forward HB is reported as an error.
// Implemented independently from production verdicts and oracle enumeration.
function naiveMissingHb(capture) {
  const events = Object.assign(Object.create(null), Object.fromEntries(capture.events.map(event => [event.id, event])));
  const same = (a, b) => a?.status === 'known' && b?.status === 'known' &&
    a.scopeId === b.scopeId && a.resourceId === b.resourceId && a.generation === b.generation && a.domain === b.domain;
  const forward = (start, end) => {
    const seen = new Set([start]), stack = [start];
    while (stack.length) {
      const current = stack.pop();
      for (const edge of capture.hb) if (edge.from === current && !seen.has(edge.to)) {
        if (edge.to === end) return true;
        seen.add(edge.to); stack.push(edge.to);
      }
    }
    return false;
  };
  const verdicts = {};
  for (const request of capture.obligations) {
    if (request.kind === 'value-generation') verdicts[request.id] = events[request.consumerId] && same(request.expected, events[request.consumerId].token) ? 'satisfied' : 'violated';
    else {
      const match = same(request.requiredToken, events[request.beforeId]?.token);
      verdicts[`${request.id}:token`] = match ? 'satisfied' : 'violated';
      verdicts[request.id] = match && events[request.afterId] && forward(request.beforeId, request.afterId) ? 'satisfied' : 'violated';
    }
  }
  return verdicts;
}

const cases = protocolCorpus(), invalid = invalidProtocolCaptures();
const results = [], verdictRows = [], sliceRows = [], timingRows = [], invalidRows = [], failures = [];
let state = 20261023;
const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
for (const item of cases) {
  try {
    const oracle = enumerateProtocolOracle(item.capture);
    const run = checkProtocol(item.capture), actual = Object.fromEntries(run.obligations.map(o => [o.id, o.status]));
    const naive = naiveMissingHb(item.capture);
    const expected = Object.fromEntries(oracle.results.map(o => [o.id, o.status]));
    assert.deepEqual(actual, expected);
    results.push({...item, oracle, derivedRun: run, naiveVerdicts: naive});
    for (const truth of oracle.results) verdictRows.push({case_id: item.id, split: item.split, obligation_id: truth.id,
      oracle_status: truth.status, production_status: actual[truth.id], naive_status: naive[truth.id],
      legal_linear_extensions: truth.legalLinearExtensions, satisfying_linear_extensions: truth.satisfyingLinearExtensions,
      identity_or_record_missing: truth.informationMissing,
      naive_error_with_a_satisfying_extension: naive[truth.id] === 'violated' && truth.satisfyingLinearExtensions > 0});
    for (const obligation of run.obligations) for (const mode of ['full', 'data-ancestors', 'evidence']) {
      const slice = sliceEvidence(run, [`protocol:query:${obligation.derivation.sourceRequestId}`], {mode});
      validateEvidenceRun(slice);
      const kept = slice.obligations.find(o => o.id === obligation.id);
      const facts = new Set(slice.evidence.map(f => f.id));
      const preserved = !!kept && kept.status === obligation.status &&
        [...obligation.positiveWitnessRefs, ...obligation.unknownRefs].every(ref => facts.has(ref));
      if (mode === 'evidence') assert.ok(preserved);
      sliceRows.push({case_id: item.id, obligation_id: obligation.id, mode, status: obligation.status,
        verdict_and_evidence_preserved: preserved, selected_nodes: slice.nodes.length, full_nodes: run.nodes.length});
    }
    for (let warmup = 0; warmup < 5; warmup++) { checkProtocol(item.capture); naiveMissingHb(item.capture); }
    for (let sample = 0; sample < 30; sample++) {
      const methods = random() < .5 ? ['production', 'naive'] : ['naive', 'production'];
      for (let position = 0; position < methods.length; position++) {
        const method = methods[position], started = process.hrtime.bigint();
        const value = method === 'production' ? checkProtocol(item.capture) : naiveMissingHb(item.capture);
        const elapsed = Number(process.hrtime.bigint() - started);
        assert.ok(value);
        timingRows.push({case_id: item.id, method, sample, order_position: position, elapsed_ns: elapsed});
      }
    }
  } catch (error) { failures.push({case_id: item.id, error: error.stack}); }
}
for (const item of invalid) {
  let rejected = false, reason = null;
  try { checkProtocol(item.capture); } catch (error) { rejected = true; reason = error.message; }
  invalidRows.push({case_id: item.id, rejected, reason});
  if (!rejected) failures.push({case_id: item.id, error: 'Invalid capture accepted'});
}
writeJson('cases-and-results.json', results); writeJson('invalid-cases.json', invalid);
writeCsv('verdicts.csv', verdictRows); writeCsv('slicing.csv', sliceRows); writeCsv('timing-raw.csv', timingRows);
writeCsv('invalid-results.csv', invalidRows); writeJson('failures.json', failures);
const counts = values => Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(x => x === value).length]));
const median = values => { const a = [...values].sort((x, y) => x - y); return a.length % 2 ? a[Math.floor(a.length / 2)] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2; };
const summary = {
  format: 'gpu-sim-bounded-protocol-experiment-v1', completed_at_utc: new Date().toISOString(),
  provenance: {kind: 'synthetic-model', source_hashes: sourceHashes, node: process.version, platform: process.platform,
    architecture: process.arch, cpu: os.cpus()[0]?.model, source_snapshots: 'source-snapshots'},
  scope: 'Finite observed-event DAGs, explicit value/completion identities and unbounded generation/domain; not PTX memory-model or real GPU fault validation.',
  cases: {valid: cases.length, invalid: invalid.length, splits: counts(cases.map(c => c.split))},
  oracle: {algorithm: 'independent enumeration of all event permutations satisfying explicit HB; no checker imports',
    status_rule: 'all order completions satisfy => satisfied; none => violated; some => unknown; missing observations/identities remain unknown',
    maximum_observed_events: Math.max(...cases.map(c => c.capture.events.length)),
    extensions_per_case_min: Math.min(...results.map(r => r.oracle.legalLinearExtensions)),
    extensions_per_case_max: Math.max(...results.map(r => r.oracle.legalLinearExtensions)),
    limitations: 'Synthetic declared facts are trusted; oracle shares the stated contract but not the reachability algorithm; no independent ISA validation.'},
  verdicts: {count: verdictRows.length, oracle_status_counts: counts(verdictRows.map(r => r.oracle_status)),
    production_matches: verdictRows.filter(r => r.oracle_status === r.production_status).length,
    naive_matches: verdictRows.filter(r => r.oracle_status === r.naive_status).length,
    naive_unsupported_violation_claims_on_unknown: verdictRows.filter(r => r.oracle_status === 'unknown' && r.naive_status === 'violated').length,
    naive_errors_on_known_satisfied: verdictRows.filter(r => r.oracle_status === 'satisfied' && r.naive_status === 'violated').length,
    naive_violation_claims_with_satisfying_linear_extensions: verdictRows.filter(r => r.naive_error_with_a_satisfying_extension).length,
    naive_satisfying_extensions_rejected: verdictRows.filter(r => r.naive_error_with_a_satisfying_extension).reduce((sum, r) => sum + r.satisfying_linear_extensions, 0),
    caveat: 'Unknown is not a known-correct task. Unsupported errors are reported separately from errors on known-satisfied obligations; extension counts are combinatorial, not probabilities.'},
  slicing: Object.fromEntries(['full', 'data-ancestors', 'evidence'].map(mode => {
    const rows = sliceRows.filter(r => r.mode === mode);
    return [mode, {derived_obligations_checked: rows.length, preserved: rows.filter(r => r.verdict_and_evidence_preserved).length,
      median_node_fraction: median(rows.map(r => r.selected_nodes / r.full_nodes))}];
  })),
  timing: {scope: 'resident capture -> validated derived evidence run for production; resident capture -> verdict object for naive; excludes oracle/IO/slicing/rendering',
    warmups_per_case_per_method: 5, samples_per_case_per_method: 30, raw_samples: timingRows.length, randomized_order_seed: 20261023,
    summary: Object.fromEntries(['production', 'naive'].map(method => {
      const medians = cases.map(item => median(timingRows.filter(r => r.case_id === item.id && r.method === method).map(r => r.elapsed_ns)));
      return [method, {median_of_case_median_ns: median(medians), min_case_median_ns: Math.min(...medians), max_case_median_ns: Math.max(...medians)}];
    })), caveat: 'One shared-host CPU session. Different output guarantees and validation scope make this a descriptive cost, not a speedup comparison.'},
  invalid_inputs_rejected: invalidRows.filter(r => r.rejected).length, failures: failures.length,
  claims_not_supported: ['real-GPU bug-detection accuracy', 'complete PTX/ISA semantics', 'human comprehension', 'novelty over existing HB analyses', 'cross-GPU semantic equivalence'],
};
summary.artifacts = Object.fromEntries(fs.readdirSync(out).filter(name => fs.statSync(path.join(out, name)).isFile())
  .map(name => [name, {sha256: sha(fs.readFileSync(path.join(out, name))), bytes: fs.statSync(path.join(out, name)).size}]));
writeJson('summary.json', summary);
console.log(JSON.stringify({output: out, cases: summary.cases, verdicts: summary.verdicts, slicing: summary.slicing,
  invalid_inputs_rejected: summary.invalid_inputs_rejected, failures: failures.length}, null, 2));
if (failures.length) process.exitCode = 1;
