#!/usr/bin/env python3
"""Guarded two-layer FP32 MLP block follow-up; no full-model claim."""
from datetime import datetime, timezone
import hashlib
import json
import platform
from pathlib import Path
import random
import statistics
import subprocess
import time

ROOT=Path(__file__).resolve().parents[3]
DIRECTORY=Path(__file__).resolve().parent


def main():
    stamp=datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output=ROOT/"out/research/cuda"/(stamp+"-mlp")
    output.mkdir(parents=True,exist_ok=False)
    summary={"schema":1,"status":"running","started_utc":stamp,"platform":platform.platform(),
        "operator":"bias-free, unfused ReLU(X W1) W2","shape_order":"B,I,H,O",
        "scope":"Resident-input two-layer MLP block; no H2D, allocation, JIT, complete model, or request latency",
        "provenance":"This-session assistant-authored integration of measured GEMM candidates, not an upstream application or naturally generated model kernel",
        "reference":"CPU double first GEMM, explicit FP32 intermediate rounding, ReLU, CPU double second GEMM",
        "tolerance":{"atol":3e-4,"rtol":3e-4,"input_domain":"xorshift32 inputs and weights in [-1,1)"},
        "cublas_math":"CUBLAS_PEDANTIC_MATH; CUBLAS_ATOMICS_NOT_ALLOWED",
        "source_sha256":{},"verification":[],"benchmark":[],"commands":[],"gpu_states":[],
        "limitations":["Shared host idle windows, not a reserved GPU","One session per shape/comparison; intervals are conditional on its pairs",
                       "Separate GEMM/ReLU kernels; no fusion claim","No block bottleneck attribution or independent human-understanding evidence"]}
    for name in ["mlp_pilot.cu","gemm_pilot.cu","run_mlp_pilot.py"]:
        data=(DIRECTORY/name).read_bytes();(output/name).write_bytes(data)
        summary["source_sha256"][name]=hashlib.sha256(data).hexdigest()

    def save(): (output/"summary.json").write_text(json.dumps(summary,indent=2,allow_nan=False)+"\n")

    def run(name,cmd):
        print(name,flush=True);before=time.monotonic()
        try:
            p=subprocess.run([str(x) for x in cmd],cwd=ROOT,text=True,capture_output=True,timeout=45)
            stdout,stderr,code=p.stdout,p.stderr,p.returncode
        except subprocess.TimeoutExpired as e:
            def text(v):return v.decode(errors="replace") if isinstance(v,bytes) else (v or "")
            stdout,stderr,code=text(e.stdout),text(e.stderr)+"\nTIMEOUT",124
        (output/(name+".stdout.txt")).write_text(stdout);(output/(name+".stderr.txt")).write_text(stderr)
        summary["commands"].append({"name":name,"argv":[str(x) for x in cmd],"exit_code":code,"seconds":time.monotonic()-before})
        save()
        if code!=0:raise RuntimeError(f"{name} failed, exit {code}; original logs retained")
        return stdout

    def idle(label):
        quiet=0
        for attempt in range(16):
            raw=subprocess.check_output(["nvidia-smi","--query-gpu=utilization.gpu,memory.used,memory.free,temperature.gpu,clocks.sm,clocks.mem,pstate","--format=csv,noheader,nounits"],text=True).strip()
            processes=subprocess.check_output(["nvidia-smi","--query-compute-apps=pid,used_memory","--format=csv,noheader,nounits"],text=True).strip()
            fields=[x.strip() for x in raw.split(",")]
            summary["gpu_states"].append({"label":label,"utc":datetime.now(timezone.utc).isoformat(),"gpu_state":fields,"other_cuda_processes":processes.splitlines()})
            save()
            if len(raw.splitlines())!=1 or int(fields[2])<512:raise RuntimeError("Unexpected topology or insufficient free memory")
            quiet=quiet+1 if int(fields[0])<=5 and not processes else 0
            if quiet==3:return
            time.sleep(.5)
        raise RuntimeError("GPU remained busy: stopped without additional launches")

    try:
        idle("initial")
        summary["git_head"]=subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip()
        for name,cmd in [("gpu_identity",["nvidia-smi","--query-gpu=name,compute_cap,driver_version,memory.total","--format=csv,noheader"]),
                         ("nvcc_version",["/usr/local/cuda-12.6/bin/nvcc","--version"]),
                         ("host_compiler_version",["g++","--version"])]:summary[name]=run(name,cmd).strip()
        binary=output/"mlp_pilot"
        run("compile",["/usr/local/cuda-12.6/bin/nvcc","-std=c++17","-O3","-lineinfo","-arch=sm_89",
            "--ptxas-options=-v",DIRECTORY/"mlp_pilot.cu","-lcublas","-Xlinker","-rpath","-Xlinker","/usr/local/cuda-12.6/lib64","-o",binary])
        summary["binary_sha256"]=hashlib.sha256(binary.read_bytes()).hexdigest()
        for batch in [16,64,128]:
            idle("before_verify_batch_"+str(batch))
            for seed in [20261023,20261024]:
                for candidate in ["baseline","tiled","cublas"]:
                    text=run(f"verify_{batch}_{seed}_{candidate}",[binary,"--mode","verify","--batch",batch,"--seed",seed,"--candidate",candidate])
                    summary["verification"].append(json.loads(text));save()
            idle("after_verify_batch_"+str(batch))
        for batch in [16,64,128]:
            for comparison in ["baseline-tiled","tiled-cublas"]:
                name=f"benchmark_{batch}_{comparison}";idle("before_"+name)
                data=json.loads(run(name,[binary,"--mode","benchmark","--batch",batch,"--comparison",comparison]))
                a,b=comparison.split("-");samples=data["samples"]
                av=[s[a+"_ms"] for s in samples];bv=[s[b+"_ms"] for s in samples]
                rng=random.Random(20261023);ratios=[]
                for _ in range(2000):
                    indexes=[rng.randrange(len(samples)) for _ in samples]
                    ratios.append(sum(av[i] for i in indexes)/sum(bv[i] for i in indexes))
                ratios.sort()
                data["statistics"]={a+"_median_ms":statistics.median(av),b+"_median_ms":statistics.median(bv),
                    "speedup_ratio_of_paired_means":statistics.mean(av)/statistics.mean(bv),"ratio_definition":a+"_ms / "+b+"_ms",
                    "paired_bootstrap_ci95":[ratios[49],ratios[1949]],"bootstrap_resamples":2000}
                summary["benchmark"].append(data);save();idle("after_"+name)
        summary["status"]="completed"
    except Exception as error:
        summary["status"]="stopped";summary["stop_reason"]=str(error);raise
    finally:
        summary["finished_utc"]=datetime.now(timezone.utc).isoformat();save();print("Artifacts: "+str(output),flush=True)


if __name__=="__main__":main()
