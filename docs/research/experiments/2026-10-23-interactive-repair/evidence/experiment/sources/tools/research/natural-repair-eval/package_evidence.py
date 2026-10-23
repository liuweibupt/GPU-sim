#!/usr/bin/env python3
"""Stage this bounded experiment without executable/wheel/upstream-tree bytes."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[3]


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def copy(source, destination):
    if source.is_dir():
        for path in sorted(source.rglob('*')):
            if path.is_file() and '__pycache__' not in path.parts:
                copy(path, destination / path.relative_to(source))
        return
    with source.open('rb') as stream:
        magic = stream.read(4)
    if magic == b'\x7fELF' or source.suffix == '.whl':
        raise ValueError(f'Unexpected executable/wheel selection: {source}')
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)


def stage(evaluation, output):
    if output.exists():
        raise ValueError('Refuse to overwrite a publication staging directory')
    output.mkdir(parents=True)
    target = output / 'evaluation'
    for path in sorted(evaluation.iterdir()):
        if path.is_file():
            copy(path, target / path.name)
    for name in ('frozen', 'trials', 'hidden-v1', 'executor-source-snapshot',
                 'build-logs', 'verification'):
        source = evaluation / name
        if not source.is_dir():
            raise ValueError(f'Missing required directory: {source}')
        copy(source, target / name)
    omissions = []
    for build in sorted((evaluation / 'builds').iterdir()):
        result = json.loads((build / 'result.json').read_text())
        entries = {v['path']: v for v in result['artifacts'].values()}
        for path in sorted(build.iterdir()):
            if not path.is_file():
                continue  # Full upstream trees remain external build dependencies.
            with path.open('rb') as stream:
                executable = stream.read(4) == b'\x7fELF'
            if executable or path.suffix == '.whl':
                entry = {'path': f'builds/{build.name}/{path.name}',
                         'sha256': digest(path), 'bytes': path.stat().st_size,
                         'reason': 'Rebuildable executable/object/wheel; bytes excluded from publication.'}
                expected = entries.get(path.name)
                if expected is None or any(entry[k] != expected[k] for k in ('sha256', 'bytes')):
                    raise ValueError(f'Unbound omitted artifact: {path}')
                omissions.append(entry)
            else:
                copy(path, target / 'builds' / build.name / path.name)
    for path in sorted((evaluation / 'runtime-jobs').rglob('*.json')):
        copy(path, target / path.relative_to(evaluation))
    (target / 'omitted-artifacts.json').write_text(json.dumps({
        'format': 'natural-repair-omissions-v1', 'artifacts': omissions,
        'upstream_trees': 'Not copied. Original source revisions, dependency hashes, and exact commands are in build result.json; retained candidate and before files are authoritative.',
        'validation': 'Each omitted artifact rehashed from actual local bytes and matched against its build result before staging.'
    }, indent=2) + '\n')
    sources = [ROOT / 'tools/research/natural-repair-eval',
               ROOT / 'tools/research/natural-diagnostic',
               ROOT / 'lib/research/natural-diagnostic.js',
               ROOT / 'tests/natural-diagnostic.test.mjs',
               ROOT / 'tools/research/agent-eval/run.mjs',
               ROOT / 'tools/research/natural-bugs/cutlass_verify.py',
               ROOT / 'tools/research/natural-bugs/tmem_upstream_LICENSE.txt',
               ROOT / 'tools/research/archive-modern-evidence.py',
               ROOT / 'tools/research/costs/cost_publish_safety.py']
    for source in sources:
        copy(source, output / 'sources' / source.relative_to(ROOT))
    copy(ROOT / 'web/research/natural-bugs', output / 'viewer')
    spec = importlib.util.spec_from_file_location('safety', ROOT / 'tools/research/costs/cost_publish_safety.py')
    safety = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(safety)
    scan = safety.scan_paths([output])
    (output / 'publication-scan.json').write_text(json.dumps(scan, indent=2) + '\n')
    if scan['matchedFiles']:
        raise ValueError('Sensitive environment-value match; do not publish staging directory')
    return {'status': 'staged', 'output': str(output),
            'omitted_artifacts': len(omissions), 'scan_files': scan['filesChecked']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evaluation', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(stage(args.evaluation.resolve(), args.output.resolve())))
