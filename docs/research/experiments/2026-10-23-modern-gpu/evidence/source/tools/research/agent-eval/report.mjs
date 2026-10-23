/** Recompute descriptive tables from saved calls; never invokes an LLM. */
import {readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {DEFAULT_OUTPUT, sha256} from './fixtures.mjs';
import {verifyFreeze, auditJSONL, validateAnswer, scoreAnswer, summarize} from './run.mjs';

const output = path.resolve(process.argv[2] ?? DEFAULT_OUTPUT);
const {manifest, fixtures} = await verifyFreeze(output);
const environment = JSON.parse(await readFile(path.join(output, 'environment.json'), 'utf8'));
const directories = (await readdir(path.join(output, 'main'), {withFileTypes: true})).filter(d => d.isDirectory()).map(d => d.name).sort();
const calls = [];
const discrepancies = [];
for (const directory of directories) {
  const call = JSON.parse(await readFile(path.join(output, 'main', directory, 'result.json'), 'utf8'));
  const task = fixtures.find(t => t.id === call.task);
  if (!task) throw new Error(`Unknown task ${call.task}`);
  const prompt = await readFile(path.join(output, 'main', directory, 'prompt.txt'), 'utf8');
  const registered = manifest.prompts.find(p => p.task === call.task && p.condition === call.condition);
  if (sha256(prompt) !== registered?.sha256 || sha256(prompt) !== call.promptSHA256) discrepancies.push(`${directory}: prompt hash`);
  const audit = auditJSONL(await readFile(path.join(output, 'main', directory, 'source.jsonl'), 'utf8'));
  if (call.valid && (audit.forbidden.length || audit.parseErrors.length || !audit.complete || audit.failed.length || !validateAnswer(call.answer))) discrepancies.push(`${directory}: recorded validity`);
  if (call.valid) {
    const finalMessage = audit.events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').at(-1)?.item.text;
    const savedAnswer = JSON.parse(await readFile(path.join(output, 'main', directory, 'answer.json'), 'utf8'));
    if (JSON.stringify(JSON.parse(finalMessage)) !== JSON.stringify(call.answer) || JSON.stringify(savedAnswer) !== JSON.stringify(call.answer)) discrepancies.push(`${directory}: raw/final answer mismatch`);
  }
  const scores = scoreAnswer(task, call.answer, call.valid);
  if (JSON.stringify(scores) !== JSON.stringify(call.scores)) discrepancies.push(`${directory}: recorded scores`);
  calls.push(call);
}
if (discrepancies.length) throw new Error(JSON.stringify(discrepancies));
const summary = summarize(fixtures, calls, manifest, environment.cliVersion);
await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
const csv = rows => rows.map(row => row.map(value => '"' + String(value ?? '').replaceAll('"', '""') + '"').join(',')).join('\n') + '\n';
await writeFile(path.join(output, 'calls.csv'), csv([['call', 'task', 'condition', 'repeat', 'gold', 'answer', 'valid', 'status_correct', 'references_valid', 'evidence_covered', 'missing_evidence_exact', 'fully_supported', 'wall_seconds', 'input_tokens', 'output_tokens'], ...calls.map(c => [c.callId, c.task, c.condition, c.repetition, c.goldStatus, c.answer?.status, c.valid, c.scores.statusCorrect, c.scores.referencesValid, c.scores.evidenceCovered, c.scores.missingEvidenceExact, c.scores.fullySupported, c.wallSeconds, c.usage.reduce((n,u)=>n+(u?.input_tokens??0),0), c.usage.reduce((n,u)=>n+(u?.output_tokens??0),0)])]));
await writeFile(path.join(output, 'tasks.csv'), csv([['task', 'source', 'gold', 'flat_status_accuracy', 'structured_status_accuracy', 'flat_support_accuracy', 'structured_support_accuracy', 'paired_status_delta', 'paired_support_delta', 'flat_wall_seconds', 'structured_wall_seconds'], ...summary.taskRows.map(t => [t.task, t.sourceId, t.gold, t.flat.statusAccuracy, t.structured.statusAccuracy, t.flat.supportAccuracy, t.structured.supportAccuracy, t.pairedStatusDelta, t.pairedSupportDelta, t.flat.wallSeconds, t.structured.wallSeconds])]));
const earliest = calls.map(c => c.startedAt).sort()[0];
if (!(manifest.frozenAt < earliest)) throw new Error('Freeze did not precede main calls');
const pct = n => `${(n * 100).toFixed(1)}%`;
const f = summary.byCondition.flat, s = summary.byCondition.structured;
const report = `# Prompt-only agent pilot: finite generation/order diagnosis\n\n` +
  `The frozen synthetic task set produced ${f.statusCorrect}/${f.attempted} correct oracle labels with flat facts and ${s.statusCorrect}/${s.attempted} with structured JSON. This measures this agent's finite-model diagnosis only. It does not establish that agents replace humans or that a visual interface improves diagnosis.\n\n` +
  `| Condition | Valid / attempted | Oracle label correct | Reference/missing-evidence checks all pass | Mean CLI wall time |\n| --- | ---: | ---: | ---: | ---: |\n` +
  `| Flat facts | ${f.valid}/${f.attempted} | ${f.statusCorrect}/${f.attempted} | ${f.fullySupported}/${f.attempted} | ${f.meanWallSeconds.toFixed(3)} s |\n` +
  `| Structured JSON | ${s.valid}/${s.attempted} | ${s.statusCorrect}/${s.attempted} | ${s.fullySupported}/${s.attempted} | ${s.meanWallSeconds.toFixed(3)} s |\n\n` +
  `At the paired task level (n = ${summary.pairedTaskAnalysis.n}; two repeats averaged within task/condition), the structured-minus-flat mean label-accuracy difference is ${pct(summary.pairedTaskAnalysis.meanStatusDelta)} and the reference-check difference is ${pct(summary.pairedTaskAnalysis.meanSupportDelta)}. There are ${summary.pairedTaskAnalysis.structuredStatusWins} structured wins, ${summary.pairedTaskAnalysis.flatStatusWins} flat wins, and ${summary.pairedTaskAnalysis.statusTies} ties. These are descriptive results, with no population or equivalence test.\n\n` +
  `## Frozen design\n\n` +
  `- Freeze time: ${manifest.frozenAt}; earliest main call: ${earliest}.\n` +
  `- Fixture SHA-256: \`${manifest.fixtureSHA256}\`.\n` +
  `- Requested model: \`${environment.model}\`; reasoning effort: \`${environment.reasoningEffort}\`; CLI: \`${environment.cliVersion}\`. A resolved model snapshot was not exposed by CLI JSONL.\n` +
  `- Twelve predeclared synthetic development tasks, from twelve different source captures, balanced 4/4/4 over sat/violated/unknown. No held-out natural-bug claim.\n` +
  `- Independent gold: exhaustive HB-consistent total-order oracle. Production code validates input structure only.\n` +
  `- Two input organizations share the exact same semantic fields, rules, and output requirements; a test reconstructs flat fields into the same JSON payload. Neither is a visualization.\n` +
  `- Two smoke calls verified transport/schema/no-tools and were excluded from the ${calls.length} main calls. No score-driven prompt tuning.\n` +
  `- Each call starts in an empty temporary working directory with no task files, uses an ephemeral thread and disabled shell tool, and receives all case information in stdin. Maximum concurrency is two and timeout is 90 seconds. Any tool item invalidates the call.\n\n` +
  `## Audit and scoring\n\n` +
  `Main calls contain ${calls.filter(c=>c.audit.forbidden.length).length} tool-contaminated transcripts, ${calls.filter(c=>!c.valid).length} invalid calls, and ${calls.filter(c=>c.timedOut).length} timeouts. Every saved prompt hash and deterministic score was recomputed from the frozen task and raw result records. Raw stdout JSONL, stderr, final answers, usage and wall time are retained per call. The runner's timeout and tool-contamination handling are tested with a mock CLI.\n\n` +
  `Reference scoring checks existence, the predeclared relevant record/identity/unique-path references, and exact missing-evidence codes. It allows extra valid references and does not judge the natural-language reason or minimal explanation. Invalid calls count as unsuccessful; no replacement calls are generated.\n\n` +
  `Input usage totals: flat ${f.usage.input_tokens ?? 0}, structured ${s.usage.input_tokens ?? 0}; output usage totals: flat ${f.usage.output_tokens ?? 0}, structured ${s.usage.output_tokens ?? 0}. CLI input usage includes harness/system context, not just the task prompt. Wall time includes network/service/queue overhead and is not an isolated reasoning-time measure.\n\n` +
  `## Boundaries\n\n` +
  `These tasks explicitly teach the bounded decision rules, are small and synthetic, and use only one model/configuration. Repeats are agent calls, not people. No human baseline, human timing, interaction study, natural GPU diagnosis task or visual-comprehension outcome was collected. A ceiling result would show that these tasks fail to discriminate the two organizations; it would not prove equivalence or agent replacement of human participants.\n\n` +
  `See \`tasks.csv\` for paired task data, \`calls.csv\` for all calls, \`frozen/manifest.json\` for preregistered inputs and source hashes, and \`validation-tests.txt\` for deterministic tests. The harness uses the [official OpenAI CLI eval approach](https://developers.openai.com/blog/eval-skills) for JSONL audit and structured outputs.\n`;
await writeFile(path.join(output, 'report.md'), report);
await writeFile(path.join(output, 'verification.json'), JSON.stringify({verifiedAt: new Date().toISOString(),
  fixtureSHA256: manifest.fixtureSHA256, mainCallsChecked: calls.length, promptHashDiscrepancies: 0,
  scoreDiscrepancies: 0, freezePrecedesMain: true, rawTranscriptAuditPassed: calls.every(c => c.audit.forbidden.length === 0),
  expectedMainCalls: 48, complete: calls.length === 48}, null, 2) + '\n');
async function walk(dir, prefix = '') {
  const files = [];
  for (const item of await readdir(dir, {withFileTypes: true})) {
    const relative = path.join(prefix, item.name);
    if (item.isDirectory()) files.push(...await walk(path.join(dir, item.name), relative));
    else if (relative !== 'artifacts.sha256') files.push(relative);
  }
  return files;
}
const hashes = [];
for (const relative of (await walk(output)).sort()) hashes.push(`${sha256(await readFile(path.join(output, relative)))}  ${relative}`);
await writeFile(path.join(output, 'artifacts.sha256'), hashes.join('\n') + '\n');
console.log(JSON.stringify({calls: calls.length, verified: true, summary: summary.byCondition}, null, 2));
