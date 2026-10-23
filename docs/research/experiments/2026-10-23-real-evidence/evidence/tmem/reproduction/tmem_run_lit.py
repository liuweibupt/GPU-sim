#!/usr/bin/env python3
"""Execute the unchanged fixed-commit allocation lit file on both CPU compilers."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time

COMMITS = {'before': '08a3cd4364d87bf2c281067f7a40e17808f22e7b',
           'after': '0002b46dadfc6f8fbe7464c285651311c709fdc6'}


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--directory', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args(); root = args.directory.resolve(); out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    test = root / 'sources' / ('triton-' + COMMITS['after']) / 'test/TritonNvidiaGPU/test_tensor_memory_allocation.mlir'
    check = next((root / 'dependencies/.triton/llvm').glob('llvm-b010a18d-*/bin/FileCheck'))
    summary = {'schema': 'exact-triton-allocation-lit-pair-v1', 'test': str(test), 'test_sha256': sha(test),
               'filecheck_sha256': sha(check), 'script_sha256': sha(__file__), 'runs': [],
               'scope': 'CPU compilation of unchanged upstream fixed-commit lit file; not hardware execution.'}
    for variant, commit in COMMITS.items():
        binary = next((root / 'sources' / ('triton-' + commit) / 'build').glob('cmake.*/bin/triton-opt'))
        argv = [str(binary), str(test), '-split-input-file', '-allow-unregistered-dialect', '-triton-tensor-memory-allocation']
        start = time.monotonic(); proc = subprocess.run(argv, capture_output=True, timeout=60)
        ir = out / (variant + '.mlir'); ir.write_bytes(proc.stdout)
        (out / (variant + '.stderr.txt')).write_bytes(proc.stderr)
        run = {'variant': variant, 'source_commit': commit, 'triton_opt_sha256': sha(binary),
               'argv': argv, 'exit_code': proc.returncode, 'wall_seconds': time.monotonic()-start,
               'ir_sha256': sha(ir), 'ir_bytes': ir.stat().st_size}
        if proc.returncode == 0:
            cmd = [str(check), str(test), '--input-file', str(ir)]
            checked = subprocess.run(cmd, capture_output=True, timeout=30)
            (out / (variant + '.filecheck.stdout.txt')).write_bytes(checked.stdout)
            err = out / (variant + '.filecheck.stderr.txt'); err.write_bytes(checked.stderr)
            run['filecheck'] = {'argv': cmd, 'exit_code': checked.returncode,
                                'stderr_sha256': sha(err), 'stderr_bytes': err.stat().st_size}
        summary['runs'].append(run)
    summary['expected_regression_transition_observed'] = all(x['exit_code'] == 0 and x.get('filecheck', {}).get('exit_code') == (1 if x['variant'] == 'before' else 0) for x in summary['runs'])
    (out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({'output': str(out), 'expected_transition': summary['expected_regression_transition_observed']}))
    return 0 if summary['expected_regression_transition_observed'] else 1


if __name__ == '__main__': raise SystemExit(main())
