import test from 'node:test';
import assert from 'node:assert/strict';
import {RACE_COMPANIES, RACE_MILESTONES, GPT3_REQUIREMENTS, PROJECT_PROFILE, RACE_UPGRADES, createRace, tickRace, getRaceStats, getRaceUpgradeCost, canBuyRaceUpgrade, buyRaceUpgrade, manualRaceCompute, startRaceProject, restoreRace, serializeRace} from '../lib/pve-race.js';
import {getFinanceStats, executeIPO} from '../lib/pve-market.js';
import {getWorkloadPerformance} from '../lib/compute-model.js';

const playerFor = race => race.companies.find(company => company.id === 'player');
const PLAYER_PLAN = ['alu', 'l1', 'alu', 'dram', 'clock', 'alu', 'scheduler', 'l2', 'alu', 'clock', 'alu', 'tensor', 'l1', 'alu', 'scheduler', 'l2', 'tensor', 'alu', 'hbm'];

function establishProject(company) {
  company.game.totalEarned = 10000;
  company.game.money = 3000;
  for (const [id, required] of Object.entries(GPT3_REQUIREMENTS)) company.game.levels[id] = required;
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
  const game = structuredClone(player.game);
  const project = structuredClone(player.project);
  assert.equal(buyRaceUpgrade(race, 'alu').ok, false);
  assert.equal(startRaceProject(race).ok, false);
  assert.deepEqual(manualRaceCompute(race), []);
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
