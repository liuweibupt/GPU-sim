/**
 * Bounded, three-valued obligations over explicitly attested observations/HB.
 * This is not a PTX memory-model implementation or a GPU race detector.
 * Unordered events, absent records, and unknown identities remain unknown.
 */
import {validateEvidenceRun} from './evidence.js';

const KINDS = new Set(['value-generation', 'completion-before-consume', 'reader-before-reuse']);
const ROLES = new Set(['producer-completion', 'consumer', 'reader-completion', 'reuse', 'marker']);
const PREFIX = 'protocol:';
const idLike = value => typeof value === 'string' && value.length > 0;
function requireThat(condition, message) {
  if (!condition) throw new Error(`Protocol capture: ${message}`);
}
function keyed(items, label) {
  requireThat(Array.isArray(items), `${label} must be an array`);
  const result = new Map();
  for (const item of items) {
    requireThat(item && idLike(item.id) && !item.id.startsWith(PREFIX), `${label} needs nonreserved IDs`);
    requireThat(!result.has(item.id), `duplicate ${label} ID ${item.id}`);
    result.set(item.id, item);
  }
  return result;
}

export function validateProtocolCapture(capture) {
  requireThat(capture && idLike(capture.id) && idLike(capture.scopeId), 'capture ID/scope required');
  const facts = keyed(capture.facts, 'facts');
  const resources = keyed(capture.resources, 'resources');
  const events = keyed(capture.events, 'events');
  const hb = keyed(capture.hb, 'HB edges');
  const obligations = keyed(capture.obligations, 'obligations');
  const reference = (ref, where) => requireThat(facts.has(ref), `${where}: missing evidence ${ref}`);
  for (const fact of facts.values()) requireThat(idLike(fact.kind), `fact ${fact.id} needs kind`);
  for (const resource of resources.values()) {
    requireThat(resource.scopeId === capture.scopeId, `mixed resource scope ${resource.id}`);
  }
  const tokenClaims = new Map();
  const token = (value, where) => {
    requireThat(value && ['known', 'unknown'].includes(value.status), `${where}: explicit token status required`);
    if (value.status === 'known') {
      requireThat(value.scopeId === capture.scopeId, `${where}: mixed token scope`);
      requireThat(resources.has(value.resourceId), `${where}: unknown resource ID`);
      requireThat(idLike(value.domain), `${where}: explicit completion/value domain required`);
      requireThat(typeof value.generation === 'string' && /^(0|[1-9][0-9]*)$/.test(value.generation),
        `${where}: generation must be an unbounded canonical decimal string, not parity`);
      reference(value.evidenceRef, where);
      const fact = facts.get(value.evidenceRef);
      for (const field of ['scopeId', 'resourceId', 'generation', 'domain']) {
        if (Object.hasOwn(fact, field)) requireThat(fact[field] === value[field], `${where}: token contradicts structured evidence field ${field}`);
      }
      const claim = JSON.stringify([value.scopeId, value.resourceId, value.generation, value.domain]);
      requireThat(!tokenClaims.has(value.evidenceRef) || tokenClaims.get(value.evidenceRef) === claim,
        `${where}: contradictory token identities share evidence ${value.evidenceRef}`);
      tokenClaims.set(value.evidenceRef, claim);
    } else {
      requireThat(idLike(value.reason), `${where}: unknown token needs reason`);
      if (value.evidenceRef != null) reference(value.evidenceRef, where);
    }
  };
  for (const event of events.values()) {
    requireThat(event.scopeId === capture.scopeId, `mixed event scope ${event.id}`);
    requireThat(ROLES.has(event.role), `unsupported event role ${event.role}`);
    reference(event.recordRef, `event ${event.id}`);
    token(event.token, `event ${event.id}`);
  }
  for (const edge of hb.values()) {
    requireThat(events.has(edge.from) && events.has(edge.to) && edge.from !== edge.to, `HB ${edge.id}: invalid endpoints`);
    requireThat(edge.verified === true, `HB ${edge.id}: explicit verified attestation required`);
    reference(edge.evidenceRef, `HB ${edge.id}`);
  }
  // A cycle is invalid input, not a GPU bug diagnosis.
  const degrees = new Map([...events.keys()].map(id => [id, 0]));
  const outgoing = new Map([...events.keys()].map(id => [id, []]));
  for (const edge of hb.values()) {
    degrees.set(edge.to, degrees.get(edge.to) + 1);
    outgoing.get(edge.from).push(edge.to);
  }
  const ready = [...degrees].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length) {
    const node = ready.pop(); visited++;
    for (const next of outgoing.get(node)) {
      degrees.set(next, degrees.get(next) - 1);
      if (degrees.get(next) === 0) ready.push(next);
    }
  }
  requireThat(visited === events.size, 'cyclic verified HB graph');
  const outputIds = new Set();
  for (const obligation of obligations.values()) {
    requireThat(KINDS.has(obligation.kind), `unsupported obligation ${obligation.kind}`);
    requireThat(!Object.hasOwn(obligation, 'status'), `obligation ${obligation.id}: input verdicts are forbidden`);
    reference(obligation.requirementRef, `obligation ${obligation.id}`);
    for (const produced of obligation.kind === 'value-generation' ? [obligation.id] : [obligation.id, `${obligation.id}:token`]) {
      requireThat(!outputIds.has(produced), `colliding derived obligation ID ${produced}`);
      outputIds.add(produced);
    }
    if (obligation.kind === 'value-generation') {
      requireThat(idLike(obligation.consumerId), `obligation ${obligation.id}: consumer ID required`);
      token(obligation.expected, `obligation ${obligation.id} expected`);
      token(obligation.observed, `obligation ${obligation.id} observed`);
      for (const value of [obligation.expected, obligation.observed]) if (value.status === 'known') requireThat(value.domain === 'value', 'value-generation requires value domain');
      if (events.has(obligation.consumerId)) {
        const consumer = events.get(obligation.consumerId);
        requireThat(consumer.role === 'consumer', 'value event must be a consumer');
        requireThat(obligation.observed.status === consumer.token.status &&
          ['scopeId', 'resourceId', 'generation', 'domain', 'evidenceRef'].every(key => obligation.observed[key] === consumer.token[key]),
        `obligation ${obligation.id}: observed value must bind to the consumer token record`);
      }
    } else {
      requireThat(idLike(obligation.beforeId) && idLike(obligation.afterId) && obligation.beforeId !== obligation.afterId,
        `obligation ${obligation.id}: distinct endpoint IDs required`);
      token(obligation.requiredToken, `obligation ${obligation.id} required token`);
      const beforeRole = obligation.kind === 'completion-before-consume' ? 'producer-completion' : 'reader-completion';
      const afterRole = obligation.kind === 'completion-before-consume' ? 'consumer' : 'reuse';
      if (events.has(obligation.beforeId)) requireThat(events.get(obligation.beforeId).role === beforeRole, `obligation ${obligation.id}: before role mismatch`);
      if (events.has(obligation.afterId)) requireThat(events.get(obligation.afterId).role === afterRole, `obligation ${obligation.id}: after role mismatch`);
    }
  }
  return capture;
}

function compareTokens(expected, observed) {
  if (expected.status !== 'known' || observed.status !== 'known') return 'unknown';
  return ['scopeId', 'resourceId', 'generation', 'domain'].every(key => expected[key] === observed[key]) ? 'satisfied' : 'violated';
}

function findPath(from, to, outgoing) {
  const queue = [from], previous = new Map([[from, null]]);
  for (let head = 0; head < queue.length; head++) {
    for (const edge of outgoing.get(queue[head]) ?? []) {
      if (previous.has(edge.to)) continue;
      previous.set(edge.to, edge);
      if (edge.to === to) {
        const path = [];
        for (let node = to; node !== from;) {
          const step = previous.get(node); path.push(step); node = step.from;
        }
        return path.reverse();
      }
      queue.push(edge.to);
    }
  }
  return null;
}

/** Derive obligations; the caller supplies observations/requirements, never verdicts. */
export function checkProtocol(capture) {
  validateProtocolCapture(capture);
  const events = new Map(capture.events.map(event => [event.id, event]));
  const outgoing = new Map();
  for (const edge of capture.hb) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge);
  }
  const evidence = structuredClone(capture.facts);
  const nodes = capture.events.map(event => ({id: event.id, role: event.role, scopeId: event.scopeId,
    token: structuredClone(event.token), evidenceRefs: [...new Set([event.recordRef, event.token.evidenceRef].filter(Boolean))]}));
  const edges = capture.hb.map(edge => ({id: edge.id, from: edge.from, to: edge.to, type: 'happens-before',
    evidenceRefs: [edge.evidenceRef], semantics: 'caller-attested verified HB; not inferred from file order'}));
  const obligations = [];
  function emit(request, id, kind, status, availableIds, facts, path, reasons) {
    const anchor = `${PREFIX}query:${request.id}`;
    if (!nodes.some(node => node.id === anchor)) nodes.push({id: anchor, role: 'obligation-query', evidenceRefs: [request.requirementRef]});
    const witnessNodes = new Set(availableIds.filter(id => events.has(id)));
    for (const edge of path ?? []) { witnessNodes.add(edge.from); witnessNodes.add(edge.to); }
    const positive = [...new Set([request.requirementRef, ...facts, ...(path ?? []).map(edge => edge.evidenceRef)].filter(Boolean))];
    const unknownRefs = [];
    if (status === 'unknown') {
      const unknownId = `${PREFIX}unknown:${id}`;
      evidence.push({id: unknownId, kind: 'observation-boundary', reasons,
        implication: 'Missing information is not evidence of a race, missing synchronization, or a wrong value.'});
      unknownRefs.push(unknownId);
    }
    obligations.push({id, kind, ruleId: `bounded-protocol-v1/${kind}`, status,
      subjectIds: [anchor, ...availableIds.filter(id => events.has(id))].filter((id, index, all) => all.indexOf(id) === index),
      witnessNodeIds: [...witnessNodes], witnessEdgeIds: (path ?? []).map(edge => edge.id),
      positiveWitnessRefs: positive, unknownRefs,
      derivation: {sourceRequestId: request.id, scope: capture.scopeId, reasons,
        inferredFromMissingHB: false, usesFileOrder: false}});
  }
  for (const request of capture.obligations) {
    if (request.kind === 'value-generation') {
      const consumer = events.get(request.consumerId);
      const status = consumer ? compareTokens(request.expected, consumer.token) : 'unknown';
      const reasons = !consumer ? ['consumer-record-missing'] : status === 'unknown' ? ['expected-or-observed-identity-unknown'] :
        [status === 'satisfied' ? 'explicit-generation-identities-equal' : 'explicit-generation-identities-differ'];
      emit(request, request.id, request.kind, status, [request.consumerId],
        [consumer?.recordRef, request.expected.evidenceRef, consumer?.token.evidenceRef], [], reasons);
      continue;
    }
    const before = events.get(request.beforeId), after = events.get(request.afterId);
    const actual = before?.token ?? {status: 'unknown', reason: 'completion-record-missing'};
    const tokenStatus = compareTokens(request.requiredToken, actual);
    const recordFacts = [before?.recordRef, after?.recordRef, request.requiredToken.evidenceRef, actual.evidenceRef];
    emit(request, `${request.id}:token`, 'completion-token-generation', tokenStatus, [request.beforeId], recordFacts, [],
      [tokenStatus === 'unknown' ? 'completion-token-or-required-identity-unknown' :
        tokenStatus === 'satisfied' ? 'explicit-completion-token-matches' : 'explicit-completion-token-mismatch']);
    let status = 'unknown', path = [], reasons;
    if (!before || !after) reasons = ['ordering-endpoint-record-missing'];
    else if (tokenStatus !== 'satisfied') reasons = ['required-completion-generation-not-established'];
    else {
      const forward = findPath(before.id, after.id, outgoing);
      const reverse = findPath(after.id, before.id, outgoing);
      if (forward) { status = 'satisfied'; path = forward; reasons = ['explicit-forward-HB-path']; }
      else if (reverse) { status = 'violated'; path = reverse; reasons = ['explicit-reverse-HB-path']; }
      else reasons = ['neither-order-proved-by-observed-HB'];
    }
    emit(request, request.id, request.kind, status, [request.beforeId, request.afterId], recordFacts, path, reasons);
  }
  return validateEvidenceRun({id: capture.id, provenance: {...structuredClone(capture.provenance),
      derivation: 'bounded-protocol-v1; conclusions derived from explicit observations, not supplied labels'},
    identity: structuredClone(capture.identity), capabilities: {logicalMapping: 'partial', accesses: 'partial', sync: 'partial'},
    nodes, edges, evidence, obligations,
    protocolMetadata: {scopeId: capture.scopeId, validatedInputDAG: true,
      semantics: 'three-valued statements over a finite attested HB partial order and explicit generation identities',
      isaCoverage: 'none claimed; no PTX memory-model, visibility, lane-mask, or cross-warp inference',
      completionDomains: 'Explicit input identities; a partial read-completion facet does not establish producer-result readiness. No domain is inferred from an opcode.',
      attestationTrust: 'Record identity/consistency is checked structurally; the authenticity and semantic correctness of caller attestations are not independently established.',
      valueSource: 'consumer.token is the sole observed value identity; request.observed is a validated compatibility mirror',
      resourceGenerationEncoding: 'unbounded nonnegative decimal strings; parity alone is insufficient'}});
}
