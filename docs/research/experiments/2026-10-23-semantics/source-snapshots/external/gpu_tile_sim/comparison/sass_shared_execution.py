"""Execute complete co-resident CTA programs against shared physical SM state."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from heapq import heappop, heappush

from gpu_tile_sim.backend.cluster_scheduler import ClusterDispatcher, ThreadBlockClusterLaunch
from gpu_tile_sim.backend.sass_partition_scheduler import PartitionExecutionPlan
from gpu_tile_sim.backend.sass_sm_resources import SharedSmAsyncResources
from gpu_tile_sim.backend.sass_sm_scheduler import SmIssueArbiter
from gpu_tile_sim.comparison.sass_execution import (
    _completion_cycle,
    _execution_complete,
    _ready_cycle,
)
from gpu_tile_sim.comparison.sass_execution_instruction import ExecutionInstruction
from gpu_tile_sim.comparison.sass_execution_issue import issue_instruction
from gpu_tile_sim.comparison.sass_execution_state import (
    MachineState,
    WarpState,
    barrier_participants,
    initial_machine_state,
)
from gpu_tile_sim.hardware.gpu_config import GPUConfig
from gpu_tile_sim.hardware.sass_spec import SassExecutionSpec

WarpProgram = Mapping[int, tuple[ExecutionInstruction, ...]]


@dataclass(slots=True)
class _ResidentCta:
    sm: int
    group: int
    machine: MachineState
    states: dict[int, WarpState]
    finishing: bool = False


def execute_shared_sass_launch(
    programs: Sequence[WarpProgram],
    config: GPUConfig,
    spec: SassExecutionSpec,
    residency: int,
    *,
    base_cycle: int = 0,
    launch: ThreadBlockClusterLaunch | None = None,
    warps_per_cta: int | None = None,
) -> PartitionExecutionPlan:
    """Replay all warp dependencies, issue arbitration, and actual CTA releases.

    A cluster is admitted together into one GPC and retains its placement slots
    until every rank finishes, matching the existing cluster lifetime contract.
    Every rank executes its own program; synchronization remains CTA-local.
    The caller must reject unsupported cross-rank synchronization evidence.
    """

    if not programs:
        raise ValueError("shared SM execution requires at least one CTA program")
    if base_cycle < 0:
        raise ValueError("shared SM execution base cycle must be nonnegative")
    if warps_per_cta is not None and (
        type(warps_per_cta) is not int
        or warps_per_cta <= 0
        or any(not 0 <= warp < warps_per_cta for program in programs for warp in program)
    ):
        raise ValueError("program warp IDs exceed the physical CTA warp allocation")
    launch = ThreadBlockClusterLaunch() if launch is None else launch
    dispatcher = ClusterDispatcher(config, len(programs), residency, launch)
    topology = config.gpc_topology
    partitions = topology.partition_count if topology else 1
    active_sms = topology.active_sms_per_partition if topology else (config.sm_count,)
    arbiters = [SmIssueArbiter(spec) for _ in range(config.sm_count)]
    async_resources = [SharedSmAsyncResources.from_spec(spec) for _ in arbiters]
    occupants = [0] * config.sm_count
    starts = [-1] * len(programs)
    finishes = [-1] * len(programs)
    partition_by_cta = [-1] * len(programs)
    cta_counts = [0] * partitions
    cluster_counts = [0] * partitions
    active: dict[int, _ResidentCta] = {}
    group_members: dict[int, list[int]] = {}
    finished_groups: dict[int, set[int]] = {}
    ready_to_release: list[tuple[int, int]] = []
    cursors: dict[tuple[int, int], tuple[int, int]] = {}
    cycle = base_cycle
    next_cta = 0
    events = 0
    while active or next_cta < len(programs):
        events += 1
        while ready_to_release and ready_to_release[0][0] <= cycle:
            completion, cta_id = heappop(ready_to_release)
            cta = active[cta_id]
            async_resources[cta.sm].tmem.validate_owner_released(cta_id, cycle)
            finishes[cta_id] = completion - base_cycle
            finished_groups[cta.group].add(cta_id)
            if len(finished_groups[cta.group]) == len(group_members[cta.group]):
                for member in group_members.pop(cta.group):
                    resident = active.pop(member)
                    occupants[resident.sm] -= 1
                    arbiters[resident.sm].release_cta(member)
                del finished_groups[cta.group]
        while next_cta < len(programs):
            assignments = dispatcher.next_tb_assignments(next_cta, occupants)
            if assignments is None:
                break
            group = next_cta // launch.cta_count
            group_members[group] = [cta for cta, _ in assignments]
            finished_groups[group] = set()
            partition = topology.partition_for_sm(assignments[0][1]) if topology else 0
            if launch.cta_count > 1:
                cluster_counts[partition] += 1
            for cta_id, sm in assignments:
                program = programs[cta_id]
                machine = initial_machine_state(spec, barrier_participants(program))
                machine.cycle = cycle
                machine.shared_async_resources = async_resources[sm]
                machine.resource_owner = cta_id
                active[cta_id] = _ResidentCta(
                    sm, group, machine, {warp: WarpState() for warp in program}
                )
                arbiters[sm].register_cta(
                    cta_id, program if warps_per_cta is None else range(warps_per_cta)
                )
                occupants[sm] += 1
                starts[cta_id] = cycle - base_cycle
                partition_by_cta[cta_id] = partition
                cta_counts[partition] += 1
            next_cta += launch.cta_count
        issued = False
        future: list[int] = []
        residents_by_sm: dict[int, list[int]] = {}
        for cta_id, cta in active.items():
            cta.machine.cycle = cycle
            if not cta.finishing:
                residents_by_sm.setdefault(cta.sm, []).append(cta_id)
        for sm, residents in residents_by_sm.items():
            arbiter = arbiters[sm]
            for scheduler in range(spec.scheduler_count):
                for _ in range(spec.scheduler_issue_width):
                    candidates = sorted(
                        (cta_id, warp_id)
                        for cta_id in residents
                        for warp_id, state in active[cta_id].states.items()
                        if state.position < len(programs[cta_id][warp_id])
                        and state.blocked_barrier is None
                        and arbiter.scheduler_for(cta_id, warp_id) == scheduler
                    )
                    cursor = cursors.get((sm, scheduler), (-1, -1))
                    ordered = [key for key in candidates if key > cursor]
                    ordered.extend(key for key in candidates if key <= cursor)
                    accepted = False
                    for cta_id, warp_id in ordered:
                        cta = active[cta_id]
                        state = cta.states[warp_id]
                        instruction = programs[cta_id][warp_id][state.position]
                        ready = _ready_cycle(
                            instruction,
                            warp=state,
                            scheduler=scheduler,
                            machine=cta.machine,
                            spec=spec,
                            shared_sm=True,
                        )
                        if ready is None:
                            continue
                        ready = max(
                            ready,
                            arbiter.ready_cycle(
                                instruction, scheduler=scheduler, cycle=cycle, owner=cta_id
                            ),
                        )
                        if ready > cycle:
                            future.append(ready)
                            continue
                        arbiter.prepare_machine(cta.machine, instruction)
                        issue_instruction(
                            instruction,
                            warp=state,
                            warp_id=warp_id,
                            states=cta.states,
                            scheduler=scheduler,
                            machine=cta.machine,
                            spec=spec,
                        )
                        arbiter.reserve(
                            instruction,
                            scheduler=scheduler,
                            cycle=cycle,
                            machine=cta.machine,
                        )
                        cursors[(sm, scheduler)] = (cta_id, warp_id)
                        accepted = issued = True
                        break
                    if not accepted:
                        break
        for cta_id, cta in active.items():
            if not cta.finishing and _execution_complete(programs[cta_id], cta.states):
                completion = max(cycle + 1, _completion_cycle(cta.states, cta.machine))
                cta.finishing = True
                heappush(ready_to_release, (completion, cta_id))
        if ready_to_release:
            future.append(ready_to_release[0][0])
        for resources in async_resources:
            completion = resources.next_completion_cycle(cycle)
            if completion is not None and completion > cycle:
                future.append(completion)
        if issued:
            cycle += 1
        elif future:
            cycle = min(value for value in future if value > cycle)
        elif active or next_cta < len(programs):
            pending = {
                cta_id: {
                    warp: programs[cta_id][warp][state.position].opcode
                    for warp, state in cta.states.items()
                    if state.position < len(programs[cta_id][warp])
                }
                for cta_id, cta in active.items()
                if not cta.finishing
            }
            raise RuntimeError(f"shared SASS SM scheduler deadlocked at {cycle}: {pending}")
    completion_by_partition = tuple(
        max(
            (finish for finish, part in zip(finishes, partition_by_cta, strict=True) if part == p),
            default=0,
        )
        for p in range(partitions)
    )
    return PartitionExecutionPlan(
        total_cycles=max(completion_by_partition),
        completion_cycles_per_partition=completion_by_partition,
        cta_count_per_partition=tuple(cta_counts),
        cluster_count_per_partition=tuple(cluster_counts),
        active_sms_per_partition=active_sms,
        partition_by_cta=tuple(partition_by_cta),
        start_cycles_by_cta=tuple(starts),
        completion_cycles_by_cta=tuple(finishes),
        memory_replay_statistics={
            "model_id": "sass-shared-sm-v1",
            "event_iterations": events,
            "instructions_issued": sum(arbiter.issued for arbiter in arbiters),
            "scheduler_count_per_sm": spec.scheduler_count,
            "issue_width_per_scheduler": spec.scheduler_issue_width,
            "warp_assignment": "lowest-free resident warp slot modulo scheduler count",
            "cluster_lifetime": "all ranks retain placement slots until the last rank completes",
        },
    )
