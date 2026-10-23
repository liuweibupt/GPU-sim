#!/usr/bin/env python3
"""Compare explicit-register candidate provenance with and without recorded masks.

This is a record-level analysis, not a complete SASS def-use or race detector.
Operand tuples, predication provenance and implicit effects are not inferred.
"""
import argparse
from collections import Counter
import csv
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import time


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def modeled_register(name):
    match = re.fullmatch(r'R(\d+)', name)
    return bool(match and int(match[1]) < 255)


def compare_stream(instructions, example_limit=8):
    """Track tokens exactly as recorded; intentionally do not expand register tuples."""
    per_lane, scalar = {}, {}
    counts, examples = Counter(), []
    for ordinal, inst in enumerate(instructions):
        mask = inst['active_mask']
        if type(mask) is not int or not 0 <= mask < 2**32:
            raise ValueError('invalid 32-bit mask')
        counts['records'] += 1
        if not mask:
            counts['zero_mask_records'] += 1
            continue
        counts['active_records'] += 1
        if mask != 2**32 - 1:
            counts['partial_mask_records'] += 1
        lanes = [lane for lane in range(32) if mask & (1 << lane)]
        for source_index, source in enumerate(inst['sources']):
            if not modeled_register(source):
                counts['unmodeled_source_token_occurrences'] += 1
                continue
            for lane in lanes:
                counts['source_token_lane_queries'] += 1
                masked = per_lane.get((source, lane))
                coarse = scalar.get(source)
                if masked is not None:
                    counts['masked_candidate_found'] += 1
                else:
                    counts['masked_no_prior_record'] += 1
                if masked == coarse:
                    counts['same_candidate'] += 1
                else:
                    counts['different_candidate'] += 1
                    counts['different_with_prior_masked_candidate' if masked is not None
                           else 'coarse_candidate_without_lane_write'] += 1
                    if len(examples) < example_limit:
                        examples.append({
                            'consumer_ordinal': ordinal, 'consumer_id': inst.get('id'),
                            'consumer_pc': inst['pc'], 'consumer_opcode': inst['opcode'],
                            'source_index': source_index, 'register': source, 'lane': lane,
                            'mask_sensitive_writer_ordinal': masked,
                            'coarse_writer_ordinal': coarse,
                            'masked_writer': instructions[masked] if masked is not None else None,
                            'coarse_writer': instructions[coarse] if coarse is not None else None,
                            'interpretation': 'different explicit-record candidate; not a labeled GPU error',
                        })
        # Read-before-write is necessary for in-place arithmetic.
        for destination in inst['destinations']:
            if modeled_register(destination):
                scalar[destination] = ordinal
                for lane in lanes:
                    per_lane[(destination, lane)] = ordinal
    return dict(counts), examples


def run(source, output):
    output.mkdir(parents=True, exist_ok=False)
    rows, examples, inputs, totals = [], [], [], Counter()
    started = time.perf_counter()
    for path in sorted(source.glob('*.json.gz')):
        raw = path.read_bytes()
        data = json.loads(gzip.decompress(raw))
        if data.get('format') != 'gpu-raw-cta-evidence-v1':
            continue
        if not data['selection'].get('cta_complete_as_recorded'):
            raise ValueError(f'incomplete CTA capture: {path}')
        identity = data['source']
        entry = {'gpu': identity['gpu'], 'case': identity['case'],
                 'trace_sha256': identity['trace_sha256'], 'file': path.name,
                 'sha256': digest(raw), 'bytes': len(raw)}
        inputs.append(entry)
        for warp in data['warps']:
            counts, differences = compare_stream(warp['instructions'])
            totals.update(counts)
            rows.append(dict(gpu=entry['gpu'], case=entry['case'], trace_sha256=entry['trace_sha256'],
                             warp_id=warp['warp_id'], **counts))
            examples.extend(dict(gpu=entry['gpu'], case=entry['case'],
                                 trace_sha256=entry['trace_sha256'], warp_id=warp['warp_id'], **ex)
                            for ex in differences)
    if not inputs:
        raise ValueError('no raw CTA artifacts')
    if len({i['trace_sha256'] for i in inputs}) != len(inputs):
        raise ValueError('duplicate trace identity')
    fields = ['gpu', 'case', 'trace_sha256', 'warp_id'] + sorted(totals)
    with (output / 'per-warp.csv').open('w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fields, lineterminator='\n', restval=0)
        writer.writeheader()
        writer.writerows(rows)
    (output / 'differences.json').write_text(json.dumps(examples, indent=2) + '\n')
    summary = {
        'format': 'gpu-raw-mask-candidates-v1', 'created_at': datetime.now(timezone.utc).isoformat(),
        'script_sha256': digest(Path(__file__).read_bytes()), 'inputs': inputs,
        'traces': len(inputs), 'warps': len(rows), 'totals': dict(totals),
        'descriptive_wall_seconds': time.perf_counter() - started,
        'comparison_unit': '(raw warp record, explicit source-register token occurrence, recorded active lane)',
        'baseline': 'last explicit destination token occurrence in the warp with nonzero mask',
        'mask_sensitive': 'last explicit destination token occurrence whose recorded mask includes this lane',
        'limits': [
            'Both methods operate on explicit R0..R254 tokens only; omitted register tuples/implicit effects remain unsupported.',
            'Static spot checks expose incomplete/misclassified raw operands, including a uniform memory base printed as R0; these counts measure raw-record sensitivity only.',
            'Unsupported intervening instructions may clobber tracked registers, so these candidates are not sound reaching definitions.',
            'Recorded active_mask meaning requires hash-bound tracer provenance; this output alone does not establish it.',
            'A prior recorded writer is a candidate, not proven value provenance or a complete architectural definition.',
            'Different candidates are not actual GPU faults, detector precision/recall, or independent human-study outcomes.',
            'No cross-warp order, memory visibility, barrier phase or tensor identity is inferred.',
        ],
    }
    (output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({'traces': len(inputs), 'warps': len(rows), 'totals': dict(totals)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    run(args.input, args.output)
