# Source-bound SM100 `tcgen05` experiment

This probe runs a real single-CTA `tcgen05.mma` GEMM on SM100, reads its FP32
accumulator from TMEM, and records observations after successful asynchronous
completion waits. It is an authored experiment, not an optimized operator or a
naturally occurring AI-generated bug.

## Operator and controlled comparison

The supported operator is fixed: `D[128,32] = A[128,16] × B[32,16]ᵀ`, with FP16
inputs, FP32 accumulation, contiguous global inputs, and exact small-integer
values. A single 128-thread CTA allocates 32 TMEM columns. There is no TMA,
multi-CTA cluster, variable shape, or overlapped performance experiment.

| Variant | Input selection | Intended outcome |
|---|---|---|
| `correct` | Requested generation | Exact requested output |
| `wrong-version` | Two generations older | Legal computation and synchronization, incorrect requested value |
| `fixed` | Starts from the same old candidate; checks the full tag and selects the requested input | Exact requested output |

The old generation has the same parity as the requested one. Full generation
tags are `uint64_t` values written as decimal JSON strings, including values
above JavaScript's exact-integer range. The suite uses generation bases `0`,
`2^53`, and `2^64−128`. Barrier generation is a separate software loop ordinal;
its parity bit is never treated as the full data generation.

## What is observed and what is derived

- The selected input tag is actually loaded from device global `input_tags`.
  Its association with the selected A matrix follows the pinned source contract.
  **This tag is not read from TMEM and is not hardware-reported provenance.**
- Every thread waits for the full `tcgen05.commit` completion using a successful
  acquire `mbarrier.try_wait`. Four warp leaders log records after success. The
  restricted A-side shared-read completion facet is not used.
- Each warp collectively loads 32 columns using `tcgen05.ld.32x32b.x1` and
  `tcgen05.wait::ld`. Every output element is saved. Warp leaders record their
  actual first-column register value after these loads.
- The four runtime reader records describe representative threads. Full-resource
  reader completion is a **derived** boundary at the uniform 128-thread CTA
  barrier after all readers' `wait::ld` and fences. A leader's record alone does
  not prove that the full TMEM allocation is safe to reuse.
- Allocation base/column count and the returned deallocation flag are recorded.
  Read-begin, MMA-issue, deallocation-issue and all-reader barrier boundaries are
  source-derived points, explicitly distinguished from runtime records.

The bridge checks requested-value generation separately from completion of the
actually selected result. Therefore the controlled old result can violate its
value requirement while satisfying completion and safe-reuse requirements.
Clocks and event-array indices do not establish cross-warp ordering.

## Reproduce

On an already allocated SM100 GPU with CUDA 13.1:

```bash
python3 tools/research/cuda/tcgen05_run_probe.py \
  --output out/research/tcgen05/<new-run> --cuda-root /usr/local/cuda
```

The default suite runs 36 cases: iteration counts `1,2,5,17`, three seed/base
pairs, and the three variants. It also runs `memcheck`, `racecheck`, `initcheck`
and `synccheck` on all three variants. Raw stdout/stderr, sanitizer logs, source
snapshots, PTX, SASS, executable hash, commands, and all output values are kept.
The runner does not provision a GPU. Command wall time is not a GPU benchmark.

For compilation only on a machine without SM100:

```bash
python3 tools/research/cuda/tcgen05_run_probe.py \
  --output out/research/tcgen05/<new-compile> \
  --cuda-root /usr/local/cuda-13.1 --compile-only
```

The standalone executable accepts:

```text
tcgen05_probe ITERATIONS SEED correct|wrong-version|fixed [GENERATION_BASE]
```

Exit `0` means requested values match, `2` means the controlled version/value
mismatch, and `1` means an operational or selected-source numerical failure.
Each command has a 120-second outer timeout and a bounded device wait watchdog.

Independent CPU checks:

```bash
python3 tools/research/cuda/tcgen05_validate.py <raw.stdout.txt> --source <snapshot.cu>
python3 -m unittest discover -s tools/research/cuda -p tcgen05_validate_test.py -v
node --test tests/research-tcgen05-bridge.test.mjs
```

Protocol bridge for a Modal-returned suite:

```bash
node tools/research/bridge-tcgen05-probe.mjs \
  --input <modal-run>/artifacts/tcgen05-suite \
  --modal-root <modal-run> --output <new-bridge-output>
```

The bridge rechecks raw/artifact/source hashes and the independent CPU reference.
An omitted remote ELF is bound to matching hashes and byte counts in both
manifests; its bytes are not claimed to have been rehashed locally. Bridge
results and interface ablations are stored as lossless gzip files with compressed
and uncompressed hashes. Every slice is verified in memory; its exact byte count
and SHA are retained along with the complete source run needed to regenerate it.
This avoids storing the same large graph repeatedly for correlated queries.

## Evidence limits

The fixed-source association is a deliberately available observation interface.
It does not establish that arbitrary traces contain enough information to
recover value provenance. Masking selected-input provenance, successful
completion tokens, or HB edges yields `unknown` in the corresponding protocol
queries; these are offline interface ablations, not new hardware failures.

Sanitizer results concern the executed instrumentation and supported tool
checks. A clean sanitizer result does not establish application-level version
correctness. Repeated generations and four warp observations are correlated,
not independent bug samples. No operator speedup, AI debugging success rate, or
human comprehension effect is measured here.

## References used

The implementation uses NVIDIA CUDA Toolkit `<cuda/ptx>` wrappers and the
[official PTX tcgen05 specification](https://docs.nvidia.com/cuda/parallel-thread-execution/index.html#tcgen05-instructions).
Descriptor/layout and lifecycle were checked against the pinned NVIDIA CUTLASS
[minimal GEMM tutorial](https://github.com/NVIDIA/cutlass/blob/91843b71d90737e0a9b86f7d9df213cff5a3526f/examples/cute/tutorial/blackwell/01_mma_sm100.cu)
and [descriptor implementation](https://github.com/NVIDIA/cutlass/blob/91843b71d90737e0a9b86f7d9df213cff5a3526f/include/cute/arch/mma_sm100_desc.hpp).
The KernelWiki pages `hw-tcgen05-mma`, `hw-tmem` and `hw-mbarrier` were consulted
as secondary context; the official instruction syntax and synchronization rules
take precedence over their abbreviated or inconsistent pseudocode.
