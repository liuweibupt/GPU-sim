#!/usr/bin/env python3
"""Verify exact archived bytes and cross-experiment SHA bindings without source trees."""
from __future__ import annotations
import argparse
import csv
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath


def sha(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(root, relative):
    path = PurePosixPath(relative)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"unsafe archive path: {relative}")
    candidate = root.joinpath(*path.parts)
    if not candidate.resolve().is_relative_to(root.resolve()) or candidate.is_symlink():
        raise ValueError(f"archive path escapes root or is a symlink: {relative}")
    return candidate


class Archive:
    def __init__(self, root, originals=False):
        self.root = Path(root).resolve()
        self.manifest = json.loads((self.root / "manifest.json").read_bytes())
        if self.manifest.get("format") != "gpu-sim-semantic-archive-v1":
            raise ValueError("unsupported archive manifest")
        self.entries, self.checks, self.failures = {}, [], []
        stored_paths = set()
        for item in self.manifest["files"]:
            key = (item["group"], item["logicalPath"])
            if key in self.entries or item["storedPath"] in stored_paths:
                raise ValueError("duplicate logical or stored archive path")
            self.entries[key] = item
            stored_paths.add(item["storedPath"])
            data = safe_path(self.root, item["storedPath"]).read_bytes()
            self.check(sha(data) == item["storedSha256"] and len(data) == item["storedBytes"], f"stored-bytes:{item['storedPath']}")
            decoded = gzip.decompress(data) if item["encoding"] == "gzip" else data
            self.check(item["encoding"] in ("identity", "gzip"), f"encoding:{item['storedPath']}")
            self.check(sha(decoded) == item["originalSha256"] and len(decoded) == item["originalBytes"], f"original-bytes:{item['storedPath']}")
            if originals:
                original = safe_path(Path(item["originalRoot"]), item["originalRelativePath"])
                self.check(original.is_file() and sha(original.read_bytes()) == item["originalSha256"], f"source-still-matches:{item['storedPath']}")

    def check(self, condition, label):
        self.checks.append(label)
        if not condition:
            self.failures.append(label)

    def data(self, group, path):
        item = self.entries[(group, path)]
        data = safe_path(self.root, item["storedPath"]).read_bytes()
        return gzip.decompress(data) if item["encoding"] == "gzip" else data

    def json(self, group, path="summary.json"):
        data = self.data(group, path)
        return json.loads(gzip.decompress(data) if path.endswith(".gz") else data)

    def bind(self, group, path, digest, label, size=None):
        item = self.entries.get((group, path))
        self.check(item is not None and item["originalSha256"] == digest and (size is None or item["originalBytes"] == size), label)

    def source_map(self, group, source_hashes, snapshot_prefix=None):
        for name, digest in source_hashes.items():
            snapshot = (group, f"{snapshot_prefix}/{name}") if snapshot_prefix else None
            if snapshot in self.entries:
                self.bind(*snapshot, digest, f"source-snapshot:{group}:{name}")
            else:
                self.bind("sources", name, digest, f"source-current-snapshot:{group}:{name}")


def verify_bindings(a):
    a.bind("sources", "tools/research/archive-semantic-experiments.py", a.manifest["archiveScriptSha256"], "archive-script-snapshot")
    raw, mask, static, protocol, cuda, rb, vb = [a.json(group) for group in ("raw", "mask", "static", "protocol", "cuda", "rawbridge", "versionbridge")]
    for item in raw["files"]:
        a.bind("raw", item["path"], item["sha256"], "raw-file:" + item["path"], item["bytes"])
        payload = a.json("raw", item["path"])
        a.check(payload["source"]["trace_sha256"] == item["trace_sha256"], "raw-trace-identity:" + item["path"])
    for item in mask["inputs"]:
        a.bind("raw", item["file"], item["sha256"], "mask-input:" + item["file"], item["bytes"])
    a.bind("sources", "tools/research/analyze-raw-evidence.py", mask["script_sha256"], "mask-script")
    a.bind("raw", "summary.json", static["input_summary_sha256"], "static-input-raw-summary")
    a.bind("references", "program-manifest.json", static["main_program_manifest_sha256"], "static-input-program-manifest")
    a.bind("references", "static-artifact-manifest.json", static["static_artifact_manifest_sha256"], "static-input-static-manifest")
    for group, summary in (("static", static), ("protocol", protocol)):
        for name, item in summary["artifacts"].items():
            a.bind(group, name, item["sha256"], f"{group}-artifact:{name}", item["bytes"])
    for name, digest in static["source_hashes"].items():
        a.bind("static", "source-snapshots/" + Path(name).name, digest, "static-source:" + name)
    a.source_map("protocol", protocol["provenance"]["source_hashes"], "source-snapshots")
    sources = raw["source_hashes"]
    a.bind("sources", "tools/research/extract-raw-evidence.py", sources["extractor_sha256"], "raw-extractor-source")
    a.bind("sources", "tools/research/audit-source-traces.py", sources["framing_audit_sha256"], "raw-framing-source")
    a.bind("references", "source_inventory.csv", sources["inventory_sha256"], "raw-source-inventory")
    for name, digest in sources["archive_selection_sha256"].items():
        a.bind("references", name, digest, "raw-selection:" + name)
    for name, digest in sources["source_parser_sha256"].items():
        a.bind("external-sources", name, digest, "raw-parser-source:" + name)
    for name, digest in cuda["source_hashes"].items():
        a.bind("cuda", name, digest, "cuda-source:" + name)
    for command in cuda["commands"]:
        for stream in ("stdout", "stderr"):
            a.bind("cuda", f"{command['name']}.{stream}.txt", command[f"{stream}_sha256"], f"cuda-command-log:{command['name']}:{stream}")
    omissions = [item for item in a.manifest["omissions"] if item["group"] == "cuda" and item["kind"] == "compiled-executable"]
    a.check(len(omissions) == 1 and omissions[0]["originalSha256"] == cuda["binary_sha256"], "cuda-binary-omission-sha")
    a.check(any(command["name"] == "compile" and command["exit_code"] == 0 for command in cuda["commands"]), "cuda-successful-compile-command-retained")
    for run in cuda["runs"]:
        for event in run["events"]:
            ref = event["recordRef"]
            a.bind("cuda", ref["path"], ref["sha256"], "cuda-event-log:" + event["id"])
    a.bind("raw", "summary.json", rb["inputManifestSha256"], "rawbridge-input-summary")
    a.source_map("rawbridge", rb["sourceSha256"])
    for row in rb["rows"]:
        a.bind("rawbridge", row["result"], row["resultSha256"], "rawbridge-result:" + row["result"], row["resultBytes"])
        a.bind("raw", row["rawArtifact"], row["rawArtifactSha256"], "rawbridge-input:" + row["rawArtifact"])
        result = a.json("rawbridge", row["result"])
        a.check(result["capture"]["provenance"]["sourceTraceSha256"] == row["traceSha256"], "rawbridge-trace:" + row["result"])
        a.check(len(result["run"]["obligations"]) == row["obligations"], "rawbridge-count:" + row["result"])
    a.bind("cuda", "summary.json", vb["inputSummarySha256"], "versionbridge-input-cuda-summary")
    a.source_map("versionbridge", vb["sourceSha256"])
    for row in vb["rows"]:
        a.bind("versionbridge", row["file"], row["resultSha256"], "versionbridge-result:" + row["file"], row["resultBytes"])
        result = a.json("versionbridge", row["file"])
        a.check(len(result["run"]["obligations"]) == row["obligations"], "versionbridge-count:" + row["file"])
        for fact in result["capture"]["facts"]:
            if "path" in fact and "sha256" in fact:
                a.bind("cuda", fact["path"], fact["sha256"], "versionbridge-event-log:" + fact["id"])
            if "source_sha256" in fact:
                a.bind("cuda", "version_probe.cu", fact["source_sha256"], "versionbridge-event-source:" + fact["id"])
            if "sourceSha256" in fact:
                a.bind("cuda", "version_probe.cu", fact["sourceSha256"], "versionbridge-source-contract:" + fact["id"])
    for row in csv.DictReader(io.StringIO(a.data("static", "traces.csv").decode())):
        a.bind("raw", row["raw_cta_artifact"], row["raw_cta_artifact_sha256"], "static-raw-cta:" + row["raw_cta_artifact"])
    # Validate all fixed source bindings and renderer inputs when supplied. The
    # browser report schema is preserved without inventing an attestation.
    if ("viewer", "viewer.html") in a.entries:
        a.check(len(a.data("viewer", "viewer.html")) > 0, "viewer-nonempty")
    if ("viewer", "browser-check.json") in a.entries:
        report = a.json("viewer", "browser-check.json")
        a.check(report["status"] == "passed" and report["chrome_exit_code"] == 0, "browser-check-passed")
        a.bind("viewer", "viewer.html", report["html_sha256"], "browser-checked-html")
        a.bind("sources", "tools/research/check-version-viewer.py", report["checker_sha256"], "browser-checker-source")
        a.bind("viewer", "viewer.png", report["screenshot"]["sha256"], "browser-screenshot")
    if ("viewer", "render-manifest.json") in a.entries:
        renderer = a.json("viewer", "render-manifest.json")
        a.bind("viewer", "viewer.html", renderer["html_sha256"], "rendered-html", renderer["html_bytes"])
        a.bind("sources", "tools/research/render-version-report.py", renderer["renderer_sha256"], "renderer-source")
        a.bind("cuda", "summary.json", renderer["inputs"]["suite_summary_sha256"], "renderer-cuda-input")
        a.bind("versionbridge", "summary.json", renderer["inputs"]["bridge_summary_sha256"], "renderer-bridge-input")
        for name, digest in renderer["inputs"]["bridge_cta_file_sha256"].items():
            a.bind("versionbridge", name, digest, "renderer-cta-input:" + name)


def check_archive(root, originals=False, files_only=False):
    archive = Archive(root, originals=originals)
    if not files_only:
        verify_bindings(archive)
    return {"format": "gpu-sim-semantic-archive-verification-v1", "archive": str(Path(root).resolve()),
            "manifestSha256": sha((Path(root) / "manifest.json").read_bytes()), "files": len(archive.entries),
            "checks": len(archive.checks), "failures": archive.failures,
            "verified": not archive.failures, "originalSourcesChecked": originals, "internalBindingsChecked": not files_only,
            "scope": "Byte-preserving archive integrity and declared SHA/count bindings; not independent proof of measurement authenticity or scientific conclusions."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--originals", action="store_true", help="Also require original local source files to remain byte-identical.")
    parser.add_argument("--files-only", action="store_true", help="Verify storage transformation only, for archive-format fixture tests.")
    args = parser.parse_args()
    result = check_archive(args.archive, originals=args.originals, files_only=args.files_only)
    print(json.dumps(result, indent=2))
    return 0 if result["verified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
