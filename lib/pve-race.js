/**
 * A continuous, fictional business race. Every company owns its own independent
 * workshop economy; ordinary customer work pays for hardware development.
 */
import {UPGRADES, createGame, tickGame, getStats, buyUpgrade, canBuyUpgrade, getUpgradeCost, manualCompute, restoreGame} from './idle-game.js?v=systems-ecosystem-1';
import {createFinance, getFinanceStats, getMarketDemand, getProjectedRevenue, settleFinance, executeIPO, restoreFinance, updateValuation} from './pve-market.js?v=systems-ecosystem-1';
import {BUSINESS_UPGRADES, getBusinessStats, getBusinessUpgradeStatus, buyBusinessUpgrade} from './business-game.js?v=systems-ecosystem-1';
import {getWorkloadPerformance} from './compute-model.js';

export {UPGRADES as RACE_UPGRADES};
export const RACE_COMPANIES = [
  {id: 'player', name: '黄Sir', subtitle: '你的算力工坊', color: '#a5df62', profile: '由你决定投资与应用研发节奏。'},
  {id: 'lisa', name: 'Lisa', subtitle: '红色计算实验室', color: '#fa7b75', profile: '均衡投资计算、缓存与供数，自动拓展矩阵业务。'},
  {id: 'grey', name: '灰盒实验室', subtitle: '虚构的带宽派对手', color: '#9ca8c5', profile: '优先建设缓存和显存，随后向模型业务转型。'},
];
export const GPT3_REQUIREMENTS = {alu: 7, l1: 2, dram: 1, l2: 2, scheduler: 2, tensor: 2, hbm: 1};
export const PROJECT_PROFILE = Object.freeze({workloadShares: Object.freeze({gemm: .7, attention: .3}), trainingPasses: 3, commercialPasses: 1, computeShare: .7});
export const RACE_MILESTONES = [
  {id: 'firstCapital', name: '第一桶金', description: '累计订单收入达到 $1,000。花掉的钱也计入累计收入。', target: 1000},
  {id: 'gpt3', name: 'GPT-3 时刻', description: '满足硬件条件，完成 20,000 单位模型训练；这是架空商业竞赛。', target: 20000},
  {id: 'commercial', name: '首单商业化', description: '模型完成后，交付 10,000 单位首单工作。率先商业化者赢下本场。', target: 10000},
];

const PLANS = {
  lisa: ['alu', 'l1', 'alu', 'dram', 'clock', 'alu', 'scheduler', 'l2', 'alu', 'clock', 'alu', 'tensor', 'l1', 'alu', 'scheduler', 'l2', 'tensor', 'alu', 'hbm', 'tma', 'tmem', 'hbm', 'tensor', 'tma', 'tmem'],
  grey: ['l1', 'alu', 'dram', 'alu', 'l1', 'scheduler', 'l2', 'clock', 'alu', 'dram', 'alu', 'scheduler', 'tensor', 'alu', 'l2', 'alu', 'tensor', 'hbm', 'alu', 'hbm', 'tma', 'tmem', 'tensor', 'tmem'],
};
// Optional system investments follow the original compute development plan.
// The rivals choose distinct procurement strategies rather than stacking both.
const BUSINESS_PLANS = {
  lisa: ['cuda', 'pcie', 'libraries', 'developers', 'nvlink', 'mellanox', 'rack'],
  grey: ['pcie', 'cuda', 'libraries', 'ib_partner', 'rack', 'developers'],
};
const COMPANY_IDS = new Set(RACE_COMPANIES.map(company => company.id));
const MILESTONE_IDS = new Set(RACE_MILESTONES.map(milestone => milestone.id));
const PROJECT_PHASES = new Set(['locked', 'ready', 'training', 'commercial', 'complete']);
const STEP = 1;
const MAX_OFFLINE = 8 * 60 * 60;
const EPSILON = 1e-8;
const finite = (value, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const companyFor = (race, id = 'player') => race.companies.find(company => company.id === id);
const catalogMilestone = id => RACE_MILESTONES.find(milestone => milestone.id === id);

function freshProject() { return {phase: 'locked', progress: 0, work: 20000, commercialProgress: 0, startedAt: null, trainedAt: null, completedAt: null}; }
function projectServiceRate(company, computeShare = PROJECT_PROFILE.computeShare) {
  // Serial kernel stages add service times, not their throughputs. Training
  // performs a forward tile plus two gradient paths; delivery needs one pass.
  const serviceTime = Object.entries(PROJECT_PROFILE.workloadShares).reduce((sum, [kind, fraction]) => sum + fraction / getWorkloadPerformance(company.game.levels, kind).throughput, 0);
  const passes = ['commercial', 'complete'].includes(company.project.phase) ? PROJECT_PROFILE.commercialPasses : PROJECT_PROFILE.trainingPasses;
  return computeShare / (serviceTime * passes) * getBusinessStats(company.game).projectMultiplier;
}
function announce(race, type, message, companyId = null, milestoneId = null) {
  const event = {type, message, companyId, milestoneId, elapsed: race.elapsed};
  race.logs.push(event);
  if (race.logs.length > 48) race.logs.shift();
  return event;
}

export function createRace(now = Date.now()) {
  const timestamp = finite(now, Date.now());
  const race = {version: 1, status: 'running', elapsed: 0, savedAt: timestamp, fraction: 0, winnerId: null, companies: RACE_COMPANIES.map(info => ({id: info.id, name: info.name, game: createGame(timestamp, {performanceModel:'analytical'}), aiPlanIndex: 0, finance: createFinance(info.id), project: freshProject(), milestones: {firstCapital: null, gpt3: null, commercial: null}})), milestones: Object.fromEntries(RACE_MILESTONES.map(milestone => [milestone.id, {winnerIds: [], elapsed: null}])), logs: []};
  announce(race, 'story', '三家公司同时开张，每家只有一个 ALU、没有缓存和显存。订单不断，Lisa 与灰盒实验室会自主投资。');
  return race;
}

export function getProjectRequirements(company) {
  return Object.entries(GPT3_REQUIREMENTS).map(([id, required]) => ({id, name: UPGRADES.find(upgrade => upgrade.id === id).name, required, current: company.game.levels[id], met: company.game.levels[id] >= required}));
}

export function getRaceStats(race) {
  const companies = race.companies.map(company => {
    const stats = getStats(company.game);
    const bankrupt = getFinanceStats(company).bankrupt;
    return {id: company.id, name: company.name, money: company.game.money, totalEarned: company.game.totalEarned, completed: company.game.completed, levels: {...company.game.levels}, ...stats, incomeRate: bankrupt ? 0 : getProjectedRevenue(company), marketDemand: getMarketDemand(company), projectRate: bankrupt ? 0 : projectServiceRate(company), project: {...company.project}, trainingProgress: clamp(company.project.progress / catalogMilestone('gpt3').target, 0, 1), commercialProgress: clamp(company.project.commercialProgress / catalogMilestone('commercial').target, 0, 1), requirements: getProjectRequirements(company), milestones: {...company.milestones}, finance: getFinanceStats(company)};
  });
  const rankings = [...companies].sort((a, b) => {
    const phaseScore = phase => ({locked: 0, ready: 1, training: 2, commercial: 3, complete: 4})[phase];
    return phaseScore(b.project.phase) - phaseScore(a.project.phase) || b.trainingProgress - a.trainingProgress || b.commercialProgress - a.commercialProgress || b.totalEarned - a.totalEarned;
  });
  return {companies, rankings, player: companies.find(company => company.id === 'player'), elapsed: race.elapsed, winnerId: race.winnerId, status: race.status};
}

export function getRaceUpgradeCost(race, id) { return getUpgradeCost(companyFor(race).game, id); }
export function canBuyRaceUpgrade(race, id) { return !getFinanceStats(companyFor(race)).bankrupt && canBuyUpgrade(companyFor(race).game, id); }
export function buyRaceUpgrade(race, id) {
  if (!canBuyRaceUpgrade(race, id)) return {ok: false, reason: '预算不足，或研发收入与前置组件尚未满足。'};
  buyUpgrade(companyFor(race).game, id);
  announce(race, 'upgrade', `黄Sir 安装了 ${UPGRADES.find(upgrade => upgrade.id === id).name} Lv.${companyFor(race).game.levels[id]}。`, 'player');
  updateReady(race, companyFor(race));
  return {ok: true};
}

export function buyRaceBusinessUpgrade(race, id) {
  const company = companyFor(race);
  if (getFinanceStats(company).bankrupt) return {ok: false, reason: '公司已经破产，无法继续投资。', cost: 0};
  const result = buyBusinessUpgrade(company.game, id);
  if (!result.ok) return result;
  const upgrade = BUSINESS_UPGRADES.find(item => item.id === id);
  announce(race, 'business-upgrade', `${company.name} 投资了 ${upgrade.name}，扩展系统与软件生态。`, company.id);
  updateReady(race, company);
  updateValuation(company, race.elapsed);
  return result;
}

export function manualRaceCompute(race) {
  const company = companyFor(race);
  if (company.finance.bankrupt) return [];
  const beforeClicks = company.game.clicks;
  const beforeRevenue = company.game.totalEarned;
  const events = manualCompute(company.game);
  const revenue = company.game.totalEarned - beforeRevenue;
  if (revenue > 0) {
    for (const event of settleFinance(company, 0, revenue, race.elapsed)) events.push(announce(race, event.type, event.message, company.id));
  }
  // A deliberate intervention also helps the active model application.
  if (company.game.clicks > beforeClicks && ['training', 'commercial'].includes(company.project.phase)) {
    const key = company.project.phase === 'training' ? 'progress' : 'commercialProgress';
    const target = company.project.phase === 'training' ? catalogMilestone('gpt3').target : catalogMilestone('commercial').target;
    company.project[key] = Math.min(target, company.project[key] + projectServiceRate(company, .1));
  }
  return events;
}

function updateReady(race, company) {
  if (company.project.phase === 'locked' && Object.entries(GPT3_REQUIREMENTS).every(([id, minimum]) => company.game.levels[id] >= minimum)) {
    company.project.phase = 'ready';
    announce(race, 'project-ready', `${company.name} 的硬件已经可以启动 GPT-3 项目。`, company.id);
  }
}

function startCompanyProject(race, company) {
  updateReady(race, company);
  if (company.project.phase !== 'ready') return {ok: false, reason: '先补齐 GPT-3 项目的硬件条件。'};
  company.project.phase = 'training';
  company.project.startedAt = race.elapsed;
  announce(race, 'project-start', `${company.name} 启动 GPT-3 项目，70% 算力投入训练，30% 继续接单。`, company.id);
  return {ok: true};
}

export function startRaceProject(race) {
  if (getFinanceStats(companyFor(race)).bankrupt) return {ok: false, reason: '公司已经破产，无法启动新项目。'};
  return startCompanyProject(race, companyFor(race));
}

function autoInvest(race, company) {
  const plan = PLANS[company.id];
  if (!plan) return;
  if (company.finance.bankrupt) return;
  if (!company.finance.listed && company.game.totalEarned >= 600) {
    const ipo = executeIPO(company);
    if (ipo.ok) announce(race, 'ipo', `${company.name} 完成 IPO 融资，继续投资算力。`, company.id);
  }
  const id = plan[company.aiPlanIndex];
  const cost = id ? getUpgradeCost(company.game, id) : Infinity;
  if (id && company.game.money >= cost && company.game.money - cost >= getFinanceStats(company).reserve && buyUpgrade(company.game, id)) {
    company.aiPlanIndex += 1;
    announce(race, 'rival-upgrade', `${company.name} 投资了 ${UPGRADES.find(upgrade => upgrade.id === id).name}，继续扩张产线。`, company.id);
  }
  updateReady(race, company);
  if (company.project.phase === 'ready') startCompanyProject(race, company);
  if (company.aiPlanIndex >= plan.length || company.project.phase === 'complete') autoInvestBusiness(race, company);
}

function autoInvestBusiness(race, company) {
  const id = BUSINESS_PLANS[company.id].find(candidate => getBusinessUpgradeStatus(company.game, candidate).level === 0);
  if (!id) return;
  const quote = getBusinessUpgradeStatus(company.game, id);
  const finance = getFinanceStats(company);
  if (!quote.ok || finance.netFlow <= 0 || finance.debt > EPSILON || company.game.money - quote.cost < finance.reserve) return;
  // Quote the resulting operating margin before committing scarce cash. This
  // prevents optional commercial plans from knowingly creating operating losses.
  const trial = {...company, game: {...company.game, business: structuredClone(company.game.business)}};
  if (!buyBusinessUpgrade(trial.game, id).ok) return;
  const after = getFinanceStats(trial);
  if (after.netFlow <= 0 || trial.game.money < after.reserve) return;
  if (!buyBusinessUpgrade(company.game, id).ok) return;
  announce(race, 'rival-business-upgrade', `${company.name} 投资了 ${BUSINESS_UPGRADES.find(upgrade => upgrade.id === id).name}，拓展系统与软件业务。`, company.id);
  updateValuation(company, race.elapsed);
}

function claimMilestones(race, events) {
  for (const milestone of RACE_MILESTONES) {
    const claimants = [];
    for (const company of race.companies) {
      const reached = milestone.id === 'firstCapital' ? company.game.totalEarned >= milestone.target : milestone.id === 'gpt3' ? ['commercial', 'complete'].includes(company.project.phase) : company.project.phase === 'complete';
      if (reached && company.milestones[milestone.id] === null) {
        company.milestones[milestone.id] = race.elapsed;
        claimants.push(company.id);
        events.push(announce(race, 'milestone', `${company.name} 达成「${milestone.name}」！`, company.id, milestone.id));
      }
    }
    if (claimants.length && race.milestones[milestone.id].elapsed === null) {
      race.milestones[milestone.id] = {winnerIds: claimants, elapsed: race.elapsed};
      if (milestone.id === 'commercial') {
        race.status = 'finished';
        race.winnerId = claimants.length === 1 ? claimants[0] : 'tie';
        events.push(announce(race, 'race-end', claimants.length === 1 ? `${companyFor(race, claimants[0]).name} 率先完成首单商业化，赢下本场商业竞赛。` : '多家公司同时商业化，本场并列。'));
      }
    }
  }
}

function stepRace(race, events) {
  race.elapsed += STEP;
  for (const company of race.companies) {
    if (company.finance.bankrupt) continue;
    const project = company.project;
    const active = ['training', 'commercial'].includes(project.phase);
    const stats = getStats(company.game);
    const beforeRate = active ? projectServiceRate(company) : 0;
    const beforeRevenue = company.game.totalEarned;
    const demandShare = Math.min(1, getMarketDemand(company, stats) / Math.max(EPSILON, stats.incomeRate));
    const businessSeconds = STEP * (active ? .3 : 1) * demandShare;
    // Finite market demand slows the arrival of paying work; full canonical
    // invoices still pay in full. Hardware alone does not create more clients.
    tickGame(company.game, businessSeconds);
    // Business simulation gets its compute and demand share; cooldowns use time.
    company.game.elapsed += STEP - businessSeconds;
    company.game.boostRemaining = Math.max(0, company.game.boostRemaining - (STEP - businessSeconds));
    if (project.phase === 'training') {
      project.progress = Math.min(catalogMilestone('gpt3').target, project.progress + beforeRate * STEP);
      if (project.progress >= catalogMilestone('gpt3').target - EPSILON) {
        project.phase = 'commercial';
        project.work = catalogMilestone('commercial').target;
        project.trainedAt = race.elapsed;
        events.push(announce(race, 'training-complete', `${company.name} 的 GPT-3 项目完成，开始交付首单商业化订单。`, company.id));
      }
    } else if (project.phase === 'commercial') {
      project.commercialProgress = Math.min(catalogMilestone('commercial').target, project.commercialProgress + beforeRate * STEP);
      if (project.commercialProgress >= catalogMilestone('commercial').target - EPSILON) { project.phase = 'complete'; project.completedAt = race.elapsed; }
    }
    for (const event of settleFinance(company, STEP, company.game.totalEarned - beforeRevenue, race.elapsed)) events.push(announce(race, event.type, event.message, company.id));
    if (company.finance.bankrupt) continue;
    if (company.id !== 'player') autoInvest(race, company);
    else updateReady(race, company);
    if (race.elapsed >= company.finance.lastValuationAt + 5 - EPSILON) updateValuation(company, race.elapsed);
  }
  claimMilestones(race, events);
}

/** Fixed simulation boundaries keep competitors fair at any browser frame rate. */
export function tickRace(race, seconds) {
  const events = [];
  race.fraction += clamp(finite(seconds), 0, MAX_OFFLINE);
  while (race.fraction >= STEP - EPSILON) {
    race.fraction = Math.max(0, race.fraction - STEP);
    stepRace(race, events);
  }
  return events;
}

export function serializeRace(race, now = Date.now()) { race.savedAt = finite(now, Date.now()); return JSON.stringify(race); }

export function restoreRace(raw, now = Date.now()) {
  const timestamp = finite(now, Date.now());
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!data || data.version !== 1 || !['running', 'finished'].includes(data.status) || !Array.isArray(data.companies) || data.companies.length !== RACE_COMPANIES.length) return null;
  const race = createRace(timestamp);
  race.elapsed = clamp(finite(data.elapsed), 0, 1e8);
  race.fraction = clamp(finite(data.fraction), 0, STEP);
  for (const company of race.companies) {
    const source = data.companies.find(item => item?.id === company.id);
    if (!source?.game?.levels || !Number.isFinite(source.game.money) || source.game.money < 0) return null;
    // Prevent the workshop helper from independently granting offline income.
    // Its original economy assumes cash <= sales. IPO proceeds break that
    // assumption, so validate research against operational sales separately.
    const cash = clamp(source.game.money, 0, 1e15);
    const earned = clamp(finite(source.game.totalEarned), 0, 1e15);
    company.game = restoreGame({...source.game, money: Math.min(cash, earned), totalEarned: earned, savedAt: timestamp, challenge: null, won: [], story: []}, timestamp, {performanceModel:'analytical'}).state;
    company.game.money = cash;
    company.game.story = [];
    company.finance = restoreFinance(source.finance);
    company.aiPlanIndex = company.id === 'player' ? 0 : Math.floor(clamp(finite(source.aiPlanIndex), 0, PLANS[company.id].length));
    if (company.id !== 'player') {
      const bought = {};
      for (let index = 0; index < company.aiPlanIndex; index += 1) {
        const id = PLANS[company.id][index];
        bought[id] = (bought[id] || 0) + 1;
        if (bought[id] > company.game.levels[id]) { company.aiPlanIndex = index; break; }
      }
    }
    const phase = source.project?.phase;
    if (!PROJECT_PHASES.has(phase)) return null;
    const requirementsMet = getProjectRequirements(company).every(requirement => requirement.met);
    company.project = {...freshProject(), phase: requirementsMet ? phase : 'locked', work: ['commercial', 'complete'].includes(phase) ? catalogMilestone('commercial').target : catalogMilestone('gpt3').target, progress: requirementsMet ? clamp(finite(source.project.progress), 0, catalogMilestone('gpt3').target) : 0, commercialProgress: requirementsMet ? clamp(finite(source.project.commercialProgress), 0, catalogMilestone('commercial').target) : 0};
    if (['commercial', 'complete'].includes(company.project.phase) && company.project.progress < catalogMilestone('gpt3').target) company.project.phase = 'training';
    if (company.project.phase === 'complete' && company.project.commercialProgress < catalogMilestone('commercial').target) company.project.phase = 'commercial';
    if (['locked', 'ready'].includes(company.project.phase)) { company.project.progress = 0; company.project.commercialProgress = 0; }
    if (company.project.phase === 'training') company.project.commercialProgress = 0;
    company.project.work = ['commercial', 'complete'].includes(company.project.phase) ? catalogMilestone('commercial').target : catalogMilestone('gpt3').target;
    for (const id of ['startedAt', 'trainedAt', 'completedAt']) company.project[id] = source.project[id] === null ? null : clamp(finite(source.project[id]), 0, race.elapsed);
    for (const milestone of RACE_MILESTONES) {
      const eligible = milestone.id === 'firstCapital' ? company.game.totalEarned >= milestone.target : milestone.id === 'gpt3' ? ['commercial', 'complete'].includes(company.project.phase) : company.project.phase === 'complete';
      company.milestones[milestone.id] = eligible && Number.isFinite(source.milestones?.[milestone.id]) ? clamp(source.milestones[milestone.id], 0, race.elapsed) : null;
    }
  }
  for (const id of MILESTONE_IDS) {
    const saved = data.milestones?.[id];
    const winnerIds = [...new Set((Array.isArray(saved?.winnerIds) ? saved.winnerIds : []).filter(companyId => COMPANY_IDS.has(companyId) && companyFor(race, companyId).milestones[id] !== null))];
    race.milestones[id] = {winnerIds, elapsed: winnerIds.length ? clamp(finite(saved.elapsed), 0, race.elapsed) : null};
  }
  const finished = race.milestones.commercial.winnerIds.length > 0;
  race.status = finished ? 'finished' : 'running';
  race.winnerId = finished ? race.milestones.commercial.winnerIds.length > 1 ? 'tie' : race.milestones.commercial.winnerIds[0] : null;
  race.logs = [announce(race, 'restore', '公司经营已恢复。离线期间所有公司按同一时钟推进，对手也会继续投资。')];
  const offline = clamp((timestamp - finite(data.savedAt, timestamp)) / 1000, 0, MAX_OFFLINE);
  tickRace(race, offline);
  race.savedAt = timestamp;
  return race;
}
