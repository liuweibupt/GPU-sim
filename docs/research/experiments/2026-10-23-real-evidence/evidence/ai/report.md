# Actual AI-generated CUDA candidates with frozen hidden tests

Six candidates were actually returned by Codex CLI `gpt-6-astra` / low reasoning and compiled unchanged for an RTX 4090 (SM89). All six passed the finite hidden suite and four sanitizer tools. This is a ceiling result on three standard public operator contracts, not a human-replacement, natural-bug, or tool-condition comparison.

| Candidate | Implementation visible in saved source | Unique hidden cases | Functional full-output checks | Sanitizer tools clean | Max absolute error |
| --- | --- | ---: | ---: | ---: | ---: |
| rmsnorm-candidate-1 | 256-thread shared-memory tree reduction | 11 | 8470 | 4/4 | 2.384185791015625e-07 |
| rmsnorm-candidate-2 | warp shuffles + eight shared warp sums | 11 | 8470 | 4/4 | 2.384185791015625e-07 |
| transpose-candidate-1 | 32×33 shared tile; 32×8 threads | 10 | 16764 | 4/4 | 0.0 |
| transpose-candidate-2 | 32×33 shared tile; 32×8 threads (same strategy) | 10 | 16764 | 4/4 | 0.0 |
| segments-candidate-1 | 256-thread int64 shared-memory tree | 10 | 560 | 4/4 | 0.0 |
| segments-candidate-2 | 256-thread int64 shared-memory tree (same strategy) | 10 | 560 | 4/4 | 0.0 |

There are 31 unique hidden input cases (11 RMSNorm, 10 transpose, 10 segmented sum) and four unique metamorphic relations. Across two candidate samples and two functional repetitions, 124 case executions compare 51,588 actual output elements and check 16 metamorphic relations. The 24 sanitizer invocations separately check 248 case executions, 103,176 output elements, and 32 relations. Repeated checks do not create additional independent tasks.

The numerical oracle uses Python double precision followed by FP32 rounding for RMSNorm (atol 2e-5, rtol 2e-4), direct byte-preserving indexing for transpose, and Python integer sums for int64 segmented outputs. Each logical element is checked. Output guards/padding and input/offset bytes must remain unchanged. Hidden cases exercise empty inputs/segments, tails, non-contiguous strides, signed zero, zero RMS rows, and a segmented sum exceeding int32 range. Metamorphic checks cover sign reversal and RMSNorm input/epsilon joint scaling; RMSNorm relation tolerance is twice the elementwise tolerance to account for both compared evaluations. Two functional repeats produced bit-identical complete captured buffers.

## Provenance and fixed budget

- Frozen at 2026-10-23T12:45:02.658499+00:00; first candidate call 2026-10-23T12:45:02.777Z.
- Hidden generator SHA-256: `7f1f3513a1369675e50512306db4be6fce8d95af83c6715701fd18fcff050afb`.
- Hidden case SHA-256: `158216074cb0cc80c382ce347e6bb03b4344ec67e6b020f4af5bc959fffd87d0`.
- Six fresh ephemeral calls, at most two concurrent; 90 seconds per call; zero repair rounds. Public contracts and response schema only in the prompt. No hidden files, paths, oracle, or evaluator code were supplied.
- CLI user configuration ignored, shell tool disabled, empty temporary cwd, full JSONL audited. Zero tool items and generation timeouts. Model alias and CLI version are saved; CLI does not expose a resolved model snapshot.
- Candidate source bytes exactly equal the structured model response, with no manual fixes. Six unique source hashes do not imply six distinct algorithm families: both transpose candidates and both segment candidates use closely related strategies.
- Build budget 90 seconds/candidate; functional budget 60 seconds/candidate/repetition; sanitizer budget 90 seconds/candidate/tool. memcheck, racecheck, initcheck and synccheck all ran. No compile, launch, timeout, numerical, metamorphic, guard, or sanitizer failure was observed. Failure categories are retained separately by the harness.
- Executed evaluator/harness/generator sources are preserved under `executed-source-snapshots/`. Command JSON legacy `started_utc` was recorded after process completion; treat it as completion/recording time, as documented in `execution-notes.json`. The current runner renames the field `finished_utc`; original logs are retained. Actual durations and generation/freeze timestamps are unaffected. No candidate, hidden fixture, or GPU harness was changed.

## Fairness and interpretation boundaries

- Single model/configuration; two samples per known operator, not independent models or humans.
- All six use the same no-tools generation condition; no tool-condition comparison.
- Simple public operator contracts and authored synthetic hidden cases, not held-out natural bugs or blind root-cause discovery.
- Tests cover finite inputs within the contract, not every allowed shape/value; sanitizer passes are not a proof.
- No feedback, repair, candidate edits, or hidden-test retuning; common transpose/segment strategies are very similar.
- Hidden from candidate prompts/cwds at generation; evaluator authored tasks and tests. This is not a formally isolated secret-evaluation service.
- No GPU performance or human-understanding measurement. Ceiling results do not establish broader capability or human replacement.

The no-tools setting is a fixed provenance/isolation control for all candidates, not an experimental comparison. Shared hardware execution was coordinated with the cost-measurement agent; no GPU timing benchmark was performed. Public operator contracts include supported ranges and tolerances, while concrete shapes, strides, values, seeds, references and relations were withheld until after generation. The coordinator authored both contracts and tests, so this is a reproducible local holdout protocol rather than an independently administered evaluation. CUDA source was inspected for prohibited host APIs; this is not a formal sandbox proof.

Raw prompts, responses, JSONL, exact sources, compiler logs, execution/sanitizer logs, complete compressed inputs and actual outputs, source snapshots and SHA indices are included in `publish/`; compiled ELF files are excluded.
