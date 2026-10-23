#!/usr/bin/env python3
"""Apply every original multi-file candidate and run the frozen GPU contract."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
from verify import verify, sha

ROOT = Path(__file__).resolve().parents[3]
PYTHON = '/home/liuwei/.cache/embodied_longwam_20261019/runtime/venv/bin/python'
SPECS = {'poly': 1540, 'sparse': 1545, 'grpo': 1461}


def load(path): return json.loads(path.read_text())


def evaluate(candidate_path, output, base, python=PYTHON):
    output.mkdir(parents=True, exist_ok=False)
    candidate = load(candidate_path)
    task = next(t for t in load(base / 'catalog.json')['tasks'] if t['id'] == candidate['taskId'])
    spec = next(t for t in load(base / 'private-plan.json')['tasks'] if t['id'] == candidate['taskId'])
    assert sha(base / 'plan.json') == spec['hiddenSpecSHA256']
    before = {f['path']: f for f in task['files']}
    assert len(candidate['files']) == len(before) and {f['path'] for f in candidate['files']} == set(before)
    for file in candidate['files']:
        original = before[file['path']]
        assert file['id'] == original['id'] and file['role'] == original['role']
        assert file['beforeSHA256'] == original['sha256']
        assert hashlib.sha256(file['text'].encode()).hexdigest() == file['sha256']
        assert file['changed'] == (file['text'] != original['text'])
        if file['role'] != 'implementation': assert file['text'] == original['text']
    tree_hash = subprocess.check_output(['node', str(Path(__file__).with_name('candidate_identity.mjs'))], input=json.dumps(candidate['files']), text=True).strip()
    assert tree_hash == candidate['candidateTreeSHA256']
    family = candidate['taskId'].removeprefix('liger-')
    original_root = base / f'sources/{SPECS[family]}/before'
    source = output / 'source'
    shutil.copytree(original_root / 'src', source / 'src', ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
    for file in candidate['files']:
        p = source / file['path']
        assert sha(p) == file['beforeSHA256']
        p.write_text(file['text'])
        assert sha(p) == file['sha256']
    shutil.copyfile(candidate_path, output / 'candidate.json')
    result = {'candidateTreeSHA256': candidate['candidateTreeSHA256'], 'hiddenSpecSHA256': spec['hiddenSpecSHA256'],
              'candidate_json_sha256': sha(candidate_path), 'evaluator_sha256': sha(Path(__file__)),
              'buildStatus': 'failed', 'verifierStatus': 'missing', 'cases': [], 'family': family}
    result['applied_sources'] = {f['path']: sha(source / f['path']) for f in candidate['files']}
    env = {k: os.environ[k] for k in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'LD_LIBRARY_PATH', 'CUDA_VISIBLE_DEVICES') if k in os.environ}
    env.update(PYTHONPATH=str(ROOT / 'out/research/natural-fault-expansion/runtime-before'),
               PYTHONNOUSERSITE='1', TRITON_CACHE_DIR=str((output / 'jit').resolve()))
    command = [python, str(ROOT / 'tools/research/liger-faults/run.py'), '--source', str(source.resolve()),
               '--family', family, '--plan', str((base / 'plan.json').resolve()), '--output', str((output / 'run').resolve())]
    result['command'] = command
    started = time.monotonic()
    try:
        process = subprocess.run(command, cwd=output.resolve(), env=env, capture_output=True, text=True, timeout=180)
        (output / 'stdout.log').write_text(process.stdout); (output / 'stderr.log').write_text(process.stderr)
        result['exit_code'] = process.returncode
        if process.returncode == 0:
            run = load(output / 'run/summary.json'); control = load(base / f'controls-v2/{family}/before/summary.json')
            assert run['native_compiler_sha256'] == control['native_compiler_sha256']
            assert run['runner_sha256'] == control['runner_sha256']
            assert run['module_sha256'] == result['applied_sources'][f'src/liger_kernel/ops/{ {"poly":"poly_norm", "sparse":"sparsemax", "grpo":"grpo_loss"}[family] }.py']
            for file in run['imported_source_files']:
                assert file['sha256'] == sha(source / file['path'])
            old = {r['id']: r for r in control['records']}
            for row in run['records']:
                if 'artifact' in row:
                    assert row['input_array_identities'] == old[row['id']]['input_array_identities'], 'candidate test inputs differ from controls'
                    assert row.get('input_strides') == old[row['id']].get('input_strides'), 'candidate input layouts differ from controls'
            receipt = verify(output / 'run', base / 'plan.json', family, input_manifest_path=base / 'input-manifest.json')
            receipt['candidateTreeSHA256'] = candidate['candidateTreeSHA256']
            receipt['input_identity_matched_to_before_control'] = True
            receipt['native_compiler_sha256'] = run['native_compiler_sha256']
            path = output / 'independent-verification.json'; path.write_text(json.dumps(receipt, indent=2) + '\n')
            result.update(verifierStatus=receipt['status'], verifierReceiptSHA256=sha(path),
                          buildStatus='passed' if 'import_error' not in run and all('error_type' not in r for r in run['records']) else 'failed',
                          cases=[{'id': r['id'], 'status': 'passed' if r['passed'] else 'failed'} for r in receipt['cases'] if r['id'] in spec['hiddenCaseIds']],
                          visibleCases=[{'id': r['id'], 'status': 'passed' if r['passed'] else 'failed'} for r in receipt['cases'] if r['id'] not in spec['hiddenCaseIds']],
                          allCaseCount=receipt['expected_cases'])
    except subprocess.TimeoutExpired as error:
        result['timed_out'] = True
        (output / 'stdout.log').write_bytes(error.stdout or b''); (output / 'stderr.log').write_bytes(error.stderr or b'')
    except Exception as error:
        result['validation_error'] = type(error).__name__ + ': ' + str(error)
    result['wall_seconds'] = time.monotonic() - started
    (output / 'runtime-record.json').write_text(json.dumps(result, indent=2) + '\n')
    return result


if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--candidate',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--base',type=Path,default=ROOT/'out/research/liger-faults');p.add_argument('--python',default=PYTHON);a=p.parse_args()
    r=evaluate(a.candidate,a.output,a.base,a.python);print(json.dumps({k:r[k] for k in ['family','buildStatus','verifierStatus','cases','wall_seconds']}))
