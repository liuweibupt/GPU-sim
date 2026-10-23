#!/usr/bin/env python3
"""Restore the archive and recompute all candidate/control outcomes without GPUs."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[3]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    sys.modules[name] = result
    spec.loader.exec_module(result)
    return result


def load(path):
    return json.loads(path.read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check(archive, restore):
    archiver = module('archive', ROOT / 'tools/research/archive-modern-evidence.py')
    extracted = archiver.extract(archive, restore)
    stage = restore / 'experiment'
    evaluation = stage / 'evaluation'
    verifier = module('retained_verifier', stage / 'sources/tools/research/natural-repair-eval/verify_runtime.py')
    modal_checks = sum(archiver.validate_modal(p) for p in restore.glob('modal-*'))
    if modal_checks != extracted['modal_integrity_checks']:
        raise ValueError('Restored Modal integrity-check count changed')
    plan = evaluation / 'hidden-v1/plan.json'
    receipts = []
    for expected_path in sorted((evaluation / 'verification').glob('*.json')):
        expected = load(expected_path)
        relative = Path(expected['raw_directory'].split('/out/research/modal/', 1)[1])
        raw = restore / ('modal-' + relative.parts[0]) / Path(*relative.parts[1:])
        verify = verifier.verify_cutlass if expected['family'] == 'cutlass' else verifier.verify_tmem
        actual = verify(raw, plan)
        if any(value != expected[key] for key, value in actual.items()):
            raise ValueError(f'Restored outcome changed: {expected_path}')
        if sha(raw / 'summary.json') != expected['summary_sha256']:
            raise ValueError('Restored runtime summary identity changed')
        receipts.append({'trial': expected_path.stem, 'kind': 'candidate', **actual})
    for family in ('cutlass', 'tmem'):
        for version in ('before', 'gold'):
            expected = load(evaluation / f'control-{family}-{version}-verification.json')
            raw = restore / f'modal-20261023-repair-{family}-controls-v1/artifacts/{version}'
            actual = (verifier.verify_cutlass if family == 'cutlass' else verifier.verify_tmem)(raw, plan)
            if any(value != expected[key] for key, value in actual.items()):
                raise ValueError(f'Restored control changed: {family}/{version}')
            if sha(raw / 'summary.json') != expected['summary_sha256']:
                raise ValueError('Restored control summary identity changed')
            receipts.append({'trial': f'{family}.{version}', 'kind': 'control', **actual})
    for build in sorted((evaluation / 'builds').iterdir()):
        result = load(build / 'result.json')
        answer = load(build / 'answer.json')
        before = build / 'before-source.txt'
        candidate = build / result['artifacts']['candidate_source']['path']
        if sha(build / 'answer.json') != result['answer_sha256'] or sha(before) != result['before_sha256']:
            raise ValueError('Restored answer/before identity changed')
        source = before.read_text()
        for edit in answer['edits']:
            if source.count(edit['old']) != 1:
                raise ValueError('Restored edit is ambiguous')
            source = source.replace(edit['old'], edit['new'], 1)
        if source != candidate.read_text() or sha(candidate) != result['candidate_sha256']:
            raise ValueError('Restored patch/candidate identity changed')
    omissions = load(evaluation / 'omitted-artifacts.json')['artifacts']
    for omitted in omissions:
        result = load(evaluation / Path(omitted['path']).parent / 'result.json')
        expected = next(a for a in result['artifacts'].values() if a['path'] == Path(omitted['path']).name)
        if any(omitted[k] != expected[k] for k in ('sha256', 'bytes')):
            raise ValueError('Omitted artifact receipt differs from retained build')
    candidates = [r for r in receipts if r['kind'] == 'candidate']
    return {'status': 'verified', 'archive': extracted,
            'restored_modal_integrity_checks': modal_checks,
            'candidate_sources_reapplied': 12, 'omitted_artifact_receipts_checked': len(omissions),
            'candidate_runs': len(candidates),
            'candidate_cases': sum(r['expected_cases'] for r in candidates),
            'candidate_outputs': sum(r.get('elements', r.get('full_byte_verification', {}).get('counts', {}).get('outputs', 0)) for r in candidates),
            'receipts': receipts}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--restore', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    result = check(args.archive.resolve(), args.restore.resolve())
    args.report.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k: v for k, v in result.items() if k != 'receipts'}))
