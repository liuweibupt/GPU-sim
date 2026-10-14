# GPU 计算城市：游戏与交互教学相关工作

调研日期：2026-10-14。目标用户先是计算机体系结构、AI systems 与 AI infra 从业者，之后扩展到新手。用户明确偏好“有一个 GPU 基础，就可以在里面做”的开放世界，并进一步指定类似造城/模拟城市、用交通理解 GPU 微架构：自由探索 kernel/profile、自行建设计算城市和实验，关卡和优化挑战作为可选内容。本文只引用开发商、原作者或项目维护者的一手来源；网页所述功能已联网核实，未宣称实际游玩或完成这些游戏。下文将“已有产品的事实”与“面向本项目的设计推断”分开。案例按可借鉴机制归组，不代表彼此独立的软件。

## 结论

最适合的产品方向是一个可持续建设、保存与分享的 **GPU 计算城市开放沙盒**。玩家带着 kernel、profile 或一个问题进入一个有基础 GPU 的城市，自定“我要做什么”，建设或修改计算/存储设施、调整 workload 与映射策略，观察数据交通如何移动和等待，保存发现与方案，再从自己的好奇心或他人的城市产生下一个目标。自由创造、理解真实 profile、优化架构、教学装置都可以成为玩法。这个方向遵从用户的开放性偏好；其具体可玩循环仍需原型验证，不能由现有游戏的商业成功直接推出本项目会成功。

最有价值的组合是：用 **Cities: Skylines / 模拟城市类玩法**提供建设、容量、需求与交通治理的主交互；用 **Minecraft** 的创造模式、可组合规则与创作扩展保证开放性；用 **Factorio** 的可读物流和蓝图复用解释数据流；用 **Opus Magnum** 的机器运转观感提供乐趣；用 **TIS-100 / SHENZHEN I/O** 的并行执行与调试提供因果解释；用 **GPU Puzzles** 提供真实 GPU 任务；用 **Human Resource Machine / 7 Billion Humans** 的可选教学和 **Digital / Logisim-evolution / CircuitVerse** 的层次观测降低进入成本。

“开放世界”的第一版不需要巨大地图、第一人称角色、地形生成或立方体美术。这里的开放性来自**玩家自己定目标、组合工具、改造世界、持续保存、复制分享，以及以后添加新部件和规则**。一个空间清晰、可缩放的基础 GPU 世界就足以验证这些能力。

不要把完成一个任务与达到最优分数绑定。Human Resource Machine 明确把功能通关与可选的程序大小、执行速度挑战分开；TIS-100 与 Opus Magnum 也明确提供多个优化维度。[Human Resource Machine 官方介绍](https://tomorrowcorporation.com/humanresourcemachine)、[TIS-100 官方介绍](https://www.zachtronics.com/tis-100/)、[Opus Magnum 官方介绍](https://www.zachtronics.com/opus-magnum/)。对本项目的推断是：正确性负责建立能力感，优化负责延长可玩时间，两者应有独立反馈。

## 案例：先看开放沙盒，再看工程解谜与教学

### Cities: Skylines II：建设、需求与交通治理

**核实事实。** 官方交通开发日志说明城市布局、居住/工作/商业位置与资源运输共同产生交通需求，提供城市与单条道路的 traffic flow、volume 图层，用于发现拥堵和判断扩容；道路工具支持替换升级、不同道路容量配置、交叉口与转向控制。[官方 Traffic AI 开发日志，2023-06-26](https://www.paradoxinteractive.com/games/cities-skylines-ii/features/traffic-ai)、[官方 Road Tools 开发日志，2023-06-19](https://www.paradoxinteractive.com/games/cities-skylines-ii/features/road-tools)

**可迁移机制。** workload 产生需求，计算单元处理任务，内存体系与队列承担运输和等待。玩家可以先观察哪个区域拥堵，再决定是扩容、减少重复运输、改变任务分配，还是调整执行顺序；结果应同时在城市运行和可展开指标里呈现。保持“建设/修改→城市自动运行→观察局部和整体后果→继续建设”的节奏，不必每次都进入一个关卡或优化排行榜。

**不宜照搬。** GPU 内部没有公路车辆的自主寻路语义，warp 不是一辆能自由行驶的车；shared memory 也不是自动管理的 cache。城市中的地理距离不能自动成为 GPU latency。真实 profile 没有给出的内部路径不可冒充观察事实；若要展示推断路径或玩具模型，必须注明来源与假设。

### Minecraft：创造模式、红石与创作者扩展

**核实事实。** 官方介绍中，创造模式提供无限资源、飞行和即时破坏，去掉生存压力以专注创作。官方红石教程以可组合的连接、开关、信号和时序构建复杂机器。Java Edition 的官方模组说明确认模组能改变内容与玩法，同时说明第三方模组并非由 Mojang 创建或审查；官方也宣布移除代码混淆以方便模组创作与调试。[官方模式介绍](https://www.minecraft.net/en-us/article/what-minecraft)、[官方红石教程](https://learn.microsoft.com/en-us/minecraft/creator/documents/redstoneguide?view=minecraft-bedrock-stable)、[官方模组说明](https://help.minecraft.net/hc/en-us/articles/4409139065613-Mods-for-Minecraft-Java-Edition-)、[官方创作者支持方向](https://www.minecraft.net/en-us/article/removing-obfuscation-in-java-edition)

**可迁移机制。** 给玩家一套即用的 GPU 基础环境与可组合工具，支持自定问题、撤销、复制、观察和持久保存。玩家既能研究一个 kernel，也能搭建一个展示 coalescing 的装置，再将其打包为别人能打开继续修改的世界。扩展接口可以分阶段支持 workload 包、模型配置、观测工具和教学装置，不必初版就开放任意宿主代码。

**不宜照搬。** 开放性不等于立方体、采矿或先收集材料才能看 SM。也不要求玩家逐周期手动搬运数据。红石的规则与 tick 不能代替 GPU 微架构语义；从真实 profile 进入的世界也不能因拖动组件就凭空生成可信的硬件反事实结果。

### Factorio：能看见来源、去向与瓶颈的自动化世界

**核实事实。** 官方把游戏定义为建造并维护工厂，提供物流扩展与蓝图工具。开发日志 FFF #430 明确把传送带的乐趣归因于可视、可交互、能观察来源/去向/瓶颈，并要求新增流体限制必须易见、易诊断；其中的拓扑高亮、悬停和地图图层是具体手段。官方 Wiki 的蓝图说明提供设计复制、蓝图库与文本导入导出机制。[官方内容介绍](https://www.factorio.com/game/content)、[开发日志 FFF #430，2024-09-27](https://www.factorio.com/blog/post/fff-430)、[官方 Wiki 蓝图说明](https://wiki.factorio.com/Blueprint)

**可迁移机制。** GPU 世界里的“有趣物流”应当是自动执行产生的可读结果：哪个请求来自哪个 warp，进入哪个缓存/队列，在哪里等待，何时推动结果产出。选中一个 tensor 或 memory request 可暂时高亮其路径，其他细节降噪；保存的实验装置可作为蓝图在别的世界复用。

**不宜照搬。** 不把 GPU 请求当作必须逐个摆传送带搬运的物品；显存容量、cache line、bank conflict 与发射依赖应来自模型。自由移动一条屏幕连线不能悄悄改变未建模的物理距离或带宽。资源制造链和防御玩法可以后续探索，不能阻挡专业用户进入自己的实验。

### 1. Turing Complete：自己搭的机器能够继续被使用

**核实事实。** 官方教学路径从逻辑门开始，引入组件与存储，再构建计算机架构，最后在自己的硬件上创建汇编指令并完成编程谜题。[官方介绍](https://turingcomplete.game/)

**可迁移机制。** 玩家此前设计的组件成为后续任务的工具，形成“构建能力，而非只消费关卡”的成长感。GPU 游戏可以让一个已验证的 shared-memory staging 或 reduction 模块成为后续关卡的可复用构件；点开组件仍能看到内部数据依赖。

**不宜照搬。** 专业用户没有必要从 NAND 门开始构建 GPU。初版应直接给出 SM、warp、内存层次和 kernel 模板，把构建深度留给架构沙盒。也不能把任意拖动模块的视觉布局解释成真实芯片物理布图。

### 2. TIS-100：有限局部资源产生并行协调谜题

**核实事实。** 玩家修复程序，优化 cycle、instruction 与 node 数量；官方提供三种沙盒，其中 visual console 可以构建游戏。[官方介绍](https://www.zachtronics.com/tis-100/)

**可迁移机制。** 让玩家面对具体的局部资源与协作约束，比面对几十个汇总指标更容易形成可操作的问题。GPU 版可让一个阻塞 warp、尚未返回的 load 和占满的队列成为可点击对象，展示“它在等谁、谁持有资源、下一步什么条件会满足”。周期数、资源量和实现复杂度分开呈现。

**不宜照搬。** TIS-100 是游戏化虚构计算机，其节点通信不能直接映射为 GPU warp 调度或真实互连。也不应要求玩家手写大量微型汇编才能体验第一次数据流反馈。

### 3. SHENZHEN I/O：代码、连线、验证时间线共同构成调试界面

**核实事实。** 玩家结合微控制器、内存与逻辑门搭电路、写汇编，并可在沙盒中创建设备；官方 1.2 更新明确支持在验证时间图和代码处设断点，把测试轮数从 8 增至 80，将 power 分数定义为测试中最坏值，并加入代码行数指标。[官方介绍](https://www.zachtronics.com/shenzhen-io/)、[1.2 更新说明](https://www.zachtronics.com/firmware-update-2/)

**可迁移机制。** 一次选中应联动代码位置、拓扑中的资源和执行时间线。断点可以针对“第一次 bank conflict”“请求队列满”“barrier 等待”这样的语义事件，运行至首次失败即暂停。测试应覆盖多种输入与 shape，分数必须说明聚合规则。

**不宜照搬。** 数据手册可以作为进阶资料，但不能把阅读长手册设成首次体验的前置条件。代码行数适合衡量某些游戏限制，不应充当 GPU kernel 质量的通用指标。

### 4. EXAPUNKS：并发代理与可编程关卡

**核实事实。** 玩家编程控制 EXA 执行代理，在网络中移动、复制并操作文件。官方关卡 API 用 JavaScript 定义主机、文件、寄存器、输入输出要求、自定义目标和每周期回调。[官方介绍](https://www.zachtronics.com/exapunks/)、[VirtualNetwork+ 官方脚本参考](https://www.zachtronics.com/virtualnetwork/)

**可迁移机制。** “可编程目标 + 初始状态 + 运行时事件 + 验证器”比把每一关写死在 UI 里更可扩展。GPU 关卡可以描述 workload、允许修改的参数、资源预算、正确性判定和挑战条件；同一个执行内核支持教程、竞赛和自由实验。

**不宜照搬。** 不把 EXA 的自主移动和复制当作 GPU 线程行为。网络主机布局可以启发可读拓扑，但 GPU 的 warp、CTA、SM、内存分区必须保留清晰的不同语义。初版自定义关卡宜用受约束数据描述，避免一开始就要求任意脚本扩展。

### 5. SpaceChem 与 Opus Magnum：让吞吐与冲突成为可见的机器运转

**核实事实。** SpaceChem 要求建造工厂，将原料变成指定产品并满足产量；开发商根据分数采集承认并非很多玩家能够完成游戏，但没有在该页给出比例。Opus Magnum 提供开放解，比较最简、最快、最紧凑的机器，支持 GIF 导出与用户关卡编辑分享。[SpaceChem 官方介绍与开发者说明](https://www.zachtronics.com/spacechem/)、[Opus Magnum 官方介绍](https://www.zachtronics.com/opus-magnum/)

**可迁移机制。** 动态过程本身应当好看且能读懂：一个 tile 如何被取回、复用、计算并写回；等待、冲突和空闲如何改变产出节奏。通关后允许保留不同风格方案，并分享带参数与模型版本的短回放。一个方案可能快，另一个节约流量，第三个更容易理解。

**不宜照搬。** 空间路径碰撞不是 GPU 性能瓶颈的普遍来源。不能为了粒子动画好看而把互连画成具有未建模距离延迟的传送带。SpaceChem 的完成难度也提醒我们采用分支关卡、提示和可跳过路线；该证据不足以推断任何具体留存率。

### 6. Human Resource Machine 与 7 Billion Humans：同一个任务支持两层深度

**核实事实。** Human Resource Machine 用可拖放命令控制单个工人，通过 inbox、outbox、地板存储槽和单个手持数据箱解释计算机；命令逐步解锁，优化程序大小与执行速度是可选挑战。7 Billion Humans 改为许多工人同时执行程序，提供 60 多个谜题及提示、跳关机制。[HRM 官方介绍](https://tomorrowcorporation.com/humanresourcemachine)、[7 Billion Humans 官方介绍](https://tomorrowcorporation.com/7billionhumans)

**可迁移机制。** 相同 workload 可以提供“概念操作”与“代码/资源细节”两种入口。第一层只改 tile 大小、数据布局等少量变量；第二层允许查看 lane 索引、mask、事务划分和资源预算。卡住时先给观察线索，再给局部提示，最终允许看一个参考方案。

**不宜照搬。** 并行工人不是 SIMT 的精确隐喻：独立代理与同一 warp 的受掩码执行不同。拟人化只能辅助新手理解，专业视图应提供准确术语与模型约束，而非强迫专家接受办公室叙事。

### 7. NandGame：明确规格与经过验证的组件复用

**核实事实。** 官网把游戏定义为一系列搭建组件的关卡，每个组件满足规定行为后可作为后续构件。第一关提供输入输出规格，使用继电器和连线构建 NAND；官网还提供键盘拾取、移动和取消操作说明。[官网](https://nandgame.com/)

**可迁移机制。** 每关先给可检验的输入输出行为，再谈优化。成功模块成为可复用积木，但需要携带其适用 shape、同步前提与资源开销。鼠标操作应有键盘替代路径，撤销和取消应随时可用。

**不宜照搬。** 真值表穷举适合小逻辑电路；GPU kernel 应使用参考计算、边界输入与多 shape 验证，不能把几个演示输入通过当成全域正确性证明。专业用户也需要跳过已掌握基础概念的入口。

### 8. Digital、Logisim-evolution 与 CircuitVerse：层次编辑与可观测性

**核实事实。** Digital 提供信号测量图、测试用例、参数化电路与自定义组件；Logisim-evolution 提供电路模拟、时序图与组件库；CircuitVerse 提供子电路、测试台/时序图、多位总线、SVG 导出和网页嵌入。[Digital 原作者项目](https://github.com/hneemann/Digital)、[Logisim-evolution 维护者项目](https://github.com/logisim-evolution/logisim-evolution)、[CircuitVerse 官网](https://circuitverse.org/)

**可迁移机制。** 用语义缩放管理复杂度：GPU 总览看 SM 与内存流量，进入 SM 看 warp 与发射，选中请求看地址映射和队列。局部探针与全局时间线同步。一个 kernel 模块或 memory mapping 可以保存为可复用组件，回放能嵌入教学或讨论。

**不宜照搬。** 这些主要是设计/仿真工具，其编辑和测量能力并不自动带来游戏目标、节奏与奖励。也没有必要为第一版引入门级细节、FPGA 综合或完整电路编辑器。

### 9. GPU Puzzles：GPU 语义应进入任务，而非只进入百科

**核实事实。** 原作者 Sasha Rush 通过交互 notebook 让学习者补全 Numba CUDA kernel，题目覆盖索引、block、shared memory 与更复杂计算；提供可视化、输出正确性检查，以及按每线程最大值统计的 global/shared 读写次数。[原作者仓库与题目](https://github.com/srush/GPU-Puzzles)

**可迁移机制。** 直接以 map、reduction、scan、transpose、matmul 等实际计算任务为关卡材料，使用小规模数据让每个索引与输出都能被追踪；把正确性检查与局部内存访问解释放在运行按钮附近。

**不宜照搬。** 每线程读写次数既不是 warp 的实际内存事务数，也不是 DRAM 字节数，更不是运行时间；该项目的计分不能直接变成 GPU 游戏性能模型。初版也不应依赖真实 GPU、驱动或 notebook 环境才能开始玩。

## 建议采用的自由探索循环

以下均为结合相关工作的产品设计建议，尚未经过本项目用户测试。

1. **打开或创建世界。** 给一个可运行的基础 GPU 和示例 workload；也支持进入自己的 kernel/profile 实验。无需通过主线关卡才能使用基础工具。
2. **自己定目标。** 可以是“为什么这个 kernel 慢”“我要看一次 reduction”“换一种 layout 会怎样”或“搭一个讲给同事看的装置”。目标是可选便笺，游戏不替玩家规定只有性能分数值得追求。
3. **选择观察或修改。** profile 模式可以放探针、展开拓扑、关联源码和时间线；可执行模型模式可以改 kernel 表达、layout、tile、block 配置或暴露的 GPU 资源。先提供少量组合能力强的工具，并允许复制实验分支。
4. **运行并观察。** 支持播放、暂停、步进到下一事件、跳到首个错误/关键阻塞。动画速度与模型时间分开，拖慢播放不改变执行结果。
5. **追踪因果。** 点击事务看到由哪些 lane 地址组成，点击等待看到依赖与资源，点击输出看到来源。说明应该来自事件与数据来源，不能根据利用率颜色猜原因。必要时只显示当前所选对象的路径。
6. **做下一次实验。** 玩家可先写自己的预测，然后修改、验证和 A/B 对比；也可只探索一个现象或制作一份解释。修改真实 kernel 后须重新采集；修改模型后须重新运行模型。旧 profile/trace 的回放本身不产生新的反事实性能数据。
7. **留下作品并继续。** 世界保存 workload、配置、探针、注释、方案和可重建的执行来源。支持命名快照、复制世界和实验装置导出。短视频/GIF 可以传播，别人能打开、复现并继续修改的世界更有长期价值。

核心乐趣假设是“我提出的问题能通过改造世界得到可见答案，我的作品能复用并被别人继续改造”，而不是“系统给我更高的分数”。第一版就应验证自定目标、可组合修改、因果观察和持久保存这四个能力；大地图与复杂美术可以之后再决定。

### 城市隐喻的可用范围

以下是产品设计映射，不是 GPU 硬件事实；专业视图应始终能切回准确名称、单位与模型配置。

| 城市交互 | GPU 世界中可以表达的内容 | 必须限制的类比 |
| --- | --- | --- |
| 建设/升级处理设施 | 模型允许的 SM/执行单元数量或吞吐配置 | 图上面积与外观不自动等于真实面积、功耗或吞吐 |
| 道路容量和交叉口治理 | 已建模的带宽、端口、队列、仲裁配置 | 路线长短与转弯不自动产生真实 latency；不任意改变真实硬件连线 |
| 需求与货流 | workload 的请求与数据依赖，保留 warp/CTA/事务身份 | warp 不是独立寻路汽车；屏幕粒子可聚合多个请求并需给出含义 |
| 仓储与本地供应 | 数据复用、cache 和显式 shared-memory staging 的不同策略 | shared memory 需要程序管理；不能用同一种仓库规则掩盖语义差别 |
| 区域图层与交通探针 | SM 活跃、队列深度、事务数、等待原因和源码关联 | 红色拥堵本身不能说明原因；未采集/未建模的数据不能编造 |
| 保存城市、复制街区 | 世界快照、实验装置、模型配置、探针与注释模板 | 移动 UI 位置只改表达布局；只有显式修改模型参数才改执行 |

创造模式可放宽建设预算，让玩家研究“如果多一个资源会怎样”；约束模式则可选择资源预算做取舍。两者不应混淆成对某个真实 GPU 的预测。第一版的城市建设可以只开放几个有可靠因果反馈的设施和参数，而非虚构完整芯片制造经济。

### 可选玩法：多目标成绩与 Pareto

默认展示原始指标及其单位，例如模型 cycles、global-memory transactions、shared-memory bytes per CTA，而不是先压成一个总分。Pareto 的含义是：若方案 A 在所有既定目标上都不比 B 差，且至少一项更好，则 A 支配 B；保留未被支配的方案，让“快但用更多 shared memory”和“慢一点但资源小”同时成立。

只有同一 workload、硬件配置、模型版本、正确性范围和评分规则下的结果才能直接比较。不同 shape 可以分别排行；综合挑战必须公开聚合规则。energy 若只来自访问次数等简化代理，标为“模型能耗代理”并给公式，不标成实测 Joules。occupancy 更适合作为解释变量，不能天然设为越高越好的通关目标。

若玩家主动开启优化挑战，前三个优化维度建议只选**模型执行时间、全局内存事务/流量、每 CTA 资源占用**，并明确资源占用可以是约束或分开展示的多个量。方案易读性可以鼓励用户标注，不宜在第一版假装能自动客观计分。排行榜不是必需的 MVP 功能；本地历史方案和个人基线即可支持自定优化目标。自由观察、创作和分享的用户无需参加任何计分。

### 关卡与自由沙盒的关系

开放沙盒是默认入口与主要产品。关卡只是可随时进入/退出的引导世界，提供学习顺序、参考结果与可控难度。两者共用 workload、模型、事件与验证器，关卡只增加允许操作和目标约束。用户的实验也应能保存成一个带说明和可选目标的教学世界，而不是被迫迁移到另一套关卡系统。

初版可从以下五种可读实验装置选择三种做核心垂直切片，玩家可任意加载、拆开、修改和组合；将其包装成关卡是可选工作：

| 任务 | 玩家操作 | 必须可见的因果 | 基础完成与可选挑战 |
| --- | --- | --- | --- |
| 访问排列 | 改 lane 到数组元素的映射 | lane 地址如何分组为模型内存事务 | 输出正确；减少事务 |
| 缓存一块 tile | 在重复 global load 与 staging 间选择 | 复用减少请求，加载与同步也有成本 | 输出正确；减少流量或时间 |
| reduction | 调整分组与树形合并步骤 | 依赖、同步与活跃参与者数量 | 和参考结果一致；缩短依赖路径 |
| transpose | 改 shared-memory 布局或 padding | 同一时刻的 bank 映射及冲突序列化 | 转置正确；在资源预算内减冲突 |
| 延迟隐藏 | 在受限资源下调整 resident warp 数 | 等待 load 的 warp 与可执行 warp 如何交替 | 完成计算；找到资源与调度的取舍 |

这些实验依赖相应语义已进入模型；没有建模的缓存或调度机制不能只靠动画暗示存在。基础 GPU 世界应允许创建自己的 workload 或组合已有算子，保存修改与回放来源。第一版无需同时包括完整 CUDA 编译、真实芯片逐周期精度、多人实时协作或大规模城市经营系统。

## 交互与可玩性的验收问题

| 检查项 | 应观察到的行为 | 提示的产品风险 |
| --- | --- | --- |
| 第一次有效操作 | 用户可直接进入基础 GPU 世界，改一个参数或放一个探针并看到对应变化 | 第一屏只有 GPU 拓扑和统计图，或必须先通过教程才能自由操作 |
| 因果解释 | 用户能点出一次合并/等待的参与对象与原因 | 粒子很多，但不能定位哪行访问产生了它们 |
| 失败恢复 | 自动停在首个错误，提供撤销、局部提示和重试 | 只能得到失败红字，需要重新看完整段动画 |
| 两层用户 | 专业用户能看术语、模型约束和事件；新手可先看少量变量 | 所有人都被迫接受完整硬件细节或长教程 |
| 自定目标与复玩 | 用户自己提出第二个问题、搭建第二个实验或保存另一个取舍方案 | 只有完成清单和分数驱动，离开引导就不知道可以做什么 |
| 作品持续存在 | 用户重新打开世界能继续原实验，别人能复制并修改他的装置 | 退出后只剩截图，无法保留自己的创作 |
| 迁移理解 | 用户能预测一个新 shape 中同类变化的大致方向 | 只记住“滑条调大分数更高”，未形成 GPU 直觉 |
| 可访问操作 | 键盘可完成选中、步进、撤销；状态同时有文字/形状 | 依赖颜色识别、精细拖动或持续观看快速动画 |
| 模型诚实性 | 用户能区分玩具模型、外部 simulator 与实测 profile 的结果 | 将教学分数误认为目标 GPU 的真实性能预测 |

建议先邀请 architecture、kernel 与 AI infra 用户打开同一个基础 GPU 世界和小 workload，简短熟悉操作后自由探索：记录他们自行提出的问题、修改了什么、能否解释差异、是否主动再做一次实验，以及想保存/分享什么。是否“有趣”需要这些行为与访谈验证；现有游戏提供的是可借鉴机制，并不能替代本产品的可玩性实验。

## 来源索引与边界

所有链接均于 2026-10-14 核实。未使用商店评论、论坛攻略、第三方榜单、GitHub 星数或付费量估计作为设计有效性的证据。

| 来源 | 可支持的范围 |
| --- | --- |
| [Cities: Skylines II 官方 Traffic AI](https://www.paradoxinteractive.com/games/cities-skylines-ii/features/traffic-ai) | 城市需求与交通、flow/volume 图层、观察拥堵与扩容 |
| [Cities: Skylines II 官方 Road Tools](https://www.paradoxinteractive.com/games/cities-skylines-ii/features/road-tools) | 建设/替换升级道路、不同道路和交叉口控制 |
| [Minecraft 官方模式介绍](https://www.minecraft.net/en-us/article/what-minecraft) | 创造模式与生存模式的不同目标和约束 |
| [Microsoft/Minecraft 官方红石教程](https://learn.microsoft.com/en-us/minecraft/creator/documents/redstoneguide?view=minecraft-bedrock-stable) | 简单连接、开关与时序规则的组合 |
| [Minecraft 官方 Java 模组说明](https://help.minecraft.net/hc/en-us/articles/4409139065613-Mods-for-Minecraft-Java-Edition-) | 模组改变内容/玩法，以及第三方模组的支持边界 |
| [Minecraft 官方移除混淆说明](https://www.minecraft.net/en-us/article/removing-obfuscation-in-java-edition) | 降低创作者扩展、调试与维护的阻力 |
| [Factorio 官方内容介绍](https://www.factorio.com/game/content) | 自动化工厂、物流与蓝图 |
| [Factorio 开发日志 FFF #430](https://www.factorio.com/blog/post/fff-430) | 来源/去向/瓶颈可见性与可交互限制的设计理由 |
| [Factorio 官方 Wiki 蓝图](https://wiki.factorio.com/Blueprint) | 设计复制、库与导入导出 |
| [Turing Complete 官网](https://turingcomplete.game/) | 逻辑门、组件、架构与汇编教学路径 |
| [TIS-100 开发商介绍](https://www.zachtronics.com/tis-100/) | 开放编程解谜、三轴指标、三种沙盒 |
| [SHENZHEN I/O 开发商介绍](https://www.zachtronics.com/shenzhen-io/) | 搭电路、编程、手册与沙盒 |
| [SHENZHEN I/O 1.2 开发商更新](https://www.zachtronics.com/firmware-update-2/) | 验证图/代码断点、测试数量、代码行数与 power 聚合规则 |
| [EXAPUNKS 开发商介绍](https://www.zachtronics.com/exapunks/) | EXA 代理、网络操作、用户创作入口 |
| [EXAPUNKS 官方 VirtualNetwork+ API](https://www.zachtronics.com/virtualnetwork/) | 关卡初始状态、回调、目标和验证接口 |
| [SpaceChem 开发商介绍](https://www.zachtronics.com/spacechem/) | 工厂与产量任务；开发商对完成难度的定性观察 |
| [Opus Magnum 开发商介绍](https://www.zachtronics.com/opus-magnum/) | 开放解、速度/简洁/紧凑、GIF 与用户关卡 |
| [Human Resource Machine 开发商介绍](https://tomorrowcorporation.com/humanresourcemachine) | 拖放命令、计算机隐喻、渐进解锁、可选优化 |
| [7 Billion Humans 开发商介绍](https://tomorrowcorporation.com/7billionhumans) | 多工人同时执行、关卡、提示与跳关 |
| [NandGame 官网](https://nandgame.com/) | 规格驱动的逐级组件构建与键盘操作；官网主页面依赖 JavaScript，本次同时核实了官网的搜索索引文本 |
| [Digital 原作者仓库](https://github.com/hneemann/Digital) | 波形测量、测试、参数化与扩展组件 |
| [Logisim-evolution 维护者仓库](https://github.com/logisim-evolution/logisim-evolution) | 教学电路仿真、时序图、组件库与可扩展功能 |
| [CircuitVerse 官网](https://circuitverse.org/) | 测试台/时序图、子电路、多位总线、导出与嵌入 |
| [GPU Puzzles 原作者仓库](https://github.com/srush/GPU-Puzzles) | CUDA 教学题目、可视化、正确性与读写次数统计 |

本调研未验证各游戏的全部运行时行为、商业授权条件或源代码可复用性。借鉴交互机制不等于获得复制代码、资产或品牌的许可；如后续直接引入某项目代码，应针对具体版本检查许可。这不影响先实现自有的简化 GPU 模型和交互原型。
