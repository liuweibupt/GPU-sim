"""Classify SASS instructions and derive architecture-local service costs."""

from __future__ import annotations

import re
from collections import defaultdict
from math import ceil
from types import MappingProxyType

from gpu_tile_sim.comparison.sass_trace_payload import SassInstruction
from gpu_tile_sim.hardware.sass_spec import (
    InstructionTiming,
    PipelineKind,
    SassExecutionSpec,
)

GLOBAL_PREFIXES = ("LDG", "STG", "LD.", "ST.", "ATOM", "RED")
SHARED_PREFIXES = ("LDS", "STS", "LDSM", "STSM")
MATRIX_PREFIXES = ("HMMA", "MMA", "IMMA", "BMMA")
TCGEN_PREFIXES = ("UTCHMMA", "TCGEN05.MMA")
TMEM_PREFIXES = (
    "LDTM",
    "UTCATOMSWS",
    "UTCLOAD",
    "UTCSTORE",
    "UTCCP",
    "TCGEN05.LD",
    "TCGEN05.ST",
    "TCGEN05.CP",
)
CONTROL_PREFIXES = ("BRA", "BRX", "BREAK", "EXIT", "NANOSLEEP", "BAR", "BSYNC", "WARPSYNC")
FLOAT_ALU_PREFIXES = ("F", "HADD", "HFMA", "HMUL", "HSET", "DADD", "DMUL", "DSET")
PIPELINE_PREFIX_GROUPS = (
    (TCGEN_PREFIXES, PipelineKind.TCGEN),
    (TMEM_PREFIXES, PipelineKind.TMEM),
    (("HGMMA", "QGMMA", "IGMMA", "WGMMA"), PipelineKind.GMMA),
    (MATRIX_PREFIXES, PipelineKind.TENSOR),
    (("MUFU",), PipelineKind.SFU),
    ((*GLOBAL_PREFIXES, *SHARED_PREFIXES, "UTMA", "UBLK"), PipelineKind.MEMORY),
    (("SYNCS", "DEPBAR", "LDGDEPBAR", "ARRIVES", "FENCE"), PipelineKind.MEMORY),
    ((*CONTROL_PREFIXES, "WARPGROUP"), PipelineKind.CONTROL),
)
GMMA_SHAPE_PATTERN = re.compile(r"^[A-Z]*GMMA\.(?P<m>\d+)[Xx](?P<n>\d+)[Xx](?P<k>\d+)")
REGISTER_PATTERN = re.compile(r"(?P<prefix>[A-Z]+)(?P<index>\d+)$")
GMMA_SMALL_N_TIMING = MappingProxyType({56: 56, 40: 20, 32: 24, 24: 12, 16: 20, 8: 18})


def pipeline_kind(opcode: str) -> PipelineKind:
    for prefixes, kind in PIPELINE_PREFIX_GROUPS:
        if opcode.startswith(prefixes):
            return kind
    if ".F64" in opcode:
        return PipelineKind.DOUBLE
    if opcode.startswith(FLOAT_ALU_PREFIXES):
        return PipelineKind.ALU
    return PipelineKind.INTEGER


def instruction_timing(
    instruction: SassInstruction,
    kind: PipelineKind,
    spec: SassExecutionSpec,
    *,
    global_l1_hit: bool,
) -> InstructionTiming:
    if instruction.opcode.startswith("UTCATOMSWS.FIND_AND_SET"):
        return _blocking_tmem_timing(spec.tmem_allocate_cycles, spec)
    if instruction.opcode.startswith("UTCATOMSWS.AND"):
        return _blocking_tmem_timing(spec.tmem_deallocate_cycles, spec)
    if instruction.opcode.startswith("SYNCS") and spec.mbarrier_cycles > 0:
        return InstructionTiming(spec.mbarrier_cycles, 1)
    if kind is PipelineKind.GMMA:
        return _gmma_timing(instruction.opcode)
    if instruction.opcode.startswith("MUFU.EX2"):
        base = spec.timings[PipelineKind.SFU]
        return InstructionTiming(
            base.latency_cycles,
            ceil(base.initiation_cycles / spec.exp2_throughput_multiplier),
        )
    if instruction.opcode.startswith(("LDS", "LDSM")):
        return InstructionTiming(spec.shared_latency_cycles, 1)
    if instruction.opcode.startswith(("LDG", "LD.")):
        latency = spec.l1_hit_latency_cycles if global_l1_hit else spec.dependent_l2_latency_cycles
        return InstructionTiming(latency, 1)
    if instruction.opcode.startswith(("STG", "ST.", "ATOM", "RED")):
        return InstructionTiming(spec.dependent_l2_latency_cycles, 1)
    if instruction.opcode.startswith(("LDC", "ULDC")):
        return InstructionTiming(spec.constant_latency_cycles, 1)
    return spec.timings[kind]


def _blocking_tmem_timing(cycles: int, spec: SassExecutionSpec) -> InstructionTiming:
    if cycles <= 0:
        return spec.timings[PipelineKind.TMEM]
    return InstructionTiming(cycles, cycles)


def expanded_destinations(instruction: SassInstruction) -> tuple[str, ...]:
    count = _implicit_register_count(instruction.opcode)
    return tuple(
        expanded
        for destination in instruction.destinations
        for expanded in _register_range(destination, count)
    )


def global_sectors(instruction: SassInstruction, sector_bytes: int) -> frozenset[int]:
    if instruction.opcode.startswith(("ATOMS", "REDUX")):
        return frozenset()
    if instruction.is_tma or not instruction.opcode.startswith(GLOBAL_PREFIXES):
        return frozenset()
    width = max(1, instruction.memory_width_bytes)
    return frozenset(
        sector
        for address in instruction.memory_addresses
        for sector in range(address // sector_bytes, (address + width - 1) // sector_bytes + 1)
    )


def shared_bank_service(instruction: SassInstruction, spec: SassExecutionSpec) -> int:
    if not instruction.opcode.startswith(SHARED_PREFIXES):
        return 0
    if not instruction.memory_addresses:
        return 1
    words_by_bank: dict[int, set[int]] = defaultdict(set)
    for address in instruction.memory_addresses:
        word = address // spec.shared_word_bytes
        words_by_bank[word % spec.shared_bank_count].add(word)
    return max((len(words) for words in words_by_bank.values()), default=1)


def is_blocking_tma_wait(opcode: str) -> bool:
    return opcode.startswith("SYNCS.PHASECHK.TRANS64.SIM_WAIT")


def _gmma_timing(opcode: str) -> InstructionTiming:
    match = GMMA_SHAPE_PATTERN.match(opcode)
    if match is None:
        raise ValueError(f"cannot recover GMMA shape from opcode: {opcode}")
    n = int(match.group("n"))
    cycles = n // 2 if n >= 64 else GMMA_SMALL_N_TIMING.get(n)
    if cycles is None:
        raise ValueError(f"unsupported Hopper GMMA N dimension: {n}")
    return InstructionTiming(cycles, cycles)


def _implicit_register_count(opcode: str) -> int:
    tmem_load = re.match(r"^LDTM\.X(?P<count>\d+)", opcode)
    if tmem_load is not None:
        return int(tmem_load.group("count"))
    gmma = GMMA_SHAPE_PATTERN.match(opcode)
    if gmma is not None:
        return int(gmma.group("n")) // 2
    if opcode.startswith("LDSM"):
        match = re.search(r"M(?:T)?88\.(\d+)", opcode)
        return 1 if match is None else int(match.group(1))
    if opcode.startswith(MATRIX_PREFIXES):
        return 4
    if opcode.startswith(("SHF", "USHF", "SYNCS")):
        # U64 names the concatenated shift input, not a vector destination.
        # SYNCS.EXCH.64 likewise returns one uniform register (including UR63,
        # where widening would invent the nonexistent UR64).
        return 1
    if any(token in opcode for token in (".128", ".U128")):
        return 4
    if any(token in opcode for token in (".64", ".U64")):
        return 2
    return 1


def _register_range(register: str, count: int) -> tuple[str, ...]:
    match = REGISTER_PATTERN.match(register)
    if match is None:
        return (register,)
    prefix = match.group("prefix")
    start = int(match.group("index"))
    return tuple(f"{prefix}{start + offset}" for offset in range(count))
