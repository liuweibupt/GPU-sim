"""Failure-oriented tests for raw evidence boundaries and lossless encoding."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest


PATH = Path(__file__).resolve().parents[1] / "tools/research/extract-raw-evidence.py"
SPEC = importlib.util.spec_from_file_location("extract_raw_evidence", PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RawEvidenceTests(unittest.TestCase):
    def with_trace(self, text, callback):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.traceg"
            path.write_text(text)
            return callback(path)

    def test_all_warps_and_zero_masks_preserved(self):
        raw = ("#BEGIN_TB\nthread block = 0,0,0\nwarp = 0\ninsts = 1\n"
               "0000 00000000 0 EXIT 0 0 0 0 NoVal\n"
               "warp = 1\ninsts = 2\n0010 ffffffff 0 EXIT 0 0 0 0 NoVal\n"
               "0020 00000001 0 EXIT 0 0 0 0 NoVal\n#END_TB\n"
               "#BEGIN_TB\nthread block = 1,0,0\nwarp = 0\ninsts = 1\n"
               "0000 ffffffff 0 EXIT 0 0 0 0 NoVal\n#END_TB\n")
        metadata = self.with_trace(raw, lambda path: MODULE.collect_cta0_metadata(path, 2))
        self.assertEqual(metadata["declarations"], {0: 1, 1: 2})
        self.assertEqual([item["warp_ordinal"] for item in metadata["records"]], [0, 0, 1])
        self.assertEqual([item["file_record_ordinal"] for item in metadata["records"]], [0, 1, 2])
        self.assertEqual(metadata["records"][0]["tokens"][1], "00000000")

    def test_truncation_count_mismatch_and_missing_warp_rejected(self):
        prefix = ("#BEGIN_TB\nthread block = 0,0,0\nwarp = 0\ninsts = 1\n"
                  "0000 ffffffff 0 EXIT 0 0 0 0 NoVal\n")
        for raw, warps in [(prefix, 1), (prefix.replace("insts = 1", "insts = 2") + "#END_TB\n", 1),
                           (prefix + "#END_TB\n", 2)]:
            with self.subTest(warps=warps, raw=raw), self.assertRaises(ValueError):
                self.with_trace(raw, lambda path: MODULE.collect_cta0_metadata(path, warps))

    def test_hash_mismatch_rejected(self):
        with self.assertRaisesRegex(ValueError, "SHA256 mismatch"):
            self.with_trace("changed bytes", lambda path: MODULE.check_digest(path, "0" * 64))

    def instruction(self):
        return SimpleNamespace(cta=(0, 0, 0), warp_id=0, pc=16, active_mask=0,
            destinations=("R0",), sources=("R2",), opcode="MOV", memory_width_bytes=8,
            memory_addresses=(2**63 + 17,), destination_values=((2**64 - 1,),), source_values=((2**53 + 1,),),
            gmma_commit_group=False, tma_mbarrier_address=None, tma_multicast_mask=None,
            tma_byte_count=0, tma_oob_byte_count=0, immediate=-(2**63), immediate2=2**63,
            cluster_id=None, cluster_cta=None, cluster_rank=None, tmem_columns=None)

    def encoded(self):
        metadata = {"source_line": 20, "file_record_ordinal": 0, "cta_record_ordinal": 0, "warp_ordinal": 0}
        presence = {"gmma_commit_group": False, "tma_payload": False, "immediate": True,
                    "immediate2": True, "register_values": True}
        return MODULE.encode_instruction(self.instruction(), metadata, "a" * 64, "Val", presence)

    def test_large_integer_roundtrip_and_zero_mask(self):
        encoded = json.loads(json.dumps(self.encoded()))
        MODULE.validate_schema(encoded, MODULE.INSTRUCTION_SCHEMA)
        self.assertEqual(int(encoded["memory_addresses"][0], 16), 2**63 + 17)
        self.assertEqual(int(encoded["destination_values"][0][0], 16), 2**64 - 1)
        self.assertEqual(int(encoded["source_values"][0][0], 16), 2**53 + 1)
        self.assertEqual(int(encoded["immediate"]), -(2**63))
        self.assertEqual(encoded["active_mask"], 0)

    def test_strict_schema_rejects_extra_fields_and_invalid_mask(self):
        encoded = self.encoded()
        encoded["invented_completion_timestamp"] = 1
        with self.assertRaisesRegex(ValueError, "unexpected field"):
            MODULE.validate_schema(encoded, MODULE.INSTRUCTION_SCHEMA)
        encoded = self.encoded()
        encoded["active_mask"] = 2**32
        with self.assertRaisesRegex(ValueError, "outside integer range"):
            MODULE.validate_schema(encoded, MODULE.INSTRUCTION_SCHEMA)

    def test_missing_raw_v6_trailer_is_not_silently_defaulted(self):
        payload = SimpleNamespace(_memory_payload=lambda *args, **kwargs: SimpleNamespace(cursor=7))
        instruction = SimpleNamespace(opcode="MOV", active_mask=0xFFFFFFFF, is_tma=False)
        tokens = "0000 ffffffff 1 R0 MOV 0 0 0 0 NoVal".split()
        marker, _ = MODULE.validate_raw_trailer(tokens, instruction, 6, payload)
        self.assertEqual(marker, "NoVal")
        for shortened in (tokens[:-1], tokens[:-2], tokens[:-3]):
            with self.assertRaises(ValueError):
                MODULE.validate_raw_trailer(shortened, instruction, 6, payload)


if __name__ == "__main__":
    unittest.main()
