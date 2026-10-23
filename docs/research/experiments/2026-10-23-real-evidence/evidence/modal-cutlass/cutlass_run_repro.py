#!/usr/bin/env python3
"""Run a frozen reduced-shape CUTLASS #2547 release-pair matrix on SM90.

Every invocation has its own CUDA context and directory. Raw observed/reference/C
FP8 bytes are retained; K=0 is also checked with a separate beta*C oracle in the
host observation patch. Report timeouts and API errors, never count them as
numerical mismatches or sanitizer detections.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import time

ISSUE_K = [0,768,384,0,0,0,0,256,0,0,1408,0,256,768,256,128,384,384,0,640,0,128,384,512,0,0,128,128,0,128,0,128]
CASES = {"positive": [128,256,128], "zero-first": [0,128,256], "zero-middle": [128,0,256], "zero-last": [128,256,0], "all-zero": [0,0,0], "issue32-reduced": ISSUE_K}

def sha(data):
    return hashlib.sha256(data).hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", type=Path, required=True)
    parser.add_argument("--after", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=10)
    parser.add_argument("--sanitizer", action="store_true")
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    binaries = {"before": args.before.resolve(), "after": args.after.resolve()}
    matrix = [{"variant":variant,"case":name,"k":ks,"m":128,"n":128,"host_shapes":host,"beta":beta,"tool":"normal"}
              for name,ks in CASES.items() for beta in (0,1) for host in (0,1) for variant in ("before","after")]
    if args.sanitizer:
        matrix += [{"variant":"after","case":name,"k":CASES[name],"m":128,"n":128,"host_shapes":host,"beta":1,"tool":"memcheck"}
                   for name in ("zero-first","zero-middle") for host in (0,1)]
    frozen = {"schema":"cutlass-zero-k-matrix-v1", "frozen_utc":datetime.now(timezone.utc).isoformat(), "adaptations":["M=N=128 instead of original 4096", "grouped example 68 (issue text names 67)", "separate process per host-shape mode", "host-only full output observation"], "binary_sha256":{v:sha(p.read_bytes()) for v,p in binaries.items()}, "matrix":matrix}
    (root/"matrix.json").write_text(json.dumps(frozen,indent=2)+"\n")
    records=[]
    for index, case in enumerate(matrix):
        case_id=f"{index:03d}-{case['variant']}-{case['case']}-b{case['beta']}-h{case['host_shapes']}-{case['tool']}"
        cwd=root/case_id
        cwd.mkdir()
        (cwd/"shapes.txt").write_text("".join(f"{i} {case['m']}x{case['n']}x{k}\n" for i,k in enumerate(case['k'])))
        binary=binaries[case['variant']]
        binary.chmod(0o700)
        argv=[str(binary),"--benchmark=shapes.txt","--iterations=0","--raster=h","--swizzle=1","--alpha=1",f"--beta={case['beta']}",f"--host-shapes={case['host_shapes']}"]
        if case['tool']=="memcheck":
            argv=["compute-sanitizer","--tool","memcheck","--error-exitcode","86"]+argv
        start=time.monotonic()
        record={"id":case_id, **case, "argv":argv}
        try:
            process=subprocess.run(argv,cwd=cwd,capture_output=True,timeout=args.timeout if case['tool']=="normal" else 30)
            stdout,stderr=process.stdout,process.stderr
            record.update(exit_code=process.returncode,timed_out=False)
        except subprocess.TimeoutExpired as error:
            stdout,stderr=error.stdout or b"",error.stderr or b""
            record.update(exit_code=None,timed_out=True)
        record["command_wall_seconds"]=time.monotonic()-start
        for name,data in (("stdout.txt",stdout),("stderr.txt",stderr)):
            (cwd/name).write_bytes(data)
        groups=[]
        for line in stdout.decode(errors="replace").splitlines():
            if line.startswith("EVIDENCE {"):
                groups.append(json.loads(line[len("EVIDENCE "):]))
        record["groups"]=groups
        record["outputs_checked"]=sum(g["outputs"] for g in groups)
        record["mismatches"]=sum(g["mismatches"] for g in groups)
        record["zero_k_mismatches"]=sum(g["zero_k_mismatches"] for g in groups)
        text=(stdout+stderr).decode(errors="replace")
        record["result"]=("timeout" if record["timed_out"] else "tma_descriptor_error" if "Failed to initialize the TMA descriptor" in text else "numerical_failure" if record["mismatches"] or record["zero_k_mismatches"] else "passed" if record["exit_code"]==0 and len(groups)==len(case["k"]) else "execution_error")
        record["sanitizer_clean"]=case["tool"]=="memcheck" and "ERROR SUMMARY: 0 errors" in text and record["result"]=="passed"
        record["files"]=[{"path":p.name,"bytes":p.stat().st_size,"sha256":sha(p.read_bytes())} for p in sorted(cwd.iterdir()) if p.is_file()]
        (cwd/"record.json").write_text(json.dumps(record,indent=2)+"\n")
        records.append(record)
        (root/"results.json").write_text(json.dumps({"format":"cutlass-natural-reproduction-v1","matrix_sha256":sha((root/"matrix.json").read_bytes()),"records":records},indent=2)+"\n")
        print(json.dumps({"id":case_id,"result":record["result"],"outputs":record["outputs_checked"]}),flush=True)

if __name__=="__main__":
    main()
