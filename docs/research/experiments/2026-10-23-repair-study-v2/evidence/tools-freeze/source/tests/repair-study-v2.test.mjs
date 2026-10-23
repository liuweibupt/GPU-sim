import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sha, validateCatalog, validatePrivatePlan, protocolWith, initialPacket, rawQuery, budgetedQuery, validAnswer, scoreLocalization, applyEdits, scoreRuntime, makePrompt} from '../tools/research/repair-study-v2/core.mjs';
import {freezeTools, freezeStudy, verifyFreeze, runTrial, replayStudy, summarize} from '../tools/research/repair-study-v2/run.mjs';

const hash = 'a'.repeat(64);
function fixture() {
  const a = 'function compute(x) {\n  return x - 1;\n}\n', b = 'function caller(x) {\n  return compute(x);\n}\n', ir = 'module {\n  %0 = operation\n}\n';
  const task = {id: 'fixture', family: 'synthetic-unit-only', split: 'development', objective: 'Preserve the declared identity operation on recorded inputs.',
    files: [{id: 'f0', path: 'src/compute.js', text: a, sha256: sha(a), role: 'implementation'}, {id: 'f1', path: 'src/caller.js', text: b, sha256: sha(b), role: 'implementation'}, {id: 'f2', path: 'capture.mlir', text: ir, sha256: sha(ir), role: 'generated-ir'}],
    cases: [{id: 'bad', status: 'wrong_value', parameters: {x: 1, mode: 'live'}, evidenceRefs: ['obs-bad', 'ir']}, {id: 'good', status: 'passed', parameters: {x: 0, mode: 'control'}, evidenceRefs: ['obs-good', 'ir']}],
    evidence: [{id: 'obs-bad', kind: 'device-output', observed: true, caseIds: ['bad'], text: 'actual=0 expected=1', rawRefs: [{id: 'raw-bad', sha256: hash}]}, {id: 'obs-good', kind: 'execution-observation', observed: true, caseIds: ['good'], text: 'control passed', rawRefs: [{id: 'raw-good', sha256: hash}]}, {id: 'ir', kind: 'compiler-ir', observed: false, caseIds: ['bad', 'good'], sourceId: 'f2', rawRefs: [{id: 'f2', sha256: sha(ir)}]}]};
  const catalog = {format: 'repair-study-catalog-v2', tasks: [task]}, spec = {id: 'fixture', rootCauseId: 'unit-fixture-only', relevantRegions: [{source_id: 'f0', start_line: 1, end_line: 3}], hiddenCaseIds: ['hidden-1', 'hidden-2'], hiddenSpecSHA256: hash, requirePassingControl: true};
  return {task, catalog, spec, plan: {format: 'repair-study-private-v2', tasks: [spec]}};
}
function answer(overrides = {}) {
  return {action: 'final', query: {op: 'none', scope: null, id: null, text: null, start: null, end: null, offset: null, derived_op: null, groupBy: null}, diagnosis: 'An observed mismatch points to the arithmetic expression; the static IR is additional context.',
    locations: [{source_id: 'f0', start_line: 1, end_line: 3}, {source_id: 'f2', start_line: 1, end_line: 2}],
    citations: [{case_id: 'bad', evidence_ids: ['obs-bad']}, {case_id: 'good', evidence_ids: ['obs-good']}], edits: [{source_id: 'f0', old: 'return x - 1;', new: 'return x;'}], ...overrides};
}

test('v2 catalog separates source, observed facts and private annotations', () => {
  const {catalog, plan, task} = fixture(); assert.equal(validateCatalog(catalog), catalog); assert.equal(validatePrivatePlan(catalog, plan), plan);
  const packet = initialPacket(task); assert.equal(packet.files.length, 3); assert.equal(JSON.stringify(packet).includes('return x - 1'), false); assert.equal('text' in packet.files[0], false);
  const bad = structuredClone(catalog); bad.tasks[0].goldPatch = 'do not show'; assert.throws(() => validateCatalog(bad), /unexpected field/);
  const single = structuredClone(catalog); single.tasks[0].files[1].role = 'test'; assert.throws(() => validateCatalog(single), /two implementation/);
  const history = structuredClone(catalog); history.tasks[0].files[1].path = '.git/config'; assert.throws(() => validateCatalog(history), /history/);
});

test('both conditions have byte-identical initial packet and ordinary source reads', () => {
  const {task} = fixture(), protocol = protocolWith();
  for (const request of [{op: 'list'}, {op: 'search', text: 'return'}, {op: 'read', id: 'f1', start: 1, end: 3}, {op: 'case', id: 'bad'}]) assert.deepEqual(rawQuery(task, 'raw', request), rawQuery(task, 'diagnostic', request));
  const raw = makePrompt(task, 'raw', protocol).split('INITIAL CATALOG:\n')[1], diagnostic = makePrompt(task, 'diagnostic', protocol).split('INITIAL CATALOG:\n')[1];
  assert.equal(raw, diagnostic); assert.equal(raw.includes('return x - 1'), false);
  assert.throws(() => rawQuery(task, 'raw', {op: 'derived', derived_op: 'contrast'}), /unavailable/);
});

test('generic relations only aggregate provided observations and explicit source links', () => {
  const {task} = fixture();
  const contrast = rawQuery(task, 'diagnostic', {op: 'derived', derived_op: 'contrast', groupBy: ['mode']});
  assert.equal(contrast.groups.length, 2); assert.deepEqual(contrast.groups[0].observationIds, ['obs-bad']);
  const observed = rawQuery(task, 'diagnostic', {op: 'derived', derived_op: 'observed'}); assert.equal(observed.observations.length, 2);
  const links = rawQuery(task, 'diagnostic', {op: 'derived', derived_op: 'source_links'}); assert.equal(links.links.length, 2); assert.ok(links.links.every(link => link.sourceId === 'f2'));
  assert.throws(() => rawQuery(task, 'diagnostic', {op: 'derived', derived_op: 'overlap', id: 'bad'}), /no supported/);
  assert.equal(JSON.stringify(links).includes('src/compute'), false);
});

test('query character and error budgets are equal, bounded, and never silently truncated', () => {
  const {task} = fixture(), protocol = protocolWith({maxQueries: 2, maxCalls: 3, maxResponseCharacters: 150, maxTotalResponseCharacters: 300});
  const raw = {queries: 0, responseCharacters: 0}, diag = {...raw};
  for (const state of [raw, diag]) {
    const large = budgetedQuery(task, 'raw', {op: 'list'}, state, protocol); assert.equal(large.rejected, true); assert.match(large.response.error, /budget/);
    const bad = budgetedQuery(task, 'raw', {op: 'delete'}, state, protocol); assert.match(bad.response.error, /unsupported/);
    assert.equal(budgetedQuery(task, 'raw', {op: 'read', id: 'f0'}, state, protocol).budgetExhausted, true);
    assert.equal(state.queries, 2); assert.ok(state.responseCharacters <= 300);
  }
  assert.deepEqual(raw, diag);
  assert.throws(() => rawQuery(task, 'raw', {op: 'read', id: 'f0', start: 0, end: 2}), /invalid/);
  assert.throws(() => rawQuery(task, 'raw', {op: 'search', text: ''}), /literal/);
});

test('all valid supplied source locations accepted, including generated IR', () => {
  const {task, spec} = fixture(), score = scoreLocalization(task, spec, answer());
  assert.equal(score.supportedLocalization, true); assert.equal(score.allLocationsValid, true);
  assert.equal(scoreLocalization(task, spec, answer({locations: [{source_id: 'f0', start_line: 1, end_line: 99}]})).supportedLocalization, false);
  assert.equal(scoreLocalization(task, spec, answer({locations: [{source_id: 'missing', start_line: 1, end_line: 1}]})).allLocationsValid, false);
});

test('shared static IR cannot cover failing and passing observations', () => {
  const {task, spec} = fixture();
  const a = answer({citations: [{case_id: 'bad', evidence_ids: ['ir']}, {case_id: 'good', evidence_ids: ['ir']}]});
  const score = scoreLocalization(task, spec, a); assert.equal(score.referencesValid, true); assert.equal(score.failureObserved, false); assert.equal(score.passingControlObserved, false); assert.equal(score.supportedLocalization, false);
  const mismatched = answer({citations: [{case_id: 'bad', evidence_ids: ['obs-good']}]}); assert.equal(scoreLocalization(task, spec, mismatched).referencesValid, false);
  const spoof = fixture(); spoof.task.evidence[2].observed = true; assert.throws(() => validateCatalog(spoof.catalog), /static IR/);
});

test('duplicate, foreign and unsupported citations are rejected', () => {
  const {task, spec} = fixture();
  for (const citations of [[{case_id: 'bad', evidence_ids: ['obs-bad', 'obs-bad']}], [{case_id: 'not-this-task', evidence_ids: ['obs-bad']}], [{case_id: 'bad', evidence_ids: ['missing']}], [answer().citations[0], answer().citations[0]]]) assert.equal(scoreLocalization(task, spec, answer({citations})).referencesValid, false);
});

test('patch application preserves exact multi-file edits and forbids test/IR targets', () => {
  const {task} = fixture();
  const patched = applyEdits(task, answer({edits: [...answer().edits, {source_id: 'f1', old: 'return compute(x);', new: 'return compute(Number(x));'}]}));
  assert.equal(patched.files.filter(file => file.changed).length, 2); assert.equal(task.files[0].text.includes('return x - 1;'), true);
  assert.throws(() => applyEdits(task, answer({edits: [{source_id: 'f2', old: 'module', new: 'other'}]})), /implementation/);
  assert.throws(() => applyEdits(task, answer({edits: [{source_id: 'f0', old: '', new: 'x'}]})), /nonempty/);
  assert.throws(() => applyEdits(task, answer({edits: [{source_id: 'f0', old: 'NOT FOUND', new: 'x'}]})), /exactly once/);
  assert.throws(() => applyEdits(task, answer({edits: [{source_id: 'f0', old: 'x', new: 'y'}]})), /exactly once/);
});

test('model schema rejects extra fields and wrong query types', () => {
  assert.equal(validAnswer(answer()), true); assert.equal(validAnswer({...answer(), hiddenAnswer: 'leak'}), false);
  assert.equal(validAnswer(answer({query: {...answer().query, start: '1'}})), false);
  assert.equal(validAnswer(answer({edits: [{source_id: 'f0', old: 'x', new: 1}]})), false);
});

test('runtime primary endpoint needs bound compilation and every hidden case', () => {
  const {task, spec} = fixture(), candidate = applyEdits(task, answer());
  const record = {candidateTreeSHA256: candidate.candidateTreeSHA256, hiddenSpecSHA256: spec.hiddenSpecSHA256, verifierStatus: 'verified', verifierReceiptSHA256: hash, buildStatus: 'passed', cases: [{id: 'hidden-1', status: 'passed'}, {id: 'hidden-2', status: 'passed'}]};
  assert.equal(scoreRuntime(spec, candidate, record).success, true);
  for (const bad of [{...record, buildStatus: 'failed'}, {...record, candidateTreeSHA256: hash}, {...record, hiddenSpecSHA256: 'b'.repeat(64)}, {...record, verifierStatus: 'unchecked'}, {...record, cases: record.cases.slice(0, 1)}, {...record, cases: [record.cases[0], record.cases[0]]}, {...record, cases: [record.cases[0], {id: 'hidden-2', status: 'timeout'}]}]) assert.equal(scoreRuntime(spec, candidate, bad).success, false);
  assert.equal(scoreRuntime(spec, candidate, null).reason, 'missing-runtime-result');
});

test('protocol reserves a final answer and fixes zero feedback before any calls', () => {
  assert.equal(protocolWith().feedbackRounds, 0); assert.equal(protocolWith().maxQueries, 8);
  assert.throws(() => protocolWith({maxQueries: 10, maxCalls: 10}), /reserve/);
  assert.throws(() => protocolWith({feedbackRounds: 1}), /zero-feedback/);
  assert.throws(() => protocolWith({conditionSpecificBudget: 2}), /unexpected/);
});

test('frozen offline trial replays exact responses and keeps missing trials in denominator', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'repair-v2-test-'));
  try {
    const {catalog, plan} = fixture(), toolDir = path.join(temporary, 'tools'), out = path.join(temporary, 'study');
    await writeFile(path.join(temporary, 'catalog.json'), JSON.stringify(catalog)); await writeFile(path.join(temporary, 'private.json'), JSON.stringify(plan));
    await freezeTools(toolDir); await freezeStudy(out, path.join(temporary, 'catalog.json'), path.join(temporary, 'private.json'), toolDir, {repetitions: 1, maxQueries: 2, maxCalls: 3});
    const study = await verifyFreeze(out); await mkdir(path.join(out, 'trials'));
    const invoke = async (prompt, directory, round) => {
      const response = round === 1 ? answer({action: 'query', query: {...answer().query, op: 'read', id: 'f0', start: 1, end: 3}, edits: []}) : answer();
      const record = {round, valid: true, answer: response, wallSeconds: 0, usage: [], promptSHA256: sha(prompt)};
      const events = [{type: 'thread.started', thread_id: 'offline-unit-only'}, {type: 'item.completed', item: {type: 'agent_message', text: JSON.stringify(response)}}, {type: 'turn.completed', usage: {}}];
      await writeFile(path.join(directory, `round-${round}.prompt.txt`), prompt); await writeFile(path.join(directory, `round-${round}.json`), JSON.stringify(record)); await writeFile(path.join(directory, `round-${round}.jsonl`), events.map(x => JSON.stringify(x)).join('\n') + '\n');
      return record;
    };
    const result = await runTrial(out, study.schedule[0], study, invoke); assert.equal(result.patchApplicable, true); assert.equal(result.budget.queries, 1);
    const replay = await replayStudy(out); assert.equal(replay.verifiedTrials, 1); assert.equal(replay.plannedTrials, 2); assert.equal(replay.audits[1].status, 'missing-trial');
    const summary = await summarize(out); assert.equal(summary.plannedTrials, 2); assert.equal(summary.rows[1].endpoint.reason, 'missing-trial'); assert.ok(summary.rows.every(row => !row.endpoint.success));
    const queryFile = path.join(out, 'trials', study.schedule[0].id, 'query-1.json'); const query = JSON.parse(await readFile(queryFile)); query.response.lines[0].text = 'tampered'; await writeFile(queryFile, JSON.stringify(query));
    assert.equal((await replayStudy(out)).audits[0].valid, false);
    await writeFile(path.join(out, 'frozen', 'private-plan.json'), '{}'); await assert.rejects(() => verifyFreeze(out), /frozen input changed/);
  } finally { await rm(temporary, {recursive: true, force: true}); }
});
