/** Verify an extracted v2 package with no model calls, GPU, or network. */
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {replayStudy, verifyFreeze} from './run.mjs';
import {sha, scoreRuntime} from './core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const need = (v, m) => { if (!v) throw Error(m); };
const canonicalCases = a => JSON.stringify(a.map(c => ({id: c.id, status: c.status})).sort((a,b) => a.id.localeCompare(b.id)));

export async function verifyArchive(base) {
  const tool = await json(path.join(base, 'tools-freeze', 'manifest.json'));
  for (const [file, hash] of Object.entries(tool.sources)) {
    need(sha(await readFile(path.join(base, 'tools-freeze', 'source', file))) === hash, 'tool snapshot differs');
    need(sha(await readFile(path.join(ROOT, file))) === hash, 'working replay implementation differs');
  }
  const runtime = await json(path.join(base, 'runtime-freeze', 'manifest.json'));
  for (const e of runtime.files) {
    need(sha(await readFile(path.join(base, 'runtime-freeze', 'source', e.path))) === e.sha256, 'runtime snapshot differs');
    const mappings = [
      ['tools/research/liger-faults/', 'liger/reproduction/'],
      ['tools/research/natural-fault-expansion/', 'triton/reproduction/'],
      ['out/research/liger-faults/', 'liger/'],
      ['out/research/natural-fault-expansion/', 'triton/'],
    ];
    const mapping = mappings.find(([prefix]) => e.path.startsWith(prefix));
    need(mapping, 'unmapped frozen runtime source');
    const packagePath = mapping[1] + e.path.slice(mapping[0].length);
    need(sha(await readFile(path.join(base, packagePath))) === e.sha256, 'published runtime/contract differs from pre-generation freeze');
  }
  const studyDir = path.join(base, 'study');
  const study = await verifyFreeze(studyDir, {workingSources: false});
  const provenanceHashes = new Set();
  for (const family of ['triton','liger']) {
    const manifest=await json(path.join(base,family,'publication-manifest.json'));
    for(const f of manifest.files) provenanceHashes.add(f.sha256);
  }
  let rawProvenanceBindings=0;
  for(const task of study.catalog.tasks) for(const fact of task.evidence) for(const raw of fact.rawRefs) {
    need(provenanceHashes.has(raw.sha256),'visible raw provenance absent from published evidence'); rawProvenanceBindings++;
  }
  need(sha(await readFile(path.join(base, 'tools-freeze', 'manifest.json'))) === study.manifest.toolFreezeSHA256, 'tool manifest binding differs');
  const replay = await replayStudy(studyDir, {workingSources: false});
  need(replay.verifiedTrials === study.schedule.length, 'not every frozen generation trial replays');
  const runs = await json(path.join(studyDir, 'runtime-results.json'));
  const summary = await json(path.join(studyDir, 'runtime-summary.json'));
  const analysis = await json(path.join(studyDir, 'analysis.json'));
  need(runs.results.length === new Set(runs.results.map(r=>r.trialId)).size, 'duplicate runtime trial');
  const receipts = [];
  for (const t of study.schedule) {
    const r = runs.results.find(r=>r.trialId===t.id), frozenRow = summary.rows.find(r=>r.id===t.id);
    const spec = study.privatePlan.tasks.find(r=>r.id===t.taskId);
    const generation = await json(path.join(studyDir, 'trials', t.id, 'result.json'));
    let candidate = null;
    if (generation.patchApplicable) candidate = await json(path.join(studyDir, 'trials', t.id, 'candidate.json'));
    let endpoint = scoreRuntime(spec, candidate, r);
    if (!generation.valid || !generation.patchApplicable) endpoint = {...endpoint, success:false};
    need(endpoint.success === frozenRow.endpoint.success, 'recomputed endpoint differs');
    if (!r) {
      need(!endpoint.success, 'missing runtime counted successful');
      receipts.push({trialId:t.id,status:'not-executed'}); continue;
    }
    const family = t.taskId.startsWith('liger-') ? 'liger' : 'triton';
    const directory = path.join(base, family, 'candidate-evaluations', t.id);
    const actualRecord = await json(path.join(directory, 'runtime-record.json'));
    const {trialId,verifierReceiptPath,...recordWithoutJoinFields} = r;
    need(JSON.stringify(recordWithoutJoinFields) === JSON.stringify(actualRecord), 'joined runtime differs from original receipt');
    if (r.verifierStatus === 'verified') {
      const bytes = await readFile(path.join(directory, 'independent-verification.json'));
      need(sha(bytes) === r.verifierReceiptSHA256, 'independent receipt binding differs');
      const v = JSON.parse(bytes), all = v.cases.map(c=>({id:c.id,status:typeof c.passed==='boolean'?c.passed?'passed':'failed':c.status}));
      need(canonicalCases(r.cases) === canonicalCases(all.filter(c=>spec.hiddenCaseIds.includes(c.id))), 'hidden result mapping differs');
      need(canonicalCases(r.visibleCases) === canonicalCases(all.filter(c=>!spec.hiddenCaseIds.includes(c.id))), 'visible result mapping differs');
      const run = await json(path.join(directory, 'run', 'summary.json'));
      const start = run.started_at ?? run.started_utc;
      need(start && new Date(start) >= new Date(runs.allGenerationFinishedAt), 'GPU validation preceded last model generation');
      receipts.push({trialId:t.id,status:'verified',hiddenSuccess:endpoint.success,cases:all.length});
    } else receipts.push({trialId:t.id,status:'failed-or-incomplete',hiddenSuccess:false});
  }
  need(runs.results.every(r=>study.schedule.some(t=>t.id===r.trialId)), 'unplanned runtime record');
  for (const group of analysis.groups) {
    const subset=summary.rows.filter(r=>r.condition===group.condition);
    need(group.planned===subset.length && group.hiddenRepairSuccess===subset.filter(r=>r.endpoint.success).length,'analysis success denominator differs');
  }
  // These hash-checked package scripts recompute every retained device result.
  const triton = JSON.parse(execFileSync('python3', [path.join(base,'triton/reproduction/publish.py'),'--verify-package',path.join(base,'triton')],{encoding:'utf8',maxBuffer:16*1024*1024}));
  const liger = JSON.parse(execFileSync('python3', [path.join(base,'liger/reproduction/verify_publication.py'),path.join(base,'liger')],{encoding:'utf8',maxBuffer:16*1024*1024}));
  return {format:'repair-study-offline-roundtrip-v2', status:'verified', modelCalls:0, gpuCalls:0,
    frozenToolFiles:Object.keys(tool.sources).length, frozenRuntimeFiles:runtime.files.length,rawProvenanceBindings,
    replayedTrials:replay.verifiedTrials, plannedTrials:study.schedule.length, receipts,
    triton:{files:triton.files_checked,runs:triton.runs.length,cases:triton.runs.reduce((s,r)=>s+r.case_count,0)},liger,
    scope:'Archived complete-output recomputation and original transcript/query/patch replay; this is audit, not fresh hardware execution.'};
}

if (process.argv[1]?.endsWith('verify_archive.mjs')) console.log(JSON.stringify(await verifyArchive(path.resolve(process.argv[2])),null,2));
