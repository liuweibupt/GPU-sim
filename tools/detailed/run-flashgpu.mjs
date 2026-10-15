#!/usr/bin/env node
// Build a pinned official simulator and capture native output; no GPU required.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const revision = '291fbe172332eb481556632a79eb9cfc93cf46bf';
const repository = 'https://github.com/FlashGPU-Sim/FlashGPU-Sim.git';
const toolDir = dirname(fileURLToPath(import.meta.url));
const sha256 = input => createHash('sha256').update(input).digest('hex');
const usage = 'node tools/detailed/run-flashgpu.mjs --cuda /usr/local/cuda-12.8 [--source /path/to/pinned/checkout] [--output /tmp/flashgpu-vectoradd] [--jobs 8] [--pipeline]';
const options = new Map();
let appliedObserver = null;

function run(command, args, {cwd, env = process.env, log} = {}) {
  const fd = log ? openSync(log, 'w') : null;
  let result;
  try {
    result = spawnSync(command, args, {cwd, env, encoding: 'utf8', stdio: fd == null ? 'pipe' : ['ignore', fd, fd]});
  } finally {
    if (fd != null) closeSync(fd);
  }
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed (${result.status ?? result.error?.message}). ${log ? `See ${log}` : result.stderr?.trim()}`);
  }
  return result.stdout?.trim() ?? '';
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(`${usage}\nRequires Linux and CUDA Toolkit (tested with 12.8), GCC/G++, Make, Flex, Bison, zlib and makedepend. A physical GPU is not required.\nWithout --source, fetches the pinned official revision in the user cache. Every capture cleans and rebuilds simulator objects with tracing enabled.\n--pipeline applies the bundled minimal lifecycle observer patch, captures exact native instruction hooks, then restores tracked upstream sources.\nWrites .log, .json, .manifest.json, .clean.log, .build.log and .compile.log beside the output prefix.`);
    process.exit(0);
  }
  for (let index = 0; index < args.length;) {
    if (args[index] === '--pipeline') {
      options.set('--pipeline', true);
      index++;
      continue;
    }
    if (!['--cuda', '--source', '--output', '--jobs'].includes(args[index]) || args[index + 1] == null) throw new Error(usage);
    options.set(args[index], args[index + 1]);
    index += 2;
  }
  const pipeline = options.has('--pipeline');
  const cuda = resolve(options.get('--cuda') ?? process.env.CUDA_INSTALL_PATH ?? '/usr/local/cuda-12.8');
  if (!existsSync(join(cuda, 'bin/nvcc'))) throw new Error(`CUDA Toolkit nvcc missing at ${cuda}; ${usage}`);
  const jobs = Number(options.get('--jobs') ?? 8);
  if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 256) throw new Error('--jobs must be an integer from 1 to 256.');
  const output = resolve(options.get('--output') ?? join(tmpdir(), 'flashgpu-vectoradd'));
  mkdirSync(dirname(output), {recursive: true});
  const source = resolve(options.get('--source') ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'gpu-sim', `flashgpu-${revision}`));
  if (!existsSync(join(source, 'setup_environment'))) {
    if (options.has('--source')) throw new Error(`No FlashGPU-Sim checkout at ${source}`);
    mkdirSync(source, {recursive: true});
    console.log(`Fetching official FlashGPU-Sim ${revision} into ${source}`);
    run('git', ['init', '-q', source]);
    run('git', ['-c', 'http.version=HTTP/1.1', 'fetch', '--depth', '1', repository, revision], {cwd: source});
    run('git', ['checkout', '--detach', 'FETCH_HEAD'], {cwd: source});
  }
  if (run('git', ['rev-parse', 'HEAD'], {cwd: source}) !== revision) throw new Error(`Source must be pinned to ${revision}`);
  if (run('git', ['status', '--porcelain', '--untracked-files=no'], {cwd: source})) throw new Error('FlashGPU-Sim tracked sources must be clean for verifiable provenance.');

  const observerPatchPath = join(toolDir, 'flashgpu-pipeline-observer.patch');
  const observerPatch = pipeline ? readFileSync(observerPatchPath) : null;
  if (pipeline) {
    run('git', ['apply', '--check', observerPatchPath], {cwd: source});
    run('git', ['apply', observerPatchPath], {cwd: source});
    appliedObserver = {source, patchPath: observerPatchPath};
  }
  const observerDiffHash = pipeline ? sha256(run('git', ['diff', '--binary'], {cwd: source})) : null;
  const observedHookSources = pipeline ? [
    ['ISSUE', 'shader_core_ctx::issue_warp', 'pipeline_observe("ISSUE",'],
    ['OPERAND_COLLECT', 'opndcoll_rfu_t::collector_unit_t::allocate', 'pipeline_observe("OPERAND_COLLECT",'],
    ['OPERAND_READY', 'opndcoll_rfu_t::collector_unit_t::dispatch', 'pipeline_observe("OPERAND_READY",'],
    ['EXECUTE', 'shader_core_ctx::execute', 'pipeline_observe("EXECUTE",'],
    ['EXECUTE_END', 'pipelined_simd_unit::cycle', 'pipeline_observe("EXECUTE_END",'],
    ['WRITEBACK', 'shader_core_ctx::writeback + ldst_unit::writeback (final successful RF completion)', 'pipeline_observe("WRITEBACK",'],
    ['COMPLETE', 'shader_core_ctx::warp_inst_complete', 'pipeline_observe("COMPLETE",']
  ].map(([event, hook, marker]) => ({event, hook, source: 'src/gpgpu-sim/shader.cc',
    patchedSourceLines: readFileSync(join(source, 'src/gpgpu-sim/shader.cc'), 'utf8').split('\n').flatMap((line, index) => line.includes(marker) ? [index + 1] : [])})) : null;

  const runDir = mkdtempSync(join(tmpdir(), 'gpu-sim-flashgpu-'));
  const setupLog = join(runDir, 'setup.log');
  const environmentResult = spawnSync('bash', ['-c', 'source "$1/setup_environment" >"$2" && env -0', 'flashgpu-setup', source, setupLog], {
    cwd: source, env: {...process.env, CUDA_INSTALL_PATH: cuda}, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024
  });
  if (environmentResult.status !== 0) throw new Error(`FlashGPU-Sim setup failed. See ${setupLog}`);
  const env = Object.fromEntries(environmentResult.stdout.split('\0').filter(Boolean).map(entry => {
    const separator = entry.indexOf('=');
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  env.OMP_NUM_THREADS = '1';
  if (pipeline) env.GPU_SIM_PIPELINE_OBSERVER = '1';
  else delete env.GPU_SIM_PIPELINE_OBSERVER;
  // Upstream Makefiles do not track compiler flags. Always clear prior objects
  // so a checkout previously built with TRACE=0 cannot silently reuse them.
  console.log(`Cleaning previous simulator objects; log: ${output}.clean.log`);
  run('make', ['clean', 'TRACE=1', 'FLASH=1'], {cwd: source, env, log: `${output}.clean.log`});
  console.log(`Building simulator; log: ${output}.build.log`);
  run('make', ['-j', String(jobs), 'TRACE=1', 'FLASH=1'], {cwd: source, env, log: `${output}.build.log`});
  if (pipeline ? sha256(run('git', ['diff', '--binary'], {cwd: source})) !== observerDiffHash : run('git', ['status', '--porcelain', '--untracked-files=no'], {cwd: source})) throw new Error('Build unexpectedly changed tracked backend sources.');
  const runtime = join(source, 'lib', env.GPGPUSIM_CONFIG, 'libcudart.so');
  if (!existsSync(runtime)) throw new Error('FlashGPU-Sim replacement CUDA runtime was not built.');

  const configName = 'SM90_H100';
  const configDir = join(source, 'configs', configName);
  cpSync(configDir, runDir, {recursive: true});
  const originalConfig = readFileSync(join(configDir, 'gpgpusim.config'), 'utf8');
  const overrides = {'-trace_enabled': '1', '-trace_components': 'INSTRUCTION_ISSUE', '-trace_sampling_core': '-1'};
  let config = originalConfig;
  for (const [key, value] of Object.entries(overrides)) {
    const pattern = new RegExp(`^${key}\\s+.*$`, 'm');
    if (!pattern.test(config)) throw new Error(`Pinned configuration lacks ${key}`);
    config = config.replace(pattern, `${key} ${value}`);
  }
  writeFileSync(join(runDir, 'gpgpusim.config'), config);
  const workloadPath = join(toolDir, 'vector-add.cu');
  const executable = join(runDir, 'vectorAdd');
  const compileArgs = ['-std=c++17', '-cudart', 'shared', '-gencode', 'arch=compute_90a,code=sm_90a', '-gencode', 'arch=compute_90a,code=compute_90a', workloadPath, '-o', executable];
  run(join(cuda, 'bin/nvcc'), compileArgs, {cwd: runDir, env, log: `${output}.compile.log`});
  if (!run('ldd', [executable], {env}).includes(runtime)) throw new Error('Workload does not resolve libcudart to the simulator replacement.');
  const capturedAt = new Date().toISOString();
  console.log(`Running actual H100 PTX simulation; native output: ${output}.log`);
  const started = process.hrtime.bigint();
  run(executable, [], {cwd: runDir, env, log: `${output}.log`});
  const wallTimeSeconds = Number(process.hrtime.bigint() - started) / 1e9;
  const raw = readFileSync(`${output}.log`, 'utf8');
  if (!raw.includes('Vector addition validation PASSED (256/256 exact results)')) throw new Error('Backend workload correctness check did not pass.');
  const simulatedCycles = Number(raw.match(/gpu_tot_sim_cycle\s*=\s*(\d+)/)?.[1]);
  if (!Number.isSafeInteger(simulatedCycles) || simulatedCycles < 1) throw new Error('Backend did not report gpu_tot_sim_cycle.');
  const logHash = sha256(raw);
  const buildIdentity = raw.match(/FlashGPU-Sim \[build ([^\]]+)\]/)?.[1];
  if (!buildIdentity?.includes(revision.slice(0, 7))) throw new Error('Runtime build identity does not match the pinned backend revision.');
  const timingScope = 'Workload process from launch to exit, including simulator startup, PTX extraction, CPU simulation, functional validation, and native stdout/stderr writing; excludes source fetch, simulator/workload compilation, and JSON conversion. OMP_NUM_THREADS=1.';
  const detailedAdapters = await import('../../lib/detailed-trace.js');
  const normalize = pipeline ? detailedAdapters.normalizeFlashGpuPipelineLog : detailedAdapters.normalizeFlashGpuLog;
  if (typeof normalize !== 'function') throw new Error('Pipeline lifecycle importer is unavailable.');
  const trace = normalize(raw, {
    title: pipeline ? 'FlashGPU-Sim H100 · Vector Add / SM 指令光点' : 'FlashGPU-Sim H100 · Vector Add / SM 指令',
    producerRevision: revision, backendVersion: `FlashGPU-Sim@${revision}`,
    runId: `flashgpu-vectoradd:${capturedAt}:${logHash.slice(0, 12)}`,
    evidenceKind: 'simulation', architecture: configName, capturedAt,
    description: pipeline ? 'Actual CPU execution of the pinned official FlashGPU-Sim with the bundled timing-neutral lifecycle observer patch. H100 configuration; 256-element vector addition, 2 CTAs × 128 threads; all SMs observed. Stable native instruction UIDs join actual ISSUE / collector / FU execute / writeback / completion hooks. Displayed movement interpolates measured hook endpoints; it does not sample physical positions or infer cache/NoC sub-stages. Exact validation passed for all 256 outputs. No cross-run mapping to GTSim.' : 'Actual CPU execution of unmodified official FlashGPU-Sim at the pinned revision. H100 configuration; 256-element vector addition, 2 CTAs × 128 threads; all SMs sampled. ISSUE/STALL records are cycle observations, not execution durations or guaranteed complete issue coverage. Exact validation passed for all 256 outputs. No cross-run mapping to GTSim.',
    wallTimeSeconds, timingScope
  });
  trace.source = {...trace.source, sha256: logHash, importedArtifactSha256: logHash, provenanceManifest: `${basename(output)}.manifest.json`};
  const eventCounts = {};
  for (const event of trace.events) eventCounts[event.args.stage] = (eventCounts[event.args.stage] ?? 0) + 1;
  const manifest = {
    format: 'gpu-sim-backend-capture-v1', evidenceKind: 'simulation', capturedAt,
    backend: {name: 'FlashGPU-Sim', repository, revision, buildIdentity, trackedSourcesClean: !pipeline, ...(pipeline ? {baseTrackedSourcesClean: true, observerPatch: 'tools/detailed/flashgpu-pipeline-observer.patch', observerPatchSha256: sha256(observerPatch), patchedDiffSha256: observerDiffHash, observer: {format: 'FLASHGPU_PIPELINE JSONL schemaVersion=1', enabledBy: 'GPU_SIM_PIPELINE_OBSERVER=1', timingStateMutations: false, hooks: observedHookSources}} : {}), buildMode: 'release', cleanArgs: ['make', 'clean', 'TRACE=1', 'FLASH=1'], buildArgs: ['make', '-j', String(jobs), 'TRACE=1', 'FLASH=1'], tracingCompiled: true, runtimeSha256: sha256(readFileSync(runtime))},
    architecture: {config: configName, sourceConfigSha256: sha256(originalConfig), effectiveConfigSha256: sha256(config), overrides, interconnectConfigSha256: sha256(readFileSync(join(configDir, 'config_ampere_islip.icnt'))), instructionHintsSha256: sha256(readFileSync(join(configDir, 'sass_primary_hints.rules')))},
    workload: {source: 'tools/detailed/vector-add.cu', sourceSha256: sha256(readFileSync(workloadPath)), elements: 256, blocks: 2, threadsPerBlock: 128, compileArgs: compileArgs.map(value => value === workloadPath ? 'tools/detailed/vector-add.cu' : value === executable ? 'vectorAdd' : value), physicalGpuRequired: false},
    toolchain: {cuda: run(join(cuda, 'bin/nvcc'), ['--version']).split('\n').find(line => line.includes('release')), compiler: run('g++', ['--version']).split('\n')[0], node: process.version, platform: process.platform, openMpThreads: 1},
    capture: {nativeLog: `${basename(output)}.log`, nativeLogSha256: logHash, nativeLogBytes: Buffer.byteLength(raw), normalization: pipeline ? 'normalizeFlashGpuPipelineLog' : 'normalizeFlashGpuLog', runId: trace.meta.runId, timeDomain: trace.meta.timeDomain, traceComponents: ['INSTRUCTION_ISSUE'], samplingCore: -1, observedSmIds: [...new Set(trace.events.map(event => event.args.smId))], observedWarpCount: trace.components.filter(component => component.kind === 'warp').length, observedEventCount: trace.events.length, eventCounts, simulatedCycles, wallTimeSeconds, timingScope},
    validation: {processExitCode: 0, exactElementsChecked: 256, passed: true, marker: 'Vector addition validation PASSED (256/256 exact results)'},
    limitations: pipeline ? ['Execution-driven PTX observations, not SASS input traces.', 'Moving dots interpolate between measured observer hook endpoints; intermediate physical wire positions are not observed.', 'FU execute / complete bounds may include execution and memory wait; no cache level, network route or per-request memory transaction timing is inferred.', 'Stores COMPLETE means native LSU pipeline retirement, not global visibility or memory acknowledgement.', 'A load may complete through the L1 latency path without a separately observed RF writeback hook; no writeback point is synthesized.', 'Native STALL_SCOREBOARD remains the original broad backend reason; no RAW-only attribution is inferred.', 'No cross-backend run alignment is inferred.'] : ['Execution-driven PTX observations, not SASS input traces.', 'ISSUE/STALL points have no instruction completion timestamps.', 'Upstream tracing does not guarantee every multi-issue instruction or every stall cause.', 'No CTA identity, active mask, dependency edges, memory routes, or mapping to another backend run is inferred.']
  };
  if (pipeline) {
    const nativeConfigurations = raw.split(/\r?\n/).filter(line => line.startsWith('FLASHGPU_PIPELINE_CONFIG ')).map(line => JSON.parse(line.slice('FLASHGPU_PIPELINE_CONFIG '.length)));
    const nativeObservations = raw.split(/\r?\n/).filter(line => line.startsWith('FLASHGPU_PIPELINE ')).map(line => JSON.parse(line.slice('FLASHGPU_PIPELINE '.length)));
    const nativeStageCounts = {};
    for (const entry of nativeObservations) nativeStageCounts[entry.event] = (nativeStageCounts[entry.event] ?? 0) + 1;
    const issuedUids = new Set(nativeObservations.filter(entry => entry.event === 'ISSUE').map(entry => entry.dynamicInstructionId));
    const completedUids = new Set(nativeObservations.filter(entry => entry.event === 'COMPLETE').map(entry => entry.dynamicInstructionId));
    const completeCoverage = [...issuedUids].every(uid => completedUids.has(uid));
    if (!completeCoverage) throw new Error('Observer capture has issued instructions without native completion hooks.');
    manifest.capture.observer = {nativeConfigurations, nativeStageCounts, observedInstructionCount: issuedUids.size, completedInstructionCount: completedUids.size, allIssuedInstructionsCompleted: completeCoverage, nonzeroSpanCount: trace.events.filter(event => event.end > event.start).length, movementSpanCount: trace.events.filter(event => event.end > event.start && event.args.smPipelineTransfer).length};
    manifest.architecture.partitionMapping = {source: 'Captured shader_core_config::sub_core_model + get_schd_id + native FU get_issue_reg_id; never warp modulo', configurations: nativeConfigurations.map(({smId, subCoreModel, schedulerCount, schedulerPartitionMap}) => ({smId, subCoreModel, schedulerCount, schedulerPartitionMap}))};
  }
  if (appliedObserver) {
    run('git', ['apply', '--reverse', appliedObserver.patchPath], {cwd: appliedObserver.source});
    appliedObserver = null;
    if (run('git', ['status', '--porcelain', '--untracked-files=no'], {cwd: source})) throw new Error('Tracked source restoration did not produce the original clean checkout.');
    manifest.backend.trackedSourcesRestoredAfterCapture = true;
  }
  const normalized = `${JSON.stringify(trace, null, 2)}\n`;
  manifest.capture.normalizedTrace = `${basename(output)}.json`;
  manifest.capture.normalizedTraceSha256 = sha256(normalized);
  writeFileSync(`${output}.json`, normalized);
  writeFileSync(`${output}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Captured ${trace.events.length} real instruction observations across ${manifest.capture.observedSmIds.length} SMs / ${manifest.capture.observedWarpCount} warps; ${simulatedCycles} cycles; validation PASSED.\nTrace: ${output}.json\nManifest: ${output}.manifest.json\nTemporary workload: ${runDir}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (appliedObserver) {
    try {
      run('git', ['apply', '--reverse', appliedObserver.patchPath], {cwd: appliedObserver.source});
    } catch (error) {
      console.error(`Could not restore upstream observer patch: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
