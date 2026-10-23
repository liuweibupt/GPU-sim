# 真人研究交接：六个实际故障的即时解释与定位

版本 **simple-six-root-immediate-v2**，替代先前八题/学习迁移草案。本轮按用户要求完成技术证据与真人实验准备，**没有招募或观测真人，也没有真人评分者**。当前已具备六份真实 main 材料、两份旧故障练习、每题私有评分键草稿、实机修复执行器映射和可运行的软件闭环。仍待负责人安排专家审核、最终方案冻结、机构适用性判定及参与者。

[直接打开任务页面](../../web/research/human-study/index.html)，或执行 `python3 tools/research/human-diagnostic-study/launch.py` 后访问 `http://127.0.0.1:4184/`。专用 loopback 服务只提供此页，不提供评分键、gold 补丁、其他 viewer 或数据上传接口。

## 1. 本研究现在回答什么

固定六任务池中，在**相同完整原始材料**上加入可回查来源的交互关系，是否改善 GPU 开发者即时解释和定位？每人做四个不同 main 根因，原始条件和诊断条件各两题。主要分析单位是参与者，结论限定于这六个已知任务，不能用重复输入增加独立根因数。

这六个任务同样用于技术 agent 实验。本研究不声称它们是全新工具开发 holdout，也不声称未出现在模型训练或参与者经验中；逐题记录参与者此前是否见过具体故障。真人理解的证据只能来自实际参与者解释，不能由 agent 成功率、浏览器自动化或模拟评分替代。

本版本**没有 pretest/posttest/transfer 占位题**，不评估长期学习、迁移或培训收益。未来如要提出这些主张，需另行冻结不同根因的等价测量题及独立组间学习设计；它们不是本轮六任务研究的开跑门槛。先前“八个 main”的数字是旧草案选择，不是投稿或方法学硬要求。

## 2. 实际任务材料已经备齐

所有 main 均来自真实 GPU 运行，使用修复前资料，不包含候选答案或 gold 源码；完整任务包 catalog SHA-256 为 `ba32ae71891d2c5e84953332d1afd39121e199f84ed4ebf6ea92f979409481d5`。

| main 任务 | 完整可查文件 | 可见实测用例 | 作答需要解释的实际现象 | 私有修复运行器 |
|---|---:|---:|---|---|
| Triton softmax | 11 | 3 | 不同归约轴/输入维度下错误与通过对照 | natural-fault-expansion；8 hidden + 3 visible |
| Triton 浮点负零 | 11 | 3 | -0.0/+0.0/非零的位级输出差异 | natural-fault-expansion；8 hidden + 3 visible |
| Triton constexpr 过滤 | 11 | 3 | 过滤/不过滤/多谓词的长度及元素差异 | natural-fault-expansion；8 hidden + 3 visible |
| Liger PolyNorm | 42 | 4 | 相同 shape 的 FP16/FP32 及大小 width 对照 | liger-faults；14 hidden + 4 visible |
| Liger sparsemax | 42 | 6 | 大偏移/不同 dtype 与宽度下的数值结果 | liger-faults；11 hidden + 6 visible |
| Liger GRPO | 41 | 6 | 相同逻辑值在 dense、strided、broadcast 布局下的结果 | liger-faults；15 hidden + 6 visible |

**表示限制：**新 main 与 agent 实发材料使用完全相同的 JS 冻结 JSON；数值字段的 -0 可能被序列化为 0，不能依赖这些数字或参数分组区分零符号。保存的 observed/reference 字节仍保真，需根据字节解释负零；没有事后恢复模型未收到的数值符号。

旧 CUTLASS 空 K 与 TMEM 故障仅用于两个界面练习，不计主评分；它们和 main 不重复根因。任务页面没有 synthetic 题。可见资料含完整实现文件、不可改测试文件、观测 ID、原始哈希、实际参数、输出或明确标记的数值样本。样本与完整验证计数区分保留；失败调用缺少输出时不补造。

六份题目专用评分键位于非 web 的 [private 目录](../../tools/research/human-diagnostic-study/private/executor-map.json)。每题包含：正确机制、允许的等价解释/修复、错误/不足解释、失败和通过证据 ID、反证预测、源码位置及哈希、真实隐藏测试执行器/运行器/独立 verifier 的映射及哈希。**这些是有实测资料支持的评分草稿，尚未经独立专家审核；文件存在不等于审核完成。**

这里的 `private` 是参与者页面与评分者材料的目录分离，不是访问控制：复现仓库公开时，评分草稿及公开上游修复都可从仓库取得。正式部署只分发参与者页面，筛查是否读过评分键并记录具体故障熟悉度；不能声称答案在公开研究中绝对保密。

原始条件：查看/搜索全部原文与证据，下载完整 JSON。诊断条件：额外使用与 agent 实验同一冻结 `repair-study-v2/query.mjs` 的 observed、contrast、source_links。关系由同一资料计算；不存在显式源码关联时返回空，不能把相关性写成动态因果。两条件的原始数据哈希一致，见 [information-audit.json](../../web/research/human-study/information-audit.json)。该文件证明资料等价，不替代专家对题目难度或可读性的判断。

## 3. 分配、招募与执行

使用 12 槽循环平衡：六个任务起点 × 两种条件起始次序，每人取连续四个互异任务，条件交错。完整 12 人区组内，每个任务各条件出现四次，四个位置各出现两次。`allocate.py` 在招募前随机打乱每个区组并保存种子/哈希；分配由登记顺序决定，不能按表现选槽。草案 N=48 入组者对应四个完整区组，不保证样本量充分或显著。

招募具备实际 CUDA、Triton、GPU 编译器或相近 GPU 调试经历，能阅读材料语言的成年人；若纳入新手，事先定义层和目标比例。项目作者、实现者及看过评分键者不作为正式参与者。具体故障熟悉度逐题登记，不因低分事后剔除；主要分析保留，预先约定敏感性分析。

每个练习上限 5 分钟，每个 main 上限 12 分钟；四题最多 48 分钟，加说明、练习与题间休息约 60–75 分钟，最终时长由独立可读性 pilot 后冻结。练习展示两种入口；main 不反馈正确答案、不展示补丁、不调用外部搜索或 LLM，偏离需记录。切换窗口仍计墙钟时间并留相对时间事件，不能称为“专注时间”。

任务填写解释、文件/函数/行位置、证据 ID、反证与修复不变量、0–100 信心及静态/动态证据操纵检查。可选提交多文件精确替换 JSON。超时自动保留草稿；可随时退出和删除本页内存记录。题内不编译补丁，避免两组测试反馈不同。

当前 `materialsReady=true`，实际任务流程可完整演练。`formalReady=false` 仅表示独立专家审查及最终方案冻结未完成，不是缺少真实任务，更不是要求再造八个或十六个题。机构适用性独立登记，不由软件假定必须审批或已经审批。

## 4. 评分、隐藏修复与分析

每题使用四个 0/1/2 分维度，总分 0–8；具体任务键给出可接受替代答案，而非与 gold 字面匹配。

| 维度 | 0 分 | 1 分 | 2 分 |
|---|---|---|---|
| 机制 | 错误、无解释或把未知当事实 | 主要方向正确但触发条件/因果链不全 | 正确失效不变量、触发条件及机制与观测连接，说明未测部分 |
| 定位 | 错组件或无可用位置 | 正确组件/函数但范围宽或依据不清 | 有依据的文件/函数/IR 位置，允许等价修改位置 |
| 证据 | 无有效引用、虚构或矛盾 | 一条有效证据，缺少区分对照 | 有效失败与通过/反例证据，解释支持与局限 |
| 反证 | 没有可区分预测或预测错误 | 合理但区分力不足的后续测试 | 能区分候选原因的可执行测试及正确预期方向/值/状态 |

程序生成随机 blind ID，给评分者题 ID 和回答，不给参与者、条件、耗时、经历与日志。两名独立 GPU 评分者分别打分、写依据和疑似破盲；分歧由第三人按冻结键独立仲裁。回答本身可能提到图或按钮，因此不声称完全不可破盲。程序在评分不全或分歧未决时拒绝合并，报告维度全一致率、绝对分差及破盲记录。

补丁表现是单独指标：`materialize_candidate.mjs` 把原始多文件替换原样交给同一冻结 `applyEdits`，`execute_candidate.py` 校验执行器、runner、verifier 和隐藏契约哈希后调用现有 GPU 实验。没有候选、不可应用、编译错误、超时、缺少结果必须留在分母；仅文字方案或高解释分不能称为修复成功。**目前没有任何真人补丁，因此没有真人实机成功率。**

预注册草稿：

1. 主指标是每人两诊断题的解释均分减去两原始题均分，随后对人求平均。参与者 bootstrap 10,000 次、固定 seed 7319 给出 95% 区间，任务池固定；不把题、trace、形状或点击当独立人。按根因、顺序与经历提供描述性结果。
2. 次指标是失败感知的限制时长：仅在题内提交且解释至少 6/8 时使用提交耗时，否则使用该题上限。另列定位分、信心、操纵检查、未答和超时。此时长不等于编译后修复速度。
3. 可选修复指标需实际执行 receipt 与完整隐藏测试验证后另接入。当前解释分析器不会从文本推断修复成功。
4. 不因低分排除。完整 paired 条件才进入主差值估计，同时报告全体入组、退出和未形成 paired 的人数；流失可能偏倚，因此完整样本结果不能被当作全体入组效果。正式冻结时确定缺失敏感性方案，不能看到结果才挑选。
5. 固定预注册入组数停止，不边看效果边加人；草案为 48 入组者，不将退出者悄悄换成“好完成者”。主要指标不显著不意味着等效。

精度假设：如果参与者内评分差 SD=2，近似 95% 半宽为 `1.96×2/sqrt(N)`，N=24/48/96 约 0.80/0.57/0.40 分；SD=2 尚未观测。差值范围 [-8,8] 的保守 SD=8 在 N=48 时半宽约 2.26 分，流失和有限样本修正还会改变精度。见 [precision-planning.json](../../web/research/human-study/precision-planning.json)。这不是 power 或可发表保证；精度导向说明参考 [Lakens, Sample Size Justification (2022)](https://doi.org/10.1525/collabra.33267)。增加参与者不能创造新根因。

## 5. 运行命令与验收

```bash
python3 tools/research/human-diagnostic-study/prepare_keys.py
python3 tools/research/human-diagnostic-study/build.py
python3 tools/research/human-diagnostic-study/launch.py
```

`prepare_keys.py` 仅重建草稿和哈希，不执行审核、不调用 GPU。正式键冻结后不要无记录覆盖它。

```bash
node --test tools/research/human-diagnostic-study/core.test.mjs
python3 -m unittest discover -s tools/research/human-diagnostic-study -p 'test_*.py'
python3 tools/research/human-diagnostic-study/check.py web/research/human-study/index.html --output web/research/human-study/browser-check.json --sessions out/research/human-diagnostic-study/six-root-software-sessions
python3 tools/research/human-diagnostic-study/selftest.py out/research/human-diagnostic-study/six-root-software-sessions --output web/research/human-study/analysis-check.json
```

[浏览器验收](../../web/research/human-study/browser-check.json)覆盖 12 槽完整软件会话、退出/超时、全部实际材料与同信息条件；[分析验收](../../web/research/human-study/analysis-check.json)覆盖导出、去条件盲包、两份明确模拟评分及分析。**这些都是 software fixtures，不能写为 12 个真人或两个真人评分者。** 默认分析拒绝 dry-run；正式记录须绑定最终 manifest，改 `mode` 字符串不能把模拟记录变成人类证据。

候选交接示例（先完成所有作答；不给题内反馈）：

```bash
node tools/research/human-diagnostic-study/materialize_candidate.mjs --catalog out/research/repair-v2-study/frozen/catalog-before.json --session /private/study/P001.json --output /private/study/P001-candidates
python3 tools/research/human-diagnostic-study/execute_candidate.py --candidate /private/study/P001-candidates/TASK.candidate.json --output /private/study/P001-runtime/TASK
```

最后一条默认只检查并打印命令，加 `--execute` 才运行实际 GPU。缺失候选保留在 `materialization.json` 的四题分母中。

## 6. 负责人尚需安排的外部事项

| 事项 | 本轮状态 | 交接动作 |
|---|---|---|
| 六 main + 两练习、两条件 UI、原始信息等价 | 已有实际资料、软件验证通过 | 最终材料冻结后复跑 |
| 六份评分键和隐藏 executor 映射 | 已有按实际机制编写的草稿与哈希 | 独立 GPU 专家逐题审核及评分者校准 |
| 两评分者与仲裁者 | 未安排 | 记录职责与利益冲突，不冒称自动评分是真人 |
| 招募、报酬、语言与时长 | 本轮不招募 | 负责人填参与者说明并安排参与者 |
| 机构审查适用性 | 待所属机构判定 | 记录批准、豁免或有理由的 not_required；软件不自批 |
| 最终方案/注册 | 草稿 | 在真实参与者作答前冻结主要指标、样本规则、任务、rubric 和代码哈希 |

页面不收姓名、邮箱或 IP 日志，不用 cookie/localStorage，不录屏或键盘轨迹，仅在用户明确导出时下载 JSON。自由文本仍可能含身份信息，正式数据需机构受控保存、去标识后使用，不能提交到公共 Git 仓库。姓名/报酬映射另存；联系人、退出/撤回窗口、数据保留期限由负责人填写。上述事项不阻塞本轮技术交付，但未经真实参与者不能得出“帮助人类理解”的实证结论。
