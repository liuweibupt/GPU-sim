"""Parse compiler-scheduled issue stalls and dependency barriers from NVIDIA SASS."""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from types import MappingProxyType

FUNCTION_PATTERN = re.compile(r"^\s*Function : (?P<name>.+?)\s*$")
INSTRUCTION_PATTERN = re.compile(
    r"^\s*/\*(?P<pc>[0-9a-fA-F]+)\*/\s+(?:@!?[UP]?P(?:T|\d+)\s+)?"
    r"(?P<opcode>[A-Za-z][A-Za-z0-9_.]*)"
)
CONTROL_WORD_PATTERN = re.compile(r"/\*\s*0x(?P<word>[0-9a-fA-F]{16})\s*\*/")
STALL_SHIFT = 41
CONTROL_MASK = 0x1FFFF
STALL_MASK = 0xF
WRITE_BARRIER_SHIFT = 5
READ_BARRIER_SHIFT = 8
WAIT_BARRIER_SHIFT = 11
BARRIER_MASK = 0x7
WAIT_BARRIER_MASK = 0x3F
UNUSED_BARRIER = 0x7
SASS_INSTRUCTION_BYTES = 16


@dataclass(frozen=True, slots=True)
class StaticControlEntry:
    opcode: str
    issue_delay_cycles: int
    wait_barriers: tuple[int, ...]
    read_barrier: int | None
    write_barrier: int | None


@dataclass(frozen=True, slots=True)
class SassControlSchedule:
    source_path: str
    source_sha256: str
    kernel_name: str
    entries: MappingProxyType[int, StaticControlEntry]

    def entry(self, pc: int, opcode: str) -> StaticControlEntry:
        try:
            entry = self.entries[pc]
        except KeyError as exc:
            if opcode == "NOP" and pc == max(self.entries) + SASS_INSTRUCTION_BYTES:
                # NVBit emits one aligned terminal NOP beyond cuobjdump's function body.
                return StaticControlEntry("NOP", 1, (), None, None)
            raise ValueError(f"static SASS has no control word for PC 0x{pc:x}") from exc
        if _hardware_opcode(entry.opcode) != _hardware_opcode(opcode):
            raise ValueError(
                f"static/dynamic SASS mismatch at 0x{pc:x}: {entry.opcode} != {opcode}"
            )
        return entry

    def issue_delay(self, pc: int, opcode: str) -> int:
        return self.entry(pc, opcode).issue_delay_cycles


def parse_sass_control_schedule(
    path: str | Path,
    kernel_name: str,
    *,
    dynamic_sites: Mapping[int, frozenset[str]] | None = None,
) -> SassControlSchedule:
    source = Path(path)
    candidates = _parse_control_candidates(source, kernel_name)
    entries = _select_control_candidate(candidates, dynamic_sites, source)
    return SassControlSchedule(
        str(source), _sha256(source), kernel_name, MappingProxyType(dict(entries))
    )


@cache
def _parse_control_candidates(
    source: Path, kernel_name: str
) -> tuple[MappingProxyType[int, StaticControlEntry], ...]:
    candidates: list[MappingProxyType[int, StaticControlEntry]] = []
    entries: dict[int, StaticControlEntry] = {}
    active = False
    pending: tuple[int, str] | None = None
    for line in source.read_text(errors="replace").splitlines():
        function = FUNCTION_PATTERN.match(line)
        if function is not None:
            if active:
                _append_candidate(candidates, entries)
            active = function.group("name") == kernel_name
            entries = {}
            pending = None
            continue
        if not active:
            continue
        pending = _parse_control_line(line, pending, entries)
    if active:
        _append_candidate(candidates, entries)
    if not candidates:
        raise ValueError(f"static SASS has no function named {kernel_name}: {source}")
    return tuple(candidates)


def _parse_control_line(
    line: str,
    pending: tuple[int, str] | None,
    entries: dict[int, StaticControlEntry],
) -> tuple[int, str] | None:
    instruction = INSTRUCTION_PATTERN.match(line)
    if instruction is not None:
        return int(instruction.group("pc"), 16), instruction.group("opcode").upper()
    control = CONTROL_WORD_PATTERN.search(line)
    if control is None or pending is None:
        return pending
    pc, opcode = pending
    entry = _decode_control_entry(opcode, int(control.group("word"), 16))
    previous = entries.setdefault(pc, entry)
    if previous != entry:
        raise ValueError(f"conflicting static SASS control words at PC 0x{pc:x}")
    return None


def _append_candidate(
    candidates: list[MappingProxyType[int, StaticControlEntry]],
    entries: dict[int, StaticControlEntry],
) -> None:
    if entries:
        candidates.append(MappingProxyType(dict(entries)))


def _select_control_candidate(
    candidates: tuple[MappingProxyType[int, StaticControlEntry], ...],
    dynamic_sites: Mapping[int, frozenset[str]] | None,
    source: Path,
) -> MappingProxyType[int, StaticControlEntry]:
    if len(candidates) == 1:
        return candidates[0]
    if dynamic_sites is None:
        raise ValueError(f"static SASS has multiple matching functions: {source}")
    matches = tuple(
        candidate
        for candidate in candidates
        if _candidate_matches_dynamic_sites(candidate, dynamic_sites)
    )
    if not matches:
        raise ValueError(f"no static SASS variant matches dynamic instruction sites: {source}")
    signatures = {_dynamic_control_signature(candidate, dynamic_sites) for candidate in matches}
    if len(signatures) != 1:
        raise ValueError(f"multiple static SASS variants match with different controls: {source}")
    return matches[0]


def _candidate_matches_dynamic_sites(
    candidate: Mapping[int, StaticControlEntry],
    dynamic_sites: Mapping[int, frozenset[str]],
) -> bool:
    terminal_pc = max(candidate) + SASS_INSTRUCTION_BYTES
    for pc, opcodes in dynamic_sites.items():
        if pc == terminal_pc and opcodes == frozenset({"NOP"}):
            continue
        entry = candidate.get(pc)
        if entry is None:
            return False
        if any(_hardware_opcode(entry.opcode) != _hardware_opcode(opcode) for opcode in opcodes):
            return False
    return True


def _dynamic_control_signature(
    candidate: Mapping[int, StaticControlEntry],
    dynamic_sites: Mapping[int, frozenset[str]],
) -> tuple[tuple[int, StaticControlEntry | None], ...]:
    return tuple((pc, candidate.get(pc)) for pc in sorted(dynamic_sites))


def _decode_control_entry(opcode: str, word: int) -> StaticControlEntry:
    control = (word >> STALL_SHIFT) & CONTROL_MASK
    wait_mask = (control >> WAIT_BARRIER_SHIFT) & WAIT_BARRIER_MASK
    read_barrier = (control >> READ_BARRIER_SHIFT) & BARRIER_MASK
    write_barrier = (control >> WRITE_BARRIER_SHIFT) & BARRIER_MASK
    return StaticControlEntry(
        opcode=opcode,
        # SASS S01 permits the next issue in the following cycle.  The replay
        # loop already advances after issue, so adding another baseline cycle
        # would make every dynamic loop iteration one cycle too long.
        issue_delay_cycles=max(1, control & STALL_MASK),
        wait_barriers=tuple(barrier for barrier in range(6) if wait_mask & (1 << barrier)),
        read_barrier=None if read_barrier == UNUSED_BARRIER else read_barrier,
        write_barrier=None if write_barrier == UNUSED_BARRIER else write_barrier,
    )


def _hardware_opcode(opcode: str) -> str:
    # Dynamic spin-loop normalization replaces repeated non-blocking TRYWAIT
    # instructions with one blocking SIM_WAIT at the same hardware site.
    return opcode.removesuffix(".TRYWAIT").removesuffix(".SIM_WAIT")


@cache
def sass_function_names(path: str | Path) -> frozenset[str]:
    return frozenset(
        match.group("name")
        for line in Path(path).read_text(errors="replace").splitlines()
        if (match := FUNCTION_PATTERN.match(line)) is not None
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
