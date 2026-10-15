import test from 'node:test';
import assert from 'node:assert/strict';
import {observationSnapshot, laneWindow, instructionSearchText} from '../lib/instruction-view.js';

const point = (id, cycle, warpId = 0, stage = 'ISSUE', dynamicWarpId = 0) => ({
  id, name: 'add.u32 %r1, %r2, %r3;', start: cycle, end: cycle, category: stage,
  args: {granularity: 'instruction', warpId, dynamicWarpId, stage, pc: '0x100', schedulerId: 2}
});

test('snapshot counts recorded points, separates stalls, and never looks ahead', () => {
  const events = [point('later', 20), point('stall', 10, 1, 'STALL_SCOREBOARD'),
    point('issued', 10), {...point('span', 1), end: 30}];
  const before = structuredClone(events);
  assert.deepEqual(observationSnapshot(events, 0), {events: [], cycle: null, atCursor: false,
    observed: 0, total: 3, issue: 0, stall: 0, omitted: 0});
  const exact = observationSnapshot(events, 10, {limit: 1});
  assert.equal(exact.cycle, 10);
  assert.equal(exact.atCursor, true);
  assert.equal(exact.observed, 2);
  assert.equal(exact.issue, 1);
  assert.equal(exact.stall, 1);
  assert.equal(exact.events.length, 1);
  assert.equal(exact.omitted, 1);
  const between = observationSnapshot(events, 19.5);
  assert.equal(between.cycle, 10);
  assert.equal(between.atCursor, false);
  assert.deepEqual(between.events.map(event => event.id), ['stall', 'issued']);
  assert.deepEqual(events, before);
});

test('large instruction windows follow cursor and retain a selected omitted lane', () => {
  const events = Array.from({length: 1000}, (_, i) => point(`p${i}`, i, i % 20));
  const before = structuredClone(events);
  const window = laneWindow(events, 990, 'p17');
  assert.ok(window.events.some(event => event.id === 'p17'));
  assert.ok(window.events.some(event => event.id === 'p990'));
  assert.ok(window.events.length <= 96);
  assert.ok(window.lanes.length <= 8);
  assert.ok(window.lanes.every(([, lane]) => lane.length <= 16));
  assert.equal(window.total, 1000);
  assert.equal(window.totalLanes, 20);
  assert.deepEqual(events, before);
});

test('warp slot reuse, stage and caller-defined lane keys remain distinct', () => {
  const events = [point('a', 1, 0, 'ISSUE', 1), point('b', 1, 0, 'ISSUE', 2),
    point('c', 1, 0, 'STALL_READY_NO_ISSUE', 2)];
  assert.equal(laneWindow(events, 1).totalLanes, 3);
  const limited = laneWindow(events, 1, 'c', {limit: 1, maxLanes: 1, perLane: 1});
  assert.deepEqual(limited.events.map(event => event.id), ['c']);
  assert.equal(laneWindow(events, 1, null, {laneKey: () => 'custom'}).lanes.length, 1);
  assert.equal(laneWindow([], 12).start, 12);
});

test('instruction search includes native PC, stage, identities and raw text', () => {
  const searchable = instructionSearchText(point('a', 1, 3, 'STALL_SCOREBOARD', 100));
  for (const term of ['0x100', 'STALL_SCOREBOARD', 'warpId 3', 'dynamicWarpId 100',
    'schedulerId 2', 'add.u32', 'warp 3', 'dynamic warp 100', 'scheduler 2']) assert.ok(searchable.includes(term), term);
});
