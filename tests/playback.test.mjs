import test from 'node:test';
import assert from 'node:assert/strict';
import {replayBounds, advanceReplay} from '../lib/playback.js';

test('native replay loops within observed spans without changing original clocks', () => {
  const trace = {meta: {capabilities: ['instruction_pipeline_stages']}, events: [
    {start: 5502, end: 5502, args: {granularity: 'instruction'}},
    {start: 5502, end: 5510, args: {granularity: 'instruction'}},
    {start: 5890, end: 5906, args: {granularity: 'instruction'}},
    {start: 0, end: 6212, args: {granularity: 'kernel'}},
  ]};
  const before = JSON.stringify(trace), bounds = replayBounds(trace, 0, 6212);
  assert.deepEqual(bounds, {start: 5502, end: 5906});
  assert.deepEqual(advanceReplay(5900, 10, bounds, true), {time: 5506, ended: false});
  assert.deepEqual(advanceReplay(5900, 10, bounds, false), {time: 5906, ended: true});
  assert.deepEqual(advanceReplay(5900, 818, bounds, true), {time: 5506, ended: false});
  assert.equal(JSON.stringify(trace), before);
});

test('teaching and point-only runs keep their own replay range', () => {
  assert.deepEqual(replayBounds({meta: {}, events: []}, 0, 1000), {start: 0, end: 1000});
  assert.deepEqual(replayBounds({meta: {capabilities: ['instruction_pipeline_stages']}, events: [
    {start: 10, end: 10, args: {granularity: 'instruction'}}]}, 0, 1000), {start: 0, end: 1000});
  assert.deepEqual(advanceReplay(1000, 0, {start: 0, end: 1000}, true), {time: 0, ended: false});
  assert.deepEqual(advanceReplay(5, 1, {start: 5, end: 5}, true), {time: 5, ended: true});
});
