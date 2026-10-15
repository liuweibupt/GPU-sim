# 浏览器执行与性能验证

2026-10-15：工作台仍是静态浏览器应用，没有服务器端仿真或物理 GPU 要求。教学模型使用原有 JavaScript 离散事件实现，在 module Web Worker 中执行；WebAssembly 加速的是播放时的活动事件查询。导入、导出和工作区仍在本地处理。

## 实现

- `lib/simulation-client.js` 与 `web/simulation-worker.js` 把 traffic / SM 仿真移出 UI 线程。切换场景、返回全景、打开其他运行或导入文件时会终止过期 Worker；旧结果不会覆盖新的选择。Worker 失败会显示错误并保留已有运行。
- `lib/interval-index.js` 按起点排序并建立最大结束时间树，每次只遍历可能包含活动区间的分支。`lib/interval-query.c` 编译成随仓库提交的 324 B WASM 模块；索引缓冲区只复制一次，每次查询只返回活动下标。模块加载失败、CSP 阻止执行或内存分配失败时保留 JavaScript 索引。每个索引独立拥有内存，替换运行后可被回收。
- 活动区间继续使用 `[start, end)`，零时长观测点独立索引；乱序输入、同周期点的原始顺序、CTA/warp 0、筛选与回退均保留。范围、搜索文本和排序结果按输入条件缓存，时间变化不再重建它们。
- 动画目标上限为 30 Hz，计数和检查面板为 10 Hz；两者均使用实际经过时间推进回放。没有缩短事件、改变周期或跳过仿真计算。静态标题、ARIA、颜色和计数只在变化时写入，任务清单复用未变化的 DOM；关闭的规格弹窗停止刷新。
- 移动光点使用分层 halo，减少逐点 blur / drop-shadow 的离屏绘制；选中与键盘聚焦仍保留发光和轮廓。

普通 `npm start` / `npm run build` 使用已经提交的 WASM，无须安装编译器。修改 C 源码后可用 Clang + wasm-ld 重建：

```bash
npm run build:wasm
```

脚本会查找 `wasm-ld` 或常见带版本号的 linker；也可设置 `WASM_CC`、`WASM_LD` 指定工具路径。静态构建同时复制 Worker 和 WASM，排除 C 源码；所有资源保持相对路径，支持 GitHub Pages 项目子目录。开发服务器以 `application/wasm` 提供模块。

## 同环境浏览器对照

基线 commit：`9f935760075bfa77c92ab4bc3d5feffafb540c76`。基线使用独立源码快照，与修改后的站点先后测量。环境为本机 Linux、无头 Google Chrome 155.0.8059.39、1440×1000、未启用减少动画；默认 traffic 回放 12 秒，再点击 SM 0，等待 750 ms 后回放 12 秒。每个模式单次采样，结果会随设备、负载和浏览器变化。

| 模式 / 指标 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 全景：主线程 TaskDuration / 12 s | 5.86 s | 3.39 s |
| 全景：场景 DOM mutations / 12 s | 186,907 | 29,448 |
| 全景：浏览器 rAF 可用帧率 | 58.8 FPS | 60.0 FPS |
| SM：主线程 TaskDuration / 12 s | 11.55 s | 5.89 s |
| SM：场景 DOM mutations / 12 s | 114,726 | 25,323 |
| SM：浏览器 rAF 可用帧率 | 37.5 FPS | 57.2 FPS |
| SM：rAF 间隔 p95 | 33.4 ms | 16.8 ms |

表中的帧率来自独立 rAF 采样器，表示浏览器处理帧回调的能力；光点动画自身上限为 30 Hz。TaskDuration 是 Chrome DevTools Protocol 累计主线程工作时间，包含脚本、布局及渲染任务，不能当作仿真耗时。两次采样的稳态窗口均无超过 50 ms 的 long task；收益主要来自持续渲染负载的减少。导入 JSON、验证、首次建立索引和场景 DOM 挂载仍在主线程，超大文件的首次打开还可能产生停顿。

默认 17,851 事件、2,000 个查询位置的 Node 独立测试中：全扫描约 223 ms，JavaScript 区间索引约 52 ms，WASM 索引约 40 ms；查询结果数量一致。该测试排除索引初始化、DOM 和 SVG 绘制；性能收益同时来自索引算法与 WASM，不能全部归因于 WASM。

## 复现

```bash
npm test
npm run validate
npm run benchmark
npm run build
npm start
```

浏览器脚本为可选开发工具，需要独立安装的 Playwright 与 Chromium/Chrome，不增加生产依赖：

```bash
CHROME_BIN=/usr/bin/google-chrome node scripts/benchmark-browser.mjs \
  http://127.0.0.1:4173/web/ /tmp/gpu-sim-browser-benchmark.json
```

默认导入 `playwright`；外部安装可设置 `PLAYWRIGHT_MODULE` 为其入口绝对路径。脚本导出两个模式的 rAF、long task、DOM mutations、主线程指标和 JS 错误。WASM 正确性测试直接执行提交的二进制，并覆盖已创建索引升级、大索引内存增长及模块加载失败；Worker 测试同时覆盖取消、过期响应、错误处理，以及真实 worker thread 与原模型的完整 trace 一致性。

本次另外通过 12 个浏览器交互检查：延迟首次加载时返回全景、取消 4,096 CTA 仿真后切换运行、搜索/清空、请求高亮、SM 光点选择与组件规格、单步与回退、两份运行的工作区导出恢复、FlashGPU 观测点筛选，以及正常 WASM、屏蔽 WASM 与 `/GPU-sim/` 子路径部署。均无页面脚本错误；屏蔽 WASM 后 JavaScript 索引仍可播放并重新运行 SM。两个 traffic 样例全部 10,093 个事件边界的新旧包计数一致。
