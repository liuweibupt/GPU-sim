#!/usr/bin/env python3
"""Independent profiler cross-check with minimal environment and public SQL rows."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3

from cost_publish_safety import scan_paths, matches

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("cost_runner", HERE/"run-version-cost.py")
runner = importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)
sha = runner.sha


def export_rows(path):
    db = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True)
    allowed = {
        "CUPTI_ACTIVITY_KIND_KERNEL": ["start", "end", "deviceId", "contextId", "streamId", "correlationId",
            "demangledName", "registersPerThread", "gridX", "gridY", "gridZ", "blockX", "blockY", "blockZ",
            "staticSharedMemory", "dynamicSharedMemory", "graphNodeId"],
        "CUPTI_ACTIVITY_KIND_MEMCPY": ["start", "end", "deviceId", "contextId", "streamId", "correlationId", "bytes", "copyKind", "srcKind", "dstKind"],
        "CUPTI_ACTIVITY_KIND_RUNTIME": ["start", "end", "correlationId", "nameId", "returnValue"],
        "CUPTI_ACTIVITY_KIND_DRIVER": ["start", "end", "correlationId", "nameId", "returnValue"],
    }
    table_names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    tables, names = {}, set()
    for table, wanted in allowed.items():
        if table not in table_names:
            continue
        actual = {r[1] for r in db.execute(f'PRAGMA table_info({table})')}
        columns = [column for column in wanted if column in actual]
        rows = db.execute(f"SELECT {','.join(columns)} FROM {table} ORDER BY start").fetchall()
        if not all(value is None or isinstance(value, (int, float)) for row in rows for value in row):
            raise ValueError("unexpected nonnumeric profiler field")
        for name_column in ('demangledName', 'nameId'):
            if name_column in columns:
                names.update(row[columns.index(name_column)] for row in rows)
        tables[table] = {"columns": columns, "rows": rows}
    if len(tables.get('CUPTI_ACTIVITY_KIND_KERNEL', {}).get('rows', [])) != 64:
        raise ValueError("expected 64 kernels in independent cross-check")
    strings = []
    for name_id in sorted(names):
        value = db.execute('SELECT value FROM StringIds WHERE id=?', (name_id,)).fetchone()[0]
        if not (value.startswith('void cost_version_probe<') or value.startswith('cuda') or value.startswith('cu')):
            raise ValueError("unexpected profiler name; full StringIds table must never be exported")
        if matches(value.encode()):
            raise ValueError("sensitive value in selected profiler name")
        strings.append({"id": name_id, "value": value})
    db.close()
    return {"format": "cost-nsys-public-rows-v1", "sourceSqliteSha256": sha(path.read_bytes()),
            "tables": tables, "referencedNames": strings,
            "selection": "Explicit numeric kernel/CUDA runtime/driver/memcpy columns and only the function-name IDs referenced by those rows. No environment/process metadata, arbitrary StringIds, OS runtime, paths or NVTX payloads exported."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gpu', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args();gpu=args.gpu.resolve();output=args.output.resolve()
    build=json.loads((gpu/'build.json').read_bytes())
    binary=gpu/'version-cost'
    if sha(binary.read_bytes()) != build['binary_sha256']:
        raise ValueError('frozen measured executable changed')
    output.mkdir(parents=True,exist_ok=False);(output/'validation').mkdir()
    for source in (Path(__file__), HERE/'cost_publish_safety.py', HERE/'run-version-cost.py'):
        (output/source.name).write_bytes(source.read_bytes())
    runner.command(output,'nsys',['nsys','profile','--force-overwrite=false','--trace=cuda','--cuda-graph-trace=node',
        '--sample=none','--cpuctxsw=none','--stats=true','-o',output/'collection',binary,'1000','2','5',output/'validation','0'],timeout=300)
    runner.command(output,'nsys-stats',['nsys','stats','--force-export=true','--report',
        'cuda_api_sum,cuda_gpu_kern_sum,cuda_gpu_mem_time_sum,cuda_gpu_mem_size_sum',output/'collection.nsys-rep'],timeout=300)
    exported=export_rows(output/'collection.sqlite')
    (output/'nsys-public-rows.json').write_text(json.dumps(exported,indent=2)+'\n')
    validations=[]
    for path in sorted((output/'validation').glob('*.json')):
        validations.append({'path':str(path.relative_to(output)),'sha256':sha(path.read_bytes()),
            **runner.validate_payload(json.loads(path.read_bytes()))})
    receipt={'format':'independent-safe-nsys-cost-profile-v1','status':'complete','formalSamplesRerun':False,
        'frozenGpuDirectory':str(gpu),'frozenBinarySha256':build['binary_sha256'],
        'frozenSamplesSha256':sha((gpu/'samples.jsonl').read_bytes()),
        'frozenSummarySha256':sha((gpu/'summary.json').read_bytes()),
        'publicRowsSha256':sha((output/'nsys-public-rows.json').read_bytes()),
        'validations':validations,'fullProfilerContainersPublished':False,
        'sources':{p.name:sha(p.read_bytes()) for p in (Path(__file__),HERE/'run-version-cost.py',HERE/'cost_publish_safety.py')},
        'scope':'Independent 64-kernel profiler cross-check after sanitizing process environment; original 720 formal GPU samples and all CPU timing data are unchanged.'}
    (output/'profile-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    scan=scan_paths([output]);(output/'sensitive-value-scan.json').write_text(json.dumps(scan,indent=2)+'\n')
    public_scan=scan_paths([p for p in output.rglob('*') if p.is_file() and p.suffix not in ('.nsys-rep','.sqlite')])
    (output/'public-files-sensitive-value-scan.json').write_text(json.dumps(public_scan,indent=2)+'\n')
    if public_scan['matchedFiles']:
        raise ValueError('selected public profile files matched sensitive values; inspect key/path-only scan locally')
    print(json.dumps({'status':'complete','kernelRows':len(exported['tables']['CUPTI_ACTIVITY_KIND_KERNEL']['rows']),
        'tableRows':{k:len(v['rows']) for k,v in exported['tables'].items()},'publicMatchedFiles':0,
        'fullContainerMatchedFiles':scan['matchedFiles'],'output':str(output)}))


if __name__=='__main__':main()
