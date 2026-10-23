#!/usr/bin/env python3
"""Derive compile-time evidence toggles from the immutable audited SM89 kernel."""
import argparse
import hashlib
from pathlib import Path

PINNED = "99f8a78d3f9fdc932fdbc83acc85b6d5ea847c3d59cf7f0be00bc8f114395f29"


def derive(raw):
    if hashlib.sha256(raw).hexdigest() != PINNED:
        raise ValueError("frozen version_probe.cu contract changed")
    text = raw.decode().split("template <typename T> static void print_array", 1)[0]
    replacements = [
        ("__device__ void emit(", "__device__ void cost_emit("),
        ("__global__ void version_probe(", "template <bool Record>\n__global__ void cost_version_probe("),
        ("      emit(", "      if constexpr (Record) cost_emit("),
        ("  if (thread == 0) tags[0] = tags[1] = -1;", "  if constexpr (Record) if (thread == 0) tags[0] = tags[1] = -1;"),
        ("      tags[write_slot] = generation;", "      if constexpr (Record) tags[write_slot] = generation;"),
        ("      observed = tags[read_slot];", "      if constexpr (Record) observed = tags[read_slot];"),
        ("        observed_tags[generation * count + index] = observed;", "        if constexpr (Record) observed_tags[generation * count + index] = observed;"),
    ]
    for old, new in replacements:
        expected = 5 if old == "      emit(" else 1
        if text.count(old) != expected:
            raise ValueError(f"unexpected source sites for {old}: {text.count(old)}")
        text = text.replace(old, new)
    return ("// Generated only by prepare-version-kernel.py. Source SHA256: " + PINNED + "\n" + text).encode()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.write_bytes(derive(args.source.read_bytes()))
