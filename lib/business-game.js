/**
 * Fictional system R&D and business choices shared by the garage and PvE.
 * These improve customer value and system delivery, never single-chip FLOPs.
 * Costs are game currency; recurringCost is the PvE operating cost per second.
 */
import {getNarrativeEffects} from './game-narrative.js?v=narrative-branches-1';

export const BUSINESS_UPGRADES = [
  {id: 'pcie', name: 'PCIe 平台', subtitle: '客户带来了一台旧服务器', description: '联调负责人把服务器摆在门口：「卡是好卡，能接进我们现有的机器吗？老板不想再换一整套。」', baseCost: 450, maxLevel: 3, unlockEarned: 900, requires: {}, hardwareRequires: {dram: 1, scheduler: 1}, icon: '⇄', benefit: '解锁网络与机柜；Lv.2 起机柜项目交付 +3% / 级', recurringCost: 0.05},
  {id: 'cuda', name: 'CUDA 编程平台', subtitle: '一封没有署名的求助邮件', description: '邮件附着一份报错日志：「我不是做芯片的。只想让程序跑起来，能有人告诉我第一步怎么做吗？」工程师把它打印了出来。', baseCost: 300, maxLevel: 3, unlockEarned: 500, requires: {}, hardwareRequires: {scheduler: 1}, icon: '⌘', benefit: '订单单价 +6% / 级', recurringCost: 0.06},
  {id: 'libraries', name: '算子与通信库', subtitle: '小林又错过了末班车', description: '小林翻开三家客户的代码：「这段矩阵和通信程序，我已经改了三遍。能不能把它好好做成一份大家都能用的库？」', baseCost: 900, maxLevel: 3, unlockEarned: 1800, requires: {cuda: 1}, hardwareRequires: {tensor: 1}, icon: '▤', benefit: '系统项目交付 +8% / 级', recurringCost: 0.14},
  {id: 'nvlink', name: 'NVLink 互联研发', subtitle: '测试室里，灯只亮了一半', description: '工程师指着几块忙闲不一的板卡：「它们在等彼此的数据。我们有个互联原型，只是把它做出来，还要不少夜班。」', baseCost: 2500, maxLevel: 3, unlockEarned: 4000, requires: {pcie: 1}, hardwareRequires: {hbm: 1, tensor: 1}, icon: '⇆', benefit: '机柜项目交付 +16% / 级', recurringCost: 0.2},
  {id: 'ib_partner', name: 'IB 网络供应商合作', subtitle: '合作方把合约留在了门口', description: '老朋友打来电话：「设备可以先送过去。你们接客户，我们值夜班。后面的维护费按合约走。」落款处还空着。', baseCost: 3500, maxLevel: 1, unlockEarned: 6000, requires: {pcie: 1}, hardwareRequires: {}, icon: '↔', benefit: '客户需求 +2；解锁机柜；较高持续费用', route: 'partner', recurringCost: 1.25},
  {id: 'mellanox', name: '收购网络团队', subtitle: '几个人，带着旧机架来拜访', description: '网络团队的负责人说：「我们想把 IB 和以太网接着做下去。人可以过来，旧客户的工单也会一起过来。」他把一叠账本推到桌上。', baseCost: 10000, maxLevel: 1, unlockEarned: 12000, requires: {pcie: 1}, hardwareRequires: {}, icon: '◇', benefit: '客户需求 +3；解锁机柜；较低持续费用', route: 'acquire', recurringCost: 0.45},
  {id: 'rack', name: '机柜系统研发', subtitle: '客户寄来了一张机房平面图', description: '客户在平面图上画了个方框：「下次验收，我们想看到整柜一起工作。」电工量了一遍门宽，开始重新核对布线和软件清单。', baseCost: 5000, maxLevel: 3, unlockEarned: 9000, requires: {pcie: 1, libraries: 1}, hardwareRequires: {hbm: 1}, icon: '▥', benefit: '系统项目交付 +20%；客户需求 +1.25 / 级', recurringCost: 0.75},
  {id: 'developers', name: '开发者生态', subtitle: '讨论区里，有人回答了陌生人', description: '你们还没来得及回复的问题，已经有人写好了教程。署名你不认识。小林问：「要不要给这些人留一间能交流的地方？」', baseCost: 1800, maxLevel: 3, unlockEarned: 3000, requires: {cuda: 1, libraries: 1}, hardwareRequires: {}, icon: '◎', benefit: '订单单价 +10%；客户需求 +2 / 级', recurringCost: 0.2},
];

const UPGRADE_MAP = new Map(BUSINESS_UPGRADES.map(upgrade => [upgrade.id, upgrade]));
const HARDWARE_NAMES = {dram: '显存 DRAM', scheduler: 'Warp 调度器', tensor: 'Tensor Core', hbm: 'HBM 高带宽显存'};
const COST_GROWTH = 1.9;
const finite = (value, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const numericLevel = (value, maximum) => Math.floor(clamp(finite(value), 0, maximum));
const hasNetwork = levels => levels.ib_partner > 0 || levels.mellanox > 0;

export function createBusiness() {
  return {version: 1, levels: Object.fromEntries(BUSINESS_UPGRADES.map(upgrade => [upgrade.id, 0]))};
}

/**
 * Recover only known, possible investments. With game context, also validate
 * hardware and lifetime earnings after the caller has sanitized those fields.
 * Unsupported explicit versions reset rather than guessing future semantics.
 */
export function restoreBusiness(raw, game) {
  const restored = createBusiness();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      (raw.version !== undefined && raw.version !== 1)) return restored;
  for (const upgrade of BUSINESS_UPGRADES) {
    restored.levels[upgrade.id] = numericLevel(raw.levels?.[upgrade.id], upgrade.maxLevel);
  }
  // A malformed save with both routes chooses the higher-capital acquisition.
  if (restored.levels.mellanox) restored.levels.ib_partner = 0;
  let changed;
  do {
    changed = false;
    for (const upgrade of BUSINESS_UPGRADES) {
      if (!restored.levels[upgrade.id]) continue;
      const prerequisitesMet = Object.entries(upgrade.requires).every(([id, minimum]) => restored.levels[id] >= minimum);
      const hardwareMet = !game || Object.entries(upgrade.hardwareRequires).every(([id, minimum]) => finite(game.levels?.[id]) >= minimum);
      const earningsMet = !game || finite(game.totalEarned) >= upgrade.unlockEarned;
      if (!prerequisitesMet || !hardwareMet || !earningsMet || (upgrade.id === 'rack' && !hasNetwork(restored.levels))) {
        restored.levels[upgrade.id] = 0;
        changed = true;
      }
    }
  } while (changed);
  return restored;
}

function currentBusiness(game) {
  return restoreBusiness(game?.business, game);
}

function costAtLevel(upgrade, level) {
  return Math.ceil(upgrade.baseCost * COST_GROWTH ** level);
}

export function getBusinessUpgradeCost(game, id) {
  const upgrade = UPGRADE_MAP.get(id);
  if (!upgrade) return Infinity;
  const level = currentBusiness(game).levels[id];
  return level >= upgrade.maxLevel ? Infinity : costAtLevel(upgrade, level);
}

/** Pure purchase diagnostics; missing contains every unmet gate for the UI. */
export function getBusinessUpgradeStatus(game, id) {
  const upgrade = UPGRADE_MAP.get(id);
  if (!upgrade) return {ok: false, reason: '未知商业研发', cost: Infinity, level: 0, maxed: false, missing: []};
  const business = currentBusiness(game);
  const level = business.levels[id];
  const maxed = level >= upgrade.maxLevel;
  const cost = maxed ? Infinity : costAtLevel(upgrade, level);
  if (maxed) return {ok: false, reason: '已满级', cost, level, maxed, missing: []};
  const missing = [];
  const otherRoute = id === 'ib_partner' ? 'mellanox' : id === 'mellanox' ? 'ib_partner' : null;
  if (otherRoute && business.levels[otherRoute]) missing.push(otherRoute === 'mellanox' ? '网络团队已进驻，现有维护安排仍在执行' : '现有网络合作合约仍在执行');
  if (finite(game?.totalEarned) < upgrade.unlockEarned) missing.push(`累计收入达到 $${upgrade.unlockEarned}`);
  for (const [required, minimum] of Object.entries(upgrade.requires)) {
    if (business.levels[required] < minimum) missing.push(`${UPGRADE_MAP.get(required).name} Lv.${minimum}`);
  }
  for (const [required, minimum] of Object.entries(upgrade.hardwareRequires)) {
    if (finite(game?.levels?.[required]) < minimum) missing.push(`${HARDWARE_NAMES[required] || required} Lv.${minimum}`);
  }
  if (id === 'rack' && !hasNetwork(business.levels)) missing.push('机房网络的接入和维护尚未落实');
  if (finite(game?.money) < cost) missing.push(`资金 $${cost}`);
  return {ok: missing.length === 0, reason: missing.length ? missing.join('；') : '可以研发', cost, level, maxed, missing};
}

/** Spend current cash only; lifetime earned revenue never includes investment. */
export function buyBusinessUpgrade(game, id) {
  const status = getBusinessUpgradeStatus(game, id);
  if (!status.ok) return status;
  const business = currentBusiness(game);
  business.levels[id]++;
  game.money = Math.max(0, game.money - status.cost);
  game.business = business;
  return {...status, level: business.levels[id], maxed: business.levels[id] >= UPGRADE_MAP.get(id).maxLevel, reason: '研发完成'};
}

/**
 * Software raises customer value; racks/interconnects accelerate system
 * projects. PCIe supplies the rack baseline, and NVLink adds value only once
 * a rack and a network route exist. No metric changes the compute model.
 */
export function getBusinessStats(game) {
  const {levels} = currentBusiness(game);
  const networkRoute = levels.mellanox ? 'acquire' : levels.ib_partner ? 'partner' : 'none';
  const consequences = getNarrativeEffects(game);
  const revenueMultiplier = Math.min(1.6, 1 + levels.cuda * 0.06 + levels.developers * 0.1) * consequences.revenueMultiplier;
  const demandBonus = consequences.demandBonus + Math.min(12, levels.developers * 2 + levels.rack * 1.25 + (networkRoute === 'acquire' ? 3 : networkRoute === 'partner' ? 2 : 0));
  const nvlinkBonus = levels.rack && networkRoute !== 'none' ? levels.nvlink * 0.16 : 0;
  const pcieBonus = levels.rack ? Math.max(0, levels.pcie - 1) * 0.03 : 0;
  const projectMultiplier = Math.min(2.5, 1 + levels.libraries * 0.08 + levels.rack * 0.2 + nvlinkBonus + pcieBonus) * consequences.projectMultiplier;
  let operatingCost = 0;
  let investmentValue = 0;
  let installedCount = 0;
  for (const upgrade of BUSINESS_UPGRADES) {
    const count = levels[upgrade.id];
    operatingCost += upgrade.recurringCost * count;
    installedCount += count;
    for (let purchased = 0; purchased < count; purchased++) investmentValue += costAtLevel(upgrade, purchased);
  }
  // Round the accounting rate to remove binary float noise in saved finance.
  operatingCost = Math.max(0, Math.round((operatingCost + consequences.operatingCost) * 1e6) / 1e6);
  const softwareLevel = levels.cuda + levels.libraries + levels.developers;
  const summary = installedCount ? `软件生态 Lv.${softwareLevel} · ${levels.rack} 级机柜 · ${networkRoute === 'acquire' ? '自有网络团队' : networkRoute === 'partner' ? 'IB 供应商合作' : '机房网络尚未接入'}` : '尚未投入软件生态与系统研发';
  return {revenueMultiplier, demandBonus, projectMultiplier, operatingCost, investmentValue, networkRoute, softwareLevel, rackCount: levels.rack, installedCount, summary};
}
