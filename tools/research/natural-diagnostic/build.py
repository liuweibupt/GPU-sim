#!/usr/bin/env python3
"""Build source-bound natural fault facts from a frozen evidence archive.

The benchmark projection includes only original input versions; no repair data,
issue links, commits, diagnostic labels, or saved overlap conclusions.
"""
import argparse
import copy
import gzip
import hashlib
import json
import math
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_ARCHIVE = ROOT / 'docs/research/experiments/2026-10-23-real-evidence/evidence'
def sha(raw): return hashlib.sha256(raw).hexdigest()
def insist(test, message):
    if not test: raise ValueError(message)

class Reader:
    def __init__(self, archive):
        self.archive = archive
        self.manifest = json.loads((archive/'manifest.json').read_text())
        self.entries = {e['original_path']: e for e in self.manifest['files']}
        self.used = {}
    def read(self, path):
        e = self.entries[path]; packed = (self.archive/e['path']).read_bytes()
        insist(sha(packed) == e['stored_sha256'] and len(packed) == e['stored_bytes'], 'stored artifact mismatch: '+path)
        raw = gzip.decompress(packed) if e['encoding'] == 'gzip' else packed
        insist(sha(raw) == e['sha256'] and len(raw) == e['bytes'], 'decoded artifact mismatch: '+path)
        self.used[path] = {'path': path, 'sha256': sha(raw), 'bytes': len(raw)}
        return raw
    def doc(self, path): return json.loads(self.read(path))

def fp8(byte):
    sign, exponent, mantissa = (-1 if byte & 128 else 1), (byte >> 3) & 15, byte & 7
    if exponent == 15 and mantissa == 7: return math.nan
    return sign * (mantissa * 2**-9 if exponent == 0 else (1 + mantissa / 8) * 2**(exponent - 7))

def build(reader):
    data = {'format': 'natural-gpu-diagnostic-v1', 'scope': 'full', 'cases': [], 'sources': [], 'evidence': [],
            'limits': ['Archived measurements; interactive queries do not execute a GPU.',
                       'Compiler IR intervals and source control flow are static evidence, not hardware timelines.',
                       'Timeout does not establish an exact blocked instruction; absent output is unknown.',
                       'Two public faults are development cases; no claim of unseen-fault generalization or human benefit.']}
    def source(path, ident, version, family):
        raw = reader.read(path)
        item = {'id': ident, 'path': path, 'sha256': sha(raw), 'text': raw.decode(), 'family': family, 'version': version}
        data['sources'].append(item); return ident
    def fact(ident, kind, path, **fields):
        raw = reader.read(path)
        item = {'id': ident, 'kind': kind, 'rawRefs': [{'id': path, 'sha256': sha(raw)}], **fields}
        data['evidence'].append(item); return ident
    for version in ['before', 'after', 'backport']:
        source(f'cutlass/{version}/collective.hpp', 'c-source-'+version, version, 'cutlass')
    source('cutlass/backport/guards.patch', 'c-guards', 'backport', 'cutlass')
    for suite, prefix in [('modal-cutlass', 'r'), ('modal-cutlass-backport', 'b')]:
        paths = sorted(p for p in reader.entries if p.startswith(suite+'/artifacts/matrix/') and p.endswith('/record.json'))
        for index, path in enumerate(paths):
            record = reader.doc(path); version = record['variant']; ident = f'c-{prefix}-{index:02d}'
            outputs = []
            for group in record['groups']:
                sample = {}
                for role in ['observed', 'reference', 'c']:
                    name = f"group-{group['group']}-{role}.bin"; entry = next(e for e in record['files'] if e['path'] == name)
                    raw = reader.read(str(Path(path).parent/name))
                    insist(sha(raw) == entry['sha256'] and len(raw) == entry['bytes'], 'output binding mismatch')
                    sample[role] = [fp8(v) for v in raw[:16]]
                outputs.append({**group, 'first16': sample, 'sampleScope': 'First 16 output elements; complete output counts refer to retained byte verification.'})
            evidence = fact(ident+'-observation', 'execution-observation', path,
                exitCode=record['exit_code'], timedOut=record['timed_out'], wallSeconds=record['command_wall_seconds'],
                outputsChecked=record['outputs_checked'], mismatches=record['mismatches'], groups=outputs)
            data['cases'].append({'id': ident, 'family': 'cutlass', 'version': version,
                'parameters': {k: record[k] for k in ['m', 'n', 'k', 'beta', 'host_shapes', 'tool']},
                'status': record['result'], 'sourceRefs': ['c-source-'+version], 'evidenceRefs': [evidence],
                'pairKey': 'cutlass:'+json.dumps({k: record[k] for k in ['m', 'n', 'k', 'beta', 'host_shapes', 'tool']}, sort_keys=True),
                'label': record['case'], 'gpu': 'H100', 'unknowns': ['No instruction-level wait sampling.', 'No output exists for a timed-out/failed invocation.']})
    ir = reader.doc('tmem/gpu-audit/ir-evidence-v2/summary.json')
    for version in ['before', 'after']:
        primary = source(f'tmem/upstream/{version}/lib/Dialect/TritonNvidiaGPU/Transforms/TensorMemoryAllocation.cpp',
                         't-source-'+version, version, 'tmem')
        summary_path = f'modal-tmem/artifacts/{version}/summary.json'; summary = reader.doc(summary_path)
        variant = next(v for v in ir['variants'] if v['variant'] == version)
        insist(sha(reader.read(summary_path)) == variant['summary_sha256'], 'IR/measurement summary binding changed')
        kernels = {}
        for index, kernel in enumerate(variant['kernels']):
            snapshot = kernel['source_snapshots']['before-next-pass']
            path = 'tmem/gpu-audit/ir-evidence-v2/'+snapshot['path']
            sid = source(path, f't-ir-{version}-{index:02d}', version, 'tmem')
            insist(data['sources'][-1]['sha256'] == snapshot['sha256'], 'IR source mismatch')
            eid = fact(sid+'-fact', 'compiler-ir', path, sourceId=sid, columns=kernel['tmem_columns'],
                       binding=kernel['binding']['method'])
            kernels[kernel['kernel_hash']] = (sid, eid)
        for index, run in enumerate(summary['runs']):
            path = f'modal-tmem/artifacts/{version}/'+run['artifact']['path']; packed = reader.read(path)
            insist(sha(packed) == run['artifact']['sha256'], 'case compressed digest mismatch')
            raw = gzip.decompress(packed); insist(sha(raw) == run['artifact']['uncompressed_sha256'], 'case decoded digest mismatch')
            observed = json.loads(raw); outputs = []
            for out in observed['outputs']:
                actual = out['actual']; reference = out['reference_value']
                insist(len(actual) == math.prod(out['shape']), 'output shape mismatch')
                mismatch = sum(v != reference for v in actual)
                insist(mismatch == out['mismatch_count'], 'output mismatch count differs')
                outputs.append({'name': out['name'], 'shape': out['shape'], 'referenceValue': reference,
                                'actual': actual, 'mismatches': mismatch, 'histogram': dict(Counter(map(str, actual)))})
            ident = f't-{version}-{index:02d}'; sid, irid = kernels[run['compiled_kernel_hashes'][0]]
            eid = fact(ident+'-observation', 'device-output', path, outputs=outputs,
                       outputsChecked=sum(len(x['actual']) for x in outputs), mismatches=sum(x['mismatches'] for x in outputs))
            data['cases'].append({'id': ident, 'family': 'tmem', 'version': version, 'parameters': observed['parameters'],
                'status': 'passed' if observed['numeric_correct'] else 'wrong_value', 'sourceRefs': [primary, sid],
                'evidenceRefs': [eid, irid], 'pairKey': 'tmem:'+json.dumps(observed['parameters'], sort_keys=True),
                'gpu': 'B200', 'unknowns': ['Static IR evidence does not measure a GPU write/read timestamp.']})
    data['provenance'] = {'archiveManifestSha256': sha((reader.archive/'manifest.json').read_bytes()),
                          'sourceFilesRead': len(reader.used), 'inputFiles': list(reader.used.values())}
    return data

def benchmark_projection(full):
    data = copy.deepcopy(full)
    data['scope'] = 'before-only'; data.pop('provenance')
    data['cases'] = [case for case in data['cases'] if case['version'] == 'before' and case['parameters'].get('tool', 'normal') == 'normal']
    ids = {old: f'case-{index:02d}' for index, old in enumerate(c['id'] for c in data['cases'])}
    sids = {old: f'source-{index:02d}' for index, old in enumerate(dict.fromkeys(s for c in data['cases'] for s in c['sourceRefs']))}
    eids = {old: f'fact-{index:02d}' for index, old in enumerate(dict.fromkeys(s for c in data['cases'] for s in c['evidenceRefs']))}
    rawids = {}
    for case in data['cases']:
        case['id'] = ids[case['id']]; case['version'] = 'input'; case.pop('label', None); case.pop('pairKey', None)
        case['sourceRefs'] = [sids[x] for x in case['sourceRefs']]; case['evidenceRefs'] = [eids[x] for x in case['evidenceRefs']]
    data['sources'] = [s for s in data['sources'] if s['id'] in sids]
    for source in data['sources']:
        old = source['id']; source['id'] = sids[old]; source['version'] = 'input'
        source['path'] = ('collective.hpp' if source['family'] == 'cutlass' else 'TensorMemoryAllocation.cpp') if '-source-' in old else source['id']+'.mlir'
    data['evidence'] = [e for e in data['evidence'] if e['id'] in eids]
    for evidence in data['evidence']:
        evidence['id'] = eids[evidence['id']]
        if 'sourceId' in evidence: evidence['sourceId'] = sids[evidence['sourceId']]
        for ref in evidence['rawRefs']:
            rawids.setdefault(ref['id'], f'raw-{len(rawids):03d}'); ref['id'] = rawids[ref['id']]
    data['limits'] = ['Only the supplied input implementation and observations are included.',
                      'IR is static compiler evidence, not a hardware timeline.',
                      'An absent output or timeout does not establish an exact blocked instruction.',
                      'Both evaluation conditions receive identical raw source and observations. Queries only derive or filter these facts.']
    return data, {'caseMap': ids, 'sourceMap': sids, 'evidenceMap': eids, 'rawMap': rawids}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, default=DEFAULT_ARCHIVE)
    parser.add_argument('--output', type=Path, default=ROOT/'web/research/natural-bugs/data.json')
    parser.add_argument('--benchmark', type=Path, default=Path(__file__).parent/'benchmark-before.json')
    args = parser.parse_args(); reader = Reader(args.archive); full = build(reader); benchmark, mapping = benchmark_projection(full)
    for path, data in [(args.output, full), (args.benchmark, benchmark)]:
        path.parent.mkdir(parents=True, exist_ok=True); path.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':'), allow_nan=False)+'\n')
    manifest = {'format': 'natural-diagnostic-build-v1', 'builderSha256': sha(Path(__file__).read_bytes()),
                'archiveManifestSha256': full['provenance']['archiveManifestSha256'],
                'dataSha256': sha(args.output.read_bytes()), 'benchmarkSha256': sha(args.benchmark.read_bytes()),
                'fullCases': len(full['cases']), 'benchmarkCases': len(benchmark['cases']), 'verifiedInputFiles': len(reader.used),
                'benchmarkMapping': mapping, 'inputFiles': list(reader.used.values())}
    (args.output.parent/'build-manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    print(json.dumps({key: value for key, value in manifest.items() if key not in ['benchmarkMapping', 'inputFiles']}))
if __name__ == '__main__': main()
