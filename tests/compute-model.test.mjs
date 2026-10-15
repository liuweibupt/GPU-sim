import test from 'node:test';
import assert from 'node:assert/strict';
import {MODEL_INFO, WORKLOADS, getWorkloadPerformance} from '../lib/compute-model.js';

const KINDS = Object.keys(WORKLOADS);
const LEVELS = {alu: 63, clock: 8, l1: 4, dram: 4, l2: 4, scheduler: 4, tensor: 6, hbm: 4, tma: 4, tmem: 4};
const NEAR_FRONTIER = {alu: 7, clock: 2, l1: 2, dram: 1, l2: 2, scheduler: 2, tensor: 2, hbm: 1, tma: 1, tmem: 1};
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8 * Math.max(1, Math.abs(a), Math.abs(b)), `${a} ≈ ${b}`);

test('metadata declares analytical teaching assumptions and every bare workload normalizes to one', () => {
  assert.match(MODEL_INFO.id, /analytical/);
  assert.ok(MODEL_INFO.limitations.some(text => text.includes('测量')));
  assert.deepEqual(KINDS, ['fp32', 'stream', 'conv', 'gemm', 'async', 'attention']);
  for (const kind of KINDS) {
    const model = getWorkloadPerformance({}, kind);
    assert.equal(model.throughput, 1);
    assert.equal(model.hitRate, 0);
    assert.equal(model.features.aluCount, 1);
    assert.equal(model.features.l1CapacityBytes, 0);
    assert.equal(model.features.l2CapacityBytes, 0);
    assert.equal(model.features.externalBandwidth, 1);
    assert.equal(model.features.externalLatency, 80);
    assert.equal(model.overlap, 0);
  }
});

test('cycles and hierarchy traffic reconstruct exactly from the published decomposition', () => {
  for (const levels of [{}, {alu: 7, l1: 2, dram: 1}, NEAR_FRONTIER, LEVELS]) {
    for (const kind of KINDS) {
      const result = getWorkloadPerformance(levels, kind);
      const feature = result.features;
      close(result.cycles, result.computeCycles + result.memoryCycles - result.overlap * Math.min(result.computeCycles, result.memoryCycles) + result.latencyCycles);
      close(feature.l1Bytes + feature.l2Bytes + feature.externalBytes, feature.trafficBytes);
      close(result.memoryCycles, feature.l1Bytes / feature.l1Bandwidth + feature.l2Bytes / feature.l2Bandwidth + feature.externalBytes / feature.externalBandwidth);
      close(result.throughput, result.baselineCycles / result.cycles);
      close(result.arithmeticIntensity, feature.operations / feature.trafficBytes);
      assert.ok(result.cycles >= Math.max(result.computeCycles, result.memoryCycles));
      assert.ok(result.overlap >= 0 && result.overlap <= 1);
      assert.ok(result.hitRate >= 0 && result.hitRate < 1);
      assert.ok(['compute', 'bandwidth', 'latency'].includes(result.bottleneck));
    }
  }
});

test('cache hit probability depends on working set and reuse, with conditional L2 misses', () => {
  const reused = getWorkloadPerformance({l1: 1, l2: 1}, 'gemm');
  const streaming = getWorkloadPerformance({l1: 1, l2: 1}, 'stream');
  assert.ok(reused.hitRate > streaming.hitRate);
  assert.ok(reused.features.externalBytes < WORKLOADS.gemm.bytes);
  close(reused.hitRate, reused.l1HitRate + reused.l2HitRate);
  const expectedL1 = (WORKLOADS.gemm.reuse / (1 + WORKLOADS.gemm.reuse)) * 32768 / (32768 + WORKLOADS.gemm.workingSetBytes);
  close(reused.l1HitRate, expectedL1);
  const bigger = getWorkloadPerformance({l1: 2, l2: 2}, 'gemm');
  assert.ok(bigger.hitRate > reused.hitRate);
  assert.ok(bigger.features.externalBytes < reused.features.externalBytes);
});

test('DRAM and HBM add actual service capacity, not final throughput multipliers', () => {
  const host = getWorkloadPerformance({}, 'stream');
  const dram = getWorkloadPerformance({dram: 1}, 'stream');
  const hbm = getWorkloadPerformance({dram: 1, hbm: 1}, 'stream');
  assert.equal(host.computeCycles, dram.computeCycles);
  assert.equal(dram.computeCycles, hbm.computeCycles);
  assert.equal(dram.features.externalBandwidth, 16);
  assert.equal(hbm.features.externalBandwidth, 144);
  assert.ok(dram.memoryCycles < host.memoryCycles);
  assert.ok(hbm.memoryCycles < dram.memoryCycles);
  assert.ok(hbm.latencyCycles < dram.latencyCycles);
  assert.ok(hbm.throughput / dram.throughput < hbm.features.externalBandwidth / dram.features.externalBandwidth);
});

test('extra ALUs and clock meet finite-work and memory ceilings', () => {
  for (const kind of KINDS) {
    let previous = 0;
    for (const count of [1, 2, 4, 8, 16, 32, 64]) {
      const result = getWorkloadPerformance({alu: count - 1}, kind);
      assert.ok(result.throughput >= previous);
      assert.equal(result.features.aluCount, count);
      previous = result.throughput;
    }
  }
  const stream32 = getWorkloadPerformance({alu: 31}, 'stream');
  const stream64 = getWorkloadPerformance({alu: 63}, 'stream');
  assert.equal(stream64.bottleneck, 'bandwidth');
  assert.ok(stream64.throughput / stream32.throughput < 1.1);
  const clocked = getWorkloadPerformance({clock: 8}, 'stream');
  assert.equal(clocked.memoryCycles, getWorkloadPerformance({}, 'stream').memoryCycles);
  assert.ok(clocked.throughput < clocked.features.clock);
  assert.ok(getWorkloadPerformance({hbm: 4, dram: 4}, 'gemm').bottleneck === 'compute');
});

test('scheduler changes outstanding requests and residual latency, not math capacity', () => {
  const before = getWorkloadPerformance({dram: 1}, 'stream');
  const scheduled = getWorkloadPerformance({dram: 1, scheduler: 2}, 'stream');
  assert.equal(before.computeCycles, scheduled.computeCycles);
  assert.equal(before.memoryCycles, scheduled.memoryCycles);
  assert.ok(scheduled.features.residentRequests > before.features.residentRequests);
  assert.ok(scheduled.latencyCycles < before.latencyCycles);
  assert.ok(scheduled.features.residentRequests <= WORKLOADS.stream.independentRequests);
  const maximal = getWorkloadPerformance(LEVELS, 'fp32');
  assert.equal(maximal.features.residentRequests, WORKLOADS.fp32.independentRequests);
});

test('Tensor Core changes matrix issue capacity without accelerating scalar math', () => {
  const base = getWorkloadPerformance({alu: 7, dram: 1}, 'gemm');
  const tensor = getWorkloadPerformance({alu: 7, dram: 1, tensor: 1}, 'gemm');
  assert.ok(tensor.computeCycles < base.computeCycles);
  assert.equal(tensor.memoryCycles, base.memoryCycles);
  assert.ok(tensor.features.tensorOperations > 0);
  assert.equal(getWorkloadPerformance({tensor: 1}, 'fp32').throughput, 1);
  assert.equal(getWorkloadPerformance({tensor: 1}, 'stream').throughput, 1);
});

test('TMA overlaps existing work while TMEM reduces only bounded accumulator spills', () => {
  const baseLevels = {...NEAR_FRONTIER, tma: 0, tmem: 0};
  const base = getWorkloadPerformance(baseLevels, 'async');
  const tma = getWorkloadPerformance({...baseLevels, tma: 1}, 'async');
  assert.equal(tma.computeCycles, base.computeCycles);
  assert.equal(tma.memoryCycles, base.memoryCycles);
  assert.equal(tma.latencyCycles, base.latencyCycles);
  assert.ok(tma.overlap > base.overlap);
  assert.ok(tma.cycles < base.cycles);
  assert.ok(tma.cycles >= Math.max(tma.computeCycles, tma.memoryCycles));
  const attention = getWorkloadPerformance(baseLevels, 'attention');
  const tmem = getWorkloadPerformance({...baseLevels, tmem: 1}, 'attention');
  assert.equal(tmem.computeCycles, attention.computeCycles);
  assert.ok(tmem.features.trafficBytes < attention.features.trafficBytes);
  assert.ok(tmem.features.retainedAccumulatorBytes < WORKLOADS.attention.accumulatorBytes);
  assert.ok(tmem.features.trafficBytes >= WORKLOADS.attention.bytes - WORKLOADS.attention.accumulatorBytes);
  assert.equal(getWorkloadPerformance({tmem: 4}, 'fp32').throughput, 1);
});

test('every upgrade is monotone throughout representative one-ALU to frontier architectures', () => {
  for (const levels of [{}, {alu: 7, l1: 1, dram: 1}, NEAR_FRONTIER, {...LEVELS, alu: 62, l1: 3, l2: 3, hbm: 3, tmem: 3}]) {
    for (const kind of KINDS) {
      const before = getWorkloadPerformance(levels, kind);
      for (const [id, cap] of Object.entries(LEVELS)) {
        if ((levels[id] || 0) >= cap) continue;
        const after = getWorkloadPerformance({...levels, [id]: (levels[id] || 0) + 1}, kind);
        assert.ok(after.throughput + 1e-10 >= before.throughput, `${kind}: ${id} improves or preserves service`);
      }
    }
  }
});

test('invalid architectures are bounded, pure and cached results cannot be corrupted', () => {
  const corrupt = {alu: Infinity, clock: -8, l1: NaN, tensor: '100', hbm: null};
  const original = {...corrupt};
  assert.equal(getWorkloadPerformance(corrupt, 'missing').throughput, 1);
  assert.deepEqual(corrupt, original);
  const bounded = getWorkloadPerformance({alu: 1e99, hbm: 1e99}, 'gemm');
  assert.equal(bounded.features.aluCount, 64);
  assert.equal(bounded.features.externalBandwidth, 512);
  assert.ok(Number.isFinite(bounded.throughput));
  assert.ok(Object.isFrozen(bounded));
  assert.ok(Object.isFrozen(bounded.features));
  assert.throws(() => { bounded.throughput = 1e99; }, TypeError);
  assert.equal(getWorkloadPerformance(null, null).throughput, 1);
});
