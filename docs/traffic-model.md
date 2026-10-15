# H100 规模的数据流模型

当前默认使用本仓库 `GPU City Traffic Model` 的双分区 crossbar 教学模型，保留 H100 SXM 的 **132 SM / 5 HBM 堆栈**数量。模型、GTSim 后端与 SM 流水线教学运行分别保存，不融合时钟或凭空展开指令。

[完整 NoC 规则与实现边界](noc-model.md) · [MICRO 2024 论文与 NVIDIA 来源核查](research/gpu-noc.md) · [SM 内部规格](sm-architecture.md)

## 当前请求与资源规则

全局 grid 中每个 CTA 完成一个合成 Tile。教学派发器先给每个 SM 一个 CTA，再填第二个驻留槽；任一槽释放后，从全局队列即时补派。默认 396 个 CTA、每 SM 最多驻留 2 个，模型 cycle 0 的初始集合为 **132 个 SM、264 个驻留 CTA**，另有 132 个 CTA 等待派发。初始启动在模型中被简化为同一时刻；真实 launch ramp 和 NVIDIA 私有派发顺序未实现。

**驻留并不等于此刻正在计算。** CTA 等输入、等待计算端点、计算、等待输出被接受时都仍占用驻留槽。界面应分别展示有驻留任务的 SM 与此刻执行计算的 SM；一个 SM 可以同时有一个 CTA 计算、另一个 CTA 等内存。小 grid、资源限制和执行尾部确实可能只占用部分 SM，不能为使画面全亮而虚构任务。CUDA 允许各 block 以任意顺序并行或串行执行，并不保证所有 SM 同周期启动。[NVIDIA CUDA Programming Model](https://docs.nvidia.com/cuda/cuda-programming-guide/01-introduction/programming-model.html#thread-blocks-and-grids)

共享输入与私有输入到齐后 CTA 才能进入计算队列；同 SM 的 CTA 共用一个 tile 级计算端点。本模型允许不同 CTA 的访存与计算重叠，但没有执行逐 warp 指令发射、GEMM 数值或真实占用率预测。

## Grid 与驻留配置

| 参数 | 默认值 | 含义 |
| --- | ---: | --- |
| `gridBlocks` | `numSms × rounds` = 396 | CTA 总数；显式设置后覆盖 `rounds` 推导值 |
| `threadsPerBlock` | 256 | 每 CTA 线程数；本教学模型要求 32 的整数倍 |
| `registersPerThread` | 64 | 每线程 32-bit 寄存器资源预算 |
| `sharedMemBytesPerBlock` | 65536 | 每 CTA 用户 shared memory 预算 |
| `maxResidentBlocksPerSm` | 2 | 教学驻留上限，与硬件最大 32 CTA/SM 分开 |

有效驻留数取配置上限、64 warp/SM、65536 个 32-bit 寄存器/SM、32 CTA/SM，以及 228 KiB shared memory/SM 各约束的最小值；shared memory 还计入每 CTA 的 1 KiB 保留。默认寄存器最多允许 4 CTA，shared memory 最多允许 3 CTA，最终教学上限为 2 CTA。该计算省略寄存器分配粒度、实际 carveout/函数 opt-in、cluster 调度和其他编译器约束，只是资源计数上界；实际 CUDA kernel 应用 occupancy API 查询。[NVIDIA Hopper Tuning Guide](https://docs.nvidia.com/cuda/hopper-tuning-guide/index.html#occupancy)

`round` 仅按 `floor(threadBlockId / numSms)` 划分共享输入组，不是全局 barrier，也不要求一个 SM 每组恰好执行一个 CTA。输出被模型 L2 写路径接受后 CTA 退休并释放槽；HBM 写提交继续异步执行，有独立完成记录和字节守恒。这一完成范围避免把所有 CTA 串行等待 DRAM 当作通用 CUDA 行为，但没有实现 CUDA memory fence、atomic、缓存一致性或跨 CTA 同步。

`trafficSmSnapshot(trace, time)` 读取保存的生命周期，返回每 SM 的 `residentBlocks / computingBlocks / readyBlocks / waitingBlocks`。区间使用 `[start, retired)`，等待与计算的 SM 数可以相交，`memoryOnlySms` 才是只有等待、没有 ready 或 compute 的数量；`completedBlocks` 表示 CTA 退休，`committedBlocks` 表示 HBM 输出已提交。旧 trace 依据其自身 issue/compute/complete 时间恢复状态，不改写旧时间戳。

## 请求与资源

- SM 读请求送往所属逻辑分区内的 L2；未命中才去数据 home HBM，远端 HBM 的请求/返回通过有向跨分区桥。
- 同一数据在不同 L2 域分别缓存和填充；共享 Tile 的 pending 合并属于明确的理想化策略，不保证整 GPU 仅一次 HBM 读取。
- 普通读请求有各自的 response packet，逐目标单播返回。**L2 复用或 miss 合并不等于 TMA multicast，也不是 HBM 天然广播。** 当前没有执行 TMA cluster multicast、DSM 或跨 GPU NVLink 广播。
- 链路占用时间为 `ceil(bytes / bandwidth)`；完整包的尾部到达时间再加传播延迟。传播中的包可与下一包串行化重叠，后续 hop 仍等完整包到达，属于 packet store-and-forward，未模拟 flit / wormhole。
- L2 与 HBM 的固定服务延迟和字节串行化占用分开：端点完成时间为 `start + ceil(bytes / bandwidth) + latency`，串行化结束后可接受下一请求。HBM 是聚合吞吐教学端点，未实现真实 DRAM 命令、bank 并行和控制器调度。旧版把每次 HBM 固定延迟占满整个端点，会过度串行化访存，压低同时计算的 SM 数；新模型允许在途服务重叠，数据依赖仍等待实际完成。
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
