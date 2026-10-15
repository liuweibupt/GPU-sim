# 网站精简、SM 驻留与光点回放验证

日期：2026-10-15。测试对象为本仓库的教学模型和浏览器回放；不表示真实 H100 周期或利用率预测。

## Review 结论与修改

- 旧 GPU 图只用 SM 下的 compute 区间点亮建筑。访存等待被记录在链路、L2、HBM 下，因此看起来只有少数 SM 启动。现在以独立 CTA 生命周期区分驻留、计算、ready 和仅等内存。
- 旧“SM 内部”默认换成只有 2 个 SM 的 FlashGPU-Sim vectorAdd 样例，容易与 132 SM 全景混淆。现在点击任意 SM 生成对应编号的独立教学流水线，宏观运行单独保留；原生样例由场景菜单明确选择。
- 旧 HBM 固定延迟也独占服务端点，造成过度串行。现在字节串行化结束后可接收下一请求，完成依赖仍等固定延迟结束；未实现 DRAM bank 或命令调度。
- 删除重复载入、渲染模式、重复事件列表和播放入口；组件导航与实验参数默认折叠，事件未选中时收起空检查面板。
- SM 光点只由非零模型/观测区间产生，支持循环、暂停、单步、定位与回退。循环只重复回放，不篡改周期或伪造新指令。原生流水线按实际观测窗口播放。

## 可复现模型检查

| 场景 | 结果 |
| --- | --- |
| 默认 grid = 396 / 132 SM，cycle 0 | 132 驻留 SM、264 驻留 CTA、132 待派 CTA；0 计算 SM（输入尚未返回） |
| 默认负载 cycle 1853 | 132 驻留 SM、85 计算 SM、47 仅等内存 SM |
| 默认负载完成 | 396 Tile 全部完成，3,231 教学周期；较慢 NoC 对照为 30,065 周期 |
| grid = 8 | 初始只有 8 个 SM 驻留；仍绘制全部 132 个配置 SM |
| 128 Warp，64 registers/thread | 最多驻留 32 Warp，其余分批准入；1,792 条教学指令完成 |
| 32 个单 Warp CTA，128 B TMA，16 registers/thread | 用户缓冲 8 KiB，加每 CTA 1 KiB 保留后共 40 KiB，选择 64 KiB carveout |
| 导入伪造 cycle 0 eligible / 提前 issue | SM 契约拒绝；状态必须对应真实译码与发射区间 |

旧固定延迟独占 HBM 的同配置版本峰值为 15 个计算 SM、32,374 周期；这是模型行为修正前后的对照，不能解释为实机性能提升。

运行命令：

```bash
node scripts/generate-traffic.mjs
node scripts/generate-sm.mjs
npm test
npm run validate
npm run build
```

**结果：144 项自动测试、7 份样例 Trace 校验与静态构建通过；浏览器最终回归通过，无 JavaScript 错误或资源请求失败。**

自动测试覆盖 CTA 资源守恒、整 CTA 准入/退场、连续 SMEM 区间与复用、异步 TMA 排空、ready/eligible/issue 因果、HBM 串行化互斥/延迟重叠、包与字节守恒，以及循环边界。原生样例、旧 trace 和工作区仍保留原始时间域。

## 浏览器检查

使用本地 Chrome 和已有 Playwright Core，无新增仓库依赖。检查默认与小 grid、SM 131 目标保持、128 Warp 分波、光点位置随周期改变、循环跨末端、暂停/定位稳定、单次播放停止、回到宏观时钟、工作区恢复，以及显式原生流水线/点日志导入。桌面检查 1440×1000、1366×768；移动端检查 390/320 px 宽度。短屏允许画布内滚动，不缩小到不可读的整图；表单展开不应产生整页横向溢出。减少动画偏好默认暂停。

[GPU 全景截图](assets/sm-residency-overview.png) · [SM 光点截图](assets/sm-residency-pipeline.png)

硬件依据：[CUDA block 派发与执行模型](https://docs.nvidia.com/cuda/cuda-programming-guide/01-introduction/programming-model.html#thread-blocks-and-grids)、[Hopper occupancy](https://docs.nvidia.com/cuda/hopper-tuning-guide/index.html#occupancy)、[每 CTA 1 KiB shared-memory 保留](https://docs.nvidia.com/cuda/hopper-tuning-guide/index.html#unified-shared-memory-l1-texture-cache)。

发布缓存回归：先在同一浏览器缓存旧版 JavaScript（1 小时缓存），再载入新版入口，确认模型、契约、架构规格和 GPU 场景均通过新版本 URL 重新获取；SM 131 光点与 128 Warp 运行通过，无脚本错误。
