# 语义证据下一阶段：实施边界与外部资源

更新：2026-10-23；现代卡资源状态已由本轮 Modal 实测更新。接续[完整投稿规划](async-gpu-paper-plan.md)、[多卡 trace 实验](experiments/2026-10-23-multigpu/report.md)及[本轮语义实验](experiments/2026-10-23-semantics/report.md)。这是一份执行与交付约定，不是已取得投稿结论的论文。

本轮已通过 Modal 执行 B200/SM100 与 H100/SM90 TMA；B200 tcgen05/TMEM 的 36 次常规运行与独立参考核验也已完成，完整结果以[现代 GPU 报告](experiments/2026-10-23-modern-gpu/report.md)为准。原表中硬件访问的阻塞已解除；真实故障/AI 候选和人的行为结论仍需各自证据。关于不依赖真人的技术路线及已执行 agent 先导，见[评价边界](agent-evaluation-scope.md)。

最新补充见[公开故障、实际 AI 隐藏测试与成本](experiments/2026-10-23-real-evidence/report.md)。其中 CUTLASS 零 K 超时已有 release 对照与三处上游 guards 回移证据；AI 六个候选和完整隐藏输出已运行；设备记录、回传、序列化与 compact-capture 分析成本分别测量。泛化诊断、工具条件收益和人类工作流仍不能由这些有限结果推导。

## 1. 是否需要更精细建模

需要，优先顺序是**逻辑版本与可观测性 → 同步/完成语义 → 跨实现对应 → 成本与性能**。当前真正的问题是“读的是哪个版本、完成的是哪项义务、我们凭什么知道”，增加 cache、流水线或 cycle 参数不能补回缺失的等待成功结果。

| 层次 | 需要表达的对象 | 本轮已实现 | 还不能声称 |
| --- | --- | --- | --- |
| 原始证据 | 来源哈希、记录位置、mask、地址、采样时点、字段缺失 | 13 CTA 保真导出；raw/static 对照；未知边界 | 所有 ISA 操作数齐全、Val 是写回值 |
| 数据身份 | tensor/区域、物理存储、完整 generation、读到的来源 | SM89 双缓冲、双架构 TMA 传输 tag 与输出；SM100 已选输入版本和 MMA 输出；有限 token 合约 | 自动从任意 SASS 恢复版本、跨 tiling 全覆盖 |
| 协议 | scope、完成类型、HB、reader-before-reuse | 三值义务推导；独立有限全序枚举；固定 kernel 源码屏障证明；现代卡成功 wait 观测 | 完整 PTX 内存模型、用 wait 返回观测反推硬件精确完成时刻 |
| 差异与展示 | 同一预期任务的不同实现、正面见证、未知原因 | 已有区域对应模型；本轮实测数据接入检查与切片 | 自动修复、新 kernel 的正确性证明或人已理解 |
| 性能 | 无插桩 kernel/应用时间、资源瓶颈、优化作用 | 前一轮 SM89 GEMM/MLP 对照 | 把结构缩减或诊断插桩时间当应用加速 |

不从 `commit` 出现推断异步操作已完成，也不把不同 completion domain 混为一项。例如 PTX 9.4 的 tcgen 特定 shared-read 完成只覆盖其约定的读阶段；等待结果、完整 generation 与作用域需要各自的证据。[官方 tcgen05.commit 语义](https://docs.nvidia.com/cuda/parallel-thread-execution/index.html#tcgen-async-sync-operations-commit) · [mbarrier 等待语义](https://docs.nvidia.com/cuda/parallel-thread-execution/index.html#parallel-synchronization-and-communication-instructions-mbarrier-test-wait-try-wait)。这些当前文档不能反向证明旧 trace 使用了新特性；每次采集必须固定工具链/ISA 版本。

## 2. 现在需要的外部资源

按阻塞程度排序。可以提供新的完整证据包代替远程机器；单纯增加同格式历史 trace 无法替代缺失字段。

| 优先级 | 具体资源 | 最小可用交付 | 解锁的实验 |
| --- | --- | --- | --- |
| 已获得 | **Modal B200/SM100 已实测可用** | 已授权 SSH/调度配置位置，GPU/驱动/CUDA 信息，可编译并运行小 kernel；支持修改插桩与保存 source/PTX/SASS/input/output | TMA→计算→等待→TMEM 读取/复用的真实正确、错误、修复闭环 |
| P0 | **实际采集器 provenance** | tracer 源码 commit/patch、实际加载 `.so` SHA、配置、采样点、丢记录/过滤声明；原始 kernel 二进制/静态 SASS 哈希 | 判断 mask、Val、谓词和 operand 的真实含义；排除归一化制造的伪因果 |
| 已获得 | Modal H100/SM90 对照已实测 | 可重跑相同逻辑输入的 TMA/WGMMA 版本及未插桩基线 | 跨代表示是否可迁移；不是 SM100 实验的替代 |
| P1 | **真实故障/修复仓库** | 最小复现、错误与修复 commit、输入 seed/形状、reference、运行命令、原症状；可含未能复现的历史样本并单独标注 | 真实错误覆盖与定位收益；避免只报告人为注入错误 |
| P1 | **固定 AI 候选及解释材料** | 一批可复现的生成记录，或可用模型/API 配置；模型版本、prompt、工具预算、完整候选/工具历史、代码与输出哈希 | 人核验 AI 修改、解释忠实度；不把本项目手写故障算作自然 AI 失败 |
| 取决于主张 | **GPU 开发者与独立评分者** | 先导参与者及两位能核对解释答案的领域评审；后续招募渠道 | 独立理解、错误建议接受率、修复表现；不能由程序测试或 LLM 自评替代 |

初次远程采集可先预留每架构约 2–4 小时、20–50 GB 工作区作为**规划预算**，先运行最小单 CTA 后按实际数据量调整；这不是实测耗时或云费用承诺。无需先取得大集群。保留无人干扰的未插桩测量窗口，并记录实际共享负载。当前未联系外部人员；本轮已运行有单卡、超时与容器数量限制的短时 Modal Functions，未建立持续部署。具体执行时长保留在原始记录中，不用命令 wall time 冒充账单。

先导可从 4–6 位有 CUDA/Triton 实践的开发者开始，目标是发现任务与评分问题、估计时间/方差，不作正式效应结论。原规划 32–48 人只是条件性预算；正式样本量应按主要终点、组内/组间设计、预期效应和任务/参与者聚类重新设计，并沿用机构适用流程。参与者、任务和数百条 trace 不能混作同一分母。

## 3. 新采集的最低证据契约

模板见 [semantic-capture-request.json](semantic-capture-request.json)。模板中的 `null` 明确表示尚未提供，不是默认已知。

1. **同一计算身份：** spec/reference 的源码与 SHA、输入张量及 seed/内容 SHA、dtype/layout/形状、误差阈值与全输出；correct/fault/fix 共享预期任务身份，二进制各自绑定。
2. **源码到指令：** kernel exact name、二进制/静态 SASS、PTX/源码行映射；提供 operand 的读写角色、宽度、tuple 与谓词，无法确定的指令保持 unknown。
3. **真实采样合约：** 指令前/后分别标注；predicate-on mask 与活跃线程 mask 分开；对 wait 记录返回成功结果；不能将指令前 destination value 当执行后的结果。
4. **版本与完成：** 显式 allocation lifetime、slot/full generation、barrier phase/token、transaction bytes、操作组身份与 completion domain。parity 可以辅助匹配，不能唯一标识长时间复用的版本。
5. **TMEM：** alloc 返回地址、列数、物理范围、generation、consumer 与 reader completion、release。编译推断与运行观察分字段保存；现有一个 512-column 静态 footprint 不能推广到所有 kernel。
6. **HB 与未知：** 每条 HB 有 ISA 规则或经审查的源码同步依据、scope、原始事件引用；文件顺序、不同 warp 的 post-barrier 回调先后、模拟器 cycle 均不自动证明 HB。丢记录时返回 unknown。
7. **成本与扰动：** 原始事件数量/丢失计数、存储大小、导入/分析/展示成本；另跑无插桩 correctness/performance；插桩改变调度时如实报告，不能外推原执行。

## 4. 收到资源后的执行顺序与停止条件

| 顺序 | 实际工作 | 验收条件与主要指标 |
| --- | --- | --- |
| S1 | 一个固定源码、单 CTA 的 TMA→MMA→读取 kernel；correct/fault/fix 三版本 | hash/输入身份闭合；独立数值 reference；关键版本/等待结果可观测；无法解释的阶段保持 unknown |
| S2 | 按机制分层：旧版本、phase/操作组错配、reader-before-reuse、尾块/layout；加入真实复现 | 每类报告支持数、unknown、TP/FP/FN；故障与修复共用输入；真实/注入分层；sanitizer/ConSan 仅在适用支持范围比较 |
| S3 | 训练/开发案例与冻结保留案例分离；跨算子/布局/架构泛化 | 对应 precision/recall 与拒答覆盖、独立 witness 核验；同一根因变体按组切分，不能随机拆 record 制造独立样本 |
| S4 | 固定 AI 候选：源码与日志、简单祖先、完整证据、新表示 | 相同信息/模型/预算；盲评解释中的来源、版本、同步和未知；错误解释接受率及正确拒答率；记录未完成 |
| S5（若保留人类收益主张） | 真正的开发者研究及无 AI 迁移测验 | 主要终点为独立理解/核验正确率；参与者和任务混合效应、区间估计；用时/信心为补充，不预设一定显著 |
| S6 | 优化与应用整合；论文收束 | 数值与模型质量先过关；固定预算选优；随机交错多会话无插桩时间、kernel/应用分别报告；无加速或不改善也保留 |

每一步可以因为不可观测、复现失败、真实效果不足而收缩主张。尤其是“新分析检测到旧版本”与“人能够学会独立解释”是两条需分别验证的假设。

## 5. 稿件路线与结论

沿原规划，当前最有希望形成的主轴是**帮助开发者核验 AI 修改的 GPU 算子：把逻辑版本、不同完成义务、未知边界连接到可回查的执行证据**。该贡献需要超越已有 GPU 执行/依赖可视化，补齐跨运行对应、证据保留与实际核验任务的收益。Daisen/Milestone 等近邻的原始实现与可用接口应按固定版本对照；未复现前不声称胜过其诊断能力。

VIS/TVCG 路线以可视分析任务、交互设计和相称的有效性验证为核心；若主要贡献最终成为人审查 AI 的行为证据，沿 CHI/TOCHI 路线组织。TOG 仍取决于最终对图形/交互社区的实质贡献，GPU/AI 负载本身并不自动建立匹配性；具体年份规则按投稿时重新核对，不能挪用旧年度页数/截止日期。

**本地 trace 加上 Modal 实机已支持证据保真审计、有限语义模型，以及现代 GPU 的受控版本错误/修复闭环。** 真实自然故障、AI 修复任务和可视分析工作流的泛化仍未完成；人类研究只在保留相应人的收益主张时成为必需证据。当前不能写成完整投稿实验已完成，也不能通过增加模拟器细节消除这些证据缺口。
