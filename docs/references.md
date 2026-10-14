# 参考文献与项目来源

元数据与链接核查日期：2026-10-14。可复用条目见 [references.bib](references.bib)。论文作者信息来自作者提交的 arXiv、作者项目页/仓库或原始论文；正式出版的 DOI、卷期与页码另与出版者登记元数据核对。以下区分实际依赖、设计参考和调研来源；引用不表示原作者参与或认可本项目。

## 当前实际使用

**GTSim / GPU-Tile-Sim 是当前可选时序后端。** Adapter 编译固定 commit [`45a996c1585e60e98194057d94f7e664d41150ba`](https://github.com/SJTU-ReArch-Group/GTSim/tree/45a996c1585e60e98194057d94f7e664d41150ba) 的 core 与原始 H100 GEMM builder，读取原生节点时间与依赖。项目中的 observer 和 viewer 自行实现；GTSim 原始源码未 vendored 进本仓库。其公开 v0.1.0 范围与论文完整系统分别依据 [release scope](https://github.com/SJTU-ReArch-Group/GTSim/blob/45a996c1585e60e98194057d94f7e664d41150ba/docs/release-scope.md) 和下述论文描述。

学术引用使用 `ding2026gputilesim`，代码版本引用使用 `gtsim2026software`。MIT 版权通知及实际使用说明见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)，下载地址与 archive hash 见 [upstream.json](../tools/gtsim/upstream.json)。学术引用与许可通知分别保留。

## 代码分析与交互设计参考

- **Gem5SimCity**：Entropy-xcy 与项目贡献者；固定核查 commit [`6c7e0b4ab7ed7b58fdb70527d9ee182db1956483`](https://github.com/Entropy-xcy/Gem5SimCity/tree/6c7e0b4ab7ed7b58fdb70527d9ee182db1956483)。直接启发 simulator → trace → 可单步回放的第一阶段形态。当前未复制其源码、trace 或资产，也未把 gem5 接作 GPU 后端。BibTeX：`entropy2026gem5simcity`；检查过程和限制见 [参考核查](research/gem5-simcity.md)。
- **Daisen / Akita**：Yifan Sun、Yixuan Zhang、Ali Mosallaei、Michael D. Shah、Cody Dunne、David Kaeli 及项目贡献者。任务、组件、时间与依赖联动的研究和交互参考；当前未集成其代码。引用论文 `sun2021daisen`；参见 [作者项目页](https://vis.khoury.northeastern.edu/pubs/Sun2021DaisenFrameworkVisualizing/) 与 [当前 Daisen 模块](https://github.com/sarchlab/akita/tree/main/daisen)。

以上属于代码分析或设计借鉴，区别于复制、修改或分发第三方实现。后续若直接复用实现或数据，需同步记录实际文件、固定版本与对应通知。

## 主要论文

1. **Yitong Ding, Jiawei Huang, Renyang Guan, Yangjie Zhou, Zihan Liu, Yu Feng, Shixuan Sun, Mingyi Guo, Jingwen Leng, Jian Weng.** *GPU-Tile-Sim: A Tile-Centric GPU Simulation Framework for LLM Hardware-Software Co-Design.* 2026，arXiv:2607.11262。作者页面注明 accepted to MICRO 2026；本仓库按已核实的预印本记录，不编造 proceedings 页码或 DOI。用于当前后端的学术归属。[arXiv](https://arxiv.org/abs/2607.11262)、[arXiv DOI](https://doi.org/10.48550/arXiv.2607.11262)。键：`ding2026gputilesim`。

2. **Siying Yu, Yixun Hong, Guozhi Qiu, Jingci Liu, Feng Gu, Chenbo Geng, Zhengrong Wang, Chen Zhang, Bei Yu.** *FlashGPU-sim: Enabling GPU Modeling for Modern Architectures and AI Workloads.* 2026，arXiv:2609.15311。作者页面注明 to appear in MICRO 2026；本仓库按预印本记录。核查日页面将其 arXiv DOI 标为 pending registration，因此 BibTeX 保留稳定的 arXiv URL。仅为相关工作及后续 adapter 调研。[arXiv](https://arxiv.org/abs/2609.15311)、[官方代码](https://github.com/FlashGPU-Sim/FlashGPU-Sim)。键：`yu2026flashgpusim`。

3. **Junrui Pan, Weili An, Cesar Avalos Baddouh, Christin David Bose, Ni Kang, Aaron Barnes, Ahmad Alawneh, Fangjia Shen, Yechen Liu, Anusuya Nallathambi, Atthin Chandrashekar, Timothy G. Rogers.** *Architecting the Next Generation of Asynchronous, Distributed GPUs for the AI Era.* 2026，arXiv:2608.22602。Accel-Sim 项目将其列为 2.0 基础引用；未核实到正式会议出版信息，按预印本记录。仅为相关工作及后续后端调研。[arXiv](https://arxiv.org/abs/2608.22602)、[arXiv DOI](https://doi.org/10.48550/arXiv.2608.22602)、[项目 citation metadata](https://github.com/accel-sim/accel-sim-framework/blob/dev/CITATION.bib)。键：`pan2026asynchronousgpus`。

4. **Mahmoud Khairy, Zhesheng Shen, Tor M. Aamodt, Timothy G. Rogers.** *Accel-Sim: An Extensible Simulation Framework for Validated GPU Modeling.* ISCA 2020，473–486。DOI：10.1109/ISCA45697.2020.00047。作为原始框架与方法的相关工作，区别于 2026 年 2.0 预印本。[IEEE 出版页](https://ieeexplore.ieee.org/document/9138922)、[DOI](https://doi.org/10.1109/ISCA45697.2020.00047)、[官方引用说明](https://accel-sim.github.io/)。键：`khairy2020accelsim`。

5. **Yifan Sun, Yixuan Zhang, Ali Mosallaei, Michael D. Shah, Cody Dunne, David Kaeli.** *Daisen: A Framework for Visualizing Detailed GPU Execution.* Computer Graphics Forum，40(3)，239–250，2021；EuroVis 2021。DOI：10.1111/cgf.14303。使用已核实的正式期刊条目，同时保留 arXiv:2104.00828 预印本入口。[作者项目页](https://vis.khoury.northeastern.edu/pubs/Sun2021DaisenFrameworkVisualizing/)、[DOI](https://doi.org/10.1111/cgf.14303)、[arXiv](https://arxiv.org/abs/2104.00828)。键：`sun2021daisen`。

6. **Aaron Ariel, Wilson W. L. Fung, Andrew E. Turner, Tor M. Aamodt.** *Visualizing Complex Dynamics in Many-Core Accelerator Architectures.* ISPASS 2010，164–174。DOI：10.1109/ISPASS.2010.5452029。AerialVision 原始论文；用于时间、组件指标与源码联动的相关工作分析。[作者论文 PDF](https://people.ece.ubc.ca/aamodt/papers/aerialvision.ispass2010.pdf)、[DOI](https://doi.org/10.1109/ISPASS.2010.5452029)、[官方手册与引用说明](https://gpgpu-sim.org/manual/index.php/AerialVision_Manual)。键：`ariel2010aerialvision`。

7. **Ali Bakhoda, George L. Yuan, Wilson W. L. Fung, Henry Wong, Tor M. Aamodt.** *Analyzing CUDA Workloads Using a Detailed GPU Simulator.* ISPASS 2009，163–174。DOI：10.1109/ISPASS.2009.4919648。GPGPU-Sim 基础论文；当前未将该后端编入本原型。[作者论文 PDF](https://people.ece.ubc.ca/aamodt/papers/gpgpusim.ispass09.pdf)、[作者机构出版记录](https://www.microsoft.com/en-us/research/publication/analyzing-cuda-workloads-using-detailed-gpu-simulator/)、[DOI](https://doi.org/10.1109/ISPASS.2009.4919648)。键：`bakhoda2009gpgpusim`。

8. **Yifan Sun 等 18 位作者。** *MGPUSim: Enabling Multi-GPU Performance Modeling and Optimization.* ISCA 2019，197–209。DOI：10.1145/3307650.3322230。完整作者列表保留在 BibTeX；用于 AMD、多 GPU 与组件化 trace 的相关工作分析，当前未接入其执行后端。[官方仓库与原作者 BibTeX](https://github.com/sarchlab/mgpusim#citation)、[作者论文 PDF](https://people.bu.edu/joshi/files/mgpusim-isca2019.pdf)、[DOI](https://doi.org/10.1145/3307650.3322230)。键：`sun2019mgpusim`。

9. **Jason Lowe-Power 等 78 位作者。** *The gem5 Simulator: Version 20.0+.* 2020，arXiv:2007.03152v2。完整作者列表保留在 BibTeX。gem5 官方出版页列作 CoRR 2020，故不将其写成正式会议或与 2011 年原始 gem5 论文混淆。它说明 Gem5SimCity 所用模拟基础；gem5 当前不是本项目 runtime dependency。[arXiv](https://arxiv.org/abs/2007.03152)、[官方出版与引用页](https://www.gem5.org/publications/)、[arXiv DOI](https://doi.org/10.48550/arXiv.2007.03152)。键：`lowepower2020gem5`。

## 格式与工具来源

**NoC 建模方法参考：** Zhixian Jin, Christopher Rocca, Jiho Kim, Hans Kasan, Minsoo Rhu, Ali Bakhoda, Tor M. Aamodt, John Kim. *Uncovering Real GPU NoC Characteristics: Implications on Interconnect Architecture.* MICRO 2024, pp. 885–898. DOI: 10.1109/MICRO61859.2024.00070。[作者公开论文](https://people.ece.ubc.ca/aamodt/publications/papers/realgpu-noc.micro2024.pdf)、[机构出版记录](https://pure.kaist.ac.kr/en/publications/uncovering-real-gpu-noc-characteristics-implications-on-interconn/)、[DOI](https://doi.org/10.1109/MICRO61859.2024.00070)。键：`jin2024realgpunoc`。该研究用于约束延迟/吞吐分离、分区与局部性、带宽层级的建模；本项目没有复现实测 H100 矩阵或使用其 simulator 代码。[逐项核查](research/gpu-noc.md)

**NoC 公开结构参考：** NVIDIA. *NVIDIA H100 Tensor Core GPU Architecture*, v1.04，[官方白皮书](https://resources.nvidia.com/en-us-hopper-architecture/nvidia-h100-tensor-c)。L2 一节明确 partitioned crossbar 与局部缓存。键：`nvidia_h100_whitepaper`；本项目的双分区编号、聚合节点与时序参数仍为教学选择。

SM 形式化规格与自研教学模型采用以下 NVIDIA 一手资料；它们是公开结构与 ISA 语义的来源，不提供本项目的 Fetch/Decode/Issue 周期参数，也不验证真实芯片周期准确性。图由本仓库原生 SVG 重新绘制，未捆绑官方架构图片。

- Michael Andersch, Greg Palmer, Ronny Krashinsky, Nick Stam, Vishal Mehta, Gonzalo Brito, Sridhar Ramaswamy. **NVIDIA Hopper Architecture In-Depth.** NVIDIA Technical Blog, 2022-03-22。SM 图、四分区、FP32/FP64/INT32/Tensor 数量及 H100 SXM 配置。[官方文章](https://developer.nvidia.com/blog/nvidia-hopper-architecture-in-depth/)。BibTeX：`nvidia2022hopper`。
- NVIDIA. **Hopper Tuning Guide, CUDA 13.0.3.** RF、驻留 warp/CTA、L1/SMEM 容量与 carveout、TMA 及 cluster 公开能力。[固定版本官方文档](https://docs.nvidia.com/cuda/archive/13.0.3/hopper-tuning-guide/index.html)。BibTeX：`nvidia2025hoppertuning`。
- NVIDIA. **Parallel Thread Execution ISA, CUDA 12.8.1.** 寄存器/存储空间、`cp.async.bulk`、`mbarrier` 和 WGMMA 的语义。教学 demo 使用单 warp MMA，尚未实现真实 WGMMA warpgroup。[固定版本官方文档](https://docs.nvidia.com/cuda/archive/12.8.1/parallel-thread-execution/index.html)。BibTeX：`nvidia2025ptx`。

Chrome/PyTorch duration JSON importer 为本项目自行实现，保留 X 与配对 B/E 区间，不根据 correlation ID 构造内部 GPU 因果。格式依据 [Chromium Trace Event Format 入口](https://chromium.googlesource.com/catapult/+/HEAD/docs/trace-event-format.md)、[Perfetto 支持的其他格式](https://perfetto.dev/docs/getting-started/other-formats) 与 [PyTorch/Kineto 官方 JSON writer](https://github.com/pytorch/kineto/blob/main/libkineto/src/output_json.cpp)。这些来源不表示本项目捆绑其代码库或 SDK。

Nsight、RGP、游戏及其他教学项目的具体事实继续在 [可视化调研](research/visualization.md)、[仿真器调研](research/simulators.md)、[游戏调研](research/games.md) 和 [Gem5SimCity 核查](research/gem5-simcity.md) 的相应段落直接引用官方来源。上述 BibTeX 集合只收录当前关键基础论文和两个固定版本的代码条目。
