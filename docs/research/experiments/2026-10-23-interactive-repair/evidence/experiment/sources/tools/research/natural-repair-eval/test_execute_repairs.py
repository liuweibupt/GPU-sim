import base64
import csv
import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("repair_executor", Path(__file__).with_name("execute_repairs.py"))
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class RepairExecutorTests(unittest.TestCase):
    def test_edits_are_exact_and_sequential(self):
        result, rows = module.apply_edits("first\nold\nlast", [{"old": "old", "new": "middle"}, {"old": "middle", "new": "final"}])
        self.assertEqual(result, "first\nfinal\nlast")
        self.assertEqual(rows[0]["source_line_before_edit"], 2)

    def test_ambiguous_and_missing_rejected(self):
        for source, edits in [("x x", [{"old": "x", "new": "z"}]), ("x", [{"old": "y", "new": "z"}]),
                              ("x", [{"old": "", "new": "z"}]), ("x", [{"old": "x", "new": "z", "path": "other"}])]:
            with self.assertRaises(ValueError): module.apply_edits(source, edits)

    def test_compile_rewrites_all_outputs_only(self):
        argv = module.compile_argv("/usr/bin/clang++ -I/immutable -MD -MT old.o -MF old.d -o old.o -c /old.cpp", "/old.cpp", "/new.cpp", "/candidate/new.o")
        self.assertIn("-I/immutable", argv)
        self.assertEqual(argv[argv.index("-MF")+1], "/candidate/new.o.d")
        self.assertEqual(argv[argv.index("-MT")+1], "/candidate/new.o")
        self.assertNotIn("/old.cpp", argv)

    def test_link_has_one_dependency_and_no_shell(self):
        command = ": && clang++ a.o " + module.TMEM_OBJECT + " -o /old.so -lm && :"
        argv = module.link_argv(command, "/new.o", "/new.so")
        self.assertEqual(argv, ["clang++", "a.o", "/new.o", "-o", "/new.so", "-lm"])
        with self.assertRaises(ValueError): module.split_ninja_command("clang++ x && echo bad")
        with self.assertRaises(ValueError): module.link_argv(command.replace("a.o", module.TMEM_OBJECT), "/new.o", "/new.so")

    def test_wheel_updates_record_without_other_member_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder); old, new, native = folder/"old.whl", folder/"new.whl", folder/"libtriton.so"
            native.write_bytes(b"new native bytes")
            with zipfile.ZipFile(old, "w") as z:
                z.writestr("triton/_C/libtriton.so", b"old native")
                z.writestr("triton/backend.py", b"untouched source")
                z.writestr("triton-3.9.dist-info/RECORD", b"old record")
            audit = module.replace_wheel_native(old, new, native)
            self.assertEqual(audit["unchanged_member_count"], 1)
            with zipfile.ZipFile(new) as z:
                self.assertEqual(z.read("triton/backend.py"), b"untouched source")
                rows = list(csv.reader(io.StringIO(z.read("triton-3.9.dist-info/RECORD").decode())))
                for path, digest, size in rows:
                    if path.endswith("RECORD"):
                        self.assertEqual((digest, size), ("", "")); continue
                    content = z.read(path)
                    self.assertEqual(int(size), len(content))
                    self.assertEqual(digest, "sha256="+base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=").decode())


if __name__ == "__main__": unittest.main()
