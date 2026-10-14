# 双分区GPU NoC教学模型

本模型服务于“SM是城市、L2是物流中心、HBM是仓库”的数据流沙盘。目标是让请求、返回、排队和共享数据复用具有可执行的因果关系，并遵守公开架构知识。本版是**参考H100文献的双分区crossbar抽象**，没有重建NVIDIA私有物理互连，也没有完成实机周期校准。研究依据与代际审计见 [GPU NoC核查](research/gpu-noc.md)。

## 结构与数量

| 节点/资源 | 本模型选择 | 真实性边界 |
| --- | --- | --- |
| SM | 默认132个执行端点 | 数量参考H100 SXM；不等于每个SM执行完整CUDA指令模型 |
| HBM | 默认5个服务端点 | 对应堆栈数量；不展开10个真实memory controller、DRAM bank或命令 |
| 逻辑聚合组 | 默认8组 | 教学路由聚合，SM编号分组不是实测GPC floorplan，不推断66个TPC映射 |
| 分区crossbar | 2个逻辑分区 | 参考公开partitioned crossbar；内部理想交换不代表真实arbiter |
| L2 | 默认8个聚合服务端口 | 不是实机80个L2 slice，也不执行完整50MB缓存容量 |
| 跨分区bridge | 双向独立服务链路 | 带宽与延迟为可调教学参数，没有声称是实机网宽 |

H100硬件数量来源于 [NVIDIA Hopper Architecture In-Depth](https://developer.nvidia.com/blog/nvidia-hopper-architecture-in-depth/)，partitioned crossbar描述来自 [官方H100白皮书](https://dam-cdn.nvd.orangelogic.com/AssetLink/705n6ur546g0uk43w0117r17n8042d73.pdf)。MICRO2024报告的80个L2 slice是另一个粒度的实验组织，不能与这里8个聚合端口逐一等同。[作者论文](https://people.ece.ubc.ca/aamodt/publications/papers/realgpu-noc.micro2024.pdf)

普通读请求先走 `SM → 聚合组 → 本分区crossbar → 本分区L2聚合端口`，cache命中可直接本地返回。miss从L2回到本分区crossbar，再访问数据的home HBM；home位于另一分区时，经crossbar bridge到home分区。HBM归属用教学hash选择，不由SM所在分区强制决定。返回沿声明的反向有向链路，反向传输可与请求并行。画布坐标和线路折点只是呈现，不参与地址映射或决定物理距离。

## 请求与分区缓存

每个SM每轮固定处理一个tile：共享输入与私有输入分别请求，二者全部返回后才能计算，计算后写回HBM，再开始下一轮。此处CTA编号用于任务归属，不模拟真实CTA派发策略或GEMM数值。

`shared:${round}` 表达本轮相同的逻辑输入身份；缓存/未完成填充的身份还包含分区。开启合并后，同分区的同key请求可加入同一未完成填充，已返回数据可在该分区命中。另一个分区保留自己的填充/驻留状态，不能因为数据key相同就宣布整个GPU唯一一次HBM读取。

这一政策用于展示H100局部L2缓存的定性原则，是理想化教学实现。它以整tile作为对象，尚未按真实地址、32B sector、cache line及有限MSHR执行。缓存只服务约定的共享输入，当前工作负载内不驱逐；不推导真实L2一致性、复制协议或地址hash。

每个等待者仍有独立请求身份和返回包。一次填充减少HBM重复读取，不减少必须交付给各目标SM的有效输入数据，也不会自动变成NoC multicast。统计中区分 `mergedMisses`、`l2Hits`、HBM读取字节、SM交付字节与每跳传输字节，禁止把这些不同口径加成同一种“流量”。

关闭共享请求合并时，共享请求独立访问HBM；该开关是反事实教学政策，不是宣称真实GPU能关闭全部缓存机制。

## 时序与资源占用

单跳数据包定义：到达链路时间 `a`、开始序列化时间 `s`、串行化周期 `Tser = ceil(bytes / bandwidth)`、传播延迟 `Tprop`。

```text
s = max(a, linkNextAccept)
serializationEnd = s + Tser
arrivalEnd = serializationEnd + Tprop
linkNextAccept = serializationEnd
下一跳最早到达 = arrivalEnd
```

链路只在 `[s,serializationEnd)` 占用串行化资源；传播阶段不会继续阻塞后续包注入。前包尚在传播时，后包可以开始串行化。动画可在完整hop区间内播放，但资源检查必须按串行化边界，而不能把可重叠传播误判为链路冲突。

采用整包逐跳转发，下一跳等待当前hop完整到达。模型没有flit、wormhole、virtual channel和逐flit credit；把传播与串行化分开不等于已经实现flit级NoC。

有向链路及L2/HBM端点按实际到达排FCFS队列；不同端口/方向可并发。crossbar内部是理想交换抽象，不额外执行复杂交换仲裁。等待队列仍无界，不声称有有限buffer、完整背压、死锁、重传或拥塞丢包模型。HBM写提交完成通知不单独生成网络ACK服务。

## 默认带宽层级及含义

| 教学参数/算式 | 默认值 | 含义 |
| --- | ---: | --- |
| 普通NoC链路 | 256 B/model-cycle | 单逻辑链路串行化能力 |
| 聚合L2端口数 | 8 | 逻辑并发端口，非物理slice数 |
| NoC到L2端口聚合名义能力 | `8×256 = 2048 B/model-cycle` | 端口能力上界，不是所有工作负载保证达到的吞吐 |
| HBM服务端点 | `5×128 = 640 B/model-cycle` | 仅字节服务名义能力，实际还受排队/服务延迟影响 |
| 端口名义能力比 | `2048/640 = 3.2` | 显式教学预算检查，不是H100微基准拟合值 |
| bridge | 512 B/model-cycle，传播16周期 | 教学跨分区资源，不是论文测得的单hop参数 |

设置层级预算是为了避免默认NoC接口能力不足而人为制造普遍的内存带宽瓶颈。论文要求区分bisection、端点接口和内存带宽；这里的3.2只是配置比，不等于实测的L2/DRAM比，也不证明本模型拥有真实GPU的完整speedup结构。[MICRO2024，Section VI](https://people.ece.ubc.ca/aamodt/publications/papers/realgpu-noc.micro2024.pdf)

参数改变可有意制造NoC瓶颈，观察其对排队和完成时间的影响；这属于玩家设定的架构实验。HBM仍以固定服务延迟加字节服务时间的单服务端点建模，不执行DRAM内部pipeline、bank并行或真实命令调度；所以640 B/model-cycle只是配置的字节速率预算，不是模型测得的可达吞吐。回放速度只改变渲染时钟，不改变任何模拟周期。所有带宽与延迟使用本次模型时间域，不能未经换算与真实GHz或GB/s混合。

## 已支持与尚未实现

| 已支持的当前模型行为 | 尚未实现/不作声明 |
| --- | --- |
| 显式双分区路径和bridge | 精确GPC/TPC/CPC物理布局、真实router/VC |
| 分区内理想共享填充合并与重用 | sector地址映射、有限MSHR、真实L2复制/一致性协议 |
| 独立请求和逐目标unicast返回 | 自动132SM广播、TMA multicast复制树 |
| 串行化占用与传播延迟分离 | flit/wormhole、有限buffer、credit/backpressure |
| 带宽参数重跑、可重复事件与因果依赖 | H100周期精确性或实测性能验证 |
| tile输入依赖、计算和写提交 | 与独立SM指令教学模型共享同一微架构状态的联合仿真 |

Hopper TMA multicast是**显式指令且cluster局部**的另一种操作。PTX CTA mask指定目标CTA，不能用132个SM的共享需求自动替代。当前SM教学示例只执行TMA global→shared单目标子集，NoC沙盘也没有multicast复制树。[PTX规范](https://docs.nvidia.com/cuda/archive/12.8.1/parallel-thread-execution/index.html#data-movement-and-conversion-instructions-cp-async-bulk)

## 数据与验证

生产者与版本、有效配置、时间域、模型假设及拓扑保存在trace元数据。transfer保留packet/request/data身份、当前跳源目的、端到端源目的、字节数及hop索引；链路资源释放点与数据到达点分别表达。缓存命中、合并、HBM服务、返回和计算之间使用实际完成依赖，不从动画进度倒推就绪。

验收至少包括：所有132SM任务完成；请求/响应字节守恒；跨分区路径确实经过bridge；两个分区的相同共享key分别保留填充；传播重叠不违反串行化互斥；后续hop不早于前hop到达；改变带宽重新生成结果；相同配置重复运行一致。当前运行统计以仓库脚本生成的示例与测试结果为准，不沿用旧单fabric模型的周期/流量数值。

旧版单fabric、12聚合组、整hop占用资源的模型说明保存在历史提交中；旧导入trace按其自身版本/配置回放，不能用新模型默认参数解释旧时间戳。
