# Multi-file real-fault diagnostic viewer

Builds an offline page over the exact before-only catalog used by the v2 agent
experiment. It bundles, without editing, the pure API in
`tools/research/repair-study-v2/query.mjs` and its natural-diagnostic dependency.
Both source hashes and the catalog hash appear in the render receipt.

```bash
python3 tools/research/repair-study-viewer/build.py --catalog out/research/repair-v2-study/frozen/catalog-before.json
python3 tools/research/repair-study-viewer/check.py web/research/repair-study-v2/index.html --output web/research/repair-study-v2/browser-check.json --screenshot web/research/repair-study-v2/preview.png
```

The page retains every supplied file, the original IDs/parameters, source hashes,
observation hashes, factual grouping, source-link provenance and numeric evidence.
It does not guess root-cause source links or draw an unmeasured event timeline.
Complete Triton output arrays are paginated; Liger bounded samples are explicitly
labeled, with full-array check counts retained in raw evidence. The model study froze numeric JSON through JavaScript serialization: `-0` may
therefore appear as `0` in numeric fields and grouping. Recorded output bytes
remain intact and are the source for signed-zero distinctions. The page uses
the identical frozen catalog; it does not silently restore numeric signs.

Final candidate outcomes can be loaded with the file input, or bundled using
`build.py --outcomes /path/to/outcomes.json`:

```json
{
  "format": "repair-study-viewer-outcomes-v1",
  "catalogSha256": "64 lowercase hex characters matching the catalog",
  "rows": [
    {
      "taskId": "catalog task ID",
      "condition": "raw",
      "repeat": 1,
      "status": "failed",
      "passedCases": 0,
      "totalCases": 1,
      "wallSeconds": 1.0,
      "sourceSha256": "candidate SOURCE TREE hash, not a single source-file hash",
      "validationSha256": "hash of the actual independent validation receipt"
    }
  ]
}
```

Statuses: `passed`, `failed`, `compile_failed`, `timeout`, `invalid`, `not_run`.
`passed` requires a positive complete pass count and two 64-character hashes.
Duplicate `(taskId,condition,repeat)` rows and mismatched catalogs are rejected.
This validates the import structure, not receipt authenticity or GPU execution;
those are checked by the experiment pipeline. A generated patch alone must not
be entered as `passed`. The UI identifies the candidate hash as a source-tree
hash. Browser import tests use explicitly synthetic transient fixtures only.

The page is separate from `web/research/human-study/`; it does not collect or
simulate human results and is not the participant interface for a formal study.
