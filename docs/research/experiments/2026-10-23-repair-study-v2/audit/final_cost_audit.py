#!/usr/bin/env python3
"""Recompute retained costs and tool uptake from raw saved calls; no new calls."""
import hashlib
from collections import Counter
import json
import math
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
STUDY = ROOT / 'out/research/repair-v2-study'
def read(p): return json.loads(p.read_text())
def near(a, b): return math.isclose(a, b, abs_tol=1e-7)
def desc(a): return {'n': len(a), 'total': sum(a), 'mean': statistics.mean(a), 'median': statistics.median(a), 'min': min(a), 'max': max(a)}

analysis = read(STUDY / 'analysis.json')
rows = []; call_count = 0; query_count = 0
for t in read(STUDY / 'frozen/schedule.json'):
    directory = STUDY / 'trials' / t['id']; g = read(directory / 'result.json')
    token = {}; missing = 0
    for c in g['calls']:
        raw = [json.loads(s) for s in (directory / f"round-{c['round']}.jsonl").read_text().splitlines()]
        usages = [e.get('usage') for e in raw if e.get('type') == 'turn.completed']
        assert usages == c['usage']
        assert c == read(directory / f"round-{c['round']}.json")
        complete = bool(usages) and all(isinstance(u, dict) and isinstance(u.get('input_tokens'), (int, float)) and isinstance(u.get('output_tokens'), (int, float)) for u in usages)
        missing += not complete
        for u in usages:
            if u:
                for k, v in u.items(): token[k] = token.get(k, 0) + v
        call_count += 1
    assert token == g['usage']
    assert near(sum(c['wallSeconds'] for c in g['calls']), g['modelWallSeconds'])
    for q in g['queries']:
        assert q == read(directory / f"query-{q['round']}.json")
        query_count += 1
    derived = [q for q in g['queries'] if q['request']['op'] == 'derived']
    effective = [q for q in derived if q['accepted'] and not q['rejected'] and not q['response'].get('error')]
    ar = next(r for r in analysis['rows'] if r['id'] == t['id'])
    assert len(derived) == ar['derivedRequests'] and len(effective) == ar['successfulDerivedRequests']
    assert len(g['calls']) == ar['calls'] and missing == ar['callsWithoutUsage']
    rows.append({'id': t['id'], 'condition': g['condition'], 'interrupted': bool(g.get('interruption')), 'calls': len(g['calls']), 'missing': missing, 'token': token, 'queries': len(g['queries']), 'modelWallSeconds': g['modelWallSeconds'], 'wallSeconds': g['wallSeconds'], 'derivedRequests': len(derived), 'acceptedDerivedRequests': sum(q['accepted'] for q in derived), 'successfulDerivedRequests': len(effective), 'operations': [q['request']['derived_op'] for q in effective]})
groups = []
for condition in ['raw', 'diagnostic']:
    rs = [r for r in rows if r['condition'] == condition]; done = [r for r in rs if not r['interrupted']]
    ag = next(g for g in analysis['groups'] if g['condition'] == condition)
    maps = {'modelCalls': 'calls', 'modelWallSeconds': 'modelWallSeconds', 'trialWallSeconds': 'wallSeconds', 'queries': 'queries'}
    for report_key, key in maps.items():
        for metric, value in desc([r[key] for r in rs]).items(): assert near(value, ag[report_key][metric])
    for report_key, key in [('inputTokens','input_tokens'), ('cachedInputTokens','cached_input_tokens'), ('outputTokens','output_tokens')]:
        for metric, value in desc([r['token'][key] for r in rs]).items(): assert near(value, ag[report_key][metric])
    for report_key, key in [('completedTrialModelWallSeconds','modelWallSeconds'), ('completedTrialWallSeconds','wallSeconds')]:
        for metric, value in desc([r[key] for r in done]).items(): assert near(value, ag[report_key][metric])
    groups.append({'condition': condition, 'plannedTrials': len(rs), 'completedTrials': len(done), 'retainedCalls': sum(r['calls'] for r in rs), 'callsWithMissingReturnedUsage': sum(r['missing'] for r in rs), 'retainedInputTokens': sum(r['token']['input_tokens'] for r in rs), 'retainedCachedInputTokens': sum(r['token']['cached_input_tokens'] for r in rs), 'retainedOutputTokens': sum(r['token']['output_tokens'] for r in rs), 'retainedQueries': sum(r['queries'] for r in rs), 'derivedRequests': sum(r['derivedRequests'] for r in rs), 'acceptedDerivedRequests': sum(r['acceptedDerivedRequests'] for r in rs), 'successfulDerivedRequests': sum(r['successfulDerivedRequests'] for r in rs), 'effectiveToolUptakeTrials': sum(r['successfulDerivedRequests'] > 0 for r in rs), 'effectiveDerivedOperations': dict(Counter(op for r in rs for op in r['operations'])), 'completedTrialModelWallSeconds': desc([r['modelWallSeconds'] for r in done]), 'completedTrialWallSeconds': desc([r['wallSeconds'] for r in done]), 'completedTrialsWithoutDerivedUse': [r['id'] for r in done if not r['derivedRequests']], 'possiblyUnrecordedCalls': any(r['interrupted'] for r in rs)})
result = {'format': 'repair-v2-independent-final-cost-audit-v1', 'status': 'verified', 'modelCalls': 0, 'gpuCalls': 0, 'analysisSHA256': hashlib.sha256((STUDY/'analysis.json').read_bytes()).hexdigest(), 'auditedRawJSONLCalls': call_count, 'auditedSavedQueryRecords': query_count, 'groups': groups, 'limits': ['Saved calls/tokens/model wall sums are retained lower bounds due to two potentially unsaved in-flight calls despite complete usage on all saved calls.', 'Cached input tokens are included in input tokens; no invoice cost is inferred.', 'Administrative interruption observation is excluded from completed-trial latency summaries.', 'GPU timing requires separate runtime provenance audit and excludes an incomplete attempt.', 'Usage uptake does not establish efficacy; raw/diagnostic means and medians must both be reported.']}
(ROOT / 'out/research/repair-v2-audit/final-cost-audit.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
