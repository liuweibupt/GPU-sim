# 真实 GPU 故障候选：下一阶段复现清单

核查日期：**2026-10-23**。本页仅进行了上游公开 issue、PR、commit 和官方文档的只读核查，**没有安装候选版本、执行复现或确认本项目能诊断这些故障**。以下数字均是上游报告，不能计入本项目实测样本、召回率或已修复案例。它们来自既有编译器／库故障，区别于本项目自行构造的 wrong-slot / wrong-version 对照；也没有证据把它们归因于 AI 编写代码。

优先在已有 Modal B200 上做候选 1、2，在 H100 上做候选 3；候选 4 的原报告硬件是 B300，B200 迁移需单独确认。所有 PR 的合并状态、提交 SHA 和父提交均已通过 GitHub REST API 核验，issue 的关闭状态也已实时核验。

| 优先级 | 候选及当前状态 | 可固定的前后版本 | 原报告／建议设备 | 复现入口 |
|---|---|---|---|---|
| P0 | Triton TMEM descriptor 选择导致提前复用；[#11634](https://github.com/triton-lang/triton/issues/11634) closed；[#11636](https://github.com/triton-lang/triton/pull/11636) merged，2026-09-21 | 报告失败版本 `1665fa9a96713f0157e5436f247369d83d0a6632`；修复 `0002b46dadfc6f8fbe7464c285651311c709fdc6`，父提交 `08a3cd4364d87bf2c281067f7a40e17808f22e7b` | 原报告 B200 / SM100；直接适合下一轮 B200 | 固定的 Gluon runtime test，16 个参数组合 |
| P0 | 混合 TMA／普通 load 的自动 warp specialization 等待遗漏；[#9111](https://github.com/triton-lang/triton/pull/9111) merged，2026-01-07 | 父提交 `eb647a8205ff230d0b2ca76ac7104d36ae9da441` → 修复 `7a0f43c3a45ca4a60bbb06bbc94807ee862748b0` | Blackwell；混合 load 测试在 Hopper 上明确 skip | 上游 warp specialization 数值测试和 ConSan 测试 |
| P1 | Hopper grouped GEMM 的 K=0 问题触发 TMA descriptor 错误／挂起；[#2547](https://github.com/NVIDIA/cutlass/issues/2547) closed，2025-09-16 | `v4.1.0`=`e51efbfe18fe4f4cbb66ab814c55bf4aa0185491` → `v4.2.0`=`59b61c606fe7aa4d33e60d3e6352cbfde98361c3`；**这是版本边界，不是已定位的单一修复提交** | 原报告 H800、CUDA 12.4、driver 535.183.06；H100 需确认迁移 | CUTLASS example 67，加报告所列含零 K 的 grouped problems |
| P2 | 循环内两次 MMA 共用 accumulator 被错误流水化；[#10821](https://github.com/triton-lang/triton/issues/10821) closed；[#10858](https://github.com/triton-lang/triton/pull/10858) merged，2026-07-17 | 父提交 `87a4ab9259e1fa05b99ccf81025c82bca4bed432` → 修复 `9e089e37bc38e2c2a71354e3b218987fbf7cccbd` | 原报告 B300 / SM103，明确未测 B200；H100 对照未出现问题 | issue 完整 Python reproducer；另有固定提交的 compiler regression |

## 1. TMEM 生命周期穿过运行时 descriptor 选择

两个 `128×32` TMEM allocation 分别存 3、5，运行时标量选择其中一个；后续 `128×64` temporary 存 7。上游在 B200 报告 selected load 的全部 4,096 个元素变成 7，而非应得的 3 或 5。生命周期分析追踪 view，却没有穿过 `arith.select`；修复使所有可能来源保持存活直到最后一次 selected use。[issue 与环境](https://github.com/triton-lang/triton/issues/11634)、[精确修复](https://github.com/triton-lang/triton/commit/0002b46dadfc6f8fbe7464c285651311c709fdc6)。

可复用的完整 runtime harness 已核实存在于作者固定提交 [test_core.py@1f33b120](https://github.com/1sgtpepper/triton/blob/1f33b120daccd127b9f464623fb960f3d5ece536/python/test/gluon/test_core.py)，入口 `test_tmem_selected_descriptor_lifetime`。它覆盖 choice=0/1、直接／链式选择、32／64／0 临时列数、提前分配等 16 个组合；issue 报告失败版本中 7/16 失败。merged PR 本身加入的是四个 allocation-pass **lit 编译器测试**，不能将这些测试说成已经合入的 GPU runtime 回归。[合入的 lit 文件](https://github.com/triton-lang/triton/blob/0002b46dadfc6f8fbe7464c285651311c709fdc6/test/TritonNvidiaGPU/test_tensor_memory_allocation.mlir)。

下一轮先原样跑上述 harness：固定失败版本、修复父提交、修复提交各自隔离安装；使用同一份 harness，保存其 SHA。原报告环境为 Python 3.12.1、PyTorch 2.12.0+cu130、B200 driver 580.95.05。实际 Modal driver 不同必须记录。观察 allocation column ranges、selected-source identity、最后一次 load 和 temporary overwrite；以完整输出的精确 3／5／7 oracle 判定。父提交是否也出现同样失败仍须实测。

研究价值：它与“物理地址仍合法，却已对应另一个逻辑值”的主题最直接吻合。这里是编译器 liveness／alias 错误，不能预先当作缺 barrier，也不能事先保证本项目的 source-bound checker 可以重建真实编译器资源映射。

## 2. TMA／普通 load 混合后的 AutoWS 等待

维护者明确指出：MMA 一部分输入通过 warp-specialized TMA，另一部分通过普通 load 时，仍需根据 MMA self-latency 插入等待。修复调整 `AssignLatencies` 和 `LowerLoops`，并更新 warp-specialized MMA 路径；这是实际编译器修复，但 PR 同时包含其他改动，不能把全部 diff 都当作单一故障原因。[PR 描述及 patch](https://github.com/triton-lang/triton/pull/9111)、[精确修复](https://github.com/triton-lang/triton/commit/7a0f43c3a45ca4a60bbb06bbc94807ee862748b0)。

固定 [test_warp_specialization.py@7a0f43c3](https://github.com/triton-lang/triton/blob/7a0f43c3a45ca4a60bbb06bbc94807ee862748b0/python/test/unit/language/test_warp_specialization.py) 中 `test_warp_specialize_tma_matmul` 及 `test_warp_specialize_tma_matmul_consan`，抽取同一 harness 在父／修复编译器各跑一次。优先选择 fp16、`num_stages=2/3`、A/B 仅一方 TMA，与双方 TMA 作对照；测试原有 shape 包括 `32×32×32` 和 `2048×2048×512`。先用 pytest collection 确定参数 ID，再固定少量组合，避免未经筛选跑整个笛卡尔积。

上游混合 load 测试在 Hopper 明确跳过，因此本候选应首先用 B200。记录完整数值误差、实际生成的 MMA wait、TMA／普通 load 两条路径及 ConSan 原始报告；**Triton ConSan 与 NVIDIA Compute Sanitizer 是两种不同工具**。若旧版本只出现编译失败，须归为 compile failure，不能充作 runtime wrong-result。

## 3. Hopper grouped GEMM 的零 K 边界

原报告 CUTLASS 4.1 在 example `67_hopper_fp8_warp_specialized_gemm_with_blockwise_scaling` 加入 K=0 的 group 后输出 TMA descriptor 初始化错误并挂起；报告含 M=N=4096、总 K=7168 和完整 32 项 K-splits。维护者随后确认在 4.2 tag 修复并关闭 issue。[原始复现说明](https://github.com/NVIDIA/cutlass/issues/2547)、[维护者确认](https://github.com/NVIDIA/cutlass/issues/2547#issuecomment-3300352323)。

版本定位已核验为 [v4.1.0 commit](https://github.com/NVIDIA/cutlass/commit/e51efbfe18fe4f4cbb66ab814c55bf4aa0185491) 和 [v4.2.0 commit](https://github.com/NVIDIA/cutlass/commit/59b61c606fe7aa4d33e60d3e6352cbfde98361c3)。未找到并验证唯一负责修复的 commit，因此先作为 **release-pair candidate**；要进入因果消融数据集，后续还需 bisect 或最小 patch 归因。

先按原报告 K-splits 在 H100 上复现，再最小化为少数含零 K 的 group；每个进程设置超时，挂起和 descriptor API failure 分开计数。K=0 的 GEMM 数值 oracle 应遵循 API 的 `D=beta*C` 及 epilogue 语义；不要直接照搬 issue 中泛化的“no-op”建议。既有 CUDA 13.1 环境不同于原始 12.4，因此记录 toolkit 迁移是否改变行为。

## 4. 循环内共享 accumulator 的 tcgen05 流水化错误

issue 的完整 kernel 在每个 K-loop 中执行两次链式 `tl.dot`，输出应为两项矩阵乘之和。原报告在 B300 的 tcgen05 tile 上有明显错误，单 dot、分离 accumulator、较小非 tcgen05 tile 则通过。维护者定位为循环依赖链被赋予不兼容 pipeline stages，并修复 latency 分配及相关 accumulator 变换。[原报告与完整 Python 复现](https://github.com/triton-lang/triton/issues/10821)、[修复说明](https://github.com/triton-lang/triton/pull/10858)。

固定 [修复提交](https://github.com/triton-lang/triton/commit/9e089e37bc38e2c2a71354e3b218987fbf7cccbd) 与上述父提交；同时保留 `pipeline-assign-latencies.mlir`、`hoist-tmem-alloc.mlir`、`accumulator-init.mlir` 编译回归。原报告测试 Triton 3.6.0、3.7.1 和 main `be7e23c`，环境为 B300、CUDA 13.2、driver 595.71.05。**不能由 SM100/SM103 相近就声称 B200 已复现**：先在 B200 做兼容性筛查；若不触发，应保留为 B300 待运行项。

重点记录循环迭代、MMA producer result readiness、accumulator 的 loop-carried version，以及错误 pipeline stage 是否使下一迭代消费旧值；具体指令与依赖必须从各版本实际编译产物确认。最终 PR 的实际文件变更比早期描述更完整，应以精确 commit patch 为准。

## 纳入下一阶段数据集的门槛

1. 每个候选保存原始报告 URL、失败／修复源码 SHA、harness SHA、环境锁文件、实际 GPU／driver／toolkit、编译命令、PTX／SASS／二进制哈希和全部输出；现有 source-bound 探针不能替代候选本身的执行。
2. 同一硬件、输入和 harness 对照失败版本与修复版本；先无额外插桩复现，再检查插桩是否改变表现。父提交不失败时如实报告，不能用人为注入代替自然故障。
3. 按类型报告 wrong-result 元素数／最大绝对误差、失败频率、hang／timeout、工具报告与 root-cause 位置。同步故障、资源生命周期、编译错误和 descriptor API failure 分列；一个 issue 的多个 shape 不算多个独立自然故障。
4. 只有重现失败、修复恢复且归因证据闭合，才计入自然故障实验。候选 3 的 release-pair、候选 4 的硬件迁移，以及候选 2 的多改动 PR，均需先消除对应归因缺口。

没有选用 Triton [#9871](https://github.com/triton-lang/triton/issues/9871) 作为本轮精确配对案例：虽然有较小复现，但评论中的具体修复归因被维护者明确质疑，不能直接将该评论的 bisect 结论当作已确认 ground truth。[维护者纠正](https://github.com/triton-lang/triton/issues/9871#issuecomment-4278563548)。

## CUDA 13.1 / Compute Sanitizer 的 tcgen05 边界

本轮云日志实际版本为 **Compute Sanitizer 2025.4.0.0**；本机 `/usr/local/cuda-13.1/compute-sanitizer/docs/` 文档标为 **2025.4.1**。二者不能混写成完全相同的 patch version。以下机制在官方 2025.1 release notes 已引入，并在本机 13.1 文档中存在：[官方 release notes](https://docs.nvidia.com/compute-sanitizer/ReleaseNotes/index.html#updates-in-2025-1)。

- **TMEM guardrails 需编译时显式启用** PTXAS `-g-tmem-access-check`（例如 NVCC `-Xptxas=-g-tmem-access-check`），再运行 memcheck；官方例子涵盖未分配 TMEM 列、越界／未对齐访问、relinquish 后再 allocation。普通 `-lineinfo` 不是该开关，旧结果没有启用时不能追认已做 guardrail 检查。[官方 guardrails](https://docs.nvidia.com/compute-sanitizer/ComputeSanitizer/index.html#tensor-core-mma-guardrails)、[CUDA 13.1 NVCC 选项](https://docs.nvidia.com/cuda/archive/13.1.2/cuda-compiler-driver-nvcc/index.html#g-tensor-memory-access-check-g-tmem-access-check)。
- **racecheck 的官方定位是 shared-memory hazard 检测**，不能把零报告写成全面覆盖 TMEM 生命周期／所有 tcgen05 races。合法地址上的旧版本数值也不由这些 guardrails 自动判定。[官方 racecheck 范围](https://docs.nvidia.com/compute-sanitizer/ComputeSanitizer/index.html#what-is-racecheck)。
- 官方 known limitations 指出，部分访问 global memory 的 `tensormap`／`tcgen05` 指令仍可能造成 initcheck 假阳性；这不能泛化成“所有 tcgen05 都不支持”，也不能忽略真实错误。[官方限制](https://docs.nvidia.com/compute-sanitizer/ReleaseNotes/index.html#known-limitations)。

本机配套官方 HTML 的 SHA256：`ComputeSanitizer/index.html` = `1a1b617cd9f37c3ec429ce7cd10344b2a693ba75b64a69148ed35f9e1c0d0e95`；`ReleaseNotes/index.html` = `2b9692b7a61178500cab63b96d99bcfe4a189ed888fbc808133abbb42d793962`。在线文档会更新，不能仅凭滚动页面反推本轮工具版本的所有能力。零 sanitizer 报告、数值 oracle 通过和 source-derived 协议义务满足，仍须分别陈述。
