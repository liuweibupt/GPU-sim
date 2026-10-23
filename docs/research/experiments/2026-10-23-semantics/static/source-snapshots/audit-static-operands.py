#!/usr/bin/env python3
"""Hash-bound static/raw operand syntax audit; deliberately not an ISA decoder."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import csv
import gzip
import hashlib
import json
from pathlib import Path
import re
import sys
import time


FUNCTION = re.compile(r"^\s*Function : (.+?)\s*$")
INSTRUCTION = re.compile(r"^\s*/\*([0-9a-fA-F]+)\*/\s+(?:(@!?[UP]?P(?:T|\d+))\s+)?([A-Za-z][A-Za-z0-9_.]*)\s*(.*?)\s*;")
GPR = re.compile(r"\b(?:UR(?:\d+|Z)|R(?:\d+|Z))\b")
NONCONSTANT_PREDICATE = re.compile(r"\bU?P\d+\b")
CONSTANT_MEMORY = re.compile(r"\b(?:c|cx)\[")
SCALAR_FAMILIES = {"MOV", "FFMA", "FADD", "FMUL", "IADD3"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def parse_variants(path, kernel):
    """Keep operand spelling and guard for every exact Function code object."""
    variants, current, active = [], {}, False
    for line_number, line in enumerate(Path(path).read_text(errors="strict").splitlines(), 1):
        function = FUNCTION.match(line)
        if function:
            if active and current:
                variants.append(current)
            current, active = {}, function.group(1) == kernel
            continue
        if not active:
            continue
        instruction = INSTRUCTION.match(line)
        if instruction:
            pc, guard, opcode, operands = instruction.groups()
            pc = int(pc, 16)
            require(pc not in current, f"duplicate PC in static code object: {pc:#x}")
            current[pc] = {"guard": guard, "opcode": opcode.upper(), "operands": operands, "line": line_number}
    if active and current:
        variants.append(current)
    require(bool(variants), "no exact-kernel static code object")
    return variants


def select_variants(variants, records):
    dynamic_sites = {(record["pc"], record["opcode"].upper()) for record in records}
    return [variant for variant in variants if all(
        (pc in variant and variant[pc]["opcode"] == opcode) or
        (opcode == "NOP" and pc == max(variant) + 16)
        for pc, opcode in dynamic_sites)]


def unique_site(variants, pc):
    sites = [variant.get(pc) for variant in variants]
    if any(site is None for site in sites):
        return None
    signatures = {(site["guard"], site["opcode"], site["operands"]) for site in sites}
    return {**sites[0], "matching_variant_lines": [site["line"] for site in sites]} if len(signatures) == 1 else None


def operand_tokens(operands):
    # ONLY a lexical convention for the five named scalar families. It is not
    # valid as a general source/destination decoder for arbitrary SASS.
    fields = operands.split(",")
    def tokens(text):
        return ["R255" if value == "RZ" else "UR63" if value == "URZ" else value for value in GPR.findall(text)]
    return tokens(fields[0]), [token for field in fields[1:] for token in tokens(field)]


def strict_syntax(site, destinations, sources):
    return (site["opcode"] in SCALAR_FAMILIES and len(destinations) == 1 and destinations[0] != "R255"
            and all(register.startswith("R") for register in destinations + sources)
            and not NONCONSTANT_PREDICATE.search(site["operands"])
            and not CONSTANT_MEMORY.search(site["operands"]))


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def write_csv(path, rows):
    with path.open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        for row in rows:
            writer.writerow({key: json.dumps(value, sort_keys=True) if isinstance(value, (dict, list)) else value for key, value in row.items()})


def run(args):
    started = time.perf_counter()
    source_root, raw_root = args.source_root.resolve(), args.raw_evidence.resolve()
    sys.path.insert(0, str(source_root))
    from gpu_tile_sim.comparison import sass_artifacts, sass_control
    manifest_path = source_root / "data/ysim_dse_programs_20261009/manifest.json"
    static_manifest_path = source_root / "data/microarchitecture/static_sass_profiles_v1.json"
    manifest = json.loads(manifest_path.read_text())
    by_trace = {entry["trace_sha256"]: entry for entry in manifest["launches"]}
    external = sass_artifacts.load_static_sass_artifacts(static_manifest_path, repository_root=source_root)
    raw_summary = json.loads((raw_root / "summary.json").read_text())
    metadata = {}
    for item in manifest["inputs"]:
        path = Path(item["metadata_path"])
        require(file_hash(path) == item["metadata_sha256"], "metadata checksum mismatch")
        metadata[item["gpu"]] = (item, {case["case"]: case for case in json.loads(path.read_text())["cases"]})
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    rows, examples, bindings, errors = [], [], [], []
    opcode_counts = defaultdict(Counter)
    for entry in raw_summary["files"]:
        try:
            path = raw_root / entry["path"]
            require(file_hash(path) == entry["sha256"], "raw CTA artifact checksum")
            raw = json.loads(gzip.decompress(path.read_bytes()))
            source = raw["source"]
            require(source["trace_sha256"] == entry["trace_sha256"], "raw summary trace identity")
            launch = by_trace[source["trace_sha256"]]
            require(launch["gpu"] == source["gpu"] and launch["case"] == source["case"], "main manifest workload identity")
            info, cases = metadata[source["gpu"]]
            case = cases[source["case"]]
            static_path = sass_artifacts.resolve_static_sass_optional(source_root / info["raw_root"], case, raw["header"]["kernel_name"], external)
            require((None if static_path is None else file_hash(static_path)) == launch["static_sass_sha256"], "static artifact SHA vs program manifest")
            records = [instruction for warp in raw["warps"] for instruction in warp["instructions"]]
            require(len(records) == raw["coverage"]["records"] == entry["coverage"]["records"], "raw record count")
            variants = [] if static_path is None else parse_variants(static_path, raw["header"]["kernel_name"])
            matched = [] if static_path is None else select_variants(variants, records)
            require(static_path is None or bool(matched), "no static code object agrees with all observed PC/opcodes")
            counts = Counter(records=len(records))
            seen_examples, seen_sites = set(), set()
            for record in records:
                family = record["opcode"].split(".")[0]
                opkey = (source["gpu"], source["case"], record["opcode"])
                opcode_counts[opkey]["all_raw_records"] += 1
                site = unique_site(matched, record["pc"]) if matched else None
                if site is not None:
                    counts["unique_static_site_records"] += 1
                    opcode_counts[opkey]["unique_static_site_records"] += 1
                    if record["pc"] not in seen_sites:
                        seen_sites.add(record["pc"])
                        bindings.append({"gpu": source["gpu"], "case": source["case"], "trace_sha256": source["trace_sha256"],
                            "static_sha256": launch["static_sass_sha256"], "pc": record["pc"], "pc_hex": hex(record["pc"]), **site})
                if family not in SCALAR_FAMILIES:
                    counts["outside_five_scalar_families"] += 1
                    if site and record["opcode"].startswith(("SYNCS.EXCH", "UTCATOMSWS", "UTCHMMA", "LDTM", "UTMALDG")):
                        key = record["opcode"]
                        if key not in seen_examples:
                            seen_examples.add(key)
                            examples.append({"gpu": source["gpu"], "case": source["case"], "trace_sha256": source["trace_sha256"],
                                "raw_cta_artifact": entry["path"], "raw_source_line": record["source_line"], "raw_record_id": record["id"],
                                "pc": record["pc"], "pc_hex": hex(record["pc"]), "opcode": record["opcode"],
                                "raw_destinations": record["destinations"], "raw_sources": record["sources"],
                                "static_path": str(static_path.relative_to(source_root)), "static_sha256": launch["static_sass_sha256"],
                                "static": site, "interpretation": "outside validated scalar lexical partition; no complete source/destination semantics inferred"})
                    continue
                counts["five_family_records"] += 1
                opcode_counts[opkey]["five_family_records"] += 1
                if static_path is None:
                    counts["five_family_no_static_unknown"] += 1
                    continue
                if site is None:
                    counts["five_family_ambiguous_static_unknown"] += 1
                    continue
                counts["five_family_static_bound"] += 1
                destinations, sources = operand_tokens(site["operands"])
                matches = destinations == record["destinations"] and sources == record["sources"]
                counts["five_family_gpr_tokens_match" if matches else "five_family_gpr_tokens_mismatch"] += 1
                opcode_counts[opkey]["five_family_gpr_tokens_match" if matches else "five_family_gpr_tokens_mismatch"] += 1
                if NONCONSTANT_PREDICATE.search(site["operands"]): counts["five_family_nonconstant_predicate_operand"] += 1
                if "." in site["opcode"]: counts["five_family_suffix"] += 1
                if CONSTANT_MEMORY.search(site["operands"]): counts["five_family_constant_memory"] += 1
                if matches and strict_syntax(site, destinations, sources):
                    counts["strict_scalar_syntax_records"] += 1
                    opcode_counts[opkey]["strict_scalar_syntax_records"] += 1
                    if record["active_mask"] != 0:
                        counts["strict_scalar_syntax_nonzero_mask"] += 1
            numeric_fields = ["records", "unique_static_site_records", "outside_five_scalar_families", "five_family_records", "five_family_no_static_unknown",
                "five_family_ambiguous_static_unknown", "five_family_static_bound", "five_family_gpr_tokens_match", "five_family_gpr_tokens_mismatch",
                "five_family_nonconstant_predicate_operand", "five_family_suffix", "five_family_constant_memory", "strict_scalar_syntax_records", "strict_scalar_syntax_nonzero_mask"]
            rows.append({"gpu": source["gpu"], "case": source["case"], "purpose": source["purpose"],
                "trace_sha256": source["trace_sha256"], "raw_cta_artifact": entry["path"], "raw_cta_artifact_sha256": entry["sha256"],
                "static_path": None if static_path is None else str(static_path.relative_to(source_root)), "static_sha256": launch["static_sass_sha256"],
                "exact_kernel_code_objects": len(variants), "pc_opcode_matching_code_objects": len(matched),
                **{key: counts[key] for key in numeric_fields}})
        except Exception as error:
            errors.append({"artifact": entry["path"], "error": str(error)})
    totals = {key: sum(row[key] for row in rows) for key in numeric_fields}
    counterexamples = [example for example in examples if example["gpu"] == "B200" and example["pc"] == 0x470 and example["opcode"] == "SYNCS.EXCH.64"]
    require(len(counterexamples) == 1, "expected B200 SYNCS lexical counterexample not retained")
    counterexample = counterexamples[0]
    require("[UR5]" in counterexample["static"]["operands"] and counterexample["raw_sources"] == ["R0", "UR6"], "counterexample spelling changed")
    counterexample["interpretation"] = "Raw sources expose R0, UR6 while hash-bound static syntax names [UR5], UR6; raw register tokens cannot establish the uniform address-register provenance. This is an observed lexical gap, not a numerical execution fault."
    write_csv(out / "traces.csv", rows)
    opcode_rows = [{"gpu": gpu, "case": case, "opcode": opcode, **{key: count[key] for key in ["all_raw_records", "unique_static_site_records", "five_family_records", "five_family_gpr_tokens_match", "five_family_gpr_tokens_mismatch", "strict_scalar_syntax_records"]}}
        for (gpu, case, opcode), count in sorted(opcode_counts.items())]
    write_csv(out / "opcode-coverage.csv", opcode_rows)
    write_json(out / "out-of-family-examples.json", examples)
    write_json(out / "b200-syncs-counterexample.json", counterexample)
    write_json(out / "static-sites.json", bindings)
    write_json(out / "errors.json", errors)
    sources = {str(Path(__file__).resolve()): file_hash(__file__), sass_artifacts.__file__: file_hash(sass_artifacts.__file__), sass_control.__file__: file_hash(sass_control.__file__)}
    snapshots = out / "source-snapshots"
    snapshots.mkdir()
    for path in sources:
        (snapshots / Path(path).name).write_bytes(Path(path).read_bytes())
    summary = {"format": "gpu-sim-static-operand-syntax-audit-v1", "completed_at_utc": datetime.now(timezone.utc).isoformat(),
        "source_root": str(source_root), "raw_evidence_root": str(raw_root), "input_summary_sha256": file_hash(raw_root / "summary.json"),
        "main_program_manifest_sha256": file_hash(manifest_path), "static_artifact_manifest_sha256": file_hash(static_manifest_path),
        "source_hashes": sources, "python": sys.version, "trace_count": len(rows), "static_available_traces": sum(row["static_path"] is not None for row in rows),
        "totals": totals, "errors": len(errors), "out_of_family_example_count": len(examples),
        "selection": "The same 12 primary raw CTA0 captures plus one B300 TMEM-footprint CTA0; no physical CTA expansion or new GPU execution.",
        "comparison": "Only MOV/FFMA/FADD/FMUL/IADD3 families: literal GPR/UR token sequence, first comma operand as destination, remaining operands as sources, RZ=>R255 and URZ=>UR63; no deduplication.",
        "strict_subset": "Exact unsuffixed five opcodes, exactly one nonzero R destination, only R registers, no nonconstant predicate operand, no c/cx constant-memory operand; instruction guards retained, zero masks counted separately.",
        "variant_binding": "Exact kernel name; all observed PC/opcode pairs must agree, allowing terminal NOP at maxPC+16; all remaining variants must agree on guard/opcode/operand text at each reported site.",
        "limitations": ["This is syntax agreement, not a complete SASS decoder, value-flow proof, architectural def-use validation, or a bug detector.",
            "The five scalar families are selected explicitly; all other records are counted as excluded, with real asynchronous/memory counterexamples retained.",
            "Predicate registers, implicit tuple widths, memory operands, register clobbers and unsupported instruction effects are not modeled.",
            "A complete reaching-definition implementation must invalidate state across unsupported possible clobbers; this audit does not compute reaching definitions.",
            "Nonzero masks do not establish a trustworthy per-lane execution mask without hash-bound tracer binary semantics.",
            "Missing static files or ambiguous operands stay unknown. Declared static source/binary hash binding is checked, not the truth of original collection attestations.",
            "The primary/supplemental captures are selected examples, not independent held-out fault cases."],
        "audit_wall_seconds": time.perf_counter() - started,
        "timing_scope": "Single descriptive IO/hash/parse/audit/export duration; no algorithm or GPU performance claim."}
    summary["artifacts"] = {path.name: {"sha256": file_hash(path), "bytes": path.stat().st_size} for path in sorted(out.iterdir()) if path.is_file()}
    write_json(out / "summary.json", summary)
    print(json.dumps({"output": str(out), "traces": len(rows), "static_available_traces": summary["static_available_traces"], "totals": totals, "errors": len(errors)}, indent=2))
    return 1 if errors else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=Path("/home/liuwei/GPU-simulator"))
    parser.add_argument("--raw-evidence", type=Path, default=Path("out/research/raw-evidence/20261023-cta0-v2"))
    parser.add_argument("--output", type=Path, default=Path("out/research/static-operands") / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    return run(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
