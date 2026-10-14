#!/usr/bin/env python3
"""Fetch a hash-locked GTSim, build an unchanged timing core, export its DAG."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import urllib.request

HERE = Path(__file__).resolve().parent
LOCK = json.loads((HERE / "upstream.json").read_text())


def upstream_source(cache: Path) -> Path:
    """The archive hash locks all upstream bytes, not just a mutable git tag."""
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / f"{LOCK['revision']}.tar.gz"
    if not archive.exists():
        print(f"Downloading {LOCK['archiveUrl']}", flush=True)
        data = urllib.request.urlopen(LOCK["archiveUrl"], timeout=60).read()
        if hashlib.sha256(data).hexdigest() != LOCK["archiveSha256"]:
            raise RuntimeError("Downloaded GTSim archive failed SHA-256 verification")
        archive.write_bytes(data)
    data = archive.read_bytes()
    if hashlib.sha256(data).hexdigest() != LOCK["archiveSha256"]:
        raise RuntimeError(f"Cached archive failed SHA-256 verification: {archive}")
    source = cache / f"source-{LOCK['revision']}"
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as contents:
        for member in contents.getmembers():
            relative = Path(*Path(member.name).parts[1:])
            if relative.is_absolute() or ".." in relative.parts:
                raise RuntimeError("Unsafe upstream archive path")
            destination = source / relative
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                handle = contents.extractfile(member)
                assert handle is not None
                expected = handle.read()
                destination.parent.mkdir(parents=True, exist_ok=True)
                if destination.exists() and destination.read_bytes() != expected:
                    raise RuntimeError(f"Cached source was modified; use a fresh --cache directory: {destination}")
                if not destination.exists():
                    destination.write_bytes(expected)
            else:
                raise RuntimeError("Unsupported upstream archive member")
    return source


def validate_trace(trace: dict, raw_log: str | None = None) -> None:
    """Check the observer contract and the two *different* dependency types."""
    assert trace["schemaVersion"] == 1
    assert trace["meta"]["evidenceKind"] == "simulation"
    assert trace["meta"]["producerRevision"] == LOCK["revision"]
    assert trace["meta"]["backend"] == "GTSim"
    assert trace["meta"]["backendVersion"] == "0.1.0"
    assert trace["meta"]["capabilities"] == ["tile_tasks"]
    assert trace["meta"]["granularity"] == "tile"
    assert trace["meta"]["experimentId"].startswith(f"gtsim-{LOCK['revision']}-gemm-")
    assert trace["meta"]["runId"].startswith("gtsim-")
    assert trace["meta"]["timeDomain"] == f"gtsim:{trace['meta']['runId']}:cycle"
    metrics = trace["metrics"]
    assert math.isfinite(metrics["wallTimeSeconds"]) and metrics["wallTimeSeconds"] >= 0
    assert metrics["timingScope"] == "Simulator::run only; excludes download, build, graph construction, and trace export"
    events = {event["id"]: event for event in trace["events"]}
    assert len(events) == len(trace["events"]), "Duplicate event IDs"
    components = {component["id"] for component in trace["components"]}
    omitted = {node["id"]: node for node in metrics["omittedNodes"]}
    assert not events.keys() & omitted.keys()
    assert len(events) == metrics["completedNodeCount"] == metrics["emittedEventCount"]
    assert len(events) + len(omitted) == metrics["totalNodeCount"]
    assert len(omitted) == metrics["unissuedNodeCount"] + metrics["startedIncompleteNodeCount"]
    for event in events.values():
        assert event["args"]["granularity"] == "tile"
        assert event["componentId"] in components
        assert 0 <= event["start"] <= event["end"] <= metrics["totalCycles"]
        assert event["start"] == event["args"]["issueCycle"]
        for producer_id in event["dependencies"]:
            assert producer_id in events, f"Missing completed producer: {producer_id}"
            assert events[producer_id]["end"] <= event["start"], f"Completion dependency violation: {producer_id} -> {event['id']}"
        # Upstream distinguishes TMA enqueue/issue order from data completion.
        # The native first-issue timestamp is a conservative ordering bound;
        # we do not invent an all-suboperations-issued milestone.
        for producer_id in event["args"]["issueDependencies"]:
            producer = events.get(producer_id, omitted.get(producer_id))
            assert producer is not None and producer["start"] is not None
            assert producer["start"] <= event["start"], f"Issue ordering violation: {producer_id} -> {event['id']}"
    for node in omitted.values():
        assert node["end"] is None
        if node["status"] == "unissued":
            assert node["start"] is None
        else:
            assert node["status"] == "started-incomplete" and node["start"] >= 0
    if metrics["simulationCompleted"]:
        assert not omitted
        assert max(event["end"] for event in events.values()) == metrics["totalCycles"]
    if raw_log is not None:
        totals = re.findall(r"^Total cycles: (\d+)$", raw_log, re.MULTILINE)
        assert totals and int(totals[-1]) == metrics["totalCycles"], "Export differs from native Total cycles"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    default_cache = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "gpu-sim" / "gtsim"
    parser.add_argument("--cache", type=Path, default=default_cache)
    parser.add_argument("--output", type=Path, default=HERE.parents[1] / "examples" / "gtsim-gemm.json")
    parser.add_argument("--m", type=int, default=256)
    parser.add_argument("--n", type=int, default=256)
    parser.add_argument("--k", type=int, default=128)
    parser.add_argument("--l2-bandwidth", type=int, help="Native L2 total service budget in bytes/cycle (>=128); configured write budget stays 2150")
    parser.add_argument("--sram-bandwidth", type=int, help="Native config SRAM bytes/cycle")
    parser.add_argument("--max-cycles", type=int, default=1000000)
    parser.add_argument("--jobs", type=int, default=4)
    parser.add_argument("--test", action="store_true", help="Run all four unmodified upstream tests")
    args = parser.parse_args()
    if args.jobs <= 0:
        parser.error("--jobs must be positive")
    source = upstream_source(args.cache.resolve())
    build = args.cache.resolve() / "build-observer-v1"
    subprocess.run(["cmake", "-S", str(HERE), "-B", str(build), f"-DGTSIM_SOURCE_DIR={source}", "-DCMAKE_BUILD_TYPE=Release"], check=True)
    subprocess.run(["cmake", "--build", str(build), "-j", str(args.jobs)], check=True)
    if args.test:
        subprocess.run(["ctest", "--test-dir", str(build), "--output-on-failure"], check=True)
    args.output = args.output.resolve()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    command = [str(build / "gtsim_trace"), "--m", str(args.m), "--n", str(args.n), "--k", str(args.k), "--max-cycles", str(args.max_cycles), "--output", str(args.output)]
    for option, value in [("--l2-bandwidth", args.l2_bandwidth), ("--sram-bandwidth", args.sram_bandwidth)]:
        if value is not None:
            command.extend([option, str(value)])
    result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    log_path = args.output.with_suffix(".log")
    log_path.write_text(result.stdout)
    if result.returncode not in (0, 2):
        print(result.stdout, file=sys.stderr)
        return result.returncode
    trace = json.loads(args.output.read_text())
    validate_trace(trace, result.stdout)
    if result.returncode == 0 and args.l2_bandwidth is None and args.sram_bandwidth is None:
        original = subprocess.run([str(build / "upstream" / "gtsim_gemm"), str(args.m), str(args.n), str(args.k)], check=True, text=True, stdout=subprocess.PIPE)
        totals = re.findall(r"^Total cycles: (\d+)$", original.stdout, re.MULTILINE)
        assert totals and int(totals[-1]) == trace["metrics"]["totalCycles"], "Observer changed official timing"
        print(f"Unmodified upstream Total cycles matched: {totals[-1]}")
    print(f"Validated {len(trace['events'])} spans; {trace['metrics']['totalCycles']} cycles; complete={trace['metrics']['simulationCompleted']}")
    print(f"Native simulation wall time: {trace['metrics']['wallTimeSeconds']:.6f} s ({trace['metrics']['timingScope']})")
    print(f"Trace: {args.output}\nNative run log: {log_path}")
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
