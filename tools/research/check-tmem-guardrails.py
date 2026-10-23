#!/usr/bin/env python3
"""Verify the strictly sm_100a-only TMEM guardrail supplementary job."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = args.input / "tcgen05_probe.cu"
    helper = Path(__file__).parent / "cuda/tcgen05_validate.py"
    if sha(source.read_bytes()) != "76a8b4f7c11d1e5c20540ce01414d131bf17a72171256f9ef1b0a11f6ef072a8":
        raise ValueError("source contract changed")
    if sha(helper.read_bytes()) != "b81ff55503f24c588e8bf80de976113572f8f60dfa7baaf1d9cb38c6244b416b":
        raise ValueError("CPU oracle changed")
    spec = importlib.util.spec_from_file_location("tcgen_oracle", helper)
    oracle = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(oracle)
    raw_summary = (args.input / "summary.json").read_bytes()
    doc = json.loads(raw_summary)
    if doc["status"] != "completed" or doc["requested_gpu"] != "B200":
        raise ValueError("completed B200 job required")
    if doc["source_sha256"].get("tcgen05_probe.cu") != sha(source.read_bytes()):
        raise ValueError("source does not bind to uploaded job")
    commands = {c["name"]: c for c in doc["execution"]["commands"]}
    if len(commands) != len(doc["execution"]["commands"]):
        raise ValueError("duplicate command name")

    def stream(command, name):
        ref = command[name]
        raw = (args.input / ref["path"]).read_bytes()
        if sha(raw) != ref["sha256"] or len(raw) != ref["bytes"]:
            raise ValueError("raw command log hash mismatch")
        return raw.decode()

    compile_cmd = commands["guardrail_compile"]
    argv = compile_cmd["argv"]
    for name in ("guardrail_compile", "guardrail_sass"):
        command = commands[name]
        if command["exit_code"] != 0 or command["timed_out"] or not command["accepted_exit"]:
            raise ValueError("compile/disassembly did not complete successfully")
    if argv[0] != "nvcc" or argv[-3:] != ["tcgen05_probe.cu", "-o", "tcgen05_guard"]:
        raise ValueError("unexpected compiler source/binary binding")
    if commands["guardrail_sass"]["argv"] != ["cuobjdump", "--dump-sass", "tcgen05_guard"]:
        raise ValueError("disassembly does not name the tested binary")
    if "-Xptxas=-g-tmem-access-check" not in argv or "arch=compute_100a,code=sm_100a" not in argv:
        raise ValueError("explicit guardrails and architecture-only gencode required")
    compiler_diagnostics = stream(compile_cmd, "stdout") + stream(compile_cmd, "stderr")
    if re.search(r"not supported|unsupported|will be ignored", compiler_diagnostics, re.I):
        raise ValueError("guardrail compiler support is ambiguous")
    sass = stream(commands["guardrail_sass"], "stdout")
    if "arch = sm_100a" not in sass or not all(op in sass for op in ("UTCHMMA", "LDTM", "BPT.TRAP")):
        raise ValueError("required instrumented target/static instructions missing")
    rows = []
    for variant, expected_code in (("correct", 0), ("wrong-version", 2), ("fixed", 0)):
        command = commands["guardrail_" + variant]
        if command["argv"] != ["compute-sanitizer", "--tool", "memcheck", "--error-exitcode", "99",
                                "./tcgen05_guard", "5", "7", variant]:
            raise ValueError("unexpected memcheck command/binary/variant")
        stdout, stderr = stream(command, "stdout"), stream(command, "stderr")
        if command["exit_code"] != expected_code or command["timed_out"]:
            raise ValueError("unexpected application/sanitizer exit")
        joined = stdout + stderr
        if "ERROR SUMMARY: 0 errors" not in joined or re.search(r"unsupported|not supported|not instrumented", joined, re.I):
            raise ValueError("memcheck did not report a clean supported execution")
        records = [(i + 1, json.loads(line)) for i, line in enumerate(stdout.splitlines()) if line.startswith('{')]
        if len(records) != 1:
            raise ValueError("exactly one output record expected")
        line, record = records[0]
        if record["variant"] != variant:
            raise ValueError("output record does not match requested variant")
        validation = oracle.validate(record, source.read_text())
        rows.append({"variant": variant, "raw_stdout": command["stdout"], "json_line": line,
                     "exit_code": command["exit_code"], "memcheck_errors": 0, "validation": validation})
    report = {"format": "tmem-guardrail-supplement-v1", "status": "verified",
              "job_summary_sha256": sha(raw_summary), "source_sha256": sha(source.read_bytes()),
              "validator_sha256": sha(helper.read_bytes()), "checker_sha256": sha(Path(__file__).read_bytes()),
              "compile_argv": argv, "static_trap_instructions": sass.count("BPT.TRAP"), "rows": rows,
              "claim": "Guardrail-enabled memcheck on three representative legal-access variants; all numerical outputs independently checked.",
              "limits": ["Separate instrumented build, excluded from the 36-run normal suite.",
                         "No intentionally invalid TMEM access was injected to estimate guardrail detection sensitivity.",
                         "Guardrail coverage is access/allocation diagnostics, not logical generation correctness or full PTX synchronization proof."]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"status": "verified", "runs": len(rows), "static_trap_instructions": report["static_trap_instructions"]}))


if __name__ == "__main__":
    main()
