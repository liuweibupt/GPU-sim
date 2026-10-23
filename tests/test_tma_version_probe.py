"""CPU-only negative controls for the TMA evidence validator; no GPU claims."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

PATH = Path(__file__).resolve().parents[1] / "tools/research/cuda/tma_run_probe.py"
SPEC = importlib.util.spec_from_file_location("tma_run_probe", PATH)
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


def fixture(variant="correct"):
    rows, cols, generations, seed = 3, 33, 5, 20261023
    output, tags = probe.oracle(rows, cols, generations, seed, variant == "wrong-slot")
    reference, expected = probe.oracle(rows, cols, generations, seed)
    record = {"format": probe.FORMAT, "mechanism": "tensor-tma-2d", "shape": [rows, cols],
        "generations": generations, "seed": seed, "variant": variant, "device_status": 0,
        "cta": [0, 0, 0], "threads": 64, "compute_capability": [10, 0], "padded_cols": 36,
        "transfer_bytes": 864, "wait_poll_limit": 1000000,
        "tensor_map": {"rank": 2, "dtype": "int32", "global_dim": [72, 21],
            "global_stride_bytes": [288], "box_dim": [72, 3], "element_stride": [1, 1], "swizzle": "none"},
        "output": output, "observed_generations": tags, "reference": reference,
        "expected_generations": expected, "correctness": {"passed": variant != "wrong-slot",
            "value_mismatches": sum(x != y for x, y in zip(output, reference)),
            "version_mismatches": sum(x != y for x, y in zip(tags, expected))}, "events": []}
    ordinals = {0: 0, 32: 0}
    for transfer in range(7):
        g = -1 if transfer < 2 else transfer - 2
        producer_slot = transfer if transfer < 2 else g % 2
        roles = ["tma_issued", "wait_returned_true"]
        if transfer >= 2:
            roles += ["consumer_sample", "reuse_ready"]
        for role in roles:
            index = len(record["events"])
            consumer = role == "consumer_sample"
            thread = 32 if consumer else 0
            slot = producer_slot ^ int(consumer and variant == "wrong-slot")
            observed = role in ("wait_returned_true", "consumer_sample")
            version = g - int(consumer and variant == "wrong-slot")
            record["events"].append({"id": f"event-{index}", "event_layout_index": index,
                "role": role, "iteration": g, "transfer": transfer, "slot": slot,
                "expected_generation": g, "observed_generation": version if observed else None,
                "representative_value": probe.value_for(seed, version, 0) if observed else None,
                "phase_parity": (0 if transfer < 2 else (1 + g // 2) % 2)
                    if role in ("tma_issued", "wait_returned_true") else -1,
                "wait_success": role == "wait_returned_true", "wait_polls": int(role == "wait_returned_true"),
                "barrier_shared_address": hex(16384 + 8 * slot), "buffer_shared_address": hex(4096 * slot),
                "thread": thread, "warp_id": thread // 32, "thread_program_ordinal": ordinals[thread],
                "source_line": 100})
            ordinals[thread] += 1
    return record


class TmaEvidenceTests(unittest.TestCase):
    def test_variants_and_sanitizer_banner(self):
        for variant in probe.VARIANTS:
            record = fixture(variant)
            parsed, line = probe.parse_stdout_record("========= COMPUTE-SANITIZER\n" + json.dumps(record) + "\n========= ERROR SUMMARY: 0 errors\n")
            self.assertEqual(line, 2)
            checked = probe.check_record(parsed)
            self.assertEqual(checked["successful_wait_observations"], 7)
            self.assertEqual(checked["all_valid_output_elements"], 495)

    def test_missing_or_pre_wait_observation_rejected(self):
        for change in (lambda r: r["events"][1].update(wait_success=False),
                       lambda r: r["events"][1].update(wait_polls=0),
                       lambda r: r["events"][1].update(observed_generation=None),
                       lambda r: r["events"].pop()):
            record = fixture()
            change(record)
            with self.assertRaises(ValueError):
                probe.check_record(record)

    def test_stale_repair_and_truncated_output_rejected(self):
        record = fixture("wrong-slot")
        record["variant"] = "repaired"
        with self.assertRaisesRegex(ValueError, "output"):
            probe.check_record(record)
        record = fixture()
        record["observed_generations"].pop()
        with self.assertRaisesRegex(ValueError, "observed_generations"):
            probe.check_record(record)
        record = fixture()
        record["output"][102] += 1
        with self.assertRaisesRegex(ValueError, "output"):
            probe.check_record(record)

    def test_phase_duplicate_and_alias_rejected(self):
        for change in (lambda r: r["events"][13].update(phase_parity=1),
                       lambda r: r["events"].__setitem__(8, copy.deepcopy(r["events"][4])),
                       lambda r: r["events"][0].update(buffer_shared_address="0x1")):
            record = fixture()
            change(record)
            with self.assertRaises(ValueError):
                probe.check_record(record)

    def test_duplicate_json_and_wrong_transaction_bytes_rejected(self):
        raw = json.dumps(fixture())
        with self.assertRaisesRegex(ValueError, "exactly one"):
            probe.parse_stdout_record(raw + "\n" + raw)
        record = fixture()
        record["transfer_bytes"] -= 16
        with self.assertRaisesRegex(ValueError, "transaction"):
            probe.check_record(record)


if __name__ == "__main__":
    unittest.main()
