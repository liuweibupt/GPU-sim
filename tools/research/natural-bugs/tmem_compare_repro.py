#!/usr/bin/env python3
"""Independently rehash and check complete numerical output of the exact pair."""
import argparse
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET

COMMITS = {'before': '08a3cd4364d87bf2c281067f7a40e17808f22e7b',
           'after': '0002b46dadfc6f8fbe7464c285651311c709fdc6'}
PARAMS = [('select', 64, False, 1), ('select', 32, False, 1), ('select', 0, False, 1),
          ('select', 64, True, 1), ('first', 64, False, 1), ('second', 64, False, 1),
          ('chain', 64, False, 0), ('chain', 64, False, 1)]


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def insist(value, message):
    if not value:
        raise ValueError(message)


def key(params):
    return tuple(params[k] for k in ['choice', 'mode', 'columns', 'early', 'outer_choice'])


def validate(folder, variant):
    raw_summary = (folder / 'summary.json').read_bytes()
    summary = json.loads(raw_summary)
    insist(summary['source_commit'] == COMMITS[variant], 'wrong exact source commit')
    expected_keys = {(choice, *p) for p in PARAMS for choice in [0, 1]}
    seen, records = set(), []
    total, wrong_elements, wrong_cases = 0, 0, 0
    for row in summary['runs']:
        path = folder / row['artifact']['path']
        compressed = path.read_bytes()
        insist(len(compressed) == row['artifact']['bytes'] and sha(compressed) == row['artifact']['sha256'], 'case compressed binding mismatch')
        unpacked = gzip.decompress(compressed)
        insist(sha(unpacked) == row['artifact']['uncompressed_sha256'], 'case raw binding mismatch')
        case = json.loads(unpacked)
        insist(case['parameters'] == row['parameters'] and case['id'] == row['id'], 'case identity mismatch')
        params = case['parameters']; k = key(params)
        insist(k not in seen and k in expected_keys, 'duplicate or non-upstream case')
        seen.add(k)
        insist(len(case['compiled_kernels']) == 1, 'missing exact compiled-kernel binding')
        kernel = case['compiled_kernels'][0]
        insist(row['compiled_kernel_hashes'] == [kernel['hash']], 'kernel row binding mismatch')
        for artifact in kernel['artifacts']:
            f = folder / artifact['path']
            raw = f.read_bytes() if f.exists() else gzip.decompress(Path(str(f) + '.gz').read_bytes())
            insist(sha(raw) == artifact['sha256'] and len(raw) == artifact['bytes'], 'generated code binding mismatch')
        expected_value = 3 if params['mode'] == 'first' or (params['mode'] == 'select' and params['choice']) else 5
        if params['mode'] == 'chain':
            expected_value = 3 if params['choice'] == params['outer_choice'] else 5
        names = ['selected'] + (['temporary'] if params['columns'] else [])
        insist([x['name'] for x in case['outputs']] == names, 'missing or extra valid output')
        mismatches = 0
        for output in case['outputs']:
            n = 128 * (32 if output['name'] == 'selected' else params['columns'])
            expected = float(expected_value if output['name'] == 'selected' else 7)
            insist(len(output['actual']) == len(output['reference']) == n, 'output length mismatch')
            insist(output['reference'] == [expected] * n, 'saved reference fails independent CPU oracle')
            actual_mismatch = [i for i, value in enumerate(output['actual']) if value != expected]
            insist(actual_mismatch == output['mismatch_indices'] and len(actual_mismatch) == output['mismatch_count'], 'saved mismatch list fails independent CPU oracle')
            mismatches += len(actual_mismatch); total += n
        insist(case['numeric_correct'] == (mismatches == 0) == row['numeric_correct'], 'saved correctness changed')
        wrong_elements += mismatches; wrong_cases += mismatches > 0
        records.append({'parameters': params, 'numeric_correct': mismatches == 0, 'mismatch_elements': mismatches,
                        'selected_values': dict(Counter(case['outputs'][0]['actual'])),
                        'selected_expected': expected_value, 'kernel_hash': kernel['hash'],
                        'case_sha256': sha(compressed)})
    insist(seen == expected_keys, 'upstream 16-case matrix incomplete')
    insist(summary['output_elements'] == total and summary['mismatch_elements'] == wrong_elements and
           summary['numeric_wrong_cases'] == wrong_cases, 'summary disagrees with full numeric outputs')
    if summary.get('pass_ir'):
        entry = summary['pass_ir']; raw = (folder / entry['path']).read_bytes()
        insist(sha(raw) == entry['sha256'] and len(raw) == entry['bytes'], 'pass IR compressed binding mismatch')
        inflated = gzip.decompress(raw)
        insist(sha(inflated) == entry['uncompressed_sha256'] and len(inflated) == entry['uncompressed_bytes'], 'pass IR raw binding mismatch')
    return {'path': str(folder), 'summary_sha256': sha(raw_summary), 'source_commit': summary['source_commit'],
            'wheel_sha256': summary['wheel_sha256'], 'libtriton_sha256': summary['libtriton_sha256'],
            'upstream_module_sha256': summary['upstream']['module_sha256'],
            'gpu': summary['gpu'], 'torch_version': summary['torch_version'], 'triton_version': summary['triton_version'],
            'cases': len(records), 'output_elements': total, 'wrong_cases': wrong_cases,
            'wrong_elements': wrong_elements, 'records': records}


def validate_plain(xml, observed_folder):
    raw = xml.read_bytes(); tree = ET.fromstring(raw)
    observed = json.loads((observed_folder / 'summary.json').read_text())
    wanted = {r['id'].split('::')[-1]: r['numeric_correct'] for r in observed['runs']}
    cases = tree.findall('.//testcase'); seen = set(); failures = []
    for case in cases:
        name = case.attrib['name']; seen.add(name)
        insist(name in wanted and case.find('error') is None and case.find('skipped') is None,
               'plain run has error, skip or foreign test')
        failure = case.find('failure')
        insist((failure is None) == wanted[name], 'plain and observed case outcomes differ')
        if failure is not None:
            text = ''.join(failure.itertext())
            insist('Mismatched elements:' in text, 'plain failure is not the expected numeric assertion')
            failures.append({'name': name, 'message': failure.attrib.get('message', '')})
    insist(len(cases) == len(seen) == len(wanted) == 16, 'plain upstream matrix incomplete')
    return {'path': str(xml), 'sha256': sha(raw), 'cases': len(cases), 'numeric_assertion_failures': failures,
            'outcomes_match_observed_suite': True, 'scope': 'Native upstream pytest with no custom observation hooks; assertions retained, full output tensors not captured in this control run.'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--before', type=Path, required=True)
    p.add_argument('--after', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--plain-before', type=Path)
    p.add_argument('--plain-after', type=Path)
    args = p.parse_args()
    before, after = validate(args.before.resolve(), 'before'), validate(args.after.resolve(), 'after')
    insist(before['upstream_module_sha256'] == after['upstream_module_sha256'], 'upstream harness differs')
    insist(before['gpu'] == after['gpu'] and before['torch_version'] == after['torch_version'], 'pair runtime differs')
    left = {key(x['parameters']): x for x in before['records']}
    right = {key(x['parameters']): x for x in after['records']}
    comparison = [{'parameters': left[k]['parameters'], 'before_correct': left[k]['numeric_correct'],
                   'after_correct': right[k]['numeric_correct'], 'before_mismatch_elements': left[k]['mismatch_elements'],
                   'after_mismatch_elements': right[k]['mismatch_elements']} for k in sorted(left)]
    summary = {'schema': 'natural-tmem-independent-pair-audit-v1', 'before': before, 'after': after,
               'pair': comparison, 'repaired_cases': sum(not x['before_correct'] and x['after_correct'] for x in comparison),
               'regressed_cases': sum(x['before_correct'] and not x['after_correct'] for x in comparison),
               'validator_sha256': sha(Path(__file__).read_bytes()),
               'scope': 'Exact upstream numeric/compiler regression; no sampled internal TMEM provenance, race, performance or general bug-coverage claim.'}
    if args.plain_before:
        summary['plain_before'] = validate_plain(args.plain_before.resolve(), args.before.resolve())
    if args.plain_after:
        summary['plain_after'] = validate_plain(args.plain_after.resolve(), args.after.resolve())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({'before_wrong': before['wrong_cases'], 'after_wrong': after['wrong_cases'],
                      'repaired_cases': summary['repaired_cases'], 'output': str(args.output)}))


if __name__ == '__main__':
    main()
