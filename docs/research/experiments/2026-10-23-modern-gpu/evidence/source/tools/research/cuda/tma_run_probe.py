#!/usr/bin/env python3
"""Compile or execute the controlled tensor-TMA suite. Cloud allocation is external."""
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

SOURCE = Path(__file__).with_name("tma_version_probe.cu")
FORMAT = "gpu-tensor-tma-version-probe-v1"
VARIANTS = ("correct", "wrong-slot", "repaired")
SHAPES = ((1, 1), (1, 17), (2, 31), (3, 33), (4, 64), (8, 63))
GENERATIONS = (1, 2, 5)
SEEDS = (20261023, 20261024)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def value_for(seed, generation, index):
    if generation < 0:
        return -(1000000 + index)
    return (seed ^ ((generation + 1) * 2654435769) ^ ((index + 11) * 2246822507)) & 8388607


def oracle(rows, cols, generations, seed, wrong_slot=False):
    count = rows * cols
    values = [value_for(seed, g - int(wrong_slot), i) for g in range(generations) for i in range(count)]
    tags = [g - int(wrong_slot) for g in range(generations) for _ in range(count)]
    return values, tags


def parse_stdout_record(text):
    records = []
    for line_number, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith("{"):
            record = json.loads(line)
            if record.get("format") == FORMAT:
                records.append((record, line_number))
    if len(records) != 1:
        raise ValueError("expected exactly one tensor-TMA JSON record")
    return records[0]


def check_record(record):
    if record.get("format") != FORMAT or record.get("mechanism") != "tensor-tma-2d":
        raise ValueError("wrong probe format/mechanism")
    rows, cols = record["shape"]
    generations, seed = record["generations"], record["seed"]
    if not (type(rows) is type(cols) is type(generations) is type(seed) is int
            and 1 <= rows <= 8 and 1 <= cols <= 64 and 1 <= generations <= 32 and 0 <= seed < 2**32):
        raise ValueError("invalid shape, generation count, or seed")
    variant = record["variant"]
    if variant not in VARIANTS or record["device_status"] != 0:
        raise ValueError("invalid variant or failed device status")
    if record["cta"] != [0, 0, 0] or record["threads"] != 64 or record["compute_capability"][0] < 9:
        raise ValueError("unexpected launch or non-TMA GPU")
    padded = (cols + 3) // 4 * 4
    if record["padded_cols"] != padded or record["transfer_bytes"] != rows * padded * 8:
        raise ValueError("invalid padded tile / transaction byte count")
    expected_map = {"rank": 2, "dtype": "int32", "global_dim": [2 * padded, (generations + 2) * rows],
                    "global_stride_bytes": [padded * 8], "box_dim": [padded * 2, rows],
                    "element_stride": [1, 1], "swizzle": "none"}
    if record["tensor_map"] != expected_map:
        raise ValueError("tensor map layout differs from independent contract")
    reference, expected_tags = oracle(rows, cols, generations, seed)
    actual_values, actual_tags = oracle(rows, cols, generations, seed, variant == "wrong-slot")
    for key, expected in (("reference", reference), ("expected_generations", expected_tags),
                          ("output", actual_values), ("observed_generations", actual_tags)):
        if record[key] != expected or any(type(v) is not int for v in record[key]):
            raise ValueError(f"{key} differs from independent exact integer oracle")
    value_errors = sum(x != y for x, y in zip(actual_values, reference))
    tag_errors = sum(x != y for x, y in zip(actual_tags, expected_tags))
    correctness = {"passed": value_errors == tag_errors == 0, "value_mismatches": value_errors,
                   "version_mismatches": tag_errors}
    if record["correctness"] != correctness or type(record["correctness"]["passed"]) is not bool:
        raise ValueError("reported correctness differs from saved outputs")
    if correctness["passed"] != (variant != "wrong-slot"):
        raise ValueError("controlled fault / repair outcome differs from contract")
    events = record["events"]
    if len(events) != 4 + generations * 4 or record["wait_poll_limit"] != 1000000:
        raise ValueError("incomplete event log / invalid wait bound")
    physical = {}
    waits = 0
    for index, event in enumerate(events):
        initial = index < 4
        transfer = index // 2 if initial else (index - 4) // 4 + 2
        g = -1 if initial else transfer - 2
        role_index = index % 2 if initial else (index - 4) % 4
        role = ("tma_issued", "wait_returned_true", "consumer_sample", "reuse_ready")[role_index]
        slot = transfer if initial else (g & 1) ^ int(role == "consumer_sample" and variant == "wrong-slot")
        observed_g = g - int(role == "consumer_sample" and variant == "wrong-slot")
        observed = role in ("wait_returned_true", "consumer_sample")
        phase = (0 if initial else (1 + g // 2) % 2) if role_index <= 1 else -1
        thread = 32 if role == "consumer_sample" else 0
        ordinal = index if initial else g if thread == 32 else 4 + g * 3 + (2 if role_index == 3 else role_index)
        expected_fields = {"id": f"event-{index}", "event_layout_index": index, "role": role,
            "iteration": g, "transfer": transfer, "slot": slot, "expected_generation": g,
            "observed_generation": observed_g if observed else None,
            "representative_value": value_for(seed, observed_g, 0) if observed else None,
            "phase_parity": phase, "wait_success": role == "wait_returned_true", "thread": thread,
            "warp_id": thread // 32, "thread_program_ordinal": ordinal}
        for key, expected in expected_fields.items():
            if event[key] != expected:
                raise ValueError(f"event {index} {key} differs from source-bound contract")
        if type(event["source_line"]) is not int or event["source_line"] <= 0:
            raise ValueError("event lacks source line")
        polls = event["wait_polls"]
        if type(polls) is not int or not (1 <= polls <= 1000000 if role == "wait_returned_true" else polls == 0):
            raise ValueError("wait-success event lacks bounded positive polling evidence")
        waits += role == "wait_returned_true"
        address = (int(event["barrier_shared_address"], 16), int(event["buffer_shared_address"], 16))
        if address[0] % 8 or address[1] % 128 or slot in physical and physical[slot] != address:
            raise ValueError("unaligned or inconsistent barrier/buffer physical identity")
        physical[slot] = address
    if physical[0][0] == physical[1][0] or abs(physical[0][1] - physical[1][1]) < 4096:
        raise ValueError("physical slots/barriers alias")
    return {"independent_python_oracle": "pass", "all_valid_output_elements": len(reference),
            "event_identity_and_payload": "pass", "successful_wait_observations": waits,
            "expected_controlled_fault_observed": variant == "wrong-slot",
            "repair_recovers_exact_outputs": variant == "repaired"}


def source_contract(source):
    lines = Path(source).read_text().splitlines()
    sites = {}
    for number, line in enumerate(lines, 1):
        for marker in re.findall(r"\b(?:CONTRACT|EVENT|CONTROLLED)_[A-Z_]+", line):
            sites[marker] = number
    return {
        "mechanism": "cuTensorMapEncodeTiled rank-2 int32 + cp.async.bulk.tensor.2d global-to-shared",
        "input_layout": "Each logical element is [int32 payload,int32 generation tag]; columns padded to multiple of four; both fields copied by TMA.",
        "logical_tail_scope": "Consumer logical tails and padded rows; does not test tensor-map out-of-bounds fill.",
        "output_layout": "generation-major [generations,rows,cols]; every valid element saved and checked exactly",
        "initial_generation": -1, "slots": 2, "threads": 64, "mbarrier_arrivals_per_phase": 1,
        "initialization": "Two TMA copies to initialize both slots, each with successful acquire wait before the first consumer.",
        "correct_slot": "g % 2", "fault_slot": "(g % 2) ^ 1; completed generation g-1, initial -1 at g=0",
        "repair": "Controlled source selector repair to g % 2; not an AI-generated or naturally occurring fault.",
        "full_generation": "Integer tag is actual transported data; barrier phase is only modulo-2 auxiliary state.",
        "wait_observation": "Event recorded after mbarrier.try_wait.parity.acquire returned true; representative value/tag loaded after return.",
        "ordering": [
            "Barrier init + async proxy fence + CTA barrier precede TMA issue.",
            "TMA issue precedes arrive.expect_tx.release with exact padded tile bytes; only thread0 arrives/waits.",
            "Successful acquire wait and its log precede consumer loads through TMA visibility CTA barrier.",
            "All consumer generic reads precede per-thread async proxy fence and reader-completion CTA barrier; next TMA overwrite follows that barrier.",
            "consumer_sample is a thread32 observation before reader-completion CTA barrier; reuse_ready is thread0 after it.",
            "Event array index is fixed storage, not a timestamp. HB comes from bound source contracts and per-thread program order."],
        "source_sites": sites,
        "limitations": ["One CTA; no overlapping transfer/compute performance claim.",
            "No tcgen05, TMEM, multicast, or descriptor mutation is exercised.",
            "Finite bounded suite does not prove arbitrary GPU kernels correct.",
            "No SM89 run is valid for this program; execution requires TMA-capable hardware and compatible compiled target."],
        "references": [
            "https://docs.nvidia.com/cuda/archive/13.0.0/cuda-c-programming-guide/index.html#using-tma-to-transfer-multi-dimensional-arrays",
            "https://docs.nvidia.com/cuda/parallel-thread-execution/index.html#parallel-synchronization-and-communication-instructions-mbarrier-test-wait-mbarrier-try-wait",
            "https://docs.nvidia.com/cuda/parallel-thread-execution/index.html#data-movement-and-conversion-instructions-cp-async-bulk-tensor"],
        "kernelwiki_consulted": {"pages": ["hw-tma", "hw-mbarrier"], "confidence": "source-reported",
            "resolution": "Official NVIDIA ordering/transaction-accounting semantics take precedence over abbreviated wiki pseudocode."}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cuda-root", type=Path, default=Path("/usr/local/cuda-13.1"))
    parser.add_argument("--arch", choices=("sm_100a", "sm_100", "sm_90a", "sm_90"), default="sm_100a")
    parser.add_argument("--compile-only", action="store_true")
    parser.add_argument("--skip-sanitizers", action="store_true")
    parser.add_argument("--smoke", action="store_true", help="one tail shape/seed/generation count, all three variants")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    for path in (SOURCE, Path(__file__)):
        (output / path.name).write_bytes(path.read_bytes())
    source_hashes = {p.name: digest(p) for p in (SOURCE, Path(__file__))}
    contract = source_contract(SOURCE)
    (output / "contract.json").write_text(json.dumps(contract, indent=2) + "\n")
    summary = {"format": "gpu-tensor-tma-version-suite-v1", "status": "preparing",
        "started_utc": datetime.now(timezone.utc).isoformat(), "platform": platform.platform(),
        "source_hashes": source_hashes, "operator_contract": contract, "compile_target": args.arch,
        "scope": "compile-only" if args.compile_only else "smoke" if args.smoke else "full-suite",
        "commands": [], "runs": [], "sanitizers": [], "artifacts": {}}

    def save():
        (output / "summary.json").write_text(json.dumps(summary, indent=2, allow_nan=False) + "\n")

    def run(name, argv, allowed=(0,), timeout=90):
        started = time.monotonic()
        command = list(map(str, argv))
        result = subprocess.run(command, text=True, capture_output=True, timeout=timeout)
        stdout_path, stderr_path = output / (name + ".stdout.txt"), output / (name + ".stderr.txt")
        stdout_path.write_text(result.stdout); stderr_path.write_text(result.stderr)
        summary["commands"].append({"name": name, "argv": command, "exit_code": result.returncode,
            "expected_exit_codes": list(allowed), "elapsed_seconds": time.monotonic() - started,
            "stdout_sha256": digest(stdout_path), "stderr_sha256": digest(stderr_path)})
        save()
        if result.returncode not in allowed:
            raise RuntimeError(f"{name}: unexpected exit {result.returncode}; logs retained")
        return result

    def augment(name, result):
        record, json_line = parse_stdout_record(result.stdout)
        record["independent_checks"] = check_record(record)
        record["measurement_id"] = name
        record["exit_code"] = result.returncode
        record["source_hashes"] = source_hashes
        raw_sha = digest(output / (name + ".stdout.txt"))
        record["recordRef"] = {"path": name + ".stdout.txt", "sha256": raw_sha, "json_line": json_line}
        for index, event in enumerate(record["events"]):
            marker = {"tma_issued": "EVENT_TMA_ISSUED", "wait_returned_true": "EVENT_WAIT_RETURNED_TRUE",
                "consumer_sample": "EVENT_CONSUMER_SAMPLE", "reuse_ready": "EVENT_REUSE_READY"}[event["role"]]
            if event["source_line"] != contract["source_sites"][marker]:
                raise ValueError("event line does not bind to the compiled source marker")
            event["recordRef"] = {"path": name + ".stdout.txt", "sha256": raw_sha, "json_line": json_line,
                "json_pointer": f"/events/{index}", "source_sha256": source_hashes[SOURCE.name],
                "source_line": event["source_line"]}
        return record

    try:
        nvcc = args.cuda_root / "bin/nvcc"
        run("nvcc-version", [nvcc, "--version"])
        binary, ptx = output / "tma_version_probe", output / "tma_version_probe.ptx"
        common = [nvcc, "-std=c++17", "-O3", "-lineinfo", "-arch=" + args.arch]
        run("compile", common + ["--ptxas-options=-v", output / SOURCE.name, "-o", binary], timeout=180)
        run("compile-ptx", common + ["--ptx", output / SOURCE.name, "-o", ptx], timeout=180)
        sass = run("disassemble", [args.cuda_root / "bin/cuobjdump", "--dump-sass", binary]).stdout
        (output / "tma_version_probe.sass").write_text(sass)
        required = ["cp.async.bulk.tensor.2d", "mbarrier.arrive.expect_tx", "mbarrier.try_wait.parity.acquire"]
        if any(marker not in ptx.read_text() for marker in required):
            raise ValueError("compiled PTX lacks required tensor-TMA / barrier instructions")
        for path in (binary, ptx, output / "tma_version_probe.sass", output / "contract.json"):
            summary["artifacts"][path.name] = {"sha256": digest(path), "bytes": path.stat().st_size}
        if args.compile_only:
            summary["status"] = "compiled-not-executed"
            return
        summary["gpu_identity"] = run("gpu-identity", ["nvidia-smi", "--query-gpu=name,compute_cap,driver_version,memory.total", "--format=csv,noheader"]).stdout.strip()
        summary["status"] = "running"
        shapes = ((3, 33),) if args.smoke else SHAPES
        generations_set = (5,) if args.smoke else GENERATIONS
        seeds = (20261023,) if args.smoke else SEEDS
        for rows, cols in shapes:
            for generations in generations_set:
                for seed in seeds:
                    for variant in VARIANTS:
                        name = f"verify_r{rows}_c{cols}_g{generations}_s{seed}_{variant}"
                        result = run(name, [binary, rows, cols, generations, seed, variant],
                                     allowed=(2,) if variant == "wrong-slot" else (0,))
                        summary["runs"].append(augment(name, result)); save()
            print(f"verified shape={rows}x{cols}", flush=True)
        if not args.skip_sanitizers:
            sanitizer = args.cuda_root / "bin/compute-sanitizer"
            run("sanitizer-version", [sanitizer, "--version"])
            for tool in ("memcheck", "synccheck", "racecheck"):
                for variant in VARIANTS:
                    name = tool + "_" + variant
                    result = run(name, [sanitizer, "--tool", tool, "--error-exitcode", "99", binary,
                        3, 33, 5, 20261023, variant], allowed=(2,) if variant == "wrong-slot" else (0,), timeout=180)
                    record = augment(name, result)
                    pattern = r"RACECHECK SUMMARY: 0 hazards displayed" if tool == "racecheck" else r"ERROR SUMMARY: 0 errors"
                    if not re.search(pattern, result.stdout + "\n" + result.stderr):
                        raise ValueError(f"{name}: no explicit zero-error sanitizer summary")
                    summary["sanitizers"].append({"tool": tool, "variant": variant, "tool_error_count": 0,
                        "application_exit_code": result.returncode, "record": record}); save()
        summary["counts"] = {"normal_runs": len(summary["runs"]),
            "correct_passed": sum(r["variant"] == "correct" and r["correctness"]["passed"] for r in summary["runs"]),
            "fault_expected_mismatch": sum(r["variant"] == "wrong-slot" and not r["correctness"]["passed"] for r in summary["runs"]),
            "repaired_passed": sum(r["variant"] == "repaired" and r["correctness"]["passed"] for r in summary["runs"]),
            "normal_output_elements": sum(len(r["output"]) for r in summary["runs"]),
            "normal_events": sum(len(r["events"]) for r in summary["runs"]),
            "successful_wait_observations": sum(r["independent_checks"]["successful_wait_observations"] for r in summary["runs"]),
            "normal_value_mismatches": sum(r["correctness"]["value_mismatches"] for r in summary["runs"]),
            "normal_version_mismatches": sum(r["correctness"]["version_mismatches"] for r in summary["runs"]),
            "sanitizer_checks": len(summary["sanitizers"]),
            "sanitizer_tool_errors": sum(r["tool_error_count"] for r in summary["sanitizers"])}
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
