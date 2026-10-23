#!/usr/bin/env python3
"""Archive semantic experiments losslessly; refuse to replace prior archives."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import sys


DEFAULTS = {
    "raw": "out/research/raw-evidence/20261023-cta0-v2",
    "mask": "out/research/raw-mask/20261023-v1",
    "static": "out/research/static-operands/20261023T091346Z",
    "protocol": "out/research/protocol/2026-10-23T09-06-51.774Z",
    "cuda": "out/research/cuda/20261023-version-probe-v3",
    "rawbridge": "out/research/raw-protocol/20261023-v3",
    "versionbridge": "out/research/version-protocol/20261023-v3",
}
GROUP_DIRECTORIES = {"rawbridge": "raw-bridge", "versionbridge": "version-bridge", "sources": "source-snapshots",
                     "external-sources": "source-snapshots/external", "references": "source-snapshots/reference-inputs"}
ATTRIBUTES = b"* -text\n**/*.csv whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol\n"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def plan_inputs(args):
    repository = args.repository.resolve()
    planned = []
    def add(group, logical_path, original_root, relative):
        source = original_root / relative
        if not source.is_file() or source.is_symlink():
            raise ValueError(f"not a regular source file: {source}")
        planned.append({"group": group, "logicalPath": logical_path, "originalRoot": str(original_root),
                        "originalRelativePath": str(relative), "source": source})
    for group in DEFAULTS:
        root = Path(getattr(args, group))
        root = (root if root.is_absolute() else repository / root).resolve()
        if not (root / "summary.json").is_file():
            raise ValueError(f"missing {group} summary: {root}")
        for source in sorted(root.rglob("*")):
            if source.is_file() and "__pycache__" not in source.parts:
                add(group, source.relative_to(root).as_posix(), root, source.relative_to(root))
    # Current source snapshots augment the per-experiment historical snapshots.
    source_files = set()
    for prefix in ("tools/research", "lib/research"):
        source_files.update(path for path in (repository / prefix).rglob("*") if path.is_file() and path.suffix in {".py", ".js", ".mjs", ".cu", ".md"})
    source_files.update((repository / "tests").glob("research-*.test.mjs"))
    source_files.update((repository / "tests").glob("test_*.py"))
    for source in sorted(source_files):
        add("sources", source.relative_to(repository).as_posix(), repository, source.relative_to(repository))
    raw_root = Path(args.raw)
    raw_root = (raw_root if raw_root.is_absolute() else repository / raw_root).resolve()
    raw = json.loads((raw_root / "summary.json").read_bytes())
    external = Path(raw["source_root"]).resolve()
    for relative in raw["source_hashes"]["source_parser_sha256"]:
        add("external-sources", relative, external, Path(relative))
    previous_archive = Path(raw["archive"]).resolve()
    for logical, root, relative in (
        ("program-manifest.json", external, Path("data/ysim_dse_programs_20261009/manifest.json")),
        ("static-artifact-manifest.json", external, Path("data/microarchitecture/static_sass_profiles_v1.json")),
        ("source_inventory.csv", previous_archive, Path("source-audit/source_inventory.csv")),
        ("selected-views.json.gz", previous_archive, Path("trace/selected-views.json.gz")),
        ("supplemental-views.json.gz", previous_archive, Path("trace/supplemental-views.json.gz")),
    ):
        add("references", logical, root, relative)
    for field, logical in (("viewer", "viewer.html"), ("browser_check", "browser-check.json")):
        source = getattr(args, field)
        if source is not None:
            source = source.resolve()
            add("viewer", logical, source.parent, Path(source.name))
    if args.viewer is not None:
        for name in ("render-manifest.json", "viewer.png", "viewer-detail.png"):
            source = args.viewer.resolve().parent / name
            add("viewer", name, source.parent, Path(name))
    for source in args.quality_log:
        source = source if source.is_absolute() else repository / source
        add("quality", source.name, source.parent.resolve(), Path(source.name))
    return planned


def archive(args):
    out = args.output.resolve()
    planned = plan_inputs(args)
    reserved = {GROUP_DIRECTORIES.get(group, group).split('/')[0] for group in DEFAULTS} | {
        "source-snapshots", "quality", "version-viewer.html", "browser-check.json", "render-manifest.json", "viewer.png", "viewer-detail.png", "manifest.json", "verification.json"}
    conflicts = [name for name in reserved if (out / name).exists()]
    if conflicts:
        raise FileExistsError(f"Refusing to replace archive entries: {conflicts}")
    attributes = out / ".gitattributes"
    if attributes.exists() and attributes.read_bytes() != ATTRIBUTES:
        raise FileExistsError("Existing .gitattributes differs; refusing to overwrite.")
    entries, omissions, stored_paths = [], [], set()
    for item in planned:
        data = item["source"].read_bytes()
        original_sha = sha(data)
        if data.startswith(b"\x7fELF"):
            if item["group"] != "cuda":
                raise ValueError("Unexpected executable outside CUDA group")
            omissions.append({key: value for key, value in item.items() if key != "source"} | {
                "kind": "compiled-executable", "originalSha256": original_sha, "originalBytes": len(data),
                "reason": "Executable omitted; exact binary SHA, CUDA source snapshot, compiler version and compile argv/stdout/stderr remain archived in cuda summary/logs."})
            continue
        compress = (item["group"] != "viewer" and item["logicalPath"].endswith(".json") and len(data) >= args.gzip_threshold
                    and (Path(item["logicalPath"]).name != "summary.json" or item["group"] == "cuda"))
        stored = f"{GROUP_DIRECTORIES.get(item['group'], item['group'])}/{item['logicalPath']}" + (".gz" if compress else "")
        if item["group"] == "viewer":
            stored = "version-viewer.html" if item["logicalPath"] == "viewer.html" else item["logicalPath"]
        if stored in stored_paths:
            raise ValueError(f"Storage encoding collides at {stored}")
        stored_paths.add(stored)
        encoded = gzip.compress(data, compresslevel=9, mtime=0) if compress else data
        entry = {key: value for key, value in item.items() if key != "source"} | {
            "originalSha256": original_sha, "originalBytes": len(data), "storedPath": stored,
            "storedSha256": sha(encoded), "storedBytes": len(encoded), "encoding": "gzip" if compress else "identity"}
        entries.append((entry, encoded))
    preview = {"output": str(out), "files": len(entries), "originalBytes": sum(item["originalBytes"] for item, _ in entries),
               "storedBytes": sum(item["storedBytes"] for item, _ in entries), "omittedExecutables": len(omissions),
               "viewerIncluded": args.viewer is not None, "browserCheckIncluded": args.browser_check is not None}
    if args.dry_run:
        print(json.dumps({"dryRun": True, **preview}, indent=2))
        return 0
    out.mkdir(parents=True, exist_ok=True)
    for item, encoded in entries:
        destination = out / item["storedPath"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("xb") as stream:
            stream.write(encoded)
    if not attributes.exists():
        attributes.write_bytes(ATTRIBUTES)
    manifest = {"format": "gpu-sim-semantic-archive-v1", "createdAtUtc": datetime.now(timezone.utc).isoformat(),
                "archiveScriptSha256": sha(Path(__file__).read_bytes()), "repository": str(args.repository.resolve()),
                "files": [item for item, _ in entries], "omissions": omissions,
                "preservation": "Input files are copied as exact bytes or losslessly gzip-compressed with mtime=0. No newline/CRLF or JSON rewriting.",
                "sourceSnapshots": "source-snapshots is the final current research tools/tests/lib snapshot plus external parser sources and reference inputs; group-local source-snapshots preserve original experiment versions.",
                "externalOmissions": ["Full source SASS/trace datasets and compiled executable remain in their original repositories; their recorded identities and selected evidence are retained.",
                                      "No new GPU measurements or scientific conclusions are generated by this archive operation."],
                "editorialFilesExcluded": ["report.md", ".gitattributes", "verification.json"],
                "totals": preview}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    checker_path = Path(__file__).with_name("check-semantic-archive.py")
    spec = importlib.util.spec_from_file_location("semantic_archive_checker", checker_path)
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    result = checker.check_archive(out, originals=True)
    (out / "verification.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({**preview, "verification": result}, indent=2))
    return 0 if result["verified"] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, default=Path(__file__).resolve().parents[2])
    for group, default in DEFAULTS.items():
        parser.add_argument("--" + group, type=Path, default=Path(default))
    parser.add_argument("--output", type=Path, default=Path("docs/research/experiments/2026-10-23-semantics"))
    parser.add_argument("--viewer", type=Path)
    parser.add_argument("--browser-check", type=Path)
    parser.add_argument("--quality-log", type=Path, action="append", default=[Path("out/research/semantics-js-tests.txt"), Path("out/research/semantics-python-tests.txt"), Path("out/research/semantics-final-bridge-tests.txt")])
    parser.add_argument("--gzip-threshold", type=int, default=65536)
    parser.add_argument("--dry-run", action="store_true")
    return archive(parser.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
