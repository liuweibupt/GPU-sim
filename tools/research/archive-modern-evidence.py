#!/usr/bin/env python3
"""Archive bounded experiment outputs, preserving originals through lossless gzip.

Usage: ... --output ARCHIVE --input modal=out/research/modal ...
       ... --verify ARCHIVE
       ... --extract ARCHIVE --to NEW_DIRECTORY
Only explicit input directories are copied; environment and credentials are not.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path


def sha(data):
    return hashlib.sha256(data).hexdigest()


def validate_modal(root):
    checks = 0
    for path in root.rglob("summary.json"):
        doc = json.loads(path.read_text())
        if doc.get("format") != "modal-gpu-evidence-job-v1":
            continue
        def check(relative, expected, size=None):
            nonlocal checks
            data = (path.parent / relative).read_bytes()
            if sha(data) != expected or size is not None and len(data) != size:
                raise ValueError(f"Modal artifact mismatch: {path.parent / relative}")
            checks += 1
        check("job.json", doc["job_sha256"])
        check("run_gpu_evidence.py", doc["runner_sha256"])
        for name, digest in doc["source_sha256"].items():
            check(name, digest)
        for command in doc.get("execution", {}).get("commands", []):
            for stream in ("stdout", "stderr"):
                entry = command[stream]
                check(entry["path"], entry["sha256"], entry["bytes"])
        for entry in doc.get("execution", {}).get("artifacts", []):
            if "omitted" not in entry:
                check("artifacts/" + entry["path"], entry["sha256"], entry["bytes"])
    return checks


def archive(inputs, output):
    if output.exists():
        raise ValueError("Archive already exists; refuse to change frozen evidence")
    # Validate the entire selection before creating any output; rglob silently
    # returns no files for a mistyped/missing directory.
    if not inputs or any(not root.is_dir() for _, root in inputs):
        raise ValueError("Every archive input must be an existing directory")
    names = [name for name, _ in inputs]
    if len(names) != len(set(names)) or any(not name or Path(name).name != name or name in (".", "..") for name in names):
        raise ValueError("Each input needs a unique simple name")
    manifest = {"format": "modern-gpu-evidence-archive-v1", "files": [],
                "inputs": [], "modal_integrity_checks": 0,
                "binary_policy": "Cloud ELF bytes are omitted; exact compiler binary hashes are retained in Modal and suite manifests.",
                "compression": "Files >= 100000 bytes use lossless deterministic gzip; original SHA and byte count remain authoritative."}
    for name, root in inputs:
        root = root.resolve()
        manifest["inputs"].append({"name": name, "source": str(root)})
        manifest["modal_integrity_checks"] += validate_modal(root)
        for path in sorted(root.rglob("*")):
            if not path.is_file() or path.is_symlink() or "__pycache__" in path.parts:
                continue
            data = path.read_bytes()
            if data.startswith(b"\x7fELF"):
                raise ValueError("Do not accidentally publish executable bytes")
            original = (Path(name) / path.relative_to(root)).as_posix()
            compressed = len(data) >= 100000
            stored = original + (".gz" if compressed else "")
            packed = gzip.compress(data, mtime=0) if compressed else data
            destination = output / stored
            if destination.exists():
                raise ValueError("Archive pathname collision")
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(packed)
            manifest["files"].append({"original_path": original, "path": stored,
                "encoding": "gzip" if compressed else "identity", "sha256": sha(data), "bytes": len(data),
                "stored_sha256": sha(packed), "stored_bytes": len(packed)})
    manifest["counts"] = {"files": len(manifest["files"]),
        "original_bytes": sum(f["bytes"] for f in manifest["files"]),
        "stored_bytes": sum(f["stored_bytes"] for f in manifest["files"])}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return verify(output)


def verify(root):
    doc = json.loads((root / "manifest.json").read_text())
    for entry in doc["files"]:
        rel = Path(entry["path"])
        original = Path(entry["original_path"])
        if rel.is_absolute() or ".." in rel.parts or original.is_absolute() or ".." in original.parts:
            raise ValueError("Invalid archive path")
        if entry["encoding"] not in ("identity", "gzip"):
            raise ValueError("Unknown compression")
        packed = (root / rel).read_bytes()
        if sha(packed) != entry["stored_sha256"] or len(packed) != entry["stored_bytes"]:
            raise ValueError(f"Stored hash mismatch: {rel}")
        data = gzip.decompress(packed) if entry["encoding"] == "gzip" else packed
        if sha(data) != entry["sha256"] or len(data) != entry["bytes"]:
            raise ValueError(f"Original hash mismatch: {rel}")
    if len({x["path"] for x in doc["files"]}) != len(doc["files"]):
        raise ValueError("Duplicate archive path")
    if len({x["original_path"] for x in doc["files"]}) != len(doc["files"]):
        raise ValueError("Duplicate original path")
    return {"status": "verified", **doc["counts"], "modal_integrity_checks": doc["modal_integrity_checks"]}


def extract(root, destination):
    result = verify(root)
    destination.mkdir(parents=True, exist_ok=False)
    doc = json.loads((root / "manifest.json").read_text())
    for entry in doc["files"]:
        raw = (root / entry["path"]).read_bytes()
        data = gzip.decompress(raw) if entry["encoding"] == "gzip" else raw
        path = destination / entry["original_path"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return {**result, "status": "extracted", "destination": str(destination)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", action="append", default=[])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--verify", type=Path)
    parser.add_argument("--extract", type=Path)
    parser.add_argument("--to", type=Path)
    args = parser.parse_args()
    if args.extract and args.to:
        result = extract(args.extract, args.to)
    elif args.verify:
        result = verify(args.verify)
    elif args.output and args.input:
        result = archive([(s.split("=", 1)[0], Path(s.split("=", 1)[1])) for s in args.input], args.output)
    else:
        parser.error("supply --verify or --output and --input name=directory")
    print(json.dumps(result))
