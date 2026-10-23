/** Descriptive reporting adapter; never alters frozen scores or candidate source. */
import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {summarize, verifyFreeze, replayStudy} from './run.mjs';
import {sha} from './core.mjs';

const json = async p => JSON.parse(await readFile(p, 'utf8'));
const save = (p, d) => writeFile(p, JSON.stringify(d, null, 2) + '\n');
const existsJson = async p => { try { return await json(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const completeUsage = c => Array.isArray(c.usage) && c.usage.length > 0 && c.usage.every(u => u && Number.isFinite(u.input_tokens) && Number.isFinite(u.output_tokens));
const normalizedCases = cases => JSON.stringify(cases.map(c => ({id: c.id, status: c.status})).sort((a, b) => a.id.localeCompare(b.id)));
const describe = a => {
  const b = a.filter(Number.isFinite).sort((a, b) => a - b);
  return {n: b.length, total: b.reduce((s, v) => s + v, 0), mean: b.length ? b.reduce((s, v) => s + v, 0) / b.length : null,
    median: b.length ? (b[Math.floor((b.length - 1) / 2)] + b[Math.floor(b.length / 2)]) / 2 : null,
    min: b[0] ?? null, max: b.at(-1) ?? null};
};

export async function analyze(studyDir, baseDir) {
  const study = await verifyFreeze(studyDir), replay = await replayStudy(studyDir);
  if (replay.verifiedTrials !== study.schedule.length) throw Error('All planned generation traces must replay before runtime reporting');
  const generation = await Promise.all(study.schedule.map(t => json(path.join(studyDir, 'trials', t.id, 'result.json'))));
  const allGenerationFinishedAt = generation.map(t => t.finishedAt).sort().at(-1);
  const records = [], runtimeById = new Map();
  for (const scheduled of study.schedule) {
    const familyDir = scheduled.taskId.startsWith('liger-') ? 'liger-faults' : 'natural-fault-expansion';
    const directory = path.join(baseDir, familyDir, 'candidate-evaluations', scheduled.id);
    const record = await existsJson(path.join(directory, 'runtime-record.json'));
    if (!record) continue;
    const receipt = await existsJson(path.join(directory, 'independent-verification.json'));
    const run = await existsJson(path.join(directory, 'run', 'summary.json'));
    const runtimeStart = run?.started_at ?? run?.started_utc;
    if (runtimeStart && new Date(runtimeStart) < new Date(allGenerationFinishedAt)) throw Error('Hidden evaluation preceded generation completion');
    if (receipt && sha(await readFile(path.join(directory, 'independent-verification.json'))) !== record.verifierReceiptSHA256) throw Error('Verifier receipt changed');
    if (receipt) {
      const spec = study.privatePlan.tasks.find(t => t.id === scheduled.taskId);
      const canonical = receipt.cases.map(c => ({id: c.id, status: typeof c.passed === 'boolean' ? c.passed ? 'passed' : 'failed' : c.status}));
      if (normalizedCases(record.cases) !== normalizedCases(canonical.filter(c => spec.hiddenCaseIds.includes(c.id))) ||
          normalizedCases(record.visibleCases ?? []) !== normalizedCases(canonical.filter(c => !spec.hiddenCaseIds.includes(c.id)))) throw Error('Runtime status mapping differs from independent verifier');
    }
    const item = {...record, trialId: scheduled.id,
      ...(receipt ? {verifierReceiptPath: path.relative(studyDir, path.join(directory, 'independent-verification.json'))} : {})};
    records.push(item); runtimeById.set(scheduled.id, {record, receipt, run});
  }
  const runtimeFile = path.join(studyDir, 'runtime-results.json');
  await save(runtimeFile, {format: 'repair-study-runtime-v2', allGenerationFinishedAt, results: records});
  const summary = await summarize(studyDir, runtimeFile);
  await save(path.join(studyDir, 'runtime-summary.json'), summary);
  await save(path.join(studyDir, 'replay.json'), replay);
  const rows = summary.rows.map(row => {
    const g = generation.find(t => t.id === row.id), runtime = runtimeById.get(row.id);
    const receipt = runtime?.receipt;
    // Both verifiers retain per-case pass judgments. Actual counts do not alter
    // the preregistered hidden-only primary endpoint.
    const cases = receipt?.cases ?? [];
    const passed = cases.filter(c => c.passed === true || c.status === 'passed').length;
    const expected = receipt?.expected_cases ?? receipt?.cases?.length ?? 0;
    const task = study.catalog.tasks.find(t => t.id === row.taskId);
    const spec = study.privatePlan.tasks.find(t => t.id === row.taskId);
    const submitted = finalAnswer(g);
    return {...row, failure: g.failure, patchError: g.patchError ?? null, wallSeconds: g.wallSeconds,
      infrastructureInterrupted: Boolean(g.interruption), unrecordedCallPossible: Boolean(g.interruption?.inFlightCallMayBeUnrecorded),
      calls: g.calls.length, queryWallMilliseconds: g.queryWallMilliseconds,
      callsWithUsage: g.calls.filter(completeUsage).length,
      callsWithoutUsage: g.calls.filter(c => !completeUsage(c)).length,
      locationCount: submitted?.locations?.length ?? 0,
      submittedLocationLines: (submitted?.locations ?? []).reduce((s, x) => s + Math.max(0, x.end_line - x.start_line + 1), 0),
      derivedRequests: g.queries.filter(q => q.request.op === 'derived').length,
      acceptedDerivedRequests: g.queries.filter(q => q.request.op === 'derived' && q.accepted).length,
      successfulDerivedRequests: g.queries.filter(q => q.request.op === 'derived' && q.accepted && !q.rejected && !q.response?.error).length,
      rejectedQueries: g.queries.filter(q => q.rejected).length,
      validationWallSeconds: runtime?.record.wall_seconds ?? null,
      allCasesExpected: task.cases.length + spec.hiddenCaseIds.length,
      allCasesVerified: receipt?.completed_cases ?? cases.filter(c => !c.missing).length, allCasesPassed: passed,
      allCasesSuccess: Boolean(row.endpoint.success && expected === task.cases.length + spec.hiddenCaseIds.length && passed === expected),
      visibleFailures: (runtime?.record.visibleCases ?? []).filter(c => c.status !== 'passed').length,
      visiblePassingControlRegressions: (runtime?.record.visibleCases ?? []).filter(c => c.status !== 'passed' && task.cases.some(old => old.id === c.id && old.status === 'passed')).length,
      validationReceiptSHA256: runtime?.record.verifierReceiptSHA256 ?? null,
      outputsVerified: receipt?.outputs ?? receipt?.total_elements ?? null,
      runtimeBuildStatus: runtime?.record.buildStatus ?? 'not-executed'};
  });
  const groups = study.protocol.conditions.map(condition => {
    const a = rows.filter(r => r.condition === condition);
    return {condition, planned: a.length, hiddenRepairSuccess: a.filter(r => r.endpoint.success).length,
      allCaseRepairSuccess: a.filter(r => r.allCasesSuccess).length,
      locationHit: a.filter(r => r.localization?.locationHit).length,
      supportedLocalization: a.filter(r => r.localization?.supportedLocalization).length,
      toolUptake: a.filter(r => r.derivedRequests > 0).length,
      callsWithMissingUsage: a.reduce((s, r) => s + r.callsWithoutUsage, 0),
      infrastructureInterrupted: a.filter(r=>r.infrastructureInterrupted).length,
      trialsWithPossibleUnrecordedCalls: a.filter(r=>r.unrecordedCallPossible).length,
      modelCalls: describe(a.map(r => r.calls)), modelWallSeconds: describe(a.map(r => r.modelWallSeconds)),
      completedTrialModelWallSeconds: describe(a.filter(r=>!r.infrastructureInterrupted).map(r=>r.modelWallSeconds)),
      trialWallSeconds: describe(a.map(r => r.wallSeconds)), validationWallSeconds: describe(a.map(r => r.validationWallSeconds)),
      completedTrialWallSeconds: describe(a.filter(r=>!r.infrastructureInterrupted).map(r=>r.wallSeconds)),
      inputTokens: describe(a.map(r => r.usage.input_tokens)), cachedInputTokens: describe(a.map(r => r.usage.cached_input_tokens)),
      outputTokens: describe(a.map(r => r.usage.output_tokens)), queries: describe(a.map(r => r.queries)),
      queryWallMilliseconds: describe(a.map(r => r.queryWallMilliseconds)), responseCharacters: describe(a.map(r => r.responseCharacters))};
  });
  const roots = study.catalog.tasks.map(task => ({taskId: task.id, conditions: groups.map(({condition}) => {
    const a = rows.filter(r => r.taskId === task.id && r.condition === condition);
    return {condition, n: a.length, success: a.filter(r => r.endpoint.success).length,
      allCaseSuccess: a.filter(r => r.allCasesSuccess).length, supportedLocalization: a.filter(r => r.localization?.supportedLocalization).length,
      modelWallSeconds: describe(a.map(r => r.modelWallSeconds)), inputTokens: describe(a.map(r => r.usage.input_tokens)),
      derivedRequests: a.reduce((s, r) => s + r.derivedRequests, 0)};
  })}));
  const report = {format: 'repair-study-descriptive-analysis-v2', allGenerationFinishedAt,
    analysisScope: 'Descriptive summaries over six selected independent roots, three model draws per condition. No population significance, human effects or operator speedup is inferred. This reporting adapter does not redefine frozen endpoints.',
    timingScope: 'Model/API wall clock includes service/network and repeated prompt serialization. Interrupted trials may have unrecorded in-flight calls, so their model wall/call totals are lower bounds; their trial wall includes an administrative observation gap and is not a completed latency. Completed-trial summaries exclude those two administrative records. GPU validation wall time covers only retained complete evaluator attempts, omitting the unmeasured externally interrupted attempt and source overlay preparation, so summed validation cost is also a retained lower bound. It includes process/import/JIT/CPU oracle/filesystem work, may overlap other correctness jobs, and is not kernel latency. Query time is local JS processing. These are scoped measurements, not full end-to-end speed.',
    usageScope: 'Provider-reported input_tokens includes cached_input_tokens; cached tokens are a subset, not an extra total. Missing usage OR infrastructure interruption with a possibly unrecorded in-flight call makes total recorded calls/tokens a lower bound, even when every retained call has usage. No invoice/USD amount is estimated.',
    plannedTrials: rows.length, runtimeRecords: records.length, groups, roots, rows};
  await save(path.join(studyDir, 'analysis.json'), report);
  const catalogBytes = await readFile(path.join(studyDir, 'frozen', 'catalog-before.json'));
  await save(path.join(studyDir, 'viewer-outcomes.json'), {format: 'repair-study-viewer-outcomes-v1', catalogSha256: sha(catalogBytes),
    rows: rows.map(r => ({taskId: r.taskId, condition: r.condition, repeat: r.repetition,
      status: r.allCasesSuccess ? 'passed' : r.runtimeBuildStatus === 'not-executed' ? 'not_run' : 'failed',
      passedCases: r.allCasesPassed, totalCases: r.allCasesExpected, wallSeconds: r.modelWallSeconds,
      sourceSha256: r.candidateTreeSHA256, validationSha256: r.validationReceiptSHA256}))});
  return {plannedTrials: rows.length, runtimeRecords: records.length, groups, roots};
}

function finalAnswer(g) { return g.calls.findLast(c => c.valid && c.answer?.action === 'final')?.answer; }

if (process.argv[1]?.endsWith('analyze.mjs')) console.log(JSON.stringify(await analyze(path.resolve(process.argv[2]), path.resolve(process.argv[3] ?? 'out/research')), null, 2));
