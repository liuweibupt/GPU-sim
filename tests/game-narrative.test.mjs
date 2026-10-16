import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNarrative, restoreNarrative, getNarrativeView, updateNarrative,
  chooseNarrativeOption, getNarrativeEffects,
} from '../lib/game-narrative.js';

const baseline = {revenueMultiplier: 1, demandBonus: 0, projectMultiplier: 1, operatingCost: 0};
function game(overrides = {}) {
  return {elapsed: 0, money: 5000, totalEarned: 12000, levels: {}, won: [],
    business: {version: 1, levels: {cuda: 1, ib_partner: 1, mellanox: 0, rack: 0}},
    narrative: createNarrative(), ...overrides};
}
function answer(state, option, context = {}) {
  const pending = getNarrativeView(state, context).pending;
  assert.ok(pending, `no letter for ${option}`);
  const before = {money: state.money, earned: state.totalEarned};
  const result = chooseNarrativeOption(state, pending.id, option, context);
  assert.equal(result.ok, true);
  assert.deepEqual({money: state.money, earned: state.totalEarned}, before, 'letters cannot mint or debit cash');
  return result;
}
function finish(software, network, scale, {acquired = false, rack = false, context = {}} = {}) {
  const state = game();
  state.business.levels.ib_partner = acquired ? 0 : 1;
  state.business.levels.mellanox = acquired ? 1 : 0;
  state.business.levels.rack = rack ? 1 : 0;
  answer(state, software, context);
  state.elapsed += 5;
  answer(state, network, context);
  state.elapsed += 5;
  answer(state, scale, context);
  state.elapsed = 90;
  state.totalEarned = 30000;
  updateNarrative(state, context);
  return state;
}

test('old games have neutral effects, fresh records are independent, and view is pure', () => {
  const state = game({business: {levels: {}}, narrative: undefined});
  const before = structuredClone(state);
  assert.deepEqual(getNarrativeEffects(state), baseline);
  assert.deepEqual(getNarrativeView(state), {pending: null, events: [], ending: null});
  assert.deepEqual(state, before);
  assert.deepEqual(restoreNarrative(undefined, state), createNarrative());
  const first = createNarrative();
  first.decisions.push({eventId: 'fake'});
  assert.equal(createNarrative().decisions.length, 0);
});

test('encounters require actual installed capabilities and prior answered letters', () => {
  const state = game({totalEarned: 0, business: {levels: {}}});
  assert.equal(getNarrativeView(state).pending, null);
  assert.equal(chooseNarrativeOption(state, 'software-letter', 'commons').ok, false);
  state.business.levels.cuda = 1;
  assert.equal(getNarrativeView(state).pending.id, 'software-letter');
  answer(state, 'commons');
  assert.equal(getNarrativeView(state).pending, null, 'network must be installed');
  state.business.levels.ib_partner = 1;
  assert.equal(getNarrativeView(state).pending.id, 'network-night');
  answer(state, 'shared');
  assert.equal(getNarrativeView(state).pending, null, 'scale requires a rack or earned operating scale');
  state.business.levels.rack = 1;
  assert.equal(getNarrativeView(state).pending.id, 'deployment-window');
  const premature = restoreNarrative({version: 1, decisions: [{eventId: 'network-night', optionId: 'dedicated', elapsed: 0}], events: []}, state);
  assert.equal(premature.decisions.length, 0);
});

test('stale, duplicated, unknown and premature replies leave all state untouched', () => {
  const state = game();
  for (const [eventId, optionId] of [['network-night', 'shared'], ['software-letter', 'pay-everyone'], ['unknown', 'commons']]) {
    const before = structuredClone(state);
    assert.equal(chooseNarrativeOption(state, eventId, optionId).ok, false);
    assert.deepEqual(state, before);
  }
  answer(state, 'commons');
  const after = structuredClone(state);
  assert.equal(chooseNarrativeOption(state, 'software-letter', 'anchor').ok, false);
  assert.deepEqual(state, after);
});

test('choices have mixed canonical economic consequences and cannot trust injected effect data', () => {
  const broad = game();
  const focused = game();
  answer(broad, 'commons');
  answer(focused, 'anchor');
  assert.deepEqual(getNarrativeEffects(broad), {revenueMultiplier: .98, demandBonus: 2, projectMultiplier: 1, operatingCost: .08});
  assert.deepEqual(getNarrativeEffects(focused), {revenueMultiplier: 1.12, demandBonus: -1, projectMultiplier: 1, operatingCost: .18});
  answer(broad, 'shared');
  answer(broad, 'careful');
  const before = structuredClone(broad);
  assert.deepEqual(getNarrativeEffects(broad), {revenueMultiplier: 1.0094, demandBonus: 3, projectMultiplier: .9215, operatingCost: .01});
  assert.deepEqual(broad, before, 'economic getters must be pure');
  broad.narrative.effects = {revenueMultiplier: 1e9};
  broad.narrative.decisions[0].effects = {revenueMultiplier: 1e9};
  assert.equal(getNarrativeEffects(broad).revenueMultiplier, 1.0094);
  broad.narrative.version = 2;
  assert.deepEqual(getNarrativeEffects(broad), baseline);
});

test('followup letters arrive once after sixty simulated seconds with stable due times', () => {
  const state = game({elapsed: 15});
  assert.equal(answer(state, 'commons').events.length, 2);
  state.elapsed = 74.999;
  assert.deepEqual(updateNarrative(state), []);
  state.elapsed = 1000;
  const events = updateNarrative(state);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, 'software-letter:commons:later');
  assert.equal(events[0].elapsed, 75);
  assert.deepEqual(updateNarrative(state), []);
  state.narrative = restoreNarrative(JSON.parse(JSON.stringify(state.narrative)), state);
  assert.deepEqual(updateNarrative(state), []);
});

test('long offline jumps and split stepping produce identical canonical letters', () => {
  const long = game({elapsed: 7});
  answer(long, 'anchor');
  const split = structuredClone(long);
  long.elapsed += 180;
  updateNarrative(long);
  for (let i = 0; i < 180; i++) { split.elapsed++; updateNarrative(split); }
  assert.deepEqual(long.narrative, split.narrative);
});

test('save restoration rebuilds text and times and drops forged, future and impossible records', () => {
  const state = game({elapsed: 25});
  answer(state, 'commons');
  const raw = structuredClone(state.narrative);
  raw.decisions.push({eventId: 'software-letter', optionId: 'anchor', elapsed: 26});
  raw.decisions.push({eventId: 'network-night', optionId: 'dedicated', elapsed: -1});
  raw.decisions.push({eventId: 'network-night', optionId: 'dedicated', elapsed: 100});
  raw.events[0].body = '<script>forged</script>';
  raw.events[0].elapsed = -999;
  raw.events.push({...raw.events[0]});
  raw.events.push({id: 'software-letter:commons:later', body: 'not due'});
  raw.events.push({id: 'forged', body: 'free money'});
  const restored = restoreNarrative(raw, state);
  assert.equal(restored.decisions.length, 1);
  assert.equal(restored.events.length, 2);
  assert.equal(restored.events.find(event => event.id.endsWith(':reply')).elapsed, 25);
  assert.doesNotMatch(restored.events.map(event => event.body).join(''), /forged|script/);
  assert.deepEqual(restoreNarrative({...raw, version: '1'}, state), createNarrative());
  state.business.levels.cuda = 0;
  assert.deepEqual(restoreNarrative(raw, state).decisions, [], 'missing capability prunes descendants');
});

test('at least five endings emerge from different concrete commitments and installed systems', () => {
  const platform = finish('commons', 'dedicated', 'careful');
  const factory = finish('anchor', 'dedicated', 'expand', {acquired: true, rack: true});
  const alliance = finish('anchor', 'shared', 'expand');
  const quiet = finish('anchor', 'dedicated', 'careful');
  const concentrated = finish('anchor', 'dedicated', 'expand');
  assert.deepEqual([platform, factory, alliance, quiet, concentrated].map(state => state.narrative.ending.id), [
    'common-language', 'single-factory', 'partner-lights', 'quiet-workshop', 'signed-horizon',
  ]);
  assert.equal(new Set([platform, factory, alliance, quiet, concentrated].map(state => state.narrative.ending.id)).size, 5);
  for (const state of [platform, factory, alliance, quiet, concentrated]) {
    assert.equal(getNarrativeView(state).pending, null);
    assert.equal(state.narrative.events.filter(event => event.id.startsWith('ending:')).length, 1);
  }
});

test('unfinished choices and an ordinary cash threshold do not reveal an ending catalogue', () => {
  const state = game({totalEarned: 999999});
  updateNarrative(state);
  let view = getNarrativeView(state);
  assert.equal(view.ending, null);
  assert.doesNotMatch(JSON.stringify(view.pending), /推荐|最佳|路线|结局|common-language|single-factory/);
  answer(state, 'commons');
  updateNarrative(state);
  assert.equal(getNarrativeView(state).ending, null);
  const factory = game({won: ['factory']});
  updateNarrative(factory);
  assert.equal(factory.narrative.ending.id, 'independent-lights');
});

test('PvE clocks follow race time and rival victory permits the player second act', () => {
  const state = game({elapsed: 1});
  const context = {mode: 'pve', elapsed: 50, raceFinished: true, winnerId: 'lisa', projectComplete: false, bankrupt: false};
  answer(state, 'commons', context);
  assert.equal(state.narrative.decisions[0].elapsed, 50);
  assert.deepEqual(updateNarrative(state, {...context, elapsed: 109}), []);
  assert.equal(updateNarrative(state, {...context, elapsed: 110})[0].elapsed, 110);
  assert.equal(getNarrativeView(state, {...context, elapsed: 110}).ending, null);
  updateNarrative(state, {...context, elapsed: 130, projectComplete: true});
  const view = getNarrativeView(state, {...context, elapsed: 130, projectComplete: true});
  assert.match(view.ending.body, /同行的庆功新闻已经过去/);
  assert.equal(view.ending.evidence.result, 'late');
});

test('PvE wins and ties leave distinct historical commercial outcomes', () => {
  for (const [winnerId, outcome, text] of [['player', 'won', /先从你的机房/], ['tie', 'tie', /没有谁独占头条/]]) {
    const state = game();
    const context = {mode: 'pve', elapsed: 100, projectComplete: true, winnerId};
    updateNarrative(state, context);
    assert.equal(state.narrative.ending.evidence.result, outcome);
    assert.match(state.narrative.ending.body, text);
  }
});

test('bankruptcy closes immediately and cannot emit imaginary renewals after closure', () => {
  const state = game();
  const active = {mode: 'pve', elapsed: 10, bankrupt: false, projectComplete: false};
  answer(state, 'anchor', active);
  const closure = {...active, elapsed: 20, bankrupt: true};
  updateNarrative(state, closure);
  assert.equal(state.narrative.ending.id, 'closure');
  const original = structuredClone(state.narrative.ending);
  assert.deepEqual(updateNarrative(state, {...closure, elapsed: 1000}), []);
  assert.deepEqual(state.narrative.ending, original);
  assert.equal(state.narrative.events.some(event => event.id.endsWith(':later')), false);
  assert.equal(getNarrativeView(state, {...closure, elapsed: 1000}).pending, null);
});

test('an awarded ending remains immutable as the workshop grows; forged ending IDs fail validation', () => {
  const state = finish('anchor', 'dedicated', 'careful');
  const earnedEnding = structuredClone(state.narrative.ending);
  state.business.levels.ib_partner = 0;
  state.business.levels.mellanox = 1;
  state.business.levels.rack = 2;
  // Network switches are impossible in gameplay, so preserve the actual saved route.
  state.business.levels.ib_partner = 1;
  state.business.levels.mellanox = 0;
  state.elapsed = 500;
  state.money += 100000;
  state.totalEarned += 100000;
  state.won = ['factory'];
  updateNarrative(state);
  assert.deepEqual(state.narrative.ending, earnedEnding);
  const injected = structuredClone(state.narrative);
  injected.ending.id = 'single-factory';
  assert.equal(restoreNarrative(injected, state).ending, null);
  injected.ending.id = 'unknown-crown';
  assert.equal(restoreNarrative(injected, state).ending, null);
  const unearned = game({totalEarned: 12000, narrative: state.narrative, elapsed: 500});
  assert.equal(restoreNarrative(state.narrative, unearned).ending, null);
});

test('already completed legacy saves get a retrospective without changing fresh-run finishing rules', () => {
  for (const mode of ['workshop', 'pve']) {
    const state = game({won: mode === 'workshop' ? ['factory'] : [], narrative: undefined});
    const context = mode === 'pve' ? {mode, projectComplete: true, winnerId: 'lisa'} : {mode};
    state.narrative = restoreNarrative(undefined, state, context);
    updateNarrative(state, context);
    assert.equal(state.narrative.retrospective, true);
    assert.equal(state.narrative.ending, null);
    assert.equal(getNarrativeView(state, context).pending.id, 'software-letter');
    state.narrative = restoreNarrative(JSON.parse(JSON.stringify(state.narrative)), state, context);
    answer(state, 'commons', context);
    answer(state, 'shared', context);
    assert.equal(state.narrative.ending, null);
    answer(state, 'careful', context);
    assert.equal(state.narrative.ending.id, 'common-language');
    assert.equal(state.narrative.retrospective, undefined);
  }
});
