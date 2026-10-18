/**
 * Small, browser-independent GPU exploration session engine.
 *
 * Every action returns a NEW frozen session: `session = runExperiment(session)`.
 * Session objects are JSON-safe; exportLabSession returns a detached JSON object.
 * The injected clock returns monotonic milliseconds; only elapsed user-action
 * time is exported, never simulation cycles disguised as elapsed time.
 * Only explicit actions create events; there is no persistence, networking or
 * participant identity collection.
 */
import {MODEL_INFO, getWorkloadPerformance} from './compute-model.js';

const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
};
export const LAB_INFO = freeze({
  id: 'gpu-exploration-lab', schemaVersion: 1, version: 2,
  buildId: 'gpu-exploration-prototype-2', scenarioVersion: 2,
  budget: {id: 'resource-option-index', version: 1, unit: 'teaching-only trial credit',
    formula: 'sum of zero-based resource option indices; scene limit = baseline cost + 2',
    extraCredits: 2, limitation: '额度只用于教学权衡，不代表真实价格、芯片面积或功耗。'},
  timeUnit: 'elapsed milliseconds; monotonic non-decreasing user event time',
  model: {...MODEL_INFO},
  limitations: ['解析教学参数，未经真实 GPU 测量标定。', '三项任务用于原型探索；尚未验证学习效果或测验效度。', '呈现条件可被指定，但本模块不进行随机分组。'],
});
export const RESOURCE_OPTIONS = freeze({
  alu: [0, 3, 7, 15, 31, 63].map((value, cost) => ({value, cost, label: `${value + 1} 个计算单元`})),
  dram: [1, 2, 3, 4].map((value, cost) => ({value, cost, label: `${value} 组 DRAM 通道`})),
  l1: [0, 1, 2, 3, 4].map((value, cost) => ({value, cost, label: value ? `${value * 32} KiB 片上缓存` : '无片上缓存'})),
});
export const SCENARIOS = freeze([
  {id: 'compute', version: 2, title: '夜班校验', workload: 'fp32',
    brief: '夜班团队送来一批数值校验任务。交付窗口即将关闭，你可以在研发台调整资源，再决定如何承接。',
    question: '哪一处调整值得投入？先留下判断，再用运行结果解释。',
    baseline: {alu: 3, dram: 4, l1: 0}},
  {id: 'bandwidth', version: 2, title: '沿海数据站', workload: 'stream',
    brief: '沿海站点不断传回新的数据批次。客户希望缩短每批处理时间，你需要检查现有设备的工作过程。',
    question: '设备忙在哪里？比较不同调整，再向客户说明依据。',
    baseline: {alu: 31, dram: 1, l1: 0}},
  {id: 'reuse', version: 2, title: '旧城影像修复', workload: 'conv',
    brief: '档案馆正在处理成批影像，相邻计算会用到部分相同数据。试产设备已经就绪，团队等待你的方案。',
    question: '怎样安排这些资源？观察数据去向和交付时间，再作解释。',
    baseline: {alu: 63, dram: 1, l1: 0}},
].map(scenario => {
  const baselineCost = Object.keys(RESOURCE_OPTIONS).reduce((sum, resource) => sum + RESOURCE_OPTIONS[resource].find(option => option.value === scenario.baseline[resource]).cost, 0);
  return {...scenario, budget: {limit: baselineCost + LAB_INFO.budget.extraCredits, baselineCost,
    formulaId: LAB_INFO.budget.id, formulaVersion: LAB_INFO.budget.version, extraCredits: LAB_INFO.budget.extraCredits}};
}));

const contexts = new WeakMap();
const CONDITIONS = ['objects', 'abstract'];
const MODES = ['free_exploration', 'url_condition'];
const DIRECTIONS = ['faster', 'same', 'slower', 'unsure'];
const BOTTLENECKS = ['compute', 'bandwidth', 'latency', 'unsure'];
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const defaultClock = () => globalThis.performance?.now?.() ?? Date.now();
const scenarioFor = id => {
  const scenario = SCENARIOS.find(item => item.id === id);
  if (!scenario) throw new RangeError('Unknown scenario');
  return scenario;
};
const budgetFor = (configuration, scenario) => {
  const costs = Object.fromEntries(Object.keys(RESOURCE_OPTIONS).map(resource =>
    [resource, RESOURCE_OPTIONS[resource].find(option => option.value === configuration[resource]).cost]));
  const used = Object.values(costs).reduce((sum, cost) => sum + cost, 0);
  return freeze({limit: scenario.budget.limit, used, remaining: scenario.budget.limit - used, costs});
};
const textInput = (value, name) => {
  if (typeof value !== 'string' || value.length > 2000) throw new TypeError(`${name} must be a string of at most 2000 characters`);
  return value.trim();
};
const enumInput = (value, choices, name) => {
  if (!choices.includes(value)) throw new RangeError(`Invalid ${name}`);
  return value;
};
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function contextFor(session) {
  const context = contexts.get(session);
  if (!context) throw new TypeError('Expected a session returned by this module');
  return context;
}
function nextTime(session) {
  const context = contextFor(session);
  const now = context.clock();
  if (!Number.isFinite(now)) throw new RangeError('Clock must return finite milliseconds');
  const elapsed = now - context.origin;
  if (!Number.isFinite(elapsed)) throw new RangeError('Elapsed time must remain finite');
  return Math.max(session.elapsedMs, 0, elapsed);
}
function transition(session, changes, type, payload, elapsedMs = nextTime(session)) {
  const next = freeze({...session, ...changes, elapsedMs, revision: session.revision + 1,
    events: [...session.events, freeze({sequence: session.events.length + 1, type, elapsedMs,
      scenarioId: changes.scenarioId ?? session.scenarioId,
      presentation: changes.presentation ?? session.presentation,
      configurationRevision: changes.configurationRevision ?? session.configurationRevision,
      payload})]});
  contexts.set(next, contextFor(session));
  return next;
}
function sessionIdentifier() {
  return globalThis.crypto?.randomUUID?.() ?? `lab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** condition is an initial label, never a claim of randomized assignment.
 * mode=url_condition locks presentation. Free switching is logged and marked
 * contaminated; such sessions must not be treated as controlled assignment.
 */
export function createLabSession({condition = 'objects', mode = 'free_exploration', scenarioId = 'compute', clock = defaultClock, sessionId = sessionIdentifier()} = {}) {
  enumInput(condition, CONDITIONS, 'condition');
  enumInput(mode, MODES, 'mode');
  const scenario = scenarioFor(scenarioId);
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new TypeError('Invalid local session identifier');
  const origin = clock();
  if (!Number.isFinite(origin)) throw new RangeError('Clock must return finite milliseconds');
  const configuration = {...scenario.baseline};
  const baselineBudget = budgetFor(configuration, scenario);
  const state = freeze({schemaVersion: LAB_INFO.schemaVersion, provenance: LAB_INFO,
    sessionId, condition, presentation: condition, mode,
    assignment: {method: mode === 'url_condition' ? 'explicit-url-condition' : 'free-exploration', randomized: false},
    presentationSwitched: false, contaminated: false,
    scenarioId, baselineConfiguration: {...scenario.baseline}, configuration, baselineBudget, budget: baselineBudget,
    baselineResult: getWorkloadPerformance(configuration, scenario.workload),
    configurationRevision: 0, revision: 0, elapsedMs: 0,
    prediction: null, predictionStatus: 'unanswered', currentRunId: null, lastRunId: null, resultIsCurrent: false,
    runs: [], events: [{sequence: 1, type: 'session_started', elapsedMs: 0, scenarioId, presentation: condition,
      configurationRevision: 0, payload: {condition, mode, configuration, budget: baselineBudget, baselineBudget, workload: scenario.workload, buildId: LAB_INFO.buildId}}],
  });
  contexts.set(state, {clock, origin});
  return state;
}

/** Clears the current view and draft prediction, preserving all past runs. */
export function selectScenario(session, scenarioId) {
  contextFor(session);
  const scenario = scenarioFor(scenarioId);
  const baselineBudget = budgetFor(scenario.baseline, scenario);
  return transition(session, {scenarioId, configuration: {...scenario.baseline}, baselineConfiguration: {...scenario.baseline}, baselineBudget, budget: baselineBudget,
    baselineResult: getWorkloadPerformance(scenario.baseline, scenario.workload),
    configurationRevision: session.configurationRevision + 1, prediction: null, predictionStatus: 'unanswered', currentRunId: null, resultIsCurrent: false},
  'scenario_selected', {previousScenarioId: session.scenarioId, configuration: scenario.baseline, budget: baselineBudget, baselineBudget, workload: scenario.workload});
}

/** Values are teaching-model levels (ALU count = value + 1), not UI indices. */
export function changeResource(session, resource, value) {
  contextFor(session);
  if (!own(RESOURCE_OPTIONS, resource) || !RESOURCE_OPTIONS[resource].some(option => option.value === value)) throw new RangeError('Invalid resource or level');
  const configuration = {...session.configuration, [resource]: value};
  const budget = budgetFor(configuration, scenarioFor(session.scenarioId));
  if (budget.remaining < 0) throw new RangeError('Resource allocation exceeds the trial budget');
  return transition(session, {configuration, budget,
    configurationRevision: session.configurationRevision + 1, prediction: null, predictionStatus: 'unanswered', currentRunId: null, resultIsCurrent: false},
  'resource_changed', {resource, before: session.configuration[resource], after: value, beforeBudget: getResourceBudget(session), baselineBudget: session.baselineBudget, budget});
}

/** null explicitly records skipping. Predictions always compare to the scene baseline. */
export function setPrediction(session, prediction) {
  contextFor(session);
  if (prediction === null) return transition(session, {prediction: null, predictionStatus: 'skipped'}, 'prediction_skipped', {});
  if (!plainObject(prediction) || Object.keys(prediction).some(key => !['direction', 'reason', 'bottleneck', 'confidence'].includes(key))) throw new TypeError('Invalid prediction object');
  const sameConfiguration = configuration => Object.keys(RESOURCE_OPTIONS).every(resource => configuration[resource] === session.configuration[resource]);
  const sceneRuns = session.runs.filter(run => run.scenarioId === session.scenarioId);
  // This records prior UI evidence exposure, not model data held internally.
  // Every displayed run includes the scene baseline; an unopened scene does not.
  const evidenceSeen = sceneRuns.some(run => sameConfiguration(run.configuration))
    || (sceneRuns.length > 0 && sameConfiguration(session.baselineConfiguration));
  const next = {direction: enumInput(prediction.direction, DIRECTIONS, 'prediction direction'),
    reference: 'scene-baseline', resultAlreadyVisible: evidenceSeen};
  if (own(prediction, 'reason')) next.reason = textInput(prediction.reason, 'Prediction reason');
  if (own(prediction, 'bottleneck')) next.bottleneck = enumInput(prediction.bottleneck, BOTTLENECKS, 'bottleneck');
  if (own(prediction, 'confidence')) {
    if (typeof prediction.confidence !== 'number' || !Number.isFinite(prediction.confidence) || prediction.confidence < 0 || prediction.confidence > 100) throw new RangeError('Confidence must be between 0 and 100');
    next.confidence = prediction.confidence;
  }
  return transition(session, {prediction: next, predictionStatus: 'answered'}, 'prediction_recorded', {prediction: next});
}

/** Only this action computes/exposes the adjusted configuration result. */
export function runExperiment(session) {
  contextFor(session);
  const scenario = scenarioFor(session.scenarioId);
  const result = getWorkloadPerformance(session.configuration, scenario.workload);
  const elapsedMs = nextTime(session);
  const changes = Object.keys(RESOURCE_OPTIONS).filter(resource => session.baselineConfiguration[resource] !== session.configuration[resource])
    .map(resource => ({resource, baseline: session.baselineConfiguration[resource], candidate: session.configuration[resource]}));
  const run = freeze({id: `${session.sessionId}-run-${session.runs.length + 1}`, scenarioId: scenario.id,
    scenarioVersion: scenario.version, workload: scenario.workload,
    presentation: session.presentation, configuration: {...session.configuration}, baselineConfiguration: {...session.baselineConfiguration},
    baselineBudget: session.baselineBudget, budget: getResourceBudget(session),
    changes, comparisonKind: changes.length === 0 ? 'unchanged' : changes.length === 1 ? 'single-factor' : 'multi-factor',
    configurationRevision: session.configurationRevision, elapsedMs,
    result, baselineResult: session.baselineResult,
    speedup: session.baselineResult.cycles / result.cycles,
    prediction: session.prediction, predictionStatus: session.predictionStatus,
    explanation: '', explanations: [], modelId: result.modelId, modelVersion: result.modelVersion});
  return transition(session, {runs: [...session.runs, run], currentRunId: run.id, lastRunId: run.id, resultIsCurrent: true,
    prediction: null, predictionStatus: 'unanswered'}, 'experiment_run', {run}, elapsedMs);
}

/** Explanations attach to a particular run; all previous revisions stay in events. */
export function recordExplanation(session, explanation, runId = session.currentRunId) {
  contextFor(session);
  const text = textInput(explanation, 'Explanation');
  const index = session.runs.findIndex(run => run.id === runId);
  if (index < 0) throw new RangeError('Explanation requires an existing run');
  const elapsedMs = nextTime(session);
  const previous = session.runs[index];
  const updated = freeze({...previous, explanation: text,
    explanations: [...previous.explanations, {text, elapsedMs}]});
  const runs = [...session.runs];
  runs[index] = updated;
  return transition(session, {runs}, 'explanation_recorded', {runId, explanation: text}, elapsedMs);
}

/** Restores this scene's baseline without deleting any experimental evidence. */
export function resetScenario(session) {
  contextFor(session);
  return transition(session, {configuration: {...session.baselineConfiguration}, budget: session.baselineBudget,
    configurationRevision: session.configurationRevision + 1,
    prediction: null, predictionStatus: 'unanswered', currentRunId: null, resultIsCurrent: false},
  'scenario_reset', {before: session.configuration, after: session.baselineConfiguration, beforeBudget: getResourceBudget(session), baselineBudget: session.baselineBudget, budget: session.baselineBudget});
}

/** Teaching-only allocation credits, unrelated to actual money, area or power. */
export function getResourceBudget(session) {
  contextFor(session);
  return budgetFor(session.configuration, scenarioFor(session.scenarioId));
}

export function setPresentation(session, presentation) {
  contextFor(session);
  enumInput(presentation, CONDITIONS, 'presentation');
  if (session.mode !== 'free_exploration') throw new RangeError('Assigned presentation is locked');
  const switched = presentation !== session.presentation;
  return transition(session, {presentation,
    presentationSwitched: session.presentationSwitched || switched,
    contaminated: session.contaminated || switched,
    // A prediction made using one representation cannot silently migrate.
    prediction: null, predictionStatus: 'unanswered', currentRunId: null, resultIsCurrent: false},
  'presentation_changed', {before: session.presentation, after: presentation, mode: session.mode});
}

/** Detached, complete, local-only data; caller decides whether to download it. */
export function exportLabSession(session) {
  contextFor(session);
  return JSON.parse(JSON.stringify({...session, exportInfo: {
    schemaVersion: LAB_INFO.schemaVersion, buildId: LAB_INFO.buildId,
    modelId: MODEL_INFO.id, modelVersion: MODEL_INFO.version,
    scenarioVersion: LAB_INFO.scenarioVersion, budgetFormulaId: LAB_INFO.budget.id, budgetFormulaVersion: LAB_INFO.budget.version, collection: 'explicit local actions only; no remote logging',
    randomized: false, controlledAssignment: false,
    analysisWarning: session.mode === 'free_exploration' ? 'Free exploration is not a controlled condition experiment.' : 'URL condition is explicitly assigned, not randomized.',
  }}));
}
