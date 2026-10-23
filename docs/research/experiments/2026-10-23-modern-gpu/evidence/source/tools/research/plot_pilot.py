#!/usr/bin/env python3
"""Plot retained pilot measurements; never synthesize missing study results."""
import argparse
import hashlib
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.colors import ListedColormap
import numpy as np


def load(path):
    raw = path.read_bytes()
    return json.loads(raw), {"file": path.name, "sha256": hashlib.sha256(raw).hexdigest()}


def save(fig, output, name):
    for ext in ("pdf", "svg", "png"):
        path = output / f"{name}.{ext}"
        fig.savefig(path, dpi=180, bbox_inches="tight")
        if ext == "svg":
            path.write_text("\n".join(line.rstrip() for line in path.read_text().splitlines()) + "\n")
    plt.close(fig)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cuda", type=Path, required=True)
    parser.add_argument("--library", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    data, source = load(args.cuda)
    if data.get("status") != "completed":
        raise SystemExit("Refusing to plot an incomplete CUDA run as a completed pilot")
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    plt.rcParams.update({"font.size": 9, "axes.spines.top": False, "axes.spines.right": False,
                         "pdf.fonttype": 42, "svg.fonttype": "none"})

    # Fixed declared case and seed, not selected by largest measured error.
    shape = [17, 19, 23]
    seed = 20261023
    candidates = ["baseline", "tiled", "tail_bug"]
    rows = []
    for candidate in candidates:
        matches = [row for row in data["verification"]
                   if row["shape_mnk"] == shape and row["seed"] == seed and row["candidate"] == candidate]
        if len(matches) != 1:
            raise SystemExit(f"Expected one fixed heatmap case for {candidate}, found {len(matches)}")
        rows.append(matches[0])
    fig, axes = plt.subplots(1, 3, figsize=(7.1, 2.8), sharex=True, sharey=True, layout="constrained")
    color = ListedColormap(["#edf1f4", "#a82532"])
    for ax, row, title in zip(axes, rows, ["Naive CUDA kernel", "Shared-memory tiling", "Injected missing tail writes"]):
        verdict = row["verdict"]
        matrix = np.asarray(verdict["violation_matrix"], dtype=int)
        if matrix.shape != (shape[0], shape[1]):
            raise SystemExit(f"Unexpected heatmap shape: {matrix.shape}")
        if int(matrix.sum()) != verdict["violations"]:
            raise SystemExit("Heatmap disagrees with recorded violation count")
        ax.imshow(matrix, cmap=color, vmin=0, vmax=1, interpolation="nearest", origin="upper")
        ax.set_title(f"{title}\n{int(matrix.sum())}/{matrix.size} failed elements", fontsize=9)
        ax.set_xlabel("Output column")
        ax.set_xticks([0, 8, 18])
        ax.set_yticks([0, 8, 16])
    axes[0].set_ylabel("Output row")
    fig.suptitle("Measured numerical checks: M=17, N=19, K=23 (FP32, SM89)", fontsize=11)
    save(fig, output, "cuda-error-map")

    benchmark = data["benchmark"]
    if not benchmark:
        raise SystemExit("No benchmark samples; no performance plot generated")
    labels, ratios, intervals = [], [], []
    for row in benchmark:
        if not all(row["correctness_gates"].values()):
            raise SystemExit("A benchmark failed its recorded correctness gate")
        samples = row["samples"]
        a = np.asarray([s["baseline_ms"] for s in samples])
        b = np.asarray([s["tiled_ms"] for s in samples])
        if np.any(a <= 0) or np.any(b <= 0) or not np.isfinite(a).all() or not np.isfinite(b).all():
            raise SystemExit("Nonpositive/nonfinite raw timing")
        stat = row["statistics"]
        ratio = float(a.mean() / b.mean())
        if not np.isclose(ratio, stat["speedup_ratio_of_paired_means"], rtol=1e-10):
            raise SystemExit("Summary speedup disagrees with retained raw timings")
        labels.append("×".join(str(v) for v in row["shape_mnk"]))
        ratios.append(ratio)
        intervals.append(stat["paired_bootstrap_ci95"])
    fig, ax = plt.subplots(figsize=(7.1, 3.2), layout="constrained")
    x = np.arange(len(labels))
    ratios, intervals = np.asarray(ratios), np.asarray(intervals)
    # Draw intervals explicitly: percentile intervals need not contain estimates.
    ax.vlines(x, intervals[:, 0], intervals[:, 1], color="#245b89", linewidth=1.5)
    ax.scatter(x, ratios, color="#245b89", marker="D", s=30, zorder=3)
    ax.axhline(1, color="#555555", linestyle="--", linewidth=1)
    ax.set_xticks(x, labels, rotation=25, ha="right")
    ax.set_ylabel("Naive / tiled mean time (×)")
    ax.set_xlabel("M × N × K; resident repeated inputs")
    ax.set_ylim(bottom=0)
    ax.grid(axis="y", alpha=0.2)
    ax.set_title("SM89 pilot: tiling benefit varies across shapes")
    save(fig, output, "cuda-tiling-speedup")

    library_source = None
    if args.library:
        library, library_source = load(args.library)
        if library.get("status") != "completed":
            raise SystemExit("Incomplete library comparison")
        fig, ax = plt.subplots(figsize=(7.1, 3.2), layout="constrained")
        labels = []
        for i, row in enumerate(library["benchmark"]):
            if row["candidate_a"] != "tiled" or row["candidate_b"] != "cublas" or not all(row["correctness_gates"].values()):
                raise SystemExit("Unexpected library comparison or failed correctness gate")
            a = np.array([sample["tiled_ms"] for sample in row["samples"]])
            b = np.array([sample["cublas_ms"] for sample in row["samples"]])
            ratio = float(a.mean() / b.mean())
            if not np.isclose(ratio, row["statistics"]["speedup_ratio_of_paired_means"], rtol=1e-10):
                raise SystemExit("Library summary disagrees with raw timings")
            low, high = row["statistics"]["paired_bootstrap_ci95"]
            ax.vlines(i, low, high, color="#77539b", linewidth=1.5)
            ax.scatter(i, ratio, color="#77539b", marker="s", s=30, zorder=3)
            labels.append("×".join(str(v) for v in row["shape_mnk"]))
        ax.axhline(1, color="#555555", linestyle="--", linewidth=1)
        ax.set_xticks(range(len(labels)), labels, rotation=25, ha="right")
        ax.set_ylabel("Tiled / cuBLAS mean time (×)")
        ax.set_xlabel("M × N × K; ratio > 1 favors cuBLAS")
        ax.set_ylim(bottom=0)
        ax.grid(axis="y", alpha=0.2)
        ax.set_title("Strong baseline: cuBLAS SGEMM with pedantic FP32 math")
        save(fig, output, "cuda-library-comparison")

    contract = {
        "stage": "internal pilot, not submission-ready evidence",
        "target": "VIS/TVCG or CHI/TOCHI; neutral quantitative style",
        "community": "visual analytics / human-computer interaction, GPU tooling secondary",
        "source": source,
        "library_source": library_source,
        "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "formats": ["pdf", "svg", "png"], "width_inches": 7.1,
        "heatmap": {"role": "validation", "selection": {"shape_mnk": shape, "seed": seed},
                    "encoding": "binary numerical-check violation, red=failed; not absolute error magnitude",
                    "note": "Nonfinite poisoned outputs count as failed; these are intentionally injected missing writes."},
        "performance": {"role": "boundary", "scope": "CUDA event interval per launch, repeated resident inputs",
                        "estimate": "ratio of paired sample means",
                        "interval": "95% paired bootstrap, within one device session only",
                        "baseline": "experiment-authored naive FP32 kernel; not cuBLAS",
                        "selection": "all benchmark configurations, including regressions"},
        "missing_evidence": ["SM100/TMA/tcgen05", "model-level speedup", "human understanding", "formal correctness"],
    }
    (output / "figure-provenance.json").write_text(json.dumps(contract, indent=2) + "\n")
    (output / "captions.md").write_text(
        "# Pilot figure captions\n\n"
        "**Numerical-check map.** Each cell is one measured output element for the fixed 17×19×23 GEMM "
        "and seed 20261023. Red indicates a tolerance failure or nonfinite output against an independent "
        "CPU double-precision reference; gray indicates a pass. The tail-write fault was deliberately injected. "
        "This plot shows failure locations, not error magnitudes or a GPU memory-race trace.\n\n"
        "**Tiling performance.** Every tested timing configuration is shown. Diamonds are naive/tiled ratios "
        "of mean times over 30 randomized balanced AB/BA sample pairs, each containing 30 launches after warmup. "
        "Lines are the recorded 95% paired bootstrap intervals. Values below one are regressions. Timing "
        "uses CUDA events with repeated resident inputs and excludes transfers and compilation; intervals "
        "describe this session, not other devices or applications. The comparator is an experiment-authored "
        "naive kernel, not an optimized library. No user-study result is implied.\n\n"
        "**Library comparison (when supplied).** Squares are tiled/cuBLAS ratios of paired means, so "
        "values above one favor cuBLAS. The library uses SGEMM with CUBLAS_PEDANTIC_MATH and "
        "CUBLAS_ATOMICS_NOT_ALLOWED; all candidates pass the same finite numerical checks. "
        "Every library timing configuration is shown with its within-session paired bootstrap interval.\n", encoding="utf-8")
    print(output.resolve())


if __name__ == "__main__":
    main()
