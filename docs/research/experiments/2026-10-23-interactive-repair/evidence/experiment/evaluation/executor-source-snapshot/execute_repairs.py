#!/usr/bin/env python3
"""Build untouched agent repair proposals against immutable before dependencies.

Only edits in the selected source file are permitted. This program never calls a
GPU or changes an upstream source/build tree. Failed proposals are evidence.
"""
import argparse
import base64
import copy
import csv
from datetime import datetime, timezone
import difflib
import hashlib
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import time
import zipfile

REPO = Path(__file__).resolve().parents[3]
NATURAL = REPO / "out/research/natural-bugs"
CUTLASS_HEADER = "include/cutlass/gemm/collective/sm90_mma_array_tma_gmma_ss_warpspecialized_fp8_blockwise_scaling.hpp"
TMEM_COMMIT = "08a3cd4364d87bf2c281067f7a40e17808f22e7b"
TMEM_AFTER = "0002b46dadfc6f8fbe7464c285651311c709fdc6"
TMEM_SOURCE = "lib/Dialect/TritonNvidiaGPU/Transforms/TensorMemoryAllocation.cpp"
TMEM_OBJECT = "lib/Dialect/TritonNvidiaGPU/Transforms/CMakeFiles/TritonNvidiaGPUTransforms.dir/TensorMemoryAllocation.cpp.o"


def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1048576), b""):
            h.update(chunk)
    return h.hexdigest()


def sha_bytes(value):
    return hashlib.sha256(value).hexdigest()


def apply_edits(source, edits):
    if not isinstance(edits, list):
        raise ValueError("edits must be a list")
    records = []
    for index, edit in enumerate(edits):
        if not isinstance(edit, dict) or set(edit) != {"old", "new"}:
            raise ValueError(f"edit {index} must contain exactly old,new")
        old, new = edit["old"], edit["new"]
        if not isinstance(old, str) or not old or not isinstance(new, str):
            raise ValueError(f"edit {index} requires nonempty string old and string new")
        occurrences = source.count(old)
        if occurrences != 1:
            raise ValueError(f"edit {index}: old occurs {occurrences} times; expected one")
        start = source.index(old)
        records.append({"index": index, "old_sha256": sha_bytes(old.encode()),
                        "new_sha256": sha_bytes(new.encode()), "source_line_before_edit": source.count("\n", 0, start)+1,
                        "old_bytes": len(old.encode()), "new_bytes": len(new.encode())})
        source = source.replace(old, new, 1)
    return source, records


def split_ninja_command(command):
    """Ninja emits these exact no-op wrappers for a link. Never use shell=True."""
    if command.startswith(": && ") and command.endswith(" && :"):
        command = command[5:-5]
    args = shlex.split(command)
    if any(token in {"&&", "||", ";", "|", ">", "<"} for token in args):
        raise ValueError("Unsupported shell command in Ninja output")
    return args


def replace_flag(args, flag, value):
    if args.count(flag) != 1:
        raise ValueError(f"Expected exactly one {flag}")
    args = list(args)
    index = args.index(flag)
    if index+1 == len(args):
        raise ValueError(f"Missing value for {flag}")
    args[index+1] = str(value)
    return args


def replace_one(args, old, new):
    if args.count(str(old)) != 1:
        raise ValueError(f"Expected exactly one dependency {old}")
    return [str(new) if x == str(old) else x for x in args]


def compile_argv(command, old_source, new_source, object_path):
    args = split_ninja_command(command)
    args = replace_one(args, old_source, new_source)
    args = replace_flag(args, "-o", object_path)
    args = replace_flag(args, "-MF", str(object_path)+".d")
    args = replace_flag(args, "-MT", object_path)
    return args


def link_argv(command, object_path, output):
    return replace_flag(replace_one(split_ninja_command(command), TMEM_OBJECT, object_path), "-o", output)


def replace_wheel_native(original, output, native):
    """Rebuild wheel RECORD and independently audit every decompressed member."""
    original, output, native = map(Path, (original, output, native))
    with zipfile.ZipFile(original) as zin:
        names = zin.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Duplicate wheel members")
        native_members = [n for n in names if n.endswith("/libtriton.so")]
        records = [n for n in names if n.endswith(".dist-info/RECORD")]
        if len(native_members) != 1 or len(records) != 1:
            raise ValueError("Expected one native library and one RECORD")
        member, record = native_members[0], records[0]
        if any(n.endswith(("/RECORD.jws", "/RECORD.p7s")) for n in names):
            raise ValueError("Signed wheel is unsupported")
        audits = []
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as zout:
            for info in zin.infolist():
                if info.filename == record:
                    continue
                h = hashlib.sha256(); size = 0
                source = native.open("rb") if info.filename == member else zin.open(info)
                # Preserve filenames, timestamps and permissions. Compression is
                # allowed to change; member bytes other than native/RECORD cannot.
                with source, zout.open(copy.copy(info), "w", force_zip64=True) as target:
                    for chunk in iter(lambda: source.read(1048576), b""):
                        target.write(chunk); h.update(chunk); size += len(chunk)
                audits.append({"path": info.filename, "sha256": h.hexdigest(), "bytes": size,
                               "changed": info.filename == member})
            lines = io.StringIO(newline=""); writer = csv.writer(lines, lineterminator="\n")
            for row in audits:
                digest = base64.urlsafe_b64encode(bytes.fromhex(row["sha256"])).rstrip(b"=").decode()
                writer.writerow([row["path"], "sha256="+digest, str(row["bytes"])])
            writer.writerow([record, "", ""])
            zout.writestr(copy.copy(zin.getinfo(record)), lines.getvalue().encode())
        with zipfile.ZipFile(output) as check:
            if set(check.namelist()) != set(names):
                raise ValueError("Wheel member names changed")
            for row in audits:
                h = hashlib.sha256()
                with check.open(row["path"]) as source:
                    for chunk in iter(lambda: source.read(1048576), b""):
                        h.update(chunk)
                if h.hexdigest() != row["sha256"]:
                    raise ValueError("Repacked member hash mismatch")
                if not row["changed"]:
                    original_hash = hashlib.sha256()
                    with zin.open(row["path"]) as source:
                        for chunk in iter(lambda: source.read(1048576), b""):
                            original_hash.update(chunk)
                    if original_hash.hexdigest() != row["sha256"]:
                        raise ValueError("Unrelated member changed")
            record_rows = list(csv.reader(io.StringIO(check.read(record).decode())))
            if len(record_rows) != len(names):
                raise ValueError("RECORD count mismatch")
    return {"original_wheel_sha256": sha(original), "candidate_wheel_sha256": sha(output),
            "native_member": member, "native_sha256": sha(native), "record_member": record,
            "member_count": len(names), "unchanged_member_count": len(names)-2,
            "members": audits, "scope": "Only native library and RECORD bytes differ; archive compression may differ."}


class Builder:
    def __init__(self, args):
        self.args = args; self.out = args.output.resolve()
        self.out.mkdir(parents=True, exist_ok=False)
        self.result = {"schema": "natural-agent-repair-build-v1", "family": args.family,
                       "started_utc": datetime.now(timezone.utc).isoformat(), "status": "running",
                       "answer_sha256": sha(args.answer), "executor_sha256": sha(__file__),
                       "commands": [], "artifacts": {}, "gpu_executed": False}
        shutil.copyfile(args.answer, self.out/"answer.json")
        self.dependencies = {}; self.save()

    def save(self):
        (self.out/"result.json").write_text(json.dumps(self.result, indent=2)+"\n")

    def depend(self, path):
        path = Path(path).resolve(); self.dependencies[str(path)] = sha(path)

    def artifact(self, name, path):
        path = Path(path)
        self.result["artifacts"][name] = {"path": str(path.relative_to(self.out)), "sha256": sha(path), "bytes": path.stat().st_size}

    def command(self, name, argv, cwd, timeout=600):
        started = datetime.now(timezone.utc).isoformat(); start = time.monotonic()
        env = os.environ.copy(); env["CCACHE_DISABLE"] = "1"
        stdout_path, stderr_path = self.out/(name+".stdout.txt"), self.out/(name+".stderr.txt")
        row = {"name": name, "argv": list(map(str, argv)), "cwd": str(cwd), "started_utc": started,
               "timeout_seconds": timeout, "timed_out": False}
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            try:
                proc = subprocess.Popen(argv, cwd=cwd, env=env, stdout=stdout, stderr=stderr, start_new_session=True)
                row["exit_code"] = proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
                row.update(exit_code=None, timed_out=True)
        row["wall_seconds"] = time.monotonic()-start
        row["finished_utc"] = datetime.now(timezone.utc).isoformat()
        row["stdout"] = {"path": stdout_path.name, "sha256": sha(stdout_path), "bytes": stdout_path.stat().st_size}
        row["stderr"] = {"path": stderr_path.name, "sha256": sha(stderr_path), "bytes": stderr_path.stat().st_size}
        self.result["commands"].append(row); self.save()
        return row

    def build(self):
        args = self.args
        if args.family == "cutlass":
            before = NATURAL/"cutlass/build-v1/before"
            original_path = before/"tree"/CUTLASS_HEADER
        else:
            before = NATURAL/"tmem/sources"/("triton-"+TMEM_COMMIT)
            original_path = before/TMEM_SOURCE
        self.depend(original_path)
        source_path = args.before_source.resolve() if args.before_source else original_path
        original = source_path.read_text()
        if source_path.read_bytes() != original_path.read_bytes():
            raise ValueError("Frozen source differs from actual before dependency")
        self.result["before_sha256"] = sha(source_path)
        if args.expected_before_sha256 and self.result["before_sha256"] != args.expected_before_sha256:
            raise ValueError("Frozen before hash mismatch")
        answer = json.loads(args.answer.read_text())
        if not isinstance(answer, dict) or "edits" not in answer:
            raise ValueError("Candidate answer must contain edits")
        modified, records = apply_edits(original, answer["edits"])
        self.result.update(candidate_sha256=sha_bytes(modified.encode()), edits=records,
                           no_op=modified == original, source_path=str(original_path))
        (self.out/"before-source.txt").write_text(original)
        candidate = self.out/("candidate.hpp" if args.family == "cutlass" else "candidate.cpp")
        candidate.write_text(modified); self.artifact("candidate_source", candidate)
        (self.out/"candidate.patch").write_text("".join(difflib.unified_diff(original.splitlines(True), modified.splitlines(True), fromfile="before", tofile="candidate")))
        self.save()
        if args.reuse:
            self.reuse(args.reuse); return
        if args.family == "cutlass": self.cutlass(before, candidate)
        else: self.tmem(before, candidate)

    def reuse(self, directory):
        directory = directory.resolve(); old = json.loads((directory/"result.json").read_text())
        for key in ("family", "before_sha256", "candidate_sha256"):
            if old.get(key) != self.result[key]: raise ValueError("Reuse mismatch: "+key)
        if old.get("status") != "built": raise ValueError("Only completed successful builds may be reused")
        if self.args.family == "tmem":
            lit = self.args.lit_input.resolve() if self.args.lit_input else NATURAL/"tmem/sources"/("triton-"+TMEM_AFTER)/"test/TritonNvidiaGPU/test_tensor_memory_allocation.mlir"
            if old.get("cpu_validation", {}).get("input_sha256") != sha(lit):
                raise ValueError("Reuse CPU regression input mismatch")
            self.depend(lit)
        for key, item in old["artifacts"].items():
            if key == "candidate_source": continue
            source = (directory/item["path"]).resolve()
            if not source.is_relative_to(directory) or sha(source) != item["sha256"]:
                raise ValueError("Reuse artifact hash/path mismatch")
            dest = self.out/item["path"]; dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, dest); self.artifact(key, dest)
        self.result.update(status="built", reused={"result_path": str(directory/"result.json"),
                           "result_sha256": sha(directory/"result.json"), "reason": "Identical complete candidate source SHA256"},
                           cpu_validation=old.get("cpu_validation"), wheel_audit=old.get("wheel_audit"))

    def cutlass(self, before, candidate):
        build_record = json.loads((before.parent/"build.json").read_text())["records"][0]
        self.depend(before.parent/"build.json"); self.depend(before/"cutlass_repro.cu")
        tree = self.out/"tree"; shutil.copytree(before/"tree", tree)
        shutil.copyfile(candidate, tree/CUTLASS_HEADER)
        source = self.out/"cutlass_repro.cu"; shutil.copyfile(before/"cutlass_repro.cu", source)
        self.result["observer_sha256"] = sha(source)
        binary = self.out/"cutlass_candidate"
        argv = [s.replace(str(before), str(self.out)) for s in build_record["argv"]]
        argv = replace_flag(argv, "-o", binary)
        row = self.command("compile", argv, self.out)
        if row["exit_code"] != 0:
            self.result["status"] = "compile_failed"; return
        self.artifact("binary", binary)
        changed = []
        for old in sorted((before/"tree").rglob("*")):
            if old.is_file():
                relative = old.relative_to(before/"tree")
                if sha(old) != sha(tree/relative): changed.append(str(relative))
        expected = [] if self.result["no_op"] else [CUTLASS_HEADER]
        if changed != expected: raise ValueError("CUTLASS tree changed outside candidate header")
        self.result.update(status="built", tree_audit={"changed_files": changed, "host_observer_unchanged": sha(source) == sha(before/"cutlass_repro.cu")})

    def tmem(self, before, candidate):
        base = NATURAL/"tmem"; build = before/"build/cmake.linux-x86_64-cpython-3.12"
        ninja = base/"build-env/bin/ninja"
        baseline_object = build/TMEM_OBJECT
        native_original = before/"build/lib.linux-x86_64-cpython-312/triton/_C/libtriton.so"
        for path in (baseline_object, native_original, build/"bin/triton-opt", build/"build.ninja"):
            self.depend(path)
        object_path = self.out/"TensorMemoryAllocation.cpp.o"
        native = self.out/"libtriton.so"; opt = self.out/"triton-opt"
        for name, target, output in [("compile", TMEM_OBJECT, object_path), ("link_native", "libtriton.so", native), ("link_opt", "bin/triton-opt", opt)]:
            query = self.command(name+"_command", [str(ninja), "-C", str(build), "-t", "commands", target], self.out, 60)
            if query["exit_code"] != 0: raise ValueError("Ninja command extraction failed")
            command = (self.out/query["stdout"]["path"]).read_text().splitlines()[-1]
            argv = compile_argv(command, before/TMEM_SOURCE, candidate, output) if name == "compile" else link_argv(command, object_path, output)
            row = self.command(name, argv, build)
            if row["exit_code"] != 0:
                self.result["status"] = "compile_failed"; return
            self.artifact(name, output)
        lit = self.args.lit_input.resolve() if self.args.lit_input else base/"sources"/("triton-"+TMEM_AFTER)/"test/TritonNvidiaGPU/test_tensor_memory_allocation.mlir"
        self.depend(lit); shutil.copyfile(lit, self.out/"cpu-regression.mlir")
        llvm = list((base/"dependencies/.triton/llvm").glob("llvm-b010a18d-*/bin/FileCheck"))
        if len(llvm) != 1: raise ValueError("Pinned FileCheck not unique")
        self.depend(llvm[0])
        row = self.command("lit_compile", [str(opt), str(lit), "-split-input-file", "-allow-unregistered-dialect", "-triton-tensor-memory-allocation"], self.out, 60)
        check = None
        if row["exit_code"] == 0:
            check = self.command("lit_filecheck", [str(llvm[0]), str(lit), "--input-file", str(self.out/"lit_compile.stdout.txt")], self.out, 60)
        self.result["cpu_validation"] = {"input_sha256": sha(lit), "compile_exit_code": row["exit_code"],
                                         "filecheck_exit_code": check["exit_code"] if check else None,
                                         "passed": row["exit_code"] == 0 and check is not None and check["exit_code"] == 0,
                                         "scope": "Frozen upstream allocation lit; CPU compiler validation, not GPU execution."}
        wheels = list((base/"wheels/before").glob("*.whl"))
        if len(wheels) != 1: raise ValueError("Original wheel not unique")
        self.depend(wheels[0]); wheel = self.out/wheels[0].name
        start = time.monotonic(); audit = replace_wheel_native(wheels[0], wheel, native)
        audit["wall_seconds"] = time.monotonic()-start
        (self.out/"wheel-audit.json").write_text(json.dumps(audit, indent=2)+"\n")
        self.result["wheel_audit"] = {key: value for key, value in audit.items() if key != "members"}
        self.artifact("wheel", wheel); self.artifact("wheel_audit", self.out/"wheel-audit.json")
        self.result["status"] = "built"

    def finish(self):
        self.result["source_dependency_audit"] = []
        for path, expected in self.dependencies.items():
            observed = sha(path)
            self.result["source_dependency_audit"].append({"path": path, "sha256_before": expected,
                                                          "sha256_after": observed, "unchanged": observed == expected})
        if not all(row["unchanged"] for row in self.result["source_dependency_audit"]):
            self.result["status"] = "dependency_modified"
        self.result["finished_utc"] = datetime.now(timezone.utc).isoformat(); self.save()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--family", choices=["cutlass", "tmem"], required=True)
    p.add_argument("--answer", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--before-source", type=Path)
    p.add_argument("--expected-before-sha256")
    p.add_argument("--reuse", type=Path)
    p.add_argument("--lit-input", type=Path)
    args = p.parse_args(); args.answer = args.answer.resolve()
    builder = Builder(args)
    try:
        builder.build()
    except Exception as error:
        builder.result.update(status="execution_error", error_type=type(error).__name__, error=str(error))
    finally:
        builder.finish()
    print(json.dumps({"output": str(builder.out), "status": builder.result["status"],
                      "candidate_sha256": builder.result.get("candidate_sha256"),
                      "cpu_validation": builder.result.get("cpu_validation")}))
    return 0 if builder.result["status"] == "built" else 1


if __name__ == "__main__":
    raise SystemExit(main())
