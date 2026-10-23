"""Exact same-ISA DSE by replaying unique timing-parametric CTA templates once."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, replace
from math import ceil, isfinite
from pathlib import Path

from gpu_tile_sim.backend.sass_partition_scheduler import PartitionExecutionPlan
from gpu_tile_sim.comparison.sass_binding import SASS_BINARY_CONFIGS, launch_execution_cycles
from gpu_tile_sim.comparison.sass_cluster import GroupedClusterIdentity
from gpu_tile_sim.comparison.sass_dse_contract import (
    validate_template_dse_changes,
    validate_template_source_config,
)
from gpu_tile_sim.comparison.sass_execution import (
    execute_cta_streams,
    profile_sass_execution,
    replay_sass_execution_spec,
)
from gpu_tile_sim.comparison.sass_execution_instruction import ExecutionInstruction
from gpu_tile_sim.comparison.sass_trace import parse_sass_trace_schedule
from gpu_tile_sim.hardware.gpu_config import GPUConfig, PipelineSpec
from gpu_tile_sim.hardware.sass_spec import (
    B300_TCGEN_SATURATED_INITIATION_CYCLES,
    PipelineKind,
    SassExecutionSpec,
)
from gpu_tile_sim.model import ResourceKind

InstructionStreams = tuple[tuple[int, tuple[ExecutionInstruction, ...]], ...]


@dataclass(frozen=True, slots=True)
class CtaTemplateDseProfile:
    """Rebindable CTA programs plus their exact physical-CTA ID stream."""

    launch: Mapping[str, object]
    templates: tuple[InstructionStreams, ...]
    template_ids: tuple[int, ...]
    source_config: GPUConfig
    source_spec: SassExecutionSpec
    cluster_execution: str = "legacy_rank_zero"

    def __post_init__(self) -> None:
        if self.cluster_execution not in {"legacy_rank_zero", "independent"}:
            raise ValueError("unknown template cluster execution contract")
        validate_template_source_config(self.source_config)
        expected_spec = replay_sass_execution_spec(
            int(self.launch["binary_version"]),
            static_control_available=self.launch.get("static_sass_sha256") is not None,
        )
        if self.source_spec != expected_spec:
            raise ValueError("DSE source spec differs from the profiled canonical execution spec")
        cta_count = int(self.launch["cta_count"])
        if len(self.template_ids) != cta_count:
            raise ValueError("DSE template-ID stream must cover every physical CTA")
        if not self.templates:
            raise ValueError("DSE profile requires at least one CTA template")
        num_warps = int(self.launch["num_warps"])
        for template in self.templates:
            ids = [warp for warp, _ in template]
            if len(set(ids)) != len(ids) or any(
                type(warp) is not int or not 0 <= warp < num_warps for warp in ids
            ):
                raise ValueError("DSE template warp IDs exceed the physical CTA allocation")


@dataclass(frozen=True, slots=True)
class CtaTemplateDseResult:
    cycles: int
    physical_cta_count: int
    unique_template_count: int
    template_executions: int
    cta_cycles: tuple[int, ...]
    execution_mode: str = "legacy"
    execution_plan: PartitionExecutionPlan | None = None


class _TemplateCollector:
    def __init__(self, cluster_execution: str = "legacy_rank_zero") -> None:
        self.cluster_execution = cluster_execution
        self._templates: list[InstructionStreams] = []
        self._template_ids: dict[int, int] = {}
        self._index: dict[InstructionStreams, int] = {}
        self._cluster_leaders: dict[tuple[int, int, int], int] = {}

    def observe(
        self,
        cta_id: int,
        streams: Mapping[int, tuple[ExecutionInstruction, ...]],
        identity: GroupedClusterIdentity,
    ) -> None:
        signature = _canonical_streams(streams)
        template_id = self._execution_template_id(signature, identity)
        self._template_ids[cta_id] = template_id

    def _execution_template_id(
        self, signature: InstructionStreams, identity: GroupedClusterIdentity
    ) -> int:
        if self.cluster_execution == "independent":
            return self._register(signature)
        if not identity.is_empty and identity.cluster_rank != 0:
            if identity.cluster_id is None:
                raise ValueError("cluster follower has no cluster identity")
            if identity.cluster_id not in self._cluster_leaders:
                raise ValueError("cluster follower appears before its rank-zero leader")
            return self._cluster_leaders[identity.cluster_id]
        template_id = self._register(signature)
        if identity.cluster_id is not None:
            self._cluster_leaders[identity.cluster_id] = template_id
        return template_id

    def _register(self, signature: InstructionStreams) -> int:
        template_id = self._index.get(signature)
        if template_id is not None:
            return template_id
        template_id = len(self._templates)
        self._index[signature] = template_id
        self._templates.append(signature)
        return template_id

    def build(
        self,
        launch: Mapping[str, object],
        source_config: GPUConfig,
        source_spec: SassExecutionSpec,
    ) -> CtaTemplateDseProfile:
        expected = range(int(launch["cta_count"]))
        if set(self._template_ids) != set(expected):
            raise ValueError("DSE template collector did not observe every physical CTA")
        ids = tuple(self._template_ids[cta_id] for cta_id in expected)
        return CtaTemplateDseProfile(
            dict(launch),
            tuple(self._templates),
            ids,
            source_config,
            source_spec,
            self.cluster_execution,
        )


def profile_cta_templates_for_dse(
    trace_path: str | Path,
    *,
    source_config: GPUConfig,
    static_sass_path: str | Path | None = None,
    cluster_execution: str = "legacy_rank_zero",
) -> CtaTemplateDseProfile:
    """Construct exact parametric templates; trace collection remains outside this call."""

    validate_template_source_config(source_config)
    collector = _TemplateCollector(cluster_execution)
    execution = profile_sass_execution(
        trace_path,
        static_sass_path=static_sass_path,
        cta_stream_observer=collector.observe,
        cluster_execution=cluster_execution,
    )
    source_spec = replay_sass_execution_spec(
        execution.binary_version,
        static_control_available=execution.static_sass_sha256 is not None,
    )
    launch = execution.to_dict()
    launch["kernel_name"] = parse_sass_trace_schedule(trace_path, require_tile=False).kernel_name
    return collector.build(launch, source_config, source_spec)


def shared_sm_launch(
    profile: CtaTemplateDseProfile,
    *,
    context: str = "active_cycles",
    expected_predictor_config: GPUConfig | None = None,
) -> dict[str, object]:
    """Bind complete programs to the ordinary launch/full-predictor entry point."""
    from gpu_tile_sim.comparison.sass_program_codec import encode_sass_program_profile

    if context not in {"active_cycles", "full_predictor"}:
        raise ValueError("unknown SASS execution envelope context")
    if (context == "full_predictor") != (expected_predictor_config is not None):
        raise ValueError(
            "full_predictor context requires an explicit expected predictor configuration; "
            "standalone active cycles cannot bind one"
        )
    result = {
        **profile.launch,
        "shared_sm_programs": encode_sass_program_profile(profile),
        "shared_sm_context": context,
    }
    if expected_predictor_config is not None:
        from gpu_tile_sim.comparison.sass_dse_contract import encode_sass_predictor_envelope

        result["shared_sm_predictor_envelope"] = encode_sass_predictor_envelope(
            profile.source_config,
            expected_predictor_config,
            trace_sha256=str(profile.launch["trace_sha256"]),
        )
    return result


def rebind_cta_templates(
    profile: CtaTemplateDseProfile,
    target_config: GPUConfig,
    *,
    deduplicate: bool = True,
    execution_mode: str = "legacy",
    execution_context: str = "active_cycles",
    latency_reference: Mapping[ResourceKind, int] | None = None,
    rate_reference: Mapping[ResourceKind, PipelineSpec] | None = None,
    tmem_footprints=None,
) -> CtaTemplateDseResult:
    """Recompute CTA-internal timing and then schedule every physical CTA exactly."""

    binary_version = int(profile.launch["binary_version"])
    _validate_retiming_reference(
        execution_context, latency_reference, rate_reference, profile.source_config
    )
    compatible = SASS_BINARY_CONFIGS.get(binary_version, frozenset())
    if profile.source_config.name not in compatible or target_config.name not in compatible:
        raise ValueError("CTA-template DSE supports same-ISA configuration changes only")
    if profile.source_spec.binary_version != binary_version:
        raise ValueError("DSE source spec does not match the profiled SASS binary")
    validate_template_dse_changes(
        profile.source_config,
        target_config,
        shared_queues=(
            profile.source_spec.launch_level_shared_queues or execution_mode == "shared_sm"
        ),
        execution_mode=execution_mode,
    )
    if profile.launch.get("memory_replay") is not None:
        raise ValueError("CTA-template DSE does not support an attached address memory_replay")
    spec = _rebind_spec(
        profile.source_spec,
        profile.source_config,
        target_config,
        execution_mode=execution_mode,
        execution_context=execution_context,
        latency_reference=latency_reference,
        rate_reference=rate_reference,
    )
    if execution_mode == "shared_sm":
        return _rebind_shared_launch(
            profile,
            target_config,
            spec,
            deduplicate,
            tmem_footprints,
            execution_context,
            latency_reference,
            rate_reference,
        )
    if tmem_footprints is not None:
        raise ValueError("TMEM footprint binding requires shared_sm execution")
    template_cycles = tuple(
        _execute_rebound_template(
            template,
            spec,
            profile.source_config,
            target_config,
            execution_context=execution_context,
            latency_reference=latency_reference,
            rate_reference=rate_reference,
        )
        for template in profile.templates
    )
    if deduplicate:
        cta_cycles = tuple(template_cycles[index] for index in profile.template_ids)
        executions = len(profile.templates)
    else:
        cta_cycles = tuple(
            _execute_rebound_template(
                profile.templates[index],
                spec,
                profile.source_config,
                target_config,
                execution_context=execution_context,
                latency_reference=latency_reference,
                rate_reference=rate_reference,
            )
            for index in profile.template_ids
        )
        executions = len(profile.template_ids)
    if execution_context == "active_cycles" and target_config == profile.source_config:
        source_cycles = tuple(int(value) for value in profile.launch["cta_cycles"])
        if cta_cycles != source_cycles:
            raise RuntimeError("source-configuration CTA rebinding changed execution semantics")
    launch = dict(profile.launch)
    launch["cta_cycles"] = list(cta_cycles)
    launch["template_cycles"] = cta_cycles[0]
    cycles = launch_execution_cycles(launch, target_config, engine="cpp", execution_spec=spec)
    return CtaTemplateDseResult(
        cycles=cycles,
        physical_cta_count=len(profile.template_ids),
        unique_template_count=len(profile.templates),
        template_executions=executions,
        cta_cycles=cta_cycles,
    )


def _rebind_shared_launch(
    profile,
    config,
    spec,
    deduplicate,
    tmem_footprints,
    execution_context,
    latency_reference,
    rate_reference,
):
    from gpu_tile_sim.backend.cluster_scheduler import cluster_launch_from_metadata
    from gpu_tile_sim.comparison.occupancy import estimate_launch_cta_residency
    from gpu_tile_sim.comparison.sass_binding import apply_launch_memory_bounds
    from gpu_tile_sim.comparison.sass_shared_execution import execute_shared_sass_launch
    from gpu_tile_sim.comparison.sass_tmem_footprint import bind_tmem_footprints

    launch = dict(profile.launch)
    cluster = cluster_launch_from_metadata(launch)
    if cluster.cta_count > 1 and profile.cluster_execution != "independent":
        raise ValueError("shared SM clusters require independent follower programs")
    if tmem_footprints is not None and (
        tmem_footprints.trace_sha256 != launch.get("trace_sha256")
        or tmem_footprints.static_sass_sha256 != launch.get("static_sass_sha256")
        or tmem_footprints.kernel_name != launch.get("kernel_name")
    ):
        raise ValueError("TMEM footprint manifest does not match the template launch")

    def retime(template):
        streams = {
            warp: tuple(
                _rebind_instruction(
                    i,
                    profile.source_config,
                    config,
                    shared_sm=True,
                    execution_context=execution_context,
                    latency_reference=latency_reference,
                    rate_reference=rate_reference,
                )
                for i in stream
            )
            for warp, stream in template
        }
        return (
            streams if tmem_footprints is None else bind_tmem_footprints(streams, tmem_footprints)
        )

    if deduplicate:
        templates = tuple(retime(template) for template in profile.templates)
        programs = tuple(templates[index] for index in profile.template_ids)
    else:
        programs = tuple(retime(profile.templates[index]) for index in profile.template_ids)
    residency = estimate_launch_cta_residency(
        config,
        {
            "exact_launch_resources": True,
            "shared_bytes_per_cta": launch["shared_bytes"],
            "num_warps": launch["num_warps"],
            "registers_per_thread": launch["registers_per_thread"],
        },
    )
    plan = execute_shared_sass_launch(
        programs,
        config,
        spec,
        residency,
        launch=cluster,
        warps_per_cta=int(launch["num_warps"]),
    )
    durations = tuple(
        finish - start
        for start, finish in zip(
            plan.start_cycles_by_cta, plan.completion_cycles_by_cta, strict=True
        )
    )
    plan = apply_launch_memory_bounds(plan, launch, config, spec)
    return CtaTemplateDseResult(
        cycles=plan.total_cycles,
        physical_cta_count=len(programs),
        unique_template_count=len(profile.templates),
        template_executions=len(programs),
        cta_cycles=durations,
        execution_mode="shared_sm",
        execution_plan=plan,
    )


def _execute_rebound_template(
    template: InstructionStreams,
    spec: SassExecutionSpec,
    source_config: GPUConfig,
    target_config: GPUConfig,
    *,
    execution_context: str = "active_cycles",
    latency_reference: Mapping[ResourceKind, int] | None = None,
    rate_reference: Mapping[ResourceKind, PipelineSpec] | None = None,
) -> int:
    streams = {
        warp: tuple(
            _rebind_instruction(
                instruction,
                source_config,
                target_config,
                execution_context=execution_context,
                latency_reference=latency_reference,
                rate_reference=rate_reference,
            )
            for instruction in instructions
        )
        for warp, instructions in template
    }
    cycles, _ = execute_cta_streams(streams, spec)
    return cycles


def _rebind_instruction(
    instruction: ExecutionInstruction,
    source_config: GPUConfig,
    target_config: GPUConfig,
    *,
    shared_sm: bool = False,
    execution_context: str = "active_cycles",
    latency_reference: Mapping[ResourceKind, int] | None = None,
    rate_reference: Mapping[ResourceKind, PipelineSpec] | None = None,
) -> ExecutionInstruction:
    # Whole-reference validation happens once at the launch/spec boundary.
    # Instruction dictionaries can contain millions of repeated instances.
    if execution_context not in {"active_cycles", "full_predictor"}:
        raise ValueError("unknown SASS execution envelope context")
    if execution_context == "full_predictor" and (
        latency_reference is None or rate_reference is None
    ):
        raise ValueError(
            "full predictor retiming requires complete bound pipeline latency references "
            "and effective pipeline rate references"
        )
    if execution_context == "active_cycles" and (
        latency_reference is not None or rate_reference is not None
    ):
        raise ValueError("standalone active cycles cannot carry predictor retiming references")
    # These memory-issue opcodes carry synchronization costs, not L2 service.
    if instruction.opcode.startswith(
        ("SYNCS", "DEPBAR", "LDGDEPBAR", "ARRIVES", "FENCE", "LDC", "ULDC")
    ):
        return instruction
    resource = _instruction_resource(instruction)
    source = source_config.pipeline(resource)
    target = target_config.pipeline(resource)
    # ISA-local seeds already contain the source characterization. Generic
    # component loop latencies are the predictor's baseline reference, not an
    # additional multiplier on those seeds. Only target/reference DSE changes
    # apply in the explicitly bound full-predictor context.
    latency_source = (
        source.latency_cycles if latency_reference is None else latency_reference[resource]
    )
    latency = _scaled_latency(instruction.latency_cycles, latency_source, target.latency_cycles)
    if instruction.opcode.startswith(("UTCATOMSWS.FIND_AND_SET", "UTCATOMSWS.AND")) and (
        instruction.latency_cycles == instruction.initiation_cycles
        and instruction.latency_cycles > 0
    ):
        return replace(instruction, latency_cycles=latency, initiation_cycles=latency)
    if (
        resource is ResourceKind.L2
        and instruction.opcode.startswith(("LDG", "LD."))
        and instruction.global_sectors > 0
        and instruction.l2_sectors == 0
    ):
        latency = instruction.latency_cycles
    # The characterized predictor reference also anchors throughput and lane
    # timing. Compiler/model scales belong to the coarse graph, not the ISA
    # seed: removing a scale must not speed up a measured UTCHMMA a second time.
    rate_source = source if rate_reference is None else rate_reference[resource]
    source_rate = rate_source.throughput_per_cycle
    target_rate = target.throughput_per_cycle
    if shared_sm:
        source_rate = rate_source.lane_throughput_per_cycle or source_rate / rate_source.issue_width
        target_rate = target.lane_throughput_per_cycle or target_rate / target.issue_width
    initiation = _scaled_initiation(
        instruction.initiation_cycles,
        source_rate,
        target_rate,
    )
    changes = {"latency_cycles": latency, "initiation_cycles": initiation}
    if shared_sm and instruction.shared_service_cycles:
        changes["shared_service_cycles"] = _scaled_initiation(
            instruction.shared_service_cycles, source_rate, target_rate
        )
    return replace(instruction, **changes)


def _validate_retiming_reference(context, reference, rate_reference, source) -> None:
    if context not in {"active_cycles", "full_predictor"}:
        raise ValueError("unknown SASS execution envelope context")
    if context == "active_cycles":
        if reference is not None or rate_reference is not None:
            raise ValueError("standalone active cycles cannot carry predictor retiming references")
    elif (
        not isinstance(reference, Mapping)
        or set(reference) != set(source.pipelines)
        or any(type(value) is not int or value < 0 for value in reference.values())
    ):
        raise ValueError(
            "full predictor retiming requires complete bound pipeline latency references"
        )
    elif (
        not isinstance(rate_reference, Mapping)
        or set(rate_reference) != set(source.pipelines)
        or any(
            not isinstance(value, PipelineSpec)
            or value.resource is not resource
            or not isfinite(value.throughput_per_cycle)
            or value.throughput_per_cycle < 0
            or type(value.issue_width) is not int
            or value.issue_width <= 0
            or value.lane_throughput_per_cycle is not None
            and (
                not isfinite(value.lane_throughput_per_cycle)
                or value.lane_throughput_per_cycle <= 0
            )
            for resource, value in rate_reference.items()
        )
    ):
        raise ValueError(
            "full predictor retiming requires complete bound effective pipeline rate references"
        )


def _scaled_latency(value: int, source: int, target: int) -> int:
    if value == 0:
        return 0
    if source == target:
        return value
    if source == 0:
        return value + target
    return max(1, ceil(value * target / source))


def _scaled_initiation(value: int, source: float, target: float) -> int:
    if value == 0:
        return 0
    if target <= 0.0:
        raise ValueError("DSE target pipeline throughput must be positive")
    if source == target:
        return value
    return max(1, ceil(value * source / target))


def _rebind_spec(
    spec: SassExecutionSpec,
    source_config: GPUConfig,
    target_config: GPUConfig,
    *,
    execution_mode: str = "legacy",
    execution_context: str = "active_cycles",
    latency_reference: Mapping[ResourceKind, int] | None = None,
    rate_reference: Mapping[ResourceKind, PipelineSpec] | None = None,
) -> SassExecutionSpec:
    _validate_retiming_reference(
        execution_context, latency_reference, rate_reference, source_config
    )

    def reference_pipeline(resource):
        return (
            source_config.pipeline(resource) if rate_reference is None else rate_reference[resource]
        )

    source_tma = reference_pipeline(ResourceKind.TMA)
    target_tma = target_config.pipeline(ResourceKind.TMA)
    source_l2 = reference_pipeline(ResourceKind.L2)
    target_l2 = target_config.pipeline(ResourceKind.L2)
    source_sram = reference_pipeline(ResourceKind.SRAM)
    target_sram = target_config.pipeline(ResourceKind.SRAM)
    source_tmem = reference_pipeline(ResourceKind.TMEM)
    target_tmem = target_config.pipeline(ResourceKind.TMEM)
    if latency_reference is not None:
        source_tma = replace(source_tma, latency_cycles=latency_reference[ResourceKind.TMA])
        source_l2 = replace(source_l2, latency_cycles=latency_reference[ResourceKind.L2])
        source_sram = replace(source_sram, latency_cycles=latency_reference[ResourceKind.SRAM])
        source_tmem = replace(source_tmem, latency_cycles=latency_reference[ResourceKind.TMEM])
    source_tma_rate = source_tma.throughput_per_cycle
    target_tma_rate = target_tma.throughput_per_cycle
    if execution_mode == "shared_sm":
        source_tma_rate = (
            source_tma.lane_throughput_per_cycle or source_tma_rate / source_tma.issue_width
        )
        target_tma_rate = (
            target_tma.lane_throughput_per_cycle or target_tma_rate / target_tma.issue_width
        )
    shared_changes = {}
    if execution_mode == "shared_sm":
        widths = {}
        resources = {
            PipelineKind.ALU: ResourceKind.CUDA_CORE,
            PipelineKind.INTEGER: ResourceKind.CUDA_CORE,
            PipelineKind.DOUBLE: ResourceKind.CUDA_CORE,
            PipelineKind.SFU: ResourceKind.SFU,
            PipelineKind.TENSOR: ResourceKind.TENSOR_CORE,
            PipelineKind.GMMA: ResourceKind.TENSOR_CORE,
            PipelineKind.TCGEN: ResourceKind.TENSOR_CORE,
            PipelineKind.TMEM: ResourceKind.TMEM,
            PipelineKind.CONTROL: ResourceKind.BARRIER,
        }
        for kind in PipelineKind:
            # MEMORY can represent several frontends; its pipeline slots use
            # L2 timing, while TMA/SRAM have additional shared service queues.
            resource = resources.get(kind, ResourceKind.L2)
            after = target_config.pipeline(resource)
            widths[kind] = after.issue_width
        shared_changes = {
            # Complete shared execution supplies exact per-CTA intervals and
            # traffic on every ISA. Its aggregate queue consumer is not limited
            # to the SM103 legacy summary path that originally enabled it.
            "launch_level_shared_queues": True,
            "scheduler_count": target_config.warp_schedulers_per_sm,
            "scheduler_issue_width": target_config.warp_issue_width_per_scheduler,
            "pipeline_issue_widths": widths,
            # Instructions already carry their own lane-rate rebinding,
            # including distinct SRAM/TMA frontends in PipelineKind.MEMORY.
            "pipeline_lane_initiation_multipliers": {},
            "sm_pipeline_initiation_cycles": {},
            "tma_descriptor_slots_per_sm": target_config.tma_descriptor_slots_per_sm,
            "tma_engine_count_per_sm": target_config.tma_engine_count_per_sm,
            "tmem_columns_per_sm": target_config.tmem_columns_per_sm,
        }
        if spec.binary_version == 103:
            before = reference_pipeline(ResourceKind.TENSOR_CORE)
            after = target_config.pipeline(ResourceKind.TENSOR_CORE)
            shared_changes["sm_pipeline_initiation_cycles"] = {
                PipelineKind.TCGEN: _scaled_initiation(
                    B300_TCGEN_SATURATED_INITIATION_CYCLES,
                    before.throughput_per_cycle,
                    after.throughput_per_cycle,
                )
            }
    elif execution_mode != "legacy":
        raise ValueError("unknown SASS DSE execution mode")
    return replace(
        spec,
        **shared_changes,
        l1tex_sector_throughput_per_cycle=_scaled_rate(
            spec.l1tex_sector_throughput_per_cycle,
            source_l2.throughput_per_cycle,
            target_l2.throughput_per_cycle,
        ),
        shared_latency_cycles=_scaled_latency(
            spec.shared_latency_cycles,
            source_sram.latency_cycles,
            target_sram.latency_cycles,
        ),
        dependent_l2_latency_cycles=_scaled_latency(
            spec.dependent_l2_latency_cycles,
            source_l2.latency_cycles,
            target_l2.latency_cycles,
        ),
        tma_setup_cycles=_scaled_latency(
            spec.tma_setup_cycles,
            source_tma.latency_cycles,
            target_tma.latency_cycles,
        ),
        tma_initiation_cycles=_scaled_initiation(
            spec.tma_initiation_cycles,
            source_tma_rate,
            target_tma_rate,
        ),
        tma_bytes_per_cycle=_scaled_float_rate(
            spec.tma_bytes_per_cycle,
            source_tma_rate,
            target_tma_rate,
        ),
        tmem_allocate_cycles=_scaled_latency(
            spec.tmem_allocate_cycles,
            source_tmem.latency_cycles,
            target_tmem.latency_cycles,
        ),
        tmem_deallocate_cycles=_scaled_latency(
            spec.tmem_deallocate_cycles,
            source_tmem.latency_cycles,
            target_tmem.latency_cycles,
        ),
    )


def _scaled_rate(value: int, source: float, target: float) -> int:
    return max(1, round(_scaled_float_rate(float(value), source, target)))


def _scaled_float_rate(value: float, source: float, target: float) -> float:
    if source <= 0.0 or target <= 0.0:
        raise ValueError("DSE pipeline throughput must be positive")
    return value * target / source


def _instruction_resource(instruction: ExecutionInstruction) -> ResourceKind:
    if instruction.kind in {PipelineKind.ALU, PipelineKind.INTEGER, PipelineKind.DOUBLE}:
        return ResourceKind.CUDA_CORE
    if instruction.kind is PipelineKind.SFU:
        return ResourceKind.SFU
    if instruction.kind in {PipelineKind.TENSOR, PipelineKind.GMMA, PipelineKind.TCGEN}:
        return ResourceKind.TENSOR_CORE
    if instruction.kind is PipelineKind.TMEM:
        return ResourceKind.TMEM
    if instruction.kind is PipelineKind.CONTROL:
        return ResourceKind.BARRIER
    if instruction.tma_bytes or instruction.tma_oob_bytes:
        return ResourceKind.TMA
    if instruction.opcode.startswith(("LDS", "STS", "LDSM", "STSM")):
        return ResourceKind.SRAM
    return ResourceKind.L2


def _canonical_streams(
    streams: Mapping[int, tuple[ExecutionInstruction, ...]],
) -> InstructionStreams:
    address_ids: dict[int, int] = {}

    def canonical(address: int | None) -> int | None:
        if address is None or address == 0:
            return address
        if address not in address_ids:
            address_ids[address] = len(address_ids) + 1
        return address_ids[address]

    normalized = []
    for warp, instructions in sorted(streams.items()):
        rebound = []
        for instruction in instructions:
            action = instruction.barrier_action
            wait = instruction.barrier_wait
            if action is not None:
                action = replace(action, address=canonical(action.address))
            if wait is not None:
                wait = replace(wait, address=canonical(wait.address))
            uses_async_addresses = instruction.opcode.startswith(("UTCBAR", "UGETNEXTWORKID"))
            async_addresses = (
                tuple(canonical(address) for address in instruction.async_barrier_addresses)
                if uses_async_addresses
                else ()
            )
            rebound.append(
                replace(
                    instruction,
                    barrier_action=action,
                    barrier_wait=wait,
                    async_barrier_addresses=async_addresses,
                    tma_mbarrier_address=canonical(instruction.tma_mbarrier_address),
                    memory_sector_addresses=(),
                )
            )
        normalized.append((warp, tuple(rebound)))
    return tuple(normalized)
