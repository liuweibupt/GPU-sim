/**
 * Fictional system R&D and business choices shared by the garage and PvE.
 * These improve customer value and system delivery, never single-chip FLOPs.
 * Costs are game currency; recurringCost is the PvE operating cost per second.
 */
export const BUSINESS_UPGRADES = [
  {id: 'pcie', name: 'PCIe 平台', subtitle: '把芯片接进客户的服务器', description: '研发主机与加速卡之间的 PCIe 平台。它也是机柜的基础连接路径，可以与 NVLink 同时使用；建成机柜后，Lv.2 与 Lv.3 各增加 3% 系统项目交付加成。', baseCost: 450, maxLevel: 3, unlockEarned: 900, requires: {}, hardwareRequires: {dram: 1, scheduler: 1}, icon: '⇄', benefit: '解锁网络与机柜；Lv.2 起机柜项目交付 +3% / 级', recurringCost: 0.05},
  {id: 'cuda', name: 'CUDA 编程平台', subtitle: '让客户能把程序跑起来', description: '投入编译器、工具链与开发文档，为客户提供编译、调试与部署支持，提升服务价格。', baseCost: 300, maxLevel: 3, unlockEarned: 500, requires: {}, hardwareRequires: {scheduler: 1}, icon: '⌘', benefit: '订单单价 +6% / 级', recurringCost: 0.06},
  {id: 'libraries', name: '算子与通信库', subtitle: '把工具链变成好用的软件栈', description: '研发矩阵算子、模型适配与集合通信库，改善系统项目交付。软件库在尚未组建机柜时也有价值。', baseCost: 900, maxLevel: 3, unlockEarned: 1800, requires: {cuda: 1}, hardwareRequires: {tensor: 1}, icon: '▤', benefit: '系统项目交付 +8% / 级', recurringCost: 0.14},
  {id: 'nvlink', name: 'NVLink 互联研发', subtitle: '让多颗 GPU 协同工作', description: '内部研发 GPU 间互联技术。与 PCIe 平台共存，配合网络路线和机柜后提升多 GPU 项目交付。', baseCost: 2500, maxLevel: 3, unlockEarned: 4000, requires: {pcie: 1}, hardwareRequires: {hbm: 1, tensor: 1}, icon: '⇆', benefit: '机柜项目交付 +16% / 级', recurringCost: 0.2},
  {id: 'ib_partner', name: 'IB 网络供应商合作', subtitle: '先租用成熟的网络能力', description: '向网络供应商采购 InfiniBand 能力。前期投入较低、持续费用较高；与收购网络团队路线互斥。', baseCost: 3500, maxLevel: 1, unlockEarned: 6000, requires: {pcie: 1}, hardwareRequires: {}, icon: '↔', benefit: '客户需求 +2；解锁机柜；较高持续费用', route: 'partner', recurringCost: 1.25},
  {id: 'mellanox', name: '收购网络团队', subtitle: '把网络能力纳入自己的研发', description: '架空商业收购，灵感来自 NVIDIA 收购 Mellanox；获得 IB 与以太网团队。前期投入较高、持续费用较低，与供应商合作路线互斥。', baseCost: 10000, maxLevel: 1, unlockEarned: 12000, requires: {pcie: 1}, hardwareRequires: {}, icon: '◇', benefit: '客户需求 +3；解锁机柜；较低持续费用', route: 'acquire', recurringCost: 0.45},
  {id: 'rack', name: '机柜系统研发', subtitle: '从一块卡到一整柜的交付', description: '把 GPU、PCIe、网络与软件库集成为机柜。先选择网络路线；没有 NVLink 时使用 PCIe 连接，有 NVLink 后进一步改善多 GPU 项目。', baseCost: 5000, maxLevel: 3, unlockEarned: 9000, requires: {pcie: 1, libraries: 1}, hardwareRequires: {hbm: 1}, icon: '▥', benefit: '系统项目交付 +20%；客户需求 +1.25 / 级', recurringCost: 0.75},
  {id: 'developers', name: '开发者生态', subtitle: '让更多人愿意长期选择平台', description: '建设教程、社区、开发者支持与软件合作，增加客户需求和服务溢价。生态投入需要编程平台与软件库共同支撑。', baseCost: 1800, maxLevel: 3, unlockEarned: 3000, requires: {cuda: 1, libraries: 1}, hardwareRequires: {}, icon: '◎', benefit: '订单单价 +10%；客户需求 +2 / 级', recurringCost: 0.2},
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
  if (otherRoute && business.levels[otherRoute]) missing.push(`已选择${UPGRADE_MAP.get(otherRoute).name}路线`);
  if (finite(game?.totalEarned) < upgrade.unlockEarned) missing.push(`累计收入达到 $${upgrade.unlockEarned}`);
  for (const [required, minimum] of Object.entries(upgrade.requires)) {
    if (business.levels[required] < minimum) missing.push(`${UPGRADE_MAP.get(required).name} Lv.${minimum}`);
  }
  for (const [required, minimum] of Object.entries(upgrade.hardwareRequires)) {
    if (finite(game?.levels?.[required]) < minimum) missing.push(`${HARDWARE_NAMES[required] || required} Lv.${minimum}`);
  }
  if (id === 'rack' && !hasNetwork(business.levels)) missing.push('选择 IB 供应商合作或收购网络团队');
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
  const revenueMultiplier = Math.min(1.6, 1 + levels.cuda * 0.06 + levels.developers * 0.1);
  const demandBonus = Math.min(12, levels.developers * 2 + levels.rack * 1.25 + (networkRoute === 'acquire' ? 3 : networkRoute === 'partner' ? 2 : 0));
  const nvlinkBonus = levels.rack && networkRoute !== 'none' ? levels.nvlink * 0.16 : 0;
  const pcieBonus = levels.rack ? Math.max(0, levels.pcie - 1) * 0.03 : 0;
  const projectMultiplier = Math.min(2.5, 1 + levels.libraries * 0.08 + levels.rack * 0.2 + nvlinkBonus + pcieBonus);
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
  operatingCost = Math.round(operatingCost * 1e6) / 1e6;
  const softwareLevel = levels.cuda + levels.libraries + levels.developers;
  const summary = installedCount ? `软件生态 Lv.${softwareLevel} · ${levels.rack} 级机柜 · ${networkRoute === 'acquire' ? '自有网络团队' : networkRoute === 'partner' ? 'IB 供应商合作' : '网络路线未选择'}` : '尚未投入软件生态与系统研发';
  return {revenueMultiplier, demandBonus, projectMultiplier, operatingCost, investmentValue, networkRoute, softwareLevel, rackCount: levels.rack, installedCount, summary};
}
