# Six actual GPU tasks: human-study handoff

Version `simple-six-root-immediate-v2` replaces the earlier eight-root learning
sketch. **Six actual before-only main tasks + two old development practice tasks,
zero synthetic task forms, zero real participants or human ratings.** The study
measures immediate explanation/localization in this fixed task pool; it makes no
long-term learning or transfer claim. Materials are operational; independent
expert review, final protocol freeze and recruitment are still pending.

See [the complete Chinese protocol](../../../docs/research/human-diagnostic-study-protocol.md).
`private/*.rubric.json` contains task-specific mechanism, equivalent explanations,
failure/pass controls, counterfactuals and source targets. `private/executor-map.json`
binds actual hidden GPU executors. These files are scoring drafts, not expert
approvals, and **are never bundled into participant HTML**. Public repository
availability does not make them secret from external browsing; study sessions
use the isolated launcher and the stated no-external-help protocol.

```bash
python3 tools/research/human-diagnostic-study/prepare_keys.py
python3 tools/research/human-diagnostic-study/build.py
python3 tools/research/human-diagnostic-study/launch.py
```

Open `http://127.0.0.1:4184/`. The launcher serves only this page and has no upload
endpoint or access log. Institution determines review applicability locally;
approved/exempt/not-required with reason are possible, never self-assumed.

```bash
node --test tools/research/human-diagnostic-study/core.test.mjs
python3 -m unittest discover -s tools/research/human-diagnostic-study -p 'test_*.py'
python3 tools/research/human-diagnostic-study/check.py web/research/human-study/index.html --output web/research/human-study/browser-check.json --sessions out/research/human-diagnostic-study/six-root-software-sessions
python3 tools/research/human-diagnostic-study/selftest.py out/research/human-diagnostic-study/six-root-software-sessions --output web/research/human-study/analysis-check.json
```

Twelve allocation slots balance six starting tasks × two condition orders. Every
person gets four different main tasks, two per condition. In twelve people each
root occurs four times per condition and twice in each position. Freeze randomized
blocks before enrollment (48 is a planning draft, not a power guarantee):

```bash
python3 tools/research/human-diagnostic-study/allocate.py --participants 48 --mode formal --output /private/study/allocation
python3 tools/research/human-diagnostic-study/analyze.py precision --output /private/study/precision.json
```

After independent review, use `build.py --manifest` with the final manifest, then
freeze it and the task/source/rubric/analysis hashes before genuine enrollment.
No extra eight/sixteen-task requirement is imposed. The current formal-entry gate
reports expert-review/freeze pending, separately from `materialsReady=true`.

```bash
python3 tools/research/human-diagnostic-study/analyze.py blind /private/study/exports/*.json --manifest /private/study/frozen-manifest.json --output /private/study/blind
python3 tools/research/human-diagnostic-study/analyze.py analyze /private/study/exports/*.json --manifest /private/study/frozen-manifest.json --mapping /private/study/blind/PRIVATE-unblinding-map.json --scores /private/study/rater-a.csv /private/study/rater-b.csv --adjudication /private/study/adjudication.csv --output /private/study/analysis.json
```

Only the rater packet/template and task-specific rubric go to raters, not the
private unblinding map, condition, timing or interaction logs. Exactly two ratings
per answer are required; disagreements need an independent adjudicator. Dry-run
exports are rejected by default and permanently labeled software-only when
`--allow-dry-run` is explicitly used for testing.

Optional candidate repairs are handed off unchanged to the already-tested real
GPU pipeline, only after the session ends:

```bash
node tools/research/human-diagnostic-study/materialize_candidate.mjs --catalog out/research/repair-v2-study/frozen/catalog-before.json --session /private/study/P001.json --output /private/study/P001-candidates
python3 tools/research/human-diagnostic-study/execute_candidate.py --candidate /private/study/P001-candidates/TASK.candidate.json --output /private/study/P001-runtime/TASK
```

The dispatcher verifies executor/runner/verifier/hidden-plan hashes and prints
the command. Add `--execute` for actual GPU execution. No/invalid candidate and
missing runtime results stay in the four-task denominator; no textual repair
plan is a runtime pass. The package has not run any human candidate.
