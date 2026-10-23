# Natural fault diagnosis and repair comparison

This is an executed, bounded agent experiment on two public defects. It measures a shared diagnostic query backend, also exposed by the browser viewer. It does not measure a visual agent, human comprehension, or population-level repair ability.

## Conditions and freeze

Both conditions receive identical input implementation files, raw case observations, and compiler IR. Long numeric arrays use reversible run-length encoding. `raw` can read cases, evidence, and source; `diagnostic` additionally runs `contrast` and `overlap` through `lib/research/natural-diagnostic.js`, the same pure query function used by the viewer. The first request is mandatory in both conditions and must use a derived query in the diagnostic condition. At most two queries and three model calls are allowed, 90 seconds each, at most two concurrent trials.

The fixed model/configuration is the existing `gpt-6-astra` / low setup. Three fresh trials per defect/condition produce 12 candidates. Each call uses a fresh empty working directory, `--ephemeral`, ignored user configuration, disabled shell, JSONL audit, and a structured response. Only within-trial visible query history is replayed. This is prompt/tool-audit isolation, not a claim of a formally secret evaluation sandbox or absence from training. [Official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode) describes structured output and machine-readable execution; the actual CLI version and argv are retained.

```sh
python3 tools/research/natural-repair-eval/prepare_hidden.py \
  --output out/research/natural-repair-eval/hidden-v1
node tools/research/natural-repair-eval/experiment.mjs freeze \
  out/research/natural-repair-eval
node tools/research/natural-repair-eval/experiment.mjs run \
  out/research/natural-repair-eval
```

Existing output directories are intentionally not overwritten. Freeze records bind prompts, hidden inputs, query implementation, and execution source hashes. No model sees the gold patch, after-version evidence, issue URL, compiler commit ID, or hidden tests. Original source names and contents remain recognizable public code. Both tasks already identify the single editable file; this is not repository-wide blind fault discovery.

## Repair execution

`execute_repairs.py` applies only the model's exact sequential `{old,new}` edits, each with one occurrence, to the frozen source. No patch is manually corrected. CUTLASS recompiles a private copy of the old tree. Triton compiles a new allocator object and relinks using read-only original dependencies; it creates a wheel changing only `libtriton.so` and RECORD. Original source/object/library hashes are checked again. Equal source hashes may share compilation and GPU validation, with explicit per-trial provenance; duplicates remain in the model-trial denominator.

```sh
python3 tools/research/natural-repair-eval/execute_repairs.py \
  --family tmem --answer TRIAL/answer.json --output NEW_BUILD \
  --before-source FROZEN/tmem.before --expected-before-sha256 SHA
```

The agent receives no compilation or test feedback. All model candidates are generated before repair builds and GPU validation begin. Builds that fail stay in the denominator. Exact upstream allocation FileCheck is reported separately: different valid allocation layouts need not match a gold layout byte-for-byte.

`hidden_gpu.py` runs the frozen evaluation contract on actual H100/B200 through the existing Modal runner. CUTLASS has four known normal cases, twelve new hidden normal cases, and two hidden memcheck cases, beta=0 throughout. Old beta=1 failures in positive controls are a separate issue, not an empty-K repair requirement. TMEM has the known 16 configurations and two sets of new constants over those configurations, totaling 48; these are not 48 independent defects. Original and gold controls validate the evaluator before candidate testing.

`verify_runtime.py` rechecks complete archived bytes, expected shapes/IDs, process/sanitizer status, and independent constant/zero-K oracles. Missing cases fail instead of disappearing from the denominator. K>0 CUTLASS references remain the upstream CPU reference implementation.

## Metrics and the preserved scoring limitation

Report exact patch application, compilation, target-function localization, evidence validity, known/hidden GPU outcomes, sanitizer checks, CPU lit compatibility, queries, token usage, model wall time, build time and GPU command wall time separately. Model wall time includes service/network/queue delays. Only two root causes are available; repetitions are model draws, not independent developers or defects. There is no significance/generalization claim.

The frozen `allLocationsValid` implementation only accepts the editable source ID. Consequently it rejects additional real MLIR locations, although the prompt only restricts *editing* to one file. Original scores are preserved. `locationHit`, reference validity, and failure/control coverage are available independently; a separately labeled post-hoc audit can validate additional provided sources without replacing the frozen score. Neither this audit nor a plausible explanation counts as successful repair; actual compiled GPU outcomes decide that endpoint.

The reproduction modules inherit the MIT-licensed upstream Triton test; see `../natural-bugs/tmem_upstream_LICENSE.txt`. CUTLASS source retains its upstream license header. New hidden cases are disclosed constant/input substitutions, not claimed newly discovered bugs.

## Executed results and retained-byte reproduction

The [report](../../../docs/research/experiments/2026-10-23-interactive-repair/report.md) records 6/6 successful trials in each condition, with no observed success-rate advantage. There are 11 unique candidate sources: one exact duplicate shares its build and GPU run, explicitly counted as two model trials but one physical execution. The 348 candidate GPU cases include 12 memcheck invocations; complete verification covers 16,539,648 output elements.

The archive retains original frozen inputs, all model transcripts and query responses, candidate sources and diffs, build commands and omission receipts, and all recorded GPU output bytes. `package_evidence.py` stages only these artifacts, hashes omitted binaries/wheels against build receipts, and checks current sensitive environment values before publication. It never copies complete build trees.

This command restores the published archive to a new directory and independently recomputes every retained candidate/control outcome without model calls, GPU hardware, or cloud charges:

```sh
python3 tools/research/natural-repair-eval/verify_archive.py \
  --archive docs/research/experiments/2026-10-23-interactive-repair/evidence \
  --restore out/research/repair-restored-new \
  --report out/research/repair-restored-new-verification.json
```

Restoration also reapplies all twelve exact model patches and checks omitted artifact identities. It validates retained observations; rerunning kernels still requires the recorded upstream build dependencies and H100/B200 environment. `independent-results-review.json` records the separate protocol/result audit, including the preserved original localization scores and explicitly post-hoc correction.
