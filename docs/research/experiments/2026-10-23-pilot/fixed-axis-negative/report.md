# Synthetic model experiment report

Provenance: **synthetic-model**. Generated 2026-10-23T07:25:57.714Z.

These are bounded executable model checks, not GPU hardware measurements, real defect discovery, AI output evaluation, or a human study. E2 tests preservation of already specified diagnostic witnesses, not discovery of new violations.

Status: **passed**; 0 failures retained. Corpus: 26 correspondence cases and 6 slicing cases; **0 independently observed real GPU bugs**. Template labels and family/split breakdowns are in results.json. All fixtures were developed during this implementation pilot; validation labels do not designate a frozen, independent holdout.

## E1: atomic correspondence

| Method | Cases evaluated / total | Precision | Recall | Actual-version accuracy |
| --- | ---: | ---: | ---: | ---: |
| source | 26 / 26 | 0.8616 | 0.9716 | 1.0000 |
| region | 26 / 26 | 0.8150 | 1.0000 | 1.0000 |
| semantic | 26 / 26 | 1.0000 | 1.0000 | 1.0000 |
| semantic-scan | 26 / 26 | 1.0000 | 1.0000 | 1.0000 |

Source, region and semantic use a conventional interval prefilter; semantic-scan uses the same semantic constraints with pairwise scanning. This implementation optimization is not a novelty claim. All modes share the same run-identity checks. Precision/recall use deduplicated (left node, right node, integer coordinate) relations from an independently enumerated oracle; empty denominators are null/n/a. Actual-version classification is evaluated only on correctly paired atoms; unmatched atoms are included in correspondence recall. Logical element and per-side coverage, unknown mappings, false-certainty counts, and raw outputs are retained per case.

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
| E1 / source | 0.0063 | 0.0134 |
| E1 / region | 0.0060 | 0.0127 |
| E1 / semantic | 0.0075 | 0.0150 |
| E1 / semantic-scan | 0.0068 | 0.0139 |
| E2 / full | 0.0383 | 0.0422 |
| E2 / data-ancestors | 0.0289 | 0.0354 |
| E2 / evidence | 0.0406 | 0.0448 |
| E7 / source | 2.2271 | 42.7745 |
| E7 / region | 2.0631 | 42.6235 |
| E7 / semantic | 2.2366 | 43.3609 |
| E7 / semantic-scan | 2.2018 | 42.7922 |
| E7 / full | 0.1484 | 0.7060 |
| E7 / data-ancestors | 0.0532 | 0.1627 |
| E7 / evidence | 0.0637 | 0.1734 |

The table below reports each scaling input separately. E7 scale instances are excluded from E1/E2 accuracy denominators; their independently checked correctness summaries and raw timings remain in per-case JSON.

| Function / method | Input nodes | Median (ms) | P95 (ms) |
| --- | ---: | ---: | ---: |
| correspondence / source | 32 | 0.0506 | 0.0693 |
| correspondence / region | 32 | 0.0461 | 0.3063 |
| correspondence / semantic | 32 | 0.0612 | 0.0715 |
| correspondence / semantic-scan | 32 | 0.0591 | 0.3885 |
| correspondence / source | 128 | 0.2804 | 0.5165 |
| correspondence / region | 128 | 0.2646 | 0.4983 |
| correspondence / semantic | 128 | 0.3262 | 0.6512 |
| correspondence / semantic-scan | 128 | 0.3159 | 0.6475 |
| correspondence / source | 512 | 4.1738 | 4.4650 |
| correspondence / region | 512 | 3.8616 | 4.2486 |
| correspondence / semantic | 512 | 4.1469 | 4.7169 |
| correspondence / semantic-scan | 512 | 4.0877 | 4.5466 |
| correspondence / source | 2048 | 49.5864 | 57.9749 |
| correspondence / region | 2048 | 49.4638 | 57.9566 |
| correspondence / semantic | 2048 | 50.2810 | 60.1744 |
| correspondence / semantic-scan | 2048 | 49.6224 | 57.6716 |
| slicing / full | 21 | 0.0691 | 0.0720 |
| slicing / data-ancestors | 21 | 0.0431 | 0.0542 |
| slicing / evidence | 21 | 0.0561 | 0.1062 |
| slicing / full | 69 | 0.0761 | 0.1027 |
| slicing / data-ancestors | 69 | 0.0333 | 0.0351 |
| slicing / evidence | 69 | 0.0406 | 0.0496 |
| slicing / full | 261 | 0.2207 | 0.2832 |
| slicing / data-ancestors | 261 | 0.0632 | 0.0786 |
| slicing / evidence | 261 | 0.0712 | 0.0750 |
| slicing / full | 1029 | 0.7916 | 1.0579 |
| slicing / data-ancestors | 1029 | 0.1803 | 0.5590 |
| slicing / evidence | 1029 | 0.1914 | 0.2033 |

Quantiles across cases do not express independent statistical replications or confidence intervals. No performance speedup claim is made. Source hashes, git state, CPU/Node identity, configuration, inputs, per-case errors, and raw samples are retained in this output directory.

## Failures

None.
