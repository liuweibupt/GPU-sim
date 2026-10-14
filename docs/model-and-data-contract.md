# GPU 模型与事件数据契约

日期：2026-10-14。前半部分描述当前原型协议；后半部分是后续可编辑世界模型的设计，不代表已实现。

## 当前 trace v1

JSON 顶层包含 `schemaVersion: 1`、`meta`、`components`、`events` 和 `metrics`。规范化与验证实现位于 [lib/trace.js](../lib/trace.js)。事件原始时序从不为动画改写。

```json
{
  "schemaVersion": 1,
  "meta": {
    "title": "一个独立实验",
    "producer": "backend name",
    "producerRevision": "fixed revision",
    "evidenceKind": "simulation",
    "timeUnit": "cycle",
    "description": "来源、运行范围与模型边界",
    "capabilities": ["tile_tasks"]
  },
  "components": [
    {"id": "gpu", "label": "GPU", "kind": "gpu"},
    {"id": "sm0", "label": "SM 0", "kind": "sm", "parentId": "gpu"}
  ],
  "events": [
    {"id": "load0", "name": "load", "category": "memory", "componentId": "sm0", "start": 0, "end": 4, "dependencies": [], "args": {}},
    {"id": "op0", "name": "compute", "category": "compute", "componentId": "sm0", "start": 4, "end": 8, "dependencies": ["load0"], "args": {}}
  ],
  "metrics": {}
}
```

这段是协议示例，不是硬件测量或 GTSim 样例。可运行仿真产物在 `examples/gtsim-gemm.json`，包括其实际来源与配置。

### 来源与能力

`evidenceKind` 为 `simulation`（后端推演）、`measurement`（导入的 profile/测量记录）、`illustration`（示意）。`measurement` 描述用户文件声称的来源，不是系统认证其真实采集。Chrome importer 在 `description` 说明来源未核验，并保留 `source.raw`。

`meta` 建议包含 producer 精确版本、config、workload/input 身份、command 和能力声明；当前 GTSim exporter 已保存版本/config/command，尚未输出可选的 `capabilities` 数组。后续为每个 run 增加稳定 ID、内容 hash 与采集选项。记录真实温度/时钟、预热、重复次数和统计窗口仅在采集端有这些信息时填写。

组件是层级定位，事件是工作区间；不能仅凭父子层级声称一次实际 route。未来 request/response/queue 等新增事件类型要有明确能力和版本迁移，不借用任务 span 猜测数据包。

### 时间、状态与依赖

一个 trace 只有一个可比较时间域，单位为 `cycle`、`us` 或 `ns`。原型不自动换算不同频率或不同采集时钟。Chrome trace 的 `ts/dur` 按其 microsecond 格式保留；`displayTimeUnit` 是显示提示，不改变这些数的单位。[Perfetto 官方 Chrome JSON 格式说明](https://perfetto.dev/docs/getting-started/other-formats)

区间使用 `[start, end)`：在 start 开始，在 end 已完成。零长度事件在其时间点完成。任务状态从时间和原始区间纯计算，滑块回退不依赖上一次帧状态。按事件边界单步不虚构中间 GPU cycle 状态。

- `dependencies` 表示完成依赖：producer.end ≤ consumer.start。
- `args.issueDependencies` 表示发射次序，允许 producer 尚未完成时 consumer 已发射；如果后端导出 `issueReleaseCycle`，以该值检查，否则只验证 producer.start ≤ consumer.start。
- 中途停止时，已开始但未完成节点保留在 `metrics.omittedNodes`，其 end 为 null。发射依赖可引用这种节点的已知 start；完成依赖不能将它视为已完成。界面不为它补造完整区间。
- correlation、同一 source line、时间相邻或同一 tensor 名称都不能自行转换成依赖边。

验证器检查 ID、父子层级、时间数值、组件引用、依赖引用、依赖环与上述时序条件。区间重叠不等于资源冲突：需要后端提供资源容量、服务阶段和仲裁规则才可判断。

### Chrome 和 PyTorch 导入范围

支持 `X` complete events 与同一 pid/tid 上正确嵌套的 `B/E`。轨道保持 process/thread 层级，保留名称、category、args 和原始记录；GPU stream 不是 SM。未配对区间不合成起止；counter、flow、instant、async 等目前不转为 duration 区间，在导入摘要中报告，并保留在来源对象中。Profile 内部时间窗口、metric 采样和 duration 不是同一语义。

输入 JSON 在本地处理。原型限制为 500,000 条原始记录、250,000 个 span 和 2,000 个组件/轨道；大型 trace 需先截取窗口，正式版再做分块/查询。Nsight 的 `.nsys-rep`、SQLite 或 Nsight Compute 报告未直接支持，需后续专用 adapter，不能把 CSV 改扩展名当作兼容。

## 后续可编辑 GPU 模型

以下是阶段 B/C 的实现约束，当前回放原型不执行这些规则。

### 世界、运行与表现分开

`World` 描述组件、typed ports、逻辑连接与模型参数；`Workload` 描述输入、计算语义、launch/layout 和操作图；`Run` 固定两者版本与后端，产生不可变事件；`View` 只描述坐标、选择、缩放和回放时间；`Rules` 定义游戏预算与目标。

改变配置、kernel 或 layout 创建新 run。正在回放的旧 trace 不被修改。地图摆放可自由整理；模型连接必须通过端口类型和容量检查，硬件改动下次运行生效。

### 最小离散事件引擎

使用稳定排序 `(time, phase, sequenceId)` 的事件队列，同一输入/config/seed 生成一致结果。声明同一时刻的完成、释放、仲裁与发射顺序；测试零延迟与同周期竞争，不依赖对象遍历或动画帧率。

每个组件具有有限输入队列、服务吞吐、服务延迟和输出容量。操作必须同时满足数据/次序依赖、执行槽和下游接收条件。完成事件释放资源，唤醒等待任务；下游拒收产生显式背压，不丢弃请求或提前释放资源。

请求记录唯一 ID、源/目的、大小、所属 tensor/tile 与 dependency；响应关联 request。重试不重复计算完成数。定义最大事件/时间预算与 deadlock 报告，分别识别合法等待、无后续事件但任务未完成、unsupported 操作和非法配置。

带宽和延迟独立建模：对可流水服务，传输占用约为 `ceil(bytes / bytesPerTick)`，首次完成还受明确延迟约束；不同请求能否重叠由通道与缓冲模型决定。不能对所有阶段简单相加，也不能把带宽翻倍当成传播延迟减半。

### 正确的数据路径

全局访存通过 load/store 与 cache/memory 系统；shared memory 是 kernel 显式操作的片上空间。不要固定画成 HBM→L2→L1→shared→register 的必经自动链。缓存命中、旁路和后端支持的异步 copy 分别决定实际路径。

初始模型可以选择只实现明确的 cache policy、粗粒度容量与简化互连，但必须列出假设。未建模项不显示伪精确的拥塞/命中率；能耗在有动作计数与相应代价模型后才呈现。

### 可展开的访存与 SIMT 细节

在选中 warp 操作时，才展开 active lanes、元素宽度与地址。对简化 NVIDIA sector 模型，取所有 active lane 字节区间覆盖的 32-byte sector 并集，不能只对起始地址取 floor；统计有效唯一字节与 sector 流量。它是该层合并量，不等于 HBM 实际传输量，后者还受 cache、重放和写策略影响。

shared memory 初始限定为标量 32-bit、32 banks：`bank = floor(address / 4) mod 32`。读同一 word 的广播与读同 bank 不同 word 的冲突分开处理；向量访问、其他宽度、写冲突和 atomics 未支持时明确拒绝或换后端，不套用同一个简化公式。[NVIDIA SIMT kernel 文档](https://docs.nvidia.com/cuda/cuda-programming-guide/02-basics/writing-cuda-kernels.html)

资源占用由 blocks/warps、shared memory、寄存器 footprint 和架构配额约束；初版的连续配额近似与真实分配粒度分开标记。Occupancy 不是单一目标：更多在驻任务可能增加内存竞争。分支用 active mask 和路径语义表示，不能把 warp 当成 32 个完全独立任意调度的 CPU。[CUDA programming model](https://docs.nvidia.com/cuda/cuda-programming-guide/01-introduction/programming-model.html)

### Workload 和数值正确性

每个可编辑 workload 插件提供：输入/输出语义、合法 shape/dtype、地址/布局生成器、操作与依赖图生成器、资源 footprint、数值 reference、适用后端及 unsupported 检测。图生成器不能只改 timing 数字来伪装 tiling/layout 变化。

从 transpose、GEMM 小输入开始，覆盖非整 tile shape、边界 mask、随机输入与误差容忍。浮点运算顺序和精度以配置声明；timing-only 图与 numerical execution 是不同能力。硬件配置正确性、数值一致性、事件完整性、实机周期校准分别验收。

Timeloop 的 architecture/mapping 分离可借鉴，但其 nest-analysis trace 描述 tile 驻留，不是逐次增量搬运，且旁路发生在后处理阶段；不能直接把它当物理 GPU 事务。[官方 trace 文档](https://timeloop.csail.mit.edu/v4/output-formats/trace)
