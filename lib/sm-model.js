import {validateTrace} from './trace.js';
import {SM_ARCHITECTURE, instantiateSmComponents, smComponentId} from './sm-architecture.js?v=sm-residency-3';

/** All cycle counts below are teaching parameters, never measured Hopper latencies. */
export const DEFAULT_SM_CONFIG = Object.freeze({
  smId: 0, warpCount: 8, partitionCount: 4, rounds: 1,
  warpsPerCta: 4, registersPerThread: 64, residentWarpLimit: 64, residentCtaLimit: 32,
  instructionBufferDepth: 2, scoreboardEntries: 8, tmaInFlightLimit: 4,
  fetchLatencyCycles: SM_ARCHITECTURE.defaultTiming.fetch.latencyCycles,
  decodeLatencyCycles: SM_ARCHITECTURE.defaultTiming.decode.latencyCycles,
  issueIntervalCycles: SM_ARCHITECTURE.defaultTiming.issue.initiationIntervalCycles,
  dispatchLatencyCycles: SM_ARCHITECTURE.defaultTiming.dispatch.latencyCycles,
  registerLatencyCycles: SM_ARCHITECTURE.defaultTiming['register-file'].latencyCycles,
  operandLatencyCycles: SM_ARCHITECTURE.defaultTiming['operand-collector'].latencyCycles,
  fp32LatencyCycles: SM_ARCHITECTURE.defaultTiming.fp32.latencyCycles,
  int32LatencyCycles: SM_ARCHITECTURE.defaultTiming.int32.latencyCycles,
  sfuLatencyCycles: SM_ARCHITECTURE.defaultTiming.sfu.latencyCycles,
  fp64LatencyCycles: SM_ARCHITECTURE.defaultTiming.fp64.latencyCycles,
  tensorLatencyCycles: SM_ARCHITECTURE.defaultTiming.tensor.latencyCycles,
  tensorInitiationIntervalCycles: SM_ARCHITECTURE.defaultTiming.tensor.initiationIntervalCycles,
  lsuLatencyCycles: SM_ARCHITECTURE.defaultTiming.lsu.latencyCycles,
  l1LatencyCycles: SM_ARCHITECTURE.defaultTiming['l1-cache'].latencyCycles,
  globalMemoryLatencyCycles: 120,
  externalBytesPerCycle: 128, l1CapacityLines: 16, l1HitEvery: 2,
  tmaLatencyCycles: SM_ARCHITECTURE.defaultTiming.tma.latencyCycles,
  tmaBytesPerCycle: 64, tmaBytes: 4096,
  sharedLatencyCycles: SM_ARCHITECTURE.defaultTiming['shared-memory'].latencyCycles,
  sharedBytesPerCycle: 128, sharedBankStrideWords: 1
});

const bounds = {
  smId: [0, 131], warpCount: [1, 128], partitionCount: [4, 4], rounds: [1, 4],
  warpsPerCta: [1, 32], registersPerThread: [1, 255], residentWarpLimit: [1, 64], residentCtaLimit: [1, 32],
  instructionBufferDepth: [1, 8], scoreboardEntries: [1, 64], tmaInFlightLimit: [1, 32],
  fetchLatencyCycles: [1, 256], decodeLatencyCycles: [1, 256], issueIntervalCycles: [1, 64],
  dispatchLatencyCycles: [1, 256], registerLatencyCycles: [1, 256], operandLatencyCycles: [1, 256],
  fp32LatencyCycles: [1, 1024], int32LatencyCycles: [1, 1024], sfuLatencyCycles: [1, 1024],
  fp64LatencyCycles: [1, 1024], tensorLatencyCycles: [1, 4096], tensorInitiationIntervalCycles: [1, 4096],
  lsuLatencyCycles: [1, 1024], l1LatencyCycles: [1, 1024], globalMemoryLatencyCycles: [1, 4096],
  externalBytesPerCycle: [1, 65536], l1CapacityLines: [1, 1024], l1HitEvery: [0, 32],
  tmaLatencyCycles: [1, 1024], tmaBytesPerCycle: [1, 65536], tmaBytes: [128, 65536],
  sharedLatencyCycles: [1, 1024], sharedBytesPerCycle: [1, 65536], sharedBankStrideWords: [1, 32]
};

const sharedSpanBytes = config => ((32 - 1) * config.sharedBankStrideWords + 1) * 4;

function residencyConfiguration(config) {
  const facts = SM_ARCHITECTURE.hardwareFacts;
  const sharedSpec = SM_ARCHITECTURE.components.find(c => c.localId === 'shared-memory').resources;
  const sharedBytesPerWarp = config.tmaBytes + sharedSpanBytes(config);
  const carveouts = sharedSpec.supportedCarveoutKiB.map(kib => kib * 1024)
    .filter(bytes => bytes + config.l1CapacityLines * 128 <= facts.unifiedL1SharedBytesPerSm);
  const reservedSharedBytesPerCta = facts.reservedSharedBytesPerCta;
  const totalShared = config.warpCount * sharedBytesPerWarp + Math.ceil(config.warpCount / config.warpsPerCta) * reservedSharedBytesPerCta;
  const desiredShared = Math.min(totalShared, carveouts.at(-1));
  const selectedCarveoutBytes = carveouts.find(bytes => bytes >= desiredShared);
  const registersPerWarp = config.registersPerThread * facts.threadsPerWarp;
  const registersPerPartition = facts.registers32BitPerSm / facts.partitionsPerSm;
  const ctas = [];
  for (let firstWarp = 0; firstWarp < config.warpCount; firstWarp += config.warpsPerCta) {
    const warpIds = Array.from({length: Math.min(config.warpsPerCta, config.warpCount - firstWarp)}, (_, i) => firstWarp + i);
    const partitionRegisters = Array.from({length: 4}, (_, partitionId) => warpIds.filter(id => id % 4 === partitionId).length * registersPerWarp);
    if (warpIds.length > config.residentWarpLimit) throw new RangeError('A whole CTA must fit the resident warp limit.');
    if (partitionRegisters.some(count => count > registersPerPartition)) throw new RangeError('A whole CTA exceeds a partition register-file budget under the teaching warp placement.');
    const userSharedBytes = warpIds.length * sharedBytesPerWarp;
    const sharedBytes = userSharedBytes + reservedSharedBytesPerCta;
    if (userSharedBytes > sharedSpec.perCtaMaxBytes || sharedBytes > selectedCarveoutBytes) {
      throw new RangeError('A whole CTA exceeds the selected shared-memory carveout or per-CTA SMEM budget.');
    }
    ctas.push({ctaId: ctas.length, warpIds, registers: warpIds.length * registersPerWarp,
      partitionRegisters, userSharedBytes, reservedSharedBytes: reservedSharedBytesPerCta, sharedBytes});
  }
  return {ctas, sharedBytesPerWarp, registersPerWarp, registersPerPartition, selectedCarveoutBytes, reservedSharedBytesPerCta,
    limits: {warps: config.residentWarpLimit, ctas: config.residentCtaLimit,
      registers: facts.registers32BitPerSm, registersPerPartition, sharedBytes: selectedCarveoutBytes}};
}

function configuration(overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new TypeError('SM config must be an object.');
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_SM_CONFIG, key)) throw new TypeError(`Unknown SM parameter: ${key}`);
  }
  const config = {...DEFAULT_SM_CONFIG, ...overrides};
  for (const [key, [min, max]] of Object.entries(bounds)) {
    if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) throw new RangeError(`${key} must be an integer in [${min}, ${max}].`);
  }
  if (config.tmaBytes % 128 !== 0) throw new RangeError('Teaching TMA byte count must be a multiple of 128 bytes.');
  if (config.tmaBytes < sharedSpanBytes(config)) throw new RangeError('LDS lane addresses extend beyond the TMA-filled destination buffer.');
  residencyConfiguration(config);
  return config;
}

/** Stable discrete-event clock: no per-cycle polling and no random animation state. */
class Clock {
  jobs = [];
  serial = 0;
  schedule(time, callback) {
    const item = {time, serial: this.serial++, callback};
    let index = this.jobs.length;
    this.jobs.push(item);
    while (index) {
      const parent = (index - 1) >> 1;
      if (!this.before(item, this.jobs[parent])) break;
      this.jobs[index] = this.jobs[parent]; index = parent;
    }
    this.jobs[index] = item;
  }
  before(a, b) { return a.time < b.time || (a.time === b.time && a.serial < b.serial); }
  run() {
    while (this.jobs.length) {
      const next = this.jobs[0], last = this.jobs.pop();
      if (this.jobs.length) {
        let index = 0;
        while (index * 2 + 1 < this.jobs.length) {
          let child = index * 2 + 1;
          if (child + 1 < this.jobs.length && this.before(this.jobs[child + 1], this.jobs[child])) child++;
          if (!this.before(this.jobs[child], last)) break;
          this.jobs[index] = this.jobs[child]; index = child;
        }
        this.jobs[index] = last;
      }
      next.callback(next.time);
    }
  }
}

function hash(value) {
  let n = 2166136261;
  for (let i = 0; i < value.length; i++) n = Math.imul(n ^ value.charCodeAt(i), 16777619) >>> 0;
  return n.toString(16);
}
const gcd = (a, b) => b ? gcd(b, a % b) : a;

/** A deliberately small synthetic warp program, not SASS or numerical execution. */
function program(warpId, config) {
  const result = [];
  for (let round = 0; round < config.rounds; round++) {
    const r = name => `${name}.${round}`;
    const add = (opcode, unit, srcRegisters, dstRegisters, extra = {}) => {
      const instruction = {id: `w${warpId}:i${result.length}`, index: result.length, round,
        opcode, unit, srcRegisters, dstRegisters, ...extra};
      result.push(instruction); return instruction;
    };
    const bufferKey = `warp${warpId}:tma-buffer${round}`, scratchKey = `warp${warpId}:scratch${round}`;
    const addresses = bufferId => ({bufferId, offsetBytes: 0, laneCount: 32, laneWidthBytes: 4,
      strideWords: config.sharedBankStrideWords,
      laneOffsetsBytes: Array.from({length: 32}, (_, lane) => lane * config.sharedBankStrideWords * 4),
      spanBytes: sharedSpanBytes(config)});
    const tma = add('TMA.LOAD', 'tma', [], [], {barrierId: `w${warpId}:barrier${round}`,
      dataKey: bufferKey, bytes: config.tmaBytes,
      descriptor: {kind: 'symbolic-contiguous-copy', sourceDataKey: `warp${warpId}:tma-global${round}`,
        destinationDataKey: bufferKey, destinationOffsetBytes: 0, bytes: config.tmaBytes}});
    add('IADD3', 'int32', ['r0'], [r('r1')]);
    add('FADD', 'fp32', [r('r1')], [r('r2')]);
    add('MUFU.RCP', 'sfu', [r('r2')], [r('r3')]);
    add('DADD', 'fp64', [r('r3')], [r('d1')]);
    add('LDG', 'lsu', [r('r1')], [r('r4')], {memory: 'global-read', dataKey: `warp${warpId}:line${round}`, bytes: 128});
    add('LDG', 'lsu', [r('r4')], [r('r6')], {memory: 'global-read', dataKey: `warp${warpId}:line${round}`, bytes: 128});
    const store = add('STS', 'lsu', [r('r6')], [], {memory: 'shared-write', dataKey: scratchKey,
      sharedAccess: addresses(scratchKey), bytes: 128});
    const barrier = add('MBAR.WAIT', 'mbarrier', [], [], {barrierId: tma.barrierId});
    add('LDS', 'lsu', [r('r6')], [r('r5')], {memory: 'shared-read', dataKey: tma.dataKey,
      sharedAccess: addresses(bufferKey), barrierId: tma.barrierId, bytes: 128, waitFor: [barrier.id, store.id]});
    // Warp mma.sync consumes register fragments. Only the prior LDS reads SMEM;
    // its writeback makes the symbolic A fragment available to the RF path.
    add('MMA.SYNC', 'tensor', [r('r5'), r('r6'), 'r0'], [r('acc')], {
      fragmentRegisters: {a: r('r5'), b: r('r6'), c: 'r0'}, operandAddressSpace: 'register'});
    add('FFMA', 'fp32', [r('acc'), r('d1')], [r('out')]);
    add('STG', 'lsu', [r('out')], [], {memory: 'global-write', dataKey: `warp${warpId}:out${round}`, bytes: 128});
    add('BRA', 'branch', [r('out')], []);
  }
  return result;
}

/**
 * Simulates ONE selected SM against an abstract external-memory service.
 * Other 131 H100 SMs are hardware context, not silently simulated here.
 * Every animation span is a deterministic model event in its own time domain.
 */
export function simulateSm(overrides = {}) {
  const config = configuration(overrides), clock = new Clock();
  const admission = residencyConfiguration(config);
  const scenarioId = `gpu-city-sm-v3-${hash(JSON.stringify(config))}`;
  const latencyOverrides = {
    fetch: config.fetchLatencyCycles, decode: config.decodeLatencyCycles, dispatch: config.dispatchLatencyCycles,
    'register-file': config.registerLatencyCycles, 'operand-collector': config.operandLatencyCycles,
    fp32: config.fp32LatencyCycles, int32: config.int32LatencyCycles, sfu: config.sfuLatencyCycles,
    fp64: config.fp64LatencyCycles, tensor: config.tensorLatencyCycles, lsu: config.lsuLatencyCycles,
    'l1-cache': config.l1LatencyCycles, tma: config.tmaLatencyCycles,
    'shared-memory': config.sharedLatencyCycles + Math.ceil(128 / config.sharedBytesPerCycle) * gcd(config.sharedBankStrideWords, 32),
    'noc-interface': config.globalMemoryLatencyCycles + Math.ceil(128 / config.externalBytesPerCycle)
  };
  const iiOverrides = {issue: config.issueIntervalCycles, tensor: config.tensorInitiationIntervalCycles,
    'register-file': config.registerLatencyCycles,
    'shared-memory': Math.ceil(128 / config.sharedBytesPerCycle) * gcd(config.sharedBankStrideWords, 32),
    'noc-interface': Math.ceil(128 / config.externalBytesPerCycle)};
  const effectiveTiming = Object.fromEntries(Object.entries(SM_ARCHITECTURE.defaultTiming).map(([localId, value]) => [localId, {
    ...value, ...(latencyOverrides[localId] != null ? {latencyCycles: latencyOverrides[localId]} : {}),
    ...(iiOverrides[localId] != null ? {initiationIntervalCycles: iiOverrides[localId]} : {}),
    queueCapacity: null, queueImplementation: 'upstream-finite-credits; no local finite queue/backpressure',
    ...(localId === 'shared-memory' ? {durationRule: 'sharedLatency + ceil(bytes/sharedBytesPerCycle)*conflictDegree; TMA writes use degree=1'} : {}),
    ...(localId === 'register-file' ? {durationRule: 'registerLatency * max(1, symbolic source-register count)'} : {}),
    ...(localId === 'tma' ? {durationRule: 'submit=tmaLatency; transfer=ceil(bytes/tmaBytesPerCycle); async credit released after SMEM commit/barrier'} : {}),
    ...(localId === 'noc-interface' ? {durationRule: 'globalMemoryLatency + ceil(bytes/externalBytesPerCycle); II=ceil(bytes/externalBytesPerCycle)'} : {})
  }]));
  const pipelineArchitecture = {...SM_ARCHITECTURE, defaultTiming: effectiveTiming,
    components: SM_ARCHITECTURE.components.map(c => ({...c, timing: effectiveTiming[c.localId],
      simulationCoverage: ['icache', 'l0-icache', 'branch'].includes(c.localId) ? 'timing-only' : c.simulationCoverage})),
    implementation: {finiteLocalQueues: false, finiteInflightCapacity: true, finiteInstructionBuffers: true,
      finiteScoreboard: true, numericExecution: false, registerValues: 'symbolic',
      instructionCacheTags: false, branchDivergence: false, memoryMissMerging: false,
      ctaResourceAdmission: true, warpReadinessHistory: true}};
  let allocatedSharedBytes = 0;
  const selectedSharedCarveoutBytes = admission.selectedCarveoutBytes;
  const components = [
    {id: 'gpu', kind: 'gpu', label: 'H100 SXM · 132 SM 架构上下文'},
    {id: `sm-${config.smId}`, kind: 'sm', label: `SM ${config.smId} · 独立流水线教学运行`, parentId: 'gpu', smId: config.smId},
    ...instantiateSmComponents(config.smId).map(c => ({...c, timing: effectiveTiming[c.args.localComponentId],
      resources: {...c.resources,
        ...(c.args.localComponentId === 'shared-memory' ? {allocatedBytes: allocatedSharedBytes, selectedCarveoutBytes: selectedSharedCarveoutBytes} : {}),
        ...(c.args.localComponentId === 'l1-cache' ? {logicalLineBytes: 128, logicalCapacityLines: config.l1CapacityLines,
          logicalCapacityBytes: config.l1CapacityLines * 128, effectiveDataCacheBudgetBytes: 262144 - selectedSharedCarveoutBytes} : {}),
        ...(c.args.localComponentId === 'scoreboard' ? {entryCapacity: config.scoreboardEntries} : {})},
      simulationCoverage: pipelineArchitecture.components.find(t => t.localId === c.args.localComponentId)?.simulationCoverage}))
  ];
  const componentIds = new Set(components.map(c => c.id));
  const resources = new Map(), events = [], instructions = [], instructionById = new Map(), barrierStates = [];
  const sharedBuffers = new Map();
  for (let warpId = 0; warpId < config.warpCount; warpId++) for (let round = 0; round < config.rounds; round++) {
    for (const [role, suffix, offset, sizeBytes] of [
      ['tma-destination', 'tma-buffer', 0, config.tmaBytes],
      ['scratch', 'scratch', config.tmaBytes, sharedSpanBytes(config)]
    ]) {
      const id = `warp${warpId}:${suffix}${round}`;
      sharedBuffers.set(id, {id, warpId, ctaId: Math.floor(warpId / config.warpsPerCta), round, role, baseOffsetBytes: offset, sizeBytes,
        allocationId: `warp${warpId}:${role}`, initializedRanges: [], writes: [], reads: []});
    }
  }
  const stats = {
    instructions: 0, completedInstructions: 0, makespan: 0,
    rawStallCycles: 0, resourceStallCycles: 0, barrierStallCycles: 0,
    issueStallCycles: 0, scoreboardStallCycles: 0, queueWaitCycles: 0,
    maxScoreboardOccupancy: 0, maxInstructionBufferOccupancy: 0, maxTmaInFlight: 0,
    maxResidentWarps: 0, maxResidentCtas: 0, maxAllocatedRegisters: 0, ctaAdmissionWaitCycles: 0,
    l1Hits: 0, l1Misses: 0, l1Evictions: 0, globalReadBytes: 0, globalWriteBytes: 0,
    tmaBytes: 0, sharedBankConflicts: 0, sharedBankConflictExtraCycles: 0,
    sharedReadBytes: 0, sharedWriteBytes: 0
  };
  let eventSerial = 0, tmaInFlight = 0;
  const cache = new Map();
  const warps = Array.from({length: config.warpCount}, (_, warpId) => ({
    warpId, ctaId: Math.floor(warpId / config.warpsPerCta), partitionId: warpId % 4, program: program(warpId, config),
    nextFetch: 0, nextIssue: 0, buffer: new Map(), bufferCredits: 0,
    pendingRegisters: new Map(), barriers: new Map(), lastIssue: null,
    admitted: null, retired: null, completed: 0, history: []
  }));
  const ctas = admission.ctas.map(cta => ({...cta, admitted: null, retired: null, admissionWaitReasons: [], sharedOffsetBytes: null}));
  const residency = {warps: 0, ctas: 0, registers: 0, sharedBytes: 0, partitionRegisters: [0, 0, 0, 0]};
  const residencyHistory = [];
  const freeSharedRanges = [{offsetBytes: 0, sizeBytes: selectedSharedCarveoutBytes}];
  const partitions = Array.from({length: 4}, (_, partitionId) => ({
    partitionId, warps: warps.filter(w => w.partitionId === partitionId),
    cursor: 0, nextSelection: 0, occupancy: 0, pendingPumps: new Set(),
    scoreboardHistory: [{time: 0, occupancy: 0}]
  }));
  for (const warp of warps) for (const inst of warp.program) {
    inst.warp = warp; inst.partitionId = warp.partitionId; inst.eventIds = [];
    inst.start = null; inst.issue = null; inst.end = null; inst.done = false; inst.stall = null;
    inst.bytes = inst.unit === 'tma' ? config.tmaBytes : inst.bytes;
    instructions.push(inst); instructionById.set(inst.id, inst);
  }
  stats.instructions = instructions.length;
  // Explicitly prewarmed lines: this is workload setup, not a guessed L1 hit rate.
  for (const warp of warps) {
    if (config.l1HitEvery && warp.warpId % config.l1HitEvery === 0) {
      for (let round = 0; round < config.rounds; round++) {
        const key = `warp${warp.warpId}:line${round}`;
        if (cache.size === config.l1CapacityLines) cache.delete(cache.keys().next().value);
        cache.set(key, null);
      }
    }
  }

  // Readiness is recorded from model state, never inferred from animation tokens.
  // Counts overlap: eligible ⊆ ready ⊆ resident; inflight/issuing are separate spans.
  function refreshWarp(warp, time) {
    let state = 'queued', ready = false, eligible = false, waitReason = null;
    const inst = warp.buffer.get(warp.nextIssue), partition = partitions[warp.partitionId];
    if (warp.retired != null) state = 'retired';
    else if (warp.admitted != null) {
      if (warp.nextIssue === warp.program.length) state = 'draining';
      else if (!inst) { state = 'fetching'; waitReason = 'instruction-fetch'; }
      else {
        const blocked = blocker(inst, partition);
        ready = !blocked || ['tma-capacity', 'scoreboard-full'].includes(blocked.reason);
        eligible = ready && !blocked && time >= partition.nextSelection;
        waitReason = blocked?.reason ?? (time < partition.nextSelection ? 'issue-bandwidth' : null);
        state = ready ? (eligible ? 'eligible' : 'ready') : 'waiting';
      }
    }
    const value = {time, state, ready, eligible, waitReason, instructionId: inst?.id ?? null};
    const previous = warp.history.at(-1);
    if (previous && ['state', 'ready', 'eligible', 'waitReason', 'instructionId'].every(key => previous[key] === value[key])) return;
    if (previous?.time === time) warp.history[warp.history.length - 1] = value;
    else warp.history.push(value);
  }
  function refreshPartition(partition, time) {
    for (const warp of partition.warps) refreshWarp(warp, time);
  }
  function recordResidency(time, cta, action) {
    residencyHistory.push({time, ctaId: cta.ctaId, action, ...residency, partitionRegisters: [...residency.partitionRegisters]});
    stats.maxResidentWarps = Math.max(stats.maxResidentWarps, residency.warps);
    stats.maxResidentCtas = Math.max(stats.maxResidentCtas, residency.ctas);
    stats.maxAllocatedRegisters = Math.max(stats.maxAllocatedRegisters, residency.registers);
    allocatedSharedBytes = Math.max(allocatedSharedBytes, residency.sharedBytes);
  }
  function admissionBlockers(cta) {
    const reasons = [];
    if (residency.ctas + 1 > admission.limits.ctas) reasons.push('cta-slots');
    if (residency.warps + cta.warpIds.length > admission.limits.warps) reasons.push('warp-slots');
    if (cta.partitionRegisters.some((count, p) => count + residency.partitionRegisters[p] > admission.limits.registersPerPartition)) reasons.push('register-capacity');
    if (residency.sharedBytes + cta.sharedBytes > admission.limits.sharedBytes || !freeSharedRanges.some(range => range.sizeBytes >= cta.sharedBytes)) reasons.push('shared-memory-capacity');
    return reasons;
  }
  function admitCtas(time) {
    for (const cta of ctas) {
      if (cta.admitted != null) continue;
      const blocked = admissionBlockers(cta);
      if (blocked.length) {
        cta.admissionWaitReasons = [...new Set([...cta.admissionWaitReasons, ...blocked])];
        break; // Deterministic FIFO teaching policy: never split a CTA or bypass it.
      }
      cta.admitted = time; stats.ctaAdmissionWaitCycles += time;
      residency.ctas++; residency.warps += cta.warpIds.length;
      residency.registers += cta.registers; residency.sharedBytes += cta.sharedBytes;
      cta.partitionRegisters.forEach((count, p) => { residency.partitionRegisters[p] += count; });
      const rangeIndex = freeSharedRanges.findIndex(range => range.sizeBytes >= cta.sharedBytes), range = freeSharedRanges[rangeIndex];
      cta.sharedOffsetBytes = range.offsetBytes;
      range.offsetBytes += cta.sharedBytes; range.sizeBytes -= cta.sharedBytes;
      if (!range.sizeBytes) freeSharedRanges.splice(rangeIndex, 1);
      for (const [localWarpId, warpId] of cta.warpIds.entries()) {
        const warp = warps[warpId]; warp.admitted = time;
        for (const buffer of sharedBuffers.values()) if (buffer.warpId === warpId) {
          buffer.baseOffsetBytes += cta.sharedOffsetBytes + localWarpId * admission.sharedBytesPerWarp;
          buffer.ctaAllocationOffsetBytes = cta.sharedOffsetBytes;
        }
        frontend(warp, time); refreshWarp(warp, time);
      }
      recordResidency(time, cta, 'admit');
    }
  }
  function retireCta(cta, time) {
    if (cta.retired != null || !cta.warpIds.every(id => warps[id].completed === warps[id].program.length &&
      warps[id].program.every(inst => inst.unit !== 'tma' || inst.asyncEnd != null))) return;
    cta.retired = time;
    residency.ctas--; residency.warps -= cta.warpIds.length;
    residency.registers -= cta.registers; residency.sharedBytes -= cta.sharedBytes;
    cta.partitionRegisters.forEach((count, p) => { residency.partitionRegisters[p] -= count; });
    freeSharedRanges.push({offsetBytes: cta.sharedOffsetBytes, sizeBytes: cta.sharedBytes});
    freeSharedRanges.sort((a, b) => a.offsetBytes - b.offsetBytes);
    for (let index = 1; index < freeSharedRanges.length;) {
      const previous = freeSharedRanges[index - 1], current = freeSharedRanges[index];
      if (previous.offsetBytes + previous.sizeBytes === current.offsetBytes) {
        previous.sizeBytes += current.sizeBytes; freeSharedRanges.splice(index, 1);
      } else index++;
    }
    for (const warpId of cta.warpIds) { warps[warpId].retired = time; refreshWarp(warps[warpId], time); }
    recordResidency(time, cta, 'retire');
    admitCtas(time);
  }

  function component(localId, inst) {
    const id = smComponentId(config.smId, localId, inst?.partitionId ?? 0);
    if (!componentIds.has(id)) throw new Error(`SM specification has no component ${id}.`);
    return id;
  }
  function emit(inst, localId, stage, start, end, dependencies = [], extra = {}, name) {
    const componentId = component(localId, inst);
    const e = {id: `sm:${eventSerial++}`, name: name ?? `${inst.opcode} · ${stage}`,
      category: stage === 'stall' ? 'queue' : stage === 'transfer' ? 'transfer' : 'pipeline',
      componentId, start, end, dependencies: [...new Set(dependencies.filter(Boolean))],
      args: {smId: config.smId, threadBlockId: inst.warp.ctaId, warpId: inst.warp.warpId,
        partitionId: inst.partitionId, instructionId: inst.id, opcode: inst.opcode,
        stage, localComponentId: localId, architectureComponentId: componentId,
        srcRegisters: [...inst.srcRegisters], dstRegisters: [...inst.dstRegisters],
        ...(inst.dataKey ? {dataKey: inst.dataKey} : {}), ...(inst.barrierId ? {barrierId: inst.barrierId} : {}), ...extra}};
    events.push(e); inst.eventIds.push(e.id); return e;
  }
  function timing(localId) {
    return effectiveTiming[localId] ?? {latencyCycles: 1, initiationIntervalCycles: 1, capacity: 1};
  }
  function service(inst, localId, stage, ready, dependencies, onComplete, options = {}) {
    const id = component(localId, inst), base = timing(localId);
    const latency = options.latency ?? base.latencyCycles ?? 1;
    const ii = options.ii ?? base.initiationIntervalCycles ?? 1;
    if (!resources.has(id)) resources.set(id, {nextAccept: 0, last: null, spans: []});
    const resource = resources.get(id);
    let start = Math.max(ready, resource.nextAccept);
    const capacity = base.capacity ?? 1;
    let active = resource.spans.filter(e => e.start <= start && e.end > start);
    const capacityReleases = [];
    while (active.length >= capacity) {
      const released = active.reduce((a, b) => a.end <= b.end ? a : b);
      start = released.end; capacityReleases.push(released.id);
      active = resource.spans.filter(e => e.start <= start && e.end > start);
    }
    const end = start + latency;
    let deps = [...dependencies];
    if (start > ready) {
      const wait = emit(inst, localId, 'stall', ready, start, deps,
        {stallReason: 'resource-busy', waitingForStage: stage, ...options.args}, `${inst.opcode} · 等待 ${localId}`);
      stats.queueWaitCycles += start - ready; stats.resourceStallCycles += start - ready;
      deps = [wait.id];
    }
    const previous = resource.last;
    const issueDependencies = [];
    if (previous) {
      if (previous.end <= start) deps.push(previous.id);
      else issueDependencies.push(previous.id);
    }
    deps.push(...capacityReleases);
    const e = emit(inst, localId, stage, start, end, deps, {
      latencyCycles: latency, initiationIntervalCycles: ii,
      inflightCapacity: capacity,
      issueReleaseCycle: Math.min(end, start + ii),
      ...(issueDependencies.length ? {issueDependencies} : {}), ...options.args
    }, options.name);
    resource.nextAccept = start + ii; resource.last = e; resource.spans.push(e);
    if (onComplete) clock.schedule(end, time => onComplete(time, e));
    return e;
  }
  function transfer(inst, source, target, ready, dependency, kind, onComplete, extra = {}) {
    const duration = extra.duration ?? 1;
    const {duration: unused, ...details} = extra;
    const e = emit(inst, source, 'transfer', ready, ready + duration, [dependency], {
      smPipelineTransfer: {sourceId: component(source, inst), targetId: component(target, inst), kind,
        ...(details.bytes != null ? {bytes: details.bytes} : {})}, ...details
    }, `${source} → ${target}`);
    if (onComplete) clock.schedule(e.end, time => onComplete(time, e));
    return e;
  }

  function frontend(warp, time) {
    while (warp.bufferCredits < config.instructionBufferDepth && warp.nextFetch < warp.program.length) {
      const inst = warp.program[warp.nextFetch++];
      warp.bufferCredits++;
      stats.maxInstructionBufferOccupancy = Math.max(stats.maxInstructionBufferOccupancy, warp.bufferCredits);
      inst.start = time;
      service(inst, 'icache', 'instruction-cache', time, [], (end, icache) => {
        transfer(inst, 'icache', 'l0-icache', end, icache.id, 'instruction', (arrival, moved) => {
          service(inst, 'l0-icache', 'instruction-cache', arrival, [moved.id], (l0End, l0) => {
            transfer(inst, 'l0-icache', 'fetch', l0End, l0.id, 'instruction', (fetchReady, arrived) => {
              service(inst, 'fetch', 'fetch', fetchReady, [arrived.id], (fetchEnd, fetched) => {
                transfer(inst, 'fetch', 'decode', fetchEnd, fetched.id, 'instruction', (decodeReady, delivered) => {
                  service(inst, 'decode', 'decode', decodeReady, [delivered.id], (decodeEnd, decoded) => {
                    inst.decoded = decoded; warp.buffer.set(inst.index, inst);
                    refreshPartition(partitions[warp.partitionId], decodeEnd);
                    wake(partitions[warp.partitionId], decodeEnd);
                  }, {latency: config.decodeLatencyCycles});
                });
              }, {latency: config.fetchLatencyCycles});
            });
          });
        });
      });
    }
  }

  function blocker(inst, partition) {
    const warp = inst.warp;
    const raw = inst.srcRegisters.filter(r => warp.pendingRegisters.has(r));
    if (raw.length) return {reason: 'RAW', registers: raw};
    const waw = inst.dstRegisters.filter(r => warp.pendingRegisters.has(r));
    if (waw.length) return {reason: 'WAW', registers: waw};
    if ((inst.waitFor ?? []).some(id => !instructionById.get(id).done)) return {reason: 'memory-order'};
    if ((inst.opcode === 'MBAR.WAIT' || (inst.memory === 'shared-read' && inst.barrierId)) && !warp.barriers.has(inst.barrierId)) return {reason: 'mbarrier'};
    if (inst.unit === 'tma' && tmaInFlight >= config.tmaInFlightLimit) return {reason: 'tma-capacity'};
    if (partition.occupancy >= config.scoreboardEntries) return {reason: 'scoreboard-full'};
    return null;
  }
  function closeStall(inst, time) {
    if (!inst.stall) return null;
    const {start, reason, registers} = inst.stall;
    inst.stall = null;
    if (time <= start) return null;
    const localId = ['RAW', 'WAW', 'scoreboard-full'].includes(reason) ? 'scoreboard' : reason === 'mbarrier' ? 'mbarrier' : 'warp-scheduler';
    const e = emit(inst, localId, 'stall', start, time, [inst.decoded.id],
      {stallReason: reason, ...(registers ? {stalledRegisters: registers} : {})}, `${inst.opcode} · ${reason}`);
    if (reason === 'RAW') stats.rawStallCycles += time - start;
    else if (reason === 'mbarrier') stats.barrierStallCycles += time - start;
    else if (reason === 'issue-slot') stats.issueStallCycles += time - start;
    else if (reason === 'scoreboard-full') stats.scoreboardStallCycles += time - start;
    return e;
  }
  function markStall(inst, time, blocked) {
    if (inst.stall?.reason === blocked.reason) return;
    closeStall(inst, time);
    inst.stall = {start: time, reason: blocked.reason, registers: blocked.registers};
  }
  function wake(partition, ready) {
    const time = Math.max(ready, partition.nextSelection);
    if (partition.pendingPumps.has(time)) return;
    partition.pendingPumps.add(time);
    clock.schedule(time, t => { partition.pendingPumps.delete(t); pump(partition, t); });
  }
  function pump(partition, time) {
    if (time < partition.nextSelection) { wake(partition, partition.nextSelection); return; }
    refreshPartition(partition, time);
    const count = partition.warps.length;
    let chosen = null, chosenIndex = 0;
    for (let offset = 0; offset < count; offset++) {
      const index = (partition.cursor + offset) % count;
      const warp = partition.warps[index], inst = warp.buffer.get(warp.nextIssue);
      if (warp.admitted == null || warp.retired != null || !inst) continue;
      const blocked = blocker(inst, partition);
      if (blocked) markStall(inst, time, blocked);
      else if (!chosen) { chosen = inst; chosenIndex = index; }
      else markStall(inst, time, {reason: 'issue-slot'});
    }
    if (!chosen) return;
    partition.cursor = count ? (chosenIndex + 1) % count : 0;
    const warp = chosen.warp, stalled = closeStall(chosen, time);
    const deps = [chosen.decoded.id, stalled?.id, warp.lastIssue?.id];
    for (const register of chosen.srcRegisters) {
      const producer = [...warp.program].reverse().find(other => other.index < chosen.index && other.done && other.dstRegisters.includes(register));
      if (producer?.writeback) deps.push(producer.writeback.id);
    }
    for (const id of chosen.waitFor ?? []) deps.push(instructionById.get(id).writeback.id);
    if ((chosen.opcode === 'MBAR.WAIT' || chosen.memory === 'shared-read') && chosen.barrierId) deps.push(warp.barriers.get(chosen.barrierId).id);
    // Reservation is finite and precedes dispatch; releases happen at writeback.
    partition.occupancy++;
    partition.scoreboardHistory.push({time, occupancy: partition.occupancy});
    stats.maxScoreboardOccupancy = Math.max(stats.maxScoreboardOccupancy, partition.occupancy);
    for (const register of chosen.dstRegisters) warp.pendingRegisters.set(register, chosen);
    if (chosen.unit === 'tma') {
      tmaInFlight++; stats.maxTmaInFlight = Math.max(stats.maxTmaInFlight, tmaInFlight);
      for (const other of partitions) refreshPartition(other, time);
    }
    warp.buffer.delete(chosen.index); warp.nextIssue++; warp.bufferCredits--;
    chosen.selected = time;
    const checked = service(chosen, 'scoreboard', 'scoreboard', time, deps, null, {latency: 1, ii: 1});
    const scheduled = service(chosen, 'warp-scheduler', 'schedule', checked.end, [checked.id], null, {latency: 1, ii: 1});
    const issued = service(chosen, 'issue', 'issue', scheduled.end, [scheduled.id], (end, e) => {
      transfer(chosen, 'issue', 'dispatch', end, e.id, 'instruction', (ready, delivered) => {
        service(chosen, 'dispatch', 'dispatch', ready, [delivered.id], (dispatchEnd, dispatched) => {
          if (chosen.unit === 'tma' || chosen.unit === 'mbarrier') {
            transfer(chosen, 'dispatch', chosen.unit, dispatchEnd, dispatched.id,
              chosen.unit === 'tma' ? 'instruction' : 'control', (executeReady, command) => execute(chosen, executeReady, command));
            return;
          }
          transfer(chosen, 'dispatch', 'register-file', dispatchEnd, dispatched.id, 'control', (rfReady, request) => {
            service(chosen, 'register-file', 'register-read', rfReady, [request.id], (rfEnd, registers) => {
              transfer(chosen, 'register-file', 'operand-collector', rfEnd, registers.id, 'operand', (operandReady, operands) => {
                service(chosen, 'operand-collector', 'operand-collect', operandReady, [operands.id], (operandEnd, collected) => {
                  transfer(chosen, 'operand-collector', chosen.unit, operandEnd, collected.id, 'operand', (executeReady, inputs) => execute(chosen, executeReady, inputs));
                }, {latency: config.operandLatencyCycles});
              });
            }, {latency: config.registerLatencyCycles * Math.max(1, chosen.srcRegisters.length), ii: config.registerLatencyCycles,
              args: {registerReadWords: chosen.srcRegisters.length * 32}});
          });
        }, {latency: config.dispatchLatencyCycles});
      });
    }, {latency: 1, ii: config.issueIntervalCycles});
    chosen.issue = issued.start; chosen.issueEvent = issued; warp.lastIssue = issued;
    partition.nextSelection = issued.start + config.issueIntervalCycles;
    frontend(warp, time);
    refreshPartition(partition, time);
    wake(partition, partition.nextSelection);
  }

  function complete(inst, end, committed) {
    inst.end = end; inst.done = true; inst.writeback = committed;
    stats.completedInstructions++;
    const warp = inst.warp, partition = partitions[inst.partitionId];
    warp.completed++;
    for (const register of inst.dstRegisters) {
      if (warp.pendingRegisters.get(register) !== inst) throw new Error('SM scoreboard producer invariant failed.');
      warp.pendingRegisters.delete(register);
    }
    partition.occupancy--;
    if (partition.occupancy < 0) throw new Error('SM scoreboard credit invariant failed.');
    partition.scoreboardHistory.push({time: end, occupancy: partition.occupancy});
    refreshPartition(partition, end);
    retireCta(ctas[warp.ctaId], end);
    wake(partition, end);
  }
  function writeback(inst, time, producer) {
    transfer(inst, inst.unit, 'writeback', time, producer.id, inst.dstRegisters.length ? 'operand' : 'completion', (ready, result) => {
      service(inst, 'writeback', 'writeback', ready, [result.id], (end, committed) => {
        if (inst.dstRegisters.length) {
          transfer(inst, 'writeback', 'register-file', end, committed.id, 'operand', (arrived, written) => complete(inst, arrived, written),
            {registerWriteWords: inst.dstRegisters.length * 32});
        } else complete(inst, end, committed);
      }, {latency: 1, ii: 1, args: {writesRegisters: inst.dstRegisters.length > 0}});
    });
  }
  function external(inst, ready, producer, origin, bytes, direction, onComplete) {
    transfer(inst, origin, 'noc-interface', ready, producer.id, 'memory', (arrival, request) => {
      service(inst, 'noc-interface', 'external-memory', arrival, [request.id], (end, response) => {
        transfer(inst, 'noc-interface', origin, end, response.id, 'memory', (returned, data) => onComplete(returned, data), {bytes});
      }, {latency: config.globalMemoryLatencyCycles + Math.ceil(bytes / config.externalBytesPerCycle),
        ii: Math.ceil(bytes / config.externalBytesPerCycle),
        args: {bytes, direction, dataKey: inst.descriptor?.sourceDataKey ?? inst.dataKey ?? inst.barrierId,
          ...(inst.descriptor ? {destinationDataKey: inst.descriptor.destinationDataKey} : {}), externalBoundary: true},
        name: `${inst.opcode} · 外部 L2/HBM 抽象服务（未展开）`});
    }, {bytes: 16});
  }
  function sharedBuffer(inst) {
    const buffer = sharedBuffers.get(inst.dataKey);
    if (!buffer) throw new Error(`No allocated symbolic shared buffer for ${inst.id}/${inst.dataKey}.`);
    return buffer;
  }
  function checkSharedRange(buffer, start, bytes) {
    if (!Number.isSafeInteger(start) || start < 0 || start + bytes > buffer.sizeBytes) {
      throw new Error(`Shared-memory access exceeds symbolic buffer ${buffer.id}.`);
    }
  }
  function commitSharedRange(buffer, inst, event, offsetBytes, bytes) {
    checkSharedRange(buffer, offsetBytes, bytes);
    const range = {offsetBytes, endOffsetBytes: offsetBytes + bytes, readyCycle: event.end,
      writerEventId: event.id, writerInstructionId: inst.id};
    buffer.initializedRanges.push(range);
    buffer.writes.push({...range});
  }
  function touchCache(key, eventId) {
    if (cache.has(key)) cache.delete(key);
    else if (cache.size >= config.l1CapacityLines) { cache.delete(cache.keys().next().value); stats.l1Evictions++; }
    cache.set(key, eventId);
  }
  function globalMemory(inst, ready, address) {
    transfer(inst, 'lsu', 'l1-cache', ready, address.id, 'memory', (arrival, request) => {
      service(inst, 'l1-cache', 'cache-lookup', arrival, [request.id], (end, lookup) => {
        if (inst.memory === 'global-write') {
          lookup.args.memoryOutcome = 'write-through'; stats.globalWriteBytes += inst.bytes;
          external(inst, end, lookup, 'l1-cache', inst.bytes, 'write', (done, committed) => {
            transfer(inst, 'l1-cache', 'lsu', done, committed.id, 'memory', (ack, acknowledged) => writeback(inst, ack, acknowledged), {bytes: 16, memoryOperation: 'write-ack'});
          });
        } else if (cache.has(inst.dataKey)) {
          lookup.args.memoryOutcome = 'hit'; stats.l1Hits++; touchCache(inst.dataKey, lookup.id);
          transfer(inst, 'l1-cache', 'lsu', end, lookup.id, 'memory', (returned, data) => writeback(inst, returned, data), {bytes: inst.bytes});
        } else {
          lookup.args.memoryOutcome = 'miss'; stats.l1Misses++; stats.globalReadBytes += inst.bytes;
          external(inst, end, lookup, 'l1-cache', inst.bytes, 'read', (returned, data) => {
            service(inst, 'l1-cache', 'cache-fill', returned, [data.id], (filled, fill) => {
              touchCache(inst.dataKey, fill.id);
              transfer(inst, 'l1-cache', 'lsu', filled, fill.id, 'memory', (delivered, values) => writeback(inst, delivered, values), {bytes: inst.bytes});
            }, {latency: 1, ii: 1, args: {dataKey: inst.dataKey, bytes: inst.bytes}});
          });
        }
      }, {latency: config.l1LatencyCycles, ii: 1, args: {dataKey: inst.dataKey, bytes: inst.bytes}});
    }, {bytes: 16});
  }
  function sharedMemory(inst, ready, producer, target, onComplete) {
    const buffer = sharedBuffer(inst), access = inst.sharedAccess;
    if (access?.bufferId !== buffer.id) throw new Error('Shared data key and symbolic access buffer disagree.');
    for (const offset of access.laneOffsetsBytes) checkSharedRange(buffer, offset, access.laneWidthBytes);
    const laneAddressesBytes = access.laneOffsetsBytes.map(offset => buffer.baseOffsetBytes + offset);
    const banks = Array.from({length: 32}, () => new Set());
    for (const address of laneAddressesBytes) banks[Math.floor(address / 4) % 32].add(address);
    const degree = Math.max(...banks.map(addresses => addresses.size));
    const transferCycles = Math.ceil(inst.bytes / config.sharedBytesPerCycle);
    const extraCycles = transferCycles * (degree - 1);
    stats.sharedBankConflicts += degree - 1; stats.sharedBankConflictExtraCycles += extraCycles;
    if (inst.memory === 'shared-write') stats.sharedWriteBytes += inst.bytes;
    else stats.sharedReadBytes += inst.bytes;
    transfer(inst, target, 'shared-memory', ready, producer.id, 'memory', (arrival, request) => {
      const deps = [request.id];
      if (inst.memory === 'shared-read') {
        for (const offset of access.laneOffsetsBytes) {
          const initialized = buffer.initializedRanges.find(range => range.offsetBytes <= offset &&
            range.endOffsetBytes >= offset + access.laneWidthBytes && range.readyCycle <= arrival);
          if (!initialized) throw new Error(`LDS ${inst.id} reads bytes not yet written by its TMA producer.`);
          deps.push(initialized.writerEventId);
        }
      }
      service(inst, 'shared-memory', 'shared-access', arrival, deps, (end, accessed) => {
        if (inst.memory === 'shared-write') for (const offset of access.laneOffsetsBytes) {
          commitSharedRange(buffer, inst, accessed, offset, access.laneWidthBytes);
        }
        if (inst.memory === 'shared-read') buffer.reads.push({instructionId: inst.id, eventId: accessed.id,
          start: accessed.start, end: accessed.end, laneOffsetsBytes: [...access.laneOffsetsBytes], laneWidthBytes: access.laneWidthBytes});
        transfer(inst, 'shared-memory', target, end, accessed.id, 'memory', onComplete, {bytes: inst.bytes});
      }, {latency: config.sharedLatencyCycles + transferCycles * degree,
        ii: transferCycles * degree, args: {bytes: inst.bytes, memoryOperation: inst.memory,
          sharedAccess: {...access, baseOffsetBytes: buffer.baseOffsetBytes, laneAddressesBytes,
            bufferSizeBytes: buffer.sizeBytes, requiresInitializedBytes: inst.memory === 'shared-read'},
          bankCount: 32, bankWidthBytes: 4, bankStrideWords: config.sharedBankStrideWords,
          conflictDegree: degree, bankConflictExtraCycles: extraCycles}});
    }, {bytes: 16});
  }
  function tma(inst, ready, operands) {
    if (inst.round > 0 && !inst.warp.program.find(previous => previous.round === inst.round - 1 && previous.unit === 'tensor').done) {
      throw new Error('TMA destination reused before the previous round consumed its RF fragments.');
    }
    service(inst, 'tma', 'tma-submit', ready, [operands.id], (submitted, command) => {
      // Warp completion is command submission, not data availability.
      complete(inst, submitted, command);
      stats.tmaBytes += inst.bytes; stats.globalReadBytes += inst.bytes;
      const state = {id: inst.barrierId, warpId: inst.warp.warpId, expectedBytes: inst.bytes,
        phase: 0, pendingArrivals: 1, pendingTxBytes: 0, history: []};
      barrierStates.push(state);
      transfer(inst, 'tma', 'mbarrier', submitted, command.id, 'control', (notified, init) => {
        service(inst, 'mbarrier', 'barrier-expect', notified, [init.id], (expected, expectation) => {
          state.pendingArrivals--; state.pendingTxBytes += inst.bytes;
          state.expectationId = expectation.id;
          state.history.push({time: expected, phase: 0, pendingArrivals: 0, pendingTxBytes: inst.bytes, action: 'arrive_expect_tx'});
        }, {latency: 1, ii: 1, args: {barrierId: inst.barrierId, expectedBytes: inst.bytes, phase: 0, pendingArrivalsBefore: 1, pendingArrivalsAfter: 0, pendingTxBytesBefore: 0, pendingTxBytesAfter: inst.bytes}});
      });
      external(inst, submitted, command, 'tma', inst.bytes, 'read', (returned, data) => {
        service(inst, 'tma', 'tma-transfer', returned, [data.id], (copied, transferred) => {
          transfer(inst, 'tma', 'shared-memory', copied, transferred.id, 'memory', (arrival, delivered) => {
            service(inst, 'shared-memory', 'shared-access', arrival, [delivered.id], (stored, store) => {
              const buffer = sharedBuffer(inst), descriptor = inst.descriptor;
              if (descriptor.destinationDataKey !== buffer.id || descriptor.bytes !== inst.bytes) throw new Error('TMA descriptor and destination allocation disagree.');
              commitSharedRange(buffer, inst, store, descriptor.destinationOffsetBytes, descriptor.bytes);
              stats.sharedWriteBytes += inst.bytes;
              transfer(inst, 'shared-memory', 'tma', stored, store.id, 'completion', (committed, receipt) => {
                transfer(inst, 'tma', 'mbarrier', committed, receipt.id, 'completion', (notified, notification) => {
                  service(inst, 'mbarrier', 'barrier-arrive', notified, [notification.id, state.expectationId], (done, barrier) => {
                  state.pendingTxBytes -= inst.bytes;
                  if (state.pendingTxBytes !== 0 || state.pendingArrivals !== 0) throw new Error('mbarrier byte/arrival invariant failed.');
                  state.phase++;
                  state.history.push({time: done, phase: state.phase, pendingArrivals: 0, pendingTxBytes: 0, action: 'complete_tx'});
                  inst.asyncEnd = done; inst.warp.barriers.set(inst.barrierId, barrier);
                  tmaInFlight--;
                  for (const partition of partitions) { refreshPartition(partition, done); wake(partition, done); }
                  retireCta(ctas[inst.warp.ctaId], done);
                  }, {latency: 1, ii: 1, args: {barrierId: inst.barrierId, expectedBytes: inst.bytes, arrivedBytes: inst.bytes, barrierReadyAfterCompletion: true, phaseBefore: 0, phaseAfter: 1}});
                });
              });
            }, {latency: config.sharedLatencyCycles + Math.ceil(inst.bytes / config.sharedBytesPerCycle),
              ii: Math.ceil(inst.bytes / config.sharedBytesPerCycle), args: {bytes: inst.bytes, memoryOperation: 'tma-write',
                descriptor: {...inst.descriptor}, bufferSizeBytes: sharedBuffer(inst).sizeBytes}});
          }, {bytes: inst.bytes});
        }, {latency: Math.ceil(inst.bytes / config.tmaBytesPerCycle), ii: Math.ceil(inst.bytes / config.tmaBytesPerCycle),
          args: {bytes: inst.bytes, barrierId: inst.barrierId, bypassesL1: true}});
      });
    }, {latency: config.tmaLatencyCycles, args: {barrierId: inst.barrierId, bytes: inst.bytes, descriptor: {...inst.descriptor}, asynchronous: true, bypassesL1: true}});
  }
  function execute(inst, ready, operands) {
    if (inst.unit === 'tma') { tma(inst, ready, operands); return; }
    if (inst.unit === 'mbarrier') {
      service(inst, 'mbarrier', 'execute', ready, [operands.id], (done, waited) => complete(inst, done, waited),
        {latency: 1, ii: 1, args: {barrierId: inst.barrierId}});
      return;
    }
    if (inst.unit === 'lsu') {
      service(inst, 'lsu', 'execute', ready, [operands.id], (end, address) => {
        if (inst.memory.startsWith('global')) globalMemory(inst, end, address);
        else sharedMemory(inst, end, address, 'lsu', (returned, values) => writeback(inst, returned, values));
      }, {latency: config.lsuLatencyCycles, ii: 1, args: {memoryOperation: inst.memory, bytes: inst.bytes}});
      return;
    }
    if (inst.unit === 'tensor') {
      service(inst, 'tensor', 'execute', ready, [operands.id], (done, result) => writeback(inst, done, result),
        {latency: config.tensorLatencyCycles, ii: config.tensorInitiationIntervalCycles,
          args: {operandAddressSpace: 'register', fragmentRegisters: inst.fragmentRegisters,
            tensorSemantics: 'synthetic warp-level MMA.SYNC with RF A/B/C fragments; not direct-SMEM WGMMA'}});
      return;
    }
    const latencies = {fp32: config.fp32LatencyCycles, int32: config.int32LatencyCycles,
      sfu: config.sfuLatencyCycles, fp64: config.fp64LatencyCycles, branch: timing('branch').latencyCycles, mbarrier: 1};
    service(inst, inst.unit, 'execute', ready, [operands.id], (done, result) => writeback(inst, done, result),
      {latency: latencies[inst.unit], args: inst.barrierId ? {barrierId: inst.barrierId} : {}});
  }

  for (const warp of warps) refreshWarp(warp, 0);
  admitCtas(0);
  clock.run();
  if (stats.completedInstructions !== instructions.length || tmaInFlight || partitions.some(p => p.occupancy) || residency.ctas) {
    throw new Error(`SM model deadlock/invariant failure: ${stats.completedInstructions}/${instructions.length} completed.`);
  }
  for (const e of events) stats.makespan = Math.max(stats.makespan, e.end);
  events.sort((a, b) => a.start - b.start || a.end - b.end || Number(a.id.slice(3)) - Number(b.id.slice(3)));
  components.find(c => c.args?.localComponentId === 'shared-memory').resources.allocatedBytes = allocatedSharedBytes;
  const trace = {
    schemaVersion: 1,
    meta: {
      title: `SM ${config.smId} 流水线教学运行`, producer: 'GPU City SM Model', backend: 'GPU City SM Model', backendVersion: '0.3.0',
      scenarioId, timeDomain: `${scenarioId}:cycle`, evidenceKind: 'simulation', timeUnit: 'cycle', granularity: 'modeled-instruction',
      smModelSchemaVersion: 1, config, smPipeline: pipelineArchitecture,
      capabilities: ['sm_pipeline', 'modeled_instruction_spans', 'modeled_memory_requests', 'sm_residency'],
      hardwareReference: {architecture: 'NVIDIA Hopper', gpu: 'H100 SXM', numSms: 132, partitionsPerSm: 4, warpSize: 32},
      modelCoverage: {
        execution: 'synthetic timing-only instruction stream; no numeric values or SASS execution',
        componentInflightCapacity: 'enforced K from effective component timing; latency and initiation interval are separate',
        residency: 'FIFO whole-CTA admission; warp/CTA slots, per-partition symbolic register counts and SMEM carveout including 1 KiB CUDA reservation per CTA enforced; no hardware allocation granularity',
        warpReadiness: 'event-derived head-instruction history; eligible ⊆ dependency-ready ⊆ resident; issuing/inflight counted separately from half-open instruction spans',
        finiteCredits: {instructionBufferDepthPerWarp: config.instructionBufferDepth,
          scoreboardEntriesPerPartition: config.scoreboardEntries, tmaInFlightLimit: config.tmaInFlightLimit},
        localQueues: 'No independently finite local queue; waiting reservations bounded by upstream credits; no downstream backpressure.',
        registers: 'symbolic availability and RAW/WAW producer identity; no bank/port allocation or numerical values',
        l1: 'finite 128-byte teaching lines, LRU, explicitly prewarmed lines; no MSHR or concurrent miss merging',
        sharedMemory: '32-bank, 32-bit explicit symbolic lane byte addresses; allocated TMA/scratch buffers and initialized byte ranges checked before LDS',
        globalLoads: 'one logical contiguous 128-byte warp access; no per-lane 32-byte transaction/coalescing simulation',
        tma: 'symbolic contiguous global→shared descriptor; one logical producer per barrier; byte initialization then arrive_expect_tx/complete_tx readiness; bypasses RF/L1',
        tensor: 'single-warp synthetic MMA.SYNC, not four-warp WGMMA',
        tensorOperands: 'register A/B/C fragments; TMA→SMEM→mbarrier→LDS→RF→operand collector→Tensor, without direct SMEM reads by MMA.SYNC',
        timingOnly: ['icache', 'l0-icache', 'branch'], unused: ['texture', 'constant-cache'],
        unsupported: ['numeric execution', 'arbitrary PTX/SASS', 'branch divergence/reconvergence', 'instruction-cache tags/misses',
          'finite local queues/downstream backpressure', 'real register-port/bank conflicts', 'MSHR/miss merging',
          'per-lane global address coalescing', 'WGMMA warp-group semantics', 'DSM/TMA multicast', 'real L2/HBM/NoC topology']
      },
      description: '单个 SM 的独立教学性离散事件模型。合成程序具有显式流水级、有限指令缓冲/scoreboard、RAW等待、异步TMA与mbarrier、L1命中/未命中、SMEM bank冲突。不是SASS执行或NVIDIA cycle-accurate测量。',
      assumptions: [
        '只执行选中 SM；132 个 SM 是 H100 SXM 架构上下文，其余 SM 在本运行中未仿真。',
        '独立教学时钟，不能与城市 tile 运行或 GTSim 原时钟拼接成同一次执行。',
        '固定四个调度分区；warpId % 4 是教学分配策略，非公开硬件放置算法。',
        'warpCount是提交的warp总数，按warpsPerCta组成完整CTA（末CTA可较小）；整CTA按FIFO准入，驻留受warp/CTA槽、分区RF和SMEM预算共同限制。寄存器按线程需求直接相乘，不执行真实硬件分配粒度。',
        '每个分区有限 scoreboard token，覆盖已选中且未写回指令；每个 warp 有限预取/译码 credit；TMA在途有独立上限。',
        '流水线 latency 与 initiation interval 分开建模；算术值不实际执行，无真实 PC、活跃线程mask、SASS校验。',
        '组件间一周期是逻辑交接延迟，所有时序、资源接收速率均为教学参数，不是 Hopper 实测。',
        '全局内存是 NoC 边界外的带宽/延迟服务，未展开真实 L2/HBM、NoC 路由、MSHR、有限链路buffer/credit/backpressure。',
        'Global LD/ST是32线程连续32-bit字的单个128B逻辑访问；未把逐lane地址合并成多个32B硬件transaction。',
        'L1是有限行数LRU教学缓存；l1HitEvery明确设置初始热行，不是实测命中率；未合并并发miss或模拟一致性。',
        'TMA异步提交后warp继续；线性symbolic descriptor明确global source key/SMEM destination key与字节范围，写入完成后才mbarrier就绪；不执行真实tensor-map/多维地址或数值payload。',
        'Tensor示例为独立warp的MMA.SYNC教学操作：A/B/C来自RF片段；TMA缓冲在mbarrier完成后由LDS读入RF，不把mma.sync画成SMEM直连，也不冒充四warp的WGMMA。',
        'SMEM示例32个bank、32-bit字、32个明确不同byte地址；bank=floor(byteAddress/4)%32。TMA与STS scratch分配独立buffer，LDS只读TMA已初始化范围；跨round复用物理buffer在前轮读取完成之后。未覆盖向量访问或swizzle。',
        'I-cache/L0只有流水服务时序，不含tag/miss；texture和constant-cache为结构节点，本程序未使用。'
      ]
    },
    components, events,
    metrics: {
      sm: stats,
      instructions: instructions.map(inst => ({id: inst.id, smId: config.smId, warpId: inst.warp.warpId, threadBlockId: inst.warp.ctaId,
        partitionId: inst.partitionId, opcode: inst.opcode, srcRegisters: [...inst.srcRegisters], dstRegisters: [...inst.dstRegisters],
        start: inst.start, selected: inst.selected, issue: inst.issue, issueEnd: inst.issueEvent.end, end: inst.end, eventIds: inst.eventIds,
        ...(inst.barrierId ? {barrierId: inst.barrierId} : {}), ...(inst.asyncEnd != null ? {asyncEnd: inst.asyncEnd} : {}),
        ...(inst.dataKey ? {dataKey: inst.dataKey} : {}), ...(inst.waitFor ? {waitFor: [...inst.waitFor]} : {}),
        ...(inst.descriptor ? {descriptor: {...inst.descriptor}} : {}), ...(inst.sharedAccess ? {sharedAccess: {...inst.sharedAccess}} : {}),
        ...(inst.fragmentRegisters ? {fragmentRegisters: {...inst.fragmentRegisters}, operandAddressSpace: 'register'} : {})})),
      scoreboard: partitions.map(p => ({partitionId: p.partitionId, capacity: config.scoreboardEntries, history: p.scoreboardHistory})),
      barriers: barrierStates,
      sharedBuffers: [...sharedBuffers.values()],
      sharedMemoryAllocation: {allocatedBytes: allocatedSharedBytes, selectedCarveoutBytes: selectedSharedCarveoutBytes,
        physicalBuffers: stats.maxResidentWarps * 2, logicalBuffers: config.warpCount * 2,
        reservedBytesPerCta: admission.reservedSharedBytesPerCta, buffersPerWarp: 2, epochsPerBuffer: config.rounds},
      ctas: ctas.map(cta => ({...cta, threadBlockId: cta.ctaId})),
      warps: warps.map(warp => ({warpId: warp.warpId, ctaId: warp.ctaId, partitionId: warp.partitionId,
        admitted: warp.admitted, retired: warp.retired, history: warp.history})),
      residency: {schemaVersion: 1, policy: 'whole-cta-fifo', limits: admission.limits, history: residencyHistory,
        stateDefinitions: {resident: 'CTA resources held, including stalled and draining warps',
          ready: 'decoded head has no RAW/WAW, completion or barrier dependency',
          eligible: 'ready plus available scoreboard/TMA credit and partition issue budget',
          issuing: 'warp with an actual issue-stage span at this cycle',
          inflight: 'warp with an issued instruction or asynchronous TMA operation not yet complete',
          waiting: 'resident warp whose next head instruction is not dependency-ready',
          queued: 'whole CTA waiting for resource admission'}},
      omittedNodes: []
    }
  };
  return validateTrace(trace);
}

/** Instantaneous, half-open [start,end) model state. Legacy traces stay unobserved. */
export function smActivityAt(trace, time, {partitionId = null} = {}) {
  if (!Number.isFinite(time) || time < 0) throw new RangeError('SM activity time must be finite and nonnegative.');
  if (partitionId != null && (!Number.isInteger(partitionId) || partitionId < 0 || partitionId > 3)) throw new RangeError('SM partition must be 0–3.');
  const metrics = trace?.metrics;
  if (!metrics?.residency || !Array.isArray(metrics.warps)) return {available: false, time, counts: null, partitions: [], waitReasons: {}, warps: []};
  const issuing = new Set(), inflight = new Set();
  for (const inst of metrics.instructions) {
    if (inst.issue <= time && time < inst.issueEnd) issuing.add(inst.warpId);
    if (inst.issue <= time && time < Math.max(inst.end, inst.asyncEnd ?? inst.end)) inflight.add(inst.warpId);
  }
  const snapshot = metrics.warps.filter(warp => partitionId == null || warp.partitionId === partitionId).map(warp => {
    let low = 0, high = warp.history.length;
    while (low < high) { const mid = (low + high) >>> 1; if (warp.history[mid].time <= time) low = mid + 1; else high = mid; }
    const current = warp.history[low - 1] ?? {state: 'queued', ready: false, eligible: false, waitReason: null, instructionId: null};
    return {warpId: warp.warpId, ctaId: warp.ctaId, partitionId: warp.partitionId, ...current,
      resident: warp.admitted <= time && time < warp.retired,
      issuing: issuing.has(warp.warpId), inflight: inflight.has(warp.warpId)};
  });
  const summarize = warps => {
    const counts = {resident: 0, ready: 0, eligible: 0, issuing: 0, inflight: 0,
      waiting: 0, fetching: 0, draining: 0, queued: 0, retired: 0};
    for (const warp of warps) {
      for (const key of ['resident', 'ready', 'eligible', 'issuing', 'inflight']) if (warp[key]) counts[key]++;
      if (['waiting', 'fetching', 'draining', 'queued', 'retired'].includes(warp.state)) counts[warp.state]++;
    }
    return counts;
  };
  const waitReasons = {};
  for (const warp of snapshot) if (warp.waitReason) waitReasons[warp.waitReason] = (waitReasons[warp.waitReason] ?? 0) + 1;
  const ctas = metrics.ctas.filter(cta => partitionId == null || cta.warpIds.some(id => id % 4 === partitionId));
  return {available: true, time, counts: {...summarize(snapshot),
    residentCtas: ctas.filter(cta => cta.admitted <= time && time < cta.retired).length,
    queuedCtas: ctas.filter(cta => cta.admitted > time).length},
    partitions: Array.from({length: 4}, (_, id) => ({partitionId: id, ...summarize(snapshot.filter(warp => warp.partitionId === id))})),
    waitReasons, warps: snapshot};
}
