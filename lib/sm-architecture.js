/**
 * Shared source of truth for the Hopper SM teaching model and its renderer.
 * Public counts are separate from model pipeline stages and model timing.
 * PTX describes observable semantics, not the proprietary physical netlist.
 */
const EVIDENCE = ['public-architecture', 'isa-semantics', 'teaching-model'];
const LINK_TYPES = ['control', 'instruction', 'operand', 'memory', 'completion'];
const references = [
  {id: 'hopper-blog', title: 'NVIDIA Hopper Architecture In-Depth', url: 'https://developer.nvidia.com/blog/nvidia-hopper-architecture-in-depth/', scope: 'H100 SM block diagram and public execution-unit counts'},
  {id: 'hopper-sm-diagram', title: 'NVIDIA GH100 SM block diagram, Figure 4', url: 'https://developer-blogs.nvidia.com/wp-content/uploads/2022/03/H100-Streaming-Multiprocessor-SM-625x869.png', scope: 'Four partitions, schedulers, dispatch, register files, arithmetic units, TMA, unified L1/shared memory and texture blocks'},
  {id: 'hopper-tuning', title: 'NVIDIA Hopper Tuning Guide, CUDA 13.0.3', url: 'https://docs.nvidia.com/cuda/archive/13.0.3/hopper-tuning-guide/index.html', scope: 'Occupancy, TMA and unified L1/shared-memory capacities'},
  {id: 'ptx-isa', title: 'NVIDIA PTX ISA, CUDA 12.8.1', url: 'https://docs.nvidia.com/cuda/archive/12.8.1/parallel-thread-execution/index.html', scope: 'Registers, memory state spaces, asynchronous copies, mbarrier and WGMMA semantics'},
  {id: 'cuda-best-practices', title: 'CUDA C++ Best Practices Guide · Shared Memory and Memory Banks', url: 'https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/index.html#shared-memory-and-memory-banks', scope: '32 banks, successive 32-bit words, conflicts and same-address broadcast'},
];
const ports = (inputs, outputs) => ({
  inputs: inputs.map(([name, type]) => ({name, type})),
  outputs: outputs.map(([name, type]) => ({name, type})),
});
const timing = (latencyCycles = 1, initiationIntervalCycles = 1, capacity = 1, queueCapacity = 8) => ({
  latencyCycles, initiationIntervalCycles, capacity, queueCapacity,
  evidenceClass: 'teaching-model', unit: 'model-cycle',
  note: '可调教学参数；不是测量或 NVIDIA 公布的指令延迟、端口数与吞吐。',
});
const commonState = [
  {name: 'queue', type: 'FIFO<Token>', initial: [], meaning: '已接收、等待服务的 token；不含正在执行的 token'},
  {name: 'inflight', type: 'Map<TokenId,CompletionCycle>', initial: {}, meaning: '已开始、尚未完成的 token'},
  {name: 'nextAcceptCycle', type: 'nonnegative-cycle', initial: 0, meaning: '起始间隔约束允许下次启动的周期'},
];
const commonTransitions = [{
  name: 'accept', status: 'specification-contract', guard: 'ready(token,t) && |Q| < queueCapacity',
  effect: 'Q := Q ++ [token]', release: '接收仅占队列槽；完成依赖尚未满足',
}, {
  name: 'start', status: 'specification-contract', guard: 'Q != [] && t >= nextAcceptCycle && |inflight| < capacity && operandsReady(head(Q))',
  effect: 'token := pop(Q); inflight[token.id] := t + latency(token); nextAcceptCycle := t + initiationIntervalCycles',
  release: '开始后释放队列槽；执行槽直到 complete 才释放',
}, {
  name: 'complete', status: 'specification-contract', guard: 'inflight[token.id] <= t && downstreamCanAccept(token)',
  effect: 'emit(token); delete inflight[token.id]', release: '释放执行槽并通知真实依赖；背压时保留结果',
}];
const commonInvariants = [
  '0 <= |Q| <= queueCapacity', '0 <= |inflight| <= capacity',
  '同一 token 在本组件至多完成一次', '完成周期 >= 启动周期；源 trace 的时间戳不由此定义改写',
];
function component(localId, label, scope, type, group, purpose, io, options = {}) {
  return {
    localId, label, scope, type, kind: 'sm-component', group,
    instances: scope === 'partition' ? 4 : 1,
    purpose, ports: io, simulationCoverage: options.simulationCoverage ?? 'executable',
    simulationCoverageNote: 'executable表示组件部分语义和时序可执行；timing-only只有教学服务时序，未实现完整功能；structural-only无活动。全部状态/端口/规范不等于已经实现，当前规则覆盖见trace.meta.modelCoverage。',
    stateFields: [...commonState, ...(options.stateFields ?? [])],
    resources: options.resources ?? {}, timing: options.timing ?? timing(),
    transitions: options.transitions ?? commonTransitions,
    invariants: [...commonInvariants, ...(options.invariants ?? [])],
    evidenceClass: options.evidenceClass ?? 'teaching-model',
    referenceIds: options.referenceIds ?? ['ptx-isa'],
    physicalNote: options.physicalNote ?? '逻辑教学组件；其独立物理布局、队列深度与逐周期时序未由 NVIDIA 公开。',
    backendMapping: {strategy: 'explicit-component-or-stage-only', aliases: [localId], evidenceRequired: true},
  };
}
const insn = [['instruction', 'instruction']];
const insnOut = [['instruction', 'instruction']];
const unitInputs = [['instruction', 'instruction'], ['operands', 'operand']];
const unitOutputs = [['result', 'operand'], ['complete', 'completion']];
const publicPartition = {evidenceClass: 'public-architecture', referenceIds: ['hopper-sm-diagram'], physicalNote: 'NVIDIA 官方 SM 图显示分区归属；图中块不等同于教学队列或微操作时序。'};
const components = [
  component('icache', 'L1 Instruction Cache · 指令缓存', 'sm', 'instruction-cache', 'frontend',
    '缓存 SM 指令流，向各分区 L0 指令缓存提供指令；不存放 kernel 的普通数据。',
    ports([['fetch', 'control'], ['fill', 'memory']], [['instruction', 'instruction'], ['miss', 'memory']]),
    {...publicPartition, simulationCoverage: 'timing-only', resources: {capacityBytes: null, capacityEvidence: 'not-publicly-specified'}}),
  component('l0-icache', 'L0 Instruction Cache', 'partition', 'instruction-cache', 'frontend',
    '分区本地指令缓存；当前保留refill/取指接口，不执行指令缓存命中缺失仿真，不猜测真实行大小和组相联度。',
    ports([['instruction', 'instruction'], ['fetch', 'control']], [['instruction', 'instruction'], ['refill', 'control']]),
    {...publicPartition, simulationCoverage: 'timing-only', resources: {capacityBytes: null}}),
  component('fetch', 'Fetch · 取指', 'partition', 'pipeline-stage', 'frontend',
    '按 warp PC 产生取指 token，并保持每个 warp 的程序顺序。',
    ports([['instruction', 'instruction'], ['pc', 'control']], [['instruction', 'instruction'], ['request', 'control']]),
    {stateFields: [{name: 'warpPC', type: 'Map<WarpId,PC>', initial: {}, meaning: '教学 warp 的下一条指令位置'}]}),
  component('decode', 'Decode · 译码', 'partition', 'pipeline-stage', 'frontend',
    '把教学 opcode 解析为执行类别、源/目标寄存器、地址空间和异步同步要求。', ports(insn, insnOut)),
  component('warp-scheduler', 'Warp Scheduler · warp 调度', 'partition', 'scheduler', 'frontend',
    '从本分区驻留 warp 中选择依赖、同步及有限 credit 均满足的候选者；教学策略为轮询 eligible warp。驻留不等于当前周期发射。',
    ports([['instruction', 'instruction'], ['readiness', 'control']], [['candidate', 'instruction'], ['query', 'control']]),
    {...publicPartition, resources: {hardwareSchedulersPerInstance: 1, hardwareThreadsPerScheduledWarp: 32},
      stateFields: [{name: 'roundRobinCursor', type: 'WarpId|null', initial: null, meaning: '教学 eligible-warp 轮询位置'},
        {name: 'residentWarps', type: 'Set<WarpId>', initial: [], meaning: '已通过整CTA资源准入且尚未退场的warp，包含等待和draining'},
        {name: 'readyWarps', type: 'Set<WarpId>', initial: [], meaning: '已译码的下一条指令满足寄存器/完成/异步依赖'},
        {name: 'eligibleWarps', type: 'Set<WarpId>', initial: [], meaning: 'ready且scoreboard/TMA credit与分区issue预算可用'}],
      invariants: ['eligibleWarps ⊆ readyWarps ⊆ residentWarps', '每个issue阶段占用属于已准入CTA的warp']}),
  component('scoreboard', 'Scoreboard · 依赖表', 'partition', 'dependency-tracker', 'frontend',
    '按 warp 与寄存器记录未完成写者；阻止 RAW/WAW 与尚未完成的异步消费。',
    ports([['query', 'control'], ['reserve', 'control'], ['complete', 'completion']], [['readiness', 'control']]),
    {stateFields: [{name: 'pendingWrites', type: 'Map<(WarpId,RegisterId),TokenId>', initial: {}, meaning: '寄存器尚未写回的唯一生产者'}],
      invariants: ['读源寄存器前不存在未完成写者（RAW）', '写目标寄存器前不存在更早未完成写者（WAW）', '仅匹配生产者完成后清除其 pendingWrites']}),
  component('issue', 'Issue · 发射仲裁', 'partition', 'pipeline-stage', 'frontend',
    '原子检查 scoreboard、目标执行资源和队列，发射成功时登记目标寄存器写者。',
    ports([['candidate', 'instruction'], ['readiness', 'control']], [['instruction', 'instruction'], ['reserve', 'control']]),
    {invariants: ['未满足 ready/issue 谓词的 token 不得发射', '登记写者与提交发射必须是同一个原子步骤']}),
  component('dispatch', 'Dispatch · 指令分派', 'partition', 'dispatcher', 'frontend',
    '将已发射的指令送往所需的执行路径；异步 TMA、普通访存与算术走不同目的地。',
    ports(insn, [['instruction', 'instruction'], ['read', 'control'], ['barrier', 'control']]), publicPartition),
  component('register-file', 'Register File · 寄存器堆', 'partition', 'register-file', 'operands',
    '保存线程寄存器/累加器；提供源操作数并接收写回。寄存器容量与读写端口能力分别描述。',
    ports([['read', 'control'], ['write', 'operand']], [['operands', 'operand']]),
    {...publicPartition, resources: {registers32Bit: 16384, capacityBytes: 65536, readPorts: null, writePorts: null},
      stateFields: [{name: 'allocatedRegisters', type: 'nonnegative-integer', initial: 0, meaning: '驻留 warp/CTA 占用的32位寄存器数量'}],
      invariants: ['allocatedRegisters <= 16384；寄存器分配粒度未建模']}),
  component('operand-collector', 'Operand Collector · 操作数收集', 'partition', 'operand-collector', 'operands',
    '收齐寄存器、立即数和需要的 SMEM 操作数后，才把 token 交给执行单元。',
    ports([['instruction', 'instruction'], ['operands', 'operand']], [['instruction', 'instruction'], ['operands', 'operand']]),
    {stateFields: [{name: 'readyOperands', type: 'Map<TokenId,Set<OperandId>>', initial: {}, meaning: '已收齐的源操作数'}],
      invariants: ['仅全部必需源操作数就绪后向执行单元传递']}),
  component('fp32', 'FP32 / FPU · 32位浮点', 'partition', 'execution-unit', 'execution',
    '执行普通 FP32 算术/FMA；不是 Tensor Core 的矩阵运算路径。', ports(unitInputs, unitOutputs),
    {...publicPartition, resources: {hardwareLanes: 32, precision: 'FP32'}, timing: timing(6, 1, 8)}),
  component('fp64', 'FP64 / DFPU · 64位浮点', 'partition', 'execution-unit', 'execution',
    '执行普通双精度算术；FP64 Tensor MMA 是另一个 opcode 路径。', ports(unitInputs, unitOutputs),
    {...publicPartition, resources: {hardwareLanes: 16, precision: 'FP64'}, timing: timing(10, 2, 8)}),
  component('int32', 'INT32 / ALU · 整数', 'partition', 'execution-unit', 'execution',
    '执行整数、位运算和地址计算类指令；DPX 在此作为单独 opcode 类别，未推断独立 DPX 物理单元。', ports(unitInputs, unitOutputs),
    {...publicPartition, resources: {hardwareLanes: 16, precision: 'INT32', supportsDpxOpcodes: true}, timing: timing(4, 1, 8)}),
  component('sfu', 'SFU · 特殊函数', 'partition', 'execution-unit', 'execution',
    '执行特殊函数类别，例如近似倒数/平方根/指数；具体编译后的多指令序列由详细后端提供。', ports(unitInputs, unitOutputs),
    {...publicPartition, resources: {hardwareScalarLaneCount: null}, timing: timing(12, 4, 4)}),
  component('tensor', 'Tensor Core · 四代矩阵单元', 'partition', 'execution-unit', 'execution',
    '执行 MMA 教学 token。寄存器 MMA 与异步 WGMMA 的操作数/完成语义必须区分。',
    ports([...unitInputs, ['sharedOperands', 'operand'], ['asyncReady', 'control']], [...unitOutputs, ['sharedRead', 'control']]),
    {...publicPartition, resources: {hardwareTensorCores: 1, generation: 4, precision: ['FP8', 'FP16', 'BF16', 'TF32', 'FP64', 'INT8']}, timing: timing(24, 8, 4), referenceIds: ['hopper-blog', 'hopper-sm-diagram', 'ptx-isa'],
      invariants: ['WGMMA 需要四个连续 warp 的协作且满足其 fence/commit/wait 规则', 'WGMMA 的 B 来自 SMEM；A 可来自 RF 或 SMEM；不强制所有 MMA 经 SMEM', '教学单 warp MMA 不得伪称真实 WGMMA 执行轨迹']}),
  component('lsu', 'LSU / LD-ST · 地址与访存', 'partition', 'load-store-unit', 'memory',
    '计算/接收地址，按地址空间将请求分流到 L1、SMEM 或只读路径，并跟踪 load 返回。',
    ports([...unitInputs, ['return', 'memory']], [...unitOutputs, ['request', 'memory']]),
    {...publicPartition, resources: {physicalPortCount: null, transactionBytes: 32, transactionSizeEvidence: 'teaching-model'}, timing: timing(3, 1, 8),
      stateFields: [{name: 'pendingRequests', type: 'Map<RequestId,TokenId>', initial: {}, meaning: '尚未返回的合并内存请求'}],
      invariants: ['一个 warp load 可产生多个 transaction；不能把整个 warp 固定画成一个 cache-line 请求', 'global load 不自动写入 SMEM；shared load 不自动访问 L1/HBM']}),
  component('branch', 'Branch / Reconvergence · 分支与汇合', 'partition', 'control-flow', 'execution',
    '更新教学 warp PC 与活动掩码；显式表达控制流语义，不声称 Hopper 使用某个特定重汇合栈。',
    ports(unitInputs, [...unitOutputs, ['pc', 'control']]),
    {simulationCoverage: 'timing-only', stateFields: [{name: 'activeMask', type: 'uint32-by-warp', initial: {}, meaning: '教学 SIMT 路径的活动线程掩码，当前控制类服务不执行真实PC/掩码更新'}], timing: timing(3, 1, 4)}),
  component('writeback', 'Writeback / Complete · 写回完成', 'partition', 'pipeline-stage', 'completion',
    '结果写入寄存器后释放 scoreboard；异步事务完成用独立完成 token 表达。',
    ports([['result', 'operand'], ['complete', 'completion']], [['write', 'operand'], ['release', 'completion']]),
    {invariants: ['寄存器写回及其 scoreboard 释放保持因果顺序', '无寄存器结果的 store/TMA 不制造虚假 RF 写回']}),
  component('l1-cache', 'L1 Data / Texture Cache · 数据缓存', 'sm', 'data-cache', 'memory',
    '为普通 global/local 数据访问提供缓存；L1 miss 经 NoC/L2 接口请求数据；与 SMEM 共享物理容量预算。',
    ports([['request', 'memory'], ['fill', 'memory']], [['response', 'memory'], ['miss', 'memory']]),
    {evidenceClass: 'public-architecture', referenceIds: ['hopper-tuning', 'hopper-sm-diagram'], resources: {physicalResource: 'unified-l1-smem', capacityBytes: null, unifiedCapacityBytes: 262144, cacheLineBytes: null}, timing: timing(12, 1, 16),
      stateFields: [{name: 'residentLines', type: 'Set<LineAddress>', initial: [], meaning: '教学缓存已驻留行'}, {name: 'pendingMisses', type: 'Map<LineAddress,RequestId[]>', initial: {}, meaning: '教学缺失合并队列'}],
      invariants: ['L1 与 SMEM 是不同寻址/一致性语义，容量不得分别都计为256 KiB']}),
  component('shared-memory', 'SMEM · 显式共享存储', 'sm', 'shared-memory', 'memory',
    '由 CTA 显式分配与寻址；接收普通 shared 访问、TMA 数据写入以及 Tensor 共享操作数读取。',
    ports([['request', 'memory'], ['tmaData', 'memory'], ['tensorRead', 'control']], [['response', 'memory'], ['operands', 'operand'], ['committed', 'completion']]),
    {evidenceClass: 'public-architecture', referenceIds: ['hopper-tuning', 'ptx-isa', 'cuda-best-practices'], resources: {physicalResource: 'unified-l1-smem', maxCapacityBytes: 233472, perCtaMaxBytes: 232448, reservedBytesPerCta: 1024, supportedCarveoutKiB: [0, 8, 16, 32, 64, 100, 132, 164, 196, 228], banks: 32, bankWidthBytes: 4, bankOrganizationEvidence: 'cuda-programming-semantics'}, timing: timing(8, 1, 16),
      stateFields: [{name: 'tileReady', type: 'Map<(CTAId,BufferId,Phase),boolean>', initial: {}, meaning: '已完成写入并满足同步条件的 tile'}, {name: 'allocatedBytes', type: 'nonnegative-integer', initial: 0, meaning: '已分配SMEM容量'}],
      invariants: ['allocatedBytes <= selectedCarveoutBytes <= 233472', 'CTA 最大用户共享内存227 KiB；不是256 KiB', '异步生产者完成并满足同步后消费者才能读；不靠动画位置推断就绪']}),
  component('tma', 'TMA · Tensor Memory Accelerator', 'sm', 'async-copy-engine', 'memory',
    '由指令提交描述符后异步搬运 global↔SMEM tensor 数据；教学 global→SMEM 路径绕过 RF。',
    ports([['instruction', 'instruction'], ['globalData', 'memory'], ['sharedData', 'memory'], ['committed', 'completion']], [['globalRequest', 'memory'], ['sharedWrite', 'memory'], ['expectTx', 'control'], ['completeTx', 'completion']]),
    {evidenceClass: 'public-architecture', referenceIds: ['hopper-blog', 'hopper-tuning', 'ptx-isa'], resources: {hardwareEngineCount: null, logicalEngines: 1, logicalEngineCountEvidence: 'teaching-model', maxTensorDimensions: 5, physicalQueueDepth: null}, timing: timing(4, 4, 4),
      stateFields: [{name: 'descriptors', type: 'Map<TokenId,TensorMap>', initial: {}, meaning: '教学搬运形状/地址/目标缓冲'}, {name: 'outstandingBytes', type: 'nonnegative-integer', initial: 0, meaning: '教学未完成搬运字节'}],
      invariants: ['发射完成不代表数据搬运完成', '只有真实写入SMEM后才complete_tx并使消费者可等待成功', '不把所有HBM traffic叫广播；TMA multicast仅限声明的cluster目标', '本版本不执行cluster DSM/TMA multicast或TMA store；后续接口保留']}),
  component('mbarrier', 'mbarrier · 异步事务屏障', 'sm', 'async-barrier', 'synchronization',
    '逻辑跟踪屏障对象的阶段、未到达参与者和未完成事务量；屏障对象实际存放在 SMEM。',
    ports([['arrive', 'control'], ['expectTx', 'control'], ['completeTx', 'completion']], [['ready', 'control']]),
    {evidenceClass: 'isa-semantics', referenceIds: ['ptx-isa'], resources: {physicalResource: 'shared-memory-barrier-objects', hardwareUnitCount: null}, timing: timing(1, 1, 16),
      stateFields: [{name: 'phase', type: 'nonnegative-integer', initial: 0, meaning: '逻辑屏障阶段'}, {name: 'pendingArrivals', type: 'nonnegative-integer', initial: 0, meaning: '本阶段尚未 arrive 的参与者'}, {name: 'pendingTxBytes', type: 'nonnegative-integer', initial: 0, meaning: '教学TMA以字节计量的未完成事务量'}],
      transitions: [{name: 'expect_tx', guard: 'initialized && bytes >= 0', effect: 'pendingTxBytes += bytes', release: '不释放wait者'}, {name: 'arrive', guard: 'pendingArrivals > 0', effect: 'pendingArrivals -= 1', release: '仅当pendingArrivals=0且pendingTxBytes=0时阶段完成'}, {name: 'complete_tx', guard: '0 <= bytes <= pendingTxBytes && sharedWriteCommitted', effect: 'pendingTxBytes -= bytes', release: '仅当两个计数均归零时推进phase并唤醒匹配phase等待者'}],
      invariants: ['pendingArrivals >= 0 && pendingTxBytes >= 0', 'phase只在所有到达与事务完成条件同时满足时推进', '该节点表示逻辑mbarrier对象/操作；不是独立物理芯片组件']}),
  component('texture', 'Texture · 纹理/只读访问', 'sm', 'texture-unit', 'memory',
    '保留官方 SM 图中的纹理访问块，使用统一 L1/Texture 缓存。当前教学程序没有纹理指令时不制造活动。',
    ports([['request', 'memory'], ['response', 'memory']], [['cacheRequest', 'memory'], ['result', 'memory']]),
    {evidenceClass: 'public-architecture', simulationCoverage: 'structural-only', referenceIds: ['hopper-sm-diagram', 'hopper-tuning'], resources: {hardwareTextureBlocksShown: 4}, timing: timing(16, 4, 4)}),
  component('constant-cache', 'Constant Cache · 常量只读路径', 'sm', 'constant-cache', 'memory',
    '表达PTX常量空间只读缓存语义；Hopper精确物理分区和容量未在本规格中断言。',
    ports([['request', 'memory'], ['fill', 'memory']], [['response', 'memory'], ['miss', 'memory']]),
    {evidenceClass: 'isa-semantics', simulationCoverage: 'structural-only', referenceIds: ['ptx-isa'], resources: {physicalCount: null, capacityBytes: null}, timing: timing(8, 1, 8)}),
  component('noc-interface', 'NoC / L2 Interface · SM边界', 'sm', 'memory-interface', 'memory',
    '将SM内部的缓存缺失/TMA请求与外部NoC/L2模型连接；L2和HBM不属于SM内部。',
    ports([['request', 'memory'], ['return', 'memory']], [['outbound', 'memory'], ['inbound', 'memory']]),
    {resources: {physicalPortCount: null}, timing: timing(1, 1, 16)}),
];

function link(source, sourcePort, target, targetPort, type, label, expansion = 'each-partition', evidenceClass = 'teaching-model') {
  return {source, sourcePort, target, targetPort, type, label, expansion, evidenceClass};
}
const links = [
  link('icache', 'instruction', 'l0-icache', 'instruction', 'instruction', 'L1I → 分区L0I'),
  link('l0-icache', 'refill', 'icache', 'fetch', 'control', 'L0 refill'),
  link('l0-icache', 'instruction', 'fetch', 'instruction', 'instruction', 'instruction bytes'),
  link('fetch', 'request', 'l0-icache', 'fetch', 'control', 'warp PC取指'),
  link('fetch', 'instruction', 'decode', 'instruction', 'instruction', '取指 → 译码'),
  link('decode', 'instruction', 'warp-scheduler', 'instruction', 'instruction', 'decoded candidate'),
  link('warp-scheduler', 'query', 'scoreboard', 'query', 'control', '依赖查询'),
  link('scoreboard', 'readiness', 'warp-scheduler', 'readiness', 'control', 'ready warp'),
  link('warp-scheduler', 'candidate', 'issue', 'candidate', 'instruction', 'candidate instruction'),
  link('scoreboard', 'readiness', 'issue', 'readiness', 'control', 'issue predicate'),
  link('issue', 'reserve', 'scoreboard', 'reserve', 'control', 'reserve destinations'),
  link('issue', 'instruction', 'dispatch', 'instruction', 'instruction', 'issued instruction'),
  link('dispatch', 'read', 'register-file', 'read', 'control', 'source register addresses'),
  link('register-file', 'operands', 'operand-collector', 'operands', 'operand', 'RF operands'),
  link('dispatch', 'instruction', 'operand-collector', 'instruction', 'instruction', 'collect operands'),
  ...['fp32', 'fp64', 'int32', 'sfu', 'tensor', 'lsu', 'branch'].flatMap(id => [
    link('operand-collector', 'instruction', id, 'instruction', 'instruction', `opcode → ${id}`),
    link('operand-collector', 'operands', id, 'operands', 'operand', `operands → ${id}`),
    link(id, 'result', 'writeback', 'result', 'operand', `${id} result`),
    link(id, 'complete', 'writeback', 'complete', 'completion', `${id} completion`),
  ]),
  link('branch', 'pc', 'fetch', 'pc', 'control', 'branch next PC/mask'),
  link('writeback', 'write', 'register-file', 'write', 'operand', 'register write'),
  link('writeback', 'release', 'scoreboard', 'complete', 'completion', 'release destination hazard'),
  link('lsu', 'request', 'l1-cache', 'request', 'memory', 'global/local request'),
  link('l1-cache', 'response', 'lsu', 'return', 'memory', 'ordinary load data'),
  link('lsu', 'request', 'shared-memory', 'request', 'memory', 'shared-space request'),
  link('shared-memory', 'response', 'lsu', 'return', 'memory', 'shared load data'),
  link('lsu', 'request', 'constant-cache', 'request', 'memory', 'constant-space request'),
  link('constant-cache', 'response', 'lsu', 'return', 'memory', 'constant data'),
  link('lsu', 'request', 'texture', 'request', 'memory', 'texture request'),
  link('texture', 'result', 'lsu', 'return', 'memory', 'texture data'),
  link('dispatch', 'instruction', 'tma', 'instruction', 'instruction', 'TMA descriptor command'),
  link('shared-memory', 'operands', 'tensor', 'sharedOperands', 'operand', 'MMA/WGMMA SMEM operands'),
  link('tensor', 'sharedRead', 'shared-memory', 'tensorRead', 'control', 'Tensor shared operand addresses'),
  link('mbarrier', 'ready', 'tensor', 'asyncReady', 'control', 'matching tile/phase readiness'),
  link('mbarrier', 'ready', 'warp-scheduler', 'readiness', 'control', 'wake async consumer'),
  link('dispatch', 'barrier', 'mbarrier', 'arrive', 'control', 'decoded barrier operation'),
  link('l1-cache', 'miss', 'noc-interface', 'request', 'memory', 'L1 miss → NoC/L2', 'shared'),
  link('noc-interface', 'inbound', 'l1-cache', 'fill', 'memory', 'NoC/L2 fill → L1', 'shared'),
  link('constant-cache', 'miss', 'noc-interface', 'request', 'memory', 'constant cache miss', 'shared'),
  link('noc-interface', 'inbound', 'constant-cache', 'fill', 'memory', 'constant fill', 'shared'),
  link('icache', 'miss', 'noc-interface', 'request', 'memory', 'instruction cache miss', 'shared'),
  link('noc-interface', 'inbound', 'icache', 'fill', 'memory', 'instruction fill', 'shared'),
  link('tma', 'globalRequest', 'noc-interface', 'request', 'memory', 'TMA global request; no RF payload', 'shared'),
  link('noc-interface', 'inbound', 'tma', 'globalData', 'memory', 'TMA global data; no RF payload', 'shared'),
  link('tma', 'sharedWrite', 'shared-memory', 'tmaData', 'memory', 'TMA → SMEM bytes', 'shared'),
  link('shared-memory', 'committed', 'tma', 'committed', 'completion', 'SMEM write committed', 'shared'),
  link('tma', 'expectTx', 'mbarrier', 'expectTx', 'control', 'expected transfer bytes', 'shared'),
  link('tma', 'completeTx', 'mbarrier', 'completeTx', 'completion', 'complete_tx after data committed', 'shared'),
  link('texture', 'cacheRequest', 'l1-cache', 'request', 'memory', 'unified texture cache', 'shared'),
  link('l1-cache', 'response', 'texture', 'response', 'memory', 'texture cached data', 'shared'),
];

export const SM_ARCHITECTURE = {
  schemaVersion: 1, id: 'hopper-sm-educational-v1', label: 'Hopper SM · 公开结构与形式化教学模型',
  partitions: 4, evidenceClasses: EVIDENCE, linkTypes: LINK_TYPES, references,
  hardwareFacts: {
    architecture: 'Hopper', computeCapability: '9.0', gpuPreset: 'H100 SXM', gpuSmCount: 132,
    partitionsPerSm: 4, warpSchedulersPerSm: 4, fp32CoresPerSm: 128,
    fp64CoresPerSm: 64, int32CoresPerSm: 64, tensorCoresPerSm: 4,
    registers32BitPerSm: 65536, maxResidentWarpsPerSm: 64, threadsPerWarp: 32,
    maxResidentCtasPerSm: 32, unifiedL1SharedBytesPerSm: 262144,
    maxSharedBytesPerSm: 233472, maxSharedBytesPerCta: 232448, reservedSharedBytesPerCta: 1024,
    evidenceClass: 'public-architecture', referenceIds: ['hopper-blog', 'hopper-sm-diagram', 'hopper-tuning'],
  },
  formalModel: {
    state: 'S(t) = (W, R, B, M, Q, C, A); W=warp PC/active-mask, R=symbolic register availability (not numerical values), B=pending writers, M=memory/tile readiness, Q=component queues, C=resource reservations, A=async phases/counters',
    token: '{id,warpId,ctaId,pc,opcode,srcRegs,dstRegs,addressSpace,bytes,dependencies,asyncPhase}',
    ready: 'decoded(i) && allCompletionDependenciesDone(i,t) && all(srcRegs(i) ∩ pendingWrites[warp(i)] = ∅) && all(dstRegs(i) ∩ pendingWrites[warp(i)] = ∅) && barrierPhaseReady(i,t)',
    issue: 'ready(i,t) && targetQueueHasSpace(i) && t >= targetNextAcceptCycle(i) && issueBudget(partition,t) > 0',
    effect: 'atomically dequeue i; reserve destination writers; reserve target resource/queue; create causal stage and completion tokens',
    release: 'an execution slot is released only after completion; register hazards after matching writeback; async phase after arrivals=0 and tx-count=0',
    residency: 'whole-CTA FIFO admission reserves CTA/warp slots, symbolic 32-bit registers per partition and SMEM bytes; all warp instructions and async operations must complete before CTA resource release; real allocation granularity is unsupported',
    instantaneousActivity: 'resident includes blocked/draining warps; dependency-ready is a subset; eligible also has finite credits and issue budget; actual issue and inflight instruction spans are independent half-open intervals',
    timing: 'latency L is start→completion; initiation interval II constrains starts; capacity K bounds in-flight operations; queueCapacity bounds waiting tokens. L,II,K are independent model parameters.',
    contractScope: '完整规范用于实现/验证后端。默认commonTransitions是specification-contract，当前后端的已执行规则由trace.meta.modelCoverage明确声明；不因画出队列或端口就声称具有有限队列/背压仿真。',
    stallReasons: ['instruction-fetch', 'raw-dependency', 'waw-dependency', 'operand-not-ready', 'issue-bandwidth', 'unit-capacity', 'queue-full', 'register-port', 'memory-return', 'shared-bank-conflict', 'async-barrier', 'downstream-backpressure'],
    unsupported: ['proprietary physical netlist', 'validated NVIDIA cycle accuracy', 'arbitrary PTX/SASS execution', 'complete CUDA memory consistency', 'instruction-cache coherence', 'real register allocation granularity', 'independent-thread scheduling details', 'DSM and TMA multicast execution'],
  },
  physicalResources: [{id: 'unified-l1-smem', capacityBytes: 262144, maxSharedBytes: 233472,
    invariant: 'selectedSharedCarveoutBytes + effectiveDataCacheBudgetBytes <= 262144; actual cache implementation/overhead is not inferred',
    evidenceClass: 'public-architecture', referenceIds: ['hopper-tuning']}],
  components, links,
  defaultTiming: Object.fromEntries(components.map(c => [c.localId, {...c.timing}])),
};

function assert(condition, message) { if (!condition) throw new TypeError(message); }
function validateSmId(smId) { assert(Number.isSafeInteger(smId) && smId >= 0, 'smId must be a nonnegative safe integer'); }

/** Stable IDs, shared by events, renderer, inspector and backend adapters. */
export function smComponentId(smId, localId, partitionId = 0) {
  validateSmId(smId);
  const template = components.find(c => c.localId === localId);
  assert(template, `Unknown SM local component: ${localId}`);
  if (template.scope === 'sm') return `sm-${smId}/${localId}`;
  assert(Number.isInteger(partitionId) && partitionId >= 0 && partitionId < 4, 'partitionId must be 0..3');
  return `sm-${smId}/p${partitionId}/${localId}`;
}

/** Internal nodes only; caller owns the existing sm-${smId} parent node. */
export function instantiateSmComponents(smId) {
  validateSmId(smId);
  return components.flatMap(template => {
    const partitionIds = template.scope === 'partition' ? [0, 1, 2, 3] : [null];
    return partitionIds.map(partitionId => ({
      ...structuredClone(template), id: smComponentId(smId, template.localId, partitionId ?? 0),
      parentId: `sm-${smId}`, smId, ...(partitionId != null ? {partitionId} : {}),
      args: {smId, ...(partitionId != null ? {partitionId} : {}), localComponentId: template.localId,
        componentRole: template.localId, architectureId: SM_ARCHITECTURE.id, evidenceClass: template.evidenceClass},
    }));
  });
}
export const createSmComponents = instantiateSmComponents;

export function instantiateSmArchitecture(smId) {
  validateSmId(smId);
  const instantiatedLinks = links.flatMap((edge, edgeIndex) => {
    const partitions = edge.expansion === 'shared' ? [null] : [0, 1, 2, 3];
    return partitions.map(partitionId => ({
      ...edge, id: `sm-${smId}/edge-${edgeIndex}${partitionId == null ? '' : `-p${partitionId}`}`,
      source: smComponentId(smId, edge.source, partitionId ?? 0),
      target: smComponentId(smId, edge.target, partitionId ?? 0),
      ...(partitionId != null ? {partitionId} : {}),
    }));
  });
  return {schemaVersion: 1, architectureId: SM_ARCHITECTURE.id, smId,
    smComponent: {id: `sm-${smId}`, label: `SM ${smId}`, kind: 'sm', args: {smId}},
    components: instantiateSmComponents(smId), links: instantiatedLinks,
    physicalResources: structuredClone(SM_ARCHITECTURE.physicalResources),
  };
}

/** Reject broken ports/topology, unsupported counts and nonformal definitions. */
export function validateSmArchitecture(architecture = SM_ARCHITECTURE) {
  assert(architecture?.schemaVersion === 1, 'SM architecture requires schemaVersion 1');
  assert(Array.isArray(architecture.components) && Array.isArray(architecture.links), 'SM architecture requires components and links');
  const isTemplate = architecture === SM_ARCHITECTURE || architecture.components.every(c => !c.id);
  const byId = new Map();
  for (const c of architecture.components) {
    const id = isTemplate ? c.localId : c.id;
    assert(typeof id === 'string' && !byId.has(id), `Duplicate or missing SM component: ${id}`);
    byId.set(id, c);
    assert(['sm', 'partition'].includes(c.scope) && c.instances === (c.scope === 'partition' ? 4 : 1), `Invalid scope/instances: ${id}`);
    assert(typeof c.purpose === 'string' && c.purpose.length > 0, `Missing purpose: ${id}`);
    assert(EVIDENCE.includes(c.evidenceClass), `Missing evidence class: ${id}`);
    assert(['executable', 'timing-only', 'structural-only'].includes(c.simulationCoverage), `Missing simulation coverage: ${id}`);
    assert(c.referenceIds.length > 0 && c.referenceIds.every(ref => references.some(r => r.id === ref)), `Unresolved references: ${id}`);
    for (const direction of ['inputs', 'outputs']) {
      assert(Array.isArray(c.ports?.[direction]), `Missing ports: ${id}`);
      const names = new Set();
      for (const p of c.ports[direction]) {
        assert(typeof p.name === 'string' && !names.has(p.name) && LINK_TYPES.includes(p.type), `Invalid/duplicate port: ${id}.${p.name}`);
        names.add(p.name);
      }
    }
    assert(c.stateFields?.length > 0 && c.transitions?.length > 0 && c.invariants?.length > 0, `Incomplete formal definition: ${id}`);
    for (const transition of c.transitions) assert(transition.name && transition.guard && transition.effect && transition.release, `Incomplete transition: ${id}`);
    for (const key of ['latencyCycles', 'initiationIntervalCycles', 'capacity', 'queueCapacity']) {
      if (key === 'queueCapacity' && c.timing?.[key] === null) {
        assert(typeof c.timing.queueImplementation === 'string', `Unmodeled local queue requires queueImplementation: ${id}`);
        continue;
      }
      assert(Number.isInteger(c.timing?.[key]) && c.timing[key] > 0, `Invalid model timing ${key}: ${id}`);
    }
    assert(c.timing.evidenceClass === 'teaching-model', `Timing cannot masquerade as published silicon timing: ${id}`);
  }
  for (const edge of architecture.links) {
    const source = byId.get(edge.source), target = byId.get(edge.target);
    assert(source && target && LINK_TYPES.includes(edge.type), `Unresolved SM link: ${edge.source} → ${edge.target}`);
    const out = source.ports.outputs.find(p => p.name === edge.sourcePort);
    const input = target.ports.inputs.find(p => p.name === edge.targetPort);
    assert(out && input && out.type === edge.type && input.type === edge.type, `SM link port/type mismatch: ${edge.source}.${edge.sourcePort} → ${edge.target}.${edge.targetPort}`);
    if (isTemplate) {
      assert(['shared', 'each-partition'].includes(edge.expansion), 'SM link requires explicit expansion');
      assert(edge.expansion !== 'shared' || (source.scope === 'sm' && target.scope === 'sm'), 'Shared edge cannot silently select one partition');
    }
  }
  return architecture;
}

validateSmArchitecture();
