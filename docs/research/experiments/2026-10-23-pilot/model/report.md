# Synthetic model experiment report

Provenance: **synthetic-model**. Generated 2026-10-23T07:37:01.000Z.

These are bounded executable model checks, not GPU hardware measurements, real defect discovery, AI output evaluation, or a human study. E2 tests preservation of already specified diagnostic witnesses, not discovery of new violations.

Status: **passed**; 0 failures retained. Corpus: 26 correspondence cases and 6 slicing cases; **0 independently observed real GPU bugs**. Template labels and family/split breakdowns are in results.json. All fixtures were developed during this implementation pilot; validation labels do not designate a frozen, independent holdout.

## E1: atomic correspondence

| Method | Cases evaluated / total | Precision | Recall | Actual-version accuracy |
| --- | ---: | ---: | ---: | ---: |
| source | 26 / 26 | 0.8616 | 0.9716 | 1.0000 |
| region | 26 / 26 | 0.8150 | 1.0000 | 1.0000 |
| semantic-scan | 26 / 26 | 1.0000 | 1.0000 | 1.0000 |
| semantic-fixed-axis | 26 / 26 | 1.0000 | 1.0000 | 1.0000 |
| semantic | 26 / 26 | 1.0000 | 1.0000 | 1.0000 |

Source, region and semantic use a conventional interval prefilter with a per-group axis choice; semantic-fixed-axis always indexes the first axis; semantic-scan uses the same semantic constraints with pairwise scanning. These implementation optimizations are not novelty claims. All modes share the same run-identity checks. Precision/recall use deduplicated (left node, right node, integer coordinate) relations from an independently enumerated oracle; empty denominators are null/n/a. Actual-version classification is evaluated only on correctly paired atoms; unmatched atoms are included in correspondence recall. Logical element and per-side coverage, unknown mappings, false-certainty counts, and raw outputs are retained per case.

## E2: specified witness preservation

| Method | Complete witness cases / eligible | Required evidence retained | Median node fraction | Median edge fraction |
| --- | ---: | ---: | ---: | ---: |
| full | 5 / 5 | 1.0000 | 1.0000 | 1.0000 |
| data-ancestors | 1 / 5 | 0.5000 | 0.4000 | 0.3333 |
| evidence | 5 / 5 | 1.0000 | 0.8000 | 1.0000 |

Nodes, edges, obligations, obligation statuses, positive evidence records, and unknown boundaries are scored separately. Unknown references must survive in both slice metadata and evidence records. The complete-witness denominator excludes cases with no supplied diagnostic obligation. Data-ancestor slicing is an intentionally limited baseline, not a validated explanation. JSON bytes include metadata; they are not memory usage.

## E7: CPU analysis cost

5 warmup calls then 30 samples per case and method; method order is deterministically shuffled. Durations are host wall time of the core function only, excluding oracle scoring, JSON serialization, and filesystem I/O. These are warm calls on reused in-memory input, not cold queries or GPU timings. Individual cases contain all samples and interpolated p50/p95.

| Experiment / method | Median of case medians (ms) | P95 of case medians (ms) |
| --- | ---: | ---: |
| E1 / source | 0.0045 | 0.0088 |
| E1 / region | 0.0043 | 0.0086 |
| E1 / semantic-scan | 0.0042 | 0.0084 |
| E1 / semantic-fixed-axis | 0.0046 | 0.0091 |
| E1 / semantic | 0.0050 | 0.0098 |
| E2 / full | 0.0338 | 0.0424 |
| E2 / data-ancestors | 0.0256 | 0.0316 |
| E2 / evidence | 0.0357 | 0.0449 |
| E7 / source | 0.1312 | 0.9258 |
| E7 / region | 0.1107 | 0.7697 |
| E7 / semantic-scan | 1.4424 | 40.0994 |
| E7 / semantic-fixed-axis | 0.2616 | 26.2430 |
| E7 / semantic | 0.1907 | 1.3377 |
| E7 / full | 0.1375 | 0.6768 |
| E7 / data-ancestors | 0.0452 | 0.1556 |
| E7 / evidence | 0.0515 | 0.1587 |

The table below reports each scaling input separately. E7 scale instances are excluded from E1/E2 accuracy denominators; their independently checked correctness summaries and raw timings remain in per-case JSON.

| Function / method | Distribution | Input nodes | Median (ms) | P95 (ms) |
| --- | --- | ---: | ---: | ---: |
| correspondence / source | disjoint-first-axis | 32 | 0.0599 | 0.0731 |
| correspondence / region | disjoint-first-axis | 32 | 0.0552 | 0.0654 |
| correspondence / semantic-scan | disjoint-first-axis | 32 | 0.0797 | 0.1107 |
| correspondence / semantic-fixed-axis | disjoint-first-axis | 32 | 0.0694 | 0.0826 |
| correspondence / semantic | disjoint-first-axis | 32 | 0.0691 | 0.1880 |
| correspondence / source | overlapping-first-axis | 32 | 0.0376 | 0.0468 |
| correspondence / region | overlapping-first-axis | 32 | 0.0339 | 0.0412 |
| correspondence / semantic-scan | overlapping-first-axis | 32 | 0.0592 | 0.0762 |
| correspondence / semantic-fixed-axis | overlapping-first-axis | 32 | 0.0632 | 0.0709 |
| correspondence / semantic | overlapping-first-axis | 32 | 0.0504 | 0.0923 |
| correspondence / source | disjoint-first-axis | 128 | 0.0522 | 0.0558 |
| correspondence / region | disjoint-first-axis | 128 | 0.0426 | 0.0479 |
| correspondence / semantic-scan | disjoint-first-axis | 128 | 0.2063 | 0.3721 |
| correspondence / semantic-fixed-axis | disjoint-first-axis | 128 | 0.0768 | 0.0855 |
| correspondence / semantic | disjoint-first-axis | 128 | 0.0771 | 0.0843 |
| correspondence / source | overlapping-first-axis | 128 | 0.0521 | 0.0576 |
| correspondence / region | overlapping-first-axis | 128 | 0.0423 | 0.0530 |
| correspondence / semantic-scan | overlapping-first-axis | 128 | 0.2160 | 0.3245 |
| correspondence / semantic-fixed-axis | overlapping-first-axis | 128 | 0.2206 | 0.3177 |
| correspondence / semantic | overlapping-first-axis | 128 | 0.0768 | 0.1135 |
| correspondence / source | disjoint-first-axis | 512 | 0.2024 | 0.2162 |
| correspondence / region | disjoint-first-axis | 512 | 0.1662 | 0.3796 |
| correspondence / semantic-scan | disjoint-first-axis | 512 | 2.6689 | 2.9650 |
| correspondence / semantic-fixed-axis | disjoint-first-axis | 512 | 0.3026 | 0.3105 |
| correspondence / semantic | disjoint-first-axis | 512 | 0.3044 | 0.3095 |
| correspondence / source | overlapping-first-axis | 512 | 0.2069 | 0.2143 |
| correspondence / region | overlapping-first-axis | 512 | 0.1716 | 0.1861 |
| correspondence / semantic-scan | overlapping-first-axis | 512 | 2.7270 | 3.0117 |
| correspondence / semantic-fixed-axis | overlapping-first-axis | 512 | 2.8233 | 3.1411 |
| correspondence / semantic | overlapping-first-axis | 512 | 0.3097 | 0.3337 |
| correspondence / source | disjoint-first-axis | 2048 | 0.9120 | 1.2771 |
| correspondence / region | disjoint-first-axis | 2048 | 0.7613 | 1.1957 |
| correspondence / semantic-scan | disjoint-first-axis | 2048 | 41.1128 | 43.2085 |
| correspondence / semantic-fixed-axis | disjoint-first-axis | 2048 | 1.3273 | 1.8123 |
| correspondence / semantic | disjoint-first-axis | 2048 | 1.3240 | 1.7449 |
| correspondence / source | overlapping-first-axis | 2048 | 0.9333 | 1.4886 |
| correspondence / region | overlapping-first-axis | 2048 | 0.7743 | 1.3225 |
| correspondence / semantic-scan | overlapping-first-axis | 2048 | 38.2173 | 44.2538 |
| correspondence / semantic-fixed-axis | overlapping-first-axis | 2048 | 38.8536 | 48.2309 |
| correspondence / semantic | overlapping-first-axis | 2048 | 1.3451 | 2.2144 |
| slicing / full | fixed-witness-plus-disconnected-nodes | 21 | 0.0360 | 0.0396 |
| slicing / data-ancestors | fixed-witness-plus-disconnected-nodes | 21 | 0.0220 | 0.0282 |
| slicing / evidence | fixed-witness-plus-disconnected-nodes | 21 | 0.0289 | 0.0329 |
| slicing / full | fixed-witness-plus-disconnected-nodes | 69 | 0.0704 | 0.1087 |
| slicing / data-ancestors | fixed-witness-plus-disconnected-nodes | 69 | 0.0302 | 0.0649 |
| slicing / evidence | fixed-witness-plus-disconnected-nodes | 69 | 0.0368 | 0.0681 |
| slicing / full | fixed-witness-plus-disconnected-nodes | 261 | 0.2047 | 0.2166 |
| slicing / data-ancestors | fixed-witness-plus-disconnected-nodes | 261 | 0.0603 | 0.0757 |
| slicing / evidence | fixed-witness-plus-disconnected-nodes | 261 | 0.0662 | 0.0812 |
| slicing / full | fixed-witness-plus-disconnected-nodes | 1029 | 0.7602 | 0.9527 |
| slicing / data-ancestors | fixed-witness-plus-disconnected-nodes | 1029 | 0.1724 | 0.2468 |
| slicing / evidence | fixed-witness-plus-disconnected-nodes | 1029 | 0.1751 | 0.1827 |

Quantiles across cases do not express independent statistical replications or confidence intervals. No performance speedup claim is made. Source hashes, git state, CPU/Node identity, configuration, inputs, per-case errors, and raw samples are retained in this output directory.

## Failures

None.
