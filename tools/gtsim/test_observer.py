#!/usr/bin/env python3
"""CPU-only integration checks; build once with build_and_trace.py --test."""
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from build_and_trace import HERE, validate_trace

CACHE = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "gpu-sim" / "gtsim"
BINARY = CACHE / "build-observer-v1" / "gtsim_trace"


class ObserverTests(unittest.TestCase):
    def assert_same_observations(self, actual, expected):
        """Compare all native observations; only invocation metadata can vary."""
        self.assertNotEqual(actual["meta"]["runId"], expected["meta"]["runId"])
        for trace in (actual, expected):
            self.assertEqual(trace["meta"]["timeDomain"], f"gtsim:{trace['meta']['runId']}:cycle")
            self.assertGreaterEqual(trace["metrics"]["wallTimeSeconds"], 0)
        actual, expected = copy.deepcopy(actual), copy.deepcopy(expected)
        for trace in (actual, expected):
            del trace["meta"]["runId"]
            del trace["meta"]["timeDomain"]
            del trace["metrics"]["wallTimeSeconds"]
        self.assertEqual(actual, expected)

    def run_trace(self, *args, expected_returncode=0):
        with tempfile.TemporaryDirectory(prefix="gpu-sim-observer-test-") as directory:
            output = Path(directory) / "trace.json"
            result = subprocess.run([str(BINARY), *args, "--output", str(output)], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
            self.assertEqual(result.returncode, expected_returncode, result.stderr)
            trace = json.loads(output.read_text())
            validate_trace(trace, result.stdout)
            return trace

    def test_committed_baseline_reproduces_native_timestamps(self):
        trace = self.run_trace()
        committed = json.loads((HERE.parents[1] / "examples/gtsim-gemm.json").read_text())
        self.assert_same_observations(trace, committed)
        self.assertEqual(trace["metrics"]["totalCycles"], 5492)
        self.assertEqual(len(trace["events"]), 796)

    def test_low_l2_bandwidth_changes_real_timing_and_matches_example(self):
        trace = self.run_trace("--l2-bandwidth", "128")
        committed = json.loads((HERE.parents[1] / "examples/gtsim-gemm-slow-l2.json").read_text())
        self.assert_same_observations(trace, committed)
        self.assertEqual(trace["metrics"]["totalCycles"], 6413)

    def test_sram_configuration_reaches_native_model(self):
        trace = self.run_trace("--sram-bandwidth", "16")
        self.assertEqual(trace["meta"]["config"]["sramBandwidthBytesPerCycle"], 16)
        self.assertEqual(trace["metrics"]["totalCycles"], 9076)

    def test_timeout_preserves_missing_timestamps_without_fake_spans(self):
        trace = self.run_trace("--max-cycles", "1", expected_returncode=2)
        self.assertEqual(trace["events"], [])
        self.assertEqual(trace["metrics"]["unissuedNodeCount"], 794)
        self.assertEqual(trace["metrics"]["startedIncompleteNodeCount"], 2)
        self.assertFalse(trace["metrics"]["simulationCompleted"])
        self.assertTrue(all(node["end"] is None for node in trace["metrics"]["omittedNodes"]))

    def test_midrun_partial_keeps_completed_spans_and_native_missing_endpoints(self):
        baseline = json.loads((HERE.parents[1] / "examples/gtsim-gemm.json").read_text())
        original_events = {event["id"]: event for event in baseline["events"]}
        for cutoff, completed in [(1000, 4), (2000, 194), (4000, 724)]:
            with self.subTest(cutoff=cutoff):
                trace = self.run_trace("--max-cycles", str(cutoff), expected_returncode=2)
                self.assertEqual(trace["metrics"]["totalCycles"], cutoff)
                self.assertEqual(len(trace["events"]), completed)
                self.assertFalse(trace["metrics"]["simulationCompleted"])
                # A time limit changes only which observations exist; it must
                # not shift any first issue or completed node's interval.
                for event in trace["events"]:
                    self.assertEqual(event, original_events[event["id"]])
                for node in trace["metrics"]["omittedNodes"]:
                    original = original_events[node["id"]]
                    self.assertIsNone(node["end"])
                    self.assertEqual(node["dependencies"], original["dependencies"])
                    self.assertEqual(node["issueDependencies"], original["args"]["issueDependencies"])
                    if node["start"] is not None:
                        self.assertEqual(node["start"], original["start"])
                        self.assertGreater(original["end"], cutoff)
                    else:
                        self.assertGreater(original["start"], cutoff)

    def test_invalid_shapes_and_nonprogressing_l2_budget_are_rejected(self):
        for args in [("--m", "127"), ("--n", "128"), ("--k", "63"), ("--l2-bandwidth", "127"), ("--sram-bandwidth", "0")]:
            with self.subTest(args=args), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "invalid.json"
                result = subprocess.run([str(BINARY), *args, "--output", str(output)], capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, 1)
                self.assertFalse(output.exists())


if __name__ == "__main__":
    if not BINARY.is_file():
        raise SystemExit("Run python3 tools/gtsim/build_and_trace.py --test first.")
    unittest.main()
