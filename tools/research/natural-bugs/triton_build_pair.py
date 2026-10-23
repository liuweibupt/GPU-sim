#!/usr/bin/env python3
"""Build exact public parent/fix Triton sources in isolated directories, CPU only.

Run with a Python 3.12 environment containing python/requirements.txt and build.
No GPU activity; no credentials or ambient environment are written to artifacts.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tarfile
import time
from urllib.request import urlretrieve

COMMITS = {"before": "08a3cd4364d87bf2c281067f7a40e17808f22e7b",
           "after": "0002b46dadfc6f8fbe7464c285651311c709fdc6"}


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1048576), b''):
            h.update(block)
    return h.hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--jobs', type=int, default=16)
    p.add_argument('--variant', choices=['before', 'after', 'both'], default='both')
    args = p.parse_args()
    if not 1 <= args.jobs <= 16:
        raise ValueError('CPU compilation job count must be 1..16')
    out = args.output.resolve()
    sources = out / 'sources'
    sources.mkdir(parents=True, exist_ok=True)
    summary = {'schema': 'triton-exact-parent-fix-build-v1', 'commits': COMMITS,
               'started_utc': datetime.now(timezone.utc).isoformat(), 'python': sys.version,
               'platform': platform.platform(), 'jobs': args.jobs, 'cpu_affinity': sorted(os.sched_getaffinity(0)), 'builds': [],
               'script_sha256': sha(__file__), 'source_policy': 'Unmodified GitHub commit archives; no source patch applied.',
               'scope': 'Default NVIDIA and AMD compiler backends; Proton and C++ unit-test binaries disabled identically in both builds.'}
    def save():
        (out / ('build-' + args.variant + '.json')).write_text(json.dumps(summary, indent=2) + '\n')
    save()
    for variant, commit in COMMITS.items():
        if args.variant not in ('both', variant):
            continue
        archive = sources / ('triton-' + commit + '.tar.gz')
        url = f'https://github.com/triton-lang/triton/archive/{commit}.tar.gz'
        if not archive.exists():
            urlretrieve(url, archive)
        source = sources / ('triton-' + commit)
        if not source.exists():
            with tarfile.open(archive) as tar:
                tar.extractall(sources, filter='data')
        wheels = out / 'wheels' / variant
        wheels.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        overrides = {'MAX_JOBS': str(args.jobs), 'CMAKE_BUILD_PARALLEL_LEVEL': str(args.jobs), 'TRITON_HOME': str(out / 'dependencies'),
                     'TRITON_BUILD_PROTON': 'OFF', 'TRITON_WHEEL_VERSION_SUFFIX': '+git' + commit[:8],
                     'TRITON_APPEND_CMAKE_ARGS': '-DTRITON_BUILD_UT=OFF -DCMAKE_C_COMPILER=/usr/bin/clang-18 -DCMAKE_CXX_COMPILER=/usr/bin/clang++-18 -DCMAKE_EXE_LINKER_FLAGS=-fuse-ld=/usr/bin/ld.lld-17 -DCMAKE_MODULE_LINKER_FLAGS=-fuse-ld=/usr/bin/ld.lld-17 -DCMAKE_SHARED_LINKER_FLAGS=-fuse-ld=/usr/bin/ld.lld-17',
                     'PATH': str(Path(sys.executable).parent) + os.pathsep + env['PATH']}
        env.update(overrides)
        command = [sys.executable, '-m', 'build', '--wheel', '--no-isolation', '--outdir', str(wheels)]
        item = {'variant': variant, 'commit': commit, 'source_url': url,
                'source_archive_sha256': sha(archive), 'source_directory': str(source),
                'llvm_info': json.loads((source / 'cmake/llvm-info.json').read_text()),
                'amd_llvm_info': json.loads((source / 'cmake/amd-llvm-info.json').read_text()),
                'allocator_source_sha256': sha(source / 'lib/Dialect/TritonNvidiaGPU/Transforms/TensorMemoryAllocation.cpp'),
                'command': command, 'explicit_build_environment': overrides, 'status': 'running'}
        summary['builds'].append(item)
        save()
        start = time.monotonic()
        log = out / ('build-' + variant + '.log')
        with log.open('wb') as stream:
            process = subprocess.run(command, cwd=source, env=env, stdout=stream, stderr=subprocess.STDOUT)
        item.update(exit_code=process.returncode, wall_seconds=time.monotonic()-start,
                    status='completed' if process.returncode == 0 else 'failed', log_sha256=sha(log))
        item['wheels'] = [{'path': str(w), 'bytes': w.stat().st_size, 'sha256': sha(w)} for w in sorted(wheels.glob('*.whl'))]
        save()
        print(json.dumps({k: item[k] for k in ['variant', 'status', 'wall_seconds', 'wheels']}), flush=True)
        if process.returncode:
            return process.returncode
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
