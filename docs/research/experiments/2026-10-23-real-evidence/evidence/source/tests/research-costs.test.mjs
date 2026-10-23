import test from 'node:test';
import assert from 'node:assert/strict';
import {quantiles, selectedQueries, verifySlice} from '../tools/research/costs/analysis-cost.mjs';
import {protocolCorpus} from '../tools/research/protocol-corpus.mjs';
import {checkProtocol} from '../lib/research/protocol.js';
import {sliceEvidence} from '../lib/research/evidence.js';

test('cost distributions preserve long tail and use interpolated quantiles',()=>{
  assert.deepEqual(quantiles([1000,1,3,2]),{n:4,min:1,p05:1.15,median:2.5,p95:850.4499999999996,max:1000});
  assert.throws(()=>quantiles([]),/empty/);
});
test('cost query selection preserves definite and unknown protocol witnesses',()=>{
  for(const {capture} of protocolCorpus()) {
    const run=checkProtocol(capture);
    for(const q of selectedQueries(run))verifySlice(run,sliceEvidence(run,q.subjects),q.id);
  }
});
test('cost validation rejects a slice that lost its positive witness',()=>{
  const fixture=protocolCorpus().find(x=>x.id==='completion-forward');
  const run=checkProtocol(fixture.capture),q=selectedQueries(run)[0],slice=sliceEvidence(run,q.subjects);
  const witness=run.obligations.find(o=>o.id===q.id).positiveWitnessRefs[0];
  slice.evidence=slice.evidence.filter(e=>e.id!==witness);
  assert.throws(()=>verifySlice(run,slice,q.id),/dropped evidence/);
});
