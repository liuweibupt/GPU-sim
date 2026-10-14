# SM 内部结构、端口与状态机

本项目以 **Hopper H100 SXM 的 SM** 为当前结构模板。每个 SM 都有相同的可点击组件定义，组件实例由 `lib/sm-architecture.js` 统一生成。绘图、教学仿真、事件检查器和后续详细模拟器适配器使用同一组稳定 ID，避免各自维护不一致的组件清单。

这份规格分开记录三种证据：`public-architecture` 是 NVIDIA 公开结构/容量；`isa-semantics` 是 CUDA/PTX 的可观察语义；`teaching-model` 是本项目显式选择的逻辑阶段、连接和参数。形式化端口图表示请求、操作数和同步关系，不是反向工程得到的 Hopper 物理网表。

## 1. 公开硬件边界

| 公开项目 | 每个 SM | 每分区（共4个） |
| --- | ---: | ---: |
| warp scheduler | 4 | 1 |
| FP32 CUDA core | 128 | 32 |
| FP64 算术 core | 64 | 16 |
| INT32 core | 64 | 16 |
| 第四代 Tensor Core | 4 | 1 |
| 32位寄存器 | 65,536 | 16,384 |
| 最大驻留 warp / CTA | 64 / 32 | 不据此推断固定CTA配额 |
| 统一 L1 / Texture / SMEM 物理预算 | 256 KiB | SM共享 |
| 可选择的最大 SMEM / 单CTA最大用户SMEM | 228 KiB / 227 KiB | SM共享 |

分区与算术单元的归属来自 [NVIDIA 官方 SM 图](https://developer-blogs.nvidia.com/wp-content/uploads/2022/03/H100-Streaming-Multiprocessor-SM-625x869.png)，驻留上限和存储容量来自 [Hopper Tuning Guide](https://docs.nvidia.com/cuda/archive/13.0.3/hopper-tuning-guide/index.html)。H100 SXM 配置是132个SM；完整GH100设计的144个SM、其他板卡型号与该配置须区分，见 [Hopper Architecture In-Depth](https://developer.nvidia.com/blog/nvidia-hopper-architecture-in-depth/)。

core 数量不等于 warp 指令延迟，也不等于每周期可接受任意指令的数量。TMA 在公开图中有命名块，但本规格不根据图形推断物理引擎个数、端口数或队列深度。Fetch、Decode、Issue、Scoreboard、Operand Collector、Writeback 是便于理解和验证的独立逻辑节点；公开图未承诺这些节点在硬件中具有对应的独立流水线寄存器。

当前浏览器教学运行限制为1–32个warp，默认8个；这不是H100的64个驻留warp硬件上限。TMA目标缓冲与scratch各按实际访问跨度计入SMEM预算，超出所选carveout或未覆盖LDS地址范围的参数组合会被拒绝；不通过动画虚构可用容量。

## 2. 机器可读结构

`SM_ARCHITECTURE.schemaVersion = 1`，当前模板 ID 为 `hopper-sm-educational-v1`。

```js
import {
  SM_ARCHITECTURE,
  instantiateSmArchitecture,
  instantiateSmComponents,
  smComponentId,
  validateSmArchitecture,
} from '../lib/sm-architecture.js';

const graph = instantiateSmArchitecture(0);
validateSmArchitecture(graph);
// graph.smComponent: SM父节点
// graph.components: 4×17个分区组件 + 8个SM共享组件 = 76个节点
// graph.links: 254条具有类型和端口名称的连接
smComponentId(0, 'fetch', 0);         // 'sm-0/p0/fetch'
smComponentId(131, 'tensor', 3);     // 'sm-131/p3/tensor'
smComponentId(0, 'shared-memory');   // 'sm-0/shared-memory'
```

`instantiateSmComponents(smId)` / `createSmComponents(smId)` 只返回内部节点，`parentId` 指向调用方已有的 `sm-${smId}`；`instantiateSmArchitecture(smId)` 还返回 `smComponent` 和实例连接。实例做深拷贝，编辑某个 SM 的可调配置不会改写模板或其他 SM。

| 字段 | 含义 |
| --- | --- |
| `localId`, `id`, `scope`, `partitionId` | 稳定组件角色、实例ID、SM共享/分区作用域、分区编号 |
| `label`, `type`, `group`, `purpose` | 完整标签、类型、绘图分组与功能 |
| `instances` | 模板实例数；分区组件4份，共享组件1份；不等于其内部算术lane数量 |
| `ports.inputs/outputs` | `{name,type}` 数组；连接须同时匹配方向与类型 |
| `stateFields` | 状态名称、类型、初值和解释 |
| `resources` | 已公开容量/数量、未知值 `null`、物理资源共享关系 |
| `timing` | 教学服务延迟、启动间隔、在途容量、队列规范；来源明确为教学模型 |
| `transitions` | 状态机的 `guard`、`effect`、`release` |
| `invariants` | 安全/因果不变量；规范目标不自动等于当前后端已经实现 |
| `evidenceClass`, `referenceIds` | 结构/语义依据，指向同一文件内的官方参考资料 |
| `simulationCoverage` | `executable`、`timing-only`、`structural-only` 三种实现覆盖 |
| `backendMapping` | 只允许显式组件/阶段映射；不能从 tile 或整个kernel名称猜逐指令活动 |

连接类型为 `control`、`instruction`、`operand`、`memory`、`completion`。`validateSmArchitecture` 检查所有连接的端点、端口方向及类型，拒绝缺失引用、重复节点、不完整状态机、错误时序来源和未声明的覆盖范围。`noc-interface.outbound/return` 是 SM 外部服务边界，TMA store 的 `sharedData` 端口用于后续扩展，当前无执行路径。

## 3. 所有组件的功能与端口

下面的端口名称与程序中的 `ports` 完全一致。`instruction` 是指令或教学指令 token，`operand` 是寄存器/SMEM操作数或结果，`memory` 是请求/数据载荷，`control` 是调度/就绪/同步信号，`completion` 是具有因果含义的完成通知。

| 组件 `localId` | 作用域 | 输入 → 输出 | 逻辑功能 |
| --- | --- | --- | --- |
| `icache` | SM共享 | `fetch,fill` → `instruction,miss` | L1指令缓存；保留指令路径，当前仅服务时序 |
| `l0-icache` | 分区 | `instruction,fetch` → `instruction,refill` | 分区本地指令缓存；当前不执行tag/命中缺失 |
| `fetch` | 分区 | `instruction,pc` → `instruction,request` | 从warp教学程序位置取指 |
| `decode` | 分区 | `instruction` → `instruction` | 解析opcode、src/dst、地址空间及同步类别 |
| `warp-scheduler` | 分区 | `instruction,readiness` → `candidate,query` | 在ready warp间选择发射候选者 |
| `scoreboard` | 分区 | `query,reserve,complete` → `readiness` | 记录未完成写者，阻止RAW/WAW |
| `issue` | 分区 | `candidate,readiness` → `instruction,reserve` | 发射仲裁与原子写者登记 |
| `dispatch` | 分区 | `instruction` → `instruction,read,barrier` | 分派算术、访存、TMA及屏障指令 |
| `register-file` | 分区 | `read,write` → `operands` | 提供符号寄存器操作数、接收结果写回 |
| `operand-collector` | 分区 | `instruction,operands` → `instruction,operands` | 收集必需源操作数 |
| `fp32` | 分区 | `instruction,operands` → `result,complete` | 普通FP32/FMA服务 |
| `fp64` | 分区 | `instruction,operands` → `result,complete` | 普通FP64服务 |
| `int32` | 分区 | `instruction,operands` → `result,complete` | 整数/地址计算；DPX是opcode扩展，无额外虚构物理core |
| `sfu` | 分区 | `instruction,operands` → `result,complete` | 特殊函数类别服务 |
| `tensor` | 分区 | `instruction,operands,sharedOperands,asyncReady` → `result,complete,sharedRead` | MMA服务；保留真实WGMMA扩展边界 |
| `lsu` | 分区 | `instruction,operands,return` → `result,complete,request` | 地址空间分流、请求生成与load返回跟踪 |
| `branch` | 分区 | `instruction,operands` → `result,complete,pc` | 控制流接口；当前仅控制类时序，不执行真实分歧/重汇合 |
| `writeback` | 分区 | `result,complete` → `write,release` | 写回并释放匹配的scoreboard写者 |
| `l1-cache` | SM共享 | `request,fill` → `response,miss` | 普通global/local数据缓存；缺失接外部L2 |
| `shared-memory` | SM共享 | `request,tmaData,tensorRead` → `response,operands,committed` | CTA显式共享存储、TMA写入、Tensor操作数 |
| `tma` | SM共享 | `instruction,globalData,sharedData,committed` → `globalRequest,sharedWrite,expectTx,completeTx` | 异步描述符搬运与事务通知；store接口预留 |
| `mbarrier` | SM共享逻辑对象 | `arrive,expectTx,completeTx` → `ready` | 阶段/参与者/事务计数同步；对象实际位于SMEM |
| `texture` | SM共享汇总 | `request,response` → `cacheRequest,result` | 官方图的纹理访问块，当前只保留结构 |
| `constant-cache` | SM逻辑路径 | `request,fill` → `response,miss` | PTX常量只读语义，当前只保留结构 |
| `noc-interface` | SM边界 | `request,return` → `outbound,inbound` | 连接SM与外部NoC/L2；不是独立物理单元断言 |

这是逻辑连接图，指令类别/地址空间决定实际选路，不会把一个token同时复制到所有执行单元。普通warp指令的模型路径为：

```text
L1I → L0I → Fetch → Decode → Warp Scheduler ↔ Scoreboard
                                  ↓
                            Issue → Dispatch → Operand Collector → execution
                              ↓          ↕RF                         ↓
                          reserve       RF ←────────────── Writeback/Complete
                              ↑                            ↓
                              └──────── Scoreboard release ┘
```

## 4. 状态、就绪与发射

形式化状态：

```text
S(t) = (W, R, B, M, Q, C, A)
W = warp教学程序位置与活动掩码接口
R = 符号寄存器可用性，不存储/计算CUDA数值结果
B = pendingWrites[(warp,register)] → producerInstruction
M = 缓存状态、共享缓冲tile就绪与未完成内存请求
Q = 组件等待队列的规范状态
C = 服务资源预约、启动间隔与在途操作
A = 异步屏障phase/arrival/transaction状态
```

教学指令 token：`{id,warpId,ctaId,pc,opcode,srcRegs,dstRegs,addressSpace,bytes,dependencies,asyncPhase}`。程序位置与指令ID属于教学输入；导入的tile/profile记录不能自动展开出这些字段。

```text
registerReady(i,t) = ∀r∈src(i)∪dst(i): B[(warp(i),r)] = ∅
dependencyReady(i,t) = ∀d∈completionDependencies(i): completed(d,t)
ready(i,t) = decoded(i) ∧ registerReady(i,t)
             ∧ dependencyReady(i,t) ∧ requiredAsyncPhaseReady(i,t)
issue(i,t) = ready(i,t) ∧ issueBudget(partition,t)>0
             ∧ targetCanAccept(i,t)
```

成功发射必须在一个原子步骤中登记 `B[(warp,dst)] = i.id` 并提交到目标路径。`RAW` 等待前序写者；`WAW` 等待前序目标寄存器写者。写回时只有 `B[(warp,dst)] === i.id` 才能释放，避免误释放后来生产者。活动掩码、真实寄存器分配粒度、WAR完整数据值语义及Hopper独立线程调度细节尚未执行，不能把这个符号模型当成CUDA功能模拟器。

## 5. 延迟、启动间隔与容量

对服务组件 `c`，定义 `L_c` 为启动到完成的服务延迟，`II_c` 为相邻启动的最小间隔，`K_c` 为最大在途操作数，`D_c` 为等待队列深度。

```text
start(c,i,t) ⇒ t ≥ nextAccept_c ∧ inflight_c < K_c
nextAccept_c := t + II_c
completionCandidate(c,i) := t + L_c(i)
```

`L=24, II=8, K=4` 允许未完成操作与后续操作重叠，不能把24周期延迟解释成24周期才允许下一次启动。模板默认值全部是 `teaching-model`，不是NVIDIA时序数据。当前例如FP32为 `L6/II1/K8`，Tensor为 `L24/II8/K4`；实际运行可改参数，检查器应优先显示trace组件的有效 `timing`，而非模板默认值。

完整规范还定义 `accept/start/complete` 的FIFO、有限本地队列及下游背压，`commonTransitions.status = specification-contract` 明确其规范属性。当前教学后端实施服务 `L/II/K`、warp指令缓冲与上游credit约束，**不实现每个组件独立有限队列和完整下游背压**。因此trace中的有效 `queueCapacity` 可为 `null`，同时用 `queueImplementation` 写明等待由上游缓冲/credit约束。不能把模板的规范队列深度当成当前实际queue统计。

正式stall类别包括 `instruction-fetch`、`raw-dependency`、`waw-dependency`、`operand-not-ready`、`issue-bandwidth`、`unit-capacity`、`queue-full`、`register-port`、`memory-return`、`shared-bank-conflict`、`async-barrier`、`downstream-backpressure`。只有后端实际报告的原因才显示为已发生，未实现类别不生成虚构计数。

## 6. 三类数据路径必须分开

普通global load：`LSU → L1 → [miss: NoC/L2/外部内存] → LSU → RF写回`。普通shared load/store：`LSU ↔ SMEM`。两者不会因为图上邻接就自动形成 `HBM → L1 → SMEM` 必经路径；从global数据构造共享tile需要显式copy/store/TMA操作。当前LSU示例以32个连续32位地址对应的128B逻辑访问建模；不执行逐lane地址合并成多个32B事务，也没有MSHR合并，不能把这一个逻辑token称为真实硬件cache transaction。

TMA global→shared：`Dispatch → TMA请求 → NoC/L2边界 → TMA数据 → SMEM写入 → complete_tx → mbarrier ready`。搬运载荷绕过RF，发出描述符的线程可继续工作；消费者仍须正确同步。TMA可用于更广泛的global/shared和cluster交换，当前教学程序只执行global→shared子集。见 [Hopper TMA编程说明](https://docs.nvidia.com/cuda/archive/13.0.3/hopper-tuning-guide/index.html#tensor-memory-accelerator)。

Tensor操作数与完成语义由opcode决定。寄存器片段MMA不能被一概画成读取SMEM；Hopper `wgmma` 使用四个连续warp，矩阵B来自SMEM，矩阵A可来自RF或SMEM，并有独立的fence/commit/wait要求。现有单warp教学MMA不能冒充真实WGMMA轨迹，见 [NVIDIA PTX WGMMA规范](https://docs.nvidia.com/cuda/archive/12.8.1/parallel-thread-execution/index.html#asynchronous-warpgroup-level-matrix-multiply-accumulate-instructions)。

## 7. 共享存储、bank与异步屏障

L1与SMEM共享 `physicalResource = unified-l1-smem` 的256 KiB预算，但地址空间、分配与数据可见性不同。SMEM的可选carveout来自公开规格；有效L1预算须扣除已选择的共享容量及实现保留量，不能宣称两个独立256 KiB存储器。模型不推断真实L1行大小/组相联/硬件MSHR数量；教学LRU配置另行声明。

CUDA公开bank规则是32个bank、连续32位字映射到连续bank。不同地址落入同bank会冲突，同一地址被多线程读取可广播，见 [CUDA Best Practices：Shared Memory and Memory Banks](https://docs.nvidia.com/cuda/cuda-c-best-practices-guide/index.html#shared-memory-and-memory-banks)。教学stride/gcd冲突模型只覆盖约定的32位规则访问，不推广为所有TMA swizzle、WGMMA、vector访问的硬件精确时序。

异步屏障规范用 `(phase, pendingArrivals, pendingTx)` 表示本阶段状态。TMA的教学事务计量选择字节；其他PTX操作的计量单位由各自指令指定，不能统一假设总是字节。

```text
expect_tx(bytes): pendingTx += bytes
arrive():         pendingArrivals -= 1
complete_tx(n):   在对应SMEM写入完成后 pendingTx -= n
phaseReady:       pendingArrivals == 0 && pendingTx == 0
```

只有两个条件都满足才允许阶段推进/匹配阶段的消费者唤醒。当前可执行子集是每warp独立的单生产者barrier：一次arrival与指定期望字节，SMEM提交后complete_tx将pendingTxBytes清零，phase由0推进到1；history记录该过程。它没有执行任意CTA多参与者到达、跨阶段复用或完整PTX内存一致性。屏障存放在SMEM，地图中的 `mbarrier` 方块是对象/操作的逻辑展示，不表示新增物理算术单元。依据为 [PTX mbarrier规范](https://docs.nvidia.com/cuda/archive/12.8.1/parallel-thread-execution/index.html#parallel-synchronization-and-communication-instructions-mbarrier)。

## 8. 当前实现覆盖与后续后端

| 覆盖 | 组件/规则 | 当前边界 |
| --- | --- | --- |
| 可执行的教学时序与部分语义 | Fetch/Decode/Scheduler/Scoreboard/Issue/Dispatch/RF/Collector/算术单元/LSU/写回 | 显式阶段token、依赖/资源约束；不计算真实kernel数值 |
| 可执行的教学缓存/共享/异步子集 | L1、SMEM、TMA、mbarrier、外部内存接口 | 有限LRU、规则bank冲突、异步copy与消费依赖；具体规则以 `meta.smPipeline.modelCoverage` 为准 |
| 仅时序 | L1I、L0I、Branch | 无instruction-cache tag/缺失、真实分支PC/掩码更新或重汇合 |
| 仅结构 | Texture、Constant Cache | 保留节点、端口、参考资料，无教学活动 |
| 规范目标 | 每组件有限Q、全链路背压、完整async/warpgroup语义 | 类型与约束已定义，尚未全执行 |

不能把GTSim tile区间合成Fetch/Issue等逐指令区间；无相应观测的组件仍可查看规格，但显示未观测。教学trace与GTSim/实测profile保留不同producer和时间域。后续Accel-Sim/GPGPU-Sim/FlashGPU-Sim适配需要逐事件提供组件/分区映射、指令ID、因果依赖与实际时序，才能替换相应层的教学服务。切换视图只影响展示，不偷偷修改当前运行时间或重放成另一个后端。

验证入口为 `node --test tests/sm-architecture.test.mjs`；测试覆盖76个实例、全部端口连接、公开数量求和、共享容量、TMA独立路径、稳定ID、深拷贝隔离，以及错误端口/类型/证据/覆盖的拒绝。
