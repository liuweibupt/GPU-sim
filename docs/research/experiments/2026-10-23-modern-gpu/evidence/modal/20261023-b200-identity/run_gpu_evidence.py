#!/usr/bin/env python3
"""Run one bounded ephemeral Modal GPU job; retain every command and artifact.

Credentials are consumed by Modal from the caller environment. They are never
included in the job payload, remote environment, output manifest, or source copy.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time


IMAGE = "docker.io/nvidia/cuda:13.1.0-devel-ubuntu24.04"


def remote_job(payload):
    import base64
    import glob
    import hashlib
    from pathlib import Path
    import subprocess
    import time

    output = {"format": "modal-gpu-evidence-execution-v1", "commands": [], "artifacts": [],
              "status": "running", "measurement_claim": "Command stdout/artifacts; no inferred GPU timestamps or benchmark claim."}
    started = time.monotonic()
    workspace = Path('/tmp/gpu-semantic-evidence')
    workspace.mkdir()
    for item in payload['sources']:
        path = workspace / item['name']
        data = base64.b64decode(item['base64'])
        if hashlib.sha256(data).hexdigest() != item['sha256']:
            raise ValueError('source upload hash mismatch')
        path.write_bytes(data)
    identity = [
        {"name": "gpu_identity", "argv": ["nvidia-smi", "--query-gpu=name,compute_cap,driver_version,memory.total", "--format=csv,noheader"], "timeout": 15},
        {"name": "nvcc_version", "argv": ["nvcc", "--version"], "timeout": 15},
        {"name": "sanitizer_version", "argv": ["compute-sanitizer", "--version"], "timeout": 15},
    ]
    for command in identity + payload['commands']:
        before = time.monotonic()
        record = dict(command)
        try:
            process = subprocess.run(command['argv'], cwd=workspace, capture_output=True,
                                     text=True, errors='replace', timeout=command.get('timeout', 30))
            record.update(exit_code=process.returncode, stdout=process.stdout, stderr=process.stderr, timed_out=False)
        except subprocess.TimeoutExpired as error:
            def text(value):
                return value.decode(errors='replace') if isinstance(value, bytes) else (value or '')
            record.update(exit_code=None, stdout=text(error.stdout), stderr=text(error.stderr), timed_out=True)
        record['wall_seconds'] = time.monotonic() - before
        record['accepted_exit'] = record['exit_code'] in command.get('allowed_exit_codes', [0]) and not record['timed_out']
        output['commands'].append(record)
        if not record['accepted_exit'] and not command.get('continue_on_failure', False):
            output['status'] = 'stopped'; output['stop_command'] = command['name']; break
    else:
        output['status'] = 'completed'
    paths = set()
    for pattern in payload.get('artifact_patterns', []):
        paths.update(Path(path) for path in glob.glob(str(workspace / pattern), recursive=True))
    for path in sorted(paths):
        if not path.is_file() or path.is_symlink():
            continue
        relative = path.relative_to(workspace).as_posix()
        data = path.read_bytes()
        entry = {"path": relative, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
        if data.startswith(b'\x7fELF'):
            entry['omitted'] = 'compiled executable; binary hash retained'
        else:
            if len(data) > 20_000_000:
                raise ValueError('artifact exceeds bounded return size')
            entry['base64'] = base64.b64encode(data).decode('ascii')
        output['artifacts'].append(entry)
    output['remote_wall_seconds'] = time.monotonic() - started
    return output


def main():
    import base64
    import modal
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--gpu', choices=['B200', 'H100!'], default='B200')
    parser.add_argument('--timeout', type=int, default=240)
    args = parser.parse_args()
    if not 30 <= args.timeout <= 600:
        raise ValueError('one job timeout must be within 30..600 seconds')
    job = json.loads(args.job.read_text())
    names = [item['name'] for item in job.get('commands', [])]
    if len(names) != len(set(names)) or any(not name or '/' in name for name in names):
        raise ValueError('commands need unique simple names')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    sources = []
    for source in job.get('sources', []):
        path = Path(source).resolve()
        data = path.read_bytes()
        sources.append({'name': path.name, 'sha256': hashlib.sha256(data).hexdigest(),
                        'base64': base64.b64encode(data).decode('ascii')})
        (output / path.name).write_bytes(data)
    if len({item['name'] for item in sources}) != len(sources):
        raise ValueError('source basenames must be unique')
    for pattern in job.get('artifact_patterns', []):
        if Path(pattern).is_absolute() or '..' in Path(pattern).parts:
            raise ValueError('artifact pattern must stay in job workspace')
    (output / 'job.json').write_text(json.dumps(job, indent=2) + '\n')
    (output / 'run_gpu_evidence.py').write_bytes(Path(__file__).read_bytes())
    summary = {'format': 'modal-gpu-evidence-job-v1', 'status': 'starting',
               'started_utc': datetime.now(timezone.utc).isoformat(), 'requested_gpu': args.gpu,
               'gpu_count': 1, 'timeout_seconds': args.timeout, 'max_containers': 1,
               'image_tag': IMAGE, 'modal_sdk_version': modal.__version__,
               'source_sha256': {item['name']: item['sha256'] for item in sources},
               'runner_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               'job_sha256': hashlib.sha256((output / 'job.json').read_bytes()).hexdigest(),
               'billing': 'No exact bill inferred from command wall times; configured limits bound each job.',
               'deployment': 'Ephemeral App.run with no persistent deployment, volumes, endpoints or minimum containers.'}
    def save():
        (output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    save()
    image = modal.Image.from_registry(IMAGE, add_python='3.12')
    app = modal.App('gpu-sim-semantic-probes')
    function = app.function(image=image, gpu=args.gpu, cpu=2, memory=2048,
                            timeout=args.timeout, max_containers=1, retries=0,
                            scaledown_window=2, serialized=True)(remote_job)
    try:
        with modal.enable_output(), app.run():
            summary['app_id'] = app.app_id
            summary['image_id'] = image.object_id
            save()
            result = function.remote({'sources': sources, 'commands': job.get('commands', []),
                                      'artifact_patterns': job.get('artifact_patterns', [])})
        for command in result['commands']:
            for stream in ['stdout', 'stderr']:
                raw = command.pop(stream).encode()
                path = command['name'] + '.' + stream + '.txt'
                (output / path).write_bytes(raw)
                command[stream] = {'path': path, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
        for artifact in result['artifacts']:
            if 'base64' not in artifact:
                continue
            raw = base64.b64decode(artifact.pop('base64'))
            if hashlib.sha256(raw).hexdigest() != artifact['sha256'] or len(raw) != artifact['bytes']:
                raise ValueError('returned artifact hash mismatch')
            path = output / 'artifacts' / artifact['path']
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        summary.update(status=result['status'], execution=result)
    except Exception as error:
        # Do not serialize arbitrary connection exceptions, headers or credentials.
        summary.update(status='failed', error_type=type(error).__name__)
        raise
    finally:
        summary['finished_utc'] = datetime.now(timezone.utc).isoformat()
        save()
    print(json.dumps({'status': summary['status'], 'output': str(output),
                      'remote_wall_seconds': summary.get('execution', {}).get('remote_wall_seconds')}))
    return 0 if summary['status'] == 'completed' else 2


if __name__ == '__main__':
    raise SystemExit(main())
