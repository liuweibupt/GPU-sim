"""Parse the schedule and resource contract from an Accel-Sim text SASS trace."""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from hashlib import sha256
from itertools import islice
from math import prod
from pathlib import Path
from types import MappingProxyType

from gpu_tile_sim.comparison.sass_cluster import (
    GROUPED_CTA_PATTERN,
    GroupedClusterIdentity,
    SassClusterAccumulator,
    SassClusterMetadata,
    grouped_cluster_field,
)
from gpu_tile_sim.comparison.sass_tile_metadata import (
    dimensions,
    int_field,
    optional_hex_field,
    resolve_tile,
    text_field,
)
from gpu_tile_sim.comparison.sass_tma_prefetch import TmaPrefetchWindowTracker
from gpu_tile_sim.comparison.sass_trace_payload import (
    SassInstruction,
    SassParseContext,
    instruction_from_tokens,
)

HEADER_LINE_LIMIT = 24
WARP_SIZE = 32
HASH_CHUNK_BYTES = 1024 * 1024
GLOBAL_LOAD_PREFIXES = ("LDG", "LD.", "LDC")
GLOBAL_STORE_PREFIXES = ("STG", "ST.", "ATOM", "RED")
MUFU_PREFIX = "MUFU."
DEFAULT_MEMORY_SECTOR_BYTES = 32
GROUPED_WARP_PATTERN = re.compile(r"^warp = (\d+)$")


@dataclass(frozen=True, slots=True)
class SassTraceSchedule:
    kernel_name: str
    grid: tuple[int, int, int]
    block: tuple[int, int, int]
    shared_bytes: int
    registers_per_thread: int
    binary_version: int
    tracer_version: int
    shared_base_address: int | None
    local_base_address: int | None
    tile_m: int | None
    tile_n: int | None
    tile_k: int | None
    num_stages: int | None

    @property
    def cta_count(self) -> int:
        return prod(self.grid)

    @property
    def num_warps(self) -> int:
        threads = prod(self.block)
        return (threads + WARP_SIZE - 1) // WARP_SIZE

    def to_dict(self) -> dict[str, object]:
        return {
            "kernel_name": self.kernel_name,
            "grid": list(self.grid),
            "block": list(self.block),
            "shared_bytes": self.shared_bytes,
            "registers_per_thread": self.registers_per_thread,
            "binary_version": self.binary_version,
            "tracer_version": self.tracer_version,
            "shared_base_address": self.shared_base_address,
            "local_base_address": self.local_base_address,
            "tile_m": self.tile_m,
            "tile_n": self.tile_n,
            "tile_k": self.tile_k,
            "num_stages": self.num_stages,
            "cta_count": self.cta_count,
            "num_warps": self.num_warps,
        }


@dataclass(frozen=True, slots=True)
class SassTraceProfile:
    """Instruction mix and coalesced global-memory requests from a dynamic trace."""

    schedule: SassTraceSchedule
    trace_sha256: str
    dynamic_instruction_counts: Mapping[str, int]
    dynamic_instruction_sites: Mapping[int, frozenset[str]]
    active_lane_instruction_counts: Mapping[str, int]
    global_load_sector_requests: int
    global_store_sector_requests: int
    unique_global_sectors: int
    memory_sector_bytes: int
    tma_load_bytes: int
    tma_store_bytes: int
    tma_oob_bytes: int
    global_load_sector_requests_by_cta: tuple[int, ...]
    global_store_sector_requests_by_cta: tuple[int, ...]
    tma_load_bytes_by_cta: tuple[int, ...]
    tma_prefetch_load_bytes_by_cta: tuple[int, ...]
    tma_store_bytes_by_cta: tuple[int, ...]
    clc_query_count_by_cta: tuple[int, ...]
    cluster: SassClusterMetadata
    unique_global_load_sectors: int | None = None
    unique_global_store_sectors: int | None = None

    @property
    def sfu_active_lane_operations(self) -> Mapping[str, int]:
        return MappingProxyType(
            {
                opcode: count
                for opcode, count in self.active_lane_instruction_counts.items()
                if opcode.startswith(MUFU_PREFIX)
            }
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "trace_sha256": self.trace_sha256,
            "cta_count": self.schedule.cta_count,
            "grid_shape": list(self.schedule.grid),
            "dynamic_instruction_counts": dict(self.dynamic_instruction_counts),
            "dynamic_instruction_sites": {
                f"0x{pc:x}": sorted(opcodes)
                for pc, opcodes in self.dynamic_instruction_sites.items()
            },
            "active_lane_instruction_counts": dict(self.active_lane_instruction_counts),
            "sfu_active_lane_operations": dict(self.sfu_active_lane_operations),
            "global_load_sector_requests": self.global_load_sector_requests,
            "global_store_sector_requests": self.global_store_sector_requests,
            "unique_global_sectors": self.unique_global_sectors,
            "unique_global_load_sectors": self.unique_global_load_sectors,
            "unique_global_store_sectors": self.unique_global_store_sectors,
            "memory_sector_bytes": self.memory_sector_bytes,
            "tma_load_bytes": self.tma_load_bytes,
            "tma_store_bytes": self.tma_store_bytes,
            "tma_oob_bytes": self.tma_oob_bytes,
            "global_load_sector_requests_by_cta": list(self.global_load_sector_requests_by_cta),
            "global_store_sector_requests_by_cta": list(self.global_store_sector_requests_by_cta),
            "tma_load_bytes_by_cta": list(self.tma_load_bytes_by_cta),
            "tma_prefetch_load_bytes_by_cta": list(self.tma_prefetch_load_bytes_by_cta),
            "tma_store_bytes_by_cta": list(self.tma_store_bytes_by_cta),
            "clc_query_count_by_cta": list(self.clc_query_count_by_cta),
            **self.cluster.to_dict(),
        }


def parse_sass_trace_schedule(
    path: str | Path,
    *,
    tile_m: int | None = None,
    tile_n: int | None = None,
    tile_k: int | None = None,
    num_stages: int | None = None,
    require_tile: bool = True,
) -> SassTraceSchedule:
    trace_path = Path(path)
    with trace_path.open(errors="replace") as source:
        header = "".join(islice(source, HEADER_LINE_LIMIT))
    kernel_name = text_field(header, "kernel name")
    tile = resolve_tile(
        kernel_name,
        tile_m=tile_m,
        tile_n=tile_n,
        tile_k=tile_k,
        num_stages=num_stages,
        require_tile=require_tile,
    )
    return SassTraceSchedule(
        kernel_name=kernel_name,
        grid=dimensions(header, "grid"),
        block=dimensions(header, "block"),
        shared_bytes=int_field(header, "shmem"),
        registers_per_thread=int_field(header, "nregs"),
        binary_version=int_field(header, "binary version"),
        tracer_version=int_field(header, "accelsim tracer version"),
        shared_base_address=optional_hex_field(header, "shmem base_addr"),
        local_base_address=optional_hex_field(header, "local mem base_addr"),
        tile_m=tile[0],
        tile_n=tile[1],
        tile_k=tile[2],
        num_stages=tile[3],
    )


def parse_sass_trace_profile(
    path: str | Path,
    *,
    memory_sector_bytes: int = DEFAULT_MEMORY_SECTOR_BYTES,
    tile_m: int | None = None,
    tile_n: int | None = None,
    tile_k: int | None = None,
    num_stages: int | None = None,
) -> SassTraceProfile:
    """Parse exact dynamic opcodes and coalesced sectors; no source-level op guessing."""

    if memory_sector_bytes <= 0:
        raise ValueError("memory_sector_bytes must be positive")
    trace_path = Path(path)
    schedule = parse_sass_trace_schedule(
        trace_path,
        tile_m=tile_m,
        tile_n=tile_n,
        tile_k=tile_k,
        num_stages=num_stages,
        require_tile=False,
    )
    instructions: Counter[str] = Counter()
    instruction_sites: dict[int, set[str]] = {}
    lane_instructions: Counter[str] = Counter()
    sector_directions: dict[int, int] = {}
    unique_loads = 0
    unique_stores = 0
    load_requests = 0
    store_requests = 0
    tma_load_bytes = 0
    tma_store_bytes = 0
    tma_oob_bytes = 0
    load_requests_by_cta = [0] * schedule.cta_count
    store_requests_by_cta = [0] * schedule.cta_count
    tma_load_bytes_by_cta = [0] * schedule.cta_count
    tma_store_bytes_by_cta = [0] * schedule.cta_count
    prefetch = TmaPrefetchWindowTracker(schedule.cta_count)
    clc_query_count_by_cta = [0] * schedule.cta_count
    previous_clc_site: tuple[tuple[int, int, int], int, int] | None = None
    cluster_accumulator = SassClusterAccumulator()
    for instruction in iter_sass_instructions(trace_path):
        cta_id = _linear_cta_id(instruction.cta, schedule.grid)
        clc_site = (instruction.cta, instruction.warp_id, instruction.pc)
        if instruction.opcode.startswith("UGETNEXTWORKID"):
            if clc_site != previous_clc_site:
                clc_query_count_by_cta[cta_id] += 1
            previous_clc_site = clc_site
        else:
            previous_clc_site = None
        cluster_accumulator.observe(instruction)
        prefetch.observe(cta_id, instruction)
        instructions[instruction.opcode] += 1
        instruction_sites.setdefault(instruction.pc, set()).add(instruction.opcode)
        lane_instructions[instruction.opcode] += instruction.active_lanes
        sectors = _coalesced_sectors(instruction, memory_sector_bytes)
        direction = 0
        if _is_global_load(instruction.opcode):
            direction = 1
            load_requests += len(sectors)
            load_requests_by_cta[cta_id] += len(sectors)
        elif _is_global_store(instruction.opcode):
            direction = 2
            store_requests += len(sectors)
            store_requests_by_cta[cta_id] += len(sectors)
        for sector in sectors:
            previous = sector_directions.get(sector, 0)
            if direction == 1 and not previous & 1:
                unique_loads += 1
            elif direction == 2 and not previous & 2:
                unique_stores += 1
            sector_directions[sector] = previous | direction
        if instruction.opcode.startswith(("UTMALDG", "UTMAPF", "UBLKCP", "UBLKPF")):
            tma_load_bytes += instruction.tma_byte_count
            tma_load_bytes_by_cta[cta_id] += instruction.tma_byte_count
        elif instruction.opcode.startswith(("UTMASTG", "UTMAREDG", "UBLKRED")):
            tma_store_bytes += instruction.tma_byte_count
            tma_store_bytes_by_cta[cta_id] += instruction.tma_byte_count
        tma_oob_bytes += instruction.tma_oob_byte_count
    return SassTraceProfile(
        schedule=schedule,
        trace_sha256=_sha256_file(trace_path),
        dynamic_instruction_counts=MappingProxyType(dict(sorted(instructions.items()))),
        dynamic_instruction_sites=MappingProxyType(
            {pc: frozenset(opcodes) for pc, opcodes in sorted(instruction_sites.items())}
        ),
        active_lane_instruction_counts=MappingProxyType(dict(sorted(lane_instructions.items()))),
        global_load_sector_requests=load_requests,
        global_store_sector_requests=store_requests,
        unique_global_sectors=len(sector_directions),
        unique_global_load_sectors=unique_loads,
        unique_global_store_sectors=unique_stores,
        memory_sector_bytes=memory_sector_bytes,
        tma_load_bytes=tma_load_bytes,
        tma_store_bytes=tma_store_bytes,
        tma_oob_bytes=tma_oob_bytes,
        global_load_sector_requests_by_cta=tuple(load_requests_by_cta),
        global_store_sector_requests_by_cta=tuple(store_requests_by_cta),
        tma_load_bytes_by_cta=tuple(tma_load_bytes_by_cta),
        tma_prefetch_load_bytes_by_cta=prefetch.bytes_by_cta,
        tma_store_bytes_by_cta=tuple(tma_store_bytes_by_cta),
        clc_query_count_by_cta=tuple(clc_query_count_by_cta),
        cluster=cluster_accumulator.metadata(),
    )


def _linear_cta_id(coordinate: tuple[int, int, int], grid: tuple[int, int, int]) -> int:
    x, y, z = coordinate
    grid_x, grid_y, grid_z = grid
    if min(coordinate) < 0 or x >= grid_x or y >= grid_y or z >= grid_z:
        raise ValueError(f"CTA coordinate {coordinate} lies outside grid {grid}")
    return x + grid_x * (y + grid_y * z)


def _sha256_file(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(HASH_CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def iter_sass_instructions(path: str | Path) -> Iterator[SassInstruction]:
    """Yield validated dynamic instructions in trace order."""

    schedule = parse_sass_trace_schedule(path, require_tile=False)
    context = SassParseContext(
        schedule.tracer_version,
        schedule.shared_base_address,
        schedule.local_base_address,
    )
    current_cta: tuple[int, int, int] | None = None
    current_warp: int | None = None
    cluster = GroupedClusterIdentity()
    with Path(path).open(errors="replace") as source:
        for line_number, line in enumerate(source, start=1):
            stripped = line.strip()
            if not stripped or stripped.startswith(("-", "#")):
                continue
            cta_match = GROUPED_CTA_PATTERN.match(stripped)
            if cta_match is not None:
                current_cta = tuple(int(value) for value in cta_match.groups())
                current_warp = None
                cluster = GroupedClusterIdentity()
                continue
            warp_match = GROUPED_WARP_PATTERN.match(stripped)
            if warp_match is not None:
                current_warp = int(warp_match.group(1))
                continue
            cluster_field = grouped_cluster_field(stripped)
            if cluster_field is not None:
                cluster = cluster.with_field(*cluster_field)
                continue
            if stripped.startswith("insts ="):
                continue
            try:
                if current_cta is None or current_warp is None:
                    yield _parse_instruction(stripped, context)
                else:
                    yield _parse_grouped_instruction(
                        stripped,
                        cta=current_cta,
                        warp_id=current_warp,
                        context=context,
                        cluster=cluster,
                    )
            except (IndexError, ValueError) as exc:
                raise ValueError(f"invalid SASS trace line {line_number}: {path}") from exc


def write_ramulator_load_store_trace(
    source_path: str | Path,
    output_path: str | Path,
    *,
    transaction_bytes: int = DEFAULT_MEMORY_SECTOR_BYTES,
) -> int:
    """Export coalesced SASS requests in Ramulator2 LoadStoreTrace format."""

    if transaction_bytes <= 0:
        raise ValueError("transaction_bytes must be positive")
    request_count = 0
    with Path(output_path).open("w", encoding="utf-8") as output:
        for request_kind, address in iter_sass_global_sector_requests(
            source_path,
            transaction_bytes=transaction_bytes,
        ):
            output.write(f"{request_kind} 0x{address:x}\n")
            request_count += 1
    return request_count


def iter_sass_global_sector_requests(
    path: str | Path,
    *,
    transaction_bytes: int = DEFAULT_MEMORY_SECTOR_BYTES,
) -> Iterator[tuple[str, int]]:
    """Yield coalesced load/store sector addresses in dynamic trace order."""

    if transaction_bytes <= 0:
        raise ValueError("transaction_bytes must be positive")
    for instruction in iter_sass_instructions(path):
        request_kind = _ramulator_request_kind(instruction.opcode)
        if request_kind is None:
            continue
        for sector in _coalesced_sectors(instruction, transaction_bytes):
            yield request_kind, sector * transaction_bytes


def _parse_instruction(line: str, context: SassParseContext) -> SassInstruction:
    tokens = line.split()
    cta = tuple(int(tokens[index]) for index in range(3))
    warp_id = int(tokens[3])
    return instruction_from_tokens(tokens[4:], cta=cta, warp_id=warp_id, context=context)


def _parse_grouped_instruction(
    line: str,
    *,
    cta: tuple[int, int, int],
    warp_id: int,
    context: SassParseContext,
    cluster: GroupedClusterIdentity,
) -> SassInstruction:
    cluster.validate_complete()
    return instruction_from_tokens(
        line.split(),
        cta=cta,
        warp_id=warp_id,
        context=context,
        cluster_id=cluster.cluster_id,
        cluster_cta=cluster.cluster_cta,
        cluster_rank=cluster.cluster_rank,
    )


def _coalesced_sectors(instruction: SassInstruction, sector_bytes: int) -> tuple[int, ...]:
    if not (_is_global_load(instruction.opcode) or _is_global_store(instruction.opcode)):
        return ()
    # Ordinary lane operands can straddle a sector. TMA addresses already
    # describe explicit sectors, so its separate payload size is not expanded.
    width = 1 if instruction.is_tma else max(1, instruction.memory_width_bytes)
    sectors: set[int] = set()
    for address in instruction.memory_addresses:
        if address < 0:
            raise ValueError("global memory address must be non-negative")
        sectors.update(range(address // sector_bytes, (address + width - 1) // sector_bytes + 1))
    return tuple(sorted(sectors))


def _is_global_load(opcode: str) -> bool:
    return opcode.startswith((*GLOBAL_LOAD_PREFIXES, "UTMALDG", "UTMAPF", "UBLKCP", "UBLKPF"))


def _is_global_store(opcode: str) -> bool:
    if opcode.startswith(("ATOMS", "REDUX")):
        return False
    return opcode.startswith((*GLOBAL_STORE_PREFIXES, "UTMASTG", "UTMAREDG", "UBLKRED"))


def _ramulator_request_kind(opcode: str) -> str | None:
    if _is_global_load(opcode):
        return "LD"
    if _is_global_store(opcode):
        return "ST"
    return None
