# 原始证据与版本协议实验

[结果报告](../../docs/research/experiments/2026-10-23-semantics/report.md) · [下一阶段资源](../../docs/research/semantic-next-stage.md)

需要 Node 18+、Python 3（标准库）；原始重导出依赖用户现有 `/home/liuwei/GPU-simulator` 与上一轮归档。新实机测试需要本地 CUDA 12.6 `nvcc`、Compute Sanitizer 13.1 与 SM89。固定工具链位置见 runner，不能在无对应设备时把 CPU 模型当硬件结果。

以下从仓库根目录执行，每次使用未存在的输出目录。源 trace 仓库只读。

```bash
python3 tools/research/extract-raw-evidence.py \
  --source /home/liuwei/GPU-simulator \
  --archive docs/research/experiments/2026-10-23-multigpu \
  --output out/research/reproduce-raw

python3 tools/research/analyze-raw-evidence.py \
  --input out/research/reproduce-raw --output out/research/reproduce-mask

python3 tools/research/audit-static-operands.py \
  --source-root /home/liuwei/GPU-simulator \
  --raw-evidence out/research/reproduce-raw --output out/research/reproduce-static

node tools/research/run-protocol-experiments.mjs --output out/research/reproduce-protocol

node tools/research/bridge-raw-protocol.mjs \
  --input out/research/reproduce-raw --output out/research/reproduce-raw-bridge
```

原始导出保持 CTA 0 的所有已记录 warp、零 mask、未归一化 opcode 与 field，输出 schema/源文件哈希/行号。无法证明采集完整性时显式 unknown。static 审计只验证列明的五个 scalar family 字面 token，不计算完整 def-use；mask 实验仅报告记录级候选差异。

`protocol-corpus.mjs` 的 oracle 穷举有限事件全序，不导入生产检查器；`protocol.js` 从事实与要求推导状态，拒绝输入 verdict、矛盾 token 和 cyclic HB。缺边不判错。领域事实仍依赖 caller attestation，不能用于声称完整 ISA 验证。

实机实验单独执行，runner 在每组前后检查空闲窗口，不终止其他作业，不作性能测量：

```bash
python3 tools/research/cuda/run_version_probe.py --output out/research/reproduce-version-cuda

node tools/research/bridge-version-probe.mjs \
  --input out/research/reproduce-version-cuda --output out/research/reproduce-version-bridge

python3 tools/research/render-version-report.py \
  --suite out/research/reproduce-version-cuda \
  --bridge out/research/reproduce-version-bridge \
  --output out/research/reproduce-viewer/version-viewer.html

python3 tools/research/check-version-viewer.py \
  out/research/reproduce-viewer/version-viewer.html \
  --output out/research/reproduce-viewer/browser-check.json
```

GPU runner 保存 72 次普通运行的完整 stdout/输出/tag/event，另以代表形状检查三种 sanitizer × 两个版本；错误版应用 exit 2 是预期数值错误，工具 exit 99 或非零工具错误不能当成功。stdout 中 sanitizer banner 与唯一 JSON 记录分开解析，所有原日志保留。

bridge 校验 stdout 内容、输入维度、独立数值 reference、事件 pointer/源码行、source SHA 与 barrier sites，再将共享 slot tag 接入版本义务。固定源码 contract 只建立明确标记的 barrier boundary 与 HB；不同 warp 的 post-barrier 回调不直接排序。遮蔽 value-token 接口或删除 HB 边测试的是接口敏感性，原始 facts 保留。由本例得到的结论不能外推 TMA/tcgen05/TMEM。

归档与校验工具：

```bash
python3 tools/research/archive-semantic-experiments.py --help
python3 tools/research/check-semantic-archive.py \
  docs/research/experiments/2026-10-23-semantics
```

归档保留原始 bytes 的 SHA 与压缩后 SHA，较大 JSON 无损 gzip；CUDA executable 不提交，二进制哈希与完整编译命令保留。归档 checker 验证文件、实验间绑定与源码快照，不把完整性校验当硬件正确性证明。

质量检查：

```bash
npm test
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_*.py' -v
```

最终原始运行分别为 raw `20261023-cta0-v2`、protocol `2026-10-23T09-06-51.774Z`、static `20261023T091346Z`、CUDA `20261023-version-probe-v3`、两个 bridge `20261023-v3`。其他本机 `out/` 中间结果不与最终计数混合。归档 manifest 是最终交付的完整文件索引。
