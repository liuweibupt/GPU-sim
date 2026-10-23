#!/usr/bin/env python3
"""Audit existing multi-GPU SASS caches and benchmark bounded structural retrieval.

The source repository is read-only. Normalized cache instructions are NOT raw
callbacks, measured GPU cycles, logical tensor versions, or a bug oracle.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import csv
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
from pathlib import Path
import platform
import random
import statistics
import subprocess
import sys
import time


FORMAT = "gpu-sim-trace-reuse-v1"
METHODS = ("full", "order_ancestors", "register_ancestors", "protocol_assisted")
CAPABILITIES = {
    "warp_instruction_order": "retained after source normalization",
    "pc_opcode_register_names": "retained; syntactic last-writer candidates only",
    "physical_cta_template_weights": "retained and checked against launch counts",
    "symbolic_barrier_fields": "retained from source normalization; no phase-aware global HB claim",
    "active_masks": "absent from this cache",
    "lane_addresses_and_register_values": "absent from this cache",
    "memory_sector_addresses": "audited separately; empty is unknown, not no memory accesses",
    "tmem_columns": "audited separately; null is unknown",
    "logical_tensor_regions_and_versions": "unknown",
    "same_input_or_numerical_equivalence_across_gpus": "unknown",
    "instruction_issue_completion_time": "unknown; model latency/cycles excluded",
    "cross_warp_happens_before": "unknown; no cross-warp edges inferred",
    "bug_ground_truth": "absent",
    "human_understanding": "not evaluated",
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical_hash(value):
    return digest(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode())


def file_hash(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_payload(payload, entry, checkpoint):
    """Validate identities and physical counts without expanding physical CTAs."""
    body = dict(payload)
    checksum = body.pop("payload_sha256", None)
    require(body.get("format") == "ysim-complete-sass-dse-programs-v1", "cache format")
    require(checksum == canonical_hash(body), "payload checksum")
    launch, identity = payload["launch"], payload["identity"]
    require(identity["launch_sha256"] == canonical_hash(launch), "launch checksum")
    for key in ("trace_sha256", "static_sass_sha256", "binary_version"):
        require(identity[key] == launch[key] == entry[key] == checkpoint[key], f"identity {key}")
    for key in ("gpu", "case", "trace", "output", "output_sha256", "physical_cta_count",
                "unique_template_count", "template_instruction_count"):
        require(checkpoint[key] == entry[key], f"checkpoint {key}")
    require(entry["status"] == checkpoint["status"] == "ok", "source extraction status")
    require(payload["cluster_execution"] == entry["cluster_execution"] == checkpoint["cluster_execution"] == "independent", "independent physical CTA contract")
    table, templates, ids = payload["instruction_table"], payload["templates"], payload["template_ids"]
    require(all(type(i) is int and 0 <= i < len(templates) for i in ids), "invalid template id")
    counts = []
    for template in templates:
        warps = set()
        for warp, program in template:
            require(type(warp) is int and 0 <= warp < launch["num_warps"] and warp not in warps, "duplicate/invalid warp")
            warps.add(warp)
            require(all(type(i) is int and 0 <= i < len(table) for i in program), "invalid instruction id")
        counts.append(sum(len(program) for _, program in template))
    require(len(ids) == entry["physical_cta_count"] == launch["cta_count"], "CTA count")
    require(math.prod(launch["grid_shape"]) == len(ids), "grid/CTA count")
    require(len(templates) == entry["unique_template_count"], "template count")
    require(sum(counts) == entry["template_instruction_count"], "template instruction count")
    physical_counts = [counts[i] for i in ids]
    require(physical_counts == launch["cta_instruction_counts"], "physical instruction counts")
    return counts, Counter(ids)


def mechanisms(inst):
    op = inst["opcode"]
    result = []
    if op.startswith(("LDGSTS", "LDGDEPBAR")):
        result.append("cp_async_sass")
    if op.startswith(("UTMALDG", "UTMASTG", "UTMAPF", "UTMAREDG", "UBLKCP", "UBLKPF", "UBLKRED")):
        result.append("tma_sass")
    if op.startswith(("HGMMA", "WARPGROUP")):
        result.append("wgmma_sass")
    if op.startswith("UTCHMMA"):
        result.append("tcgen05_mma_sass")
    if op.startswith(("LDTM", "STTM", "UTCTM", "UTCATOMSWS")):
        result.append("tmem_sass")
    if inst.get("barrier_action") is not None or inst.get("barrier_wait") is not None:
        result.append("symbolic_mbarrier")
    if inst.get("tma_bytes", 0):
        result.append("tma_byte_metadata")
    return result


def barrier_addresses(inst):
    result = set(inst.get("async_barrier_addresses", []))
    for field in ("barrier_action", "barrier_wait"):
        if inst.get(field) is not None and inst[field].get("address") is not None:
            result.add(inst[field]["address"])
    if inst.get("tma_mbarrier_address") is not None:
        result.add(inst["tma_mbarrier_address"])
    return sorted(result)


def build_graph(program):
    """Syntactic local candidates; no lane-sensitive, memory, or cross-warp HB."""
    edges = set()
    registers, symbols, scoreboard = {}, {}, {}
    for ordinal, inst in enumerate(program):
        if ordinal:
            edges.add((ordinal - 1, ordinal, "order"))
        for source in inst.get("sources", []):
            if source in registers:
                edges.add((registers[source], ordinal, "syntactic_register"))
        for token in barrier_addresses(inst):
            if token in symbols:
                edges.add((symbols[token], ordinal, "symbolic_barrier_candidate"))
            symbols[token] = ordinal
        for slot in inst.get("static_wait_barriers", []):
            if slot in scoreboard:
                edges.add((scoreboard[slot], ordinal, "static_scoreboard_candidate"))
        for field in ("static_read_barrier", "static_write_barrier"):
            slot = inst.get(field)
            if slot is not None:
                scoreboard[slot] = ordinal
        for destination in inst.get("destinations", []):
            if destination not in ("RZ", "URZ", "PT", "UPT"):
                registers[destination] = ordinal
    return sorted(edges)


def prepare_query(node_count, edges, seeds):
    incoming = {name: defaultdict(list) for name in METHODS if name != "full"}
    for source, target, kind in edges:
        if kind == "order":
            incoming["order_ancestors"][target].append(source)
        if kind == "syntactic_register":
            incoming["register_ancestors"][target].append(source)
        if kind != "order":
            incoming["protocol_assisted"][target].append(source)
    return node_count, incoming, tuple(seeds)


def retrieve(query, method):
    node_count, incoming, seeds = query
    if method == "full":
        return set(range(node_count))
    selected, todo = set(seeds), list(seeds)
    while todo:
        current = todo.pop()
        for earlier in incoming[method].get(current, ()):
            if earlier not in selected:
                selected.add(earlier)
                todo.append(earlier)
    return selected


def case_family(case):
    if case["kernel"] == "attention":
        return "flashinfer/" + ("prefill" if "prefill" in case["case_id"] else "decode")
    return case["source"] + "/" + case["kernel"]


def choose_seeds(program):
    """Output store, last MMA, and last symbolic wait; deterministic, not faults."""
    seeds = set()
    predicates = (
        lambda i: i["opcode"].startswith(("STG", "UTMASTG")),
        lambda i: i["opcode"].startswith(("HMMA", "HGMMA", "UTCHMMA")),
        lambda i: i.get("barrier_wait") is not None,
    )
    for predicate in predicates:
        matches = [n for n, inst in enumerate(program) if predicate(inst)]
        if matches:
            seeds.add(matches[-1])
    if not seeds:
        matches = [n for n, inst in enumerate(program) if inst.get("sources")]
        seeds.add(matches[-1] if matches else len(program) - 1)
    return sorted(seeds)


def make_view(payload, entry, category, *, warp_selection="mechanism", experiment_group="primary"):
    template_id = payload["template_ids"][0]
    streams = payload["templates"][template_id]
    table = payload["instruction_table"]
    if warp_selection == "tensor":
        score = lambda inst: inst["opcode"].startswith(("HMMA", "HGMMA", "UTCHMMA"))
    else:
        score = lambda inst: bool(mechanisms(inst))
    warp, ids = max(streams, key=lambda item: (sum(score(table[i]) for i in item[1]), -item[0]))
    program = [table[i] for i in ids]
    started = time.perf_counter_ns()
    edges = build_graph(program)
    seeds = choose_seeds(program)
    query = prepare_query(len(program), edges, seeds)
    build_ns = time.perf_counter_ns() - started
    reference = retrieve(query, "protocol_assisted")
    candidate_edges = [(s, t, k) for s, t, k in edges if k != "order" and s in reference and t in reference]
    methods = {}
    for method in METHODS:
        selected = retrieve(query, method)
        kept_relations = sum(s in selected and t in selected for s, t, _ in candidate_edges)
        methods[method] = {
            "node_ids": sorted(selected), "node_count": len(selected),
            "node_fraction": len(selected) / len(program),
            "retained_reference_candidate_relations": kept_relations,
            "reference_candidate_relation_count": len(candidate_edges),
            "reference_candidate_relation_fraction": kept_relations / len(candidate_edges) if candidate_edges else None,
        }
    nodes = [{
        "id": n, "ordinal": n, "pc": inst["pc"], "opcode": inst["opcode"],
        "sources": inst["sources"], "destinations": inst["destinations"],
        "mechanisms": mechanisms(inst), "symbolic_barrier_addresses": barrier_addresses(inst),
        "barrier_action": inst.get("barrier_action"), "barrier_wait": inst.get("barrier_wait"),
        "tma_bytes": inst.get("tma_bytes", 0),
    } for n, inst in enumerate(program)]
    return {
        "view_id": f"{entry['gpu']}:{category}:{entry['case']}", "gpu": entry["gpu"],
        "case": entry["case"], "category": category, "trace": entry["trace"], "experiment_group": experiment_group,
        "trace_sha256": entry["trace_sha256"], "cache_sha256": entry["output_sha256"],
        "cta_id": 0, "template_id": template_id, "warp_id": warp,
        "nodes": nodes, "edges": [{"source": s, "target": t, "type": k} for s, t, k in edges],
        "seed_ids": seeds, "methods": methods,
        "selection": {"full_warp_instruction_count": len(program), "omitted_from_selected_warp": 0,
                      "warp_policy": "most HMMA/HGMMA/UTCHMMA instructions; lowest ID tie-break" if warp_selection == "tensor" else "most instructions with mechanism fields; lowest ID tie-break",
                      "other_physical_ctas_omitted": len(payload["template_ids"]) - 1,
                      "other_warps_in_selected_cta_omitted": len(streams) - 1,
                      "graph_build_and_index_ns_single_observation": build_ns},
    }, query


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def write_csv(path, rows):
    if not rows:
        path.write_text("")
        return
    keys = list(rows[0])
    with path.open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=keys)
        writer.writeheader()
        for row in rows:
            writer.writerow({k: json.dumps(v, sort_keys=True) if isinstance(v, (list, dict)) else v for k, v in row.items()})


def git_state(root):
    def read(args):
        return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()
    return {"commit": read(["rev-parse", "HEAD"]), "status_porcelain": read(["status", "--porcelain"])}


def audit_paired_addresses(root, manifest):
    """Audit optional address sidecars as two existing traces, never new samples."""
    known = {entry["trace_sha256"]: entry for entry in manifest["launches"]}
    rows, grouped = [], defaultdict(list)
    directory = root / "data/ysim_dse_programs_20261009/paired_address"
    for path in sorted(directory.glob("*.json.gz")):
        value = json.loads(gzip.decompress(path.read_bytes()))
        payload = value["memory_replay"]
        body = dict(payload)
        expected = body.pop("payload_sha256")
        require(expected == canonical_hash(body), "paired address payload checksum")
        require(payload["format"] == "sass-address-memory-replay-v1", "paired address format")
        entry = known[payload["trace_sha256"]]
        for key in ("trace_sha256", "static_sass_sha256", "binary_version"):
            require(payload[key] == value[key] == entry[key], f"paired address identity {key}")
        table, programs, ids = payload["instruction_table"], payload["programs"], payload["program_ids_by_cta"]
        contract = payload["launch_contract"]
        require(len(ids) == contract["cta_count"] == value["cta_count"], "paired CTA count")
        require(len(ids) == len(payload["memory_sectors_by_cta"]) == math.prod(contract["grid_shape"]), "paired grid/address count")
        require(all(type(i) is int and 0 <= i < len(programs) for i in ids), "paired program references")
        for program in programs:
            warps = set()
            for warp, instructions in program:
                require(type(warp) is int and warp >= 0 and warp not in warps, "paired invalid/duplicate warp")
                warps.add(warp)
                require(all(type(i) is int and 0 <= i < len(table) for i in instructions), "paired instruction reference")
        sectors, visits, opcode_visits = set(), 0, Counter()
        address_instructions, examples = 0, []
        for cta, warp_entries in enumerate(payload["memory_sectors_by_cta"]):
            program = dict(programs[ids[cta]])
            require(sum(len(instructions) for instructions in program.values()) == value["cta_instruction_counts"][cta], "paired instruction count")
            seen_warps = set()
            for warp, address_rows in warp_entries:
                require(warp in program and warp not in seen_warps, "paired address warp")
                seen_warps.add(warp)
                seen_ordinals = set()
                for ordinal, addresses in address_rows:
                    require(type(ordinal) is int and 0 <= ordinal < len(program[warp]) and ordinal not in seen_ordinals, "paired address instruction ordinal")
                    seen_ordinals.add(ordinal)
                    require(all(type(address) is int and address >= 0 and address % contract["memory_sector_bytes"] == 0 for address in addresses), "paired aligned sector base addresses")
                    inst = table[program[warp][ordinal]]
                    address_instructions += 1
                    visits += len(addresses)
                    opcode_visits[inst["opcode"]] += len(addresses)
                    sectors.update(addresses)
                    if addresses and len(examples) < 3:
                        examples.append({"cta": cta, "warp": warp, "ordinal": ordinal, "opcode": inst["opcode"],
                                         "sector_base_address_sample": addresses[:4], "total_sectors_in_record": len(addresses)})
        require(visits == value["total_global_load_sector_requests"] + value["total_global_store_sector_requests"], "paired load/store sector requests")
        require(len(sectors) == value["total_unique_global_sectors"], "paired unique sectors")
        row = {
            "source": str(path.relative_to(root)), "source_sha256": file_hash(path),
            "payload_sha256_verified": expected, "trace_sha256": entry["trace_sha256"],
            "gpu": entry["gpu"], "case": entry["case"], "physical_ctas": len(ids),
            "sector_bytes": contract["memory_sector_bytes"], "address_instruction_records": address_instructions,
            "sector_visits": visits, "unique_sector_base_addresses": len(sectors),
            "sector_visits_by_opcode": dict(opcode_visits), "examples": examples,
            "address_records_sha256": canonical_hash(payload["memory_sectors_by_cta"]),
            "source_replay_options": payload["options"], "source_replay_assumptions": payload["assumptions"],
        }
        rows.append(row)
        grouped[entry["trace_sha256"]].append(row)
    return {
        "format": "gpu-sim-paired-address-audit-v1", "source_files": len(rows), "unique_existing_traces": len(grouped),
        "not_additional_cases_or_measurements": True,
        "capabilities": "Physical CTA/warp/instruction ordinal -> 32-byte sector base addresses for these sidecars only; no tensor identity, output values, versions, lane mask, or hardware instruction time.",
        "deduplicated": [{"trace_sha256": trace, "gpu": items[0]["gpu"], "case": items[0]["case"],
                          "source_variant_count": len(items),
                          "address_records_identical_across_variants": len({r["address_records_sha256"] for r in items}) == 1,
                          "sector_visits": items[0]["sector_visits"], "unique_sector_base_addresses": items[0]["unique_sector_base_addresses"]}
                         for trace, items in sorted(grouped.items())], "files": rows,
        "scope": "All available paired_address sidecars audited separately; no model execution, timing comparison, or address recovery into other caches.",
    }


def run(args):
    root = args.source_root.resolve()
    manifest_path = root / "data/ysim_dse_programs_20261009/manifest.json"
    manifest = json.loads(manifest_path.read_text())
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    launched_at = datetime.now(timezone.utc).isoformat()
    metadata = {}
    case_rows, source_inputs = [], []
    for item in manifest["inputs"]:
        path = Path(item["metadata_path"])
        if not path.is_file():
            path = root / item["raw_root"] / "hardware_timings.json"
        require(file_hash(path) == item["metadata_sha256"], "hardware metadata hash")
        value = json.loads(path.read_text())
        source_inputs.append({"gpu": item["gpu"], "path": str(path), "sha256": item["metadata_sha256"],
                              "hardware_truth": value.get("hardware_truth"),
                              "component_measurements": value.get("component_measurements"),
                              "gpu_identity": value.get("gpu_identity"), "nvcc_version": value.get("nvcc_version")})
        for case in value["cases"]:
            key = (item["gpu"], case["case_id"])
            require(key not in metadata, "duplicate case")
            metadata[key] = case
            hardware = case["hardware"]
            case_rows.append({
                "gpu": item["gpu"], "case": case["case_id"], "family": case_family(case),
                "dtype": case["dtype"], "params": case["params"],
                "source_revision": case.get("source_revision"),
                "measured_ms_original": hardware["measured_ms"], "samples_ms_original": hardware.get("samples_ms"),
                "iterations_original": hardware.get("iterations"), "hardware_truth_original": value.get("hardware_truth"),
                "component_timing_method_original": value.get("component_measurements", {}).get("timing_method"),
                "command_original": hardware.get("command"), "numerical_correctness_original": hardware.get("correctness"),
                "trace_count_declared": len(case["trace"]["trace_files"]),
                "workload_alignment": "case-name/operator/shape/dtype only; no verified common input or logical identity",
            })
    gpus = sorted({gpu for gpu, _ in metadata})
    common_cases = set.intersection(*({case for gpu0, case in metadata if gpu0 == gpu} for gpu in gpus))
    selections = {}
    for gpu in gpus:
        candidates = [case for (g, name), case in metadata.items() if g == gpu and name in common_cases]
        for category, predicate in (
            ("gemm", lambda c: c["kernel"] == "gemm" and "m128_n1024_k128" in c["case_id"]),
            ("norm", lambda c: c["kernel"] == "rmsnorm"),
            ("attention", lambda c: c["kernel"] == "attention" and "prefill" in c["case_id"]),
        ):
            names = sorted(c["case_id"] for c in candidates if predicate(c))
            require(bool(names), f"representative selection {gpu}/{category}")
            selections[(gpu, names[0])] = category

    launch_rows, views, queries, supplemental_views = [], [], [], []
    opcode_counts, template_opcode_counts = Counter(), Counter()
    group_stats = defaultdict(Counter)
    observed_fields = Counter()
    parse_started = time.perf_counter()
    errors = []
    for index, entry in enumerate(manifest["launches"]):
        try:
            cache_path = root / entry["output"]
            compressed = cache_path.read_bytes()
            require(digest(compressed) == entry["output_sha256"], "compressed output hash")
            require(len(compressed) == entry["output_bytes"], "compressed byte count")
            raw = gzip.decompress(compressed)
            payload = json.loads(raw)
            checkpoint_path = Path(str(cache_path).replace(".program.json.gz", ".checkpoint.json"))
            checkpoint = json.loads(checkpoint_path.read_text())
            template_counts, weights = validate_payload(payload, entry, checkpoint)
            key = (entry["gpu"], entry["case"])
            case = metadata[key]
            require(entry["trace_file"] in case["trace"]["trace_files"], "trace missing from case metadata")
            trace_index = case["trace"]["trace_files"].index(entry["trace_file"])
            require(case["trace"]["trace_sha256"][trace_index] == entry["trace_sha256"], "case raw trace identity")
            physical_counter, template_counter = Counter(), Counter()
            for template_id, template in enumerate(payload["templates"]):
                local = Counter()
                for _, ids in template:
                    local.update(ids)
                template_counter.update(local)
                for inst_id, count in local.items():
                    physical_counter[inst_id] += count * weights[template_id]
            physical_count = sum(physical_counter.values())
            require(physical_count == sum(payload["launch"]["cta_instruction_counts"]), "weighted count")
            mechanism_counts = Counter()
            field_counts = Counter()
            family = case_family(case)
            for inst_id, count in physical_counter.items():
                inst = payload["instruction_table"][inst_id]
                opkey = (entry["gpu"], family, inst["opcode"])
                opcode_counts[opkey] += count
                template_opcode_counts[opkey] += template_counter[inst_id]
                for mechanism in mechanisms(inst):
                    mechanism_counts[mechanism] += count
                for field in ("memory_sector_addresses", "tmem_columns", "barrier_action", "barrier_wait"):
                    if inst.get(field) is not None and inst.get(field) != []:
                        field_counts[field] += count
                if inst.get("tma_bytes", 0):
                    field_counts["tma_bytes_nonzero"] += count
            observed_fields.update(field_counts)
            row = {
                "gpu": entry["gpu"], "case": entry["case"], "family": family,
                "trace": entry["trace"], "trace_sha256_declared": entry["trace_sha256"],
                "raw_sha_validation": "separate full-raw audit required; not recomputed by this adapter",
                "cache": entry["output"], "cache_sha256_verified": entry["output_sha256"],
                "checkpoint_sha256": file_hash(checkpoint_path), "payload_sha256_verified": payload["payload_sha256"],
                "launch_sha256_verified": payload["identity"]["launch_sha256"], "binary_version": entry["binary_version"],
                "physical_ctas": len(payload["template_ids"]), "unique_templates": len(payload["templates"]),
                "template_instructions": sum(template_counts), "physical_normalized_instructions": physical_count,
                "compressed_bytes": len(compressed), "json_bytes": len(raw),
                "cluster_shape": payload["launch"]["cluster_shape"], "mechanism_occurrences": dict(mechanism_counts),
                "observed_field_occurrences": dict(field_counts), "status": "verified",
            }
            launch_rows.append(row)
            for group in (entry["gpu"], entry["gpu"] + "/" + family, "all"):
                stats = group_stats[group]
                stats.update({"launches": 1, "physical_ctas": row["physical_ctas"],
                              "unique_templates": row["unique_templates"], "template_instructions": row["template_instructions"],
                              "physical_normalized_instructions": physical_count,
                              "compressed_bytes": len(compressed), "json_bytes": len(raw)})
                for mechanism, count in mechanism_counts.items():
                    stats[mechanism + "_launches"] += 1
                    stats[mechanism + "_occurrences"] += count
            if key in selections:
                category = selections.pop(key)
                view, query = make_view(payload, entry, category)
                views.append(view)
                queries.append(query)
                if category == "gemm":
                    tensor_view, _ = make_view(payload, entry, "gemm_tensor", warp_selection="tensor", experiment_group="supplemental")
                    if tensor_view["warp_id"] != view["warp_id"]:
                        supplemental_views.append(tensor_view)
        except Exception as exc:
            errors.append({"launch_index": index, "gpu": entry.get("gpu"), "case": entry.get("case"), "error": str(exc)})
        if (index + 1) % 100 == 0:
            print(f"Audited {index + 1}/{len(manifest['launches'])} caches; errors={len(errors)}", flush=True)
    audit_seconds = time.perf_counter() - parse_started
    require(len(launch_rows) + len(errors) == manifest["expected_launch_count"], "manifest launch count")
    if selections:
        errors.append({"error": "representative selections not extracted", "selections": list(map(str, selections))})

    timing_rows, timing_summaries = [], []
    rng = random.Random(args.seed)
    for view, query in zip(views, queries):
        for _ in range(args.warmup):
            for method in METHODS:
                retrieve(query, method)
        for sample in range(args.samples):
            order = list(METHODS)
            rng.shuffle(order)
            for method in order:
                started = time.perf_counter_ns()
                selected = retrieve(query, method)
                elapsed = time.perf_counter_ns() - started
                require(sorted(selected) == view["methods"][method]["node_ids"], "retrieval repeatability")
                timing_rows.append({"view_id": view["view_id"], "method": method, "sample": sample,
                                    "order_position": order.index(method), "elapsed_ns": elapsed, "selected_nodes": len(selected)})
        for method in METHODS:
            values = [row["elapsed_ns"] for row in timing_rows if row["view_id"] == view["view_id"] and row["method"] == method]
            timing_summaries.append({"view_id": view["view_id"], "method": method, "samples": len(values),
                                     "median_ns": statistics.median(values), "p95_ns": sorted(values)[math.ceil(.95 * len(values)) - 1],
                                     "node_count": view["methods"][method]["node_count"],
                                     "node_fraction": view["methods"][method]["node_fraction"],
                                     "reference_candidate_relation_fraction": view["methods"][method]["reference_candidate_relation_fraction"]})
    selection_policy = {
        "cases": "4 GPUs x common BF16 GEMM m128/n1024/k128, lexicographically first RMSNorm, first prefill attention",
        "launch": "first manifest launch for selected case; additional launches omitted from view, included in census",
        "cta": "physical CTA 0", "warp": "most instructions with mechanism fields; lowest warp ID tie-break",
        "seeds": "last global store, last MMA, last symbolic barrier wait when present; otherwise last instruction with sources",
        "scope": "complete selected normalized warp; other CTAs/warps excluded from graph",
        "representativeness": "12 deterministic convenience examples, not random held-out tasks",
    }
    relation_caveat = (
        "Reference is the transitive closure of supplied syntactic register, same-warp nearest symbolic-token, "
        "and static scoreboard candidate edges. Relation retention is a mechanical property of this graph, "
        "NOT correctness recall, bug detection, true dependency recall, causal completeness, or human understanding. "
        "Protocol-assisted retention is 1 by construction. Masks/values/phases are unavailable."
    )
    write_json(out / "selected-views.json", {"format": FORMAT, "capabilities": CAPABILITIES,
               "selection_policy": selection_policy, "relation_caveat": relation_caveat, "views": views})
    write_json(out / "supplemental-views.json", {"format": FORMAT, "capabilities": CAPABILITIES,
               "selection_policy": "same GEMM launch and physical CTA 0, warp with most MMA instructions if different from primary; display only, excluded from 12-view timing/size statistics",
               "relation_caveat": relation_caveat, "views": supplemental_views})
    write_csv(out / "cases.csv", sorted(case_rows, key=lambda r: (r["gpu"], r["case"])))
    write_csv(out / "launches.csv", launch_rows)
    write_csv(out / "opcodes.csv", [{"gpu": gpu, "family": family, "opcode": opcode,
               "physical_normalized_occurrences": count, "template_occurrences": template_opcode_counts[(gpu, family, opcode)]}
               for (gpu, family, opcode), count in sorted(opcode_counts.items())])
    write_csv(out / "retrieval-raw.csv", timing_rows)
    write_csv(out / "retrieval-summary.csv", timing_summaries)
    try:
        paired = audit_paired_addresses(root, manifest)
    except Exception as exc:
        paired = {"error": str(exc)}
        errors.append({"error": "paired address audit: " + str(exc)})
    write_json(out / "paired-address-audit.json", paired)
    write_json(out / "errors.json", errors)
    alignment = []
    for name in sorted(common_cases):
        cases = [metadata[(gpu, name)] for gpu in gpus]
        # Implementation and runtime protocol fields intentionally differ by GPU.
        shape_keys = ("M", "N", "K", "batch", "N", "seq", "dim", "rows", "cols", "bs", "nh", "nkv", "qlen", "kvlen", "hd", "causal")
        signatures = [{"kernel": c["kernel"], "dtype": c["dtype"],
                       "shape": {k: c["params"][k] for k in shape_keys if k in c["params"]}} for c in cases]
        alignment.append({"case": name, "gpus": gpus, "workload_signature_equal": all(s == signatures[0] for s in signatures),
                          "signature": signatures[0], "logical_semantic_identity": "unverified", "numeric_equivalence": "unknown"})
    write_json(out / "workload-alignment.json", alignment)
    summary = {
        "format": FORMAT, "started_at_utc": launched_at, "completed_at_utc": datetime.now(timezone.utc).isoformat(),
        "provenance": {"source_root": str(root), "manifest": str(manifest_path), "manifest_sha256": file_hash(manifest_path),
                       "cache_extraction_source_commit": manifest["source_commit"],
                       "cache_extraction_source_worktree_dirty": manifest["source_worktree_dirty"],
                       "source_repository_now": git_state(root), "script": str(Path(__file__).resolve()),
                       "script_sha256": file_hash(Path(__file__)), "python": sys.version, "platform": platform.platform(),
                       "machine": platform.machine(), "processor": platform.processor(), "source_inputs": source_inputs},
        "validation": {"expected_launches": manifest["expected_launch_count"], "verified_launches": len(launch_rows),
                       "errors": len(errors), "checks": ["manifest output SHA256", "checkpoint identity and counts", "payload SHA256", "launch SHA256",
                       "metadata SHA256 and trace identity", "grid/CTA and template weights", "all template and instruction references", "physical instruction counts"],
                       "not_checked_here": ["raw trace SHA256 (separate audit)", "source model calibration", "raw-to-cache information preservation", "original numerical correctness rerun"]},
        "census": {"case_count": len(metadata), "common_workload_cases": len(common_cases),
                   "equal_workload_signatures": sum(a["workload_signature_equal"] for a in alignment),
                   "groups": {k: dict(v) for k, v in sorted(group_stats.items())},
                   "field_occurrences": dict(observed_fields),
                   "cluster_shapes": dict(Counter(str(row["cluster_shape"]) for row in launch_rows)),
                   "instruction_unit": "normalized dynamic warp instruction occurrences weighted by physical CTA templates; not raw callbacks or thread instructions",
                   "paired_address_caches": "excluded; four side files are not additional launches"},
        "capabilities": CAPABILITIES, "selection_policy": selection_policy,
        "supplemental_views": {"count": len(supplemental_views), "artifact": "supplemental-views.json", "excluded_from_primary_statistics": True},
        "retrieval": {"views": len(views), "methods": list(METHODS), "timing_scope": "resident prebuilt graph/index -> Python set of node IDs; excludes IO, parsing, graph construction, sorting and rendering",
                      "warmups_per_method_per_view": args.warmup, "samples_per_method_per_view": args.samples,
                      "random_order_seed": args.seed, "raw_timing_rows": len(timing_rows), "summary": timing_summaries,
                      "relation_caveat": relation_caveat,
                      "timing_limit": "one shared-host CPU session; query-size dependent; no repeated-session confidence interval or GPU speed claim"},
        "audit_wall_seconds": audit_seconds,
        "audit_wall_scope": "sequential cache IO/decompression/hash/JSON validation/census and selected graph construction; descriptive cost only, not a performance comparison",
        "hardware_timings": "preserved from each original case and original protocol; no cross-GPU speedup pooled or fresh measurement claimed",
        "paired_address_audit": {"artifact": "paired-address-audit.json", "source_files": paired.get("source_files"),
                                 "unique_existing_traces": paired.get("unique_existing_traces"), "not_additional_samples": True},
        "limitations": ["Source extraction was dirty; exact final extraction code cannot be reconstructed from commit alone.",
                        "No same-input identifier, output tensor values, or logical version mapping; cross-GPU alignment is workload level only.",
                        "Caches already normalized loops/callbacks and lost masks/addresses/values; cache completeness does not imply raw semantic completeness.",
                        "All observed cluster shapes are recorded; no support for claims about unobserved multi-CTA cluster behavior.",
                        "These traces have no labeled faults, fixes, or human study; structural retrieval is not error localization or explainability validation."],
    }
    summary["artifacts"] = {p.name: {"sha256": file_hash(p), "bytes": p.stat().st_size} for p in sorted(out.iterdir()) if p.is_file()}
    write_json(out / "summary.json", summary)
    print(json.dumps({"output": str(out), "verified_launches": len(launch_rows), "cases": len(metadata),
                      "views": len(views), "errors": len(errors), "totals": dict(group_stats["all"]), "audit_seconds": audit_seconds}, indent=2), flush=True)
    return 1 if errors else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=Path("/home/liuwei/GPU-simulator"))
    parser.add_argument("--output", type=Path, default=Path("out/research/trace-reuse") / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--samples", type=int, default=30)
    parser.add_argument("--seed", type=int, default=20261023)
    args = parser.parse_args()
    parser.error("at least 5 warmups and 30 samples required") if args.warmup < 5 or args.samples < 30 else None
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
