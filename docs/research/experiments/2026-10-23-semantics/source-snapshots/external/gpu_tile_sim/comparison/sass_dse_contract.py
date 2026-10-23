"""Explicit supported differences for the same-ISA CTA-template cycles API."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import fields, is_dataclass, replace
from enum import Enum
from math import isfinite

from gpu_tile_sim.hardware.configs import get_gpu_config
from gpu_tile_sim.hardware.gpu_config import GPUConfig, PipelineSpec
from gpu_tile_sim.model import ResourceKind

# These fields affect exact-launch placement, residency or implemented memory
# lower bounds. Acceptance does not imply a full cache/controller DSE model.
SUPPORTED_CONFIG_FIELDS = frozenset(
    {
        "sm_count",
        "max_threadblocks_per_sm",
        "gpc_topology",
        "dram_max_inflight_bytes",
        "dependent_global_memory_latency_cycles",
        "l2_read_bytes_per_cycle",
        "l2_write_bytes_per_cycle",
        "l2_read_write_serial_fraction",
        "shared_memory_bytes_per_sm",
        "register_file_regs_per_sm",
        "max_warps_per_sm",
        "shared_memory_allocation_granularity_bytes",
        "register_allocation_granularity_regs",
    }
)
SUPPORTED_PIPELINES = frozenset(
    {
        ResourceKind.CUDA_CORE,
        ResourceKind.SFU,
        ResourceKind.TENSOR_CORE,
        ResourceKind.SRAM,
        ResourceKind.L2,
        ResourceKind.TMA,
        ResourceKind.TMEM,
        ResourceKind.BARRIER,
        ResourceKind.GLOBAL,
    }
)

# These values are consumed by the complete predictor outside SASS active
# cycles. They may be projected out only under that explicitly declared
# envelope; the standalone timing-template API continues to reject them.
OUTER_PREDICTOR_FIELDS = frozenset(
    {
        "core_frequency_mhz",
        "launch_engine",
        "scalar_copy_hbm_bytes_per_cycle",
        "scalar_l2_bytes_per_cycle",
        "scalar_triad_hbm_bytes_per_cycle",
    }
)

# The coupled memory service replaces these characterized aggregate bounds
# with its own aggregate-L2 requests and explicit evidence-owned credits. They
# are not outer timing consumers and must not be projected out of the timing
# template path, where launch memory bounds actually use them.
COUPLED_REPLACED_CHARACTERIZATION_FIELDS = frozenset(
    {
        "l2_read_bytes_per_cycle",
        "l2_write_bytes_per_cycle",
        "l2_read_write_serial_fraction",
        "dram_max_inflight_bytes",
    }
)
PREDICTOR_ENVELOPE_FORMAT = "ysim-full-predictor-envelope-v1"


def _envelope_plain(value):
    if is_dataclass(value) and not isinstance(value, type):
        return {
            item.name: _envelope_plain(getattr(value, item.name))
            for item in fields(value)
            if item.init
        }
    if isinstance(value, Mapping):
        return {str(key): _envelope_plain(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_envelope_plain(item) for item in value]
    if isinstance(value, Enum):
        return value.value
    return value


def _envelope_sha(value) -> str:
    return hashlib.sha256(
        json.dumps(
            _envelope_plain(value), sort_keys=True, separators=(",", ":"), allow_nan=False
        ).encode()
    ).hexdigest()


def _envelope_trace_sha(value) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ValueError("full predictor envelope requires an exact SHA-256 trace identity")
    return value


def encode_sass_predictor_envelope(
    source: GPUConfig,
    expected_predictor_config: GPUConfig,
    *,
    trace_sha256: str,
    coupled: bool = False,
) -> dict[str, object]:
    """Bind only an explicitly supplied record's characterized projection values.

    This is an integrity and scope contract, not an assertion that an arbitrary
    caller-provided configuration was independently measured. Consumed active
    parameters may still vary in a DSE target; projected parameters must match
    this frozen record envelope instead of silently becoming ignored knobs.
    """

    if source.name != expected_predictor_config.name:
        raise ValueError("full predictor envelope source and characterized GPU names differ")
    names = OUTER_PREDICTOR_FIELDS | (
        COUPLED_REPLACED_CHARACTERIZATION_FIELDS if coupled else frozenset()
    )
    payload = {
        "format": PREDICTOR_ENVELOPE_FORMAT,
        "context": "full_predictor",
        "active_mode": "address_coupled" if coupled else "timing_templates",
        "trace_sha256": _envelope_trace_sha(trace_sha256),
        "source_config_sha256": _envelope_sha(source),
        "characterized_config_sha256": _envelope_sha(expected_predictor_config),
        "projected_fields": {
            name: _envelope_plain(getattr(expected_predictor_config, name))
            for name in sorted(names)
        },
        "pipeline_latency_reference": {
            resource.value: pipeline.latency_cycles
            for resource, pipeline in expected_predictor_config.pipelines.items()
        },
        # pipeline() applies coarse resource_scales. Source SASS seeds are
        # independently characterized and never consume those scales; clearing
        # a compiler/model scale in the predictor must not accelerate them again.
        "pipeline_rate_reference": {
            resource.value: {
                "throughput_per_cycle": effective.throughput_per_cycle,
                "issue_width": effective.issue_width,
                "lane_throughput_per_cycle": effective.lane_throughput_per_cycle,
            }
            for resource in expected_predictor_config.pipelines
            for effective in (expected_predictor_config.pipeline(resource),)
        },
    }
    payload["payload_sha256"] = _envelope_sha(payload)
    return payload


def active_sass_config(
    source: GPUConfig,
    target: GPUConfig,
    context: str,
    *,
    envelope: Mapping[str, object] | None = None,
    coupled: bool = False,
    trace_sha256: str | None = None,
) -> GPUConfig:
    if context == "active_cycles":
        if envelope is not None:
            raise ValueError("standalone active cycles cannot carry a full predictor envelope")
        return target
    if context != "full_predictor":
        raise ValueError("unknown SASS execution envelope context")
    if not isinstance(envelope, Mapping):
        raise ValueError("full_predictor context requires a bound characterized envelope")
    payload = dict(envelope)
    checksum = payload.pop("payload_sha256", None)
    expected_fields = {
        "format",
        "context",
        "active_mode",
        "trace_sha256",
        "source_config_sha256",
        "characterized_config_sha256",
        "projected_fields",
        "pipeline_latency_reference",
        "pipeline_rate_reference",
    }
    if set(payload) != expected_fields or checksum != _envelope_sha(payload):
        raise ValueError("full predictor envelope schema or checksum mismatch")
    if (
        payload["format"] != PREDICTOR_ENVELOPE_FORMAT
        or payload["context"] != context
        or payload["active_mode"] != ("address_coupled" if coupled else "timing_templates")
    ):
        raise ValueError("full predictor envelope context or active replay mode mismatch")
    if payload["trace_sha256"] != _envelope_trace_sha(trace_sha256):
        raise ValueError("full predictor envelope belongs to another trace")
    if payload["source_config_sha256"] != _envelope_sha(source) or target.name != source.name:
        raise ValueError("full predictor envelope source configuration mismatch")
    _envelope_trace_sha(payload["characterized_config_sha256"])
    reference = payload["pipeline_latency_reference"]
    if (
        not isinstance(reference, Mapping)
        or set(reference) != {resource.value for resource in source.pipelines}
        or any(type(value) is not int or value < 0 for value in reference.values())
    ):
        raise ValueError("full predictor envelope has invalid pipeline latency references")
    rate_reference = payload["pipeline_rate_reference"]
    if (
        not isinstance(rate_reference, Mapping)
        or set(rate_reference) != {resource.value for resource in source.pipelines}
        or any(not _valid_rate_reference(value) for value in rate_reference.values())
    ):
        raise ValueError("full predictor envelope has invalid pipeline rate references")
    names = OUTER_PREDICTOR_FIELDS | (
        COUPLED_REPLACED_CHARACTERIZATION_FIELDS if coupled else frozenset()
    )
    projected = payload["projected_fields"]
    if not isinstance(projected, Mapping) or set(projected) != names:
        raise ValueError("full predictor envelope has missing or unknown projected fields")
    changed = [
        name for name in sorted(names) if _envelope_plain(getattr(target, name)) != projected[name]
    ]
    if changed:
        raise ValueError(
            "target changes bound full predictor envelope fields: "
            + ", ".join(changed)
            + "; projection only permits the original characterized record values"
        )
    return replace(target, **{name: getattr(source, name) for name in names})


def predictor_latency_reference(
    envelope: Mapping[str, object] | None,
) -> dict[ResourceKind, int] | None:
    """Read references after active_sass_config validates the complete envelope."""

    if envelope is None:
        return None
    return {
        ResourceKind(resource): value
        for resource, value in envelope["pipeline_latency_reference"].items()
    }


def _valid_rate_reference(value) -> bool:
    if not isinstance(value, Mapping) or set(value) != {
        "throughput_per_cycle",
        "issue_width",
        "lane_throughput_per_cycle",
    }:
        return False
    aggregate, width, lane = (
        value["throughput_per_cycle"],
        value["issue_width"],
        value["lane_throughput_per_cycle"],
    )
    return (
        not isinstance(aggregate, bool)
        and isinstance(aggregate, (int, float))
        and isfinite(aggregate)
        and aggregate >= 0
        and type(width) is int
        and width > 0
        and (
            lane is None
            or not isinstance(lane, bool)
            and isinstance(lane, (int, float))
            and isfinite(lane)
            and lane > 0
        )
    )


def predictor_rate_reference(
    envelope: Mapping[str, object] | None,
) -> dict[ResourceKind, PipelineSpec] | None:
    """Read effective aggregate/lane references after full envelope validation."""

    if envelope is None:
        return None
    return {
        ResourceKind(resource): PipelineSpec(
            resource=ResourceKind(resource), latency_cycles=0, **value
        )
        for resource, value in envelope["pipeline_rate_reference"].items()
    }


def validate_template_dse_changes(
    source: GPUConfig,
    target: GPUConfig,
    *,
    shared_queues: bool = True,
    execution_mode: str = "legacy",
) -> None:
    """Fail before replay if any requested difference has no implemented consumer.

    This API returns active cycles. Clock and launch-engine changes therefore
    require a separate, explicitly modeled envelope and are rejected here.
    """

    if execution_mode not in {"legacy", "shared_sm"}:
        raise ValueError("unknown SASS DSE execution mode")
    shared_fields = (
        {
            "warp_schedulers_per_sm",
            "warp_issue_width_per_scheduler",
            "tma_descriptor_slots_per_sm",
            "tma_engine_count_per_sm",
            "tmem_columns_per_sm",
        }
        if execution_mode == "shared_sm"
        else set()
    )
    unsupported = []
    if source.gpc_topology != target.gpc_topology:
        before, after = source.gpc_topology, target.gpc_topology
        if (
            before is None
            or after is None
            or replace(
                before,
                active_sms_per_gpc=after.active_sms_per_gpc,
                partition_by_gpc=after.partition_by_gpc,
                provenance=after.provenance,
            )
            != after
        ):
            unsupported.append("gpc_topology.physical_geometry")
    if not shared_queues:
        for name in (
            "l2_read_bytes_per_cycle",
            "l2_write_bytes_per_cycle",
            "l2_read_write_serial_fraction",
        ):
            if getattr(source, name) != getattr(target, name):
                unsupported.append(name + " (no launch-level shared queues)")
    for item in fields(GPUConfig):
        if item.name in SUPPORTED_CONFIG_FIELDS | shared_fields or item.name in {
            "pipelines",
            "resource_scales",
        }:
            continue
        if getattr(source, item.name) != getattr(target, item.name):
            unsupported.append(item.name)
    if set(source.pipelines) != set(target.pipelines):
        unsupported.append("pipelines.keys")
    for resource in source.pipelines.keys() & target.pipelines.keys():
        before, after = source.pipelines[resource], target.pipelines[resource]
        for item in fields(PipelineSpec):
            if getattr(before, item.name) == getattr(after, item.name):
                continue
            if resource in SUPPORTED_PIPELINES and item.name in {
                "throughput_per_cycle",
                "latency_cycles",
            }:
                continue
            if (
                execution_mode == "shared_sm"
                and resource in SUPPORTED_PIPELINES
                and (
                    item.name == "lane_throughput_per_cycle"
                    and resource is not ResourceKind.GLOBAL
                    or item.name == "issue_width"
                    and resource not in {ResourceKind.SRAM, ResourceKind.TMA, ResourceKind.GLOBAL}
                )
            ):
                continue
            unsupported.append(f"pipelines.{resource.value}.{item.name}")
    for resource in source.resource_scales.keys() | target.resource_scales.keys():
        if source.resource_scales.get(resource, 1.0) == target.resource_scales.get(resource, 1.0):
            continue
        if resource not in SUPPORTED_PIPELINES:
            unsupported.append(f"resource_scales.{resource.value}")
    if unsupported:
        raise ValueError(
            "unsupported CTA-template DSE parameter changes: "
            + ", ".join(sorted(unsupported))
            + "; these parameters require additional modeling before a sweep"
        )


def validate_template_source_config(source: GPUConfig) -> None:
    """Canonical ISA execution profiling cannot label already-retimed source costs."""

    canonical = get_gpu_config(source.name)
    validate_template_dse_changes(canonical, source, shared_queues=False)
    if set(source.pipelines) != set(canonical.pipelines) or any(
        source.pipeline(resource) != canonical.pipeline(resource)
        for resource in canonical.pipelines
    ):
        raise ValueError(
            "CTA-template profiling requires canonical source pipeline timing; "
            "apply timing changes to the target configuration after profiling"
        )


def validate_coupled_dse_changes(
    source: GPUConfig,
    target: GPUConfig,
    *,
    execution_mode: str = "legacy",
) -> None:
    """Reject target changes with no consumer in address-coupled active cycles.

    Cache capacity/line size are consumed here, unlike timing-only templates.
    Credits, associativity, L1 capacity and NoC links/routes are explicit replay
    evidence options, so unrelated GPUConfig fields cannot replace those inputs.
    The full predictor keeps its clock/envelope conversion outside this API.
    """

    if execution_mode not in {"legacy", "shared_sm"}:
        raise ValueError("unknown coupled SASS execution mode")
    supported = {
        "sm_count",
        "max_threadblocks_per_sm",
        "gpc_topology",
        "l2_size_bytes",
        "l1_hit_latency_cycles",
        "dependent_l2_hit_latency_cycles",
        "dependent_global_memory_latency_cycles",
        "shared_memory_bytes_per_sm",
        "register_file_regs_per_sm",
        "max_warps_per_sm",
        "shared_memory_allocation_granularity_bytes",
        "register_allocation_granularity_regs",
    }
    if execution_mode == "shared_sm":
        supported.update(
            {
                "warp_schedulers_per_sm",
                "warp_issue_width_per_scheduler",
                "tma_descriptor_slots_per_sm",
                "tma_engine_count_per_sm",
                "tmem_columns_per_sm",
            }
        )
    unsupported = []
    for item in fields(GPUConfig):
        if item.name in supported | {"pipelines", "resource_scales", "memory_hierarchy"}:
            continue
        if getattr(source, item.name) != getattr(target, item.name):
            unsupported.append(item.name)
    before, after = source.memory_hierarchy, target.memory_hierarchy
    supported_l2 = replace(
        before.l2,
        capacity_bytes=after.l2.capacity_bytes,
        line_bytes=after.l2.line_bytes,
        evidence=after.l2.evidence,
    )
    if replace(before, l2=supported_l2) != after:
        unsupported.append("memory_hierarchy.unmodeled_geometry_or_policy")
    if before.l2.capacity_bytes != after.l2.capacity_bytes and (
        after.l2.capacity_bytes != target.l2_size_bytes
    ):
        unsupported.append("memory_hierarchy.l2.capacity_bytes inconsistent with l2_size_bytes")
    if set(source.pipelines) != set(target.pipelines):
        unsupported.append("pipelines.keys")
    for resource in source.pipelines.keys() & target.pipelines.keys():
        before, after = source.pipelines[resource], target.pipelines[resource]
        for item in fields(PipelineSpec):
            if getattr(before, item.name) == getattr(after, item.name):
                continue
            if resource in SUPPORTED_PIPELINES and item.name in {
                "throughput_per_cycle",
                "latency_cycles",
            }:
                continue
            if (
                execution_mode == "shared_sm"
                and resource in SUPPORTED_PIPELINES
                and (
                    item.name == "lane_throughput_per_cycle"
                    and resource is not ResourceKind.GLOBAL
                    or item.name == "issue_width"
                    and resource not in {ResourceKind.SRAM, ResourceKind.TMA, ResourceKind.GLOBAL}
                )
            ):
                continue
            unsupported.append(f"pipelines.{resource.value}.{item.name}")
    for resource in source.resource_scales.keys() | target.resource_scales.keys():
        if (
            source.resource_scales.get(resource, 1.0) != target.resource_scales.get(resource, 1.0)
            and resource not in SUPPORTED_PIPELINES
        ):
            unsupported.append(f"resource_scales.{resource.value}")
    if unsupported:
        raise ValueError(
            "unsupported coupled SASS DSE parameter changes: "
            + ", ".join(sorted(unsupported))
            + "; these fields have no consumer in this replay mode"
        )
