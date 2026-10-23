#!/usr/bin/env python3
"""Run the unchanged upstream 16-case TMEM regression and retain all outputs.

Only host torch.empty allocations are observed, without modifying returned
tensors, kernel code, launch arguments, or upstream assertion behavior.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import gzip
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1048576), b''):
            h.update(block)
    return h.hexdigest()


def dump(path, obj):
    raw = (json.dumps(obj, sort_keys=True, separators=(',', ':')) + '\n').encode()
    path.write_bytes(gzip.compress(raw, mtime=0))
    return {'path': path.name, 'sha256': sha(path), 'bytes': path.stat().st_size,
            'uncompressed_sha256': hashlib.sha256(raw).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--variant', choices=['before', 'after'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--build-manifest', type=Path, required=True)
    parser.add_argument('--wheel', type=Path, required=True)
    parser.add_argument('--dump-pass-ir', action='store_true', help='Record official MLIR debug dumps, including allocation boundaries; disables compiler context multithreading identically in both variants.')
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    out = args.output.resolve()
    if args.dump_pass_ir and not args.worker:
        # The C++ dump stream has process lifetime. Compress only after its
        # destructor flushes on child exit, preserving every original byte.
        proc = subprocess.run([sys.executable, str(Path(__file__).resolve()), *sys.argv[1:], '--worker'])
        raw_path, summary_path = out / 'pass-ir.mlir', out / 'summary.json'
        if raw_path.exists() and summary_path.exists():
            raw = raw_path.read_bytes()
            dest = out / 'pass-ir.mlir.gz'
            dest.write_bytes(gzip.compress(raw, mtime=0))
            saved = json.loads(summary_path.read_text())
            saved['pass_ir'] = {'path': dest.name, 'sha256': sha(dest), 'bytes': dest.stat().st_size,
                                'uncompressed_sha256': hashlib.sha256(raw).hexdigest(), 'uncompressed_bytes': len(raw),
                                'capture_boundary': 'Compiler child process exited; C++ dump stream flushed before compression.'}
            summary_path.write_text(json.dumps(saved, indent=2) + '\n')
            raw_path.unlink()  # All original bytes retained losslessly in gzip.
        return proc.returncode
    out.mkdir(parents=True, exist_ok=False)
    here = Path(__file__).resolve().parent
    upstream_manifest = json.loads((here / 'tmem_upstream_manifest.json').read_text())
    test = here / 'tmem_upstream_regression.py'
    if sha(test) != upstream_manifest['module_sha256']:
        raise ValueError('upstream extracted module hash mismatch')
    build = json.loads(args.build_manifest.read_text())
    variant = next(x for x in build['builds'] if x['variant'] == args.variant)
    wheel = next(x for x in variant['wheels'] if x['sha256'] == sha(args.wheel))
    if variant['status'] != 'completed' or not wheel.get('compiler_members'):
        raise ValueError('completed compiler wheel/member binding required')
    os.environ.update(TRITON_CACHE_DIR=str(out / 'cache'), TRITON_DUMP_DIR=str(out / 'compiler'),
                      TRITON_KERNEL_DUMP='1', PYTHONDONTWRITEBYTECODE='1')
    if args.dump_pass_ir:
        os.environ.update(MLIR_ENABLE_DUMP='1', MLIR_DUMP_PATH=str(out / 'pass-ir.mlir'))
    import torch
    import triton
    import pytest
    from triton._C import libtriton
    actual_lib = sha(libtriton.__file__)
    expected_lib = next(x['sha256'] for x in wheel['compiler_members'] if x['path'].endswith('/libtriton.so'))
    installed_distribution_version = importlib.metadata.version('triton')
    if actual_lib != expected_lib or variant['commit'][:8] not in installed_distribution_version:
        raise ValueError('installed compiler does not match exact source-bound wheel')
    if torch.cuda.get_device_capability() != (10, 0):
        raise ValueError('this reproduction requires an SM100 GPU')
    summary = {'schema': 'natural-tmem-upstream-regression-v1', 'variant': args.variant,
               'source_commit': variant['commit'], 'source_archive_sha256': variant['source_archive_sha256'],
               'allocator_source_sha256': variant['allocator_source_sha256'],
               'build_manifest_sha256': sha(args.build_manifest), 'wheel_sha256': wheel['sha256'],
               'libtriton_sha256': actual_lib, 'runner_sha256': sha(__file__),
               'upstream': upstream_manifest, 'started_utc': datetime.now(timezone.utc).isoformat(),
               'python': sys.version, 'platform': platform.platform(),
               'torch_version': torch.__version__, 'torch_cuda': torch.version.cuda,
               'triton_version': triton.__version__, 'triton_distribution_version': installed_distribution_version,
               'gpu': torch.cuda.get_device_name(),
               'compute_capability': list(torch.cuda.get_device_capability()),
               'mlir_pass_dump_enabled': args.dump_pass_ir,
               'mlir_pass_dump_scope': 'Official enable_debug IR printer before passes; compiler context multithreading disabled when requested. No pass additions, IR edits, or in-kernel instrumentation.',
               'host_observation': 'Observe the first two torch.empty tensors; unchanged upstream test/kernel/assertions. Copy valid outputs only after the test call completes or raises.',
               'claims': 'Numerical/compiler regression only; no performance, hardware timeline, or sampled TMEM tag claim.',
               'runs': [], 'reports': []}
    (out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')

    class Recorder:
        @pytest.hookimpl(hookwrapper=True)
        def pytest_runtest_call(self, item):
            allocations = []
            compiled = []
            original_empty = torch.empty
            original_compile_hook = triton.knobs.runtime.jit_post_compile_hook
            if original_compile_hook is not None:
                raise ValueError('unexpected preinstalled compiler observer')
            def observe_empty(*a, **kw):
                tensor = original_empty(*a, **kw)
                if len(allocations) < 2:
                    allocations.append(tensor)
                return tensor
            def observe_compile(**kw):
                # Read-only hook at the audited upstream interface. It observes
                # the already-built kernel; no IR, options or launch changes.
                kernel = kw['fn'].jit_function.device_caches[kw['compile']['device']][0][kw['key']]
                bound = out / 'compiler' / kernel.hash
                bound.mkdir(parents=True, exist_ok=True)
                members = []
                for name, path in sorted(kernel.metadata_group.items()):
                    raw = Path(path).read_bytes()
                    dest = bound / Path(name).name
                    dest.write_bytes(raw)
                    members.append({'path': str(dest.relative_to(out)), 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)})
                compiled.append({'hash': kernel.hash, 'name': kernel.name,
                                 'specialization_data': kw['compile']['specialization_data'],
                                 'artifacts': members})
            torch.empty = observe_empty
            triton.knobs.runtime.jit_post_compile_hook = observe_compile
            begin = time.monotonic()
            try:
                yield
            finally:
                torch.empty = original_empty
                triton.knobs.runtime.jit_post_compile_hook = original_compile_hook
                params = dict(item.callspec.params)
                record = {'id': item.nodeid, 'parameters': params,
                          'compiled_kernels': compiled,
                          'host_call_wall_seconds': time.monotonic()-begin,
                          'output_observation': 'GPU output tensor copied to CPU after upstream call; no in-kernel instrumentation.'}
                try:
                    torch.cuda.synchronize()
                    if len(allocations) != 2:
                        raise ValueError('upstream allocation observation count changed')
                    choice, mode, columns, outer = (params[k] for k in ['choice', 'mode', 'columns', 'outer_choice'])
                    expected = 3 if mode == 'first' or (mode == 'select' and choice) else 5
                    if mode == 'chain':
                        expected = 3 if choice == outer else 5
                    outputs = []
                    for label, tensor, value in [('selected', allocations[0], expected)] + ([('temporary', allocations[1], 7)] if columns else []):
                        actual = tensor.detach().cpu().contiguous().reshape(-1).tolist()
                        reference = [float(value)] * len(actual)
                        mismatch = [i for i, (a, b) in enumerate(zip(actual, reference)) if a != b]
                        outputs.append({'name': label, 'shape': list(tensor.shape), 'dtype': str(tensor.dtype),
                                        'actual': actual, 'reference': reference, 'mismatch_indices': mismatch,
                                        'mismatch_count': len(mismatch), 'actual_value_counts': dict(Counter(actual)),
                                        'reference_value': value})
                    record.update(outputs=outputs, numeric_correct=all(x['mismatch_count'] == 0 for x in outputs),
                                  unused_temporary_excluded=columns == 0)
                except Exception as error:
                    record.update(observation_error_type=type(error).__name__, observation_error=str(error))
                artifact = dump(out / f'case-{len(summary["runs"]):02d}.json.gz', record)
                summary['runs'].append({'id': record['id'], 'parameters': params, 'artifact': artifact,
                                        'compiled_kernel_hashes': [x['hash'] for x in compiled],
                                        'numeric_correct': record.get('numeric_correct'),
                                        'mismatch_count': sum(x['mismatch_count'] for x in record.get('outputs', [])),
                                        'output_elements': sum(len(x['actual']) for x in record.get('outputs', []))})

        def pytest_runtest_logreport(self, report):
            entry = {'id': report.nodeid, 'when': report.when, 'outcome': report.outcome}
            if report.failed:
                entry['failure'] = report.longreprtext
            summary['reports'].append(entry)

    code = int(pytest.main([str(test), '-vv', '--tb=long', '--capture=tee-sys',
                            '--junitxml=' + str(out / 'pytest.xml'), '-p', 'no:cacheprovider'], plugins=[Recorder()]))
    summary['pytest_exit_code'] = code
    summary['counts'] = dict(Counter(x['outcome'] for x in summary['reports'] if x['when'] == 'call'))
    summary['numeric_correct_cases'] = sum(x['numeric_correct'] is True for x in summary['runs'])
    summary['numeric_wrong_cases'] = sum(x['numeric_correct'] is False for x in summary['runs'])
    summary['output_elements'] = sum(x['output_elements'] for x in summary['runs'])
    summary['mismatch_elements'] = sum(x['mismatch_count'] for x in summary['runs'])
    # Retain generated code, including ELF cubins as compressed bytes rather than
    # allowing transport's generic ELF omission policy to discard the binaries.
    artifacts = []
    bundled_cuobjdump = Path(triton.__file__).resolve().parent / 'backends/nvidia/bin/cuobjdump'
    cuobjdump = str(bundled_cuobjdump) if bundled_cuobjdump.exists() else shutil.which('cuobjdump')
    if cuobjdump is None:
        raise ValueError('cuobjdump is required to retain generated SASS')
    tool_version = subprocess.run([cuobjdump, '--version'], capture_output=True, text=True, timeout=15)
    summary['cuobjdump'] = {'path': cuobjdump, 'sha256': sha(cuobjdump),
                            'version_stdout': tool_version.stdout, 'version_stderr': tool_version.stderr,
                            'version_exit_code': tool_version.returncode}
    for path in sorted((out / 'compiler').rglob('*')):
        if not path.is_file():
            continue
        entry = {'path': str(path.relative_to(out)), 'sha256': sha(path), 'bytes': path.stat().st_size}
        if path.suffix == '.cubin':
            compressed = path.with_suffix('.cubin.gz')
            compressed.write_bytes(gzip.compress(path.read_bytes(), mtime=0))
            entry['gzip_path'] = str(compressed.relative_to(out)); entry['gzip_sha256'] = sha(compressed)
            sass = path.with_suffix('.sass')
            proc = subprocess.run([cuobjdump, '--dump-sass', str(path)], capture_output=True, timeout=30)
            sass.write_bytes(proc.stdout)
            sass.with_suffix('.sass.stderr').write_bytes(proc.stderr)
            entry.update(sass_path=str(sass.relative_to(out)), sass_sha256=sha(sass), sass_exit_code=proc.returncode)
        artifacts.append(entry)
    summary['compiler_artifacts'] = artifacts
    expect_wrong = 7 if args.variant == 'before' else 0
    summary['matches_reported_reproduction_pattern'] = (len(summary['runs']) == 16 and
        summary['numeric_wrong_cases'] == expect_wrong and summary['numeric_correct_cases'] == 16-expect_wrong and
        summary['counts'] == ({'passed': 9, 'failed': 7} if expect_wrong else {'passed': 16}) and code == (1 if expect_wrong else 0))
    summary['finished_utc'] = datetime.now(timezone.utc).isoformat()
    (out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({k: summary[k] for k in ['variant', 'counts', 'numeric_wrong_cases', 'output_elements', 'mismatch_elements', 'matches_reported_reproduction_pattern']}))
    return 0 if summary['matches_reported_reproduction_pattern'] else 3


if __name__ == '__main__':
    raise SystemExit(main())
