/** Pure shared query API for browser and agent. No filesystem, network, or node imports. */
import {queryDiagnostic} from '../../../lib/research/natural-diagnostic.js';
const insist = (value, message) => { if (!value) throw Error(message); };
const clone = value => JSON.parse(JSON.stringify(value));
const DEFAULT_QUERY_LIMITS = Object.freeze({maxSourceLines: 120, maxSearchMatches: 40});

export function initialPacket(task) {
  return {taskId: task.id, objective: task.objective,
    files: task.files.map(file => ({id: file.id, path: file.path, role: file.role, lines: file.text.split('\n').length})),
    cases: task.cases.map(item => ({id: item.id, status: item.status, parameters: item.parameters})),
    limits: task.limits ?? []};
}

export function rawQuery(task, condition, request, protocol = DEFAULT_QUERY_LIMITS) {
  insist(['raw', 'diagnostic'].includes(condition), 'unknown condition');
  insist(request && typeof request.op === 'string', 'operation required');
  if (request.op === 'list') {
    const scope = request.scope ?? 'all'; insist(['all', 'files', 'cases', 'evidence'].includes(scope), 'invalid list scope');
    const response = {};
    if (['all', 'files'].includes(scope)) response.files = initialPacket(task).files;
    if (['all', 'cases'].includes(scope)) response.cases = initialPacket(task).cases;
    if (['all', 'evidence'].includes(scope)) response.evidence = task.evidence.map(({id, kind, caseIds, observed, sourceId}) => ({id, kind, caseIds, observed, sourceId}));
    return response;
  }
  if (request.op === 'search') {
    insist(typeof request.text === 'string' && request.text.length > 0 && request.text.length <= 200, 'nonempty literal search of at most 200 characters required');
    const sourceIds = request.id == null ? task.files.map(file => file.id) : [request.id];
    insist(sourceIds.every(id => task.files.some(file => file.id === id)), 'unknown search file');
    const matches = [];
    for (const file of task.files.filter(file => sourceIds.includes(file.id))) file.text.split('\n').forEach((text, index) => {
      if (text.includes(request.text)) matches.push({source_id: file.id, path: file.path, line: index + 1, text});
    });
    const offset = request.offset ?? 0;
    insist(Number.isInteger(offset) && offset >= 0, 'invalid search offset');
    return {literal: request.text, totalMatches: matches.length, offset, matches: matches.slice(offset, offset + protocol.maxSearchMatches), nextOffset: offset + protocol.maxSearchMatches < matches.length ? offset + protocol.maxSearchMatches : null};
  }
  if (request.op === 'read') {
    const file = task.files.find(file => file.id === request.id);
    if (file) {
      const lines = file.text.split('\n'), start = request.start ?? 1, end = request.end ?? Math.min(lines.length, start + protocol.maxSourceLines - 1);
      insist(Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start && end <= lines.length && end - start + 1 <= protocol.maxSourceLines, 'invalid/budget-exceeding source range');
      return {id: file.id, path: file.path, sha256: file.sha256, start, end, totalLines: lines.length, lines: lines.slice(start - 1, end).map((text, offset) => ({line: start + offset, text}))};
    }
    const fact = task.evidence.find(fact => fact.id === request.id);
    insist(fact, 'unknown source/evidence ID');
    return clone(fact);
  }
  if (request.op === 'case') {
    const item = task.cases.find(item => item.id === request.id); insist(item, 'unknown case');
    return {case: clone(item), evidence: task.evidence.filter(fact => item.evidenceRefs.includes(fact.id)).map(clone)};
  }
  if (request.op === 'derived') {
    insist(condition === 'diagnostic', 'derived operation unavailable in raw condition');
    insist(['contrast', 'observed', 'source_links', 'overlap'].includes(request.derived_op), 'unsupported derived operation');
    if (request.derived_op !== 'overlap') return genericDerived(task, request);
    insist(task.diagnosticData, 'no supported allocation relation for this capture');
    const req = {op: request.derived_op};
    if (request.id != null) req.id = request.id;
    if (request.groupBy != null) req.groupBy = request.groupBy;
    return queryDiagnostic(task.diagnosticData, req);
  }
  throw Error('unsupported operation');
}

/** Generic factual relations, defined without bug-specific symbols or repair hints. */
export function genericDerived(task, request) {
  const cases = request.id == null ? task.cases : task.cases.filter(c => c.id === request.id);
  insist(cases.length > 0, 'no cases for derived request');
  if (request.derived_op === 'contrast') {
    const groupBy = request.groupBy ?? [];
    insist(Array.isArray(groupBy) && groupBy.length <= 8 && groupBy.every(key => typeof key === 'string' && key.length <= 100), 'groupBy must contain up to eight parameter keys');
    const groups = new Map();
    for (const item of cases) {
      const parameters = Object.fromEntries(groupBy.map(key => [key, Object.hasOwn(item.parameters, key) ? item.parameters[key] : null]));
      const key = JSON.stringify(parameters);
      if (!groups.has(key)) groups.set(key, {parameters, counts: {}, caseIds: [], observationIds: []});
      const group = groups.get(key); group.counts[item.status] = (group.counts[item.status] ?? 0) + 1; group.caseIds.push(item.id);
      group.observationIds.push(...item.evidenceRefs.filter(id => task.evidence.find(fact => fact.id === id).observed));
    }
    return {groups: [...groups.values()].map(group => ({...group, observationIds: [...new Set(group.observationIds)]})), scope: 'Descriptive grouping of the supplied observed statuses; no causal or repair inference.'};
  }
  if (request.derived_op === 'observed') {
    return {observations: cases.flatMap(item => item.evidenceRefs.map(id => task.evidence.find(fact => fact.id === id)).filter(fact => fact.observed).map(fact => ({caseId: item.id, status: item.status, parameters: item.parameters, evidenceId: fact.id, kind: fact.kind, text: fact.text ?? null, rawRefs: fact.rawRefs}))), scope: 'Observed facts only; payload values remain available through read/case in both conditions.'};
  }
  if (request.derived_op === 'source_links') {
    return {links: cases.flatMap(item => item.evidenceRefs.map(id => task.evidence.find(fact => fact.id === id)).flatMap(fact => {
      const ids = [...new Set([fact.sourceId, ...fact.rawRefs.map(ref => ref.id)].filter(id => task.files.some(file => file.id === id)))];
      return ids.map(id => ({caseId: item.id, evidenceId: fact.id, sourceId: id, path: task.files.find(file => file.id === id).path, rawRefs: fact.rawRefs}));
    })), scope: 'Only explicit archived source/provenance links; absent links are not inferred.'};
  }
  throw Error('unsupported generic derived operation');
}

