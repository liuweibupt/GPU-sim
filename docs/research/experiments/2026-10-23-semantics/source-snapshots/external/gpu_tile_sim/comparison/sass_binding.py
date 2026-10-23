"""Bind exact dynamic SASS instruction work to a tile graph."""

from __future__ import annotations

from dataclasses import fields, replace

from gpu_tile_sim.backend.cluster_scheduler import (
    build_cluster_wave_plan,
    cluster_launch_from_metadata,
)
from gpu_tile_sim.backend.cta_template_codec import expand_cta_observables
from gpu_tile_sim.backend.sass_dram import sass_dram_bound
from gpu_tile_sim.backend.sass_partition_scheduler import (
    PartitionExecutionPlan,
    schedule_traced_ctas,
)
from gpu_tile_sim.backend.sass_shared_queue import apply_shared_sass_queues
from gpu_tile_sim.comparison.occupancy import estimate_launch_cta_residency
from gpu_tile_sim.hardware.gpu_config import GPUConfig
from gpu_tile_sim.hardware.sass_spec import SassExecutionSpec, sass_execution_spec
from gpu_tile_sim.model import OperationDescriptor, ResourceKind, TileGraph, TileNode

MEMORY_PREFIXES = (
    "LD",
    "ST",
    "ATOM",
    "RED",
    "CPASYNC",
    "LDGSTS",
    "UTMA",
)
MATRIX_PREFIXES = (
    "HMMA",
    "HGMMA",
    "IMMA",
    "BMMA",
    "MMA",
    "WGMMA",
    "UTCHMMA",
    "TCGEN05.MMA",
)
CONTROL_PREFIXES = (
    "BAR",
    "BRA",
    "BRX",
    "BREAK",
    "EXIT",
    "MEMBAR",
    "NANOSLEEP",
    "NOP",
    "WARPSYNC",
    "YIELD",
)
SASS_BINARY_CONFIGS = {
    80: frozenset({"A100", "A100_PCIE_80GB", "NVIDIA_A100_SXM4_80GB"}),
    89: frozenset({"RTX4090"}),
    90: frozenset({"H100_SXM", "NVIDIA_H200"}),
    100: frozenset({"B200"}),
    103: frozenset({"B300"}),
}
RECORD_LAUNCH_STREAM_SCOPE = "record_physical_launch_stream"


def bind_sass_instruction_summary(
    graph: TileGraph,
    summary: dict[str, object],
    config: GPUConfig,
) -> TileGraph:
    """Replace source-estimated execution work with exact active-lane SASS work."""

    if not summary:
        return graph
    if summary.get("binding_scope") == RECORD_LAUNCH_STREAM_SCOPE:
        return graph
    cta_count = int(summary.get("cta_count", 0))
    if cta_count != graph.tb_count:
        raise ValueError(
            f"SASS trace CTA count {cta_count} disagrees with graph TB count {graph.tb_count}"
        )
    trace_hash = str(summary.get("trace_sha256", ""))
    if len(trace_hash) != 64:
        raise ValueError("SASS instruction summary requires a SHA-256 trace identity")
    raw_mix = summary.get("sfu_active_lane_operations")
    if not isinstance(raw_mix, dict):
        raise ValueError("SASS instruction summary requires sfu_active_lane_operations")
    total_mix = {str(opcode): float(count) for opcode, count in raw_mix.items()}
    if any(count < 0.0 for count in total_mix.values()):
        raise ValueError("SASS SFU counts must be non-negative")
    per_cta_mix = {opcode: count / cta_count for opcode, count in total_mix.items()}
    equivalent_work = config.sfu_equivalent_work(per_cta_mix)
    source_work = _source_sfu_work(graph)
    nodes = _replace_sfu_work(
        graph.nodes,
        source_work=source_work,
        equivalent_work=equivalent_work,
        per_cta_mix=per_cta_mix,
    )
    if _binds_cuda_work(graph):
        nodes = _bind_cuda_work(nodes, summary, cta_count)
    metadata = dict(graph.metadata)
    metadata.update(
        {
            "sass_instruction_summary": dict(summary),
            "sass_trace_sha256": trace_hash,
            "sass_sfu_active_lane_operations_per_cta": per_cta_mix,
            "sass_sfu_equivalent_operations_per_cta": equivalent_work,
            "sfu_work_provenance": "dynamic_sass_active_lane_opcodes",
        }
    )
    _bind_memory_traffic(metadata, summary)
    _bind_cluster_launch(metadata, summary)
    _bind_sass_execution(metadata, summary, config)
    from gpu_tile_sim.frontend.graph_resource_binding import bind_sass_graph_resources

    return bind_sass_graph_resources(
        replace(graph, nodes=nodes, metadata=metadata), summary, config
    )


def _bind_sass_execution(
    metadata: dict[str, object], summary: dict[str, object], config: GPUConfig
) -> None:
    raw_launches = summary.get("sass_execution_launches")
    if raw_launches is None:
        return
    if not isinstance(raw_launches, list) or not raw_launches:
        raise ValueError("SASS execution envelope requires a non-empty launch list")
    launches = [dict(launch) for launch in raw_launches]
    for launch in launches:
        launch.setdefault("cache_state", metadata.get("cache_state", "unknown"))
    if (
        len(launches) == 1
        and summary.get("trace_sha256") is not None
        and launches[0].get("trace_sha256") is None
    ):
        launches[0]["trace_sha256"] = summary["trace_sha256"]
    launch_cycles = [launch_execution_cycles(launch, config) for launch in launches]
    cycle_bound = sum(launch_cycles)
    metadata["sass_execution_bound_cycles"] = cycle_bound
    metadata["sass_execution_launch_bound_cycles"] = launch_cycles
    metadata["sass_execution_launches"] = launches
    metadata["sass_execution_provenance"] = (
        "dynamic SASS warp issue, scoreboard, L1TEX/shared queue, and async-group envelope"
    )


def _bind_cluster_launch(metadata: dict[str, object], summary: dict[str, object]) -> None:
    if "cluster_shape" not in summary:
        return
    uses_clc = summary.get("uses_cluster_launch_control", False)
    metadata_present = summary.get("cluster_metadata_present", False)
    if not isinstance(uses_clc, bool) or not isinstance(metadata_present, bool):
        raise ValueError("SASS cluster flags must be booleans")
    metadata["cluster_shape"] = list(summary["cluster_shape"])
    if "grid_shape" in summary:
        metadata["grid_shape"] = list(summary["grid_shape"])
    metadata["uses_cluster_launch_control"] = uses_clc
    metadata["cluster_metadata_present"] = metadata_present


def launch_execution_cycles(
    launch: dict[str, object],
    config: GPUConfig,
    *,
    engine: str = "python",
    execution_spec: SassExecutionSpec | None = None,
) -> int:
    """Schedule fixed CTA-cycle observations over compatible physical partitions.

    This hot path rebinds placement, residency, and launch-shared queues. It does not
    recompute CTA-internal dependencies when pipeline timing changes; use the
    timing-free CTA-template DSE path for those changes.
    """

    return launch_partition_execution_plan(
        launch, config, engine=engine, execution_spec=execution_spec
    ).total_cycles


def launch_partition_execution_plan(
    launch: dict[str, object],
    config: GPUConfig,
    *,
    engine: str = "python",
    execution_spec: SassExecutionSpec | None = None,
) -> PartitionExecutionPlan:
    """Return the per-partition completion state for one exact SASS launch."""

    if launch.get("shared_sm_programs") is not None:
        if execution_spec is not None or launch.get("memory_replay") is not None:
            raise ValueError(
                "shared SM program replay cannot combine separate replay/spec overrides"
            )
        from gpu_tile_sim.comparison.sass_dse_contract import (
            active_sass_config,
            predictor_latency_reference,
            predictor_rate_reference,
        )
        from gpu_tile_sim.comparison.sass_program_codec import decode_sass_program_profile
        from gpu_tile_sim.comparison.sass_template_rebind import rebind_cta_templates

        profile = decode_sass_program_profile(launch["shared_sm_programs"])
        if any(launch.get(name) != value for name, value in profile.launch.items()):
            raise ValueError("shared SM program launch differs from its exact source evidence")
        execution_context = str(launch.get("shared_sm_context", "active_cycles"))
        active_config = active_sass_config(
            profile.source_config,
            config,
            execution_context,
            envelope=launch.get("shared_sm_predictor_envelope"),
            trace_sha256=str(launch.get("trace_sha256")),
        )
        result = rebind_cta_templates(
            profile,
            active_config,
            execution_mode="shared_sm",
            execution_context=execution_context,
            latency_reference=predictor_latency_reference(
                launch.get("shared_sm_predictor_envelope")
            ),
            rate_reference=predictor_rate_reference(launch.get("shared_sm_predictor_envelope")),
        )
        assert result.execution_plan is not None
        return result.execution_plan
    launch = expand_cta_observables(launch)
    binary_version = int(launch["binary_version"])
    compatible = SASS_BINARY_CONFIGS.get(binary_version)
    if compatible is None or config.name not in compatible:
        raise ValueError(
            f"SASS sm_{binary_version} execution profile is incompatible with {config.name}"
        )
    model_id = str(launch.get("model_id", ""))
    expected_model_id = sass_execution_spec(binary_version).model_id
    if model_id != expected_model_id:
        raise ValueError(
            f"stale SASS execution profile {model_id!r}; expected {expected_model_id!r}"
        )
    if execution_spec is not None and (
        execution_spec.binary_version != binary_version or execution_spec.model_id != model_id
    ):
        raise ValueError("target execution spec is incompatible with the SASS launch")
    if execution_spec is not None:
        _validate_rebound_execution_spec(launch, execution_spec)
    resources = {
        "exact_launch_resources": True,
        "shared_bytes_per_cta": int(launch["shared_bytes"]),
        "num_warps": int(launch["num_warps"]),
        "registers_per_thread": int(launch["registers_per_thread"]),
    }
    residency = estimate_launch_cta_residency(config, resources)
    if "cluster_shape" not in launch:
        raise ValueError("SASS execution profile has no cluster shape; regenerate the profile")
    cluster_launch = cluster_launch_from_metadata(launch)
    build_cluster_wave_plan(
        config,
        int(launch["cta_count"]),
        max_ctas_per_sm=residency,
        launch=cluster_launch,
    )
    raw_cta_cycles = launch.get("cta_cycles")
    if not isinstance(raw_cta_cycles, list) or not raw_cta_cycles:
        raise ValueError("SASS execution profile lacks full-CTA cycle coverage")
    cta_cycles = tuple(int(value) for value in raw_cta_cycles)
    if len(cta_cycles) != int(launch["cta_count"]):
        raise ValueError("SASS CTA cycle count disagrees with the physical launch grid")
    if launch.get("memory_replay") is not None:
        if execution_spec is not None:
            raise ValueError("address memory replay does not support a rebound execution spec")
        from gpu_tile_sim.backend.sass_dram_replay import replay_sass_memory_launch

        return replay_sass_memory_launch(launch, config)
    plan = schedule_traced_ctas(
        config,
        cta_cycles,
        max_ctas_per_sm=residency,
        launch=cluster_launch,
        engine=engine,
    )
    spec = execution_spec or sass_execution_spec(binary_version)
    return apply_launch_memory_bounds(plan, launch, config, spec)


def apply_launch_memory_bounds(
    plan: PartitionExecutionPlan,
    launch: dict[str, object],
    config: GPUConfig,
    spec: SassExecutionSpec,
) -> PartitionExecutionPlan:
    """Apply existing aggregate launch bounds to an already scheduled plan.

    The shared-SM path uses real CTA start/finish intervals. These aggregate
    queue tails retain the fast memory approximation; they do not implement
    address-level completion feedback, which belongs to coupled replay.
    """
    if spec.launch_level_shared_queues:
        plan = apply_shared_sass_queues(plan, launch=launch, config=config, spec=spec)
    dram = sass_dram_bound(launch, config)
    return replace(
        plan,
        total_cycles=max(plan.total_cycles, dram.cycles),
        dram_bound_cycles=dram.cycles,
        dram_traffic_estimate=dram.to_dict(),
    )


def _validate_rebound_execution_spec(launch: dict[str, object], target: SassExecutionSpec) -> None:
    from gpu_tile_sim.comparison.sass_execution import replay_sass_execution_spec

    source = replay_sass_execution_spec(
        int(launch["binary_version"]),
        static_control_available=launch.get("static_sass_sha256") is not None,
    )
    retimable = {
        "l1tex_sector_throughput_per_cycle",
        "shared_latency_cycles",
        "dependent_l2_latency_cycles",
        "tma_setup_cycles",
        "tma_initiation_cycles",
        "tma_bytes_per_cycle",
        "tmem_allocate_cycles",
        "tmem_deallocate_cycles",
    }
    changed = [
        item.name
        for item in fields(SassExecutionSpec)
        if item.name not in retimable and getattr(source, item.name) != getattr(target, item.name)
    ]
    if changed:
        raise ValueError("unsupported rebound execution spec fields: " + ", ".join(changed))


def _binds_cuda_work(graph: TileGraph) -> bool:
    return (
        graph.metadata.get("source_kind") == "cuda_source_schedule"
        or graph.metadata.get("workload") == "attention"
    )


def _bind_cuda_work(
    nodes: tuple[TileNode, ...], summary: dict[str, object], cta_count: int
) -> tuple[TileNode, ...]:
    raw = summary.get("active_lane_instruction_counts")
    if not isinstance(raw, dict):
        raise ValueError("SASS instruction summary requires active-lane instruction counts")
    mix = {
        str(opcode): float(count) / cta_count
        for opcode, count in raw.items()
        if _is_cuda_opcode(str(opcode))
    }
    source_work = sum(
        node.operation.work_amount
        for node in nodes
        if node.operation.resource is ResourceKind.CUDA_CORE
    )
    exact_work = sum(mix.values())
    return _replace_resource_work(
        nodes,
        resource=ResourceKind.CUDA_CORE,
        source_work=source_work,
        exact_work=exact_work,
        mix=mix,
    )


def _is_cuda_opcode(opcode: str) -> bool:
    prefixes = (*MEMORY_PREFIXES, *MATRIX_PREFIXES, *CONTROL_PREFIXES, "MUFU")
    return not opcode.startswith(prefixes)


def _bind_memory_traffic(metadata: dict[str, object], summary: dict[str, object]) -> None:
    if metadata.get("source_kind") != "cuda_source_schedule":
        return
    sector_bytes = int(summary.get("memory_sector_bytes", 0))
    load_sectors = int(summary.get("global_load_sector_requests", 0))
    store_sectors = int(summary.get("global_store_sector_requests", 0))
    unique_sectors = int(summary.get("unique_global_sectors", 0))
    if min(sector_bytes, unique_sectors) <= 0 or min(load_sectors, store_sectors) < 0:
        raise ValueError("SASS memory summary requires positive sectors and sector bytes")
    metadata["l2_requested_bytes"] = (load_sectors + store_sectors) * sector_bytes
    metadata["l2_cold_miss_bytes"] = unique_sectors * sector_bytes
    metadata["l2_persistent_bytes"] = unique_sectors * sector_bytes
    metadata["memory_work_provenance"] = "dynamic_sass_coalesced_sector_addresses"


def _source_sfu_work(graph: TileGraph) -> float:
    return sum(
        node.operation.work_amount
        for node in graph.nodes
        if node.operation.resource is ResourceKind.SFU
    )


def _replace_sfu_work(
    nodes: tuple[TileNode, ...],
    *,
    source_work: float,
    equivalent_work: float,
    per_cta_mix: dict[str, float],
) -> tuple[TileNode, ...]:
    return _replace_resource_work(
        nodes,
        resource=ResourceKind.SFU,
        source_work=source_work,
        exact_work=equivalent_work,
        mix=per_cta_mix,
    )


def _replace_resource_work(
    nodes: tuple[TileNode, ...],
    *,
    resource: ResourceKind,
    source_work: float,
    exact_work: float,
    mix: dict[str, float],
) -> tuple[TileNode, ...]:
    if source_work == 0.0:
        if exact_work != 0.0:
            raise ValueError(f"SASS trace contains {resource.value} work without a graph node")
        return nodes
    scale = exact_work / source_work
    return tuple(
        _scaled_resource_node(node, resource=resource, scale=scale, mix=mix) for node in nodes
    )


def _scaled_resource_node(
    node: TileNode,
    *,
    resource: ResourceKind,
    scale: float,
    mix: dict[str, float],
) -> TileNode:
    if node.operation.resource is not resource:
        return node
    metadata = dict(node.operation.metadata)
    metadata[f"sass_{resource.value}_active_lane_operations_per_cta"] = mix
    operation = OperationDescriptor(
        kind=node.operation.kind,
        resource=node.operation.resource,
        work_amount=node.operation.work_amount * scale,
        latency_cycles=node.operation.latency_cycles,
        target=node.operation.target,
        metadata=metadata,
    )
    return replace(node, operation=operation)
