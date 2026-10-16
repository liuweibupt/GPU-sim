/**
 * A deliberately fictional GPU idle economy. Work, clocks, prices and hit rates
 * are teaching/game units. Service rates come from the analytical compute model.
 * The module has no browser dependencies so saves and progression are testable.
 */
import {getWorkloadPerformance} from './compute-model.js';
import {createBusiness, restoreBusiness, getBusinessStats, buyBusinessUpgrade} from './business-game.js?v=narrative-branches-1';
import {createNarrative, restoreNarrative, updateNarrative, chooseNarrativeOption, getNarrativeEffects} from './game-narrative.js?v=narrative-branches-1';
export const UPGRADES = [
  {id: 'alu', name: '浮点 ALU', subtitle: '多一个工位，多一份算力', description: '增加一个浮点计算单元，增加计算吞吐；访存受限时收益可能很小。', baseCost: 18, maxLevel: 63, unlockEarned: 0, requires: [], icon: '＋', benefit: '+1 ALU'},
  {id: 'clock', name: '时钟升级', subtitle: '给车库一点频率', description: '每级增加 35% 基础时钟，也会增加功耗。', baseCost: 36, maxLevel: 8, unlockEarned: 0, requires: [], icon: '↗', benefit: '+35% 基础时钟 / 级'},
  {id: 'l1', name: 'L1 Cache', subtitle: '常用数据，就放手边', description: '缓存可复用的数据；卷积和矩阵订单获益更多，流式订单获益较少。', baseCost: 24, maxLevel: 4, unlockEarned: 0, requires: [], icon: '▤', benefit: '提高复用订单速度与命中率'},
  {id: 'dram', name: '显存 DRAM', subtitle: '终于不用逐个喂数据', description: '建立显存，改善供数能力，并解锁流式数据客户。', baseCost: 65, maxLevel: 4, unlockEarned: 50, requires: ['l1'], icon: '▥', benefit: '增加外部带宽，缩短供数等待'},
  {id: 'l2', name: '共享 L2', subtitle: '让多个工位共享成果', description: '让更多计算单元复用数据，进一步减少重复取数。', baseCost: 180, maxLevel: 4, unlockEarned: 160, requires: ['dram'], icon: '▦', benefit: '更高的复用速度与命中率'},
  {id: 'scheduler', name: 'Warp 调度器', subtitle: '等数据时，接着干活', description: '提高并发调度效率，更多客户会带着订单找上门。', baseCost: 130, maxLevel: 4, unlockEarned: 160, requires: ['dram'], icon: '⇄', benefit: '增加在途任务数与发射能力'},
  {id: 'tensor', name: 'Tensor Core', subtitle: '矩阵乘法，专岗专做', description: '解锁 GEMM 客户，明显加速矩阵、卷积和注意力工作负载。', baseCost: 420, maxLevel: 6, unlockEarned: 700, requires: ['l2', 'scheduler'], icon: '⊞', benefit: '矩阵订单专项加速'},
  {id: 'hbm', name: 'HBM 高带宽显存', subtitle: '给大模型加一条快车道', description: '提高供数能力，尤其适合流式和注意力订单。', baseCost: 1500, maxLevel: 4, unlockEarned: 2200, requires: ['dram', 'l2', 'tensor'], icon: '▰', benefit: '增加内存服务带宽'},
  {id: 'tma', name: 'TMA 异步搬运', subtitle: '搬运与计算，终于重叠', description: '解锁异步 Tile 工作负载，将供数与计算安排成流水线。', baseCost: 2400, maxLevel: 4, unlockEarned: 5000, requires: ['hbm', 'scheduler'], icon: '⇢', benefit: '异步 Tile 与矩阵订单加速'},
  {id: 'tmem', name: 'TMEM 张量存储', subtitle: '为矩阵中间结果留个座位', description: '解锁长序列注意力订单，提升张量中间结果的周转效率。', baseCost: 6500, maxLevel: 4, unlockEarned: 12000, requires: ['tma', 'tensor'], icon: '▧', benefit: '大矩阵与注意力订单加速'},
];

export const CHAPTERS = [
  {id: 'scalar', year: '起步', title: '小数事务所', subtitle: '先把第一份小数账算明白', description: '街角事务所送来一叠账单。老板临走前回头问：「天黑以前，能给我个准数吗？」你把第一张纸摊在还没擦干的工作台上。', work: 20, reward: 15, requires: {}, previous: null, icon: '＋'},
  {id: 'vector', year: '基础', title: '向量快递', subtitle: '不是一个数，是一整列数', description: '快递站的小哥把一长串路径留在桌上，头盔都没摘：「明早发车，车上的人都等着这份表。」外面的引擎声一直没有停。', work: 100, reward: 40, requires: {alu: 1}, previous: 'scalar', icon: '⇢'},
  {id: 'graphics', year: '图形', title: '像素工坊', subtitle: '每一个像素都想准时上色', description: '工作室只来了两个人，反复播放一段还没上色的演示。「下周第一次给别人看。」他们说完，又把那段视频从头放了一遍。', work: 260, reward: 100, requires: {alu: 2, l1: 1}, previous: 'vector', icon: '▦'},
  {id: 'physics', year: '并行', title: '物理沙盒', subtitle: '让粒子世界动起来', description: '仿真组展示的球体在屏幕里穿墙而过。研究员苦笑：「模型没写错，只是这一晚算不完。我们明天还得给实验室一个解释。」', work: 500, reward: 180, requires: {alu: 3, dram: 1}, previous: 'graphics', icon: '◌'},
  {id: 'alexnet', year: '2012', title: 'AlexNet 时刻', subtitle: '经营一阵之后，迎来图像识别大单', description: '研究团队从纸箱里倒出一堆图片。有人认得猫，有人认得汽车，机器还什么也认不出。「如果这次跑通，」小林说，「也许真会有人换一种方式看待我们。」', work: 3000, reward: 900, requires: {alu: 7, l1: 2, l2: 1, dram: 1, scheduler: 1}, previous: 'physics', icon: '◈'},
  {id: 'transformer', year: '2017', title: 'Attention 来敲门', subtitle: '模型应用走向大矩阵', description: '小林带来一份新的论文草稿，边角已经被翻软。「他们说只需要看看前面的词。」第一次运行还没结束，窗外已经亮了。', work: 6500, reward: 2200, requires: {tensor: 1, l2: 1, scheduler: 1}, previous: 'alexnet', icon: '✳'},
  {id: 'training', year: '训练', title: '大模型训练流水线', subtitle: '把一次次矩阵乘法接成生产线', description: '客户把漫长的训练任务交了过来，进度条像不会动一样。工程师轮流守着它，偶尔在群里发一句：「还在跑，今天没有掉。」', work: 24000, reward: 6500, requires: {tma: 1, hbm: 1, scheduler: 2}, previous: 'transformer', icon: '⇢'},
  {id: 'attention', year: '推理', title: '长序列推理', subtitle: '上下文更长，中间结果更多', description: '客户带来一本写满批注的长文：「前面答应的事情，后面就不该忘。」阿岚听完没接话，只在自己的工单本上多写了一行。', work: 90000, reward: 18000, requires: {tmem: 1, tensor: 2, hbm: 2}, previous: 'training', icon: '▧'},
  {id: 'factory', year: '2026 · 架空', title: 'AI 工厂开工', subtitle: '从一个 ALU 到整座算力工厂', description: '验收队伍约在清晨到。阿岚把车库那把旧钥匙放在机房窗台上，小林正在核对最后一份清单。所有人都想知道，这些年答应过的事情，今天能不能一起兑现。', work: 300000, reward: 50000, requires: {tmem: 2, tma: 2, tensor: 3, hbm: 3, alu: 7}, previous: 'attention', icon: '✦'},
];

const UPGRADE_MAP = new Map(UPGRADES.map(upgrade => [upgrade.id, upgrade]));
const CHAPTER_MAP = new Map(CHAPTERS.map(chapter => [chapter.id, chapter]));
const MAX_OFFLINE_SECONDS = 8 * 60 * 60;
const MAX_MONEY = 1e15;
const EPSILON = 1e-8;
const JOB_KINDS = ['fp32', 'stream', 'conv', 'gemm', 'async', 'attention'];
const TIER_SCALE = [1, 4, 14, 44, 130, 360];
const CLIENTS = ['周同学', '轨道工作室', '气象实验室', '像素面包房', '小林的机器人', '深夜研究组', '星图设计所', '云端研究社'];
const JOB_SPEC = {
  fp32: {name: 'FP32 向量计算', work: 7, reward: 5, reuse: 0.7},
  stream: {name: '流式数据归约', work: 9, reward: 7, reuse: 0.12},
  conv: {name: '图像卷积', work: 12, reward: 10, reuse: 1.1},
  gemm: {name: '矩阵乘法 GEMM', work: 16, reward: 13, reuse: 1.2},
  async: {name: '异步 Tile 计算', work: 24, reward: 20, reuse: 0.85},
  attention: {name: '长序列注意力', work: 36, reward: 30, reuse: 1.3},
};

const finite = (value, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const level = (state, id) => state.levels[id] || 0;

function addStory(state, id, message, type = 'story', elapsed = state.elapsed) {
  if (state.story.some(item => item.id === id)) return;
  state.story.push({id, type, message, elapsed});
  if (state.story.length > 40) state.story.shift();
}

function addEvent(events, event) {
  events.push(event);
  // A suspended browser can resume in one long tick. Preserve the application
  // completion notification even if hundreds of later ordinary orders finish.
  if (events.length > 64) {
    const expendable = events.findIndex(item => item.type === 'job-complete');
    events.splice(expendable < 0 ? 0 : expendable, 1);
  }
}

function recordNarrative(state, records, events = []) {
  for (const record of records) {
    const message = `${record.speaker}：${record.body}`;
    addStory(state, `narrative-${record.id}`, message, 'narrative', record.elapsed);
    addEvent(events, {type: 'narrative', id: record.id, message});
  }
  return events;
}

function syncNarrative(state, context, events = []) {
  return recordNarrative(state, updateNarrative(state, context), events);
}

function announceResearch(state, events) {
  for (const upgrade of UPGRADES) {
    if (!upgrade.unlockEarned || state.totalEarned < upgrade.unlockEarned ||
        state.story.some(item => item.id === `research-${upgrade.id}`)) continue;
    const message = `工程师把${upgrade.name}的图纸留在桌上，预算和联调清单夹在最后一页。`;
    addStory(state, `research-${upgrade.id}`, message, 'research-unlocked');
    addEvent(events, {type: 'research-unlocked', id: upgrade.id, message});
  }
}

function unlockedKinds(state) {
  return JOB_KINDS.filter(kind => kind === 'fp32' ||
    (kind === 'stream' && level(state, 'dram') > 0) ||
    (kind === 'conv' && level(state, 'alu') >= 3 && level(state, 'l1') > 0) ||
    (kind === 'gemm' && level(state, 'tensor') > 0) ||
    (kind === 'async' && level(state, 'tma') > 0) ||
    (kind === 'attention' && level(state, 'tmem') > 0));
}

function developmentTier(state) {
  const hardwareLevels = UPGRADES.reduce((sum, upgrade) => sum + level(state, upgrade.id), 0);
  return [4, 10, 18, 28, 40].filter(threshold => hardwareLevels >= threshold).length;
}

function makeJob(id, kind, tier = 0) {
  const spec = JOB_SPEC[kind];
  const variation = 0.85 + (id % 7) * 0.05;
  const a = ((id * 17) % 89 + 10) / 10;
  const b = ((id * 29) % 67 + 10) / 10;
  const scale = TIER_SCALE[tier];
  const expression = kind === 'fp32' ? `${a.toFixed(1)} × ${b.toFixed(1)} + 0.5` :
    kind === 'stream' ? `Σ FP32 · ${64 * scale} 元素` :
    kind === 'conv' ? `Conv 3×3 · ${16 * scale} 通道` :
    kind === 'gemm' ? `A × B · ${32 * scale} Tiles` :
    kind === 'async' ? `Load → GEMM · ${16 * scale} Tiles` :
    `Q × Kᵀ → V · ${128 * scale} Tokens`;
  return {id, kind, tier, client: CLIENTS[(id * 3) % CLIENTS.length], name: spec.name,
    work: Math.round(spec.work * scale * variation * 100) / 100, progress: 0,
    reward: Math.round(spec.reward * scale * variation), expression,
    result: kind === 'fp32' ? (a * b + 0.5).toFixed(2) : '计算完成'};
}

function random(state) {
  state.rng = (Math.imul(state.rng, 1664525) + 1013904223) >>> 0;
  return state.rng / 4294967296;
}

function newJob(state) {
  const kinds = unlockedKinds(state);
  const kind = kinds[Math.floor(random(state) * kinds.length)];
  return makeJob(state.nextJobId++, kind, developmentTier(state));
}

function arrivalInterval(state) {
  const customerInterest = Math.max(.75, 1 + .08 * getNarrativeEffects(state).demandBonus);
  return Math.max(0.35, 2.8 / ((1 + level(state, 'scheduler') * 0.8) * customerInterest));
}

function queueCapacity(state) {
  return 8 + level(state, 'dram') * 2 + level(state, 'scheduler') * 2;
}

function workloadRate(state, kind) {
  return getWorkloadPerformance(state.levels, kind).throughput;
}

function challengeKind(state) {
  const id = state.challenge?.id;
  const kind = ['scalar', 'vector', 'graphics'].includes(id) ? 'fp32' :
    id === 'physics' ? 'stream' : id === 'alexnet' ? 'conv' :
    id === 'transformer' ? 'gemm' : id === 'training' ? 'async' : 'attention';
  return kind;
}

function currentWorkloadKind(state) {
  return state.activeJob?.kind ?? (state.challenge ? challengeKind(state) : 'fp32');
}
function challengeRate(state) {
  const systemProject = ['training', 'attention', 'factory'].includes(state.challenge?.id);
  return workloadRate(state, challengeKind(state)) * (systemProject ? getBusinessStats(state).projectMultiplier : 1);
}

function completeJob(state, events) {
  const job = state.activeJob;
  if (!job || job.progress < job.work - EPSILON) return;
  const reward = Math.round(job.reward * getBusinessStats(state).revenueMultiplier * 100) / 100;
  state.money = Math.min(MAX_MONEY, state.money + reward);
  state.totalEarned = Math.min(MAX_MONEY, state.totalEarned + reward);
  state.completed++;
  addEvent(events, {type: 'job-complete', message: `${job.client} 的${job.name}完成，到账 $${reward}`, reward, jobId: job.id, kind: job.kind});
  announceResearch(state, events);
  state.activeJob = state.queue.shift() || null;
}

function completeChallenge(state, events) {
  if (!state.challenge || state.challenge.progress < state.challenge.work - EPSILON) return;
  const chapter = CHAPTER_MAP.get(state.challenge.id);
  if (!state.won.includes(chapter.id)) {
    state.won.push(chapter.id);
    state.money = Math.min(MAX_MONEY, state.money + chapter.reward);
    state.totalEarned = Math.min(MAX_MONEY, state.totalEarned + chapter.reward);
    const message = `${chapter.title}的验收单回来了。客户在签名旁写了句「谢谢」，尾款 $${chapter.reward} 已到账。`;
    addStory(state, `chapter-${chapter.id}`, message, 'challenge-complete');
    addEvent(events, {type: 'challenge-complete', id: chapter.id, message, reward: chapter.reward});
    announceResearch(state, events);
  }
  state.challenge = null;
}

export function createGame(now = Date.now()) {
  const state = {version: 1, money: 0, totalEarned: 0, completed: 0, flops: 0,
    levels: Object.fromEntries(UPGRADES.map(upgrade => [upgrade.id, 0])),
    business: createBusiness(),
    narrative: createNarrative(),
    queue: [makeJob(2, 'fp32'), makeJob(3, 'fp32')], activeJob: makeJob(1, 'fp32'),
    challenge: null, won: [], elapsed: 0, boostRemaining: 0,
    savedAt: finite(now, Date.now()), story: [], nextJobId: 4, arrivalClock: 0.8,
    rng: 0x48534952, lastManualAt: -1, clicks: 0};
  // Keep a canonical marker so older saves and callers migrate without resetting.
  state.performanceModel = 'analytical';
  addStory(state, 'garage', '雨从卷帘门下渗进来。黄Sir 把第一张客户便条压在账本上：「算好以后，给我打个电话。」车库里的 ALU 亮了。');
  syncNarrative(state, {mode: 'workshop'});
  return state;
}

export function getStats(state) {
  const kinds = unlockedKinds(state);
  const currentKind = currentWorkloadKind(state);
  const performance = getWorkloadPerformance(state.levels, currentKind);
  const throughput = kinds.reduce((sum,kind)=>sum+getWorkloadPerformance(state.levels,kind).throughput,0)/kinds.length;
  const hitRate = kinds.reduce((sum,kind)=>sum+getWorkloadPerformance(state.levels,kind).hitRate,0)/kinds.length;
  const tier = developmentTier(state);
  const scale = TIER_SCALE[tier];
  const averageReward = kinds.reduce((sum, kind) => sum + JOB_SPEC[kind].reward * scale, 0) / kinds.length;
  const challengeShare = state.challenge ? 0.3 : 1;
  const boost = state.boostRemaining > 0 ? 1.55 : 1;
  const business = getBusinessStats(state);
  const incomeRate = Math.min(throughput * boost * challengeShare / (kinds.reduce((sum,kind)=>sum+JOB_SPEC[kind].work*scale,0)/kinds.length), 1/arrivalInterval(state))*averageReward*business.revenueMultiplier;
  return {throughput, hitRate, incomeRate, performance, business, workloadName: JOB_SPEC[currentKind].name, aluCount: 1 + level(state, 'alu'),
    memoryLabel: level(state, 'hbm') ? `HBM ${level(state, 'hbm') * 8} GB` : level(state, 'dram') ? `DRAM ${level(state, 'dram') * 256} MB` : '无显存 · 逐项供数',
    cacheLabel: level(state, 'l2') ? `L1 ${level(state, 'l1') * 32} KB + L2 ${level(state, 'l2') * 256} KB` : level(state, 'l1') ? `L1 ${level(state, 'l1') * 32} KB` : '无缓存',
    power: Math.round((1 + level(state, 'alu')) * (1.5 + level(state, 'clock') * 0.8) + level(state, 'dram') * 2 + level(state, 'hbm') * 5 + level(state, 'tensor') * 3 + level(state, 'tma') + level(state, 'tmem') * 2),
    chapterIndex: state.won.length, developmentTier: tier, queueCapacity: queueCapacity(state), unlockedKinds: kinds,
    boosted: state.boostRemaining > 0};
}

export function getUpgradePreview(state, id) {
  const kind = currentWorkloadKind(state);
  const upgrade = UPGRADE_MAP.get(id);
  if (!upgrade || level(state,id) >= upgrade.maxLevel) return null;
  const before = getWorkloadPerformance(state.levels,kind);
  const after = getWorkloadPerformance({...state.levels,[id]:level(state,id)+1},kind);
  return {gain:after.throughput/before.throughput-1,before:before.cycles,after:after.cycles};
}

export function getUpgradeCost(state, id) {
  const upgrade = UPGRADE_MAP.get(id);
  if (!upgrade || level(state, id) >= upgrade.maxLevel) return Infinity;
  const growth = id === 'alu' ? 1.55 : id === 'clock' ? 1.85 : 2.05;
  return Math.ceil(upgrade.baseCost * growth ** level(state, id));
}

export function canBuyUpgrade(state, id) {
  const upgrade = UPGRADE_MAP.get(id);
  return Boolean(upgrade && level(state, id) < upgrade.maxLevel &&
    state.totalEarned >= upgrade.unlockEarned &&
    upgrade.requires.every(required => level(state, required) > 0) && state.money >= getUpgradeCost(state, id));
}

export function buyUpgrade(state, id, context = {mode: 'workshop'}) {
  if (!canBuyUpgrade(state, id)) return false;
  const cost = getUpgradeCost(state, id);
  state.money = Math.max(0, state.money - cost);
  state.levels[id]++;
  const upgrade = UPGRADE_MAP.get(id);
  if (level(state, id) === 1) {
    const extra = id === 'dram' ? ' 流式数据客户已解锁。' : id === 'tensor' ? ' GEMM 矩阵客户已解锁。' : id === 'tma' ? ' 异步 Tile 客户已解锁。' : id === 'tmem' ? ' 长序列注意力客户已解锁。' : '';
    addStory(state, `upgrade-${id}`, `黄Sir 签下了${upgrade.name}的到货单。工坊里响起新设备的低鸣。${extra}`, 'upgrade');
  }
  if (level(state, 'alu') >= 3 && level(state, 'l1') > 0) {
    addStory(state, 'workload-conv', '四个 ALU 与 L1 Cache 开始协作。图像卷积客户加入日常订单，应用任务仍可按自己的节奏挑战。', 'workload');
  }
  syncNarrative(state, context);
  return true;
}

export function buyGameBusinessUpgrade(state, id) {
  const result = buyBusinessUpgrade(state, id);
  if (!result.ok) return result;
  const notes = {
    pcie: '客户的服务器第一次认出了车库里的卡。联调群里有人发来一张亮灯的照片。',
    cuda: '工程师把安装包发了出去。深夜，邮箱里出现了第一封来自陌生开发者的信。',
    libraries: '那些反复手改的程序有了共同的接口。小林关掉终端，终于赶上了末班车。',
    nvlink: '两块板卡之间的指示灯同时亮起。实验室安静了几秒，然后有人笑出了声。',
    ib_partner: '合作方把网络设备送到门口，随箱附着一份维护合约和一个值班电话号码。',
    mellanox: '网络团队搬来了旧机架、工具箱和没有结清的客户工单。办公室多了几张新面孔。',
    rack: '机柜推过车库门槛时，大家一起抬了一把。它刚好挡住了墙上那张开业合照。',
    developers: '讨论区第一次出现了你们还没来得及写的教程，署名是一个从未见过的名字。',
  };
  if (result.level === 1) addStory(state, `business-upgrade-${id}`, notes[id], 'upgrade');
  syncNarrative(state, {mode: 'workshop'});
  return result;
}

export function chooseGameNarrative(state, eventId, optionId) {
  const result = chooseNarrativeOption(state, eventId, optionId, {mode: 'workshop'});
  if (result.ok) {
    recordNarrative(state, result.events || []);
    syncNarrative(state, {mode: 'workshop'});
  }
  return result;
}

/** Advance at event boundaries, including arrivals, completions and boost expiry. */
export function tickGame(state, seconds, context = {mode: 'workshop'}) {
  let remaining = clamp(finite(seconds), 0, MAX_OFFLINE_SECONDS);
  const events = [];
  let iterations = 0;
  while (remaining > EPSILON && iterations++ < 200000) {
    if (!state.activeJob) state.activeJob = state.queue.shift() || null;
    const boost = state.boostRemaining > EPSILON ? 1.55 : 1;
    const hasChallenge = Boolean(state.challenge);
    const customerRate = state.activeJob ? workloadRate(state, state.activeJob.kind) * boost * (hasChallenge ? 0.3 : 1) : 0;
    const bossRate = hasChallenge ? challengeRate(state) * boost * (state.activeJob ? 0.7 : 1) : 0;
    const jobTime = customerRate ? Math.max(0, state.activeJob.work - state.activeJob.progress) / customerRate : Infinity;
    const bossTime = bossRate ? Math.max(0, state.challenge.work - state.challenge.progress) / bossRate : Infinity;
    const step = Math.min(remaining, Math.max(0, state.arrivalClock), jobTime, bossTime,
      state.boostRemaining > EPSILON ? state.boostRemaining : Infinity);
    if (state.activeJob) state.activeJob.progress = Math.min(state.activeJob.work, state.activeJob.progress + step * customerRate);
    if (hasChallenge) state.challenge.progress = Math.min(state.challenge.work, state.challenge.progress + step * bossRate);
    state.flops += step * (customerRate + bossRate);
    state.elapsed += step;
    state.arrivalClock = Math.max(0, state.arrivalClock - step);
    state.boostRemaining = Math.max(0, state.boostRemaining - step);
    remaining -= step;
    completeJob(state, events);
    completeChallenge(state, events);
    syncNarrative(state, context, events);
    if (state.arrivalClock <= EPSILON) {
      // A full lobby does not punish the player; new clients keep arriving.
      if (state.queue.length < queueCapacity(state)) {
        const job = newJob(state);
        if (!state.activeJob) state.activeJob = job;
        else state.queue.push(job);
      }
      state.arrivalClock = arrivalInterval(state);
    }
  }
  syncNarrative(state, context, events);
  return events;
}

export function manualCompute(state, context = {mode: 'workshop'}) {
  // Real game time must advance between presses: synthetic click storms at the
  // same timestamp cannot generate arbitrary money or stack an infinite boost.
  if (state.elapsed - state.lastManualAt < 0.12 - EPSILON) return [];
  state.lastManualAt = state.elapsed;
  if (!state.activeJob) state.activeJob = state.queue.shift() || null;
  state.clicks++;
  state.boostRemaining = Math.min(3, state.boostRemaining + 0.8);
  const events = [];
  let work = Math.max(5, getStats(state).throughput * 0.18);
  if (state.challenge) {
    const used = Math.min(work * (state.activeJob ? 0.7 : 1), state.challenge.work - state.challenge.progress);
    state.challenge.progress += used;
    state.flops += used;
    work -= used;
    completeChallenge(state, events);
  }
  if (state.activeJob && work > 0) {
    // A click only contributes to this contract, so it cannot cash out the
    // entire queue when hardware becomes powerful.
    const used = Math.min(work, state.activeJob.work - state.activeJob.progress);
    state.activeJob.progress += used;
    state.flops += used;
    completeJob(state, events);
  }
  syncNarrative(state, context, events);
  return events;
}

export function startChallenge(state, id) {
  const chapter = CHAPTER_MAP.get(id);
  if (!chapter) return {ok: false, reason: '这段算力史还没有写到。'};
  if (state.won.includes(id)) return {ok: false, reason: '这一章已经完成，继续经营工厂吧。'};
  if (state.challenge) return {ok: false, reason: '先完成正在进行的挑战。'};
  if (chapter.previous && !state.won.includes(chapter.previous)) return {ok: false, reason: '先完成上一份应用任务。'};
  const missing = Object.entries(chapter.requires).filter(([required, minimum]) => level(state, required) < minimum);
  if (missing.length) return {ok: false, reason: `还需要：${missing.map(([required, minimum]) => `${UPGRADE_MAP.get(required).name} Lv.${minimum}`).join('、')}`};
  state.challenge = {id, progress: 0, work: chapter.work};
  addStory(state, `challenge-start-${id}`, `${chapter.year} · ${chapter.title}开始。70% 算力优先服务挑战，日常订单仍会继续。`, 'challenge-start');
  return {ok: true, reason: ''};
}

function sanitizeJob(raw, state, seen) {
  if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.id) || raw.id < 1 || raw.id > 1e12 || seen.has(raw.id)) return null;
  if (!unlockedKinds(state).includes(raw.kind)) return null;
  const tier = clamp(Math.floor(finite(raw.tier)), 0, developmentTier(state));
  // Rebuild client text, prices and workloads from canonical definitions. A
  // malformed save cannot inject HTML, negative work or an enormous payout.
  const job = makeJob(raw.id, raw.kind, tier);
  job.progress = clamp(finite(raw.progress), 0, Math.max(0, job.work - EPSILON * 2));
  seen.add(job.id);
  return job;
}

export function restoreGame(raw, now = Date.now(), context = {mode: 'workshop'}) {
  const timestamp = finite(now, Date.now());
  const fresh = () => ({state: createGame(timestamp), offline: {seconds: 0, earned: 0, completed: 0}});
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return fresh(); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1 ||
      !data.levels || typeof data.levels !== 'object' || Array.isArray(data.levels) ||
      typeof data.money !== 'number' || !Number.isFinite(data.money) || data.money < 0) return fresh();
  // Model selection is retired. Rebuild the economy with the analytical model
  // before offline catch-up, regardless of a legacy save's model marker.
  const state = createGame(timestamp);
  state.money = clamp(data.money, 0, MAX_MONEY);
  state.totalEarned = clamp(finite(data.totalEarned, state.money), state.money, MAX_MONEY);
  state.completed = clamp(Math.floor(finite(data.completed)), 0, 1e12);
  state.flops = clamp(finite(data.flops), 0, 1e18);
  state.elapsed = clamp(finite(data.elapsed), 0, 1e12);
  for (const upgrade of UPGRADES) {
    state.levels[upgrade.id] = clamp(Math.floor(finite(data.levels[upgrade.id])), 0, upgrade.maxLevel);
    if (state.totalEarned < upgrade.unlockEarned || upgrade.requires.some(required => !state.levels[required])) state.levels[upgrade.id] = 0;
  }
  state.business = restoreBusiness(data.business, state);
  state.won = [];
  for (const chapter of CHAPTERS) {
    if (!Array.isArray(data.won) || !data.won.includes(chapter.id)) break;
    // Completed chapters need valid hardware too; a corrupt future chapter
    // cannot unlock its workload or offline economy out of order.
    if (Object.entries(chapter.requires).some(([required, minimum]) => level(state, required) < minimum)) break;
    state.won.push(chapter.id);
  }
  state.challenge = null;
  if (data.challenge && typeof data.challenge === 'object') {
    const chapter = CHAPTER_MAP.get(data.challenge.id);
    if (chapter && !state.won.includes(chapter.id) && (!chapter.previous || state.won.includes(chapter.previous)) &&
        Object.entries(chapter.requires).every(([required, minimum]) => level(state, required) >= minimum)) {
      state.challenge = {id: chapter.id, work: chapter.work, progress: clamp(finite(data.challenge.progress), 0, chapter.work - EPSILON * 2)};
    }
  }
  const seen = new Set();
  state.activeJob = sanitizeJob(data.activeJob, state, seen);
  state.queue = (Array.isArray(data.queue) ? data.queue.slice(0, queueCapacity(state)) : [])
    .map(job => sanitizeJob(job, state, seen)).filter(Boolean);
  state.nextJobId = clamp(Math.floor(finite(data.nextJobId, 1)), 1, 1e12);
  for (const id of seen) state.nextJobId = Math.max(state.nextJobId, id + 1);
  state.rng = finite(data.rng, state.rng) >>> 0;
  state.arrivalClock = clamp(finite(data.arrivalClock, arrivalInterval(state)), 0, arrivalInterval(state));
  state.boostRemaining = clamp(finite(data.boostRemaining), 0, 3);
  state.lastManualAt = clamp(finite(data.lastManualAt, -1), -1, state.elapsed);
  state.clicks = clamp(Math.floor(finite(data.clicks)), 0, 1e12);
  state.story = (Array.isArray(data.story) ? data.story.slice(-40) : state.story).filter(item => item &&
    typeof item.id === 'string' && typeof item.message === 'string').map(item => ({
      id: item.id.slice(0, 80), type: typeof item.type === 'string' ? item.type.slice(0, 40) : 'story',
      message: item.message.slice(0, 300), elapsed: clamp(finite(item.elapsed), 0, state.elapsed),
    }));
  state.narrative = restoreNarrative(data.narrative, state, context);
  const savedAt = finite(data.savedAt, timestamp);
  const seconds = clamp((timestamp - savedAt) / 1000, 0, MAX_OFFLINE_SECONDS);
  const beforeMoney = state.money;
  const beforeCompleted = state.completed;
  tickGame(state, seconds, context);
  state.savedAt = timestamp;
  return {state, offline: {seconds, earned: state.money - beforeMoney, completed: state.completed - beforeCompleted}};
}

export function serializeGame(state, now = Date.now()) {
  state.savedAt = finite(now, Date.now());
  return JSON.stringify(state);
}
