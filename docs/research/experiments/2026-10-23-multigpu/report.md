# 多卡 GPU trace 复用实验报告

日期：2026-10-23。对应[研究规划](../../async-gpu-paper-plan.md)，接续[独立模型与 RTX 4090 实机先导实验](../2026-10-23-pilot/report.md)。本阶段已完成本地现有数据上的来源核验、结构实验、候选检索对照和交互查看器验证；尚未完成整套投稿实验。

**主要结果：已有数据足够支撑现代异步 GPU 程序的离线证据浏览和结构研究，包含 TMA、WGMMA、tcgen05 与 TMEM；目前仍不足以建立真实协议违例检测、优化因果效果或人类理解收益。** 本次采用的规范化 cache 缺少部分关键语义信息，必须显式保持 unknown。可直接打开[交互查看器](viewer.html)，复现入口见[工具说明](../../../../tools/research/TRACE_REUSE.md)。

## 1. 研究问题与本轮实验边界

总体 motivation 仍是：AI 能生成或修改 GPU 算子，但运行成功、工具未报错、模型给出解释，并不自动让开发者知道某个 tensor tile 来自哪个版本、异步读写何时完成、修复是否保留了预期计算。需要让解释能回到可检查的执行证据，并在缺证据时拒绝给出确定结论。

本轮落实三个可执行的问题：

1. **输入可信性与可观测性：** 现有多卡采集能提供什么，转换过程丢失了什么，哪些主张不受数据支持？
2. **结构检索与显示规模：** 在真实 trace 导出的局部程序上，寄存器与符号关联能缩小多少候选集合，查询成本如何？
3. **可检查的呈现：** 能否让用户逐条查看 PC、指令、候选关联与来源哈希，并始终区分观察、转换和未知？

这不是 Daisen 或 Visualize the Invisible 的性能/任务比较，也没有完成相对这些工作的创新验证。它为后续“同一逻辑任务在不同实现中如何对应、如何保留违例见证、如何让人独立核验 AI 修改”提供数据与能力边界。当前关系图仍是语法候选图，尚未将真实 trace 接到上一阶段的逻辑版本/义务证据接口；上一阶段使用的是显式模型和独立 oracle，不是已实现的真实程序提取器。

## 2. 数据、样本单位与来源

### 2.1 四卡完整动态采集

读取 `/home/liuwei/GPU-simulator/data/representative_100_native/`，全量重新计算 457 个 `.traceg` 文件的 SHA256，共 **30,197,410,987 bytes**。全部与 manifest、checkpoint、case 中的三处已记录哈希一致。源仓库只读，git 状态前后相同；源仓库已有的未跟踪 PDF 未被改动。

| GPU 元数据名称 | SM | case | launch/trace | 物理 CTA | 唯一模板 | 物理 CTA 加权规范化指令 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A100 80GB PCIe | 80 | 100 | 116 | 6,962 | 1,397 | 35,936,044 |
| H100 80GB HBM3 | 90 | 100 | 109 | 6,766 | 2,669 | 30,159,274 |
| B200 | 100 | 100 | 116 | 7,566 | 1,133 | 22,798,173 |
| B300 SXM6 AC | 103 | 100 | 116 | 7,566 | 1,131 | 22,871,934 |
| 合计 | — | **400** | **457** | **28,860** | **6,330** | **111,765,425** |

每卡有 CUTLASS GEMM 30、FlashInfer attention 20、FlagGems GELU 12 / SiLU-mul 12 / RMSNorm 13 / softmax 13。四卡具有 100 个共同的 operator/shape/dtype 签名；不同二进制、layout、CTA 和 launch 组织仍可能不同，且没有统一的同输入身份或输出值。这里只报告 **workload 级对齐**，不报告逻辑版本对应正确率或数值等价。

规范化程序来自 `data/ysim_dse_programs_20261009/`。统计按模板内的每次 instruction occurrence 乘以 `template_ids` 中的物理 CTA 频次；不统计去重指令字典作为动态总量。这是规范化 **warp 指令 occurrence**，不是 raw callback 数，也不是 thread 指令数。全部 cluster shape 为 `[1,1,1]`，没有多 CTA cluster 覆盖。

所有 457 个 cache 均通过压缩文件、payload、launch、checkpoint、metadata 身份及计数校验。上游提取记录 `source_worktree_dirty=true`，保留这个限制；不能仅凭旧 commit 声称完全重建当时解析过程。[全量 cache 结果](trace/summary.json) · [全量原始文件哈希结果](source-audit/summary.json)

### 2.2 五卡 launch 级补充采集

另读取 `data/compact_gtsim_traces/*/trace.json`，含 A100、H100、H200、B200、RTX 4090。此组来自另一个采集协议，独立统计：

| GPU | case 行 | 唯一 launch capture | 复用 capture 的额外 case 行 |
| --- | ---: | ---: | ---: |
| A100 | 710 | 523 | 187 |
| H100 | 720 | 531 | 189 |
| H200 | 720 | 526 | 194 |
| B200 | 680 | 504 | 176 |
| RTX 4090 | 760 | 539 | 221 |
| 合计 | **3,590** | **2,623** | **967** |

2,623 份去重 capture 共包含 83,017 条 launch 记录；多个 case 可以复用一份 capture，不能把 3,590 行称为独立动态指令 trace。五卡共同声明的 workload 参数签名有 482 个，不是经过验证的语义匹配。检查 capture 完成标记、引用、case ID、正且有限的原计时和 grid/block 体积，未发现校验错误。

此组记录的是 CUPTI launch/resource 字段，明确没有逐指令/地址 trace，且去除了 launch 的硬件起止时刻。原时间端点为 warm CUDA-event **minimum**；四卡 Representative-100 是 queue-ahead CUDA-event **median**，不能混池计算性能收益。两组数据合计覆盖六种 GPU 名称，case/capture/launch 的分母保持分开。[五卡摘要](compact/summary.json) · [逐行记录](compact/cases.csv)

## 3. 原始 trace 回查与证据缺口

原始抽样选择每 GPU 最小 GEMM、一个 RMSNorm、一个多 launch attention，共 12 case / 16 trace；此选择不同于下节的 12 个检索视图。16 个文件均小于 100 MB，全文件检查 `insts` 声明、`#END_TB` 闭合与索引范围，共 **677,997 条 raw records**，全部通过。官方 parser 解码每文件至多 10,000 条，共 **121,804 条**：12 个受界前缀和 4 个完整的小 RMSNorm trace。未对 30.2 GB 全库做逐指令语义解析。

| 回查结果 | 记录数 | 含义 |
| --- | ---: | --- |
| raw PC/opcode 可在 cache 指令表找到 | 113,756 | 存在性检查；不证明 occurrence 一一对应 |
| cache 无该 PC/opcode、raw mask 为零 | 4,116 | 与规范化过滤机制相符 |
| cache 无该 PC/opcode、raw mask 非零 | 3,932 | 不能宣称逐条原始执行被保留 |
| 两类缺项中，同 PC 存在 `.SIM_WAIT` | 598（596 非零 mask＋2 零 mask） | 可见等待归一化线索；不证明逐条等价 |

原始数据含 active mask、部分地址/值与 TMA 信息，而主 cache 明确移除 mask、真实 sector/lane 地址和寄存器值，并将 barrier 地址符号化。所有主 cache 的 `tmem_columns` 为空；没有逐指令实测 issue/completion 时间。模型的 `latency_cycles` 未被当作硬件时间显示。

H100/B200/B300 GEMM 抽样前缀分别有 24/56/56 条 TMA 指令带 mbarrier 字段。这证明字段可观测，不证明 phase 或完成协议正确。400 case 中 280 个明确保存了 `hardware.correctness.max_abs/max_rel`，其余 120 个没有该记录；错误统计的存在不等于统一阈值下全部通过，本轮也没有重新执行这些硬件数值检查。[抽样与差异明细](source-audit/samples.json) · [原数值验证字段](source-audit/case-validation-metadata.json)

**这项结果直接约束研究框架：** 来源记录、转换记录与未知边界必须进入一等数据模型。若把规范化 cache 直接包装成完整语义证据，就无法可靠回答“到底读到哪个版本”或“是否存在竞态”。

## 4. 现代异步机制覆盖

以下按 opcode 与字段规则识别指令族，launch 之间可能重叠，不相加作为独立案例数。SASS 指令族对应不等于恢复原 PTX 语句。

| 机制 | 含此机制的 launch | 加权规范化 occurrence |
| --- | ---: | ---: |
| cp.async 对应 SASS | 136 | 1,778,864 |
| TMA | 100 | 177,924 |
| WGMMA | 40 | 1,673,152 |
| tcgen05 MMA | 60 | 131,216 |
| TMEM，含分配/释放 | 60 | 82,552 |
| symbolic mbarrier | 100 | 362,396 |

独立审查发现初版 TMEM 计数漏了 `UTCATOMSWS` 的分配/释放，本轮已修正并加回归测试。TMA、tcgen05 与 TMEM 的存在说明该研究可以从 AI/GPGPU 负载开展，不必限于图形流水线；但目前数据不覆盖多 CTA cluster 协议。

两个 B300 地址 sidecar 作为补充：四个文件按原 trace SHA 去重为两个**已有** trace，active/full-predictor 副本的地址记录一致。GEMM 有 20,352 次 sector 引用 / 19,392 个独立 sector base 地址；GELU 为 32,768 / 32,768。它们不能替其他 455 个主 cache 恢复地址，也不提供完整 lane 值或逻辑版本。[地址审计](trace/paired-address-audit.json)

## 5. 结构检索对照与 CPU 成本

### 5.1 固定选择与方法

主实验选四卡共同的 BF16 GEMM `128×1024×128`、首个 RMSNorm 与首个 prefill attention，共 12 个确定性便利样本。每例选 manifest 中首个 launch、物理 CTA 0、机制字段最多的 warp；只展开该完整 warp，其余 warp/CTA 不在检索图中。seed 为存在时的最后 global store、最后 MMA、最后符号 wait，否则取最后有源寄存器的指令。这不是独立随机保留集，也不是故障点真值。

四种对照分别为完整 warp、同 warp 顺序祖先、寄存器最近写者的语法候选祖先、再加符号 barrier / 静态 scoreboard 候选的祖先。缺少 mask 时，最近写者不是精确 def-use；同符号不是完整 phase 匹配；没有推断跨 warp happens-before。

### 5.2 实测结果

| 方法 | 12 视图节点保留比例中位数 | 各视图 CPU 中位数的中位数 |
| --- | ---: | ---: |
| 完整 warp | 100.0000% | 6.390 µs |
| 顺序祖先 | 99.3902% | 85.2675 µs |
| 寄存器候选祖先 | 11.5854% | 7.8375 µs |
| 寄存器＋符号关联祖先 | 18.8416% | 12.52025 µs |

每方法每视图 5 次预热、30 次随机顺序计时，共 **1,440 个原始 CPU 样本**。计时范围是驻留图/预建索引到 Python node-ID set，排除文件读取、解压、构图、排序和浏览器渲染；一次共享 CPU 会话，不提供跨会话置信区间。[逐视图结果](trace/retrieval-summary.csv) · [全部原始样本](trace/retrieval-raw.csv)

这里有一个明确的负结果：**更小的结果集合没有带来相对完整集合构造的整体查询加速。** `full` 可以直接生成 ID 集合，而祖先查询需要遍历关联。不能把显示规模缩减写成端到端计算加速。

含符号关联的方法保留节点比例范围约 5.17%–61.59%。B300 GEMM 主视图从 1,083 条缩到 56 条；B300 RMSNorm 则从寄存器方法的 19/164 扩到 101/164，说明保留候选关联有实际显示成本。两种现象都保留，没有剔除不利样本。

相对所构造候选边闭包的关系保留为 1 是定义保证，**不能当作独立 recall、见证完整率、bug 定位率或真实因果召回率**。上一阶段独立合成 oracle 上的见证结果，也不能转借为此处真实程序的正确性结论。

## 6. 可视化与“让人理解”的当前实现

[自包含交互查看器](viewer.html) 展示 12 个主视图，以及 B200/B300 各一个 tensor consumer warp（387/386 条指令）的补充视图，共 14 个。补充视图含 tcgen05、TMEM、mbarrier，不纳入 12-view 统计。这样可以分别检查 TMA 搬运与 tensor 计算，尚未把两者连接为经过验证的跨 warp 因果链。

界面支持切换架构/算子、检索对照、点击 seed、查看 PC/opcode/寄存器/候选关联与来源哈希。按字段生成中文阅读提示，对 `SIM_WAIT`、TMA、tcgen05 和同步记录解释“此记录支持什么、还缺什么”。这不是 LLM 解释正确性评价；也没有以 assistant 自评替代参与者研究。

查看器在生成前校验 summary 的零错误状态与输入产物 SHA，拒绝混用或改动后的数据。Chrome 实际加载成功；56 组检索集合与离线结果一致，连同 seed/恢复/分页共 **98 项浏览器检查**通过。[浏览器检查记录](browser-check.json)

第一阶段的真实错误位置图与该查看器解决的是不同问题：前者显示实验注入的 GEMM 尾块漏写；后者浏览真实采集的正常工作负载结构。尚无同一真实异步故障从源码、指令、义务、切片到修复的完整演示。

## 7. 对投稿实验的实际影响

| 规划部分 | 本阶段进展 | 仍缺的关键证据 |
| --- | --- | --- |
| 数据与现代架构覆盖 | 四卡完整 trace＋五卡 launch，六种 GPU 名称；全量来源核验 | 带真值的真实异步错误/修复，未见的 cluster 协议 |
| 逻辑对应 E1 | 100 个共同 workload 签名 | 同输入身份、tensor/版本映射与独立 ground truth |
| 保证切片 E2 | 真实局部程序上的候选检索与可视检查 | 从真实程序提取可验证义务/见证，明确未知传播 |
| 诊断 E3/E4 | 能检查机制与来源；已有 SM89 注入故障先导 | 真实项目故障，检测器/人工基线，重新执行修复 |
| 优化 E5/E6 | 第一阶段有真实 GEMM/MLP 对照；本次保留历史 timing | 同一工具工作流驱动的优化、固定预算选优、模型级集成 |
| 规模 E7 | 全 457-launch census、模板权重与 12-view CPU 查询 | 大型真实逻辑图、冷导入/渲染/内存/多会话评估 |
| 人与 AI E9–E11 | 可核验的中文阅读提示和交互原型 | 固定 AI 候选/解释集，独立解释核验，真实开发者实验 |

目前应把核心主张收紧为待验证假设：**给 AI 生成/修改的 GPU 程序提供能回到执行证据的解释，且将缺失证据明确呈现，是否改善人独立定位、修复与判断解释可信度的能力。** “支持新 GPU 指令”或“多卡可视化”本身还不是充分论文贡献。

沿原规划，对本项目的 VIS/TVCG 路线，应补系统化任务设计、可视分析机制和支持所述收益的真实案例/用户证据；若主贡献是人审查 AI 修改，则应完成规划中的受控研究。这里是针对本研究主张的评估设计，并非声称所有 VIS/CHI 论文都必须做同一类用户实验：官方标准强调方法与贡献类型相称、证据支持结论。[VIS 审稿标准](https://ieeevis.org/year/2026/info/call-participation/call-for-participation/) · [CHI 投稿指南](https://chi2027.acm.org/guide-to-a-successful-submission/)

TOG 的匹配性仍需说明对图形/交互社区的实质贡献，不能仅由“用到了 GPU”推出；具体论证沿用整体规划的条件性路线。本轮没有完成这些投稿门槛，也没有声称已能投稿。上述是研究社区和评估路线，不是承诺赶投已经截止的会议届次。

## 8. 可复现性、质量检查与结论

最终 cache run 为 `20261023T080110Z`，raw audit 为 `20261023-full-v4`；此前中间版本保留在本地 `out/`，不与最终计时混用。当前实验源码 SHA 与归档快照一致。`selected-views.json.gz`、`supplemental-views.json.gz` 为原 JSON 的无损 gzip，解压后哈希与原 summary 一致。原始 30.2 GB trace 未复制进本仓库。

- `trace/`：全量 census、对齐、opcode、候选检索原始样本、主/补充视图和产物哈希。
- `source-audit/`：457 文件哈希、原始前缀/框架检查、转换差异与数值验证字段。
- `compact/`：独立五卡 launch 审计和去重结果。
- `source-snapshots/`：此次实际运行的工具源码与测试；执行入口仍使用仓库 `tools/research/`。
- `viewer.html`：可离线打开的完整界面；`browser-check.json` 为功能检查，不是用户研究数据。

质量检查包括 11 项 cache/检索故障回归、4 项原始文件故障检测测试、归档哈希校验及 98 项浏览器检查；此前仓库 309 项 JavaScript 测试、trace validation 与静态构建均通过。独立审查发现的 TMEM 漏计、warp 上界、独立 CTA 契约、查看器产物绑定和外部 bytecode 写入风险已处理。

**结论：用户已有 trace 已被实际复用，现代 GPU 覆盖和可审查的离线实验链已经建立。最重要的新发现是证据保真边界与检索成本的负结果。下一项决定论文能否成立的工作，是把真实程序接到可验证的逻辑版本/协议证据，再用真实错误、修复重执行与人类研究验证收益；这些结果不能由现有历史 trace 自动补出。**
