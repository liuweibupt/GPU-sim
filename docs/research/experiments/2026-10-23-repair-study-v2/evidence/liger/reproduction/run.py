#!/usr/bin/env python3
"""Execute unchanged imported Liger production code and retain complete arrays."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import traceback


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def array_identity(arrays):
    import numpy as np
    entries = []
    for name, value in sorted(arrays.items()):
        value = np.ascontiguousarray(value)
        entries.append({'name': name, 'shape': list(value.shape), 'dtype': str(value.dtype),
                        'sha256': hashlib.sha256(value.tobytes()).hexdigest()})
    return entries


def reference(family, arrays, p):
    import numpy as np
    if family == 'poly':
        x = arrays['x'].astype(np.float64); w = arrays['weights'].astype(np.float64); b = float(arrays['bias'])
        return sum(w[i] * x**power / np.sqrt(np.mean(x**(2 * power), axis=-1, keepdims=True) + p['eps']) for i, power in enumerate([3, 2, 1])) + b
    if family == 'sparse':
        x = arrays['x'].astype(np.float64)
        shifted = x - x.max(axis=-1, keepdims=True)
        z = np.sort(shifted, axis=-1)[:, ::-1]
        cssv = np.cumsum(z, axis=-1)
        support = z - (cssv - 1) / np.arange(1, x.shape[-1] + 1) > 0
        k = support.sum(axis=-1)
        tau = (cssv[np.arange(len(k)), k - 1] - 1) / k
        return np.maximum(shifted - tau[:, None], 0)
    x = arrays['logits'].astype(np.float64)[:, :-1] / p['temperature']
    shifted = x - x.max(axis=-1, keepdims=True)
    logp = shifted - np.log(np.exp(shifted).sum(axis=-1, keepdims=True))
    return np.take_along_axis(logp, arrays['ids'].astype(np.int64)[..., None], axis=-1)[..., 0] * arrays['mask']


def layout_inputs(ids, mask, layout):
    batch, length = ids.shape
    if layout == 'dense': return ids, mask
    if layout == 'different_prefixes':
        a = ids.new_zeros(batch, length + 3); a[:, -length:] = ids
        b = mask.new_zeros(batch, length + 9); b[:, -length:] = mask
        return a, b
    if layout == 'strided_ids':
        a = ids.new_zeros(batch, 2 * length); a[:, ::2] = ids
        b = mask.new_zeros(batch, 2 * length + 3); b[:, -length:] = mask
        return a[:, ::2], b
    if layout == 'strided_mask':
        b = mask.new_zeros(batch, 2 * length); b[:, ::2] = mask
        return ids, b[:, ::2]
    if layout == 'broadcast_ids': return ids[:1].expand(batch, -1), mask
    if layout == 'broadcast_mask':
        b = mask.new_zeros(batch, length); b[0] = mask[0]
        return ids, b[:1].expand(batch, -1)
    raise ValueError(layout)


def run(source, family, plan_path, output, partition):
    import numpy as np
    import torch
    import triton
    output.mkdir(parents=True, exist_ok=False)
    sys.path.insert(0, str(source / 'src'))
    module_name = {'poly': 'poly_norm', 'sparse': 'sparsemax', 'grpo': 'grpo_loss'}[family]
    start = time.monotonic()
    doc = {'format': 'liger-natural-runtime-v1', 'family': family,
           'started_at': datetime.now(timezone.utc).isoformat(), 'plan_sha256': sha(plan_path),
           'runner_sha256': sha(__file__), 'source_root': str(source),
           'torch': torch.__version__, 'triton': triton.__version__, 'python': sys.version,
           'gpu': torch.cuda.get_device_name(), 'capability': list(torch.cuda.get_device_capability()),
           'identity': subprocess.run(['nvidia-smi', '--query-gpu=name,compute_cap,driver_version,memory.total', '--format=csv,noheader'], capture_output=True, text=True).stdout.strip(),
           'records': [], 'timing_scope': 'Host correctness execution including imports/JIT/CPU oracle/copy/serialization; not an operator benchmark.'}
    plan = json.loads(plan_path.read_text())
    try:
        op = importlib.import_module('liger_kernel.ops.' + module_name)
        assert Path(op.__file__).resolve() == (source / 'src/liger_kernel/ops' / (module_name + '.py')).resolve()
        doc['module_sha256'] = sha(op.__file__)
        for case in plan['cases']:
            if case['family'] != family or (partition != 'all' and case['partition'] != partition): continue
            before = time.monotonic(); record = dict(case); p = case['parameters']
            try:
                rng = torch.Generator(device='cpu').manual_seed(p['seed']); dtype = getattr(torch, p['dtype'])
                arrays = {}; inputs = []; input_copies = []
                if family in ['poly', 'sparse']:
                    if family == 'sparse' and p['distribution'] == 'constant':
                        cpu = torch.full((p['rows'], p['width']), p['offset'], dtype=dtype)
                    else:
                        cpu = (torch.randn(p['rows'], p['width'], generator=rng) * p.get('scale', 1) + p.get('offset', 0)).to(dtype)
                    x = cpu.cuda(); arrays['x'] = cpu.float().numpy(); inputs = [x]
                    input_copies = [x.clone()]
                    if family == 'poly':
                        w = torch.tensor(p['weights'], dtype=dtype, device='cuda'); b = torch.tensor(p['bias'], dtype=dtype, device='cuda')
                        arrays.update(weights=w.cpu().float().numpy(), bias=b.cpu().float().numpy())
                        inputs += [w, b]; input_copies += [w.clone(), b.clone()]
                        y = op.LigerPolyNormFunction.apply(x, w, b, p['eps'], False)
                    else: y = op.LigerSparsemaxFunction.apply(x, -1)
                else:
                    batch, length, vocab = p['batch'], p['length'], p['vocab']
                    logits = torch.randn(batch, length + 1, vocab, generator=rng).to(dtype).cuda()
                    ids = torch.randint(vocab, (batch, length), generator=rng).cuda()
                    mask = ((torch.arange(batch * length).reshape(batch, length) + p['seed']) % 3 != 0).cuda()
                    ids, mask = layout_inputs(ids, mask, p['layout'])
                    selected = ids[:, -length:]; active = mask[:, -length:]
                    arrays.update(logits=logits.cpu().float().numpy(), ids=selected.cpu().numpy(), mask=active.cpu().numpy() if p['masked'] else np.ones((batch, length), dtype=bool))
                    record['input_strides'] = {'ids': list(selected.stride()), 'mask': list(active.stride()), 'ids_offset': selected.storage_offset(), 'mask_offset': active.storage_offset()}
                    inputs = [logits, ids, mask]; input_copies = [v.clone() for v in inputs]
                    y = op.fused_selective_log_softmax(logits, ids, p['temperature'], mask if p['masked'] else None)
                torch.cuda.synchronize()
                record['actual_dtype'] = str(y.dtype).removeprefix('torch.')
                record['actual_shape'] = list(y.shape)
                record['input_array_identities'] = array_identity(arrays)
                for i, value in enumerate(inputs):
                    arrays[f'input_before_{i}'] = input_copies[i].cpu().float().numpy()
                    arrays[f'input_after_{i}'] = value.cpu().float().numpy()
                arrays['actual'] = y.detach().cpu().float().numpy()
                arrays['reference'] = reference(family, arrays, p)
                unchanged = all(torch.equal(a, b) for a, b in zip(inputs, input_copies))
                finite = np.isfinite(arrays['actual'])
                close = finite & np.isclose(arrays['actual'], arrays['reference'], atol=p['atol'], rtol=p['rtol'])
                path = output / (case['id'] + '.npz'); np.savez_compressed(path, **arrays)
                difference = np.abs(arrays['actual'] - arrays['reference'])
                dtype_ok = record['actual_dtype'] == ('float32' if family == 'grpo' else p['dtype'])
                record.update(passed=bool(close.all() and unchanged and dtype_ok), outputs=int(close.size), mismatches=int((~close).sum()),
                              nonfinite=int((~finite).sum()), inputs_unchanged=unchanged,
                              max_abs_error=float(difference.max()) if np.isfinite(difference).all() else 'nonfinite',
                              artifact={'path': path.name, 'sha256': sha(path), 'bytes': path.stat().st_size})
            except Exception as error:
                record.update(passed=False, error_type=type(error).__name__, traceback=traceback.format_exc(), outputs=0, mismatches=None)
            record['wall_seconds'] = time.monotonic() - before
            doc['records'].append(record)
            (output / (case['id'] + '.json')).write_text(json.dumps(record, indent=2) + '\n')
            print(json.dumps({k: record[k] for k in ['id', 'passed', 'outputs', 'mismatches']}), flush=True)
    except Exception:
        doc['import_error'] = traceback.format_exc()
    doc['imported_source_files'] = []
    for name, mod in sorted(sys.modules.items()):
        path = getattr(mod, '__file__', None)
        if name.startswith('liger_kernel') and path and Path(path).is_file():
            doc['imported_source_files'].append({'module': name, 'path': str(Path(path).relative_to(source)), 'sha256': sha(path)})
    doc['compiler_artifacts'] = []
    cache = Path(os.environ['TRITON_CACHE_DIR'])
    for path in sorted(cache.rglob('*')):
        if not path.is_file() or path.suffix not in ['.json', '.ttir', '.ttgir', '.llir', '.ptx', '.cubin']: continue
        data = path.read_bytes(); relative = path.relative_to(cache)
        entry = {'path': str(Path('compiler') / relative), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
        if data.startswith(b'\x7fELF'):
            entry['omitted'] = 'compiled device binary; exact hash retained'
        else:
            dest = output / entry['path']; dest.parent.mkdir(parents=True, exist_ok=True); dest.write_bytes(data)
        doc['compiler_artifacts'].append(entry)
    from triton._C import libtriton
    doc['native_compiler_sha256'] = sha(libtriton.__file__)
    doc['wall_seconds'] = time.monotonic() - start
    (output / 'summary.json').write_text(json.dumps(doc, indent=2) + '\n')
    return doc


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source', type=Path, required=True); p.add_argument('--family', choices=['poly', 'sparse', 'grpo'], required=True)
    p.add_argument('--plan', type=Path, required=True); p.add_argument('--output', type=Path, required=True)
    p.add_argument('--partition', choices=['visible', 'hidden', 'all'], default='all'); a = p.parse_args()
    run(a.source.resolve(), a.family, a.plan.resolve(), a.output.resolve(), a.partition)
