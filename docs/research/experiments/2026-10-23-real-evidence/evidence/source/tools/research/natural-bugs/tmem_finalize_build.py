#!/usr/bin/env python3
"""Bind exact source archives, source delta, installed compiler members and wheels."""
import argparse
import hashlib
import json
from pathlib import Path
import tarfile
from urllib.request import urlretrieve
import zipfile


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def source_files(path):
    with tarfile.open(path) as tar:
        return {'/'.join(x.name.split('/')[1:]): sha(tar.extractfile(x).read())
                for x in tar.getmembers() if x.isfile()}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--directory', type=Path, required=True)
    args = p.parse_args()
    folder = args.directory.resolve()
    base = json.loads((folder / 'build-both.json').read_text())
    if len(base['builds']) != 2 or any(x['status'] != 'completed' for x in base['builds']):
        raise ValueError('both exact compiler builds must complete')
    maps = {}
    for item in base['builds']:
        archive = folder / 'sources' / ('triton-' + item['commit'] + '.tar.gz')
        if sha(archive.read_bytes()) != item['source_archive_sha256']:
            raise ValueError('source archive changed')
        maps[item['variant']] = source_files(archive)
        item['nvidia_toolchain_info'] = json.loads((Path(item['source_directory']) / 'cmake/nvidia-toolchain-version.json').read_text())
        for wheel in item['wheels']:
            file = Path(wheel['path'])
            if sha(file.read_bytes()) != wheel['sha256'] or file.stat().st_size != wheel['bytes']:
                raise ValueError('compiler wheel changed')
            with zipfile.ZipFile(file) as z:
                names = [n for n in z.namelist() if n.endswith(('/libtriton.so', '/compiler.py', '/ptxas', '/ptxas-blackwell', '/cuobjdump', '/nvdisasm'))]
                wheel['compiler_members'] = [{'path': n, 'bytes': z.getinfo(n).file_size,
                                               'sha256': sha(z.read(n))} for n in names]
            if not any(x['path'].endswith('/libtriton.so') for x in wheel['compiler_members']):
                raise ValueError('wheel lacks native compiler')
    changed = sorted(k for k in set(maps['before']) | set(maps['after']) if maps['before'].get(k) != maps['after'].get(k))
    expected = ['lib/Dialect/TritonNvidiaGPU/Transforms/TensorMemoryAllocation.cpp',
                'test/TritonNvidiaGPU/test_tensor_memory_allocation.mlir']
    if changed != expected:
        raise ValueError(f'unexpected exact commit delta: {changed}')
    base['source_delta'] = [{'path': k, 'before_sha256': maps['before'].get(k),
                             'after_sha256': maps['after'].get(k)} for k in changed]
    patch = folder / 'sources' / '0002b46dadfc6f8fbe7464c285651311c709fdc6.patch'
    if not patch.exists():
        urlretrieve('https://github.com/triton-lang/triton/commit/0002b46dadfc6f8fbe7464c285651311c709fdc6.patch', patch)
    base['upstream_patch'] = {'path': str(patch), 'sha256': sha(patch.read_bytes()), 'bytes': patch.stat().st_size}
    base['finalizer_sha256'] = sha(Path(__file__).read_bytes())
    output = folder / 'tmem_build_manifest.json'
    output.write_text(json.dumps(base, indent=2) + '\n')
    print(json.dumps({'manifest': str(output), 'sha256': sha(output.read_bytes()), 'delta_files': changed,
                      'wheels': [w for x in base['builds'] for w in x['wheels']]}))


if __name__ == '__main__':
    main()
