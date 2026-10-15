import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UPGRADES, CHAPTERS, createGame, getStats, getUpgradeCost, canBuyUpgrade,
  buyUpgrade, tickGame, manualCompute, startChallenge, restoreGame, serializeGame,
} from '../lib/idle-game.js';

function buyLevels(state, levels) {
  state.money = 1e12;
  state.totalEarned = 1e12;
  for (const upgrade of UPGRADES) {
    for (let i = 0; i < (levels[upgrade.id] || 0); i++) {
      assert.equal(buyUpgrade(state, upgrade.id), true, `buy ${upgrade.id}`);
    }
  }
  state.money = 0;
}

const starterHardware = {alu: 7, l1: 2, dram: 1, l2: 1, scheduler: 1};
const fullHardware = {alu: 12, clock: 4, l1: 3, dram: 3, l2: 3, scheduler: 3, tensor: 4, hbm: 3, tma: 3, tmem: 3};

test('the garage starts with exactly one ALU, no cache, no memory and real FP32 contracts', () => {
  const state = createGame(1000);
  const stats = getStats(state);
  assert.equal(stats.aluCount, 1);
  assert.equal(stats.hitRate, 0);
  assert.match(stats.cacheLabel, /无缓存/);
  assert.match(stats.memoryLabel, /无显存/);
  assert.equal(state.money, 0);
  assert.equal(state.completed, 0);
  assert.equal(state.savedAt, 1000);
  assert.deepEqual(Object.values(state.levels), UPGRADES.map(() => 0));
  assert.equal(state.activeJob.kind, 'fp32');
  assert.match(state.activeJob.expression, /×/);
  assert.equal(Number(state.activeJob.result), 11.03);
  assert.equal(state.queue.length, 2);
  assert.doesNotThrow(() => JSON.stringify(state));
});

test('automatic work progresses FIFO, pays once and keeps receiving bounded customer queues', () => {
  const state = createGame(0);
  const first = structuredClone(state.activeJob);
  tickGame(state, first.work / 2);
  assert.equal(state.completed, 0);
  assert.ok(Math.abs(state.activeJob.progress - first.work / 2) < 1e-8);
  const events = tickGame(state, first.work / 2);
  assert.equal(state.money, first.reward);
  assert.equal(state.totalEarned, first.reward);
  assert.equal(state.completed, 1);
  assert.equal(state.activeJob.id, 2);
  assert.equal(events.filter(event => event.type === 'job-complete').length, 1);
  const nextBefore = state.nextJobId;
  tickGame(state, 300);
  assert.ok(state.completed > 40);
  assert.ok(state.nextJobId > nextBefore);
  assert.equal(state.queue.length, getStats(state).queueCapacity);
  assert.ok(state.flops > 300);
});

test('first upgrades are reachable passively or in eight deliberate clicks', () => {
  const passive = createGame(0);
  tickGame(passive, 40);
  assert.equal(canBuyUpgrade(passive, 'l1'), true);
  const active = createGame(0);
  for (let click = 0; click < 8; click++) {
    manualCompute(active);
    tickGame(active, 0.2);
  }
  assert.equal(canBuyUpgrade(active, 'alu'), true);
  assert.ok(active.elapsed < passive.elapsed);
});

test('purchases enforce money, prerequisites, rising costs and level caps', () => {
  const state = createGame(0);
  assert.equal(buyUpgrade(state, 'l1'), false);
  assert.equal(buyUpgrade(state, 'unknown'), false);
  state.money = 1000;
  assert.equal(canBuyUpgrade(state, 'dram'), false);
  assert.equal(buyUpgrade(state, 'dram'), false);
  assert.equal(state.money, 1000);
  assert.equal(buyUpgrade(state, 'l1'), true);
  assert.equal(state.money, 976);
  assert.equal(state.levels.l1, 1);
  assert.ok(getUpgradeCost(state, 'l1') > 24);
  assert.equal(canBuyUpgrade(state, 'dram'), false, 'money alone does not replace earned research eligibility');
  state.totalEarned = 1000;
  assert.equal(buyUpgrade(state, 'dram'), true);
  assert.ok(getStats(state).hitRate > 0);
  assert.match(getStats(state).memoryLabel, /DRAM/);
  state.money = 1e12;
  while (buyUpgrade(state, 'l1')) { /* buy to its published cap */ }
  assert.equal(state.levels.l1, UPGRADES.find(upgrade => upgrade.id === 'l1').maxLevel);
  assert.equal(getUpgradeCost(state, 'l1'), Infinity);
  assert.equal(canBuyUpgrade(state, 'l1'), false);
});

test('cache improves compute and benefits reuse more than streaming workloads', () => {
  const bare = createGame(0);
  const cached = createGame(0);
  cached.money = 24;
  buyUpgrade(cached, 'l1');
  assert.ok(getStats(cached).throughput > getStats(bare).throughput);
  tickGame(bare, 1);
  tickGame(cached, 1);
  assert.ok(cached.activeJob.progress > bare.activeJob.progress);
  const progress = (kind, cacheLevel) => {
    const state = createGame(0);
    // Compare cache reuse with adequate compute capacity: a single ALU can mask it.
    state.levels.alu = 7; state.levels.tensor = 1;
    state.levels.l1 = cacheLevel;
    state.activeJob.kind = kind;
    state.activeJob.work = 1e6;
    tickGame(state, 1);
    return state.activeJob.progress;
  };
  const reuseGain = progress('gemm', 1) / progress('gemm', 0);
  const streamingGain = progress('stream', 1) / progress('stream', 0);
  assert.ok(reuseGain > streamingGain);
  assert.ok(streamingGain > 1);
});

test('clicks add bounded work and a timed boost without same-timestamp money exploits', () => {
  const state = createGame(0);
  const before = state.activeJob.progress;
  manualCompute(state);
  assert.ok(state.activeJob.progress > before);
  assert.equal(state.money, 0);
  const snapshot = structuredClone(state);
  for (let click = 0; click < 10000; click++) manualCompute(state);
  assert.deepEqual(state, snapshot);
  assert.ok(state.boostRemaining <= 3);
  tickGame(state, 4);
  assert.equal(state.boostRemaining, 0);
  assert.equal(getStats(state).boosted, false);
  const original = serializeGame(state, 4000);
  tickGame(state, -20);
  tickGame(state, NaN);
  tickGame(state, Infinity);
  assert.equal(serializeGame(state, 4000), original);
});

test('AlexNet checks prerequisites, shares compute with customers and awards its reward once', () => {
  const state = createGame(0);
  assert.equal(startChallenge(state, 'missing').ok, false);
  assert.equal(startChallenge(state, 'alexnet').ok, false);
  assert.equal(startChallenge(state, 'transformer').ok, false);
  buyLevels(state, starterHardware);
  for (const chapter of CHAPTERS.slice(0, 4)) {
    assert.equal(startChallenge(state, chapter.id).ok, true);
    tickGame(state, 300);
  }
  assert.equal(startChallenge(state, 'alexnet').ok, true);
  assert.equal(startChallenge(state, 'alexnet').ok, false);
  const jobsBefore = state.completed;
  const events = tickGame(state, 2400);
  assert.equal(state.challenge, null);
  assert.deepEqual(state.won, ['scalar', 'vector', 'graphics', 'physics', 'alexnet']);
  assert.ok(state.completed > jobsBefore);
  assert.equal(events.filter(event => event.type === 'challenge-complete').length, 1);
  assert.ok(state.story.some(item => item.id === 'chapter-alexnet'));
  assert.ok(getStats(state).unlockedKinds.includes('conv'));
  const reward = state.money;
  assert.equal(startChallenge(state, 'alexnet').ok, false);
  assert.equal(state.money, reward);
});

test('chronological chapters evolve from Tensor Core through TMA and TMEM to an endless factory', () => {
  const state = createGame(0);
  buyLevels(state, fullHardware);
  assert.ok(getStats(state).unlockedKinds.includes('gemm'));
  assert.ok(getStats(state).unlockedKinds.includes('async'));
  assert.ok(getStats(state).unlockedKinds.includes('attention'));
  assert.equal(startChallenge(state, 'factory').ok, false);
  for (const chapter of CHAPTERS) {
    assert.equal(startChallenge(state, chapter.id).ok, true);
    // Resource limits replace exponential upgrade multipliers; allow an offline window.
    tickGame(state, 8 * 3600);
    assert.ok(state.won.includes(chapter.id), `${chapter.id} completed`);
  }
  assert.equal(getStats(state).chapterIndex, CHAPTERS.length);
  const before = state.completed;
  tickGame(state, (state.activeJob.work - state.activeJob.progress) / getStats(state).throughput + 1);
  assert.ok(state.completed > before);
});

test('long resume ticks retain the application completion event in their bounded notification buffer', () => {
  const state = createGame(0);
  assert.equal(startChallenge(state, 'scalar').ok, true);
  const events = tickGame(state, 900);
  assert.deepEqual(state.won, ['scalar']);
  assert.equal(events.filter(event => event.type === 'challenge-complete').length, 1);
  assert.ok(events.length <= 64);
  assert.ok(events.some(event => event.type === 'job-complete'));
  assert.ok(state.completed > 64);
});

test('applications start small and hardware research progresses independently of every application', () => {
  const state = createGame(0);
  assert.equal(CHAPTERS[0].id, 'scalar');
  assert.equal(CHAPTERS[1].id, 'vector');
  assert.equal(CHAPTERS[4].id, 'alexnet');
  assert.equal(startChallenge(state, 'scalar').ok, true);
  tickGame(state, 40);
  assert.ok(state.won.includes('scalar'));
  assert.equal(state.levels.alu, 0);
  assert.equal(state.levels.l1, 0);
  const independent = createGame(0);
  independent.money = 1e7;
  independent.totalEarned = 699;
  for (const [id, count] of Object.entries({alu: 3, l1: 1, dram: 1, l2: 1, scheduler: 1})) {
    for (let i = 0; i < count; i++) assert.equal(buyUpgrade(independent, id), true);
  }
  assert.equal(canBuyUpgrade(independent, 'tensor'), false);
  independent.totalEarned = 700;
  assert.equal(buyUpgrade(independent, 'tensor'), true);
  independent.totalEarned = 12000;
  assert.equal(buyUpgrade(independent, 'hbm'), true);
  assert.equal(buyUpgrade(independent, 'tma'), true);
  assert.equal(buyUpgrade(independent, 'tmem'), true);
  assert.deepEqual(independent.won, []);
  assert.deepEqual(getStats(independent).unlockedKinds, ['fp32', 'stream', 'conv', 'gemm', 'async', 'attention']);
  const before = getStats(independent);
  independent.won = CHAPTERS.map(chapter => chapter.id);
  const after = getStats(independent);
  assert.equal(after.throughput, before.throughput);
  assert.equal(after.incomeRate, before.incomeRate);
  assert.equal(after.developmentTier, before.developmentTier);
  assert.equal(after.queueCapacity, before.queueCapacity);
});

test('ordinary revenue offers new research once without applications and persists the offer across saves', () => {
  const state = createGame(0);
  state.totalEarned = 49;
  const events = tickGame(state, state.activeJob.work);
  const offers = events.filter(event => event.type === 'research-unlocked');
  assert.deepEqual(offers.map(event => event.id), ['dram']);
  assert.match(offers[0].message, /显存 DRAM/);
  assert.deepEqual(state.won, []);
  assert.equal(state.levels.dram, 0);
  assert.equal(canBuyUpgrade(state, 'dram'), false, 'a research offer does not install prerequisites');
  const story = state.story.find(item => item.id === 'research-dram');
  assert.equal(story.type, 'research-unlocked');
  const restored = restoreGame(serializeGame(state, 1000), 1000).state;
  assert.deepEqual(restored.story.find(item => item.id === 'research-dram'), story);
  const later = tickGame(restored, 50);
  assert.equal(later.filter(event => event.type === 'research-unlocked' && event.id === 'dram').length, 0);
  assert.equal(restored.story.filter(item => item.id === 'research-dram').length, 1);
  const clicked = createGame(0);
  clicked.totalEarned = 49;
  clicked.activeJob.progress = clicked.activeJob.work - 1;
  assert.ok(manualCompute(clicked).some(event => event.type === 'research-unlocked' && event.id === 'dram'));
  const application = createGame(0);
  application.totalEarned = 49;
  startChallenge(application, 'scalar');
  application.challenge.progress = application.challenge.work - 1;
  assert.ok(manualCompute(application).some(event => event.type === 'research-unlocked' && event.id === 'dram'));
});

test('TMA and TMEM provide larger gains to their intended workloads', () => {
  const speed = (kind, hardware) => {
    const state = createGame(0);
    Object.assign(state.levels, hardware);
    state.activeJob.kind = kind;
    state.activeJob.work = 1e8;
    tickGame(state, 1);
    return state.activeJob.progress;
  };
  assert.ok(speed('async', {tma: 1}) / speed('async', {}) > speed('fp32', {tma: 1}) / speed('fp32', {}));
  assert.ok(speed('attention', {tmem: 1}) / speed('attention', {}) > speed('fp32', {tmem: 1}) / speed('fp32', {}));
});

test('JSON saves preserve active contracts and challenge progress without changing their source', () => {
  const state = createGame(1000);
  buyLevels(state, starterHardware);
  assert.equal(startChallenge(state, 'scalar').ok, true);
  manualCompute(state);
  tickGame(state, 0.1);
  assert.ok(state.challenge?.progress > 0);
  const text = serializeGame(state, 4250);
  const before = structuredClone(state);
  const restored = restoreGame(text, 4250);
  assert.deepEqual(restored.offline, {seconds: 0, earned: 0, completed: 0});
  assert.deepEqual(restored.state, before);
  assert.deepEqual(state, before);
});

test('offline catch-up matches continuous simulation, has an eight-hour cap and cannot replay on resave', () => {
  const state = createGame(1000);
  const text = serializeGame(state, 1000);
  const expected = structuredClone(state);
  tickGame(expected, 120);
  const restored = restoreGame(text, 121000);
  assert.equal(restored.offline.seconds, 120);
  assert.equal(restored.offline.earned, expected.money);
  assert.equal(restored.offline.completed, expected.completed);
  assert.equal(restored.state.activeJob.id, expected.activeJob.id);
  assert.equal(restored.state.activeJob.progress, expected.activeJob.progress);
  const capped = restoreGame(text, 1000 + 100 * 3600000);
  const eightHours = restoreGame(text, 1000 + 8 * 3600000);
  assert.equal(capped.offline.seconds, 8 * 3600);
  assert.equal(capped.offline.earned, eightHours.offline.earned);
  assert.ok(Math.abs(capped.state.elapsed - 8 * 3600) < 1e-6);
  const saved = serializeGame(capped.state, 1000 + 100 * 3600000);
  const again = restoreGame(saved, 1000 + 100 * 3600000);
  assert.equal(again.offline.earned, 0);
  assert.equal(again.offline.seconds, 0);
  assert.equal(again.state.money, capped.state.money);
});

test('corrupt, future and hostile saves safely rebuild canonical jobs and bounded progression', () => {
  for (const raw of [null, '', 'invalid json', '[]', '{}', '{"version":2}', {version: 1, levels: {}, money: NaN},
    {version: 1, levels: {}, money: -10}, {version: 1, levels: [], money: 100},
    {version: 1, levels: 'invalid', money: 100}]) {
    const result = restoreGame(raw, 1000);
    assert.equal(result.state.money, 0);
    assert.equal(result.offline.seconds, 0);
    assert.equal(getStats(result.state).aluCount, 1);
  }
  const future = createGame(200000);
  assert.equal(restoreGame(future, 1000).offline.seconds, 0);
  const hostile = createGame(1000);
  hostile.money = 1e100;
  hostile.levels.alu = 1e100;
  hostile.levels.l1 = -3;
  hostile.levels.dram = 4;
  hostile.levels.tensor = 6;
  hostile.won = ['factory', 'blackwell'];
  hostile.activeJob = {...hostile.activeJob, work: -1, reward: 1e100, progress: Infinity, client: '<script>bad()</script>'};
  hostile.queue = [hostile.activeJob, null, {...hostile.activeJob, id: 2, kind: 'attention'}];
  hostile.challenge = {id: 'factory', progress: 1e100, work: 1};
  const result = restoreGame(hostile, 1000);
  assert.ok(Number.isFinite(result.state.money));
  assert.equal(result.state.levels.alu, 63);
  assert.equal(result.state.levels.l1, 0);
  assert.equal(result.state.levels.dram, 0);
  assert.equal(result.state.levels.tensor, 0);
  assert.deepEqual(result.state.won, []);
  assert.equal(result.state.challenge, null);
  assert.equal(result.state.queue.length, 0);
  assert.equal(result.state.activeJob.work, createGame(0).activeJob.work);
  assert.equal(result.state.activeJob.reward, createGame(0).activeJob.reward);
  assert.equal(result.state.activeJob.progress, 0);
  assert.doesNotMatch(result.state.activeJob.client, /script/);
});

test('event stepping is stable across animation-sized ticks and long offline spans', () => {
  const one = createGame(0);
  const many = createGame(0);
  tickGame(one, 40);
  for (let step = 0; step < 400; step++) tickGame(many, 0.1);
  assert.equal(one.money, many.money);
  assert.equal(one.completed, many.completed);
  assert.equal(one.activeJob.id, many.activeJob.id);
  assert.ok(Math.abs(one.activeJob.progress - many.activeJob.progress) < 1e-6);
  assert.ok(Math.abs(one.elapsed - many.elapsed) < 1e-6);
  assert.equal(one.rng, many.rng);
});
