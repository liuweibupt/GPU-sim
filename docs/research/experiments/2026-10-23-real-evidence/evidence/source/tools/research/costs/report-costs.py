#!/usr/bin/env python3
"""Audit Nsight launch correspondence and package exact bounded cost evidence."""
import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
from cost_publish_safety import matches, scan_paths

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
spec = importlib.util.spec_from_file_location("cost_helpers", HERE/"run-version-cost.py")
helper = importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
sha = helper.sha


def read(path):
    return json.loads(path.read_bytes())


def profile(gpu):
    lines = (gpu/"nsys.stdout.txt").read_text().splitlines()
    samples = [json.loads(line) for line in lines if line.startswith('{') and '"kind":"sample"' in line]
    configurations = list(dict.fromkeys((s["count"], s["generations"]) for s in samples))
    command = next(json.loads(line) for line in (gpu/"commands.jsonl").read_text().splitlines() if json.loads(line)["name"] == "nsys")
    assert command["argv"][-4:-2] == ["2", "5"], "profile repetition contract changed"
    public_path=gpu/'nsys-public-rows.json';public=read(public_path)
    names={row['id']:row['value'] for row in public['referencedNames']}
    table=public['tables']['CUPTI_ACTIVITY_KIND_KERNEL']
    kernels=[]
    for values in table['rows']:
        row=dict(zip(table['columns'],values))
        kernels.append((row['start'],row['end'],row['gridX'],row['blockX'],names[row['demangledName']],row['graphNodeId']))
    expected = []
    for n, g in configurations:
        expected += [(n, g, mode, "preflight", None) for mode in (False, True)]
        expected += [(n, g, mode, "warmup", None) for _ in range(5) for mode in (False, True)]
        expected += [(n, g, s["instrumented"], "sample", s) for s in samples if (s["count"], s["generations"]) == (n, g)]
    assert len(kernels) == len(expected) == 64, "unexpected number of actual profiled kernels"
    rows = []
    for (start, end, grid, block, name, node), (n, g, mode, phase, sample) in zip(kernels, expected):
        assert grid == (n+31)//32 and block == 64 and f"<(bool){int(mode)}>" in name
        assert node is not None and node > 0, "expected explicit CUDA graph kernel node"
        rows.append({"count": n, "generations": g, "instrumented": mode, "phase": phase,
                     "kernel_device_us": (end-start)/1000, "start_ns": start, "end_ns": end,
                     "graphNodeId": node, "event_span_us": sample["kernel_us"] if sample else None,
                     "pair": sample["pair"] if sample else None, "order": sample["order"] if sample else None})
    distributions = []
    for n, g in configurations:
        result = {"count": n, "generations": g}
        for mode in (False, True):
            result[str(mode)] = helper.quantiles([r["kernel_device_us"] for r in rows if r["count"] == n and r["generations"] == g and r["instrumented"] == mode])
        distributions.append(result)
    return {"format": "nsys-cost-range-audit-v2", "sqliteSha256": public['sourceSqliteSha256'],
            "publicRowsSha256":sha(public_path.read_bytes()),"profileReceiptSha256":sha((gpu/'profile-receipt.json').read_bytes()),
            "rows": rows, "distributions": distributions,
            "correspondence": "Exact deterministic single-thread harness launch sequence: each shape has 2 preflight + 10 warmup + 4 sampled kernels; all 64 rows validated by kernel mode, grid, block, positive graphNodeId and saved sample order.",
            "scope": "Separate short profiled cross-check, 8 kernels/mode/shape including preflight/warmup; not substituted for the 90 unprofiled pairs or a production overhead estimate."}


def build_report(gpu, cpu, audit):
    g, c = read(gpu/"summary.json"), read(cpu/"summary.json")
    text = ["# 真实采集与分析成本实验", "", "本轮证明了采集开销必须分阶段处理：GPU 记录、数据回传和 CPU 序列化的量级不同。全部测量来自当前有界原型，不能外推成生产 AI 算子的固定开销。", "",
            "## GPU 采集：RTX 4090 / SM89", "",
            "冻结原始 version probe 派生同源的 baseline/instrumented 编译实例：保留相同计算、值输出、64-thread CTA 和同步屏障；baseline 只移除辅助标签及事件记录。寄存器 26→30，共享内存 256→264 B。", "",
            "3 个独立进程 session，每形状每模式预热 20 次，随后 30 个随机顺序配对；共 360 对 / 720 样本。每个配对使用相同 seed，每个样本由 C++ 全量校验，另有 24 份完整输出由 Python 独立校验。", "",
            "下表为 graph 内 event→kernel→event 区间，包含 event/graph 调度与计时分辨率；**不是纯 kernel 硬件耗时**。两列各为 90 样本中位数，增量和比例则先逐对计算再取中位数。", "",
            "| count × generations | baseline / instrumented (µs) | 配对增量 (µs) | 配对比例 | 额外回传 host (µs) | 序列化 baseline / instrumented (ms) |",
            "|---|---:|---:|---:|---:|---:|"]
    for r in g["results"]:
        base, inst = r["per_mode"]["False"], r["per_mode"]["True"]
        text.append(f"| {r['count']} × {r['generations']} | {base['kernel_us']['median']:.3f} / {inst['kernel_us']['median']:.3f} | {r['paired_kernel_delta_us']['median']:.3f} | {r['paired_kernel_ratio']['median']:.3f}× | {inst['evidence_d2h_host_us']['median']:.2f} | {base['serialize_us']['median']/1000:.4f} / {inst['serialize_us']['median']/1000:.4f} |")
    text += ["", "以下 Nsight Systems 数值来自修正环境继承后独立重跑的 64-kernel profile，正式 720 条测量完全未重跑或修改。新 profile 以显式 allowlist 提供运行环境；发布物只包含限定的 CUDA kernel/API/memcpy 行及所引用的函数名称，不包含完整 profiler 容器或任意字符串表。全部 64 个实际 graph kernel 节点按可复核的确定性提交顺序关联形状；各形状每模式 8 次（含预热与预检）。**该短 profile 仅用于范围交叉核验，不替代正式分布**。", "",
             "| count × generations | nsys baseline / instrumented kernel (µs) |",
             "|---|---:|"]
    for r in sorted(audit["distributions"], key=lambda r:(r["count"],r["generations"])):
        text.append(f"| {r['count']} × {r['generations']} | {r['False']['median']:.3f} / {r['True']['median']:.3f} |")
    largest = g["results"][-1]
    text += ["", f"最大配置每次输出 {largest['bytes_per_mode']['True']['output_bytes']:,} B，额外证据 {largest['bytes_per_mode']['True']['evidence_bytes']:,} B / {largest['bytes_per_mode']['True']['events']:,} 条事件；instrumented JSON 中位大小 {largest['serialized_bytes_per_mode']['True']['median']:,.0f} B。在该微实验中，完整文本序列化比 GPU 记录的增量耗时大得多，后续应优先研究选择性记录、二进制编码和按需导出，并分别重新验证。", "",
             "`version-20261023-v3` 的直接 event/kernel/event API 调用包含 host 提交空档，曾产生 0.84× 的假负开销。它作为失败方法保留，**不据此声称优化收益**。最终 v4 使用一个 graph 提交全部计时节点，仍将 graph 区间与 Nsight 纯 kernel 时间区分。D2H event span 也可能包含提交间隙，host elapsed 单列。机器未锁频；GPU 与本任务其他工作错峰，CPU/系统资源仍共享。", "",
             "## CPU 分析：216 TMA + 36 tcgen05 实测 capture", "",
             "全部 252 个 bridge 结果先校验压缩及解压 SHA，并重算 protocol 结果一致；保存其原样 capture 对象作为紧凑输入。3 个进程 session、每 capture 5 次预热 + 10 次计时，共 7,560 条样本；固定 CPU 84。输入转换、解压、原始数值 oracle 与语义映射不计入以下分析成本。文件读取为 warm OS page cache，不是冷盘测试。", "",
             "各数值为 µs 的中位数；check 的 p95 显示尾延迟。slice 每次取一个完整证据查询，轮换 value / completion / reuse 类别，绝不拼接所有 slice。", "",
             "| 输入类型 / GPU / generations | captures | read | parse | check median / p95 | slice | serialize run / slice |",
             "|---|---:|---:|---:|---:|---:|---:|"]
    for r in sorted(c["distributions"], key=lambda r:(r["group"][0],r["group"][1],r["group"][2])):
        s=r["stages"];m=lambda k:s[k]["median"]
        text.append(f"| {' / '.join(map(str,r['group']))} | {r['captures']} | {m('read_us'):.1f} | {m('parse_us'):.1f} | {m('check_protocol_us'):.1f} / {s['check_protocol_us']['p95']:.1f} | {m('slice_us'):.1f} | {m('serialize_run_us'):.1f} / {m('serialize_slice_us'):.1f} |")
    rss=[e["maxRssBytes"]/1024**2 for e in c["environments"]]
    loads=[e["loadAverageBefore"][0] for e in c["environments"]]+[e["loadAverageAfter"][0] for e in c["environments"]]
    text += ["",f"进程峰值 RSS：{min(rss):.1f}–{max(rss):.1f} MiB；这是进程总量，不是单次分配归因。192 logical-CPU 共享主机的 1-minute load average 约 {min(loads):.1f}–{max(loads):.1f}，本结果必须作为该环境的描述性分布，不声称独占 CPU 或无争用。JIT 预热后正常分配与 GC 留在计时内。", "",
             "## 能支持的结论", "", "这轮补齐了可复核的成本证据和瓶颈位置，但不是可投稿性的充分证明。它支持报告当前原型在这些真实输入上的分析延迟、空间和采集阶段成本；不能证明生产模型可接受开销、TMA/tcgen05 记录成本相同、所有查询可扩展，或人类调试效率已提升。曾经全 slice 字符串超限的问题仍保留为限制。本轮按需 slice 避免重复输出，不等同于已经解决大规模分析。", ""]
    return '\n'.join(text)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for arg in ("gpu", "cpu", "cpu-inputs", "rejected", "profile", "output"):
        parser.add_argument("--"+arg,type=Path,required=True)
    parser.add_argument("--prior-attempt",type=Path,action="append",default=[])
    args=parser.parse_args();out=args.output.resolve();out.mkdir(parents=True,exist_ok=False)
    # Verify completed GPU run artifacts, including binary before intentionally omitting it.
    original_manifest=read(args.gpu/"manifest.json")
    for rel,expected in original_manifest.items():
        raw=(args.gpu/rel).read_bytes()
        assert sha(raw)==expected["sha256"] and len(raw)==expected["bytes"], f"GPU artifact changed: {rel}"
    profile_receipt=read(args.profile/'profile-receipt.json')
    assert profile_receipt['frozenSamplesSha256']==sha((args.gpu/'samples.jsonl').read_bytes())
    assert profile_receipt['frozenSummarySha256']==sha((args.gpu/'summary.json').read_bytes())
    assert profile_receipt['formalSamplesRerun'] is False
    audit=profile(args.profile)
    (out/"nsys-range-audit.json").write_text(json.dumps(audit,indent=2)+'\n')
    (out/"report.md").write_text(build_report(args.gpu,args.cpu,audit))
    manifest={"format":"cost-evidence-package-v2","files":[],"omissions":[],"gpuOriginalChecks":len(original_manifest),
        "privacyPolicy":"All full profiler containers are omitted regardless of secret-value scan outcome. Only explicit CUDA numeric rows and referenced function names are public. Original local files are not overwritten.",
        "formalSamplesSha256":sha((args.gpu/'samples.jsonl').read_bytes()),
        "independentProfileReceiptSha256":sha((args.profile/'profile-receipt.json').read_bytes())}
    groups=[("gpu",args.gpu),("cpu",args.cpu),("cpu-inputs",args.cpu_inputs),("independent-profile",args.profile)]
    candidates=[(str(Path(name)/p.relative_to(root)),p) for name,root in groups for p in sorted(root.rglob('*')) if p.is_file()]
    rejected_names={"summary.json","samples.jsonl","build.json","commands.jsonl","nsys-stats.stdout.txt","collection.nsys-rep","collection.sqlite",
                    "prepare-version-kernel.py","run-version-cost.py","version-cost.cu","version_cost_kernel.cuh","version_probe.cu"}
    candidates += [("rejected-direct-event-method/"+p.name,p) for p in sorted(args.rejected.iterdir()) if p.is_file() and p.name in rejected_names]
    receipts=[]
    for attempt in args.prior_attempt:
        build=read(attempt/'build.json')
        commands=[json.loads(line) for line in (attempt/'commands.jsonl').read_text().splitlines()]
        failures=[c for c in commands if c['exit_code']!=0]
        receipts.append({'path':str(attempt.resolve()),'status':'incomplete-profile-attempt' if failures else 'compiled-only',
            'formalSamplingComplete':(attempt/'summary.json').exists(),'build':build,'commands':commands,
            'reason':'No formal GPU sample session. Profile preparation encountered the retained tool diagnostics.' if failures else 'Successful matching build only; no failed GPU computation or measured sampling claimed.'})
        for path in sorted(attempt.iterdir()):
            if path.is_file() and (path.suffix in ('.cu','.cuh','.py','.nsys-rep','.sqlite') or path.name in ('build.json','commands.jsonl') or path.name.endswith(('.stdout.txt','.stderr.txt'))):
                candidates.append((f'prior-attempts/{attempt.name}/{path.name}',path))
    (out/'prior-attempt-receipts.json').write_text(json.dumps(receipts,indent=2)+'\n')
    current_sources=list(HERE.glob('*'))+[ROOT/"tests/research-costs.test.mjs"]
    candidates += [("source-snapshots/"+str(p.relative_to(ROOT)).replace('/','__'),p) for p in current_sources if p.is_file()]
    source_scan=scan_paths([root for _,root in groups]+[args.rejected]+args.prior_attempt)
    (out/'source-sensitive-value-scan.json').write_text(json.dumps(source_scan,indent=2)+'\n')
    for logical,path in candidates:
        raw=path.read_bytes()
        found=matches(raw)
        if path.suffix in ('.nsys-rep','.sqlite','.qdrep') or found:
            manifest['omissions'].append({'originalPath':str(path.resolve()),'logicalPath':logical,'sha256':sha(raw),'bytes':len(raw),
                'reason':'Full profiler container omitted: contains unrelated process metadata and may include inherited environment. Only the independent clean-run selected CUDA rows are published.' if path.suffix in ('.nsys-rep','.sqlite','.qdrep') else 'Exact current sensitive environment value matched; original file retained locally and omitted from publication.',
                'sensitiveValueMatches':found})
            continue
        if raw.startswith(b'\x7fELF'):
            manifest["omissions"].append({"originalPath":str(path.resolve()),"logicalPath":logical,"sha256":sha(raw),"bytes":len(raw),"reason":"Compiled executable omitted; build/source/SASS and exact binary SHA retained."});continue
        compression=len(raw)>=100000
        packed=gzip.compress(raw,mtime=0) if compression else raw
        stored=logical+('.gz' if compression else '')
        target=out/stored;target.parent.mkdir(parents=True,exist_ok=True)
        with target.open('xb') as f:f.write(packed)
        recovered=gzip.decompress(target.read_bytes()) if compression else target.read_bytes()
        assert recovered==raw
        manifest["files"].append({"originalPath":str(path.resolve()),"logicalPath":logical,"storedPath":stored,
            "encoding":"gzip" if compression else "identity","originalSha256":sha(raw),"originalBytes":len(raw),"storedSha256":sha(packed),"storedBytes":len(packed)})
    binaries=[entry for entry in manifest['omissions'] if entry['reason'].startswith('Compiled executable')]
    assert len(binaries)==1 and binaries[0]['sha256']==read(args.gpu/'build.json')['binary_sha256']
    manifest["counts"]={"files":len(manifest["files"]),"originalBytes":sum(r["originalBytes"] for r in manifest["files"]),"storedBytes":sum(r["storedBytes"] for r in manifest["files"])}
    for name in ('report.md','nsys-range-audit.json','prior-attempt-receipts.json','source-sensitive-value-scan.json'):
        raw=(out/name).read_bytes();manifest.setdefault('generated',[]).append({'path':name,'sha256':sha(raw),'bytes':len(raw)})
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    scan=scan_paths([out])
    if scan['matchedFiles']:
        raise ValueError('publication matched current sensitive values; inspect local scan, never print snippets')
    (out/'publication-sensitive-value-scan.json').write_text(json.dumps(scan,indent=2)+'\n')
    print(json.dumps({'status':'verified-and-packaged',**manifest['counts'],'omissions':len(manifest['omissions']),'output':str(out)}))


if __name__=='__main__':main()
