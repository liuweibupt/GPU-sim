# GitHub Pages 发布

站点目标地址为 <https://liuweibupt.github.io/GPU-sim/>，入口自动转到 `web/`。首次启用前，地址可能返回 404；以 Actions 成功部署和实际 HTTP 检查为准。

## 静态构建

```bash
npm test
npm run validate
npm run build
```

构建无第三方 npm 依赖。`dist/` 仅包含 `web/`、`lib/`、`examples/*.json`、入口跳转和 `.nojekyll`，不发布仿真器源码、构建缓存或实验日志。原有目录层级与相对 URL 保留，因此部署到 `/GPU-sim/` 项目路径时，JS 模块、默认 trace 和图片仍可加载。`dist/` 已在 `.gitignore` 中；由 Actions 上传构建产物，无需将生成文件提交至主分支。

Worker 入口和已编译的 `lib/interval-query.wasm` 一同发布，C 源码不进入站点。正常构建无需 Clang；仅修改 WASM 源码时执行 `npm run build:wasm` 并提交二进制。WASM 加载失败时播放会使用 JavaScript 索引。[性能与复现方法](browser-performance.md)

GitHub Pages 只托管浏览器端静态应用。Trace 导入和工作区存档仍在用户浏览器中完成；它不会在服务器执行 CUDA 或启动仿真器。线上站点与 localhost 的浏览器存储属于不同 origin，需要通过工作区文件迁移存档。

## 首次启用

拥有仓库管理权限的账号在 [Settings → Pages](https://github.com/liuweibupt/GPU-sim/settings/pages) 的 **Build and deployment → Source** 中选择 **GitHub Actions**。然后推送 `main`，或在 [Deploy GPU city to GitHub Pages](https://github.com/liuweibupt/GPU-sim/actions/workflows/pages.yml) 点击 **Run workflow**。

使用已登录且具有仓库 Pages / Administration 写权限的 GitHub CLI，也可执行：

```bash
gh api --method POST repos/liuweibupt/GPU-sim/pages -f build_type=workflow
gh workflow run pages.yml --repo liuweibupt/GPU-sim --ref main
```

若站点已存在而采用其他构建方式，使用 `gh api --method PUT repos/liuweibupt/GPU-sim/pages -f build_type=workflow` 切换；不要在未知错误时盲目重试创建。工作流内置的 `GITHUB_TOKEN` 用于后续部署，不能首次启用 Pages；首次启用不需要把个人 token 保存到仓库 secrets。

每次 `main` 推送都先运行测试与 trace 校验，再构建并发布。部署 job 使用 `pages: write`、`id-token: write` 和 `github-pages` environment；构建 job 只有读取权限。并发发布按队列串行执行。

## 验证与限制

确认 Actions 的 build、deploy 均成功，且 `/GPU-sim/` 能进入工作台，默认示例、组件图、回放与图片能正常加载。API 可读取状态：

```bash
gh api repos/liuweibupt/GPU-sim/pages --jq '{status, html_url, build_type, https_enforced}'
gh run list --repo liuweibupt/GPU-sim --workflow pages.yml --limit 3
```

2026-10-14 首次核查时，仓库为 public、默认分支为 main、尚未开启 Pages；用户选择 GitHub Actions 后，公开仓库 metadata 已返回 `has_pages: true`。这说明 Pages 已启用，站点是否发布仍以 Actions 部署结果与实际 HTTP 检查为准。GitHub Free 支持公开仓库的 Pages；私有仓库需要支持 Pages 的付费方案。更改仓库可见性与发布网站是独立操作，本流程不会修改仓库可见性。

官方来源：[自定义 Pages 工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[Pages REST API 与权限](https://docs.github.com/en/rest/pages/pages)、[configure-pages 首次启用限制](https://github.com/actions/configure-pages/blob/v6.0.0/action.yml)。工作流的版本于 2026-10-14 按官方发布页核实：[checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1)、[setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0)、[configure-pages v6.0.0](https://github.com/actions/configure-pages/releases/tag/v6.0.0)、[upload-pages-artifact v5.0.0](https://github.com/actions/upload-pages-artifact/releases/tag/v5.0.0)、[deploy-pages v5.0.1](https://github.com/actions/deploy-pages/releases/tag/v5.0.1)。这些版本在 GitHub 托管 runner 上使用 Node.js 24 runtime。
