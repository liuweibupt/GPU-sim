#!/usr/bin/env python3
"""Offline complete-array verification of a curated Liger evidence package."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import subprocess
import types


def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def load(p): return json.loads(p.read_text())


def verify_package(package):
    manifest = load(package / 'publication-manifest.json')
    seen = set()
    for row in manifest['files']:
        rel = Path(row['path'])
        assert not rel.is_absolute() and '..' not in rel.parts and str(rel) not in seen
        seen.add(str(rel)); p = package / rel
        assert not p.is_symlink() and p.is_file() and p.stat().st_size == row['bytes'] and sha(p) == row['sha256']
        assert p.read_bytes()[:4] != b'\x7fELF' and p.suffix not in ('.whl', '.so', '.pyc', '.cubin')
    assert {str(p.relative_to(package)) for p in package.rglob('*') if p.is_file()} == seen | {'publication-manifest.json'}
    # Import only verified Python CPU-oracle functions, without creating pycache
    # or loading CUDA/Triton. run.py imports torch only inside its GPU entrypoint.
    archived_run = types.ModuleType('run'); archived_run.__file__ = str(package / 'reproduction/run.py')
    exec(compile(Path(archived_run.__file__).read_text(), archived_run.__file__, 'exec'), archived_run.__dict__)
    previous_run = sys.modules.get('run'); sys.modules['run'] = archived_run
    verifier = types.ModuleType('archived_liger_verify'); verifier.__file__ = str(package / 'reproduction/verify.py')
    try:
        exec(compile(Path(verifier.__file__).read_text(), verifier.__file__, 'exec'), verifier.__dict__)
    finally:
        if previous_run is None: sys.modules.pop('run')
        else: sys.modules['run'] = previous_run
    rows = []
    specs = {'poly': 1540, 'sparse': 1545, 'grpo': 1461}
    assert {p.name for p in (package / 'gold-evaluator-check-v3').iterdir() if p.is_dir()} == set(specs), 'missing official gold evaluator control'
    execution_summary = package / 'candidate-execution-summary.json'
    if execution_summary.exists():
        executions = load(execution_summary)
        assert len(executions) == 18 and len({r['trialId'] for r in executions}) == 18, 'candidate denominator differs'
        expected = {r['trialId'] for r in executions if r.get('status') != 'not-executed'}
        actual = {p.name for p in (package / 'candidate-evaluations').glob('*') if p.is_dir()}
        assert actual == expected, 'candidate execution directory set differs'
    controls = {}
    catalog = {t['id']: t for t in load(package / 'catalog.json')['tasks']}
    private = {t['id']: t for t in load(package / 'private-plan.json')['tasks']}
    for family, pr in specs.items():
        for version in ('before', 'gold'):
            root = package / f'controls-v2/{family}/{version}'
            v = verifier.verify(root, package / 'plan.json', family, input_manifest_path=package / 'input-manifest.json')
            summary = load(root / 'summary.json')
            assert summary['runner_sha256'] == sha(package / 'reproduction/run.py')
            for source in summary['imported_source_files']:
                assert sha(package / f'sources/{pr}/{version}' / source['path']) == source['sha256']
            controls[(family, version)] = summary
            rows.append({'path': str(root.relative_to(package)), 'category': 'final-' + version + '-control',
                'cases': v['completed_cases'], 'passed': v['passed_cases'], 'outputs': v['outputs']})
    for pattern, category in [('gold-evaluator-check-v3/*', 'core-upstream-gold-control'), ('candidate-evaluations/*', 'model-candidate')]:
        for root in sorted(package.glob(pattern)):
            if not root.is_dir(): continue
            record = load(root / 'runtime-record.json'); candidate = load(root / 'candidate.json')
            assert record['candidate_json_sha256'] == sha(root / 'candidate.json')
            assert candidate['candidateTreeSHA256'] == record['candidateTreeSHA256']
            original = {f['path']: f for f in catalog[candidate['taskId']]['files']}
            assert len(candidate['files']) == len(original) and {f['path'] for f in candidate['files']} == set(original)
            tree = subprocess.check_output(['node', str(package / 'reproduction/candidate_identity.mjs')], input=json.dumps(candidate['files']), text=True).strip()
            assert tree == candidate['candidateTreeSHA256']
            assert record['evaluator_sha256'] == sha(package / 'reproduction/evaluate_candidate.py')
            for f in candidate['files']:
                assert hashlib.sha256(f['text'].encode()).hexdigest() == f['sha256'] == record['applied_sources'][f['path']]
                old = original[f['path']]
                assert f['id'] == old['id'] and f['role'] == old['role'] and f['beforeSHA256'] == old['sha256']
                assert f['changed'] == (f['text'] != old['text'])
                if f['role'] != 'implementation': assert f['text'] == old['text']
            if record['verifierStatus'] != 'verified':
                rows.append({'path': str(root.relative_to(package)), 'category': category, 'cases': 0, 'passed': 0,
                    'outputs': 0, 'status': 'incomplete-or-failed', 'failureReceiptSHA256': sha(root / 'runtime-record.json')})
                continue
            receipt = root / 'independent-verification.json'
            assert sha(receipt) == record['verifierReceiptSHA256']
            v = verifier.verify(root / 'run', package / 'plan.json', record['family'], input_manifest_path=package / 'input-manifest.json')
            old = load(receipt)
            assert v['cases'] == old['cases'] and v['outputs'] == old['outputs']
            spec = private[candidate['taskId']]
            canonical = [{'id': c['id'], 'status': 'passed' if c['passed'] else 'failed'} for c in v['cases']]
            assert record['hiddenSpecSHA256'] == spec['hiddenSpecSHA256'] == sha(package / 'plan.json')
            assert record['cases'] == [c for c in canonical if c['id'] in spec['hiddenCaseIds']]
            assert record['visibleCases'] == [c for c in canonical if c['id'] not in spec['hiddenCaseIds']]
            summary = load(root / 'run/summary.json')
            control = controls[(record['family'], 'before')]
            assert summary['native_compiler_sha256'] == control['native_compiler_sha256']
            assert summary['runner_sha256'] == control['runner_sha256']
            for source in summary['imported_source_files']:
                expected = record['applied_sources'].get(source['path'])
                if expected is None:
                    expected = sha(package / f'sources/{specs[record["family"]]}/before' / source['path'])
                assert source['sha256'] == expected
            rows.append({'path': str(root.relative_to(package)), 'category': category, 'cases': v['completed_cases'],
                'passed': v['passed_cases'], 'outputs': v['outputs'], 'candidateTreeSHA256': candidate['candidateTreeSHA256']})
    return {'format': 'liger-offline-publication-verification-v1', 'filesVerified': len(seen), 'runs': rows,
        'scope': 'Complete final control and candidate arrays, frozen inputs/strides/dtypes, imported source and native/compiler-text identities. Initial screening/capture versions are hash checked, not promoted to final controls. No GPU execution or network.'}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__); p.add_argument('package', type=Path); p.add_argument('--receipt', type=Path)
    a = p.parse_args(); result = verify_package(a.package)
    if a.receipt: a.receipt.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'filesVerified': result['filesVerified'], 'runs': len(result['runs']), 'cases': sum(r['cases'] for r in result['runs']), 'outputs': sum(r['outputs'] for r in result['runs'])}))
