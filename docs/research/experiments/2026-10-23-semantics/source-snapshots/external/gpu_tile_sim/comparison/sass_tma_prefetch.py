"""Recover the unthrottled TMA stage window from dynamic SASS."""

from __future__ import annotations

from dataclasses import dataclass, field

from gpu_tile_sim.comparison.sass_trace_payload import SassInstruction

TMA_LOAD_PREFIXES = ("UTMALDG", "UTMAPF", "UBLKCP", "UBLKPF")


@dataclass(slots=True)
class _BarrierRing:
    current_address: int | None = None
    closed_addresses: set[int] = field(default_factory=set)
    complete: bool = False

    def admits(self, address: int) -> bool:
        if self.complete:
            return False
        if self.current_address == address:
            return True
        if self.current_address is not None:
            self.closed_addresses.add(self.current_address)
        if address in self.closed_addresses:
            self.complete = True
            return False
        self.current_address = address
        return True


class TmaPrefetchWindowTracker:
    """Count each producer warp's first traversal of its mbarrier stage ring."""

    def __init__(self, cta_count: int) -> None:
        if cta_count <= 0:
            raise ValueError("CTA count must be positive")
        self._bytes_by_cta = [0] * cta_count
        self._rings: dict[tuple[int, int], _BarrierRing] = {}

    def observe(self, cta_id: int, instruction: SassInstruction) -> None:
        if not instruction.opcode.startswith(TMA_LOAD_PREFIXES):
            return
        address = instruction.tma_mbarrier_address
        if address is None or address <= 0:
            return
        ring = self._rings.setdefault((cta_id, instruction.warp_id), _BarrierRing())
        if ring.admits(address):
            self._bytes_by_cta[cta_id] += instruction.tma_byte_count

    @property
    def bytes_by_cta(self) -> tuple[int, ...]:
        return tuple(self._bytes_by_cta)
