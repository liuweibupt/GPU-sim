# Modal 现代 GPU 与 agent 实验

日期：2026-10-23。研究阶段：受控实机机制验证与 agent development pilot；不是已完成的 TOG/VIS 投稿实验。接续[语义实验](../2026-10-23-semantics/report.md)，评价与投稿调整见[agent 评价边界](../../agent-evaluation-scope.md)。

交互证据：[双架构 TMA 全部运行](modern-evidence.html) · [B200 tcgen05 三版本代表运行](tcgen05-evidence.html)。两页离线可打开，显示实际输出、完整 generation、成功 wait、源合同和记录 SHA，不把代际排列伪装成硬件时间线。

## 1. 当前实际证据

本轮通过已授权 Modal 运行 NVIDIA B200（SM100，183359 MiB）与 NVIDIA H100 80GB HBM3（SM90，81559 MiB）。两者 driver 610.57.04，CUDA 13.1.80。H100 使用严格型号请求 `H100!`，实际身份有原始记录。现代 GPU 资源不再是原先的硬件访问阻塞。

| 实验 | 实际执行与分母 | 结果 | 能支持的结论 |
| --- | --- | --- | --- |
| B200 tensor TMA | 108 常规运行：6 shapes × 3 generation counts × 2 seeds × 3 variants；45,072 个有效输出 | 36 correct、36 repaired 全部正确；36 wrong-slot 均产生预期错误，15,024 个值及对应 tag 不匹配 | 真实 TMA 搬运后，等待完成与消费正确逻辑版本是两项不同要求 |
| H100 tensor TMA | 同一逻辑套件，另 108 次、45,072 个有效输出 | 与 B200 同一数值结论 | 该有限版本合约可在两代真实硬件上复测；不代表任意算子迁移已验证 |
| TMA sanitizer | 每卡 memcheck / synccheck / racecheck × 3 variants，共 18 次代表性运行 | 全部 0 tool errors，故障版仍由独立 oracle 检出错误输出 | 此故障处于已执行 sanitizer 的报告边界之外；不是一般性优于 sanitizer 的结论 |
| B200 tcgen05/TMEM | 36 常规运行：4 iteration counts × 3 seeds × 3 variants；921,600 个输出 | 12 correct、12 fixed 全部正确；12 wrong-version 共 307,200 个预期输出不匹配；所有运行均与已选输入的独立 oracle 一致 | 矩阵计算和完成协议可以合法，而所选输入属于错误完整 generation |
| tcgen05 sanitizer | 原构建 4 tools × 3 variants = 12 次；另严格 SM100a guardrail 构建 memcheck × 3 variants = 3 次 | 15 次均无工具错误；guardrail 构建故障版仍有预期旧版本输出 | 访问/分配检查与逻辑版本语义的覆盖边界不同；未测非法 TMEM 访问的检出灵敏度 |
| agent 盲测 | 12 合成开发任务 × 2 等信息表达 × 2 重复 = 48 次；另 2 次 smoke 不计分 | flat 24/24、structured 24/24，12 个任务全部打平；0 无效/超时/工具污染 | agent 能消费这批有限证据；没有测出表达收益，也不能推导人类理解收益 |

这些是运行/参数点数。TMA 错槽位是一个人为控制的根因族，不是 72 个独立自然 bug。新的采集不能补填旧 trace 中没有观察到的字段。

## 2. TMA：成功等待后仍读错版本

实际执行 `cuTensorMapEncodeTiled` rank-2 tensor map 和 `cp.async.bulk.tensor.2d`；payload 与 generation tag 交错存储并由同一次 TMA 搬运。每次 transfer 的事件在 `mbarrier.try_wait.parity.acquire` **实际返回 true 之后**记录；CPU 检查器独立验证所有有效输出、tag、transaction bytes、tensor map、事件身份和源码位置。

每卡保存 1,584 条常规事件、504 个成功 wait 观察。两卡合计 90,144 个输出、3,168 条事件、1,008 个成功 wait。形状包括 1×1、1×17、2×31、3×33、4×64、8×63，generation counts 为 1/2/5，种子为 20261023/20261024。非整齐形状测试的是 padded tile 中消费者的逻辑尾部，不是 TMA descriptor 越界填充。

错版选择另一个**已初始化、已完成传输**的 slot，读取 g−1（首代为初始 −1）；修复选择当前 slot。这个构造使地址和同步合法，便于隔离“正确的等待”与“错误的逻辑来源”。原始事件数组位置不是时间戳；跨 warp 顺序依据固定源码的 acquire wait、CTA barrier、proxy fence 和读者完成屏障合同。

## 3. tcgen05 / TMEM 的测量范围

B200 首轮 smoke 的 M128/N32/K16 FP16→FP32 GEMM 共 4,096 个输出全部与独立整数 oracle 一致。实际包含 TMEM alloc、tcgen05 MMA、full-completion commit、成功 acquire wait、TMEM load/wait、reader completion 和 dealloc。源码先以 `sm_100a` 编译，再在 B200 执行；没有在本地 SM89 上模拟成功执行这些指令。

完整套件的 iteration counts 为 1/2/5/17，seeds 为 0/7/65535，generation base 覆盖 0、2^53 和接近 uint64 上限。36 次运行合计 225 个迭代、2,475 个实际事件、900 个成功 wait 观察，另有对应的代表线程读后观察。所有运行 selected-source mismatch 为 0；故障版选择旧两代输入，75 个故障迭代的完整 generation 均不匹配但 parity 相同。修复版实际读取 device tag 后修正输入选择。generation 是从 device input tag 实读的**已选输入版本**，不是从 TMEM 中读出的标签；全部 MMA 输出另与 selected-source reference 及 requested-source reference 比较，分别证明计算了所选输入和是否满足原任务。`clock64` 保存为观察值，不用于跨线程强行建立 HB。

常规构建另完成 memcheck、racecheck、synccheck、initcheck 各三版本，共 12 次代表性检查；工具输出均没有错误或不支持诊断。TMEM guardrails 另用 `-gencode arch=compute_100a,code=sm_100a -Xptxas=-g-tmem-access-check` 编译后运行 3 次 memcheck；独立 CPU 重新检查了这些运行的 61,440 个输出。第一版 `-arch=sm_100a` guardrail 构建对附带的通用 SM100 target 给出忽略该选项的诊断，原记录保留但不计入正式 guardrail 三次；严格目标重跑无该诊断。静态指令检查、编译选项、工具报告与数值 oracle 分别保存。

普通 `-lineinfo` 不等于开启 TMEM guardrails，racecheck 也不意味着覆盖所有 TMEM races。工具范围与官方来源见[已核查的支持边界](../../natural-gpu-bug-candidates.md#cuda-131--compute-sanitizer-的-tcgen05-边界)。两类 sanitizer 构建不混作同一二进制，也不用于性能比较。

目前 TMA 与 tcgen05 是两个分别验证的微实验，没有把它们写成已验证的融合 TMA→MMA 重叠流水线。只有单 CTA；不覆盖 multicast、跨 CTA、WGMMA、partial-completion 新变体、真实竞态故障、生产规模性能。

### 协议检查与切片

| 接入 | 义务总数 | satisfied | violated | unknown |
| --- | ---: | ---: | ---: | ---: |
| 双架构 TMA | 2,256 | 2,064 | 192 | 0 |
| B200 tcgen05/TMEM | 3,150 | 2,850 | 300 | 0 |

全部 492 项违例均来自受控错误版的 requested value generation；针对**实际消费版本**的完成和复用义务满足。查询单位不是独立故障：TMA 每代的 query、tcgen05 每迭代四个代表 consumer query 都有相关性。零 unknown 只适用于完整、固定源码探针合同，不是对历史 trace 或未知 kernel 的结论。

离线遮蔽版本、成功等待 token、HB 接口后，TMA 分别得到 576、1,152、840 个目标 unknown；tcgen05 分别为 900、1,800、1,125。完整 raw facts 仍保留，这些是检查器接口消融，不是重新制造的 GPU 故障。切片核验保留相应义务、见证及未知边界。tcgen05 的整个 TMEM 区域读者完成节点来自全体 128 线程的 CTA 屏障合同；单独的四个 lane0 读后记录只作为局部观察，不能代替全资源完成。

tcgen05 初次导出把每个切片的完整图反复展开，在 17-iteration 输入触发 Node 字符串长度上限。保留未完成尝试及失败说明；最终输出改为完整 baseline/ablation 图、每个实际检验切片的 SHA/bytes 和可确定重建规则。3,150 个 baseline 与 9,450 个 ablation slices 均执行保真检查，另从最终存储重建 18 个有界切片核对。最终 36 个结果 gzip 合计 4,431,967 bytes，对应 116,872,368 原始 bytes。这个存储修正解决了本轮导出，不等于生产 trace 可扩展性已经验证。

## 4. agent 评价：可执行，但目前有天花板效应

冻结 fixture SHA-256：`8d394fe5623ca027f4aaf1a919fb3af94886aedcaad3e80a1cf7849f87a8e7f1`。任务包含 satisfied / violated / unknown 各 4 个；答案来自独立有限全序枚举。两条件共享同一匿名事实、规则和查询，区别仅为平铺字段文本或结构化 JSON；均不提供检查器答案。模型请求名 `gpt-6-astra`，reasoning low，CLI 版本及实际参数保留在原始记录中；服务端未暴露的模型权重快照保持未知。

每次调用使用新的空工作目录、ephemeral 会话、禁用 shell、忽略用户配置，审计原始 JSONL 中的额外工具操作。程序检查答案、引用存在性、规定证据覆盖和缺失证据代码；没有用出题模型给自己打分。自然语言 reason 没有全面语义评分，引用覆盖不等于解释中的每句话都正确。

两条件状态及有限证据评分都为 24/24，任务配对差值为 0。平均 CLI wall time 分别为 8.501 s 和 8.576 s；它包含网络、排队、缓存和服务因素，不是独立推理时间或人的调试用时。重复调用不是不同参与者。12 题来自已知 development corpus，不是保留集中的自然故障，不能据此报告真实故障诊断准确率。

这个结果说明下一轮应增加冻结的新根因、干扰证据、长路径和缺失观测，并独立评价可执行修复及隐藏输入；不能将当前满分包装为结构化表达或可视化的提升。若论文主张人更能理解、信任更准确或学习迁移，仍要直接取得相应人类结果。

## 5. 可重复性与证据边界

复现入口：[Modal runner](../../../../tools/research/modal/README.md)、[agent pilot](../../../../tools/research/agent-eval/README.md)。常规主套件合计 252 次 GPU 运行、1,011,744 个输出；正式代表性 sanitizer 检查合计 33 次。smoke、第一版带诊断的 guardrail 构建和身份探测都单独保留，不计入这些分母。每个云端 job 保留 source/runner/job SHA、真实 GPU、工具链、镜像 ID、完整命令 stdout/stderr、PTX/SASS、所有输出和独立检查。编译 ELF 只保留云端 SHA 与字节数，未取回其原始字节；不能称已在本地重新 hash ELF。

受控故障退出码 2 只有在保存的输出和事件符合预定故障后才被 suite 接受；不是把任意非零退出都算成功。远端函数有超时和单容器限制，完成后停止 ephemeral app。初次身份探测因本地/镜像 Python minor version 不一致在 GPU 函数创建前失败，失败记录保留；它不计为 GPU 数值运行。Modal 计费不能由 command wall time 精确还原。

最终归档保持原文件 SHA 和字节数，大文件以确定性 gzip 无损存储。工具调用与源文件经过本地核验；归档哈希检查只证明相对于记录的完整性，不提供独立可信硬件签名，也不证明任意输入上的程序正确性。

## 6. 对投稿和下一阶段的影响

现在可以用真实现代 GPU 结果论证“完成某个操作不等于消费了预期版本”，并展示从实际数据到义务和可回查证据的过程。比继续添加 cycle/cache 参数更有用的建模是完整 generation、不同 completion domain、读者完成与复用身份，以及无法观测时的 unknown。

已锁定[四个公开自然故障候选及固定版本](../../natural-gpu-bug-candidates.md)，包括 B200 的 TMEM descriptor 生命周期错误与混合 TMA AutoWS 等待遗漏；它们尚未在本项目复现，不计作本轮结果。当前最有价值的下一批证据是自然 GPU 故障/修复、固定 AI 候选与隐藏测试、可视分析工作流、公开可用基线和未插桩成本/性能。真实故障的来源、根因与修复必须独立于我们为展示方法编写的受控用例。继续评估 VIS/TVCG 方法路线，TOG 仍需实质图形/交互贡献；本轮没有建立可直接投稿或可录用的结论。

真人不是所有系统论文的统一前置条件：[VIS 2026 审稿规则](https://ieeevis.org/year/2026/info/call-participation/review-instructions/)和[SIGGRAPH 2026 审稿规则](https://s2026.siggraph.org/technical-papers-reviewer-instructions-ethics/)都要求验证方式与贡献相称。当前可以先以技术有效性和 agent 任务评价推进；不要声称 agent 调用取代了对人的收益测量。

## 7. 本地核验与归档复用

本轮仓库 342 项 Node 测试、agent 评价器 8 项测试、34 项 Python repository 测试及 9 项 tcgen05 oracle 测试通过；最终修改后的 tcgen05 bridge 与归档恢复又执行了针对性检查。Chrome 对 TMA 页面核对 216 个 runs、576 个代际选择及全部 90,144 个输出；tcgen05 代表页核对 3 个 runs、15 个迭代及 61,440 个输出，另核对完整 uint64 generation 与低位关系。DOM 检查和截图审查是界面正确性验证，不是人类可用性研究。

[归档 manifest](evidence/manifest.json)记录每个源文件、原始运行、模型调用、图/切片结果与查看器的原始及存储 SHA。失败的身份探测、带诊断的 guardrail v1，以及 tcgen05 首次导出失败说明保留；首次巨大未完成导出的重复 partial files 不纳入正式数据。

```bash
python3 tools/research/archive-modern-evidence.py \
  --verify docs/research/experiments/2026-10-23-modern-gpu/evidence
python3 tools/research/archive-modern-evidence.py \
  --extract docs/research/experiments/2026-10-23-modern-gpu/evidence \
  --to out/research/modern-restored
```

恢复后 `modal/` 含云端原始记录，`agent/` 含冻结题目及全部回答，`tma-protocol/`、`tcgen05-protocol/` 含有界检查结果，`source/` 保留本轮工具与依赖的源码快照。完整 agent 报告在 `evidence/agent/report.md`；主表评分的程序核对见 `evidence/agent/verification.json`。
