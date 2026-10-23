/** Frozen bounded agent study; endpoint scoring remains independent of model diagnosis. */
import {spawn, execFileSync} from 'node:child_process';
import {mkdir, readFile, writeFile, mkdtemp, rm, readdir, access} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {auditJSONL} from '../agent-eval/run.mjs';
import {sha, validateCatalog, validatePrivatePlan, protocolWith, initialPacket, RESPONSE_SCHEMA, validAnswer, budgetedQuery, scoreLocalization, applyEdits, scoreRuntime, makePrompt} from './core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SOURCE_PATHS = ['tools/research/repair-study-v2/core.mjs', 'tools/research/repair-study-v2/query.mjs', 'tools/research/repair-study-v2/run.mjs', 'tests/repair-study-v2.test.mjs', 'lib/research/natural-diagnostic.js', 'tools/research/agent-eval/run.mjs', 'tools/research/agent-eval/fixtures.mjs'];
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const exists = async file => { try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const insist = (value, message) => { if (!value) throw Error(message); };

/** Freeze generic mechanisms before adapting or reading new fault data. */
export async function freezeTools(output) {
  await mkdir(output, {recursive: false});
  const sources = {};
  for (const file of SOURCE_PATHS) {
    const bytes = await readFile(path.join(ROOT, file)); sources[file] = sha(bytes);
    const destination = path.join(output, 'source', file); await mkdir(path.dirname(destination), {recursive: true}); await writeFile(destination, bytes);
  }
  const manifest = {format: 'repair-study-tool-freeze-v2', frozenAt: new Date().toISOString(), sources, statement: 'Generic query/scorer mechanisms are frozen independently of the final task data. Timestamp is a local audit record, not an external preregistration.'};
  await save(path.join(output, 'manifest.json'), manifest); return manifest;
}

export async function verifyTools(output) {
  const manifest = await json(path.join(output, 'manifest.json'));
  insist(manifest.format === 'repair-study-tool-freeze-v2', 'tool freeze format');
  for (const [file, hash] of Object.entries(manifest.sources)) {
    insist(sha(await readFile(path.join(ROOT, file))) === hash, `execution source changed after tool freeze: ${file}`);
    insist(sha(await readFile(path.join(output, 'source', file))) === hash, `tool snapshot mismatch: ${file}`);
  }
  insist(SOURCE_PATHS.length === Object.keys(manifest.sources).length && SOURCE_PATHS.every(file => manifest.sources[file]), 'tool dependency list mismatch');
  return manifest;
}

export async function freezeStudy(output, catalogFile, privateFile, toolFreeze, overrides = {}) {
  const catalog = validateCatalog(await json(catalogFile)), privatePlan = validatePrivatePlan(catalog, await json(privateFile));
  const toolManifest = await verifyTools(toolFreeze), protocol = protocolWith(overrides);
  await mkdir(output, {recursive: false}); const frozen = path.join(output, 'frozen'); await mkdir(frozen);
  await save(path.join(frozen, 'catalog-before.json'), catalog); await save(path.join(frozen, 'private-plan.json'), privatePlan);
  await save(path.join(frozen, 'protocol.json'), protocol); await save(path.join(frozen, 'response.schema.json'), RESPONSE_SCHEMA);
  const schedule = [];
  for (let rep = 1; rep <= protocol.repetitions; rep++) {
    const tasks = rep % 2 ? catalog.tasks : [...catalog.tasks].reverse();
    for (const task of tasks) for (const condition of rep % 2 ? protocol.conditions : [...protocol.conditions].reverse()) schedule.push({id: `${task.id}.${condition}.r${rep}`, taskId: task.id, condition, repetition: rep, split: task.split});
  }
  await save(path.join(frozen, 'schedule.json'), schedule);
  const files = ['catalog-before.json', 'private-plan.json', 'protocol.json', 'response.schema.json', 'schedule.json'];
  for (const task of catalog.tasks) {
    await save(path.join(frozen, `${task.id}.initial.json`), initialPacket(task)); files.push(`${task.id}.initial.json`);
    for (const condition of protocol.conditions) { const file = `${task.id}.${condition}.prompt.txt`; await writeFile(path.join(frozen, file), makePrompt(task, condition, protocol)); files.push(file); }
  }
  const hashes = {};
  for (const file of files) hashes[file] = sha(await readFile(path.join(frozen, file)));
  const manifest = {format: 'repair-study-freeze-v2', frozenAt: new Date().toISOString(), files: hashes, toolFreeze: path.resolve(toolFreeze), toolFreezeSHA256: sha(await readFile(path.join(toolFreeze, 'manifest.json'))), toolManifest,
    limitations: ['Public source and issues can occur in model training; no training exclusion is established.', 'The supplied subsystem file set is a bounded search package, not an entire-repository discovery task.', 'API/cwd/JSONL-audit isolation is not a formally secure hidden-test sandbox.', 'Only observed API traces and actual repaired-runtime results are measured; agents are not human subjects.', 'A local hash/time freeze is not a public external preregistration.'],
    counts: {tasks: catalog.tasks.length, independentRootCauses: new Set(privatePlan.tasks.map(t => t.rootCauseId)).size, trials: schedule.length,
      developmentTasks: catalog.tasks.filter(t => t.split === 'development').length, holdoutTasks: catalog.tasks.filter(t => t.split === 'holdout').length}};
  await save(path.join(frozen, 'manifest.json'), manifest); return manifest;
}

export async function verifyFreeze(output, {workingSources = true} = {}) {
  const frozen = path.join(output, 'frozen'), manifest = await json(path.join(frozen, 'manifest.json'));
  insist(manifest.format === 'repair-study-freeze-v2', 'study freeze format');
  for (const [file, hash] of Object.entries(manifest.files)) insist(sha(await readFile(path.join(frozen, file))) === hash, `frozen input changed: ${file}`);
  if (workingSources) {
    const toolManifest = await verifyTools(manifest.toolFreeze);
    insist(sha(await readFile(path.join(manifest.toolFreeze, 'manifest.json'))) === manifest.toolFreezeSHA256 && JSON.stringify(toolManifest) === JSON.stringify(manifest.toolManifest), 'tool freeze binding mismatch');
  }
  const catalog = validateCatalog(await json(path.join(frozen, 'catalog-before.json')));
  const privatePlan = validatePrivatePlan(catalog, await json(path.join(frozen, 'private-plan.json')));
  const protocol = await json(path.join(frozen, 'protocol.json')), schedule = await json(path.join(frozen, 'schedule.json'));
  insist(schedule.length === manifest.counts.trials, 'schedule denominator changed');
  return {manifest, catalog, privatePlan, protocol, schedule};
}

export async function invokeModel(prompt, directory, round, protocol, remainingSeconds) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'repair-study-v2-')), cwd = path.join(tmp, 'empty'); await mkdir(cwd);
  const schema = path.join(tmp, 'schema.json'), answerFile = path.join(tmp, 'answer.json'); await save(schema, RESPONSE_SCHEMA);
  const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--json', '--color', 'never', '--sandbox', 'read-only', '-C', cwd, '-m', protocol.model,
    '-c', `model_reasoning_effort="${protocol.reasoning}"`, '-c', 'features.shell_tool=false', '--output-schema', schema, '-o', answerFile, '-'];
  const startedAt = new Date().toISOString(), started = performance.now(), timeoutSeconds = Math.min(protocol.timeoutSecondsPerCall, remainingSeconds);
  let stdout = '', stderr = '', timedOut = false, spawnError = null, term;
  const child = spawn('codex', args, {cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe']});
  child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes); child.stdin.on('error', () => {}); child.stdin.end(prompt);
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, Math.max(1, timeoutSeconds * 1000));
  try { term = await new Promise(resolve => { child.on('error', error => { spawnError = String(error); resolve({exitCode: null, signal: null}); }); child.on('close', (exitCode, signal) => resolve({exitCode, signal})); }); }
  finally { clearTimeout(timer); }
  const audit = auditJSONL(stdout); let answer = null;
  try { answer = await json(answerFile); } catch {}
  let finalMatches = false;
  try { const messages = audit.events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message'); finalMatches = JSON.stringify(JSON.parse(messages.at(-1).item.text)) === JSON.stringify(answer); } catch {}
  const reasons = [];
  if (timedOut) reasons.push('model-timeout');
  if (spawnError) reasons.push('spawn-error');
  if (term.exitCode !== 0) reasons.push('nonzero-model-exit');
  if (audit.forbidden.length) reasons.push('external-tool-contamination');
  if (!audit.complete || audit.failed.length || audit.parseErrors.length) reasons.push('invalid-model-jsonl');
  if (!validAnswer(answer) || !finalMatches) reasons.push('invalid-structured-answer');
  const result = {round, startedAt, finishedAt: new Date().toISOString(), wallSeconds: (performance.now() - started) / 1000, timeoutSeconds,
    command: ['codex', ...args], promptSHA256: sha(prompt), ...term, timedOut, spawnError, valid: reasons.length === 0, reasons, finalMatches, answer,
    audit: {forbidden: audit.forbidden, parseErrors: audit.parseErrors, failed: audit.failed, threadId: audit.threadId}, usage: audit.usage};
  await writeFile(path.join(directory, `round-${round}.prompt.txt`), prompt);
  await writeFile(path.join(directory, `round-${round}.jsonl`), stdout);
  await writeFile(path.join(directory, `round-${round}.stderr.txt`), stderr);
  await save(path.join(directory, `round-${round}.json`), result); await rm(tmp, {recursive: true, force: true}); return result;
}

export async function runTrial(output, scheduled, study, invoke = invokeModel) {
  const {catalog, privatePlan, protocol} = study, task = catalog.tasks.find(task => task.id === scheduled.taskId), spec = privatePlan.tasks.find(t => t.id === task.id);
  const directory = path.join(output, 'trials', scheduled.id); await mkdir(directory, {recursive: false});
  const base = await readFile(path.join(output, 'frozen', `${task.id}.${scheduled.condition}.prompt.txt`), 'utf8');
  const started = performance.now(), state = {queries: 0, responseCharacters: 0}, result = {format: 'repair-study-trial-v2', ...scheduled, startedAt: new Date().toISOString(), calls: [], queries: [], valid: false, failure: null};
  let transcript = '', answer = null, candidate = null;
  try {
    for (let round = 1; round <= protocol.maxCalls; round++) {
      const remaining = protocol.timeoutSecondsPerTrial - (performance.now() - started) / 1000;
      if (remaining <= 0) { result.failure = 'trial-timeout'; break; }
      const prompt = base + transcript + `\nROUND ${round}/${protocol.maxCalls}; queries used ${state.queries}/${protocol.maxQueries}, response characters used ${state.responseCharacters}/${protocol.maxTotalResponseCharacters}. ${round === protocol.maxCalls || state.queries === protocol.maxQueries ? 'Return the final answer now.' : 'You may query or submit the final answer.'}`;
      const call = await invoke(prompt, directory, round, protocol, remaining); result.calls.push(call);
      if (!call.valid || !validAnswer(call.answer)) { result.failure = 'invalid-model-call'; break; }
      if (call.answer.action === 'final') { answer = call.answer; result.valid = true; await save(path.join(directory, 'answer.json'), answer); break; }
      if (round === protocol.maxCalls) { result.failure = 'call-budget-exhausted'; break; }
      const at = performance.now(), query = budgetedQuery(task, scheduled.condition, call.answer.query, state, protocol);
      const record = {round, request: call.answer.query, ...query, wallMilliseconds: performance.now() - at};
      result.queries.push(record); await save(path.join(directory, `query-${round}.json`), record);
      if (query.budgetExhausted) { result.failure = 'query-or-character-budget-exhausted'; break; }
      transcript += '\nYOUR PREVIOUS REQUEST:\n' + JSON.stringify(call.answer) + '\nQUERY RESPONSE:\n' + JSON.stringify(query.response);
    }
    if (answer) {
      try { candidate = applyEdits(task, answer); await save(path.join(directory, 'candidate.json'), candidate); }
      catch (error) { result.patchError = error.message; }
    }
  } catch (error) { result.failure = `runner-error: ${error.message}`; }
  if (!answer && !result.failure) result.failure = 'no-final-answer';
  result.finishedAt = new Date().toISOString(); result.wallSeconds = (performance.now() - started) / 1000;
  result.modelWallSeconds = result.calls.reduce((total, call) => total + call.wallSeconds, 0);
  result.queryWallMilliseconds = result.queries.reduce((total, query) => total + query.wallMilliseconds, 0);
  result.budget = state; result.localization = scoreLocalization(task, spec, answer, protocol);
  result.patchApplicable = Boolean(candidate); result.candidateTreeSHA256 = candidate?.candidateTreeSHA256 ?? null;
  result.usage = {}; for (const call of result.calls) for (const usage of call.usage ?? []) for (const [key, value] of Object.entries(usage ?? {})) if (typeof value === 'number') result.usage[key] = (result.usage[key] ?? 0) + value;
  await save(path.join(directory, 'result.json'), result); return result;
}

export async function runStudy(output) {
  const study = await verifyFreeze(output), {schedule, protocol} = study;
  await mkdir(path.join(output, 'trials'), {recursive: false});
  const version = execFileSync('codex', ['--version'], {encoding: 'utf8'}).trim();
  await save(path.join(output, 'run-start.json'), {startedAt: new Date().toISOString(), cliVersion: version, modelAlias: protocol.model, resolvedSnapshot: null, plannedTrials: schedule.length});
  for (let offset = 0; offset < schedule.length; offset += protocol.maxConcurrency) {
    await Promise.all(schedule.slice(offset, offset + protocol.maxConcurrency).map(async scheduled => {
      const result = await runTrial(output, scheduled, study);
      process.stdout.write(JSON.stringify({id: result.id, valid: result.valid, patchApplicable: result.patchApplicable, queries: result.budget.queries, seconds: result.wallSeconds, failure: result.failure}) + '\n');
    }));
    await save(path.join(output, 'generation-summary.json'), await summarize(output));
  }
  return summarize(output);
}

/** Replay original calls and exact bounded responses. Does not call a model or a GPU. */
export async function replayStudy(output, {workingSources = true} = {}) {
  const study = await verifyFreeze(output, {workingSources}), audits = [];
  for (const scheduled of study.schedule) {
    const directory = path.join(output, 'trials', scheduled.id);
    if (!await exists(path.join(directory, 'result.json'))) { audits.push({id: scheduled.id, status: 'missing-trial', valid: false}); continue; }
    const result = await json(path.join(directory, 'result.json')), task = study.catalog.tasks.find(t => t.id === scheduled.taskId), spec = study.privatePlan.tasks.find(t => t.id === task.id), state = {queries: 0, responseCharacters: 0};
    const failures = []; let transcript = '';
    if (result.id !== scheduled.id || result.taskId !== scheduled.taskId || result.condition !== scheduled.condition || result.repetition !== scheduled.repetition || result.calls.length > study.protocol.maxCalls) failures.push('schedule-or-call-budget-mismatch');
    const base = await readFile(path.join(output, 'frozen', `${task.id}.${scheduled.condition}.prompt.txt`), 'utf8');
    for (const [index, call] of result.calls.entries()) {
      const round = index + 1;
      const expectedPrompt = base + transcript + `\nROUND ${round}/${study.protocol.maxCalls}; queries used ${state.queries}/${study.protocol.maxQueries}, response characters used ${state.responseCharacters}/${study.protocol.maxTotalResponseCharacters}. ${round === study.protocol.maxCalls || state.queries === study.protocol.maxQueries ? 'Return the final answer now.' : 'You may query or submit the final answer.'}`;
      const originalCall = await json(path.join(directory, `round-${round}.json`));
      if (JSON.stringify(originalCall) !== JSON.stringify(call)) failures.push(`round-${round}-record-mismatch`);
      if (sha(await readFile(path.join(directory, `round-${round}.prompt.txt`))) !== sha(expectedPrompt) || call.promptSHA256 !== sha(expectedPrompt)) failures.push(`round-${round}-prompt-mismatch`);
      const audit = auditJSONL(await readFile(path.join(directory, `round-${round}.jsonl`), 'utf8'));
      if (call.valid && (!audit.complete || audit.failed.length || audit.parseErrors.length || audit.forbidden.length || !validAnswer(call.answer))) failures.push(`round-${round}-audit-mismatch`);
      if (call.valid) {
        let matches = false;
        try { const messages = audit.events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message'); matches = JSON.stringify(JSON.parse(messages.at(-1).item.text)) === JSON.stringify(call.answer); } catch {}
        if (!matches) failures.push(`round-${round}-model-answer-mismatch`);
      }
      if (call.valid && call.answer.action === 'query' && round < study.protocol.maxCalls) {
        const query = result.queries.find(query => query.round === round), actual = budgetedQuery(task, scheduled.condition, call.answer.query, state, study.protocol);
        if (!query || JSON.stringify(query.request) !== JSON.stringify(call.answer.query) || ['accepted', 'rejected', 'budgetExhausted', 'responseCharacters', 'responseSHA256'].some(key => query[key] !== actual[key]) || JSON.stringify(query.response) !== JSON.stringify(actual.response)) failures.push(`round-${round}-query-mismatch`);
        if (query && JSON.stringify(await json(path.join(directory, `query-${round}.json`))) !== JSON.stringify(query)) failures.push(`round-${round}-query-file-mismatch`);
        transcript += '\nYOUR PREVIOUS REQUEST:\n' + JSON.stringify(call.answer) + '\nQUERY RESPONSE:\n' + JSON.stringify(actual.response);
      }
    }
    if (JSON.stringify(state) !== JSON.stringify(result.budget)) failures.push('budget-accounting-mismatch');
    let answer = null, candidate = null;
    if (await exists(path.join(directory, 'answer.json'))) {
      answer = await json(path.join(directory, 'answer.json'));
      const finalCall = result.calls.findLast(call => call.valid && call.answer.action === 'final');
      if (!finalCall || JSON.stringify(finalCall.answer) !== JSON.stringify(answer)) failures.push('final-answer-mismatch');
      try { candidate = applyEdits(task, answer); } catch {}
    }
    if (JSON.stringify(scoreLocalization(task, spec, answer, study.protocol)) !== JSON.stringify(result.localization)) failures.push('localization-score-mismatch');
    if (Boolean(candidate) !== result.patchApplicable || (candidate?.candidateTreeSHA256 ?? null) !== result.candidateTreeSHA256) failures.push('patch-result-mismatch');
    if (candidate && JSON.stringify(await json(path.join(directory, 'candidate.json'))) !== JSON.stringify(candidate)) failures.push('candidate-file-mismatch');
    audits.push({id: scheduled.id, status: failures.length ? 'mismatch' : 'verified', valid: failures.length === 0, failures});
  }
  return {format: 'repair-study-replay-v2', auditedAt: new Date().toISOString(), plannedTrials: study.schedule.length, verifiedTrials: audits.filter(a => a.valid).length, audits,
    statement: 'Recomputed API responses, exact model patch application and fixed localization scores. Replaying bytes is not rerunning kernels or validating a new runtime claim.'};
}

export async function summarize(output, runtimeFile = null) {
  const study = await verifyFreeze(output), records = runtimeFile ? await json(runtimeFile) : {format: 'repair-study-runtime-v2', results: []};
  insist(records.format === 'repair-study-runtime-v2' && Array.isArray(records.results), 'runtime result format');
  insist(new Set(records.results.map(record => record.trialId)).size === records.results.length && records.results.every(record => study.schedule.some(trial => trial.id === record.trialId)), 'duplicate/unplanned runtime result');
  const rows = [];
  for (const scheduled of study.schedule) {
    const directory = path.join(output, 'trials', scheduled.id), result = await exists(path.join(directory, 'result.json')) ? await json(path.join(directory, 'result.json')) : null;
    const task = study.catalog.tasks.find(task => task.id === scheduled.taskId);
    let candidate = null, candidateIdentityVerified = false;
    if (await exists(path.join(directory, 'answer.json'))) {
      try {
        candidate = applyEdits(task, await json(path.join(directory, 'answer.json')));
        candidateIdentityVerified = JSON.stringify(candidate) === JSON.stringify(await json(path.join(directory, 'candidate.json'))) && candidate.candidateTreeSHA256 === result?.candidateTreeSHA256;
      } catch { candidate = null; }
    }
    const spec = study.privatePlan.tasks.find(task => task.id === scheduled.taskId), record = records.results.find(record => record.trialId === scheduled.id);
    let endpoint = scoreRuntime(spec, candidate, record);
    let verifierReceiptBound = false;
    if (record?.verifierReceiptPath && runtimeFile) {
      try { verifierReceiptBound = sha(await readFile(path.resolve(path.dirname(runtimeFile), record.verifierReceiptPath))) === record.verifierReceiptSHA256; } catch {}
    }
    if (endpoint.success && (!candidateIdentityVerified || !verifierReceiptBound)) endpoint = {...endpoint, success: false, reason: !candidateIdentityVerified ? 'candidate-file-identity-mismatch' : 'verifier-receipt-bytes-missing-or-mismatched'};
    if (!result?.valid || !result?.patchApplicable) endpoint = {...endpoint, success: false, reason: result ? 'invalid-or-inapplicable-model-candidate' : 'missing-trial'};
    rows.push({...scheduled, rootCauseId: spec.rootCauseId, generated: Boolean(result), valid: Boolean(result?.valid), patchApplicable: Boolean(result?.patchApplicable),
      localization: result?.localization ?? null, queries: result?.budget.queries ?? null, responseCharacters: result?.budget.responseCharacters ?? null,
      modelWallSeconds: result?.modelWallSeconds ?? null, usage: result?.usage ?? {}, candidateTreeSHA256: candidate?.candidateTreeSHA256 ?? null, candidateIdentityVerified, verifierReceiptBound, endpoint});
  }
  const groups = [];
  for (const split of ['development', 'holdout']) for (const condition of study.protocol.conditions) {
    const subset = rows.filter(row => row.split === split && row.condition === condition);
    if (!subset.length) continue;
    groups.push({split, condition, planned: subset.length, generated: subset.filter(row => row.generated).length, repairSuccess: subset.filter(row => row.endpoint.success).length,
      rootCauses: [...new Set(subset.map(row => row.rootCauseId))], localizationHits: subset.filter(row => row.localization?.locationHit).length,
      supportedLocalization: subset.filter(row => row.localization?.supportedLocalization).length});
  }
  return {format: 'repair-study-summary-v2', createdAt: new Date().toISOString(), plannedTrials: rows.length, groups, rows,
    primaryEndpoint: study.protocol.primaryEndpoint, comparisonUnit: study.protocol.comparisonUnit, runtimeReceipt: runtimeFile ? {path: path.resolve(runtimeFile), sha256: sha(await readFile(runtimeFile))} : null,
    limitation: 'Development and holdout are separate. Missing trials/results count as no successful repair; a generation-only summary does not demonstrate runtime failure or success.'};
}

async function main() {
  const [command, output, ...args] = process.argv.slice(2);
  if (!command || !output) throw Error('Use tools-freeze DIR | tools-verify DIR | freeze OUT CATALOG PRIVATE TOOL_FREEZE [OVERRIDES_JSON] | verify OUT | run OUT | replay OUT | summarize OUT [RUNTIME_JSON]');
  let result;
  if (command === 'tools-freeze') result = await freezeTools(path.resolve(output));
  else if (command === 'tools-verify') result = await verifyTools(path.resolve(output));
  else if (command === 'freeze') { insist(args.length >= 3, 'catalog/private/tool-freeze required'); result = await freezeStudy(path.resolve(output), ...args.slice(0, 3).map(file => path.resolve(file)), args[3] ? await json(args[3]) : {}); }
  else if (command === 'verify') { const value = await verifyFreeze(path.resolve(output)); result = {status: 'verified', frozenAt: value.manifest.frozenAt, counts: value.manifest.counts}; }
  else if (command === 'run') result = await runStudy(path.resolve(output));
  else if (command === 'replay') result = await replayStudy(path.resolve(output));
  else if (command === 'summarize') result = await summarize(path.resolve(output), args[0] ? path.resolve(args[0]) : null);
  else throw Error('unknown command');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
