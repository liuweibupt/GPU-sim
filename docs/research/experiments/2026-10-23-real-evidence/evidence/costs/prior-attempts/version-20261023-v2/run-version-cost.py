#!/usr/bin/env python3
"""Paired CUDA-event acquisition costs. Run only in the coordinated GPU slot."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import statistics
import subprocess
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def quantiles(values):
    values = sorted(values)
    def q(p):
        n = (len(values)-1)*p
        lo, hi = math.floor(n), math.ceil(n)
        return values[lo]*(hi-n)+values[hi]*(n-lo) if lo != hi else values[lo]
    return {"n": len(values), "min": values[0], "p05": q(.05), "median": q(.5), "p95": q(.95), "max": values[-1]}


def validate_payload(record):
    n, g, seed = record["count"], record["generations"], record["seed"]
    expected = [(seed ^ ((gen+1)*2654435769) ^ ((i+11)*2246822507)) & 8388607
                for gen in range(g) for i in range(n)]
    if record["output"] != expected:
        raise ValueError("independent Python value oracle failed")
    if record["instrumented"]:
        if record["observed_generations"] != [gen for gen in range(g) for _ in range(n)]:
            raise ValueError("independent Python generation oracle failed")
        blocks = (n+31)//32
        if len(record["events"]) != blocks*g*5:
            raise ValueError("incomplete events")
        for i, e in enumerate(record["events"]):
            role, gen, block = i % 5, i//5 % g, i//5//g
            actual = {"block": block, "thread": 32 if role in (2, 3) else 0, "generation": gen,
                      "role": role, "slot": gen & 1, "observed_generation": gen,
                      "representative_value": expected[gen*n+block*32], "valid_elements": min(32, n-block*32)}
            if any(e[k] != value for k, value in actual.items()) or not e["source_line"] > 0:
                raise ValueError("independent Python event oracle failed")
    return {"elements": len(expected), "events": len(record.get("events", [])), "passed": True}


def summarize(samples):
    groups = {}
    for s in samples:
        key = (s["count"], s["generations"])
        groups.setdefault(key, []).append(s)
    rows = []
    metrics = ["kernel_us", "output_d2h_device_us", "output_d2h_host_us", "evidence_d2h_device_us",
               "evidence_d2h_host_us", "serialize_us"]
    for (n, g), group in sorted(groups.items()):
        pairs = {}
        for s in group:
            pair = pairs.setdefault((s["session"], s["pair"]), {})
            if s["instrumented"] in pair:
                raise ValueError("duplicate paired mode")
            pair[s["instrumented"]] = s
        if any(set(pair) != {False, True} or pair[False]["seed"] != pair[True]["seed"] or
               {pair[False]["order"], pair[True]["order"]} != {0, 1} for pair in pairs.values()):
            raise ValueError("incomplete or unmatched pair")
        ratio = lambda p: p[True]["kernel_us"]/p[False]["kernel_us"]
        rows.append({"count": n, "generations": g, "pairs": len(pairs),
                     "per_mode": {str(mode): {m: quantiles([s[m] for s in group if s["instrumented"] == mode])
                                               for m in metrics} for mode in (False, True)},
                     "paired_kernel_ratio": quantiles([ratio(p) for p in pairs.values()]),
                     "paired_kernel_delta_us": quantiles([p[True]["kernel_us"]-p[False]["kernel_us"] for p in pairs.values()]),
                     "session_median_kernel_ratios": {str(session): statistics.median(ratio(p) for (s, _), p in pairs.items() if s == session)
                                                       for session in sorted({s for s, _ in pairs})},
                     "bytes_per_mode": {str(mode): {k: next(s[k] for s in group if s["instrumented"] == mode)
                                                     for k in ("output_bytes", "evidence_bytes", "events")} for mode in (False, True)},
                     "serialized_bytes_per_mode": {str(mode): quantiles([s["serialized_bytes"] for s in group if s["instrumented"] == mode]) for mode in (False, True)}})
    return rows


def command(output, name, argv, timeout=180):
    start = time.monotonic()
    result = subprocess.run([str(a) for a in argv], capture_output=True, timeout=timeout)
    for stream in ("stdout", "stderr"):
        (output/f"{name}.{stream}.txt").write_bytes(getattr(result, stream))
    record = {"name": name, "argv": [str(a) for a in argv], "exit_code": result.returncode,
              "wall_seconds": time.monotonic()-start}
    with (output/"commands.jsonl").open("a") as f:
        f.write(json.dumps(record)+"\n")
    if result.returncode:
        raise RuntimeError(f"{name} failed: {result.stderr.decode(errors='replace')[-2000:]}")
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--compile-only", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--sessions", type=int, default=3)
    parser.add_argument("--pairs", type=int, default=30)
    parser.add_argument("--warmups", type=int, default=20)
    parser.add_argument("--nsys", action="store_true")
    args = parser.parse_args()
    if args.sessions < 3 or args.pairs < 30 or args.warmups < 5:
        parser.error("publication cost run requires >=3 sessions, >=30 pairs/session and >=5 warmups/mode")
    output = args.output.resolve()
    sources = [HERE/"prepare-version-kernel.py", HERE/"version-cost.cu", Path(__file__), ROOT/"tools/research/cuda/version_probe.cu"]
    nvcc = Path("/usr/local/cuda-13.1/bin/nvcc")
    if not args.resume:
        output.mkdir(parents=True, exist_ok=False)
        for source in sources:
            (output/source.name).write_bytes(source.read_bytes())
        spec = importlib.util.spec_from_file_location("cost_prepare", HERE/"prepare-version-kernel.py")
        prepare = importlib.util.module_from_spec(spec); spec.loader.exec_module(prepare)
        (output/"version_cost_kernel.cuh").write_bytes(prepare.derive(sources[-1].read_bytes()))
        command(output, "compile", [nvcc, "-std=c++17", "-O3", "-lineinfo", "-arch=sm_89", "-Xptxas=-v",
                                     output/"version-cost.cu", "-o", output/"version-cost"])
        command(output, "sass", [nvcc.parent/"cuobjdump", "--dump-sass", output/"version-cost"])
        build = {"source_hashes": {s.name: sha(s.read_bytes()) for s in sources},
                 "generated_sha256": sha((output/"version_cost_kernel.cuh").read_bytes()),
                 "binary_sha256": sha((output/"version-cost").read_bytes())}
        (output/"build.json").write_text(json.dumps(build, indent=2)+"\n")
    else:
        build = json.loads((output/"build.json").read_text())
        if any(sha(s.read_bytes()) != build["source_hashes"][s.name] or sha((output/s.name).read_bytes()) != build["source_hashes"][s.name] for s in sources):
            raise ValueError("prepared source changed; create a new output")
        if sha((output/"version-cost").read_bytes()) != build["binary_sha256"]:
            raise ValueError("prepared executable changed")
    if args.compile_only:
        print(json.dumps({"status": "compiled", "output": str(output), **build})); return
    if (output/"summary.json").exists():
        raise ValueError("completed experiment cannot be overwritten")
    command(output, "gpu-before", ["nvidia-smi", "-q"])
    command(output, "cpu", ["lscpu", "-J"])
    # Inspect collection phases before the unprofiled experiment, following the
    # nsys-first workflow. Profiled measurements never enter paired distributions.
    if args.nsys:
        directory = output/"nsys-validation";directory.mkdir()
        command(output, "nsys", ["nsys", "profile", "--force-overwrite=false", "--trace=cuda,nvtx,osrt", "--sample=none",
                                  "--stats=true", "-o", output/"collection", output/"version-cost", "1000", "2", "5", directory, "0"], timeout=300)
        command(output, "nsys-stats", ["nsys", "stats", "--report", "cuda_api_sum,cuda_gpu_kern_sum,cuda_gpu_mem_time_sum,cuda_gpu_mem_size_sum",
                                       output/"collection.nsys-rep"], timeout=300)
    samples, validations, environments = [], [], []
    for session in range(args.sessions):
        directory = output/f"validation-{session}";directory.mkdir()
        raw = command(output, f"session-{session}", [output/"version-cost", session, args.pairs, args.warmups, directory, 0], timeout=600)
        for line in raw.decode().splitlines():
            row = json.loads(line)
            if row["kind"] == "environment": environments.append(row)
            else: samples.append({"session": session, **row})
        for path in sorted(directory.glob("*.json")):
            validation = validate_payload(json.loads(path.read_bytes()))
            validations.append({"session": session, "path": str(path.relative_to(output)), "sha256": sha(path.read_bytes()), **validation})
        command(output, f"gpu-after-{session}", ["nvidia-smi", "-q"])
    (output/"samples.jsonl").write_text("".join(json.dumps(s)+"\n" for s in samples))
    summary = {"format": "version-probe-acquisition-cost-v1", "timestamp": datetime.now(timezone.utc).isoformat(),
               "sessions": args.sessions, "pairs_per_shape_per_session": args.pairs, "warmups_per_mode_shape_session": args.warmups,
               "environments": environments, "build": build, "results": summarize(samples), "validations": validations,
               "method": {"pairing": "Same seed/shape/64-thread launch/value output; seeded random within-pair and shape order; independent process sessions.",
                          "baseline": "Compile-time removal of event writes and auxiliary tag initialization/read/write only. Algorithm payload, CTA barriers and output stores retained.",
                          "kernel": "One kernel bracketed by CUDA events; allocation, D2H, validation, host serialization excluded. Short-kernel timer quantization and launch scheduling remain.",
                          "d2h": "Pinned host buffers; output transfer separately from extra tags/events. CUDA event span and host elapsed including synchronization both retained.",
                          "serialize": "Host steady-clock compact JSON string construction only; includes allocation; excludes file I/O. Captured values/tags/events only, no duplicated oracle arrays.",
                          "correctness": "Every sampled output/event verified by C++ oracle outside timing; one full payload per shape/mode/session independently checked in Python."},
               "limitations": ["SM89 controlled scalar/shared-memory toy only; not TMA/tcgen05 overhead or optimized production AI operators.",
                               "Same-machine sessions, no frequency locking; hardware/software state and raw samples retained.",
                               "Original frozen probe has extra reporting/oracle fields; these serializer timings are for the explicitly documented acquisition schema.",
                               "Nsight Systems run is separate and excluded from measured samples. No roofline or MFU inference."]}
    (output/"summary.json").write_text(json.dumps(summary, indent=2)+"\n")
    manifest = {str(p.relative_to(output)): {"sha256": sha(p.read_bytes()), "bytes": p.stat().st_size}
                for p in sorted(output.rglob("*")) if p.is_file() and p.name != "manifest.json"}
    (output/"manifest.json").write_text(json.dumps(manifest, indent=2)+"\n")
    print(json.dumps({"status": "complete", "samples": len(samples), "output": str(output)}))


if __name__ == "__main__": main()
