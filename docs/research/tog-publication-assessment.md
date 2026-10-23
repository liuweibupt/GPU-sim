# GPU-sim 面向 ACM TOG 的投稿评估与发展方向

核验日期：2026-10-23。仓库基线：`0582851`。本文评估已有实现与研究证据，不包含新实验结果；文献检索为有针对性的近邻调查，不是穷尽 TOG 历年目录的系统综述。

目标为 **ACM Transactions on Graphics（TOG，期刊）**，主社区是计算机图形学与交互技术；GPU 系统、可视分析和 HCI 是交叉社区。当前项目是教学模型、模拟器轨迹工作台和探索实验原型，尚不是一篇已完成的 TOG 稿件。既有 [HCI 研究方案](hci-publication-plan.md) 保持其原有研究问题，本报告提供另一条选题决策依据。

## 1. 当前是否适合投稿

**不建议以当前版本直接投稿 TOG 完整研究论文。已有可复用的工程平台，但核心贡献和决定性证据仍需建立。** 这不是录用概率估计，也不是说 GPU 工具或交互系统不在 TOG 范围内。

SIGGRAPH 2026 官方审稿说明要求期刊轨研究具有原创贡献、充分验证和完整描述，同时明确接受系统集成、实验研究、数据集及分析等贡献，并不要求每篇论文都有新算法或用户研究。因此，问题不是“有没有新渲染算法”，而是：我们对图形学或交互技术推进了什么，为什么已有方法做不到，以及证据是否足以支持这个推进。[官方审稿说明](https://s2026.siggraph.org/technical-papers-reviewer-instructions-ethics/)

| 当前资产 | 已有证据 | 对投稿结论的限制 |
| --- | --- | --- |
| GPU 城市与单 SM 流水线 | 显式请求/响应、依赖与资源等待、可重复运行、可追溯回放 | 132 SM 城市是教学模型；单 SM 是符号时序模型，不执行任意 PTX/SASS；不能称为真实 H100 数字孪生。[模型契约](../model-and-data-contract.md)、[SM 能力声明](../../lib/sm-model.js) |
| 外部模拟器接入 | GTSim GEMM 原生区间；FlashGPU-Sim vectorAdd 原生阶段，256/256 输出通过 CPU 参考核对 | 后者在 CPU 上执行模拟器，仅覆盖小样例的 2 SM、8 warp、176 动态指令；数值正确性与模拟时序来源明确，不等于实机性能准确性。[原生阶段验证](../sm-light-validation.md) |
| 多层观察 | GPU/SM 范围、CTA/warp 筛选、任务/指令粒度、独立 run 保存 | 未实现同一次执行的跨后端状态对齐、checkpoint 或局部精化；独立 run 的 cycle 不能直接拼接。[多尺度边界](../multiscale-simulation.md) |
| 浏览器交互性能 | Worker、区间索引、WASM、浏览器对照记录 | 有工程收益；浏览器对照为同机单次采样，不是 GPU kernel 加速或大规模可视分析的系统性结果。[性能记录](../browser-performance.md) |
| 三场景探索实验台 | 相同模型/动作/数值的对象和抽象表示，预测—试产—解释及本地日志 | 教学参数未实机标定；未开展参与者实验，尚无学习、迁移或专家诊断效果证据。[试运行手册](gpu-exploration-pilot.md)、[验收边界](../exploration-lab-validation.md) |

最主要的三个缺口是：**还没有从近邻中区分出的研究机制；缺少真实图形工作负载的应用证据；缺少与选定主张相匹配的比较评价。** 性能方法需要实际优化或预测证据，教学方法需要理解与迁移证据；不是把两种证据都机械地要求一遍。

## 2. TOG 中确实存在相关工作

以下八篇均为正式 TOG 论文。前两篇是可视调试直接近邻，中间四篇涉及执行/优化表达，后两篇用于判断系统或视觉编程贡献的形态，不应全部当作同一任务的数值基线。

| 论文与正式载体 | 核心贡献 | 对 GPU-sim 的意义 |
| --- | --- | --- |
| **A Relational Debugging Engine for the Graphics Pipeline** — Duca et al.，TOG **24(3), 453–463, 2005** / SIGGRAPH 2005。[作者原文](https://www.cs.jhu.edu/~niski/gldb.pdf)，[DOI](https://doi.org/10.1145/1073204.1073213) | 将图形流水线状态及顶点、图元、片元、像素等组织为关系数据，支持查询、关联与可视调试。 | 跨层联动、从输出追溯来源已有先例。需要提出新的关联操作、表示或诊断能力，不能只以层级更多为创新。 |
| **Debugging GPU Stream Programs Through Automatic Dataflow Recording and Visualization** — Hou, Zhou, Guo，TOG **28(5), Article 153, 2009** / SIGGRAPH Asia 2009。[论文原文镜像](https://citeseerx.ist.psu.edu/document?doi=a5237dad5b9cba9c882e4920df763aa8b54e5535&repid=rep1&type=pdf)，[DOI](https://doi.org/10.1145/1618452.1618499) | 编译器自动插桩记录 GPU 内存操作，检测越界、未初始化读取及竞态，并沿线程和数据流检查错误传播；另有 GPU interrupt 编译机制。 | TOG 内非常直接的先例。其贡献包括数据采集和错误检测，超出轨迹播放器。GPU-sim 当前尚无等价的完整内存数据依赖和自动诊断。 |
| **Decoupling Algorithms from Schedules for Easy Optimization of Image Processing Pipelines** — Ragan-Kelley et al.，TOG **31(4), Article 32, 2012** / SIGGRAPH 2012。[MIT 作者项目](https://people.csail.mit.edu/jrk/halide12/) | Halide 分离算法与 schedule，探索 tiling、融合、存储/重算及并行等选择，编译到 CPU/GPU。 | 若让用户操作 tile、复用和流水线，必须区分教学参数变化与真实可执行 schedule，说明相对 Halide 的新能力。 |
| **Piko: A Framework for Authoring Programmable Graphics Pipelines** — Patney et al.，TOG **34(4), Article 147, 2015** / SIGGRAPH 2015。[作者原文](https://escholarship.org/uc/item/7dx346m6)，[DOI](https://doi.org/10.1145/2766973) | 用空间 bins/tiles 组织流水线阶段，分离计算与调度，探索局部性和负载均衡并生成可执行管线。 | “可编辑 GPU 流水线”路线的重要近邻。显示 tile 运动尚不等于具备可编程图形流水线。 |
| **A System for Rapid Exploration of Shader Optimization Choices** — He, Foley, Fatahalian，TOG **35(4), Article 112, 2016** / SIGGRAPH 2016。[CMU 作者项目](https://graphics.cs.cmu.edu/projects/spire/)，[DOI](https://doi.org/10.1145/2897824.2925923) | Spire 以时空计算频率表达 shader 优化，覆盖多个 pass 及离线预处理，支持 shader LOD 和自动调优。 | 优化探索路线必须讨论的近邻；“交互调参后更快”本身不足，需要新的优化表达、决策能力或成本优势。 |
| **Slang: Language Mechanisms for Extensible Real-time Shading Systems** — He et al.，TOG **37(4), Article 141, 2018** / SIGGRAPH 2018。[CMU 作者项目](https://graphics.cs.cmu.edu/projects/slang/)，[DOI](https://doi.org/10.1145/3197517.3201380) | 用语言与编译机制同时支持模块化和高效 shader 专门化，在真实 shading 系统中验证。 | 属于编程系统参照，不是播放器基线；可学习其机制、软件集成与性能证据的对应关系。 |
| **Dr.Jit: A Just-In-Time Compiler for Differentiable Rendering** — Jakob et al.，TOG **41(4), Article 124, 2022** / SIGGRAPH 2022。[作者项目](https://dvicini.github.io/drjit/) | 追踪渲染计算并按场景专门化，结合自动微分及依赖分析生成高效程序。 | 可启发面向可微渲染的分析任务。这里的 tracing 是编译计算图，不能混同于硬件时间 trace；当前项目尚未接入。 |
| **Visual Knitting Machine Programming** — Narayanan et al.，TOG **38(4), Article 63, 2019** / SIGGRAPH 2019。[CMU 作者项目](https://textiles.cs.cmu.edu/publications/2019-visualknit/)，[DOI](https://doi.org/10.1145/3306346.3322995) | 用 augmented stitch mesh 联结几何、机器操作和依赖，支持满足可制造约束的交互编辑，并在机器上生产。 | 非 GPU 竞争者，但说明视觉编程系统可以进入 TOG；可借鉴“新表示—合法编辑—实际执行”的研究结构。 |

Hou 2009 的旧论文原文通过学术镜像读取，Technical Papers 身份另由 [SIGGRAPH Asia 2009 官方节目](https://www.siggraph.org/asia2009/for_attendees/SA09_AdvanceProgram.pdf)交叉核对。本次未复现这些论文，也不将未核验的效果量填入表格。直接近邻较早不意味着近年的研究空白。

### 非 TOG 但必须处理的近邻

- **Daisen: A Framework for Visualizing Detailed GPU Execution**，**EuroVis / Computer Graphics Forum 2021**。模拟器 trace、硬件层级、任务、时间与依赖联动，是与当前工作台最直接的比较对象。[作者页面](https://vis.khoury.northeastern.edu/pubs/Sun2021DaisenFrameworkVisualizing/)
- **Visualize the Invisible: Exposing Causal Layers in GPU Performance Analysis through Milestone Abstractions**，Deng, Isaacs, Sun，**IEEE VIS 2026，TVCG 待刊**。Milestone 记录解除阻塞的状态及等待原因，结合阻塞摘要、时间变化和跨层分析。作者稿报告 4 人需求研究、6 人评价，其中 3 人参加过前期研究。它已经覆盖“从发生了什么走向为什么等待”，不能再将这句话单独作为创新。[官方节目](https://www.ieeevis.org/year/2026/program/paper/9b5bc41f-c90f-40f6-81d2-9266713c4766/)、[作者原文](https://sarchlab.org/vis_the_invisible.pdf)、[待刊状态](https://kisaacs.github.io/publications.html)。截至本报告日期，会议报告尚未举行；作者稿 DOI 仍为占位符，不补造正式卷期。
- **ShaderTransformer: Predicting Shader Quality via One-shot Embedding for Fast Simplification**，**SIGGRAPH 2022 Conference Paper Track，非 TOG**。如果发展学习型 shader 优化/质量预测，应继续精读。[SIGGRAPH 官方摘要](https://www.siggraph.org/wp-content/uploads/2022/08/SIGGRAPH-22-ACM-SIGGRAPH-2022-Conference-Proceedings.html)、[DOI](https://doi.org/10.1145/3528233.3530722)
- **Nsight Graphics Shader Profiler** 是实际工具基线，已提供源码/反汇编关联、stall 原因及执行计数等信息。不能把现有 profiler 描述成只有总耗时。[官方文档](https://docs.nvidia.com/nsight-graphics/UserGuide/shader-profiler.html)

“如果优化某段代码会怎样”本身也不是新问题，已有 **Coz: Finding Code that Counts with Causal Profiling**。[作者论文](https://arxiv.org/abs/1608.03676)。其方法不能不加论证地移植到 GPU 内部并发；后续必须继续核查因果 profiling、GPU 性能预测和调优文献，才可确定新颖性。本报告提出的是候选研究空隙，不宣称首次。

## 3. 最值得验证的 TOG 路线：真实图形任务的性能干预

建议把问题收敛为：

> 对真实图形 kernel，能否用带资源竞争信息的层级执行表示，在有限测量或仿真预算内，可靠选择哪些合法修改会提升相同画质下的性能，并提供可检查的解释？

这一方向复用事件契约、依赖和资源信息、分层选择与重跑能力。图形学联系来自具体渲染/图像处理任务及其优化约束，而不是界面用了 GPU 建筑。若最终贡献主要是通用 GPU 可视分析，VIS/TVCG 仍可能比 TOG 更合适。

### 候选机制及其尚待证明的部分

1. **从输出/阶段到执行证据建立稳定映射。** 对支持的应用记录图像 tile、渲染 pass、kernel、CTA 和观测事件之间的实际关联。无法观测的硬件内部路径保留未知；不从低分辨率 profiler 自动补成逐指令事实。
2. **依据干预范围选择分析粒度。** 将候选修改可能影响的依赖、资源占用和共享竞争保留或精化，对不影响候选排序的部分聚合。研究目标是保持优化决策，而不是只保持原始总时间。
3. **以不确定性决定何时重新执行。** 候选排序不稳定、超出适用操作集或影响共享竞争时，扩大观察范围或完整重跑。给出适用范围和失败，而非只返回一个精确数字。
4. **闭合预测与实际优化。** 修改代码、数据布局或 schedule 后重新运行，比较预测的方向/幅度、实际质量和端到端时间。软件优化与虚构硬件资源升级分开；后者无法在同一商品 GPU 上直接实机验证。

以上不是已经实现或证明的新算法。若最后只是给 profiler、模拟器和现有调优器接一个统一界面，需要进一步证明这种集成带来了过去无法完成的任务或实质优势；功能组合本身不自动成立。

### 最难的技术问题

观测 trace 不能唯一确定改动后的执行过程。改变 tile、寄存器占用、融合或 cache 行为，可能同时改变指令、地址、驻留、仲裁和请求顺序。直接把 DAG 中一类节点缩短再求关键路径，仅适用于仍保持这些条件的限定模型。

单独重放一个 SM 并固定其他 SM 的原始流量，可能丢失跨 SM 竞争的反馈。第一步应采用完整重新执行；局部重仿真必须另有边界状态、背景竞争和误差验证。当前[多尺度设计](../multiscale-simulation.md)已指出这一问题，尚未解决。

等待时间占比也不等于消除该等待后的加速比。重叠、其他资源及关键路径切换会限制收益；某项代码修改同时改变多种机制时，只能先归因于完整修改，不能直接归因于其中一个硬件因素。

## 4. 先做一个可决定去留的小实验

建议先投入一个有时间边界的技术先导，例如 **2–4 周**，按人员和硬件条件调整；这不是完成论文的估时。目标是判断研究假设值不值得继续，而不是增加页面数量。

| 阶段 | 工作 | 产出与决策 |
| --- | --- | --- |
| 选一个图形应用族 | 优先可完整观测的 CUDA 图像滤波/去噪，或 tile-based rasterization / Gaussian splatting 的计算阶段；先核对后端指令、原子操作和同步支持 | 固定实现、GPU、输入、正确性与画质标准；不默认模拟器覆盖 RT Core，也不同时铺开全部应用 |
| 建立干预真值 | 选两类机制不同的 kernel 和小型合法候选集，如 tile/工作分组/数据布局；实机完整重跑，保留退化及无收益配置 | 基线与每项干预的数值/图像检查、时间分布、编译配置、数据来源；模拟器结果另列 |
| 构造有区分力的实例 | 纳入基线症状相似但最优修改不同的场景，留出完整场景/规模组合 | 检验方法是否超出“看到访存多就加带宽”等经验；不把同一场景相邻帧随机拆成独立训练/测试 |
| 比较简单方案与候选方法 | 对比朴素 DAG 缩时、适用的 profiler/解析启发式、相同预算搜索和完整重执行；应用相关时加入现有调优方案 | 区分新表示、竞争建模或自适应精化究竟带来什么；无需把解决不同问题的八篇 TOG 全部重实现 |
| 判断是否继续 | 检查未见实例的决策质量、成本和同画质实际收益 | 若收益只存在于自己的教学模型，或比简单方法没有额外价值，停止扩建这一 TOG 方向 |

评价至少分开三种误差：完整模型对实机、简化方法对完整模型、最终所选方案对实机最优候选的差距。不能以“接近模拟器”直接宣称“接近硬件”。

建议的主要指标为：

- **优化决策质量：** 对超出测量噪声的变化，预测加速/减速方向是否正确；所选方案相对已测试合法候选中最快方案多耗时多少，即 `T_selected / T_best_tested - 1`；同时报告最坏退化。
- **真实应用结果：** 固定质量下的 kernel 时间和端到端帧/处理时间；改变画质时独立给出质量—性能曲线。
- **方法成本：** 采集、构图、存储、预处理、重执行数量及交互查询时间；分别给冷启动和重复使用成本，不只报告预处理后的查询延迟。
- **机制价值：** 去掉竞争信息或自适应精化后，决策/成本是否变差；保留不符合预期的实例。

这是方法研究的评价建议，不是 TOG 官方阈值。若论文另外声称帮助开发者提高诊断效率，再设计匹配信息与工具能力的开发者任务研究；用户偏好不能代替性能或正确性证据。

## 5. 两条备选与投稿取舍

| 发展路线 | 需要新增的核心内容 | 与当前平台的关系 | 较自然的目标判断 |
| --- | --- | --- | --- |
| 图形性能干预与优化决策 | 可信执行证据、干预响应方法、真实图形场景和实际收益 | 能复用工作台，性能方法主体尚需研发 | TOG 候选；若主要贡献为视觉分析，则考虑 VIS/TVCG |
| 可视化 schedule 编程 | 具有合法性约束的编辑表示、可执行代码生成、真实质量/性能验证 | tile/依赖界面可复用，编译与约束体系是较大新增 | 有 TOG 系统先例；需区分 Halide、Piko、Spire，不能只是节点编辑器 |
| 对象化 GPU 学习与迁移 | 独立题目审核、形成性研究、受控比较、未见任务与保持/迁移评价 | 与三场景实验台和已有研究计划最连续 | CHI/TOCHI 更自然；当前同样尚未具备效果证据 |

**建议保留现有 HCI 研究，同时先验证一条窄的图形性能路线，再决定是否投入 TOG。** 若实际更关心通用 GPU 架构分析，可以直接发展 VIS/TVCG 的专家工作流研究，但也需回应 Daisen 及新的 Milestone 工作。增加城市细节、3D 渲染、剧情或组件数量可以服务产品目标，不能单独填补上述研究缺口。

## 6. 投稿身份、时间与本次核验范围

TOG 期刊投稿与 SIGGRAPH Technical Papers 的具体投稿路线应分别核查。**SIGGRAPH Conference Paper、Poster、Talk 或教育类材料不自动等于 TOG 论文。** 2026 官方页明确区分 Journal 与 Conference 出版载体；这里以其解释评审期待，不把 2026 年的篇幅、匿名或格式要求套用为下一届规则。[2026 官方说明](https://s2026.siggraph.org/program/technical-papers/)

截至 2026-10-23，[SIGGRAPH 2027 官方页](https://s2027.siggraph.org/program/technical-papers/)列出：表单/冲突信息截止为北京时间 **2027-01-22 06:00**，论文截止为 **2027-01-29 06:00**，上传截止为 **2027-01-30 06:00**（原页分别为前一日 22:00 GMT）；同时注明详细投稿说明尚待公布。不要把这些日期当作 TOG 常规投稿截止日，也不应为了这个时间点省略决定性验证。

本次核验了仓库实现/验证记录、相关论文与作者项目、官方会议资料。ACM TOG 常规作者指南页面直接访问返回 403，因此未确认其当前完整程序规则；仓库未提供待投稿论文 PDF，本次也未做格式合规审查。没有重新运行性能实验、招募参与者或提交论文；没有将代码测试通过转换为实机或学习结论。
