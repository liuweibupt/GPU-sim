/** Synthetic-only reporting integration test. Never reads real trial directories. */
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {freezeStudy, verifyFreeze, runTrial} from '../../../tools/research/repair-study-v2/run.mjs';
import {sha} from '../../../tools/research/repair-study-v2/core.mjs';
import {analyze} from '../../../tools/research/repair-study-v2/analyze.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const save = (p, x) => writeFile(p, JSON.stringify(x, null, 2) + '\n');
const directory = await mkdtemp(path.join(ROOT, 'out/research/repair-v2-audit/.report-fixture-'));
const assertions = [];
try {
  const tasks = ['liger-unit-only', 'triton-unit-only'].map(id => {
    const texts = ['function op(x) {\n  return x-1;\n}\n', 'export function caller(x) { return op(x); }\n'];
    return {id, family: 'synthetic-reporting-test-only', split: 'development', objective: 'Synthetic unit fixture, no real GPU result.',
      files: texts.map((text, i) => ({id: 'source-' + i, path: 'src/file-' + i + '.js', text, sha256: sha(text), role: 'implementation'})),
      cases: [{id: 'visible-bad', status: 'wrong_value', parameters: {x: 1}, evidenceRefs: ['obs-bad']}, {id: 'visible-good', status: 'passed', parameters: {x: 0}, evidenceRefs: ['obs-good']}],
      evidence: ['bad', 'good'].map(suffix => ({id: 'obs-' + suffix, kind: 'device-output', caseIds: ['visible-' + suffix], observed: true, text: 'synthetic observation', rawRefs: [{id: 'raw-' + suffix, sha256: 'a'.repeat(64)}]}))};
  });
  const catalog = {format: 'repair-study-catalog-v2', tasks};
  const privatePlan = {format: 'repair-study-private-v2', tasks: tasks.map(task => ({id: task.id, rootCauseId: task.id, relevantRegions: [{source_id: 'source-0', start_line: 1, end_line: 3}], hiddenCaseIds: ['hidden-one'], hiddenSpecSHA256: 'b'.repeat(64), requirePassingControl: true}))};
  const base = path.join(directory, 'base'), studyDir = path.join(directory, 'study'); await mkdir(path.join(base, 'repair-v2-input'), {recursive: true});
  await save(path.join(base, 'repair-v2-input/catalog.json'), catalog); await save(path.join(directory, 'private.json'), privatePlan);
  await freezeStudy(studyDir, path.join(base, 'repair-v2-input/catalog.json'), path.join(directory, 'private.json'), path.join(ROOT, 'out/research/repair-v2-tools-frozen'), {repetitions: 1, maxQueries: 1, maxCalls: 2});
  const study = await verifyFreeze(studyDir); await mkdir(path.join(studyDir, 'trials'));
  for (const scheduled of study.schedule) {
    const invoke = async (prompt, dir, round) => {
      const q = {op: 'none', scope: null, id: null, text: null, start: null, end: null, offset: null, derived_op: null, groupBy: null};
      const request = scheduled.condition === 'diagnostic' && round === 1;
      const answer = {action: request ? 'query' : 'final', query: request ? {...q, op: 'derived', derived_op: 'overlap', id: 'visible-bad'} : q,
        diagnosis: 'Synthetic fixture only.', locations: [{source_id: 'source-0', start_line: 1, end_line: 3}], citations: [{case_id: 'visible-bad', evidence_ids: ['obs-bad']}, {case_id: 'visible-good', evidence_ids: ['obs-good']}], edits: [{source_id: 'source-0', old: 'return x-1;', new: 'return x;'}]};
      const usage = scheduled.taskId.startsWith('liger-') ? [round === 1 ? null : {}] : [{input_tokens: 100, output_tokens: 5, cached_input_tokens: 10}];
      const call = {round, valid: true, answer, wallSeconds: .001, usage, promptSHA256: sha(prompt)};
      const events = [{type: 'thread.started', thread_id: 'synthetic-only'}, {type: 'item.completed', item: {type: 'agent_message', text: JSON.stringify(answer)}}, {type: 'turn.completed', usage: usage[0]}];
      await writeFile(path.join(dir, `round-${round}.prompt.txt`), prompt); await save(path.join(dir, `round-${round}.json`), call);
      await writeFile(path.join(dir, `round-${round}.jsonl`), events.map(x => JSON.stringify(x)).join('\n') + '\n'); return call;
    };
    await runTrial(studyDir, scheduled, study, invoke);
  }
  const generation = await Promise.all(study.schedule.map(t => readFile(path.join(studyDir, 'trials', t.id, 'result.json'), 'utf8').then(JSON.parse)));
  const runtimeStart = new Date(Math.max(...generation.map(g => Date.parse(g.finishedAt))) + 1000).toISOString();
  for (const scheduled of study.schedule) {
    const liger = scheduled.taskId.startsWith('liger-'), dir = path.join(base, liger ? 'liger-faults' : 'natural-fault-expansion', 'candidate-evaluations', scheduled.id);
    await mkdir(path.join(dir, 'run'), {recursive: true});
    const cases = [{id: 'visible-bad', status: liger ? 'failed' : 'passed'}, {id: 'visible-good', status: 'passed'}, {id: 'hidden-one', status: 'passed'}];
    const receipt = liger ? {unitTestOnly: true, expected_cases: 3, outputs: 42, cases: cases.map(c => ({id: c.id, passed: c.status === 'passed'}))} : {unitTestOnly: true, total_elements: 42, cases};
    const receiptPath = path.join(dir, 'independent-verification.json'); await save(receiptPath, receipt);
    const candidate = JSON.parse(await readFile(path.join(studyDir, 'trials', scheduled.id, 'candidate.json')));
    await save(path.join(dir, 'runtime-record.json'), {unitTestOnly: true, candidateTreeSHA256: candidate.candidateTreeSHA256, hiddenSpecSHA256: 'b'.repeat(64), buildStatus: 'passed', verifierStatus: 'verified', verifierReceiptSHA256: sha(await readFile(receiptPath)), cases: cases.filter(c => c.id === 'hidden-one'), visibleCases: cases.filter(c => c.id !== 'hidden-one'), wall_seconds: .002});
    await save(path.join(dir, 'run/summary.json'), liger ? {started_at: runtimeStart} : {started_utc: runtimeStart});
  }
  await analyze(studyDir, base);
  const report = JSON.parse(await readFile(path.join(studyDir, 'analysis.json')));
  assert.equal(report.plannedTrials, 4); assertions.push('synthetic-four-trial denominator retained');
  assert.ok(report.rows.every(row => row.endpoint.success)); assertions.push('both Liger boolean and Triton status schemas map hidden pass');
  for (const row of report.rows) {
    assert.equal(row.outputsVerified, 42);
    assert.equal(row.allCasesSuccess, row.taskId.startsWith('triton-'));
    assert.equal(row.visiblePassingControlRegressions, 0);
    assert.equal(row.visibleFailures, row.taskId.startsWith('liger-') ? 1 : 0);
    if (row.taskId.startsWith('liger-')) { assert.equal(row.callsWithoutUsage, row.calls); assert.equal(row.usage.input_tokens, undefined); }
    if (row.condition === 'diagnostic') { assert.equal(row.derivedRequests, 1); assert.equal(row.acceptedDerivedRequests, 1); assert.equal(row.successfulDerivedRequests, 0); }
  }
  assertions.push('null/empty usage stays missing', 'unsupported derived result not successful uptake', 'visible failing bug not mislabelled passing-control regression', 'hidden and all-case endpoints separated', 'full-output fields normalized');
  const corruptDir = path.join(base, 'liger-faults/candidate-evaluations', study.schedule.find(t => t.taskId.startsWith('liger-')).id);
  const p = path.join(corruptDir, 'runtime-record.json'), record = JSON.parse(await readFile(p)); record.cases[0].status = 'failed'; await save(p, record);
  await assert.rejects(() => analyze(studyDir, base), /mapping differs/); assertions.push('runtime-record mapping tamper rejected');
  record.cases[0].status = 'passed'; await save(p, record);
  await save(path.join(corruptDir, 'run/summary.json'), {started_at: '2000-01-01T00:00:00Z'});
  await assert.rejects(() => analyze(studyDir, base), /preceded generation/); assertions.push('evaluation-before-generation timestamp rejected');
  const receipt = {format: 'reporting-adapter-synthetic-integration-review-v1', unitTestOnly: true, modelCalls: 0, gpuCalls: 0, actualStudyAnswersRead: 0, assertions, passed: assertions.length, reportingSourceSHA256: sha(await readFile(path.join(ROOT, 'tools/research/repair-study-v2/analyze.mjs')))};
  await save(path.join(ROOT, 'out/research/repair-v2-audit/reporting-synthetic-test.json'), receipt);
  process.stdout.write(JSON.stringify(receipt) + '\n');
} finally { await rm(directory, {recursive: true, force: true}); }
