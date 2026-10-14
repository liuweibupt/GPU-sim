import test from 'node:test';
import assert from 'node:assert/strict';
import {timeWindow,eventInScope,intersectsWindow} from '../lib/view-state.js';

test('timeline lens preserves absolute time and clamps high/negative time origins', () => {
  assert.deepEqual(timeWindow({start:1000000,end:1001600},16,1000000),{start:1000000,end:1000100});
  assert.deepEqual(timeWindow({start:-1600,end:0},16,0),{start:-100,end:0});
  assert.deepEqual(timeWindow({start:2,end:2},8,100),{start:2,end:2});
  assert.deepEqual(timeWindow({start:10,end:20},1,100),{start:10,end:20});
});

test('CTA/warp scopes preserve zero IDs and never manufacture missing source identity', () => {
  const event={args:{smId:0,threadBlockId:0,warpId:8}};
  assert.equal(eventInScope(event,{smId:0,threadBlockId:0}),true);
  assert.equal(eventInScope(event,{smId:0,threadBlockId:1}),false);
  assert.equal(eventInScope(event,{warpId:'8'}),true);
  assert.equal(eventInScope({args:{}},{smId:0}),false);
  assert.equal(eventInScope(event,null),true);
});

test('lens handles instants and half-open intervals without mutating them', () => {
  const event={start:2,end:4};
  assert.equal(intersectsWindow(event,{start:4,end:6}),false);
  assert.equal(intersectsWindow(event,{start:3,end:6}),true);
  assert.equal(intersectsWindow({start:4,end:4},{start:4,end:6}),true);
  assert.deepEqual(event,{start:2,end:4});
});
