import {workshopPerformance, previewWorkshopUpgrade, diagnoseWorkshop} from './workshop-sim.js';
/**
 * A deliberately fictional GPU idle economy. Work, clocks, prices and hit rates
 * are teaching/game units. Service rates come from workshop-sim resource scheduling.
 * The module has no browser dependencies so saves and progression are testable.
 */
import {getWorkloadPerformance} from './compute-model.js';
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
  {id: 'scalar', year: '起步', title: '小数事务所', subtitle: '先把第一份小数账算明白', description: '街角事务所送来一叠浮点账单。一个 ALU 就能处理：先完成小委托，再决定下一笔钱怎么花。', work: 20, reward: 15, requires: {}, previous: null, icon: '＋'},
  {id: 'vector', year: '基础', title: '向量快递', subtitle: '不是一个数，是一整列数', description: '快递站要批量计算路径权重。多一个 ALU，让成组的浮点运算也能准时交付。', work: 100, reward: 40, requires: {alu: 1}, previous: 'scalar', icon: '⇢'},
  {id: 'graphics', year: '图形', title: '像素工坊', subtitle: '每一个像素都想准时上色', description: '独立游戏工作室带来一批像素着色任务。更多 ALU 配上一块 L1 Cache，把重复取数省下来。', work: 260, reward: 100, requires: {alu: 2, l1: 1}, previous: 'vector', icon: '▦'},
  {id: 'physics', year: '并行', title: '物理沙盒', subtitle: '让粒子世界动起来', description: '仿真团队想让一群粒子碰撞、弹跳和漂浮。显存存下状态，并行计算负责更新每一个时间步。', work: 500, reward: 180, requires: {alu: 3, dram: 1}, previous: 'graphics', icon: '◌'},
  {id: 'alexnet', year: '2012', title: 'AlexNet 时刻', subtitle: '经营一阵之后，迎来图像识别大单', description: '研究团队带来卷积神经网络训练。八个 ALU、两级缓存、显存和调度器组成协作团队，接下这份更大的应用委托。', work: 3000, reward: 900, requires: {alu: 7, l1: 2, l2: 1, dram: 1, scheduler: 1}, previous: 'physics', icon: '◈'},
  {id: 'transformer', year: '2017', title: 'Attention 来敲门', subtitle: '模型应用走向大矩阵', description: '研究组带来注意力模型计算。使用适合自己的机器完成委托；硬件研发仍按经营积累独立推进。', work: 6500, reward: 2200, requires: {tensor: 1, l2: 1, scheduler: 1}, previous: 'alexnet', icon: '✳'},
  {id: 'training', year: '训练', title: '大模型训练流水线', subtitle: '把一次次矩阵乘法接成生产线', description: '训练服务商带来一批多阶段矩阵任务。让异步搬运和计算协作，按时完成训练流水线验收。', work: 24000, reward: 6500, requires: {tma: 1, hbm: 1, scheduler: 2}, previous: 'transformer', icon: '⇢'},
  {id: 'attention', year: '推理', title: '长序列推理', subtitle: '上下文更长，中间结果更多', description: '客户想处理更长的上下文。利用张量存储周转中间结果，为这份注意力应用交出答卷。', work: 90000, reward: 18000, requires: {tmem: 1, tensor: 2, hbm: 2}, previous: 'training', icon: '▧'},
  {id: 'factory', year: '2026 · 架空', title: 'AI 工厂开工', subtitle: '从一个 ALU 到整座算力工厂', description: '最后一份订单来自一座想象中的 AI 工厂。把多年积累的计算、缓存、显存与异步流水线串起来，完成黄Sir 的车库创业故事。', work: 300000, reward: 50000, requires: {tmem: 2, tma: 2, tensor: 3, hbm: 3, alu: 7}, previous: 'attention', icon: '✦'},
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

function addStory(state, id, message, type = 'story') {
  if (state.story.some(item => item.id === id)) return;
  state.story.push({id, type, message, elapsed: state.elapsed});
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

function announceResearch(state, events) {
  for (const upgrade of UPGRADES) {
    if (!upgrade.unlockEarned || state.totalEarned < upgrade.unlockEarned ||
        state.story.some(item => item.id === `research-${upgrade.id}`)) continue;
    const message = `研发图纸已开放：${upgrade.name}。补齐前置后即可安装。`;
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
  return Math.max(0.35, 2.8 / (1 + level(state, 'scheduler') * 0.8));
}

function queueCapacity(state) {
  return 8 + level(state, 'dram') * 2 + level(state, 'scheduler') * 2;
}

function workloadRate(state, kind, tier=0) {
  return state.performanceModel === 'analytical' ? getWorkloadPerformance(state.levels,kind).throughput : workshopPerformance(state.levels, kind, tier).rate;
}

function challengeKind(state) {
  const id = state.challenge?.id;
  const kind = ['scalar', 'vector', 'graphics'].includes(id) ? 'fp32' :
    id === 'physics' ? 'stream' : id === 'alexnet' ? 'conv' :
    id === 'transformer' ? 'gemm' : id === 'training' ? 'async' : 'attention';
  return kind;
}

function challengeTier(state) {
  const index=CHAPTERS.findIndex(chapter=>chapter.id===state.challenge?.id);
  return Math.max(0,Math.min(5,index-2));
}
function currentWorkload(state) {
  return state.activeJob ? {kind:state.activeJob.kind,tier:state.activeJob.tier??0}
    : state.challenge ? {kind:challengeKind(state),tier:challengeTier(state)} : {kind:'fp32',tier:0};
}
function challengeRate(state) { return workloadRate(state, challengeKind(state),challengeTier(state)); }

function completeJob(state, events) {
  const job = state.activeJob;
  if (!job || job.progress < job.work - EPSILON) return;
  state.money = Math.min(MAX_MONEY, state.money + job.reward);
  state.totalEarned = Math.min(MAX_MONEY, state.totalEarned + job.reward);
  state.completed++;
  addEvent(events, {type: 'job-complete', message: `${job.client} 的${job.name}完成，到账 $${job.reward}`, reward: job.reward, jobId: job.id, kind: job.kind});
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
    const message = `${chapter.year} · ${chapter.title}验收通过，获得 $${chapter.reward}。硬件研发仍按经营积累独立推进。`;
    addStory(state, `chapter-${chapter.id}`, message, 'challenge-complete');
    addEvent(events, {type: 'challenge-complete', id: chapter.id, message, reward: chapter.reward});
    announceResearch(state, events);
  }
  state.challenge = null;
}

export function createGame(now = Date.now(), {performanceModel = 'analytical'} = {}) {
  const state = {version: 1, money: 0, totalEarned: 0, completed: 0, flops: 0,
    levels: Object.fromEntries(UPGRADES.map(upgrade => [upgrade.id, 0])),
    queue: [makeJob(2, 'fp32'), makeJob(3, 'fp32')], activeJob: makeJob(1, 'fp32'),
    challenge: null, won: [], elapsed: 0, boostRemaining: 0,
    savedAt: finite(now, Date.now()), story: [], nextJobId: 4, arrivalClock: 0.8,
    rng: 0x48534952, lastManualAt: -1, clicks: 0};
  state.performanceModel = performanceModel === 'workshop' ? 'workshop' : 'analytical';
  addStory(state, 'garage', '黄Sir：车库里只有一个 ALU。先接浮点小单，把第一块 L1 Cache 挣出来。');
  return state;
}

export function getStats(state) {
  const kinds = unlockedKinds(state);
  const current=currentWorkload(state);
  const analytical = state.performanceModel === 'analytical';
  const performance = analytical ? getWorkloadPerformance(state.levels, current.kind) : workshopPerformance(state.levels, current.kind, current.tier);
  const throughput = analytical ? kinds.reduce((sum,kind)=>sum+getWorkloadPerformance(state.levels,kind).throughput,0)/kinds.length : performance.rate;
  const hitRate = analytical ? kinds.reduce((sum,kind)=>sum+getWorkloadPerformance(state.levels,kind).hitRate,0)/kinds.length : performance.hitRate;
  const tier = developmentTier(state);
  const scale = TIER_SCALE[tier];
  const averageReward = kinds.reduce((sum, kind) => sum + JOB_SPEC[kind].reward * scale, 0) / kinds.length;
  const challengeShare = state.challenge ? 0.3 : 1;
  const boost = state.boostRemaining > 0 ? 1.55 : 1;
  const resourceIncomeRate = Math.min(boost * challengeShare / (kinds.reduce((sum, kind) => sum + JOB_SPEC[kind].work * scale / workloadRate(state, kind, tier), 0) / kinds.length), 1 / arrivalInterval(state)) * averageReward;
  const incomeRate = analytical ? Math.min(throughput * boost * challengeShare / (kinds.reduce((sum,kind)=>sum+JOB_SPEC[kind].work*scale,0)/kinds.length), 1/arrivalInterval(state))*averageReward : resourceIncomeRate;
  return {throughput, hitRate, incomeRate, performance, diagnosis:analytical?null:diagnoseWorkshop(performance), workloadName: JOB_SPEC[current.kind].name, aluCount: 1 + level(state, 'alu'),
    memoryLabel: level(state, 'hbm') ? `HBM ${level(state, 'hbm') * 8} GB` : level(state, 'dram') ? `DRAM ${level(state, 'dram') * 256} MB` : '无显存 · 逐项供数',
    cacheLabel: level(state, 'l2') ? `L1 ${level(state, 'l1') * 32} KB + L2 ${level(state, 'l2') * 256} KB` : level(state, 'l1') ? `L1 ${level(state, 'l1') * 32} KB` : '无缓存',
    power: Math.round((1 + level(state, 'alu')) * (1.5 + level(state, 'clock') * 0.8) + level(state, 'dram') * 2 + level(state, 'hbm') * 5 + level(state, 'tensor') * 3 + level(state, 'tma') + level(state, 'tmem') * 2),
    chapterIndex: state.won.length, developmentTier: tier, queueCapacity: queueCapacity(state), unlockedKinds: kinds,
    boosted: state.boostRemaining > 0};
}

export function getUpgradePreview(state, id) {
  const {kind,tier}=currentWorkload(state);
  if (state.performanceModel === 'analytical') {
    const upgrade = UPGRADE_MAP.get(id);
    if (!upgrade || level(state,id) >= upgrade.maxLevel) return null;
    const before = getWorkloadPerformance(state.levels,kind);
    const after = getWorkloadPerformance({...state.levels,[id]:level(state,id)+1},kind);
    return {gain:after.throughput/before.throughput-1,before:before.cycles,after:after.cycles};
  }
  return previewWorkshopUpgrade(state.levels, kind, id,tier);
}

export function getUpgradeCost(state, id) {
  const upgrade = UPGRADE_MAP.get(id);
  if (!upgrade || level(state, id) >= upgrade.maxLevel) return Infinity;
  const growth = id === 'alu' ? 1.55 : id === 'clock' ? 1.85 : 2.05;
  return Math.ceil(upgrade.baseCost * growth ** level(state, id));
}

export function canBuyUpgrade(state, id) {
  const upgrade = UPGRADE_MAP.get(id);
  return Boolean(upgrade && !(id === 'dram' && level(state, 'hbm') > 0 && state.performanceModel !== 'analytical') && level(state, id) < upgrade.maxLevel &&
    state.totalEarned >= upgrade.unlockEarned &&
    upgrade.requires.every(required => level(state, required) > 0) && state.money >= getUpgradeCost(state, id));
}

export function buyUpgrade(state, id) {
  if (!canBuyUpgrade(state, id)) return false;
  const cost = getUpgradeCost(state, id);
  state.money = Math.max(0, state.money - cost);
  state.levels[id]++;
  const upgrade = UPGRADE_MAP.get(id);
  if (level(state, id) === 1) {
    const extra = id === 'dram' ? ' 流式数据客户已解锁。' : id === 'tensor' ? ' GEMM 矩阵客户已解锁。' : id === 'tma' ? ' 异步 Tile 客户已解锁。' : id === 'tmem' ? ' 长序列注意力客户已解锁。' : '';
    addStory(state, `upgrade-${id}`, `黄Sir 解锁了${upgrade.name}。${upgrade.subtitle}。${extra}`, 'upgrade');
  }
  if (level(state, 'alu') >= 3 && level(state, 'l1') > 0) {
    addStory(state, 'workload-conv', '四个 ALU 与 L1 Cache 开始协作。图像卷积客户加入日常订单，应用任务仍可按自己的节奏挑战。', 'workload');
  }
  return true;
}

/** Advance at event boundaries, including arrivals, completions and boost expiry. */
export function tickGame(state, seconds) {
  let remaining = clamp(finite(seconds), 0, MAX_OFFLINE_SECONDS);
  const events = [];
  let iterations = 0;
  while (remaining > EPSILON && iterations++ < 200000) {
    if (!state.activeJob) state.activeJob = state.queue.shift() || null;
    const boost = state.boostRemaining > EPSILON ? 1.55 : 1;
    const hasChallenge = Boolean(state.challenge);
    const customerRate = state.activeJob ? workloadRate(state, state.activeJob.kind,state.activeJob.tier??0) * boost * (hasChallenge ? 0.3 : 1) : 0;
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
  return events;
}

export function manualCompute(state) {
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

export function restoreGame(raw, now = Date.now(), {performanceModel} = {}) {
  const timestamp = finite(now, Date.now());
  const fresh = () => ({state: createGame(timestamp, {performanceModel}), offline: {seconds: 0, earned: 0, completed: 0}});
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return fresh(); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== 1 ||
      !data.levels || typeof data.levels !== 'object' || Array.isArray(data.levels) ||
      typeof data.money !== 'number' || !Number.isFinite(data.money) || data.money < 0) return fresh();
  const state = createGame(timestamp, {performanceModel: performanceModel ?? data.performanceModel});
  state.money = clamp(data.money, 0, MAX_MONEY);
  state.totalEarned = clamp(finite(data.totalEarned, state.money), state.money, MAX_MONEY);
  state.completed = clamp(Math.floor(finite(data.completed)), 0, 1e12);
  state.flops = clamp(finite(data.flops), 0, 1e18);
  state.elapsed = clamp(finite(data.elapsed), 0, 1e12);
  for (const upgrade of UPGRADES) {
    state.levels[upgrade.id] = clamp(Math.floor(finite(data.levels[upgrade.id])), 0, upgrade.maxLevel);
    if (state.totalEarned < upgrade.unlockEarned || upgrade.requires.some(required => !state.levels[required])) state.levels[upgrade.id] = 0;
  }
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
  const savedAt = finite(data.savedAt, timestamp);
  const seconds = clamp((timestamp - savedAt) / 1000, 0, MAX_OFFLINE_SECONDS);
  const beforeMoney = state.money;
  const beforeCompleted = state.completed;
  tickGame(state, seconds);
  state.savedAt = timestamp;
  return {state, offline: {seconds, earned: state.money - beforeMoney, completed: state.completed - beforeCompleted}};
}

export function serializeGame(state, now = Date.now()) {
  state.savedAt = finite(now, Date.now());
  return JSON.stringify(state);
}
