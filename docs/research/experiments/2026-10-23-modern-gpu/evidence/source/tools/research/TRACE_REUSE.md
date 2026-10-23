# 多卡 trace 复用与证据查看

这是离线结构实验，不需要远程 GPU。数据根目录默认为 `/home/liuwei/GPU-simulator`；脚本只读源仓库，并在当前仓库的新目录写结果。完整结果见[多卡实验报告](../../docs/research/experiments/2026-10-23-multigpu/report.md)，此前独立模型与实机运行见[先导报告](../../docs/research/experiments/2026-10-23-pilot/report.md)。

## 顺序执行

从本仓库根目录运行，使用不存在的输出目录：

```bash
python3 tools/research/audit-source-traces.py --output out/research/source-new
python3 tools/research/run-trace-experiments.py --output out/research/trace-new
python3 tools/research/audit-compact-traces.py --output out/research/compact-new
python3 tools/research/render-trace-report.py \
  --input out/research/trace-new --output out/research/trace-new/viewer.html
python3 tools/research/check-trace-viewer.py \
  out/research/trace-new/viewer.html --output out/research/trace-new/browser-check.json
```

前两项默认读取同一份 457-launch manifest。原始 trace 审计重算约 30.2 GB 的 SHA256，再在 12 case / 16 trace 上验证完整文件框架并受界解码；不是全库逐指令语义校验。它导入外部仓库的 Python parser，内部禁止写 bytecode，并记录这些依赖的 SHA。缓存分析器仅需 Python 标准库，逐模板计算统计，再按物理 CTA 重数加权，不展开 1.12 亿条指令到内存。

compact 工具单独读取五卡的 launch 采集，检查引用/计数/时间字段并按 trace identity 去重；其 CUDA-event minimum 与 Representative-100 median 不能混为同一性能端点。case ID 是局部行号，跨卡比较使用声明的 operator/params，仅称 workload 对齐。

## 查看和重画已有结果

可直接打开 [viewer.html](../../docs/research/experiments/2026-10-23-multigpu/viewer.html)。不依赖网络或服务，包含 12 个主要 warp 视图与 2 个 Blackwell tensor warp 补充视图。支持切换检索策略、选择 seed、分页查看指令及检查候选前驱；其中阅读提示由字段规则生成，没有调用 LLM，也没有证明人的理解改善。

归档中体积较大的 JSON 使用无损 gzip；查看器会自动读取并校验**解压后的原始内容**，与 summary 中的 SHA/字节数一致才生成界面。没有源数据也能重新生成归档查看器：

```bash
python3 tools/research/render-trace-report.py \
  --input docs/research/experiments/2026-10-23-multigpu/trace \
  --output out/research/archived-trace-viewer.html
```

## 方法与不确定性

- `full` 返回所选 warp 的全部 ID；`order_ancestors` 取记录顺序前缀。
- `register_ancestors` 使用同名寄存器的最近写入作为语法候选，读取在当前指令写入之前处理，排除零寄存器写入。
- `protocol_assisted` 额外使用同一 warp 的符号 barrier 与静态 scoreboard 候选，未解析完整 phase/完成协议，没有跨 warp happens-before 边。
- 检索计时使用已在内存的图和索引，排除 I/O、解压、构图、排序和渲染；每方法每主视图 5 次预热、30 次随机顺序测量。补充视图不进入 12-view 统计。
- 候选边闭包保留率为 1 是构造性质，不是检测准确率、真实依赖召回率或因果完备性。缩小显示集合也不自动带来计算加速。
- 主 cache 缺 active mask、lane 地址、寄存器值、逻辑 tensor/版本、逐指令实测时间和 TMEM columns。空数组或 null 表示信息缺失，不解释为“没有访问”或“没有错误”。
- 两个 B300 地址 sidecar 保留 sector 地址，但仍没有 lane 值/版本；四份副本按原 trace SHA 去重为两个已有案例。
- source extraction 的 `source_worktree_dirty=true` 如实保留，不能只凭旧 commit 重建当时解析器。此次源码与产物 SHA 可以复核当前实验。

## 检查

```bash
python3 tests/test_trace_reuse.py
python3 tools/research/audit-source-traces.py --self-test
```

Chrome/Chromium 检查验证 14 个视图的 56 组交互检索集合与离线输出一致，并检查选中 seed、恢复和分页。它是功能验证，不是用户研究。源 hash 校验、模板权重、索引/独立 CTA 契约、截断/mask/缺字段的失败测试均不能替代 GPU 数值或协议正确性验证。
