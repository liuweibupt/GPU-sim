# Natural-fault interactive diagnostic

The generated [viewer](../../../web/research/natural-bugs/index.html) is self-contained and works offline. Under `npm start`, open `/web/research/natural-bugs/`. Its 108 saved calls comprise 76 CUTLASS invocations (72 ordinary runs and four memcheck invocations), plus 32 observed Triton cases (16 per compiler version). Plain, unobserved Triton control runs are retained in the original archive, not duplicated as viewer cases.

The page offers family/version/status filters, paired-version navigation, original-source search, source-bound static TMEM column intervals, a bounded overlap query, actual output inspection, raw record identities, and JSON export. CUTLASS exposes the first 16 decoded FP8 elements of each returned group and identifies that sample explicitly; full-output verification counts come from the existing retained byte verification. Triton retains every observed output element and shows them in pages of 64. Failed calls with no output display an unknown numerical result.

The TMEM visualization is a **static compiler allocation view**, not a hardware timeline. Overlap is recomputed from allocation/store/select/load statements in the supplied fixed straight-line IR. It does not establish arbitrary alias analysis, sampled memory ordering, or general detection accuracy. CUTLASS source anchors are inspection entry points; the captures do not establish a dynamically sampled blocked instruction. The independent β=1 control failure remains visible separately from the β=0 zero-K timeout.

## Rebuild and verify

No restored `out/` tree, GPU, cloud account, or model is required. The builder reads the previously frozen repository archive directly and validates stored and decoded hashes for every input it uses.

```bash
python tools/research/natural-diagnostic/build.py
python tools/research/natural-diagnostic/render.py
node --test tests/natural-diagnostic.test.mjs
python tools/research/natural-diagnostic/check.py web/research/natural-bugs/index.html \
  --output web/research/natural-bugs/browser-check.json \
  --screenshot web/research/natural-bugs/viewer.png
```

The build manifest binds the original archive, 1,313 read source/record/output artifacts, full dataset, and benchmark projection. The render manifest binds HTML, data, renderer, UI, style, and shared query implementation. Browser checks use actual headless Chrome, including filters, cases, paired-version navigation, source links/search, first/second/last output pages, exports, and the download handler. They verify interface bindings against the saved evidence, not scientific effectiveness or human comprehension.

## Shared pure query interface

```js
import {queryDiagnostic} from '../../../lib/research/natural-diagnostic.js';
const result = queryDiagnostic(data, {op: 'overlap', id: 'case-24'});
```

The `query` alias is identical. Queries return deep copies and have no filesystem, shell, network, or mutation capability. The schema is `natural-gpu-diagnostic-v1`, with `scope`, `cases`, `sources`, `evidence`, and `limits`.

| Operation | Request fields | Result |
|---|---|---|
| `cases` / `list_cases` | optional `family`, `version`, `status`, `parameters` exact filters | Matching case records |
| `case` | `id` | Case and all its supplied evidence |
| `evidence` | `id` | One supplied evidence record |
| `source` | `id`; optional one-based `start`, `end`, literal `search` | Source text window, complete-source hash, matching line numbers |
| `overlap` | case `id` | MLIR allocations/stores/selects/loads and possible selected-source interval intersections, with raw source hashes and line references |
| `contrast` | optional case filters; `groupBy` array | Descriptive counts by fields/parameters; `hasZeroK` is computed from the K list |

```bash
node tools/research/natural-diagnostic/query.mjs \
  tools/research/natural-diagnostic/benchmark-before.json \
  '{"op":"contrast","family":"cutlass","groupBy":["beta","hasZeroK"]}'
```

## Separation from the agent comparison

`benchmark-before.json` is a separate **before-only** projection with 40 input cases (24 CUTLASS and 16 Triton). It retains identical original input source text and observations, but replaces source/record identities with neutral names and omits issue links, commits, later versions, repair patches, saved diagnosis labels, and repair outcomes. Its sources include the complete input `collective.hpp`, complete input `TensorMemoryAllocation.cpp`, and seven observed post-allocation MLIR files. Every variant is named `input`.

Both agent conditions must receive the **same** before-only original facts. Plain-read operations are `cases`, `case`, `evidence`, and `source`; diagnostic operations additionally derive `overlap` and `contrast` from those facts. Every derived candidate/group has raw references. The shared module never loads the full viewer dataset. The optional mapping back to original archive identities lives only in the full build manifest, outside the agent input.

The original public faults have already informed development of this tool. They are not unknown held-out faults. This comparison can measure bounded agent localization/patch behavior; it cannot establish visual interaction benefits, human understanding, or replacement of human participants. Repeated calls are not additional independent bug families.

**Frozen evaluation input hashes:**

- `benchmark-before.json`: `19d9ada359dc832e479e89fba421033dabdeedf10624867e64109f285dfddcb1`
- `lib/research/natural-diagnostic.js`: `233b4e99180b36d7aa01ded58329ac1bd0e40f070fc247f13f2469df6fc6c370`

The model-execution/evaluation runner and its results are maintained separately under `tools/research/natural-repair-eval/`.
