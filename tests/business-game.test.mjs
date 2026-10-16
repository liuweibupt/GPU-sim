import test from 'node:test';
import assert from 'node:assert/strict';
import {getWorkloadPerformance} from '../lib/compute-model.js';
import {
  BUSINESS_UPGRADES, createBusiness, restoreBusiness, getBusinessUpgradeCost,
  getBusinessUpgradeStatus, buyBusinessUpgrade, getBusinessStats,
} from '../lib/business-game.js';

const readyGame = () => ({money: 1e7, totalEarned: 1e7, levels: {dram: 1, scheduler: 1, tensor: 1, hbm: 1}, business: createBusiness()});
function purchase(game, ...ids) {
  for (const id of ids) assert.equal(buyBusinessUpgrade(game, id).ok, true, id);
}

test('old saves default to zero investments and queries do not mutate them', () => {
  const game = {money: 0, totalEarned: 0, levels: {}};
  const before = structuredClone(game);
  const stats = getBusinessStats(game);
  assert.deepEqual(game, before);
  assert.equal(stats.revenueMultiplier, 1);
  assert.equal(stats.projectMultiplier, 1);
  assert.equal(stats.operatingCost, 0);
  assert.equal(stats.investmentValue, 0);
  assert.equal(stats.networkRoute, 'none');
  assert.equal(stats.installedCount, 0);
  assert.deepEqual(restoreBusiness(undefined), createBusiness());
  const first = createBusiness();
  first.levels.cuda = 1;
  assert.equal(createBusiness().levels.cuda, 0);
});

test('purchases enforce earned revenue, cash, chip prerequisites and business prerequisites', () => {
  const game = readyGame();
  game.totalEarned = 499;
  assert.match(getBusinessUpgradeStatus(game, 'cuda').reason, /累计收入/);
  assert.equal(buyBusinessUpgrade(game, 'cuda').ok, false);
  game.totalEarned = 1e7;
  game.levels.scheduler = 0;
  assert.match(getBusinessUpgradeStatus(game, 'cuda').reason, /Warp/);
  assert.equal(buyBusinessUpgrade(game, 'cuda').ok, false);
  game.levels.scheduler = 1;
  game.money = 299;
  assert.match(getBusinessUpgradeStatus(game, 'cuda').reason, /资金/);
  assert.equal(buyBusinessUpgrade(game, 'cuda').ok, false);
  game.money = 1e7;
  assert.match(getBusinessUpgradeStatus(game, 'libraries').reason, /CUDA/);
  assert.equal(buyBusinessUpgrade(game, 'libraries').ok, false);
  purchase(game, 'cuda', 'libraries');
  assert.equal(game.business.levels.libraries, 1);
  assert.equal(getBusinessUpgradeCost(game, 'missing'), Infinity);
  const before = structuredClone(game);
  assert.equal(buyBusinessUpgrade(game, 'missing').ok, false);
  assert.deepEqual(game, before);
});

test('investment spends cash exactly once, grows by 1.9 and does not create earned revenue', () => {
  const game = readyGame();
  const earned = game.totalEarned;
  const cash = game.money;
  purchase(game, 'cuda');
  assert.equal(game.money, cash - 300);
  assert.equal(game.totalEarned, earned);
  assert.equal(getBusinessUpgradeCost(game, 'cuda'), 570);
  purchase(game, 'cuda', 'cuda');
  assert.equal(game.money, cash - 300 - 570 - 1083);
  assert.equal(getBusinessStats(game).investmentValue, 1953);
  assert.equal(getBusinessUpgradeCost(game, 'cuda'), Infinity);
  assert.equal(getBusinessUpgradeStatus(game, 'cuda').maxed, true);
  const before = structuredClone(game);
  assert.equal(buyBusinessUpgrade(game, 'cuda').ok, false);
  assert.deepEqual(game, before);
});

test('supplier and acquisition routes trade capital for upkeep and remain exclusive', () => {
  const partner = readyGame();
  const acquired = readyGame();
  purchase(partner, 'pcie', 'ib_partner');
  purchase(acquired, 'pcie', 'mellanox');
  const partnerStats = getBusinessStats(partner);
  const acquiredStats = getBusinessStats(acquired);
  assert.equal(partnerStats.networkRoute, 'partner');
  assert.equal(acquiredStats.networkRoute, 'acquire');
  assert.ok(partnerStats.investmentValue < acquiredStats.investmentValue);
  assert.ok(partnerStats.operatingCost > acquiredStats.operatingCost);
  assert.equal(buyBusinessUpgrade(partner, 'mellanox').ok, false);
  assert.equal(buyBusinessUpgrade(acquired, 'ib_partner').ok, false);
  assert.match(getBusinessUpgradeStatus(partner, 'mellanox').reason, /合约仍在执行/);
});

test('software improves customer value and projects independently of the single-GPU model', () => {
  const game = readyGame();
  const hardwareBefore = structuredClone(game.levels);
  const performanceBefore = getWorkloadPerformance(game.levels, 'gemm');
  purchase(game, 'cuda', 'libraries', 'developers');
  const stats = getBusinessStats(game);
  assert.ok(stats.revenueMultiplier > 1);
  assert.ok(stats.demandBonus > 0);
  assert.ok(stats.projectMultiplier > 1);
  assert.equal(stats.rackCount, 0);
  assert.equal(stats.softwareLevel, 3);
  assert.deepEqual(game.levels, hardwareBefore);
  assert.deepEqual(getWorkloadPerformance(game.levels, 'gemm'), performanceBefore);
});

test('PCIe racks work without NVLink, while NVLink pays off only in networked rack projects', () => {
  const game = readyGame();
  purchase(game, 'pcie', 'cuda', 'libraries');
  const softwareOnly = getBusinessStats(game).projectMultiplier;
  purchase(game, 'nvlink');
  assert.equal(getBusinessStats(game).projectMultiplier, softwareOnly);
  assert.equal(game.business.levels.pcie, 1, 'PCIe coexists with NVLink');
  assert.equal(buyBusinessUpgrade(game, 'rack').ok, false);
  assert.match(getBusinessUpgradeStatus(game, 'rack').reason, /网络.*尚未落实/);
  purchase(game, 'ib_partner');
  assert.equal(getBusinessStats(game).projectMultiplier, softwareOnly, 'network alone does not activate NVLink');
  purchase(game, 'rack');
  assert.ok(Math.abs(getBusinessStats(game).projectMultiplier - (softwareOnly + 0.2 + 0.16)) < 1e-12);
  const pcieOnly = readyGame();
  purchase(pcieOnly, 'pcie', 'cuda', 'libraries', 'ib_partner', 'rack');
  assert.ok(getBusinessStats(pcieOnly).projectMultiplier > softwareOnly);
  assert.ok(getBusinessStats(pcieOnly).projectMultiplier < getBusinessStats(game).projectMultiplier);
});

test('higher PCIe levels improve rack project delivery while preserving standalone and single-chip rates', () => {
  const game = readyGame();
  const hardwareBefore = structuredClone(game.levels);
  const performanceBefore = getWorkloadPerformance(game.levels, 'gemm');
  purchase(game, 'pcie');
  const standalone = getBusinessStats(game).projectMultiplier;
  purchase(game, 'pcie', 'pcie');
  assert.equal(getBusinessStats(game).projectMultiplier, standalone, 'a platform alone does not accelerate system projects');
  purchase(game, 'cuda', 'libraries', 'ib_partner', 'rack');
  const pcieThree = getBusinessStats(game).projectMultiplier;
  const pcieOne = structuredClone(game);
  pcieOne.business.levels.pcie = 1;
  const pcieTwo = structuredClone(game);
  pcieTwo.business.levels.pcie = 2;
  assert.ok(Math.abs(getBusinessStats(pcieTwo).projectMultiplier - getBusinessStats(pcieOne).projectMultiplier - 0.03) < 1e-12);
  assert.ok(Math.abs(pcieThree - getBusinessStats(pcieTwo).projectMultiplier - 0.03) < 1e-12);
  assert.deepEqual(game.levels, hardwareBefore);
  assert.deepEqual(getWorkloadPerformance(game.levels, 'gemm'), performanceBefore);
});

test('restoration bounds numeric levels, strips unknown data, and prunes broken dependency trees', () => {
  const raw = {version: 1, levels: {pcie: 100, cuda: 1.9, libraries: 9, developers: 2, rack: 3, nvlink: NaN, ib_partner: 1, mellanox: 1, unknown: 99}, unknown: true};
  const restored = restoreBusiness(raw);
  assert.equal(restored.levels.pcie, 3);
  assert.equal(restored.levels.cuda, 1);
  assert.equal(restored.levels.libraries, 3);
  assert.equal(restored.levels.nvlink, 0);
  assert.equal(restored.levels.ib_partner, 0);
  assert.equal(restored.levels.mellanox, 1);
  assert.equal(restored.levels.rack, 3);
  assert.equal('unknown' in restored, false);
  assert.equal('unknown' in restored.levels, false);
  assert.deepEqual(restoreBusiness(JSON.parse(JSON.stringify(restored))), restored);
  assert.deepEqual(restoreBusiness({...raw, version: 2}), createBusiness());
  assert.deepEqual(restoreBusiness({...raw, version: '1'}), createBusiness());
  const broken = restoreBusiness({levels: {cuda: -3, libraries: 3, developers: 3, rack: 3, pcie: Infinity, ib_partner: 1, nvlink: '2'}});
  assert.deepEqual(broken, createBusiness());
  const noRoute = restoreBusiness({levels: {pcie: 1, cuda: 1, libraries: 1, rack: 2}});
  assert.equal(noRoute.levels.rack, 0);
  assert.equal(noRoute.levels.libraries, 1);
});

test('restoration with game context also rejects missing hardware and insufficient lifetime earnings', () => {
  const raw = {version: 1, levels: Object.fromEntries(BUSINESS_UPGRADES.map(upgrade => [upgrade.id, upgrade.maxLevel]))};
  const game = readyGame();
  game.levels.scheduler = 0;
  assert.deepEqual(restoreBusiness(raw, game), createBusiness());
  game.levels.scheduler = 1;
  game.totalEarned = 800;
  const early = restoreBusiness(raw, game);
  assert.equal(early.levels.cuda, 3);
  assert.equal(early.levels.pcie, 0);
  assert.equal(early.levels.libraries, 0);
  assert.equal(early.levels.rack, 0);
});

test('maximum investment bonuses stay bounded with finite upkeep and book value', () => {
  const game = readyGame();
  purchase(game, 'pcie', 'cuda', 'libraries', 'mellanox', 'rack', 'nvlink', 'developers');
  for (const upgrade of BUSINESS_UPGRADES.filter(item => !item.route)) {
    while (getBusinessUpgradeStatus(game, upgrade.id).ok) purchase(game, upgrade.id);
  }
  const before = structuredClone(game);
  const stats = getBusinessStats(game);
  assert.ok(stats.revenueMultiplier > 1 && stats.revenueMultiplier <= 1.6);
  assert.ok(stats.demandBonus > 0 && stats.demandBonus <= 12);
  assert.ok(stats.projectMultiplier > 1 && stats.projectMultiplier <= 2.5);
  assert.ok(Number.isFinite(stats.operatingCost) && stats.operatingCost > 0);
  assert.ok(Number.isFinite(stats.investmentValue) && stats.investmentValue > 10000);
  assert.equal(stats.rackCount, 3);
  assert.equal(stats.installedCount, 19);
  assert.equal(stats.softwareLevel, 9);
  assert.deepEqual(game, before);
});
