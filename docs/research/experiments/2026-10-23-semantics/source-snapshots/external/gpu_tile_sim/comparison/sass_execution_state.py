"""Mutable state containers for one compact per-CTA SASS replay."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from gpu_tile_sim.comparison.sass_mbarrier import MBarrierTracker
from gpu_tile_sim.hardware.sass_spec import PipelineKind, SassExecutionSpec

if TYPE_CHECKING:
    from gpu_tile_sim.backend.sass_sm_resources import SharedSmAsyncResources
    from gpu_tile_sim.comparison.sass_execution_instruction import ExecutionInstruction


@dataclass(slots=True)
class WarpState:
    position: int = 0
    issue_ready: int = 0
    register_ready: dict[str, int] = field(default_factory=dict)
    open_async_copy_ready: int = 0
    async_copy_groups: list[int] = field(default_factory=list)
    open_gmma_ready: int = 0
    gmma_groups: list[int] = field(default_factory=list)
    barrier_occurrences: dict[int, int] = field(default_factory=dict)
    blocked_barrier: tuple[int, int] | None = None
    mbarrier_wait_target: dict[int, tuple[int, int]] = field(default_factory=dict)
    dependency_barrier_ready: dict[int, int] = field(default_factory=dict)


@dataclass(slots=True)
class MachineState:
    cycle: int
    memory_queue_available: int
    memory_completion: int
    shared_memory_available: int
    tma_available: int
    tma_completion: int
    tcgen_completion: int
    clc_available: int
    clc_completion: int
    issued: int
    scheduler_round_robin: list[int]
    pipeline_available: dict[tuple[int, PipelineKind], int]
    barrier_participants: Mapping[tuple[int, int], frozenset[int]]
    barrier_arrivals: dict[tuple[int, int], dict[int, int]]
    mbarriers: MBarrierTracker
    shared_async_resources: SharedSmAsyncResources | None = None
    resource_owner: int = 0


def initial_machine_state(
    spec: SassExecutionSpec,
    barrier_participants: Mapping[tuple[int, int], frozenset[int]],
) -> MachineState:
    return MachineState(
        cycle=0,
        memory_queue_available=0,
        memory_completion=0,
        shared_memory_available=0,
        tma_available=0,
        tma_completion=0,
        tcgen_completion=0,
        clc_available=0,
        clc_completion=0,
        issued=0,
        scheduler_round_robin=[0] * spec.scheduler_count,
        pipeline_available=defaultdict(int),
        barrier_participants=barrier_participants,
        barrier_arrivals=defaultdict(dict),
        mbarriers=MBarrierTracker(),
    )


def barrier_participants(
    warps: Mapping[int, tuple[ExecutionInstruction, ...]],
) -> Mapping[tuple[int, int], frozenset[int]]:
    """Recover the participating warps for every CTA barrier generation."""

    participants: dict[tuple[int, int], set[int]] = defaultdict(set)
    for warp_id, stream in warps.items():
        generations: dict[int, int] = defaultdict(int)
        for instruction in stream:
            if not instruction.opcode.startswith("BAR.SYNC"):
                continue
            barrier_id = instruction.immediate
            key = (barrier_id, generations[barrier_id])
            participants[key].add(warp_id)
            generations[barrier_id] += 1
    return {key: frozenset(warp_ids) for key, warp_ids in participants.items()}
