"""Issue-side state transitions for one compact SASS CTA replay."""

from __future__ import annotations

from collections.abc import Mapping
from math import ceil

from gpu_tile_sim.comparison.sass_async_services import (
    apply_barrier_action,
    schedule_clc_response,
    schedule_tcgen_commit,
    schedule_tma_transfer,
    schedule_tmem_lifecycle,
)
from gpu_tile_sim.comparison.sass_execution_instruction import ExecutionInstruction
from gpu_tile_sim.comparison.sass_execution_state import MachineState, WarpState
from gpu_tile_sim.hardware.sass_spec import PipelineKind, SassExecutionSpec

ASYNC_COPY_PREFIXES = ("LDGSTS", "CPASYNC")
WARP_SERIALIZING_CONTROL_PREFIXES = (
    "BRA",
    "BRX",
    "BREAK",
    "BSSY",
    "BSYNC",
    "CALL",
    "RET",
    "YIELD",
)


def issue_instruction(
    instruction: ExecutionInstruction,
    *,
    warp: WarpState,
    warp_id: int,
    states: Mapping[int, WarpState],
    scheduler: int,
    machine: MachineState,
    spec: SassExecutionSpec,
    memory_completion_cycle: int | None = None,
    memory_issue_cycle: int | None = None,
    tma_resource_ticket: int | None = None,
    tma_resources_pre_reserved: bool = False,
) -> None:
    """Issue one ready instruction and publish all resulting completion state."""

    issue_cycle = machine.cycle
    if spec.functional_mbarrier:
        apply_barrier_action(instruction, machine=machine, issue_cycle=issue_cycle)
    completion = _instruction_service_completion(
        instruction,
        warp=warp,
        machine=machine,
        spec=spec,
        memory_completion_cycle=memory_completion_cycle,
        memory_issue_cycle=memory_issue_cycle,
        tma_resource_ticket=tma_resource_ticket,
        tma_resources_pre_reserved=tma_resources_pre_reserved,
    )
    completion = _record_architecture_async_state(
        instruction,
        machine=machine,
        issue_cycle=issue_cycle,
        completion=completion,
        spec=spec,
    )
    _record_async_groups(instruction, warp=warp, completion=completion)
    _record_warp_constraints(instruction, warp=warp, completion=completion)
    _publish_static_dependencies(
        instruction,
        warp=warp,
        issue_cycle=issue_cycle,
        completion=completion,
    )
    for destination in instruction.destinations:
        warp.register_ready[destination] = completion
    _reserve_instruction_pipeline(
        instruction,
        scheduler=scheduler,
        issue_cycle=issue_cycle,
        machine=machine,
    )
    if instruction.opcode.startswith("BAR.SYNC"):
        _arrive_cta_barrier(
            instruction,
            warp=warp,
            warp_id=warp_id,
            states=states,
            machine=machine,
            completion=completion,
            spec=spec,
        )
    warp.position += 1
    machine.issued += 1


def _instruction_service_completion(
    instruction: ExecutionInstruction,
    *,
    warp: WarpState,
    machine: MachineState,
    spec: SassExecutionSpec,
    memory_completion_cycle: int | None = None,
    memory_issue_cycle: int | None = None,
    tma_resource_ticket: int | None = None,
    tma_resources_pre_reserved: bool = False,
) -> int:
    issue_cycle = machine.cycle
    completion = issue_cycle + instruction.latency_cycles
    if memory_completion_cycle is not None:
        completion = max(issue_cycle, memory_completion_cycle)
        machine.memory_completion = max(machine.memory_completion, completion)
        if instruction.tma_bytes or instruction.tma_oob_bytes:
            completion = schedule_tma_transfer(
                instruction,
                machine=machine,
                issue_cycle=issue_cycle if memory_issue_cycle is None else memory_issue_cycle,
                spec=spec,
                memory_completion_cycle=completion,
                tma_resource_ticket=tma_resource_ticket,
                tma_resources_pre_reserved=tma_resources_pre_reserved,
            )
        return completion
    if instruction.global_sectors:
        service = ceil(instruction.global_sectors / spec.l1tex_sector_throughput_per_cycle)
        queue_start = max(issue_cycle, machine.memory_queue_available)
        machine.memory_queue_available = queue_start + service
        completion = machine.memory_queue_available + instruction.latency_cycles
        machine.memory_completion = max(machine.memory_completion, completion)
    if instruction.shared_service_cycles:
        machine.shared_memory_available = issue_cycle + instruction.shared_service_cycles
        warp.issue_ready = machine.shared_memory_available
        completion = machine.shared_memory_available + instruction.latency_cycles
    if instruction.tma_bytes or instruction.tma_oob_bytes:
        completion = schedule_tma_transfer(
            instruction,
            machine=machine,
            issue_cycle=issue_cycle,
            spec=spec,
        )
    return completion


def _record_architecture_async_state(
    instruction: ExecutionInstruction,
    *,
    machine: MachineState,
    issue_cycle: int,
    completion: int,
    spec: SassExecutionSpec,
) -> int:
    schedule_tmem_lifecycle(
        instruction, machine=machine, issue_cycle=issue_cycle, completion=completion, spec=spec
    )
    if instruction.kind is PipelineKind.TCGEN:
        machine.tcgen_completion = max(machine.tcgen_completion, completion)
    if spec.functional_mbarrier and instruction.opcode.startswith("UTCBAR"):
        schedule_tcgen_commit(instruction, machine=machine, completion=completion)
    if spec.clc_response_cycles > 0 and instruction.opcode.startswith("UGETNEXTWORKID"):
        completion = max(
            completion,
            schedule_clc_response(
                instruction,
                machine=machine,
                issue_cycle=issue_cycle,
                spec=spec,
            ),
        )
    return completion


def _record_async_groups(
    instruction: ExecutionInstruction, *, warp: WarpState, completion: int
) -> None:
    if instruction.opcode.startswith(ASYNC_COPY_PREFIXES):
        warp.open_async_copy_ready = max(warp.open_async_copy_ready, completion)
    if instruction.opcode.startswith("LDGDEPBAR"):
        warp.async_copy_groups.append(warp.open_async_copy_ready)
        warp.open_async_copy_ready = 0
    if instruction.opcode.startswith("DEPBAR"):
        _retire_groups(warp.async_copy_groups, instruction.immediate)
    if instruction.kind is PipelineKind.GMMA:
        warp.open_gmma_ready = max(warp.open_gmma_ready, completion)
        if instruction.gmma_commit_group:
            warp.gmma_groups.append(warp.open_gmma_ready)
            warp.open_gmma_ready = 0
    if instruction.opcode.startswith("WARPGROUP.DEPBAR"):
        _retire_groups(warp.gmma_groups, instruction.immediate)


def _record_warp_constraints(
    instruction: ExecutionInstruction, *, warp: WarpState, completion: int
) -> None:
    if instruction.opcode.startswith("UTCATOMSWS"):
        warp.issue_ready = max(warp.issue_ready, completion)
    if instruction.opcode.startswith(WARP_SERIALIZING_CONTROL_PREFIXES):
        warp.issue_ready = max(warp.issue_ready, completion)


def _publish_static_dependencies(
    instruction: ExecutionInstruction,
    *,
    warp: WarpState,
    issue_cycle: int,
    completion: int,
) -> None:
    if instruction.static_issue_delay_cycles is not None:
        warp.issue_ready = max(
            warp.issue_ready, issue_cycle + instruction.static_issue_delay_cycles
        )
    if instruction.static_read_barrier is not None:
        barrier = instruction.static_read_barrier
        warp.dependency_barrier_ready[barrier] = max(
            warp.dependency_barrier_ready.get(barrier, 0), issue_cycle + 1
        )
    if instruction.static_write_barrier is not None:
        barrier = instruction.static_write_barrier
        warp.dependency_barrier_ready[barrier] = max(
            warp.dependency_barrier_ready.get(barrier, 0), completion
        )


def _reserve_instruction_pipeline(
    instruction: ExecutionInstruction,
    *,
    scheduler: int,
    issue_cycle: int,
    machine: MachineState,
) -> None:
    initiation = instruction.initiation_cycles
    if instruction.shared_service_cycles:
        initiation = max(initiation, instruction.shared_service_cycles)
    machine.pipeline_available[(scheduler, instruction.kind)] = issue_cycle + initiation


def _arrive_cta_barrier(
    instruction: ExecutionInstruction,
    *,
    warp: WarpState,
    warp_id: int,
    states: Mapping[int, WarpState],
    machine: MachineState,
    completion: int,
    spec: SassExecutionSpec,
) -> None:
    barrier_id = instruction.immediate
    generation = warp.barrier_occurrences.get(barrier_id, 0)
    key = (barrier_id, generation)
    participants = machine.barrier_participants[key]
    arrivals = machine.barrier_arrivals[key]
    arrivals[warp_id] = max(
        completion,
        warp.issue_ready,
        max(warp.register_ready.values(), default=0),
    )
    warp.barrier_occurrences[barrier_id] = generation + 1
    warp.blocked_barrier = key
    if arrivals.keys() != participants:
        return
    release_cycle = max(arrivals.values()) + spec.cta_barrier_cycles
    for participant in participants:
        state = states[participant]
        state.blocked_barrier = None
        state.issue_ready = max(state.issue_ready, release_cycle)


def _retire_groups(groups: list[int], keep_groups: int) -> None:
    if keep_groups == 0:
        groups.clear()
        return
    groups[:] = groups[-keep_groups:]
