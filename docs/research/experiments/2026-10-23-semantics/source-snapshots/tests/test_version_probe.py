"""Check evidence-parser failures independently of CUDA availability."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

PATH = Path(__file__).resolve().parents[1] / "tools/research/cuda/run_version_probe.py"
SPEC = importlib.util.spec_from_file_location("run_version_probe", PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class VersionProbeTests(unittest.TestCase):
    def record(self):
        seed = 20261023
        value = MODULE.oracle(1, 1, seed)[0]
        record = {"format": "gpu-version-probe-v1", "shape": [1], "generations": 1,
            "seed": seed, "variant": "correct", "output": [value], "reference": [value],
            "observed_generations": [0], "expected_generations": [0],
            "correctness": {"value_mismatches": 0, "version_mismatches": 0, "elements": 1, "passed": True},
            "events": []}
        roles = ["producer_write", "producer_complete", "consumer_read", "reader_done", "reuse_ready"]
        phases = ["before_producer_barrier", "after_producer_barrier", "before_reuse_barrier", "after_reuse_barrier", "after_reuse_barrier"]
        for index, role in enumerate(roles):
            consumer = index in (2, 3)
            record["events"].append({"cta": [0, 0, 0], "iteration": 0, "role": role,
                "slot": 0, "observed_generation": 0, "expected_generation": 0,
                "representative_value": value, "valid_elements": 1, "thread": 32 if consumer else 0,
                "warp_id": 1 if consumer else 0, "event_layout_index": index, "phase": phases[index],
                "thread_program_ordinal": index - 2 if consumer else 2 if index == 4 else index})
        return record

    def test_sanitizer_stdout_banner_and_summary(self):
        raw = "========= COMPUTE-SANITIZER\n" + json.dumps(self.record()) + "\n========= ERROR SUMMARY: 0 errors\n"
        parsed, line = MODULE.parse_stdout_record(raw)
        self.assertEqual(line, 2)
        self.assertEqual(MODULE.check_record(parsed)["independent_python_oracle"], "pass")

    def test_missing_or_multiple_json_records_rejected(self):
        for raw in ["========= ERROR SUMMARY: 0 errors\n", json.dumps(self.record()) + "\n" + json.dumps(self.record())]:
            with self.assertRaises(ValueError):
                MODULE.parse_stdout_record(raw)

    def test_stale_tag_and_fabricated_success_rejected(self):
        baseline = self.record()
        stale = copy.deepcopy(baseline)
        stale["observed_generations"][0] = -1
        with self.assertRaises(ValueError):
            MODULE.check_record(stale)
        false_verdict = copy.deepcopy(baseline)
        false_verdict["correctness"]["passed"] = False
        with self.assertRaises(ValueError):
            MODULE.check_record(false_verdict)

    def test_duplicate_event_and_wrong_observed_version_rejected(self):
        for mutation in ("duplicate", "stale"):
            record = self.record()
            if mutation == "duplicate":
                record["events"][1] = copy.deepcopy(record["events"][0])
            else:
                record["events"][2]["observed_generation"] = -1
            with self.assertRaises(ValueError):
                MODULE.check_record(record)


if __name__ == "__main__":
    unittest.main()
