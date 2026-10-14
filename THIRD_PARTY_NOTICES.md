# Third-party notices

The optional GTSim adapter downloads **[GTSim v0.1.0](https://github.com/SJTU-ReArch-Group/GTSim)** at commit
`45a996c1585e60e98194057d94f7e664d41150ba`. Its original source is not vendored
in this repository. The committed example traces are outputs of its hand-written
H100 GEMM timing graph, with a read-only observer authored for this project.

The adapter preserves the unmodified upstream timing implementation and original
tests. Compiling the GEMM builder renames only its `main` entry-point symbol.
GTSim's license, reproduced from that revision, is:

```text
MIT License

Copyright (c) 2026 Jiawei Huang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

When referring to the simulator, cite Yitong Ding, Jiawei Huang, and their
coauthors' paper, [*GPU-Tile-Sim: A Tile-Centric GPU Simulation Framework for LLM
Hardware-Software Co-Design*](https://arxiv.org/abs/2607.11262), 2026
(authors note acceptance to MICRO 2026). The public v0.1.0
[release scope](https://github.com/SJTU-ReArch-Group/GTSim/blob/main/docs/release-scope.md)
is narrower than the paper.

The repository does not vendor other simulators, visualization projects, or game
code/assets. Project and design acknowledgements are maintained in
[README.md](README.md); research citations are in [references.md](docs/references.md)
and [references.bib](docs/references.bib). These citations do not replace license
notices for any future code, data, or asset reuse.

The detailed log adapter is independently authored against the documented
FlashGPU-Sim runtime output grammar at revision
[`291fbe172332eb481556632a79eb9cfc93cf46bf`](https://github.com/FlashGPU-Sim/FlashGPU-Sim/tree/291fbe172332eb481556632a79eb9cfc93cf46bf).
No FlashGPU-Sim source, executable, or simulation output is redistributed here.
The format sources and limitations are recorded in
[the adapter guide](tools/detailed/README.md). Accel-Sim 2.0 remains a candidate
execution backend requiring an output observer; raw SASS inputs are not imported
as simulated instruction timings.

The six component PNGs under `web/assets/gpu/` were generated for this project
with the built-in image generation tool on 2026-10-14. They are conceptual
hardware artwork, not copied game assets, vendor logos, or measured floorplans.
Generation prompts and their role are recorded in
[the asset manifest](web/assets/gpu/manifest.json).
