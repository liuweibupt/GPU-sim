import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {validateDiagnostic,queryDiagnostic,parseAllocationIR} from '../lib/research/natural-diagnostic.js';
const full=JSON.parse(readFileSync(new URL('../web/research/natural-bugs/data.json',import.meta.url)));
const before=JSON.parse(readFileSync(new URL('../tools/research/natural-diagnostic/benchmark-before.json',import.meta.url)));
const hash=text=>createHash('sha256').update(text).digest('hex');

test('natural diagnostic source snapshots and 108 observed cases are bound',()=>{
  validateDiagnostic(full);assert.equal(full.cases.length,108);
  assert.equal(full.cases.filter(c=>c.family==='cutlass').length,76);
  assert.equal(full.cases.filter(c=>c.family==='tmem').length,32);
  for(const source of full.sources)assert.equal(hash(source.text),source.sha256);
  for(const fact of full.evidence.filter(e=>e.kind==='device-output')){
    assert.equal(fact.outputsChecked,fact.outputs.reduce((n,out)=>n+out.actual.length,0));
    assert.equal(fact.mismatches,fact.outputs.reduce((n,out)=>n+out.actual.filter(v=>v!==out.referenceValue).length,0));
  }
});
test('before-only projection contains identical original input text and facts, with no repair metadata',()=>{
  validateDiagnostic(before);assert.equal(before.cases.length,40);
  assert(before.cases.every(c=>c.version==='input'&&!('label'in c)&&!('pairKey'in c)));
  for(const source of before.sources){
    assert.equal(hash(source.text),source.sha256);
    assert(full.sources.some(original=>original.version==='before'&&original.text===source.text));
    assert.equal(source.version,'input');assert(!source.path.includes('before'));
  }
  for(const fact of before.evidence){
    assert(!('candidates'in fact)&&!('possible_selected_lifetime_overlaps'in fact));
    assert(fact.rawRefs.every(ref=>/^raw-\d+$/.test(ref.id)));
  }
  const noSourceText=JSON.stringify({...before,sources:before.sources.map(({text,...source})=>source)});
  assert(!/source_commit|"issue"|fix\.patch|guards\.patch|"after"|repaired_cases/.test(noSourceText));
});
test('query is side-effect free, returned values cannot mutate input, and rawRefs remain attached',()=>{
  const frozen=JSON.stringify(before),result=queryDiagnostic(before,{op:'case',id:'case-24'});
  result.case.parameters.choice=900;result.evidence[0].outputs[0].actual[0]=900;
  assert.equal(JSON.stringify(before),frozen);
  const overlap=queryDiagnostic(before,{op:'overlap',id:'case-24'});
  assert.equal(overlap.candidates.length,2);assert(overlap.candidates.every(c=>c.rawRefs.length&&c.rawRefs[0].lines.length===5));
  assert.equal(JSON.stringify(before),frozen);
});
test('static source-derived overlap agrees with all 32 saved numerical cases without consulting status',()=>{
  let wrong=0;
  for(const item of full.cases.filter(c=>c.family==='tmem')){
    const result=queryDiagnostic(full,{op:'overlap',id:item.id});
    const outputs=full.evidence.find(e=>e.id===item.evidenceRefs[0]).outputs;
    const affected=result.candidates.some(candidate=>candidate.selectedSourceValue===outputs[0].referenceValue);
    assert.equal(affected,outputs[0].mismatches>0,item.id);wrong+=affected;
  }
  assert.equal(wrong,7);
  const changed=structuredClone(before);changed.cases.find(c=>c.id==='case-24').status='passed';
  assert.deepEqual(queryDiagnostic(changed,{op:'overlap',id:'case-24'}),queryDiagnostic(before,{op:'overlap',id:'case-24'}));
});
test('contrast keeps the beta=1 nonzero-control confounder separate and counts actual trials',()=>{
  const rows=queryDiagnostic(before,{op:'contrast',family:'cutlass',groupBy:['beta','hasZeroK']}).groups;
  assert.deepEqual(rows.map(row=>row.counts),[{passed:2},{execution_error:2},{timeout:10},{execution_error:10}]);
  assert(rows.every(row=>row.rawRefs.length===row.caseIds.length));
  assert.equal(queryDiagnostic(before,{op:'cases',family:'tmem',parameters:{columns:32}}).cases.length,2);
});
test('source search and bounded unsupported queries fail explicitly',()=>{
  const source=queryDiagnostic(before,{op:'source',id:'source-00',start:816,end:831,search:'consumer_wait'});
  assert.equal(source.start,816);assert(source.matches.length>0);assert(source.text.includes('consumer_wait'));
  assert.throws(()=>queryDiagnostic(before,{op:'source',id:'source-00',start:-1}));
  assert.throws(()=>queryDiagnostic(before,{op:'case',id:'missing'}));
  assert.throws(()=>queryDiagnostic(before,{op:'execute'}));
  assert.equal(queryDiagnostic(before,{op:'overlap',id:'case-00'}).supported,false);
  assert.throws(()=>parseAllocationIR('unrelated IR'));
  const bad=structuredClone(before);bad.cases[0].sourceRefs.push('missing');assert.throws(()=>validateDiagnostic(bad));
});
