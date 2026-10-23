/** Auditable, bounded repository/evidence access; no filesystem in query functions. */
import {createHash} from 'node:crypto';
import {validateDiagnostic} from '../../../lib/research/natural-diagnostic.js';
import {initialPacket, rawQuery, genericDerived} from './query.mjs';
export {initialPacket, rawQuery, genericDerived};

export const sha = value => createHash('sha256').update(value).digest('hex');
export const clone = value => JSON.parse(JSON.stringify(value));
const insist = (value, message) => { if (!value) throw Error(message); };
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value);
const keys = (value, allowed, label) => insist(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)), `${label}: unexpected field`);
const unique = (values, label) => {
  insist(Array.isArray(values), `${label}: array required`);
  const ids = new Set();
  for (const value of values) { insist(safeId(value.id) && !ids.has(value.id), `${label}: invalid/duplicate id`); ids.add(value.id); }
  return ids;
};
export const STATUSES = ['passed', 'wrong_value', 'timeout', 'execution_error', 'compilation_error', 'sanitizer_error'];
export const OBSERVED_KINDS = ['device-output', 'execution-observation', 'compiler-observation', 'sanitizer-observation'];

/** Catalog contains before observations only. Hidden/gold annotations belong to a different file. */
export function validateCatalog(catalog) {
  keys(catalog, ['format', 'tasks'], 'catalog');
  insist(catalog.format === 'repair-study-catalog-v2', 'catalog format');
  unique(catalog.tasks, 'tasks');
  for (const task of catalog.tasks) {
    keys(task, ['id', 'family', 'split', 'objective', 'files', 'cases', 'evidence', 'diagnosticData', 'limits'], 'task');
    insist(['development', 'holdout'].includes(task.split), 'explicit development/holdout split required');
    insist(typeof task.family === 'string' && typeof task.objective === 'string' && task.objective.length, 'task description required');
    const files = unique(task.files, 'files'), cases = unique(task.cases, 'cases'), evidence = unique(task.evidence, 'evidence');
    insist(task.files.length >= 2, 'v2 requires a multi-file catalog');
    const allIds = [...files, ...cases, ...evidence];
    insist(new Set(allIds).size === allIds.length, 'IDs must be unique across files/cases/evidence');
    const paths = new Set();
    for (const file of task.files) {
      keys(file, ['id', 'path', 'text', 'sha256', 'role'], 'file');
      insist(typeof file.path === 'string' && !file.path.startsWith('/') && !file.path.includes('\\') && !file.path.split('/').some(p => ['..', '.', ''].includes(p)) && !paths.has(file.path), 'unsafe/duplicate file path');
      insist(!file.path.split('/').includes('.git'), 'source history is not a catalog entry');
      insist(typeof file.text === 'string' && sha(file.text) === file.sha256, 'source hash mismatch');
      insist(['implementation', 'generated-ir', 'test', 'configuration'].includes(file.role), 'file role required');
      paths.add(file.path);
    }
    insist(task.files.filter(file => file.role === 'implementation').length >= 2, 'at least two implementation files must be searchable/editable; do not disclose one editable target');
    for (const item of task.cases) {
      keys(item, ['id', 'status', 'parameters', 'evidenceRefs'], 'case');
      insist(STATUSES.includes(item.status) && item.parameters && typeof item.parameters === 'object' && !Array.isArray(item.parameters), 'case status/parameters');
      insist(Array.isArray(item.evidenceRefs) && item.evidenceRefs.length && new Set(item.evidenceRefs).size === item.evidenceRefs.length && item.evidenceRefs.every(id => evidence.has(id)), 'case evidence references');
    }
    for (const fact of task.evidence) {
      keys(fact, ['id', 'kind', 'caseIds', 'observed', 'text', 'payload', 'sourceId', 'rawRefs'], 'evidence');
      insist(typeof fact.kind === 'string' && typeof fact.observed === 'boolean', 'fact kind/observed required');
      insist(Array.isArray(fact.caseIds) && fact.caseIds.length && new Set(fact.caseIds).size === fact.caseIds.length && fact.caseIds.every(id => cases.has(id)), 'fact case references');
      insist(Array.isArray(fact.rawRefs) && fact.rawRefs.length && fact.rawRefs.every(ref => safeId(ref.id) && /^[a-f0-9]{64}$/.test(ref.sha256)), 'raw fact provenance required');
      for (const ref of fact.rawRefs) keys(ref, ['id', 'sha256', 'lines'], 'raw provenance reference');
      insist(fact.sourceId == null || files.has(fact.sourceId), 'evidence source is not in catalog');
      insist(!fact.observed || OBSERVED_KINDS.includes(fact.kind), 'static IR/derived evidence cannot count as observed failure/control');
      for (const id of fact.caseIds) insist(task.cases.find(item => item.id === id).evidenceRefs.includes(fact.id), 'case/evidence links must be bidirectional');
    }
    for (const item of task.cases) for (const id of item.evidenceRefs) insist(task.evidence.find(fact => fact.id === id).caseIds.includes(item.id), 'case/evidence links must be bidirectional');
    if (task.diagnosticData != null) {
      const data = validateDiagnostic(task.diagnosticData);
      insist(data.scope === 'before-only', 'diagnostics may contain before-only observations');
      for (const source of data.sources) {
        const file = task.files.find(file => file.id === source.id);
        insist(file && file.text === source.text && file.sha256 === source.sha256, 'derived-query source not identically available to raw condition');
      }
      for (const item of data.cases) {
        const other = task.cases.find(c => c.id === item.id);
        insist(other && other.status === item.status && JSON.stringify(other.parameters) === JSON.stringify(item.parameters) && JSON.stringify(other.evidenceRefs) === JSON.stringify(item.evidenceRefs), 'derived-query case differs from raw observations');
      }
      for (const fact of data.evidence) {
        const other = task.evidence.find(e => e.id === fact.id);
        insist(other && JSON.stringify(other.payload) === JSON.stringify(fact), 'derived-query evidence must be available verbatim as raw payload');
      }
    }
    insist(task.limits == null || (Array.isArray(task.limits) && task.limits.every(x => typeof x === 'string')), 'limits must be strings');
  }
  return catalog;
}

export function validatePrivatePlan(catalog, plan) {
  keys(plan, ['format', 'tasks'], 'private plan');
  insist(plan.format === 'repair-study-private-v2', 'private plan format');
  unique(plan.tasks, 'private tasks');
  insist(plan.tasks.length === catalog.tasks.length, 'private task count mismatch');
  for (const task of catalog.tasks) {
    const spec = plan.tasks.find(x => x.id === task.id);
    keys(spec, ['id', 'rootCauseId', 'relevantRegions', 'hiddenCaseIds', 'hiddenSpecSHA256', 'requirePassingControl'], 'private task');
    insist(typeof spec.rootCauseId === 'string' && spec.rootCauseId.length, 'independent root-cause ID required');
    insist(Array.isArray(spec.relevantRegions) && spec.relevantRegions.length, 'predeclared source regions required');
    for (const loc of spec.relevantRegions) {
      const file = task.files.find(x => x.id === loc.source_id);
      insist(file && validLocation(file, loc, Number.MAX_SAFE_INTEGER), 'invalid private target region');
    }
    insist(Array.isArray(spec.hiddenCaseIds) && spec.hiddenCaseIds.length && spec.hiddenCaseIds.every(safeId) && new Set(spec.hiddenCaseIds).size === spec.hiddenCaseIds.length, 'nonempty unique hidden contract required');
    insist(spec.hiddenCaseIds.every(id => !task.cases.some(item => item.id === id)), 'hidden case IDs must not identify visible cases');
    insist(/^[a-f0-9]{64}$/.test(spec.hiddenSpecSHA256), 'hidden specification SHA required');
    insist(typeof spec.requirePassingControl === 'boolean', 'control requirement must be explicit');
    insist(task.cases.some(c => c.status !== 'passed'), 'visible observed failure required');
    if (spec.requirePassingControl) insist(task.cases.some(c => c.status === 'passed'), 'visible control required by contract');
  }
  for (const spec of plan.tasks) {
    const split = catalog.tasks.find(task => task.id === spec.id).split;
    insist(!plan.tasks.some(other => other.rootCauseId === spec.rootCauseId && catalog.tasks.find(task => task.id === other.id).split !== split), 'one root cause cannot span development and holdout');
  }
  return plan;
}

export const DEFAULT_PROTOCOL = Object.freeze({
  format: 'repair-study-protocol-v2', model: 'gpt-6-astra', reasoning: 'low', repetitions: 3,
  conditions: ['raw', 'diagnostic'], maxQueries: 8, maxCalls: 9,
  maxResponseCharacters: 16000, maxTotalResponseCharacters: 64000, maxSourceLines: 120,
  maxSearchMatches: 40, maxLocationLines: 40, timeoutSecondsPerCall: 90,
  timeoutSecondsPerTrial: 600, maxConcurrency: 2, feedbackRounds: 0,
  rawOps: ['list', 'search', 'read', 'case'], diagnosticExtraOps: ['derived'],
  firstQuery: 'optional; no condition is required to invoke any tool',
  primaryEndpoint: 'Unmodified candidate applies, actually compiles, and passes every frozen hidden case; invalid calls, missing outputs, build failures and timeouts stay in the denominator.',
  comparisonUnit: 'independent root cause; repetitions are repeated model draws, not new defects or people',
});

export function protocolWith(overrides = {}) {
  const allowed = ['model', 'reasoning', 'repetitions', 'maxQueries', 'maxCalls', 'maxResponseCharacters', 'maxTotalResponseCharacters', 'maxSourceLines', 'maxSearchMatches', 'maxLocationLines', 'timeoutSecondsPerCall', 'timeoutSecondsPerTrial', 'maxConcurrency', 'feedbackRounds'];
  keys(overrides, allowed, 'protocol override');
  const value = {...DEFAULT_PROTOCOL, ...overrides};
  for (const name of allowed.filter(n => !['model', 'reasoning', 'feedbackRounds'].includes(n))) insist(Number.isInteger(value[name]) && value[name] > 0, `positive integer protocol ${name}`);
  insist(value.maxCalls >= value.maxQueries + 1, 'reserve a final-answer call');
  insist(value.maxTotalResponseCharacters >= value.maxResponseCharacters, 'response budget too small');
  insist(value.feedbackRounds === 0, 'this runner deliberately supports predeclared zero-feedback evaluation only');
  insist(typeof value.model === 'string' && typeof value.reasoning === 'string', 'model configuration required');
  return value;
}

/** Errors and rejected responses consume query budget. No silent result truncation. */
export function budgetedQuery(task, condition, request, state, protocol = DEFAULT_PROTOCOL) {
  insist(Number.isInteger(state.queries) && Number.isInteger(state.responseCharacters), 'invalid query accounting');
  if (state.queries >= protocol.maxQueries) return {accepted: false, budgetExhausted: true, response: {error: 'query budget exhausted'}, responseCharacters: 0};
  state.queries++;
  let response;
  try { response = rawQuery(task, condition, request, protocol); } catch (error) { response = {error: error.message}; }
  let serialized = JSON.stringify(response), rejected = false;
  const available = Math.min(protocol.maxResponseCharacters, protocol.maxTotalResponseCharacters - state.responseCharacters);
  if (serialized.length > available) { response = {error: 'response character budget exceeded; narrow source range, search, or read one evidence ID'}; serialized = JSON.stringify(response); rejected = true; }
  if (serialized.length > available) return {accepted: false, budgetExhausted: true, response: null, responseCharacters: 0};
  state.responseCharacters += serialized.length;
  return {accepted: true, rejected, response, responseCharacters: serialized.length, responseSHA256: sha(serialized)};
}

const nullableString = {type: ['string', 'null']}, nullableInteger = {type: ['integer', 'null']};
const queryProperties = {op: {type: 'string'}, scope: nullableString, id: nullableString, text: nullableString, start: nullableInteger, end: nullableInteger, offset: nullableInteger, derived_op: nullableString, groupBy: {type: ['array', 'null'], items: {type: 'string'}}};
export const RESPONSE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    action: {type: 'string', enum: ['query', 'final']},
    query: {type: 'object', additionalProperties: false, properties: queryProperties, required: Object.keys(queryProperties)},
    diagnosis: {type: 'string'},
    locations: {type: 'array', items: {type: 'object', additionalProperties: false, properties: {source_id: {type: 'string'}, start_line: {type: 'integer'}, end_line: {type: 'integer'}}, required: ['source_id', 'start_line', 'end_line']}},
    citations: {type: 'array', items: {type: 'object', additionalProperties: false, properties: {case_id: {type: 'string'}, evidence_ids: {type: 'array', items: {type: 'string'}}}, required: ['case_id', 'evidence_ids']}},
    edits: {type: 'array', items: {type: 'object', additionalProperties: false, properties: {source_id: {type: 'string'}, old: {type: 'string'}, new: {type: 'string'}}, required: ['source_id', 'old', 'new']}},
  }, required: ['action', 'query', 'diagnosis', 'locations', 'citations', 'edits'],
};

export function validAnswer(answer) {
  try {
    keys(answer, RESPONSE_SCHEMA.required, 'answer');
    insist(RESPONSE_SCHEMA.required.every(k => Object.hasOwn(answer, k)), 'missing answer field');
    insist(['query', 'final'].includes(answer.action) && typeof answer.diagnosis === 'string', 'invalid action/diagnosis');
    keys(answer.query, Object.keys(queryProperties), 'query');
    insist(Object.keys(queryProperties).every(k => Object.hasOwn(answer.query, k)), 'missing query field');
    for (const [name, type] of Object.entries(queryProperties)) {
      const value = answer.query[name], types = Array.isArray(type.type) ? type.type : [type.type];
      insist(value === null ? types.includes('null') : Array.isArray(value) ? types.includes('array') && value.every(x => typeof x === 'string') : typeof value === 'number' ? types.includes('integer') && Number.isInteger(value) : types.includes(typeof value), 'query field type');
    }
    for (const name of ['locations', 'citations', 'edits']) {
      insist(Array.isArray(answer[name]), 'answer array');
      const itemSchema = RESPONSE_SCHEMA.properties[name].items;
      for (const item of answer[name]) {
        keys(item, itemSchema.required, name);
        insist(itemSchema.required.every(k => Object.hasOwn(item, k)), 'missing record field');
        for (const [key, spec] of Object.entries(itemSchema.properties)) {
          insist(spec.type === 'array' ? Array.isArray(item[key]) && item[key].every(x => typeof x === 'string') : spec.type === 'integer' ? Number.isInteger(item[key]) : typeof item[key] === spec.type, 'record field type');
        }
      }
    }
    return true;
  } catch { return false; }
}

export function validLocation(file, location, limit = DEFAULT_PROTOCOL.maxLocationLines) {
  return Number.isInteger(location.start_line) && Number.isInteger(location.end_line) && location.start_line >= 1 && location.end_line >= location.start_line && location.end_line - location.start_line + 1 <= limit && location.end_line <= file.text.split('\n').length;
}

export function scoreLocalization(task, spec, answer, protocol = DEFAULT_PROTOCOL) {
  const locations = answer?.locations ?? [], citations = answer?.citations ?? [];
  const validLocations = locations.filter(loc => { const file = task.files.find(f => f.id === loc.source_id); return file && validLocation(file, loc, protocol.maxLocationLines); });
  const locationHit = validLocations.some(loc => spec.relevantRegions.some(target => target.source_id === loc.source_id && loc.start_line <= target.end_line && loc.end_line >= target.start_line));
  const invalidCitations = [], observedCases = new Set(), citationKeys = new Set();
  for (const citation of citations) {
    const item = task.cases.find(c => c.id === citation.case_id), ids = citation.evidence_ids ?? [], key = `${citation.case_id}:${JSON.stringify(ids)}`;
    if (!item || !ids.length || new Set(ids).size !== ids.length || citationKeys.has(key) || !ids.every(id => item.evidenceRefs.includes(id) && task.evidence.some(fact => fact.id === id && fact.caseIds.includes(item.id)))) { invalidCitations.push(citation); continue; }
    citationKeys.add(key);
    if (ids.some(id => { const fact = task.evidence.find(e => e.id === id); return fact.observed && OBSERVED_KINDS.includes(fact.kind); })) observedCases.add(item.id);
  }
  const failureObserved = task.cases.some(c => observedCases.has(c.id) && c.status !== 'passed');
  const passingControlObserved = task.cases.some(c => observedCases.has(c.id) && c.status === 'passed');
  const allLocationsValid = locations.length > 0 && validLocations.length === locations.length;
  const referencesValid = citations.length > 0 && invalidCitations.length === 0;
  return {locationHit, allLocationsValid, referencesValid, failureObserved, passingControlObserved,
    supportedLocalization: locationHit && allLocationsValid && referencesValid && failureObserved && (!spec.requirePassingControl || passingControlObserved),
    invalidLocations: locations.filter(l => !validLocations.includes(l)), invalidCitations,
    scope: 'Declared source-region hit and valid observed references; not semantic proof of a correct explanation.'};
}

/** Original sequential replacements only, across any implementation files in the catalog. */
export function applyEdits(task, answer) {
  insist(validAnswer(answer) && answer.action === 'final', 'valid final answer required');
  insist(answer.edits.length > 0, 'empty candidate patch');
  const texts = new Map(task.files.map(file => [file.id, file.text]));
  for (const edit of answer.edits) {
    const file = task.files.find(file => file.id === edit.source_id);
    insist(file?.role === 'implementation', 'patch target must be a catalog implementation file');
    insist(edit.old.length > 0 && edit.old !== edit.new, 'nonempty meaningful replacement required');
    const text = texts.get(file.id), at = text.indexOf(edit.old);
    insist(at >= 0 && text.indexOf(edit.old, at + 1) === -1, 'old text must match exactly once');
    texts.set(file.id, text.slice(0, at) + edit.new + text.slice(at + edit.old.length));
  }
  const files = task.files.map(file => ({id: file.id, path: file.path, role: file.role, text: texts.get(file.id), beforeSHA256: file.sha256, sha256: sha(texts.get(file.id)), changed: texts.get(file.id) !== file.text}));
  insist(files.some(file => file.changed), 'candidate has no net change');
  return {format: 'repair-study-candidate-v2', taskId: task.id, files,
    candidateTreeSHA256: sha(JSON.stringify(files.map(({path, sha256}) => ({path, sha256})).sort((a, b) => a.path.localeCompare(b.path))))};
}

export function scoreRuntime(spec, candidate, record) {
  const fail = reason => ({success: false, reason, expectedHiddenCases: spec.hiddenCaseIds.length, passedHiddenCases: 0});
  if (!candidate) return fail('no-applicable-candidate');
  if (!record) return fail('missing-runtime-result');
  if (record.candidateTreeSHA256 !== candidate.candidateTreeSHA256 || record.hiddenSpecSHA256 !== spec.hiddenSpecSHA256) return fail('candidate-or-hidden-contract-identity-mismatch');
  if (record.verifierStatus !== 'verified' || !/^[a-f0-9]{64}$/.test(record.verifierReceiptSHA256 ?? '')) return fail('missing-independent-verifier-receipt');
  if (record.buildStatus !== 'passed') return fail('build-failure');
  if (!Array.isArray(record.cases)) return fail('missing-cases');
  const ids = record.cases.map(c => c.id);
  if (new Set(ids).size !== ids.length || ids.length !== spec.hiddenCaseIds.length || !spec.hiddenCaseIds.every(id => ids.includes(id))) return fail('hidden-case-set-mismatch');
  const passed = record.cases.filter(c => c.status === 'passed').length;
  return {success: passed === spec.hiddenCaseIds.length, reason: passed === spec.hiddenCaseIds.length ? null : 'hidden-case-failure', expectedHiddenCases: spec.hiddenCaseIds.length, passedHiddenCases: passed};
}

export function makePrompt(task, condition, protocol) {
  return `Diagnose and repair the implementation using this bounded source/evidence catalog. You are not given a target file. All files with role implementation may be edited; tests/configuration/generated IR may be read but not changed. Do not hardcode observed or expected outputs. The final patch is applied unchanged and evaluated by actual compilation and held-out correctness tests. No compile/test feedback will be supplied.\n` +
    `Both conditions may query list(scope=all|files|cases|evidence), search(text=literal,id=optional file,offset=optional match offset), read(id=file or evidence,start/end optional source lines), and case(id). Search is literal, not regex. Read at most ${protocol.maxSourceLines} source lines per request. All source and raw observations are available on demand.\n` +
    (condition === 'diagnostic' ? `You may additionally query derived(derived_op=contrast,groupBy=[parameter keys]), derived(derived_op=observed,id=optional caseId), derived(derived_op=source_links,id=optional caseId), or derived(derived_op=overlap,id=caseId). These reusable relations use the same raw source/observations available in the ordinary API. Contrast groups supplied statuses; observed collects actual observation references; source_links follows explicit archived source/provenance links only. Overlap uses the existing interactive viewer's static TMEM parser when supported. Unsupported cases return an explicit error. Derived results are not hardware timing or causal proof. Use these queries only if useful; no dedicated query is mandatory.\n` : `This condition has the ordinary source/evidence operations above.\n`) +
    `At most ${protocol.maxQueries} queries and ${protocol.maxCalls} model calls, ${protocol.maxResponseCharacters} characters per response and ${protocol.maxTotalResponseCharacters} total response characters; failed requests consume query budget. The initial catalog is identical across conditions. You may finish immediately, or request evidence first. Final answer: locations with at most ${protocol.maxLocationLines} lines each, citations binding each case_id to its actual evidence_ids, and sequential exact unique-match edits {source_id,old,new}. Include actual observed failure evidence and, when available, a passing control; shared static IR alone is not an observation. All source files including generated IR are valid location citations. Explain unknowns in diagnosis.\n` +
    `Use the required JSON schema. For an unused query set op='none' and every other field to null. For a query response, locations/citations/edits may be empty. External tools, shell, network and source history are not available through this task API.\nINITIAL CATALOG:\n${JSON.stringify(initialPacket(task))}`;
}
