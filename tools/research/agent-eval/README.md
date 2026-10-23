# Finite, prompt-only agent diagnosis pilot

This pilot measures one requested agent model/configuration on 12 predeclared synthetic development tasks from the repository's finite protocol model. It does **not** test natural held-out GPU bugs, a visual UI, or whether agents can replace human participants.

The two conditions encode exactly the same anonymized payload. `flat` emits field-path facts; `structured` emits nested JSON. The tests reconstruct the flat facts and compare them with the JSON payload. The shared prompt supplies the finite semantics and the exact answer schema. Neither condition supplies checker verdicts, oracle outputs, repository paths, source case IDs, descriptions, or answer files. Both conditions include the same evidence-ID requirements. Any difference concerns text organization only.

Gold labels come from `enumerateProtocolOracle` in `tools/research/protocol-corpus.mjs`, which enumerates all HB-consistent total orders independently of the production reachability checker. `validateProtocolCapture` only validates authored input structure. The frozen selection has four `sat`, four `violated`, and four `unknown` targets. Selection covers arbitrary-length generations, stale same-parity generations, resource mismatch, completion-domain mismatch, forward/transitive and reverse HB, incomparable endpoints, and missing records. A completion token mismatch is `violated` for a token target but `unknown` for a gated ordering target.

Each call uses a new empty temporary working directory, a fresh ephemeral Codex thread, `--ignore-user-config`, `--sandbox read-only`, and `features.shell_tool=false`. All task information is sent through stdin. The requested model is fixed to `gpt-6-astra`, with `model_reasoning_effort="low"`; no model substitution or score-driven prompt tuning is performed. CLI JSONL is audited conservatively: any item other than reasoning or an agent message counts as tool contamination. Malformed JSONL, missing completion, timeout, CLI errors, and invalid answer schema are retained as failures. Isolation is enforced by configuration and the transcript audit; it is not a claim that the CLI system instructions are absent.

## Run

```bash
node --test tools/research/agent-eval/agent-eval.test.mjs
node tools/research/agent-eval/run.mjs freeze
node tools/research/agent-eval/run.mjs smoke
node tools/research/agent-eval/run.mjs run
node tools/research/agent-eval/report.mjs
```

An optional output-directory argument follows the mode. The default is `out/research/agent-eval/` (Git-ignored; archive explicitly for publication). Freeze records input SHA-256, all 24 prompt SHA-256 values, source SHA-256 values, schema, model/configuration and predeclared selection. It refuses to overwrite a different registered fixture. Existing calls cannot be rerun in place. A smoke test runs one predeclared task in both conditions and checks transport, schema and absence of tools, without conditioning continuation on correctness. Its two calls are excluded from the 48 main calls. Main execution uses 12 tasks × two conditions × two repeats, at most two concurrent processes, and a 90-second timeout per call. Access/CLI failures stop future calls; existing failures remain visible.

Per-call artifacts preserve the exact prompt, stdout JSONL, stderr, final answer (if present), wall time, CLI usage, process status, and deterministic score. A requested model alias is recorded; no resolved model snapshot is claimed when the CLI does not expose one. Temporary directories are removed after their raw output is saved.

## Scoring and interpretation

The primary score is exact agreement with the independent oracle. Additional checks verify that cited IDs exist, the declared relevant record/identity references and unique proof-path edges are covered, and missing-evidence codes exactly match the frozen requirements. The `fullySupported` field is the conjunction of these deterministic checks; it is a narrow reference-coverage measure, **not** a semantic assessment of the reason text. Extra valid evidence IDs are allowed, so this is not a minimality or irrelevant-evidence metric. Invalid/contaminated calls score zero, without replacement.

Results average the two repeats within each task and compare the paired task-level condition averages. Repeated calls are not human participants or additional independent tasks. Wall time includes network, queueing and service overhead. There is no human baseline, task-completion user study, or measurement of visual comprehension. High pilot accuracy can justify further agent evaluation but cannot establish human equivalence or visualization benefit.

The CLI structured-output/JSONL approach follows the [official OpenAI eval guidance](https://developers.openai.com/blog/eval-skills). No LLM self-grader is used.
