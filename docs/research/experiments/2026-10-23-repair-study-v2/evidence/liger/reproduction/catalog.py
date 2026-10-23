#!/usr/bin/env python3
"""Expose genuine subsystem sources and before observations, never gold answers."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np

FAMILIES = {'poly': (1540, 'poly_norm'), 'sparse': (1545, 'sparsemax'), 'grpo': (1461, 'grpo_loss')}
OBJECTIVES = {
    'poly': 'Repair PolyNorm forward output: y = w[0]*RMSNormalize(x^3) + w[1]*RMSNormalize(x^2) + w[2]*RMSNormalize(x) + bias, where RMSNormalize(u)=u/sqrt(mean(u^2)+eps). Preserve output shape/dtype and input tensors. Inputs are finite fp16/bf16/fp32; evaluate the mathematical formula on the represented inputs with the stated case tolerances. The public entry point is LigerPolyNormFunction.apply. Backward optimization is outside this task.',
    'sparse': 'Repair sparsemax forward, the Euclidean projection of each last-axis input row onto the probability simplex. Preserve input tensors, output shape/dtype and the operation for finite fp16/bf16/fp32 values. Public entry point: LigerSparsemaxFunction.apply(x,-1). Case observations include tolerance and complete-output comparison counts. Do not change the test contract.',
    'grpo': 'Repair fused_selective_log_softmax(logits,input_ids,temperature,mask). Logits are contiguous (B,L+1,V); output is FP32 (B,L), gathering the log-softmax of logits[:,:-1]/temperature at input_ids[:,-L:]. Where a supplied mask[:,-L:] is false, output is zero. Valid strided or broadcast ID/mask views are supported independently; mask may be None. Preserve inputs. Error tolerance is atol=rtol=2e-5.'}


def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()


def build(root):
    plan = json.loads((root / 'plan.json').read_text()); tasks = []; private = []
    for family, (number, module) in FAMILIES.items():
        source = root / f'sources/{number}/before'; run = root / f'controls-v2/{family}/before'
        paths = list((source / 'src/liger_kernel/ops').glob('*.py'))
        paths += [source / 'src/liger_kernel/utils.py', source / 'src/liger_kernel/functional.py']
        wrapper = source / f'src/liger_kernel/transformers/{module}.py'
        if wrapper.exists(): paths.append(wrapper)
        files = [{'id': f'source-{i:02d}', 'path': str(p.relative_to(source)), 'text': p.read_text(), 'sha256': sha(p), 'role': 'implementation'} for i, p in enumerate(sorted(paths))]
        cases = []; facts = []
        summary = json.loads((run / 'summary.json').read_text())
        for row in summary['records']:
            if row['partition'] != 'visible': continue
            case_id = row['id']; fact_id = 'observation-' + case_id
            case = {'id': case_id, 'status': 'passed' if row['passed'] else 'wrong_value' if row.get('outputs') else 'execution_error', 'parameters': row['parameters'], 'evidenceRefs': [fact_id]}
            payload = {k: row[k] for k in ['outputs', 'mismatches', 'nonfinite', 'max_abs_error', 'inputs_unchanged', 'input_array_identities', 'actual_dtype', 'actual_shape'] if k in row}
            payload['input_strides'] = row.get('input_strides')
            if row.get('artifact'):
                with np.load(run / row['artifact']['path'], allow_pickle=False) as arrays:
                    actual, expected = arrays['actual'].ravel(), arrays['reference'].ravel()
                    p = row['parameters']; bad = ~np.isclose(actual, expected, atol=p['atol'], rtol=p['rtol']) | ~np.isfinite(actual)
                    indices = np.flatnonzero(bad)[:16] if bad.any() else np.arange(min(16, actual.size))
                    def value(v): return float(v) if np.isfinite(v) else str(v)
                    payload['sample'] = [{'flat_index': int(i), 'actual': value(actual[i]), 'reference': value(expected[i])} for i in indices]
                    payload['sample_scope'] = 'At most 16 mismatching positions, or first 16 positions in a passing case. Full-array comparison counts above; complete arrays retained outside the bounded agent packet.'
            refs = [{'id': 'record-' + case_id, 'sha256': sha(run / (case_id + '.json'))}]
            if row.get('artifact'): refs.append({'id': 'arrays-' + case_id, 'sha256': row['artifact']['sha256']})
            facts.append({'id': fact_id, 'kind': 'device-output', 'observed': True, 'caseIds': [case_id], 'text': f"Actual GPU invocation: {case['status']}; {row['mismatches']} mismatches among {row['outputs']} outputs.", 'payload': payload, 'rawRefs': refs})
            cases.append(case)
        task_id = 'liger-' + family
        tasks.append({'id': task_id, 'family': family, 'split': 'holdout', 'objective': OBJECTIVES[family], 'files': files, 'cases': cases, 'evidence': facts,
                      'limits': ['All supplied implementation files may be searched and edited; this is a real subsystem package, not the entire upstream repository.', 'These public sources are new to this project tool evaluation, not claimed absent from model training.', 'Generic diagnostic queries were not specialized to this bug. Runtime numerical evidence is not a hardware event timeline.']})
        target = next(f for f in files if f['path'] == f'src/liger_kernel/ops/{module}.py')
        ranges = {'poly': [(24, 99), (205, 259)], 'sparse': [(12, 70), (108, 134)], 'grpo': [(27, 84)]}[family]
        private.append({'id': task_id, 'rootCauseId': f'linkedin/Liger-Kernel#{number}',
                        'relevantRegions': [{'source_id': target['id'], 'start_line': a, 'end_line': b} for a,b in ranges],
                        'hiddenCaseIds': [c['id'] for c in plan['cases'] if c['family'] == family and c['partition'] == 'hidden'],
                        'hiddenSpecSHA256': sha(root / 'plan.json'), 'requirePassingControl': True})
    return {'format': 'repair-study-catalog-v2', 'tasks': tasks}, {'format': 'repair-study-private-v2', 'tasks': private}


if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--input',type=Path,required=True);a=p.parse_args()
    catalog, private=build(a.input)
    for name, obj in [('catalog.json',catalog),('private-plan.json',private)]:
        with (a.input/name).open('x') as stream:stream.write(json.dumps(obj,indent=2)+'\n')
    print(json.dumps({'tasks':len(catalog['tasks']),'files':[len(t['files']) for t in catalog['tasks']]}))
