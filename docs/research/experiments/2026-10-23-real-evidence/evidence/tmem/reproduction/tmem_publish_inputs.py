#!/usr/bin/env python3
"""Publish bounded reproduction inputs and CPU evidence, retaining binary hashes."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--directory', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args(); root = args.directory.resolve(); out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    entries = []
    def copy(source, relative):
        if source.is_symlink() or not source.is_file() or source.stat().st_size > 2000000:
            raise ValueError(f'non-regular or oversized publication input: {source}')
        dest = out / relative; dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, dest)
        entries.append({'path': relative, 'bytes': dest.stat().st_size, 'sha256': sha(dest), 'original_path': str(source)})
    here = Path(__file__).resolve().parent
    for glob in ['tmem_*.py', 'tmem_*.json', 'tmem_*.txt', 'triton_build_*.py']:
        for source in sorted(here.glob(glob)):
            copy(source, 'reproduction/' + source.name)
    for glob in ['build-*.json', 'build-*.log', '*-audit.json', '*-import-check.json', 'source-delta-preflight.json', 'tmem_build_manifest.json', 'verifier-selftests.*.txt']:
        for source in sorted(root.glob(glob)):
            relative = 'cpu-evidence/' + source.name
            if not any(x['path'] == relative for x in entries): copy(source, relative)
    for source in sorted((root / 'lit-pair-v1').iterdir()):
        copy(source, 'cpu-evidence/lit-pair-v1/' + source.name)
    for name in ['gpu-independent-audit-v2.json', 'pair-validation-v2.json']:
        if (root/name).exists(): copy(root/name, 'gpu-audit/' + name)
    if (root/'ir-evidence-v2').exists():
        for source in sorted((root/'ir-evidence-v2').iterdir()):
            copy(source, 'gpu-audit/ir-evidence-v2/' + source.name)
    copy(root / 'sources/upstream_test_core.py', 'upstream/upstream_test_core.py')
    copy(root / 'sources/0002b46dadfc6f8fbe7464c285651311c709fdc6.patch', 'upstream/fix.patch')
    build = json.loads((root / 'tmem_build_manifest.json').read_text())
    for item in build['builds']:
        source = Path(item['source_directory'])
        for name in ['LICENSE', 'setup.py', 'python/requirements.txt', 'python/build_helpers.py',
                     'cmake/llvm-info.json', 'cmake/amd-llvm-info.json', 'cmake/nvidia-toolchain-version.json',
                     'lib/Dialect/TritonNvidiaGPU/Transforms/TensorMemoryAllocation.cpp',
                     'test/TritonNvidiaGPU/test_tensor_memory_allocation.mlir']:
            copy(source / name, 'upstream/' + item['variant'] + '/' + name)
    manifest = {'schema': 'natural-tmem-bounded-publication-inputs-v1', 'files': entries,
                'scope': 'Public exact source snapshots, patch, original upstream harness, compiler build records, CPU lit validation, and optional independently checked GPU/IR audit summaries. Full GPU output remains in the separate source-bound Modal artifact.',
                'excluded': 'Wheels, source tarballs, Python environment, LLVM dependencies, generated build trees and native executables are retained locally; their cryptographic hashes and upstream download locations remain in the build manifest.',
                'source_archives': [{'commit': x['commit'], 'url': x['source_url'], 'sha256': x['source_archive_sha256']} for x in build['builds']]}
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'output': str(out), 'files': len(entries), 'bytes': sum(x['bytes'] for x in entries), 'manifest_sha256': sha(out / 'manifest.json')}))


if __name__ == '__main__': main()
