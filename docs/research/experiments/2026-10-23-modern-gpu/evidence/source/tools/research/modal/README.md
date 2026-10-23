# Bounded modern GPU evidence on Modal

These are executed numerical/semantic probes, not throughput benchmarks or naturally occurring AI bugs. The result archive is [`2026-10-23-modern-gpu`](../../../docs/research/experiments/2026-10-23-modern-gpu/report.md).

The runner uses one GPU, at most one container per ephemeral app, no retry, a bounded function timeout, and no persistent deployment, volume or endpoint. Modal credentials remain in the local SDK environment; only the explicitly listed source files are uploaded. Cloud scheduling can take longer than the function execution timeout. The recorded command wall time is not a bill or a GPU-kernel latency.

## Reproduce from the repository root

```bash
python3 -m venv out/research/modal-env
out/research/modal-env/bin/pip install -r tools/research/modal/requirements.txt
out/research/modal-env/bin/python tools/research/modal/run_gpu_evidence.py \
  --job tools/research/modal/jobs/b200-tma.json \
  --output out/research/modal/new-b200-tma --gpu B200 --timeout 420
out/research/modal-env/bin/python tools/research/modal/run_gpu_evidence.py \
  --job tools/research/modal/jobs/h100-tma.json \
  --output out/research/modal/new-h100-tma --gpu 'H100!' --timeout 420
out/research/modal-env/bin/python tools/research/modal/run_gpu_evidence.py \
  --job tools/research/modal/jobs/b200-tcgen05.json \
  --output out/research/modal/new-b200-tcgen05 --gpu B200 --timeout 360
```

Requires already authorized Modal credentials (for example SDK-supported `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET`). No credentials should be put in a job JSON or committed. Each output directory must be new. The pinned SDK includes its proxy support extra, needed on this host. CUDA image tag, resolved image ID, application ID, Python version, SDK version, source and runner hashes are recorded per job. Python in the image matches the local Python major/minor because the function is serialized.

- TMA: actual rank-2 tensor-map transfer of interleaved payload and generation; 108 cases per architecture, plus 9 representative sanitizer launches. Tail handling concerns valid consumer elements in padded tiles, not descriptor out-of-bounds fill. Correct, wrong-slot and repaired are one controlled fault family.
- tcgen05: one CTA, M128/N32/K16 FP16-to-FP32 GEMM, real TMEM allocation/MMA/full completion/loads/read completion/deallocation. 36 cases plus 12 representative sanitizer launches. The source generation is a device-loaded input tag, not a tag read from TMEM. All GEMM outputs are independently checked against the selected-source and requested-source integer references.
- The kernels are deliberately sequential instrumented probes. They do not establish production performance, a fused TMA→MMA pipeline, arbitrary PTX correctness, or natural fault prevalence.

Unexpected command exits or timeouts stop the remote job and retain available logs/artifacts. Controlled faults return exit 2; suite runners accept that only when independent output and event checks verify the declared fault. ELF bytes are omitted from returned artifacts; binary SHA-256 and size remain in remote manifests. Source/PTX/SASS/raw stdout are returned and locally rehashed. Do not describe this as local verification of an archived binary.

[Modal GPU types](https://modal.com/docs/guide/gpu): the `H100!` request prevents an automatic architecture upgrade; always retain the actual device identity. GPU use is metered. These scripts create short-lived Functions; their manifests do not infer exact cost.

## TMEM guardrail supplement

The normal suite uses its ordinary instrumented kernel build. The separate `jobs/b200-tmem-guardrails.json` adds PTXAS `-g-tmem-access-check` with **only** `compute_100a -> sm_100a` code generation, then runs three memcheck variants. Validate the returned job using:

```bash
python3 -B tools/research/check-tmem-guardrails.py \
  --input out/research/modal/new-b200-guardrails \
  --output out/research/tmem-guardrails/new-validation.json
```

The first supplementary build used `-arch=sm_100a` and emitted an unsupported-option diagnostic for its additional generic SM100 target. That attempt is preserved separately; the strictly architecture-specific rerun is the reported guardrail result. No invalid TMEM accesses were injected, so this supplement does not estimate guardrail sensitivity.
