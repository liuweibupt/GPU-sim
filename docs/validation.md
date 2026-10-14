# 功能原型验证记录

日期：2026-10-14。验证范围是 GTSim 后端接入、trace 契约和浏览器回放，不包括真实 H100 性能复现或 GEMM 数值执行。

## 自动检查

| 检查 | 结果与覆盖 |
| --- | --- |
| GTSim 官方回归 | 固定 commit `45a996c1585e60e98194057d94f7e664d41150ba`，4/4 通过；不修改上游调度与 timing 源码 |
| Adapter 集成 | 6/6 通过：逐字段重现默认和低 L2 样例、SRAM 参数生效、非法输入、超时空输出、有已完成节点的中途停止 |
| Node 测试 | 11/11 通过：HTTP 入口、ID/层级/依赖、完成与发射边的差异、回放边界/回退、Chrome/Kineto envelope 与原始单位、未知/不完整记录处理、组件规模、partial producer、两个原生样例 |
| Trace 校验 | 默认 796 区间 / 9 组件，原始区间范围 1–5,492 cycles；完成时间与 native Total cycles 一致 |
| 文件检查 | JS 语法与 Git 空白检查通过；本地文档链接检查通过 |

可复现命令：

```bash
npm test
npm run validate
python3 tools/gtsim/build_and_trace.py --test
python3 tools/gtsim/test_observer.py
```

## 后端实验

| 同一 256×256×128 GEMM timing graph | 结果 |
| --- | --- |
| 默认配置 | 796 completed nodes，5,492 cycles；与未修改的官方 CLI 相同 |
| L2 shared service budget 改为 128 bytes/cycle | 796 completed nodes，6,413 cycles |
| SRAM service rate 改为 16 bytes/cycle | 796 completed nodes，9,076 cycles |
| 在 1,000 / 2,000 / 4,000 cycles 停止 | 4 / 194 / 724 个完整区间；其字段与完整运行相同；未完成 end 保持 null |

这是受支持参数进入真实 GTSim 模型的检查，不是实机 benchmark。当前 hand-written graph 固定 tile shape 与 132-SM 配置。

## 浏览器检查

使用本机 Chrome 与 Playwright 1.50.1 检查，无 pageerror：默认样例加载、播放/暂停、前后事件边界、组件过滤、事件详情/依赖/跳转、trace 下载、工作区保存后重开、缺省 category、发射依赖展示、坏 JSON 保留旧工作区、Chrome profile 的较大起始时间和 us 单位。390px 宽度没有整页横向溢出，时间线在自身容器内滚动。

50,000 个 duration spans：5,900,017 bytes 的 Chrome 输入保存为 15,639,713 bytes 的紧凑工作区，能够重开且保留 `source.raw`。另用约 17 MiB 输入触发归一化后输出超过 32 MiB：界面明确阻止导出，不产生自身无法重开的文件，也不删除原始来源。

未完成 producer 的发射边在详情中显示已知 start 和未知 end，不生成虚构 span 或跳转目标。

## 当前边界

只有上述 GTSim GEMM 图与参数接入；未运行任意 CUDA/Triton、未直接读取 Nsight 私有报告/SQLite。Chrome importer 当前显示 X 和配对 B/E，其他 phase 原样保留并报告。没有硬件在线拼装、并排 A/B、数值 reference executor、城市渲染或多人服务；这些在阶段设计中分别验收。

## GPU 界面细化与发布构建

2026-10-14 的后续迭代加入六类组件概念美术、GPU/SM/CTA/warp 观察、时间线窗口、精确定位和 GitHub Pages 构建。前述“当前边界”是初始功能原型记录；当前已具备 GPU 城市结构美术，仍没有新的指令/请求仿真后端或在线硬件拼装。

- Node 自动检查 **20/20** 通过，包括新增层级计数、CTA 原始归属、profile 轨道保真、时间窗口和默认相机可读性。默认任务仍为原生 796 区间 / 5,492 cycles，未改 timing。
- Chrome 验证 GPU→SM0→CTA0→warp8、返回清除范围。warp8 的原始 14 区间（LD 10 + ST 4）与筛选结果一致。
- 保存后重开恢复 time=1750、timelineZoom=8、scope={smId:0, threadBlockId:0, warpId:8}、相机 125% 及各视图开关。
- 慢 L2 示例末时间 6,413；Kineto/Chrome schemaVersion=1 导入保留 process/track；依赖组前 8 条加懒展开，选中 node-13 与原始区间 1,756–1,804 一致。
- 默认重要架构标签在最低可读缩放下保持至少 11px；SM/CTA 细节纵向滚动，滚轮钻取、全屏展开及退出可用。1440px 桌面、390px 手机和其他 4 种宽度均无整页横向溢出、页面错误或失败资源请求。
- 六张生成 PNG 加载成功，具有 alpha 通道；提示词与角色记录齐全。美术格子、亮点、结构位置不当作测量数据。
- `npm run build` 保留项目子路径资源层级；独立静态站点的 `/GPU-sim/` 入口跳转、ESM、示例与图片加载通过浏览器烟测。线上部署另以 Actions 和实际站点检查确认。


## 立体盒子城市

2026-10-14 将默认 GPU / SM 视图升级为原生 SVG/CSS 的 2.5D 等距盒子沙盘，保留结构图、CTA / warp 及权威时间线。

- 本轮交付的 Node 测试 **22/22** 通过；新增测试覆盖盒子三面的几何连接与高度、源事件身份、半开区间、零时长事件和确定性回退。默认样例仍为 796 个区间 / 9 组件 / 5,492 cycles。
- Chrome 检查立体 / 结构切换、GPU→SM→CTA→warp、流水线盒子选择和真实 active / completed 计数；warp8 仍为 14 个原生区间。SVG 上按空格选择组件不会同时触发全局播放。
- 工作区恢复 presentation=boxes / structure、time=1750、timelineZoom=8、CTA0 / warp8、相机125%及城市优先开关；缺少新增视图字段的旧存档继续使用默认立体视图。
- 1440×1000 桌面首屏可见完整盒子芯片、L2 / HBM 及播放操作；手机画布增加高度，320 / 390px 与城市优先开关两种状态没有整页横向溢出。reduced-motion 可用；无页面错误、404 或失败资源请求。
- Chrome / PyTorch profile 保留原生 tracks，立体硬件视图按钮禁用，不把轨道映射为 SM。L2 / HBM / Scheduler 等无独立事件的盒子始终为静态示意；进度光点只来自对应源区间，不编码互连请求。
- 立体图最多展示8个原生组件并显示数量限制；完整组件树和时间线保留。配置SM与记录SM的数量在首屏分别标出，未列入的SM不解释为空闲。
- 静态构建保留新增 ESM 文件与项目子路径。部署完成后再核对 Pages workflow、线上模块内容与浏览器烟测。

## 132 SM 数据流与 NoC 运输

2026-10-14 后续实现独立的 [数据流教学模型](traffic-model.md)，默认采用 H100 SXM 的132 SM / 5 HBM堆栈数量，完整绘制全部端点；未将 GTSim 的计算区间展开成推测内存事务。

- **62/62 Node测试通过**，包括请求与字节守恒、共享合并/命中/分发、计算输入与写回提交依赖、FCFS队列、链路带宽/独占、连续hop路径、确定性、非法输入、132SM布局、零流量源与旧详细后端兼容，以及GTSim操作语义/依赖面板。
- 默认132SM共完成396tile，12,822个事件、38,768模型周期、3,174端到端包；NoC64→16 B/cycle后为54,159周期，交付数据与完成任务不变。
- 396共享读取仅3次HBM读取；80次pending miss合并、313次L2返回后命中，共节省393次读取。关闭合并后共享HBM读取为396，SM有效输入字节守恒。
- 独立补验最大允许拓扑（256SM / 256路由组 / 32L2 / 16HBM / 8轮：1,970组件、63,923事件）、1-byte payload、零传播延迟及HBM端点多于L2的边界，transport contract、FCFS和资源不重叠检查通过。
- Chrome验证132个可选SM与5HBM全见、SM131下钻、逐跳运动、暂停/seek/回退位置一致、点击响应包定位源事件并高亮同request路径；无flow的HBM/L2服务与排队可选，不生成虚构payload。
- 参数草稿不改旧运行；NoC32 B/cycle重仿真为39,288周期。宏观/详细运行工作区保存恢复各自时钟（1000 / 12），源配置与选择保留。
- 旧GTSim保持796事件，只含2个native SM，130配置占位标为未观测且无光包；Chrome profile保持tracks。减少动画默认暂停。
- 1440×1000默认地图完整显示132SM与5HBM，SM编号约9–11px、光包约12.4×6.9px、辅助证据11px；HBM/L2中心、队列及重叠位置的包可常规点击。390/320无整页横向溢出，来源详情展开后恢复折叠的facts。
- 两个数据流JSON及原GTSim样例通过CLI验证；新增模块通过语法与静态构建检查。Chrome无页面错误或失败资源请求。62项测试与上述补验检验实现行为，不代表真实H100时序或数值执行验证。
- 操作语义与任务依赖面板位于时间线之后，默认折叠；GTSim展开后保留定位重叠、方包选择与依赖追踪。各宽度的grid行独立，新增面板不遮挡数据流城市与回放控件。

等待队列仍无界，router/fabric为理想中转，未实现真实NVIDIA NoC布局、有限buffer/credit背压、flit或硬件multicast。模型与动画时钟分别控制。

## 形式化 SM 与文献约束的双分区 NoC

2026-10-14 后续迭代：本节描述当前实现；前述单 Fabric 的周期、12 个逻辑路由组和全 GPU 单次共享 fill 属于历史模型记录。

- **106/106 Node测试通过**；5份GTSim/NoC/SM样例契约校验、JS语法、Git空白和本地文档链接检查通过。静态构建在`/GPU-sim/`子路径验证入口、ESM、动态CSS和原schema详细指令导入，无404/请求失败/脚本错误，320px无整页溢出。

- SM 图与教学模型共用25类组件定义，按4分区实例化76节点、254条类型化端口连线。组件有状态、资源、L/II/K/Q、转换条件、释放条件、不变量与来源等级；只有选定SM展开教学事件，没有在132SM各复制76节点并伪称全GPU详细仿真。
- TMA 提交与异步完成分开，SMEM提交后再完成字节计数barrier。没有经过RF的TMA payload或虚构的TMA寄存器写回；MMA.SYNC通过寄存器片段输入，不冒充WGMMA warpgroup执行。未执行的纹理/常量路径无活动，I-cache与分支明确只做时序服务。
- 最终SM默认 **112条教学指令 / 2,611阶段 / 1,130模型周期**；stride32为 **2,622阶段 / 1,198周期**。TMA每warp填充4KiB，具体LDS lane地址范围必须落入已填充缓冲并引用真实写入依赖；STS使用独立scratch。默认/stride32分配33,792 / 64,544B，均为64KiB carveout；32warp+stride32等超容量组合会被拒绝。多轮复用两个物理缓冲前须完成前轮消费，不把不同dataKey误算为无限存储。
- Chrome检查SM131、四分区总览76组件、P0/P3切换、typed ports/状态/当前有效时序/转换/不变量/引用弹窗、Escape关闭。显式Fetch→Decode token定位、前进、回退坐标一致。工作区保留宏观与教学各自时钟、SM目标、bank参数和分区选择。
- NoC默认 **14,411事件 / 596组件 / 396 Tile / 32,166模型周期**；带宽256→16 B/cycle后 **15,508事件 / 46,834周期**。共享396读分别在两个缓存域各填充3次，共6次HBM读取、节省390次；不是全GPU广播或TMA multicast。
- 566个bridge hop、591,744桥传输字节；214本地HBM读、188远端HBM读。本分区L2命中返回不跨桥，远端内存miss请求/返回经过有向桥。
- 串行化占用与传播独立，L2固定延迟与接收间隔分开。契约严格验证serializer释放、字节带宽、尾包到达、后续hop因果；旧无释放声明记录继续按end占用，不修改原Trace。
- 独立审计补验141个配置，含1SM/1L2、奇数SM/router/L2、不同HBM、合并开关与单Fabric模式。完成数、端点字节、分区fill、bridge和本地返回守恒；7,313次传播重叠无注入冲突。默认3.2只是NoC/L2端口与HBM字节预算之比，未称实测吞吐。
- Chrome验证默认132SM/5HBM/2fabric与cache域、点击bridge源事件`traffic:1398`并追踪request、从SM131启动教学运行后切回恢复宏观时钟、参数草稿不改旧记录、慢NoC重仿真、单Fabric兼容、原GTSim保持5,492周期且无推测车流。390/320px无整页横向溢出，无脚本错误或失败资源请求。

当前HBM仍为未校准的单服务端点；Tile缓存/pending合并是理想化策略，未执行真实sector/MSHR、有限NoC buffer/credit、flit/wormhole、完整WGMMA/DSM/TMA multicast或数值kernel。检查与补验验证实现规则，不等于实机H100校准。[NoC规则与论文核查](noc-model.md) · [SM完整定义](sm-architecture.md)
