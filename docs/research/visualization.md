# GPU 执行与数据流可视化调研

调研日期：2026-10-14。面向体系结构、AI systems 与 AI infra 用户；第一版允许简化建模。这里关注“工具真正提供什么数据、界面怎样帮助理解、如何接入游戏”，完整仿真器能力比较另见仿真器调研。来源限于官方文档、项目仓库与原作者论文。本次进行了文档与仓库核查，未实际安装或运行这些工具。

## 核心判断

用户后续补充希望“有 GPU 基础就可以在里面做”，更接近 Minecraft 式开放世界。建议把产品定义为**开放 GPU 工坊**：导入真实 kernel/profile、探索硬件与执行、搭建或修改简化模型、保存并比较实验。挑战模板是可选的任务板，不应限制自由探索。

工坊中保留真实 profile 的观察模式和可修改模型的实验模式。二者共享可视化与数据协议，但提供不同程度的证据；从真实 trace 派生实验时，应创建一个注明模型与输入的新 run。

真实 profile 可以支撑“什么时候运行了什么、哪个单元有多忙、哪些源码位置经常等待”；要显示“这个请求在第几周期进入某个队列、因何被阻塞、沿什么路径返回”，通常需要显式插桩的仿真事件。把指标画在 GPU 方框上很容易，把每条动画的语义解释清楚才是主要工程难点。

以下关于产品与架构的条目是本调研的设计建议，不是现有工具声称具有的功能。

## 相关工作与可借鉴内容

| 工作 | 已核实的数据与交互 | 对本项目的意义与边界 |
| --- | --- | --- |
| **AerialVision / GPGPU-Sim** | Time Lapse View 以模拟 cycle 为横轴，显示 IPC、DRAM、warp divergence 等统计；Source Code View 关联 PTX/CUDA 行；支持多图、强度图、缩放与重新读取正在写入的日志。 | 最直接的“微体系结构指标 + 时间 + 源码”先例。已有 visualizer log 主要是统计，不能自动转成逐请求路径。适合借鉴每 SM/DRAM channel 的小多图和热点下钻。[官方手册](https://gpgpu-sim.org/manual/index.php/AerialVision_Manual) |
| **GPGPU-Sim 现行仓库** | 仓库仍包含 `aerialvision`，并说明 GPGPU-Sim 4.0 可通过 Accel-Sim 运行 SASS trace。 | 说明 AerialVision 属于既有工具链，而非只有历史论文；不代表其所有旧界面依赖、现代指令指标和当前系统都已验证。[官方仓库](https://github.com/gpgpu-sim/gpgpu-sim_distribution) |
| **Daisen / MGPUSim / Akita** | 原作者在 EuroVis/CGF 2021 提供硬件组件概览、组件内部任务、任务父子关系等关联视图，用于检查模拟执行与定位性能问题。当前 Akita 仓库可取得 `daisen` 模块，README 的主体文档仍为 placeholder。 | **最值得精读的交互与事件抽象先例。** 它把性能分析从大量日志变成组件和任务间的探索；需要由本项目补充自由搭建、实验存档与可选任务。[原作者项目页](https://vis.khoury.northeastern.edu/pubs/Sun2021DaisenFrameworkVisualizing/)、[论文 PDF](https://zjanice.github.io/assets/papers/EuroVis21_Daisen.pdf)、[当前代码](https://github.com/sarchlab/akita/tree/main/daisen) |
| **Akita tracing** | `Task` 带 ID、ParentID、Kind/What、Where、起止时间与步骤；指令、cache access、DRAM transaction 都可作为任务。MGPUSim 文档提供 `-trace-vis`，输出供 Daisen 查看。 | 可借鉴“组件模型发事件、消费者负责展示”的接口。我们的协议还应支持一次请求拆成多笔事务、多请求合并及资源等待关系，而不局限于一棵父子树。[Tracing 文档](https://akitasim.dev/docs/akita/getting_deeper/hooking/)、[MGPUSim 参数](https://akitasim.dev/docs/mgpusim/command_line_argument/) |
| **Nsight Systems** | 显示 CUDA API、kernel、memcpy 等 activity 的时间区间与 stream/context；另有周期性 GPU metrics 采样。 | 借鉴全局时间线、CPU→GPU 发射关联、NVTX 语义分组和框选分析。活动条带提供工作负载的执行区间，不是 SM 内所有事务的录像。[官方 User Guide](https://docs.nvidia.com/nsight-systems/UserGuide/index.html) |
| **Nsight Compute** | 提供 kernel/范围指标、源码与 SASS 关联、PC/warp sampling，以及 PM sampling 时间序列；指标收集可能经过 replay，通常会序列化 kernel，范围 replay 有不同语义。 | 借鉴 bottleneck 指标与源位置的关联、baseline 比较、分层报告。不能把常规 ncu 报告中的 kernel 时间简单拼成应用原有的并发时间线。[官方 Profiling Guide](https://docs.nvidia.com/nsight-compute/ProfilingGuide/)、[UI 手册](https://docs.nvidia.com/nsight-compute/NsightCompute/) |
| **Accel-Sim 2.0 / GPUVision** | 截至核查日，官网说明 2.0 于 2026 年 8 月发布；仓库描述 GPUVision 通过 CUPTI PM Sampling 获取硬件计数器时间序列，并与模拟器进行 cycle-level correlation。 | 对“真实硬件与模拟走势对照”很有价值。官方所谓 cycle-level correlation 仍需结合采样间隔与具体指标解释，不能读成硬件全部内部状态逐周期可观测。[官网](https://accel-sim.github.io/)、[框架与 GPUVision 说明](https://github.com/accel-sim/accel-sim-framework#gpuvision--cycle-level-cupti-profiling) |
| **Radeon GPU Profiler** | 提供 wavefront occupancy 与 instruction timing；指令追踪受 shader engine/CU 范围限制，少量 wave 的事件可能没有指令数据。AMD 展示了用颜色区分等待时间中被其他 wave 的计算覆盖的部分。 | 很好的 latency hiding 教学先例：画“等待有没有被覆盖”，比单纯把等待着色更有解释力。它也提醒我们保留采集覆盖范围。[官方 Events 手册](https://gpuopen.com/manuals/rgp_manual/events_windows/)、[AMD occupancy 讲解](https://gpuopen.com/learn/occupancy-explained/) |
| **Perfetto / Chrome trace 格式** | 浏览器支持 slice/counter/flow、时间缩放、选中实体详情、区域选择与 SQL 分析；支持 Perfetto proto 和 legacy JSON trace。 | 可作为工程师使用的导出与交叉检查工具。其时间线思想应借鉴，游戏主画布仍需硬件空间布局、任务目标和即时反馈。[UI 文档](https://perfetto.dev/docs/visualization/perfetto-ui)、[Track Events](https://perfetto.dev/docs/instrumentation/track-events)、[Trace Processor](https://perfetto.dev/docs/analysis/trace-processor) |
| **TinyGPU** | 轻量 Python 教学模拟器，含寄存器、线程 PC、访存、分支、同步及热图/GIF 输出。 | 说明小模型可以很快提供可理解反馈；未核实其达到研究级 timing fidelity 或有成熟游戏机制。适合参考教学呈现，不建议直接视作现代 NVIDIA 性能后端。[项目仓库](https://github.com/deaneeth/tiny-gpu) |
| **GPUTejas 2.0** | 官方描述为 Java 并行 trace-driven 模拟器，2.0 使用 NVBit/SASS，并更新 Ampere pipeline。 | 是未来 adapter 候选；本次核查的主页和 v2 手册中，没有确认与 Daisen 相当的现成任务因果浏览界面。这是检索范围内的结果，不是断言项目不存在可视化。[官方主页](https://www.cse.iitd.ac.in/~srsarangi/tejasweb/gputejas/index.html)、[2024-08-05 v2 手册](https://www.cse.iitd.ac.in/tejas/gputejas/home_files/GPUTejas_manual-v2.pdf) |

## 数据能支持什么画面

以下是面向接入层的归纳；“可推断”与“采集到”要分开存储。CUPTI Activity 的 correlation ID 可以关联 API 与 GPU activity，PM sampling 则按间隔采集指标与时间戳，二者不是同一种记录。[CUPTI 官方 Usage](https://docs.nvidia.com/cupti/main/main.html)

| 输入粒度 | 可以诚实显示 | 不能仅凭这些数据声称 |
| --- | --- | --- |
| kernel 聚合统计 | 本次 launch 的流量、命中率、执行与资源指标；算术强度；baseline 差值 | 某个具体周期的瞬时状态；某次 load 命中的 cache line |
| API / kernel / memcpy activity trace | CPU 发射、GPU 执行、stream 重叠、复制区间；已有 correlation 关系 | 每个 SM 的分配过程、所有 warp 的发射顺序、内部 memory request 路径 |
| 硬件指标时间采样 | 时间窗内吞吐、活跃程度、指标随时间的变化 | 把一个采样窗展开成真实逐周期事件；在指标未归属 kernel 时强行做精确归属 |
| PC / warp state sampling | 某些指令位置或状态的采样分布；带采样覆盖说明的热点 | 每一个 warp 的完整生命周期；全部 dynamic instruction 的确定执行顺序 |
| 带 ID 的仿真事件 | 在该模型中，某请求的入队、命中、发出、返回、等待依赖；特定单元状态 | 与真实芯片完全相同的隐藏策略和时序 |
| 输入指令 trace | 所记录运行中的指令、active mask、地址等字段，取决于 tracer | 新硬件配置下自动得到正确 timing；改动算法/分支后 trace 仍有效 |

profile 观察模式可用边宽或亮度表示**一段时间内的聚合流量**，用注释显示采样窗。若使用移动粒子表现流动，应标记“流量示意”，不能让点击粒子返回一个虚构的真实 transaction ID。仿真模式只有确实记录了 ID 与事件的事务才允许逐笔追踪。

同样，某时间窗 memory stall 较高是证据；“某条 L2 请求导致这个 warp 阻塞”需要明确关联。重叠发生的事件可作为假设线索，不能直接生成因果边。交互上可以显示“待验证假设”，再让用户改方案、重跑并比较。

## 推荐的交互闭环

第一版使用一个统一的当前时间和当前选择，贯穿以下视图；避免各面板各自拥有互不相关的筛选状态。

1. **全局时间线**：播放、暂停、下一事件、跳到下一次阻塞、缩放到选中区间；播放速度改变墙上时间，模型时间保持不变。用户暂停后，所有组件与证据卡固定到同一模型时刻。
2. **硬件地图**：GPU → SM → warp/执行单元分级展开。总览只展示利用率、队列长度和流量；用户选中某个 SM 后才展示细粒度对象。节点位置稳定，颜色表达状态，文字与纹理辅助区分。
3. **选择联动**：选中 warp，显示它的指令、所处资源和未完成请求；选中请求，显示其来源指令、上游/下游任务及生命周期；选中源行，筛选对应事件与指标。统一稳定 ID，支持返回上一选择。
4. **证据卡**：明确当前对象为什么不能前进，例如“load 的 request-42 尚未返回”“barrier 还有 1 个 warp 未到达”“队列 4/4”；同时给出指标值、单位、区间和来源。真实 profile 缺少细节时呈现已知证据与缺失项。
5. **修改与重跑**：用户调整 tile、访存排布、block size、流水重叠或有限的硬件预算，然后保存为另一个方案。对比完成时间、事务数、占用资源、正确性和原瓶颈是否转移。

最有潜力的第一个开放实验模板是 **latency hiding**：提供一段小程序和简化 GPU，玩家调整可驻留 warp 数，看到一个 warp 等内存时其他 warp 是否有 ready instruction。其他模板包括 coalescing、shared-memory bank conflict 和 barrier。用户可以改参数、替换 workload、复制实验，或完全从空白工坊开始；模板每次只强调一种机制。

暂停与单步服务理解，搭建/决策/实验/结果服务可玩性。避免让专业用户逐周期点击完成整个 kernel；自动运行、跳到关键事件与快速比较方案应始终可用。

### 开放工坊需要的持续交互

- **存档是一等对象**：保存 GPU 配置、workload、seed、模型版本、可视化布局、书签、注释和实验谱系；原始导入 profile 保存文件引用/哈希及采集元数据。重新打开时能恢复选中的区间与对象。
- **实验可分支**：从 baseline 复制出方案，不覆盖已取得的观测。比较页显示改了哪些参数、结果怎样变化；可导出一个别人能重开的实验包。
- **组件可扩展**：用户可以增加执行单元、队列策略或新型访存模型，但每个组件要声明端口、时序/容量约束、事件、统计和版本。组件描述与 UI 渲染解耦；新组件缺少专用画法时仍可使用通用队列/单元视图。
- **操作可发现**：鼠标悬停看状态，点击进入细节，右侧检查器编辑参数；拖动只做布局，连线必须表达明确类型。专业术语保留，配就地解释；快捷键是加速方式，不应是唯一入口。
- **观察与修改的转换明确**：用户导入 nsys 后可探索真实时间线；选择“基于此创建模型实验”时再选择可用 kernel 输入和模型。仅有 activity/metric 的文件无法自动生成有真实内存地址语义的可执行 workload。
- **扩展范围可控**：首版中的“自由搭建”限定在已经建模的资源与协议内；增加节点不自动意味着其在真实硬件上可实现。高级用户可以查看并修改模型假设。

## 可扩展的 adapter 与数据契约

建议前端依赖自有、版本化的事件模型，而非任何模拟器的日志文本、CUDA 专用类或厂商 metric 名称。每个 adapter 声明能力，界面按能力启用。

```text
Run
  id, schemaVersion, backend, backendVersion, workload, configuration
  mode: simulation | profile
  clockDomains[], sourceFiles[], capabilities{}, diagnostics[]

Resource
  id, parentId, kind, displayName, capacity, properties

Event
  id, runId, time, clockDomainId, resourceId, kind, entityIds[], payload
  provenance: measured | sampled | simulated | inferred

Interval
  id, start, end, resourceId, entityIds[], category, state

Relation
  fromId, toId, kind: parent | dependency | request | response | correlation
  provenance, evidenceIds[]

MetricSeries
  id, resourceId, name, vendorName, unit, aggregation, scope
  clockDomainId, samples[], sampleWindow, coverage, missingReason
```

实施时要明确以下约束：

- **时间域**：保存原始 timestamp 单位、domain 和对齐方法。ns、core cycle、memory cycle 不做隐式等同；跨 run 比较通过 launch ID、范围标记或明示的对齐点完成。频率变化时，周期换算需相应模型。
- **指标类型**：区分 cumulative counter、时间窗 delta、gauge、rate 和 ratio；注明分母。命中率不能把各 SM 的百分数直接平均；occupancy、SM active、issue utilization 不合并为一个“GPU 利用率”。
- **关系类型**：父子关系不自动等于执行依赖；一个 memory instruction 可产生多笔 transaction，多笔访问也可能合并。用关系表容纳 DAG，保留 tracer 真的提供的关联。
- **缺失与覆盖**：缺项显示 unknown，不当作 0；保存丢弃事件、采样间隔、过滤范围、replay 模式和采集诊断。没有 request trace 的 backend 不启用“跟踪这一笔请求”。
- **状态重建**：运行时内核发 append-only 事件；定期保存 checkpoint。回退是从 checkpoint 确定性重放，而不是要求每个模块维护一套反向操作。UI 只读事件与重建状态。
- **规模控制**：主画布使用按像素或时间窗聚合的 level of detail，细节按选择加载；长 trace 分块并索引 `time/resource/entity`。不为全部 SM 的全部线程创建常驻 DOM 节点。

### 接入顺序

| 阶段 | Adapter | 最小交付与风险控制 |
| --- | --- | --- |
| MVP | 自有简化、确定性模拟器 | 先完成事件语义、单步、回退、联动选择、自由修改、实验存档与三个模板；模型参数随 run 保存。 |
| 低成本验证 | Perfetto JSON/proto 导出 | 把 interval、counter 和已知 flow 导出，在成熟时间线中独立检查事件顺序与持续时间。导出只是一个消费者，不把整个产品绑定到该格式。 |
| 真实 profile | Nsight Systems SQLite 导入 | 先接 kernel/memcpy/API、stream、correlation，再接 metrics。保存原 `.nsys-rep`；读取导出 schema 版本并检查表是否存在。 |
| kernel 证据 | Nsight Compute 报告/CSV 导入 | 用于补充 kernel 指标与 baseline，保留采集配置和 replay 说明；不依靠跨两次采集的绝对 timestamp 硬拼成一条执行。 |
| 研究后端 | Accel-Sim/GPGPU-Sim adapter | 先消费已有 statistics/AerialVision log；需要事务时再做显式事件插桩。GPUVision 作为额外硬件采样序列，而不是事件 trace 的替代品。 |
| 泛化验证 | Akita/MGPUSim task adapter | 验证协议能容纳 AMD wavefront/CU、parent task 与跨组件 request；随后评估其他研究模拟器。 |

Nsight Systems 官方明确：`.nsys-rep` 才是应视为前向兼容的报告格式，SQLite schema 会变化；存在 `EXPORT_SCHEMA_VERSION`，且表可能按实际采集内容惰性创建。adapter 因此需要版本与字段探测。[官方 Analysis Guide](https://docs.nvidia.com/nsight-systems/AnalysisGuide/index.html#sqlite-schema-reference)

Nsight Compute CLI 可输出 CSV；这适合第一轮指标接入，但聚合 CSV 不会自动拥有可播放的细粒度事件。[CLI Console Output](https://docs.nvidia.com/nsight-compute/NsightComputeCli/index.html#console-output)

## 对第一版的验收建议

这些验收项用于验证游戏解释是否可信；不要求先实现完整现代 GPU。

- **已知小例子**：一个合并良好的 load 与一个跨多个 segment 的 load，在明示的事务划分规则下产生可手算的不同事务数；改变可视化速度不改变结果。
- **等待可解释**：暂停在某个 stalled warp，能指出未满足的具体依赖；请求返回后解除相应等待。barrier 必须显示参与集合和已到达集合。
- **状态一致**：同一 seed 与配置重跑得到相同事件与结果；先前进再回退到某一时刻，所有视图选择与状态一致。
- **反例辨识**：增加 warp 数不保证无限提升速度；当模型中已达到带宽/容量上限时，结果应展示新的约束。让玩家看到优化的适用条件。
- **导入退化**：只有 kernel activity 的样例仍可正常浏览，但内部事务视图明确缺少数据；带采样缺口的例子不显示连续、精确的事件路径。
- **开放实验**：用户从一个模板派生两个方案，修改组件参数，保存退出后恢复，能对照 baseline，并把包含模型版本的实验包交给另一位用户重开。
- **专家可用性**：至少邀请体系结构与 AI systems 两类用户各完成一次“自由探索→识别瓶颈→提出修改→比较”的任务，记录是否能解释变化依据，而不仅是是否喜欢动画。

优先验证“自由探索可见状态、形成假设、修改方案、保存和对照结果”这条闭环。完成后再扩展真实 profile 的细节接入、更多架构机制与新手引导。
