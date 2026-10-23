# GPU 逻辑版本与协议证据实验

日期：2026-10-23。接续[多卡 trace 复用](../2026-10-23-multigpu/report.md)与[投稿规划](../../async-gpu-paper-plan.md)。本轮完成了现有条件下的原始证据恢复、静态缺口核对、有限三值协议检查，以及 RTX 4090 上的受控错误→证据→检查→切片闭环。**完整投稿实验仍未完成；现代异步故障重采集和真实开发者研究需要外部资源。**

主要发现是：**同步和地址检查通过，仍然可能读错逻辑版本；证据缺失时，分析必须保持未知。** 现在已有一个真实 GPU 执行的受控案例支持这一区分，但尚不能推广为真实 AI 算子错误的检测率。可打开[版本错误交互查看器](version-viewer.html)，资源交付与下一步见[执行清单](../../semantic-next-stage.md)，复现见[工具说明](../../../../tools/research/SEMANTIC_EXPERIMENTS.md)。

## 1. 问题、方法与证据层次

AI 能写出可运行、甚至更快的 GPU 算子，并不自动让人理解“此输出来自哪个输入/中间版本”“等待完成覆盖了哪一种操作”“改动是否仍满足预期计算”。本研究希望把这些判断连接到可检查的执行证据，并在信息不足时明确拒绝确定结论。

本轮沿三条独立证据路径实施，避免把一个层次的结果借给另一个层次：

| 路径 | 输入 | 本轮可检验的结论 |
| --- | --- | --- |
| 历史真实采集 | 四卡 AI 算子的 13 个已记录完整 CTA | 字段/静态语法能恢复多少，哪些关系仍不可判定 |
| 有限语义模型 | 显式事件、generation、完成类型、已证明 HB | 检查器是否符合声明的三值合约；切片是否保留证据 |
| 新实机受控实验 | SM89 双缓冲的正确与错读版本 | 实际输出/tag 能否给出版本错误见证；源代码同步合约如何接入 |

检查器覆盖 `value-generation`、`completion-before-consume`、`reader-before-reuse`。身份包括 scope、resource、完整非负十进制 generation、domain；区分 value、producer-result-ready、reader-done 等。known token 有具体证据引用；未知身份、缺失事件或无法证明的顺序返回 unknown。先检查完成 token 的身份，再检查顺序，不能拿其他代次或其他完成阶段冒充所需事件。

此模块不是完整 PTX 内存模型或通用 race detector。输入事实的内部一致性、引用和 DAG 可验证，但其真实性与 ISA 含义仍依赖采集器或经审查的源码合约。三值分析/HB 可达性本身也不是本轮已建立的新颖性主张。

## 2. 原始数据恢复与保真审计

### 2.1 固定样本与规模

沿上一轮 12 个主检索视图，取 A100/H100/B200/B300 的 GEMM、RMSNorm、attention 各一个 trace 的 **CTA 0 全部已声明 warp**，另加一个有 TMEM 静态 footprint 的 B300 FP16 GEMM。没有把这 13 个样本当作全库、故障保留集或独立随机抽样。

| 范围 | trace / CTA | warp | raw records | 零 mask | 非零部分 mask |
| --- | ---: | ---: | ---: | ---: | ---: |
| 四卡主样本 | 12 | 76 | 123,819 | 3,296 | 2,055 |
| B300 TMEM 补充样本 | 1 | 8 | 7,288 | 617 | 63 |
| 合计 | 13 | 84 | **131,107** | **3,913** | **2,118** |

每个原文件重新做 SHA 与全文件分组闭合检查，解析至 CTA 0 最后记录；保留零 mask、原始 operand、64-bit 字段的无损字符串和 raw 行号。导出 13 个 gzip 共 5,713,025 bytes。本轮不重新解码全部 30.2 GB 原库；源目录只读，前后 git 状态一致。

恢复到主样本的 memory address 条目为 652,312，补充样本为 96,945；它们是记录条目数量，不是独立地址或内存事务数。主样本有 98 条 TMA/mbarrier 字段记录，补充样本有 44 条，其中 20 条提供 byte count。raw `tmem_columns` 在全部 131,107 条记录中均为空。[导出摘要](raw/summary.json)

### 2.2 能解释与不能解释的字段

声明的 tracer pin 为 `64653015f85fb5664c84a10f48527e8897d289d0`。该源码按 active 与 predicate mask 合成记录，且在 `IPOINT_BEFORE` 回调。因此 destination Val 是指令执行前的旧值，不能作为写回值或 wait 成功结果。32 个 Val 对应物理 lane 槽；一个 Val 是全槽相同值的压缩，不能解释为仅一个活跃线程。实际 capture 缺少加载 tracer `.so` 的哈希，故导出仍将 mask 语义标为 unverified。[声明版本的 tracer](https://raw.githubusercontent.com/accel-sim/accel-sim-framework/64653015f85fb5664c84a10f48527e8897d289d0/util/tracer_nvbit/tracer_tool/tracer_tool.cu) · [设备回调](https://raw.githubusercontent.com/accel-sim/accel-sim-framework/64653015f85fb5664c84a10f48527e8897d289d0/util/tracer_nvbit/tracer_tool/inject_funcs.cu)

还发现了实际 operand 缺口：B200 GEMM PC `0x470` 的 raw `SYNCS.EXCH.64` sources 为 `R0, UR6`，hash-bound static SASS 为 `URZ, [UR5], UR6`。因此不能把所有 raw `R*` 当作真实、完整的源寄存器；uniform memory base、谓词、隐式 tuple 及读写角色均需额外解码。[完整反例及来源](static/b200-syncs-counterexample.json)

### 2.3 静态语法验证的支持范围

7/13 条 trace 有可绑定 exact kernel、trace/静态 SHA 的 static SASS；另外六条缺失。多 code object 必须在动态 PC/opcode 上匹配，且对应 guard/operand 文本一致才接受。

| 五种指定 family：MOV / FFMA / FADD / FMUL / IADD3 | 动态记录 |
| --- | ---: |
| family 总计 | 29,574 |
| 有 static、显式 R/UR 字面 token 一致 | 11,865 |
| 缺 static，unknown | 17,709 |
| 更保守的无 suffix/非常量谓词/constant-memory/UR 语法子集 | 5,390 |
| 上述子集非零 mask | 5,259 |
| 五类以外、明确不进入此语法比较 | 101,533 |

11,865 条里零字面 mismatch **不代表全 ISA 操作数正确**。保守语法子集也不能形成完整 reaching-definitions：中间未支持指令可能覆盖寄存器，不能无条件沿用旧 writer。审计另外保留 20 个异步/内存指令实例，避免只呈现成功的 scalar 子集。[静态审计摘要](static/summary.json) · [逐 trace](static/traces.csv)

对于补充 B300 kernel，原 manifest 确实把 alloc `0x2e30`、free `0x3b60` 两个静态 site 绑定到 512 columns，并通过 trace/static SHA 与 exact kernel 验证。这是 compiler/source inference，单独存于 `external_evidence`；没有修改 raw `tmem_columns`，也没有称作运行时容量或生命周期安全证明。

## 3. 掩码敏感的候选来源实验

比较两个**记录级候选**：warp 内最近一次非零 mask 的显式 R 目的 token，以及包含查询 lane 的最近一次显式 R 目的 token。读先于同记录写；只跟踪 R0–R254，不展开隐式 tuple。分母是 `(raw record, source-token occurrence, active lane)`，重复 operand 也按出现次数统计。

| 指标 | 数量 |
| --- | ---: |
| source-token/lane 查询 | 5,849,364 |
| 两种候选不同 | **7,307** |
| 有更早的 lane 候选 | 6,897 |
| coarse 有候选、该 lane 无已记录写入 | 410 |
| mask 方法没有先前记录候选 | 244,104 |

这证明保留 mask 会影响候选关联，不能解释为发现了 7,307 个错误，也不构成检测 precision/recall。raw operand 的已知缺口、unsupported clobber 和缺失采集 provenance 仍然存在。对实现本身，用独立反向扫描检查了 100 个固定 seed 随机记录流，并测试零 mask、部分写、read-before-write 等边界。[摘要](mask/summary.json) · [逐 warp](mask/per-warp.csv)

## 4. 有限三值语义与独立 oracle

### 4.1 设计

26 个手写开发案例与 48 个固定 seed 结构变体，共 74 个合法输入；另有 7 个非法输入。变体主要改变事件存储顺序和大 generation，并非 74 个独立真实 bug 或保留测试项目。

生产检查器使用 HB 可达性；独立 oracle 枚举满足输入偏序的所有有限事件排列，代码不调用生产检查器。当前最大 5 个观测事件，每例 20–120 个可行全序。两者共享显式有限合约，oracle 不能验证外部事实或完整 ISA。

### 4.2 结果与消融

| 结果 | 数量 |
| --- | ---: |
| 派生义务 / 与 oracle 一致 | **140 / 140** |
| satisfied / violated / unknown | 66 / 25 / 49 |
| 非法输入被拒绝 | 7 / 7 |
| 完整图 / evidence 切片保留结论与所需证据 | 140 / 140，各自 |
| data-only ancestors 保留同一目标 | 4 / 140 |
| evidence 切片节点比例中位数 | 50% |

一个刻意简单的错误消融把“没有前向 HB”直接当作违例，得到 49 个无根据的确定错误；它不是强现有方法基线。unknown 不是已知正确，所以不能把这 49 项写成已知正常程序的 false positive。其中 11 项存在共 470 个满足要求的可行全序，给出了具体反例；470 是组合计数，不是执行概率。

CPU 记录含 4,440 个随机交错样本。完整检查器各例中位数的中位数为 34.3205 µs，简单消融为 1.255 µs。两者返回对象和验证工作量不同，只报告成本，不声称加速；没有跨会话置信区间。[有限模型摘要](protocol/summary.json) · [原始计时](protocol/timing-raw.csv)

### 4.3 真实 raw 接口保持未知

每个真实 CTA 确定性选一个 tensor issue/output anchor，存在时再选一个 release anchor。anchor 来自导出记录顺序，不推断跨 warp 最后事件。接入检查器后共 **37 个派生义务全部 unknown**，切片全部保留未知原因。

缺少逻辑映射、完整 generation、等待成功与 reader completion 时，没有产生“安全”或“错误”结论。这是实际接口接入和拒绝过度推断的结果；没有真实 bug 标签，不能声称零误报或零漏报，也不是全 ISA 自动义务提取。[raw 接口摘要](raw-bridge/summary.json)

## 5. RTX 4090 实际版本错误闭环

### 5.1 实验与独立检查

设备为本机报告的 RTX 4090 / SM89，CUDA 12.6 编译，Compute Sanitizer 13.1；完整设备/驱动日志归档。kernel 每 CTA 64 线程：warp 0 写共享双缓冲的 payload 和 tag，uniform CTA barrier 后 warp 1 读取，第二个 barrier 保证读结束再进入下一轮。正确版读 `g % 2`，错误版故意读另一 slot。两个 slot 都初始化，访问合法，不通过故意数据竞争或越界制造错误。

扫描 N=`1,17,32,33,65,127`，迭代数 `1,2,5`，两个 seed，两种版本，共 **72 次普通运行**。保存全部有效输出、reference、tag 与固定位置事件；C++、独立 Python 以及桥接 JS 均重新核对 reference/计数，bridge 逐项绑定原 stdout、事件 JSON pointer、源码 SHA 和 barrier 行号。没有仅相信 `pass` 标记。

| 指标 | 实测 |
| --- | ---: |
| 正确版运行通过 | **36 / 36** |
| 错读版出现预期数值和版本错误 | **36 / 36** |
| 保存的 output 元素 / 实际事件 | 8,800 / 1,920 |
| 错读版 value mismatch / version mismatch | 4,400 / 4,400 |
| memcheck、synccheck、racecheck × 两版本 | 6 项均 **0 tool errors** |

Sanitizer 仅对 `N=65, generations=5, seed=20261023` 两种版本运行，不是对全部 72 次逐一运行。错误版应用退出码为预期的 2，工具错误数仍为 0。测试覆盖有限，不能解释为通用安全证明或工具无用；本例展示的是工具检查范围与逻辑任务正确性的区别。

例如 `N=1, generations=5` 错读版的实际 tag 是 `[-1,0,1,2,3]`，预期为 `[0,1,2,3,4]`。初始化 tag -1 显式映射到逻辑 generation 0，迭代 g 映射到 g+1；保留原 tag，不能用 phase parity 替代完整版本。

### 5.2 同步证据不能来自回调数组顺序

`producer_complete(thread0)` 与 `consumer_read(thread32)` 都在第一个 barrier 后，不能直接给这两个回调加 HB；`reader_done(thread32)` 与 `reuse_ready(thread0)` 同理。

桥接新增明确标注 **source-derived** 的 barrier 边界：consumer 返回生产 barrier 之前，所需写入已完成；producer 返回 reader barrier 之后，可以按源码程序顺序进入下一轮写入。边界有源码 SHA、行号与作用域，不伪装为采样到的设备完成时刻。实际回调仍单独保留。此推导只适用于经过审查的固定 kernel，不是任意 CUDA 自动分析器。

### 5.3 检查、见证、消融

72 次运行导出 144 个 CTA capture：

| 派生结果 | 数量 |
| --- | ---: |
| 全部义务 | 1,536 |
| satisfied / violated / unknown | 1,344 / 192 / 0 |
| 版本义务 satisfied / violated | **192 / 192** |
| 完成身份与顺序义务 | 1,152 satisfied |
| 每项目标的切片保留核对 | 1,536 / 1,536 |

这个结果把错误定位到数据选择，而不是凭缺边宣称同步错误。144 CTA 与数百个派生义务是相关观测，不能当作独立错误案例计算总体准确率。逐条切片核对检验接口保真，不是独立故障定位评测。

离线遮蔽 consumer value-token 接口后，384 个版本义务均变为 unknown；删除 HB 边后，576 个顺序义务均变为 unknown。原始事实和其他接口仍保留，因此这是**检查器接口敏感性消融**，不是物理移除原始 tag，也没有新增 GPU 故障。[实机桥接摘要](version-bridge/summary.json)

没有对本例测量性能收益；诊断事件和 tag 可能改变运行，不能将插桩执行时间当未插桩性能。正确/错误版本为本实验手写，不是自然 AI 生成的失败，也未执行 TMA、tcgen05 或 TMEM。

## 6. 人类可检查的呈现与尚未完成的评价

[交互查看器](version-viewer.html)连接实际输出/tag、双 slot 版本、三值结论、原始事件与源码推导的 barrier 边界。按 N、迭代数、seed、版本及 CTA 选择实例，可检查整数误差和见证；明确区分记录顺序与硬件时间、观测与推导。浏览器功能核对单独归档，不能作为人类理解收益。

Chrome 实际加载并检查了 72 个运行、144 个 CTA、384 个 CTA×generation 状态、8,800 个显示输出与 1,536 个义务，还检查 17 项筛选和 72 次源码跳转，全部通过。渲染前严格校验每个 CTA 结果的 SHA/字节数；合法 JSON 的字节改动与声明字节数改动均被拒绝。[浏览器记录](browser-check.json)

目前能够让读者回查“为何得到这个结论”；尚未证明用户因此更准确、更快，或在不使用工具时理解得更好。也没有与 Daisen、Milestone 等近邻做同任务比较。后续应使用相同 AI 候选和信息预算，分别测量解释核验、独立理解与实际修复结果，保留错误解释接受、unknown 处理、失败和超时。

## 7. 可复现性与已知限制

归档 manifest 记录每个保存文件的压缩前后 SHA/字节数，大型 JSON 无损 gzip；不提交 30.2 GB 原 trace 或 CUDA 可执行文件，保留二进制 SHA、编译命令、源码与原输出。`source-snapshots/` 保存本轮源码。GPU 最终运行是 `20261023-version-probe-v3`；v1 的 sanitizer banner 解析失败与 v2 中间结果仍在本机 `out/`，不混入最终计数。

最终归档包含 450 个文件，归档输入文件合计 105,277,642 bytes，保存 20,321,029 bytes；已压缩的 raw 文件按其文件字节数计算，不代表全量 trace 解压规模。10,644 项字节/跨实验绑定检查全部通过，并核对本机原始文件仍逐字节一致。[完整 manifest](manifest.json) · [校验结果](verification.json)

质量验证包括仓库 **329 项 JavaScript 测试、26 项 Python 测试**通过；新增协议、raw 解码、mask 候选、sanitizer 日志处理与 bridge 关键边界都有回归。协议检查器、两个 bridge 和固定 CUDA 同步合约经过独立审查。归档/浏览器检查另见保存记录。

仍缺的核心证据包括：实际 loaded tracer provenance；现代卡的 post-wait 成功与完整版本采集；真实错误/修复；不同 tiling 的真实逻辑对应；无插桩成本；固定 AI 候选；真实开发者与独立评分。有限模型、语法一致、受控故障和真实项目错误必须分层报告。

## 8. 结论与投稿判断

**相比上一轮，本轮从“看见真实指令与候选关联”推进到了“实际观察数据版本错误，并给出可核验的检查/切片证据”。** 同时，真实现代卡 trace 的 37 项未知结果说明：缺失的完成与版本观测无法靠更细周期模型推算成事实。

这些结果支持继续研究，但尚不足以宣称具备 TOG/VIS/TVCG 完整投稿证据。最值得补的是语义采集与真实任务价值，而不是先扩大模拟器微架构细节。优先获得可重新采集的 B200 环境及 tracer 资料，再完成真实 bug/fix、固定 AI 候选、开发者理解/核验研究。具体资源格式、顺序与验收指标已列入[下一阶段清单](../../semantic-next-stage.md)。
