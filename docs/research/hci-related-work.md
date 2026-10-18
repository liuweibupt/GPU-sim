# GPU-sim 人机交互研究：相关工作与指标依据

核验日期：2026-10-18。本文为投稿方案的相关工作附件；描述的是已有论文的方法与结果，不代表 GPU-sim 已完成用户研究。链接优先指向出版方、作者或大学实验室。

CHI、CSCW 的条目均为完整研究论文，不是 Extended Abstracts、演示或 workshop。其余条目保留实际发表载体，不能因主题相关就统称为 CCF A 论文；投稿定位与最新目录核验见主方案。

## 最值得精读的近邻

| 工作与原始来源 | 已核验的方法、指标与结果 | 可研究的差异及证据边界 |
| --- | --- | --- |
| **Teaching Programming with Gamified Semantics** — Ian Arawjo, Cheng-Yao Wang, Andrew C. Myers, Erik Andersen, François Guimbretière. **CHI 2017**. DOI [10.1145/3025453.3025711](https://doi.org/10.1145/3025453.3025711)；[Cornell 原文](https://www.cs.cornell.edu/~eland/papers/chi2017_reduct.pdf)。 | Reduct 将程序执行规则转成玩家操作。实验室 24 人，另有 2,942 名线上玩家；分测识别、回忆、脱离图形支架的 JavaScript 近迁移，正确率约 82%、75%、58%。记录完成、耗时及相对多余操作数。具象表示渐隐的消融未发现显著学习优势。 | 可借鉴“游戏内成功与游戏外迁移分开测”。GPU-sim 可研究从执行机制到性能瓶颈的跨层推理；增加动画或具象图形本身不足以支持有效性声明。 |
| **LearnIoTVR: An End-to-End Virtual Reality Environment Providing Authentic Learning Experiences for Internet of Things** — Zhengzhe Zhu, Ziyi Liu, Youyou Zhang, Lijun Zhu, Joey Huang, Ana Villanueva, Xun Qian, Kylie Peppler, Karthik Ramani. **CHI 2023**. DOI [10.1145/3544548.3581396](https://doi.org/10.1145/3544548.3581396)；[作者原文](https://kpeppler.com/pubs/2023_CP69.pdf)。 | 第一研究 24 人：组件知识、编程能力前后测、集成任务独立完成与求助程度、SUS。评分为 0/0.5/1，部分双人复评 κ=0.71；SUS 为 75.4±14.86。另 6 人比较 VR/桌面体验，只作定性比较，没有测两版本学习差异。 | 与“组件—程序—系统行为”直接相关。可借鉴分层能力、独立整合任务；GPU-sim 应进一步用随机对照验证跨层反馈，不能把单组前后测解释成某个界面机制的因果效果。 |
| **Storytelling Alice Motivates Middle School Girls to Learn Computer Programming** — Caitlin Kelleher, Randy Pausch, Sara Kiesler. **CHI 2007**. DOI [10.1145/1240624.1240844](https://doi.org/10.1145/1240624.1240844)；[CMU 作者稿](https://www.cs.cmu.edu/~caitlin/kelleherCHI2007Draft.pdf)。 | 88 名女生随机分组，比较故事支持版与普通版；测程序行为预测、操作日志、兴趣及自愿继续等行为。故事版编程时间增加 42%，自愿延长使用更常见；基础编程测验未发现组间显著差异。 | 故事动机已有先例；它研究的是创作故事，不等于体验分支剧情。应区分参与和理解；“未发现显著差异”不等于通过正式等效或非劣效检验。 |
| **Crystallize: An Immersive, Collaborative Game for Second Language Learning** — Gabriel Culbertson, Erik Andersen, Walker White, Daniel Zhang, Malte Jung. **CSCW 2016**. DOI [10.1145/2818048.2820020](https://doi.org/10.1145/2818048.2820020)；[Cornell 原文](https://www.cs.cornell.edu/~eland/papers/cscw2016.pdf)。 | 招募 48 人，最终分析 42 人/21 对；随机操纵任务相互依赖。测聊天量、IOS 亲近感、帮助感、翻译前后测及每任务学习量、进展速度；聊天编码 Fleiss κ=0.64。高依赖提升多项合作/学习指标，但进展更慢。 | 可启发真实玩家分任芯片、软件、机柜角色，在信息分散条件下共同决策。单人与 NPC 剧情不直接对应协作贡献；应测协商、个人理解和团队交付，不能只看聊天量。 |
| **Getting Academical: A Choice-Based Interactive Storytelling Game for Teaching Responsible Conduct of Research** — Edward F. Melcer, Katelyn M. Grasse, James Ryan, Nick Junius, Max Kreminski, Dietrich Squinkifer, Brent Hill, Noah Wardrip-Fruin. **FDG 2020**，不是 CHI 完整论文. DOI [10.1145/3402942.3403005](https://doi.org/10.1145/3402942.3403005)；[作者原文](https://njunius.github.io/papers/Getting_Academical_A_Choice_Based_Intera.pdf)。 | 28 人随机分配至故事游戏/课程网页。测 TPI Engagement、主题知识、独立情境书面推理；BARS 评分问题识别、各方立场、方案与后果，双人 κ=.72–1。游戏组投入度和推理总分更高，知识优势仅见于部分主题；仅测单次短期结果。 | 可借用“理由与后果质量”，不把某条路线定义为唯一正确。可研究商业选择怎样支持技术权衡理解；伦理场景的结果不能直接外推到 GPU 经营。 |

## 直接领域先例、对照设计与反向证据

| 工作与原始来源 | 已核验的方法、指标与结果 | 可研究的差异及证据边界 |
| --- | --- | --- |
| **Daisen: A Framework for Visualizing Detailed GPU Execution** — Yifan Sun, Yixuan Zhang, Ali Mosallaei, Michael D. Shah, Cody Dunne, David Kaeli. **EuroVis / Computer Graphics Forum 2021**. DOI [10.1111/cgf.14303](https://doi.org/10.1111/cgf.14303)；[Northeastern 作者页面](https://vis.khoury.northeastern.edu/pubs/Sun2021DaisenFrameworkVisualizing/)。 | 基于 GPU 设计者问卷与访谈建立任务抽象，提供模拟器执行 trace 的分层交互可视化；以 GPU 硬件设计者定性评估检查工作流、潜在瓶颈和优化机会。此处未补填未核验的样本数或量化学习增益。 | 是最直接的 GPU 可视化先例。不能把 GPU 执行展示、任务层级或瓶颈可视化单独当作新颖性；可研究面向学习者的跨层预测、干预和迁移机制，及其与叙事决策的联系。 |
| **Comparing the Effectiveness of Online Learning Approaches on CS1 Learning Outcomes** — Michael J. Lee, Amy J. Ko. **ICER 2015**. DOI [10.1145/2787622.2787709](https://doi.org/10.1145/2787622.2787709)；[UW 原文](https://faculty.washington.edu/ajko/papers/Lee2015EvaluatingGidget.pdf)。 | 60 名新手，20 人/组，随机使用教程、Gidget 调试游戏或开放创作环境。24 题前后测、分概念正确率与耗时。游戏和教程后测未发现显著差异，两者优于开放创作；活动时间中位数分别为 4.76、9.25 小时。 | 对照应包括同内容教程、开放沙盒。原研究接触时间不一致是限制；GPU-sim 应控制教学内容与时间，分别估计机制的效果和自愿投入带来的效果。 |
| **Improving Learning Computer Architecture through an Educational Mobile Game** — Ahmed Tlili, Fathi Essalmi, Mohamed Jemni. **Smart Learning Environments 3:7, 2016**. DOI [10.1186/s40561-016-0030-6](https://doi.org/10.1186/s40561-016-0030-6)；[出版原文](https://link.springer.com/article/10.1186/s40561-016-0030-6)。 | 27 名本科生，用 TAM、五星喜好度和访谈评价架构学习游戏；报告接受、满意、动机及再使用意愿。没有以独立架构知识前后测验证学习效果。 | 架构教育游戏已有明确先例。GPU-sim 可超越接受度，验证瓶颈诊断、因果解释及新场景迁移；不能仅据满意度说“学得更好”。 |
| **Narrative Games for Learning: Testing the Discovery and Narrative Hypotheses** — Deanne M. Adams, Richard E. Mayer, Andrew MacNamara, Alan Koenig, Richard Wainess. **Journal of Educational Psychology 104(1):235–249, 2012**，2011 年先在线发表. DOI [10.1037/a0025595](https://doi.org/10.1037/a0025595)；[作者上传全文](https://www.researchgate.net/publication/232533283_Narrative_Games_for_Learning_Testing_the_Discovery_and_Narrative_Hypotheses)。 | 两项实验比较游戏与匹配内容的幻灯片，并对有无侦探叙事作增量比较。测保持、迁移、难度和学习时间。短于两小时的学习中，游戏未优于幻灯片；去除叙事未显著改变后测。此处未补填未完整核验的样本数。 | 必须处理的反向证据：沉浸和自由探索不自动产生学习优势。可用叙事/反馈消融查明作用条件，并检查额外负担与误解；不能外推为所有叙事游戏均无效。 |
| **Digital Educational Games: Methodologies for Evaluating the Impact of Game Type** — Stephanie Heintz, Effie L.-C. Law. **ACM TOCHI 25(2), Article 8, 2018**. DOI [10.1145/3177881](https://doi.org/10.1145/3177881)。 | 出版方摘要报告两项研究共 280 名学生，领域为编程；比较单一游戏属性及不同游戏类型，将知识增益和玩家体验分别评价。此处未把摘要中未展开的量表或分组人数补写成已核验事实。 | 支持按机制或属性比较，避免只评价整款游戏。GPU-sim 的实验应说明究竟改变了哪些交互条件，而不是将所有新功能捆在一起后归因于“游戏化”。 |

## 从文献到 GPU-sim 的可检验主张

以下是研究设计推断，不是已经建立的创新性或实证结论。

可研究的核心链条为：**玩家先预测结果 → 操作系统参数 → 观察与预测不一致的证据 → 跨层定位原因 → 在未见场景中修正决策**。单独的 GPU 可视化、教育游戏、角色叙事和多结局都有相关先例；更有价值的问题是这些环节如何结合，以及哪些环节能改善准确理解而不过度增加负担。

建议用游戏外的负载、配置和约束检验上述链条，具体区分：

- **技术理解**：识别概念、预测执行/性能、解释瓶颈、对未见负载迁移。游戏内财富、排名、通关和结局不能作为知识真值。
- **决策推理**：依据证据识别约束、比较可行方案、考虑不同角色、预判短长期后果，并随新证据修正解释。评分不奖励预设商业路线。
- **参与体验**：沉浸、能动感、自愿继续、失败后重试与实际回访。它们可以是独立贡献，但不能替代准确率和迁移。
- **真实协作**：共享理解、信息整合、帮助与协商质量、个人学得多少、团队交付如何；仅在真实多人机制及相应研究开展后提出。

应预先设计叙事、跨层反馈或预测反思环节的消融，匹配内容、时间和任务难度；安排延迟测验，并保留失败、退出和无显著差异。不要把公开网页访问量当参与人数，不要把测试通过或功能完整当用户研究证据。

## 引用载体提醒

Gidget 2014 的 CSCW 相关材料是 workshop；这里采用的学习比较成果为 ICER 2015，不能写成 CSCW 完整论文。
