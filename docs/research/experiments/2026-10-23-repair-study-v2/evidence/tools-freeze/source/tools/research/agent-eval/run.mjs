/** Prompt-only Codex CLI pilot. Never evaluates model-generated code. */
import {spawn, execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, rm, access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DEFAULT_OUTPUT, MODEL, REASONING, MISSING, CONDITIONS, freeze, sha256} from './fixtures.mjs';

export function auditJSONL(raw) {
  const events = [], parseErrors = [], forbidden = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { parseErrors.push(index + 1); }
  }
  for (const event of events) {
    const item = event.item;
    if (item && !['reasoning', 'agent_message'].includes(item.type)) forbidden.push({event: event.type, itemType: item.type ?? null});
    if (/tool|command|function_call|web_search/i.test(event.type ?? '')) forbidden.push({event: event.type});
  }
  return {events, parseErrors, forbidden,
    complete: events.some(event => event.type === 'turn.completed'),
    failed: events.filter(event => event.type === 'error' || event.type === 'turn.failed'),
    usage: events.filter(event => event.type === 'turn.completed').map(event => event.usage ?? null),
    threadId: events.find(event => event.type === 'thread.started')?.thread_id ?? null};
}
export function validateAnswer(answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false;
  if (Object.keys(answer).sort().join(',') !== 'evidence_ids,missing_evidence,reason,status') return false;
  return ['sat', 'violated', 'unknown'].includes(answer.status) && typeof answer.reason === 'string' && answer.reason.length > 0 &&
    Array.isArray(answer.evidence_ids) && answer.evidence_ids.every(v => typeof v === 'string') &&
    Array.isArray(answer.missing_evidence) && answer.missing_evidence.every(v => MISSING.includes(v));
}
export function scoreAnswer(task, answer, valid = true) {
  if (!valid || !validateAnswer(answer)) return {statusCorrect: false, referencesValid: false,
    evidenceCovered: false, missingEvidenceExact: false, fullySupported: false};
  const facts = new Set(task.payload.facts.map(f => f.id));
  const cited = new Set(answer.evidence_ids), missing = new Set(answer.missing_evidence);
  const statusCorrect = answer.status === task.gold.status;
  const referencesValid = answer.evidence_ids.every(id => facts.has(id)) && cited.size === answer.evidence_ids.length;
  const evidenceCovered = task.gold.evidenceIds.every(id => cited.has(id));
  const missingEvidenceExact = missing.size === answer.missing_evidence.length &&
    [...missing].sort().join(',') === [...task.gold.missingEvidence].sort().join(',');
  return {statusCorrect, referencesValid, evidenceCovered, missingEvidenceExact,
    fullySupported: statusCorrect && referencesValid && evidenceCovered && missingEvidenceExact,
    invalidReferences: answer.evidence_ids.filter(id => !facts.has(id)),
    requiredReferencesMissing: task.gold.evidenceIds.filter(id => !cited.has(id))};
}

export async function verifyFreeze(output) {
  const dir = path.join(output, 'frozen');
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  const fixtureText = await readFile(path.join(dir, 'fixtures.json'), 'utf8');
  if (sha256(fixtureText) !== manifest.fixtureSHA256) throw new Error('Frozen fixture hash mismatch');
  for (const prompt of manifest.prompts) {
    if (sha256(await readFile(path.join(dir, prompt.file))) !== prompt.sha256) throw new Error(`Frozen prompt changed: ${prompt.file}`);
  }
  return {manifest, fixtures: JSON.parse(fixtureText)};
}

export async function runCall({output, task, condition, repetition, phase, timeoutMs = 90000, command = 'codex'}) {
  const callId = `${task.id}.${condition}.r${repetition}`;
  const dir = path.join(output, phase, callId);
  await mkdir(dir, {recursive: true});
  try { await access(path.join(dir, 'result.json')); throw new Error(`Call already exists; refusing rerun: ${dir}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const prompt = await readFile(path.join(output, 'frozen', `${task.id}.${condition}.txt`), 'utf8');
  await writeFile(path.join(dir, 'prompt.txt'), prompt);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'finite-agent-'));
  const cwd = path.join(temp, 'work'); await mkdir(cwd);
  // Schema and output are outside the empty cwd and contain no task gold.
  const schemaPath = path.join(temp, 'schema.json'), answerPath = path.join(temp, 'answer.json');
  await writeFile(schemaPath, await readFile(path.join(output, 'frozen/output.schema.json')));
  const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--json', '--color', 'never',
    '--sandbox', 'read-only', '-C', cwd, '-m', MODEL, '-c', `model_reasoning_effort="${REASONING}"`,
    '-c', 'features.shell_tool=false', '--output-schema', schemaPath, '-o', answerPath, '-'];
  const startedAt = new Date().toISOString(), start = performance.now();
  let stdout = '', stderr = '', timedOut = false, spawnError = null;
  const child = spawn(command, args, {cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe']});
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  const killGroup = signal => { try { process.kill(-child.pid, signal); } catch {} };
  let forceTimer;
  const timer = setTimeout(() => { timedOut = true; killGroup('SIGTERM'); forceTimer = setTimeout(() => killGroup('SIGKILL'), 1000); }, timeoutMs);
  const termination = await new Promise(resolve => {
    child.on('error', error => { spawnError = error.message; resolve({exitCode: null, signal: null}); });
    child.on('close', (exitCode, signal) => resolve({exitCode, signal}));
  });
  clearTimeout(timer); clearTimeout(forceTimer);
  const wallSeconds = (performance.now() - start) / 1000;
  const audit = auditJSONL(stdout);
  let answer = null, answerRaw = null, answerError = null;
  try { answerRaw = await readFile(answerPath, 'utf8'); answer = JSON.parse(answerRaw); }
  catch (error) { answerError = error.code === 'ENOENT' ? 'missing-answer-file' : `invalid-answer-json: ${error.message}`; }
  const failureReasons = [];
  if (timedOut) failureReasons.push('timeout');
  if (spawnError) failureReasons.push('spawn-error');
  if (termination.exitCode !== 0) failureReasons.push('nonzero-exit');
  if (audit.forbidden.length) failureReasons.push('tool-contamination');
  if (audit.parseErrors.length) failureReasons.push('malformed-jsonl');
  if (!audit.complete) failureReasons.push('missing-turn-completed');
  if (audit.failed.length) failureReasons.push('cli-error-event');
  if (answerError) failureReasons.push(answerError);
  if (!validateAnswer(answer)) failureReasons.push('invalid-answer-schema');
  const valid = failureReasons.length === 0;
  const result = {schema: 'finite-agent-call-v1', callId, task: task.id, condition, repetition, phase,
    modelRequested: MODEL, resolvedModelSnapshot: null, resolvedModelNote: 'Codex CLI JSONL does not expose a resolved model snapshot in this run.',
    reasoningEffort: REASONING, startedAt, finishedAt: new Date().toISOString(), wallSeconds, timeoutMs,
    command: [command, ...args], freshCwd: cwd, cwdInitialState: 'empty', promptSHA256: sha256(prompt),
    ...termination, timedOut, spawnError, valid, failureReasons,
    audit: {parseErrors: audit.parseErrors, forbidden: audit.forbidden, turnComplete: audit.complete,
      errors: audit.failed, threadId: audit.threadId}, usage: audit.usage, answer,
    goldStatus: task.gold.status, scores: scoreAnswer(task, answer, valid)};
  await writeFile(path.join(dir, 'source.jsonl'), stdout);
  await writeFile(path.join(dir, 'stderr.txt'), stderr);
  if (answerRaw !== null) await writeFile(path.join(dir, 'answer.json'), answerRaw);
  await writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  await rm(temp, {recursive: true, force: true});
  process.stdout.write(JSON.stringify({callId, phase, valid, seconds: Number(wallSeconds.toFixed(2)), failures: failureReasons}) + '\n');
  return result;
}

const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
export function summarize(fixtures, results, manifest, version) {
  const taskRows = fixtures.map(task => {
    const row = {task: task.id, sourceId: task.sourceId, gold: task.gold.status};
    for (const condition of CONDITIONS) {
      const calls = results.filter(r => r.task === task.id && r.condition === condition);
      row[condition] = {calls: calls.length, valid: calls.filter(c => c.valid).length,
        statusAccuracy: mean(calls.map(c => Number(c.scores.statusCorrect))),
        supportAccuracy: mean(calls.map(c => Number(c.scores.fullySupported))),
        wallSeconds: mean(calls.map(c => c.wallSeconds))};
    }
    row.pairedStatusDelta = row.structured.statusAccuracy === null || row.flat.statusAccuracy === null ? null : row.structured.statusAccuracy - row.flat.statusAccuracy;
    row.pairedSupportDelta = row.structured.supportAccuracy === null || row.flat.supportAccuracy === null ? null : row.structured.supportAccuracy - row.flat.supportAccuracy;
    return row;
  });
  const byCondition = Object.fromEntries(CONDITIONS.map(condition => {
    const calls = results.filter(r => r.condition === condition);
    return [condition, {attempted: calls.length, valid: calls.filter(c => c.valid).length,
      invalid: calls.filter(c => !c.valid).length, timeouts: calls.filter(c => c.timedOut).length,
      statusCorrect: calls.filter(c => c.scores.statusCorrect).length,
      fullySupported: calls.filter(c => c.scores.fullySupported).length,
      taskMeanStatusAccuracy: mean(taskRows.map(r => r[condition].statusAccuracy).filter(v => v !== null)),
      taskMeanSupportAccuracy: mean(taskRows.map(r => r[condition].supportAccuracy).filter(v => v !== null)),
      meanWallSeconds: mean(calls.map(c => c.wallSeconds)),
      usage: calls.reduce((sum, c) => { for (const u of c.usage) for (const [k, v] of Object.entries(u ?? {})) if (typeof v === 'number') sum[k] = (sum[k] ?? 0) + v; return sum; }, {})}];
  }));
  return {schema: 'finite-agent-pilot-summary-v1', createdAt: new Date().toISOString(), fixtureSHA256: manifest.fixtureSHA256,
    cliVersion: version, modelRequested: MODEL, reasoningEffort: REASONING, plannedCalls: 48,
    completedCalls: results.length, status: results.length === 48 ? 'completed' : 'incomplete',
    taskCount: fixtures.length, repetitions: 2, byCondition, taskRows,
    pairedTaskAnalysis: {unit: 'synthetic task, with two repeated calls averaged within each condition',
      n: taskRows.filter(r => r.pairedStatusDelta !== null).length,
      meanStatusDelta: mean(taskRows.map(r => r.pairedStatusDelta).filter(v => v !== null)),
      meanSupportDelta: mean(taskRows.map(r => r.pairedSupportDelta).filter(v => v !== null)),
      structuredStatusWins: taskRows.filter(r => r.pairedStatusDelta > 0).length,
      flatStatusWins: taskRows.filter(r => r.pairedStatusDelta < 0).length,
      statusTies: taskRows.filter(r => r.pairedStatusDelta === 0).length,
      inferentialClaim: 'Descriptive pilot only; no population significance or human-equivalence claim.'},
    limitations: ['Synthetic development tasks from a known finite model; not held-out natural GPU bugs.',
      'Only one model/configuration, 12 selected tasks, and two repeated calls per condition.',
      'Neither condition is a visual UI; comparison concerns text organization only.',
      'No human participants or human timing baseline; cannot establish that agents replace people.',
      'Reference existence/coverage is deterministic; prose justification quality is not graded.',
      'CLI elapsed time includes service/network/queue effects and is not isolated reasoning time.',
      'Resolved model snapshot is not reported by CLI; requested model alias and CLI version are recorded.']};
}

async function main() {
  const mode = process.argv[2] ?? 'freeze';
  const output = path.resolve(process.argv[3] ?? DEFAULT_OUTPUT);
  if (mode === 'freeze') { console.log(JSON.stringify(await freeze(output), null, 2)); return; }
  const {manifest, fixtures} = await verifyFreeze(output);
  const version = execFileSync('codex', ['--version'], {encoding: 'utf8'}).trim();
  await writeFile(path.join(output, 'environment.json'), JSON.stringify({capturedAt: new Date().toISOString(),
    node: process.version, platform: process.platform, arch: process.arch, cliVersion: version,
    model: MODEL, reasoningEffort: REASONING, runConfig: {maxConcurrency: 2, timeoutSeconds: 90, shellTool: false,
      ignoreUserConfig: true, ephemeral: true, sandbox: 'read-only', freshEmptyCwd: true}}, null, 2) + '\n');
  if (mode === 'smoke') {
    // One predeclared task, both formats. Passing means valid transport and no tools,
    // not a correct score. Smoke calls are excluded from main performance analysis.
    const results = await Promise.all(CONDITIONS.map(condition => runCall({output, task: fixtures[0], condition, repetition: 0, phase: 'smoke'})));
    const smoke = {createdAt: new Date().toISOString(), task: fixtures[0].id, calls: results.length,
      frameworkPassed: results.every(r => r.valid), usedForPromptTuning: false, results};
    await writeFile(path.join(output, 'smoke-summary.json'), JSON.stringify(smoke, null, 2) + '\n');
    if (!smoke.frameworkPassed) process.exitCode = 1;
    return;
  }
  if (mode !== 'run') throw new Error('Usage: node run.mjs freeze|smoke|run [output-directory]');
  const smoke = JSON.parse(await readFile(path.join(output, 'smoke-summary.json'), 'utf8'));
  if (!smoke.frameworkPassed) throw new Error('Smoke framework failed; preserve failures, do not start main pilot.');
  const results = [];
  // Pair-by-task, at most two simultaneous requests. Reverse condition launch order
  // across task/repetition parity; no response influences any future prompt.
  for (let repetition = 1; repetition <= 2; repetition++) {
    const tasks = repetition === 1 ? fixtures : [...fixtures].reverse();
    for (const [index, task] of tasks.entries()) {
      const conditions = (index + repetition) % 2 ? CONDITIONS : [...CONDITIONS].reverse();
      const batch = await Promise.all(conditions.map(condition => runCall({output, task, condition, repetition, phase: 'main'})));
      results.push(...batch);
      const summary = summarize(fixtures, results, manifest, version);
      await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
      // An actual CLI access failure aborts future calls. Preserve completed evidence.
      if (batch.some(r => r.failureReasons.some(f => ['spawn-error', 'nonzero-exit', 'cli-error-event'].includes(f)) && !r.timedOut)) {
        await writeFile(path.join(output, 'aborted.json'), JSON.stringify({reason: 'CLI failure; no synthetic replacement data', calls: batch.map(r => r.callId)}, null, 2) + '\n');
        process.exitCode = 1; return;
      }
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
