#!/usr/bin/env node
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {normalizeDetailedTrace, normalizeFlashGpuLog, normalizeFlashGpuPipelineLog} from '../../lib/detailed-trace.js';

const usage = 'node tools/detailed/convert.mjs --input simulation.log --output detail.json [--run-id ID] [--revision SHA] [--backend-version VERSION] [--wall-time-seconds SECONDS --timing-scope SCOPE]';
const options = new Map();
const allowed = new Set(['--input', '--output', '--run-id', '--revision', '--backend-version', '--wall-time-seconds', '--timing-scope', '--evidence-kind']);
try {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index]) || args[index + 1] == null) throw new Error(usage);
    options.set(args[index], args[index + 1]);
  }
  if (!options.has('--input') || !options.has('--output')) throw new Error(usage);
  const raw = await readFile(options.get('--input'), 'utf8');
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const isJson = /^\s*\{/.test(raw);
  const input = isJson ? JSON.parse(raw) : null;
  const meta = {runId: options.get('--run-id') ?? input?.meta?.runId ?? `import-sha256:${sha256}`};
  if (options.has('--revision')) meta.producerRevision = options.get('--revision');
  if (options.has('--backend-version')) meta.backendVersion = options.get('--backend-version');
  if (options.has('--evidence-kind')) meta.evidenceKind = options.get('--evidence-kind');
  if (options.has('--wall-time-seconds')) meta.wallTimeSeconds = Number(options.get('--wall-time-seconds'));
  if (options.has('--timing-scope')) meta.timingScope = options.get('--timing-scope');
  const trace = isJson
    ? normalizeDetailedTrace({...input, meta: {...input.meta, ...meta}, metrics: {...input.metrics, ...(meta.wallTimeSeconds == null ? {} : {wallTimeSeconds: meta.wallTimeSeconds}), ...(meta.timingScope == null ? {} : {timingScope: meta.timingScope})}})
    : /^\s*FLASHGPU_PIPELINE(?:_CONFIG)?\s/m.test(raw) ? normalizeFlashGpuPipelineLog(raw, meta) : normalizeFlashGpuLog(raw, meta);
  trace.source = {...(trace.source ?? {format: 'canonical-instruction-trace', raw: input}), importedArtifactSha256: sha256};
  if (trace.source.sha256 == null) trace.source.sha256 = sha256;
  await writeFile(options.get('--output'), `${JSON.stringify(trace, null, 2)}\n`);
  console.log(`Converted ${trace.events.length} instruction observations/intervals; capabilities: ${trace.meta.capabilities.join(', ')}. Source SHA-256: ${sha256}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
