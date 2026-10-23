# 独立真实 GPU 故障扩展：三项 Triton 前端语义错误

2026-10-23，本轮补充三个不同于 CUTLASS 空 K 超时和 TMEM 生命周期的独立真实根因。选择规则是有公开上游修复、可在现有设备复现、有明确数值契约；选择发生在新一轮模型对照前，未根据模型是否失败筛选。

| 根因 | 上游已合入修复 | 本机修复前 | 单根因回移修复后 |
|---|---|---:|---:|
| `tl.softmax` 约减后维度丢失，错误广播 | [PR #11409](https://github.com/triton-lang/triton/pull/11409) | 5/11 通过 | 11/11 通过 |
| 标量浮点负零变成正零 | [PR #11426](https://github.com/triton-lang/triton/pull/11426) | 6/11 通过 | 11/11 通过 |
| constexpr 列表推导忽略 `if` 过滤 | [PR #10888](https://github.com/triton-lang/triton/pull/10888) | 3/11 通过 | 11/11 通过 |

这里的失败是实际 RTX 4090 输出错误。合计修复前 19/33 个用例失败、1,565 个输出元素中 967 个错误；分别只回移对应根因的上游补丁后，三组各 11/11 通过。错误输出和全部生成 IR/PTX 均保留，cubin 以完整生成字节的 SHA256 标识。另有三项补丁一起应用的 33/33 通过对照；单根因控制避免把共同 gold 环境误作隔离归因。

执行环境是 RTX 4090／SM89、driver 610.57.04、Python 3.10.20、PyTorch 2.7.1+cu126、官方 Triton 3.8.0 wheel。另行实查 wheel 自带 PTX assembler 为 CUDA 12.9 / V12.9.86，实际生成 PTX 使用 `.version 8.8`、`.target sm_89`；不能把 PyTorch 的 cu126 与 JIT assembler 版本混写。五个涉及修改的 wheel Python 文件与官方 v3.8.0 tag 字节完全相同。所有控制共用原始 native compiler `c3306b024133cf76abba389ac00c6dc9cb9127be6a0796aef2acf2134e5f082f`，只应用上游已合入的 Python 补丁原样 hunks，禁止 patch fuzz。**本实验是 release 加精确补丁回移，不是精确父／修复提交的完整 native compiler 重建。** PR metadata、parent／merge SHA、原始 patch、父／修复文件、release tag 文件和许可证全部保留。

这些是 GPU 编译／库前端语义错误；错误表现经过真实 GPU 执行验证。它们扩大算子、输入契约及根因覆盖，不能作为 TMA、tcgen05 或异步同步缺陷数量增加。公开汇总 [issue #11735](https://github.com/triton-lang/triton/issues/11735) 是候选来源，上游的设备和报告数字与本项目实测分列。

每个根因有 3 个可见用例和 8 个隐藏用例。softmax 涵盖非末轴、负轴、大小不同的方阵、长方阵、常数和极端有限输入；负零覆盖 float16、bfloat16、float32、float64 及正零和非零控制；推导式覆盖全部通过、全部过滤、负数、多 `if` 与保序。冻结计划 `plan.json` SHA256 为 `a3215870aaaf47801a448c7b4da727ca80da29b65a0c852d999d564827e38d85`。不同输入不算新的独立故障。

初轮负零 harness 把 `-0.0/+0.0` 作为同一个 JIT kernel 的浮点 constexpr 参数依次传入，意外叠加了二者缓存键等价的混杂：修复后的正零控制复用了负零二进制。原始 run 与原始 harness 完整保留。最终 harness 按上游 regression 的方式直接构造字面量，用布尔分支区分两条调用身份，before/gold 使用完全相同的代码；该处理隔离额外缓存问题，没有修改被测源代码，也未把缓存问题新增计为一个经确认根因。

模型任务提供十个真实、完整、同等可编辑的库实现文件，另附一个只读的可见 kernel。每例的完整实际输出、数值契约与只读原始哈希可查；源码 provenance 仅关联实际被执行的 test kernel，没有把事后 gold 根因位置注入设备观测。相关函数范围仅在私有定位评分文件声明。这里的 holdout 指未用于本项目工具开发；公开代码、公开问题可能在模型训练中出现，因此不主张训练无泄漏，也不把多文件任务称为无限制全仓库发现。

候选评估器校验原始及候选文件 SHA、完整候选 tree SHA、实际加载 native SHA，原样应用任意允许文件的补丁，并在独立目录、最小环境变量白名单与超时下执行。实际 GPU 输出由第二套纯 Python／`struct` oracle 独立核验；它不采用 runner 的 reference 数组或通过标记作为依据。隐藏输入不返回生成模型，失败候选不手工修复。六个对抗自测覆盖删掉整个根因、输出截断、伪造 pass 并重新计算记录哈希、负零与独立数值契约。

源代码和重放入口见 [natural-fault-expansion](../../tools/research/natural-fault-expansion/README.md)。模型定位／修复对照结果由整体 `repair-study-v2` 报告统一汇总；本页表格只陈述自然故障与已知上游修复控制，不把这些控制当成 agent 生成的候选成功。

归档还区分三层校准：初轮筛选（含负零缓存混杂）、最终统一 harness 的 before／共同 gold、每根因独立 gold。其中最后又通过真正 `core.applyEdits` 生成三份上游 gold 候选并执行，各 11/11 通过。候选 tree 哈希使用与生成器一致的 Node `localeCompare` 排序；含下划线、连字符和句点的路径反例证明不能替换为 Python `sorted`。共八项测试通过，包括六项数值／输出完整性测试和两项候选身份测试。

发布收集器只保留源码、完整实际输出、编译器文本与哈希回执；不提交 native library、wheel、cubin 或 cache。解包后可运行 `python PACKAGE/reproduction/publish.py --verify-package PACKAGE --receipt /tmp/offline-receipt.json`，无需 GPU、PyTorch、Triton 或网络即可重算 oracle 并检查所有发布文件身份。该核验会保留初轮失败、已知 gold 与模型候选的类别区别，不把离线重算计为新的 GPU 实测。

模型生成启动后进行的表示审计发现：JavaScript JSON 序列化把数值字段的 `-0` 规范化为 `0`。负零可见失败例的参数数值因此失去符号，但原始／冻结 packet 的完整 `observed_bytes` 和 `reference_bytes` 逐字节一致，仍完整保留 IEEE 符号位契约；实际 GPU 使用的 Python plan 不受此转换影响。两组获得完全相同的 packet，不过按数值 `value` 分组不能区分两种零。本轮保持冻结文件原样、不补提示、不重试候选，并把这一限制纳入解释；后续协议应显式保存 sign-bit 字段。

隐藏集通过只说明通过冻结契约，不证明完整库级正确性。softmax 测试限连续、有限 float32 输入及 wrapper 默认 `keep_dims` 调用，不覆盖任意显式旧参数、所有 rank／dtype 或 autograd；负零限声明的四种浮点类型，不含 FP8；推导式限 constexpr 整数与条件，不覆盖运行时条件、任意嵌套或其他 target 形式。生成后不针对未测维度追加测试以选择性改变某个候选的评分。

三项 Triton 的 v2 agent 对照已完整执行：每根因 × 有／无专用工具 × 三次独立生成，共 18 个候选。六个条件单元均为 3/3 修复通过，18 个候选都通过全部 11 个用例，共 198 次有完整输出的设备用例（144 隐藏、54 可见），独立核验 9,390 个输出元素。因此该子集没有观察到专用诊断工具的修复成功率优势。

实机验证编排过程中另有一次外部 143 终止，发生在 11 个候选已完整完成、下一个候选处于准备阶段时。未完成目录、日志、相同候选字节及 469 文件身份清单独立保留；该次没有完整输出数组或 runtime receipt，不能据此判断是否已开始设备操作。之后只在新目录重放同一冻结候选的 GPU 验证，没有重新采样模型、修改补丁、修改测试或反馈隐藏结果。18 次完整验证与这一次不完整物理尝试分列，不把外部中断称为数值失败或隐去记录。
