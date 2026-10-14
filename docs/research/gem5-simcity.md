# Gem5SimCity 参考核查与 GPU 版本实施建议

核查日期：2026-10-14。用户参考：[gem5simcity.pages.dev](https://gem5simcity.pages.dev)。用户希望先完成类似功能并保证正确性，再增加渲染与游戏化。

## 访问与证据范围

线上页面在本次环境中未成功加载：web open 返回抓取错误，Chrome headless 在 15 秒页面等待后超时。本报告没有把线上点击或视觉验收称为已经完成。

通过搜索找到并直接核实作者公开仓库 [Entropy-xcy/Gem5SimCity](https://github.com/Entropy-xcy/Gem5SimCity)，以只读方式在临时目录检查源码，快照 commit 为 [`6c7e0b4ab7ed7b58fdb70527d9ee182db1956483`](https://github.com/Entropy-xcy/Gem5SimCity/tree/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483)。以下功能判断来自这份源码，不能证明线上当前部署与该 commit 完全一致。未编译或运行其 gem5 后端；运行了前端纯数据类的最小 Node 复核。

## 它到底是什么

**公开仓库实现的是 gem5 事件驱动的 CPU 执行可视化和离线 trace 回放，不是仅在浏览器中自行计算教学 timing。** 同时，浏览器中的播放、单步与时间线拖动也不等于正在运行 gem5。

作者 README 给出链路：ARM64 demo binary → 带 SimCity tracer patch 的 gem5 → NDJSON 日志 → Python 转换 → React/three.js 前端。预生成 sample trace 随仓库提供。[README](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/README.md)

源码提供相互印证：

- [run_simcity.py](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/scripts/run_simcity.py) 构建单核 ARM O3、LTAGE、L1/L2、DDR4 的 SE mode 模型，接受 ROB/IQ/LQ/SQ 容量、宽度与 CPU clock 参数。
- [gem5-simcity.patch](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/gem5-simcity.patch) 在 CPU pipeline、scoreboard、cache、MSHR 等位置发出结构化 debug 记录。
- [Makefile](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/Makefile) 在浏览器外运行 gem5 并转换日志。
- [App.jsx](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/web/src/App.jsx#L7) 从 `/trace.json`、demo 文件或查询参数指定的 URL 加载已生成数据。

因此，可借鉴的目标是“**有可追溯执行数据的交互工作台**”。本项目第一阶段不必先做复杂游戏世界，也不必把 GPU 模拟器全部移植进浏览器。

## 已核实的模块与交互

| 模块 | 源码中已有内容 | GPU 版本可借鉴的方式 |
| --- | --- | --- |
| 数据转换 | NDJSON → 紧凑 instruction/event/series，字典编码，cycle 索引 | 独立 adapter；保留原始事件与转换诊断，给协议加版本和 provenance。[trace2json.py](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/tools/trace2json.py) |
| 数据查询 | SoA typed arrays、ID→index、按 cycle 查询、指令详情 | 用相同原则查询 kernel/block/warp/instruction/request；查询不依赖 3D。[trace.js](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/web/src/trace.js) |
| 时间控制 | 播放/暂停、前后一个 cycle、速度、拖动时间线、占用曲线 | 第一版就具备；增加跳到下一依赖解除/瓶颈事件与准确的暂停状态。[HUD.jsx](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/web/src/hud/HUD.jsx#L60) |
| 硬件检查 | 点击组件看容量/占用；scoreboard、寄存器、cache、queue 格子 | 替换成 SM、warp scheduler、执行单元、shared memory、cache 和 memory partitions；缺少细节时展示统计。[Structures.jsx](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/web/src/scene/Structures.jsx) |
| 代码关联 | 源码与汇编并列，随 commit PC 跟随；token hover 看指令及阶段时间 | GPU 中使用选中 warp 的当前/等待 instruction；不套用 CPU 的单一全局 in-order commit frontier。[HUD.jsx](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/web/src/hud/HUD.jsx) |
| 场景与动画 | 自由旋转/缩放/平移、键盘移动；不同 instruction 类型有形状/颜色；实例化 token 和事件效果 | 保留“硬件地图 + 可选动画皮肤”；GPU 大规模对象按层级展开与聚合。[City.jsx](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/web/src/scene/City.jsx)、[Tokens.jsx](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/web/src/scene/Tokens.jsx) |
| 工作负载切换 | 七种 demo 名称，切换时 fetch 对应 trace/code，URL 记录 demo | 将 demo picker 扩展成 kernel/实验库；切换数据时统一清空与重建运行状态。[store.js](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/web/src/store.js) |

### 保存与用户修改的实际边界

检查 `web/src` 后，没有找到 localStorage/IndexedDB 存档、实验包导入导出、参数编辑后运行 gem5、自由添加组件或用户工程管理实现。查询参数可指定 demo/trace/code，适合引用同一数据；当前 URL 不保存 cycle、camera、选择或注释。以上是对所检查源码范围的判断，不推断线上另有服务。[App.jsx](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/web/src/App.jsx)、[store.js](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/web/src/store.js)

它可以帮助确定第一版的浏览体验，但开放 GPU 工坊还需补：实验存档、baseline 分支、模型参数编辑、运行管理、原始数据和模型版本追踪。修改相机/布局与修改硬件模型必须是不同操作。

## “功能正确”的边界与一次复核

真实模拟器输出不是可视化正确性的充分条件。以下是源码中可以核实的转换或简化，不能直接作为我们的精确状态基线：

1. **动画阶段可能是合成的。** 转换器给缺失的 issue/complete 补时间；前端又把同周期或非递增阶段拉开 0.3 cycle。后者会改动供 `instInfo()` 返回的 stage 数组。本项目应保留 authoritative 时间，另建 `visualProgress`。[转换器](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/tools/trace2json.py#L263)、[loader](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/web/src/trace.js#L101)
2. **队列占用有推导和截断。** IQ/LQ/SQ 的 series 由 instruction residency 重建，超 capacity 的值会截断；例如 series 中 LQ 到 issue 结束，而组件视图还表现 issued load 等待数据。不同面板必须先统一资源生命周期语义。超限应保留诊断，不能通过 clamp 证明模型正确。[series 构造](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/tools/trace2json.py#L310)、[结构视图](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/web/src/scene/Structures.jsx)
3. **cache 格子和流动路径存在表现性约定。** cache grid 固定 128 sets × 4 ways；miss 没有有效 set/way 时存在 fallback；miss packet 使用预设飞行时间与路径。它不是完整的 fill/eviction/response 追踪。本项目应依据 metadata 生成布局，未知位置就显示未知，示意流动单独标记。[Structures.jsx](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/web/src/scene/Structures.jsx#L21)、[Effects.jsx](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/web/src/scene/Effects.jsx)
4. **物理位置不能由逻辑 ID 自动推断。** 队列/ROB 格子使用序号取模，执行 lane 有类型与 FU 的映射规则；这适合可视化布局，但不自动等于模拟器的真实槽位分配。[layout.js](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/web/src/layout.js)

另发现一项已复现的 cycle bucket 偏移。`mkBuckets` 已经构造 prefix offset，随后再将 offset 右移一次；使按 bucket 消费的阶段事件晚一个 cycle。**这是该源码快照的行为，不是对线上当前版本的断言。** [相关函数](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/web/src/trace.js#L71)

在仓库根目录运行以下只读 Node 检查即可重现，不需要 npm 安装或 gem5：

```js
// node --input-type=module
import fs from 'node:fs';
import { Trace } from './web/src/trace.js';
const raw = JSON.parse(fs.readFileSync('web/public/trace.json', 'utf8'));
const t = new Trace(raw);
const b = t.renameBuckets;
const ids = c => Array.from(b.idx.slice(b.off[c], b.off[c + 1]))
  .map(i => t.sn[i]);
console.log(raw.insts.find(r => r[0] === 1)[7]); // 82
console.log(ids(82), ids(83));                  // [] [1]
```

对同一 sample 的复核结果：

| 检查项 | 结果 |
| --- | --- |
| 随仓库 sample | 8,001 cycles；16,257 条 instruction；97,279 条 side event；JSON 4,578,051 bytes |
| loader 是否保持所有 stage 原值 | 否：3,543 条 instruction 各有一个 stage 被调整 |
| instruction #1 的 rename | 原始为 cycle 82；在 `renameBuckets[83]` 中出现 |
| 全部 rename bucket 与原始阶段逐 cycle 比较 | 5,615 / 8,001 个 cycle 不同 |

这些结果说明应当借鉴其分层和交互，再以可手算 fixture 与后端事件核对自己的实现。README 对 tracer 无功能影响、低开销的描述属于作者声明；本次未完成编译对照与性能测量。

## 对本项目第一版的实施调整

建议采用以下数据链路，先交付二维工作台：

```text
简化 GPU 模型 / 外部 simulator trace / profile adapter
                         ↓
        原始事件 + 配置 + 数据来源 + 覆盖/缺失说明
                         ↓
        规范化事件、查询索引、确定性状态 reducer
                         ↓
        时间线 + GPU/SM 地图 + 对象检查器 + 代码视图
                         ↓
           可替换的 2D / 3D / 游戏化渲染层
```

原始事件与 reducer 的结果决定计数、时间和依赖；渲染层可以插值、聚合、变速，却不能回写 authoritative 状态。源代码定位、指标和画布由一个当前时间和当前选择联动。

首个可交付版本应包括：

- 一套足够小、参数明示的 GPU 模型：warp 调度、计算/访存、scoreboard、有限队列、一个简化内存层级；自带可手算小 workload。
- 播放/暂停、前后单步、任意 seek、选中 warp/instruction/request、等待原因与资源占用。
- kernel/profile 观察入口按 adapter 能力展示。只有 kernel activity 的输入不能凭空变成逐访存事务。
- 编辑配置后创建新 run，保存参数、输入、模型版本、结果和书签；支持 baseline 比较。先实现 JSON 实验包，后续再增加在线共享。
- 最后在同一状态模型上添加 3D 城市、粒子与开放工坊操作；保证关闭特效后仍可完成全部分析任务。

## 正确性验收清单

| 验收 | 明确通过条件 |
| --- | --- |
| 原始事件保真 | 导入与索引前后的 ID、时间、地址、active mask 不被渲染改写；推导字段带 provenance。 |
| cycle 索引 | 已知事件在 cycle C 时，各 panel、bucket 和 inspector 都在 C 看到它；覆盖 C=0、同周期多事件和末周期。 |
| 状态重建 | 连续播放到 T、直接 seek 到 T、从未来回退到 T，得到相同状态与计数；切换 workload 不残留上次状态。 |
| 资源生命周期 | 每个资源定义 acquire/release 条件；时间线曲线、格子和检查器使用同一 reducer，避免分别推导。 |
| 不变量与异常 | 队列占用、在途 request、barrier 参与集合、scoreboard 依赖可检查；超限保留错误，未知不当作 0。 |
| 多时间域 | core/memory cycle 与 ns 的换算显式；改变 clock 时转换符合配置。 |
| 算法正确性 | workload 的最终输出与独立参考一致；优化配置不能靠漏执行、漏请求提高速度。 |
| 回放与渲染独立 | 快慢播放、掉帧、暂停、是否开 3D/Bloom 不改变模型结果和指标；动画可省略，语义状态不能漏事件。 |
| 数据可追溯 | 保存后重开能找到后端/版本/配置/输入；外部 trace 记录原始文件哈希和转换版本。 |

上述是本项目建议，并非参考项目已经满足的验收。此阶段的成功标准是**能解释一个真实的模型执行过程，修改方案后得到可重复的结果**；游戏化随后扩展同一基础。

## 复用注意

仓库的 LICENSE 对项目文件使用 MIT，并注明 gem5 与修改 gem5 的 patch 采用相应 BSD 3-Clause 条款。若复用代码，应保留对应通知并分别确认所取文件的许可。[作者 LICENSE](https://github.com/Entropy-xcy/Gem5SimCity/blob/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483/LICENSE)
