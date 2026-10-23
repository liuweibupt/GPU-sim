"""Explicit, source-bound TMEM column footprints for register-only SASS traces.

UTCATOMSWS register operands in existing NoVal traces do not directly encode a
PTX columns operand. This manifest is an explicit compiler/ISA evidence input;
it must not be represented as measured device capacity or an inferred default.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from types import MappingProxyType

from gpu_tile_sim.comparison.sass_async_services import TMEM_ALLOC_PREFIXES, TMEM_FREE_PREFIXES
from gpu_tile_sim.comparison.sass_control import parse_sass_control_schedule
from gpu_tile_sim.comparison.sass_execution_instruction import ExecutionInstruction
from gpu_tile_sim.comparison.sass_trace import parse_sass_trace_schedule


@dataclass(frozen=True, slots=True)
class TmemFootprintManifest:
    trace_sha256: str
    static_sass_sha256: str
    kernel_name: str
    provenance: str
    columns_by_site: Mapping[tuple[int, str], int]

    def __post_init__(self) -> None:
        object.__setattr__(self, "columns_by_site", MappingProxyType(dict(self.columns_by_site)))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_tmem_footprint_manifest(
    path: str | Path,
    *,
    trace_path: str | Path,
    static_sass_path: str | Path,
) -> TmemFootprintManifest:
    """Verify a footprint manifest against the exact dynamic/static source pair."""

    payload = json.loads(Path(path).read_text())
    if payload.get("format") != "ysim-tmem-footprints-v1":
        raise ValueError("unsupported TMEM footprint manifest format")
    trace = Path(trace_path)
    static = Path(static_sass_path)
    for field, source in (("trace_sha256", trace), ("static_sass_sha256", static)):
        if payload.get(field) != _sha256(source):
            raise ValueError(f"TMEM footprint manifest {field} does not match source")
    kernel_name = parse_sass_trace_schedule(trace, require_tile=False).kernel_name
    if payload.get("kernel_name") != kernel_name:
        raise ValueError("TMEM footprint manifest kernel_name does not match trace")
    provenance = payload.get("provenance")
    if not isinstance(provenance, str) or not provenance.strip():
        raise ValueError("TMEM footprint manifest requires explicit compiler/ISA provenance")
    sites: dict[tuple[int, str], int] = {}
    for entry in payload.get("footprints", ()):
        pc_value = entry["pc"]
        pc = int(pc_value, 0) if isinstance(pc_value, str) else pc_value
        opcode = entry["opcode"]
        columns = entry["columns"]
        if isinstance(pc, bool) or not isinstance(pc, int) or pc < 0:
            raise ValueError("TMEM footprint PC must be a non-negative instruction address")
        if not isinstance(opcode, str) or not opcode.startswith(
            (*TMEM_ALLOC_PREFIXES, *TMEM_FREE_PREFIXES)
        ):
            raise ValueError("TMEM footprint entries must identify allocation/free opcodes")
        if isinstance(columns, bool) or not isinstance(columns, int) or columns <= 0:
            raise ValueError("TMEM footprint columns must be a positive integer")
        if columns not in {32, 64, 128, 256, 512}:
            raise ValueError(
                "SM100/SM103 TMEM footprint must use a legal PTX column count: "
                "32, 64, 128, 256, or 512"
            )
        key = (pc, opcode)
        if key in sites:
            raise ValueError(f"duplicate TMEM footprint for PC 0x{pc:x}")
        sites[key] = columns
    if not sites:
        raise ValueError("TMEM footprint manifest has no allocation/free sites")
    dynamic_sites: dict[int, frozenset[str]] = {}
    for pc, opcode in sites:
        dynamic_sites[pc] = dynamic_sites.get(pc, frozenset()) | frozenset({opcode})
    schedule = parse_sass_control_schedule(static, kernel_name, dynamic_sites=dynamic_sites)
    for pc, opcode in sites:
        schedule.entry(pc, opcode)
    return TmemFootprintManifest(
        payload["trace_sha256"], payload["static_sass_sha256"], kernel_name, provenance, sites
    )


def bind_tmem_footprints(
    warps: Mapping[int, tuple[ExecutionInstruction, ...]],
    manifest: TmemFootprintManifest,
) -> dict[int, tuple[ExecutionInstruction, ...]]:
    """Attach only verified lifecycle footprints, rejecting every uncovered site."""

    def bind(instruction: ExecutionInstruction) -> ExecutionInstruction:
        if not instruction.opcode.startswith((*TMEM_ALLOC_PREFIXES, *TMEM_FREE_PREFIXES)):
            return instruction
        key = (instruction.pc, instruction.opcode)
        if key not in manifest.columns_by_site:
            raise ValueError(
                f"TMEM footprint manifest does not cover {instruction.opcode} at "
                f"PC {instruction.pc!r}"
            )
        columns = manifest.columns_by_site[key]
        if instruction.tmem_columns is not None and instruction.tmem_columns != columns:
            raise ValueError(
                "TMEM footprint manifest disagrees with existing instruction footprint"
            )
        return replace(instruction, tmem_columns=columns)

    return {
        warp: tuple(bind(instruction) for instruction in stream)
        for warp, stream in warps.items()
    }
