#!/usr/bin/env python3
"""Independent local CPU audit of all v2 retained outputs. No model/GPU calls."""
import hashlib
import importlib.util
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
STUDY = ROOT / 'out/research/repair-v2-study'
OUT = ROOT / 'out/research/repair-v2-audit'

def read(p): return json.loads(Path(p).read_text())
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def text_sha(s): return hashlib.sha256(s.encode()).hexdigest()
def stamp(s): return datetime.fromisoformat(s.replace('Z', '+00:00'))
def load(name, p):
    spec = importlib.util.spec_from_file_location(name, p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m

def audit():
    frozen = ROOT / 'out/research/repair-v2-runtime-frozen'
    mf = read(frozen / 'manifest.json')
    for f in mf['files']:
        assert sha(ROOT / f['path']) == f['sha256']
        assert sha(frozen / 'source' / f['path']) == f['sha256']
    tool = ROOT / 'out/research/repair-v2-tools-frozen'
    tm = read(tool / 'manifest.json')
    for p, h in tm['sources'].items():
        assert sha(ROOT / p) == h == sha(tool / 'source' / p)
    # Import CPU oracle functions only; neither runner's GPU entry point is called.
    triton_verify = load('audit_triton_verify', ROOT / 'tools/research/natural-fault-expansion/verify.py')
    sys.modules['run'] = load('audit_liger_reference', ROOT / 'tools/research/liger-faults/run.py')
    liger_verify = load('audit_liger_verify', ROOT / 'tools/research/liger-faults/verify.py')
    catalog = {t['id']: t for t in read(STUDY / 'frozen/catalog-before.json')['tasks']}
    specs = {t['id']: t for t in read(STUDY / 'frozen/private-plan.json')['tasks']}
    schedule = read(STUDY / 'frozen/schedule.json')
    analysis = read(STUDY / 'analysis.json')
    analyzed = {r['id']: r for r in analysis['rows']}
    generations = {t['id']: read(STUDY / 'trials' / t['id'] / 'result.json') for t in schedule}
    finish = max(stamp(g['finishedAt']) for g in generations.values())
    assert finish == stamp(analysis['allGenerationFinishedAt'])
    native = read(ROOT / 'out/research/natural-fault-expansion/manifest.json')['native_compiler_sha256']
    rows = []
    for scheduled in schedule:
        tid = scheduled['id']; g = generations[tid]; a = analyzed[tid]
        task = catalog[scheduled['taskId']]; spec = specs[task['id']]
        liger = task['id'].startswith('liger-')
        base = ROOT / 'out/research' / ('liger-faults' if liger else 'natural-fault-expansion')
        directory = base / 'candidate-evaluations' / tid
        if not g['patchApplicable']:
            assert g['failure'] == 'external-runner-interruption' and g['interruption']['modelResampled'] is False
            assert not (directory / 'runtime-record.json').exists()
            assert not (STUDY / 'trials' / tid / 'candidate.json').exists()
            assert not a['endpoint']['success'] and not a['allCasesSuccess']
            rows.append({'id': tid, 'taskId': task['id'], 'condition': g['condition'], 'status': 'infrastructure-incomplete', 'hiddenSuccess': False, 'allCaseSuccess': False, 'verifiedCases': 0})
            continue
        cp = STUDY / 'trials' / tid / 'candidate.json'
        candidate = read(cp); record = read(directory / 'runtime-record.json')
        assert sha(cp) == sha(directory / 'candidate.json') == record['candidate_json_sha256']
        assert candidate['candidateTreeSHA256'] == g['candidateTreeSHA256'] == record['candidateTreeSHA256'] == a['candidateTreeSHA256']
        assert record['hiddenSpecSHA256'] == spec['hiddenSpecSHA256'] == sha(base / 'plan.json')
        assert record['evaluator_sha256'] == sha(ROOT / 'tools/research' / base.name / 'evaluate_candidate.py')
        before = {f['id']: f for f in task['files']}
        assert set(before) == {f['id'] for f in candidate['files']}
        applied = {}
        for f in candidate['files']:
            old = before[f['id']]
            assert f['path'] == old['path'] and f['role'] == old['role']
            assert f['beforeSHA256'] == old['sha256']
            assert f['sha256'] == text_sha(f['text'])
            assert f['changed'] == (f['sha256'] != f['beforeSHA256'])
            if f['role'] == 'implementation':
                location = directory / ('source' if liger else 'runtime') / f['path']
                assert sha(location) == f['sha256']
                applied[f['path']] = f['sha256']
        assert applied == record['applied_sources']
        summary = read(directory / 'run/summary.json')
        start = stamp(summary['started_at'] if liger else summary['started_utc'])
        assert start >= finish
        assert summary['native_compiler_sha256'] == native
        assert summary['runner_sha256' if liger else 'harness_sha256'] == sha(ROOT / 'tools/research' / base.name / 'run.py')
        if liger:
            for f in summary['imported_source_files']:
                assert sha(directory / 'source' / f['path']) == f['sha256']
            receipt = liger_verify.verify(directory / 'run', base / 'plan.json', record['family'], input_manifest_path=base / 'input-manifest.json')
            before_records = {c['id']: c for c in read(base / 'controls-v2' / record['family'] / 'before/summary.json')['records']}
            assert all(c['input_array_identities'] == before_records[c['id']]['input_array_identities'] and c.get('input_strides') == before_records[c['id']].get('input_strides') for c in summary['records'])
            receipt.update(candidateTreeSHA256=candidate['candidateTreeSHA256'], native_compiler_sha256=native, input_identity_matched_to_before_control=True)
        else:
            sources = {p: applied['triton/' + p] for p in summary['source_sha256']}
            receipt = triton_verify.verify(directory / 'run', base / 'plan.json', sources, native, record['family'])
        stored_receipt = read(directory / 'independent-verification.json')
        assert receipt == stored_receipt, (tid, {k: (str(receipt.get(k))[:160], str(stored_receipt.get(k))[:160]) for k in receipt.keys() | stored_receipt.keys() if receipt.get(k) != stored_receipt.get(k)})
        assert sha(directory / 'independent-verification.json') == record['verifierReceiptSHA256'] == a['validationReceiptSHA256']
        canonical = {c['id']: ('passed' if c['passed'] else 'failed') if 'passed' in c else c['status'] for c in receipt['cases']}
        hidden = set(spec['hiddenCaseIds']); visible = {c['id'] for c in task['cases']}
        assert not (hidden & visible) and set(canonical) == hidden | visible
        assert {c['id']: c['status'] for c in record['cases']} == {k: v for k, v in canonical.items() if k in hidden}
        assert {c['id']: c['status'] for c in record['visibleCases']} == {k: v for k, v in canonical.items() if k in visible}
        hidden_ok = record['buildStatus'] == 'passed' and all(canonical[k] == 'passed' for k in hidden)
        all_ok = hidden_ok and all(v == 'passed' for v in canonical.values())
        assert hidden_ok == a['endpoint']['success'] and all_ok == a['allCasesSuccess']
        assert len(canonical) == a['allCasesExpected'] == a['allCasesVerified']
        rows.append({'id': tid, 'taskId': task['id'], 'condition': g['condition'], 'status': 'verified', 'hiddenSuccess': hidden_ok, 'allCaseSuccess': all_ok, 'verifiedCases': len(canonical), 'hiddenCases': len(hidden), 'visibleCases': len(visible), 'outputs': receipt.get('outputs', receipt.get('total_elements')), 'candidateSHA256': sha(cp), 'receiptSHA256': record['verifierReceiptSHA256'], 'runtimeStartedAt': start.isoformat()})
    groups = []
    for condition in ['raw', 'diagnostic']:
        rs = [r for r in rows if r['condition'] == condition]
        group = {'condition': condition, 'fixedDenominator': len(rs), 'validCandidates': sum(r['status'] == 'verified' for r in rs), 'hiddenSuccess': sum(r['hiddenSuccess'] for r in rs), 'allCaseSuccess': sum(r['allCaseSuccess'] for r in rs), 'infrastructureIncomplete': sum(r['status'] == 'infrastructure-incomplete' for r in rs)}
        ag = next(g for g in analysis['groups'] if g['condition'] == condition)
        assert group['fixedDenominator'] == ag['planned'] and group['hiddenSuccess'] == ag['hiddenRepairSuccess'] and group['allCaseSuccess'] == ag['allCaseRepairSuccess']
        groups.append(group)
    root_effects = []
    for tid in catalog:
        counts = {c: sum(r['hiddenSuccess'] for r in rows if r['taskId'] == tid and r['condition'] == c) for c in ['raw', 'diagnostic']}
        root_effects.append({'taskId': tid, **counts, 'conditionDenominator': 3, 'diagnosticMinusRaw': (counts['diagnostic'] - counts['raw']) / 3})
    partial = ROOT / 'out/research/natural-fault-expansion/interrupted-attempts/triton-softmax-axis.raw.r2.attempt-1'
    pm = read(partial / 'partial-tree-manifest.json'); event = read(partial / 'external-interruption.json')
    for f in pm['files']:
        assert sha(partial / f['path']) == f['sha256'] and (partial / f['path']).stat().st_size == f['bytes']
    tid = event['trial']; original = STUDY / 'trials' / tid / 'candidate.json'
    assert sha(partial / 'candidate.json') == sha(original) == event['candidate_json_sha256']
    candidate = read(original)
    assert event['candidateTreeSHA256'] == candidate['candidateTreeSHA256']
    assert sha(partial / 'runtime/triton/_C/libtriton.so') == native
    # The interrupted overlay may be only partly populated: validate supplied
    # implementation bytes that exist without claiming it reached GPU execution.
    overlay_files = 0
    for f in candidate['files']:
        p = partial / 'runtime' / f['path']
        if f['role'] == 'implementation' and p.exists():
            assert sha(p) == f['sha256']; overlay_files += 1
    assert not (partial / 'run/summary.json').exists() and not (partial / 'runtime-record.json').exists()
    assert pm['completed_device_cases_with_verified_arrays'] == 0
    return {'format': 'repair-v2-independent-final-runtime-audit-v1', 'status': 'verified', 'reviewedAt': datetime.now(timezone.utc).isoformat(), 'modelCalls': 0, 'gpuCalls': 0, 'frozenToolFiles': len(tm['sources']), 'frozenRuntimeFiles': len(mf['files']), 'reportingSourceSHA256': sha(ROOT / 'tools/research/repair-study-v2/analyze.mjs'), 'analysisSHA256': sha(STUDY / 'analysis.json'), 'plannedTrials': len(rows), 'completeRuntimeTrials': sum(r['status'] == 'verified' for r in rows), 'allGenerationFinishedAt': finish.isoformat(), 'groups': groups, 'rootEffects': root_effects, 'completeCasesRecomputed': sum(r['verifiedCases'] for r in rows), 'completeOutputElementsRecomputed': sum(r.get('outputs', 0) for r in rows), 'gpuInterruption': {'trialId': tid, 'preservedManifestFiles': len(pm['files']), 'preservedOverlayImplementationFiles': overlay_files, 'candidateBytesUnchanged': True, 'nativeCompilerUnchanged': True, 'verifiedCompletedCases': 0, 'unrecordedCost': 'unknown; excluded from retained validation wall sums', 'sameCandidateRetry': True, 'cause': 'reported external exit 143, underlying cause not independently established'}, 'rows': rows, 'scope': 'CPU recomputation of retained complete actual arrays and provenance checking; no fresh execution. Zero per-root success difference is a descriptive null result, not equivalence or improved human understanding.'}

if __name__ == '__main__':
    result = audit()
    (OUT / 'final-runtime-audit.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({k:v for k,v in result.items() if k != 'rows'}, indent=2))
