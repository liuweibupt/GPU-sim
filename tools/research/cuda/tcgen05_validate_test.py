"""CPU-only validation tests. Fixtures below are synthetic, never hardware evidence."""
import copy
import unittest
from pathlib import Path

from tcgen05_validate import DOMAINS, EVENTS, M, N, ROLES, THREADS, cpu_reference, expected_source_lines, validate


SOURCE = Path(__file__).with_name("tcgen05_probe.cu").read_text()


def synthetic_fixture(variant="correct", iterations=2, base=9007199254740992):
    lines = expected_source_lines(SOURCE)
    data = {"format": "tcgen05-probe-v1", "source_contract": "tcgen05-probe-v1",
            "shape": [128, 32, 16], "dtype": "f16xf16-f32", "grid": [1, 1, 1], "block": [128, 1, 1],
            "iterations": iterations, "seed": 7, "generation_base": str(base), "variant": variant,
            "gpu": {"major": 10, "minor": 0}, "instruction_descriptor": 0x08080010,
            "lifecycle": {"allocated": True, "deallocated": True, "tmem_base": 0, "tmem_columns": 32, "barrier_address": 5120},
            "output": [], "reference": [], "events": []}
    for i in range(iterations):
        candidate = i + 2 if variant == "correct" else i
        selected = candidate if variant != "fixed" else i + 2
        output = cpu_reference(7, selected)
        data["output"].extend(output)
        data["reference"].extend(cpu_reference(7, i + 2))
        for offset, (role, thread) in enumerate(zip(ROLES, THREADS)):
            data["events"].append({"id": f"i{i}:e{offset}", "event_layout_index": i * EVENTS + offset,
                "iteration": i, "role": role, "domain": DOMAINS[role], "thread": thread, "warp_id": thread // 32,
                "expected_generation": str(base + i + 2), "observed_generation": str(base + selected),
                "barrier_generation": str(i), "barrier_phase": i % 2, "candidate_input": candidate,
                "selected_input": selected, "repaired": variant == "fixed", "tmem_base": 0, "tmem_columns": 32,
                "barrier_address": 5120, "descriptor_a": str((8 << 16) | (16 << 32) | (1 << 46)),
                "descriptor_b": str((8 << 16) | (16 << 32) | (1 << 46) | 256),
                "wait_success": offset >= 2, "failed_wait_polls": 0, "clock64": str(i * 100 + offset),
                "source_line": lines[role], "representative_value": output[thread * N] if offset >= 6 else 0})
    wrong = variant == "wrong-version"
    data["correctness"] = {"elements": iterations * M * N,
        "expected_value_mismatches": iterations * M * N if wrong else 0,
        "selected_source_mismatches": 0, "version_mismatches": iterations if wrong else 0,
        "max_abs_error": max(abs(a - b) for a, b in zip(data["output"], data["reference"])),
        "passed": not wrong, "exact_integer_reference": True}
    return data


class Tcgen05ValidationTest(unittest.TestCase):
    def test_controlled_triplet_and_large_generation(self):
        for variant in ("correct", "wrong-version", "fixed"):
            with self.subTest(variant=variant):
                result = validate(synthetic_fixture(variant), SOURCE)
                self.assertEqual(result["correctness"]["passed"], variant != "wrong-version")
                self.assertEqual(result["same_parity_wrong_generation_iterations"], 2 if variant == "wrong-version" else 0)

    def test_cpu_reference_one_explicit_dot_product(self):
        # Independently listed first A/B vectors: seed=0, input=0, row=0, col=0.
        a = [-1, 4, 2, 0, 5, 3, 1, -1, 4, 2, 0, 5, 3, 1, -1, 4]
        b = [1, 4, 2, 5, 3, 1, 4, 2, 5, 3, 1, 4, 2, 5, 3, 1]
        self.assertEqual(cpu_reference(0, 0)[0], sum(x * y for x, y in zip(a, b)))

    def test_nonzero_allocated_column_base(self):
        data = synthetic_fixture()
        data["lifecycle"]["tmem_base"] = 480
        for event in data["events"]:
            event["tmem_base"] = 480
        validate(data, SOURCE)

    def test_rejects_missing_or_premature_completion(self):
        for mutation in ("missing", "false_wait", "issued_as_complete", "wrong_facet"):
            data = synthetic_fixture()
            if mutation == "missing": data["events"].pop(2)
            if mutation == "false_wait": data["events"][2]["wait_success"] = False
            if mutation == "issued_as_complete": data["events"][1]["wait_success"] = True
            if mutation == "wrong_facet": data["events"][2]["domain"] = "smem_read_complete"
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): validate(data, SOURCE)

    def test_rejects_parity_only_or_conflicting_generation(self):
        for value in (0, "0", "9007199254740992"):
            data = synthetic_fixture()
            data["events"][2]["observed_generation"] = value
            with self.subTest(value=value), self.assertRaises(ValueError): validate(data, SOURCE)

    def test_rejects_numerical_or_report_tampering(self):
        for target in ("output", "reference", "summary", "reader_value"):
            data = synthetic_fixture()
            if target in ("output", "reference"): data[target][1] += 1
            elif target == "summary": data["correctness"]["expected_value_mismatches"] = 1
            else: data["events"][7]["representative_value"] += 1
            with self.subTest(target=target), self.assertRaises(ValueError): validate(data, SOURCE)

    def test_rejects_wrong_source_or_descriptor(self):
        for target in ("source_line", "descriptor_a", "selected_input"):
            data = synthetic_fixture()
            if target == "descriptor_a": data["events"][0][target] = "0"
            else: data["events"][0][target] += 1
            with self.subTest(target=target), self.assertRaises(ValueError): validate(data, SOURCE)

    def test_rejects_incomplete_deallocation(self):
        data = synthetic_fixture()
        data["lifecycle"]["deallocated"] = False
        with self.assertRaises(ValueError): validate(data, SOURCE)

    def test_does_not_infer_hb_from_clocks(self):
        data = synthetic_fixture()
        for event in data["events"]:
            event["clock64"] = "0"
        validate(data, SOURCE)


if __name__ == "__main__":
    unittest.main()
