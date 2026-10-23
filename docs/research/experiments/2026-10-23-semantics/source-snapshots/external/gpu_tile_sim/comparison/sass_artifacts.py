"""Resolve hashed static-SASS artifacts paired with a dynamic trace case."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from pathlib import Path, PurePosixPath
from types import MappingProxyType

from gpu_tile_sim.comparison.sass_control import sass_function_names


def resolve_static_sass(
    artifact_root: Path,
    case: dict[str, object],
    kernel_name: str,
) -> Path:
    files = list(dict(dict(case["trace"])["compiler_artifacts"])["files"])
    candidates = []
    for raw in files:
        entry = dict(raw)
        declared = str(entry["path"])
        if not declared.endswith(".sass"):
            continue
        path = _local_path(artifact_root, declared)
        _validate_hash(path, str(entry["sha256"]))
        if kernel_name in sass_function_names(path):
            candidates.append(path)
    unique = tuple(dict.fromkeys(candidates))
    if len(unique) != 1:
        raise ValueError(
            f"expected one static SASS function for {kernel_name}, found {len(unique)}"
        )
    return unique[0]


def resolve_static_sass_optional(
    artifact_root: Path,
    case: dict[str, object],
    kernel_name: str,
    external_artifacts: Mapping[str, Path] | None = None,
) -> Path | None:
    """Return a matching hashed control-word artifact when the binary was retained."""

    compiler_artifacts = dict(case["trace"]).get("compiler_artifacts")
    files = [] if compiler_artifacts is None else list(dict(compiler_artifacts)["files"])
    candidates = []
    for raw in files:
        entry = dict(raw)
        declared = str(entry["path"])
        if not declared.endswith(".sass"):
            continue
        path = _local_path(artifact_root, declared)
        _validate_hash(path, str(entry["sha256"]))
        if kernel_name in sass_function_names(path):
            candidates.append(path)
    binary_sha256 = str(case["binary_sha256"])
    external = (external_artifacts or {}).get(binary_sha256)
    if external is not None and kernel_name in sass_function_names(external):
        candidates.append(external)
    unique = tuple(dict.fromkeys(candidates))
    if len(unique) > 1:
        raise ValueError(f"multiple static SASS functions match {kernel_name}")
    return None if not unique else unique[0]


def load_static_sass_artifacts(
    manifest_path: str | Path,
    *,
    repository_root: str | Path,
) -> Mapping[str, Path]:
    """Load exact-binary static SASS without consulting target-kernel timing."""

    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    if int(manifest.get("format", 0)) != 1:
        raise ValueError("unsupported static-SASS manifest format")
    if manifest.get("uses_target_kernel_latency") is not False:
        raise ValueError("static-SASS manifest must reject target-kernel latency")
    raw_artifacts = manifest.get("artifacts")
    if not isinstance(raw_artifacts, dict) or not raw_artifacts:
        raise ValueError("static-SASS manifest must contain artifacts")
    root = Path(repository_root)
    artifacts = {}
    for binary_sha256, raw_entry in raw_artifacts.items():
        if len(str(binary_sha256)) != 64:
            raise ValueError("static-SASS artifact has an invalid binary identity")
        entry = dict(raw_entry)
        path = root / str(entry.get("path", ""))
        _validate_hash(path, str(entry.get("sha256", "")))
        artifacts[str(binary_sha256)] = path
    return MappingProxyType(artifacts)


def _local_path(artifact_root: Path, declared: str) -> Path:
    source = PurePosixPath(declared)
    try:
        root_index = source.parts.index(artifact_root.name)
    except ValueError as exc:
        raise ValueError(f"static SASS path is outside artifact job: {declared}") from exc
    path = artifact_root.joinpath(*source.parts[root_index + 1 :])
    if not path.is_file():
        raise FileNotFoundError(path)
    return path


def _validate_hash(path: Path, expected: str) -> None:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != expected:
        raise ValueError(f"static SASS SHA-256 mismatch: {path}")
