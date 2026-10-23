/** Synthetic finite-model fixtures and an independent permutation oracle.
 * No import of the production checker, graph reachability, or slicer.
 */

function known(resourceId = 'tile', generation = '4', evidenceRef = 'observed-token', domain = 'value') {
  return {status: 'known', scopeId: 'capture-0', resourceId, generation, evidenceRef, domain};
}
function unknown(reason = 'not-captured') { return {status: 'unknown', reason}; }

// Fixture authoring helper: make every token fact atomic and attach actual value
// observations to their consumer. It assigns observations, never oracle verdicts.
function bindFixtureTokenFacts(capture) {
  for (const request of capture.obligations) if (request.kind === 'value-generation') {
    const consumer = capture.events.find(event => event.id === request.consumerId);
    if (consumer) consumer.token = structuredClone(request.observed);
  }
  const setFact = (token, id, kind) => {
    if (token.status !== 'known') return;
    token.evidenceRef = id;
    const fact = {id, kind, scopeId: token.scopeId, resourceId: token.resourceId, generation: token.generation, domain: token.domain,
      provenance: 'experiment-authored synthetic token fact'};
    capture.facts = capture.facts.filter(item => item.id !== id); capture.facts.push(fact);
  };
  for (const event of capture.events) setFact(event.token, `${event.id}-token`, 'synthetic-token-observation');
  for (const request of capture.obligations) {
    if (request.kind === 'value-generation') {
      setFact(request.expected, `${request.id}-expected-token`, 'synthetic-token-expectation');
      const consumer = capture.events.find(event => event.id === request.consumerId);
      if (consumer) request.observed = structuredClone(consumer.token);
      else setFact(request.observed, `${request.id}-unbound-observed-token`, 'synthetic-token-observation');
    } else setFact(request.requiredToken, `${request.id}-required-token`, 'synthetic-token-expectation');
  }
  return capture;
}

export function baseProtocolCapture(id = 'fixture') {
  const facts = ['requirement', 'expected-token', 'observed-token', 'complete-record', 'read-record',
    'readerDone-record', 'reuse-record', 'marker-record', 'hb0', 'hb1', 'hb2'].map(id => ({id,
      kind: id === 'requirement' || id === 'expected-token' ? 'synthetic-specification' : 'synthetic-explicit-record',
      provenance: 'experiment-authored finite model; no GPU measurement'}));
  return bindFixtureTokenFacts({id, scopeId: 'capture-0', provenance: {kind: 'synthetic-model', generator: 'protocol-corpus-v1'},
    identity: {specId: 'bounded-generation-order', specHash: 'finite-protocol-v1', inputId: id, semanticsId: 'attested-HB-linear-extensions-v1'},
    facts, resources: [{id: 'tile', scopeId: 'capture-0'}, {id: 'other-tile', scopeId: 'capture-0'}],
    events: [['complete', 'producer-completion'], ['read', 'consumer'], ['readerDone', 'reader-completion'], ['reuse', 'reuse'], ['marker', 'marker']]
      .map(([id, role]) => ({id, scopeId: 'capture-0', role, recordRef: `${id}-record`, token:
        role === 'producer-completion' ? known('tile', '4', 'observed-token', 'producer_result_ready') :
        role === 'reader-completion' ? known('tile', '4', 'observed-token', 'reader_done') : unknown('event-is-not-a-completion-record')})),
    hb: [], obligations: []});
}
function edge(from, to, n = 0) { return {id: `e${n}`, from, to, verified: true, evidenceRef: `hb${n}`}; }
function valueRequest(expected = known('tile', '4', 'expected-token'), observed = known()) {
  return {id: 'value', kind: 'value-generation', consumerId: 'read', requirementRef: 'requirement', expected, observed};
}
function orderRequest(kind = 'completion-before-consume') {
  return {id: 'ordering', kind, beforeId: kind === 'completion-before-consume' ? 'complete' : 'readerDone',
    afterId: kind === 'completion-before-consume' ? 'read' : 'reuse', requirementRef: 'requirement',
    requiredToken: known('tile', '4', 'expected-token', kind === 'completion-before-consume' ? 'producer_result_ready' : 'reader_done')};
}

export function protocolCorpus() {
  const result = [];
  const add = (id, description, edit, split = 'handwritten-development') => {
    const capture = baseProtocolCapture(id); edit(capture); bindFixtureTokenFacts(capture);
    result.push({id, description, split, capture});
  };
  add('value-equal', 'Explicit expected and observed generations agree.', c => c.obligations.push(valueRequest()));
  add('value-wrong-generation', 'Known stale generation differs.', c => c.obligations.push(valueRequest(known('tile', '4', 'expected-token'), known('tile', '3'))));
  add('value-same-parity-wrong-generation', 'Same parity does not establish generation identity: 4 versus 2.', c => c.obligations.push(valueRequest(known('tile', '4', 'expected-token'), known('tile', '2'))));
  add('value-huge-generation-equal', 'Generation strings exceed JS safe integer precision.', c => c.obligations.push(valueRequest(known('tile', '90071992547409931234567890', 'expected-token'), known('tile', '90071992547409931234567890'))));
  add('value-wrong-resource', 'Known different resource identity cannot satisfy value provenance.', c => c.obligations.push(valueRequest(known('tile', '4', 'expected-token'), known('other-tile', '4'))));
  add('value-unknown-expected', 'Expected identity not established.', c => c.obligations.push(valueRequest(unknown('no-expected-identity'))));
  add('value-unknown-observed', 'Observed generation not captured.', c => c.obligations.push(valueRequest(known('tile', '4', 'expected-token'), unknown())));
  add('value-missing-consumer', 'Separate value facts cannot invent a consumer record.', c => { c.obligations.push(valueRequest()); c.events = c.events.filter(e => e.id !== 'read'); });
  add('missing-id-matches-object-prototype-name', 'An absent event named toString is still absent.', c => { const request = valueRequest(); request.consumerId = 'toString'; c.obligations.push(request); });
  add('completion-forward', 'Explicit producer completion precedes consumer.', c => { c.obligations.push(orderRequest()); c.hb.push(edge('complete', 'read')); });
  add('completion-transitive', 'Positive multi-edge path, with intermediate marker.', c => { c.obligations.push(orderRequest()); c.hb.push(edge('complete', 'marker'), edge('marker', 'read', 1)); });
  add('completion-reverse', 'Explicit consumer-before-completion proves violated order.', c => { c.obligations.push(orderRequest()); c.hb.push(edge('read', 'complete')); });
  add('completion-unordered-overlap', 'Overlap with no proven relative order admits both extensions.', c => c.obligations.push(orderRequest()));
  add('completion-missing-record', 'Absent producer completion is unknown.', c => { c.obligations.push(orderRequest()); c.events = c.events.filter(e => e.id !== 'complete'); });
  add('completion-missing-consumer', 'Absent consumer prevents ordering decision.', c => { c.obligations.push(orderRequest()); c.events = c.events.filter(e => e.id !== 'read'); });
  add('completion-unknown-token', 'Known path cannot establish unknown completion generation.', c => { c.obligations.push(orderRequest()); c.events[0].token = unknown(); c.hb.push(edge('complete', 'read')); });
  add('completion-same-parity-old-token', 'Old completion generation 2 cannot satisfy generation 4, even with HB.', c => { c.obligations.push(orderRequest()); c.events[0].token.generation = '2'; c.hb.push(edge('complete', 'read')); });
  add('completion-wrong-facet-same-generation', 'A-side shared-memory read completion is not full MMA-result readiness.', c => { c.obligations.push(orderRequest()); c.events[0].token.domain = 'smem_read_complete'; c.hb.push(edge('complete', 'read')); });
  add('completion-unrelated-HB', 'An unrelated explicit edge does not decide this pair.', c => { c.obligations.push(orderRequest()); c.hb.push(edge('marker', 'reuse')); });
  add('reuse-after-reader', 'Storage reused after explicit reader completion.', c => { c.obligations.push(orderRequest('reader-before-reuse')); c.hb.push(edge('readerDone', 'reuse')); });
  add('reuse-before-reader', 'Explicit early reuse is an ordering violation.', c => { c.obligations.push(orderRequest('reader-before-reuse')); c.hb.push(edge('reuse', 'readerDone')); });
  add('reuse-unordered', 'Reader/reuse relative order not observed.', c => c.obligations.push(orderRequest('reader-before-reuse')));
  add('reuse-missing-reader', 'Missing reader completion cannot prove early reuse.', c => { c.obligations.push(orderRequest('reader-before-reuse')); c.events = c.events.filter(e => e.id !== 'readerDone'); });
  add('reuse-wrong-generation', 'Reader completed an older same-parity generation.', c => { c.obligations.push(orderRequest('reader-before-reuse')); c.events.find(e => e.id === 'readerDone').token.generation = '2'; c.hb.push(edge('readerDone', 'reuse')); });
  add('legal-independent-overlap', 'Unrelated operations can overlap while required producer/consumer order holds.', c => { c.obligations.push(orderRequest()); c.hb.push(edge('complete', 'read'), edge('readerDone', 'reuse', 1)); });
  add('several-obligations-one-capture', 'Value and ordering constraints can disagree without collapsing verdicts.', c => { c.obligations.push(valueRequest(known('tile', '4', 'expected-token'), known('tile', '2')), orderRequest()); c.hb.push(edge('complete', 'read')); });
  let state = 20261023;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  for (let i = 0; i < 48; i++) {
    add(`seeded-${String(i).padStart(2, '0')}`, 'Fixed-seed event storage-order, generation and explicit partial-order variation.', c => {
      const reuse = i % 2 === 1;
      const request = orderRequest(reuse ? 'reader-before-reuse' : 'completion-before-consume');
      const generation = (9007199254740993000n + BigInt(i * 2)).toString();
      request.requiredToken.generation = generation;
      c.events.find(e => e.id === request.beforeId).token.generation = generation;
      c.obligations.push(request);
      const relation = i % 6;
      if (relation === 0) c.hb.push(edge(request.beforeId, request.afterId));
      if (relation === 1) c.hb.push(edge(request.afterId, request.beforeId));
      if (relation === 2) c.hb.push(edge(request.beforeId, 'marker'), edge('marker', request.afterId, 1));
      if (relation === 3) c.hb.push(edge('marker', request.afterId));
      if (relation === 4) c.events.find(e => e.id === request.beforeId).token.generation = (BigInt(generation) - 2n).toString();
      if (relation === 5) c.events.find(e => e.id === request.beforeId).token = unknown('randomized-record-omission-of-token');
      for (let j = c.events.length - 1; j > 0; j--) { const k = Math.floor(random() * (j + 1)); [c.events[j], c.events[k]] = [c.events[k], c.events[j]]; }
    }, 'fixed-seed-structural-variants');
  }
  return result;
}

/** Exhaustive permutations, filtered by explicit HB; no path/reachability code. */
export function enumerateProtocolOracle(capture) {
  if (capture.events.length > 8) throw new Error('Oracle bounded to eight observed events.');
  const byId = Object.assign(Object.create(null), Object.fromEntries(capture.events.map(event => [event.id, event])));
  if (Object.keys(byId).length !== capture.events.length) throw new Error('Oracle duplicate event IDs.');
  if (capture.events.some(event => event.scopeId !== capture.scopeId) || capture.resources.some(resource => resource.scopeId !== capture.scopeId)) throw new Error('Oracle mixed scopes.');
  if (capture.hb.some(edge => !byId[edge.from] || !byId[edge.to] || edge.verified !== true)) throw new Error('Oracle invalid attested edge.');
  const orders = [];
  function permute(prefix, remaining) {
    if (!remaining.length) {
      const positions = Object.fromEntries(prefix.map((id, index) => [id, index]));
      if (capture.hb.every(edge => positions[edge.from] < positions[edge.to])) orders.push(positions);
      return;
    }
    for (let i = 0; i < remaining.length; i++) permute([...prefix, remaining[i]], [...remaining.slice(0, i), ...remaining.slice(i + 1)]);
  }
  permute([], capture.events.map(event => event.id));
  if (!orders.length) throw new Error('Oracle no legal linear extensions (cyclic graph).');
  function tokenTruth(expected, observed) {
    if (!expected || !observed || expected.status !== 'known' || observed.status !== 'known') return null;
    return expected.scopeId === observed.scopeId && expected.resourceId === observed.resourceId && expected.generation === observed.generation && expected.domain === observed.domain;
  }
  const verdict = (id, truths, reason) => ({id, status: truths === null ? 'unknown' : truths.every(Boolean) ? 'satisfied' : truths.some(Boolean) ? 'unknown' : 'violated',
    legalLinearExtensions: orders.length, satisfyingLinearExtensions: truths === null ? null : truths.filter(Boolean).length,
    informationMissing: truths === null, reason});
  const results = [];
  for (const request of capture.obligations) {
    if (request.kind === 'value-generation') {
      const truth = byId[request.consumerId] ? tokenTruth(request.expected, byId[request.consumerId].token) : null;
      results.push(verdict(request.id, truth === null ? null : orders.map(() => truth), 'explicit-value-identity'));
    } else {
      const before = byId[request.beforeId], after = byId[request.afterId];
      const token = tokenTruth(request.requiredToken, before?.token);
      results.push(verdict(`${request.id}:token`, token === null ? null : orders.map(() => token), 'explicit-completion-identity'));
      results.push(verdict(request.id, !before || !after || token !== true ? null : orders.map(order => order[request.beforeId] < order[request.afterId]), 'all-observed-HB-consistent-total-orders'));
    }
  }
  return {oracle: 'independent-exhaustive-permutation-v1', eventCount: capture.events.length,
    legalLinearExtensions: orders.length, results,
    scope: 'finite observed-event order completions; unknown identities/records are not invented; not full PTX behavior'};
}

export function invalidProtocolCaptures() {
  const cycle = baseProtocolCapture('reject-cycle'); cycle.hb.push(edge('complete', 'read'), edge('read', 'complete', 1));
  const mixed = baseProtocolCapture('reject-mixed-scope'); mixed.events[0].scopeId = 'another-capture';
  const duplicate = baseProtocolCapture('reject-shadowed-resource'); duplicate.resources.push({id: 'tile', scopeId: 'another-capture'});
  const parity = baseProtocolCapture('reject-parity-only'); parity.events[0].token = {status: 'known', scopeId: 'capture-0', resourceId: 'tile', parity: 0, evidenceRef: 'observed-token'};
  const unverified = baseProtocolCapture('reject-unverified-HB'); unverified.hb.push({...edge('complete', 'read'), verified: false});
  const contradictory = baseProtocolCapture('reject-contradictory-token-fact'); contradictory.events.find(e => e.id === 'readerDone').token.evidenceRef = contradictory.events[0].token.evidenceRef;
  const upgraded = baseProtocolCapture('reject-unbound-known-value'); upgraded.obligations.push(valueRequest());
  return [cycle, mixed, duplicate, parity, unverified, contradictory, upgraded].map(capture => ({id: capture.id, capture}));
}
