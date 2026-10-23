#!/usr/bin/env python3
"""Audit launch-level captures without inventing instruction-level evidence."""
import argparse
from collections import Counter
import csv
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def audit(source, output):
    output.mkdir(parents=True, exist_ok=False)
    sources, rows, errors, workload_sets = [], [], [], {}
    for path in sorted(source.glob('*/trace.json')):
        raw = path.read_bytes()
        data = json.loads(raw)
        gpu, cases, traces = data['gpu'], data['cases'], data['traces']
        local_errors = []
        if not data.get('capture_complete') or data.get('selected_count') != len(cases):
            local_errors.append('capture completeness/count mismatch')
        contract = data['trace_contract']
        if contract.get('dynamic_instruction_or_address_trace') is not False:
            local_errors.append('unexpected instruction/address trace contract')
        if len({c['case_id'] for c in cases}) != len(cases):
            local_errors.append('duplicate case_id within GPU')
        identities = Counter(c['trace_identity'] for c in cases)
        if set(identities) != set(traces):
            local_errors.append('referenced trace identities differ from stored identities')
        workload_sets[gpu] = set()
        for case in cases:
            trace = traces.get(case['trace_identity'], {})
            launches = trace.get('launches', [])
            ms = case.get('hardware', {}).get('measured_ms')
            valid_time = isinstance(ms, (int, float)) and math.isfinite(ms) and ms > 0
            if not valid_time or not launches or trace.get('contains_timing_metrics') is not False:
                local_errors.append(f"{case['case_id']}: invalid time/launch/timing contract")
            for launch in launches:
                if (math.prod(launch['grid']) != launch['grid_ctas'] or
                        math.prod(launch['block']) != launch['block_threads']):
                    local_errors.append(f"{case['case_id']}: inconsistent grid/block volume")
            # Case IDs are local row ordinals; compare declared workloads instead.
            params = {k: v for k, v in case['params'].items()
                      if k not in ('source_sha256', 'measurement_includes_launch', 'cache_state')}
            workload = json.dumps([case['operator'], params], sort_keys=True, separators=(',', ':'))
            workload_sets[gpu].add(workload)
            rows.append({
                'gpu': gpu, 'case_id': case['case_id'], 'operator': case['operator'],
                'declared_workload_sha256': sha(workload.encode()),
                'source_sha256': case['params'].get('source_sha256', ''),
                'trace_identity': case['trace_identity'], 'launch_count': len(launches),
                'physical_ctas': sum(x['grid_ctas'] for x in launches),
                'measured_ms': ms, 'timing_protocol': contract['timing'],
                'semantics_verified': False, 'source_file_sha256': sha(raw),
            })
        sources.append({
            'gpu': gpu, 'path': str(path.resolve()), 'sha256': sha(raw), 'bytes': len(raw),
            'case_rows': len(cases), 'unique_launch_captures': len(traces),
            'case_rows_reusing_capture': sum(n - 1 for n in identities.values()),
            'unique_launch_records': sum(len(t['launches']) for t in traces.values()),
            'operator_counts': dict(sorted(Counter(c['operator'] for c in cases).items())),
            'trace_contract': contract,
            'gpu_identity': data['baseline'].get('gpu_identity'),
            'nvcc_version': data['baseline'].get('nvcc_version'),
            'binary_sha256': data['baseline'].get('binary_sha256'),
            'cupti_injection_sha256': data['baseline'].get('cupti_injection_sha256'),
            'validation_errors': local_errors,
        })
        errors.extend(f'{gpu}: {e}' for e in local_errors)
    if not sources:
        errors.append('no inputs found')
    common = set.intersection(*workload_sets.values()) if workload_sets else set()
    summary = {
        'created_at': datetime.now(timezone.utc).isoformat(), 'format': 'gpu-launch-audit-v1',
        'script_sha256': sha(Path(__file__).read_bytes()), 'sources': sources,
        'total_case_rows': len(rows),
        'total_unique_launch_captures_within_gpu': sum(s['unique_launch_captures'] for s in sources),
        'total_unique_launch_records': sum(s['unique_launch_records'] for s in sources),
        'declared_workloads_common_to_all_gpus': len(common),
        'workload_key_policy': 'operator + params excluding source hash/cache/timing flags; exact declared metadata only',
        'limitations': [
            'Case rows are not independent instruction traces; multiple rows reuse one launch capture.',
            'Cross-GPU workload metadata equality does not verify numerical or logical-version equivalence.',
            'Stored timing endpoints are warm CUDA-event minima, not the Representative-100 medians.',
            'No internal barrier/TMEM evidence or per-instruction timestamps; no new GPU measurement.',
        ],
        'validation_errors': errors, 'status': 'failed' if errors else 'completed',
    }
    (output / 'summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False) + '\n')
    (output / 'common-workloads.json').write_text(json.dumps([json.loads(k) for k in sorted(common)], indent=2) + '\n')
    if rows:
        with (output / 'cases.csv').open('w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)
    print(json.dumps({k: summary[k] for k in ('status', 'total_case_rows', 'total_unique_launch_captures_within_gpu', 'total_unique_launch_records', 'declared_workloads_common_to_all_gpus', 'validation_errors')}))
    return 1 if errors else 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path('/home/liuwei/GPU-simulator/data/compact_gtsim_traces'))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    raise SystemExit(audit(args.source, args.output))
