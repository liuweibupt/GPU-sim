# GPU 仿真器：作为可探索 GPU 世界的数据与模型后端

调研日期、链接访问日期：2026-10-14。只采用作者论文、项目官方仓库及文档；以下明确区分**公开实现事实**、**论文报告**和**本项目建议**。本次没有全面复现各仿真器的准确率，只有 GTSim 的小规模构建与回归实测。

## 对开放沙盒的结论

目标是一个**可进入、观察、修改、再运行的 GPU 世界**，采用造城/模拟城市式玩法，以交通帮助理解数据流：真实 profile 和已知 kernel 给城市施加需求，后续允许玩家建设、扩容、调整调度以及改变 kernel 的工作分解与 layout。按当前开发范围，**阶段 A 先用 GTSim 权威 trace 做功能回放，保证事件导出、依赖和交互正确；阶段 B 再加入自建的可编辑有限队列模型；后续接入 FlashGPU-Sim、Accel-Sim 等高保真后端。** 自建模型负责可解释的机制实验，研究仿真器负责各自支持范围内的详细事件回放、校准或实验验证。

三个重点项目已经有公开实现，但适合承担不同职责：

| 项目 | 截至调研日核实的状态 | 对产品最有价值的部分 | 建议承担的职责 |
| --- | --- | --- | --- |
| Accel-Sim 2.0 | 官方 v2.0.0 于 2026-08-25 发布；依赖匹配的 Hopper GPGPU-Sim 后端 | 真实 SASS 路径、Hopper 异步机制、硬件相关验证工具 | 后续 NVIDIA SASS 离线回放与校准插件 |
| GTSim / GPU-Tile-Sim | 公开核心版 v0.1.0；只含 H100 GEMM、FA3 两种手写参考图生成器 | tile 操作与依赖图适合解释计算、搬运、等待的因果关系 | 阶段 A 的权威仿真 trace 来源与只读回放后端；也是阶段 B 抽象设计参考 |
| FlashGPU-Sim | 正式作者项目；公开 `flash` 分支提供 CUDA/Triton 工作流与 runtime tracing | 执行驱动，且已有 TMA、MMA、L2、NoC 等可选择的仿真事件输出 | 优先考察现代 AI kernel 的详细数据流离线插件 |

依据：[Accel-Sim release](https://github.com/accel-sim/accel-sim-framework/releases/tag/v2.0.0)、[GTSim release scope](https://github.com/SJTU-ReArch-Group/GTSim/blob/main/docs/release-scope.md)、[FlashGPU-Sim 官方项目](https://github.com/FlashGPU-Sim/FlashGPU-Sim)、[runtime tracing](https://github.com/FlashGPU-Sim/FlashGPU-Sim/blob/flash/docs/tracing.md)。表中职责是本项目建议，不能理解成这些项目自带游戏接口。

## Accel-Sim 2.0

**公开实现事实。** 2.0 已正式发布，不能沿用“只支持旧 NVIDIA GPU”的判断。该版本说明明确列出 Hopper TMA、WGMMA、`mbarrier`、threadblock clusters；Blackwell 和 multi-GPU / NVLink 在 release 中仍列为后续方向。release 要求 GPGPU-Sim 后端不早于其 Hopper 合入点，固定框架版本却随意换后端会破坏可复现性。[v2.0.0 release](https://github.com/accel-sim/accel-sim-framework/releases/tag/v2.0.0)

**数据入口。** 基本工作流是在 NVIDIA 实机上通过 NVBit 采集 SASS，再在性能模型中重放。旧 tracer 文档展示 PC、active mask、源/目标寄存器、opcode、访存宽度和地址等字段，可做指令与数据来源关联；这不是实机上每一个 cache/NoC 事务的直接测量。[tracer 文档及格式](https://github.com/accel-sim/accel-sim-framework/blob/dev/util/tracer_nvbit/README.md)

**2.0 格式和成本。** release notes 改为逐 warp zstd `.tracez`，支持分页加载；`traceDsm` 可转回 `.traceg`，不能只按旧 README 的文本格式实现 importer。GPUVision 通过 CUPTI PM sampling 提供计数器时间序列，采样计数器也不能当作完整逐事务路径。官方报告分页把运行时内存约束到约 4 GB、吞吐改进约 2.2 倍；这些是发布方结果，不是本次实测，不意味着任意 AI kernel 可即时运行。[2.0 release notes](https://github.com/accel-sim/accel-sim-framework/blob/v2.0.0/release.notes.md)

**论文报告。** 作者报告 H100 周期误差 13.4% 和 Pearson 相关性 99%；这是其验证集合的总体结果，不能保证某个关卡、某种硬件改动或单条数据路径同样准确。论文讨论范围还包含 Blackwell，实际集成能力仍需按公开 release 单独确认。[作者预印本，2026-08-23](https://arxiv.org/abs/2608.22602)

**本项目建议。** 接入拆成“输入 SASS trace”和“输出仿真事件”两项。前者有格式与工具，后者需要确认观测点、增加稳定的事件导出层，不能期待 SASS trace 本身已有每条链路的起止时间。改变 cache 容量可以用同一 trace 做受约束的微架构实验；改变 block shape、tile shape、layout 或 kernel 算法通常需要重新生成执行路径和地址，不能继续重放原 trace 后宣称代表新 kernel。

## GTSim：身份清晰，论文与公开核心版要分开

这里将用户提到的 GTsim 解释为 **GTSim（GPU-Tile-Sim）**：作者官方仓库为 SJTU-ReArch-Group/GTSim，论文是 *GPU-Tile-Sim: A Tile-Centric GPU Simulation Framework for LLM Hardware-Software Co-Design*。其核心表示是 warp 层面的 tile 图，节点是 tile 操作，边是数据和次序约束。[官方 README](https://github.com/SJTU-ReArch-Group/GTSim)

不要把它与 2017 年 **GATSim: Abstract Timing Simulation of GPUs** 混同，后者是不同作者、不同方法的工作；也不能仅凭相近拼写合并结论。[GATSim 作者论文](https://slam.ece.utexas.edu/pubs/date17.GATSim.pdf)

**论文报告。** 作者称在 A100/H100 上，所测 GEMM、attention、端到端 LLM 推理工作负载 MAPE 为 1.22%–8.71%，并有 Blackwell 初步验证；论文页面注明 accepted to MICRO 2026。[作者预印本，2026-07-13](https://arxiv.org/abs/2607.11262)

**公开核心版事实。** v0.1.0 只有 graph-driven backend、H100 persistent two-stage GEMM、H100 FA3 手写参考图。自动 TileLang-IR frontend、自动图构建、CTA 模板共享、其他 workload builders、B200/FA4 case study，以及全部论文运行时优化/实验均明确不包含在此版本。[release-scope.md](https://github.com/SJTU-ReArch-Group/GTSim/blob/main/docs/release-scope.md)

**公开版验证。** 对应仓库结果为 H100 GEMM 8 个 case、MAPE 2.65%；H100 FA3 6 个 case、MAPE 9.79%。这些数值与论文完整集合不同，报告或宣传时应分别标注。[公开版 validation](https://github.com/SJTU-ReArch-Group/GTSim/blob/main/validation/v0.1.0.md)

**本次实际验证。** 在本机临时目录下载固定 commit `45a996c1585e60e98194057d94f7e664d41150ba`，使用 AMD EPYC 9475F、GCC 13.3、Release 构建、`-j 4`，未使用 GPU：

| 检查 | 结果 | 单次墙钟耗时 |
| --- | --- | --- |
| CMake configure / build | 成功 | 0.27 s / 6.74 s |
| `ctest --output-on-failure` | 4/4 通过 | 0.87 s |
| `gtsim_gemm 512 512 512` | 9,568 个节点；12,956 simulated cycles | 0.29 s |
| `gtsim_fa3 1 32 8 128 128` | 15,872 个完成节点；7,353 simulated cycles | 0.37 s |
| `run_reference.py --verify` | 两条参考周期均匹配 | 0.43 s |

这只是小输入、单次运行的可运行性证据，不是吞吐 benchmark，也没有重新采集 H100 性能。其输出同时列 `Total cycles` 与 `Kernel time (last output store issue cycle)`，两者时间边界不同，适配器应保存原始指标名称，不能统称成相同的 kernel completion time。[对应构建定义](https://github.com/SJTU-ReArch-Group/GTSim/blob/45a996c1585e60e98194057d94f7e664d41150ba/CMakeLists.txt)

**本项目建议。** 阶段 A 用固定版本 GTSim 的原生节点区间与依赖检验 backend→trace→viewer 链路，保持原始 issue/completion 时序，不为动画合成内存阶段。阶段 B 再把 tile 依赖、双缓冲、生产者/消费者 warp 与共享资源排队发展为可编辑模型。GTSim 能为 GEMM/FA3 适配提供参考，但不能作为“任意真实 kernel 直接导入”的完整底座；图的操作粒度也不是每个物理 lane/寄存器 bit 的真实轨迹。

## FlashGPU-Sim：现代执行驱动与较丰富事件输出

**身份与公开范围。** 正式项目为 FlashGPU-Sim/FlashGPU-Sim，建立在 GPGPU-Sim 上；当前 README 列出 H100、B200、RTX 5090 配置及 OpenMP SM 并行模拟。编译/仿真本身不要求物理 GPU；工具链仍需要 CUDA Toolkit，当前文档要求 12.8+，Triton 依赖有特定测试版本。README 对 distributed shared memory 标为 In progress，gem5 backend 标为 Experimental，scale-up multi-GPU 标为 Planned。[官方 README](https://github.com/FlashGPU-Sim/FlashGPU-Sim)

**论文报告。** 2026-09-14 预印本注明 to appear in MICRO 2026；作者在 RTX 5090/H100/B200 共 131 个 workload configuration 上报告周期 MAPE 5.24%，16 host threads 加速 7.86×。论文摘要包括 distributed shared memory 建模，但这不能覆盖前述公开代码 roadmap 的限制。[作者预印本](https://arxiv.org/abs/2609.15311)

**Triton 接入。** TritonTrace 捕获编译产物、launch 参数和张量数据，生成独立 CUDA C++ harness。Online 模式需要 GPU，能够保存修改后的参考输出；Offline 模式可无 GPU 编译指定目标，但只接受固定 autotuning 配置，且没有实机执行或参考输出验证。它是编译/launch capture，不是和 Accel-Sim 等价的动态 SASS 指令 trace。[TritonTrace 文档](https://github.com/FlashGPU-Sim/FlashGPU-Sim/blob/flash/tools/README.md)

**真正有利于数据流可视化的现成能力。** runtime tracing 可按 SM/partition 和事件类别选择输出：warp scheduling、issue/scoreboard、MMA、WGMMA register traffic、TMA/`mbarrier`、L2 请求/接受/响应、NoC 等。请求包含标识符、地址、大小和 sector mask 等适用字段，可转换成世界中的对象流动。文档明确说明 issue trace 不含全部 stall 原因；全 SM 或 fragment 值输出可能很大并拖慢仿真；GPU cycles、`icnt_cycle`、`gem5_tick` 等时间域必须分别处理。[runtime tracing](https://github.com/FlashGPU-Sim/FlashGPU-Sim/blob/flash/docs/tracing.md)

**本项目建议。** 后续先选一个已验证 GEMM，记录 TMA→shared memory→MMA→store 的有限事件窗口，构造 FlashGPU adapter；同时保存 workload、输入、架构 config、采集选项和精确 commit。先提供离线“研究回放”模式，再考虑后台运行任务。不要把其人类可读 stdout 日志当永久稳定 API，也不要把一次仿真的内部流动称为实机直接观测。

## 其他候选与直接可借鉴的可视化

| 项目 | 一手资料支持的事实 | 对本项目的判断 |
| --- | --- | --- |
| GPGPU-Sim 4.x | cycle-level CUDA/OpenCL 模型；可与 Accel-Sim SASS frontend 合作；内含 AerialVision；不同 fork/分支有不同能力 | 适合底层观测点和传统微架构参考。使用 Accel-Sim 时优先配套其 fork，不应重复维护两套 NVIDIA timing backend。见[官方仓库](https://github.com/gpgpu-sim/gpgpu-sim_distribution) |
| AerialVision | 时间视图按 cycle 展示指标，源代码视图关联 CUDA/PTX 行 | 借鉴时间轴、源码联动、局部放大；它本身是分析工具，并未提供建造/改动/实验的游戏循环。见[官方 manual](https://gpgpu-sim.org/manual/index.php/AerialVision_Manual) |
| MGPUSim | 当前 README 明确 stable supported 为 AMD GCN3；支持 multi-GPU；NVIDIA 部分仍在开发、not ready | 后续 AMD/multi-GPU 扩展候选，不能当成熟 Hopper/Blackwell backend。见[官方 README](https://github.com/sarchlab/mgpusim) |
| MGPUSim trace + Daisen | `-trace-vis` 收集详细仿真 trace；`-debug-isa` 可输出指令后的硬件状态；Daisen 展示仿真任务、组件与性能行为 | 非常直接的事件 schema、因果追踪、组件视图参考；可研究其 adapter，而不是重新发明所有 trace 分析交互。见[官方参数文档](https://akitasim.dev/docs/mgpusim/command_line_argument/)、[Daisen 作者论文](https://arxiv.org/abs/2104.00828)、[当前实现目录](https://github.com/sarchlab/akita/tree/main/daisen) |
| Multi2Sim | 当前公开 README 为 5.0；官方 NEWS 从 2011 年起提供 GPU timing/block diagram 可视化与 occupancy calculator | 有“硬件图 + 时间推进”的历史参考价值；旧工具链和维护状态使它不适合首选现代 AI kernel 后端。见[官方仓库](https://github.com/Multi2Sim/multi2sim)、[官方 NEWS](https://github.com/Multi2Sim/multi2sim/blob/master/NEWS) |

MGPUSim 的当前 `go.mod` 要求 Go 1.27，并依赖 Akita v5.0.0-beta.10；不能照抄旧博客中的 Go 版本或旧 API。调研时 Multi2Sim 默认分支最新提交日期为 2018-04-24，这只能说明所查分支的提交状态，不能据此断言所有 fork 已停止维护。[MGPUSim go.mod](https://github.com/sarchlab/mgpusim/blob/main/go.mod)、[Multi2Sim 所查提交](https://github.com/Multi2Sim/multi2sim/commit/77b16e0ba3c23c5609657834b8cdfc7d0e22c303)

## 开放世界中的三类改动必须分别处理

以下是本项目设计约束：

| 玩家行为 | 模型中应该发生什么 | 真实验证需要什么 |
| --- | --- | --- |
| 改 kernel：tile 大小、warp 分工、融合、异步 pipeline | 重建工作量、依赖图、同步关系、resource footprint | 重编译并重跑/重采集；旧 profile 仅可作 baseline |
| 改 layout：连续/跨步访问、shared-memory padding/swizzle | 重算访问地址、coalescing、bank 映射和流量；按模型规则执行 | 需要可重建地址的源码/参数或新 trace；仅有聚合计数器不能唯一反演 |
| 改硬件：cache/SRAM 大小、带宽、队列、执行资源 | 在同一已知 workload 上重新调度与模拟 | 输出标为仿真预测；如果参数不对应可用实机，不能显示为测量 |
| 改 profile 的可视化比例、颜色或时间窗口 | 只改变呈现 | 原始测量保持原样；不会产生新的反事实性能 |

公开 profile 是观察证据；仿真是根据假设产生的轨迹；游戏中的 particle 是轨迹的视觉表达。三者分别保存 provenance。导入只有 kernel 总时长和计数器的 profile 时，世界可以展示已测总量，并用“模型推演”标出内部路径；不能凭空补成唯一真实数据流。

## 统一接口与接入顺序

建议保留三层，以阶段 A 的回放契约承接后续模型与后端扩展：

1. **世界模型：** 阶段 A 使用 GTSim 的既有 timing graph 与配置，不在 viewer 重做一套调度器。阶段 B 才新增 topology、resource capacities、finite queues、work units、dependencies 和确定性调度规则；对象先用 tile/warp-group，再按后端能力展开更细层级。
2. **运行与数据层：** GTSim、profile importer，以及后续自建模型、FlashGPU、Accel-Sim adapter 共享 trace 边界。当前协议采用 `schemaVersion`、`meta`、`components`、`events`、`metrics`；区间保留 `start/end` 和 `componentId`，完成依赖与发射次序分别表达。未来 run identity、requests、bytes、time domains 和 cause links 按能力与版本扩展，不把建议字段当成当前后端已观测的数据。具体协议见[模型与数据契约](../model-and-data-contract.md)。
3. **交互层：** 阶段 A 先支持组件/任务联动、事件详情、权威时间线与可重复回放；阶段 B/C 再扩展世界分支和重跑比较。SM/CTA、warp/tile、单个请求按来源能力逐级展开。渲染时钟独立于模拟时间，未来城市动画只在已记录边界之间插值。

阶段 B 的造城类比需要由实际规则支撑：链路有带宽和传播延迟，服务单元有吞吐与处理延迟，队列有有限容量；下游拒收会造成上游 backpressure，不能只靠动画减速表达堵车。届时玩家能扩容 SRAM/cache/队列、增加并行服务资源、调整调度策略，然后在一个新分支重新运行同一需求，观察拥塞转移。请求与响应保留关联 ID，数据依赖未满足的任务不能提前执行。运行中的硬件重建先限制为“下一次运行生效”，避免在途请求因设施移除而失去语义。这些是后续模型的设计约束；阶段 A 回放不会从 tile 区间推算未导出的队列或内部事务。

建议顺序：**阶段 A：固定 GTSim→权威 trace→功能回放，并接收真实 profile 的既有区间 → 阶段 B：自建可编辑有限队列模型与同一 workload 重跑比较 → 后续：FlashGPU 有限事件窗口、Accel-Sim SASS 后端 → AMD、多 GPU 和 cluster 扩展。** 先证明原始时序、依赖、来源与回放一致，再增加建设和游戏渲染；耗时的高保真实验放在可选择的后台任务中。

对大型 trace 采用按组件/时间窗口查询、压缩、分块加载与层级摘要，保留原始事件用于核查。Daisen/Akita 的官方 issue 也记录 SQLite 在大 trace 写入、查询和共享上的瓶颈；其中 Parquet/ClickHouse 是提案，不应视为已发布功能。[官方 issue #350](https://github.com/sarchlab/akita/issues/350)

## 版本与分发约束

| 组件 | 核实的许可证/版本事实 | 集成时需保留的约束 |
| --- | --- | --- |
| Accel-Sim framework | LICENSE 标题为 BSD 2-Clause，但正文实际含第三条名称背书限制 | 以实际许可证正文与文件级 notices 为准，不能只复制机器识别标签；固定 framework、GPGPU 后端、tracer 版本。见[LICENSE](https://github.com/accel-sim/accel-sim-framework/blob/dev/LICENSE) |
| GPGPU-Sim / FlashGPU-Sim | COPYRIGHT 为宽松再分发条款，但明确指出 CUDA 派生文件、Booksim、decuda 等组件适用各自条件 | 分发原生 backend/修改版时保留对应 notices；不要把完整依赖栈统称为单一 MIT/BSD。见[GPGPU COPYRIGHT](https://github.com/accel-sim/gpgpu-sim_distribution/blob/dev/COPYRIGHT)、[FlashGPU COPYRIGHT](https://github.com/FlashGPU-Sim/FlashGPU-Sim/blob/flash/COPYRIGHT) |
| GTSim | 官方为 MIT；v0.1.0 核心有明确 release scope | 保留 MIT notice，明确只接入其已公开能力。见[LICENSE](https://github.com/SJTU-ReArch-Group/GTSim/blob/main/LICENSE) |
| MGPUSim | 官方为 MIT；当前 API/module 已到 v5 | 固定对应 Akita 版本，不混合旧 trace/API 文档。见[LICENSE](https://github.com/sarchlab/mgpusim/blob/main/LICENSE)、[go.mod](https://github.com/sarchlab/mgpusim/blob/main/go.mod) |
| Multi2Sim | 官方 COPYING 为 GPL-3.0 | 若复用/分发代码，应按实际组合方式处理 GPL 义务；暂以参考其交互为主。见[COPYING](https://github.com/Multi2Sim/multi2sim/blob/master/COPYING) |

### 本次核查的可复现快照

下列为调研时官方默认分支 HEAD，经 GitHub API 读取；版本锁定应写进未来 adapter 的 manifest。Accel-Sim 正式 release 推荐先以 `v2.0.0` 为基线，再另锁定其匹配后端。

| 官方仓库 / 分支 | HEAD |
| --- | --- |
| [accel-sim-framework / dev](https://github.com/accel-sim/accel-sim-framework/commit/d930ad6d02c09bb56867132583735aba0389cff4) | `d930ad6d02c09bb56867132583735aba0389cff4` |
| [GTSim / main](https://github.com/SJTU-ReArch-Group/GTSim/commit/45a996c1585e60e98194057d94f7e664d41150ba) | `45a996c1585e60e98194057d94f7e664d41150ba` |
| [FlashGPU-Sim / flash](https://github.com/FlashGPU-Sim/FlashGPU-Sim/commit/291fbe172332eb481556632a79eb9cfc93cf46bf) | `291fbe172332eb481556632a79eb9cfc93cf46bf` |
| [MGPUSim / main](https://github.com/sarchlab/mgpusim/commit/a3bba0853776585f023956d41f4b723373e3cbee) | `a3bba0853776585f023956d41f4b723373e3cbee` |
| [Multi2Sim / master](https://github.com/Multi2Sim/multi2sim/commit/77b16e0ba3c23c5609657834b8cdfc7d0e22c303) | `77b16e0ba3c23c5609657834b8cdfc7d0e22c303` |

所有论文准确率、加速比都只适用于原作者实验条件；其 workload、架构、时钟、统计边界与误差定义不同，不能用 MAPE 数字为这些工具做横向排行榜。下一步应对同一个小 GEMM、transpose 和 async pipeline，比较 correctness、事件完整性、墙钟时间、trace 体积及可修改参数范围，再决定哪些插件进入正式产品。
