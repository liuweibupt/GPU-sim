# GPU 城市：空间层级、交通粒度与仿真后端

日期：2026-10-14。本文记录当前产品方向及后续实现约束；除“本次实现范围”外，均为设计，不代表后端已接入。统一 trace 的现有协议见 [模型与数据契约](model-and-data-contract.md)，后端公开能力及固定版本见 [仿真器调研](research/simulators.md)。

当前还实现了独立 [SM 流水线教学模型](sm-architecture.md)：四分区的 Fetch/Decode/Scheduler/Scoreboard/Issue、操作数与执行路径，以及 L1、SMEM、TMA 和异步 barrier。每项由版本化形式化规格定义，图中未观测组件保持结构展示。该教学运行在 detail 槽保存，不把城市 Tile、旧 GTSim 操作或外部 observer 自动展开成推测指令；本节之后的多后端关联、checkpoint 与局部精化仍是后续设计。

## 一个 GPU 世界，多座 SM 城市

GPU 全景是一个区域，**每个 SM 是一座可进入的城市**。放大进入 SM 后，看执行单元、寄存器、L1/shared memory、调度与工作队伍；继续按 CTA、warp 和操作筛选，观察任务在哪里执行、在等什么。

| 城市表达 | GPU 对应 | 画面应表达的含义 |
| --- | --- | --- |
| 区域总览 | GPU 与其 SM、共享存储和互连 | 显示城市之间的公共资源与整体负载 |
| 每座城市 | SM | 计算、片上存储与驻留工作队伍所在位置 |
| 城内工厂 | Tensor / SIMT 等执行资源 | 操作使用哪类资源，以及后端实际提供的忙闲/等待信息 |
| 城内工作台与仓储 | 寄存器、shared memory、L1 | 分别表现显式工作空间、寄存器资源和缓存，不混成一个容量池 |
| 共享集装箱物流中心 | L2 | 多个 SM 共享的缓存及请求服务；展开 slice/bank 必须有配置或事件依据 |
| 区域大仓库 | HBM / DRAM 与其内存分区 | 全局存储及后端提供的通道、服务和争用信息 |
| 运输网络 | 互连及访存路径 | 只有观测到请求、响应或明确模型路径时，才展示该次运行的交通 |
| 入城与工作队伍 | CTA 归属、驻留与 warp 分工 | 软件工作单元如何分配到硬件，和数据搬运分别呈现 |

L2 和 HBM 不能为了画面整齐而复制成每个 SM 私有的独立设施。默认可用一个图形概括共享系统，但“一个图形”不表示硬件只有一个 bank、一个通道或一个仲裁点。CTA 是逻辑工作单元，通常在一个 SM 上执行；cluster 是 CTA 之上的协作层级，需要对应架构和后端支持。[CUDA 编程模型](https://docs.nvidia.com/cuda/cuda-programming-guide/01-introduction/programming-model.html)

城市坐标是阅读布局。移动建筑、镜头缩放、更新美术不会自动改变连线延迟；以后若支持面积、布线距离或建设成本，必须由独立模型参数明确计入新运行。

## 调度交通和数据交通分开

**CTA 调度决定工作在哪里获得资源；数据交通决定存储请求怎样被服务。** 两者可联动选择，但不能用同一种“车辆”混合表示。

- 调度/控制层显示 CTA 分配与驻留、warp 发射、依赖释放及 barrier 等后端实际提供的事件。CTA 的入城标记表示分配关系，不表示它携带了全部输入数据经过道路。
- 数据层显示 load/store、异步 copy 或具体请求/响应。只有请求 ID、大小、源/目的、时间等确有来源时，才显示相应运输、排队和流量。
- 选中工作队伍可筛选其关联请求；选中请求可追到所属操作。完成依赖、发射次序和内存请求关联分别保留语义。

普通 global load/store、shared-memory 操作、TMA 和其他异步路径分别按后端支持处理。不能预设所有数据都沿 HBM → L2 → L1 → shared → registers 依次经过；命中、旁路、写策略和显式数据搬运会决定实际路径。

## 空间层级与事件粒度是两个独立维度

进入 SM、CTA 或 warp，是**改变观察范围**；从 tile 操作展开到指令或内存请求，是**改变事件粒度**。缩放不会生成后端没有记录的细节。全景可汇总细粒度 trace，SM 内也可以只显示粗粒度 tile 操作。

| 维度 | 可选范围 | 是否改变原始运行 |
| --- | --- | --- |
| 空间/归属范围 | GPU → SM → CTA → warp，以及 pipeline/共享存储 | 否，只选择或聚合已记录对象 |
| 事件粒度 | tile 操作、warp 指令、合并后的请求/响应、队列状态 | 否，受当前 trace 的能力声明约束 |
| 仿真模型与参数 | GTSim、详细指令模型、架构配置和 workload | 是，改变后需创建或选择另一个 run |

tile 是操作或数据工作块，CTA/warp 是执行归属；两者不是可互换的数量单位。一个 CTA 可以处理多个 tile，一个 warp 的指令也可能产生多个存储请求。只因 trace 使用 `cycle` 单位，不能将其称为逐指令或逐事务完整仿真。

## 两种主要交通粒度

### 宏观：tile 任务与依赖

GTSim 回放把一个原生 DAG 操作表示为任务 token，保留原始开始、完成、操作类型、SM、CTA/warp 归属和已有依赖。适合观察 tile 搬运与计算重叠、生产者/消费者分工和关键等待。

这里的 token 不等于一辆物理数据包。一个 TMA tile 操作的总区间没有给出其每个 cache/NoC 子阶段，不能将区间按比例拆成“真实 L2 等待”“真实 HBM 排队”。GTSim 公开核心版是图驱动时序模型，当前公开的手写 GEMM/FA3 builder 与论文完整范围应分别表述。[GTSim 公开范围](https://github.com/SJTU-ReArch-Group/GTSim/blob/main/docs/release-scope.md)

### 微观：warp 指令和合并访存请求

后续接入详细后端时，至少区分两个可选择的对象层：

1. **warp 指令 token**：表示动态指令实例，关联 PC/opcode、active mask、warp 身份和该后端提供的 issue/执行/完成阶段。
2. **访存请求 token**：表示 LSU/cache 侧生成并由存储系统处理的请求，关联地址、大小、sector mask、请求/响应 ID 和确有观测的服务阶段。

一条 warp 访存指令覆盖的活跃 lane 地址，可能合并成一个或多个请求；后续 miss、合并、重放或请求拆分还可能形成进一步关系。因此数据结构保留“指令 → 请求集合”，不能规定“一条指令等于一辆数据车”，也不能把请求数量当成指令数量。请求生成、粒度和重放规则由具体后端及配置确定，前端不自行反演。

shared-memory bank 访问、普通缓存请求和异步搬运各有语义；只在后端支持时展开相应路径。存储响应保留关联 ID，重试和阶段事件不能重复计作新的有效数据流量。地址覆盖/合并教学模型的简化假设见 [模型与数据契约](model-and-data-contract.md#可展开的访存与-simt-细节)。

## 后端职责与能力门槛

| 数据/后端 | 产品中的用途 | 接入前必须确认的内容 |
| --- | --- | --- |
| GTSim tile 图 | 宏观任务归属、原生时序和依赖回放 | 固定 builder/config/版本；保留 timing-only 边界 |
| Accel-Sim / GPGPU-Sim | 动态指令输入与详细性能模型实验 | 匹配 tracer/模型版本；增加或核实输出事件观测点；输入 SASS 不自动包含仿真的 cache/NoC 阶段 |
| FlashGPU-Sim | 详细执行、异步机制与存储/互连事件的候选后端 | 按 kernel 与硬件能力确认 tracing 覆盖、标识符、时间域及数值验证 |
| 实机 profile | 已有 activity、区间与采样指标的观察 | 保留原轨道和测量窗口；没有内部事务就不补造 SM 数据交通 |

Accel-Sim 2.0 的格式、Hopper 机制和匹配后端要求以其 [正式 release](https://github.com/accel-sim/accel-sim-framework/releases/tag/v2.0.0) 为准；FlashGPU 的 warp issue、MMA/TMA、L2、NoC 等选择性输出以 [官方 runtime tracing 文档](https://github.com/FlashGPU-Sim/FlashGPU-Sim/blob/flash/docs/tracing.md) 为准。上表是集成设计，并非已接入能力清单。

界面按能力决定可用视图，并持续显示 producer、版本、时间单位、模型假设和本次观测范围。缺少某类事件时，说明缺失原因；不能以更精细的图标或更多粒子代替证据。

## 切换后端：独立运行与关联比较

首个可实现方案是固定 workload/input 和目标架构，分别生成宏观 run 与详细 run，再按已知 kernel、CTA、warp、tile 或源码身份关联选择、比较指标。**切换视图读取不同 run，不在执行中的 CTA 上任意替换模拟器状态。**

每个 run 独立保存后端版本、输入/源码 hash、launch、布局、架构参数、观测选项、模拟时间域与产物。相同 CTA 数字不足以证明跨 run 对应；调度、warp 分工或 tile 划分变化时，应给出实际映射或明确不能对齐。只比较定义和统计范围一致的指标；不同后端的 cycle 位置不直接拼接为一条“更精确”的时间线。

以后可以研究 checkpoint、ROI 或局部详细重仿真，但要先建立可验证的状态与边界协议：寄存器/内存值、执行位置、barrier/scoreboard、在途请求、cache/队列状态，以及共享资源上的并发竞争都必须有明确处理。单独抽出一个 SM/CTA 会改变其他 SM 对 L2、NoC、DRAM 的争用；需要保留共同仿真、可重放的边界流量或经过验证的外部模型，并报告误差和适用范围。未具备这些条件时，只提供独立受控实验，不声称无损热切换或多后端精确融合。

## 接受慢仿真，保持交互可用

详细仿真可以很慢。前端提供排队、运行、产物整理、完成/失败/取消状态；回放已完成产物时仍可流畅选择、暂停、单步和检查。后台墙钟耗时、GPU 模拟时间与动画播放速度分别显示。

模拟器不为动画帧率修改周期、请求数量、延迟或调度。表现层可在有依据的阶段边界之间插值、聚合大量请求、限制屏幕同时显示的粒子，并支持减少动画；聚合标记须能展开到原始对象。长 trace 以后按组件与时间窗口分块加载，摘要仍保留统计定义与原始数据定位。

## 本次实现范围

当前采用两级入口：GPU 全景默认运行独立的 [132 SM 数据流教学模型](traffic-model.md)，并可切换 GTSim tile 操作；SM 内部按已导入数据展示任务、指令观测或指令区间。原有固定小 GEMM 仍来自真实 GTSim，归属信息来自已有事件中的 `smId`、`threadBlockId`、`warpId`；没有这些字段的 profile 不猜测归属。教学模型的 HBM / NoC 事件来自它自己的离散事件引擎，不从 GTSim 区间拆出。

本次增加 [详细事件 adapter](../tools/detailed/README.md)：可直接转换 FlashGPU-Sim 原生 `INSTRUCTION_ISSUE` runtime 日志，保留 cycle、SM、scheduler、warp、dynamic warp ID、PC、操作类别和指令文本。其 ISSUE/STALL 记录是时间点，以 `instruction_observations` 声明能力，不补造完成时间。带实际起止时间的自定义后端 observer JSON 可声明 `instruction_spans`；原始 Accel-Sim `.tracez` / `.traceg` 是执行输入，不能通过此入口直接获得仿真 issue/completion。格式核查版本与操作方法见 adapter 文档。

两级分别维护 run、模拟时间域和回放速度；墙钟仿真耗时只有实际记录时才显示，否则为未知。GTSim 的宏观周期与详细后端周期不按比例对齐。详细 run 缺失时界面说明导入方式，SM 内不会把同一批 tile 节点改称逐指令数据。

L2 物流中心、HBM 仓库及内部设施可以作为架构示意帮助定位，但没有对应事件时不显示为已观测的请求队列、命中率或交通量。本次没有集成 Accel-Sim/GPGPU-Sim/FlashGPU-Sim 本地运行器，也没有实现 CTA 后端热切、checkpoint 或新的 GPU 执行引擎。导入日志的能力与直接启动后端的能力分别表述。

本次核查了 FlashGPU-Sim 官方记录格式并验证 adapter；当前环境没有 CUDA `nvcc`，未构建或运行详细模拟器，也未提供伪装成后端产物的指令样例。测试中手写 fixture 显式为 `illustration`。后续依次验收：详细后端的小 kernel 与数值/事件验证、指令到请求的稳定关联、同 workload 独立 run 比较，最后再研究局部精化或混合仿真。每一步同时验证原始时间不变、归属正确、请求不重复计数、未知信息不补造，以及缩放/筛选/回退的交互一致性。
