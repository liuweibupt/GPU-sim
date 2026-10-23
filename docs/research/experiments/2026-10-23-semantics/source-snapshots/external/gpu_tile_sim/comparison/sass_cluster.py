"""Thread-block-cluster and Cluster Launch Control facts from grouped SASS traces."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from math import prod
from pathlib import Path

from gpu_tile_sim.comparison.sass_trace_payload import SassInstruction

GROUPED_CTA_PATTERN = re.compile(r"^thread block = (\d+),(\d+),(\d+)$")
GROUPED_CLUSTER_VECTOR_PATTERN = re.compile(
    r"^cluster (?P<kind>id|cta) = (?P<x>\d+),(?P<y>\d+),(?P<z>\d+)$"
)
GROUPED_CLUSTER_RANK_PATTERN = re.compile(r"^cluster rank = (?P<rank>\d+)$")
CLC_OPCODE = "UGETNEXTWORKID"
CLUSTER_DIMENSION_COUNT = 3
INSTRUCTION_LINE_PATTERN = re.compile(r"^[0-9a-fA-F]+\s+[0-9a-fA-F]+\s+")


@dataclass(frozen=True, slots=True)
class SassClusterMetadata:
    shape: tuple[int, int, int]
    observed_cluster_count: int
    metadata_present: bool
    clc_query_count: int

    @property
    def uses_cluster_launch_control(self) -> bool:
        return self.clc_query_count > 0

    def to_dict(self) -> dict[str, object]:
        return {
            "cluster_shape": list(self.shape),
            "observed_cluster_count": self.observed_cluster_count,
            "cluster_metadata_present": self.metadata_present,
            "clc_query_count": self.clc_query_count,
            "uses_cluster_launch_control": self.uses_cluster_launch_control,
        }


@dataclass(frozen=True, slots=True)
class GroupedClusterIdentity:
    cluster_id: tuple[int, int, int] | None = None
    cluster_cta: tuple[int, int, int] | None = None
    cluster_rank: int | None = None

    @property
    def is_empty(self) -> bool:
        return self.cluster_id is None and self.cluster_cta is None and self.cluster_rank is None

    def with_field(self, name: str, value: tuple[int, int, int] | int) -> GroupedClusterIdentity:
        values = {
            "cluster_id": self.cluster_id,
            "cluster_cta": self.cluster_cta,
            "cluster_rank": self.cluster_rank,
        }
        if name not in values:
            raise ValueError(f"unknown grouped cluster field: {name}")
        values[name] = value
        return GroupedClusterIdentity(**values)

    def validate_complete(self) -> None:
        if self.is_empty:
            return
        if None in (self.cluster_id, self.cluster_cta, self.cluster_rank):
            raise ValueError("grouped SASS cluster identity is incomplete")


@dataclass(slots=True)
class SassClusterAccumulator:
    """Collect one identity per CTA while the main instruction parser is already streaming."""

    identities: dict[tuple[int, int, int], GroupedClusterIdentity] = field(default_factory=dict)
    clc_query_count: int = 0
    _previous_clc_site: tuple[tuple[int, int, int], int, int, str] | None = None

    def observe(self, instruction: SassInstruction) -> None:
        if instruction.opcode.startswith(CLC_OPCODE):
            site = (instruction.cta, instruction.warp_id, instruction.pc, instruction.opcode)
            if site != self._previous_clc_site:
                self.clc_query_count += 1
            self._previous_clc_site = site
        else:
            self._previous_clc_site = None
        identity = GroupedClusterIdentity(
            instruction.cluster_id,
            instruction.cluster_cta,
            instruction.cluster_rank,
        )
        identity.validate_complete()
        if identity.is_empty:
            return
        previous = self.identities.get(instruction.cta)
        if previous is not None and previous != identity:
            raise ValueError("one CTA has inconsistent grouped SASS cluster identities")
        self.identities[instruction.cta] = identity

    def metadata(self) -> SassClusterMetadata:
        return _metadata_from_identities(tuple(self.identities.values()), self.clc_query_count)


def parse_sass_cluster_metadata(path: str | Path) -> SassClusterMetadata:
    identities: list[GroupedClusterIdentity] = []
    identity = GroupedClusterIdentity()
    in_thread_block = False
    clc_queries = 0
    previous_clc_site: tuple[str, str] | None = None
    with Path(path).open(errors="replace") as source:
        for line in source:
            stripped = line.strip()
            if CLC_OPCODE in stripped:
                tokens = stripped.split()
                site = (tokens[0], CLC_OPCODE)
                if site != previous_clc_site:
                    clc_queries += 1
                previous_clc_site = site
            elif INSTRUCTION_LINE_PATTERN.match(stripped):
                previous_clc_site = None
            if GROUPED_CTA_PATTERN.match(stripped):
                if in_thread_block:
                    _append_identity(identities, identity)
                identity = GroupedClusterIdentity()
                in_thread_block = True
                continue
            field = grouped_cluster_field(stripped)
            if field is not None:
                identity = identity.with_field(*field)
    if in_thread_block:
        _append_identity(identities, identity)
    return _metadata_from_identities(tuple(identities), clc_queries)


def grouped_cluster_field(
    line: str,
) -> tuple[str, tuple[int, int, int] | int] | None:
    vector = GROUPED_CLUSTER_VECTOR_PATTERN.match(line)
    if vector is not None:
        name = "cluster_id" if vector.group("kind") == "id" else "cluster_cta"
        return name, tuple(int(vector.group(axis)) for axis in ("x", "y", "z"))
    rank = GROUPED_CLUSTER_RANK_PATTERN.match(line)
    if rank is not None:
        return "cluster_rank", int(rank.group("rank"))
    return None


def _append_identity(
    identities: list[GroupedClusterIdentity], identity: GroupedClusterIdentity
) -> None:
    identity.validate_complete()
    if not identity.is_empty:
        identities.append(identity)


def _cluster_shape(
    identities: tuple[GroupedClusterIdentity, ...],
) -> tuple[int, int, int]:
    coordinates = [identity.cluster_cta for identity in identities]
    if any(coordinate is None for coordinate in coordinates):
        raise RuntimeError("validated cluster identity lost its local CTA coordinate")
    return tuple(
        max(coordinate[axis] for coordinate in coordinates if coordinate) + 1
        for axis in range(CLUSTER_DIMENSION_COUNT)
    )


def _validate_cluster_ranks(
    identities: tuple[GroupedClusterIdentity, ...], shape: tuple[int, int, int]
) -> None:
    shape_x, shape_y, _ = shape
    for identity in identities:
        coordinate = identity.cluster_cta
        if coordinate is None or identity.cluster_rank is None:
            raise RuntimeError("validated cluster identity became incomplete")
        x, y, z = coordinate
        expected_rank = x + shape_x * (y + shape_y * z)
        if identity.cluster_rank != expected_rank:
            raise ValueError("grouped SASS cluster rank disagrees with cluster CTA coordinate")
    if prod(shape) < max(identity.cluster_rank or 0 for identity in identities) + 1:
        raise ValueError("grouped SASS cluster shape does not contain every cluster rank")


def _metadata_from_identities(
    identities: tuple[GroupedClusterIdentity, ...], clc_queries: int
) -> SassClusterMetadata:
    if not identities:
        return SassClusterMetadata(
            shape=(1, 1, 1),
            observed_cluster_count=0,
            metadata_present=False,
            clc_query_count=clc_queries,
        )
    shape = _cluster_shape(identities)
    _validate_cluster_ranks(identities, shape)
    cluster_ids = {identity.cluster_id for identity in identities}
    return SassClusterMetadata(
        shape=shape,
        observed_cluster_count=len(cluster_ids),
        metadata_present=True,
        clc_query_count=clc_queries,
    )
