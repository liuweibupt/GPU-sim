# SM89 GEMM evidence pilot

This is a **this-session assistant-authored pilot with an experiment-specified,
deliberately injected tail-write bug**. It is not a naturally occurring error from a frozen AI generation
system, a public-project bug, a user study, or evidence for SM100/TMA/tcgen05/TMEM.

The supported operator is contiguous row-major FP32 `A[M,K] @ B[K,N] -> C[M,N]`,
for positive sizes. There is no batching, transpose flag, arbitrary stride, or
backward implementation. The kernels use ordinary FP32 instructions:

- `gemm_baseline`: one thread per output, guarded scalar dot product.
- `gemm_tiled`: conventional synchronous 16-by-16 shared-memory reuse, selected
  after baseline profiling identified high load/store request pressure.
- `gemm_tail_bug`: deliberately drops incomplete output tiles. Its accesses remain
  in bounds; missing outputs retain an explicitly initialized NaN sentinel.
- `cublas`: separate SGEMM reference with `CUBLAS_PEDANTIC_MATH` and
  `CUBLAS_ATOMICS_NOT_ALLOWED`. Row-major arrays are passed as column-major
  `C^T = B^T A^T` without conversion. It is not a TF32 comparison.

The independent CPU reference multiplies the actual FP32 input values in double
precision and accumulates in double. Each output must satisfy
`abs(actual-reference) <= 2e-5 + 2e-4*abs(reference)` and must be finite. Inputs use
a fixed xorshift32 generator with exact binary scaling, with seeds 20261023 and
20261024. `input_hash` is a reproducibility fingerprint of the generated words,
not a cryptographic guarantee. Shape order in every record is **M, N, K**.

## Run

The script uses the installed CUDA 12.6 compiler/runtime and cuBLAS, CUDA 13.1's
Nsight Compute / Compute Sanitizer 2025.4.1, and `nsys` from PATH. These absolute
paths are deliberate for the inspected machine; adapt and record them when
moving to another machine. No PyTorch/Triton installation is required.

```bash
python3 tools/research/cuda/run_pilot.py
python3 tools/research/cuda/run_pilot.py --library-only
python3 tools/research/cuda/run_mlp_pilot.py
```

Each command creates a new `out/research/cuda/<UTC timestamp>/` and refuses an
existing directory. Source and runner snapshots, binary/source hashes, commands,
exit codes, logs, tool versions, device identity, and GPU-state checks are retained.
`--baseline-only` runs the initial baseline verification/profile probe.

The guard waits at most about eight seconds for three consecutive readings with
GPU utilization at most 5%, at least 512 MiB free, and no other CUDA process. It
stops instead of launching when that condition is not met. It never terminates
other processes or changes clocks. A new process can still appear after a check:
this is an idle window on a shared host, **not a reserved exclusive GPU**. A stopped
run remains a stopped run; use a fresh directory once the resource is available.

The main run checks 12 shapes (including 17-by-19 output and non-divisible K) and
two seeds per candidate. It attempts Nsight Systems before target-only Nsight
Compute, then runs memcheck, racecheck, initcheck, and synccheck on a small odd
shape. Tool failure logs are preserved; software installation is not confused
with successful collection. `nsys` uses a run-local TMPDIR to avoid a shared
`/tmp/nvidia` permission problem observed in the initial probe.

## Timings and evidence boundaries

Verification and profiling run separately from native timing. Each benchmark
first independently verifies both candidates, warms up each for 30 launches,
then records 30 balanced, deterministically shuffled AB/BA pairs, with 30
launches per CUDA-event interval. The reported sample is interval duration divided
by the number of launches. Inputs remain resident and repeat; this is a warm-cache
kernel invocation scope, excluding allocations, input copies, CPU reference, and
application integration. Tiny intervals can include host submission gaps.

Raw pairs are retained. The ratio is `mean(A_ms)/mean(B_ms)`, with a paired
bootstrap percentile interval (2,000 resamples, fixed seed). The initial experiment
compares baseline to tiled; the separate library experiment compares tiled to
cuBLAS. Ratios from these separate executions should not be multiplied into an
unmeasured direct comparison. No timing for a numerically failed candidate is
reported as a usable speedup. A naive-to-tiled improvement does not establish a
competitive GEMM implementation.

Profiler replay times/counters are distinct from native timing samples. Counter
changes support a mechanism hypothesis, not a unique causal proof. The pilot does
not measure model-level speedup, all numerical domains, low precision, training,
or complete correctness over schedules. Four clean sanitizer reports cannot
establish that output values or coverage are correct.

## JSON contract for the parent experiment

`summary.json.verification[]` includes `shape_mnk`, `seed`, `candidate`,
`input_hash`, and `verdict`:

- `pass`, `violations`, `elements`, `nonfinite`, `max_abs_finite`, `relative_l2`.
- Up to 12 `error_samples` with `row`, `col`, `reference`, `actual`, `abs_error`,
  and `nonfinite`.
- For at most 400 output elements, complete nested row-major `reference_matrix`,
  `actual_matrix`, `abs_error_matrix`, and boolean `violation_matrix`.

Non-finite outputs/errors are JSON `null`; they must not be interpreted as zero.
`relative_l2` is also null if any output is non-finite. `max_abs_finite` only covers
finite outputs. The 17-by-19 tail-bug case is expected to expose 67 missing outputs;
this is an authored expectation, to be compared with the actual run.

`summary.json.benchmark[]` contains `correctness_gates`, launch/warmup counts,
`samples[]` with pair index/order and named candidate milliseconds, and statistics.
`status`, `profiles[]`, `sanitizers[]`, retained command exits and their logs must
be consulted before labeling a run complete. The summary is a report of measured
checks, not a claim of formal verification or a human-understanding result.

## Separate two-layer MLP follow-up

`mlp_pilot.cu` reuses the same GEMM kernels and strict cuBLAS mode in a **bias-free,
unfused `ReLU(X W1) W2` block**, with B=16/64/128, I=128, H=256, O=128. It is an
executable AI computation block authored for this experiment, not an integration
into an upstream trained model. It does not establish full-model or request speedup.

The CPU oracle computes the first GEMM in double, explicitly rounds the intermediate
to FP32, applies ReLU, then computes the second GEMM in double. Before running,
the tolerance is fixed at `3e-4 + 3e-4*abs(reference)` for inputs/weights in [-1,1).
Each of three candidates is checked at two seeds and all three batch sizes.
Each benchmark covers both GEMMs and the intervening ReLU, using separate kernels
on one stream with resident inputs. Input copies, allocations and compilation are
excluded. Warmup, 30 shuffled balanced AB/BA pairs, 30 block invocations per sample,
and the guarded shared-device checks match the GEMM protocol. There is no claim
that the block is fused or that its bottleneck was independently established.

The MLP runner creates its own `out/research/cuda/<timestamp>-mlp/summary.json`,
with shape order `shape_biho`, independent command/source/binary identities, and
complete raw paired timings. It does not overwrite either GEMM experiment.

Some frozen earlier run summaries say “human-specified” for the injected tail bug.
That wording was imprecise: the concrete bug was specified by this session's
experiment design, not by the user. Original records are retained; this note
corrects the attribution without presenting the bug as a natural AI failure.
