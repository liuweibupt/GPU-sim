# Acquisition and analysis cost experiments

These experiments measure the current bounded prototype. They do not estimate overhead for a production AI model or a generic GPU recorder.

Full Nsight containers can retain process metadata, including inherited environment values. They are **never publication artifacts**. `run-version-cost.py` now invokes profiler tools with an explicit environment allowlist and `--inherit-environment=false`; `profile-cost-safe.py` independently reruns only the short profile using the already measured executable. It exports specified numeric CUDA kernel/API/memcpy columns plus only referenced function names. `report-costs.py --profile ...` publishes those rows, omits every complete `.nsys-rep`/SQLite container with an original-hash receipt, and scans original files and nested gzip content against current sensitive environment values. No matching value or snippet is printed. The original 720 samples remain byte-for-byte unchanged; new profile figures are explicitly a separate run.

## SM89 acquisition

`prepare-version-kernel.py` accepts only the SHA-pinned, unchanged `../cuda/version_probe.cu`. It derives two compile-time instantiations from the same source. Both retain the payload computation, initial values, value output, 64-thread CTA layout and all three source barriers. The baseline removes auxiliary shared tags, output tags and five event writes per CTA/generation. This measures their **combined** overhead, including compiler consequences, not event-store cost alone. All allocations occur outside timing; identical device/pinned-host buffers are allocated for both modes.

```sh
python3 tools/research/costs/run-version-cost.py \
  --output out/research/costs/version-RUN --compile-only
# Only after obtaining the coordinated GPU slot:
python3 tools/research/costs/run-version-cost.py \
  --output out/research/costs/version-RUN --resume --nsys
```

The default run uses three independent processes, 20 warmups per mode/shape/process and 30 random-order pairs per shape/process. Within a pair, shape, seed, output values and launch dimensions match. Shapes are `(count,generations) = (32,1), (257,5), (4096,8), (4096,64)`. Every sampled value/tag/event is checked outside timed regions. Full preflight payloads from every session undergo a separate Python integer oracle.

The Nsight Systems run precedes and is excluded from unprofiled sampling. Each unprofiled row retains six timing measurements: CUDA-event kernel span, output D2H event span and host elapsed time, extra evidence D2H event span and host elapsed time, and CPU JSON serialization. The kernel is inside a CUDA graph with explicit start-event → kernel → stop-event nodes. One graph submission eliminates host API submission gaps between these markers. Graph construction and per-sample seed updates occur outside the event interval. Allocation, validation and disk I/O are excluded. D2H uses pinned buffers; its direct-call event intervals can include submission gaps and are not claimed as pure DMA duration. Serialization writes a compact capture schema containing values, tags and event fields; it excludes duplicated reference arrays from the old diagnostic CLI.

The earlier direct-call measurement in `version-20261023-v3` exposed stream idle gaps and even an apparent negative overhead; it is retained as a rejected timing method, not a device speedup. The final graph measurement still includes event/graph scheduling and timer quantization. Inspect the separate Nsight Systems hardware kernel durations before attributing the entire span to device instructions. Keep raw paired deltas, ratios and per-session medians; do not assume overhead is small. Clocks are not locked. This is an SM89 scalar/shared-memory experiment, not TMA or tcgen05 acquisition cost. See NVIDIA's [graph event-record API](https://docs.nvidia.com/cuda/cuda-runtime-api/group__CUDART__GRAPH.html) and [event timing API](https://docs.nvidia.com/cuda/cuda-runtime-api/group__CUDART__EVENT.html).

## CPU analysis

```sh
node tools/research/costs/analysis-cost.mjs prepare out/research/costs/cpu-inputs-RUN \
  tma=out/research/tma-protocol/20261023-v1 \
  tcgen05=out/research/tcgen05-protocol/20261023-v2
node tools/research/costs/analysis-cost.mjs run \
  out/research/costs/cpu-inputs-RUN out/research/costs/cpu-RUN 3 5 10 84
```

Preparation verifies the compressed and uncompressed hashes of all 216 TMA and 36 tcgen05 results, extracts their exact capture objects and recomputes the stored protocol outputs. It saves source snapshots and a manifest connecting each compact capture back to the original result. The measured pipeline begins at those compact captures; raw hardware decoding, independent numeric oracles, semantic mapping and archive inflation are outside this cost scope.

Each fresh Node process uses a random capture order, five warmups and ten measured samples per capture (30 total across three sessions). Separate timers measure synchronous warm-cache file read, JSON decoding/parsing, `checkProtocol`, one complete evidence slice, run serialization and slice serialization. Query rotation covers the first value, first producer completion and last storage reuse obligation when present. Each result and slice is checked against its prepared SHA outside timing. All complete run witnesses remain; the benchmark never concatenates all slices into one huge string.

Record CPU affinity, system load, process RSS and raw samples. Affinity does not isolate shared cache, memory bandwidth or NUMA effects. Natural allocation/GC pauses remain in measured distributions. RSS is process-level, not per-operation memory attribution. These are warm-cache descriptive results, not cold-storage throughput or a claim that large-trace scalability is solved.
