"""Per-CTA SASS scheduler envelope below full Accel-Sim instruction detail."""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import replace
from pathlib import Path
from types import MappingProxyType

from gpu_tile_sim.comparison.sass_async_services import (
    async_resource_ready_cycle,
    mbarrier_wait_target,
)
from gpu_tile_sim.comparison.sass_cluster import (
    GroupedClusterIdentity,
    SassClusterMetadata,
    parse_sass_cluster_metadata,
)
from gpu_tile_sim.comparison.sass_control import SassControlSchedule, parse_sass_control_schedule
from gpu_tile_sim.comparison.sass_cta_profile import (
    CtaStreamCallbacks,
    CtaStreamProfile,
    profile_cta_streams,
)
from gpu_tile_sim.comparison.sass_execution_instruction import (
    ExecutionInstruction,
    execution_instruction,
    is_tcgen_warpgroup_duplicate,
)
from gpu_tile_sim.comparison.sass_execution_issue import issue_instruction
from gpu_tile_sim.comparison.sass_execution_profile import SassExecutionProfile
from gpu_tile_sim.comparison.sass_execution_state import (
    MachineState,
    WarpState,
    barrier_participants,
    initial_machine_state,
)
from gpu_tile_sim.comparison.sass_instruction_model import is_blocking_tma_wait
from gpu_tile_sim.comparison.sass_trace import (
    SassTraceProfile,
    parse_sass_trace_profile,
    parse_sass_trace_schedule,
)
from gpu_tile_sim.comparison.sass_trace_normalization import canonicalize_spin_loops
from gpu_tile_sim.hardware.sass_spec import SassExecutionSpec, sass_execution_spec


def profile_sass_execution(
    path: str | Path,
    *,
    cluster_metadata: SassClusterMetadata | None = None,
    cluster_execution: str = "legacy_rank_zero",
    execution_spec: SassExecutionSpec | None = None,
    memory_profile: SassTraceProfile | None = None,
    static_sass_path: str | Path | None = None,
    cta_stream_observer: (
        Callable[
            [
                int,
                Mapping[int, tuple[ExecutionInstruction, ...]],
                GroupedClusterIdentity,
            ],
            None,
        ]
        | None
    ) = None,
) -> SassExecutionProfile:
    """Simulate every CTA while retaining first-CTA compatibility statistics."""

    schedule = parse_sass_trace_schedule(path, require_tile=False)
    memory = parse_sass_trace_profile(path) if memory_profile is None else memory_profile
    if memory.schedule != schedule:
        raise ValueError("SASS memory and execution profiles describe different schedules")
    spec = _execution_spec(schedule.binary_version, execution_spec)
    control = _control_schedule(
        schedule.kernel_name,
        static_sass_path,
        spec,
        dynamic_sites=memory.dynamic_instruction_sites,
    )
    replay_spec = _spec_for_control_availability(spec, control)
    cta_profile = _cta_profile(
        path,
        grid_shape=schedule.grid,
        spec=replay_spec,
        control=control,
        stream_observer=cta_stream_observer,
        cluster_execution=cluster_execution,
        cluster_shape=(cluster_metadata or memory.cluster).shape,
    )
    template_cta = cta_profile.first_cta
    warps = cta_profile.first_warps
    instructions = tuple(item for stream in warps.values() for item in stream)
    scheduler_cycles, instruction_count = _execute_template(warps, replay_spec)
    shared_services = [
        item.shared_service_cycles for item in instructions if item.shared_service_cycles
    ]
    shared_replay_cycles = sum(service - 1 for service in shared_services)
    mix = Counter(item.kind.value for item in instructions)
    return SassExecutionProfile(
        model_id=spec.model_id,
        trace_sha256=memory.trace_sha256,
        binary_version=schedule.binary_version,
        template_cta=template_cta,
        cta_count=schedule.cta_count,
        grid_shape=schedule.grid,
        num_warps=schedule.num_warps,
        shared_bytes=schedule.shared_bytes,
        registers_per_thread=schedule.registers_per_thread,
        template_cycles=scheduler_cycles,
        template_instruction_count=instruction_count,
        cta_cycles=cta_profile.cycles_by_cta,
        cta_instruction_counts=cta_profile.instruction_counts_by_cta,
        pipeline_instruction_counts=MappingProxyType(dict(sorted(mix.items()))),
        global_sector_requests=sum(item.global_sectors for item in instructions),
        l1_hit_sector_requests=sum(item.l1_hit_sectors for item in instructions),
        l2_sector_requests=sum(item.l2_sectors for item in instructions),
        shared_instruction_count=len(shared_services),
        shared_bank_service_cycles=sum(shared_services),
        shared_bank_replay_cycles=shared_replay_cycles,
        tma_bytes=sum(item.tma_bytes for item in instructions),
        total_global_load_sector_requests=memory.global_load_sector_requests,
        total_global_store_sector_requests=memory.global_store_sector_requests,
        total_unique_global_sectors=memory.unique_global_sectors,
        total_unique_global_load_sectors=memory.unique_global_load_sectors,
        total_unique_global_store_sectors=memory.unique_global_store_sectors,
        memory_sector_bytes=memory.memory_sector_bytes,
        total_tma_load_bytes=memory.tma_load_bytes,
        total_tma_store_bytes=memory.tma_store_bytes,
        total_tma_oob_bytes=memory.tma_oob_bytes,
        global_load_sector_requests_by_cta=memory.global_load_sector_requests_by_cta,
        global_store_sector_requests_by_cta=memory.global_store_sector_requests_by_cta,
        tma_load_bytes_by_cta=memory.tma_load_bytes_by_cta,
        tma_prefetch_load_bytes_by_cta=memory.tma_prefetch_load_bytes_by_cta,
        tma_store_bytes_by_cta=memory.tma_store_bytes_by_cta,
        clc_query_count_by_cta=memory.clc_query_count_by_cta,
        static_sass_sha256=None if control is None else control.source_sha256,
        static_control_pc_count=0 if control is None else len(control.entries),
        provenance=spec.provenance,
        cluster=(
            parse_sass_cluster_metadata(path) if cluster_metadata is None else cluster_metadata
        ),
    )


def _execution_spec(
    binary_version: int,
    execution_spec: SassExecutionSpec | None,
) -> SassExecutionSpec:
    spec = sass_execution_spec(binary_version) if execution_spec is None else execution_spec
    if spec.binary_version != binary_version:
        raise ValueError(
            "injected SASS execution spec does not match trace binary version: "
            f"sm_{spec.binary_version} != sm_{binary_version}"
        )
    return spec


def _spec_for_control_availability(
    spec: SassExecutionSpec,
    control: SassControlSchedule | None,
) -> SassExecutionSpec:
    if control is not None or spec.cta_barrier_missing_control_cycles == 0:
        return spec
    return replace(
        spec,
        cta_barrier_cycles=(spec.cta_barrier_cycles + spec.cta_barrier_missing_control_cycles),
    )


def replay_sass_execution_spec(
    binary_version: int,
    *,
    static_control_available: bool,
    execution_spec: SassExecutionSpec | None = None,
) -> SassExecutionSpec:
    """Return the effective spec used to construct a replayable CTA stream."""

    spec = _execution_spec(binary_version, execution_spec)
    return spec if static_control_available else _spec_for_control_availability(spec, None)


def _cta_profile(
    path: str | Path,
    *,
    grid_shape: tuple[int, int, int],
    spec: SassExecutionSpec,
    control: SassControlSchedule | None,
    cluster_execution: str,
    cluster_shape: tuple[int, int, int],
    stream_observer: (
        Callable[
            [
                int,
                Mapping[int, tuple[ExecutionInstruction, ...]],
                GroupedClusterIdentity,
            ],
            None,
        ]
        | None
    ),
) -> CtaStreamProfile[ExecutionInstruction]:
    callbacks = CtaStreamCallbacks[ExecutionInstruction](
        convert=lambda instruction, sectors: execution_instruction(
            instruction, spec, sectors, control_schedule=control
        ),
        execute=lambda warps: _execute_template(warps, spec),
        is_duplicate=is_tcgen_warpgroup_duplicate,
        normalize=canonicalize_spin_loops,
        observe_streams=stream_observer,
    )
    return profile_cta_streams(
        path,
        grid_shape=grid_shape,
        callbacks=callbacks,
        cluster_execution=cluster_execution,
        cluster_shape=cluster_shape,
    )


def execute_cta_streams(
    warps: Mapping[int, tuple[ExecutionInstruction, ...]],
    spec: SassExecutionSpec,
) -> tuple[int, int]:
    """Execute one timing-bound CTA stream through the SASS dependency engine."""

    if any(
        value is not None
        for value in (
            spec.tma_descriptor_slots_per_sm,
            spec.tma_engine_count_per_sm,
            spec.tmem_columns_per_sm,
        )
    ):
        raise ValueError(
            "finite TMA/TMEM capacities require shared-SM launch replay; "
            "isolated CTA execution cannot represent cross-CTA resource ownership"
        )
    return _execute_template(warps, spec)


def _control_schedule(
    kernel_name: str,
    static_sass_path: str | Path | None,
    spec: SassExecutionSpec,
    *,
    dynamic_sites: Mapping[int, frozenset[str]],
) -> SassControlSchedule | None:
    if not spec.static_control_schedule:
        return None
    if static_sass_path is None:
        return None
    return parse_sass_control_schedule(static_sass_path, kernel_name, dynamic_sites=dynamic_sites)


def _execute_template(
    warps: Mapping[int, tuple[ExecutionInstruction, ...]], spec: SassExecutionSpec
) -> tuple[int, int]:
    states = {warp: WarpState() for warp in warps}
    machine = initial_machine_state(spec, barrier_participants(warps))
    while not _execution_complete(warps, states):
        issued = False
        future_cycles = []
        for scheduler in range(spec.scheduler_count):
            did_issue, ready_cycles = _issue_scheduler(
                scheduler,
                warps=warps,
                states=states,
                machine=machine,
                spec=spec,
            )
            issued = issued or did_issue
            future_cycles.extend(ready_cycles)
        if issued:
            machine.cycle += 1
            continue
        if not future_cycles:
            pending = {
                warp: (
                    states[warp].position,
                    warps[warp][states[warp].position].opcode,
                    warps[warp][states[warp].position].barrier_action,
                    warps[warp][states[warp].position].barrier_wait,
                    states[warp].blocked_barrier,
                )
                for warp in warps
                if states[warp].position < len(warps[warp])
            }
            raise RuntimeError(
                "SASS CTA scheduler stalled without a future completion: "
                f"cycle={machine.cycle}, pending={pending}, "
                f"cta_barrier_arrivals={dict(machine.barrier_arrivals)}, "
                f"mbarriers={machine.mbarriers.debug_snapshot()}"
            )
        machine.cycle = min(future_cycles)
    return _completion_cycle(states, machine), machine.issued


def _issue_scheduler(
    scheduler: int,
    *,
    warps: Mapping[int, tuple[ExecutionInstruction, ...]],
    states: dict[int, WarpState],
    machine: MachineState,
    spec: SassExecutionSpec,
) -> tuple[bool, list[int]]:
    candidates = _scheduler_warps(
        scheduler,
        warps=warps,
        states=states,
        scheduler_count=spec.scheduler_count,
    )
    if not candidates:
        return False, []
    offset = machine.scheduler_round_robin[scheduler] % len(candidates)
    ordered = candidates[offset:] + candidates[:offset]
    future = []
    for warp in ordered:
        instruction = warps[warp][states[warp].position]
        ready = _ready_cycle(
            instruction,
            warp=states[warp],
            scheduler=scheduler,
            machine=machine,
            spec=spec,
        )
        if ready is None:
            continue
        if ready > machine.cycle:
            future.append(ready)
            continue
        issue_instruction(
            instruction,
            warp=states[warp],
            warp_id=warp,
            states=states,
            scheduler=scheduler,
            machine=machine,
            spec=spec,
        )
        machine.scheduler_round_robin[scheduler] = candidates.index(warp) + 1
        return True, future
    return False, future


def _ready_cycle(
    instruction: ExecutionInstruction,
    *,
    warp: WarpState,
    scheduler: int,
    machine: MachineState,
    spec: SassExecutionSpec,
    shared_sm: bool = False,
) -> int | None:
    ready = _scoreboard_ready_cycle(instruction, warp)
    ready = _barrier_action_ready_cycle(
        instruction,
        ready=ready,
        machine=machine,
        spec=spec,
    )
    if ready is None:
        return None
    ready = _async_wait_ready_cycle(
        instruction,
        ready=ready,
        warp=warp,
        machine=machine,
        spec=spec,
    )
    if ready is None:
        return None
    return _resource_ready_cycle(
        instruction,
        ready=ready,
        scheduler=scheduler,
        machine=machine,
        spec=spec,
        shared_sm=shared_sm,
    )


def _scoreboard_ready_cycle(instruction: ExecutionInstruction, warp: WarpState) -> int:
    return max(
        warp.issue_ready,
        max((warp.register_ready.get(reg, 0) for reg in instruction.sources), default=0),
        max(
            (
                warp.dependency_barrier_ready.get(barrier, 0)
                for barrier in instruction.static_wait_barriers
            ),
            default=0,
        ),
    )


def _barrier_action_ready_cycle(
    instruction: ExecutionInstruction,
    *,
    ready: int,
    machine: MachineState,
    spec: SassExecutionSpec,
) -> int | None:
    if spec.functional_mbarrier and instruction.barrier_action is not None:
        action_ready = machine.mbarriers.action_ready_cycle(
            instruction.barrier_action, machine.cycle
        )
        if action_ready is None:
            return None
        return max(ready, action_ready)
    return ready


def _async_wait_ready_cycle(
    instruction: ExecutionInstruction,
    *,
    ready: int,
    warp: WarpState,
    machine: MachineState,
    spec: SassExecutionSpec,
) -> int | None:
    if instruction.opcode.startswith("DEPBAR"):
        ready = max(ready, _group_wait_cycle(warp.async_copy_groups, instruction.immediate))
    if instruction.opcode.startswith("WARPGROUP.DEPBAR"):
        ready = max(ready, _group_wait_cycle(warp.gmma_groups, instruction.immediate))
    if spec.functional_mbarrier and instruction.barrier_wait is not None:
        # A consumer warp can be inspected before the producer warp has issued
        # the CTA-wide mbarrier initialization. This is a scheduling stall; an
        # actually missing initializer is still exposed as a replay deadlock.
        if not machine.mbarriers.has_state(instruction.barrier_wait.address):
            return None
        target_generation = mbarrier_wait_target(instruction.barrier_wait, warp)
        barrier_ready = machine.mbarriers.wait_generation_cycle(
            instruction.barrier_wait, target_generation, machine.cycle
        )
        if barrier_ready is None:
            return None
        ready = max(ready, barrier_ready)
    elif is_blocking_tma_wait(instruction.opcode):
        ready = max(ready, machine.tma_completion)
    return ready


def _resource_ready_cycle(
    instruction: ExecutionInstruction,
    *,
    ready: int,
    scheduler: int,
    machine: MachineState,
    spec: SassExecutionSpec,
    shared_sm: bool = False,
) -> int | None:
    if not shared_sm:
        ready = max(ready, machine.pipeline_available[(scheduler, instruction.kind)])
    if instruction.shared_service_cycles:
        ready = max(ready, machine.shared_memory_available)
    if instruction.tma_bytes or instruction.tma_oob_bytes:
        ready = max(ready, machine.tma_available)
    if instruction.opcode.startswith("UGETNEXTWORKID"):
        ready = max(ready, machine.clc_available)
    async_ready = async_resource_ready_cycle(instruction, machine=machine, spec=spec)
    if async_ready is None:
        return None
    ready = max(ready, async_ready)
    return ready


def _completion_cycle(states: Mapping[int, WarpState], machine: MachineState) -> int:
    warp_ready = [_warp_completion_cycle(state) for state in states.values()]
    return max(
        machine.cycle,
        machine.memory_queue_available,
        machine.memory_completion,
        machine.shared_memory_available,
        machine.tma_completion,
        machine.tcgen_completion,
        machine.clc_completion,
        machine.mbarriers.latest_event_cycle(),
        *machine.pipeline_available.values(),
        *warp_ready,
    )


def _warp_completion_cycle(warp: WarpState) -> int:
    return max(
        max(warp.register_ready.values(), default=0),
        max(warp.open_async_copy_ready, *warp.async_copy_groups, 0),
        max(warp.open_gmma_ready, *warp.gmma_groups, 0),
    )


def _group_wait_cycle(groups: list[int], keep_groups: int) -> int:
    if keep_groups < 0:
        raise ValueError("wait-group count must be non-negative")
    wait_count = max(0, len(groups) - keep_groups)
    return max(groups[:wait_count], default=0)


def _execution_complete(
    warps: Mapping[int, tuple[ExecutionInstruction, ...]], states: Mapping[int, WarpState]
) -> bool:
    return all(state.position >= len(warps[warp]) for warp, state in states.items())


def _scheduler_warps(
    scheduler: int,
    *,
    warps: Mapping[int, tuple[ExecutionInstruction, ...]],
    states: Mapping[int, WarpState],
    scheduler_count: int,
) -> list[int]:
    return sorted(
        warp
        for warp, stream in warps.items()
        if warp % scheduler_count == scheduler
        and states[warp].position < len(stream)
        and states[warp].blocked_barrier is None
    )
