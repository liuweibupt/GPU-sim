# Prompt-only agent pilot: finite generation/order diagnosis

The frozen synthetic task set produced 24/24 correct oracle labels with flat facts and 24/24 with structured JSON. This measures this agent's finite-model diagnosis only. It does not establish that agents replace humans or that a visual interface improves diagnosis.

| Condition | Valid / attempted | Oracle label correct | Reference/missing-evidence checks all pass | Mean CLI wall time |
| --- | ---: | ---: | ---: | ---: |
| Flat facts | 24/24 | 24/24 | 24/24 | 8.501 s |
| Structured JSON | 24/24 | 24/24 | 24/24 | 8.576 s |

At the paired task level (n = 12; two repeats averaged within task/condition), the structured-minus-flat mean label-accuracy difference is 0.0% and the reference-check difference is 0.0%. There are 0 structured wins, 0 flat wins, and 12 ties. These are descriptive results, with no population or equivalence test.

## Frozen design

- Freeze time: 2026-10-23T11:05:27.301Z; earliest main call: 2026-10-23T11:06:09.288Z.
- Fixture SHA-256: `8d394fe5623ca027f4aaf1a919fb3af94886aedcaad3e80a1cf7849f87a8e7f1`.
- Requested model: `gpt-6-astra`; reasoning effort: `low`; CLI: `codex-cli 0.161.0`. A resolved model snapshot was not exposed by CLI JSONL.
- Twelve predeclared synthetic development tasks, from twelve different source captures, balanced 4/4/4 over sat/violated/unknown. No held-out natural-bug claim.
- Independent gold: exhaustive HB-consistent total-order oracle. Production code validates input structure only.
- Two input organizations share the exact same semantic fields, rules, and output requirements; a test reconstructs flat fields into the same JSON payload. Neither is a visualization.
- Two smoke calls verified transport/schema/no-tools and were excluded from the 48 main calls. No score-driven prompt tuning.
- Each call starts in an empty temporary working directory with no task files, uses an ephemeral thread and disabled shell tool, and receives all case information in stdin. Maximum concurrency is two and timeout is 90 seconds. Any tool item invalidates the call.

## Audit and scoring

Main calls contain 0 tool-contaminated transcripts, 0 invalid calls, and 0 timeouts. Every saved prompt hash and deterministic score was recomputed from the frozen task and raw result records. Raw stdout JSONL, stderr, final answers, usage and wall time are retained per call. The runner's timeout and tool-contamination handling are tested with a mock CLI.

Reference scoring checks existence, the predeclared relevant record/identity/unique-path references, and exact missing-evidence codes. It allows extra valid references and does not judge the natural-language reason or minimal explanation. Invalid calls count as unsuccessful; no replacement calls are generated.

Input usage totals: flat 418220, structured 417566; output usage totals: flat 1677, structured 1683. CLI input usage includes harness/system context, not just the task prompt. Wall time includes network/service/queue overhead and is not an isolated reasoning-time measure.

## Boundaries

These tasks explicitly teach the bounded decision rules, are small and synthetic, and use only one model/configuration. Repeats are agent calls, not people. No human baseline, human timing, interaction study, natural GPU diagnosis task or visual-comprehension outcome was collected. A ceiling result would show that these tasks fail to discriminate the two organizations; it would not prove equivalence or agent replacement of human participants.

See `tasks.csv` for paired task data, `calls.csv` for all calls, `frozen/manifest.json` for preregistered inputs and source hashes, and `validation-tests.txt` for deterministic tests. The harness uses the [official OpenAI CLI eval approach](https://developers.openai.com/blog/eval-skills) for JSONL audit and structured outputs.
