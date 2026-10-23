# Bounded multi-file repair study, v2

This runner measures access to evidence and actual executable repair, with equal ordinary search/read capabilities in both conditions. It removes the previous pilot's supplied single editable file, mandatory diagnostic query, and initial full-source packet. A curated subsystem package is still a bounded search task; it is not entire-repository blind discovery. The original CUTLASS/TMEM defects are development material and cannot be presented as newly held-out defects.

`query.mjs` is a pure browser-compatible API: `initialPacket(task)`, `rawQuery(task, condition, request, protocol)` and `genericDerived(task, request)`. It has no filesystem/network access or Node builtins. The runner and a browser can import this exact module. API results alone do not establish the usability of a visual layout.

## Frozen protocol

Default: 3 repetitions per defect/condition, `gpt-6-astra` / low, at most 8 requests and 9 model calls per trial, 90 seconds per call and 600 seconds per trial. All conditions have the same 16,000-character response ceiling and 64,000-character cumulative response ceiling, counted as JavaScript UTF-16 string length. Rejected/error queries consume request budget; oversized responses are rejected with an error, never silently truncated. Full model usage and response size are retained. Identical ceilings do not imply equal realized tokens or latency.

Both conditions have:

- `list(scope=all|files|cases|evidence)`
- `search(text=literal,id=optional file,offset=optional match offset)` across all supplied files, at most 40 matches per page
- `read(id=file,start,end)` for at most 120 source lines, or `read(id=evidence)`
- `case(id)` for case metadata and its raw observations

The diagnostic condition additionally has `derived(derived_op=...)`:

- `contrast`, grouped by arbitrary supplied parameter keys;
- `observed`, collecting actual observation IDs/text/provenance;
- `source_links`, following explicit archived source IDs only;
- `overlap`, when an optional before-only TMEM capture is supported by the pre-existing shared parser.

Generic operations contain no defect-specific symbol, inferred source location, bug classifier, repair template or gold-derived link. The initial packet includes only the same objective, file directory and case metadata. Source contents and observation payloads must be acquired. Agents may return immediately or choose ordinary/derived queries; the first turn never forces tool use. Files with role `implementation` are all editable. At least two implementation files are required; constructing a catalog with one disclosed editable target is rejected.

Compilation/test feedback is fixed to **zero rounds** before the study starts. This implementation deliberately rejects nonzero feedback configurations instead of silently improvising an interactive repair loop. All candidates should be generated before hidden validation. A future feedback study needs its own protocol and freeze.

## Input API

Public input is a JSON object with format `repair-study-catalog-v2` and `tasks`. Each task contains:

```json
{
  "id": "fault-001",
  "family": "implementation-family",
  "split": "holdout",
  "objective": "The entry-point contract and observed symptom, without a repair target.",
  "files": [
    {"id":"source-0","path":"src/operator.py","text":"...","sha256":"64 hex characters","role":"implementation"},
    {"id":"source-1","path":"src/caller.py","text":"...","sha256":"64 hex characters","role":"implementation"}
  ],
  "cases": [
    {"id":"case-0","status":"wrong_value","parameters":{"shape":[32,64]},"evidenceRefs":["evidence-0"]}
  ],
  "evidence": [
    {"id":"evidence-0","kind":"device-output","observed":true,"caseIds":["case-0"],"text":"Raw recorded symptom","payload":{},"rawRefs":[{"id":"raw-0","sha256":"64 hex characters"}]}
  ],
  "limits": ["No dynamic source location was captured."]
}
```

The example is schematic, not executable experimental evidence. Valid status values: `passed`, `wrong_value`, `timeout`, `execution_error`, `compilation_error`, `sanitizer_error`. File roles: `implementation`, `generated-ir`, `test`, `configuration`. Only implementation files may change. Evidence links are bidirectional. `observed:true` is restricted to `device-output`, `execution-observation`, `compiler-observation`, and `sanitizer-observation`; static IR cannot count as both a failing and a passing observation. Optional `sourceId` must reference supplied raw source, and raw provenance is `{id,sha256,lines?}`. Do not add source links from the gold patch. Optional `diagnosticData` must be `natural-gpu-diagnostic-v1`, `before-only`, and contain source/case/evidence bytes equally available through the ordinary API.

Private input has format `repair-study-private-v2` and one entry per task:

```json
{
  "id":"fault-001",
  "rootCauseId":"independent-defect-id",
  "relevantRegions":[{"source_id":"source-0","start_line":20,"end_line":80}],
  "hiddenCaseIds":["hidden-0","hidden-1"],
  "hiddenSpecSHA256":"SHA256 of the separately frozen hidden test specification",
  "requirePassingControl":true
}
```

This private file is never included in model prompts or tool responses. Hidden case IDs must differ from visible IDs. One root cause cannot be counted in both development and holdout splits. Its hidden specification is a hash commitment: the task owner must retain the actual specification and validate its bytes before GPU execution. The runner does not invent or implement an oracle from this hash.

Source history, after-version files, fix URLs and issue IDs are excluded from the task API. Public source may nevertheless be recognizable or represented in training data. Semantic leakage must be checked when constructing the catalog; strict field whitelisting does not prove that a free-text objective contains no answer.

## Freeze, run, replay

Freeze generic tools and tests **before** adapting new defect data, then freeze inputs and private endpoints before any candidate call. Local timestamps/hashes are auditable records, not external preregistration.

```sh
node --test tests/repair-study-v2.test.mjs
node tools/research/repair-study-v2/run.mjs tools-freeze out/research/repair-v2-tools-frozen
node tools/research/repair-study-v2/run.mjs freeze out/research/repair-v2-study \
  CATALOG_BEFORE.json PRIVATE_PLAN.json out/research/repair-v2-tools-frozen
node tools/research/repair-study-v2/run.mjs verify out/research/repair-v2-study
node tools/research/repair-study-v2/run.mjs run out/research/repair-v2-study
node tools/research/repair-study-v2/run.mjs replay out/research/repair-v2-study
```

The optional fifth freeze argument is a JSON object overriding documented protocol values; it is committed before candidate calls and applies equally to both conditions. Tool/source files changing after tool freeze make verification fail. Existing output/trial directories are not overwritten. Repetitions alternate task and condition order and run in bounded concurrent pairs. Missing trials stay in the frozen denominator. No automatic retry selects a more favorable candidate.

Each invocation uses an empty temporary cwd, `--ephemeral`, ignored user configuration, disabled shell, a structured schema and a JSONL audit that rejects external tool events. This is API/cwd/audit isolation, **not a formally secure secrecy sandbox**. Within-trial visible requests/responses are replayed, with no history exchanged between independent trials. The model alias and CLI argv/version are recorded; no unavailable weight snapshot is asserted.

`replay` rechecks frozen bytes, original call prompts, final model messages, query responses and budgets, exact patch application and predeclared localization scores. It requires no model or GPU. It verifies retained observations, not a new hardware run.

## Exact candidates and primary endpoint

Final answers contain sequential `{source_id,old,new}` edits. Each old string must match exactly once, whitespace included. Multiple supplied implementation files may change. `candidate.json` retains every resulting source file, before/after hashes and a stable path-sorted `candidateTreeSHA256`. The coordinator must not repair a failed patch, limit a valid model patch to the known gold file, or replace it with the official fix. A compilation failure stays in the denominator. CPU/GPU execution is an external independent step; this runner never directly executes arbitrary candidate source.

The runtime adapter returns:

```json
{
  "format":"repair-study-runtime-v2",
  "results":[{
    "trialId":"fault-001.raw.r1",
    "candidateTreeSHA256":"exact candidate identity",
    "hiddenSpecSHA256":"frozen hidden contract identity",
    "buildStatus":"passed",
    "verifierStatus":"verified",
    "verifierReceiptPath":"relative/to/runtime-json/verification.json",
    "verifierReceiptSHA256":"SHA256 of independent verification receipt bytes",
    "cases":[{"id":"hidden-0","status":"passed"},{"id":"hidden-1","status":"passed"}]
  }]
}
```

```sh
node tools/research/repair-study-v2/run.mjs summarize \
  out/research/repair-v2-study RUNTIME_RESULTS.json
```

The summary reapplies the original answer, checks the complete saved candidate identity, binds the independent verifier receipt's actual bytes, and requires successful compilation plus exactly every frozen hidden case. Missing, duplicated, aborted or timed-out cases cannot disappear from the denominator. The runtime adapter remains responsible for checking complete outputs, oracle independence and native binary/source bindings. A receipt hash is an integrity binding, not proof that an arbitrary verifier is correct; retain and audit that verifier separately.

Localization is secondary: valid bounded line ranges may name any supplied file, including generated IR. At least one range must hit a private predeclared source region, and case-bound citations must include actual observed failure and the required passing control. Shared IR, mismatched case/evidence pairs, duplicates and foreign IDs cannot obtain observation coverage. This checks supported location and references, not semantic correctness of every sentence.

Report repair success and resource consumption by independent root cause and condition. Repetitions are repeated model draws, not independent defects or developers. Keep development and holdout summaries separate, retain null and negative outcomes, and do not interpret an agent experiment as evidence of human understanding or interface usability.

## Post-generation reporting and portable audit

The following adapters are reporting code, written after the core protocol was
frozen. They do not change its endpoint or original transcripts.

```sh
node tools/research/repair-study-v2/analyze.mjs out/research/repair-v2-study
python3 tools/research/repair-study-viewer/build.py \
  --outcomes out/research/repair-v2-study/viewer-outcomes.json
python3 tools/research/archive-modern-evidence.py \
  --extract docs/research/experiments/2026-10-23-repair-study-v2/evidence \
  --to NEW_EMPTY_DIRECTORY
node tools/research/repair-study-v2/verify_archive.mjs NEW_EMPTY_DIRECTORY
```

Analysis retains every scheduled trial, cross-checks hidden/visible status
mapping against independent receipts, separates all-case safety from the
frozen hidden-only primary endpoint, and counts missing provider usage rather
than treating it as zero. Published totals are descriptive: six selected roots
and three draws per cell, not 36 independent developers. Timing scopes exclude
unmeasured preparation and must not be described as full end-to-end speed.

The extracted archive contains `study`, `tools-freeze`, `runtime-freeze`,
`triton`, and `liger` directories. The offline verifier needs Node and Python
with NumPy, but no model, GPU, installed Triton wheel or network. It verifies
frozen source bindings, replays exact prompts/queries/patches and recomputes
the retained numerical outputs. It requires this checkout's seven replay
source files to match the recorded freeze; audit code is not silently upgraded.

Known representation limitation: JavaScript JSON serialization normalizes a
numeric `-0` parameter to `0`. Frozen model inputs and the matching viewer retain
that limitation; signed-zero correctness remains decidable from complete raw
IEEE bytes, and the Python GPU plan retains its signed literals. Do not edit
an in-progress frozen catalog to add an extra sign hint.
