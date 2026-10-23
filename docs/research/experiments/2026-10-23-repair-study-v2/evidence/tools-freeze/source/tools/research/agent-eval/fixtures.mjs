/** Frozen finite-model pilot inputs. Gold comes only from the permutation oracle. */
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {protocolCorpus, enumerateProtocolOracle} from '../protocol-corpus.mjs';
import {validateProtocolCapture} from '../../../lib/research/protocol.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEFAULT_OUTPUT = path.join(ROOT, 'out/research/agent-eval');
export const MODEL = 'gpt-6-astra';
export const REASONING = 'low';
export const CONDITIONS = ['flat', 'structured'];
export const MISSING = ['consumer-record', 'before-record', 'after-record', 'expected-token-identity',
  'observed-token-identity', 'required-token-identity', 'completion-token-identity', 'matching-completion-token', 'relative-hb-order'];
export const OUTPUT_SCHEMA = {type: 'object', additionalProperties: false,
  properties: {status: {type: 'string', enum: ['sat', 'violated', 'unknown']},
    evidence_ids: {type: 'array', items: {type: 'string'}},
    missing_evidence: {type: 'array', items: {type: 'string', enum: MISSING}}, reason: {type: 'string'}},
  required: ['status', 'evidence_ids', 'missing_evidence', 'reason']};

// Selection is fixed before any inference call. These are synthetic development
// fixtures, not held-out natural bugs. IDs/descriptions below are never in prompts.
const SELECTION = [
  ['value-huge-generation-equal', 'value', 'value-generation', []],
  ['completion-transitive', 'ordering', 'order', []],
  ['reuse-after-reader', 'ordering', 'order', []],
  ['completion-forward', 'ordering:token', 'completion-token', []],
  ['value-same-parity-wrong-generation', 'value', 'value-generation', []],
  ['value-wrong-resource', 'value', 'value-generation', []],
  ['completion-reverse', 'ordering', 'order', []],
  ['completion-wrong-facet-same-generation', 'ordering:token', 'completion-token', []],
  ['value-unknown-observed', 'value', 'value-generation', ['observed-token-identity']],
  ['completion-unordered-overlap', 'ordering', 'order', ['relative-hb-order']],
  ['completion-same-parity-old-token', 'ordering', 'order', ['matching-completion-token']],
  ['completion-missing-record', 'ordering', 'order', ['before-record', 'completion-token-identity']],
];

export const INSTRUCTIONS = `Diagnose exactly the supplied target using only this prompt. Do not use any tools, shell, browsing, files, external knowledge, or code execution. This is a finite synthetic observation problem, not full GPU/PTX semantics. Return only the required JSON object, with a short reason.

Rules:
1. A token identity is the exact tuple (scopeId, resourceId, generation, domain). Generation is an arbitrary-length decimal STRING, never parity or a floating-point number. Known tokens match iff all four fields agree. An unknown token never matches or mismatches conclusively.
2. For target kind value-generation: compare request.expected with the token attached to the event request.consumerId. If the consumer is absent or either token is unknown, return unknown. Otherwise return sat for an exact match and violated for a mismatch. request.observed is only a mirror and cannot replace a missing consumer record.
3. For target kind completion-token: compare request.requiredToken with the token attached to request.beforeId. If the event is absent or either token is unknown, return unknown. Otherwise return sat for an exact match and violated for a mismatch. All domains are distinct, including producer_result_ready, smem_read_complete, reader_done, and value.
4. For target kind order: both endpoint events must be present and the completion-token comparison in rule 3 must be sat. If either condition fails, return unknown (even if the completion token itself is a known mismatch). Otherwise consider EVERY total order consistent with all verified hb edges: sat if beforeId precedes afterId in every such order; violated if afterId precedes beforeId in every such order; unknown if both orders are possible. Transitive edges count. Array order and record/file order supply NO ordering evidence. No edge means uncertainty, not a violation. Inputs are valid DAGs.
5. Return evidence_ids containing only IDs in facts. Cite the requirementRef, relevant endpoint recordRef(s), known token evidenceRef(s), and every HB evidenceRef needed for an ordering proof. For value-generation use the consumer record and expected/observed token facts; for completion-token use only the before-event record and required/actual token facts; for order use both endpoint records and required/actual token facts that are present. For unknown relative order, cite the relevant identity and endpoint facts; absent HB edges cannot be cited. There is no requirement to cite irrelevant records.
6. missing_evidence must be empty for sat/violated. For unknown, use applicable codes from: consumer-record, before-record, after-record, expected-token-identity, observed-token-identity, required-token-identity, completion-token-identity, matching-completion-token, relative-hb-order. Missing before-event entails both before-record and completion-token-identity. A known mismatching completion token uses matching-completion-token. Only use relative-hb-order when endpoints and matching completion identity are established but neither relative order is established. Do not claim that missing evidence proves a GPU defect.

The data below contains the entire problem. The target has no supplied verdict.\n`;

export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
export function flattenFacts(value, prefix = '') {
  if (Array.isArray(value)) {
    if (!value.length) return [`${prefix} = []`];
    return value.flatMap((item, i) => flattenFacts(item, `${prefix}[${i}]`));
  }
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => flattenFacts(item, prefix ? `${prefix}.${key}` : key));
  return [`${prefix} = ${JSON.stringify(value)}`];
}
export function renderPrompt(payload, condition) {
  if (!CONDITIONS.includes(condition)) throw new Error(`Unknown condition ${condition}`);
  return INSTRUCTIONS + (condition === 'flat'
    ? '\nData as flat field facts (paths identify fields of the same records):\n' + flattenFacts(payload).join('\n')
    : '\nData as structured relationship JSON:\n' + JSON.stringify(payload, null, 2)) + '\n';
}

function anonymize(capture, kind) {
  const c = structuredClone(capture);
  const names = new Map();
  const add = (old, replacement) => names.set(old, replacement);
  add(c.scopeId, 's01');
  c.resources.forEach((r, i) => add(r.id, `r${String(i + 1).padStart(2, '0')}`));
  c.events.forEach((e, i) => add(e.id, `n${String(i + 1).padStart(2, '0')}`));
  // Absent event references also receive neutral IDs.
  for (const request of c.obligations) for (const field of ['consumerId', 'beforeId', 'afterId']) {
    if (request[field] && !names.has(request[field])) add(request[field], `n${String(names.size + 1).padStart(2, '0')}`);
  }
  c.facts.forEach((f, i) => add(f.id, `f${String(i + 1).padStart(2, '0')}`));
  c.hb.forEach((h, i) => add(h.id, `h${String(i + 1).padStart(2, '0')}`));
  c.obligations.forEach((o, i) => add(o.id, `q${String(i + 1).padStart(2, '0')}`));
  const transform = item => {
    if (Array.isArray(item)) return item.map(transform);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item)
      .filter(([key]) => key !== 'provenance')
      .map(([key, value]) => [key, transform(value)]));
    return typeof item === 'string' && names.has(item) ? names.get(item) : item;
  };
  const payload = transform({scopeId: c.scopeId, resources: c.resources, facts: c.facts,
    events: c.events, hb: c.hb, request: c.obligations[0], target: {kind}});
  // Reasons state missing input, not case labels.
  const normalizeUnknown = item => {
    if (Array.isArray(item)) item.forEach(normalizeUnknown);
    else if (item && typeof item === 'object') {
      if (item.status === 'unknown') item.reason = 'not-observed';
      Object.values(item).forEach(normalizeUnknown);
    }
  };
  normalizeUnknown(payload);
  return {payload, names};
}

// Evidence grading is a narrowly declared reference-coverage check, not a claim
// that the model's prose is correct. All selected order proofs have one path.
function requiredEvidence(capture, sourceTarget, kind, status) {
  const request = capture.obligations[0];
  const byId = new Map(capture.events.map(event => [event.id, event]));
  const refs = [request.requirementRef];
  const add = token => { if (token?.status === 'known') refs.push(token.evidenceRef); };
  if (kind === 'value-generation') {
    const event = byId.get(request.consumerId);
    if (event) refs.push(event.recordRef);
    add(request.expected); add(event?.token);
  } else {
    const before = byId.get(request.beforeId), after = byId.get(request.afterId);
    if (before) refs.push(before.recordRef);
    if (kind === 'order' && after) refs.push(after.recordRef);
    add(request.requiredToken); add(before?.token);
    if (kind === 'order' && status !== 'unknown') {
      // This corpus selection contains only the unique direct/transitive proof.
      refs.push(...capture.hb.map(edge => edge.evidenceRef));
    }
  }
  return [...new Set(refs)];
}

export function buildFixtures() {
  const corpus = new Map(protocolCorpus().map(item => [item.id, item]));
  // Opaque order does not group answers; selection and order are predeclared.
  const order = [9, 1, 5, 11, 3, 6, 0, 8, 4, 2, 10, 7];
  return order.map((selectedIndex, position) => {
    const [sourceId, targetId, kind, missing] = SELECTION[selectedIndex];
    const source = corpus.get(sourceId);
    validateProtocolCapture(source.capture);
    const oracle = enumerateProtocolOracle(source.capture);
    const result = oracle.results.find(item => item.id === targetId);
    if (!result) throw new Error(`Missing oracle target ${sourceId}/${targetId}`);
    const status = result.status === 'satisfied' ? 'sat' : result.status;
    const {payload, names} = anonymize(source.capture, kind);
    const refs = requiredEvidence(source.capture, targetId, kind, status).map(ref => names.get(ref));
    return {id: `t${String(position + 1).padStart(2, '0')}`, sourceId, sourceDescription: source.description,
      sourceSplit: source.split, sourceCapture: source.capture, sourceTargetId: targetId, payload,
      gold: {status, evidenceIds: refs, missingEvidence: missing,
        evidenceScoringScope: 'required record/identity references plus unique path edges; no semantic grading of reason'}, oracle};
  });
}

export async function freeze(output = DEFAULT_OUTPUT) {
  const dir = path.join(output, 'frozen');
  await mkdir(dir, {recursive: true});
  const fixtures = buildFixtures();
  const contents = JSON.stringify(fixtures, null, 2) + '\n';
  const fixtureSHA256 = sha256(contents);
  try {
    const previous = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    if (previous.fixtureSHA256 !== fixtureSHA256) throw new Error('Existing freeze differs: use a new output directory; never overwrite a registered pilot.');
    return previous;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const prompts = [];
  for (const task of fixtures) for (const condition of CONDITIONS) {
    const content = renderPrompt(task.payload, condition);
    const file = `${task.id}.${condition}.txt`;
    await writeFile(path.join(dir, file), content);
    prompts.push({task: task.id, condition, file, sha256: sha256(content)});
  }
  const sourceFiles = ['lib/research/protocol.js', 'tools/research/protocol-corpus.mjs',
    'tools/research/agent-eval/fixtures.mjs', 'tools/research/agent-eval/run.mjs'];
  const sources = [];
  for (const file of sourceFiles) sources.push({file, sha256: sha256(await readFile(path.join(ROOT, file)))});
  await writeFile(path.join(dir, 'fixtures.json'), contents);
  await writeFile(path.join(dir, 'output.schema.json'), JSON.stringify(OUTPUT_SCHEMA, null, 2) + '\n');
  const manifest = {schema: 'finite-agent-pilot-freeze-v1', frozenAt: new Date().toISOString(), fixtureSHA256,
    tasks: fixtures.length, balance: Object.fromEntries(['sat', 'violated', 'unknown'].map(s => [s, fixtures.filter(t => t.gold.status === s).length])),
    model: MODEL, reasoningEffort: REASONING, repetitions: 2, conditions: CONDITIONS, maxConcurrency: 2,
    timeoutSeconds: 90, smokeCalls: 2, mainCalls: 48, gold: 'independent-exhaustive-permutation-v1',
    syntheticDevelopmentFixtures: true, heldOutNaturalBugs: false, conditionsDifferOnlyInOrganization: true,
    prompts, sources, officialDocumentation: 'https://developers.openai.com/blog/eval-skills',
    constraints: ['prompt-only; no tools; fresh empty cwd for every call', 'no model answer or descriptive case IDs in prompt',
      'smoke validates transport/schema/isolation only; prompts not tuned by score', 'no human performance or visualization-benefit inference',
      'task is the statistical unit; repetitions are repeated agent calls, not participants']};
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
