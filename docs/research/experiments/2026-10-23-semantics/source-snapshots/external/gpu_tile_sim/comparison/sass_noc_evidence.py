"""Trace-bound routes for explicit SASS NoC/partition experiments.

Endpoint, partition, byte overhead and directed path are supplied evidence. No
address bits, balanced placement, or GPU product name are routing evidence.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass

from gpu_tile_sim.backend.sass_noc import (
    NoCLinkSpec,
    NoCRouterSpec,
    SassNoCNetwork,
    SassNoCTransaction,
)
from gpu_tile_sim.comparison.sass_execution_instruction import ExecutionInstruction

NOC_EVIDENCE_FORMAT = "sass-explicit-noc-routes-v1"


def _digest(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


@dataclass(frozen=True, slots=True)
class SassNoCRoute:
    cta_id: int
    warp_id: int
    instruction_index: int
    source_sm: int
    partition_id: int
    source: str
    destination: str
    request_path: tuple[str, ...]
    response_path: tuple[str, ...]
    request_bytes: int
    response_bytes: int
    data_bytes: int

    def __post_init__(self) -> None:
        for name in (
            "cta_id",
            "warp_id",
            "instruction_index",
            "source_sm",
            "partition_id",
            "request_bytes",
            "response_bytes",
            "data_bytes",
        ):
            if type(getattr(self, name)) is not int or getattr(self, name) < 0:
                raise ValueError(f"NoC evidence {name} must be a nonnegative integer")
        if not self.source or not self.destination or not self.data_bytes:
            raise ValueError("NoC route requires endpoint identities and nonzero traced data bytes")

    @property
    def key(self) -> tuple[int, int, int]:
        return self.cta_id, self.warp_id, self.instruction_index

    def transaction(
        self,
        ready_cycle: int,
        *,
        actual_sm: int,
        transaction_id: object | None = None,
        **service,
    ) -> SassNoCTransaction:
        if actual_sm != self.source_sm:
            raise ValueError(
                "NoC route source SM disagrees with actual CTA placement; rebind routes"
            )
        return SassNoCTransaction(
            self.key if transaction_id is None else transaction_id,
            ready_cycle,
            self.source,
            self.destination,
            self.request_path,
            self.response_path,
            self.request_bytes,
            self.response_bytes,
            **service,
        )


@dataclass(frozen=True, slots=True)
class SassNoCEvidence:
    trace_sha256: str
    provenance: str
    links: tuple[NoCLinkSpec, ...]
    routers: tuple[NoCRouterSpec, ...]
    routes: tuple[SassNoCRoute, ...]

    def __post_init__(self) -> None:
        if (
            not isinstance(self.trace_sha256, str)
            or len(self.trace_sha256) != 64
            or any(c not in "0123456789abcdef" for c in self.trace_sha256)
        ):
            raise ValueError("NoC routes need an exact SHA-256 trace identity")
        if not isinstance(self.provenance, str) or not self.provenance.strip():
            raise ValueError("NoC routes and capacities require explicit provenance")
        network = SassNoCNetwork(self.links, self.routers)
        keys = set()
        for route in self.routes:
            if route.key in keys:
                raise ValueError("NoC evidence duplicates a physical SASS instruction")
            keys.add(route.key)
            network.validate_route(route.source, route.destination, route.request_path)
            network.validate_route(route.destination, route.source, route.response_path)

    def network(self) -> SassNoCNetwork:
        return SassNoCNetwork(self.links, self.routers)

    def bind(
        self,
        programs: Sequence[Mapping[int, tuple[ExecutionInstruction, ...]]],
        *,
        trace_sha256: str,
        sector_bytes: int,
    ) -> dict[tuple[int, int, int], SassNoCRoute]:
        if self.trace_sha256 != trace_sha256:
            raise ValueError("NoC route evidence belongs to another SASS trace")
        if type(sector_bytes) is not int or sector_bytes <= 0:
            raise ValueError("NoC trace sector_bytes must be positive")
        expected = {}
        for cta, warps in enumerate(programs):
            for warp, stream in warps.items():
                for position, instruction in enumerate(stream):
                    if instruction.memory_sector_addresses:
                        expected[cta, warp, position] = instruction
        routes = {route.key: route for route in self.routes}
        if routes.keys() != expected.keys():
            raise ValueError(
                "NoC route evidence must cover every and only addressed SASS instruction"
            )
        for key, instruction in expected.items():
            route = routes[key]
            data = len(instruction.memory_sector_addresses) * sector_bytes
            if route.data_bytes != data:
                raise ValueError("NoC route data bytes disagree with traced sector payload")
            store = instruction.opcode.startswith(("STG", "ST.", "UTMASTG"))
            if (route.request_bytes if store else route.response_bytes) < data:
                raise ValueError("NoC packet bytes cannot be smaller than its traced data transfer")
        return routes

    def to_dict(self) -> dict[str, object]:
        payload = {"format": NOC_EVIDENCE_FORMAT, **asdict(self)}
        payload["payload_sha256"] = _digest(payload)
        return payload

    @classmethod
    def from_dict(cls, raw: Mapping[str, object]) -> SassNoCEvidence:
        payload = dict(raw)
        checksum = payload.pop("payload_sha256", None)
        if checksum != _digest(payload) or payload.pop("format", None) != NOC_EVIDENCE_FORMAT:
            raise ValueError("NoC route evidence format or checksum mismatch")
        expected_fields = {"trace_sha256", "provenance", "links", "routers", "routes"}
        if set(payload) != expected_fields:
            raise ValueError("NoC route evidence has missing or unknown schema fields")
        routes = []
        for raw_route in payload.pop("routes"):
            route = dict(raw_route)
            route["request_path"] = tuple(route["request_path"])
            route["response_path"] = tuple(route["response_path"])
            routes.append(SassNoCRoute(**route))
        links = tuple(NoCLinkSpec(**item) for item in payload.pop("links"))
        routers = tuple(NoCRouterSpec(**item) for item in payload.pop("routers"))
        return cls(**payload, links=links, routers=routers, routes=tuple(routes))
