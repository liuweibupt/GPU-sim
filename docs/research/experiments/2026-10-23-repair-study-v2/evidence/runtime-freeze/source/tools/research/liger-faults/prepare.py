#!/usr/bin/env python3
"""Predeclare bounded visible/hidden contracts for three upstream GPU defects."""
import argparse
import hashlib
import json
from pathlib import Path


def make_plan():
    cases = []
    def add(family, partition, **parameters):
        cases.append({'id': f'{family}-{sum(c["family"] == family for c in cases):02d}',
                      'family': family, 'partition': partition, 'parameters': parameters})
    for partition, widths, seeds in [('visible', [128, 8192], [0]), ('hidden', [257, 4096, 8192], [71, 93])]:
        for width in widths:
            for seed in seeds:
                for dtype in ['float16', 'float32']:
                    add('poly', partition, rows=4, width=width, seed=seed, dtype=dtype,
                        scale=1.0, eps=1e-6, weights=[1/3, 1/3, 1/3], bias=1.0,
                        atol=0.002 if dtype == 'float16' else 2e-5,
                        rtol=0.002 if dtype == 'float16' else 2e-5)
    for dtype, scale in [('float16', 2.0), ('bfloat16', 1.0)]:
        add('poly', 'hidden', rows=3, width=1023, seed=107, dtype=dtype, scale=scale,
            eps=1e-5, weights=[0.6, -0.2, 0.3], bias=-0.25,
            atol=0.002 if dtype == 'float16' else 0.03, rtol=0.002 if dtype == 'float16' else 0.03)
    for partition, seed, widths in [('visible', 0, [16, 256]), ('hidden', 73, [31, 128, 1023])]:
        for width in widths:
            for dtype, offset, distribution in [('float32', 0., 'normal'), ('float16', -65504., 'constant'), ('bfloat16', 94370000., 'constant')]:
                add('sparse', partition, rows=2, width=width, seed=seed, dtype=dtype,
                    offset=offset, distribution=distribution, atol=0.002, rtol=0.002)
    for offset in [-100., 100.]:
        add('sparse', 'hidden', rows=3, width=4096, seed=89, dtype='float32', offset=offset,
            distribution='normal', atol=2e-6, rtol=2e-5)
    for partition, seed, batch, length, vocab, temp in [('visible', 83, 3, 7, 17, 1.0), ('hidden', 97, 2, 5, 37, 0.7), ('hidden', 101, 4, 9, 2053, 1.3)]:
        for layout in ['dense', 'different_prefixes', 'strided_ids', 'strided_mask', 'broadcast_ids', 'broadcast_mask']:
            add('grpo', partition, batch=batch, length=length, vocab=vocab, seed=seed,
                dtype='float32', layout=layout, temperature=temp, masked=True, atol=2e-5, rtol=2e-5)
    for dtype, layout in [('float16', 'strided_ids'), ('bfloat16', 'broadcast_ids'), ('float32', 'dense')]:
        add('grpo', 'hidden', batch=3, length=11, vocab=67, seed=113, dtype=dtype,
            layout=layout, temperature=0.9, masked=False, atol=2e-5, rtol=2e-5)
    return {'format': 'liger-fault-contract-v1', 'cases': cases,
            'scope': 'Forward operator correctness on fixed finite inputs, not full training or all backward paths. Hidden cases are input generalization within three independent public defects.',
            'reference': 'CPU float64 mathematical oracle from complete actual input values; per-case tolerances fixed before model generation.'}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__); p.add_argument('--output', type=Path, required=True); a = p.parse_args()
    a.output.parent.mkdir(parents=True, exist_ok=True)
    with a.output.open('x') as stream: stream.write(json.dumps(make_plan(), indent=2) + '\n')
    print(json.dumps({'path': str(a.output), 'sha256': hashlib.sha256(a.output.read_bytes()).hexdigest(), 'cases': len(make_plan()['cases'])}))
