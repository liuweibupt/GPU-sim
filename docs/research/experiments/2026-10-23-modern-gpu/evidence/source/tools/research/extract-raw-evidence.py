#!/usr/bin/env python3
"""Export complete recorded CTA0 streams, preserving raw NVBit instruction fields.

All input trace bytes are hashed and all grouped framing is checked. The source
parser decodes only the prefix through the final CTA0 record. No normalization,
zero-mask filtering, implicit-register expansion, or cross-warp ordering is used.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import importlib
import importlib.util
import json
import math
import platform
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.dont_write_bytecode = True
FORMAT = "gpu-raw-cta-evidence-v1"
FOOTPRINT_SHA = "912c4bdcf13bf541b3785e5f60854bc29e47015be93cb0e5ee6bfd2854609f89"
FOOTPRINT_PATH = "docs/results/ysim_dse_resource_modeling_20261009/tmem_lowering/cutlass_m8_n768_k384_footprints.json"


def load_local_audit():
    spec = importlib.util.spec_from_file_location("gpu_source_audit", Path(__file__).with_name("audit-source-traces.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


AUDIT = load_local_audit()
sha256_file = AUDIT.sha256_file


def object_schema(properties):
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


COUNT = {"type": "integer", "minimum": 0}
NULL_COUNT = {"type": ["integer", "null"], "minimum": 0}
TEXT = {"type": "string"}
FLAG = {"type": "boolean"}
HEX = {"type": "string", "pattern": r"^0x[0-9a-f]+$"}
NULL_HEX = {"type": ["string", "null"], "pattern": r"^0x[0-9a-f]+$"}
DECIMAL = {"type": "string", "pattern": r"^-?(0|[1-9][0-9]*)$"}
SHA = {"type": "string", "pattern": r"^[0-9a-f]{64}$"}
COORD = {"type": "array", "items": COUNT, "minItems": 3, "maxItems": 3}
NULL_COORD = {**COORD, "type": ["array", "null"]}


def array_schema(items):
    return {"type": "array", "items": items}


INSTRUCTION_PROPERTIES = {
    "id": TEXT, "warp_ordinal": COUNT, "cta_record_ordinal": COUNT,
    "file_record_ordinal": COUNT, "source_line": {"type": "integer", "minimum": 1},
    "cta": COORD, "warp_id": COUNT, "pc": COUNT,
    "active_mask": {"type": "integer", "minimum": 0, "maximum": 0xFFFFFFFF},
    "destinations": array_schema(TEXT), "sources": array_schema(TEXT), "opcode": TEXT,
    "memory_width_bytes": COUNT, "memory_addresses": array_schema(HEX),
    "destination_values": array_schema(array_schema(HEX)), "source_values": array_schema(array_schema(HEX)),
    "gmma_commit_group": FLAG, "tma_mbarrier_address": NULL_HEX, "tma_multicast_mask": NULL_COUNT,
    "tma_byte_count": COUNT, "tma_oob_byte_count": COUNT, "immediate": DECIMAL, "immediate2": DECIMAL,
    "cluster_id": NULL_COORD, "cluster_cta": NULL_COORD, "cluster_rank": NULL_COUNT, "tmem_columns": NULL_COUNT,
    "register_values_marker": {"type": "string", "enum": ["Val", "NoVal", "not_available_in_format"]},
    "raw_payload_presence": object_schema({key: FLAG for key in
        ("gmma_commit_group", "tma_payload", "immediate", "immediate2", "register_values")}),
}
INSTRUCTION_SCHEMA = object_schema(INSTRUCTION_PROPERTIES)
HEADER_PROPERTIES = {"kernel_name": TEXT, "grid": COORD, "block": COORD, "shared_bytes": COUNT,
    "registers_per_thread": COUNT, "binary_version": COUNT, "tracer_version": COUNT,
    "shared_base_address": NULL_HEX, "local_base_address": NULL_HEX, "tile_m": NULL_COUNT,
    "tile_n": NULL_COUNT, "tile_k": NULL_COUNT, "num_stages": NULL_COUNT,
    "cta_count": COUNT, "num_warps": COUNT}
SOURCE_SCHEMA = object_schema({"source_root": TEXT, "trace": TEXT, "trace_sha256": SHA,
    "gpu": TEXT, "case": TEXT, "view_ids": array_schema(TEXT), "purpose": TEXT,
    "inventory_sha256": SHA, "archive_selection_sha256": {"type": "object", "additionalProperties": SHA}})
SELECTION_SCHEMA = object_schema({"cta": COORD, "cta_complete_as_recorded": FLAG,
    "all_declared_warps_included": FLAG, "capture_completeness": {"type": "string", "const": "unknown"},
    "active_mask_semantics": {"type": "string", "const": "unverified"},
    "cross_warp_happens_before_inferred": {"type": "boolean", "const": False},
    "raw_records_total_in_file": COUNT, "raw_records_selected": COUNT, "raw_records_not_exported": COUNT,
    "parser_decoded_prefix_records": COUNT, "parser_unparsed_suffix_records": COUNT,
    "cta_begin_line": COUNT, "cta_end_line": COUNT, "full_file_framing_verified": FLAG})
COVERAGE_SCHEMA = {"type": "object", "additionalProperties": COUNT}
EXTERNAL_EVIDENCE_SCHEMA = object_schema({"kind": TEXT, "path": TEXT, "sha256": SHA,
    "trace_sha256": SHA, "static_sass_path": TEXT, "static_sass_sha256": SHA,
    "source_pair_verified": FLAG, "raw_fields_modified": {"type": "boolean", "const": False},
    "columns_by_site": array_schema(object_schema({"pc": COUNT, "opcode": TEXT, "columns": COUNT})),
    "provenance": TEXT})
DOCUMENT_SCHEMA = {"$schema": "https://json-schema.org/draft/2020-12/schema", **object_schema({
    "format": {"type": "string", "const": FORMAT}, "source": SOURCE_SCHEMA,
    "header": object_schema(HEADER_PROPERTIES), "selection": SELECTION_SCHEMA,
    "warps": array_schema(object_schema({"warp_id": COUNT, "declared_instruction_count": COUNT,
                                         "instructions": array_schema(INSTRUCTION_SCHEMA)})),
    "coverage": COVERAGE_SCHEMA, "external_evidence": array_schema(EXTERNAL_EVIDENCE_SCHEMA),
    "interpretation_limits": array_schema(TEXT),
})}


def validate_schema(value, schema, location="$"):
    """Dependency-free validation of every schema keyword used above."""
    types = schema.get("type", [])
    types = [types] if isinstance(types, str) else types
    actual = ("null" if value is None else "boolean" if isinstance(value, bool) else
              "integer" if isinstance(value, int) else "string" if isinstance(value, str) else
              "array" if isinstance(value, list) else "object" if isinstance(value, dict) else "unsupported")
    if types and actual not in types:
        raise ValueError(f"{location}: expected {types}, got {actual}")
    if "const" in schema and value != schema["const"]:
        raise ValueError(f"{location}: incorrect constant")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{location}: not in enum")
    if actual == "object":
        missing = set(schema.get("required", [])) - value.keys()
        if missing:
            raise ValueError(f"{location}: missing fields {sorted(missing)}")
        properties = schema.get("properties", {})
        for key, child in value.items():
            rule = properties.get(key, schema.get("additionalProperties", True))
            if rule is False:
                raise ValueError(f"{location}: unexpected field {key}")
            if isinstance(rule, dict):
                validate_schema(child, rule, f"{location}.{key}")
    elif actual == "array":
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", math.inf):
            raise ValueError(f"{location}: invalid array length")
        for index, child in enumerate(value):
            validate_schema(child, schema.get("items", {}), f"{location}[{index}]")
    elif actual == "integer":
        if value < schema.get("minimum", -math.inf) or value > schema.get("maximum", math.inf):
            raise ValueError(f"{location}: outside integer range")
    elif actual == "string" and "pattern" in schema and not re.fullmatch(schema["pattern"], value):
        raise ValueError(f"{location}: invalid string encoding")


def collect_cta0_metadata(path: Path, expected_warps: int) -> dict:
    """Require a closed CTA0 block and all warp declarations, preserving raw lines."""
    in_block = False
    target = False
    cta = None
    warp = None
    records = []
    declarations = {}
    seen_counts = Counter()
    file_ordinal = 0
    begin_line = None
    pending_begin_line = None
    with path.open(encoding="utf-8", errors="strict") as stream:
        for line_number, raw in enumerate(stream, 1):
            line = raw.strip()
            if not line:
                continue
            if line == "#BEGIN_TB":
                if in_block:
                    raise ValueError("nested BEGIN_TB")
                in_block, cta, warp = True, None, None
                pending_begin_line = line_number
            elif line == "#END_TB":
                if not in_block:
                    raise ValueError("END_TB outside block")
                if target:
                    if set(declarations) != set(range(expected_warps)):
                        raise ValueError("CTA0 does not declare every expected warp")
                    for key, declared in declarations.items():
                        if seen_counts[key] != declared:
                            raise ValueError(f"CTA0 warp {key} insts count mismatch")
                    return {"records": records, "declarations": declarations,
                            "begin_line": begin_line, "end_line": line_number}
                in_block, cta, warp = False, None, None
            elif line.startswith(("-", "#")):
                continue
            elif line.startswith("thread block ="):
                cta = tuple(map(int, line.split("=", 1)[1].split(",")))
                target = cta == (0, 0, 0)
                if target:
                    begin_line = pending_begin_line
            elif line.startswith("cluster "):
                continue
            elif line.startswith("warp ="):
                warp = int(line.split("=", 1)[1])
                if target and warp in declarations:
                    raise ValueError("duplicate CTA0 warp")
            elif line.startswith("insts ="):
                if target:
                    if warp is None or warp in declarations:
                        raise ValueError("invalid CTA0 insts declaration")
                    declarations[warp] = int(line.split("=", 1)[1])
            else:
                if not in_block or cta is None or warp is None:
                    raise ValueError("instruction outside CTA/warp")
                if target:
                    if warp not in declarations:
                        raise ValueError("instruction before insts declaration")
                    tokens = line.split()
                    records.append({"source_line": line_number, "file_record_ordinal": file_ordinal,
                                    "cta_record_ordinal": len(records), "warp_id": warp,
                                    "warp_ordinal": seen_counts[warp], "tokens": tokens})
                    seen_counts[warp] += 1
                file_ordinal += 1
    raise ValueError("missing complete CTA0 block (EOF before END_TB or no CTA0)")


def validate_raw_trailer(tokens, instruction, version, payload_module):
    destination_count = int(tokens[2])
    opcode_index = 3 + destination_count
    source_count = int(tokens[opcode_index + 1])
    cursor = opcode_index + 2 + source_count
    has_commit = "GMMA" in instruction.opcode
    cursor += int(has_commit)
    memory_width = int(tokens[cursor])
    cursor += 1
    payload = payload_module._memory_payload(tokens, cursor=cursor, opcode=instruction.opcode,
                                             active_mask=instruction.active_mask, memory_width=memory_width)
    immediate_count = 2 if version >= 6 else 1
    if len(tokens) < payload.cursor + immediate_count:
        raise ValueError("truncated raw immediate trailer; parser defaults are not accepted")
    marker = "not_available_in_format"
    if version >= 6:
        marker_index = payload.cursor + immediate_count
        if marker_index >= len(tokens) or tokens[marker_index] not in ("Val", "NoVal"):
            raise ValueError("missing raw v6 register-value marker")
        marker = tokens[marker_index]
    return marker, {"gmma_commit_group": has_commit, "tma_payload": instruction.is_tma,
                    "immediate": True, "immediate2": version >= 6, "register_values": marker == "Val"}


def encode_instruction(instruction, metadata, trace_sha, marker, presence):
    output = {key: getattr(instruction, key) for key in (
        "cta", "warp_id", "pc", "active_mask", "destinations", "sources", "opcode",
        "memory_width_bytes", "memory_addresses", "destination_values", "source_values",
        "gmma_commit_group", "tma_mbarrier_address", "tma_multicast_mask", "tma_byte_count",
        "tma_oob_byte_count", "immediate", "immediate2", "cluster_id", "cluster_cta", "cluster_rank", "tmem_columns")}
    for key in ("cta", "destinations", "sources", "cluster_id", "cluster_cta"):
        if output[key] is not None:
            output[key] = list(output[key])
    output["memory_addresses"] = [hex(value) for value in output["memory_addresses"]]
    for key in ("destination_values", "source_values"):
        output[key] = [[hex(value) for value in group] for group in output[key]]
    if output["tma_mbarrier_address"] is not None:
        output["tma_mbarrier_address"] = hex(output["tma_mbarrier_address"])
    output["immediate"], output["immediate2"] = str(output["immediate"]), str(output["immediate2"])
    output.update({key: metadata[key] for key in
                   ("source_line", "file_record_ordinal", "cta_record_ordinal", "warp_ordinal")})
    output["id"] = f"{trace_sha}:cta:0,0,0:warp:{instruction.warp_id}:record:{metadata['warp_ordinal']}"
    output["register_values_marker"] = marker
    output["raw_payload_presence"] = presence
    return output


def check_digest(path: Path, expected: str) -> str:
    actual = sha256_file(path)
    if actual != expected:
        raise ValueError(f"source SHA256 mismatch: {path}")
    return actual


def extract_one(root, entry, parser, payload_module, inventory_hash, archive_hashes):
    path = root / entry["trace"]
    before = path.stat()
    check_digest(path, entry["sha256"])
    schedule = parser.parse_sass_trace_schedule(path, require_tile=False)
    framing = AUDIT.validate_grouped_structure(path, schedule.grid, schedule.block)
    if framing["status"] != "pass":
        raise ValueError(f"full-file framing rejected: {path}: {framing['errors']}")
    metadata = collect_cta0_metadata(path, schedule.num_warps)
    if not metadata["records"]:
        raise ValueError("CTA0 has no recorded instructions")
    expected = {item["file_record_ordinal"]: item for item in metadata["records"]}
    final_ordinal = max(expected)
    warps = defaultdict(list)
    coverage = Counter()
    iterator = parser.iter_sass_instructions(path)
    try:
        for ordinal in range(final_ordinal + 1):
            try:
                instruction = next(iterator)
            except StopIteration as exc:
                raise ValueError("parser ended before complete CTA0") from exc
            item = expected.get(ordinal)
            if item is None:
                if instruction.cta == (0, 0, 0):
                    raise ValueError("parser/line scanner disagree about CTA0 boundary")
                continue
            if instruction.cta != (0, 0, 0) or instruction.warp_id != item["warp_id"]:
                raise ValueError("parser/line scanner disagree about CTA/warp identity")
            if instruction.pc != int(item["tokens"][0], 16) or instruction.active_mask != int(item["tokens"][1], 16):
                raise ValueError("parser/line scanner disagree about raw PC or mask")
            marker, presence = validate_raw_trailer(item["tokens"], instruction, schedule.tracer_version, payload_module)
            encoded = encode_instruction(instruction, item, entry["sha256"], marker, presence)
            warps[instruction.warp_id].append(encoded)
            coverage["records"] += 1
            coverage["zero_active_mask_records"] += instruction.active_mask == 0
            coverage["partial_active_mask_records"] += 0 < instruction.active_mask < 0xFFFFFFFF
            coverage["memory_address_records"] += bool(instruction.memory_addresses)
            coverage["memory_address_entries"] += len(instruction.memory_addresses)
            coverage["register_value_records"] += marker == "Val"
            coverage["register_value_entries"] += sum(map(len, (*instruction.destination_values, *instruction.source_values)))
            coverage["tma_records"] += instruction.is_tma
            coverage["tma_mbarrier_records"] += instruction.tma_mbarrier_address is not None
            coverage["tma_byte_count_records"] += instruction.tma_byte_count > 0
            coverage["tmem_columns_records"] += instruction.tmem_columns is not None
            coverage["cluster_identity_records"] += instruction.cluster_id is not None
    finally:
        iterator.close()
    after = path.stat()
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
        raise ValueError("source changed during extraction")
    header = schedule.to_dict()
    for key in ("shared_base_address", "local_base_address"):
        if header[key] is not None:
            header[key] = hex(header[key])
    document = {"format": FORMAT,
        "source": {"source_root": str(root), "trace": entry["trace"], "trace_sha256": entry["sha256"],
                   "gpu": entry["gpu"], "case": entry["case"], "view_ids": sorted(entry["view_ids"]),
                   "purpose": entry["purpose"], "inventory_sha256": inventory_hash,
                   "archive_selection_sha256": archive_hashes},
        "header": header,
        "selection": {"cta": [0, 0, 0], "cta_complete_as_recorded": True, "all_declared_warps_included": True,
                      "capture_completeness": "unknown", "active_mask_semantics": "unverified",
                      "cross_warp_happens_before_inferred": False,
                      "raw_records_total_in_file": framing["raw_instruction_records"],
                      "raw_records_selected": coverage["records"],
                      "raw_records_not_exported": framing["raw_instruction_records"] - coverage["records"],
                      "parser_decoded_prefix_records": final_ordinal + 1,
                      "parser_unparsed_suffix_records": framing["raw_instruction_records"] - final_ordinal - 1,
                      "cta_begin_line": metadata["begin_line"], "cta_end_line": metadata["end_line"],
                      "full_file_framing_verified": True},
        "warps": [{"warp_id": warp, "declared_instruction_count": declared, "instructions": warps[warp]}
                  for warp, declared in sorted(metadata["declarations"].items())],
        "coverage": dict(sorted(coverage.items())), "external_evidence": [],
        "interpretation_limits": [
            "All CTA0 records present in this captured file are retained, including zero-mask records and repeated callbacks.",
            "The active_mask field is copied; whether it includes the instruction predicate is unverified.",
            "Explicit register operands are not a complete architectural def-use model; no implicit-width expansion is applied.",
            "Register-value groups and address lists preserve parser order; lane mapping and value capture time require tracer semantics.",
            "The declared tracer revision captures Val before instruction execution; destination_values must not be interpreted as writeback or a successful wait. The actual tracer binary is not hash-bound here.",
            "Default-valued parser fields are distinguished by raw_payload_presence; absent information is not proof of zero activity.",
            "No global instruction timestamps, logical tensor versions, or cross-warp happens-before relations are inferred.",
            "TMEM footprint evidence, when separately bound, remains compiler/source evidence and never changes raw tmem_columns.",
        ]}
    validate_document(document)
    return document


def validate_document(document):
    validate_schema(document, DOCUMENT_SCHEMA)
    seen = set()
    total = 0
    cta_ordinals = []
    for warp in document["warps"]:
        if len(warp["instructions"]) != warp["declared_instruction_count"]:
            raise ValueError("exported warp count differs from declaration")
        for index, instruction in enumerate(warp["instructions"]):
            if instruction["warp_ordinal"] != index or instruction["warp_id"] != warp["warp_id"]:
                raise ValueError("invalid per-warp order/identity")
            if instruction["cta"] != [0, 0, 0] or instruction["id"] in seen:
                raise ValueError("invalid CTA identity or repeated raw record ID")
            expected_id = f"{document['source']['trace_sha256']}:cta:0,0,0:warp:{warp['warp_id']}:record:{index}"
            if instruction["id"] != expected_id:
                raise ValueError("raw record ID does not bind trace/warp/ordinal")
            cta_ordinals.append(instruction["cta_record_ordinal"])
            seen.add(instruction["id"])
            total += 1
    if sorted(cta_ordinals) != list(range(total)):
        raise ValueError("CTA record ordinal coverage is incomplete")
    if total != document["selection"]["raw_records_selected"] or total != document["coverage"]["records"]:
        raise ValueError("export total inconsistent")
    if {warp["warp_id"] for warp in document["warps"]} != set(range(document["header"]["num_warps"])):
        raise ValueError("missing CTA warp")


def load_selection(archive, inventory, include_footprint):
    rows = list(csv.DictReader(inventory.open()))
    by_hash = {row["sha256"]: row for row in rows}
    chosen = {}
    archive_hashes = {}
    for name in ("selected-views.json.gz", "supplemental-views.json.gz"):
        path = archive / "trace" / name
        archive_hashes[name] = sha256_file(path)
        with gzip.open(path, "rt") as stream:
            views = json.load(stream)["views"]
        for view in views:
            digest = view["trace_sha256"]
            row = by_hash[digest]
            if row["trace"] != view["trace"] or any(row[f"{key}_hash_verdict"] != "match" for key in ("case", "checkpoint", "manifest")):
                raise ValueError("selected view/inventory provenance mismatch")
            entry = chosen.setdefault(digest, {**row, "view_ids": [], "purpose": "primary-selected-views"})
            entry["view_ids"].append(view["view_id"])
    if include_footprint:
        if FOOTPRINT_SHA in chosen:
            raise ValueError("footprint case unexpectedly overlaps primary selection")
        chosen[FOOTPRINT_SHA] = {**by_hash[FOOTPRINT_SHA], "view_ids": [], "purpose": "tmem-footprint"}
    return sorted(chosen.values(), key=lambda item: (item["purpose"], item["gpu"], item["case"])), archive_hashes


def bind_external_footprint(document, root, static_sass_path):
    path = root / FOOTPRINT_PATH
    module = importlib.import_module("gpu_tile_sim.comparison.sass_tmem_footprint")
    verified = module.load_tmem_footprint_manifest(path, trace_path=root / document["source"]["trace"],
                                                   static_sass_path=static_sass_path)
    document["external_evidence"].append({"kind": "compiler-source-tmem-footprint", "path": FOOTPRINT_PATH,
        "sha256": sha256_file(path), "trace_sha256": verified.trace_sha256,
        "static_sass_path": str(static_sass_path.relative_to(root)), "static_sass_sha256": verified.static_sass_sha256,
        "source_pair_verified": True, "raw_fields_modified": False, "provenance": verified.provenance,
        "columns_by_site": [{"pc": pc, "opcode": opcode, "columns": columns}
                            for (pc, opcode), columns in sorted(verified.columns_by_site.items())]})
    validate_document(document)


def write_gzip_json(path, value):
    raw = (json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n").encode()
    path.write_bytes(gzip.compress(raw, mtime=0))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path("/home/liuwei/GPU-simulator"))
    parser.add_argument("--archive", type=Path, default=Path("docs/research/experiments/2026-10-23-multigpu"))
    parser.add_argument("--output", type=Path, default=Path("out/research/raw-evidence") / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--footprint-static-sass", type=Path)
    args = parser.parse_args()
    wall, cpu = time.perf_counter(), time.process_time()
    root, archive, output = args.source.resolve(), args.archive.resolve(), args.output.resolve()
    inventory = archive / "source-audit/source_inventory.csv"
    entries, archive_hashes = load_selection(archive, inventory, args.footprint_static_sass is not None)
    output.mkdir(parents=True, exist_ok=False)
    git_before = AUDIT.git_state(root)
    sys.path.insert(0, str(root))
    source_parser = importlib.import_module("gpu_tile_sim.comparison.sass_trace")
    payload_module = importlib.import_module("gpu_tile_sim.comparison.sass_trace_payload")
    results = []
    for entry in entries:
        document = extract_one(root, entry, source_parser, payload_module, sha256_file(inventory), archive_hashes)
        if entry["purpose"] == "tmem-footprint":
            bind_external_footprint(document, root, args.footprint_static_sass.resolve())
        filename = f"{entry['gpu']}-{entry['sha256'][:16]}.json.gz"
        path = output / filename
        write_gzip_json(path, document)
        results.append({"path": filename, "sha256": sha256_file(path), "bytes": path.stat().st_size,
                        "trace": entry["trace"], "trace_sha256": entry["sha256"], "gpu": entry["gpu"],
                        "case": entry["case"], "purpose": entry["purpose"], "view_ids": entry["view_ids"],
                        "warp_count": len(document["warps"]), "coverage": document["coverage"],
                        "selection": document["selection"]})
    AUDIT.write_json(output / "raw-evidence.schema.json", DOCUMENT_SCHEMA)
    parser_files = sorted((root / "gpu_tile_sim/comparison").glob("sass_*.py"))
    sources = {"extractor_sha256": sha256_file(Path(__file__)),
               "framing_audit_sha256": sha256_file(Path(__file__).with_name("audit-source-traces.py")),
               "inventory_sha256": sha256_file(inventory), "archive_selection_sha256": archive_hashes,
               "source_parser_sha256": {str(path.relative_to(root)): sha256_file(path) for path in parser_files}}
    AUDIT.write_json(output / "source-hashes.json", sources)
    summary = {"format": FORMAT, "generated_utc": datetime.now(timezone.utc).isoformat(),
               "source_root": str(root), "archive": str(archive), "files": results,
               "primary_trace_count": sum(item["purpose"] == "primary-selected-views" for item in results),
               "supplemental_trace_count": sum(item["purpose"] != "primary-selected-views" for item in results),
               "primary_records": sum(item["coverage"]["records"] for item in results if item["purpose"] == "primary-selected-views"),
               "supplemental_records": sum(item["coverage"]["records"] for item in results if item["purpose"] != "primary-selected-views"),
               "source_hashes": sources, "source_git_before": git_before, "source_git_after": AUDIT.git_state(root),
               "machine": {"hostname": platform.node(), "platform": platform.platform(), "python": sys.version},
               "wall_seconds": time.perf_counter() - wall, "cpu_seconds": time.process_time() - cpu}
    AUDIT.write_json(output / "summary.json", summary)
    print(json.dumps({"output": str(output), "primary_traces": summary["primary_trace_count"],
                      "supplemental_traces": summary["supplemental_trace_count"],
                      "primary_records": summary["primary_records"], "supplemental_records": summary["supplemental_records"],
                      "wall_seconds": summary["wall_seconds"]}))


if __name__ == "__main__":
    main()
