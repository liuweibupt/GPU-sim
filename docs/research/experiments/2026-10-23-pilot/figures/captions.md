# Pilot figure captions

**Numerical-check map.** Each cell is one measured output element for the fixed 17×19×23 GEMM and seed 20261023. Red indicates a tolerance failure or nonfinite output against an independent CPU double-precision reference; gray indicates a pass. The tail-write fault was deliberately injected. This plot shows failure locations, not error magnitudes or a GPU memory-race trace.

**Tiling performance.** Every tested timing configuration is shown. Diamonds are naive/tiled ratios of mean times over 30 randomized balanced AB/BA sample pairs, each containing 30 launches after warmup. Lines are the recorded 95% paired bootstrap intervals. Values below one are regressions. Timing uses CUDA events with repeated resident inputs and excludes transfers and compilation; intervals describe this session, not other devices or applications. The comparator is an experiment-authored naive kernel, not an optimized library. No user-study result is implied.

**Library comparison (when supplied).** Squares are tiled/cuBLAS ratios of paired means, so values above one favor cuBLAS. The library uses SGEMM with CUBLAS_PEDANTIC_MATH and CUBLAS_ATOMICS_NOT_ALLOWED; all candidates pass the same finite numerical checks. Every library timing configuration is shown with its within-session paired bootstrap interval.
