import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFixtures, flattenFacts, renderPrompt, sha256} from './fixtures.mjs';
import {auditJSONL, validateAnswer, scoreAnswer, summarize} from './run.mjs';

const fixtures = buildFixtures();
test('predeclared pilot has 12 unique sources and balanced oracle targets', () => {
  assert.equal(fixtures.length, 12);
  assert.equal(new Set(fixtures.map(t => t.sourceId)).size, 12);
  for (const status of ['sat', 'violated', 'unknown']) assert.equal(fixtures.filter(t => t.gold.status === status).length, 4);
  for (const task of fixtures) {
    const gold = task.oracle.results.find(r => r.id === task.sourceTargetId).status;
    assert.equal(task.gold.status, gold === 'satisfied' ? 'sat' : gold);
    assert.ok(task.gold.evidenceIds.every(id => task.payload.facts.some(f => f.id === id)));
  }
});
test('flat facts encode exactly the same leaves as structured JSON with no diagnostic labels', () => {
  for (const task of fixtures) {
    const flat = renderPrompt(task.payload, 'flat');
    const structured = renderPrompt(task.payload, 'structured');
    const rebuilt = {};
    // Parse path/value statements back into the complete structured data.
    for (const line of flattenFacts(task.payload)) {
      const cut = line.indexOf(' = '), keys = line.slice(0, cut).replaceAll(']', '').split(/[.[]/);
      let node = rebuilt;
      for (let i = 0; i < keys.length - 1; i++) node = node[keys[i]] ??= /^\d+$/.test(keys[i + 1]) ? [] : {};
      node[keys.at(-1)] = JSON.parse(line.slice(cut + 3));
    }
    assert.deepEqual(rebuilt, task.payload);
    for (const prompt of [flat, structured]) {
      assert.ok(!prompt.includes(task.sourceId));
      assert.ok(!prompt.includes(task.sourceDescription));
      assert.ok(!prompt.includes(task.id));
      assert.ok(!prompt.includes('legalLinearExtensions'));
      assert.ok(!prompt.includes('/home/'));
    }
  }
  assert.equal(sha256(JSON.stringify(buildFixtures())), sha256(JSON.stringify(fixtures)));
});
test('domain mismatch target is violated while known old-token ordering target is unknown', () => {
  assert.equal(fixtures.find(t => t.sourceId === 'completion-wrong-facet-same-generation').gold.status, 'violated');
  assert.equal(fixtures.find(t => t.sourceId === 'completion-same-parity-old-token').gold.status, 'unknown');
});
test('transitive/reverse order proof requires each attested edge', () => {
  for (const sourceId of ['completion-transitive', 'completion-reverse']) {
    const task = fixtures.find(t => t.sourceId === sourceId);
    for (const edge of task.payload.hb) assert.ok(task.gold.evidenceIds.includes(edge.evidenceRef));
  }
});
test('JSONL auditing rejects tool/unknown items and malformed output', () => {
  const clean = [{type: 'item.completed', item: {type: 'agent_message', text: '{}'}}, {type: 'turn.completed', usage: {input_tokens: 1}}].map(JSON.stringify).join('\n');
  assert.equal(auditJSONL(clean).forbidden.length, 0);
  for (const type of ['command_execution', 'mcp_tool_call', 'web_search', 'unknown_future_item']) {
    assert.equal(auditJSONL(JSON.stringify({type: 'item.started', item: {type}})).forbidden.length, 1);
  }
  assert.equal(auditJSONL('{broken').parseErrors.length, 1);
  assert.equal(auditJSONL('').complete, false);
});
test('deterministic scoring penalizes wrong labels, invented refs, missing proofs and invalid calls', () => {
  for (const task of fixtures) {
    const answer = {status: task.gold.status, evidence_ids: [...task.gold.evidenceIds], missing_evidence: [...task.gold.missingEvidence], reason: 'Test explanation.'};
    assert.ok(validateAnswer(answer)); assert.equal(scoreAnswer(task, answer).fullySupported, true);
    assert.equal(scoreAnswer(task, {...answer, evidence_ids: [...answer.evidence_ids, 'invented']}).fullySupported, false);
    assert.equal(scoreAnswer(task, {...answer, evidence_ids: []}).fullySupported, false);
    assert.equal(scoreAnswer(task, answer, false).statusCorrect, false);
  }
});
test('summary averages repetitions within task and does not call them participants', () => {
  const task = fixtures[0];
  const result = {task: task.id, condition: 'flat', valid: true, timedOut: false, scores: {statusCorrect: true, fullySupported: true}, wallSeconds: 1, usage: []};
  const summary = summarize([task], [result, {...result, scores: {statusCorrect: false, fullySupported: false}}], {fixtureSHA256: 'hash'}, 'test');
  assert.equal(summary.taskRows[0].flat.statusAccuracy, 0.5);
  assert.equal(summary.taskCount, 1);
  assert.equal(summary.byCondition.flat.taskMeanStatusAccuracy, 0.5);
  assert.equal(summary.pairedTaskAnalysis.n, 0);
});

test('CLI runner preserves contaminated output and enforces per-call timeout', async () => {
  const {mkdtemp, mkdir, writeFile, readFile, rm, chmod} = await import('node:fs/promises');
  const os = await import('node:os'); const path = await import('node:path');
  const {runCall} = await import('./run.mjs');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'finite-agent-runner-test-'));
  try {
    const frozen = path.join(temp, 'frozen'); await mkdir(frozen);
    const task = fixtures[0];
    await writeFile(path.join(frozen, `${task.id}.flat.txt`), renderPrompt(task.payload, 'flat'));
    await writeFile(path.join(frozen, 'output.schema.json'), '{}');
    const command = path.join(temp, 'fake-cli');
    const answer = {status: task.gold.status, evidence_ids: task.gold.evidenceIds, missing_evidence: task.gold.missingEvidence, reason: 'Fixture response.'};
    await writeFile(command, `#!/usr/bin/env node\nconst fs=require('node:fs');\nfs.writeFileSync(process.argv[process.argv.indexOf('-o')+1], ${JSON.stringify(JSON.stringify(answer))});\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'command_execution',command:'forbidden'}}));\nconsole.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1}}));\n`);
    await chmod(command, 0o700);
    const contaminated = await runCall({output: temp, task, condition: 'flat', repetition: 1, phase: 'test', command});
    assert.equal(contaminated.valid, false);
    assert.ok(contaminated.failureReasons.includes('tool-contamination'));
    assert.equal(contaminated.scores.statusCorrect, false);
    assert.match(await readFile(path.join(temp, 'test', contaminated.callId, 'source.jsonl'), 'utf8'), /command_execution/);
    await writeFile(command, '#!/usr/bin/env node\nsetTimeout(()=>{}, 10000);\n');
    const timeout = await runCall({output: temp, task, condition: 'flat', repetition: 2, phase: 'test', command, timeoutMs: 50});
    assert.equal(timeout.timedOut, true);
    assert.equal(timeout.valid, false);
    assert.ok(timeout.wallSeconds < 3);
  } finally { await rm(temp, {recursive: true, force: true}); }
});
