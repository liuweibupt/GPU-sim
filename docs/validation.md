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
