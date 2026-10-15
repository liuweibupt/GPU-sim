/**
 * An analytical teaching model, not a silicon predictor. All capacities, work
 * sizes and latencies below are explicit fictional parameters in logical units.
 * No benchmark was measured and no regression/XGBoost model was trained.
 */
export const MODEL_INFO = Object.freeze({
  id: 'analytical-compute-memory', version: 1,
  description: '有限并行计算 + 分层存储流量 + 延迟隐藏 + 计算/搬运重叠的解析教学模型。',
  limitations: Object.freeze(['参数为公开的游戏教学假设，未用真实 GPU 测量标定。', '吞吐按每种任务的裸 ALU 基线归一化，不能跨任务比较真实 FLOPS。', '不预测实际芯片、CUDA 内核、精度误差、互联、能耗或 PipeWeave/XGBoost 结果。']),
  units: 'logical cycles, operations and bytes; normalized service work / second',
});

// Work describes a representative service tile, not an actual model or GPU.
export const WORKLOADS = Object.freeze({
  fp32: Object.freeze({name: 'FP32 浮点', operations: 256, bytes: 1024, accumulatorBytes: 0, workingSetBytes: 65536, reuse: .7, matrixShare: 0, independentRequests: 8, dependentLoads: 1, asyncShare: 0}),
  stream: Object.freeze({name: '流式归约', operations: 256, bytes: 4096, accumulatorBytes: 0, workingSetBytes: 1048576, reuse: .12, matrixShare: 0, independentRequests: 64, dependentLoads: 4, asyncShare: .1}),
  conv: Object.freeze({name: '图像卷积', operations: 8192, bytes: 4096, accumulatorBytes: 1024, workingSetBytes: 98304, reuse: 8, matrixShare: .9, independentRequests: 32, dependentLoads: 2, asyncShare: .2}),
  gemm: Object.freeze({name: '矩阵乘法', operations: 16384, bytes: 4096, accumulatorBytes: 2048, workingSetBytes: 131072, reuse: 16, matrixShare: .995, independentRequests: 32, dependentLoads: 1, asyncShare: .8}),
  async: Object.freeze({name: '异步 Tile', operations: 16384, bytes: 8192, accumulatorBytes: 4096, workingSetBytes: 262144, reuse: 8, matrixShare: .995, independentRequests: 64, dependentLoads: 4, asyncShare: .95}),
  attention: Object.freeze({name: '长序列注意力', operations: 32768, bytes: 16384, accumulatorBytes: 12288, workingSetBytes: 524288, reuse: 12, matrixShare: .998, independentRequests: 64, dependentLoads: 4, asyncShare: .85}),
});

const LEVEL_CAPS = {alu: 63, clock: 8, l1: 4, dram: 4, l2: 4, scheduler: 4, tensor: 6, hbm: 4, tma: 4, tmem: 4};
const IDS = Object.keys(LEVEL_CAPS);
const EMPTY = Object.fromEntries(IDS.map(id => [id, 0]));
const CACHE = new Map();
const clamp = (number, low, high) => Math.min(high, Math.max(low, number));
const level = (levels, id) => typeof levels?.[id] === 'number' && Number.isFinite(levels[id]) ? Math.floor(clamp(levels[id], 0, LEVEL_CAPS[id])) : 0;

function calculate(levels, kind) {
  const work = WORKLOADS[kind];
  const aluCount = 1 + levels.alu;
  const clock = 1 + .35 * levels.clock;
  const vectorIssue = aluCount * clock;
  const matrixIssue = (aluCount + 256 * levels.tensor) * clock;
  const tensorOps = levels.tensor ? work.operations * work.matrixShare : 0;
  const scalarOps = work.operations - tensorOps;
  // The launch/setup is serial. Each instruction group must fit a whole issue
  // slot, which prevents infinite speedup from fractional operation batches.
  const computeCycles = (2 + Math.ceil(scalarOps / aluCount) + (tensorOps ? Math.ceil(tensorOps / (aluCount + 256 * levels.tensor)) : 0)) / clock;

  const l1CapacityBytes = levels.l1 * 32768;
  const l2CapacityBytes = levels.l2 * 262144;
  const reuseOpportunity = work.reuse / (1 + work.reuse);
  const l1HitRate = reuseOpportunity * l1CapacityBytes / (l1CapacityBytes + work.workingSetBytes);
  const conditionalL2HitRate = reuseOpportunity * l2CapacityBytes / (l2CapacityBytes + work.workingSetBytes);
  const l2HitRate = (1 - l1HitRate) * conditionalL2HitRate;
  const hitRate = l1HitRate + l2HitRate;

  // TMEM supplies a bounded on-chip home for accumulators, reducing spills.
  // It cannot remove compulsory tensor inputs or improve ordinary FP32 traffic.
  const tmemCapacityBytes = levels.tmem * 4096;
  const retainedAccumulatorBytes = work.accumulatorBytes * tmemCapacityBytes / Math.max(1, tmemCapacityBytes + work.accumulatorBytes);
  const trafficBytes = work.bytes - retainedAccumulatorBytes;
  const l1Bytes = trafficBytes * l1HitRate;
  const l2Bytes = trafficBytes * l2HitRate;
  const externalBytes = trafficBytes * (1 - hitRate);
  // Aggregate on-chip ports exceed installed off-chip channels. This preserves
  // a hierarchy: a cache hit never sends bytes to a slower path than a miss.
  const l1Bandwidth = 4096 * Math.max(1, levels.l1);
  const l2Bandwidth = 1024 * Math.max(1, levels.l2);
  // With no board memory, clients feed the ALU over a one-byte/cycle host link.
  // DRAM and HBM are independent installed channel capacities, added in parallel.
  const externalBandwidth = levels.dram || levels.hbm ? 16 * levels.dram + 128 * levels.hbm : 1;
  const memoryCycles = l1Bytes / l1Bandwidth + l2Bytes / l2Bandwidth + externalBytes / externalBandwidth;

  const externalLatency = levels.hbm ? 14 : levels.dram ? 20 : 80;
  const meanAccessLatency = l1HitRate + 4 * l2HitRate + (1 - hitRate) * externalLatency;
  const residentRequests = Math.min(work.independentRequests, 1 + .35 * levels.alu + 2 * levels.scheduler);
  const latencyCycles = work.dependentLoads * meanAccessLatency / residentRequests;
  const overlap = Math.min(.92, (levels.dram || levels.hbm ? .1 : 0) + .08 * levels.scheduler + .65 * (1 - Math.exp(-levels.tma)) * work.asyncShare);
  const overlapCycles = overlap * Math.min(computeCycles, memoryCycles);
  const cycles = computeCycles + memoryCycles - overlapCycles + latencyCycles;
  const bottleneck = latencyCycles > Math.max(computeCycles, memoryCycles) ? 'latency' : computeCycles >= memoryCycles ? 'compute' : 'bandwidth';
  return {cycles, computeCycles, memoryCycles, latencyCycles, overlap, overlapCycles, hitRate, l1HitRate, l2HitRate, bottleneck,
    arithmeticIntensity: work.operations / trafficBytes,
    features: Object.freeze({aluCount, clock, vectorIssue, matrixIssue, tensorUnits: levels.tensor,
      operations: work.operations, scalarOperations: scalarOps, tensorOperations: tensorOps,
      bytes: work.bytes, trafficBytes, retainedAccumulatorBytes, workingSetBytes: work.workingSetBytes,
      l1CapacityBytes, l2CapacityBytes, tmemCapacityBytes, l1Bandwidth, l2Bandwidth,
      externalBandwidth, externalLatency, meanAccessLatency, l1Bytes, l2Bytes, externalBytes, residentRequests,
      reuseOpportunity, independentRequests: work.independentRequests}),
  };
}

const BASELINES = Object.fromEntries(Object.keys(WORKLOADS).map(kind => [kind, calculate(EMPTY, kind).cycles]));

/** Returns an immutable decomposition. Invalid inputs safely use bare hardware. */
export function getWorkloadPerformance(rawLevels = {}, rawKind = 'fp32') {
  const kind = Object.hasOwn(WORKLOADS, rawKind) ? rawKind : 'fp32';
  const levels = {};
  let key = kind;
  for (const id of IDS) { const value = level(rawLevels, id); levels[id] = value; key += `,${value}`; }
  if (CACHE.has(key)) return CACHE.get(key);
  const result = calculate(levels, kind);
  const performance = Object.freeze({kind, ...result, throughput: BASELINES[kind] / result.cycles,
    baselineCycles: BASELINES[kind], modelId: MODEL_INFO.id, modelVersion: MODEL_INFO.version});
  if (CACHE.size >= 1024) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(key, performance);
  return performance;
}
