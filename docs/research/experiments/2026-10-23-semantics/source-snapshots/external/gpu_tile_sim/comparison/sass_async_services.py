"""Asynchronous completion events shared by the compact SASS executor."""

from __future__ import annotations

from math import ceil

from gpu_tile_sim.comparison.sass_execution_instruction import ExecutionInstruction
from gpu_tile_sim.comparison.sass_execution_state import MachineState, WarpState
from gpu_tile_sim.comparison.sass_mbarrier import BarrierWait
from gpu_tile_sim.hardware.sass_spec import SassExecutionSpec

TMEM_ALLOC_PREFIXES = ("UTCATOMSWS.FIND_AND_SET", "TCGEN05.ALLOC")
TMEM_FREE_PREFIXES = ("UTCATOMSWS.AND", "TCGEN05.DEALLOC")


def _tmem_columns(instruction: ExecutionInstruction) -> int:
    columns = instruction.tmem_columns
    if isinstance(columns, bool) or not isinstance(columns, int) or columns <= 0:
        raise ValueError(
            f"exact TMEM capacity replay requires a verified columns footprint for "
            f"{instruction.opcode}; load a trace/SASS SHA-bound footprint manifest"
        )
    return columns


def async_resource_ready_cycle(
    instruction: ExecutionInstruction,
    *,
    machine: MachineState,
    spec: SassExecutionSpec,
) -> int | None:
    """Probe shared credits at the actual clock, without future reservations."""

    resources = machine.shared_async_resources
    if resources is None:
        return machine.cycle
    if instruction.tma_bytes or instruction.tma_oob_bytes:
        return resources.tma.ready_cycle(machine.cycle)
    if instruction.opcode.startswith(TMEM_ALLOC_PREFIXES) and resources.tmem.enabled:
        return resources.tmem.ready_cycle(
            machine.resource_owner, _tmem_columns(instruction), machine.cycle
        )
    if instruction.opcode.startswith(TMEM_FREE_PREFIXES) and resources.tmem.enabled:
        _tmem_columns(instruction)
    return machine.cycle


def schedule_tmem_lifecycle(
    instruction: ExecutionInstruction,
    *,
    machine: MachineState,
    issue_cycle: int,
    completion: int,
    spec: SassExecutionSpec,
) -> None:
    """Reserve columns at allocation issue, and return them after free completes."""

    resources = machine.shared_async_resources
    if resources is None or not resources.tmem.enabled:
        return
    if instruction.opcode.startswith(TMEM_ALLOC_PREFIXES):
        resources.tmem.allocate(
            machine.resource_owner, _tmem_columns(instruction), issue_cycle
        )
    elif instruction.opcode.startswith(TMEM_FREE_PREFIXES):
        resources.tmem.free(
            machine.resource_owner,
            _tmem_columns(instruction),
            issue_cycle=issue_cycle,
            completion_cycle=completion,
        )


def schedule_tma_transfer(
    instruction: ExecutionInstruction,
    *,
    machine: MachineState,
    issue_cycle: int,
    spec: SassExecutionSpec,
    memory_completion_cycle: int | None = None,
    tma_resource_ticket: int | None = None,
    tma_resources_pre_reserved: bool = False,
) -> int:
    """Reserve TMA initiation and completion-held shared descriptor/engine credits."""

    if spec.tma_setup_cycles <= 0:
        raise ValueError(f"{spec.model_id} does not support TMA instructions")
    if tma_resource_ticket is not None and not tma_resources_pre_reserved:
        raise ValueError("TMA reservation ticket requires pre-reserved resource mode")
    if tma_resources_pre_reserved and machine.shared_async_resources is None:
        raise ValueError("pre-reserved TMA completion requires the admitting shared SM pool")
    tensor_bytes = instruction.tma_bytes + instruction.tma_oob_bytes
    payload_cycles = ceil(tensor_bytes / spec.tma_bytes_per_cycle)
    service_cycles = spec.tma_setup_cycles + payload_cycles
    # TMA completion includes the dependent cache-service return path on every
    # architecture.  Functional mbarrier replay controls how completion is
    # observed; it must not remove the physical L2 service itself.
    if memory_completion_cycle is None:
        service_cycles += spec.dependent_l2_latency_cycles
        completion = issue_cycle + service_cycles
    else:
        # The coupled hierarchy supplies its own return latency.  TMA engine
        # service overlaps that path rather than charging the L2 return twice.
        completion = max(issue_cycle + service_cycles, memory_completion_cycle)
    if machine.shared_async_resources is not None:
        if tma_resources_pre_reserved:
            machine.shared_async_resources.tma.finish_tma(
                tma_resource_ticket,
                completion_cycle=completion,
                observation_cycle=machine.cycle,
            )
        elif machine.shared_async_resources.tma.enabled and issue_cycle != machine.cycle:
            raise ValueError(
                "finite TMA capacity requires admission at the actual machine cycle; "
                "deferred memory issue must be scheduled as a future execution event"
            )
        else:
            machine.shared_async_resources.tma.reserve(
                machine.resource_owner,
                issue_cycle=issue_cycle,
                completion_cycle=completion,
                engine_completion_cycle=issue_cycle + spec.tma_setup_cycles + payload_cycles,
            )
    machine.tma_available = max(machine.tma_available, issue_cycle + spec.tma_initiation_cycles)
    machine.tma_completion = max(machine.tma_completion, completion)
    if spec.functional_mbarrier:
        schedule_tma_completion(instruction, machine=machine, completion=completion)
    return completion


def mbarrier_wait_target(wait: BarrierWait, warp: WarpState) -> int:
    previous = warp.mbarrier_wait_target.get(wait.address)
    if previous is None:
        target = 0 if wait.phase else 1
    elif previous[0] == wait.phase:
        target = previous[1]
    else:
        target = previous[1] + 1
    warp.mbarrier_wait_target[wait.address] = (wait.phase, target)
    return target


def apply_barrier_action(
    instruction: ExecutionInstruction,
    *,
    machine: MachineState,
    issue_cycle: int,
) -> None:
    action = instruction.barrier_action
    if action is not None:
        machine.mbarriers.apply(action, issue_cycle)


def schedule_tma_completion(
    instruction: ExecutionInstruction,
    *,
    machine: MachineState,
    completion: int,
) -> None:
    address = instruction.tma_mbarrier_address
    if address is None or address == 0:
        return
    if instruction.tma_mbarrier_transaction_bytes > 0:
        machine.mbarriers.schedule_completion(
            address,
            cycle=completion,
            transaction_bytes=instruction.tma_mbarrier_transaction_bytes,
        )


def schedule_tcgen_commit(
    instruction: ExecutionInstruction,
    *,
    machine: MachineState,
    completion: int,
) -> None:
    event_cycle = max(completion, machine.tcgen_completion)
    for address in instruction.async_barrier_addresses:
        if machine.mbarriers.has_state(address):
            machine.mbarriers.schedule_completion(
                address,
                cycle=event_cycle,
                arrivals=instruction.async_barrier_arrivals,
            )
    machine.tcgen_completion = 0


def schedule_clc_response(
    instruction: ExecutionInstruction,
    *,
    machine: MachineState,
    issue_cycle: int,
    spec: SassExecutionSpec,
) -> int:
    completion = issue_cycle + spec.clc_response_cycles
    machine.clc_available = issue_cycle + spec.clc_initiation_cycles
    machine.clc_completion = max(machine.clc_completion, completion)
    for address in instruction.async_barrier_addresses:
        if machine.mbarriers.has_state(address):
            machine.mbarriers.schedule_completion(
                address,
                cycle=completion,
                transaction_bytes=spec.clc_response_bytes,
            )
    return completion
