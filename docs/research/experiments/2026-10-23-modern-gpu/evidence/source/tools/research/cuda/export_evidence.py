#!/usr/bin/env python3
"""Export bounded, auditable JSON from completed pilot directories (CPU only)."""
import argparse
import copy
import csv
import hashlib
import json
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    path.write_text(json.dumps(value,indent=2,allow_nan=False)+"\n")


def compact(source):
    data=copy.deepcopy(source)
    for item in data["verification"]:
        retain=item["shape_mnk"]==[17,19,23] and item["seed"]==20261023
        if not retain:
            for key in list(item["verdict"]):
                if key.endswith("_matrix"):
                    del item["verdict"][key]
    data["portable_export"]={"full_matrices_retained_for":{"shape_mnk":[17,19,23],"seed":20261023},
        "all_verification_counts_and_error_samples_retained":True,
        "all_raw_paired_timing_samples_retained":True,
        "ci_scope":"Within one run's 30 pairs; not an interval across independently reserved sessions",
        "omitted_full_matrices":"Available in original out/research/cuda run summary"}
    return data


def nsys_table(text, report):
    for chunk in text.split("Processing ["):
        if report+".py" not in chunk:
            continue
        lines=chunk.splitlines()
        start=next((i for i,line in enumerate(lines) if line.startswith("Time (%),") or line.startswith("PID,TID,")),None)
        if start is None:
            return []
        table=[]
        for line in lines[start:]:
            if not line:
                break
            table.append(line)
        return list(csv.DictReader(table))
    return []


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--main-run",type=Path,required=True)
    parser.add_argument("--library-run",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=False)
    runs={"main":args.main_run,"cublas":args.library_run}
    sources={name:json.loads((path/"summary.json").read_text()) for name,path in runs.items()}
    if any(s["status"]!="completed" for s in sources.values()):
        raise SystemExit("Only completed runs may be exported as completed experiments")
    manifest={"schema":1,"source_runs":{},"claims_scope":"SM89 numerical/profile/timing pilot, not a validation of the paper's human-understanding hypothesis"}
    for name,path in runs.items():
        data=sources[name]
        if digest(path/"source.cu")!=data["source_sha256"]:
            raise SystemExit("Source snapshot hash mismatch")
        if digest(path/"gemm_pilot")!=data["binary_sha256"]:
            raise SystemExit("Binary hash mismatch")
        manifest["source_runs"][name]={"path":str(path),"status":data["status"],"artifacts":{}}
        for artifact in ["summary.json","commands.json","gpu_states.json","source.cu","runner.py","gemm_pilot"]:
            manifest["source_runs"][name]["artifacts"][artifact]={"sha256":digest(path/artifact),"bytes":(path/artifact).stat().st_size}
        write(args.output/(name+".json"),compact(data))
    profile={"shape_mnk":[512,512,512],"scope":"Instrumented profiler executions, separate from native timing",
             "nsys_capture":"20 launches after warmup; input copies and initialization are outside capture",
             "ncu_capture":"One selected kernel launch after warmup, replayed for section metrics",
             "candidates":{},"sanitizers":[]}
    selected=["gpu__time_duration.sum","sm__throughput.avg.pct_of_peak_sustained_elapsed",
        "sm__inst_executed_pipe_lsu.avg.pct_of_peak_sustained_elapsed",
        "gpu__compute_memory_access_throughput.avg.pct_of_peak_sustained_elapsed",
        "gpu__compute_memory_request_throughput.avg.pct_of_peak_sustained_elapsed",
        "gpu__dram_throughput.avg.pct_of_peak_sustained_elapsed",
        "l1tex__throughput.avg.pct_of_peak_sustained_active","l1tex__t_sector_hit_rate.pct",
        "lts__t_sector_hit_rate.pct","lts__throughput.avg.pct_of_peak_sustained_elapsed",
        "sm__warps_active.avg.pct_of_peak_sustained_active","smsp__warps_eligible.avg.per_cycle_active",
        "smsp__average_warps_issue_stalled_long_scoreboard_per_issue_active.ratio",
        "smsp__average_warps_issue_stalled_short_scoreboard_per_issue_active.ratio",
        "smsp__average_warps_issue_stalled_barrier_per_issue_active.ratio",
        "launch__registers_per_thread","launch__shared_mem_per_block_static"]
    for candidate in ["baseline","tiled"]:
        path=args.main_run
        rows=list(csv.reader((path/f"ncu_raw_{candidate}.stdout.txt").read_text().splitlines()))
        header=next(i for i,row in enumerate(rows) if row and row[0]=="ID")
        keys,units,values=rows[header:header+3]
        metrics={k:{"value":values[keys.index(k)],"unit":units[keys.index(k)]} for k in selected if k in keys}
        text=(path/f"nsys_stats_{candidate}.stdout.txt").read_text()
        profile["candidates"][candidate]={"ncu_metrics":metrics,
            "nsys_kernel_summary":nsys_table(text,"cuda_gpu_kern_sum"),
            "nsys_cuda_api_summary":nsys_table(text,"cuda_api_sum"),
            "nsys_kernel_execution_summary":nsys_table(text,"cuda_kern_exec_sum"),
            "nsys_memory_capture":"No GPU copy rows in the marked resident-compute range; not zero application transfer cost"}
        for artifact in [f"nsys_{candidate}.nsys-rep",f"ncu_{candidate}.ncu-rep",
                         f"nsys_stats_{candidate}.stdout.txt",f"ncu_raw_{candidate}.stdout.txt"]:
            manifest["source_runs"]["main"]["artifacts"][artifact]={"sha256":digest(path/artifact),"bytes":(path/artifact).stat().st_size}
    for check in sources["main"]["sanitizers"]:
        record=copy.deepcopy(check)
        text="\n".join((args.main_run/(check["log"]+suffix)).read_text() for suffix in [".stdout.txt",".stderr.txt"])
        record["tool_summary_lines"]=[line for line in text.splitlines() if "SUMMARY" in line]
        record["shape_mnk"]=[31,33,17]
        record["meaning"]="Tool-specific findings, independently from the program's numerical exit code"
        profile["sanitizers"].append(record)
    write(args.output/"profiles.json",profile)
    write(args.output/"manifest.json",manifest)
    print(args.output)


if __name__=="__main__":
    main()
