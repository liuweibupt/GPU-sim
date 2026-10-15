/**
 * Fictional business accounting for the PvE race, in game dollars and seconds.
 * Revenue is credited by the race BEFORE settlement. Financing is never sales.
 * Queries do not mutate a company; actions mutate only its cash and finance.
 */
import {UPGRADES, getStats} from './idle-game.js?v=analytical-1';

const MAX_VALUE = 1e15;
const FOUNDER_SHARES = 1000;
const IPO_SHARES = 250;
const IPO_EARNED = 600;
const EPSILON = 1e-8;
const runtimeFinance = new WeakSet();
const hardwareCache = new Map();
const finite = (value, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const amount = value => clamp(finite(value), 0, MAX_VALUE);
const count = (value, max) => Math.floor(clamp(finite(value), 0, max));

export function createFinance() {
  const finance = {version: 1, listed: false, outstandingShares: FOUNDER_SHARES,
    founderShares: FOUNDER_SHARES, publicShares: 0, treasuryShares: 0,
    debt: 0, totalCosts: 0, totalRevenue: 0, ipoProceeds: 0, buybackSpent: 0,
    bankrupt: false, price: 1, history: [], lastValuationAt: -5};
  runtimeFinance.add(finance);
  return finance;
}

export function restoreFinance(raw) {
  const finance = createFinance();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return finance;
  finance.listed = raw.listed === true;
  finance.bankrupt = raw.bankrupt === true;
  // The only share operations are one 250-share issue and public-float buybacks.
  // Reconstruct supply rather than trusting independently editable save fields.
  finance.publicShares = finance.listed ? count(raw.publicShares, IPO_SHARES) : 0;
  finance.treasuryShares = finance.listed ? IPO_SHARES - finance.publicShares : 0;
  finance.outstandingShares = FOUNDER_SHARES + finance.publicShares;
  for (const key of ['debt', 'totalCosts', 'totalRevenue', 'ipoProceeds', 'buybackSpent']) finance[key] = amount(raw[key]);
  finance.price = clamp(finite(raw.price, 1), 1, MAX_VALUE);
  const samples = Array.isArray(raw.history) ? raw.history.filter(point => point &&
    Number.isFinite(point.elapsed) && point.elapsed >= 0 &&
    Number.isFinite(point.price) && point.price >= 1).map(point => ({
      elapsed: amount(point.elapsed), price: clamp(point.price, 1, MAX_VALUE),
    })).sort((a, b) => a.elapsed - b.elapsed) : [];
  for (const point of samples) {
    if (!finance.history.length || point.elapsed - finance.history.at(-1).elapsed >= 5 - EPSILON) finance.history.push(point);
  }
  finance.history = finance.history.slice(-120);
  finance.lastValuationAt = finance.history.at(-1)?.elapsed ?? -5;
  return finance;
}

function ensureFinance(company) {
  if (!runtimeFinance.has(company.finance)) company.finance = restoreFinance(company.finance);
  return company.finance;
}

function readFinance(raw) {
  const listed = raw?.listed === true;
  const publicShares = listed ? count(raw?.publicShares, IPO_SHARES) : 0;
  return {listed, publicShares, founderShares: FOUNDER_SHARES,
    treasuryShares: listed ? IPO_SHARES - publicShares : 0,
    outstandingShares: FOUNDER_SHARES + publicShares, bankrupt: raw?.bankrupt === true,
    debt: amount(raw?.debt), totalCosts: amount(raw?.totalCosts), totalRevenue: amount(raw?.totalRevenue)};
}

function safeGame(company) {
  const game = company?.game || {};
  return {money: amount(game.money), totalEarned: amount(game.totalEarned),
    levels: Object.fromEntries(UPGRADES.map(upgrade => [upgrade.id, count(game.levels?.[upgrade.id], upgrade.maxLevel)])),
    won: Array.isArray(game.won) ? game.won : [], boostRemaining: 0, challenge: null};
}

/** Demand limits stop idle-tier rewards from making every expansion profitable. */
export function getMarketDemand(company, knownStats) {
  const stats = knownStats || getStats(safeGame(company));
  return 2 + 3 * (stats.unlockedKinds.length - 1);
}

export function getProjectedRevenue(company, knownStats) {
  const stats = knownStats || getStats(safeGame(company));
  const activeProject = ['training', 'commercial'].includes(company?.project?.phase);
  return Math.min(stats.incomeRate, getMarketDemand(company, stats)) * (activeProject ? .3 : 1);
}

function hardwareEconomy(game, stats) {
  const key = UPGRADES.map(upgrade => game.levels[upgrade.id]).join(',');
  if (hardwareCache.has(key)) return hardwareCache.get(key);
  let value = 18; // The original one-ALU workstation also has a small book value.
  let hardwareCount = 1;
  for (const upgrade of UPGRADES) {
    const growth = upgrade.id === 'alu' ? 1.55 : upgrade.id === 'clock' ? 1.85 : 2.05;
    hardwareCount += game.levels[upgrade.id];
    for (let level = 0; level < game.levels[upgrade.id]; level++) value += Math.ceil(upgrade.baseCost * growth ** level);
  }
  const result = {equipmentValue: Math.min(MAX_VALUE, value * .5),
    operatingCost: .1 + .02 * stats.power + .004 * stats.power ** 1.65 + .008 * hardwareCount ** 1.6};
  if (hardwareCache.size >= 256) hardwareCache.delete(hardwareCache.keys().next().value);
  hardwareCache.set(key, result);
  return result;
}

export function getOperatingCost(company, knownStats) {
  const game = safeGame(company);
  return hardwareEconomy(game, knownStats || getStats(game)).operatingCost;
}

export function getFinanceStats(company) {
  const finance = readFinance(company?.finance);
  const game = safeGame(company);
  const stats = getStats(game);
  const {operatingCost, equipmentValue} = hardwareEconomy(game, stats);
  const incomeRate = finance.bankrupt ? 0 : getProjectedRevenue(company, stats);
  const netFlow = finance.bankrupt ? 0 : incomeRate - operatingCost;
  const creditLimit = Math.min(2000, 250 + .1 * game.totalEarned);
  const equity = game.money + equipmentValue - finance.debt;
  const estimatedValue = Math.max(0, equity) + incomeRate * 90 + Math.max(0, netFlow) * 90;
  const price = finance.bankrupt ? 1 : clamp(estimatedValue / finance.outstandingShares, 1, MAX_VALUE);
  const loss = Math.max(0, -netFlow);
  return {price, marketCap: price * finance.outstandingShares,
    ownership: finance.founderShares / finance.outstandingShares,
    publicShares: finance.publicShares, treasuryShares: finance.treasuryShares,
    outstandingShares: finance.outstandingShares, founderShares: finance.founderShares,
    listed: finance.listed, bankrupt: finance.bankrupt, cash: game.money,
    debt: finance.debt, operatingCost, incomeRate, netFlow, creditLimit,
    runway: loss > EPSILON ? Math.max(0, game.money + creditLimit - finance.debt) / loss : null,
    cashRunway: loss > EPSILON ? game.money / loss : null,
    equity, equipmentValue, reserve: operatingCost * 10,
    bankruptcyRatio: clamp(finance.debt / creditLimit, 0, 1),
    totalCosts: finance.totalCosts, totalRevenue: finance.totalRevenue,
    ipoEligible: !finance.listed && !finance.bankrupt && game.totalEarned >= IPO_EARNED};
}

export function quoteIPO(company) {
  const stats = getFinanceStats(company);
  const proceeds = stats.price * IPO_SHARES;
  const reason = stats.bankrupt ? '公司已破产，需重开竞赛。' :
    stats.listed ? '已经上市，每场竞赛只能 IPO 一次。' :
    amount(company?.game?.totalEarned) < IPO_EARNED ? '累计订单收入达到 $600 后才能 IPO。' :
    proceeds > MAX_VALUE - stats.cash ? '公司现金已接近本场资金上限，无法继续融资。' : '';
  return {ok: !reason, reason, message: reason || `发行 ${IPO_SHARES} 股，获得 $${proceeds.toFixed(2)}，创始持股降至 80%。`,
    shares: IPO_SHARES, price: stats.price, proceeds};
}

export function executeIPO(company) {
  const quote = quoteIPO(company);
  if (!quote.ok) return quote;
  ensureFinance(company);
  company.finance.listed = true;
  company.finance.publicShares = IPO_SHARES;
  company.finance.treasuryShares = 0;
  company.finance.outstandingShares = FOUNDER_SHARES + IPO_SHARES;
  company.finance.ipoProceeds = quote.proceeds;
  company.game.money = Math.min(MAX_VALUE, amount(company.game.money) + quote.proceeds);
  company.finance.price = getFinanceStats(company).price;
  return quote;
}

export function quoteBuyback(company, shares) {
  const stats = getFinanceStats(company);
  const validCount = Number.isSafeInteger(shares) && shares > 0;
  const cost = validCount ? shares * stats.price : 0;
  const reason = stats.bankrupt ? '公司已破产，需重开竞赛。' :
    !stats.listed ? '先完成 IPO，才有可回购的流通股。' :
    !validCount ? '回购数量必须为正整数。' :
    shares > stats.publicShares ? `流通股只有 ${stats.publicShares} 股。` :
    stats.debt > EPSILON ? '先偿清运营欠款，再进行回购。' :
    cost > stats.cash - stats.reserve + EPSILON ? '回购后须保留至少 10 秒运营费用。' : '';
  return {ok: !reason, reason, message: reason || `回购 ${shares} 股，花费 $${cost.toFixed(2)}。`, cost, price: stats.price, shares: validCount ? shares : 0};
}

export function executeBuyback(company, shares) {
  const quote = quoteBuyback(company, shares);
  if (!quote.ok) return quote;
  ensureFinance(company);
  company.game.money = Math.max(0, amount(company.game.money) - quote.cost);
  company.finance.publicShares -= shares;
  company.finance.treasuryShares += shares;
  company.finance.outstandingShares -= shares;
  company.finance.buybackSpent = Math.min(MAX_VALUE, company.finance.buybackSpent + quote.cost);
  company.finance.price = getFinanceStats(company).price;
  return quote;
}

/**
 * The caller has already credited revenue to game.money and game.totalEarned.
 * Use incremental revenue to repay debt, then cash to pay costs, borrowing only
 * the remainder. No interest is compounded and no income is credited here.
 */
export function settleFinance(company, seconds, revenue, elapsed = 0) {
  if (!company?.game || !Number.isFinite(seconds) || seconds < 0 || (seconds === 0 && amount(revenue) === 0)) return [];
  const finance = ensureFinance(company);
  const creditedRevenue = amount(revenue);
  company.game.money = amount(company.game.money);
  if (finance.bankrupt) {
    // A stopped company cannot be restarted by a caller accidentally adding cash.
    company.game.money = Math.max(0, company.game.money - creditedRevenue);
    return [];
  }
  const stats = getFinanceStats(company);
  const repayment = Math.min(finance.debt, creditedRevenue, company.game.money);
  finance.debt -= repayment;
  company.game.money -= repayment;
  const costs = Math.min(MAX_VALUE, stats.operatingCost * seconds);
  const paid = Math.min(company.game.money, costs);
  company.game.money -= paid;
  finance.debt = Math.min(MAX_VALUE, finance.debt + costs - paid);
  finance.totalCosts = Math.min(MAX_VALUE, finance.totalCosts + costs);
  finance.totalRevenue = Math.min(MAX_VALUE, finance.totalRevenue + creditedRevenue);
  if (finance.debt >= stats.creditLimit - EPSILON) {
    finance.bankrupt = true;
    finance.price = 1;
    return [{type: 'bankrupt', companyId: company.id, elapsed: amount(elapsed),
      message: `${company.name || '公司'} 的运营欠款达到 $${stats.creditLimit.toFixed(0)} 破产线，停止接单。`}];
  }
  return [];
}

export function updateValuation(company, elapsed = 0) {
  const finance = ensureFinance(company);
  const time = amount(elapsed);
  const stats = getFinanceStats(company);
  finance.price = stats.price;
  if (time >= finance.lastValuationAt + 5 - EPSILON) {
    finance.history.push({elapsed: time, price: stats.price});
    finance.history = finance.history.slice(-120);
    finance.lastValuationAt = time;
  }
  return stats;
}
