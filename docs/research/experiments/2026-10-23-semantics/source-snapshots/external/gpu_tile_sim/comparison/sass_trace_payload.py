"""Decode instruction payloads from Accel-Sim/NVBit text traces."""

from __future__ import annotations

from dataclasses import dataclass, field

WARP_SIZE = 32
ADDRESS_LIST_ALL = 0
ADDRESS_BASE_STRIDE = 1
ADDRESS_BASE_DELTA = 2
TMA_ADDRESS_LIST_ALL = 3
TMA_ADDRESS_BASE_DELTA = 4
TMA_PREFIXES = (
    "UTMALDG",
    "UTMASTG",
    "UTMAPF",
    "UTMAREDG",
    "UBLKCP",
    "UBLKPF",
    "UBLKRED",
)


@dataclass(frozen=True, slots=True)
class SassParseContext:
    tracer_version: int
    shared_base_address: int | None
    local_base_address: int | None


@dataclass(frozen=True, slots=True)
class SassInstruction:
    """One dynamic instruction, including dependencies and asynchronous payload."""

    cta: tuple[int, int, int]
    warp_id: int
    pc: int
    active_mask: int
    destinations: tuple[str, ...]
    sources: tuple[str, ...]
    opcode: str
    memory_width_bytes: int
    memory_addresses: tuple[int, ...]
    destination_values: tuple[tuple[int, ...], ...] = field(default=(), compare=False)
    source_values: tuple[tuple[int, ...], ...] = field(default=(), compare=False)
    gmma_commit_group: bool = False
    tma_mbarrier_address: int | None = None
    tma_multicast_mask: int | None = None
    tma_byte_count: int = 0
    tma_oob_byte_count: int = 0
    immediate: int = 0
    immediate2: int = 0
    cluster_id: tuple[int, int, int] | None = None
    cluster_cta: tuple[int, int, int] | None = None
    cluster_rank: int | None = None
    # Explicit columns from a verified PTX/compiler footprint manifest. Existing
    # UTCATOMSWS register/immediate payloads do not expose a columns operand.
    tmem_columns: int | None = None

    @property
    def active_lanes(self) -> int:
        return self.active_mask.bit_count()

    @property
    def is_tma(self) -> bool:
        return self.opcode.startswith(TMA_PREFIXES)


def instruction_from_tokens(
    tokens: list[str],
    *,
    cta: tuple[int, int, int],
    warp_id: int,
    context: SassParseContext,
    cluster_id: tuple[int, int, int] | None = None,
    cluster_cta: tuple[int, int, int] | None = None,
    cluster_rank: int | None = None,
) -> SassInstruction:
    """Decode the exact field order used by Accel-Sim ``trace_parser.cc``."""

    pc = int(tokens[0], 16)
    active_mask = int(tokens[1], 16)
    destination_count = int(tokens[2])
    destinations = tuple(tokens[3 : 3 + destination_count])
    opcode_index = 3 + destination_count
    opcode = tokens[opcode_index].upper()
    source_count = int(tokens[opcode_index + 1])
    source_start = opcode_index + 2
    sources = tuple(tokens[source_start : source_start + source_count])
    cursor = source_start + source_count
    commit_group = False
    if "GMMA" in opcode:
        commit_group = bool(int(tokens[cursor]))
        cursor += 1
    memory_width = int(tokens[cursor])
    cursor += 1
    payload = _memory_payload(
        tokens,
        cursor=cursor,
        opcode=opcode,
        active_mask=active_mask,
        memory_width=memory_width,
    )
    immediate, immediate2, cursor = _immediates(tokens, payload.cursor, context.tracer_version)
    destination_values, source_values = _register_values(
        tokens,
        cursor=cursor,
        destination_count=destination_count,
        source_count=source_count,
        tracer_version=context.tracer_version,
    )
    return SassInstruction(
        cta=cta,
        warp_id=warp_id,
        pc=pc,
        active_mask=active_mask,
        destinations=destinations,
        sources=sources,
        opcode=opcode,
        memory_width_bytes=memory_width,
        memory_addresses=payload.addresses,
        destination_values=destination_values,
        source_values=source_values,
        gmma_commit_group=commit_group,
        tma_mbarrier_address=payload.tma_mbarrier_address,
        tma_multicast_mask=payload.tma_multicast_mask,
        tma_byte_count=payload.tma_byte_count,
        tma_oob_byte_count=payload.tma_oob_byte_count,
        immediate=immediate,
        immediate2=immediate2,
        cluster_id=cluster_id,
        cluster_cta=cluster_cta,
        cluster_rank=cluster_rank,
    )


@dataclass(frozen=True, slots=True)
class _MemoryPayload:
    cursor: int
    addresses: tuple[int, ...] = ()
    tma_mbarrier_address: int | None = None
    tma_multicast_mask: int | None = None
    tma_byte_count: int = 0
    tma_oob_byte_count: int = 0


def _memory_payload(
    tokens: list[str],
    *,
    cursor: int,
    opcode: str,
    active_mask: int,
    memory_width: int,
) -> _MemoryPayload:
    if opcode.startswith(TMA_PREFIXES):
        return _tma_payload(tokens, cursor=cursor, active_mask=active_mask)
    if memory_width == 0:
        return _MemoryPayload(cursor)
    address_mode = int(tokens[cursor])
    addresses, cursor = _normal_addresses(
        tokens,
        cursor=cursor + 1,
        address_mode=address_mode,
        active_mask=active_mask,
    )
    return _MemoryPayload(cursor, addresses)


def _normal_addresses(
    tokens: list[str], *, cursor: int, address_mode: int, active_mask: int
) -> tuple[tuple[int, ...], int]:
    active_count = active_mask.bit_count()
    if address_mode == ADDRESS_LIST_ALL:
        end = cursor + active_count
        return tuple(int(value, 16) for value in tokens[cursor:end]), end
    if address_mode == ADDRESS_BASE_STRIDE:
        base = int(tokens[cursor], 16)
        stride = int(tokens[cursor + 1])
        return tuple(base + index * stride for index in range(active_count)), cursor + 2
    if address_mode != ADDRESS_BASE_DELTA:
        raise ValueError(f"unsupported memory address mode: {address_mode}")
    if active_count == 0:
        return (), cursor
    base = int(tokens[cursor], 16)
    delta_end = cursor + active_count
    deltas = (int(value) for value in tokens[cursor + 1 : delta_end])
    addresses = [base]
    addresses.extend(_accumulated_addresses(base, deltas))
    return tuple(addresses), delta_end


def _tma_payload(tokens: list[str], *, cursor: int, active_mask: int) -> _MemoryPayload:
    mbarrier = int(tokens[cursor], 16)
    multicast = bool(int(tokens[cursor + 1]))
    cursor += 2
    multicast_mask = None
    if multicast:
        multicast_mask = int(tokens[cursor], 16)
        cursor += 1
    byte_count = int(tokens[cursor])
    oob_count = int(tokens[cursor + 1])
    address_mode = int(tokens[cursor + 2])
    cursor += 3
    addresses, cursor = _tma_addresses(
        tokens,
        cursor=cursor,
        address_mode=address_mode,
        active_mask=active_mask,
    )
    return _MemoryPayload(
        cursor,
        addresses,
        mbarrier,
        multicast_mask,
        byte_count,
        oob_count,
    )


def _tma_addresses(
    tokens: list[str], *, cursor: int, address_mode: int, active_mask: int
) -> tuple[tuple[int, ...], int]:
    if address_mode == TMA_ADDRESS_LIST_ALL:
        count = int(tokens[cursor])
        end = cursor + 1 + count
        return tuple(int(value, 16) for value in tokens[cursor + 1 : end]), end
    if address_mode != TMA_ADDRESS_BASE_DELTA:
        raise ValueError(f"unsupported TMA address mode: {address_mode}")
    base = int(tokens[cursor], 16)
    count = int(tokens[cursor + 1])
    end = cursor + 2 + max(0, count - 1)
    if count == 0 or active_mask == 0:
        return (), end
    deltas = (int(value) for value in tokens[cursor + 2 : end])
    return (base, *_accumulated_addresses(base, deltas)), end


def _accumulated_addresses(base: int, deltas: object) -> tuple[int, ...]:
    addresses = []
    current = base
    for delta in deltas:
        current += int(delta)
        addresses.append(current)
    return tuple(addresses)


def _immediates(tokens: list[str], cursor: int, tracer_version: int) -> tuple[int, int, int]:
    immediate = _integer(tokens[cursor]) if cursor < len(tokens) else 0
    cursor += 1
    immediate2 = _integer(tokens[cursor]) if tracer_version >= 6 and cursor < len(tokens) else 0
    cursor += int(tracer_version >= 6 and cursor < len(tokens))
    return immediate, immediate2, cursor


def _register_values(
    tokens: list[str],
    *,
    cursor: int,
    destination_count: int,
    source_count: int,
    tracer_version: int,
) -> tuple[tuple[tuple[int, ...], ...], tuple[tuple[int, ...], ...]]:
    if tracer_version < 6 or cursor >= len(tokens):
        return (), ()
    marker = tokens[cursor]
    if marker == "NoVal":
        if cursor + 1 != len(tokens):
            raise ValueError("unexpected payload after NoVal marker")
        return (), ()
    if marker != "Val":
        raise ValueError(f"invalid register-value marker: {marker}")
    values, cursor = _value_groups(
        tokens, cursor=cursor + 1, count=destination_count + source_count
    )
    if cursor != len(tokens):
        raise ValueError("unexpected trailing register-value payload")
    return values[:destination_count], values[destination_count:]


def _value_groups(
    tokens: list[str], *, cursor: int, count: int
) -> tuple[tuple[tuple[int, ...], ...], int]:
    groups = []
    for _ in range(count):
        if cursor >= len(tokens):
            raise ValueError("missing register-value lane count")
        width = int(tokens[cursor])
        if width not in (1, WARP_SIZE):
            raise ValueError(f"invalid register-value lane count: {width}")
        end = cursor + 1 + width
        if end > len(tokens):
            raise ValueError("truncated register-value lane payload")
        groups.append(tuple(int(value, 16) for value in tokens[cursor + 1 : end]))
        cursor = end
    return tuple(groups), cursor


def _integer(value: str) -> int:
    return int(value, 16) if value.lower().startswith("0x") else int(value)
