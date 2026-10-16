import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame, UPGRADES, buyUpgrade, getStats} from '../lib/idle-game.js';
import {buyBusinessUpgrade, getBusinessStats} from '../lib/business-game.js';
import {chooseNarrativeOption} from '../lib/game-narrative.js';
import {createFinance, restoreFinance, getFinanceStats, getMarketDemand, getProjectedRevenue,
  quoteIPO, executeIPO, quoteBuyback, executeBuyback, settleFinance, updateValuation} from '../lib/pve-market.js';

const near = (a, b, message = '') => assert.ok(Math.abs(a - b) < 1e-6, `${message}: ${a} vs ${b}`);
const company = () => ({id: 'player', name: '黄Sir', game: createGame(0), finance: createFinance(), project: {phase: 'locked'}});
function settle(c, seconds, revenue, elapsed = seconds) {
  c.game.money += revenue;
  c.game.totalEarned += revenue;
  return settleFinance(c, seconds, revenue, elapsed);
}
function equip(c, levels) {
  c.game.money = 1e12;
  c.game.totalEarned = 1e12;
  for (const upgrade of UPGRADES) for (let level = 0; level < (levels[upgrade.id] || 0); level++) assert.equal(buyUpgrade(c.game, upgrade.id), true);
  c.game.money = 0;
  c.game.totalEarned = 12000;
}

test('one ALU starts with a positive operating margin and empty cash has a credit grace period', () => {
  const c = company();
  const stats = getFinanceStats(c);
  assert.ok(stats.operatingCost > .15 && stats.operatingCost < .17);
  assert.ok(stats.netFlow > .5);
  assert.equal(stats.creditLimit, 250);
  assert.equal(stats.ownership, 1);
  assert.equal(stats.runway, null);
  settle(c, 5, 0);
  assert.equal(c.game.money, 0);
  near(c.finance.debt, stats.operatingCost * 5);
  assert.equal(c.finance.bankrupt, false);
});

test('settlement never credits revenue twice and obeys cash/debt ledger conservation', () => {
  const c = company();
  c.game.money = 3;
  c.finance.debt = 50;
  const openingEquity = c.game.money - c.finance.debt;
  const cost = getFinanceStats(c).operatingCost * 10;
  settle(c, 10, 20);
  near(c.finance.debt, 30);
  near(c.game.money, 3 - cost);
  near(c.game.money - c.finance.debt, openingEquity + 20 - cost);
  assert.equal(c.finance.totalRevenue, 20);
  near(c.finance.totalCosts, cost);
  assert.equal(c.game.totalEarned, 20);
});

test('constant income and hardware settle identically in one step and many steps', () => {
  for (const [cash, debt, rate] of [[10, 50, .05], [10, 50, 2], [0, 0, .1], [10, 1, .2]]) {
    const whole = company();
    whole.game.money = cash;
    whole.finance.debt = debt;
    const split = structuredClone(whole);
    settle(whole, 60, rate * 60, 60);
    for (let time = 1; time <= 60; time++) settle(split, 1, rate, time);
    near(whole.game.money, split.game.money);
    near(whole.finance.debt, split.finance.debt);
    near(whole.finance.totalRevenue, split.finance.totalRevenue);
    near(whole.finance.totalCosts, split.finance.totalCosts);
  }
});

test('IPO requires operational sales, issues exactly 250 shares once and never unlocks research', () => {
  const c = company();
  c.game.money = 1000;
  assert.equal(quoteIPO(c).ok, false);
  c.game.totalEarned = 600;
  const quote = quoteIPO(c);
  const before = c.game.money;
  assert.equal(quote.ok, true);
  assert.ok(quote.proceeds >= 250);
  const result = executeIPO(c);
  assert.equal(result.ok, true);
  near(c.game.money, before + quote.proceeds);
  assert.equal(c.game.totalEarned, 600);
  assert.equal(c.finance.totalRevenue, 0);
  assert.equal(c.finance.outstandingShares, 1250);
  assert.equal(c.finance.founderShares, 1000);
  assert.equal(c.finance.publicShares, 250);
  assert.equal(getFinanceStats(c).ownership, .8);
  const cash = c.game.money;
  assert.equal(executeIPO(c).ok, false);
  assert.equal(c.game.money, cash);
});

test('fair IPO and buyback preserve share price, exact cash accounting and share supply', () => {
  const c = company();
  c.game.money = 2000;
  c.game.totalEarned = 800;
  const price = getFinanceStats(c).price;
  executeIPO(c);
  near(getFinanceStats(c).price, price);
  const cash = c.game.money;
  const result = executeBuyback(c, 50);
  assert.equal(result.ok, true);
  near(c.game.money, cash - result.cost);
  near(getFinanceStats(c).price, price);
  assert.equal(c.finance.publicShares, 200);
  assert.equal(c.finance.treasuryShares, 50);
  assert.equal(c.finance.outstandingShares, 1200);
  assert.equal(c.finance.founderShares + c.finance.publicShares, c.finance.outstandingShares);
  assert.equal(c.finance.outstandingShares + c.finance.treasuryShares, 1250);
  near(getFinanceStats(c).ownership, 1000 / 1200);
  assert.equal(c.game.totalEarned, 800);
});

test('buyback cannot exceed public float or consume ten-second operating reserve', () => {
  const c = company();
  c.game.totalEarned = 600;
  assert.equal(quoteBuyback(c, 1).ok, false);
  executeIPO(c);
  for (const shares of [-1, 0, .5, NaN, Infinity, 251, '5']) assert.equal(quoteBuyback(c, shares).ok, false);
  c.finance.debt = 1;
  assert.equal(quoteBuyback(c, 1).ok, false);
  c.finance.debt = 0;
  c.game.money = getFinanceStats(c).reserve;
  const before = structuredClone(c);
  assert.equal(executeBuyback(c, 1).ok, false);
  assert.deepEqual(c, before);
});

test('buying all float removes exactly IPO cash and cannot create a repeatable financing loop', () => {
  const c = company();
  c.game.money = 2000;
  c.game.totalEarned = 800;
  const openingCash = c.game.money;
  executeIPO(c);
  assert.equal(executeBuyback(c, 250).ok, true);
  near(c.game.money, openingCash);
  assert.equal(c.finance.publicShares, 0);
  assert.equal(c.finance.outstandingShares, 1000);
  assert.equal(getFinanceStats(c).ownership, 1);
  assert.equal(executeIPO(c).ok, false);
  assert.equal(executeBuyback(c, 1).ok, false);
});

test('bankruptcy happens at the debt line once and cannot be rescued after closure', () => {
  const c = company();
  c.finance.debt = 249.9;
  const events = settle(c, 1, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'bankrupt');
  assert.equal(events[0].companyId, 'player');
  assert.equal(c.finance.bankrupt, true);
  assert.equal(c.game.money, 0);
  const costs = c.finance.totalCosts;
  const debt = c.finance.debt;
  assert.deepEqual(settle(c, 10, 100), []);
  assert.equal(c.game.money, 0);
  assert.equal(c.finance.totalCosts, costs);
  assert.equal(c.finance.debt, debt);
  assert.equal(executeIPO(c).ok, false);
  assert.equal(executeBuyback(c, 1).ok, false);
});

test('credit expands from genuine sales, stays bounded and excludes IPO proceeds', () => {
  const c = company();
  c.game.totalEarned = 600;
  const line = getFinanceStats(c).creditLimit;
  executeIPO(c);
  assert.equal(getFinanceStats(c).creditLimit, line);
  c.game.totalEarned = 1e9;
  assert.equal(getFinanceStats(c).creditLimit, 2000);
});

test('specialized market demand and project diversion expose a real overexpansion loss', () => {
  const c = company();
  equip(c, {alu: 12, clock: 4, l1: 3, dram: 3, l2: 3, scheduler: 3, tensor: 4, hbm: 3, tma: 3, tmem: 3});
  assert.equal(getMarketDemand(c), 17);
  assert.ok(getStats(c.game).incomeRate > getMarketDemand(c));
  c.project.phase = 'training';
  near(getProjectedRevenue(c), 5.1);
  const stats = getFinanceStats(c);
  assert.ok(stats.netFlow < -5, `overexpanded margin is ${stats.netFlow}`);
  assert.ok(stats.runway > 0 && stats.runway < 300);
  // Real published hardware levels, normal revenue and no injected debt.
  let event;
  for (let time = 1; time <= 400; time++) {
    event = settle(c, 1, getProjectedRevenue(c), time).find(item => item.type === 'bankrupt');
    if (event) break;
  }
  assert.ok(event, 'finite operating losses must reach the bankruptcy line');
  assert.equal(c.finance.bankrupt, true);
});

test('a disciplined matrix business has positive normal margin and a measurable training reserve', () => {
  const c = company();
  equip(c, {alu: 7, l1: 2, dram: 1, l2: 2, scheduler: 2, tensor: 2, hbm: 1});
  assert.equal(getMarketDemand(c), 11);
  assert.ok(getFinanceStats(c).netFlow > 5);
  c.project.phase = 'training';
  c.game.money = 100;
  const stats = getFinanceStats(c);
  assert.ok(stats.netFlow > -1);
  settle(c, 120, getProjectedRevenue(c) * 120, 120);
  assert.equal(c.finance.bankrupt, false);
  assert.ok(c.game.money >= 0);
});

test('price sampling is bounded, spaced, monotone and serializable', () => {
  const c = company();
  for (let time = 0; time < 2000; time++) updateValuation(c, time);
  assert.equal(c.finance.history.length, 120);
  for (let i = 1; i < c.finance.history.length; i++) assert.ok(c.finance.history[i].elapsed - c.finance.history[i - 1].elapsed >= 5);
  const before = c.finance.history.length;
  updateValuation(c, 1);
  assert.equal(c.finance.history.length, before);
  assert.doesNotThrow(() => JSON.stringify(c.finance));
  assert.deepEqual(restoreFinance(c.finance), c.finance);
});

test('finance restore rejects corrupted balances, share exploits and invalid history without touching game', () => {
  const raw = {listed: true, founderShares: -100, publicShares: 1000000, outstandingShares: Infinity,
    treasuryShares: -1, debt: -1, totalCosts: NaN, totalRevenue: Infinity, price: -10,
    history: [{elapsed: 10, price: 2}, {elapsed: 1, price: 3}, {elapsed: 2, price: 4},
      {elapsed: -1, price: 2}, {elapsed: 20, price: NaN}, {elapsed: 30, price: 0}],
    game: {money: 1e20}};
  const frozen = structuredClone(raw);
  const restored = restoreFinance(raw);
  assert.deepEqual(raw, frozen);
  assert.equal(restored.founderShares, 1000);
  assert.equal(restored.publicShares, 250);
  assert.equal(restored.outstandingShares, 1250);
  assert.equal(restored.treasuryShares, 0);
  assert.equal(restored.debt, 0);
  assert.equal(restored.totalCosts, 0);
  assert.equal(restored.totalRevenue, 0);
  assert.equal(restored.price, 1);
  assert.equal('game' in restored, false);
  assert.deepEqual(restored.history, [{elapsed: 1, price: 3}, {elapsed: 10, price: 2}]);
  assert.deepEqual(restoreFinance(null), createFinance());
  assert.deepEqual(restoreFinance('bad'), createFinance());
  const privateCompany = restoreFinance({listed: false, publicShares: 250, treasuryShares: 250});
  assert.equal(privateCompany.outstandingShares, 1000);
  assert.equal(privateCompany.publicShares, 0);
});

test('invalid settlement time is inert and finance queries never mutate malformed input', () => {
  const c = company();
  for (const time of [-1, NaN, Infinity, '1']) {
    const before = structuredClone(c);
    assert.deepEqual(settleFinance(c, time, 10, 1), []);
    assert.deepEqual(c, before);
  }
  const beforeZero = structuredClone(c);
  assert.deepEqual(settleFinance(c, 0, 0, 1), []);
  assert.deepEqual(c, beforeZero);
  const corrupt = {game: {money: -10, totalEarned: NaN, levels: {alu: Infinity}}, finance: {debt: -10}};
  const before = structuredClone(corrupt);
  const stats = getFinanceStats(corrupt);
  assert.deepEqual(corrupt, before);
  assert.equal(stats.cash, 0);
  assert.equal(stats.debt, 0);
  assert.ok(Number.isFinite(stats.operatingCost));
});


test('instant manual revenue settles debt without charging another operating step', () => {
  const c = company();
  c.finance.debt = 10;
  settle(c, 0, 15, 0);
  assert.equal(c.game.money, 5);
  assert.equal(c.finance.debt, 0);
  assert.equal(c.finance.totalRevenue, 15);
  assert.equal(c.finance.totalCosts, 0);
});


test('IPO rejects a cash-cap overflow instead of issuing shares for clipped proceeds', () => {
  const c = company();
  c.game.money = 1e15;
  c.game.totalEarned = 600;
  const before = structuredClone(c);
  assert.equal(executeIPO(c).ok, false);
  assert.deepEqual(c, before);
});

test('system and ecosystem investments affect demand, costs and assets without contaminating hardware', () => {
  const c = company();
  equip(c, {alu: 7, l1: 2, dram: 1, l2: 2, scheduler: 2, tensor: 2, hbm: 1});
  c.game.money = 60000;
  const baseFinance = getFinanceStats(c);
  const baseStats = getStats(c.game);
  const baseDemand = getMarketDemand(c);
  const earned = c.game.totalEarned;
  const costs = c.finance.totalCosts;
  for (const id of ['cuda', 'pcie', 'libraries', 'nvlink', 'ib_partner', 'rack', 'developers']) {
    assert.equal(buyBusinessUpgrade(c.game, id).ok, true, id);
  }
  const business = getBusinessStats(c.game);
  const stats = getStats(c.game);
  const finance = getFinanceStats(c);
  assert.ok(business.demandBonus > 0);
  assert.ok(business.operatingCost > 0);
  assert.ok(business.investmentValue > 0);
  near(getMarketDemand(c), baseDemand + business.demandBonus);
  near(finance.operatingCost, baseFinance.operatingCost + business.operatingCost);
  near(finance.equipmentValue, baseFinance.equipmentValue + business.investmentValue);
  near(stats.incomeRate, baseStats.incomeRate * business.revenueMultiplier);
  assert.equal(stats.power, baseStats.power);
  assert.equal(c.game.totalEarned, earned);
  assert.equal(c.finance.totalRevenue, 0);
  assert.equal(c.finance.totalCosts, costs);
  c.project.phase = 'training';
  near(getProjectedRevenue(c), Math.min(stats.incomeRate, getMarketDemand(c)) * .3);
  // The same hardware key still represents only hardware in the shared cache.
  const plain = company();
  equip(plain, c.game.levels);
  near(getFinanceStats(plain).operatingCost, baseFinance.operatingCost);
  near(getFinanceStats(plain).equipmentValue, baseFinance.equipmentValue);
});

test('finance reads sanitize system saves and never mutate the source business', () => {
  const c = company();
  c.game.business = {levels: {cuda: 1e99, pcie: -10, rack: 100, mellanox: Infinity}, networkRoute: 'acquire'};
  const before = structuredClone(c);
  const stats = getFinanceStats(c);
  assert.deepEqual(c, before);
  assert.ok(Number.isFinite(stats.operatingCost));
  assert.ok(Number.isFinite(stats.equipmentValue));
  const plain = getFinanceStats(company());
  near(stats.operatingCost, plain.operatingCost);
  near(stats.equipmentValue, plain.equipmentValue);
});

test('canonical customer commitments survive pure finance reads and balance through settlement', () => {
  const c = company();
  equip(c, {alu: 7, l1: 2, dram: 1, l2: 2, scheduler: 2, tensor: 2, hbm: 1});
  c.game.money = 5000;
  assert.equal(buyBusinessUpgrade(c.game, 'cuda').ok, true);
  const baseline = getFinanceStats(c);
  const demand = getMarketDemand(c);
  assert.equal(chooseNarrativeOption(c.game, 'software-letter', 'anchor', {mode: 'pve', elapsed: 0}).ok, true);
  c.game.narrative.effects = {revenueMultiplier: 1e99, demandBonus: 1e99, operatingCost: -1e99};
  c.game.narrative.events.push({id: 'injected', title: '<script>', body: '<script>', elapsed: 0});
  const source = structuredClone(c);
  const stats = getFinanceStats(c);
  assert.deepEqual(c, source, 'reading a company must not rewrite its saved letters');
  near(stats.operatingCost, baseline.operatingCost + .18);
  near(getMarketDemand(c), demand - 1);
  near(stats.incomeRate, Math.min(getStats(c.game).incomeRate, getMarketDemand(c)));
  near(stats.equipmentValue, baseline.equipmentValue, 'a support promise is not equipment');
  c.finance.debt = 30;
  const opening = c.game.money - c.finance.debt;
  settle(c, 10, 20, 10);
  near(c.game.money - c.finance.debt, opening + 20 - stats.operatingCost * 10);
  near(c.finance.totalRevenue, 20);
  near(c.finance.totalCosts, stats.operatingCost * 10);
});
