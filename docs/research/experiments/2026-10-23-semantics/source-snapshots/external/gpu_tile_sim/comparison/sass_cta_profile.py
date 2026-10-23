"""Stream every CTA in a SASS trace into an injected per-CTA execution engine."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from math import prod
from pathlib import Path
from typing import Generic, TypeVar

from gpu_tile_sim.comparison.sass_cluster import (
    GroupedClusterIdentity,
    parse_sass_cluster_metadata,
)
from gpu_tile_sim.comparison.sass_trace import iter_sass_instructions
from gpu_tile_sim.comparison.sass_trace_payload import SassInstruction

InstructionT = TypeVar("InstructionT")


@dataclass(frozen=True, slots=True)
class CtaStreamCallbacks(Generic[InstructionT]):
    convert: Callable[[SassInstruction, set[int]], InstructionT]
    execute: Callable[[Mapping[int, tuple[InstructionT, ...]]], tuple[int, int]]
    is_duplicate: Callable[[SassInstruction, SassInstruction | None], bool]
    normalize: Callable[[tuple[SassInstruction, ...]], tuple[SassInstruction, ...]]
    observe_streams: (
        Callable[[int, Mapping[int, tuple[InstructionT, ...]], GroupedClusterIdentity], None] | None
    ) = None


@dataclass(frozen=True, slots=True)
class CtaStreamProfile(Generic[InstructionT]):
    first_cta: tuple[int, int, int]
    first_warps: Mapping[int, tuple[InstructionT, ...]]
    cycles_by_cta: tuple[int, ...]
    instruction_counts_by_cta: tuple[int, ...]
    cluster_identities_by_cta: tuple[GroupedClusterIdentity, ...] = ()
    cluster_execution: str = "legacy_rank_zero"

    @property
    def isolated_cluster_completion_cycles(self) -> dict[tuple[int, int, int], int]:
        """Slowest real rank's isolated work, before placement/shared-SM competition."""

        result: dict[tuple[int, int, int], int] = {}
        for identity, cycles in zip(
            self.cluster_identities_by_cta, self.cycles_by_cta, strict=True
        ):
            if identity.cluster_id is not None:
                result[identity.cluster_id] = max(result.get(identity.cluster_id, 0), cycles)
        return result


def profile_cta_streams(
    path: str | Path,
    *,
    grid_shape: tuple[int, int, int],
    callbacks: CtaStreamCallbacks[InstructionT],
    cluster_execution: str = "legacy_rank_zero",
    cluster_shape: tuple[int, int, int] | None = None,
) -> CtaStreamProfile[InstructionT]:
    """Return CTA-isolated cycles in CUDA X-first logical CTA order."""

    if cluster_execution not in {"legacy_rank_zero", "independent"}:
        raise ValueError("cluster_execution must be legacy_rank_zero or independent")
    if cluster_execution == "independent" and cluster_shape is None:
        cluster_shape = parse_sass_cluster_metadata(path).shape
    if cluster_shape is not None and (
        len(cluster_shape) != 3
        or any(type(value) is not int or value <= 0 for value in cluster_shape)
    ):
        raise ValueError("cluster_shape must contain three positive integers")
    state = _CtaAccumulator(callbacks, grid_shape, cluster_execution, cluster_shape)
    for instruction in iter_sass_instructions(path):
        state.observe(instruction)
    return state.finish(path)


class _CtaAccumulator(Generic[InstructionT]):
    def __init__(
        self,
        callbacks: CtaStreamCallbacks[InstructionT],
        grid_shape: tuple[int, int, int],
        cluster_execution: str,
        cluster_shape: tuple[int, int, int] | None,
    ) -> None:
        self._callbacks = callbacks
        self._grid_shape = grid_shape
        self._cluster_execution = cluster_execution
        self._cluster_shape = cluster_shape
        self._multi_rank_cluster = cluster_shape is not None and prod(cluster_shape) > 1
        self._identities: dict[int, GroupedClusterIdentity] = {}
        self._current: tuple[int, int, int] | None = None
        self._current_identity = GroupedClusterIdentity()
        self._warps: dict[int, list[SassInstruction]] = defaultdict(list)
        self._cluster_leader_cycles: dict[tuple[int, int, int], int] = {}
        self._cycles: dict[int, int] = {}
        self._instruction_counts: dict[int, int] = {}
        self._first_cta: tuple[int, int, int] | None = None
        self._first_warps: Mapping[int, tuple[InstructionT, ...]] | None = None

    def observe(self, instruction: SassInstruction) -> None:
        if self._current is not None and instruction.cta != self._current:
            self._flush()
        if self._current is None:
            self._current = instruction.cta
            self._current_identity = GroupedClusterIdentity(
                instruction.cluster_id,
                instruction.cluster_cta,
                instruction.cluster_rank,
            )
        identity = GroupedClusterIdentity(
            instruction.cluster_id, instruction.cluster_cta, instruction.cluster_rank
        )
        identity.validate_complete()
        if (
            self._cluster_execution == "independent"
            and self._multi_rank_cluster
            and identity.is_empty
        ):
            raise ValueError(
                "independent multi-rank cluster requires an identity for every physical CTA"
            )
        if identity != self._current_identity:
            raise ValueError("one CTA has inconsistent grouped SASS cluster identities")
        if self._cluster_execution == "independent":
            _validate_independent_cluster_instruction(
                instruction, multi_rank=self._multi_rank_cluster
            )
        if instruction.active_mask:
            self._warps[instruction.warp_id].append(instruction)

    def finish(self, path: str | Path) -> CtaStreamProfile[InstructionT]:
        self._flush()
        expected = prod(self._grid_shape)
        if len(self._cycles) != expected:
            raise ValueError(
                f"SASS trace contains {len(self._cycles)} CTAs, expected {expected}: {path}"
            )
        order = tuple(range(expected))
        if set(self._cycles) != set(order):
            raise ValueError(f"SASS trace does not cover every logical CTA exactly once: {path}")
        if self._cluster_execution == "independent":
            _validate_independent_cluster_members(
                tuple(self._identities.values()), declared_shape=self._cluster_shape
            )
        if self._first_cta is None or self._first_warps is None:
            raise ValueError(f"SASS trace has no active instructions: {path}")
        return CtaStreamProfile(
            first_cta=self._first_cta,
            first_warps=self._first_warps,
            cycles_by_cta=tuple(self._cycles[index] for index in order),
            instruction_counts_by_cta=tuple(self._instruction_counts[index] for index in order),
            cluster_identities_by_cta=tuple(self._identities[index] for index in order),
            cluster_execution=self._cluster_execution,
        )

    def _flush(self) -> None:
        if self._current is None:
            return
        streams = self._converted_streams()
        if not streams:
            raise ValueError(f"CTA {self._current} has no active SASS instructions")
        cta_id = _linear_cta_id(self._current, self._grid_shape)
        if cta_id in self._cycles:
            raise ValueError(f"CTA {self._current} appears more than once in the SASS trace")
        if self._callbacks.observe_streams is not None:
            self._callbacks.observe_streams(cta_id, streams, self._current_identity)
        try:
            cycles, instruction_count = self._profile_streams(streams)
        except Exception as exc:
            raise RuntimeError(f"failed to execute traced CTA {self._current}") from exc
        self._cycles[cta_id] = cycles
        self._identities[cta_id] = self._current_identity
        self._instruction_counts[cta_id] = instruction_count
        if self._first_cta is None:
            self._first_cta = self._current
            self._first_warps = streams
        self._current = None
        self._current_identity = GroupedClusterIdentity()
        self._warps = defaultdict(list)

    def _profile_streams(self, streams: Mapping[int, tuple[InstructionT, ...]]) -> tuple[int, int]:
        identity = self._current_identity
        if (
            self._cluster_execution == "independent"
            or identity.is_empty
            or identity.cluster_rank == 0
        ):
            cycles, instruction_count = self._callbacks.execute(streams)
            if identity.cluster_id is not None:
                self._cluster_leader_cycles[identity.cluster_id] = cycles
            return cycles, instruction_count
        if identity.cluster_id is None:
            raise RuntimeError("cluster follower has no cluster identity")
        if identity.cluster_id not in self._cluster_leader_cycles:
            raise RuntimeError("cluster follower appears before its rank-zero leader")
        instruction_count = sum(len(stream) for stream in streams.values())
        return self._cluster_leader_cycles[identity.cluster_id], instruction_count

    def _converted_streams(self) -> dict[int, tuple[InstructionT, ...]]:
        resident_sectors: set[int] = set()
        converted = {}
        for warp, raw_stream in self._warps.items():
            previous = None
            stream = []
            for instruction in self._callbacks.normalize(tuple(raw_stream)):
                if self._callbacks.is_duplicate(instruction, previous):
                    previous = None
                    continue
                previous = instruction
                stream.append(self._callbacks.convert(instruction, resident_sectors))
            converted[warp] = tuple(stream)
        return converted


def _linear_cta_id(coordinate: tuple[int, int, int], grid: tuple[int, int, int]) -> int:
    x, y, z = coordinate
    grid_x, grid_y, grid_z = grid
    if min(coordinate) < 0 or x >= grid_x or y >= grid_y or z >= grid_z:
        raise ValueError(f"CTA coordinate {coordinate} lies outside grid {grid}")
    return x + grid_x * (y + grid_y * z)


def _validate_independent_cluster_instruction(
    instruction: SassInstruction, *, multi_rank: bool
) -> None:
    """Reject cross-rank operations whose participant/completion trace is absent.

    A cluster identity alone cannot establish barrier ownership, remote shared
    addresses, multicast recipients' readiness, or CLC work redistribution.
    Independent arithmetic/global-memory ranks are supported. Cluster sync and
    remote/multicast operations require a future explicit cross-rank contract.
    """

    opcode = instruction.opcode
    if (
        (multi_rank and opcode.startswith(("SYNCS", "UTCBAR", "UGETNEXTWORKID")))
        or ".CLUSTER" in opcode
        or ".REMOTE" in opcode
        or (
            instruction.tma_multicast_mask is not None
            and (
                multi_rank or instruction.tma_multicast_mask != 1 << (instruction.cluster_rank or 0)
            )
        )
    ):
        raise ValueError(
            f"independent cluster execution needs cross-rank synchronization/route "
            f"evidence for {opcode}; rank-zero substitution is only available in legacy mode"
        )


def _validate_independent_cluster_members(
    identities: tuple[GroupedClusterIdentity, ...],
    *,
    declared_shape: tuple[int, int, int] | None,
) -> None:
    grouped = [identity for identity in identities if not identity.is_empty]
    if not grouped:
        if declared_shape is not None and prod(declared_shape) > 1:
            raise ValueError("independent multi-rank cluster requires complete grouped identities")
        return
    if len(grouped) != len(identities):
        raise ValueError(
            "independent cluster execution requires an identity for every physical CTA"
        )
    shape = tuple(
        max(identity.cluster_cta[axis] for identity in grouped) + 1  # type: ignore[index]
        for axis in range(3)
    )
    if declared_shape is not None and shape != declared_shape:
        raise ValueError("declared cluster shape disagrees with observed grouped identities")
    if prod(shape) == 1:
        # Some pre-cluster tracers emit the same zero cluster-id placeholder for
        # every CTA. A singleton launch groups by physical CTA, so that field
        # cannot identify a shared lifetime or make distinct CTAs duplicate ranks.
        if any(identity.cluster_rank != 0 for identity in grouped):
            raise ValueError("singleton cluster requires rank zero")
        return
    ranks: dict[tuple[int, int, int], set[int]] = defaultdict(set)
    for identity in grouped:
        coordinate = identity.cluster_cta
        cluster = identity.cluster_id
        rank = identity.cluster_rank
        if coordinate is None or cluster is None or rank is None:
            raise ValueError("independent cluster identity is incomplete")
        expected_rank = coordinate[0] + shape[0] * (coordinate[1] + shape[1] * coordinate[2])
        if rank != expected_rank or rank in ranks[cluster]:
            raise ValueError("independent cluster rank is inconsistent or duplicated")
        ranks[cluster].add(rank)
    expected = set(range(prod(shape)))
    if any(members != expected for members in ranks.values()):
        raise ValueError("independent cluster execution requires every rank of each cluster")
