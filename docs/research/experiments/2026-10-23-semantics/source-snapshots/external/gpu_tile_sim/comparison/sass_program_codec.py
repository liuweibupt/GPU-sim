"""Hash-bound, compressed complete SASS programs for reproducible resource DSE.

This is a resident-input cache, not an accuracy summary: every physical CTA has
a retained template ID and every template retains all warp instructions. Source
timings are seeds that the DSE API rebinds; source model changes invalidate the
cache instead of silently replaying old characterization.
"""

from __future__ import annotations

import gzip
import hashlib
import json
from collections.abc import Mapping
from dataclasses import fields, is_dataclass, replace
from enum import Enum
from pathlib import Path

from gpu_tile_sim.comparison.sass_execution import replay_sass_execution_spec
from gpu_tile_sim.comparison.sass_execution_instruction import ExecutionInstruction
from gpu_tile_sim.comparison.sass_mbarrier import BarrierAction, BarrierActionKind, BarrierWait
from gpu_tile_sim.comparison.sass_template_rebind import CtaTemplateDseProfile
from gpu_tile_sim.hardware.configs import get_gpu_config
from gpu_tile_sim.hardware.gpu_config import GPUConfig
from gpu_tile_sim.hardware.sass_spec import PipelineKind
from gpu_tile_sim.hardware.topology import GpcTopologySpec

PROGRAM_FORMAT = "ysim-complete-sass-dse-programs-v1"
_TUPLE_FIELDS = frozenset(
    {
        "destinations",
        "sources",
        "async_barrier_addresses",
        "static_wait_barriers",
        "memory_sector_addresses",
    }
)
_SOURCE_OVERRIDES = frozenset(
    {
        "sm_count",
        "max_threadblocks_per_sm",
        "gpc_topology",
        "dram_max_inflight_bytes",
        "dependent_global_memory_latency_cycles",
        "shared_memory_bytes_per_sm",
        "register_file_regs_per_sm",
        "max_warps_per_sm",
        "shared_memory_allocation_granularity_bytes",
        "register_allocation_granularity_regs",
    }
)
_UNSET = object()


def _plain(value):
    if is_dataclass(value) and not isinstance(value, type):
        return {item.name: _plain(getattr(value, item.name)) for item in fields(value) if item.init}
    if isinstance(value, Mapping):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_plain(item) for item in value]
    if isinstance(value, Enum):
        return value.value
    return value


def _bytes(value: object) -> bytes:
    return json.dumps(
        _plain(value), sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


def _sha(value: object) -> str:
    return hashlib.sha256(_bytes(value)).hexdigest()


def _validated_sha(value: object, name: str, *, optional=False) -> str | None:
    if optional and value is None:
        return None
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ValueError(f"SASS program {name} requires an exact SHA-256 identity")
    return value


def encode_sass_program_profile(profile: CtaTemplateDseProfile) -> dict[str, object]:
    """Dictionary-encode a complete, canonical-source CTA-template profile."""

    launch = _plain(profile.launch)
    trace_sha = _validated_sha(launch.get("trace_sha256"), "trace")
    static_sha = _validated_sha(launch.get("static_sass_sha256"), "static SASS", optional=True)
    canonical = get_gpu_config(profile.source_config.name)
    overrides = {}
    for item in fields(GPUConfig):
        before, after = getattr(canonical, item.name), getattr(profile.source_config, item.name)
        if before == after:
            continue
        if item.name not in _SOURCE_OVERRIDES:
            raise ValueError(f"unsupported SASS program source override: {item.name}")
        overrides[item.name] = _plain(after)
    instructions = []
    instruction_ids: dict[bytes, int] = {}
    templates = []
    for template in profile.templates:
        streams = []
        for warp, program in template:
            ids = []
            for instruction in program:
                value = _plain(instruction)
                key = _bytes(value)
                if key not in instruction_ids:
                    instruction_ids[key] = len(instructions)
                    instructions.append(value)
                ids.append(instruction_ids[key])
            streams.append([warp, ids])
        templates.append(streams)
    payload = {
        "format": PROGRAM_FORMAT,
        "identity": {
            "trace_sha256": trace_sha,
            "static_sass_sha256": static_sha,
            "binary_version": launch["binary_version"],
            "launch_sha256": _sha(launch),
            "canonical_config_sha256": _sha(canonical),
            "source_config_sha256": _sha(profile.source_config),
            "source_spec_sha256": _sha(profile.source_spec),
        },
        "source_config": {"name": canonical.name, "overrides": overrides},
        "cluster_execution": profile.cluster_execution,
        "launch": launch,
        "instruction_table": instructions,
        "templates": templates,
        "template_ids": list(profile.template_ids),
    }
    payload["payload_sha256"] = _sha(payload)
    return payload


def decode_sass_program_profile(
    raw: Mapping[str, object],
    *,
    expected_trace_sha256: str | None = None,
    expected_static_sass_sha256: object = _UNSET,
    expected_binary_version: int | None = None,
) -> CtaTemplateDseProfile:
    """Validate input/model identity, then reconstruct complete replay programs."""

    payload = dict(raw)
    checksum = payload.pop("payload_sha256", None)
    if payload.get("format") != PROGRAM_FORMAT or checksum != _sha(payload):
        raise ValueError("SASS program format or payload checksum mismatch")
    identity = dict(payload["identity"])
    launch = dict(payload["launch"])
    trace_sha = _validated_sha(identity.get("trace_sha256"), "trace")
    static_sha = _validated_sha(identity.get("static_sass_sha256"), "static SASS", optional=True)
    for name, expected in (
        ("trace_sha256", trace_sha),
        ("static_sass_sha256", static_sha),
        ("binary_version", identity["binary_version"]),
    ):
        if launch.get(name) != expected:
            raise ValueError(f"SASS program launch identity mismatch: {name}")
    if identity.get("launch_sha256") != _sha(launch):
        raise ValueError("SASS program launch checksum mismatch")
    if expected_trace_sha256 is not None and trace_sha != expected_trace_sha256:
        raise ValueError("SASS program trace differs from expected artifact")
    if expected_static_sass_sha256 is not _UNSET and static_sha != expected_static_sass_sha256:
        raise ValueError("SASS program static SASS differs from expected artifact")
    if expected_binary_version is not None and launch["binary_version"] != expected_binary_version:
        raise ValueError("SASS program binary version differs from expected artifact")
    source = dict(payload["source_config"])
    canonical = get_gpu_config(str(source["name"]))
    if identity.get("canonical_config_sha256") != _sha(canonical):
        raise ValueError("SASS program canonical GPU model changed; rebuild the program cache")
    overrides = dict(source["overrides"])
    if set(overrides) - _SOURCE_OVERRIDES:
        raise ValueError("unsupported SASS program source override")
    if overrides.get("gpc_topology") is not None:
        value = dict(overrides["gpc_topology"])
        for name in ("active_sms_per_gpc", "physical_sms_per_gpc", "partition_by_gpc"):
            value[name] = tuple(value[name])
        overrides["gpc_topology"] = GpcTopologySpec(**value)
    config = replace(canonical, **overrides)
    if identity.get("source_config_sha256") != _sha(config):
        raise ValueError("SASS program source configuration checksum mismatch")
    spec = replay_sass_execution_spec(
        int(launch["binary_version"]), static_control_available=static_sha is not None
    )
    if identity.get("source_spec_sha256") != _sha(spec):
        raise ValueError("SASS program canonical SASS timing changed; rebuild the program cache")
    instructions = []
    expected_fields = {item.name for item in fields(ExecutionInstruction)}
    for item in payload["instruction_table"]:
        value = dict(item)
        if set(value) != expected_fields:
            raise ValueError("SASS program instruction contract changed; rebuild the program cache")
        value["kind"] = PipelineKind(value["kind"])
        for name in _TUPLE_FIELDS:
            value[name] = tuple(value[name])
        if value["barrier_action"] is not None:
            action = dict(value["barrier_action"])
            action["kind"] = BarrierActionKind(action["kind"])
            value["barrier_action"] = BarrierAction(**action)
        if value["barrier_wait"] is not None:
            value["barrier_wait"] = BarrierWait(**value["barrier_wait"])
        instructions.append(ExecutionInstruction(**value))
    templates = []
    for template in payload["templates"]:
        streams = []
        warps = set()
        for warp, ids in template:
            if type(warp) is not int or warp < 0 or warp in warps:
                raise ValueError("SASS program contains duplicate or invalid warp IDs")
            warps.add(warp)
            if any(type(index) is not int or not 0 <= index < len(instructions) for index in ids):
                raise ValueError("SASS program has invalid instruction table references")
            streams.append((warp, tuple(instructions[index] for index in ids)))
        templates.append(tuple(streams))
    ids = tuple(payload["template_ids"])
    if any(type(index) is not int or not 0 <= index < len(templates) for index in ids):
        raise ValueError("SASS program has invalid template references")
    return CtaTemplateDseProfile(
        launch=launch,
        templates=tuple(templates),
        template_ids=ids,
        source_config=config,
        source_spec=spec,
        cluster_execution=str(payload["cluster_execution"]),
    )


def write_sass_program_profile(path: str | Path, profile: CtaTemplateDseProfile) -> None:
    """Atomically checkpoint a deterministic gzip-JSON program cache."""

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".tmp")
    temporary.write_bytes(gzip.compress(_bytes(encode_sass_program_profile(profile)), mtime=0))
    temporary.replace(target)


def read_sass_program_profile(path: str | Path, **identity) -> CtaTemplateDseProfile:
    return decode_sass_program_profile(
        json.loads(gzip.decompress(Path(path).read_bytes())), **identity
    )
