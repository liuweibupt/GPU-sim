/** Outcome-blind audit: never opens trials, answers, generation logs or candidate runtime results. */
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {verifyFreeze} from '../../../tools/research/repair-study-v2/run.mjs';
import {initialPacket, rawQuery} from '../../../tools/research/repair-study-v2/query.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const inputPaths = [];
async function read(relative) { inputPaths.push(relative); return readFile(path.join(ROOT, relative)); }
const study = await verifyFreeze(path.join(ROOT, 'out/research/repair-v2-study'));
const {catalog, privatePlan, protocol, schedule, manifest} = study;
const runtimeManifest = JSON.parse(await read('out/research/repair-v2-runtime-frozen/manifest.json'));
for (const file of runtimeManifest.files) {
  const current = await read(file.path), stored = await read('out/research/repair-v2-runtime-frozen/source/' + file.path);
  assert.equal(sha(current), file.sha256); assert.equal(sha(stored), file.sha256); assert.equal(current.length, file.bytes);
}
const start = JSON.parse(await read('out/research/repair-v2-study/run-start.json'));
assert.ok(Date.parse(manifest.toolManifest.frozenAt) < Date.parse(runtimeManifest.frozen_at));
assert.ok(Date.parse(runtimeManifest.frozen_at) <= Date.parse(manifest.frozenAt));
assert.ok(Date.parse(manifest.frozenAt) < Date.parse(start.startedAt));
assert.equal(catalog.tasks.length, 6); assert.equal(schedule.length, 36); assert.equal(new Set(privatePlan.tasks.map(t => t.rootCauseId)).size, 6);
assert.equal(protocol.repetitions, 3); assert.equal(protocol.feedbackRounds, 0);
const tasks = [];
for (const task of catalog.tasks) {
  const spec = privatePlan.tasks.find(t => t.id === task.id), entries = schedule.filter(t => t.taskId === task.id);
  assert.equal(entries.length, 6);
  for (const condition of ['raw', 'diagnostic']) assert.deepEqual(entries.filter(t => t.condition === condition).map(t => t.repetition).sort(), [1, 2, 3]);
  const rawPrompt = (await read(`out/research/repair-v2-study/frozen/${task.id}.raw.prompt.txt`)).toString();
  const diagnosticPrompt = (await read(`out/research/repair-v2-study/frozen/${task.id}.diagnostic.prompt.txt`)).toString();
  const rawInitial = rawPrompt.split('INITIAL CATALOG:\n')[1], diagnosticInitial = diagnosticPrompt.split('INITIAL CATALOG:\n')[1];
  assert.equal(rawInitial, diagnosticInitial); assert.deepEqual(JSON.parse(rawInitial), initialPacket(task));
  const requests = [{op: 'list'}, ...task.cases.map(c => ({op: 'case', id: c.id})),
    ...task.files.map(f => ({op: 'read', id: f.id, start: 1, end: Math.min(f.text.split('\n').length, protocol.maxSourceLines)}))];
  for (const request of requests) assert.deepEqual(rawQuery(task, 'raw', request, protocol), rawQuery(task, 'diagnostic', request, protocol));
  assert.ok(task.cases.some(c => c.status !== 'passed')); assert.ok(task.cases.some(c => c.status === 'passed'));
  assert.ok(spec.hiddenCaseIds.every(id => !task.cases.some(c => c.id === id)));
  tasks.push({id: task.id, rootCauseId: spec.rootCauseId, split: task.split, files: task.files.length,
    editableFiles: task.files.filter(f => f.role === 'implementation').length, sourceCharacters: task.files.reduce((sum, f) => sum + f.text.length, 0),
    visibleCases: task.cases.length, hiddenCases: spec.hiddenCaseIds.length, visiblePassingControls: task.cases.filter(c => c.status === 'passed').length,
    scheduledTrials: entries.length, initialPacketsIdentical: true, ordinaryRequestsMatched: requests.length,
    rawPromptCharacters: rawPrompt.length, diagnosticPromptCharacters: diagnosticPrompt.length, diagnosticInstructionExtraCharacters: diagnosticPrompt.length - rawPrompt.length});
}
for (let i = 0; i < schedule.length; i += 2) assert.ok(schedule[i].taskId === schedule[i + 1].taskId && schedule[i].repetition === schedule[i + 1].repetition && schedule[i].condition !== schedule[i + 1].condition);
const receipt = {format: 'repair-v2-outcome-blind-methodology-audit-v1', auditedAt: new Date().toISOString(), status: 'frozen-protocol-consistent',
  outcomeAccess: 'No trial directories, model answers, generation logs or candidate runtime results were read.',
  toolsFrozenAt: manifest.toolManifest.frozenAt, runtimeFrozenAt: runtimeManifest.frozen_at, studyFrozenAt: manifest.frozenAt, generationStartedAt: start.startedAt,
  plannedTrials: schedule.length, rootCauses: 6, conditions: 2, repetitions: 3, tasks,
  immutableFilesVerified: {studyInputs: Object.keys(manifest.files).length, sharedTools: Object.keys(manifest.toolManifest.sources).length, runtimeAndContracts: runtimeManifest.files.length},
  protocol, inputPaths,
  pendingPostGenerationChecks: ['All 36 planned generation outcomes, including invalid/timeout attempts, must be retained.', 'Check max generation finish timestamp precedes min candidate GPU evaluator start; before/gold preflight checks are separate.', 'Recompute score, budget, final-message and original-patch replay for every trial.', 'Bind runtime source/native/hidden identities and actual verifier receipt bytes.', 'Report hidden endpoint and visible+hidden regression endpoint separately.', 'Report optional tool uptake without dropping diagnostic nonusers or failed tool requests.']};
const out = path.join(ROOT, 'out/research/repair-v2-audit/protocol-audit.json'); await writeFile(out, JSON.stringify(receipt, null, 2) + '\n');
process.stdout.write(JSON.stringify({status: receipt.status, tasks: tasks.length, plannedTrials: receipt.plannedTrials, ordinaryRequestsMatched: tasks.reduce((sum, t) => sum + t.ordinaryRequestsMatched, 0), receipt: out, sha256: sha(await readFile(out))}) + '\n');
