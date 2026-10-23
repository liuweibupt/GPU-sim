import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("archive_modern", Path(__file__).resolve().parents[1] / "tools/research/archive-modern-evidence.py")
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class ModernArchive(unittest.TestCase):
    def test_missing_input_rejected_before_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "input"
            source.mkdir()
            (source / "data.txt").write_text("valid input")
            with self.assertRaises(ValueError):
                M.archive([("valid", source), ("missing", root / "typo")], root / "archive")
            self.assertFalse((root / "archive").exists())

    def test_roundtrip_and_corruption_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "input"
            source.mkdir()
            (source / "raw.txt").write_bytes(b"hardware observation\n" * 10000)
            result = M.archive([("run", source)], root / "archive")
            self.assertEqual(result["files"], 1)
            M.extract(root / "archive", root / "restored")
            self.assertEqual((root / "restored/run/raw.txt").read_bytes(), (source / "raw.txt").read_bytes())
            path = root / "archive/run/raw.txt.gz"
            path.write_bytes(path.read_bytes()[:-1])
            with self.assertRaises(ValueError):
                M.verify(root / "archive")

    def test_modal_mismatched_hash_rejected(self):
        import json
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "job.json").write_text("changed")
            (root / "summary.json").write_text(json.dumps({"format": "modal-gpu-evidence-job-v1", "job_sha256": "0" * 64}))
            with self.assertRaises(ValueError):
                M.validate_modal(root)


if __name__ == "__main__":
    unittest.main()
