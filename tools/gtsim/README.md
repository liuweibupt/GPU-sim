# GTSim → native tile intervals → viewer trace

This adapter runs the **actual public GTSim v0.1.0 H100 GEMM timing graph**.
It downloads a commit- and SHA-256-locked archive, compiles the unmodified timing
core and workload builder, then reads the DAG's native timestamps after the run.
No GPU or CUDA installation is required. You need Python 3, CMake 3.15+, and a
C++17 compiler. Downloads/build products live in the user cache, outside this repo.

```bash
python3 tools/gtsim/build_and_trace.py --test
python3 tools/gtsim/test_observer.py
```

The first command runs the four original upstream tests, exports
`examples/gtsim-gemm.json`, validates dependency timing, and compares `Total cycles`
with the original upstream GEMM executable. The example is a **complete run**:
256×256×128, 796 tile-node intervals, 5,492 simulated cycles. The native run log is
saved beside the JSON as `.log`. This is a timing graph: it does **not** execute GEMM
numerics or validate matrix values, and it is not a physical-GPU measurement.

The adapter uses `add_subdirectory` for the official project. A separate object
target compiles its original GEMM file with only `main` renamed at compile time.
No scheduler, memory model, node timestamps, delays, or dependencies are patched.
The observer emits no fictional L2/DRAM/cache-hit stages. This is the same thin
backend→trace→viewer boundary needed before adding richer game rendering.

## Native experiments supported by this prototype

```bash
# Same demand, lower native L2 shared service budget: 6,413 cycles.
python3 tools/gtsim/build_and_trace.py --l2-bandwidth 128 \
  --output examples/gtsim-gemm-slow-l2.json

# Lower native SRAM service rate: 9,076 cycles for the default shape.
python3 tools/gtsim/build_and_trace.py --sram-bandwidth 16 \
  --output /tmp/gtsim-slow-sram.json

# Another complete supported graph shape.
python3 tools/gtsim/build_and_trace.py --m 128 --n 256 --k 64 \
  --output /tmp/gtsim-small.json
```

| Input | Actual behavior / boundary |
| --- | --- |
| M / N / K | Rebuilds the official hand-written graph; require multiples of 128 / 256 / 64, respectively, to prevent the original integer divisions silently truncating work. |
| `--l2-bandwidth` | Changes `SimulatorConfig.l2_bandwidth_bytes_per_cycle`, a shared total service budget. The upstream configured write budget stays 2,150 bytes/cycle and is clamped to the total. Integer cache-line budgets require ≥128 bytes/cycle; smaller values cannot make progress in the original implementation and are rejected. |
| `--sram-bandwidth` | Changes native `SimulatorConfig.sram_bandwidth_bytes_per_cycle`; positive integer bytes/cycle. |
| `--max-cycles` | Stops at a native simulation cycle limit. A partial run writes provenance and omitted-node states, and exits with code 2. |
| SM count | Fixed to the official 132-SM H100 configuration. The original builder has its own fixed 132-SM mapping; simply changing config would not be a valid experiment. Components show only SM/pipeline groups represented by the graph; omitted idle SMs do not mean the device has only two SMs. |
| Tile shape, kernel source, layout, profile import | Not supported by this adapter. The observer does not claim to extract graphs from arbitrary kernels. |

The optional model parameters produce **new simulations**, not edited silicon
measurements. The observer limits dimensions to 2,048 and graphs to 50,000 nodes
because this is a small functional prototype.

## Trace semantics

The top-level schema is `schemaVersion: 1`, `meta`, `components`, `events`, `metrics`.
Metadata records upstream commit, producer, `evidenceKind: simulation`, cycle units,
actual shape/configuration, and a reproducible native harness command.

- `meta.backend` / `backendVersion` identify GTSim v0.1.0. Its only advertised
  capability is `tile_tasks`; both `meta.granularity` and every completed event's
  `args.granularity` are `tile`. A tile DAG node is not an instruction issue or a
  warp scheduler observation, even when its native operation names resemble GPU
  instructions. The SM instruction view requires a separate detailed backend.
- `meta.experimentId` identifies the locked backend, workload, adjustable service
  budgets, and cycle limit reproducibly. `meta.runId` identifies one native
  invocation, and `meta.timeDomain` names that invocation's cycle clock. Repeating
  an experiment preserves native node IDs/timestamps but produces a fresh run ID.
  Independent tile and instruction backend clocks must not be aligned by matching
  cycle numbers or SM numbers; any drill-down correspondence needs explicit
  provenance from the detailed backend.
- `metrics.wallTimeSeconds` measures the steady-clock duration of the actual
  `Simulator::run` call, including its native final reporting. `metrics.timingScope`
  explicitly excludes download, compilation, DAG construction, and JSON export.
  It is host elapsed time for this invocation, not simulated GPU time or a claim
  about GTSim versus another backend's speed. Exported examples record fresh
  measured values, so this field varies across machines and repeated runs.
- Each event is one completed original DAG node. `start` is its native first issue;
  `end` is native completion. Node ID, operation, warp, block, SM, and tile are kept
  in `args`. A span can include both service and waiting; it is not a claimed
  per-stage hardware transaction.
- `dependencies` is the original `depends_on`: producer **completion** must precede
  consumer issue. The validator checks `producer.end <= consumer.start`.
- `args.issueDependencies` is the original `issue_depends_on`, which constrains
  **issue order**, not data completion. These are separate from completion edges;
  a consumer may issue before this producer completes. The validator checks the
  recorded first-issue ordering. The observer adds no invented issue-release
  milestone. `tmaIssueCompleteCycle` is only the upstream field and remains `null`
  when upstream has not set it; it must not be equated with dependency release.
- Unissued or started-but-incomplete nodes are **not** turned into complete spans.
  They appear in `metrics.omittedNodes`, with unobserved start/end as `null`. Counts
  account for every original graph node, even on timeout. An issue-order dependency
  may in general refer to a started-but-incomplete node with a known start in this
  list; consumers must validate that known issue timestamp without requiring or
  inventing a completion. Completion dependencies must still refer to completed
  `events`. The current small GEMM's issue edges finish in order, so its tested
  partial runs do not exercise that cross-list dependency case.
- `metrics.totalCycles` is `Simulator.cycle` and is checked against native
  `Total cycles`. It includes all observed completion; the upstream separately
  reports last output-store issue, which is a different metric.

The renderer may animate between the recorded boundaries, but must keep the
authoritative cycle values and dependency semantics unchanged.

The integration checks include native partial runs at 1, 1,000, 2,000 and 4,000
cycles. Mid-run completed intervals are checked against the full baseline, while
the unfinished nodes retain missing endpoints. A time limit must not shift
timestamps or delete original dependencies merely to make a file importable.
Reproduction checks compare every native observation and reproducible metadata
field; only the invocation's run ID, clock-domain name, and measured wall time are
excluded from byte-for-byte equality.

See [the upstream lock](upstream.json) and [third-party notices](../../THIRD_PARTY_NOTICES.md).
