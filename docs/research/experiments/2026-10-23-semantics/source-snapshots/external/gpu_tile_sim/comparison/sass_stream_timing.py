"""Compose dynamic-SASS execution with host launch-submission timing."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace

from gpu_tile_sim.calibration.kernel_floor import KernelFloorProfile
from gpu_tile_sim.calibration.library_dispatch import LibraryDispatchProfile
from gpu_tile_sim.comparison.records import ModalTraceRecord
from gpu_tile_sim.comparison.sass_binding import (
    RECORD_LAUNCH_STREAM_SCOPE,
    launch_execution_cycles,
)
from gpu_tile_sim.hardware.gpu_config import GPUConfig

FRAMEWORK_EAGER_SUBMISSION = "framework_eager"
NATIVE_PREQUEUED_SUBMISSION = "native_prequeued"


def sass_launch_floor_us(metadata: Mapping[str, object], config: GPUConfig) -> float:
    raw_cycles = metadata.get("sass_execution_launch_bound_cycles")
    if raw_cycles is None:
        return 0.0
    if not isinstance(raw_cycles, list) or not raw_cycles:
        raise ValueError("SASS launch cycle bounds require a non-empty list")
    if config.launch_engine is None:
        raise ValueError("SASS launch floors require an independently characterized launch engine")
    launch_floor = config.launch_engine.cycles(config.core_frequency_mhz)
    cycles = sum(int(value) + launch_floor for value in raw_cycles)
    return config.cycles_to_microseconds(cycles)


def record_sass_envelope_us(
    summary: Mapping[str, object],
    *,
    config: GPUConfig,
    launch_us: float,
    sustained_launch_us: float | None = None,
    kernel_floor_profile: KernelFloorProfile | None = None,
    overlap_active_with_launch: bool = False,
    engine: str = "python",
    cache_state: str | None = None,
) -> float:
    raw_launches = summary.get("sass_execution_launches")
    if raw_launches is None:
        return 0.0
    if not isinstance(raw_launches, list) or not raw_launches:
        raise ValueError("record SASS execution envelope requires a non-empty launch list")
    trailing_launch_us = launch_us if sustained_launch_us is None else sustained_launch_us
    launches = [dict(launch) for launch in raw_launches]
    identities = summary.get("sass_trace_sha256s")
    if identities is not None:
        if not isinstance(identities, list) or len(identities) != len(launches):
            raise ValueError("SASS trace identities must match physical launch count")
        for launch, identity in zip(launches, identities, strict=True):
            existing = launch.get("trace_sha256")
            if existing is not None and existing != identity:
                raise ValueError("SASS launch trace identity differs from stream identity")
            launch["trace_sha256"] = identity
    elif len(launches) == 1 and summary.get("trace_sha256") is not None:
        if launches[0].get("trace_sha256") is None:
            launches[0]["trace_sha256"] = summary["trace_sha256"]
    for launch in launches:
        launch.setdefault("cache_state", cache_state or summary.get("cache_state", "unknown"))
    if kernel_floor_profile is None:
        active_cycles = sum(
            launch_execution_cycles(launch, config, engine=engine) for launch in launches
        )
        dispatch_us = launch_us + (len(raw_launches) - 1) * trailing_launch_us
        return config.cycles_to_microseconds(active_cycles) + dispatch_us
    total_us = 0.0
    for index, launch in enumerate(launches):
        active_us = config.cycles_to_microseconds(
            launch_execution_cycles(launch, config, engine=engine)
        )
        dispatch_us = launch_us if index == 0 else trailing_launch_us
        total_us += kernel_floor_profile.launch_us(
            active_us=active_us,
            empty_launch_us=dispatch_us,
            cta_count=int(launch["cta_count"]),
            block_threads=int(launch["num_warps"]) * 32,
            has_arithmetic=_launch_has_arithmetic(launch),
            overlap_active_with_launch=overlap_active_with_launch,
        )
    return total_us


def static_launch_floor_envelope_us(
    summary: Mapping[str, object],
    *,
    predicted_us: float,
    launch_us: float,
    sustained_launch_us: float | None,
    kernel_floor_profile: KernelFloorProfile,
    has_arithmetic: bool,
    overlap_active_with_launch: bool = False,
) -> float:
    """Apply the independent launch floor to a static physical-launch contract."""

    raw_resources = summary.get("launch_resources")
    if not isinstance(raw_resources, list) or not raw_resources:
        raise ValueError("static launch floors require exact per-launch resources")
    launch_count = int(summary.get("launch_count", 0))
    if launch_count != len(raw_resources):
        raise ValueError("static launch-resource count does not match the physical launch count")
    trailing_us = launch_us if sustained_launch_us is None else sustained_launch_us
    dispatch_total = launch_us + (launch_count - 1) * trailing_us
    active_per_launch = max(0.0, predicted_us - dispatch_total) / launch_count
    floor_us = 0.0
    for index, raw_resource in enumerate(raw_resources):
        if not isinstance(raw_resource, Mapping):
            raise ValueError("static launch resources must be mappings")
        dispatch_us = launch_us if index == 0 else trailing_us
        floor_us += kernel_floor_profile.launch_us(
            active_us=active_per_launch,
            empty_launch_us=dispatch_us,
            cta_count=int(raw_resource["grid_size"]),
            block_threads=int(raw_resource["block_size"]),
            has_arithmetic=has_arithmetic,
            overlap_active_with_launch=overlap_active_with_launch,
        )
    return max(predicted_us, floor_us)


def combine_execution_envelopes(
    source_graph_us: float,
    *,
    sass_envelope_us: float,
    summary: Mapping[str, object],
    independent_floor_us: float = 0.0,
) -> float:
    if sass_envelope_us <= 0.0:
        return source_graph_us
    if summary.get("binding_scope") == RECORD_LAUNCH_STREAM_SCOPE:
        # A complete physical stream already contains the source-level work.
        # Combining both additively would count the same execution twice.
        return max(sass_envelope_us, independent_floor_us)
    return max(source_graph_us, sass_envelope_us, independent_floor_us)


def record_launch_us(record: ModalTraceRecord, default_us: float) -> float:
    value = record.compiler_ir_summary.get("independent_empty_launch_us")
    if value is None:
        return default_us
    launch_us = float(value)
    if launch_us <= 0.0:
        raise ValueError("independent empty-launch duration must be positive")
    return launch_us


def sustained_record_launch_us(
    record: ModalTraceRecord,
    *,
    dispatch_profile: LibraryDispatchProfile | None,
    enabled: bool,
) -> float | None:
    """Return the independent steady-state interval for trailing CUDA launches."""

    if not uses_sustained_dispatch(record, enabled) or dispatch_profile is None:
        return None
    return dispatch_profile.sustained_empty_launch_us


def uses_sustained_dispatch(record: ModalTraceRecord, enabled: bool) -> bool:
    submission = record.compiler_ir_summary.get("launch_submission_mode")
    if submission == FRAMEWORK_EAGER_SUBMISSION:
        return False
    if submission not in {None, NATIVE_PREQUEUED_SUBMISSION}:
        raise ValueError(f"unsupported launch submission mode: {submission}")
    return enabled


def record_sass_clock_config(record: ModalTraceRecord, config: GPUConfig) -> GPUConfig:
    value = record.compiler_ir_summary.get("independent_effective_sm_clock_mhz")
    if value is None:
        return config
    clock_mhz = float(value)
    if clock_mhz <= 0.0 or clock_mhz > config.core_frequency_mhz * 1.05:
        raise ValueError(f"invalid independently measured SM clock: {clock_mhz}")
    return replace(config, core_frequency_mhz=clock_mhz)


def _launch_has_arithmetic(launch: Mapping[str, object]) -> bool:
    raw = launch.get("pipeline_instruction_counts")
    if not isinstance(raw, dict):
        raise ValueError("SASS launch lacks pipeline instruction counts")
    arithmetic = ("alu", "integer", "double", "sfu", "tensor", "gmma", "tcgen05")
    return any(int(raw.get(kind, 0)) > 0 for kind in arithmetic)
