"""Normalize hardware-dependent dynamic polling before functional replay."""

from __future__ import annotations

from dataclasses import replace

from gpu_tile_sim.comparison.sass_trace_payload import SassInstruction

SPIN_BODY_SEARCH_LIMIT = 12
SLOW_PATH_PREFIX_LIMIT = 8


def canonicalize_spin_loops(
    stream: tuple[SassInstruction, ...],
) -> tuple[SassInstruction, ...]:
    """Replace repeated mbarrier polling with one functional TRYWAIT.

    Raw NVBit traces contain the number of polling iterations taken on the
    collection GPU. Replaying those iterations would leak measured timing into
    the simulator and double-count the wait. Accel-Sim's mark-region mode keeps
    one loop body and replays it from simulated mbarrier state; this compact
    envelope emits the equivalent single blocking TRYWAIT.
    """

    repeated = _collapse_repeated_spin_loops(_merge_clc_callbacks(stream))
    return _remove_slow_retry_paths(repeated)


def _merge_clc_callbacks(
    stream: tuple[SassInstruction, ...],
) -> tuple[SassInstruction, ...]:
    """Merge NVBit's response-address and mbarrier callbacks for one CLC issue."""

    merged: list[SassInstruction] = []
    for instruction in stream:
        if not merged or not _same_clc_site(merged[-1], instruction):
            merged.append(instruction)
            continue
        previous = merged[-1]
        addresses = tuple(
            dict.fromkeys((*previous.memory_addresses, *instruction.memory_addresses))
        )
        merged[-1] = replace(previous, memory_addresses=addresses)
    return tuple(merged)


def _collapse_repeated_spin_loops(
    stream: tuple[SassInstruction, ...],
) -> tuple[SassInstruction, ...]:
    normalized: list[SassInstruction] = []
    position = 0
    while position < len(stream):
        loop = _spin_loop_at(stream, position)
        if loop is None:
            normalized.append(stream[position])
            position += 1
            continue
        normalized.append(_functional_wait(stream[position]))
        position = loop
    return tuple(normalized)


def _remove_slow_retry_paths(
    stream: tuple[SassInstruction, ...],
) -> tuple[SassInstruction, ...]:
    normalized: list[SassInstruction] = []
    position = 0
    while position < len(stream):
        instruction = stream[position]
        origin = _retry_origin(normalized, instruction)
        if origin is None:
            normalized.append(instruction)
            position += 1
            continue
        del normalized[origin + 1 :]
        position += 1
        while position < len(stream) and _is_retry_control(stream[position]):
            position += 1
    return tuple(normalized)


def _retry_origin(normalized: list[SassInstruction], instruction: SassInstruction) -> int | None:
    key = _wait_key(instruction)
    if key is None:
        return None
    start = max(0, len(normalized) - SLOW_PATH_PREFIX_LIMIT)
    for position in range(len(normalized) - 1, start - 1, -1):
        if _wait_key(normalized[position]) != key:
            continue
        suffix = normalized[position + 1 :]
        if any(_is_wait(item) for item in suffix):
            return None
        return position if any(item.opcode.startswith("BRA") for item in suffix) else None
    return None


def _wait_key(instruction: SassInstruction) -> tuple[int, int] | None:
    if not _is_wait(instruction) or not instruction.memory_addresses:
        return None
    if len(instruction.source_values) < 2 or not instruction.source_values[1]:
        return None
    phase = (int(instruction.source_values[1][0]) >> 31) & 1
    return instruction.memory_addresses[0], phase


def _is_retry_control(instruction: SassInstruction) -> bool:
    return instruction.opcode.startswith(("NANOSLEEP", "SYNCS.PHASECHK", "BRA"))


def _functional_wait(instruction: SassInstruction) -> SassInstruction:
    # PHASECHK/TRYWAIT itself is a non-blocking predicate query. Only a
    # dynamically observed polling loop represents a blocking dependency.
    return replace(instruction, opcode="SYNCS.PHASECHK.TRANS64.SIM_WAIT")


def _spin_loop_at(stream: tuple[SassInstruction, ...], start: int) -> int | None:
    instruction = stream[start]
    if not _is_wait(instruction):
        return None
    recurrence = _next_same_pc(stream, start)
    if recurrence is None or not _is_spin_body(stream[start:recurrence]):
        return None
    signature = _pc_signature(stream[start:recurrence])
    cursor = recurrence
    while _matches_at(stream, cursor, signature):
        cursor += len(signature)
    if cursor < len(stream) and _same_instruction_site(stream[cursor], instruction):
        cursor += 1
    return cursor


def _next_same_pc(stream: tuple[SassInstruction, ...], start: int) -> int | None:
    stop = min(len(stream), start + SPIN_BODY_SEARCH_LIMIT + 1)
    for position in range(start + 1, stop):
        if _same_instruction_site(stream[position], stream[start]):
            return position
    return None


def _is_spin_body(body: tuple[SassInstruction, ...]) -> bool:
    return (
        any(item.opcode.startswith("NANOSLEEP") for item in body)
        and any(item.opcode.startswith("BRA") for item in body)
        and any(_is_wait(item) for item in body)
    )


def _matches_at(
    stream: tuple[SassInstruction, ...],
    start: int,
    signature: tuple[tuple[int, str], ...],
) -> bool:
    stop = start + len(signature)
    return stop <= len(stream) and _pc_signature(stream[start:stop]) == signature


def _pc_signature(
    stream: tuple[SassInstruction, ...],
) -> tuple[tuple[int, str], ...]:
    return tuple((item.pc, item.opcode) for item in stream)


def _same_instruction_site(left: SassInstruction, right: SassInstruction) -> bool:
    return left.pc == right.pc and left.opcode == right.opcode


def _same_clc_site(left: SassInstruction, right: SassInstruction) -> bool:
    return (
        left.opcode.startswith("UGETNEXTWORKID")
        and right.opcode.startswith("UGETNEXTWORKID")
        and _same_instruction_site(left, right)
    )


def _is_wait(instruction: SassInstruction) -> bool:
    return instruction.opcode.startswith("SYNCS.PHASECHK.TRANS64")
