# Modern GPU 实测证据查看器

直接打开 `modern-evidence.html`。它内嵌 H100/B200 共 216 条真实 Tensor TMA 运行，可选择 GPU、correct/fault/fix、形状/seed/代数和逻辑 generation，检查全部 90,144 个有效输出元素。

页面顶部可进入 `tcgen05-evidence.html`：从 B200 已完成的 36-run full suite 中选择 iterations=5、seed=7 的三个版本，展示 15 个 iteration / 61,440 个输出元素。其 generation 全程保留十进制字符串，使用 BigInt 派生输入 tag 低位；完整 tag 来自设备加载的源输入 metadata，不是 TMEM tag 或 MMA payload 中的硬件 generation。这个页面没有把 smoke 算作完整测试，也没有声称展示全部 36 次运行。

两页均为自包含离线 HTML，无外部脚本或字体依赖。所有输入 raw stdout 和绑定源码在渲染前校验 SHA-256；TMA summary 与 raw 对应字段、tcgen05 数值差异计数均在生成时复核。源码合同和实际设备记录分开标注。事件数组布局不是时间轴；本页不从数组顺序、clock64 或 opcode 邻接推断跨线程 HB。

## 复现

```bash
python3 tools/research/render-modern-evidence.py
python3 tools/research/check-modern-viewer.py out/research/modern-viewer/modern-evidence.html --output out/research/modern-viewer/browser-check.json --screenshot out/research/modern-viewer/viewer.png
python3 tools/research/check-modern-viewer.py out/research/modern-viewer/tcgen05-evidence.html --output out/research/modern-viewer/tcgen05-browser-check.json --screenshot out/research/modern-viewer/tcgen05-viewer.png
```

渲染器支持重复 `--summary` 指定 TMA 输入、`--tcgen-summary` 指定可选 TC 完整 suite 和 `--out` 指定输出目录。TC 默认输入尚不存在时只生成 TMA 页面。

## 验证

真实 Chrome 通过全部 TMA 216 runs / 576 generation states / 90,144 输出元素 / 2,304 事件记录，以及 TC 3 runs / 15 iterations / 61,440 输出元素 / 165 事件记录的 DOM 绑定核对。TC 5 个 fault iteration 的相同低位、不同完整 generation 字符串已核对。两张最终截图经过视觉检查，关键字段没有页面横向溢出；输出大数组使用面板内滚动。

这些检查验证 UI 与保存的实测证据一致；不是新的 GPU 实验、独立 ISA 语义证明、性能研究或用户理解研究。
