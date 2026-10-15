/** Bounded, deterministic tile/resource simulator for the workshop (teaching units).
 * Each benchmark starts cold. Hardware/shape changes rerun it; gameplay reuses
 * the measured service rate. No CUDA execution or claim of silicon calibration.
 */
export const WORKLOADS = Object.freeze({
  fp32: {ops:512, footprint:4, matrix:false},
  stream: {ops:64, footprint:48, matrix:false},
  conv: {ops:4096, footprint:8, matrix:true},
  gemm: {ops:8192, footprint:8, matrix:true},
  async: {ops:4096, footprint:12, matrix:true},
  attention: {ops:8192, footprint:16, matrix:true},
});
export const RESOURCE_NAMES = {issue:'任务发射',memory:'外部供数 / 显存',memoryBandwidth:'外部传输带宽',memoryLatency:'访存响应延迟',l1:'L1 缓存',l2:'L2 缓存',alu:'ALU 计算',tensor:'Tensor 计算'};
const KEYS=['alu','clock','l1','l2','dram','scheduler','tensor','hbm','tma','tmem'];
const MAX=[63,8,4,4,4,4,6,4,4,4];
const cache=new Map();
function hardware(levels){return Object.fromEntries(KEYS.map((k,i)=>[k,Math.max(0,Math.min(MAX[i],Math.floor(Number(levels[k])||0)))]));}
const add=(costs,key,value)=>({...costs,[key]:(costs[key]??0)+value});
function lruRead(map,key){if(!map.has(key))return false;map.delete(key);map.set(key,true);return true;}
function lruFill(map,key,capacity){if(!capacity)return;map.delete(key);map.set(key,true);while(map.size>capacity)map.delete(map.keys().next().value);}
export function workloadShape(kind='fp32',tier=0) {
  if(!WORKLOADS[kind])throw new Error(`Unknown workload ${kind}`);
  tier=Math.max(0,Math.min(5,Math.floor(Number(tier)||0)));
  const footprint=WORKLOADS[kind].footprint*2**tier;
  // Stream touches seven new addresses per eight accesses, without cyclic reuse.
  return {tier,footprint:kind==='stream'?footprint*7/8:footprint,
    workingSetBytes:(kind==='stream'?footprint*7/8:footprint)*4096,
    tileCount:kind==='stream'?footprint:Math.max(24,footprint*3)};
}
export function simulateWorkshop(levels={},kind='fp32',tier=0,options={}) {
  const h=hardware(levels),spec=WORKLOADS[kind];if(!spec)throw new Error(`Unknown workload ${kind}`);
  const shape=workloadShape(kind,tier);
  const resources=Object.fromEntries(['issue','memory','l1','l2','alu','tensor'].map(k=>[k,{free:0,costs:{},busy:0,bytes:0}]));
  const events=[],pending=[],l1=new Map(),l2=new Map();let nextTile=0,finished=0,end=0,critical={},reads=0,hits=0,l1Hits=0,l2Hits=0;
  const clock=1+.35*h.clock,cores=1+h.alu;
  const memoryBandwidth=(h.hbm?4096*h.hbm: h.dram?512*(1+2*h.dram):512)*(options.bandwidthScale??1);
  const memoryLatency=(h.hbm?3:h.dram?5:8)*(options.latencyScale??1);
  const asyncEnabled=['async','gemm','attention'].includes(kind);
  const slots=1+h.scheduler+(asyncEnabled?2*h.tma:0)+(options.extraSlots??0);
  const tileCount=shape.tileCount;
  function reserve(resource,ready,service,latency,tile,operation,bytes,done){
    const r=resources[resource],start=Math.max(ready.time,r.free);
    const costs=ready.time>=r.free?ready.costs:r.costs;
    const serviceCosts=add(costs,resource==='memory'?'memoryBandwidth':resource,service);
    r.free=start+service;r.costs=serviceCosts;r.busy+=service;r.bytes+=bytes;
    const complete={time:r.free+latency,costs:add(serviceCosts,resource==='memory'?'memoryLatency':resource,latency)};
    if(options.recordEvents!==false)events.push({tile,resource,operation,start,end:complete.time,serviceEnd:r.free,bytes,ready:ready.time});
    pending.push({at:complete.time,run:()=>done(complete)});
  }
  function read(tile,ready,done){
    const address=kind==='stream'?(tile%8===7?tile-1:tile):tile%shape.footprint;
    reads++;let source='memory';if(lruRead(l1,address)){source='l1';hits++;l1Hits++;}else if(lruRead(l2,address)){source='l2';hits++;l2Hits++;}
    const bandwidth=source==='l1'?8192:source==='l2'?4096:memoryBandwidth;
    reserve(source,ready,4096/bandwidth,source==='l1'?1:source==='l2'?2:memoryLatency,tile,'read',4096,result=>{
      // Cache fills become visible only on completion, never on request issue.
      lruFill(l2,address,h.l2*64);lruFill(l1,address,h.l1*8);done(result);
    });
  }
  function startTile(ready){
    if(nextTile>=tileCount)return;const tile=nextTile++;
    reserve('issue',ready,1/(1+.2*h.scheduler),0,tile,'issue',0,issued=>read(tile,issued,loaded=>{
      const unit=spec.matrix&&h.tensor?'tensor':'alu';
      const rate=unit==='tensor'?512*h.tensor*clock:32*cores*clock;
      reserve(unit,loaded,spec.ops/rate,0,tile,'compute',0,computed=>{
        // TMEM retains matrix intermediates; only uncovered bytes spill.
        const intermediate=['gemm','attention'].includes(kind)?4096:0;
        const spill=Math.max(0,intermediate-h.tmem*2048);
        reserve('memory',computed,(1024+2*spill)/memoryBandwidth,memoryLatency,tile,'write / intermediate spill',1024+2*spill,stored=>{
          finished++;if(stored.time>=end){end=stored.time;critical=stored.costs;}startTile(stored);
        });
      });
    }));
  }
  for(let i=0;i<Math.min(slots,tileCount);i++)startTile({time:0,costs:{}});
  while(pending.length){pending.sort((a,b)=>a.at-b.at);pending.shift().run();}
  const bottleneck=Object.keys(critical).sort((a,b)=>critical[b]-critical[a])[0];
  return {kind,cycles:end,tileCount,finished,events,resources,critical,bottleneck,hitRate:hits/reads,l1Hits,l2Hits,reads,
    memoryBytes:resources.memory.bytes,slots,hardware:h,...shape,model:'workshop-resource-v2'};
}
// Fixed conversion for the economy: the original one-ALU FP32 workshop remains 1 work/s.
const BASELINE_TICKS_PER_TILE=simulateWorkshop({},'fp32').cycles/24;
export function workshopPerformance(levels,kind='fp32',tier=0) {
  tier=workloadShape(kind,tier).tier;
  const h=hardware(levels),key=JSON.stringify([kind,tier,...KEYS.map(k=>h[k])]);
  if(cache.has(key))return cache.get(key);
  const result=simulateWorkshop(h,kind,tier,{recordEvents:false});
  result.rate=BASELINE_TICKS_PER_TILE*result.tileCount/result.cycles;
  result.bottleneckLabel=RESOURCE_NAMES[result.bottleneck];
  if(cache.size>=128)cache.delete(cache.keys().next().value);
  cache.set(key,result);return result;
}
export function previewWorkshopUpgrade(levels,kind,id,tier=0){
  const h=hardware(levels),i=KEYS.indexOf(id);
  if(i<0||h[id]>=MAX[i]||(id==='dram'&&h.hbm>0))return null;
  const before=workshopPerformance(h,kind,tier),after=workshopPerformance({...h,[id]:h[id]+1},kind,tier);
  return {gain:after.rate/before.rate-1,before:before.cycles,after:after.cycles};
}

// Counterfactuals separate latency hiding from bandwidth limits. They are
// explanatory experiments, not simultaneous upgrades or additive speedups.
const diagnosisCache=new WeakMap();
export function diagnoseWorkshop(performance) {
  if(diagnosisCache.has(performance))return diagnosisCache.get(performance);
  const p=performance;
  const trial=options=>p.cycles/simulateWorkshop(p.hardware,p.kind,p.tier,{recordEvents:false,...options}).cycles-1;
  const result={bandwidth:trial({bandwidthScale:2}),latency:trial({latencyScale:.5}),concurrency:trial({extraSlots:1})};
  diagnosisCache.set(p,result);return result;
}
