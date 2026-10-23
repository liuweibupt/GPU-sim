#!/usr/bin/env python3
"""Recompute all forward results from complete archived input/output arrays."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from run import reference, array_identity


def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()


def verify(root, plan_path, family, partition='all', input_manifest_path=None):
    plan = json.loads(plan_path.read_text()); summary = json.loads((root / 'summary.json').read_text())
    assert summary['family'] == family and summary['plan_sha256'] == sha(plan_path)
    expected = [c for c in plan['cases'] if c['family'] == family and (partition == 'all' or c['partition'] == partition)]
    inputs = None
    if input_manifest_path is not None:
        input_manifest = json.loads(input_manifest_path.read_text())
        assert input_manifest['plan_sha256'] == sha(plan_path)
        inputs = {c['id']: c for c in input_manifest['cases']}
        assert all(c['id'] in inputs for c in expected)
    known = {c['id']: c for c in expected}; seen = set(); rows = []; total = 0
    for row in summary['records']:
        assert row['id'] in known and row['id'] not in seen
        case = known[row['id']]; seen.add(row['id'])
        assert all(row[k] == v for k, v in case.items())
        assert json.loads((root / (row['id'] + '.json')).read_text()) == row
        good = False
        if 'artifact' in row:
            if inputs is not None:
                assert row['input_array_identities'] == inputs[row['id']]['input_array_identities']
                assert row.get('input_strides') == inputs[row['id']].get('input_strides')
            entry = row['artifact']; assert Path(entry['path']).name == entry['path']
            path = root / entry['path']; assert sha(path) == entry['sha256'] and path.stat().st_size == entry['bytes']
            with np.load(path, allow_pickle=False) as z: arrays = dict(z)
            oracle = reference(family, arrays, case['parameters']); actual = arrays['actual']; p = case['parameters']
            shape = (p['batch'], p['length']) if family == 'grpo' else (p['rows'], p['width'])
            assert actual.shape == shape
            assert row['actual_shape'] == list(shape)
            dtype_ok = row['actual_dtype'] == ('float32' if family == 'grpo' else p['dtype'])
            if family == 'grpo':
                assert arrays['logits'].shape == (p['batch'], p['length'] + 1, p['vocab'])
                assert arrays['ids'].shape == shape and arrays['mask'].shape == shape
            else: assert arrays['x'].shape == shape
            input_arrays = {k: v for k, v in arrays.items() if k not in ['actual', 'reference'] and not k.startswith('input_before_') and not k.startswith('input_after_')}
            assert array_identity(input_arrays) == row['input_array_identities']
            before_keys = [k for k in arrays if k.startswith('input_before_')]
            assert len(before_keys) == (3 if family in ['poly', 'grpo'] else 1)
            assert np.array_equal(arrays['input_before_0'], arrays['logits' if family == 'grpo' else 'x'])
            if family == 'poly':
                assert np.array_equal(arrays['input_before_1'], arrays['weights'])
                assert np.array_equal(arrays['input_before_2'], arrays['bias'])
            elif family == 'grpo':
                assert np.array_equal(arrays['input_before_1'][:, -p['length']:], arrays['ids'])
                if p['masked']: assert np.array_equal(arrays['input_before_2'][:, -p['length']:], arrays['mask'])
            unchanged = all(np.array_equal(arrays[k], arrays[k.replace('before', 'after')]) for k in before_keys)
            assert unchanged == row['inputs_unchanged']
            assert actual.shape == oracle.shape == arrays['reference'].shape
            assert np.allclose(oracle, arrays['reference'], atol=1e-12, rtol=1e-12)
            close = np.isfinite(actual) & np.isclose(actual, oracle, atol=p['atol'], rtol=p['rtol'])
            assert int((~np.isfinite(actual)).sum()) == row['nonfinite']
            assert int((~close).sum()) == row['mismatches'] and close.size == row['outputs']
            good = bool(close.all() and unchanged and dtype_ok); total += close.size
        assert good == row['passed']
        rows.append({'id': row['id'], 'partition': case['partition'], 'passed': good, 'outputs': row['outputs'], 'mismatches': row['mismatches']})
    rows += [{'id': c['id'], 'partition': c['partition'], 'passed': False, 'missing': True} for c in expected if c['id'] not in seen]
    for entry in summary['compiler_artifacts']:
        if 'omitted' not in entry:
            path = root / entry['path']; assert sha(path) == entry['sha256'] and path.stat().st_size == entry['bytes']
    return {'format': 'liger-retained-array-verification-v1', 'family': family, 'status': 'verified',
            'plan_sha256': sha(plan_path), 'summary_sha256': sha(root / 'summary.json'),
            'expected_cases': len(expected), 'completed_cases': len(seen), 'passed_cases': sum(r['passed'] for r in rows),
            'all_passed': len(seen) == len(expected) and all(r['passed'] for r in rows), 'outputs': total, 'cases': rows,
            'input_binding': 'frozen-control-input-manifest' if inputs is not None else 'self-consistency-only',
            'input_manifest_sha256': sha(input_manifest_path) if input_manifest_path is not None else None}


if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--input',type=Path,required=True);p.add_argument('--plan',type=Path,required=True);p.add_argument('--family',required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--inputs',type=Path,required=True);a=p.parse_args()
    result=verify(a.input,a.plan,a.family,input_manifest_path=a.inputs);a.output.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k!='cases'}))
