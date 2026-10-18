import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAB_INFO, SCENARIOS, RESOURCE_OPTIONS, createLabSession, selectScenario,
  changeResource, setPrediction, runExperiment, recordExplanation,
  resetScenario, setPresentation, exportLabSession, getResourceBudget,
} from '../lib/exploration-lab.js';

const create = options => createLabSession({sessionId: 'test-session', clock: () => 1000, ...options});
const latest = session => session.runs.find(run => run.id === session.lastRunId);
const candidate = (scenarioId, resource, value, condition = 'objects') =>
  latest(runExperiment(changeResource(create({scenarioId, condition}), resource, value)));

// These are causal properties of the teaching model, not hardware benchmarks.
test('scenes exhibit distinct resource sensitivities without hiding their teaching assumptions', () => {
  assert.equal(SCENARIOS.length, 3);
  const compute = create({scenarioId: 'compute'});
  const memory = create({scenarioId: 'bandwidth'});
  assert.equal(compute.baselineResult.bottleneck, 'compute');
  assert.equal(memory.baselineResult.bottleneck, 'bandwidth');
  const moreCompute = candidate('compute', 'alu', 15);
  const moreMemory = candidate('bandwidth', 'dram', 3);
  const memoryMoreCompute = candidate('bandwidth', 'alu', 63);
  assert.ok(moreCompute.speedup > 2);
  assert.ok(moreMemory.speedup > 2);
  assert.ok(memoryMoreCompute.speedup < 1.1);
  assert.equal(moreMemory.result.computeCycles, memory.baselineResult.computeCycles);
  const reused = candidate('reuse', 'l1', 2);
  const stream = candidate('bandwidth', 'l1', 2);
  assert.ok(reused.result.hitRate > stream.result.hitRate);
  assert.ok(reused.result.features.externalBytes < reused.baselineResult.features.externalBytes);
  assert.ok(reused.speedup > stream.speedup);
  assert.match(LAB_INFO.model.id, /analytical/);
  assert.ok(LAB_INFO.limitations.some(text => text.includes('标定')));
});

test('presentation condition has no effect on numeric mechanics for every feasible configuration', () => {
  let checked = 0;
  for (const scenario of SCENARIOS) {
    for (const alu of RESOURCE_OPTIONS.alu) for (const dram of RESOURCE_OPTIONS.dram) for (const l1 of RESOURCE_OPTIONS.l1) {
      if (alu.cost + dram.cost + l1.cost > scenario.budget.limit) continue;
      const runs = ['objects', 'abstract'].map(condition => {
        let session = create({scenarioId: scenario.id, condition});
        for (const resource of Object.keys(RESOURCE_OPTIONS)) session = changeResource(session, resource, RESOURCE_OPTIONS[resource][0].value);
        for (const [resource, option] of Object.entries({alu, dram, l1})) session = changeResource(session, resource, option.value);
        return latest(runExperiment(session));
      });
      assert.deepEqual(runs[0].result, runs[1].result);
      assert.deepEqual(runs[0].baselineResult, runs[1].baselineResult);
      assert.deepEqual(runs[0].budget, runs[1].budget);
      assert.equal(runs[0].speedup, runs[1].speedup);
      checked++;
    }
  }
  assert.ok(checked > 100);
});

test('candidate results are exposed only on explicit runs and invalidated by later edits', () => {
  let session = create();
  assert.equal(session.currentRunId, null);
  assert.equal(session.runs.length, 0);
  session = changeResource(session, 'alu', 7);
  assert.equal(session.runs.length, 0);
  session = runExperiment(session);
  const first = latest(session);
  assert.equal(session.resultIsCurrent, true);
  session = changeResource(session, 'alu', 15);
  assert.equal(session.resultIsCurrent, false);
  assert.equal(session.currentRunId, null);
  assert.equal(session.lastRunId, first.id);
  assert.deepEqual(latest(session), first);
  session = runExperiment(session);
  assert.notEqual(session.currentRunId, first.id);
  assert.equal(latest(session).configuration.alu, 15);
  assert.equal(first.configuration.alu, 7);
});

test('runs report exact baseline changes and distinguish multi-factor comparisons', () => {
  let session = runExperiment(create());
  assert.equal(latest(session).comparisonKind, 'unchanged');
  assert.deepEqual(latest(session).changes, []);
  session = runExperiment(changeResource(session, 'alu', 7));
  assert.equal(latest(session).comparisonKind, 'single-factor');
  assert.deepEqual(latest(session).changes, [{resource: 'alu', baseline: 3, candidate: 7}]);
  session = runExperiment(changeResource(session, 'l1', 1));
  assert.equal(latest(session).comparisonKind, 'multi-factor');
  assert.deepEqual(latest(session).changes.map(change => change.resource), ['alu', 'l1']);
  assert.deepEqual(latest(session).baselineConfiguration, SCENARIOS[0].baseline);
});

test('prediction snapshots and explanation revisions remain tied to their original run', () => {
  let session = changeResource(create(), 'alu', 7);
  session = setPrediction(session, {direction: 'faster', bottleneck: 'compute', confidence: 75, reason: '我预计计算时间下降'});
  session = runExperiment(session);
  const firstId = session.currentRunId;
  assert.equal(latest(session).prediction.resultAlreadyVisible, false);
  session = recordExplanation(session, '第一次解释');
  session = recordExplanation(session, '修订解释');
  assert.equal(latest(session).explanations.length, 2);
  session = changeResource(session, 'dram', 1);
  assert.equal(session.prediction, null);
  session = runExperiment(session);
  assert.equal(latest(session).predictionStatus, 'unanswered');
  assert.equal(latest(session).prediction, null);
  const original = session.runs.find(run => run.id === firstId);
  assert.equal(original.prediction.reason, '我预计计算时间下降');
  assert.equal(original.explanation, '修订解释');
  assert.equal(original.explanations[0].text, '第一次解释');
  assert.equal(session.events.filter(event => event.type === 'explanation_recorded').length, 2);
});

test('predictions after visible evidence and explicit skipping are distinguishable from no response', () => {
  let session = runExperiment(create());
  session = setPrediction(session, {direction: 'same'});
  session = runExperiment(session);
  assert.equal(latest(session).prediction.resultAlreadyVisible, true);
  assert.equal(latest(session).prediction.reference, 'scene-baseline');
  session = setPrediction(session, null);
  session = runExperiment(session);
  assert.equal(latest(session).predictionStatus, 'skipped');
  assert.equal(latest(session).prediction, null);
  assert.ok(session.events.some(event => event.type === 'prediction_skipped'));
});

test('reset and scene selection preserve all evidence but restore a fixed scene baseline', () => {
  let session = runExperiment(changeResource(create(), 'alu', 15));
  session = recordExplanation(session, '等待没有消失');
  const original = latest(session);
  const eventCount = session.events.length;
  session = resetScenario(session);
  assert.deepEqual(session.configuration, SCENARIOS[0].baseline);
  assert.equal(session.events.length, eventCount + 1);
  assert.deepEqual(latest(session), original);
  assert.equal(session.resultIsCurrent, false);
  session = selectScenario(session, 'bandwidth');
  assert.deepEqual(session.configuration, SCENARIOS[1].baseline);
  assert.equal(session.baselineResult.kind, 'stream');
  assert.deepEqual(session.runs[0], original);
  session = selectScenario(session, 'compute');
  assert.deepEqual(session.configuration, SCENARIOS[0].baseline);
  assert.equal(session.runs.length, 1);
});

test('elapsed action times stay finite and monotonic when an injected clock regresses', () => {
  const values = [1000, 1010, 1005, 1300, 1301];
  let session = create({clock: () => values.shift()});
  session = changeResource(session, 'alu', 7);
  session = setPrediction(session, {direction: 'faster'});
  session = runExperiment(session);
  session = recordExplanation(session, '观察记录');
  assert.deepEqual(session.events.map(event => event.elapsedMs), [0, 10, 10, 300, 301]);
  assert.equal(latest(session).elapsedMs, 300);
  assert.notEqual(latest(session).result.cycles, latest(session).elapsedMs);
  for (let index = 0; index < session.events.length; index++) {
    assert.equal(session.events[index].sequence, index + 1);
    assert.ok(Number.isFinite(session.events[index].elapsedMs));
  }
});

test('explicit condition is locked while free view switching remains visibly unassigned', () => {
  const locked = create({mode: 'url_condition', condition: 'abstract'});
  assert.throws(() => setPresentation(locked, 'objects'), /locked/);
  assert.equal(locked.assignment.randomized, false);
  let free = create();
  free = setPresentation(free, 'abstract');
  assert.equal(free.condition, 'objects');
  assert.equal(free.presentation, 'abstract');
  assert.equal(free.presentationSwitched, true);
  assert.equal(free.contaminated, true);
  free = setPresentation(free, 'objects');
  assert.equal(free.contaminated, true);
  assert.equal(exportLabSession(free).exportInfo.controlledAssignment, false);
  assert.equal(exportLabSession(locked).exportInfo.randomized, false);
});

test('complete JSON export is detached, versioned and not truncated after many actions', () => {
  let session = create();
  for (let index = 0; index < 1200; index++) session = changeResource(session, 'l1', index % 3);
  session = runExperiment(session);
  const exported = exportLabSession(session);
  assert.equal(exported.events.length, 1202);
  assert.equal(exported.events[0].type, 'session_started');
  assert.equal(exported.schemaVersion, LAB_INFO.schemaVersion);
  assert.equal(exported.exportInfo.modelId, latest(session).modelId);
  assert.equal(exported.exportInfo.modelVersion, latest(session).modelVersion);
  assert.equal(exported.exportInfo.scenarioVersion, SCENARIOS[0].version);
  assert.equal(exported.exportInfo.buildId, LAB_INFO.buildId);
  assert.doesNotThrow(() => JSON.stringify(exported));
  exported.events[0].payload.configuration.alu = 999;
  assert.equal(session.events[0].payload.configuration.alu, 3);
  assert.equal(Object.hasOwn(exported, 'clock'), false);
});

test('actions do not mutate prior sessions or the shared scenario catalogue', () => {
  const previous = create();
  const next = changeResource(previous, 'alu', 15);
  assert.equal(previous.configuration.alu, 3);
  assert.equal(next.configuration.alu, 15);
  assert.equal(previous.events.length, 1);
  assert.equal(next.events.length, 2);
  assert.throws(() => { next.configuration.alu = 100; }, TypeError);
  assert.throws(() => { SCENARIOS[0].baseline.alu = 100; }, TypeError);
});

test('bounded public inputs reject unsupported levels, conditions, text and predictions', () => {
  const session = create();
  for (const condition of ['other', {}, null]) assert.throws(() => create({condition}));
  assert.throws(() => create({scenarioId: 'other'}));
  assert.throws(() => create({mode: 'randomized'}));
  assert.throws(() => create({sessionId: '<script>'}));
  assert.throws(() => create({clock: () => NaN}));
  assert.throws(() => changeResource(session, '__proto__', 1));
  for (const value of [-1, 1.5, 100, NaN, Infinity, '3']) assert.throws(() => changeResource(session, 'alu', value));
  assert.throws(() => selectScenario(session, 'not-found'));
  assert.throws(() => setPrediction(session, {direction: 'always wins'}));
  assert.throws(() => setPrediction(session, {direction: 'faster', confidence: 101}));
  assert.throws(() => setPrediction(session, {direction: 'faster', confidence: NaN}));
  assert.throws(() => setPrediction(session, {direction: 'faster', reason: 'x'.repeat(2001)}));
  assert.throws(() => setPrediction(session, {direction: 'faster', bottleneck: 'magic'}));
  assert.throws(() => setPrediction(session, {direction: 'faster', unknown: true}));
  assert.throws(() => recordExplanation(session, '没有运行'));
  assert.throws(() => exportLabSession(JSON.parse(JSON.stringify(session))));
  assert.equal(session.events.length, 1);
});


test('nonfinite or overflowing clock readings cannot corrupt existing telemetry', () => {
  let now = 0;
  const session = create({clock: () => now});
  now = Infinity;
  assert.throws(() => runExperiment(session), /finite/);
  assert.equal(session.events.length, 1);
  let huge = -1e308;
  const extreme = create({clock: () => huge});
  huge = 1e308;
  assert.throws(() => resetScenario(extreme), /finite/);
  assert.equal(extreme.events.length, 1);
});


test('revisiting a previous candidate does not make its prediction appear unseen', () => {
  let session = runExperiment(changeResource(create(), 'alu', 7));
  session = changeResource(session, 'alu', 15);
  session = changeResource(session, 'alu', 7);
  assert.equal(session.resultIsCurrent, false);
  session = setPrediction(session, {direction: 'faster'});
  assert.equal(session.prediction.resultAlreadyVisible, true);
  session = resetScenario(session);
  session = setPrediction(session, {direction: 'same'});
  assert.equal(session.prediction.resultAlreadyVisible, true);
});


test('trial budget forces reallocation and rejects unaffordable actions without changing history', () => {
  let session = create();
  assert.deepEqual(getResourceBudget(session), {limit: 6, used: 4, remaining: 2, costs: {alu: 1, dram: 3, l1: 0}});
  session = changeResource(session, 'alu', 15);
  assert.equal(getResourceBudget(session).remaining, 0);
  const before = JSON.stringify(session);
  assert.throws(() => changeResource(session, 'l1', 1), /budget/);
  assert.throws(() => changeResource(session, 'alu', 63), /budget/);
  assert.equal(JSON.stringify(session), before);
  session = changeResource(session, 'dram', 2);
  assert.equal(getResourceBudget(session).remaining, 2);
  session = changeResource(session, 'alu', 63);
  assert.equal(getResourceBudget(session).remaining, 0);
  session = runExperiment(session);
  assert.deepEqual(latest(session).budget, getResourceBudget(session));
  assert.equal(latest(session).baselineBudget.remaining, 2);
  assert.equal(latest(session).comparisonKind, 'multi-factor');
  session = resetScenario(session);
  assert.equal(getResourceBudget(session).remaining, 2);
  assert.deepEqual(session.budget, session.baselineBudget);
  assert.equal(session.runs.length, 1);
  session = selectScenario(session, 'reuse');
  assert.equal(getResourceBudget(session).limit, 7);
  assert.equal(getResourceBudget(session).remaining, 2);
  assert.ok(session.events.filter(event => event.type === 'resource_changed').every(event => event.payload.budget.remaining >= 0));
  const exported = exportLabSession(session);
  assert.equal(exported.exportInfo.budgetFormulaVersion, LAB_INFO.budget.version);
  assert.equal(exported.provenance.budget.id, SCENARIOS[0].budget.formulaId);
});


test('baseline evidence is unseen before any displayed scene run but exposed alongside a candidate result', () => {
  let session = setPrediction(create(), {direction: 'same'});
  assert.equal(session.prediction.resultAlreadyVisible, false);
  assert.equal(session.runs.length, 0);
  session = changeResource(session, 'alu', 7);
  session = runExperiment(session);
  session = resetScenario(session);
  session = setPrediction(session, {direction: 'same'});
  assert.equal(session.prediction.resultAlreadyVisible, true);
  session = selectScenario(session, 'bandwidth');
  session = setPrediction(session, {direction: 'same'});
  assert.equal(session.prediction.resultAlreadyVisible, false);
});
