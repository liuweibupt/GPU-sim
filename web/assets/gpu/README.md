# GPU 组件美术

六张透明 PNG 使用内置 `image_gen` 工具生成于 2026-10-14，作为本项目的概念硬件美术：

| 文件 | 视觉角色 |
| --- | --- |
| `sm.png` | 有重复计算分区的 SM 城市模块 |
| `tensor.png` | 矩阵乘加阵列 |
| `scheduler.png` | 队列与调度分派模块 |
| `cache.png` | 片上 banked SRAM / cache 模块 |
| `hbm.png` | 堆叠 HBM 存储 |
| `warp.png` | warp 工作包示意；美术格子不编码 lane 数或 active mask |

完整提示词、生成方式和各文件角色保存在 [manifest.json](manifest.json)。素材是统一视角、graphite/copper/teal 配色的概念切图，未使用第三方游戏素材或厂商 logo。它们不表示某家真实芯片的物理版图。

组件名称、真实任务数、时刻、选中状态和交互命中区域全部由前端独立绘制。美术中的格子、端口或亮点不应解释为后端实际观测值。缺少观测数据的 L2、HBM、scheduler 等保留结构示意标记。
