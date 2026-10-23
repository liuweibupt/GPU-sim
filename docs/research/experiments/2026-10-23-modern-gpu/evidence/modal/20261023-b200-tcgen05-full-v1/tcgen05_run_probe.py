#!/usr/bin/env python3
"""Bounded local/allocated-GPU tcgen05 suite; this script never allocates cloud GPUs."""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import itertools
import json
from pathlib import Path
import re
import subprocess
import time

from tcgen05_validate import validate

SOURCE = Path(__file__).with_name("tcgen05_probe.cu")
VALIDATOR = Path(__file__).with_name("tcgen05_validate.py")
VARIANTS = ("correct", "wrong-version", "fixed")
CONFIGS = ((0, 0), (7, 2**53), (65535, 2**64 - 128))


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def contract(source):
    return {
        "id": "tcgen05-probe-v1", "shape_mnk": [128, 32, 16], "dtype": "f16xf16-f32",
        "cta_count": 1, "threads": 128, "tmem_columns": 32,
        "input_layout": "GMEM A[input,row,k] and B[column,k] packed into FP16 K-major interleaved SMEM; LBO128B/SBO256B, no swizzle.",
        "operation": "One tcgen05.mma.cta_group::1.kind::f16 per iteration, input-D disabled, exact small-integer operands.",
        "full_generation": "uint64 tag actually loaded from selected input_tags on device; decimal strings in JSON preserve >2^53. Source-bound metadata associated with selected A, not hardware generation state or transported MMA payload.",
        "barrier_generation": "Software loop ordinal, independent from input value generation; barrier parity = ordinal mod 2. Not decoded from opaque mbarrier state.",
        "fault": "Controlled source selector chooses expected_input-2, so parity matches while full generation differs. Legal memory/synchronization; not a race or natural AI-generated defect.",
        "repair": "Same old candidate; compare its full loaded tag with required generation, then select current input when unequal.",
        "ordering": [
            "Barrier init and fence.mbarrier_init.release.cluster before CTA publication.",
            "Every SMEM writer executes async proxy fence; CTA barrier and tcgen05 fence-after precede MMA issue.",
            "Issuing thread performs full tcgen05.commit; no sync_restrict shared-read-only completion.",
            "Every thread loops on mbarrier.try_wait.parity.acquire until true, then tcgen05 fence-after. Four warp leaders log post-success observations.",
            "Every warp collectively loads its 32 TMEM rows, with tcgen05.wait::ld after each column load. Leaders log actual first-column register value.",
            "tcgen05 fence-before and CTA reader barrier precede reuse_ready, next MMA and deallocation.",
            "No HB is inferred merely from event array offsets, clocks, opcode adjacency or missing records."],
        "completion_domains": ["commit_issued", "producer_result_ready", "reader_done", "reuse_ready"],
        "watchdog": "2e9 device clock cycles inside wait; 120s outer command timeout. No performance interpretation.",
        "references": [
            "https://docs.nvidia.com/cuda/parallel-thread-execution/index.html#tcgen05-instructions",
            "https://github.com/NVIDIA/cutlass/blob/91843b71d90737e0a9b86f7d9df213cff5a3526f/examples/cute/tutorial/blackwell/01_mma_sm100.cu",
            "https://github.com/NVIDIA/cutlass/blob/91843b71d90737e0a9b86f7d9df213cff5a3526f/include/cute/arch/mma_sm100_desc.hpp"],
        "limitations": ["Fixed tiny GEMM; no arbitrary shapes or throughput claim.",
                        "One CTA and SM100a only; no TMA, cluster multicast, concurrent producer/consumer overlap, or partial shared-read commit.",
                        "Instrumented authored experiment, not generic trace reconstruction or independent ISA semantic verification.",
                        "Full generations originate in source-bound software metadata; sanitizers do not prove all hardware protocol properties.",
                        "No AI provenance, natural bug-discovery, or human-understanding study claim."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--cuda-root", type=Path, default=Path("/usr/local/cuda"))
    parser.add_argument("--compile-only", action="store_true")
    parser.add_argument("--skip-sanitizers", action="store_true")
    parser.add_argument("--smoke", action="store_true", help="one iteration/seed, all three variants")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    for path in (SOURCE, VALIDATOR, Path(__file__)):
        (output / path.name).write_bytes(path.read_bytes())
    source_text = (output / SOURCE.name).read_text()
    summary = {"format": "tcgen05-probe-suite-v1", "status": "preparing",
        "started_utc": datetime.now(timezone.utc).isoformat(),
        "source_hashes": {p.name: digest(p) for p in (SOURCE, VALIDATOR, Path(__file__))},
        "scope": "compile-only" if args.compile_only else "smoke" if args.smoke else "full-suite",
        "measurement_claim": "Numerical/source-contract validation; command wall seconds include orchestration and are not a GPU benchmark.",
        "commands": [], "runs": [], "sanitizers": [], "artifacts": {}}
    (output / "contract.json").write_text(json.dumps(contract(source_text), indent=2) + "\n")

    def save():
        (output / "summary.json").write_text(json.dumps(summary, indent=2, allow_nan=False) + "\n")

    def run(name, argv, allowed=(0,), timeout=120):
        before = time.monotonic()
        command = list(map(str, argv))
        timed_out = False
        try:
            result = subprocess.run(command, capture_output=True, timeout=timeout)
            stdout, stderr, code = result.stdout, result.stderr, result.returncode
        except subprocess.TimeoutExpired as error:
            stdout, stderr, code, timed_out = error.stdout or b"", error.stderr or b"", None, True
        paths = []
        for stream, raw in (("stdout", stdout), ("stderr", stderr)):
            path = output / f"{name}.{stream}.txt"
            path.write_bytes(raw)
            paths.append({"path": path.name, "sha256": digest(path), "bytes": len(raw)})
        summary["commands"].append({"name": name, "argv": command, "exit_code": code,
            "allowed_exit_codes": list(allowed), "timed_out": timed_out,
            "wall_seconds": time.monotonic() - before, "stdout": paths[0], "stderr": paths[1]})
        save()
        if timed_out or code not in allowed:
            raise RuntimeError(f"{name}: failed/timeout, raw logs preserved")
        return stdout, code

    def check_run(name, raw, code, expected_code):
        record = json.loads(raw)
        checked = validate(record, source_text)
        if code != expected_code:
            raise ValueError(f"{name}: unexpected controlled outcome")
        checked.update(name=name, exit_code=code, path=name + ".stdout.txt",
                       sha256=hashlib.sha256(raw).hexdigest(), bytes=len(raw))
        return checked

    try:
        nvcc = args.cuda_root / "bin/nvcc"
        run("nvcc-version", [nvcc, "--version"])
        binary, ptx = output / "tcgen05_probe", output / "tcgen05_probe.ptx"
        common = [nvcc, "-std=c++17", "-O3", "-lineinfo", "-arch=sm_100a"]
        run("compile", common + ["--ptxas-options=-v", output / SOURCE.name, "-o", binary], timeout=180)
        run("compile-ptx", common + ["--ptx", output / SOURCE.name, "-o", ptx], timeout=180)
        sass, _ = run("disassemble", [args.cuda_root / "bin/cuobjdump", "--dump-sass", binary])
        (output / "tcgen05_probe.sass").write_bytes(sass)
        required = ["tcgen05.mma.cta_group::1.kind::f16", "tcgen05.commit.cta_group::1.mbarrier::arrive::one",
                    "tcgen05.alloc", "tcgen05.dealloc", "tcgen05.ld.sync.aligned.32x32b", "tcgen05.wait::ld",
                    "mbarrier.try_wait.parity.acquire", "tcgen05.fence::before_thread_sync", "tcgen05.fence::after_thread_sync"]
        missing = [instruction for instruction in required if instruction not in ptx.read_text()]
        if missing:
            raise ValueError("PTX is missing required operations: " + ", ".join(missing))
        summary["static_isa_checks"] = {"required_ptx_present": required,
            "sass_present": [name for name in ("UTCHMMA", "UTCBAR", "LDTM", "UTCATOMSWS") if name.encode() in sass],
            "scope": "Static code presence only; dynamic behavior is checked by runtime outputs/events."}
        if args.compile_only:
            summary["status"] = "compiled-not-executed"
        else:
            run("gpu-identity", ["nvidia-smi", "--query-gpu=name,compute_cap,driver_version,memory.total", "--format=csv,noheader"])
            configurations = ((1, 7, 2**53),) if args.smoke else tuple(
                (iterations, seed, base) for iterations in (1, 2, 5, 17) for seed, base in CONFIGS)
            for iterations, seed, base in configurations:
                for variant in VARIANTS:
                    name = f"i{iterations}-s{seed}-{variant}"
                    expected_code = 2 if variant == "wrong-version" else 0
                    raw, code = run(name, [binary, iterations, seed, variant, base], allowed=(expected_code,))
                    summary["runs"].append(check_run(name, raw, code, expected_code))
                    save()
            if not args.skip_sanitizers:
                sanitizer = args.cuda_root / "bin/compute-sanitizer"
                run("sanitizer-version", [sanitizer, "--version"])
                for tool, variant in itertools.product(("memcheck", "racecheck", "initcheck", "synccheck"), VARIANTS):
                    name = f"sanitizer-{tool}-{variant}"
                    log = output / f"{name}.log"
                    expected_code = 2 if variant == "wrong-version" else 0
                    raw, code = run(name, [sanitizer, "--tool", tool, "--error-exitcode", 99,
                        "--log-file", log, binary, 3, 7, variant, 2**53], allowed=(expected_code, 99), timeout=120)
                    text = log.read_text() if log.exists() else ""
                    zero_errors = bool(re.search(r"(?:ERROR SUMMARY: 0 errors|RACECHECK SUMMARY: 0 hazards)", text))
                    unsupported = bool(re.search(r"not supported|unsupported|not instrumented|failed to attach", text, re.I))
                    entry = {"name": name, "tool": tool, "variant": variant, "exit_code": code,
                             "expected_exit_code": expected_code, "log": log.name,
                             "log_sha256": digest(log) if log.exists() else None,
                             "zero_error_summary_present": zero_errors, "unsupported_diagnostic_present": unsupported,
                             "clean": code == expected_code and zero_errors and not unsupported}
                    if code == expected_code:
                        entry["independent_validation"] = check_run(name, raw, code, expected_code)
                    summary["sanitizers"].append(entry)
                    save()
            summary["status"] = "completed" if all(r["clean"] for r in summary["sanitizers"]) else "sanitizer-failure-or-inconclusive"
            summary["totals"] = {"runs": len(summary["runs"]),
                "output_elements": sum(r["correctness"]["elements"] for r in summary["runs"]),
                "iterations": sum(r["iterations"] for r in summary["runs"]),
                "events": sum(r["events"] for r in summary["runs"]),
                "expected_value_mismatches": sum(r["correctness"]["expected_value_mismatches"] for r in summary["runs"]),
                "selected_source_mismatches": sum(r["correctness"]["selected_source_mismatches"] for r in summary["runs"]),
                "sanitizer_runs": len(summary["sanitizers"]), "sanitizer_clean": sum(r["clean"] for r in summary["sanitizers"])}
            with (output / "runs.csv").open("w", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=("name", "variant", "iterations", "seed", "generation_base", "elements", "expected_value_mismatches", "selected_source_mismatches", "version_mismatches", "events", "sha256"))
                writer.writeheader()
                for row in summary["runs"]:
                    writer.writerow({key: row.get(key, row["correctness"].get(key)) for key in writer.fieldnames})
    except Exception as error:
        summary["status"] = "failed"
        summary["error"] = str(error)
        raise
    finally:
        for path in sorted(output.iterdir()):
            if path.is_file() and path.name != "summary.json":
                summary["artifacts"][path.name] = {"sha256": digest(path), "bytes": path.stat().st_size,
                    "kind": "compiled-executable" if path.read_bytes()[:4] == b"\x7fELF" else "data-or-source"}
        summary["finished_utc"] = datetime.now(timezone.utc).isoformat()
        save()
    print(json.dumps({"status": summary["status"], "output": str(output), "totals": summary.get("totals")}))
    return 0 if summary["status"] in ("completed", "compiled-not-executed") else 2


if __name__ == "__main__":
    raise SystemExit(main())
