#!/usr/bin/env python3
"""Select complete numerical evidence and source; omit installed native binaries."""
import argparse
import hashlib
import json
from pathlib import Path


def collect(base, output):
    output.mkdir(parents=True, exist_ok=False)
    entries = []

    def copy(path, relative=None):
        if '__pycache__' in path.parts or path.suffix == '.pyc':
            return
        data = path.read_bytes()
        assert not data.startswith(b'\x7fELF'), f'ELF rejected: {path}'
        rel = relative or path.relative_to(base)
        dest = output / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        entries.append({'path': str(rel), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})

    for p in base.iterdir():
        if p.is_file() and p.suffix in ('.json', '.v1', '.log', '.txt'):
            copy(p)
    for name in ('upstream', 'screening-v1', 'controls-v1', 'controls-v2', 'gold-candidates'):
        for p in (base / name).rglob('*'):
            if p.is_file():
                copy(p)
    # Exact source imports, including unchanged runtime support and licenses.
    # Full checkout tests/docs and compressed upstream tarballs are unnecessary.
    for version in (base / 'sources').glob('*/*'):
        if version.name not in ('before', 'gold') or not version.is_dir():
            continue
        for p in (version / 'src').rglob('*'):
            if p.is_file():
                copy(p)
        for name in ('LICENSE', 'NOTICE', 'pyproject.toml'):
            if (version / name).is_file():
                copy(version / name)
        for p in (version / 'licenses').rglob('*'):
            if p.is_file():
                copy(p)
    for pattern in ('gold-evaluator-check*/*', 'candidate-evaluations/*'):
        for run in base.glob(pattern):
            if not run.is_dir():
                continue
            for p in run.iterdir():
                if p.is_file() and p.suffix in ('.json', '.log', '.txt'):
                    copy(p)
            for p in (run / 'run').rglob('*'):
                if p.is_file():
                    copy(p)
    for p in Path(__file__).parent.iterdir():
        if p.is_file():
            copy(p, Path('reproduction') / p.name)
    manifest = {'format': 'liger-fault-publication-v1', 'files': entries,
        'policy': 'Full numerical inputs/actual/reference buffers and compiler text are retained. Source for exact before/gold imports is retained. Candidate source is reconstructible from complete candidate.json, not repeated checkout copies. Wheels, jit caches, tarballs and ELF binaries are omitted; their identities remain in runtime/source receipts.'}
    (output / 'publication-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return {'files': len(entries), 'bytes': sum(e['bytes'] for e in entries)}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base', type=Path, default=Path('out/research/liger-faults'))
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    print(json.dumps(collect(a.base, a.output)))
