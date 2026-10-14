# H100 规模的数据流模型

当前默认使用本仓库 `GPU City Traffic Model` 的双分区 crossbar 教学模型，保留 H100 SXM 的 **132 SM / 5 HBM 堆栈**数量。模型、GTSim 后端与 SM 流水线教学运行分别保存，不融合时钟或凭空展开指令。

[完整 NoC 规则与实现边界](noc-model.md) · [MICRO 2024 论文与 NVIDIA 来源核查](research/gpu-noc.md) · [SM 内部规格](sm-architecture.md)

## 当前请求与资源规则

每个 SM 每轮完成一个合成 Tile：共享输入与私有输入到齐后开始计算，输出提交 HBM 后开始下一轮。这是并发共享输入演示，不执行真实 GEMM 张量数值或 CUDA CTA 调度。各 SM 可同时发出请求，但数据依实际缓存、端口、链路竞争分别到达，不要求全部同时接收。

- SM 读请求送往所属逻辑分区内的 L2；未命中才去数据 home HBM，远端 HBM 的请求/返回通过有向跨分区桥。
- 同一数据在不同 L2 域分别缓存和填充；共享 Tile 的 pending 合并属于明确的理想化策略，不保证整 GPU 仅一次 HBM 读取。
- 普通读请求有各自的 response packet，逐目标单播返回。**L2 复用或 miss 合并不等于 TMA multicast，也不是 HBM 天然广播。** 当前没有执行 TMA cluster multicast、DSM 或跨 GPU NVLink 广播。
- 链路占用时间为 `ceil(bytes / bandwidth)`；完整包的尾部到达时间再加传播延迟。传播中的包可与下一包串行化重叠，后续 hop 仍等完整包到达，属于 packet store-and-forward，未模拟 flit / wormhole。
- L2 lookup 固定延迟与启动间隔也分开；HBM 是粗粒度单服务端点，未实现真实 DRAM 命令、bank 并行和控制器调度。
- 等待队列无界；8 个聚合路由组与 8 个聚合 L2 节点不是逆向出的物理 GPC/slice 布局。带宽、桥延迟、SM→分区编号映射均是教学参数，尚未拟合实机测量。

## 来源、导入与扩展

`meta.capabilities` 保留 `tile_tasks`、`memory_requests`、`noc_transfers`，`trafficSchemaVersion: 1`；拓扑保存全部节点、方向、链路预算，事件保存原始 packet/request/data 身份、字节数与 hop 序列。`issueReleaseCycle` 标识串行化资源释放，与 packet 的 `end` 到达时间不同；依赖校验分别检查发射与完成条件。

[契约](../lib/traffic-contract.js) 验证端点、字节与身份、连续路径、链路占用与到达因果。旧记录没有释放时间时按原 `end` 解释，不修改历史 Trace。单 Fabric 对照模式保留理想全局缓存假设，界面明确标注为对照。

```bash
node scripts/generate-traffic.mjs
npm test
npm run validate
```

默认和慢 NoC 样例分别在 [h100-traffic.json](../examples/h100-traffic.json) 与 [h100-traffic-slow-noc.json](../examples/h100-traffic-slow-noc.json)；记录包含实际参数与计算结果。本项目此前 38,768 / 54,159 周期来自旧单 Fabric、传播占用链路的教学模型，是历史实现结果，不能用来说明当前模型或真实 H100 性能。

后续接入实测 SM↔L2 RTT/吞吐时，需要保留采集 GPU、命中/缺失、并发度、时钟域与运行条件；先校准端到端模型，再分解可识别参数。有限 sector/MSHR、真实 multicast 树、有限 buffer/credit 和 detailed backend transport 另行实现与验证。
