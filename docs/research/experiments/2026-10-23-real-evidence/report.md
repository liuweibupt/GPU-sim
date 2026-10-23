# 真实故障、AI 隐藏测试与成本：实证补充

日期：2026-10-23。接续[受控现代 GPU 实验](../2026-10-23-modern-gpu/report.md)。本轮回答三个问题：公开故障是否在实机复现并被实际修复；真实 AI 生成的 CUDA 候选能否通过事先冻结的隐藏测试；当前采集和分析原型的实际成本是多少。评价对象是 GPU 系统与可视分析的技术证据，不把这些结果当作人类理解实验。

后续已完成[真实故障交互诊断与代理修复对照](../2026-10-23-interactive-repair/report.md)，可打开[交互诊断页](../../../../web/research/natural-bugs/index.html)检查本报告的 CUTLASS／Triton 证据。原始读取与诊断工具条件各修复 **6/6**，没有工具优势证据；这是两个公开根因、单文件预定位的 agent 实验，不代表用户研究或人的理解收益。本报告保留本轮实验的原始范围与分母。

## 1. 公开故障与修复

### CUTLASS：零 K 超时与独立 epilogue 检查

上游 [#2547](https://github.com/NVIDIA/cutlass/issues/2547) 报告 Hopper grouped GEMM 在 K=0 时出现 descriptor 错误／挂起，维护者确认 4.2 修复。本轮固定 4.1 `e51efbfe18fe4f4cbb66ab814c55bf4aa0185491`、4.2 `59b61c606fe7aa4d33e60d3e6352cbfde98361c3`，在 **H100 / SM90、CUDA 13.1** 编译执行。它是从 H800/CUDA 12.4 迁移后的缩小复现：M=N 从 4096 降为 128；保留原报告完整 32 项 K-splits，另测零 K 位于首／中／尾、全零和非零对照。

原 issue 写的是 example 67；两个固定版本中实现 grouped GEMM 的是 **example 68**。没有修改 kernel。主机端只加入完整输出保存、独立 K=0 oracle，并将两种 host-shape 模式分到独立进程。每个进程超时 10 秒。

| 对照 | 分母与实际结果 | 解释 |
|---|---|---|
| 4.1，β=0 非零 K | 2/2 通过 | 两种 host-shape 模式的正对照成立 |
| 4.1，β=0 含零 K | 10/10 超时 | 5 个输入族 × 2 模式；是一个根因族的参数点 |
| 4.1 + 三处上游 empty-K guards，β=0 | 12/12 通过，含原先全部 10 个超时配置 | 相同源树只修改一个 collective header 的三处 guard；其他库文件和观测 `.cu` 不变 |
| 4.2，β=0/1 | 24/24 常规运行通过 | 3,080,192 个完整输出与上游 reference 一致；K=0 另用独立 `β*C` oracle |
| 4.2 memcheck | 4/4 通过、0 errors | 仅覆盖所选 zero-first/zero-middle、β=1、两种 host-shape 模式 |
| 4.1，β=1 | 12/12 `SIGABRT/cuda_exception`，含两个非零 K 对照 | 单独保留的混杂因素；不能归因于零 K，也没有声称 backport 修复它 |

三处 guard 来自上游 4.2 的零 K 路径修改。组合回移消除了已观测超时，提供了比整个 release 对比更窄的干预证据；未逐项消融，不能称为数学意义的最小必要修复。静态源码显示修复约束空 K 下的消费等待和 pipeline release；本轮没有 PC 采样或指令级等待记录，不能说已动态定位某条 wait，也没有观测到原报告中的 descriptor error 文本。

修复是否只是返回全零也被实际排除：4.2 的 β=1 常规运行中，**655,360 个零 K 输出包含 491,312 个非零值**，全部等于 C。四次 memcheck 另检查 65,536 个零 K 输出。Python 从保留的 FP8 E4M3 bytes 独立解码复核；K>0 的 GEMM reference 仍来自上游 CPU 实现，不能说是独立重写的 GEMM oracle。

加上 backport 与 4.2 的同机复测，本轮 CUTLASS 共 **72 次常规运行 + 4 次 memcheck**，完整保留并复核 **6,455,296 个已产生的输出**；超时／异常的未产生输出不记为数值正确。一个 issue、10 个参数点、76 次执行有不同统计含义。

### Triton：选择后的 TMEM descriptor 生命周期

上游 [#11634](https://github.com/triton-lang/triton/issues/11634) 的问题是：两个 TMEM allocation 分别保存 3、5，运行时选择一个 descriptor；之后保存 7 的 temporary 被错误地分配到仍存活的区域。这里是编译器生命周期分析问题，不是本项目人为选择旧 slot。

从源码分别构建修复提交 `0002b46dadfc6f8fbe7464c285651311c709fdc6` 和唯一父提交 `08a3cd4364d87bf2c281067f7a40e17808f22e7b`。两份源归档各 1,778 个 regular source files，构建后逐文件核对均无改动；两提交仅 allocation pass 与其 lit regression 两个文件不同。使用[作者固定提交的原样 16-case runtime 函数](https://github.com/1sgtpepper/triton/blob/1f33b120daccd127b9f464623fb960f3d5ece536/python/test/gluon/test_core.py)，没有修改 kernel、launch、参数或 assertions。

实机为同一 Modal **B200 / SM100、driver 610.57.04**，Python 3.12.3、PyTorch 2.12.0+cu130。安装时校验 exact wheel 与 native compiler SHA。容器 NVCC 为 13.1；编译器自身绑定的 Blackwell PTXAS pin 为 **13.4.59**，不能统称 CUDA 13.1 assembler。

| 检查 | 修复父提交 | 修复提交 |
|---|---:|---:|
| 原样 pytest，无 observer | 9 通过、7 数值断言失败 | 16/16 通过 |
| 保留完整输出与编译产物的同一测试 | 9 正确、7 错误 | 16/16 正确 |
| 完整输出元素（selected + 有效 temporary） | 172,032 | 172,032 |
| 错误输出元素 | 28,672 | 0 |
| CPU allocation lit regression | `triton-opt` 成功，FileCheck 失败 | `triton-opt` 与 FileCheck 均成功 |

七个失败 case 的 selected 输出均是 7，而非预期的 3／5，每例 4,096 个元素；修复后全部恢复。temporary 本身由独立常数 7 oracle 核验；TEMP_COLS=0 时未使用的 temporary buffer 不计入输出。32 个原样 case 执行与32个观测 case 执行逐例结果一致；完整输出分母只取后者，合计 **344,064**，不把重复执行当独立根因。没有修改生成 IR 或补插 GPU 事件来制造该结果。

记录实际编译产物、PTX、SASS、device cubin 和 allocation pass IR；这些是静态编译证据，不能伪装成硬件内部版本标签或动态时间线。完整输出由独立脚本重算，并绑定 case、编译产物和来源 SHA。原样测试与 observer 的匹配支持观测未改变这组结果，不证明任意程序零扰动。

进一步从实际 pass dump 提取 allocation 前后 IR，用 GLIR/TTGIR 内容逐字匹配绑定到每例真正编译的 kernel hash，而非猜测编译顺序。每版有七个 unique kernels、16 个 runtime case。典型 late-select 的 first/second 占 `[0,32)`、`[32,64)` 列，修复前 temporary 从第 0 列开始，修复后从第 64 列开始：

| 实际编译路径 | 修复前 temporary 区间 | 与仍存活来源的重叠 | 实测错误 case |
|---|---|---|---:|
| select，64 列 late temporary | `[0,64)` | first 和 second 都被覆盖 | 2/2 |
| select，32 列 late temporary | `[0,32)` | 仅 first 被覆盖 | 1/2 |
| chain，64 列 late temporary | `[0,64)` | 两种候选来源都被覆盖 | 4/4 |
| early temporary、direct descriptor、无 temporary 对照 | 依实际 IR 分别核验 | 被选来源无该生命周期重叠 | 0/8 |

修复把上述 temporary 移到第 64 列；32 列 temporary 的区间为 `[64,96)`。相关 kernel 的总 TMEM 分配从 64 增至 128 列，七个错误 case 全部消失。该固定直线 IR 的窄审计在两版共 32 个 case 上，静态来源重叠与实际输出错误一致。它给出了“为何恰好七例失败”的可回查解释；没有测量该资源增长的性能代价，也不代表通用 alias/liveness detector 或现有 protocol checker 已覆盖任意编译器程序。

首个云镜像缺 `Python.h`，pytest 在 collection 阶段停止，数值用例数为零。该准备失败保留，加入 `python3.12-dev` 后使用相同编译器与测试重跑；失败尝试不纳入上述成功复现分母。

## 2. 实际 AI 候选与冻结隐藏测试

先冻结公开合同、隐藏 generator 和 31 个具体输入，再调用模型。冻结时间为 `2026-10-23T12:45:02.658499Z`，首次生成开始为 `12:45:02.777Z`。模型为本会话实际可用的 `gpt-6-astra`，low reasoning；每合同两次独立 ephemeral 调用，最多两路并发、每次 90 秒，**零反馈、零修复、零手工修改候选**。

| 算子合同 | 候选 | 唯一隐藏用例 | 两轮功能验证输出数 | 结果 |
|---|---:|---:|---:|---|
| FP32 strided RMSNorm | 2 | 11 | 16,940 | 全通过；最大绝对误差 2.3842×10⁻⁷ |
| FP32 strided transpose | 2 | 10 | 33,528 | 位级输出、padding 与 guards 全通过 |
| int32 segmented sum → int64 | 2 | 10 | 1,120 | 空 segment、尾部、超过 int32 范围的精确和均通过 |

六个候选全部原样编译成功。两轮功能测试合计 **124 次 case 执行、51,588 个输出元素、16 次 metamorphic 检查**。memcheck/racecheck/initcheck/synccheck 共 **24 次调用**，另核对 248 次 case、103,176 个输出、32 次关系检查，均通过。重复调用不增加独立任务数；唯一 metamorphic 关系是四条。

隐藏输入覆盖不连续 stride、tail、空维度／segment、signed zero、RMS 零行和宽整数累加。检查器同时验证未修改输入／offset、完整输出 buffer 和两端 guards；数值评分由 Python double→FP32、直接索引及 Python 整数和完成。生成进程只收到公开合同与 response schema，使用空工作目录、忽略用户配置、禁用工具；原始 JSONL 没有额外工具项。模型输出、保存源码、编译输入和执行结果由 SHA 连接。这里的隐藏性指模型提示和工作目录层面，不是正式隔离的保密评测服务。

**这是满分／天花板结果。** 三个合同是常见算子，两个 transpose 候选和两个 segmented-sum 候选采用相近策略；六个源码 SHA 不等于六类算法或六个模型。本轮没有工具条件比较、自然故障保留集或人类参与者，不能据此报告调试收益、修复能力提升或人类理解提升。它补齐的是实际代码生成→冻结候选→隐藏输入→全量输出验证这一可审计链路。

## 3. 采集成本：设备、回传与序列化分别计量

从冻结 SM89 version probe 派生匹配的 baseline/instrumented 编译实例：保留相同 payload、输出、CTA 和同步，baseline 移除辅助 tags 与事件。测量是两者的**联合记录开销**，含编译后寄存器与共享内存变化；不是单条 store 成本。硬件是本地 RTX 4090，不代表 TMA/tcgen05 的插桩开销。

3 个独立进程 session，每形状每模式预热 20 次、30 个随机顺序配对，合计 **360 对／720 条正式样本**。每个样本全量检查；24 份 preflight 完整 payload 另经 Python oracle。下表设备时间是 CUDA graph 内 start-event→kernel→stop-event 区间，含 event/graph 调度，**不是纯 kernel 硬件时间**。增量先逐对求差，再取中位数。

| count × generations | baseline → 记录版区间（μs） | 配对增量（μs） | 额外证据回传 host（μs） | 序列化 baseline → 记录版（ms） |
|---|---:|---:|---:|---:|
| 32 × 1 | 3.296 → 3.568 | 0.128 | 9.44 | 0.0009 → 0.0023 |
| 257 × 5 | 3.888 → 4.496 | 0.496 | 9.94 | 0.0238 → 0.0812 |
| 4096 × 8 | 3.792 → 5.072 | 1.216 | 55.73 | 0.634 → 2.274 |
| 4096 × 64 | 12.432 → 21.728 | 9.344 | 391.29 | 5.476 → 19.737 |

独立 Nsight Systems profile 核对 64 个实际 kernel 节点。最大配置纯 kernel 中位数为 3.280→13.153 μs，支持增量量级；每形状每模式仅 8 次且含预热，不能用这个短 profile 替代正式分布或把 graph 比例当纯 kernel 比例。各阶段的时间作用域不同，不从上述中位数相加推导端到端延迟。该 profile 是环境继承设置修正后的独立重跑，正式 720 条样本保持原字节不变。

完整 Nsight 容器仍携带环境元数据，因此所有新旧 `.nsys-rep`／SQLite 均不发布，只保留原始 SHA 和省略原因。公开的是限定 CUDA 字段、64 条 kernel、128 条 memcpy、730 条 API 记录及其引用的函数名；不导出任意字符串表。发布材料经过当前敏感环境值及嵌套 gzip 内容的逐文件匹配检查。此检查不声称能发现所有历史或编码形式的秘密。

最大配置额外证据 **2,523,136 B、40,960 条事件**；输出值另有 1,048,576 B，完整 JSON 中位大小约 9.0 MB。此配置的完整文本序列化远贵于设备记录增量，因此下一步优化应首先验证选择性采集、二进制／列式编码和按需输出。本轮没有实现或声称这些优化已带来收益。

保留了被否决的测量：早期直接 event/kernel/event API 调用被 host 提交间隙污染，出现约 0.84× 的假负开销。正式 v4 改为单 graph 提交，配合 Nsight 核验。准备版本、工具失败／重试和被否决 v3 均保留，未挑掉不利数据。机器未锁频；GPU 与本任务其他实验错峰，系统资源仍共享。

## 4. CPU 分析成本

复用已经实测的 **216 个 TMA + 36 个 tcgen05 capture**，先验证存储／解压 SHA 并重算 protocol 结果一致。计时入口为这些结果中的 compact capture；**原始数据解码、语义映射、归档解压和 GPU 数值 oracle 不在本项计时内**。3 个进程 session，每 capture 5 次预热、10 次计时，共 **7,560 条样本**。

| 代表输入 | `checkProtocol` 中位数 / p95 | 单个完整 slice 中位数 |
|---|---:|---:|
| B200 TMA，5 generations | 0.442 / 0.895 ms | 0.440 ms |
| H100 TMA，5 generations | 0.445 / 1.189 ms | 0.441 ms |
| B200 tcgen05，1 generation | 0.365 / 0.681 ms | 0.223 ms |
| B200 tcgen05，17 generations | 8.155 / 21.463 ms | 2.217 ms |

读取、JSON parse、check、单个 slice、run/slice serialize 分开保存原始分布；read 是 warm OS cache。进程峰值 RSS 166.4–179.0 MiB，不能归为单次操作内存。固定 CPU 84，但 192 logical-CPU 主机的 load average 约 381–391；因此这是共享环境的描述性结果，不能声称独占机器或已解决大规模 trace 可扩展性。此项与 SM89 采集实验使用不同输入，不拼成同一流水线的端到端性能。

## 5. 对论文主张的影响

本轮把证据从受控 wrong-version 示例推进到公开软件故障与实际修复，并加入真实 AI 代码及冻结隐藏测试、分阶段成本。技术评价可以由可执行 oracle、上游回归、agent 候选和自动复核完成；**“让人更能理解／更快调试”仍需要对应的人类结果，agent 调用不能代替该证据。**

仍未建立的主张包括：现有 source-bound checker 自动诊断这些自然故障、跨根因泛化、工具辅助 agent 的因果收益、生产 AI 算子的可接受开销、以及人的理解收益。公开 issue 也没有证据被 AI 编写，不能改称 AI 代码的真实故障。

投稿方向继续以 VIS/TVCG 的 GPU 可视分析系统为主线：问题与分析任务 → 可回查证据表示 → 交互诊断 → 技术正确性与成本 → 对贡献相称的任务评价。TOG 仍需实质的图形／交互贡献，不能仅凭 GPU 硬件和 AI 负载直接保证适配。当前补充提高了技术证据的可信度，尚不构成可直接投稿或可录用的结论。

## 6. 复现与原始证据

工具入口：[公开故障](../../../../tools/research/natural-bugs/README.md)、[AI 隐藏测试](../../../../tools/research/agent-kernel-eval/README.md)、[采集与分析成本](../../../../tools/research/costs/README.md)、[Modal runner](../../../../tools/research/modal/README.md)。

固定归档见 [evidence/manifest.json](evidence/manifest.json)，保留原始与压缩后双 SHA、原始字节数和分组来源。较大的文本与完整输出 buffer 无损 gzip；不是截取部分输出。host 可执行文件和两份大型 Triton wheel 以源码、构建日志和 SHA 收据复现，不直接放入 Git；显式保留的 device cubin 有对应编译来源。原始运行失败、预备镜像失败和被否决的计时方法也留有记录。

| 归档分组 | 可复核内容 |
|---|---|
| `modal-cutlass` / `modal-cutlass-backport` | 实际 H100 命令、完整输出、退出码、超时、sanitizer、源与二进制身份 |
| `cutlass` | source diff、三处 guards、独立 FP8 oracle 和输出复核 |
| `modal-tmem` / `modal-tmem-setup` | 成功 B200 对照与首次准备失败；pytest、完整输出与实际编译产物 |
| `tmem` | exact compiler 构建、CPU lit、独立数值复核、14 kernel / 490 pass chunks / 28 IR 片段审阅 |
| `ai` | 冻结输入、完整模型响应、原样候选、两轮输出、24 次 sanitizer 与完整性复核 |
| `costs` | 720 + 7,560 条正式样本、阶段分布、公开 profiler 行、省略收据和安全发布检查 |
| `source` / `validation` | 本轮最终分析源码、测试日志；实际执行时源码快照另随各运行保存 |

从仓库根目录恢复并验证：

```sh
python3 tools/research/archive-modern-evidence.py --verify \
  docs/research/experiments/2026-10-23-real-evidence/evidence
python3 tools/research/archive-modern-evidence.py --extract \
  docs/research/experiments/2026-10-23-real-evidence/evidence \
  --to out/research/restored-real-evidence
python3 tools/research/natural-bugs/cutlass_verify.py \
  --input out/research/restored-real-evidence/modal-cutlass/artifacts/matrix \
  --output out/research/restored-cutlass-verification.json
python3 tools/research/natural-bugs/cutlass_verify.py \
  --input out/research/restored-real-evidence/modal-cutlass-backport/artifacts/matrix \
  --output out/research/restored-cutlass-backport-verification.json
python3 tools/research/natural-bugs/tmem_compare_repro.py \
  --before out/research/restored-real-evidence/modal-tmem/artifacts/before \
  --after out/research/restored-real-evidence/modal-tmem/artifacts/after \
  --plain-before out/research/restored-real-evidence/modal-tmem/artifacts/plain-before.xml \
  --plain-after out/research/restored-real-evidence/modal-tmem/artifacts/plain-after.xml \
  --output out/research/restored-tmem-verification.json
```

归档共 **2,669 个文件**，原始约 55.3 MB、存储约 39.6 MB（不含 manifest），通过 1,838 项 Modal 绑定检查。完整恢复后再次通过 CUTLASS 全输出复核、Triton 配对 oracle；AI 403 个压缩成员重新验 SHA，36 个阶段的 154,764 个完整输出重新评分一致。Node 345、仓库 Python 56、AI harness 3、成本 Python 8、TMEM verifier 7 项测试均通过；成本 Node 测试已包含在 345 中，不重复计数。

验证汇总见 [validation.json](validation.json)。这些复核不重新租用 GPU；可从已归档完整输出重新推导数值结论。
