import {
  LAB_INFO, RESOURCE_OPTIONS, SCENARIOS, createLabSession, selectScenario,
  changeResource, setPrediction, runExperiment, recordExplanation,
  resetScenario, setPresentation, exportLabSession, getResourceBudget,
} from '../../../lib/exploration-lab.js';

const $ = id => document.getElementById(id);
const parameters = new URLSearchParams(location.search);
const requestedCondition = parameters.get('condition');
const lockedCondition = ['objects', 'abstract'].includes(requestedCondition);
const requestedScene = parameters.get('scene');
let session = createLabSession({
  condition: lockedCondition ? requestedCondition : 'objects',
  mode: lockedCondition ? 'url_condition' : 'free_exploration',
  scenarioId: SCENARIOS.some(scene => scene.id === requestedScene) ? requestedScene : SCENARIOS[0].id,
});
let inspectedRunId = null;
let busy = false;
let runningTimer;

const SCENE_DETAILS = {
  compute: {sender: '临港 · 夜班校验团队', tagline: '一批等着出发的结果'},
  bandwidth: {sender: '沿海 · 数据站值守员', tagline: '一批接着一批的新数据'},
  reuse: {sender: '旧城 · 数字档案馆', tagline: '在旧影像里找回细节'},
};
const resourceNames = {alu: 'ALU', dram: '显存通道', l1: 'L1 缓存'};
const bottleneckNames = {compute: '计算', bandwidth: '数据搬运', latency: '访问延迟'};
const directionNames = {faster: '更短', same: '相近', slower: '更长', unsure: '暂不确定'};
const number = value => Number(value).toLocaleString('zh-CN', {maximumFractionDigits: 2, minimumFractionDigits: 0});
const sceneFor = id => SCENARIOS.find(scene => scene.id === id);
const runNumber = run => session.runs.findIndex(item => item.id === run.id) + 1;
const compactResource = (resource, value) => resource === 'alu' ? `${value + 1} 个` : resource === 'dram' ? `${value} 组` : value ? `${value * 32} KiB` : '0 KiB';
const configurationText = configuration => `${configuration.alu + 1} ALU / ${configuration.dram} 组显存通道 / ${configuration.l1 * 32} KiB L1`;
const byteText = value => value >= 1024 ? `${number(value / 1024)} KiB` : `${number(value)} B`;
const sceneRuns = () => session.runs.filter(run => run.scenarioId === session.scenarioId);
const freshRun = () => session.runs.find(run => run.id === session.currentRunId);
const displayedRun = () => session.runs.find(run => run.id === inspectedRunId && run.scenarioId === session.scenarioId) ?? freshRun() ?? sceneRuns().at(-1);
const sameConfiguration = (first, second) => Object.keys(RESOURCE_OPTIONS).every(resource => first[resource] === second[resource]);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clearPredictionInputs() {
  for (const id of ['prediction-direction', 'prediction-bottleneck', 'prediction-confidence']) $(id).value = '';
  updateConfidenceAvailability();
}

function updateConfidenceAvailability() {
  const hasJudgment = Boolean($('prediction-direction').value || $('prediction-bottleneck').value);
  $('prediction-confidence').disabled = !hasJudgment;
  if (!hasJudgment) $('prediction-confidence').value = '';
}

function updateTabs() {
  const fragment = document.createDocumentFragment();
  SCENARIOS.forEach((scene, index) => {
    const button = element('button', 'scene-tab');
    button.type = 'button';
    button.dataset.scene = scene.id;
    button.setAttribute('aria-current', scene.id === session.scenarioId ? 'step' : 'false');
    button.append(element('span', 'scene-number', `0${index + 1}`));
    const title = element('span', 'scene-title');
    title.append(element('strong', '', scene.title), element('small', '', SCENE_DETAILS[scene.id].tagline));
    button.append(title);
    if (session.runs.some(run => run.scenarioId === scene.id)) button.append(element('span', 'tested-mark', '已试产 ↗'));
    fragment.append(button);
  });
  $('scene-tabs').replaceChildren(fragment);
}

function updateLetter() {
  const scene = sceneFor(session.scenarioId);
  const index = SCENARIOS.indexOf(scene);
  const features = session.baselineResult.features;
  $('letter-number').textContent = `0${index + 1}`;
  $('letter-sender').textContent = SCENE_DETAILS[scene.id].sender;
  $('letter-title').textContent = scene.title;
  $('letter-brief').textContent = scene.brief;
  $('letter-question').textContent = scene.question;
  const facts = [
    ['任务类型', {fp32: '数值校验 / FP32', stream: '流式归约', conv: '图像卷积'}[scene.workload]],
    ['每批运算', `${number(features.operations)} 次`],
    ['输入数据', byteText(features.bytes)],
    ['工作集', byteText(features.workingSetBytes)],
  ];
  $('task-facts').replaceChildren(...facts.map(([label, value]) => {
    const row = element('div');
    row.append(element('span', '', label), element('strong', '', value));
    return row;
  }));
}

function updateHardware() {
  $('hardware-board').dataset.presentation = session.presentation;
  $('presentation-note').textContent = lockedCondition ? `当前呈现 · ${session.presentation === 'objects' ? '对象工坊' : '抽象框图'}` : '自由探索 · 可切换呈现';
  $('presentation-switch').hidden = lockedCondition;
  for (const button of document.querySelectorAll('button[data-presentation]')) button.setAttribute('aria-pressed', String(button.dataset.presentation === session.presentation));
  const changedResources = Object.keys(RESOURCE_OPTIONS).filter(resource => session.configuration[resource] !== session.baselineConfiguration[resource]);
  $('configuration-status').textContent = freshRun() ? '当前配置已试产' : changedResources.length ? `已调整 ${changedResources.length} 项 · 待试产` : '初始配置 · 待试产';
  const budget = getResourceBudget(session);
  $('budget-used').textContent = budget.used;
  $('budget-limit').textContent = budget.limit;
  $('budget-remaining').textContent = budget.remaining;
  for (const [resource, options] of Object.entries(RESOURCE_OPTIONS)) {
    const index = options.findIndex(option => option.value === session.configuration[resource]);
    const output = $(`${resource}-value`);
    output.textContent = compactResource(resource, session.configuration[resource]);
    output.setAttribute('aria-label', `${resourceNames[resource]}：${options[index].label}`);
    for (const button of document.querySelectorAll(`[data-resource="${resource}"]`)) {
      const step = Number(button.dataset.step);
      const unavailable = index + step < 0 || index + step >= options.length;
      const unaffordable = step > budget.remaining;
      button.disabled = busy || unavailable || unaffordable;
      button.title = !unavailable && unaffordable ? '试产额度不足，可先降低其他资源' : '';
    }
  }
  const cellCount = session.configuration.alu + 1;
  $('alu-cells').style.setProperty('--alu-columns', cellCount > 16 ? 8 : 4);
  $('alu-cells').classList.toggle('dense', cellCount > 16);
  $('alu-cells').replaceChildren(...Array.from({length: cellCount}, () => element('i')));
  document.querySelectorAll('.memory-figure i').forEach((item, index) => item.classList.toggle('inactive', index >= session.configuration.dram));
  document.querySelectorAll('.cache-figure i').forEach((item, index) => item.classList.toggle('inactive', index >= session.configuration.l1));
  $('reset-button').disabled = busy;
  $('condition-description').textContent = lockedCondition
    ? '此链接指定了一种呈现，未进行随机分配；导出会保留该标记。'
    : session.presentationSwitched
      ? '这是自由探索记录，已包含呈现切换，不能作为随机分组实验数据。'
      : '这是自由探索记录，不能作为随机分组实验数据。';
}

function renderBars(result) {
  const parts = [['computeCycles', '计算'], ['memoryCycles', '数据搬运'], ['latencyCycles', '访问延迟'], ['overlapCycles', '重叠抵扣']];
  const maximum = Math.max(1, ...parts.map(([key]) => result[key]));
  $('cycle-bars').replaceChildren(...parts.map(([key, label]) => {
    const row = element('div', 'cycle-row');
    row.dataset.part = key;
    const track = element('div', 'cycle-track');
    track.setAttribute('aria-hidden', 'true');
    const fill = element('div', 'cycle-fill');
    fill.style.width = `${result[key] / maximum * 100}%`;
    track.append(fill);
    row.append(element('span', '', label), track, element('span', '', `${key === 'overlapCycles' ? '−' : ''}${number(result[key])}`));
    return row;
  }));
  $('cycle-equation').textContent = `${number(result.computeCycles)} + ${number(result.memoryCycles)} + ${number(result.latencyCycles)} − ${number(result.overlapCycles)} = ${number(result.cycles)} 逻辑周期`;
}

function updateResults() {
  const run = displayedRun();
  const hasRun = Boolean(run);
  $('empty-result').hidden = hasRun;
  $('result-content').hidden = !hasRun;
  $('save-reflection').disabled = !hasRun;
  $('reflection-input').disabled = !hasRun;
  $('reflection-status').textContent = '';
  if (!run) {
    $('result-label').textContent = '等待本场景的第一次试产';
    return;
  }
  const isFresh = run.id === session.currentRunId && session.resultIsCurrent;
  $('result-label').textContent = `试产 #${runNumber(run)} · ${isFresh ? '当前配置' : '已保存回执'}`;
  $('snapshot-warning').hidden = isFresh;
  $('snapshot-warning').textContent = sameConfiguration(run.configuration, session.configuration)
    ? `正在查看试产 #${runNumber(run)} 的已保存回执（${configurationText(run.configuration)}）。当前尚未重新试产，回执不会随操作更新。`
    : `资源已改变。下方仍是试产 #${runNumber(run)} 的回执（${configurationText(run.configuration)}），不代表当前台面配置；运行后会生成新回执。`;
  const result = run.result;
  $('total-cycles').textContent = number(result.cycles);
  $('baseline-cycles').textContent = number(run.baselineResult.cycles);
  $('speedup').textContent = `${number(run.speedup)}×`;
  const delta = (result.cycles / run.baselineResult.cycles - 1) * 100;
  const comparison = Math.abs(delta) < .005 ? '与初始配置耗时相同' : `比初始配置${delta < 0 ? '少' : '多'}用 ${number(Math.abs(delta))}% 耗时`;
  const changeSummary = run.comparisonKind === 'unchanged' ? '本次沿用初始配置。'
    : run.comparisonKind === 'single-factor' ? `本次相对起点只调整了${resourceNames[run.changes[0].resource]}。`
      : `本次相对起点调整了 ${run.changes.length} 项资源，结果反映组合变化，不能据此单独归因。`;
  $('result-summary').textContent = `${comparison}。模型分解中，${bottleneckNames[result.bottleneck]}是主要限制项。${changeSummary}`;
  renderBars(result);
  $('external-bytes').textContent = byteText(result.features.externalBytes);
  $('cache-hit').textContent = `${number(result.hitRate * 100)}%`;
  $('memory-bandwidth').textContent = `${number(result.features.externalBandwidth)} B/周期`;
  const prediction = run.prediction;
  $('prediction-feedback').hidden = !prediction;
  if (prediction) {
    const predicted = [];
    if (prediction.direction !== 'unsure') predicted.push(`你预测耗时${directionNames[prediction.direction]}`);
    if (prediction.bottleneck && prediction.bottleneck !== 'unsure') predicted.push(`主要限制在${bottleneckNames[prediction.bottleneck]}`);
    if (prediction.confidence !== undefined) predicted.push(`判断正确概率 ${prediction.confidence}%`);
    const actualDirection = delta < -5 ? 'faster' : delta > 5 ? 'slower' : 'same';
    $('prediction-feedback').textContent = `${predicted.length ? `${predicted.join('，')}。` : '本次选择暂不确定。'}回执：耗时${directionNames[actualDirection]}${actualDirection === 'same' ? '（±5%）' : ''}，主要限制在${bottleneckNames[result.bottleneck]}。${prediction.resultAlreadyVisible ? '你已看过这份配置的结果；本条属于看过结果后的预测。' : ''}`;
  }
  $('reflection-input').value = run.explanation;
  $('reflection-input').dataset.runId = run.id;
}

function updateHistory() {
  const runs = sceneRuns();
  const displayed = displayedRun();
  $('history-count').textContent = `${runs.length} 次试产`;
  $('history-empty').hidden = runs.length > 0;
  $('history-table-wrap').hidden = runs.length === 0;
  $('history-body').replaceChildren(...[...runs].reverse().map(run => {
    const selected = run.id === displayed?.id;
    const row = element('tr', selected ? 'selected' : '');
    const values = [`#${runNumber(run)}`, `${run.configuration.alu + 1}`, `${run.configuration.dram} 组`, `${run.configuration.l1 * 32} KiB`, number(run.result.cycles), `${number(run.speedup)}×`];
    values.forEach((value, index) => row.append(element('td', index === 0 && selected ? 'selected-title' : '', value)));
    const action = element('td');
    const button = element('button', '', selected ? '正在查看' : '查看回执');
    button.type = 'button';
    button.dataset.inspectRun = run.id;
    button.setAttribute('aria-label', `查看试产 ${runNumber(run)} 的回执`);
    button.setAttribute('aria-pressed', String(selected));
    action.append(button);
    row.append(action);
    return row;
  }));
}

function render() {
  updateTabs();
  updateLetter();
  updateHardware();
  updateResults();
  updateHistory();
  $('run-button').disabled = busy;
  $('model-provenance').textContent = `原型 ${LAB_INFO.buildId} · 模型 ${LAB_INFO.model.id} v${LAB_INFO.model.version} · 场景 v${LAB_INFO.scenarioVersion}。对象工坊与抽象框图共用任务、模型、操作和结果信息。`;
}

function announce(message) {
  $('live-status').textContent = message;
}

function saveReflection({silent = false} = {}) {
  const runId = $('reflection-input').dataset.runId;
  const run = session.runs.find(item => item.id === runId);
  if (!run || $('reflection-input').value.trim() === run.explanation) {
    if (!silent && run) $('reflection-status').textContent = '笔记已保存。';
    return;
  }
  session = recordExplanation(session, $('reflection-input').value, runId);
  if (!silent) $('reflection-status').textContent = `已保存到试产 #${runNumber(run)}。`;
}

$('scene-tabs').addEventListener('click', event => {
  const button = event.target.closest('button[data-scene]');
  if (!button || button.dataset.scene === session.scenarioId || busy) return;
  saveReflection({silent: true});
  session = selectScenario(session, button.dataset.scene);
  inspectedRunId = null;
  clearPredictionInputs();
  render();
  document.querySelector(`[data-scene="${session.scenarioId}"]`).focus({preventScroll: true});
  announce(`已打开「${sceneFor(session.scenarioId).title}」。资源回到该场景起点，已有回执仍保留。`);
});

$('hardware-board').addEventListener('click', event => {
  const button = event.target.closest('button[data-resource]');
  if (!button || button.disabled || busy) return;
  const {resource, step} = button.dataset;
  const options = RESOURCE_OPTIONS[resource];
  const nextIndex = options.findIndex(option => option.value === session.configuration[resource]) + Number(step);
  if (!options[nextIndex]) return;
  saveReflection({silent: true});
  session = changeResource(session, resource, options[nextIndex].value);
  clearPredictionInputs();
  render();
  announce(`${resourceNames[resource]}已调整为${options[nextIndex].label}，当前配置尚未试产。`);
});

$('presentation-switch').addEventListener('click', event => {
  const button = event.target.closest('button[data-presentation]');
  if (!button || lockedCondition || button.dataset.presentation === session.presentation || busy) return;
  saveReflection({silent: true});
  session = setPresentation(session, button.dataset.presentation);
  clearPredictionInputs();
  render();
  announce('呈现已切换。配置与模型保持一致，切换已记录为自由探索。');
});

$('reset-button').addEventListener('click', () => {
  if (busy) return;
  saveReflection({silent: true});
  session = resetScenario(session);
  clearPredictionInputs();
  render();
  announce('已恢复本场景的初始配置，之前的试产与笔记仍保留。');
});

$('run-button').addEventListener('click', () => {
  if (busy) return;
  saveReflection({silent: true});
  const direction = $('prediction-direction').value;
  const bottleneck = $('prediction-bottleneck').value;
  const confidence = $('prediction-confidence').value;
  session = setPrediction(session, direction || bottleneck || confidence ? {
    direction: direction || 'unsure',
    ...(bottleneck ? {bottleneck} : {}),
    ...(confidence ? {confidence: Number(confidence)} : {}),
  } : null);
  session = runExperiment(session);
  inspectedRunId = session.currentRunId;
  busy = true;
  clearPredictionInputs();
  render();
  $('hardware-board').classList.add('is-running');
  const run = freshRun();
  announce(`试产 #${runNumber(run)} 已完成，总耗时 ${number(run.result.cycles)} 逻辑周期。回执已更新。`);
  clearTimeout(runningTimer);
  runningTimer = setTimeout(() => {
    busy = false;
    $('hardware-board').classList.remove('is-running');
    updateHardware();
    $('run-button').disabled = false;
  }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 450);
});

$('history-body').addEventListener('click', event => {
  const button = event.target.closest('button[data-inspect-run]');
  if (!button || busy) return;
  saveReflection({silent: true});
  inspectedRunId = button.dataset.inspectRun;
  updateResults();
  updateHistory();
  announce(`正在查看试产 #${runNumber(displayedRun())} 的已保存回执。`);
  $('results').focus({preventScroll: true});
  $('results').scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest'});
});

$('save-reflection').addEventListener('click', () => saveReflection());
for (const id of ['prediction-direction', 'prediction-bottleneck']) $(id).addEventListener('change', updateConfidenceAvailability);
$('export-button').addEventListener('click', () => {
  saveReflection({silent: true});
  const data = exportLabSession(session);
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const link = element('a');
  link.href = url;
  link.download = `gpu-lab-${session.sessionId}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  announce(`已导出 ${session.runs.length} 次试产及操作事件到本地 JSON 文件。`);
});

// Keep the action sequence intact on narrow screens: letter, resources,
// prediction/run, then result. Moving the same node preserves equal controls.
const narrowLayout = matchMedia('(max-width: 920px)');
const experimentPanel = document.querySelector('.experiment');
const sideColumn = document.querySelector('.side-column');
function placeExperimentPanel() {
  sideColumn.classList.toggle('experiment-relocated', narrowLayout.matches);
  if (narrowLayout.matches) $('results').before(experimentPanel);
  else sideColumn.insertBefore(experimentPanel, sideColumn.querySelector('.small-note'));
}
narrowLayout.addEventListener('change', placeExperimentPanel);
placeExperimentPanel();
updateConfidenceAvailability();
render();
