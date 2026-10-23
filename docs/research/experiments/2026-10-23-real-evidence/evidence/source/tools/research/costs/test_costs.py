import importlib.util
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE/file)
    result = importlib.util.module_from_spec(spec);spec.loader.exec_module(result)
    return result


prepare = module("prepare_cost", "prepare-version-kernel.py")
cost = module("run_cost", "run-version-cost.py")


class CostTests(unittest.TestCase):
    def test_immutable_source_gate(self):
        raw = (HERE.parent/"cuda/version_probe.cu").read_bytes()
        derived = prepare.derive(raw).decode()
        self.assertEqual(derived.count("__syncthreads()"), raw.decode().count("__syncthreads()"))
        self.assertIn("output[generation * count + index] = value;", derived)
        self.assertEqual(derived.count("if constexpr (Record) cost_emit("), 5)
        with self.assertRaises(ValueError): prepare.derive(raw+b"\n")

    def test_oracle_rejects_numerical_corruption(self):
        record = {"count": 1, "generations": 1, "seed": 7, "instrumented": False,
                  "output": [(7 ^ 2654435769 ^ (11*2246822507)) & 8388607]}
        self.assertTrue(cost.validate_payload(record)["passed"])
        record["output"][0] += 1
        with self.assertRaises(ValueError): cost.validate_payload(record)

    def test_pairing_requires_same_seed_and_two_distinct_modes(self):
        row = {"count": 1, "generations": 1, "session": 0, "pair": 0, "instrumented": False,
               "seed": 7, "order": 0}
        with self.assertRaises(ValueError): cost.summarize([row])
        with self.assertRaises(ValueError): cost.summarize([row, row])
        with self.assertRaises(ValueError): cost.summarize([row, {**row, "instrumented": True, "seed": 9, "order": 1}])

    def test_quantiles_do_not_hide_outlier(self):
        result = cost.quantiles([1, 2, 3, 1000])
        self.assertEqual(result["median"], 2.5)
        self.assertGreater(result["p95"], 800)
        self.assertEqual(result["max"], 1000)


if __name__ == "__main__": unittest.main()
