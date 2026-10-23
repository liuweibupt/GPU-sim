#!/usr/bin/env python3
"""Independent CPU reference and strict source-contract checks for tcgen05_probe.

This validates emitted observations of this authored probe only. It is not a SASS
decoder, a generic race detector, or an attestation that caller-supplied records
were captured on hardware. The runner must separately bind source/binary/GPU logs.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path

M, N, K, EVENTS = 128, 32, 16, 11
ROLES = ["input_selected", "mma_committed"] + ["mma_wait_success"] * 4 + ["tmem_reader_done"] * 4 + ["reuse_ready"]
DOMAINS = {"input_selected": "value", "mma_committed": "commit_issued",
           "mma_wait_success": "producer_result_ready", "tmem_reader_done": "reader_done",
           "reuse_ready": "reuse_ready"}
THREADS = [0, 0, 0, 32, 64, 96, 0, 32, 64, 96, 0]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def uint(value, name, maximum=(1 << 64) - 1):
    require(type(value) is int and 0 <= value <= maximum, f"invalid unsigned integer: {name}")
    return value


def decimal(value, name):
    require(type(value) is str and value.isascii() and value.isdigit()
            and (value == "0" or not value.startswith("0")), f"noncanonical decimal string: {name}")
    return uint(int(value), name)


def cpu_reference(seed, input_index):
    """Integer arithmetic, no CUDA code or probe-reported reference imported."""
    left = [[2 * input_index - 1 + (seed + 3 * row + 5 * k) % 7 for k in range(K)] for row in range(M)]
    right = [[1 + (seed + column + 3 * k) % 5 for k in range(K)] for column in range(N)]
    return [sum(x * y for x, y in zip(a_row, b_column)) for a_row in left for b_column in right]


def expected_source_lines(source):
    lines = [i for i, line in enumerate(source.splitlines(), 1) if "__LINE__" in line]
    require(len(lines) == 5, "source does not match the five observation call sites")
    return dict(zip(DOMAINS, lines))


def validate(data, source=None):
    require(data.get("format") == "tcgen05-probe-v1" and data.get("source_contract") == "tcgen05-probe-v1", "unsupported format/contract")
    require(data.get("shape") == [M, N, K] and data.get("dtype") == "f16xf16-f32", "unsupported operator")
    require(data.get("grid") == [1, 1, 1] and data.get("block") == [128, 1, 1], "unsupported launch shape")
    iterations = uint(data["iterations"], "iterations", 64)
    require(iterations > 0, "no iterations")
    seed = uint(data["seed"], "seed", 65535)
    base = decimal(data["generation_base"], "generation_base")
    require(base + iterations + 2 <= (1 << 64) - 1, "generation overflow")
    variant = data["variant"]
    require(variant in ("correct", "wrong-version", "fixed"), "unknown variant")
    require(data["gpu"]["major"] == 10 and data["gpu"]["minor"] == 0, "expected SM100")
    require(data["instruction_descriptor"] == 0x08080010, "instruction descriptor mismatch")
    life = data["lifecycle"]
    require(life["allocated"] is True and life["deallocated"] is True, "incomplete lifecycle")
    require(life["tmem_columns"] == 32, "wrong column allocation")
    tmem = uint(life["tmem_base"], "TMEM base", 0xffffffff)
    require(tmem < 512 and tmem % 32 == 0 and tmem + 32 <= 512, "invalid SM100 TMEM allocation address")
    barrier = uint(life["barrier_address"], "barrier address", 0x3ffff)
    require(barrier % 8 == 0, "misaligned barrier")
    require(len(data["events"]) == iterations * EVENTS, "missing/extra event")
    require(len(data["output"]) == len(data["reference"]) == iterations * M * N, "incorrect output length")
    call_lines = expected_source_lines(source) if source is not None else None
    mismatches = selected_mismatches = version_mismatches = max_error = 0
    same_parity_wrong_generation = 0
    selected_indices = []
    for iteration in range(iterations):
        expected_index = iteration + 2
        observed = data["events"][iteration * EVENTS]
        selected = uint(observed["selected_input"], "selected_input", iterations + 1)
        candidate = uint(observed["candidate_input"], "candidate_input", iterations + 1)
        actual_generation = decimal(observed["observed_generation"], "observed_generation")
        require(actual_generation == base + selected, "observed source tag does not bind selected input")
        require(candidate == (expected_index if variant == "correct" else expected_index - 2), "candidate violates source contract")
        require(selected == (candidate if variant != "fixed" else expected_index), "selection violates source contract")
        require(observed["repaired"] is (variant == "fixed"), "repair observation contradicts source contract")
        selected_indices.append(selected)
        version_mismatches += actual_generation != base + expected_index
        same_parity_wrong_generation += actual_generation != base + expected_index and actual_generation % 2 == (base + expected_index) % 2
        for offset, (role, thread) in enumerate(zip(ROLES, THREADS)):
            e = data["events"][iteration * EVENTS + offset]
            require(e["id"] == f"i{iteration}:e{offset}" and e["event_layout_index"] == iteration * EVENTS + offset, "event identity mismatch")
            require(e["iteration"] == iteration and e["role"] == role and e["domain"] == DOMAINS[role], "event role/domain mismatch")
            require(e["thread"] == thread and e["warp_id"] == thread // 32, "event emitter mismatch")
            require(decimal(e["expected_generation"], "expected generation") == base + expected_index, "expected generation mismatch")
            require(decimal(e["observed_generation"], "actual generation") == actual_generation, "conflicting actual generation")
            require(decimal(e["barrier_generation"], "barrier generation") == iteration and e["barrier_phase"] == iteration % 2, "barrier generation/phase mismatch")
            require(e["selected_input"] == selected and e["candidate_input"] == candidate and e["repaired"] is observed["repaired"], "source selection changed within MMA")
            require(e["tmem_base"] == tmem and e["tmem_columns"] == 32 and e["barrier_address"] == barrier, "resource identity mismatch")
            require(e["wait_success"] is (offset >= 2), "wait-success observation missing or premature")
            uint(e["failed_wait_polls"], "failed_wait_polls", 0xffffffff)
            decimal(e["clock64"], "clock64")  # clocks are NOT converted into cross-warp HB.
            for key in ("descriptor_a", "descriptor_b"):
                desc = decimal(e[key], key)
                require(desc == decimal(observed[key], key), "descriptor changed within operation")
                require(desc & ~0x3fff == (8 << 16) | (16 << 32) | (1 << 46), "unsupported SMEM descriptor fields")
            uint(e["source_line"], "source line", 1000000)
            if call_lines is not None:
                require(e["source_line"] == call_lines[role], "observation call site does not match source")
        expected_values = cpu_reference(seed, expected_index)
        selected_values = cpu_reference(seed, selected)
        start, stop = iteration * M * N, (iteration + 1) * M * N
        output = data["output"][start:stop]
        require(data["reference"][start:stop] == expected_values, "probe reference disagrees with independent CPU reference")
        for value, wanted, selected_wanted in zip(output, expected_values, selected_values):
            require(type(value) in (int, float) and math.isfinite(value), "nonfinite/non-numeric output")
            mismatches += value != wanted
            selected_mismatches += value != selected_wanted
            max_error = max(max_error, abs(value - wanted))
        for offset in range(6, 10):
            e = data["events"][iteration * EVENTS + offset]
            require(e["representative_value"] == output[e["thread"] * N], "TMEM reader observation disagrees with output")
        require(data["events"][iteration * EVENTS + 10]["representative_value"] == output[0], "reuse observation disagrees with output")
    independently_checked = {
        "elements": iterations * M * N, "expected_value_mismatches": mismatches,
        "selected_source_mismatches": selected_mismatches, "version_mismatches": version_mismatches,
        "max_abs_error": max_error, "passed": mismatches == version_mismatches == 0,
        "exact_integer_reference": True,
    }
    require(data["correctness"] == independently_checked, "reported correctness disagrees with independent CPU computation")
    require(selected_mismatches == 0, "MMA numerics do not match the observed selected source")
    return {"variant": variant, "iterations": iterations, "seed": seed,
            "generation_base": str(base), "source_contract_checked": call_lines is not None,
            "selected_inputs": selected_indices, "events": len(data["events"]),
            "successful_wait_records": iterations * 4, "reader_done_records": iterations * 4,
            "same_parity_wrong_generation_iterations": same_parity_wrong_generation,
            "correctness": independently_checked}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", type=Path, nargs="+")
    parser.add_argument("--source", type=Path, default=Path(__file__).with_name("tcgen05_probe.cu"))
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    source_bytes = args.source.read_bytes()
    results = []
    for path in args.inputs:
        raw = path.read_bytes()
        result = validate(json.loads(raw), source_bytes.decode("utf-8"))
        result.update(path=str(path), bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
        results.append(result)
    report = {"format": "tcgen05-cpu-validation-v1", "source_path": str(args.source),
              "source_sha256": hashlib.sha256(source_bytes).hexdigest(),
              "validator_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "results": results,
              "limitations": ["Only this source-bound authored probe; not arbitrary CUDA or natural AI bugs.",
                              "Source contracts and runtime instrumentation, not independent trace reconstruction.",
                              "No performance or human-understanding claim; no cross-warp HB inferred from clocks."]}
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.out:
        args.out.write_text(rendered)
    print(rendered, end="")


if __name__ == "__main__":
    main()
