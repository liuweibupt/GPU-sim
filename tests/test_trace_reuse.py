"""Independent small fixtures for the cache adapter's nontrivial guarantees."""
import copy
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("trace_reuse", Path(__file__).parents[1] / "tools/research/run-trace-experiments.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def instruction(opcode="IADD3", sources=(), destinations=(), **extra):
    return {"opcode": opcode, "sources": list(sources), "destinations": list(destinations), **extra}


class TraceReuseTest(unittest.TestCase):
    def test_tmem_alloc_free_and_tensor_mma_are_distinct_mechanisms(self):
        self.assertIn("tmem_sass", MODULE.mechanisms(instruction("UTCATOMSWS.FIND_AND_SET.ALIGN")))
        self.assertIn("tmem_sass", MODULE.mechanisms(instruction("UTCATOMSWS.AND")))
        self.assertIn("tcgen05_mma_sass", MODULE.mechanisms(instruction("UTCHMMA")))
        self.assertNotIn("tcgen05_mma_sass", MODULE.mechanisms(instruction("UTCATOMSWS.AND")))

    def test_register_read_before_write_and_zero_register(self):
        program = [instruction(destinations=("R0", "RZ")),
                   instruction(sources=("R0", "RZ"), destinations=("R0",)),
                   instruction(sources=("R0",))]
        candidates = [edge for edge in MODULE.build_graph(program) if edge[2] == "syntactic_register"]
        self.assertEqual(candidates, [(0, 1, "syntactic_register"), (1, 2, "syntactic_register")])

    def test_symbolic_address_zero_is_not_missing_and_no_cross_token_edge(self):
        program = [instruction(barrier_action={"address": 0}),
                   instruction(barrier_action={"address": 1}),
                   instruction(barrier_wait={"address": 0})]
        edges = MODULE.build_graph(program)
        self.assertIn((0, 2, "symbolic_barrier_candidate"), edges)
        self.assertNotIn((1, 2, "symbolic_barrier_candidate"), edges)

    def test_scoreboard_slots_are_separate_from_mbarrier_tokens(self):
        program = [instruction(static_write_barrier=0),
                   instruction(barrier_action={"address": 0}),
                   instruction(static_wait_barriers=[0])]
        edges = MODULE.build_graph(program)
        self.assertIn((0, 2, "static_scoreboard_candidate"), edges)
        self.assertNotIn((1, 2, "static_scoreboard_candidate"), edges)

    def test_retrieval_has_expected_independent_sets(self):
        edges = [(0, 1, "order"), (1, 2, "order"), (2, 3, "order"), (3, 4, "order"),
                 (0, 2, "syntactic_register"), (2, 4, "syntactic_register"),
                 (1, 4, "symbolic_barrier_candidate")]
        query = MODULE.prepare_query(6, edges, [4])
        self.assertEqual(MODULE.retrieve(query, "full"), set(range(6)))
        self.assertEqual(MODULE.retrieve(query, "order_ancestors"), {0, 1, 2, 3, 4})
        self.assertEqual(MODULE.retrieve(query, "register_ancestors"), {0, 2, 4})
        self.assertEqual(MODULE.retrieve(query, "protocol_assisted"), {0, 1, 2, 4})

    def fixture(self):
        launch = {"trace_sha256": "a" * 64, "static_sass_sha256": "b" * 64, "binary_version": 100,
                  "cta_count": 3, "grid_shape": [3, 1, 1], "cta_instruction_counts": [2, 1, 2], "num_warps": 2}
        identity = {k: launch[k] for k in ("trace_sha256", "static_sass_sha256", "binary_version")}
        identity["launch_sha256"] = MODULE.canonical_hash(launch)
        payload = {"format": "ysim-complete-sass-dse-programs-v1", "launch": launch, "identity": identity, "cluster_execution": "independent",
                   "instruction_table": [{}, {}], "templates": [[[0, [0, 1]]], [[1, [1]]]], "template_ids": [0, 1, 0]}
        payload["payload_sha256"] = MODULE.canonical_hash(payload)
        entry = {**{k: launch[k] for k in ("trace_sha256", "static_sass_sha256", "binary_version")},
                 "gpu": "B200", "case": "fixture", "trace": "a", "output": "b", "output_sha256": "c" * 64,
                 "physical_cta_count": 3, "unique_template_count": 2, "template_instruction_count": 3, "status": "ok", "cluster_execution": "independent"}
        return payload, entry, copy.deepcopy(entry)

    def test_physical_weighting_and_template_counts(self):
        payload, entry, checkpoint = self.fixture()
        counts, weights = MODULE.validate_payload(payload, entry, checkpoint)
        self.assertEqual(counts, [2, 1])
        self.assertEqual(dict(weights), {0: 2, 1: 1})
        self.assertEqual(sum(counts[i] * weight for i, weight in weights.items()), 5)

    def test_corruption_rejected_even_when_identity_unchanged(self):
        payload, entry, checkpoint = self.fixture()
        payload["templates"][0][0][1][0] = 1
        with self.assertRaisesRegex(ValueError, "payload checksum"):
            MODULE.validate_payload(payload, entry, checkpoint)

    def test_invalid_reference_rejected_after_rehash(self):
        payload, entry, checkpoint = self.fixture()
        payload["templates"][0][0][1][0] = 2
        payload.pop("payload_sha256")
        payload["payload_sha256"] = MODULE.canonical_hash(payload)
        with self.assertRaisesRegex(ValueError, "invalid instruction id"):
            MODULE.validate_payload(payload, entry, checkpoint)

    def test_bad_cta_counts_rejected_after_rehash(self):
        payload, entry, checkpoint = self.fixture()
        payload["launch"]["cta_instruction_counts"] = [2, 1, 1]
        payload["identity"]["launch_sha256"] = MODULE.canonical_hash(payload["launch"])
        payload.pop("payload_sha256")
        payload["payload_sha256"] = MODULE.canonical_hash(payload)
        with self.assertRaisesRegex(ValueError, "physical instruction counts"):
            MODULE.validate_payload(payload, entry, checkpoint)

    def test_out_of_range_warp_rejected_after_rehash(self):
        payload, entry, checkpoint = self.fixture()
        payload["templates"][0][0][0] = 2
        payload.pop("payload_sha256")
        payload["payload_sha256"] = MODULE.canonical_hash(payload)
        with self.assertRaisesRegex(ValueError, "duplicate/invalid warp"):
            MODULE.validate_payload(payload, entry, checkpoint)

    def test_leader_substitution_contract_rejected_after_rehash(self):
        payload, entry, checkpoint = self.fixture()
        payload["cluster_execution"] = entry["cluster_execution"] = checkpoint["cluster_execution"] = "leader"
        payload.pop("payload_sha256")
        payload["payload_sha256"] = MODULE.canonical_hash(payload)
        with self.assertRaisesRegex(ValueError, "independent physical CTA contract"):
            MODULE.validate_payload(payload, entry, checkpoint)


if __name__ == "__main__":
    unittest.main()
