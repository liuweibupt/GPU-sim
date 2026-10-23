"""Explicit profiler environment and exact-value publication checks.

Reports contain key names and file paths only, never credential values/snippets.
"""
import gzip
import json
import os
from pathlib import Path
import re

SENSITIVE_NAME = re.compile(r"token|secret|api[_-]?key|password|passwd|credential|authorization|access[_-]?key|private[_-]?key", re.I)
ENV_ALLOWLIST = ("PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "LD_LIBRARY_PATH",
                 "CUDA_VISIBLE_DEVICES", "CUDA_DEVICE_ORDER", "NVIDIA_VISIBLE_DEVICES", "NVIDIA_DRIVER_CAPABILITIES")


def sensitive_values(environment=None):
    environment = os.environ if environment is None else environment
    return {key: value.encode() for key, value in environment.items() if value and SENSITIVE_NAME.search(key)}


def matches(raw, values=None):
    values = sensitive_values() if values is None else values
    hits, layer = [], 0
    while True:
        keys = sorted(key for key, value in values.items() if value in raw)
        if keys:
            hits.append({"layer": layer, "keys": keys})
        if not raw.startswith(b'\x1f\x8b'):
            break
        if layer >= 8:
            raise ValueError("gzip nesting exceeds publication scan bound")
        raw = gzip.decompress(raw)
        layer += 1
    return hits


def profiler_environment(scratch, environment=None):
    environment = os.environ if environment is None else environment
    values = sensitive_values(environment)
    clean = {key: environment[key] for key in ENV_ALLOWLIST if key in environment}
    clean.setdefault("PATH", "/usr/local/cuda-13.1/bin:/usr/local/bin:/usr/bin:/bin")
    clean["TMPDIR"] = str(scratch)
    if any(matches(value.encode(), values) for value in clean.values()):
        raise ValueError("sensitive value present in profiler environment allowlist; refusing capture")
    return clean


def scan_paths(roots, values=None):
    values = sensitive_values() if values is None else values
    hits, files, layers, total_bytes = [], 0, 0, 0
    for root in roots:
        root = Path(root)
        paths = [root] if root.is_file() else sorted(p for p in root.rglob('*') if p.is_file())
        for path in paths:
            raw = path.read_bytes();files += 1;total_bytes += len(raw)
            found = matches(raw, values)
            if found:
                hits.append({"path": str(path.resolve()), "matches": found})
    return {"format": "cost-sensitive-value-scan-v1", "sensitiveKeyNames": sorted(values),
            "filesChecked": files, "storedBytesChecked": total_bytes, "matchedFiles": len(hits), "hits": hits,
            "scope": "Exact current nonempty sensitive environment values, checked in each original file and every nested gzip layer. Values and matching snippets are never stored or printed. This is not a claim to identify every possible historical or encoded secret."}
