"""Replay exact SASS addresses through L2 before exporting DRAM requests."""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

from gpu_tile_sim.backend.cache import L2Stats, SectorL2Cache
from gpu_tile_sim.comparison.sass_trace import (
    _coalesced_sectors,
    _is_global_load,
    _is_global_store,
    iter_sass_global_sector_requests,
    iter_sass_instructions,
)
from gpu_tile_sim.comparison.sass_trace_payload import SassInstruction


@dataclass(frozen=True, slots=True)
class SassL2ReplayConfig:
    capacity_bytes: int
    line_bytes: int
    sector_bytes: int
    associativity: int | None = None


def profile_sass_dram_traffic(
    source_path: str | Path,
    config: SassL2ReplayConfig,
    *,
    cache_state: str = "cold",
    flush_dirty: bool = False,
) -> dict[str, object]:
    """Estimate post-L2 traffic from addresses, with explicit offline assumptions.

    This replays file order, including CTA/warp grouping when present. It does
    not reconstruct the GPU's timed request order. ``warm_persistent`` means
    exactly one prior identical invocation, preserving its valid and dirty
    sectors; the returned counters cover only the second invocation. Stores
    use the assumed policy ``write_allocate_no_fetch``: even partial stores
    validate and dirty a whole sector without fetching its remaining bytes.
    Dirty sectors produce writes on eviction or an explicitly requested final
    flush. Atomic and reduction operations are rejected rather than modeled as
    ordinary stores.
    """

    if cache_state not in ("cold", "warm_persistent"):
        raise ValueError("cache_state must be 'cold' or 'warm_persistent'")
    if not isinstance(flush_dirty, bool):
        raise ValueError("flush_dirty must be a boolean")
    cache = _DramSectorCache(config)
    trace_path = Path(source_path)
    trace_hash = _trace_sha256(trace_path)
    if cache_state == "warm_persistent":
        _replay_dram_traffic(trace_path, cache)
        cache.clear_counters()
    initial_dirty_bytes = cache.dirty_sector_count * config.sector_bytes
    initial_resident_sector_count = cache.valid_sector_count
    tma_payload_bytes = _replay_dram_traffic(trace_path, cache)
    retained_before_flush = cache.dirty_sector_count * config.sector_bytes
    if flush_dirty:
        cache.flush_dirty()
    provenance = {
        "source": "parsed_dynamic_sass_addresses",
        "address_order": "source_file_order_including_grouped_CTA_warp_order",
        "gpu_timing_order_reconstructed": False,
        "model": "set_associative_sector_valid_LRU_with_sector_dirty_bits",
        "set_mapping": "line_address_modulo_set_count",
        "associativity_assumption": (
            "caller_supplied" if config.associativity is not None else "fully_associative_default"
        ),
        "write_policy": "write_allocate_no_fetch",
        "partial_store_assumption": "whole_sector_valid_and_dirty_without_read_fetch",
        "hardware_write_policy_verified": False,
        "cache_opcode_policy": "all_supported_global_loads_and_stores_use_the_assumed_L2_policy",
        "atomic_semantics": "unsupported_atomic_and_reduction_opcodes_rejected",
        "tma_accounting": "explicit_address_sectors_only_payload_byte_count_not_added",
        "tma_address_coverage": "source_address_list_assumed_complete_not_hardware_verified",
        "initial_state": cache_state,
        "warmup": (
            "one_identical_prior_invocation_with_valid_and_dirty_sectors_preserved"
            if cache_state == "warm_persistent"
            else "none_empty_L2"
        ),
        "warmup_invocations": int(cache_state == "warm_persistent"),
        "warmup_counters_included": False,
        "flush_dirty": flush_dirty,
        "retained_dirty_state": "retained_unless_explicit_final_flush",
        "scope": "offline_trace_order_traffic_evidence_not_coupled_GPU_timing",
    }
    return {
        "read_bytes": cache.read_sectors * config.sector_bytes,
        "write_bytes": (cache.evicted_dirty_sectors + cache.flushed_dirty_sectors)
        * config.sector_bytes,
        "cache_state": cache_state,
        "l2_capacity_bytes": config.capacity_bytes,
        "line_bytes": config.line_bytes,
        "sector_bytes": config.sector_bytes,
        "associativity": cache.associativity,
        "set_count": cache.set_count,
        "trace_sha256": trace_hash,
        "provenance": provenance,
        "address_order": provenance["address_order"],
        "model": provenance["model"],
        "write_policy": provenance["write_policy"],
        "warmup": provenance["warmup"],
        "initial_state": cache_state,
        "initial_dirty_bytes": initial_dirty_bytes,
        "initial_resident_sector_count": initial_resident_sector_count,
        "retained_dirty_bytes_before_flush": retained_before_flush,
        "retained_dirty_bytes": cache.dirty_sector_count * config.sector_bytes,
        "flush_dirty": flush_dirty,
        "load_sector_requests": cache.load_requests,
        "store_sector_requests": cache.store_requests,
        "address_request_count": cache.load_requests + cache.store_requests,
        "l2_sector_hits": cache.hits,
        "l2_sector_misses": cache.misses,
        "read_fill_sectors": cache.read_sectors,
        "evicted_dirty_sectors": cache.evicted_dirty_sectors,
        "flushed_dirty_sectors": cache.flushed_dirty_sectors,
        "tma_payload_bytes": tma_payload_bytes,
    }


@dataclass(slots=True)
class _DramCacheLine:
    valid: int = 0
    dirty: int = 0


class _DramSectorCache:
    """Lazy sets and bit masks keep space proportional to resident cache lines."""

    def __init__(self, config: SassL2ReplayConfig) -> None:
        # Reuse the public sector-cache geometry contract, without allocating
        # its sets. This additionally excludes floats/bools from byte counts.
        values = (config.capacity_bytes, config.line_bytes, config.sector_bytes)
        if any(type(value) is not int or value <= 0 for value in values):
            raise ValueError("cache capacity, line, and sector sizes must be positive integers")
        if config.capacity_bytes % config.line_bytes or config.line_bytes % config.sector_bytes:
            raise ValueError("cache capacity/line/sector sizes must divide exactly")
        line_count = config.capacity_bytes // config.line_bytes
        if config.associativity is not None and (
            type(config.associativity) is not int
            or config.associativity <= 0
            or config.associativity > line_count
            or line_count % config.associativity
        ):
            raise ValueError("cache associativity must divide the cache line count")
        self.associativity = config.associativity or line_count
        self.set_count = line_count // self.associativity
        self.line_bytes = config.line_bytes
        self.sector_bytes = config.sector_bytes
        self._sets: dict[int, OrderedDict[int, _DramCacheLine]] = {}
        self.clear_counters()

    def clear_counters(self) -> None:
        self.load_requests = 0
        self.store_requests = 0
        self.hits = 0
        self.misses = 0
        self.read_sectors = 0
        self.evicted_dirty_sectors = 0
        self.flushed_dirty_sectors = 0

    @property
    def dirty_sector_count(self) -> int:
        return sum(
            line.dirty.bit_count()
            for cache_set in self._sets.values()
            for line in cache_set.values()
        )

    @property
    def valid_sector_count(self) -> int:
        return sum(
            line.valid.bit_count()
            for cache_set in self._sets.values()
            for line in cache_set.values()
        )

    def access_one(self, kind: str, address: int) -> None:
        if address < 0:
            raise ValueError("cache address must be non-negative")
        line_address = address // self.line_bytes
        sector_bit = 1 << ((address % self.line_bytes) // self.sector_bytes)
        set_index = line_address % self.set_count
        cache_set = self._sets.get(set_index)
        if cache_set is None:
            cache_set = OrderedDict()
            self._sets[set_index] = cache_set
        line = cache_set.get(line_address)
        if line is not None and line.valid & sector_bit:
            self.hits += 1
        else:
            self.misses += 1
            if kind == "LD":
                self.read_sectors += 1
            if line is None:
                if len(cache_set) >= self.associativity:
                    _, evicted = cache_set.popitem(last=False)
                    self.evicted_dirty_sectors += evicted.dirty.bit_count()
                line = _DramCacheLine()
                cache_set[line_address] = line
            line.valid |= sector_bit
        cache_set.move_to_end(line_address)
        if kind == "LD":
            self.load_requests += 1
        else:
            self.store_requests += 1
            line.dirty |= sector_bit

    def flush_dirty(self) -> None:
        for cache_set in self._sets.values():
            for line in cache_set.values():
                self.flushed_dirty_sectors += line.dirty.bit_count()
                line.dirty = 0


def _replay_dram_traffic(path: Path, cache: _DramSectorCache) -> int:
    tma_payload_bytes = 0
    for instruction in iter_sass_instructions(path):
        if instruction.opcode.startswith(("ATOM", "RED", "UTMAREDG", "UBLKRED")):
            raise ValueError(
                f"unsupported atomic/reduction DRAM semantics: {instruction.opcode} "
                f"at PC 0x{instruction.pc:x} in {path}"
            )
        if _is_global_load(instruction.opcode):
            kind = "LD"
        elif _is_global_store(instruction.opcode):
            kind = "ST"
        else:
            continue
        if instruction.is_tma:
            tma_payload_bytes += instruction.tma_byte_count
            if (
                instruction.active_mask
                and instruction.tma_byte_count
                and not instruction.memory_addresses
            ):
                raise ValueError("active TMA transfer has no source address evidence")
        for address in _instruction_sector_addresses(instruction, cache.sector_bytes):
            cache.access_one(kind, address)
    return tma_payload_bytes


def _instruction_sector_addresses(instruction: SassInstruction, sector_bytes: int) -> list[int]:
    return [sector * sector_bytes for sector in _coalesced_sectors(instruction, sector_bytes)]


def _trace_sha256(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def replay_sass_l2(
    source_path: str | Path,
    config: SassL2ReplayConfig,
) -> L2Stats:
    """Replay one cold dynamic address stream with explicit sector/tag state."""

    cache = _cache(config)
    for _, address in iter_sass_global_sector_requests(
        source_path,
        transaction_bytes=config.sector_bytes,
    ):
        cache.access_one(address)
    return cache.snapshot()


def write_ramulator_l2_miss_trace(
    source_path: str | Path,
    output_path: str | Path,
    config: SassL2ReplayConfig,
) -> L2Stats:
    """Export only post-L2 misses for a Ramulator2 LoadStoreTrace frontend."""

    cache = _cache(config)
    with Path(output_path).open("w", encoding="utf-8") as output:
        for kind, address in iter_sass_global_sector_requests(
            source_path,
            transaction_bytes=config.sector_bytes,
        ):
            if not cache.access_one(address):
                output.write(f"{kind} 0x{address:x}\n")
    return cache.snapshot()


def _cache(config: SassL2ReplayConfig) -> SectorL2Cache:
    return SectorL2Cache(
        config.capacity_bytes,
        config.line_bytes,
        config.sector_bytes,
        associativity=config.associativity,
    )
