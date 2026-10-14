import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeTrace, validateTrace, stateAt, traceBounds} from '../lib/trace.js';

function simple() {
  return {schemaVersion:1, meta:{producer:'test', evidenceKind:'illustration',timeUnit:'cycle'},
    components:[{id:'gpu',label:'GPU',kind:'gpu'}, {id:'sm',label:'SM',kind:'sm',parentId:'gpu'}],
    events:[{id:'a',name:'load',componentId:'sm',start:0,end:4,dependencies:[]},
      {id:'b',name:'compute',componentId:'sm',start:4,end:7,dependencies:['a']}],metrics:{}};
}

test('half-open boundaries, zero duration and deterministic rewind', () => {
  const trace = simple();
  trace.events.push({id:'z',name:'instant',componentId:'sm',start:4,end:4,dependencies:[]});
  validateTrace(trace);
  const before = JSON.stringify(trace);
  assert.deepEqual(stateAt(trace, 0).active.map(e => e.id), ['a']);
  assert.deepEqual(stateAt(trace, 4).active.map(e => e.id), ['b']);
  assert.deepEqual(stateAt(trace, 4).completed.map(e => e.id), ['a','z']);
  assert.equal(stateAt(trace, 7).completed.length, 3);
  assert.equal(stateAt(trace, 1).active[0].id, 'a');
  assert.equal(JSON.stringify(trace), before);
});

test('completion dependencies and issue-order dependencies have different semantics', () => {
  const trace = simple();
  trace.events[0].end = 10;
  assert.throws(() => validateTrace(trace), /完成依赖违反时序/);
  trace.events[1].dependencies = [];
  trace.events[1].args = {issueDependencies:['a']};
  validateTrace(trace);
  trace.events[0].args = {issueReleaseCycle:5};
  assert.throws(() => validateTrace(trace), /发射依赖违反时序/);
  trace.events[0].args = {issueReleaseCycle:-1};
  assert.throws(() => validateTrace(trace), /释放时间超出/);
});

test('invalid topology, missing dependencies, cycles and NaN are rejected', () => {
  for (const mutation of [
    t => t.components[0].parentId = 'sm',
    t => t.events[0].dependencies.push('missing'),
    t => t.events[0].end = NaN,
    t => t.events[1].id = 'a',
    t => t.events[0].componentId = 'missing'
  ]) {
    const trace = simple(); mutation(trace);
    assert.throws(() => validateTrace(trace));
  }
  const trace = simple();
  for (const event of trace.events) { event.start = 0; event.end = 0; }
  trace.events[0].dependencies = ['b'];
  assert.throws(() => validateTrace(trace), /存在环/);
});

test('Chrome complete events preserve exact timestamps, raw records and track identity', () => {
  // This is the actual Kineto envelope shape, including its own schemaVersion.
  const raw = {schemaVersion:1, displayTimeUnit:'ns', traceEvents:[
    {ph:'M',pid:5,name:'process_name',args:{name:'GPU 0'}},
    {ph:'M',pid:5,tid:9,name:'thread_name',args:{name:'stream 7'}},
    {ph:'X',pid:5,tid:9,ts:1000.125,dur:2.25,name:'gemm',cat:'kernel',args:{correlation:4}},
    {ph:'C',pid:5,tid:9,ts:1001,name:'metric',args:{value:8}},
    {ph:'s',pid:5,tid:9,ts:1000,id:4,name:'flow'}
  ]};
  const trace = normalizeTrace(raw);
  assert.equal(trace.meta.timeUnit, 'us'); // Chrome timestamp unit, not displayTimeUnit.
  assert.equal(trace.events[0].start, 1000.125);
  assert.equal(trace.events[0].end, 1002.375);
  assert.equal(trace.events[0].category, 'compute');
  assert.deepEqual(trace.events[0].dependencies, []); // Correlation is not a causal proof.
  assert.equal(trace.components.find(c => c.id === 'p:5/t:9').label, 'stream 7');
  assert.equal(trace.meta.importSummary.ignoredPhases.C, 1);
  assert.equal(trace.source.raw, raw);
  assert.equal(trace.meta.evidenceKind, 'measurement');
  assert.deepEqual(traceBounds(trace), {start:1000.125,end:1002.375});
});

test('nested Chrome B/E pairs, missing endpoints and unsupported phases', () => {
  const trace = normalizeTrace({traceEvents:[
    {ph:'B',pid:1,tid:1,ts:0,name:'outer'},
    {ph:'B',pid:1,tid:1,ts:1,name:'inner'},
    {ph:'E',pid:1,tid:1,ts:2}, {ph:'E',pid:1,tid:1,ts:3},
    {ph:'E',pid:1,tid:1,ts:4}, {ph:'B',pid:1,tid:1,ts:5,name:'unfinished'}
  ]});
  assert.deepEqual(trace.events.map(e => [e.name,e.start,e.end]), [['outer',0,3],['inner',1,2]]);
  assert.equal(trace.meta.importSummary.unmatchedBegins, 1);
  assert.equal(trace.meta.importSummary.unmatchedEnds, 1);
  assert.throws(() => normalizeTrace({traceEvents:[{ph:'I',ts:1,name:'point'}]}), /没有可回放/);
  assert.throws(() => normalizeTrace({traceEvents:[{ph:'X',ts:1,dur:-1,name:'bad'}]}), /dur 无效/);
});

test('canonical round trip leaves authoritative timing unchanged', () => {
  const trace = simple();
  assert.deepEqual(normalizeTrace(JSON.parse(JSON.stringify(trace))), trace);
});

test('component cardinality is bounded before rendering imported tracks', () => {
  const trace = simple();
  trace.components = Array.from({length:2001}, (_, i) => ({id:`c${i}`,label:`Track ${i}`}));
  assert.throws(() => validateTrace(trace), /2,000 个组件/);
});

test('partial runs retain an unfinished issue producer without inventing an endpoint', () => {
  const trace = simple();
  trace.events = [{id:'consumer',name:'issued later',componentId:'sm',start:4,end:7,dependencies:[],args:{issueDependencies:['producer']}}];
  trace.metrics.omittedNodes = [{id:'producer',status:'started-incomplete',start:1,end:null,dependencies:[],issueDependencies:[]}];
  validateTrace(trace);
  assert.equal(trace.metrics.omittedNodes[0].end,null);
  assert.equal(stateAt(trace,5).active[0].id,'consumer');
  trace.events[0].dependencies = ['producer'];
  assert.throws(() => validateTrace(trace),/完成依赖违反时序/);
  trace.events[0].dependencies = [];
  trace.metrics.omittedNodes[0].status = 'unissued';
  trace.metrics.omittedNodes[0].start = null;
  assert.throws(() => validateTrace(trace),/发射依赖违反时序/);
});

for (const [name, cycles] of [['gtsim-gemm',5492], ['gtsim-gemm-slow-l2',6413]]) {
  test(`bundled ${name} satisfies native completion, provenance and all dependencies`, async () => {
    const trace = normalizeTrace(JSON.parse(await readFile(new URL(`../examples/${name}.json`, import.meta.url),'utf8')));
    assert.equal(trace.meta.evidenceKind,'simulation');
    assert.match(trace.meta.producer,/GTSim/i);
    assert.equal(trace.meta.timeUnit,'cycle');
    assert.equal(trace.events.length,796);
    const finalTime = traceBounds(trace).end;
    assert.equal(finalTime, cycles);
    assert.equal(finalTime, trace.metrics.totalCycles);
    assert.equal(stateAt(trace, finalTime).pending.length,0);
    assert.equal(stateAt(trace, finalTime).active.length,0);
  });
}
