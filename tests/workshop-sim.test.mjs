import test from 'node:test';
import assert from 'node:assert/strict';
import {simulateWorkshop,workshopPerformance,previewWorkshopUpgrade} from '../lib/workshop-sim.js';
import {createGame,getStats,getUpgradePreview,tickGame} from '../lib/idle-game.js';

test('tiles obey read-compute-write dependencies; resource service never overlaps',()=>{
 const result=simulateWorkshop({alu:7,l1:1,scheduler:4,tma:2,tensor:1},'async');
 assert.equal(result.finished,result.tileCount);
 for(let tile=0;tile<result.tileCount;tile++){
  const events=result.events.filter(e=>e.tile===tile);
  assert.deepEqual(events.map(e=>e.operation),['issue','read','compute','write / intermediate spill']);
  for(let i=1;i<events.length;i++)assert.ok(events[i].start>=events[i-1].end);
 }
 for(const resource of Object.keys(result.resources)){
  const events=result.events.filter(e=>e.resource===resource).sort((a,b)=>a.start-b.start);
  for(let i=1;i<events.length;i++)assert.ok(events[i].start>=events[i-1].serviceEnd-1e-9);
 }
 assert.ok(Math.abs(Object.values(result.critical).reduce((a,b)=>a+b,0)-result.cycles)<1e-8);
});

test('memory-bound streams saturate ALUs while bandwidth upgrades relieve the limit',()=>{
 const base={scheduler:4,alu:31};
 const original=workshopPerformance(base,'stream');
 const moreAlu=workshopPerformance({...base,alu:63},'stream');
 const moreMemory=workshopPerformance({...base,dram:1},'stream');
 assert.ok(moreAlu.rate/original.rate<1.02);
 assert.ok(moreMemory.rate/original.rate>1.2);
 assert.equal(original.bottleneck,'memoryBandwidth');
});

test('LRU hits reduce external bytes and depend on access stream, not a level formula',()=>{
 const bare=simulateWorkshop({},'fp32'),cached=simulateWorkshop({l1:1},'fp32');
 assert.equal(bare.hitRate,0);assert.equal(cached.l1Hits,20);
 assert.ok(cached.memoryBytes<bare.memoryBytes);
 assert.ok(simulateWorkshop({l1:1},'stream').hitRate<cached.hitRate);
 // Many simultaneous cold requests cannot hit fills that have not completed.
 assert.ok(simulateWorkshop({l1:1,scheduler:4},'fp32').l1Hits<cached.l1Hits);
});

test('TMA overlap, tensor execution and TMEM spills change actual schedules',()=>{
 const base={alu:7,l1:1,dram:1,tensor:1};
 assert.ok(simulateWorkshop({...base,tma:1},'async').cycles<simulateWorkshop(base,'async').cycles);
 assert.equal(simulateWorkshop({...base,tma:1},'fp32').cycles,simulateWorkshop(base,'fp32').cycles);
 const matrix=simulateWorkshop(base,'gemm');
 assert.ok(matrix.events.some(e=>e.resource==='tensor'));
 assert.ok(simulateWorkshop({...base,tmem:1},'gemm').memoryBytes<matrix.memoryBytes);
 assert.ok(matrix.cycles<simulateWorkshop({...base,tensor:0},'gemm').cycles);
});

test('game rates, hit rates and upgrade previews use the same cached simulation',()=>{
 const state=createGame(0);Object.assign(state.levels,{alu:7,l1:1,dram:1,scheduler:1});
 state.activeJob.work=1e6;
 const stats=getStats(state),sim=workshopPerformance(state.levels,'fp32');
 assert.equal(stats.throughput,sim.rate);assert.equal(stats.hitRate,sim.hitRate);
 tickGame(state,1);assert.equal(state.activeJob.progress,sim.rate);
 assert.deepEqual(getUpgradePreview(state,'alu'),previewWorkshopUpgrade(state.levels,'fp32','alu'));
 assert.equal(workshopPerformance(state.levels,'fp32'),sim);
 state.levels.alu++;assert.notEqual(workshopPerformance(state.levels,'fp32'),sim);
 assert.equal(previewWorkshopUpgrade({alu:63},'fp32','alu'),null);
});

import {diagnoseWorkshop,workloadShape} from '../lib/workshop-sim.js';
import {buyUpgrade,canBuyUpgrade,serializeGame,restoreGame} from '../lib/idle-game.js';

test('order working sets cross L1 and L2 capacity boundaries without artificial speed bonuses',()=>{
 const h={alu:31,clock:2,l1:1,l2:1,dram:1,scheduler:1,tensor:4,tmem:2};
 const small=workshopPerformance(h,'gemm',0);
 const medium=workshopPerformance(h,'gemm',1);
 const large=workshopPerformance(h,'gemm',4);
 assert.equal(small.workingSetBytes,32*1024);assert.ok(small.l1Hits>0);assert.equal(small.l2Hits,0);
 assert.equal(medium.workingSetBytes,64*1024);assert.equal(medium.l1Hits,0);assert.ok(medium.l2Hits>0);
 assert.equal(large.workingSetBytes,512*1024);assert.equal(large.hitRate,0);
 assert.ok(previewWorkshopUpgrade(h,'gemm','l1',1).gain>.05);
 assert.ok(previewWorkshopUpgrade(h,'gemm','l2',4).gain>.05);
 assert.equal(previewWorkshopUpgrade(h,'gemm','l2',0).gain,0);
 assert.ok(workshopPerformance({...h,l2:2},'gemm',4).memoryBytes<large.memoryBytes);
 assert.equal(workloadShape('attention',5).tileCount,1536);
});

test('bandwidth and latency critical path costs are separate; concurrency experiment changes only slots',()=>{
 const h={alu:31,l1:1,dram:1,scheduler:1};
 const p=workshopPerformance(h,'fp32',0),d=diagnoseWorkshop(p);
 assert.ok(p.critical.memoryLatency>0);assert.ok(p.critical.memoryBandwidth>0);
 assert.ok(Math.abs(Object.values(p.critical).reduce((a,b)=>a+b,0)-p.cycles)<1e-7);
 for(const [key,options]of [['bandwidth',{bandwidthScale:2}],['latency',{latencyScale:.5}],['concurrency',{extraSlots:1}]]){
  assert.equal(d[key],p.cycles/simulateWorkshop(h,'fp32',0,options).cycles-1);
 }
 assert.ok(d.latency>d.bandwidth);
 assert.equal(diagnoseWorkshop(p),d);
});

test('a stored order keeps its workload scale when hardware changes; progression and preview agree',()=>{
 const state=createGame(0);Object.assign(state.levels,{alu:15,l1:1,l2:1,dram:1,scheduler:1,tensor:2});
 state.money=state.totalEarned=1e8;state.activeJob.kind='gemm';state.activeJob.tier=4;state.activeJob.work=1e8;
 const before=getStats(state),expected=workshopPerformance(state.levels,'gemm',4);
 assert.equal(before.throughput,expected.rate);
 tickGame(state,1);assert.equal(state.activeJob.progress,expected.rate);
 const preview=getUpgradePreview(state,'l2');assert.equal(buyUpgrade(state,'l2'),true);
 const after=getStats(state);assert.equal(after.performance.tier,4);
 assert.ok(Math.abs(after.throughput/before.throughput-1-preview.gain)<1e-12);
});

test('HBM retires DRAM purchases without losing legacy levels or money',()=>{
 const state=createGame(0);state.money=state.totalEarned=1e8;
 Object.assign(state.levels,{l1:1,dram:2,l2:1,scheduler:1,tensor:1});
 assert.equal(canBuyUpgrade(state,'dram'),true);assert.equal(buyUpgrade(state,'hbm'),true);
 const money=state.money;assert.equal(canBuyUpgrade(state,'dram'),false);assert.equal(buyUpgrade(state,'dram'),false);
 assert.equal(getUpgradePreview(state,'dram'),null);assert.equal(state.money,money);assert.equal(state.levels.dram,2);
 const restored=restoreGame(serializeGame(state,1000),1000).state;
 assert.equal(restored.levels.dram,2);assert.equal(restored.levels.hbm,1);assert.equal(canBuyUpgrade(restored,'dram'),false);
});

import {getWorkloadPerformance} from '../lib/compute-model.js';
import {createRace,restoreRace,serializeRace} from '../lib/pve-race.js';
test('PvE explicitly retains its analytical economy across saves while the workshop uses tile simulation',()=>{
 const race=createRace(1000);
 for(const company of race.companies){
  assert.equal(company.game.performanceModel,'analytical');
  company.game.levels.alu=7;
  assert.equal(getStats(company.game).throughput,getWorkloadPerformance(company.game.levels,'fp32').throughput);
 }
 const restored=restoreRace(serializeRace(race,1000),1000);
 const state=restored;
 for(const company of state.companies)assert.equal(company.game.performanceModel,'analytical');
 const standalone=createGame(1000);standalone.levels.alu=7;
 assert.equal(getStats(standalone).throughput,workshopPerformance(standalone.levels,'fp32').rate);
});
