#!/usr/bin/env python3
"""Guarded SM89 double-buffer version evidence; no performance claims."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(__file__).with_name("version_probe.cu")
NVCC = "/usr/local/cuda-12.6/bin/nvcc"
SANITIZER = "/usr/local/cuda-13.1/bin/compute-sanitizer"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def oracle(count, generations, seed):
    return [int((seed ^ ((generation + 1) * 2654435769) ^ ((index + 11) * 2246822507)) & 8388607)
            for generation in range(generations) for index in range(count)]


def parse_stdout_record(text):
    records = []
    for line_number, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith("{"):
            record = json.loads(line)
            if record.get("format") == "gpu-version-probe-v1":
                records.append((record, line_number))
    if len(records) != 1:
        raise ValueError("expected exactly one version-probe JSON record in stdout")
    return records[0]


def check_record(record):
    count = record["shape"][0]
    generations = record["generations"]
    seed = record["seed"]
    correct = record["variant"] == "correct"
    reference = oracle(count, generations, seed)
    expected_tags = [generation for generation in range(generations) for _ in range(count)]
    observed_expected = expected_tags if correct else [generation - 1 for generation in range(generations) for _ in range(count)]
    output_expected = reference if correct else [-(1000000 + index) if generation == 0
        else oracle(count, generation, seed)[(generation - 1) * count + index]
        for generation in range(generations) for index in range(count)]
    if record["reference"] != reference or record["expected_generations"] != expected_tags:
        raise ValueError("C++ oracle differs from independent Python oracle")
    if record["output"] != output_expected or record["observed_generations"] != observed_expected:
        raise ValueError("observed output/tags differ from specified correct or deliberate wrong-slot behavior")
    mismatch_count = sum(a != b for a, b in zip(record["output"], reference))
    version_mismatches = sum(a != b for a, b in zip(record["observed_generations"], expected_tags))
    if record["correctness"]["value_mismatches"] != mismatch_count or record["correctness"]["version_mismatches"] != version_mismatches:
        raise ValueError("reported mismatch counts differ from actual saved arrays")
    if (mismatch_count == 0 and version_mismatches == 0) != correct:
        raise ValueError("correctness verdict does not match expected variant")
    if record["correctness"]["passed"] is not correct:
        raise ValueError("saved correctness boolean disagrees with measured arrays")
    blocks = (count + 31) // 32
    if len(record["events"]) != blocks * generations * 5:
        raise ValueError("event log incomplete")
    seen = set()
    role_index = {name: i for i, name in enumerate(("producer_write", "producer_complete", "consumer_read", "reader_done", "reuse_ready"))}
    for event in record["events"]:
        block, generation = event["cta"][0], event["iteration"]
        role = role_index[event["role"]]
        key = (block, generation, role)
        if key in seen or not 0 <= block < blocks or not 0 <= generation < generations:
            raise ValueError("duplicate or invalid event identity")
        seen.add(key)
        consumer = event["role"] in ("consumer_read", "reader_done")
        expected_slot = (generation & 1) ^ int(consumer and not correct)
        expected_version = generation - int(consumer and not correct)
        index = block * 32
        expected_value = (-(1000000 + index) if expected_version == -1
                          else oracle(count, expected_version + 1, seed)[expected_version * count + index])
        if event["slot"] != expected_slot or event["observed_generation"] != expected_version:
            raise ValueError("event does not match independently checked slot/version")
        if event["representative_value"] != expected_value or event["valid_elements"] != min(32, count - index):
            raise ValueError("event payload/valid tail count differs from oracle")
        if event["thread"] != (32 if consumer else 0):
            raise ValueError("event recorded by unexpected thread")
        if event["expected_generation"] != generation or event["cta"] != [block, 0, 0]:
            raise ValueError("event expected generation or CTA identity is inconsistent")
        if event["warp_id"] != event["thread"] // 32 or event["event_layout_index"] != (block * generations + generation) * 5 + role:
            raise ValueError("event warp or fixed storage layout is inconsistent")
        phases = ["before_producer_barrier", "after_producer_barrier", "before_reuse_barrier", "after_reuse_barrier", "after_reuse_barrier"]
        expected_ordinal = generation * (2 if consumer else 3) + (role - 2 if consumer else 2 if role == 4 else role)
        if event["phase"] != phases[role] or event["thread_program_ordinal"] != expected_ordinal:
            raise ValueError("event source phase or per-thread program order is inconsistent")
    return {"independent_python_oracle": "pass", "event_identity_and_payload": "pass",
            "expected_injected_fault_observed": not correct}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output = (args.output or ROOT / "out/research/cuda" / (stamp + "-version-probe")).resolve()
    output.mkdir(parents=True, exist_ok=False)
    (output / "version_probe.cu").write_bytes(SOURCE.read_bytes())
    (output / "run_version_probe.py").write_bytes(Path(__file__).read_bytes())
    source_lines = SOURCE.read_text().splitlines()
    contract_sites = {line.split("// ", 1)[1]: index for index, line in enumerate(source_lines, 1) if "// CONTRACT_" in line}
    source_hashes = {"version_probe.cu": digest(SOURCE), "run_version_probe.py": digest(Path(__file__))}
    summary = {"format": "gpu-version-probe-suite-v1", "status": "running", "started_utc": stamp,
        "platform": platform.platform(), "source_hashes": source_hashes, "runs": [], "sanitizers": [],
        "commands": [], "gpu_states": [], "operator_contract": {
            "dtype": "int32 exact", "layout": "generation-major contiguous output [generations,count]",
            "input": "deterministic uint32 mixing of seed, generation and element index; lower 23 bits",
            "shapes": [1, 17, 32, 33, 65, 127], "generation_counts": [1, 2, 5], "seeds": [20261023, 20261024],
            "block_threads": 64, "producer_threads": [0, 31], "consumer_threads": [32, 63],
            "slot": "generation % 2", "initial_version": -1, "tolerance": 0,
            "source_barrier_sites": contract_sites,
            "happens_before_contract": [
                "Initialization writes precede all generation accesses through the initialization __syncthreads.",
                "All producer writes of generation g precede all consumer reads of generation g through producer visibility __syncthreads.",
                "All consumer reads of generation g precede all producer writes of generation g+1 through reader completion/reuse __syncthreads and program order.",
                "producer_complete and consumer_read are separate post-producer-barrier observations; no order between those two log events is inferred.",
                "reader_done and reuse_ready are separate post-barrier observations; no order between these two events is inferred."]},
        "provenance": "Experiment-authored controlled wrong-slot fault; not a natural AI failure, SM100 protocol, or performance experiment.",
        "limitations": ["Shared-host idle windows are observed, not a reservation.",
            "Fixed event array index is storage layout, not event timestamp or cross-thread execution order.",
            "Observed tags and values are actual GPU outputs; HB derives only from this source-bound uniform CTA barrier contract.",
            "Finite checks do not prove arbitrary programs correct; no TMA, tcgen05, or TMEM instruction is exercised."]}

    def save():
        (output / "summary.json").write_text(json.dumps(summary, indent=2, allow_nan=False) + "\n")

    def run(name, command, allowed=(0,), timeout=60):
        started = time.monotonic()
        result = subprocess.run(list(map(str, command)), cwd=ROOT, text=True, capture_output=True, timeout=timeout)
        (output / (name + ".stdout.txt")).write_text(result.stdout)
        (output / (name + ".stderr.txt")).write_text(result.stderr)
        summary["commands"].append({"name": name, "argv": list(map(str, command)), "exit_code": result.returncode,
                                    "expected_exit_codes": list(allowed), "elapsed_seconds": time.monotonic() - started,
                                    "stdout_sha256": digest(output / (name + ".stdout.txt")),
                                    "stderr_sha256": digest(output / (name + ".stderr.txt"))})
        save()
        if result.returncode not in allowed:
            raise RuntimeError(f"{name}: unexpected exit {result.returncode}; logs retained")
        return result

    def idle(label):
        quiet = 0
        for attempt in range(16):
            raw = subprocess.check_output(["nvidia-smi", "--query-gpu=index,utilization.gpu,memory.free,temperature.gpu,clocks.sm,pstate", "--format=csv,noheader,nounits"], text=True).strip()
            processes = subprocess.check_output(["nvidia-smi", "--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"], text=True).strip()
            rows = [[field.strip() for field in line.split(",")] for line in raw.splitlines()]
            summary["gpu_states"].append({"label": label, "attempt": attempt, "utc": datetime.now(timezone.utc).isoformat(),
                                          "columns": ["index", "util_percent", "free_mib", "temperature_c", "sm_clock_mhz", "pstate"],
                                          "rows": rows, "compute_processes": processes.splitlines()})
            save()
            if len(rows) != 1 or int(rows[0][2]) < 512:
                raise RuntimeError("Unexpected GPU topology or insufficient free memory; no launch")
            quiet = quiet + 1 if int(rows[0][1]) <= 5 and not processes else 0
            if quiet == 3:
                return
            time.sleep(0.5)
        raise RuntimeError("GPU remained busy during bounded idle guard; no further launch")

    def augment(record, name, result, json_line):
        stdout_hash = digest(output / (name + ".stdout.txt"))
        record["measurement_id"] = name
        record["exit_code"] = result.returncode
        record["source_hashes"] = source_hashes
        record["source_barrier_sites"] = contract_sites
        record["independent_checks"] = check_record(record)
        record["recordRef"] = {"path": name + ".stdout.txt", "sha256": stdout_hash, "json_line": json_line}
        for index, event in enumerate(record["events"]):
            event["id"] = name + ":" + event["id"]
            event["recordRef"] = {"path": name + ".stdout.txt", "sha256": stdout_hash,
                                   "json_line": json_line, "json_pointer": f"/events/{index}", "source_sha256": source_hashes["version_probe.cu"],
                                   "source_line": event["source_line"]}
        return record

    try:
        idle("initial")
        for name, command in [("gpu_identity", ["nvidia-smi", "--query-gpu=name,compute_cap,driver_version,memory.total", "--format=csv,noheader"]),
                              ("nvcc_version", [NVCC, "--version"]), ("sanitizer_version", [SANITIZER, "--version"])]:
            summary[name] = run(name, command).stdout.strip()
        binary = output / "version_probe"
        run("compile", [NVCC, "-std=c++17", "-O3", "-lineinfo", "-arch=sm_89", "--ptxas-options=-v", SOURCE,
                        "-Xlinker", "-rpath", "-Xlinker", "/usr/local/cuda-12.6/lib64", "-o", binary])
        summary["binary_sha256"] = digest(binary)
        for count in summary["operator_contract"]["shapes"]:
            idle("before_shape_" + str(count))
            for generations in summary["operator_contract"]["generation_counts"]:
                for seed in summary["operator_contract"]["seeds"]:
                    for variant in ("correct", "wrong-slot"):
                        name = f"verify_n{count}_g{generations}_s{seed}_{variant}"
                        result = run(name, [binary, count, generations, seed, variant], allowed=(0,) if variant == "correct" else (2,))
                        record, json_line = parse_stdout_record(result.stdout)
                        summary["runs"].append(augment(record, name, result, json_line))
                        save()
            idle("after_shape_" + str(count))
            print(f"verified count={count}", flush=True)
        for tool in ("memcheck", "synccheck", "racecheck"):
            for variant in ("correct", "wrong-slot"):
                idle("before_" + tool + "_" + variant)
                name = tool + "_" + variant
                result = run(name, [SANITIZER, "--tool", tool, "--error-exitcode", "99", binary, 65, 5, 20261023, variant],
                             allowed=(0,) if variant == "correct" else (2,))
                record, json_line = parse_stdout_record(result.stdout)
                record = augment(record, name, result, json_line)
                expression = r"RACECHECK SUMMARY: 0 hazards displayed" if tool == "racecheck" else r"ERROR SUMMARY: 0 errors"
                if not re.search(expression, result.stdout + "\n" + result.stderr):
                    raise RuntimeError(f"{name}: no explicit zero-error sanitizer summary")
                summary["sanitizers"].append({"tool": tool, "variant": variant, "tool_error_count": 0,
                                               "application_exit_code": result.returncode, "record": record})
                save()
        idle("final")
        summary["counts"] = {
            "normal_runs": len(summary["runs"]),
            "correct_passed": sum(record["variant"] == "correct" and record["correctness"]["passed"] for record in summary["runs"]),
            "fault_expected_mismatch": sum(record["variant"] == "wrong-slot" and record["independent_checks"]["expected_injected_fault_observed"] for record in summary["runs"]),
            "normal_output_elements": sum(len(record["output"]) for record in summary["runs"]),
            "normal_events": sum(len(record["events"]) for record in summary["runs"]),
            "normal_value_mismatches": sum(record["correctness"]["value_mismatches"] for record in summary["runs"]),
            "normal_version_mismatches": sum(record["correctness"]["version_mismatches"] for record in summary["runs"]),
            "sanitizer_checks": len(summary["sanitizers"]),
            "sanitizer_tool_errors": sum(record["tool_error_count"] for record in summary["sanitizers"]),
        }
        summary["status"] = "completed"
    except Exception as error:
        summary["status"] = "stopped"
        summary["stop_reason"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        summary["finished_utc"] = datetime.now(timezone.utc).isoformat()
        save()
        print("Artifacts: " + str(output), flush=True)


if __name__ == "__main__":
    main()
