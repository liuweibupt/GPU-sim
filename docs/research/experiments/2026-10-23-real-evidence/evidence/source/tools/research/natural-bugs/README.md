# Public compiler/library regression evidence

These experiments reproduce upstream defects without injecting a substitute bug.
Parameter points and repeated runs are not independent root causes. The numerical
oracles do not establish general diagnostic coverage or human benefit.

## CUTLASS zero-K grouped GEMM

`cutlass_build_pair.py` reads a local upstream Git repository without changing it.
It extracts pinned 4.1/4.2 trees and builds example **68**, which implements grouped
GEMM in both releases. Issue #2547 names example 67. The example receives a
host-only observation patch: preserve full observed/reference/C output bytes,
check K=0 independently as `beta*C`, and run each host-shape mode in its own
process. The underlying kernels are unchanged.

```bash
python3 tools/research/natural-bugs/cutlass_build_pair.py \
  --repo /path/to/cutlass --output out/research/cutlass-build
python3 tools/research/natural-bugs/cutlass_backport.py \
  --build out/research/cutlass-build --output out/research/cutlass-backport
```

Execute `cutlass_run_repro.py` on an SM90 GPU with those binaries. The archived
Modal job specifies the exact argv and file hashes. It freezes six input families
before execution: positive control, zero first/middle/last, all zero, and the
original 32 K splits with M=N reduced to 128. Both host-shape modes and beta=0/1
run in fresh processes with a ten-second deadline. Four additional 4.2 memcheck
cases are separate from ordinary runs. `--before-label backport --betas 0` tests
the same 4.1 build with only the three upstream empty-K guards backported.

```bash
python3 tools/research/natural-bugs/cutlass_verify.py \
  --input out/research/modal/RUN/artifacts/matrix --output out/research/verification.json
```

The verifier rehashes every saved per-case artifact, decodes all FP8 E4M3 outputs,
and independently checks K=0. Positive-K reference computation remains upstream
CUTLASS CPU code. Do not describe it as an independently implemented GEMM oracle.
The three-guard intervention isolates a small repair region but is not an
ablation proving each guard necessary. The old beta=1 positive-control failure
is a separate confounder; a K=0 timeout is not evidence of an observed descriptor
error or a sampled instruction-level wait. Host-only binary bytes are omitted
from the public archive; source trees, patches, compiler commands and hashes bind
the actual local build to uploaded and executed files.

## Triton selected TMEM descriptor lifetime

`triton_build_pair.py` builds the exact fix and its parent from pinned source
archives, with a bounded parallel build and upstream-pinned dependencies.
`tmem_finalize_build.py` checks that the source difference contains only the
allocation pass and its regression test, then hashes the wheel and native
compiler members. `tmem_upstream_regression.py` preserves the public author's
16-case function and decorators verbatim; its manifest identifies source/license.

`tmem_run_repro.py` requires an SM100 GPU and verifies the installed native
compiler against the build manifest. It observes host output allocations and
already-compiled artifacts without changing the kernel, launch or assertions.
Selected outputs have an independent constant 3/5 oracle and the temporary
output has a constant 7 oracle. Unused temporary storage is excluded when its
column count is zero. CPU lit tests and GPU runtime tests remain separate.

`tmem_compare_repro.py` rechecks the complete 16-case matrix and full retained
outputs in both versions, including generated-code hashes. Compressed device
cubins are deliberately retained as compiler evidence; host compiler wheels and
executables are represented by hashes and reproducible source/build records.
The wheel's actual bundled PTXAS version may differ from the Modal CUDA image's
NVCC version; record both, rather than inferring assembler identity from the
container tag.
