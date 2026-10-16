import test from 'node:test';
import assert from 'node:assert/strict';
import {RACE_COMPANIES, RACE_MILESTONES, GPT3_REQUIREMENTS, PROJECT_PROFILE, RACE_UPGRADES, createRace, tickRace, getRaceStats, getRaceUpgradeCost, canBuyRaceUpgrade, buyRaceUpgrade, buyRaceBusinessUpgrade, chooseRaceNarrative, manualRaceCompute, startRaceProject, restoreRace, serializeRace} from '../lib/pve-race.js';
import {getFinanceStats, executeIPO} from '../lib/pve-market.js';
import {getBusinessStats, getBusinessUpgradeStatus} from '../lib/business-game.js';
import {getWorkloadPerformance} from '../lib/compute-model.js';

const playerFor = race => race.companies.find(company => company.id === 'player');
const PLAYER_PLAN = ['alu', 'l1', 'alu', 'dram', 'clock', 'alu', 'scheduler', 'l2', 'alu', 'clock', 'alu', 'tensor', 'l1', 'alu', 'scheduler', 'l2', 'tensor', 'alu', 'hbm'];

function establishProject(company) {
  company.game.totalEarned = 10000;
  company.game.money = 3000;
  for (const [id, required] of Object.entries(GPT3_REQUIREMENTS)) company.game.levels[id] = required;
}

function establishCorrespondence(race) {
  const player = playerFor(race);
  establishProject(player);
  player.game.totalEarned = 20000;
  player.game.money = 50000;
  for (const id of ['cuda', 'pcie', 'libraries', 'ib_partner', 'rack']) assert.equal(buyRaceBusinessUpgrade(race, id).ok, true, id);
  return player;
}

test('three companies open independent businesses with one ALU and no cash, cache or memory', () => {
  const race = createRace(1000);
  assert.equal(race.elapsed, 0);
  assert.equal(race.status, 'running');
  assert.equal(race.winnerId, null);
  assert.deepEqual(race.companies.map(company => company.id), RACE_COMPANIES.map(company => company.id));
  const stats = getRaceStats(race);
  for (const company of stats.companies) {
    assert.equal(company.aluCount, 1);
    assert.equal(company.money, 0);
    assert.equal(company.totalEarned, 0);
    assert.equal(company.hitRate, 0);
    assert.equal(company.project.phase, 'locked');
    assert.equal(company.finance.bankrupt, false);
  }
  assert.notEqual(race.companies[0].game, race.companies[1].game);
  assert.notEqual(race.companies[0].game.levels, race.companies[1].game.levels);
  assert.ok(RACE_MILESTONES.some(milestone => milestone.id === 'firstCapital' && milestone.target === 1000));
});

test('ordinary orders generate revenue while opponents autonomously reinvest', () => {
  const race = createRace(0);
  tickRace(race, 200);
  const player = playerFor(race);
  assert.ok(player.game.totalEarned > 50);
  assert.equal(player.game.levels.alu, 0, 'player controls their own investment decisions');
  assert.ok(race.companies[1].game.levels.alu > 0);
  assert.ok(race.companies[1].game.levels.l1 > 0);
  assert.ok(race.companies[2].game.levels.dram > 0);
  assert.ok(race.companies[1].game.totalEarned > player.game.totalEarned);
  assert.ok(race.companies.every(company => company.game.money >= 0));
  assert.ok(race.logs.some(event => event.type === 'rival-upgrade'));
});

test('player purchases enforce ordinary funds, research, prerequisites and caps', () => {
  const race = createRace(0);
  assert.equal(canBuyRaceUpgrade(race, 'alu'), false);
  assert.equal(buyRaceUpgrade(race, 'alu').ok, false);
  assert.equal(buyRaceUpgrade(race, 'unknown').ok, false);
  assert.equal(getRaceUpgradeCost(race, 'unknown'), Infinity);
  tickRace(race, 40);
  const before = playerFor(race).game.money;
  const cost = getRaceUpgradeCost(race, 'alu');
  assert.equal(buyRaceUpgrade(race, 'alu').ok, true);
  assert.equal(playerFor(race).game.money, before - cost);
  assert.equal(getRaceStats(race).player.aluCount, 2);
  assert.equal(buyRaceUpgrade(race, 'tmem').ok, false);
  assert.ok(getRaceUpgradeCost(race, 'alu') > cost);
});

test('hardware and applications remain independent; GPT-3 is a later real workload', () => {
  const race = createRace(0);
  assert.equal(startRaceProject(race).ok, false);
  const player = playerFor(race);
  establishProject(player);
  player.game.levels.hbm = 0;
  assert.equal(startRaceProject(race).ok, false);
  player.game.levels.hbm = 1;
  assert.equal(startRaceProject(race).ok, true);
  assert.equal(player.project.phase, 'training');
  assert.equal(player.project.work, 20000);
  const revenue = player.game.totalEarned;
  tickRace(race, 10);
  assert.ok(player.project.progress > 0);
  assert.ok(player.game.totalEarned > revenue, 'customer business continues alongside training');
  assert.equal(player.game.won.length, 0, 'no idle application victories are required');
  assert.ok(getRaceStats(race).player.incomeRate >= 0);
  assert.equal(player.game.elapsed, race.elapsed);
});

test('GPT-3 project service adds GEMM and attention times, with three training passes', () => {
  const race = createRace(0);
  const player = playerFor(race);
  establishProject(player);
  startRaceProject(race);
  const expected = PROJECT_PROFILE.computeShare / (PROJECT_PROFILE.trainingPasses * Object.entries(PROJECT_PROFILE.workloadShares).reduce((sum, [kind, fraction]) => sum + fraction / getWorkloadPerformance(player.game.levels, kind).throughput, 0));
  assert.ok(Math.abs(getRaceStats(race).player.projectRate - expected) < 1e-8);
  tickRace(race, 1);
  assert.ok(Math.abs(player.project.progress - expected) < 1e-8);
  player.project.phase = 'commercial';
  player.project.progress = 20000;
  player.project.work = 10000;
  const commercialRate = getRaceStats(race).player.projectRate;
  assert.ok(Math.abs(commercialRate - expected * 3) < 1e-8);
  tickRace(race, 1);
  assert.ok(Math.abs(player.project.commercialProgress - commercialRate) < 1e-8);
});

test('a completely idle player falls behind real autonomous competitors', () => {
  const race = createRace(0);
  tickRace(race, 1800);
  assert.equal(race.status, 'finished');
  assert.ok(['lisa', 'grey'].includes(race.winnerId));
  assert.equal(playerFor(race).project.phase, 'locked');
  assert.ok(race.milestones.firstCapital.elapsed < race.milestones.gpt3.elapsed);
  assert.ok(race.milestones.gpt3.elapsed < race.milestones.commercial.elapsed);
  const winner = race.companies.find(company => company.id === race.winnerId);
  assert.equal(winner.project.phase, 'complete');
});

test('active thoughtful investment can beat Lisa without starting cash or injected hardware', () => {
  const race = createRace(0);
  let index = 0;
  for (let time = 0; time < 1800 && !race.winnerId; time += 1) {
    const player = playerFor(race);
    manualRaceCompute(race);
    const finance = getFinanceStats(player);
    if (!finance.listed && player.game.totalEarned >= 600) executeIPO(player);
    if (index < PLAYER_PLAN.length && buyRaceUpgrade(race, PLAYER_PLAN[index]).ok) index += 1;
    if (player.project.phase === 'ready') startRaceProject(race);
    tickRace(race, 1);
  }
  assert.equal(race.winnerId, 'player');
  assert.equal(playerFor(race).project.phase, 'complete');
  assert.ok(race.elapsed > 120);
  assert.ok(!getFinanceStats(playerFor(race)).bankrupt);
});

test('first commercial winner remains recorded while all businesses continue afterwards', () => {
  const race = createRace(0);
  tickRace(race, 1800);
  const winner = race.winnerId;
  const wonAt = race.milestones.commercial.elapsed;
  const before = playerFor(race).game.totalEarned;
  const elapsed = race.elapsed;
  tickRace(race, 20);
  assert.equal(race.elapsed, elapsed + 20);
  assert.equal(race.winnerId, winner);
  assert.equal(race.milestones.commercial.elapsed, wonAt);
  assert.ok(playerFor(race).game.totalEarned >= before);
  assert.equal(getRaceStats(race).status, 'finished');
});

test('same-second first crossings are explicit ties, not array order wins', () => {
  const race = createRace(0);
  for (const company of race.companies) {
    establishProject(company);
    company.project = {phase: 'commercial', progress: 20000, work: 10000, commercialProgress: 9999, startedAt: 0, trainedAt: 0, completedAt: null};
  }
  tickRace(race, 1);
  assert.equal(race.winnerId, 'tie');
  assert.deepEqual(race.milestones.commercial.winnerIds, ['player', 'lisa', 'grey']);
  assert.equal(race.milestones.commercial.elapsed, 1);
});

test('same-time manual spam cannot create money or model work', () => {
  const race = createRace(0);
  const player = playerFor(race);
  establishProject(player);
  startRaceProject(race);
  manualRaceCompute(race);
  const progress = player.project.progress;
  const clicks = player.game.clicks;
  const revenue = player.game.totalEarned;
  for (let i = 0; i < 100; i += 1) manualRaceCompute(race);
  assert.equal(player.project.progress, progress);
  assert.equal(player.game.clicks, clicks);
  assert.equal(player.game.totalEarned, revenue);
  tickRace(race, 1);
  manualRaceCompute(race);
  assert.ok(player.project.progress > progress);
});

test('fixed economic steps preserve results across browser frame partitioning', () => {
  const large = createRace(0);
  const small = createRace(0);
  tickRace(large, 200.5);
  for (let i = 0; i < 2005; i += 1) tickRace(small, .1);
  assert.equal(large.elapsed, small.elapsed);
  assert.ok(Math.abs(large.fraction - small.fraction) < 1e-8);
  assert.deepEqual(large.companies, small.companies);
  assert.deepEqual(large.milestones, small.milestones);
  const snapshot = serializeRace(large, 0);
  tickRace(large, NaN);
  tickRace(large, -10);
  assert.equal(serializeRace(large, 0), snapshot);
});

test('one shared offline clock advances opponents, hardware, training and finances', () => {
  const original = createRace(0);
  tickRace(original, 100);
  const serialized = serializeRace(original, 100000);
  const loaded = restoreRace(serialized, 300000);
  const direct = structuredClone(original);
  tickRace(direct, 200);
  assert.ok(loaded);
  assert.equal(loaded.elapsed, direct.elapsed);
  for (let index = 0; index < loaded.companies.length; index += 1) {
    const a = loaded.companies[index]; const b = direct.companies[index];
    assert.equal(a.game.totalEarned, b.game.totalEarned);
    assert.deepEqual(a.game.levels, b.game.levels);
    assert.equal(a.aiPlanIndex, b.aiPlanIndex);
    assert.equal(a.project.phase, b.project.phase);
    assert.ok(Math.abs(a.project.progress - b.project.progress) < 1e-8);
    assert.ok(Math.abs(a.game.money - b.game.money) < 1e-8);
  }
});

test('restoring financed cash never turns IPO proceeds into operating sales or research', () => {
  const race = createRace(0);
  const player = playerFor(race);
  player.game.totalEarned = 600;
  player.game.money = 600;
  assert.equal(executeIPO(player).ok, true);
  assert.ok(player.game.money > player.game.totalEarned);
  const restored = restoreRace(serializeRace(race, 0), 0);
  assert.ok(restored);
  assert.equal(playerFor(restored).game.totalEarned, 600);
  assert.equal(playerFor(restored).game.money, player.game.money);
  assert.equal(playerFor(restored).finance.ipoProceeds, player.finance.ipoProceeds);
  assert.equal(canBuyRaceUpgrade(restored, 'tensor'), false);
  assert.equal(restored.milestones.firstCapital.elapsed, null);
});

test('bankrupt companies freeze jobs, investment and projects', () => {
  const race = createRace(0);
  const player = playerFor(race);
  establishProject(player);
  startRaceProject(race);
  player.finance.bankrupt = true;
  const project = structuredClone(player.project);
  assert.equal(buyRaceUpgrade(race, 'alu').ok, false);
  assert.equal(buyRaceBusinessUpgrade(race, 'cuda').ok, false);
  assert.equal(startRaceProject(race).ok, false);
  assert.deepEqual(manualRaceCompute(race), []);
  tickRace(race, 1);
  assert.equal(getRaceStats(race).player.narrative.ending.id, 'closure');
  const game = structuredClone(player.game);
  tickRace(race, 30);
  assert.deepEqual(player.game, game);
  assert.deepEqual(player.project, project);
  assert.equal(getRaceStats(race).player.incomeRate, 0);
  assert.ok(race.companies[1].game.totalEarned > 0);
});

test('real IPO-funded compute overexpansion can bankrupt a company without sufficient demand', () => {
  const race = createRace(0);
  const player = playerFor(race);
  let expanded = false;
  for (let time = 0; time < 1800 && !player.finance.bankrupt; time += 1) {
    if (!expanded) manualRaceCompute(race);
    if (!expanded && player.game.money >= 1000) {
      assert.equal(executeIPO(player).ok, true);
      expanded = true;
    }
    if (expanded) {
      for (let count = 0; count < 50; count += 1) {
        const ids = ['alu', 'clock'].sort((a, b) => getRaceUpgradeCost(race, a) - getRaceUpgradeCost(race, b));
        if (!ids.some(id => buyRaceUpgrade(race, id).ok)) break;
      }
    }
    tickRace(race, 1);
  }
  assert.ok(expanded);
  assert.equal(player.finance.bankrupt, true);
  assert.equal(player.game.levels.l1, 0, 'compute-only expansion never broadened its customers');
  assert.equal(player.game.levels.dram, 0);
  assert.equal(getFinanceStats(player).bankruptcyRatio, 1);
  assert.ok(player.game.money >= 0);
  assert.ok(race.logs.some(event => event.type === 'bankrupt' && event.companyId === 'player'));
});

test('manual invoices repay debt and enter the finance revenue ledger immediately', () => {
  const race = createRace(0);
  const player = playerFor(race);
  tickRace(race, 1);
  const debt = player.finance.debt;
  manualRaceCompute(race);
  tickRace(race, 1);
  const beforeCosts = player.finance.totalCosts;
  manualRaceCompute(race);
  assert.ok(player.game.totalEarned > 0);
  assert.equal(player.finance.totalRevenue, player.game.totalEarned);
  assert.equal(player.finance.debt, 0);
  assert.ok(debt > 0);
  assert.equal(player.finance.totalCosts, beforeCosts, 'a click does not advance operating time');
});

test('restoration caps the shared offline clock at eight hours', () => {
  const fresh = createRace(0);
  const restored = restoreRace(serializeRace(fresh, 0), 24 * 60 * 60 * 1000);
  assert.ok(restored);
  assert.equal(restored.elapsed, 8 * 60 * 60);
  assert.equal(restored.savedAt, 24 * 60 * 60 * 1000);
  assert.ok(restored.winnerId);
  for (const company of restored.companies) {
    assert.ok(company.game.money >= 0);
    assert.ok(company.finance.history.length <= 120);
  }
});

test('save sanitation rebuilds canonical names, jobs, requirements, stock state and winners', () => {
  for (const raw of [null, '', '{bad', '{}', {version: 999}]) assert.equal(restoreRace(raw, 0), null);
  const hostile = createRace(0);
  const company = playerFor(hostile);
  company.name = '<script>evil</script>';
  company.project = {phase: 'complete', work: -1, progress: 1e99, commercialProgress: 1e99};
  company.game.activeJob = {id: 1, kind: 'fp32', name: '<script>', work: -10, reward: 1e99, progress: 0};
  company.game.story = [{id: 'evil', message: '<script>'}];
  company.milestones.commercial = 0;
  hostile.status = 'finished';
  hostile.winnerId = 'evil';
  hostile.milestones.commercial = {winnerIds: ['evil', 'player'], elapsed: 0};
  hostile.logs = [{message: '<script>'}];
  const restored = restoreRace(hostile, 0);
  assert.ok(restored);
  assert.equal(playerFor(restored).name, '黄Sir');
  assert.equal(playerFor(restored).project.phase, 'locked');
  assert.equal(restored.winnerId, null);
  assert.equal(restored.status, 'running');
  assert.ok(!serializeRace(restored, 0).includes('<script>'));
  assert.ok(playerFor(restored).game.activeJob.work > 0);
  assert.ok(playerFor(restored).game.activeJob.reward < 100);
  assert.equal(RACE_UPGRADES.length, 10);
});

test('business purchases spend cash once without creating orders, sales or financing income', () => {
  const race = createRace(0);
  const player = playerFor(race);
  assert.equal(buyRaceBusinessUpgrade(race, 'unknown').ok, false);
  assert.equal(buyRaceBusinessUpgrade(race, 'cuda').ok, false);
  establishProject(player);
  const before = {money: player.game.money, earned: player.game.totalEarned,
    revenue: player.finance.totalRevenue, costs: player.finance.totalCosts, completed: player.game.completed};
  const quote = getBusinessUpgradeStatus(player.game, 'cuda');
  assert.equal(quote.ok, true);
  const result = buyRaceBusinessUpgrade(race, 'cuda');
  assert.equal(result.ok, true);
  assert.equal(player.game.money, before.money - quote.cost);
  assert.equal(player.game.totalEarned, before.earned);
  assert.equal(player.finance.totalRevenue, before.revenue);
  assert.equal(player.finance.totalCosts, before.costs);
  assert.equal(player.game.completed, before.completed);
  assert.deepEqual(getRaceStats(race).player.business, getBusinessStats(player.game));
  assert.ok(race.logs.some(event => event.type === 'business-upgrade' && event.companyId === 'player'));
  assert.ok(player.finance.history.length > 0);
});

test('software and interconnect project benefits apply once to the measured service rate', () => {
  const race = createRace(0);
  const player = playerFor(race);
  establishProject(player);
  player.game.money = 30000;
  const base = getRaceStats(race).player.projectRate;
  for (const id of ['cuda', 'pcie', 'libraries', 'nvlink', 'ib_partner', 'rack']) assert.equal(buyRaceBusinessUpgrade(race, id).ok, true, id);
  assert.equal(startRaceProject(race).ok, true);
  const business = getBusinessStats(player.game);
  assert.ok(business.projectMultiplier > 1);
  const rate = getRaceStats(race).player.projectRate;
  assert.ok(Math.abs(rate - base * business.projectMultiplier) < 1e-8);
  tickRace(race, 1);
  assert.ok(Math.abs(player.project.progress - rate) < 1e-8);
});

test('IB procurement strategies remain exclusive in the business race', () => {
  const race = createRace(0);
  const player = playerFor(race);
  establishProject(player);
  player.game.totalEarned = 20000;
  player.game.money = 50000;
  assert.equal(buyRaceBusinessUpgrade(race, 'pcie').ok, true);
  assert.equal(buyRaceBusinessUpgrade(race, 'ib_partner').ok, true);
  const before = structuredClone(player.game);
  assert.equal(buyRaceBusinessUpgrade(race, 'mellanox').ok, false);
  assert.deepEqual(player.game, before);
  assert.equal(getBusinessStats(player.game).networkRoute, 'partner');
});

test('saved system businesses and model work use the same offline company clock', () => {
  const race = createRace(0);
  const player = playerFor(race);
  establishProject(player);
  for (const id of ['cuda', 'pcie', 'libraries']) assert.equal(buyRaceBusinessUpgrade(race, id).ok, true, id);
  startRaceProject(race);
  tickRace(race, 40);
  const serialized = serializeRace(race, 40000);
  const restored = restoreRace(serialized, 160000);
  const direct = structuredClone(race);
  tickRace(direct, 120);
  assert.ok(restored);
  for (let index = 0; index < restored.companies.length; index += 1) {
    const actual = restored.companies[index];
    const expected = direct.companies[index];
    assert.deepEqual(actual.game.business, expected.game.business);
    assert.equal(actual.game.totalEarned, expected.game.totalEarned);
    assert.ok(Math.abs(actual.game.money - expected.game.money) < 1e-8);
    assert.ok(Math.abs(actual.project.progress - expected.project.progress) < 1e-8);
    assert.ok(Math.abs(actual.finance.totalCosts - expected.finance.totalCosts) < 1e-8);
  }
});

test('rivals retain their hardware plan and make distinct solvent optional business investments', () => {
  const race = createRace(0);
  const [lisa, grey] = race.companies.filter(company => company.id !== 'player');
  for (const rival of [lisa, grey]) {
    establishProject(rival);
    for (const upgrade of RACE_UPGRADES) rival.game.levels[upgrade.id] = Math.min(2, upgrade.maxLevel);
    rival.game.levels.alu = 7;
    rival.game.totalEarned = 50000;
    rival.game.money = 100000;
    rival.aiPlanIndex = 25;
    rival.project = {phase: 'complete', progress: 20000, work: 10000, commercialProgress: 10000, startedAt: 0, trainedAt: 0, completedAt: 0};
  }
  tickRace(race, 12);
  assert.equal(getBusinessStats(lisa.game).networkRoute, 'acquire');
  assert.equal(getBusinessStats(grey.game).networkRoute, 'partner');
  assert.ok(getBusinessStats(lisa.game).rackCount > 0);
  assert.ok(getBusinessStats(grey.game).rackCount > 0);
  for (const rival of [lisa, grey]) {
    const finance = getFinanceStats(rival);
    assert.ok(finance.netFlow > 0);
    assert.ok(rival.game.money >= finance.reserve);
    assert.equal(finance.bankrupt, false);
  }
  assert.ok(race.logs.some(event => event.type === 'rival-business-upgrade'));
});

test('a letter changes actual customer prices, demand and support costs without creating sales', () => {
  const race = createRace(0);
  const player = establishCorrespondence(race);
  const before = getRaceStats(race).player;
  const opening = {cash: player.game.money, earned: player.game.totalEarned,
    revenue: player.finance.totalRevenue, costs: player.finance.totalCosts};
  assert.equal(before.narrative.pending.id, 'software-letter');
  assert.equal(chooseRaceNarrative(race, 'software-letter', 'anchor').ok, true);
  const after = getRaceStats(race).player;
  assert.equal(after.marketDemand, before.marketDemand - 1);
  assert.ok(Math.abs(after.finance.operatingCost - before.finance.operatingCost - .18) < 1e-8);
  assert.ok(Math.abs(after.business.revenueMultiplier / before.business.revenueMultiplier - 1.12) < 1e-8);
  assert.equal(after.incomeRate, after.finance.incomeRate);
  assert.equal(player.game.money, opening.cash);
  assert.equal(player.game.totalEarned, opening.earned);
  assert.equal(player.finance.totalRevenue, opening.revenue);
  assert.equal(player.finance.totalCosts, opening.costs);
  const invoice = player.game.activeJob;
  invoice.progress = invoice.work - .01;
  const reward = Math.round(invoice.reward * after.business.revenueMultiplier * 100) / 100;
  manualRaceCompute(race);
  assert.ok(Math.abs(player.game.totalEarned - opening.earned - reward) < 1e-8);
  assert.ok(Math.abs(player.finance.totalRevenue - opening.revenue - reward) < 1e-8);
  assert.equal(player.finance.totalCosts, opening.costs, 'answering or manually completing an invoice does not advance operating time');
  assert.equal(chooseRaceNarrative(race, 'software-letter', 'commons').ok, false, 'the same letter cannot be answered twice');
});

test('offline letters retain the same shared-clock chronology and economic consequences', () => {
  const race = createRace(0);
  establishCorrespondence(race);
  assert.equal(chooseRaceNarrative(race, 'software-letter', 'commons').ok, true);
  tickRace(race, 10);
  assert.equal(chooseRaceNarrative(race, 'network-night', 'shared').ok, true);
  const snapshot = serializeRace(race, 10000);
  const direct = structuredClone(race);
  tickRace(direct, 90);
  const loaded = restoreRace(snapshot, 100000);
  assert.ok(loaded);
  assert.deepEqual(playerFor(loaded).game.narrative, playerFor(direct).game.narrative);
  assert.deepEqual(getRaceStats(loaded).player.narrative.events.filter(event => event.id.endsWith(':later')).map(event => event.elapsed), [60, 70]);
  for (const key of ['money', 'totalEarned']) assert.ok(Math.abs(playerFor(loaded).game[key] - playerFor(direct).game[key]) < 1e-8, key);
  for (const key of ['totalCosts', 'totalRevenue']) assert.ok(Math.abs(playerFor(loaded).finance[key] - playerFor(direct).finance[key]) < 1e-8, key);
});

test('a rival headline leaves the player story open and a later delivery earns its own permanent ending', () => {
  const race = createRace(0);
  const player = establishCorrespondence(race);
  for (const [eventId, optionId] of [['software-letter', 'commons'], ['network-night', 'shared'], ['deployment-window', 'careful']]) {
    assert.equal(chooseRaceNarrative(race, eventId, optionId).ok, true);
  }
  const lisa = race.companies.find(company => company.id === 'lisa');
  establishProject(lisa);
  lisa.project = {phase: 'commercial', progress: 20000, work: 10000, commercialProgress: 9999, startedAt: 0, trainedAt: 0, completedAt: null};
  tickRace(race, 1);
  assert.equal(race.winnerId, 'lisa');
  assert.equal(getRaceStats(race).player.narrative.ending, null);
  player.project = {phase: 'commercial', progress: 20000, work: 10000, commercialProgress: 9999, startedAt: 0, trainedAt: 1, completedAt: null};
  tickRace(race, 1);
  const ending = structuredClone(getRaceStats(race).player.narrative.ending);
  assert.equal(ending.id, 'common-language');
  assert.equal(ending.evidence.result, 'late');
  assert.equal(getRaceStats(race).player.narrative.pending, null);
  assert.equal(chooseRaceNarrative(race, 'deployment-window', 'expand').ok, false);
  tickRace(race, 100);
  assert.deepEqual(getRaceStats(race).player.narrative.ending, ending);
  const restored = restoreRace(serializeRace(race, 102000), 102000);
  assert.ok(restored);
  assert.deepEqual(getRaceStats(restored).player.narrative.ending, ending);
});

test('bankruptcy closes pending mail and freezes the awarded archive through offline time', () => {
  const race = createRace(0);
  const player = establishCorrespondence(race);
  assert.equal(chooseRaceNarrative(race, 'software-letter', 'anchor').ok, true);
  player.game.money = 0;
  player.finance.debt = getFinanceStats(player).creditLimit - .01;
  player.game.activeJob.work = 1e9;
  player.game.queue = [];
  player.game.arrivalClock = 1000;
  tickRace(race, 1);
  assert.equal(player.finance.bankrupt, true);
  const archive = structuredClone(player.game.narrative);
  assert.equal(archive.ending.id, 'closure');
  assert.equal(getRaceStats(race).player.narrative.pending, null);
  assert.equal(chooseRaceNarrative(race, 'network-night', 'dedicated').ok, false);
  tickRace(race, 120);
  assert.deepEqual(player.game.narrative, archive);
  const restored = restoreRace(serializeRace(race, 121000), 241000);
  assert.ok(restored);
  assert.deepEqual(playerFor(restored).game.narrative, archive);
  assert.equal(getRaceStats(restored).player.finance.incomeRate, 0);
});

test('a tie between rivals does not claim that the later player delivery shared their headline', () => {
  const race = createRace(0);
  const player = establishCorrespondence(race);
  for (const company of race.companies.filter(company => company.id !== 'player')) {
    establishProject(company);
    company.project = {phase: 'commercial', progress: 20000, work: 10000, commercialProgress: 9999, startedAt: 0, trainedAt: 0, completedAt: null};
  }
  tickRace(race, 1);
  assert.equal(race.winnerId, 'tie');
  assert.deepEqual(race.milestones.commercial.winnerIds, ['lisa', 'grey']);
  player.project = {phase: 'commercial', progress: 20000, work: 10000, commercialProgress: 9999, startedAt: 0, trainedAt: 1, completedAt: null};
  tickRace(race, 1);
  const ending = getRaceStats(race).player.narrative.ending;
  assert.equal(ending.evidence.result, 'late');
  const restored = restoreRace(serializeRace(race, 2000), 2000);
  assert.ok(restored);
  assert.deepEqual(getRaceStats(restored).player.narrative.ending, ending);
});

test('a completed save from before letters existed can revisit its history before receiving an ending', () => {
  const race = createRace(0);
  const player = establishCorrespondence(race);
  player.project = {phase: 'complete', progress: 20000, work: 10000, commercialProgress: 10000, startedAt: 0, trainedAt: 0, completedAt: 0};
  player.milestones = {firstCapital: 0, gpt3: 0, commercial: 0};
  race.milestones.commercial = {winnerIds: ['player'], elapsed: 0};
  race.winnerId = 'player';
  race.status = 'finished';
  delete player.game.narrative;
  const loaded = restoreRace(serializeRace(race, 0), 0);
  assert.ok(loaded);
  assert.equal(getRaceStats(loaded).player.narrative.ending, null);
  assert.equal(getRaceStats(loaded).player.narrative.pending.id, 'software-letter');
  for (const [eventId, optionId] of [['software-letter', 'anchor'], ['network-night', 'dedicated'], ['deployment-window', 'expand']]) {
    assert.equal(chooseRaceNarrative(loaded, eventId, optionId).ok, true);
  }
  const ending = getRaceStats(loaded).player.narrative.ending;
  assert.equal(ending.id, 'signed-horizon');
  assert.equal(ending.evidence.result, 'won');
  assert.equal(ending.evidence.decisionCount, 3);
});
