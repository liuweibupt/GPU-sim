# 可复现的有界模型实验

后续工作：[多卡 trace 复用](TRACE_REUSE.md)、[原始证据、三值协议与 SM89 版本错误实验](SEMANTIC_EXPERIMENTS.md)、[Modal B200/H100 实机](modal/README.md)及[盲测 agent 先导](agent-eval/README.md)。后者实际执行受控 kernel，证据范围与本页合成模型分开报告。

本页说明论文规划中 E1（逻辑工作对应）、E2（已有诊断见证保留）及 E7（CPU 分析开销）的一轮开发先导。这里的模型输入均标记 `synthetic-model`：**这些模型结果没有执行真实 GPU kernel，没有真实 AI 候选或人类参与者，不能据此声称 GPU 性能提升、发现真实错误或提高人的理解。** 独立的 SM89 实机实验见 [CUDA 实验说明](cuda/README.md)，两类结果不能混合归因。

## 运行

需要 Node.js 18 或更新版本，不需要额外依赖：

```bash
node tools/research/run-model-experiments.mjs
node tools/research/run-model-experiments.mjs --output /tmp/gpu-model-run --seed 20261023
```

默认输出 `out/research/model/<UTC 时间戳>/`。每个方法、每个输入先运行 5 次预热，再保存 30 次 host wall 时间，方法顺序由独立的有种子伪随机序列打乱。快速检查可以显式减少次数；这种结果不充当默认测量预算：

```bash
node tools/research/run-model-experiments.mjs --output /tmp/gpu-model-smoke --warmups 1 --samples 2
```

每次运行必须使用新的输出目录。显式 `--output` 指向已经存在的路径会被拒绝，防止覆盖先前的负结果；当次有效文件清单以 `results.json.caseFiles` 为准。输出目录不自动表示一个冻结的保留集。

## 模块与独立性

- `corpus.mjs`：手写小协议/区域对照与有种子的整数网格实例，声明诊断义务及需要保留的见证。`makeScaleCases()` 另外生成规模输入。
- `oracle.mjs`：逐整数坐标枚举对应关系，不导入生产 matcher；另核对预先声明的见证集合。它没有经过独立专家审查，也不是 PTX ISA oracle。
- `../../lib/research/evidence.js`：被测的区域对应与证据切片实现。
- `run-model-experiments.mjs`：执行、评分、计时与结果保存，不用 matcher 的返回值产生真值。

源码、oracle 与 fixtures 在本轮共同开发。`development` / `validation` 只区分开发期结构覆盖，**不是预注册、冻结、盲评的外部保留测试**。`rootCauseTemplate` / `family` 和 seed 实例分别保存，一个模板的多次实例不能算多个独立真实错误。真实错误计数明确为 0。

## E1：对应关系与实际版本

比较 `source`（tensor 与源码位置/名称）、`region`（同 tensor 区域）和 `semantic`（tensor、角色、迭代、预期版本、完全相同归约域及区域）三个语义策略，另设同语义的 `semantic-scan`、`semantic-fixed-axis` 性能消融。前三者采用传统区间索引并为每组选择坐标轴；`semantic-fixed-axis` 固定使用首轴，`semantic-scan` 逐对扫描。该实现优化不作为论文新颖性，三种完整语义实现均必须符合独立 oracle。所有方法都先检查 run 的规范、输入和语义身份是否相容，因此不把身份检查的收益只归给完整方法。`source` 也需要区域有交集，属于源码锚加区域约束基线。

生产方法输出矩形关系；runner 将其展开成去重的 `(leftId, rightId, coordinate)` 原子关系，与独立枚举 oracle 比较 precision / recall。空分母保存 `null`，不记作 0 或 1。另报：

- 独立逻辑元素覆盖，避免矩形拆边改变覆盖结果。
- 左右各自的 node-coordinate 覆盖与未匹配节点率。
- 映射未知节点、实际来源未知、以及把未知来源错误标成确定结果的次数。
- 在正确配对原子上的 `equal` / `different` / `unknown` 实际版本混淆矩阵；漏配对仍计入对应 recall，不借版本准确率掩盖漏配。
- 按 family、split、family/split 和 oracle 得出的对应拓扑（如一对多、多对多）汇总；主表为描述性 micro 分数，不提供伪独立显著性检验。

错误的实际来源版本仍应与预期的同一逻辑工作对应，并显式标成 `different`。首版只支持有限整数半开矩形与相同归约域，不支持任意索引映射、归约重分块或一般程序等价判定。

## E2：已有诊断见证的保留

比较 `full`（全部图）、`data-ancestors`（数据依赖祖先）和 `evidence`（包含义务与其他关系的切片）。预期需要保留的节点、边、义务与 unknown 引用由输入 fixtures 独立声明，另外核对：

- 义务的 `satisfied` / `violated` / `unknown` 状态没有变化。
- `positiveWitnessRefs` 指向的证据实体仍在输出中。
- unknown 引用同时存在于 `sliceMetadata.unknownRefs` 和实际 `evidence` 记录。

只有保留所有所需实体及状态才算完整见证。无诊断义务的对照仍评分节点/边保留，但不进入“完整诊断见证保留率”的分母。记录节点、边和序列化 UTF-8 JSON 字节比例；字节包含切片 metadata，因此可能比原图更大，不是内存占用。数据祖先切片是受限比较方法，结果缺乏完整见证时不能当成充分解释。

这些实验检查**给定诊断的保留**，不证明义务标签本身正确，也不证明系统可以自动检测新错误。要验证检测能力仍需独立 ISA/实机依据、真实错误与合法程序集。

## E7：CPU 规模与成本

除了小型 E1/E2 输入上的时间，另测 16 / 64 / 256 / 1024 个节点规模，每档对应规模分别包含首轴分离、首轴全重叠两种分布，保留固定首轴索引无法有效预筛的情况。对应规模是每个 run 的节点数，表格 `inputNodeCount` 是两个 run 的合计；切片规模是固定见证加额外无关节点，总数与 metadata 一起保存。它们是有限模型节点，不代表真实 GPU 事件数。规模实例单独列为 E7，不加入 E1/E2 准确率的分母；执行独立正确性检查，并记录原始计时样本和输出摘要。

计时包含核心函数内的校验、分配和切片复制，排除 oracle 枚举、评分、JSON 序列化和文件 I/O。输入已驻留内存，预热后调用，因此不是冷查询。p50/p95 使用排序后线性插值；汇总表的“case median 的 p95”与某个 case 的 30 样本 p95 分开标识。

未锁 CPU 频率、绑定 CPU 或独占机器，JIT、GC 和并发负载都可能影响耗时；不从这些样本推断 GPU 时间或给出统计加速结论。区间索引按选定坐标预筛后仍做精确交集判断，最坏情形仍可能逐对检查。`semantic-scan`、`semantic-fixed-axis` 与按组选择坐标轴的版本在同一轮采用相同预热/样本预算并打乱执行顺序。规模实验不能替代完整真实 trace 的可扩展性评估。

## 产物与失败处理

| 文件 | 内容 |
| --- | --- |
| `manifest.json` | Git commit/dirty 状态，所有被测源码 SHA-256，Node/OS/CPU，配置，运行开始/结束时间与机器负载 |
| `results.json` | 全部方法结果、分组统计、失败、原始时间、当次有效 case 文件清单 |
| `cases/*.json` | 单例输入、独立真值与结果；规模输入保留摘要，避免反复复制全部输出 |
| `cases.csv` / `aggregates.csv` | 逐例和分组指标；JSON 为完整权威记录 |
| `report.md` | 明确来源、分母与限制的可读报告 |

每个方法的异常都会保存，不静默跳过。完整语义方法违反 oracle、完整证据切片丢失所需见证、核心调用异常或执行期间源码变化时退出码为非零。受限基线的预期漏配/缺失会保留为测量结果，不因准确率低自动终止。输出记录不足以证实硬件和用户研究的论文主张，后续实验仍需按照完整研究规划补齐。
