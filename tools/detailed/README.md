# Detailed instruction output → SM viewer

The viewer accepts two forms of **simulation output**:

- Native FlashGPU-Sim `INSTRUCTION_ISSUE` runtime log records, as timestamped
  instruction observations. This is an implemented log adapter; it does not
  build, install or launch FlashGPU-Sim.
- `gpu-sim-instruction-observer-v1`, a custom JSON contract for a backend observer
  that actually records instruction intervals or points. Accel-Sim requires such
  an output observer; this contract is **not** an importer for its input SASS
  `.tracez` / `.traceg` files.

No detailed simulator output is bundled as an example. The tests explicitly use
hand-written `evidenceKind: illustration` fixtures. No FlashGPU-Sim/Accel-Sim run
was performed in this environment, which has no `nvcc` installation.

## FlashGPU-Sim native logs

The adapter grammar was checked against official FlashGPU-Sim revision
[`291fbe172332eb481556632a79eb9cfc93cf46bf`](https://github.com/FlashGPU-Sim/FlashGPU-Sim/tree/291fbe172332eb481556632a79eb9cfc93cf46bf):
[runtime tracing](https://github.com/FlashGPU-Sim/FlashGPU-Sim/blob/291fbe172332eb481556632a79eb9cfc93cf46bf/docs/tracing.md),
[scheduler record format](https://github.com/FlashGPU-Sim/FlashGPU-Sim/blob/291fbe172332eb481556632a79eb9cfc93cf46bf/src/gpgpu-sim/shader_trace.h),
[cycle prefix](https://github.com/FlashGPU-Sim/FlashGPU-Sim/blob/291fbe172332eb481556632a79eb9cfc93cf46bf/src/trace.h),
and [emission sites](https://github.com/FlashGPU-Sim/FlashGPU-Sim/blob/291fbe172332eb481556632a79eb9cfc93cf46bf/src/gpgpu-sim/shader.cc).
This reference revision identifies the inspected **format**, not the version of
a user's captured simulator run.

In an already working FlashGPU-Sim installation, enable the component in the
workload's `gpgpusim.config` and capture the workload process output:

```text
-trace_enabled 1
-trace_components INSTRUCTION_ISSUE
-trace_sampling_core 0
```

```bash
./workload > simulation.log 2>&1
node tools/detailed/convert.mjs --input simulation.log --output detail.json \
  --run-id my-kernel-run --revision ACTUAL_SIMULATOR_COMMIT \
  --backend-version ACTUAL_SIMULATOR_VERSION
```

These options follow the official tracing documentation; compiling/running the
workload still follows the backend's own setup. `-trace_sampling_core -1` selects
all SMs but can produce much larger logs. The import retains the sampled scope;
missing SMs and missing observations are not zero activity.

Native `ISSUE`, `STALL_SCOREBOARD` and `STALL_READY_NO_ISSUE` records retain the
observed GPU total cycle, SM, scheduler, warp slot, dynamic warp ID, PC, operation
class, instruction text and scoreboard producer class. Each becomes a
zero-duration point with `args.granularity: instruction` and capability
`instruction_observations`. It is never expanded to a made-up execution interval
or combined with the next PC into a guessed completion time. Repeated PC records
remain separate observations, and a reused warp slot with another dynamic warp
ID remains distinct.

The backend documents incomplete multi-issue and stall-cause coverage. The
current importer also does not consume L2/NoC/TMA output; different subsystem
clocks are not merged. CTA identity, active mask, instruction completion,
functional output correctness and memory routes are unknown from these records.
The logged `op` is an operation **class**; raw instruction text is retained
instead of claiming to extract an exact opcode. Producer classes do not become
dependency edges.

## Custom interval observer contract

The following is a **protocol illustration**, not simulator output:

```json
{
  "format": "gpu-sim-instruction-observer-v1",
  "meta": {
    "title": "Illustrative observer contract",
    "producer": "Hand-written illustration; not a backend run",
    "producerRevision": "unknown",
    "backendVersion": "fixture-format-v1",
    "runId": "illustration-only",
    "timeDomain": "illustration.core_cycle",
    "timeUnit": "cycle",
    "evidenceKind": "illustration"
  },
  "instructions": [
    {
      "id": "observed-interval-0",
      "instructionId": "dynamic-instruction-0",
      "smId": 0,
      "warpId": 2,
      "pc": "0x100",
      "opcode": "IADD3",
      "start": 10,
      "end": 14,
      "stage": "observer-defined-issue-to-completion"
    }
  ]
}
```

`start`, `end`, `stage`, PC and instruction identity must come from the observer.
The adapter checks required identities and timestamps but cannot authenticate
the origin of an imported file. Use `simulation` only for actual backend output.
The observer must describe the meaning of each stage and its capture scope in
`meta.description`; a named interval does not imply complete pipeline coverage.
For points set `start === end`. Capability `instruction_spans` is emitted only
for nonzero intervals; mixed inputs declare both capabilities.

Optional `threadBlockId`, `dynamicWarpId`, `activeMask` and other observed fields
are retained. Hex addresses and masks are strings, preserving values beyond
JavaScript's safe integer range. `dependencies` defaults to no known edges and
may be provided only when actual completion dependency IDs are known. An
`instructionId` associates multiple observed records with one dynamic
instruction; it is not inferred from PC. The adapter also accepts canonical
trace v1 with matching validated instruction capabilities.

## Time and provenance

GTSim and detailed outputs are separate runs and retain independent cycle axes.
Matching numeric SM/CTA/warp IDs does not establish a cross-run mapping. Entering
an SM does not translate GTSim nodes into detailed instructions or substitute
simulator state while execution is in progress.

`runId`, `backendVersion` and `producerRevision` remain `unknown` when the input
does not provide them. `timeDomain` for native scheduler logs is explicitly
`flashgpu.gpu_total_cycle`; observer JSON must describe its own clock or use
`unknown`. The CLI records the input SHA-256. Without `--run-id`, it assigns
`import-sha256:HASH`, identifying the imported artifact rather than claiming the
simulator emitted that run identity.

Optional measured wall time can be supplied with both `--wall-time-seconds` and
`--timing-scope`. It is stored as `metrics.wallTimeSeconds` and
`metrics.timingScope`. Absent measurements stay unknown; no backend speed is
derived from simulated cycles, replay speed or the number of imported records.
The scope should state whether tracing, setup and output writing are included.

The library API is `normalizeFlashGpuLog(text, metadata?)`,
`normalizeDetailedTrace(json)`, `isDetailedTrace(json)` and
`detailCapabilities(trace)` in [lib/detailed-trace.js](../../lib/detailed-trace.js).
Detection validates both capability declarations and actual record shape;
a backend name or a tile operation named `wgmma` does not pass. Cache the
capability result when loading a run rather than validating the whole trace on
every animation frame. Input limits are 64 MiB / 500,000 log lines, 250,000
observations/intervals, and the canonical trace's 2,000-component limit.
