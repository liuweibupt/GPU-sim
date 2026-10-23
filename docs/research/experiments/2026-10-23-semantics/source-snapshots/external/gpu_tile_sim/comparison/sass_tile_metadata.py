"""Recover launch and tile metadata from Accel-Sim SASS trace headers."""

from __future__ import annotations

import re

MANGLED_TILE_PATTERN = re.compile(
    r"MmaMultistage.*?GemmShapeILi(?P<m>\d+)ELi(?P<n>\d+)ELi(?P<k>\d+)EEE"
)
MANGLED_STAGE_PATTERN = re.compile(r"ELi(?P<stages>\d+)ELNS\w+_23SharedMemoryClearOption")
SHORT_KERNEL_PATTERN = re.compile(r"_(?P<m>\d+)x(?P<n>\d+).*?_stages_(?P<k>\d+)x(?P<stages>\d+)_")
XMMA_TILE_PATTERN = re.compile(r"_tilesize(?P<m>\d+)x(?P<n>\d+)x(?P<k>\d+)_stage(?P<stages>\d+)_")
CUTLASS_NAMED_TILE_PATTERN = re.compile(
    r"gemm(?:_relu)?_f(?:16|32|64).*?_(?P<m>\d+)x(?P<n>\d+)_"
    r"(?P<k>\d+)x(?P<stages>\d+)_"
)


def resolve_tile(
    kernel_name: str,
    *,
    tile_m: int | None,
    tile_n: int | None,
    tile_k: int | None,
    num_stages: int | None,
    require_tile: bool,
) -> tuple[int | None, int | None, int | None, int | None]:
    supplied = (tile_m, tile_n, tile_k, num_stages)
    try:
        parsed = _kernel_tile(kernel_name)
    except ValueError:
        if any(value is None for value in supplied):
            if require_tile:
                raise
            return (None, None, None, None)
        parsed = tuple(int(value) for value in supplied if value is not None)
    else:
        if any(value is not None for value in supplied):
            expected = tuple(
                parsed[index] if value is None else int(value)
                for index, value in enumerate(supplied)
            )
            if parsed != expected:
                raise ValueError(
                    f"trace kernel tile {parsed} disagrees with supplied tile {expected}"
                )
    if any(value is not None and value <= 0 for value in parsed):
        raise ValueError(f"tile schedule must be positive: {parsed}")
    return parsed


def dimensions(header: str, name: str) -> tuple[int, int, int]:
    match = re.search(rf"^-{name} dim = \((\d+),(\d+),(\d+)\)$", header, re.MULTILINE)
    if match is None:
        raise ValueError(f"missing {name} dimensions")
    return tuple(int(value) for value in match.groups())


def int_field(header: str, name: str) -> int:
    return int(text_field(header, name))


def text_field(header: str, name: str) -> str:
    match = re.search(rf"^-{re.escape(name)} = (.+)$", header, re.MULTILINE)
    if match is None:
        raise ValueError(f"missing trace header field: {name}")
    return match.group(1).strip()


def optional_hex_field(header: str, name: str) -> int | None:
    match = re.search(rf"^-{re.escape(name)} = (0x[0-9a-fA-F]+)$", header, re.MULTILINE)
    return None if match is None else int(match.group(1), 16)


def _kernel_tile(kernel_name: str) -> tuple[int, int, int, int]:
    tile_match = MANGLED_TILE_PATTERN.search(kernel_name)
    stage_match = MANGLED_STAGE_PATTERN.search(kernel_name)
    if tile_match is not None and stage_match is not None:
        return (
            int(tile_match.group("m")),
            int(tile_match.group("n")),
            int(tile_match.group("k")),
            int(stage_match.group("stages")),
        )
    for pattern in (SHORT_KERNEL_PATTERN, XMMA_TILE_PATTERN, CUTLASS_NAMED_TILE_PATTERN):
        match = pattern.search(kernel_name)
        if match is not None:
            return tuple(int(match.group(key)) for key in ("m", "n", "k", "stages"))
    raise ValueError(f"cannot recover CUTLASS tile schedule from kernel: {kernel_name}")
