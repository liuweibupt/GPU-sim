#!/usr/bin/env python3
"""Independently recheck retained full FP8 bytes and every per-case artifact hash."""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import re

def fp8(raw):
    sign = -1 if raw & 128 else 1
    exponent, fraction = (raw >> 3) & 15, raw & 7
    if exponent == 15 and fraction == 7:
        return math.nan
    return sign * (fraction / 8 * 2**-6 if exponent == 0 else (1 + fraction / 8) * 2**(exponent-7))

VALUES = [fp8(i) for i in range(256)]

def verify(root):
    matrix_bytes = (root / 'matrix.json').read_bytes()
    matrix = json.loads(matrix_bytes)
    results = json.loads((root / 'results.json').read_text())
    if hashlib.sha256(matrix_bytes).hexdigest() != results['matrix_sha256']:
        raise ValueError('matrix hash mismatch')
    if len(results['records']) != len(matrix['matrix']):
        raise ValueError('incomplete frozen matrix')
    groups = Counter()
    total = Counter()
    hash_checks = 0
    for case, record in zip(matrix['matrix'], results['records']):
        if any(record.get(k) != v for k, v in case.items()):
            raise ValueError('case no longer matches frozen matrix')
        cwd = root / record['id']
        if json.loads((cwd / 'record.json').read_text()) != record:
            raise ValueError('record copies disagree')
        for entry in record['files']:
            data = (cwd / entry['path']).read_bytes()
            if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
                raise ValueError('artifact hash mismatch')
            hash_checks += 1
        if not {'stdout.txt', 'stderr.txt'} <= {entry['path'] for entry in record['files']}:
            raise ValueError('raw streams missing from artifact manifest')
        stdout = (cwd / 'stdout.txt').read_text(errors='replace')
        stderr = (cwd / 'stderr.txt').read_text(errors='replace')
        observed_groups = [json.loads(line[len('EVIDENCE '):])
                           for line in stdout.splitlines() if line.startswith('EVIDENCE {')]
        if observed_groups != record['groups']:
            raise ValueError('stdout groups disagree with record')
        group_ids = [g.get('group') if isinstance(g, dict) else None for g in record['groups']]
        if any(type(index) is not int or not 0 <= index < len(case['k']) for index in group_ids):
            raise ValueError('invalid group ID')
        if len(set(group_ids)) != len(group_ids):
            raise ValueError('duplicate group ID')
        # A failed or timed-out process may legitimately emit only a prefix.
        # Successful evidence must cover each problem once, regardless of order.
        if record['result'] == 'passed' and set(group_ids) != set(range(len(case['k']))):
            raise ValueError('incomplete group coverage')
        tool_output = stdout + '\n' + stderr
        # Count even malformed/truncated summary lines, so a valid zero line
        # cannot hide an additional contradictory or incomplete tool result.
        summaries = [line for line in tool_output.splitlines()
                     if re.match(r'^[ \t]*=+[ \t]+ERROR SUMMARY\b', line)]
        sanitizer_clean = (case['tool'] == 'memcheck' and record['result'] == 'passed'
                           and record['exit_code'] == 0 and not record['timed_out']
                           and re.search(r'^=+\s+COMPUTE-SANITIZER\s*$', tool_output, re.MULTILINE) is not None
                           and len(summaries) == 1
                           and re.fullmatch(r'[ \t]*=+[ \t]+ERROR SUMMARY:[ \t]+0[ \t]+errors[ \t]*', summaries[0]) is not None)
        if record.get('sanitizer_clean') is not sanitizer_clean:
            raise ValueError('sanitizer clean flag disagrees with raw tool output')
        groups[f"{case['variant']}/{case['tool']}/{record['result']}"] += 1
        checked = mismatches = zero_errors = 0
        for g in record['groups']:
            index = g['group']
            if g['m'] != case['m'] or g['n'] != case['n'] or g['k'] != case['k'][index] or g['beta'] != case['beta']:
                raise ValueError('group shape/beta mismatch')
            actual = (cwd / f'group-{index}-observed.bin').read_bytes()
            reference = (cwd / f'group-{index}-reference.bin').read_bytes()
            c = (cwd / f'group-{index}-c.bin').read_bytes()
            expected_size = g['m'] * g['n']
            if len(actual) != expected_size or len(reference) != expected_size or len(c) != expected_size or g['outputs'] != expected_size:
                raise ValueError('truncated output')
            mismatch = sum(VALUES[a] != VALUES[b] for a,b in zip(actual,reference))
            zero_error = 0
            if g['k'] == 0:
                zero_error = sum(VALUES[a] != case['beta'] * VALUES[b] for a,b in zip(actual,c))
                total['zero_k_outputs'] += len(actual)
                total['zero_k_nonzero_outputs'] += sum(VALUES[a] != 0 for a in actual)
            if mismatch != g['mismatches'] or zero_error != g['zero_k_mismatches']:
                raise ValueError('recorded oracle result disagrees with full bytes')
            checked += len(actual)
            mismatches += mismatch
            zero_errors += zero_error
        if checked != record['outputs_checked'] or mismatches != record['mismatches'] or zero_errors != record['zero_k_mismatches']:
            raise ValueError('aggregate counts mismatch')
        if record['result'] == 'passed' and (record['exit_code'] != 0 or record['timed_out'] or len(record['groups']) != len(case['k']) or mismatches or zero_errors):
            raise ValueError('invalid pass')
        total['outputs'] += checked
        total['mismatches'] += mismatches
        total['zero_k_mismatches'] += zero_errors
    return {'format':'cutlass-retained-byte-verification-v1','status':'verified','matrix_sha256':results['matrix_sha256'],'cases':len(results['records']),'artifact_hash_checks':hash_checks,'counts':dict(total),'case_results':dict(groups),'oracle':'FP8 E4M3 finite decoder, signed zero numerically equal; all raw bytes, independent K=0 beta*C'}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    result=verify(args.input)
    args.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result))

if __name__=='__main__':
    main()
