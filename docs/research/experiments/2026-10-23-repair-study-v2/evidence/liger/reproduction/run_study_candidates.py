#!/usr/bin/env python3
"""Wait for the entire frozen generation phase, then execute untouched Liger candidates."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time
from evaluate_candidate import evaluate


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--study', type=Path, default=Path('out/research/repair-v2-study'))
    p.add_argument('--base', type=Path, default=Path('out/research/liger-faults'))
    a = p.parse_args()
    schedule = json.loads((a.study / 'frozen/schedule.json').read_text())
    while not all((a.study / 'trials' / t['id'] / 'result.json').exists() for t in schedule):
        time.sleep(5)
    generation = [json.loads((a.study / 'trials' / t['id'] / 'result.json').read_text()) for t in schedule]
    assert all(r['finishedAt'] for r in generation)
    freeze = json.loads(Path('out/research/repair-v2-runtime-frozen/manifest.json').read_text())
    for entry in freeze['files']:
        assert hashlib.sha256(Path(entry['path']).read_bytes()).hexdigest() == entry['sha256'], entry['path']
    gate = {'format': 'all-candidates-before-validation-gate-v1', 'plannedTrials': len(schedule),
        'completedGeneration': len(generation), 'allGenerationFinishedAt': max(r['finishedAt'] for r in generation),
        'validationGateOpenedAt': datetime.now(timezone.utc).isoformat(), 'runtimeFreezeVerified': True,
        'runner_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    (a.base / 'candidate-generation-gate.json').write_text(json.dumps(gate, indent=2) + '\n')
    outputs = []
    for t in schedule:
        if not t['taskId'].startswith('liger-'):
            continue
        candidate = a.study / 'trials' / t['id'] / 'candidate.json'
        if not candidate.exists():
            record = {'trialId': t['id'], 'status': 'not-executed', 'reason': 'original candidate absent; trial retained in denominator'}
        else:
            r = evaluate(candidate, a.base / 'candidate-evaluations' / t['id'], a.base)
            record = {'trialId': t['id'], 'buildStatus': r['buildStatus'], 'verifierStatus': r['verifierStatus'],
                'hiddenPassed': sum(c['status'] == 'passed' for c in r['cases']), 'hiddenRecorded': len(r['cases']),
                'wall_seconds': r['wall_seconds'], 'validation_error': r.get('validation_error')}
        outputs.append(record)
        print(json.dumps(record), flush=True)
    (a.base / 'candidate-execution-summary.json').write_text(json.dumps(outputs, indent=2) + '\n')


if __name__ == '__main__':
    main()
