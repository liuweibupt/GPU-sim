"""Address-backed SASS evidence for optional coupled memory replay.

Unlike fixed CTA summaries, this artifact preserves every warp program and its
global sector addresses.  Instruction/program dictionaries retain compression
without normalizing distinct addresses into false cross-CTA aliases.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping
from dataclasses import asdict, fields, replace
from pathlib import Path

from gpu_tile_sim.backend.sass_memory_service import SassMemoryService
from gpu_tile_sim.comparison.sass_dse_contract import encode_sass_predictor_envelope
from gpu_tile_sim.comparison.sass_execution import profile_sass_execution
from gpu_tile_sim.comparison.sass_execution_instruction import ExecutionInstruction
from gpu_tile_sim.comparison.sass_mbarrier import BarrierAction, BarrierActionKind, BarrierWait
from gpu_tile_sim.comparison.sass_noc_evidence import SassNoCEvidence
from gpu_tile_sim.comparison.sass_tmem_footprint import (
    bind_tmem_footprints,
    load_tmem_footprint_manifest,
)
from gpu_tile_sim.hardware.gpu_config import GPUConfig
from gpu_tile_sim.hardware.sass_spec import PipelineKind

REPLAY_FORMAT = "sass-address-memory-replay-v1"
LAUNCH_CONTRACT_FIELDS = frozenset(
    {
        "grid_shape",
        "cluster_shape",
        "cta_count",
        "num_warps",
        "shared_bytes",
        "registers_per_thread",
        "memory_sector_bytes",
    }
)
TUPLE_FIELDS = {
    item.name
    for item in fields(ExecutionInstruction)
    if item.name
    in {
        "destinations",
        "sources",
        "async_barrier_addresses",
        "static_wait_barriers",
        "memory_sector_addresses",
    }
}


def _digest(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def profile_sass_dram_replay(
    trace_path: str | Path,
    *,
    max_mshrs: int,
    max_dram_requests: int,
    provenance: str,
    cache_state: str = "cold",
    l2_associativity: int = 1,
    l1_capacity_bytes_per_sm: int = 0,
    static_sass_path: str | Path | None = None,
    controller_parameters: Mapping[str, object] | None = None,
    execution_mode: str = "legacy",
    noc_evidence: SassNoCEvidence | None = None,
    tmem_footprint_manifest: str | Path | None = None,
    execution_context: str = "active_cycles",
    expected_predictor_config: GPUConfig | None = None,
) -> dict[str, object]:
    """Create an exact launch accepted by launch_partition_execution_plan.

    Queue capacities are explicit reference parameters until independently
    characterized.  Warm means one complete prior identical invocation.  L1
    bypass is explicit when no per-SM L1 capacity is supplied.
    """

    if cache_state not in {"cold", "warm_persistent"}:
        raise ValueError("coupled memory replay needs explicit cold or warm_persistent state")
    if execution_mode not in {"legacy", "shared_sm"}:
        raise ValueError("coupled execution_mode must be legacy or shared_sm")
    if execution_context not in {"active_cycles", "full_predictor"}:
        raise ValueError("unknown SASS execution envelope context")
    if (execution_context == "full_predictor") != (expected_predictor_config is not None):
        raise ValueError("full_predictor context requires an expected predictor configuration")
    if noc_evidence is not None and execution_mode != "shared_sm":
        raise ValueError("explicit NoC replay requires shared_sm execution mode")
    if noc_evidence is not None and l1_capacity_bytes_per_sm:
        raise ValueError("explicit NoC replay currently requires L1 bypass")
    footprints = None
    if tmem_footprint_manifest is not None:
        if static_sass_path is None:
            raise ValueError("TMEM footprint replay requires its paired static SASS")
        footprints = load_tmem_footprint_manifest(
            tmem_footprint_manifest, trace_path=trace_path, static_sass_path=static_sass_path
        )
    for name, value in (
        ("max_mshrs", max_mshrs),
        ("max_dram_requests", max_dram_requests),
        ("l2_associativity", l2_associativity),
    ):
        if type(value) is not int or value <= 0:
            raise ValueError(f"{name} must be a positive integer")
    if type(l1_capacity_bytes_per_sm) is not int or l1_capacity_bytes_per_sm < 0:
        raise ValueError("L1 capacity must be a nonnegative integer")
    if not isinstance(provenance, str) or not provenance.strip():
        raise ValueError("parameter provenance is required")
    table: list[dict[str, object]] = []
    table_ids: dict[str, int] = {}
    programs: list[list[object]] = []
    program_ids: dict[str, int] = {}
    ctas: dict[int, tuple[int, list[object]]] = {}
    raw_programs = {}

    def observe(cta_id, streams, identity):
        if not identity.is_empty and identity.cluster_rank not in {None, 0}:
            raise ValueError("coupled replay does not support cluster follower proxies")
        if footprints is not None:
            streams = bind_tmem_footprints(streams, footprints)
        if noc_evidence is not None:
            raw_programs[cta_id] = streams
        program = []
        memory = []
        for warp, instructions in sorted(streams.items()):
            ids = []
            addresses = []
            for position, instruction in enumerate(instructions):
                SassMemoryService.validate_opcode(instruction.opcode)
                if instruction.global_sectors and not instruction.memory_sector_addresses:
                    raise ValueError("coupled memory instruction is missing traced addresses")
                if instruction.tma_bytes and not instruction.memory_sector_addresses:
                    raise ValueError("coupled TMA transfer requires traced sector addresses")
                value = asdict(replace(instruction, memory_sector_addresses=()))
                key = json.dumps(value, sort_keys=True)
                if key not in table_ids:
                    table_ids[key] = len(table)
                    table.append(value)
                ids.append(table_ids[key])
                if instruction.memory_sector_addresses:
                    addresses.append([position, list(instruction.memory_sector_addresses)])
            program.append([warp, ids])
            memory.append([warp, addresses])
        key = json.dumps(program)
        if key not in program_ids:
            program_ids[key] = len(programs)
            programs.append(program)
        ctas[cta_id] = (program_ids[key], memory)

    profile = profile_sass_execution(
        trace_path, static_sass_path=static_sass_path, cta_stream_observer=observe
    )
    launch = profile.to_dict()
    if list(launch["cluster_shape"]) != [1, 1, 1]:
        raise ValueError("coupled replay currently supports singleton CTA launches")
    if noc_evidence is not None:
        noc_evidence.bind(
            tuple(raw_programs[index] for index in range(profile.cta_count)),
            trace_sha256=profile.trace_sha256,
            sector_bytes=profile.memory_sector_bytes,
        )
    payload = {
        "format": REPLAY_FORMAT,
        "trace_sha256": profile.trace_sha256,
        "static_sass_sha256": profile.static_sass_sha256,
        "binary_version": profile.binary_version,
        "model_id": profile.model_id,
        "launch_contract": {
            name: launch[name]
            for name in (
                "grid_shape",
                "cluster_shape",
                "cta_count",
                "num_warps",
                "shared_bytes",
                "registers_per_thread",
                "memory_sector_bytes",
            )
        },
        "instruction_table": table,
        "programs": programs,
        "program_ids_by_cta": [ctas[i][0] for i in range(profile.cta_count)],
        "memory_sectors_by_cta": [ctas[i][1] for i in range(profile.cta_count)],
        "options": {
            "max_mshrs": max_mshrs,
            "max_dram_requests": max_dram_requests,
            "l2_associativity": l2_associativity,
            "l1_capacity_bytes_per_sm": l1_capacity_bytes_per_sm,
            "provenance": provenance,
            "controller_parameters": dict(controller_parameters or {}),
        },
        "assumptions": [
            "modeled issue order, not grouped file order, drives shared memory state",
            "write_allocate_no_fetch sector stores; not established NVIDIA partial-store policy",
            "one identical preceding invocation defines warm_persistent",
            "co-resident CTA compute pipelines remain isolated; memory hierarchy is shared",
            "simple modulo cache/address mapping; explicit parameters enable detailed DRAM timing",
        ],
    }
    if execution_mode != "legacy":
        payload["options"]["execution_mode"] = execution_mode
        payload["assumptions"][3] = (
            "co-resident CTA compute issue, pipeline and async credits are shared per SM"
        )
    if execution_context == "full_predictor":
        from gpu_tile_sim.hardware.configs import get_gpu_config

        payload["options"]["execution_context"] = execution_context
        payload["options"]["predictor_envelope"] = encode_sass_predictor_envelope(
            get_gpu_config(expected_predictor_config.name),
            expected_predictor_config,
            trace_sha256=profile.trace_sha256,
            coupled=True,
        )
    if noc_evidence is not None:
        payload["options"]["noc_evidence"] = noc_evidence.to_dict()
        payload["assumptions"].append(
            "explicit NoC routes cover all addressed instructions; current warp remains "
            "at its memory instruction until actual routed response completion"
        )
    if footprints is not None:
        payload["options"]["tmem_footprint_provenance"] = footprints.provenance
    payload["payload_sha256"] = _digest(payload)
    launch["cache_state"] = cache_state
    launch["memory_replay"] = payload
    return launch


def decode_memory_replay(
    launch: Mapping[str, object],
    *,
    instruction_transform: Callable[[ExecutionInstruction], ExecutionInstruction] | None = None,
) -> tuple[tuple[dict[int, tuple[ExecutionInstruction, ...]], ...], dict[str, object]]:
    """Validate evidence and recover exact CTA programs and address aliases."""

    raw = launch.get("memory_replay")
    if not isinstance(raw, dict) or raw.get("format") != REPLAY_FORMAT:
        raise ValueError("missing or incompatible address-backed memory replay evidence")
    payload = dict(raw)
    checksum = payload.pop("payload_sha256", None)
    if checksum != _digest(payload):
        raise ValueError("memory replay payload checksum mismatch")
    for name in ("trace_sha256", "static_sass_sha256", "binary_version", "model_id"):
        if payload.get(name) != launch.get(name):
            raise ValueError(f"memory replay {name} does not match its physical launch")
    contract = payload["launch_contract"]
    if set(contract) != LAUNCH_CONTRACT_FIELDS:
        raise ValueError("memory replay launch contract has missing or unknown fields")
    for name, value in contract.items():
        if launch.get(name) != value:
            raise ValueError(f"memory replay launch contract mismatch: {name}")
    trace_hash = str(payload.get("trace_sha256", ""))
    if len(trace_hash) != 64 or any(c not in "0123456789abcdef" for c in trace_hash):
        raise ValueError("memory replay requires an exact SHA-256 trace identity")
    instructions = []
    for item in payload["instruction_table"]:
        value = dict(item)
        value["kind"] = PipelineKind(value["kind"])
        for name in TUPLE_FIELDS:
            value[name] = tuple(value[name])
        if value["barrier_action"] is not None:
            action = dict(value["barrier_action"])
            action["kind"] = BarrierActionKind(action["kind"])
            value["barrier_action"] = BarrierAction(**action)
        if value["barrier_wait"] is not None:
            value["barrier_wait"] = BarrierWait(**value["barrier_wait"])
        instruction = ExecutionInstruction(**value)
        instructions.append(
            instruction if instruction_transform is None else instruction_transform(instruction)
        )
    ids = payload["program_ids_by_cta"]
    memory = payload["memory_sectors_by_cta"]
    if len(ids) != int(launch["cta_count"]) or len(memory) != len(ids):
        raise ValueError("memory replay must cover every physical CTA exactly once")
    decoded = []
    for program_id, cta_memory in zip(ids, memory, strict=True):
        if type(program_id) is not int or not 0 <= program_id < len(payload["programs"]):
            raise ValueError("invalid memory replay program ID")
        streams = {}
        address_maps = {}
        for warp, entries in cta_memory:
            if type(warp) is not int or warp < 0 or warp in address_maps:
                raise ValueError("duplicate or invalid memory address warp")
            address_maps[warp] = {}
            for position, addresses in entries:
                if type(position) is not int or position < 0 or position in address_maps[warp]:
                    raise ValueError("duplicate or invalid memory address position")
                address_maps[warp][position] = addresses
        program = payload["programs"][program_id]
        if set(address_maps) != {warp for warp, _ in program}:
            raise ValueError("memory addresses must match the exact warp program coverage")
        for warp, instruction_ids in program:
            if type(warp) is not int or warp < 0:
                raise ValueError("invalid warp program ID")
            if any(position >= len(instruction_ids) for position in address_maps[warp]):
                raise ValueError("memory address position exceeds warp program")
            stream = []
            for position, instruction_id in enumerate(instruction_ids):
                if type(instruction_id) is not int or not 0 <= instruction_id < len(instructions):
                    raise ValueError("invalid memory replay instruction ID")
                instruction = instructions[instruction_id]
                addresses = tuple(address_maps.get(int(warp), {}).get(position, ()))
                if instruction.tma_bytes and not addresses:
                    raise ValueError("coupled TMA transfer requires traced sector addresses")
                if not instruction.tma_bytes and len(addresses) != instruction.global_sectors:
                    raise ValueError(
                        "memory replay address count does not match instruction sectors"
                    )
                if addresses:
                    sector = int(launch["memory_sector_bytes"])
                    if len(set(addresses)) != len(addresses) or any(
                        type(a) is not int or a < 0 or a % sector for a in addresses
                    ):
                        raise ValueError("memory replay requires unique aligned sector addresses")
                    instruction = replace(instruction, memory_sector_addresses=addresses)
                SassMemoryService.validate_opcode(instruction.opcode)
                stream.append(instruction)
            if int(warp) in streams or not stream:
                raise ValueError("duplicate or empty warp program")
            streams[int(warp)] = tuple(stream)
        if not streams:
            raise ValueError("empty CTA memory replay program")
        decoded.append(streams)
    options = dict(payload["options"])
    for name in ("max_mshrs", "max_dram_requests", "l2_associativity"):
        if type(options[name]) is not int or options[name] <= 0:
            raise ValueError(f"{name} must be a positive integer")
    if (
        type(options["l1_capacity_bytes_per_sm"]) is not int
        or options["l1_capacity_bytes_per_sm"] < 0
    ):
        raise ValueError("L1 capacity must be a nonnegative integer")
    return tuple(decoded), options
