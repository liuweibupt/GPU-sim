import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_SM_CONFIG, simulateSm, smActivityAt} from '../lib/sm-model.js';
import {SM_ARCHITECTURE, instantiateSmArchitecture, validateSmArchitecture} from '../lib/sm-architecture.js';
import {validateTrace} from '../lib/trace.js';
import {validateSmTrace} from '../lib/sm-contract.js';

const baseline = simulateSm();
const stages = (trace, instructionId, stage) => trace.events.filter(e => e.args.instructionId === instructionId && (!stage || e.args.stage === stage));
const instruction = (trace, warpId, opcode) => trace.metrics.instructions.find(i => i.warpId === warpId && i.opcode === opcode);

test('one selected SM has four real model partitions within an honest 132-SM architecture context', () => {
  assert.equal(baseline.meta.backend, 'GPU City SM Model');
  assert.equal(baseline.meta.smModelSchemaVersion, 1);
  assert.equal(baseline.meta.evidenceKind, 'simulation');
  assert.equal(baseline.meta.hardwareReference.numSms, 132);
  assert.equal(baseline.meta.config.partitionCount, 4);
  assert.equal(baseline.components.filter(c => c.kind === 'sm').length, 1);
  assert.deepEqual(new Set(baseline.events.map(e => e.args.partitionId)), new Set([0, 1, 2, 3]));
  assert.equal(baseline.metrics.sm.instructions, DEFAULT_SM_CONFIG.warpCount * 14);
  assert.equal(baseline.metrics.sm.completedInstructions, baseline.metrics.sm.instructions);
  assert.ok(!baseline.meta.capabilities.includes('instruction_spans'));
  assert.equal(validateTrace(baseline), baseline);
  assert.equal(validateSmTrace(baseline), baseline);
  const sm131 = simulateSm({smId: 131, warpCount: 1});
  assert.ok(sm131.events.every(e => e.args.smId === 131));
  assert.ok(sm131.components.some(c => c.id === 'sm-131/p0/fetch'));
});

test('each declared pipeline and execution resource has causal timing evidence, while unused units stay empty', () => {
  const used = new Set(baseline.events.filter(e => !['transfer', 'stall'].includes(e.args.stage)).map(e => e.args.localComponentId));
  for (const name of ['icache', 'l0-icache', 'fetch', 'decode', 'scoreboard', 'warp-scheduler', 'issue', 'dispatch',
    'register-file', 'operand-collector', 'fp32', 'int32', 'sfu', 'fp64', 'tensor', 'lsu', 'l1-cache', 'shared-memory',
    'tma', 'mbarrier', 'writeback', 'noc-interface', 'branch']) assert.ok(used.has(name), name);
  assert.ok(!used.has('texture'));
  assert.ok(!used.has('constant-cache'));
  for (const i of baseline.metrics.instructions) {
    const span = stages(baseline, i.id);
    assert.equal(span.filter(e => e.args.stage === 'fetch').length, 1);
    assert.equal(span.filter(e => e.args.stage === 'decode').length, 1);
    assert.equal(span.filter(e => e.args.stage === 'issue').length, 1);
    assert.equal(i.issue, span.find(e => e.args.stage === 'issue').start);
    assert.ok(span.every(e => e.start >= i.start && e.end <= (i.asyncEnd ?? i.end)));
  }
});

test('every explicit transfer matches typed ports in the shared formal topology', () => {
  const architecture = instantiateSmArchitecture(0);
  const links = new Set(architecture.links.map(e => `${e.source}|${e.target}|${e.type}`));
  for (const e of baseline.events) {
    const flow = e.args.smPipelineTransfer;
    if (flow) assert.ok(links.has(`${flow.sourceId}|${flow.targetId}|${flow.kind}`), e.name);
  }
});

test('RAW consumers cannot issue before the matching producer completes', () => {
  const groups = new Map();
  for (const i of baseline.metrics.instructions) {
    if (!groups.has(i.warpId)) groups.set(i.warpId, []);
    groups.get(i.warpId).push(i);
  }
  for (const group of groups.values()) {
    const written = new Map();
    for (const i of group) {
      for (const register of i.srcRegisters) {
        if (written.has(register)) assert.ok(i.issue >= written.get(register).end, `${i.id} reads ${register} too soon`);
      }
      for (const register of i.dstRegisters) written.set(register, i);
    }
  }
  const raw = baseline.events.filter(e => e.args.stallReason === 'RAW');
  assert.ok(raw.length > 0);
  assert.equal(raw.reduce((sum, e) => sum + e.end - e.start, 0), baseline.metrics.sm.rawStallCycles);
  assert.ok(raw.every(e => e.args.stalledRegisters.length > 0));
});

test('finite scoreboard, instruction-buffer and TMA credits stay within configured capacities', () => {
  const trace = simulateSm({warpCount: 16, scoreboardEntries: 1, instructionBufferDepth: 1, tmaInFlightLimit: 1});
  assert.equal(trace.metrics.sm.maxScoreboardOccupancy, 1);
  assert.equal(trace.metrics.sm.maxInstructionBufferOccupancy, 1);
  assert.equal(trace.metrics.sm.maxTmaInFlight, 1);
  assert.ok(trace.metrics.sm.scoreboardStallCycles > 0);
  assert.ok(trace.events.some(e => e.args.stallReason === 'tma-capacity'));
  for (const partition of trace.metrics.scoreboard) {
    assert.ok(partition.history.every(s => s.occupancy >= 0 && s.occupancy <= partition.capacity));
    assert.equal(partition.history.at(-1).occupancy, 0);
  }
  assert.ok(trace.metrics.sm.makespan > baseline.metrics.sm.makespan);
});

test('partition issue budgets and every component in-flight K are enforced independently of latency', () => {
  const trace = simulateSm({warpCount: 32, fp32LatencyCycles: 40, issueIntervalCycles: 2});
  for (let partitionId = 0; partitionId < 4; partitionId++) {
    const issued = trace.events.filter(e => e.args.stage === 'issue' && e.args.partitionId === partitionId);
    for (let n = 1; n < issued.length; n++) assert.ok(issued[n].start - issued[n - 1].start >= 2);
  }
  const resources = new Map();
  for (const e of trace.events.filter(e => e.args.inflightCapacity != null)) {
    if (!resources.has(e.componentId)) resources.set(e.componentId, []);
    resources.get(e.componentId).push(e);
  }
  let overlapped = false;
  for (const spans of resources.values()) {
    const edges = spans.flatMap(e => [[e.start, 1], [e.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let active = 0;
    for (const [, change] of edges) {
      active += change;
      assert.ok(active <= spans[0].args.inflightCapacity && active >= 0);
      if (active > 1 && spans.some(e => e.args.localComponentId === 'fp32')) overlapped = true;
    }
    for (let n = 1; n < spans.length; n++) {
      assert.ok(spans[n].start >= spans[n - 1].start + spans[n - 1].args.initiationIntervalCycles);
    }
  }
  assert.ok(overlapped, 'pipelined arithmetic must overlap instead of serializing the full latency');
});

test('TMA is asynchronous, bypasses RF and L1, and commits SMEM before releasing its byte-count barrier', () => {
  for (let warpId = 0; warpId < 8; warpId++) {
    const copy = instruction(baseline, warpId, 'TMA.LOAD');
    const integer = instruction(baseline, warpId, 'IADD3');
    const wait = instruction(baseline, warpId, 'MBAR.WAIT');
    const fragmentLoad = instruction(baseline, warpId, 'LDS');
    const tensor = instruction(baseline, warpId, 'MMA.SYNC');
    assert.ok(copy.end < copy.asyncEnd);
    assert.ok(integer.issue < copy.asyncEnd, 'independent work can issue while the TMA copy remains outstanding');
    assert.ok(wait.issue >= copy.asyncEnd);
    assert.ok(fragmentLoad.issue >= wait.end);
    assert.ok(fragmentLoad.issue >= copy.asyncEnd);
    assert.equal(fragmentLoad.barrierId, copy.barrierId);
    assert.equal(fragmentLoad.dataKey, copy.dataKey);
    assert.ok(fragmentLoad.waitFor.includes(wait.id));
    assert.ok(tensor.issue >= wait.end);
    const span = stages(baseline, copy.id);
    assert.ok(!span.some(e => ['register-file', 'operand-collector', 'l1-cache', 'writeback'].includes(e.args.localComponentId)));
    const store = span.find(e => e.args.stage === 'shared-access');
    const arrived = span.find(e => e.args.stage === 'barrier-arrive');
    assert.ok(arrived.start >= store.end);
    assert.equal(arrived.args.expectedBytes, DEFAULT_SM_CONFIG.tmaBytes);
    assert.equal(arrived.args.arrivedBytes, arrived.args.expectedBytes);
  }
  for (const barrier of baseline.metrics.barriers) {
    assert.equal(barrier.history.length, 2);
    assert.equal(barrier.history[0].pendingTxBytes, barrier.expectedBytes);
    assert.equal(barrier.history[1].pendingTxBytes, 0);
    assert.equal(barrier.history[1].pendingArrivals, 0);
    assert.equal(barrier.phase, 1);
  }
});

test('warp MMA.SYNC consumes RF fragments loaded after the TMA barrier, without a direct SMEM-to-Tensor path', () => {
  for (let warpId = 0; warpId < 8; warpId++) {
    const load = instruction(baseline, warpId, 'LDS');
    const mma = instruction(baseline, warpId, 'MMA.SYNC');
    const spans = stages(baseline, mma.id);
    const inputs = spans.filter(e => e.args.smPipelineTransfer?.targetId === `sm-0/p${mma.partitionId}/tensor`);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].args.smPipelineTransfer.sourceId, `sm-0/p${mma.partitionId}/operand-collector`);
    assert.equal(inputs[0].args.smPipelineTransfer.kind, 'operand');
    assert.ok(!spans.some(e => e.args.stage === 'shared-access' || e.args.localComponentId === 'shared-memory'));
    assert.ok(!spans.some(e => e.args.smPipelineTransfer?.sourceId === 'sm-0/shared-memory'));
    const read = spans.find(e => e.args.stage === 'register-read');
    const execute = spans.find(e => e.args.stage === 'execute' && e.args.localComponentId === 'tensor');
    assert.equal(execute.args.operandAddressSpace, 'register');
    assert.deepEqual(execute.args.fragmentRegisters, mma.fragmentRegisters);
    assert.ok(Object.values(mma.fragmentRegisters).every(register => read.args.srcRegisters.includes(register)));
    assert.ok(read.start >= load.end);
    const arrived = stages(baseline, load.id).find(e => e.args.smPipelineTransfer?.sourceId === `sm-0/p${load.partitionId}/writeback` &&
      e.args.smPipelineTransfer?.targetId === `sm-0/p${load.partitionId}/register-file`);
    assert.ok(arrived, 'LDS result must explicitly arrive in RF');
    assert.equal(arrived.end, load.end);
    assert.ok(spans.find(e => e.args.stage === 'scoreboard').dependencies.includes(arrived.id), 'RAW edge must retain the actual LDS→RF completion');
  }
});

test('TMA descriptors initialize the exact LDS buffer and lane byte ranges, separate from STS scratch writes', () => {
  for (const trace of [baseline, simulateSm({sharedBankStrideWords: 32})]) {
    const buffers = new Map(trace.metrics.sharedBuffers.map(buffer => [buffer.id, buffer]));
    const events = new Map(trace.events.map(event => [event.id, event]));
    for (let warpId = 0; warpId < trace.meta.config.warpCount; warpId++) {
      const copy = instruction(trace, warpId, 'TMA.LOAD');
      const store = instruction(trace, warpId, 'STS');
      const load = instruction(trace, warpId, 'LDS');
      const destination = buffers.get(copy.descriptor.destinationDataKey);
      const scratch = buffers.get(store.dataKey);
      assert.equal(load.dataKey, destination.id);
      assert.notEqual(scratch.id, destination.id);
      assert.equal(destination.role, 'tma-destination');
      assert.equal(scratch.role, 'scratch');
      assert.ok(destination.baseOffsetBytes + destination.sizeBytes <= scratch.baseOffsetBytes);
      assert.equal(destination.writes.length, 1);
      assert.equal(destination.writes[0].writerInstructionId, copy.id);
      assert.equal(destination.writes[0].offsetBytes, copy.descriptor.destinationOffsetBytes);
      assert.equal(destination.writes[0].endOffsetBytes, copy.descriptor.destinationOffsetBytes + copy.descriptor.bytes);
      assert.ok(scratch.writes.every(write => write.writerInstructionId === store.id));
      const external = stages(trace, copy.id, 'external-memory')[0];
      assert.equal(external.args.dataKey, copy.descriptor.sourceDataKey);
      assert.equal(external.args.destinationDataKey, destination.id);
      const access = stages(trace, load.id, 'shared-access')[0];
      assert.equal(access.args.sharedAccess.bufferId, destination.id);
      const ancestors = new Set(), pending = [...access.dependencies];
      while (pending.length) {
        const id = pending.pop();
        if (ancestors.has(id)) continue;
        ancestors.add(id); pending.push(...events.get(id).dependencies);
      }
      for (const byteAddress of access.args.sharedAccess.laneAddressesBytes) {
        const offset = byteAddress - destination.baseOffsetBytes;
        assert.ok(offset >= 0 && offset + 4 <= destination.sizeBytes);
        const range = destination.initializedRanges.find(range => range.offsetBytes <= offset && range.endOffsetBytes >= offset + 4);
        assert.ok(range && range.readyCycle <= access.start);
        assert.ok(ancestors.has(range.writerEventId));
        assert.equal(events.get(range.writerEventId).args.memoryOperation, 'tma-write');
      }
    }
  }
});

test('L1 hits and misses follow different actual paths and memory byte totals conserve requests', () => {
  const loads = baseline.metrics.instructions.filter(i => i.opcode === 'LDG');
  let hits = 0, misses = 0;
  for (const i of loads) {
    const spans = stages(baseline, i.id);
    const lookup = spans.find(e => e.args.stage === 'cache-lookup');
    const external = spans.filter(e => e.args.stage === 'external-memory');
    if (lookup.args.memoryOutcome === 'hit') { hits++; assert.equal(external.length, 0); }
    else { misses++; assert.equal(external.length, 1); assert.ok(spans.some(e => e.args.stage === 'cache-fill')); }
  }
  assert.equal(hits, baseline.metrics.sm.l1Hits);
  assert.equal(misses, baseline.metrics.sm.l1Misses);
  assert.equal(hits + misses, 16);
  const external = baseline.events.filter(e => e.args.stage === 'external-memory');
  assert.equal(external.filter(e => e.args.direction === 'read').reduce((sum, e) => sum + e.args.bytes, 0), baseline.metrics.sm.globalReadBytes);
  assert.equal(external.filter(e => e.args.direction === 'write').reduce((sum, e) => sum + e.args.bytes, 0), baseline.metrics.sm.globalWriteBytes);
  const cold = simulateSm({l1HitEvery: 0});
  assert.equal(cold.metrics.sm.l1Misses, 8);
  const tiny = simulateSm({l1CapacityLines: 1});
  assert.ok(tiny.metrics.sm.l1Evictions > 0);
});

test('SMEM conflict degrees derive from bank addresses and slow real execution', () => {
  const conflict = simulateSm({sharedBankStrideWords: 32});
  assert.ok(conflict.metrics.sm.makespan > baseline.metrics.sm.makespan);
  assert.equal(baseline.metrics.sm.sharedBankConflicts, 0);
  assert.ok(conflict.metrics.sm.sharedBankConflicts > 0);
  const spans = conflict.events.filter(e => e.args.stage === 'shared-access' && e.args.conflictDegree != null);
  assert.ok(spans.every(e => e.args.conflictDegree === 32));
  assert.ok(spans.every(e => e.end - e.start === DEFAULT_SM_CONFIG.sharedLatencyCycles + 32));
  assert.equal(conflict.metrics.sm.sharedBankConflictExtraCycles, spans.reduce((sum, e) => sum + e.args.bankConflictExtraCycles, 0));
  assert.equal(conflict.metrics.sm.sharedReadBytes, baseline.metrics.sm.sharedReadBytes);
  assert.equal(conflict.metrics.sm.sharedWriteBytes, baseline.metrics.sm.sharedWriteBytes);
});

test('latency, issue interval and memory bandwidth controls causally change completion times', () => {
  for (const overrides of [{globalMemoryLatencyCycles: 240}, {tensorLatencyCycles: 48},
    {tmaBytesPerCycle: 8}, {externalBytesPerCycle: 8}]) {
    const changed = simulateSm(overrides);
    assert.ok(changed.metrics.sm.makespan > baseline.metrics.sm.makespan, JSON.stringify(overrides));
    assert.equal(changed.metrics.sm.completedInstructions, baseline.metrics.sm.completedInstructions);
    assert.equal(changed.metrics.sm.globalReadBytes, baseline.metrics.sm.globalReadBytes);
    assert.notEqual(changed.meta.timeDomain, baseline.meta.timeDomain);
  }
  // Default TMA/memory bottlenecks may hide issue bandwidth from makespan.
  // Use a small-copy workload to expose issue pressure without changing work.
  const issueWorkload = {tmaBytes: 128, globalMemoryLatencyCycles: 1};
  const fastIssue = simulateSm(issueWorkload), slowIssue = simulateSm({...issueWorkload, issueIntervalCycles: 4});
  assert.ok(slowIssue.metrics.sm.makespan > fastIssue.metrics.sm.makespan);
  assert.equal(slowIssue.metrics.sm.completedInstructions, fastIssue.metrics.sm.completedInstructions);
});

test('effective formal timing and memory allocation agree with execution and its explicit limitations', () => {
  const trace = simulateSm({tensorLatencyCycles: 32, tensorInitiationIntervalCycles: 2, sharedBankStrideWords: 2});
  assert.equal(trace.meta.smPipeline.defaultTiming.tensor.latencyCycles, 32);
  assert.equal(trace.meta.smPipeline.defaultTiming.tensor.initiationIntervalCycles, 2);
  assert.equal(SM_ARCHITECTURE.defaultTiming.tensor.latencyCycles, 24, 'simulation must not mutate the shared source specification');
  assert.equal(validateSmArchitecture(trace.meta.smPipeline), trace.meta.smPipeline);
  const tensor = trace.components.find(c => c.id === 'sm-0/p0/tensor');
  assert.equal(tensor.timing.latencyCycles, 32);
  assert.equal(tensor.timing.queueCapacity, null);
  assert.ok(tensor.timing.queueImplementation);
  const shared = trace.components.find(c => c.id === 'sm-0/shared-memory');
  const l1 = trace.components.find(c => c.id === 'sm-0/l1-cache');
  assert.ok(shared.resources.allocatedBytes <= shared.resources.selectedCarveoutBytes);
  assert.ok(l1.resources.logicalCapacityBytes + shared.resources.selectedCarveoutBytes <= 262144);
  assert.equal(trace.meta.modelCoverage.tensor, 'single-warp synthetic MMA.SYNC, not four-warp WGMMA');
  assert.ok(trace.meta.modelCoverage.unsupported.includes('finite local queues/downstream backpressure'));
});

test('runs are deterministic and repeated rounds retain valid separate instruction and barrier identities', () => {
  assert.deepEqual(simulateSm({warpCount: 4, rounds: 2}), simulateSm({warpCount: 4, rounds: 2}));
  const trace = simulateSm({warpCount: 4, rounds: 2});
  assert.equal(trace.metrics.sm.completedInstructions, 4 * 2 * 14);
  assert.equal(trace.metrics.barriers.length, 8);
  assert.equal(new Set(trace.metrics.instructions.map(i => i.id)).size, 112);
  validateSmTrace(trace);
});

test('successive rounds reuse two physical buffers per warp only after the previous LDS and MMA have consumed them', () => {
  const trace = simulateSm({warpCount: 4, rounds: 3});
  const once = simulateSm({warpCount: 4, rounds: 1});
  assert.equal(trace.metrics.sharedMemoryAllocation.physicalBuffers, 8);
  assert.equal(trace.metrics.sharedMemoryAllocation.allocatedBytes, once.metrics.sharedMemoryAllocation.allocatedBytes);
  assert.equal(new Set(trace.metrics.sharedBuffers.map(buffer => buffer.allocationId)).size, 8);
  for (let warpId = 0; warpId < 4; warpId++) {
    const copies = trace.metrics.instructions.filter(i => i.warpId === warpId && i.opcode === 'TMA.LOAD');
    const tensors = trace.metrics.instructions.filter(i => i.warpId === warpId && i.opcode === 'MMA.SYNC');
    const loads = trace.metrics.instructions.filter(i => i.warpId === warpId && i.opcode === 'LDS');
    const buffers = copies.map(copy => trace.metrics.sharedBuffers.find(buffer => buffer.id === copy.descriptor.destinationDataKey));
    assert.equal(new Set(buffers.map(buffer => buffer.baseOffsetBytes)).size, 1);
    for (let round = 1; round < copies.length; round++) {
      assert.ok(copies[round].issue >= loads[round - 1].end);
      assert.ok(copies[round].issue >= tensors[round - 1].end);
      assert.notEqual(copies[round].descriptor.destinationDataKey, copies[round - 1].descriptor.destinationDataKey);
      assert.ok(buffers[round].initializedRanges.every(range => range.writerInstructionId === copies[round].id));
    }
  }
});

test('invalid inputs and impossible unified-memory allocations fail before event execution', () => {
  for (const invalid of [null, [], '8', {smId: -1}, {smId: 132}, {warpCount: 0}, {warpCount: 129},
    {warpCount: NaN}, {partitionCount: 8}, {rounds: 0}, {scoreboardEntries: 0}, {fetchLatencyCycles: 0},
    {tensorLatencyCycles: 1.5}, {tensorInitiationIntervalCycles: Infinity}, {sharedBankStrideWords: 0},
    {sharedBankStrideWords: 33}, {l1HitEvery: -1}, {tmaInFlightLimit: 0}, {tmaBytesPerCycle: 0},
    {warpCount: 32, tmaBytes: 65536}, {warpCount: 32, warpsPerCta: 32, tmaBytes: 4096, l1CapacityLines: 1024},
    {tmaBytes: 1024, sharedBankStrideWords: 32}, {tmaBytes: 1025},
    {warpCount: 32, warpsPerCta: 32, tmaBytes: 4096, sharedBankStrideWords: 32},
    {warpsPerCta: 0}, {registersPerThread: 256}, {residentWarpLimit: 0}, {residentCtaLimit: 33},
    {warpsPerCta: 4, residentWarpLimit: 3}, {warpCount: 32, warpsPerCta: 32, registersPerThread: 255},
    {fakeLatency: 5}, {toString: 1}]) assert.throws(() => simulateSm(invalid), JSON.stringify(invalid));
});

test('whole CTA resource admission waits for retirement, reuses SMEM and preserves all submitted work', () => {
  const trace = simulateSm({warpCount: 16, residentCtaLimit: 1});
  assert.equal(trace.metrics.ctas.length, 4);
  assert.equal(trace.metrics.sm.maxResidentCtas, 1);
  assert.equal(trace.metrics.sm.maxResidentWarps, 4);
  assert.equal(trace.metrics.sharedMemoryAllocation.physicalBuffers, 8);
  assert.equal(trace.metrics.sharedMemoryAllocation.logicalBuffers, 32);
  assert.equal(trace.metrics.sm.completedInstructions, 16 * 14);
  assert.ok(trace.metrics.sm.ctaAdmissionWaitCycles > 0);
  for (const cta of trace.metrics.ctas) {
    if (cta.ctaId) assert.equal(cta.admitted, trace.metrics.ctas[cta.ctaId - 1].retired);
    assert.ok(trace.metrics.instructions.filter(i => i.threadBlockId === cta.ctaId)
      .every(i => i.start >= cta.admitted && Math.max(i.end, i.asyncEnd ?? i.end) <= cta.retired));
  }
  assert.ok(trace.metrics.ctas[1].admissionWaitReasons.includes('cta-slots'));
  const first = trace.metrics.sharedBuffers.find(b => b.warpId === 0 && b.role === 'tma-destination');
  const reused = trace.metrics.sharedBuffers.find(b => b.warpId === 4 && b.role === 'tma-destination');
  assert.equal(first.baseOffsetBytes, reused.baseOffsetBytes);
  assert.equal(validateSmTrace(trace), trace);
});

test('register, warp and unified shared-memory budgets independently bound residency', () => {
  const cases = [
    [{warpCount: 32, registersPerThread: 255}, 'register-capacity'],
    [{warpCount: 16, residentWarpLimit: 8}, 'warp-slots'],
    [{warpCount: 32, l1CapacityLines: 1024}, 'shared-memory-capacity'],
    [{warpCount: 32, sharedBankStrideWords: 32}, 'shared-memory-capacity'],
  ];
  for (const [config, expectedReason] of cases) {
    const trace = simulateSm(config), {limits, history} = trace.metrics.residency;
    assert.ok(trace.metrics.ctas.some(cta => cta.admissionWaitReasons.includes(expectedReason)), expectedReason);
    for (const state of history) {
      assert.ok(state.ctas <= limits.ctas && state.warps <= limits.warps && state.registers <= limits.registers && state.sharedBytes <= limits.sharedBytes);
      assert.ok(state.partitionRegisters.every(count => count <= limits.registersPerPartition));
    }
    assert.equal(trace.metrics.sm.completedInstructions, config.warpCount * 14);
    validateSmTrace(trace);
  }
});

test('128 submitted warps run in whole-CTA waves without increasing hardware residency', () => {
  const trace = simulateSm({warpCount: 128, tmaBytes: 128, registersPerThread: 16});
  assert.equal(trace.metrics.ctas.length, 32);
  assert.equal(trace.metrics.sm.completedInstructions, 128 * 14);
  assert.equal(trace.metrics.sm.maxResidentWarps, 64);
  assert.equal(smActivityAt(trace, 0).counts.queued, 64);
  assert.equal(trace.metrics.residency.history.at(-1).warps, 0);
  validateSmTrace(trace);
});

test('CUDA reserves an additional 1 KiB per CTA beyond its user buffers', () => {
  const trace = simulateSm({warpCount: 32, warpsPerCta: 1, tmaBytes: 128, registersPerThread: 16});
  assert.equal(trace.metrics.ctas.length, 32);
  assert.equal(trace.metrics.ctas[0].userSharedBytes, 256);
  assert.equal(trace.metrics.ctas[0].reservedSharedBytes, 1024);
  assert.equal(trace.metrics.ctas[0].sharedBytes, 1280);
  assert.equal(trace.metrics.sharedMemoryAllocation.allocatedBytes, 40960);
  assert.equal(trace.metrics.sharedMemoryAllocation.selectedCarveoutBytes, 65536);
  assert.equal(trace.metrics.sharedMemoryAllocation.reservedBytesPerCta, 1024);
  for (const buffer of trace.metrics.sharedBuffers) {
    const cta = trace.metrics.ctas[buffer.ctaId];
    assert.ok(buffer.baseOffsetBytes >= cta.sharedOffsetBytes);
    assert.ok(buffer.baseOffsetBytes + buffer.sizeBytes <= cta.sharedOffsetBytes + cta.userSharedBytes);
  }
  validateSmTrace(trace);
});

test('instantaneous warp evidence separates residency, dependency readiness, eligibility, issue and outstanding work', () => {
  const trace = simulateSm({warpCount: 8, residentCtaLimit: 1, tmaInFlightLimit: 1, scoreboardEntries: 1});
  const initial = smActivityAt(trace, 0);
  assert.equal(initial.counts.resident, 4);
  assert.equal(initial.counts.queued, 4);
  assert.equal(initial.counts.residentCtas, 1);
  assert.equal(initial.counts.queuedCtas, 1);
  let resourceWait = false, dependencyWait = false, outstandingWithoutIssue = false;
  for (let time = 0; time <= trace.metrics.sm.makespan; time++) {
    const activity = smActivityAt(trace, time), count = activity.counts;
    assert.ok(count.eligible <= count.ready && count.ready <= count.resident);
    assert.ok(count.issuing <= count.resident && count.inflight <= count.resident);
    assert.equal(count.resident + count.queued + count.retired, 8);
    assert.equal(activity.partitions.reduce((sum, p) => sum + p.resident, 0), count.resident);
    const expectedIssuing = new Set(trace.metrics.instructions.filter(i => i.issue <= time && time < i.issueEnd).map(i => i.warpId)).size;
    assert.equal(count.issuing, expectedIssuing);
    resourceWait ||= count.ready > count.eligible;
    dependencyWait ||= activity.waitReasons.RAW > 0;
    outstandingWithoutIssue ||= count.inflight > 0 && count.issuing === 0;
  }
  assert.ok(resourceWait && dependencyWait && outstandingWithoutIssue);
  const finished = smActivityAt(trace, trace.metrics.sm.makespan);
  assert.equal(finished.counts.resident, 0);
  assert.equal(finished.counts.inflight, 0);
  assert.equal(finished.counts.retired, 8);
  const endFirstCta = trace.metrics.ctas[0].retired;
  assert.equal(smActivityAt(trace, endFirstCta).warps.find(w => w.warpId === 0).resident, false);
  assert.equal(smActivityAt(trace, endFirstCta).warps.find(w => w.warpId === 4).resident, true);
  assert.equal(smActivityAt(trace, 0, {partitionId: 0}).counts.resident, 1);
  const legacy = structuredClone(baseline); delete legacy.metrics.residency; delete legacy.metrics.warps;
  assert.equal(smActivityAt(legacy, 0).available, false);
  assert.throws(() => smActivityAt(trace, -1), RangeError);
  assert.throws(() => smActivityAt(trace, Infinity), RangeError);
});
