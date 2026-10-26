import test from 'node:test';
import assert from 'node:assert/strict';
import {getWorkloadPerformance} from '../lib/compute-model.js';
import {createGame,getStats,tickGame,getUpgradePreview,getUpgradeRecommendations,serializeGame,restoreGame} from '../lib/idle-game.js';

test('larger resident sets lower hits without multiplying per-unit work or changing baseline',()=>{
 const levels={alu:7,l1:2,l2:1,dram:1};
 const small=getWorkloadPerformance(levels,'gemm',0),large=getWorkloadPerformance(levels,'gemm',3);
 assert.equal(large.features.workingSetBytes,small.features.workingSetBytes*8);
 assert.equal(large.features.operations,small.features.operations);
 assert.equal(large.features.bytes,small.features.bytes);
 assert.equal(large.baselineCycles,small.baselineCycles);
 assert.ok(large.hitRate<small.hitRate);
 assert.ok(large.throughput<small.throughput);
 assert.equal(getWorkloadPerformance(levels,'gemm',3),large);
 assert.equal(getWorkloadPerformance(levels,'gemm',Infinity),small);
});
test('current task display, actual progress and candidate upgrade use identical kind and tier',()=>{
 const s=createGame(1000);s.money=s.totalEarned=1e8;
 Object.assign(s.levels,{alu:7,l1:1,l2:1,dram:1,scheduler:1,tensor:1});
 s.activeJob.kind='gemm';s.activeJob.tier=3;s.activeJob.work=1e8;
 s.boostRemaining=3;
 s.challenge={id:'scalar',work:20,progress:0};
 const stats=getStats(s),p=getWorkloadPerformance(s.levels,'gemm',3);
 assert.equal(stats.throughput,p.throughput);
 assert.equal(stats.hitRate,p.hitRate);
 tickGame(s,.01);
 assert.ok(Math.abs(s.activeJob.progress-stats.effectiveThroughput*.01)<1e-10);
 const expected=getWorkloadPerformance({...s.levels,l2:2},'gemm',3).throughput/p.throughput-1;
 assert.equal(getUpgradePreview(s,'l2').gain,expected);
 const recommendations=getUpgradeRecommendations(s);
 assert.ok(recommendations.length>0);
 for(let i=0;i<recommendations.length;i++){
  const r=recommendations[i];
  assert.equal(r.gain,getUpgradePreview(s,r.id).gain);
  if(i)assert.ok(recommendations[i-1].gain>=r.gain);
 }
 const early=createGame();assert.ok(getUpgradeRecommendations(early).every(r=>['alu','clock','l1'].includes(r.id)));
});
test('legacy Tile selection migrates without losing progress; offline and online execution agree',()=>{
 const s=createGame(1000);s.money=100;s.totalEarned=100;s.activeJob.progress=1;
 s.performanceModel='workshop';
 const raw=serializeGame(s,1000),restored=restoreGame(raw,1000).state;
 assert.equal(restored.money,100);assert.equal(restored.activeJob.progress,1);
 assert.equal(restored.performanceModel,'analytical');
 tickGame(restored,1);
 assert.equal(restoreGame(raw,2000).state.activeJob.progress,restored.activeJob.progress);
});
