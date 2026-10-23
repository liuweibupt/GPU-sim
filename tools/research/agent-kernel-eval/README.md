# Actual AI-generated CUDA / hidden-input pilot

Three public contracts (FP32 strided RMSNorm, bit-exact strided transpose, int32-to-int64 segmented reduction), two fresh candidate calls each. Source is returned by the fixed `gpt-6-astra` / low Codex CLI, saved unchanged and linked with an evaluator-authored host harness. Concrete tests and the independent Python oracle are frozen before generation and withheld from candidate prompts/cwds. This pilot is independent of the earlier finite-protocol diagnosis pilot.

```bash
python3 tools/research/agent-kernel-eval/test_harness.py
python3 tools/research/agent-kernel-eval/freeze.py
node tools/research/agent-kernel-eval/generate.mjs
python3 tools/research/agent-kernel-eval/evaluate.py compile
# Coordinate the local GPU window before this command:
python3 tools/research/agent-kernel-eval/evaluate.py run
python3 tools/research/agent-kernel-eval/report.py
```

Default output: `out/research/agent-kernel-eval/`. Python commands accept `--out`; the generation script takes the output directory as its positional argument. Existing frozen datasets and GPU evaluations cannot be overwritten. The frozen model budget is six calls, at most two concurrent, 90 seconds each, no repair/feedback. Generation has no model tools, is ephemeral, ignores user config, uses an empty temporary cwd, and emits JSONL. Unknown/tool transcript items invalidate a candidate.

The 31 hidden cases include empty dimensions/segments, tails, non-contiguous strides, signed zero, zero RMS rows, and an exact int64 sum beyond int32 range. Four metamorphic relations compare actual outputs across input sign reversal or joint RMS input/epsilon scaling. The CUDA host harness captures full output buffers and both-side guards plus unchanged input/offset buffers. It does not implement candidate kernels. CPU scoring uses double-precision arithmetic/FP32 rounding, direct indexing, or Python integer sums. Functional evaluation runs twice per candidate; all four Compute Sanitizer tools run with explicit deadlines. Compilation, generation, runtime, missing outputs, numerical errors, guard errors, relation failures and sanitizer failures remain separately inspectable.

`report.py` verifies exact response/source identity, prompt freeze hashes and all saved output scores, and creates `publish/` without compiled ELF files. Raw inputs/outputs are losslessly compressed with per-file hashes. Executed source snapshots allow auditing the initial run. A metadata correction is disclosed in `execution-notes.json`: the original command field `started_utc` recorded completion time; current code names it `finished_utc`. Original logs, candidate code, hidden cases and GPU harness remain unchanged.

All six samples use one model and the same no-tools condition; neither repetitions nor candidates are independent models or people. The public contracts describe standard operators, and the coordinator authored the hidden tests. No natural-bug holdout, independent-administered benchmark, human-understanding, tool-condition comparison, complete correctness proof, or GPU performance claim is made. Fresh-cwd/configuration/transcript isolation is not a formal secret-evaluation sandbox. See the generated report for actual results and limits.
