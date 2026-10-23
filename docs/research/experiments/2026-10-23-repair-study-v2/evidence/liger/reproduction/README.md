# Three natural Liger faults: exact source, GPU outputs, independent oracle

The cases are PolyNorm low-precision reduction (upstream PR 1540), sparsemax
translation stability (1545), and selective-log-softmax independent ID/mask
strides (1461). `source-manifest.json` identifies each actual merge parent and
merged source archive. This is real unmodified upstream code before/after,
imported through the normal package, not a rewritten stand-in kernel.

This phase tests forward numerical contracts on the locally reported RTX 4090,
SM89, PyTorch 2.7.1+cu126 and an isolated official Triton 3.8.0 wheel. It does not
test complete model training, gradients, all package operators, performance,
or Hopper/Blackwell synchronization. The existing physical H100/B200 evidence
is separate. Driver/device output, imported source hashes, native compiler SHA,
complete buffers and compiler text are retained in every successful run.

`prepare.py` fixes 56 cases: 18 PolyNorm, 17 sparsemax, 21 selective-log-softmax.
The visible/hidden split is 16/40. `run.py` retains original represented inputs,
outputs, references and before/after input copies. `verify.py` independently
recomputes float64 CPU oracles, validates exact case identities, frozen input
identities and strides, output shape/dtype, nonfinite and wrong-element counts,
and all retained compiler-text hashes. Tolerances are fixed in `plan.json`.
The independent review additionally reimplemented the mathematical references
with alternative algorithms. Input mutation and coherent input/reference
rewrites are rejected against a separately frozen manifest.

The final `controls-v2` record passes are before 12/18, 9/17, 6/21 and gold
18/18, 17/17, 21/21. There are 307,219 output elements per version. Earlier
screening/capture controls remain in the archive and are not extra defects.

```sh
python3 -m unittest discover -s tools/research/liger-faults -p 'test*.py'
python3 tools/research/liger-faults/verify.py --help
python3 tools/research/liger-faults/evaluate_candidate.py \
  --candidate out/research/repair-v2-study/trials/TRIAL/candidate.json \
  --output out/research/liger-faults/candidate-evaluations/TRIAL
python3 tools/research/liger-faults/publish.py --output NEW_EMPTY_DIRECTORY
```

The evaluator's default Python path is the authorized local runtime and can be
overridden with `--python`. Restore source archives from the recorded GitHub
commits, or use retained exact `src/` source. Restore the isolated official
Triton wheel at the recorded `runtime-before` path; do not overwrite another
project's environment. Runtime/native differences constitute a new experiment.

Every supplied implementation file is editable: 42 files for PolyNorm and
sparsemax, 41 for selective-log-softmax. A candidate is applied verbatim as a
complete file tree, with the same Node locale ordering used by the study.
Only after all model calls finish does the evaluator execute all cases. It
does not repair malformed patches, retry failed model answers, or feed hidden
results back to the model. `buildStatus=passed` alone does not imply numerical
correctness; the frozen hidden endpoint and visible regression checks are
reported separately. Validation wall time excludes source overlay preparation
and includes imports/JIT/CPU analysis; it is not an operator benchmark.

Before sharing, `publish.py` selects full numerical evidence and source while
omitting wheels, duplicated checkouts, caches and native ELF/cubin bytes. Use
`archive-modern-evidence.py` for lossless compression, hash verification and
extraction. Original runtime/source receipts retain omitted binary identities.
Public source recognizability and model training inclusion are unknown.
