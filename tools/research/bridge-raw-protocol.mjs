#!/usr/bin/env node
/** Connect real raw-record references to bounded obligations without inventing
 * completion observations, logical mappings, or cross-warp order. */
import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {checkProtocol} from '../../lib/research/protocol.js';
import {sliceEvidence} from '../../lib/research/evidence.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const missing = reason => ({status: 'unknown', reason});
const json = value => JSON.stringify(value, null, 2) + '\n';

export function captureFromRaw(raw) {
  if (raw.format !== 'gpu-raw-cta-evidence-v1' || !raw.selection.cta_complete_as_recorded) throw Error('complete raw CTA required');
  const digest = raw.source.trace_sha256;
  const scopeId = `${digest}:cta:0,0,0`;
  const flat = raw.warps.flatMap(warp => warp.instructions).filter(i => i.active_mask !== 0);
  // These are observation anchors, not recovered output tensors or fault sites.
  const tensor = flat.find(i => /^(UTCHMMA|HGMMA|HMMA|LDTM)/.test(i.opcode));
  const fallback = flat.findLast(i => /^STG/.test(i.opcode)) ?? flat.at(-1);
  const consumer = tensor ?? fallback;
  if (!consumer) throw Error('no active observation anchor');
  const free = flat.findLast(i => /^UTCATOMSWS\.AND/.test(i.opcode));
  const record = (inst, role) => ({id: inst.id, scopeId, role, recordRef: `record:${inst.id}`,
    token: missing('logical resource/generation/domain not recovered from this raw callback')});
  const facts = [{id: 'analysis-contract', kind: 'analysis-request',
    scope: 'query actual evidence sufficiency, not classify an ISA violation',
    sourceTraceSha256: digest}];
  for (const inst of [...new Map([consumer, free].filter(Boolean).map(inst => [inst.id, inst])).values()]) facts.push({id: `record:${inst.id}`, kind: 'raw-instruction-record',
    traceSha256: digest, sourceLine: inst.source_line, warpId: inst.warp_id, ordinal: inst.warp_ordinal,
    pc: inst.pc, opcode: inst.opcode, activeMask: inst.active_mask,
    interpretation: 'raw pre-instruction callback; not an observed asynchronous completion'});
  const events = [record(consumer, 'consumer')];
  const obligations = [{id: 'observed-value-origin', kind: 'value-generation', consumerId: consumer.id,
    requirementRef: 'analysis-contract', expected: missing('logical tensor/version mapping unavailable'),
    observed: missing('no verified post-write/consumer value provenance')}];
  if (tensor) obligations.push({id: 'tensor-input-readiness', kind: 'completion-before-consume',
    beforeId: 'unobserved-producer-completion', afterId: tensor.id, requirementRef: 'analysis-contract',
    requiredToken: missing('matching full generation and completion domain unavailable')});
  if (free && free.id !== consumer.id) {
    events.push(record(free, 'reuse'));
    obligations.push({id: 'tmem-reader-before-release', kind: 'reader-before-reuse',
      beforeId: 'unobserved-last-reader-completion', afterId: free.id, requirementRef: 'analysis-contract',
      requiredToken: missing('TMEM reader set, completion domain and runtime generation unavailable')});
  }
  return {id: `raw-partial:${digest}`, scopeId,
    provenance: {kind: 'derived', sourceKind: 'hardware-trace', sourceTraceSha256: digest,
      selection: 'at most one tensor issue/output anchor and one release anchor selected in exported warp/record order; no cross-warp temporal lastness inferred'},
    identity: {specId: `unmapped:${digest}`, specHash: `unverified:${digest}`, inputId: `unverified:${digest}`,
      semanticsId: 'raw-callbacks-with-explicit-unknown-v1'}, resources: [], facts, events, hb: [], obligations};
}

async function main() {
  const args = process.argv.slice(2), get = flag => args[args.indexOf(flag) + 1];
  if (!args.includes('--input') || !args.includes('--output')) throw Error('--input and --output required');
  const input = resolve(get('--input')), output = resolve(get('--output'));
  const manifestBytes = await readFile(join(input, 'summary.json'));
  const manifest = JSON.parse(manifestBytes);
  if (manifest.format !== 'gpu-raw-cta-evidence-v1') throw Error('raw evidence manifest required');
  const declared = new Map(manifest.files.map(row => [row.path, row]));
  if (declared.size !== manifest.files.length) throw Error('duplicate raw manifest path');
  await mkdir(output, {recursive: false});
  const rows = [];
  for (const file of (await readdir(input)).filter(name => name.endsWith('.json.gz')).sort()) {
    const bytes = await readFile(join(input, file));
    const expected = declared.get(file);
    if (!expected || expected.sha256 !== sha(bytes) || expected.bytes !== bytes.length) throw Error('raw manifest artifact mismatch');
    const raw = JSON.parse(gunzipSync(bytes));
    if (raw.format !== 'gpu-raw-cta-evidence-v1') continue;
    if (raw.source.trace_sha256 !== expected.trace_sha256 || raw.source.gpu !== expected.gpu || raw.source.case !== expected.case) throw Error('raw manifest identity mismatch');
    const capture = captureFromRaw(raw), run = checkProtocol(capture);
    if (run.obligations.some(o => o.status !== 'unknown')) throw Error('unsupported positive raw-trace conclusion');
    const slices = run.obligations.map(o => ({obligationId: o.id, run: sliceEvidence(run, o.subjectIds)}));
    for (const slice of slices) {
      const original = run.obligations.find(o => o.id === slice.obligationId);
      const retained = slice.run.obligations.find(o => o.id === original.id);
      if (!retained || JSON.stringify(retained) !== JSON.stringify(original)) throw Error('unknown obligation not preserved');
    }
    const name = `${raw.source.gpu}-${raw.source.trace_sha256.slice(0,16)}.json`;
    const encoded = json({capture, run, slices});
    await writeFile(join(output, name), encoded);
    rows.push({gpu: raw.source.gpu, case: raw.source.case, traceSha256: raw.source.trace_sha256,
      rawArtifact: file, rawArtifactSha256: sha(bytes), result: name,
      resultSha256: sha(encoded), resultBytes: Buffer.byteLength(encoded), obligations: run.obligations.length,
      satisfied: 0, violated: 0, unknown: run.obligations.length, unknownPreservedInEverySlice: true});
  }
  if (!rows.length) throw Error('no raw artifacts');
  if (rows.length !== declared.size) throw Error('missing declared raw artifacts');
  const summary = {format: 'raw-to-protocol-bridge-v1', inputManifestSha256: sha(manifestBytes), rows,
    totalObligations: rows.reduce((n, row) => n + row.obligations, 0),
    realTraceConclusions: 'unknown: actual completion/value identities are unavailable; no bug or safety conclusion',
    limitations: ['Query anchors are selected observations, not an exhaustive ISA obligation extraction.',
      'Static allocation-column knowledge does not recover runtime generation or reader completion.',
      'Preserving these unknown obligations is interface integration, not new true-positive detection.'],
    sourceSha256: Object.fromEntries(await Promise.all(['tools/research/bridge-raw-protocol.mjs', 'lib/research/protocol.js',
      'lib/research/evidence.js'].map(async path => [path, sha(await readFile(path))])))};
  await writeFile(join(output, 'summary.json'), json(summary));
  process.stdout.write(json({traces: rows.length, totalObligations: summary.totalObligations, conclusion: 'all unknown preserved'}));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
