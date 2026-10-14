import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildDataflow,reachable,eventState,stages} from '../lib/dataflow.js';
test('native Load → Tensor → register store → TMA store remains traversable',()=>{
 const trace=JSON.parse(readFileSync(new URL('../examples/gtsim-gemm.json',import.meta.url)));
 const model=buildDataflow(trace), upstream=reachable(model,'node-394','upstream');
 for(const id of ['node-0','node-5','node-266'])assert.ok(upstream.has(id),id);
 assert.ok(reachable(model,'node-0','downstream').has('node-394'));
 assert.equal(new Set(model.incoming.get('node-266').map(e=>e.source)).size,model.incoming.get('node-266').length);
 assert.deepEqual(stages.map(s=>trace.events.filter(e=>e.args.op===s.op).length),[20,512,256,8]);
});
test('distinct edge meanings, omitted endpoints, and exact time boundaries',()=>{
 const model=buildDataflow({events:[{id:'b',start:3,end:5,dependencies:[],args:{issueDependencies:['a']}}],metrics:{omittedNodes:[{id:'a',start:1,end:null,dependencies:[]}]}});
 assert.equal(model.incoming.get('b')[0].kind,'issue');
 assert.ok(reachable(model,'b','upstream').has('a'));
 assert.equal(eventState(model.nodes.get('a'),4),'未完成（结束未知）');
 assert.equal(eventState(model.events.get('b'),3),'进行中');
 assert.equal(eventState(model.events.get('b'),5),'已完成');
 assert.equal(eventState({start:0,end:0},0),'已完成');
});
test('unrelated profile tracks have no invented dependencies',()=>{
 const model=buildDataflow({events:[{id:'x',category:'Tensor',dependencies:[]}]});
 assert.equal(model.incoming.size,0);assert.equal(reachable(model,'x','downstream').size,0);
});

import {flowGroups,activityWindows} from '../lib/dataflow.js';
test('CTA identities stay separate across SMs, including zero IDs',()=>{
 const event=(smId,threadBlockId)=>({args:{smId,threadBlockId,op:'cp.dram2sram_tma'}});
 const groups=flowGroups([event(0,0),event(1,0),event(0,1)],'cta');
 assert.equal(groups.length,3);assert.equal(groups[0].label,'SM 0 / CTA 0');
 assert.equal(flowGroups([{category:'LD',args:{smId:0}}]).length,0);
});
test('parallel windows use interval unions and half-open boundaries',()=>{
 const e=(op,start,end)=>({start,end,args:{op}});
 const windows=activityWindows([e('cp.dram2sram_tma',0,10),e('cp.dram2sram_tma',2,8),e('wgmma.m64n64k16',5,12),e('st.reg2sram',12,14)]);
 assert.equal(windows.filter(w=>w.overlap).reduce((s,w)=>s+w.end-w.start,0),5);
 assert.equal(windows.find(w=>w.start===12).overlap,false);
 assert.equal(windows.find(w=>w.start===5).load,2);
});

import {tilePayload,transferPackets} from '../lib/dataflow.js';
test('tile sizes preserve element counts; byte sizes require an explicit assumption',()=>{
 const e={args:{tile:{rows:128,cols:64}}};
 assert.deepEqual(tilePayload(e),{rows:128,cols:64,elements:8192,bytes:null});
 assert.equal(tilePayload(e,2).bytes,16384);
 assert.equal(tilePayload({args:{tile:{rows:0,cols:64}}}),null);
 assert.equal(tilePayload({}),null);
});
test('shared operand references are deduplicated and store payloads are not multiplied by dependency count',()=>{
 const load={id:'a',start:0,end:2,args:{op:'cp.dram2sram_tma',tile:{rows:128,cols:64}}};
 const tensor=id=>({id,start:2,end:5,dependencies:['a'],args:{op:'wgmma.m64n64k16'}});
 const t1=tensor('b'),t2=tensor('c');
 const store={id:'d',start:5,end:7,dependencies:['b','c'],args:{op:'st.reg2sram',tile:{rows:16,cols:16}}};
 const model=buildDataflow({events:[load,t1,t2,store]});
 const refs=transferPackets([t1,t2],model);
 assert.equal(refs.length,1);assert.deepEqual(refs[0].consumers,['b','c']);assert.equal(refs[0].reference,true);
 assert.equal(transferPackets([store],model).length,1);
});
