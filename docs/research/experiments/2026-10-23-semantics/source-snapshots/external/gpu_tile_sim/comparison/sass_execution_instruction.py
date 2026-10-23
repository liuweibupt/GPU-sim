"""Convert traced SASS into the compact execution-engine instruction contract."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from gpu_tile_sim.comparison.sass_instruction_model import (
    expanded_destinations,
    global_sectors,
    instruction_timing,
    pipeline_kind,
    shared_bank_service,
)
from gpu_tile_sim.comparison.sass_mbarrier import (
    BarrierAction,
    BarrierWait,
    barrier_action,
    barrier_wait,
    unique_memory_addresses,
)
from gpu_tile_sim.comparison.sass_trace import _coalesced_sectors
from gpu_tile_sim.comparison.sass_trace_payload import SassInstruction
from gpu_tile_sim.hardware.sass_spec import PipelineKind, SassExecutionSpec

if TYPE_CHECKING:
    from gpu_tile_sim.comparison.sass_control import SassControlSchedule, StaticControlEntry


@dataclass(frozen=True, slots=True)
class ExecutionInstruction:
    opcode: str
    destinations: tuple[str, ...]
    sources: tuple[str, ...]
    kind: PipelineKind
    latency_cycles: int
    initiation_cycles: int
    global_sectors: int
    l1_hit_sectors: int
    l2_sectors: int
    shared_service_cycles: int
    tma_bytes: int
    gmma_commit_group: bool
    immediate: int
    barrier_action: BarrierAction | None
    barrier_wait: BarrierWait | None
    async_barrier_addresses: tuple[int, ...]
    tma_mbarrier_address: int | None
    tma_oob_bytes: int
    static_issue_delay_cycles: int | None
    static_wait_barriers: tuple[int, ...]
    static_read_barrier: int | None
    static_write_barrier: int | None
    tma_mbarrier_transaction_bytes: int = 0
    async_barrier_arrivals: int = 1
    memory_sector_addresses: tuple[int, ...] = ()
    tmem_columns: int | None = None
    pc: int | None = None


def execution_instruction(
    instruction: SassInstruction,
    spec: SassExecutionSpec,
    resident_global_sectors: set[int],
    *,
    control_schedule: SassControlSchedule | None = None,
) -> ExecutionInstruction:
    kind = pipeline_kind(instruction.opcode)
    sectors = global_sectors(instruction, spec.global_sector_bytes)
    cacheable_load = instruction.opcode.startswith(("LDG", "LD."))
    hit_sectors = sectors & resident_global_sectors if cacheable_load else frozenset()
    missing_sectors = sectors - hit_sectors
    if cacheable_load:
        resident_global_sectors.update(sectors)
    timing = instruction_timing(
        instruction,
        kind,
        spec,
        global_l1_hit=bool(sectors) and not missing_sectors,
    )
    control = _static_control(instruction, control_schedule)
    return ExecutionInstruction(
        opcode=instruction.opcode,
        destinations=expanded_destinations(instruction),
        sources=instruction.sources,
        kind=kind,
        latency_cycles=timing.latency_cycles,
        initiation_cycles=timing.initiation_cycles,
        global_sectors=len(sectors),
        l1_hit_sectors=len(hit_sectors),
        l2_sectors=len(missing_sectors),
        shared_service_cycles=shared_bank_service(instruction, spec),
        tma_bytes=instruction.tma_byte_count,
        gmma_commit_group=instruction.gmma_commit_group,
        immediate=instruction.immediate,
        barrier_action=barrier_action(instruction),
        barrier_wait=barrier_wait(instruction),
        async_barrier_addresses=unique_memory_addresses(instruction),
        tma_mbarrier_address=instruction.tma_mbarrier_address,
        tma_oob_bytes=instruction.tma_oob_byte_count,
        static_issue_delay_cycles=None if control is None else control.issue_delay_cycles,
        static_wait_barriers=() if control is None else control.wait_barriers,
        static_read_barrier=None if control is None else control.read_barrier,
        static_write_barrier=None if control is None else control.write_barrier,
        tma_mbarrier_transaction_bytes=_tma_mbarrier_transaction_bytes(instruction),
        async_barrier_arrivals=_async_barrier_arrivals(instruction),
        memory_sector_addresses=tuple(
            sector * spec.global_sector_bytes
            for sector in _coalesced_sectors(instruction, spec.global_sector_bytes)
        ),
        tmem_columns=instruction.tmem_columns,
        pc=instruction.pc,
    )


def _tma_mbarrier_transaction_bytes(instruction: SassInstruction) -> int:
    copies = 1
    if instruction.tma_multicast_mask is not None:
        copies = instruction.tma_multicast_mask.bit_count()
    return copies * (instruction.tma_byte_count + instruction.tma_oob_byte_count)


def _async_barrier_arrivals(instruction: SassInstruction) -> int:
    if not instruction.opcode.startswith("UTCBAR.MULTICAST"):
        return 1
    if len(instruction.source_values) < 3 or not instruction.source_values[2]:
        raise ValueError("UTCBAR.MULTICAST requires a traced cluster mask")
    arrivals = int(instruction.source_values[2][0]).bit_count()
    if arrivals <= 0:
        raise ValueError("UTCBAR.MULTICAST cluster mask must not be empty")
    return arrivals


def _static_control(
    instruction: SassInstruction, control_schedule: SassControlSchedule | None
) -> StaticControlEntry | None:
    if control_schedule is None:
        return None
    return control_schedule.entry(instruction.pc, instruction.opcode)


def is_tcgen_warpgroup_duplicate(
    instruction: SassInstruction, previous: SassInstruction | None
) -> bool:
    """Collapse the duplicate callback emitted for one Blackwell TCGEN instruction."""

    return instruction.opcode.startswith("UTCHMMA") and instruction == previous
