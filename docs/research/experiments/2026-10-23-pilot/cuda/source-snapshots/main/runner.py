#!/usr/bin/env python3
"""Small, guarded SM89 pilot. All generated artifacts go to out/research/cuda."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import random
import statistics
import subprocess
import time

ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(__file__).with_name("gemm_pilot.cu")
NVCC = "/usr/local/cuda-12.6/bin/nvcc"
NCU = "/usr/local/cuda-13.1/bin/ncu"
SANITIZER = "/usr/local/cuda-13.1/bin/compute-sanitizer"
SHAPES = [(1,1,1),(7,13,5),(16,16,16),(17,19,23),(31,33,17),(64,48,80),
          (127,129,65),(128,128,128),(256,256,256),(256,384,128),
          (511,257,129),(512,512,512)]
BENCH_SHAPES = [(16,16,16),(31,33,17),(128,128,128),(256,256,256),
                (256,384,128),(511,257,129),(512,512,512)]
SEEDS = [20261023,20261024]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-only", action="store_true")
    parser.add_argument("--library-only", action="store_true",help="Separate tiled-vs-cuBLAS reference experiment")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.baseline_only and args.library_only:
        parser.error("Choose only one partial experiment")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output = (args.output or ROOT/"out/research/cuda"/stamp).resolve()
    if output.exists():
        raise SystemExit("Refusing to overwrite an existing run directory")
    output.mkdir(parents=True)
    (output/"source.cu").write_bytes(SOURCE.read_bytes())
    (output/"runner.py").write_bytes(Path(__file__).read_bytes())
    commands = []
    states = []
    summary = {"schema":1,"status":"running","started_utc":stamp,
               "baseline_only":args.baseline_only,"library_only":args.library_only,"source_sha256":hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
               "platform":platform.platform(),"scope":"SM89 scalar FP32 GEMM pilot; shared host, no other CUDA context at phase checks",
               "provenance":"This-session assistant-authored pilot with a human-specified deliberately injected tail-write bug; not natural errors from a frozen generation system or discovered public defects",
               "tolerance":{"atol":2e-5,"rtol":2e-4},"verification":[],"benchmark":[],
               "sanitizers":[],"profiles":[],"limitations":[
                   "No SM100/TMA/tcgen05/TMEM evidence", "Scalar FP32 candidate kernels; cuBLAS reference uses pedantic FP32",
                   "GPU not reserved/exclusive; external CUDA contexts are checked before phases and new arrivals stop the run",
                   "Repeated resident inputs yield a cache-warm kernel-level timing scope",
                   "No fixed GPU clocks or end-to-end AI model measurement",
                   "Finite numerical/sanitizer checks are not a proof of general correctness"]}

    def save():
        (output/"summary.json").write_text(json.dumps(summary,indent=2)+"\n")
        (output/"commands.json").write_text(json.dumps(commands,indent=2)+"\n")
        (output/"gpu_states.json").write_text(json.dumps(states,indent=2)+"\n")

    def run(name, cmd, timeout=45, allowed=(0,)):
        print(name,flush=True)
        before=time.monotonic()
        environment=os.environ.copy()
        if name.startswith("nsys_"):
            # The shared host /tmp/nvidia directory may belong to another user.
            temporary=output/"nsys_tmp"
            temporary.mkdir(exist_ok=True)
            environment["TMPDIR"]=str(temporary)
        try:
            result=subprocess.run([str(x) for x in cmd],cwd=ROOT,env=environment,capture_output=True,text=True,timeout=timeout)
            stdout,stderr,code=result.stdout,result.stderr,result.returncode
        except subprocess.TimeoutExpired as exc:
            def decoded(x): return x.decode(errors="replace") if isinstance(x,bytes) else (x or "")
            stdout,stderr,code=decoded(exc.stdout),decoded(exc.stderr)+"\nTIMEOUT\n",124
        (output/(name+".stdout.txt")).write_text(stdout)
        (output/(name+".stderr.txt")).write_text(stderr)
        commands.append({"name":name,"argv":[str(x) for x in cmd],"exit_code":code,
                         "elapsed_seconds":time.monotonic()-before,"expected_exit_codes":list(allowed)})
        save()
        if code not in allowed:
            raise RuntimeError(f"{name}: unexpected exit {code}; see retained logs")
        return stdout,code

    def idle(label):
        consecutive_idle=0
        # Utilization averages can lag a completed process. Wait without launching
        # until three idle readings; stop after a bounded observation window.
        for sample in range(16):
            data=subprocess.check_output(["nvidia-smi","--query-gpu=index,utilization.gpu,memory.used,memory.free,temperature.gpu,clocks.sm,clocks.mem,pstate","--format=csv,noheader,nounits"],text=True)
            rows=[row.split(",") for row in data.strip().splitlines()]
            processes=subprocess.check_output(["nvidia-smi","--query-compute-apps=pid,used_memory","--format=csv,noheader,nounits"],text=True)
            states.append({"label":label,"sample":sample,"utc":datetime.now(timezone.utc).isoformat(),
                           "gpu_fields":["index","gpu_util_percent","used_mib","free_mib","temp_c","sm_clock_mhz","mem_clock_mhz","pstate"],
                           "gpu_rows":[[x.strip() for x in row] for row in rows],
                           "compute_process_pid_memory_mib":processes.strip().splitlines()})
            save()
            if len(rows)!=1 or int(rows[0][3])<512:
                raise RuntimeError("Insufficient GPU headroom or unexpected topology: stopping without further launches")
            consecutive_idle=consecutive_idle+1 if int(rows[0][1])<=5 and not processes.strip() else 0
            if consecutive_idle==3:
                return
            time.sleep(0.5)
        raise RuntimeError("GPU remained busy during bounded observation: stopping without further launches")

    def problem_args(shape,seed=SEEDS[0]):
        m,n,k=shape
        return ["--m",m,"--n",n,"--k",k,"--seed",seed]

    def verification(candidate,shape,seed):
        name=f"verify_{candidate}_{'x'.join(map(str,shape))}_{seed}"
        stdout,code=run(name,[binary,"--mode","verify","--candidate",candidate,*problem_args(shape,seed)],
                        allowed=(0,2) if candidate=="tail_bug" else (0,))
        record=json.loads(stdout)
        record["exit_code"]=code
        summary["verification"].append(record)
        save()

    def profile(candidate):
        idle("before_nsys_"+candidate)
        command=[binary,"--mode","profile","--candidate",candidate,*problem_args((512,512,512)),
                 "--warmup",20,"--launches",20]
        nsys_path=output/("nsys_"+candidate)
        try:
            run("nsys_"+candidate,["nsys","profile","--force-overwrite=true","--trace=cuda,nvtx",
                "--sample=none","--cpuctxsw=none","--capture-range=cudaProfilerApi",
                "--capture-range-end=stop","-o",nsys_path,*command])
            run("nsys_stats_"+candidate,["nsys","stats","--report",
                "cuda_api_sum,cuda_gpu_kern_sum,cuda_gpu_mem_time_sum,cuda_gpu_mem_size_sum,cuda_kern_exec_sum",
                "--format","csv",str(nsys_path)+".nsys-rep"])
            summary["profiles"].append({"candidate":candidate,"tool":"nsys","status":"completed"})
        except RuntimeError as exc:
            summary["profiles"].append({"candidate":candidate,"tool":"nsys","status":"failed","reason":str(exc)})
        idle("before_ncu_"+candidate)
        ncu_path=output/("ncu_"+candidate)
        try:
            # Single known target kernel, one measured launch after application warmup.
            run("ncu_"+candidate,[NCU,"--force-overwrite","--profile-from-start","off",
                "--kernel-name","regex:gemm_"+candidate,"--launch-count","1",
                "--section","SpeedOfLight","--section","MemoryWorkloadAnalysis",
                "--section","Occupancy","--section","SchedulerStats","--section","WarpStateStats",
                "--section","LaunchStats","-o",ncu_path,*command],timeout=60)
            run("ncu_raw_"+candidate,[NCU,"--import",str(ncu_path)+".ncu-rep","--page","raw","--csv"])
            summary["profiles"].append({"candidate":candidate,"tool":"ncu","status":"completed"})
        except RuntimeError as exc:
            summary["profiles"].append({"candidate":candidate,"tool":"ncu","status":"failed","reason":str(exc)})
        save()

    def benchmark_all(comparison):
        candidate_a,candidate_b=comparison.split("-")
        for shape in BENCH_SHAPES:
            idle("before_benchmark_"+'x'.join(map(str,shape)))
            name="benchmark_"+comparison+"_"+'x'.join(map(str,shape))
            stdout,_=run(name,[binary,"--mode","benchmark","--comparison",comparison,*problem_args(shape),
                              "--warmup",30,"--pairs",30,"--launches",30])
            raw=json.loads(stdout)
            samples=raw["samples"]
            a=[s[candidate_a+"_ms"] for s in samples]; b=[s[candidate_b+"_ms"] for s in samples]
            rng=random.Random(20261023)
            boots=[]
            for _ in range(2000):
                idx=[rng.randrange(len(samples)) for _ in samples]
                boots.append(sum(a[i] for i in idx)/sum(b[i] for i in idx))
            boots.sort()
            raw["statistics"]={candidate_a+"_median_ms":statistics.median(a),candidate_b+"_median_ms":statistics.median(b),
                "speedup_ratio_of_paired_means":statistics.mean(a)/statistics.mean(b),
                "ratio_definition":candidate_a+"_ms / "+candidate_b+"_ms",
                "paired_bootstrap_ci95":[boots[49],boots[1949]],"bootstrap_resamples":2000,
                candidate_a+"_min_max_ms":[min(a),max(a)],candidate_b+"_min_max_ms":[min(b),max(b)]}
            summary["benchmark"].append(raw)
            save()
            idle("after_benchmark_"+'x'.join(map(str,shape)))

    try:
        idle("initial")
        summary["git_head"]=subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip()
        for name,cmd in [("nvcc_version",[NVCC,"--version"]),("ncu_version",[NCU,"--version"]),
                         ("sanitizer_version",[SANITIZER,"--version"]),("nsys_version",["nsys","--version"]),
                         ("host_compiler_version",["g++","--version"]),
                         ("gpu_identity",["nvidia-smi","--query-gpu=name,compute_cap,driver_version,memory.total","--format=csv,noheader"])]:
            text,_=run(name,cmd)
            summary[name]=text.strip()
        binary=output/"gemm_pilot"
        run("compile",[NVCC,"-std=c++17","-O3","-lineinfo","-arch=sm_89","--ptxas-options=-v",SOURCE,
                       "-lcublas","-Xlinker","-rpath","-Xlinker","/usr/local/cuda-12.6/lib64","-o",binary])
        summary["binary_sha256"]=hashlib.sha256(binary.read_bytes()).hexdigest()
        identity,_=run("cuda_identity",[binary,"--mode","identify"])
        summary["cuda_identity"]=json.loads(identity)
        if summary["cuda_identity"]["sm"]!=89:
            raise RuntimeError("This pilot is scoped to the inspected SM89 device")
        if args.library_only:
            for shape in SHAPES:
                idle("before_library_verify_"+'x'.join(map(str,shape)))
                for seed in SEEDS:
                    for candidate in ["tiled","cublas"]:
                        verification(candidate,shape,seed)
            benchmark_all("tiled-cublas")
            idle("final")
            summary["status"]="completed"
            return
        for shape in SHAPES:
            idle("before_baseline_verify_"+'x'.join(map(str,shape)))
            verification("baseline",shape,SEEDS[0])
        profile("baseline")
        if args.baseline_only:
            summary["status"]="baseline_profile_completed"
            return
        for shape in SHAPES:
            idle("before_candidate_verify_"+'x'.join(map(str,shape)))
            for seed in SEEDS:
                if seed!=SEEDS[0]: verification("baseline",shape,seed)
                for candidate in ["tiled","tail_bug"]: verification(candidate,shape,seed)
        for candidate in ["baseline","tiled","tail_bug"]:
            for tool in ["memcheck","racecheck","initcheck","synccheck"]:
                idle("before_"+tool+"_"+candidate)
                name=f"sanitizer_{tool}_{candidate}"
                stdout,code=run(name,[SANITIZER,"--tool",tool,"--error-exitcode","99",binary,
                    "--mode","verify","--candidate",candidate,*problem_args((31,33,17))],
                    allowed=(0,2) if candidate=="tail_bug" else (0,))
                summary["sanitizers"].append({"candidate":candidate,"tool":tool,"exit_code":code,
                    "expected_application_numerical_failure":candidate=="tail_bug","log":name})
        profile("tiled")
        benchmark_all("baseline-tiled")
        idle("final")
        summary["status"]="completed"
    except Exception as exc:
        summary["status"]="stopped"
        summary["stop_reason"]=str(exc)
        raise
    finally:
        summary["finished_utc"]=datetime.now(timezone.utc).isoformat()
        save()
        print("Artifacts: "+str(output),flush=True)


if __name__=="__main__":
    main()
