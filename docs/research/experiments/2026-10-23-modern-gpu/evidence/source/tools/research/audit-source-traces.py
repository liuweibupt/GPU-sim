#!/usr/bin/env python3
"""Audit reused NVBit sources without treating a trace as a correctness oracle.

The external source tree is read-only. Inventory and hash tables are stable for
unchanged bytes; summary.json also records intentionally variable run timings.
Only selected prefixes are decoded by the source repository's parser. A separate
line-level check validates grouped-block framing of selected small trace files.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import importlib
import itertools
import json
import math
import platform
import re
import subprocess
import sys
import tempfile
import time
import unittest
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def digest_verdict(actual: str, declared: object) -> str:
    if not isinstance(declared, str) or not re.fullmatch(r"[0-9a-f]{64}", declared):
        return "missing_or_invalid_declaration"
    return "match" if actual == declared else "mismatch"


def write_json(path: Path, data: object) -> None:
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")


def git_state(root: Path) -> dict:
    def run(*args: str) -> str:
        result = subprocess.run(["git", "-C", str(root), *args], text=True,
                                capture_output=True, check=True)
        return result.stdout.strip()
    return {"commit": run("rev-parse", "HEAD"),
            "status_porcelain": run("status", "--porcelain", "--untracked-files=normal")}


def validate_grouped_structure(path: Path, grid=None, block=None) -> dict:
    """Check every grouped record count and block terminator, not semantics.

    Strict UTF-8 and explicit EOF checks avoid the source parser's permissive
    replacement decoding and ignored insts declarations. Predicate masks of zero
    are valid captured records. No instruction payload decoding happens here.
    """
    open_block = False
    cta = None
    warp = None
    declared = None
    observed = 0
    count = 0
    blocks = 0
    warps = 0
    seen_ctas = set()
    seen_warps = set()
    errors = []

    def fail(line, message):
        if len(errors) < 20:
            errors.append({"line": line, "message": message})

    def finish_warp(line):
        nonlocal declared, observed, warp
        if warp is not None and declared is None:
            fail(line, "warp has no insts declaration")
        elif declared is not None and declared != observed:
            fail(line, f"insts declaration {declared} differs from {observed} records")
        declared, observed, warp = None, 0, None

    line_number = 0
    with path.open(encoding="utf-8", errors="strict") as stream:
        for line_number, raw in enumerate(stream, 1):
            line = raw.strip()
            if not line:
                continue
            if line == "#BEGIN_TB":
                if open_block:
                    fail(line_number, "nested BEGIN_TB or missing END_TB")
                finish_warp(line_number)
                open_block, cta = True, None
                blocks += 1
                seen_warps = set()
            elif line == "#END_TB":
                if not open_block:
                    fail(line_number, "END_TB without BEGIN_TB")
                if cta is None:
                    fail(line_number, "block has no CTA coordinate")
                finish_warp(line_number)
                open_block, cta = False, None
            elif line.startswith(("-", "#")):
                continue
            elif line.startswith("thread block ="):
                if not open_block:
                    fail(line_number, "CTA outside block")
                try:
                    cta = tuple(map(int, line.split("=", 1)[1].split(",")))
                    if len(cta) != 3 or min(cta) < 0:
                        raise ValueError("invalid CTA coordinate")
                    if grid is not None and any(v >= n for v, n in zip(cta, grid)):
                        fail(line_number, "CTA outside declared grid")
                    if cta in seen_ctas:
                        fail(line_number, "duplicate CTA block")
                    seen_ctas.add(cta)
                except ValueError:
                    fail(line_number, "invalid CTA coordinate")
            elif line.startswith("cluster "):
                continue
            elif line.startswith("warp ="):
                finish_warp(line_number)
                warp = int(line.split("=", 1)[1])
                if not open_block or cta is None:
                    fail(line_number, "warp outside CTA")
                if warp < 0 or (block is not None and warp >= math.ceil(math.prod(block) / 32)):
                    fail(line_number, "warp outside declared block")
                if warp in seen_warps:
                    fail(line_number, "duplicate warp in CTA")
                seen_warps.add(warp)
                warps += 1
            elif line.startswith("insts ="):
                if warp is None or declared is not None:
                    fail(line_number, "missing warp or repeated insts declaration")
                declared = int(line.split("=", 1)[1])
                if declared < 0:
                    fail(line_number, "negative insts declaration")
            else:
                if not open_block or warp is None or declared is None:
                    fail(line_number, "instruction outside declared warp")
                fields = line.split(None, 2)
                try:
                    int(fields[0], 16)
                    mask = int(fields[1], 16)
                    if not 0 <= mask <= 0xFFFFFFFF:
                        fail(line_number, "active mask outside 32 bits")
                except (ValueError, IndexError):
                    fail(line_number, "invalid instruction prefix")
                observed += 1
                count += 1
    finish_warp(line_number + 1)
    if open_block:
        fail(line_number + 1, "EOF before END_TB")
    if not blocks:
        fail(line_number + 1, "no grouped blocks")
    if grid is not None and len(seen_ctas) != math.prod(grid):
        fail(line_number + 1, "observed CTA count differs from declared grid")
    return {"scope": "full_file_grouped_framing_only", "status": "pass" if not errors else "fail",
            "line_count": line_number, "blocks": blocks, "warp_records": warps,
            "raw_instruction_records": count, "errors": errors,
            "payload_semantics_validated": False}


def selected_cases(launches: list, root: Path) -> list:
    groups = defaultdict(list)
    for launch in launches:
        groups[(launch["gpu"], launch["case"])].append(launch)
    selections = []
    for gpu in sorted({key[0] for key in groups}):
        for family in ("gemm", "rmsnorm", "multi_launch_attention"):
            candidates = []
            for (card, case), entries in groups.items():
                matches = ("gemm" in case if family == "gemm" else "rmsnorm" in case
                           if family == "rmsnorm" else "flashinfer" in case and len(entries) > 1)
                if card == gpu and matches:
                    size = sum((root / item["trace"]).stat().st_size for item in entries)
                    candidates.append((size, case, entries))
            size, case, entries = min(candidates, key=lambda item: (item[0], item[1]))
            selections.append({"gpu": gpu, "family": family, "case": case, "bytes": size,
                               "launches": sorted(entries, key=lambda item: item["trace_file"])})
    return selections


def explicit_validation_fields(value, prefix="") -> list:
    """Record explicit validation keys only; never derive correctness from timing."""
    records = []
    if isinstance(value, dict):
        for key, child in sorted(value.items()):
            location = f"{prefix}.{key}" if prefix else key
            if re.search(r"correct|validat|allclose|mismatch|error_tolerance", key, re.I):
                records.append({"path": location, "value": child})
            elif isinstance(child, (dict, list)):
                records.extend(explicit_validation_fields(child, location))
            elif key in ("stdout", "stderr") and isinstance(child, str):
                for index, line in enumerate(child.splitlines()):
                    if line.startswith("{"):
                        try:
                            parsed = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        records.extend(explicit_validation_fields(parsed, f"{location}.jsonline[{index}]"))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            records.extend(explicit_validation_fields(child, f"{prefix}[{index}]"))
    return records


def sample_launch(root: Path, launch: dict, limit: int, structure_limit: int, parser) -> dict:
    path = root / launch["trace"]
    schedule = parser.parse_sass_trace_schedule(path, require_tile=False)
    with gzip.open(root / launch["output"], "rt") as stream:
        cache = json.load(stream)
    cache_pairs = {(item["pc"], item["opcode"]) for item in cache["instruction_table"]}
    cache_opcodes_at_pc = defaultdict(set)
    for pc, opcode in cache_pairs:
        cache_opcodes_at_pc[pc].add(opcode)
    counts = Counter()
    opcodes = Counter()
    observed_pairs = set()
    unmatched = defaultdict(Counter)
    examples = []
    iterator = parser.iter_sass_instructions(path)
    more = False
    try:
        for index, instruction in enumerate(itertools.islice(iterator, limit + 1)):
            if index == limit:
                more = True
                break
            counts["instructions"] += 1
            counts["with_nonzero_active_mask"] += instruction.active_mask != 0
            counts["with_partial_active_mask"] += 0 < instruction.active_mask < 0xFFFFFFFF
            counts["with_memory_addresses"] += bool(instruction.memory_addresses)
            counts["memory_address_entries"] += len(instruction.memory_addresses)
            counts["with_register_values"] += bool(instruction.destination_values or instruction.source_values)
            counts["tma_instructions"] += instruction.is_tma
            counts["with_tma_mbarrier"] += instruction.tma_mbarrier_address is not None
            counts["with_tma_byte_count"] += instruction.tma_byte_count > 0
            counts["with_tma_multicast_mask"] += instruction.tma_multicast_mask is not None
            counts["with_tmem_columns"] += instruction.tmem_columns is not None
            counts["with_cluster_id"] += instruction.cluster_id is not None
            counts["invalid_active_mask"] += not 0 <= instruction.active_mask <= 0xFFFFFFFF
            counts["invalid_cta"] += len(instruction.cta) != 3 or any(
                v < 0 or v >= n for v, n in zip(instruction.cta, schedule.grid))
            counts["invalid_warp"] += not 0 <= instruction.warp_id < schedule.num_warps
            opcodes[instruction.opcode] += 1
            pair = (instruction.pc, instruction.opcode)
            observed_pairs.add(pair)
            if pair not in cache_pairs:
                activity = "nonzero_active_mask" if instruction.active_mask else "zero_active_mask"
                unmatched[pair][activity] += 1
                counts[f"raw_pair_absent_from_cache_{activity}"] += 1
                if any(opcode.endswith(".SIM_WAIT") for opcode in cache_opcodes_at_pc[instruction.pc]):
                    counts["raw_pair_has_same_pc_sim_wait_replacement"] += 1
            else:
                counts["raw_pair_present_in_cache"] += 1
            if len(examples) < 3:
                examples.append({"pc": instruction.pc, "opcode": instruction.opcode,
                                 "active_lane_count": instruction.active_lanes})
    finally:
        iterator.close()
    structure = (validate_grouped_structure(path, schedule.grid, schedule.block)
                 if path.stat().st_size <= structure_limit else
                 {"scope": "not_checked", "status": "skipped_size_limit", "limit_bytes": structure_limit})
    identity = cache["identity"]
    return {"gpu": launch["gpu"], "case": launch["case"], "trace": launch["trace"],
            "trace_sha256": launch["trace_sha256"], "cache": launch["output"],
            "cache_trace_identity_matches_manifest": identity["trace_sha256"] == launch["trace_sha256"],
            "cache_binary_version_matches_header": identity["binary_version"] == schedule.binary_version,
            "header": {"binary_version": schedule.binary_version, "tracer_version": schedule.tracer_version,
                       "grid": schedule.grid, "block": schedule.block, "shared_bytes": schedule.shared_bytes,
                       "registers_per_thread": schedule.registers_per_thread},
            "decode_scope": "bounded_prefix" if more else "full_file",
            "instruction_limit": limit, "has_unparsed_suffix": more,
            "availability_counts": dict(sorted(counts.items())), "opcode_counts": dict(sorted(opcodes.items())),
            "unique_pc_opcode_pairs": len(observed_pairs),
            "raw_pairs_absent_from_cache_table": [{"pc": pc, "opcode": opcode,
                                                  "raw_prefix_records": sum(activity.values()),
                                                  "activity_counts": dict(sorted(activity.items())),
                                                  "cache_opcodes_at_same_pc": sorted(cache_opcodes_at_pc[pc])}
                                                 for (pc, opcode), activity in sorted(unmatched.items())],
            "pair_comparison_note": "Existence only, not order/count equivalence; the source pipeline filters zero-mask records, canonicalizes evidenced spin loops to SIM_WAIT, and removes duplicate tensor callbacks. Active absent pairs are recorded, not assumed equivalent. A same-PC SIM_WAIT is evidence of a transformed site, not a count-preserving one-to-one match.",
            "examples_without_addresses_or_values": examples, "framing_check": structure,
            "hardware_instruction_timestamps_available": False,
            "logical_tensor_version_identity_available": False}


def audit(args) -> int:
    started = datetime.now(timezone.utc).isoformat()
    wall_start, cpu_start = time.perf_counter(), time.process_time()
    root = args.source.resolve()
    manifest_path = root / args.manifest
    manifest = json.loads(manifest_path.read_text())
    launches = sorted(manifest["launches"], key=lambda item: (item["gpu"], item["case"], item["trace_file"]))
    if len({item["trace"] for item in launches}) != len(launches):
        raise ValueError("duplicate raw trace in manifest")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    git_before = git_state(root)
    case_cache = {}
    rows, hashes, failures = [], [], []
    for launch in launches:
        path = root / launch["trace"]
        case_path = path.parent.parent / "case.json"
        if case_path not in case_cache:
            case_cache[case_path] = json.loads(case_path.read_text())
        case = case_cache[case_path]
        checkpoint_path = (root / launch["output"]).parent / (launch["trace_file"] + ".checkpoint.json")
        checkpoint = json.loads(checkpoint_path.read_text())
        trace_names, declared_hashes = case["trace"]["trace_files"], case["trace"].get("trace_sha256", [])
        case_digests = dict(zip(trace_names, declared_hashes))
        before = path.stat()
        actual = sha256_file(path)
        after = path.stat()
        stable = (before.st_size, before.st_mtime_ns, before.st_ino) == (after.st_size, after.st_mtime_ns, after.st_ino)
        verdicts = {"manifest": digest_verdict(actual, launch.get("trace_sha256")),
                    "checkpoint": digest_verdict(actual, checkpoint.get("trace_sha256")),
                    "case": digest_verdict(actual, case_digests.get(launch["trace_file"]))}
        row = {"gpu": launch["gpu"], "case": launch["case"], "trace_file": launch["trace_file"],
               "trace": launch["trace"], "bytes": after.st_size, "sha256": actual,
               **{f"{name}_hash_verdict": value for name, value in verdicts.items()},
               "source_unchanged_during_hash": stable, "binary_version_manifest": launch["binary_version"],
               "case_hardware_median_ms": case.get("hardware", {}).get("measured_ms"),
               "case_launch_count": len(trace_names), "case_sha256": sha256_file(case_path),
               "checkpoint_sha256": sha256_file(checkpoint_path)}
        rows.append(row)
        hashes.append({key: row[key] for key in ("gpu", "case", "trace", "bytes", "sha256", "case_sha256", "checkpoint_sha256")})
        if not stable or any(value != "match" for value in verdicts.values()):
            failures.append({"trace": launch["trace"], "hash_verdicts": verdicts,
                             "source_unchanged_during_hash": stable})
    with (output / "source_inventory.csv").open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    write_json(output / "source-hashes.json", {"format": "gpu-source-hash-audit-v1",
                                               "manifest_sha256": sha256_file(manifest_path), "sources": hashes})
    # Preserve the read-only source-tree contract even when the caller does not
    # set PYTHONDONTWRITEBYTECODE: importing its parser must not create pyc files.
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(root))
    parser = importlib.import_module("gpu_tile_sim.comparison.sass_trace")
    selections = selected_cases(launches, root)
    samples = []
    for selection in selections:
        for launch in selection["launches"]:
            try:
                sample = sample_launch(root, launch, args.prefix_instructions, args.structure_limit_bytes, parser)
            except Exception as error:
                sample = {"gpu": launch["gpu"], "case": launch["case"], "trace": launch["trace"],
                          "status": "error", "error": f"{type(error).__name__}: {error}"}
                failures.append(sample)
            if sample.get("framing_check", {}).get("status") == "fail":
                failures.append({"trace": launch["trace"], "framing_check": sample["framing_check"]})
            if any(sample.get("availability_counts", {}).get(key, 0) for key in
                   ("invalid_active_mask", "invalid_cta", "invalid_warp")):
                failures.append({"trace": launch["trace"], "invalid_decoded_identity": sample["availability_counts"]})
            if sample.get("cache_trace_identity_matches_manifest") is False or sample.get("cache_binary_version_matches_header") is False:
                failures.append({"trace": launch["trace"], "cache_identity_mismatch": True})
            samples.append(sample)
    write_json(output / "samples.json", {"selection_rule": "Within each GPU, smallest total trace bytes per GEMM, RMSNorm, and multi-launch attention case; ties lexicographic.",
                                          "selected_cases": [{key: value for key, value in item.items() if key != "launches"} for item in selections],
                                          "samples": samples})
    validation = [{"case": value.get("case_id", value.get("case")), "gpu": value.get("gpu"),
                   "explicit_fields": explicit_validation_fields(value)} for _, value in sorted(case_cache.items())]
    write_json(output / "case-validation-metadata.json", {"cases": validation,
                "scope": "Explicit key names and JSON stdout/stderr lines in case.json only; not a numerical rerun or proof of correctness."})
    parser_files = sorted((root / "gpu_tile_sim/comparison").glob("sass_*.py"))
    summary = {"format": "gpu-source-audit-summary-v1", "started_utc": started,
               "source_root": str(root), "manifest": str(manifest_path), "manifest_sha256": sha256_file(manifest_path),
               "source_git_before": git_before, "source_git_after": git_state(root),
               "machine": {"hostname": platform.node(), "platform": platform.platform(), "python": sys.version},
               "audit_script_sha256": sha256_file(Path(__file__)),
               "source_parser_sha256": {str(path.relative_to(root)): sha256_file(path) for path in parser_files},
               "launch_count": len(rows), "case_count": len(case_cache), "total_raw_bytes": sum(row["bytes"] for row in rows),
               "per_gpu": {gpu: {"launches": sum(row["gpu"] == gpu for row in rows),
                                  "cases": len({row["case"] for row in rows if row["gpu"] == gpu}),
                                  "bytes": sum(row["bytes"] for row in rows if row["gpu"] == gpu)}
                           for gpu in sorted({row["gpu"] for row in rows})},
               "hash_verdicts": {name: dict(Counter(row[f"{name}_hash_verdict"] for row in rows))
                                 for name in ("manifest", "checkpoint", "case")},
               "selected_case_count": len(selections), "sampled_launch_count": len(samples),
               "decoded_instruction_records": sum(item.get("availability_counts", {}).get("instructions", 0) for item in samples),
               "raw_cache_pair_comparison_counts": {key: sum(item.get("availability_counts", {}).get(key, 0) for item in samples)
                                                    for key in ("raw_pair_present_in_cache", "raw_pair_absent_from_cache_zero_active_mask",
                                                                "raw_pair_absent_from_cache_nonzero_active_mask", "raw_pair_has_same_pc_sim_wait_replacement")},
               "full_file_framing_checks": dict(Counter(item.get("framing_check", {}).get("status", "error") for item in samples)),
               "cases_with_explicit_validation_fields": sum(bool(item["explicit_fields"]) for item in validation),
               "failures": failures, "cpu_seconds": time.process_time() - cpu_start,
               "wall_seconds": time.perf_counter() - wall_start,
               "limits": ["SHA equality checks provenance consistency, not scientific correctness or completeness of tracing.",
                          "Raw instruction decoding is bounded; full-file framing checks do not validate every payload.",
                          "Cached model latency/issue cycles are not measured instruction timestamps.",
                          "Hardware median copied from case metadata is case-level, repeated for its launches; do not sum repeated rows.",
                          "Missing numerical-validation metadata means unknown, not pass."]}
    write_json(output / "summary.json", summary)
    print(json.dumps({"output": str(output), "launches": len(rows), "raw_bytes": summary["total_raw_bytes"],
                      "failures": len(failures), "wall_seconds": summary["wall_seconds"]}))
    return 1 if failures else 0


class AuditFailureTests(unittest.TestCase):
    def test_hash_mismatch_and_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trace"
            path.write_bytes(b"original")
            expected = sha256_file(path)
            self.assertEqual(digest_verdict(expected, expected), "match")
            path.write_bytes(b"changed")
            self.assertEqual(digest_verdict(sha256_file(path), expected), "mismatch")
            self.assertEqual(digest_verdict(expected, None), "missing_or_invalid_declaration")

    def check_structure(self, text):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.traceg"
            path.write_text(text)
            return validate_grouped_structure(path, (1, 1, 1), (32, 1, 1))

    def test_complete_and_truncated_records(self):
        prefix = "#BEGIN_TB\nthread block = 0,0,0\nwarp = 0\ninsts = 2\n0000 ffffffff 0 EXIT 0 0\n"
        valid = prefix + "0010 00000000 0 EXIT 0 0\n#END_TB\n"
        self.assertEqual(self.check_structure(valid)["status"], "pass")
        self.assertEqual(self.check_structure(prefix)["status"], "fail")
        self.assertEqual(self.check_structure(prefix + "#END_TB\n")["status"], "fail")

    def test_invalid_mask_and_cta(self):
        text = "#BEGIN_TB\nthread block = 1,0,0\nwarp = 0\ninsts = 1\n0000 1ffffffff 0 EXIT 0 0\n#END_TB\n"
        result = self.check_structure(text)
        self.assertEqual(result["status"], "fail")
        self.assertTrue(any("mask" in error["message"] for error in result["errors"]))
        self.assertTrue(any("CTA" in error["message"] for error in result["errors"]))

    def test_timing_is_not_validation(self):
        self.assertEqual(explicit_validation_fields({"hardware": {"measured_ms": 1.2}}), [])
        self.assertEqual(explicit_validation_fields({"stdout": '{"correct": false}'}),
                         [{"path": "stdout.jsonline[0].correct", "value": False}])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("/home/liuwei/GPU-simulator"))
    parser.add_argument("--manifest", type=Path, default=Path("data/ysim_dse_programs_20261009/manifest.json"))
    parser.add_argument("--output", type=Path, default=Path("out/research/trace-source-audit") / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--prefix-instructions", type=int, default=10000)
    parser.add_argument("--structure-limit-bytes", type=int, default=100_000_000)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        suite = unittest.defaultTestLoader.loadTestsFromTestCase(AuditFailureTests)
        return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1
    if args.prefix_instructions <= 0 or args.structure_limit_bytes <= 0:
        parser.error("positive sampling limits required")
    return audit(args)


if __name__ == "__main__":
    raise SystemExit(main())
