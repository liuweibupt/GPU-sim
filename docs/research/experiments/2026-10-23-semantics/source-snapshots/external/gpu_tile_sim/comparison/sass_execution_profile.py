"""Serializable result of one reusable dynamic-SASS CTA execution template."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from gpu_tile_sim.comparison.sass_cluster import SassClusterMetadata


@dataclass(frozen=True, slots=True)
class SassExecutionProfile:
    model_id: str
    binary_version: int
    template_cta: tuple[int, int, int]
    cta_count: int
    grid_shape: tuple[int, int, int]
    num_warps: int
    shared_bytes: int
    registers_per_thread: int
    template_cycles: int
    template_instruction_count: int
    cta_cycles: tuple[int, ...]
    cta_instruction_counts: tuple[int, ...]
    pipeline_instruction_counts: Mapping[str, int]
    global_sector_requests: int
    l1_hit_sector_requests: int
    l2_sector_requests: int
    shared_instruction_count: int
    shared_bank_service_cycles: int
    shared_bank_replay_cycles: int
    tma_bytes: int
    total_global_load_sector_requests: int
    total_global_store_sector_requests: int
    total_unique_global_sectors: int
    memory_sector_bytes: int
    total_tma_load_bytes: int
    total_tma_store_bytes: int
    total_tma_oob_bytes: int
    global_load_sector_requests_by_cta: tuple[int, ...]
    global_store_sector_requests_by_cta: tuple[int, ...]
    tma_load_bytes_by_cta: tuple[int, ...]
    tma_prefetch_load_bytes_by_cta: tuple[int, ...]
    tma_store_bytes_by_cta: tuple[int, ...]
    clc_query_count_by_cta: tuple[int, ...]
    static_sass_sha256: str | None
    static_control_pc_count: int
    provenance: str
    cluster: SassClusterMetadata
    total_unique_global_load_sectors: int | None = None
    total_unique_global_store_sectors: int | None = None
    trace_sha256: str | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "model_id": self.model_id,
            "trace_sha256": self.trace_sha256,
            "binary_version": self.binary_version,
            "template_cta": list(self.template_cta),
            "cta_count": self.cta_count,
            "grid_shape": list(self.grid_shape),
            "num_warps": self.num_warps,
            "shared_bytes": self.shared_bytes,
            "registers_per_thread": self.registers_per_thread,
            "template_cycles": self.template_cycles,
            "template_instruction_count": self.template_instruction_count,
            "cta_cycles": list(self.cta_cycles),
            "cta_instruction_counts": list(self.cta_instruction_counts),
            "pipeline_instruction_counts": dict(self.pipeline_instruction_counts),
            "global_sector_requests": self.global_sector_requests,
            "l1_hit_sector_requests": self.l1_hit_sector_requests,
            "l2_sector_requests": self.l2_sector_requests,
            "shared_instruction_count": self.shared_instruction_count,
            "shared_bank_service_cycles": self.shared_bank_service_cycles,
            "shared_bank_replay_cycles": self.shared_bank_replay_cycles,
            "tma_bytes": self.tma_bytes,
            "total_global_load_sector_requests": self.total_global_load_sector_requests,
            "total_global_store_sector_requests": self.total_global_store_sector_requests,
            "total_unique_global_sectors": self.total_unique_global_sectors,
            "total_unique_global_load_sectors": self.total_unique_global_load_sectors,
            "total_unique_global_store_sectors": self.total_unique_global_store_sectors,
            "memory_sector_bytes": self.memory_sector_bytes,
            "total_tma_load_bytes": self.total_tma_load_bytes,
            "total_tma_store_bytes": self.total_tma_store_bytes,
            "total_tma_oob_bytes": self.total_tma_oob_bytes,
            "global_load_sector_requests_by_cta": list(self.global_load_sector_requests_by_cta),
            "global_store_sector_requests_by_cta": list(self.global_store_sector_requests_by_cta),
            "tma_load_bytes_by_cta": list(self.tma_load_bytes_by_cta),
            "tma_prefetch_load_bytes_by_cta": list(self.tma_prefetch_load_bytes_by_cta),
            "tma_store_bytes_by_cta": list(self.tma_store_bytes_by_cta),
            "clc_query_count_by_cta": list(self.clc_query_count_by_cta),
            "static_sass_sha256": self.static_sass_sha256,
            "static_control_pc_count": self.static_control_pc_count,
            "provenance": self.provenance,
            **self.cluster.to_dict(),
        }
