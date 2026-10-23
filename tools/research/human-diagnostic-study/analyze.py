#!/usr/bin/env python3
"""Validate exports, create blind scoring packets, and report a frozen descriptive analysis.

Dry-run records are rejected unless explicitly allowed; enabling them permanently labels
the result software rehearsal. No analysis file is a human outcome merely because it exists.
"""
import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
import random
import secrets
import statistics

FORMAT='gpu-human-diagnostic-study-v2'
DIMENSIONS=('mechanism','localization','evidence','counterfactual')


def read_sessions(paths, allow_dry_run=False, manifest=None):
    sessions=[];seen=set()
    for path in paths:
        item=json.loads(Path(path).read_text())
        if item.get('format')!=FORMAT:raise ValueError(f'Unknown export: {path}')
        if item.get('mode')!='formal' and not allow_dry_run:raise ValueError('Dry-run exports excluded from human analysis; use --allow-dry-run only for software validation')
        if item.get('mode')=='formal':
            if manifest is None:raise ValueError('Formal analysis requires the frozen manifest, not self-reported mode labels')
            unsigned={k:v for k,v in manifest.items() if k!='manifestSha256'}
            digest=hashlib.sha256(json.dumps(unsigned,sort_keys=True,separators=(',',':')).encode()).hexdigest()
            if digest!=manifest.get('manifestSha256') or item['manifestSha256']!=digest:raise ValueError('Frozen manifest hash mismatch')
            mains=[t for t in manifest['tasks'] if t['stage']=='main']
            if len(mains)!=6 or not manifest.get('preregistration',{}).get('frozenSha256'):raise ValueError('Manifest is not formally ready')
            for task in manifest['tasks']:
                if not task.get('materialsReviewed') or not task.get('rubricSha256') or not task.get('equalInformationAuditSha256'):raise ValueError('Unreviewed formal materials')
                if task['stage']!='practice' and (task.get('synthetic') or task.get('stage') not in ['main','practice']):raise ValueError('Development material cannot be relabeled as formal')
            slot=item['allocationSlot'];offset=(slot//2)%6;parity=slot%2
            expected=[]
            for stage in ['practice']:
                expected += [{'id':t['id'],'rootCauseId':t['rootCauseId'],'stage':stage,'condition':'practice-both' if stage=='practice' else 'raw'} for t in manifest['tasks'] if t['stage']==stage]
            expected += [{'id':mains[(offset+i)%6]['id'],'rootCauseId':mains[(offset+i)%6]['rootCauseId'],'stage':'main','condition':'diagnostic' if (i+parity)%2 else 'raw'} for i in range(4)]
            for stage in []:
                expected += [{'id':t['id'],'rootCauseId':t['rootCauseId'],'stage':stage,'condition':'raw'} for t in manifest['tasks'] if t['stage']==stage]
            if item['taskOrder']!=expected:raise ValueError('Task order differs from frozen allocation')
            by_id={t['id']:t for t in manifest['tasks']};expected_by_id={t['id']:t for t in expected}
            for response in item['responses']:
                original=by_id.get(response['taskId']);allocation=expected_by_id.get(response['taskId'])
                if not original or not allocation or any(response[k]!=allocation[k] for k in ['stage','condition','rootCauseId']) or response['timeLimitSeconds']!=original['timeLimitSeconds']:raise ValueError('Response differs from frozen task assignment')
        if item['participantId'] in seen:raise ValueError('Duplicate participant ID; resolve repeated sessions before analysis')
        seen.add(item['participantId'])
        ids=[r['taskId'] for r in item['responses']]
        if len(set(ids))!=len(ids):raise ValueError('Duplicate task response')
        if len({r['rootCauseId'] for r in item['responses']})!=len(ids):raise ValueError('Repeated root cause within participant')
        for response in item['responses']:
            if response['elapsedMs']<0 or response['elapsedMs']>response['timeLimitSeconds']*1000:raise ValueError('Invalid bounded duration')
            if not 0<=response['answer']['confidence']<=100:raise ValueError('Invalid confidence')
        sessions.append(item)
    if not sessions:raise ValueError('No session files')
    if len({s['manifestSha256'] for s in sessions})!=1:raise ValueError('Do not pool different frozen task manifests')
    return sessions


def blind(sessions, output):
    output=Path(output);output.mkdir(parents=True,exist_ok=False)
    mapping=[];packets=[]
    for session in sessions:
        for response in session['responses']:
            if response['stage']=='practice':continue
            bid=secrets.token_hex(12)
            mapping.append({'blindId':bid,'participantId':session['participantId'],'taskId':response['taskId'],'stage':response['stage'],'condition':response['condition']})
            answer=response['answer']
            # Keep the answer verbatim; no condition/time/experience/log metadata is sent to raters.
            packets.append({'blindId':bid,'taskId':response['taskId'],'answer':{k:answer[k] for k in ['diagnosis','locations','evidenceIds','repair','edits']}})
    secrets.SystemRandom().shuffle(packets)
    (output/'rater-packet.json').write_text(json.dumps({'scope':'Answers may self-reveal interface use; raters must flag suspected unblinding.','answers':packets},ensure_ascii=False,indent=2)+'\n')
    (output/'PRIVATE-unblinding-map.json').write_text(json.dumps(mapping,indent=2)+'\n')
    with (output/'rater-template.csv').open('w',newline='') as stream:
        writer=csv.DictWriter(stream,fieldnames=['blind_id','rater_id',*DIMENSIONS,'repair_validated','suspected_unblinding','justification']);writer.writeheader()
        for packet in packets:writer.writerow({'blind_id':packet['blindId'],'rater_id':'RATER-CHANGE-ME'})
    return {'responses':len(packets),'scope':'Private mapping must not be supplied to raters; export to separate access-controlled locations.'}


def mean(values):return statistics.mean(values) if values else None


def percentile(values,p):
    values=sorted(values);at=(len(values)-1)*p;lo=math.floor(at);hi=math.ceil(at)
    return values[lo]+(values[hi]-values[lo])*(at-lo)


def interval(values,seed=7319,repetitions=10000):
    if len(values)<2:return None
    rng=random.Random(seed)
    samples=[statistics.mean(rng.choices(values,k=len(values))) for _ in range(repetitions)]
    return [percentile(samples,.025),percentile(samples,.975)]


def resolve_scores(mapping, score_paths, adjudication=None):
    entries={};reviews=[]
    for score_path in score_paths:
        with Path(score_path).open(newline='') as stream:
            for row in csv.DictReader(stream):
                key=row['blind_id'];scores=tuple(int(row[d]) for d in DIMENSIONS)
                if any(x not in [0,1,2] for x in scores):raise ValueError('Scores must be 0, 1, 2')
                if not row.get('rater_id') or row['rater_id']=='RATER-CHANGE-ME':raise ValueError('Independent rater ID required')
                if any(prior['rater_id']==row['rater_id'] for prior in entries.get(key,[])):raise ValueError('Duplicate rater/answer')
                entries.setdefault(key,[]).append({**row,'scores':scores})
    final={}
    if adjudication:
        with Path(adjudication).open(newline='') as stream:
            for row in csv.DictReader(stream):
                values=tuple(int(row[d]) for d in DIMENSIONS)
                if any(x not in [0,1,2] for x in values) or not row.get('justification'):raise ValueError('Adjudication requires bounded scores and justification')
                if row['blind_id'] in final:raise ValueError('Duplicate adjudication')
                final[row['blind_id']]=values
    resolved={};agreement=[]
    for item in mapping:
        rows=entries.get(item['blindId'],[])
        if len(rows)!=2:raise ValueError('Exactly two independent ratings required per nonpractice answer')
        equal=rows[0]['scores']==rows[1]['scores'];agreement.append(equal)
        if not equal and item['blindId'] not in final:raise ValueError('Unresolved scoring disagreement; obtain independent adjudication before unblinding')
        values=rows[0]['scores'] if equal else final[item['blindId']]
        resolved[(item['participantId'],item['taskId'])]={'score':sum(values),'dimensions':dict(zip(DIMENSIONS,values))}
        reviews.append({'blindId':item['blindId'],'exactAgreement':equal,'absoluteScoreDifference':abs(sum(rows[0]['scores'])-sum(rows[1]['scores'])),'suspectedUnblinding':any(r.get('suspected_unblinding','').lower() in ['true','1','yes'] for r in rows)})
    return resolved,{'answers':len(agreement),'exactAgreementFraction':mean(agreement),'meanAbsoluteScoreDifference':mean([r['absoluteScoreDifference'] for r in reviews]),'reviews':reviews}


def analyze(sessions, scores, agreement):
    rehearsal=any(s['mode']!='formal' for s in sessions);rows=[];deltas=[];duration_deltas=[];pair_details=[]
    for session in sessions:
        for response in session['responses']:
            if response['stage']=='practice':continue
            scored=scores.get((session['participantId'],response['taskId']))
            if not scored:raise ValueError('Unscored answer')
            rows.append({'participantId':session['participantId'],'taskId':response['taskId'],'stage':response['stage'],'condition':response['condition'],'score':scored['score'],'reason':response['reason'],'elapsedSeconds':response['elapsedMs']/1000,'timeLimitSeconds':response['timeLimitSeconds'],'priorFamiliarity':response['answer']['priorFamiliarity'],'confidence':response['answer']['confidence'],'manipulationCheck':response['answer']['evidenceBasis']=='inferred'})
        own=[r for r in rows if r['participantId']==session['participantId'] and r['stage']=='main']
        expected=[t for t in session['taskOrder'] if t['stage']=='main']
        complete=len(own)==len(expected) and {r['condition'] for r in own}=={'raw','diagnostic'}
        if complete:
            raw=[r for r in own if r['condition']=='raw'];diagnostic=[r for r in own if r['condition']=='diagnostic']
            delta=mean([r['score'] for r in diagnostic])-mean([r['score'] for r in raw]);deltas.append(delta)
            # Failure-aware restricted completion time: a diagnosis below 6/8 or timeout is capped.
            rt=lambda r:r['elapsedSeconds'] if r['score']>=6 and r['reason']=='submitted' else r['timeLimitSeconds']
            dt=mean([rt(r) for r in diagnostic])-mean([rt(r) for r in raw]);duration_deltas.append(dt)
            pair_details.append({'participantId':session['participantId'],'scoreDifference':delta,'restrictedTimeDifferenceSeconds':dt})
    formal_rows=[r for r in rows if r['stage']=='main'];conditions={}
    for condition in ['raw','diagnostic']:
        subset=[r for r in formal_rows if r['condition']==condition];conditions[condition]={'responses':len(subset),'meanScore':mean([r['score'] for r in subset]),'timeouts':sum(r['reason']=='timeout' for r in subset),'withdrawals':sum(r['reason']=='withdrawn' for r in subset),'priorFamiliarity':sum(r['priorFamiliarity'] for r in subset),'manipulationPasses':sum(r['manipulationCheck'] for r in subset)}
    return {'format':'gpu-human-study-analysis-v1','scope':'SOFTWARE DRY-RUN — NOT HUMAN EVIDENCE' if rehearsal else 'Participant evidence conditional on this frozen task pool; no population-of-bugs generalization.',
      'participants':len(sessions),'completeMainPairs':len(deltas),'excludedFromPairedEstimate':len(sessions)-len(deltas),'statusCounts':{status:sum(s['status']==status for s in sessions) for status in ['completed','withdrawn','running']},
      'primary':{'metric':'Within-participant mean evidence-backed diagnosis score difference (diagnostic minus raw), 0–8 rubric','estimate':mean(deltas),'participantBootstrap95Interval':interval(deltas),'bootstrapReplicates':10000,'seed':7319,'unit':'participants, not tasks, traces, or clicks'},
      'secondary':{'restrictedTimeDifferenceSeconds':mean(duration_deltas),'participantBootstrap95Interval':interval(duration_deltas),'successDefinition':'score >=6/8 AND submitted before timeout; this is a diagnosis threshold, not compiled repair success'},
      'conditions':conditions,'interRater':agreement,'participantDifferences':pair_details,'rows':rows,
      'limitations':['No p-value selection or data-dependent stopping. Bootstrap precision is conditional on a fixed task set.','Missing condition pairs are retained in flow counts; complete-pair estimate may be selected by attrition. Report attrition bounds and missingness before claims.','This is immediate explanation/localization in a fixed six-root pool, with no pre/post/transfer learning claim.','Textual repair plans never count as GPU-validated repairs. Join execution receipts separately.']}


def precision():
    return {'scope':'Planning assumptions only, not observed precision or power. N is independent participants with complete paired scores.',
       'assumedPairedScoreSD':2.0,'table':[{'participants':n,'approximate95HalfWidthAtSD2':1.96*2/math.sqrt(n),'conservativeHalfWidthAtSD8':1.96*8/math.sqrt(n),'standardizedHalfWidth':1.96/math.sqrt(n)} for n in [24,32,48,64,96]],
       'limitations':['Normal approximation ignores finite-sample t correction and attrition.','Paired difference is in [-8,8], so SD <=8 is a conservative bound; SD=2 is unverified.','No effect-size assumption or statement that any N guarantees significance.','Task-root diversity requires its own evidence; increasing participant N does not create independent root causes.']}


def main():
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='command',required=True)
    pprec=sub.add_parser('precision');pprec.add_argument('--output',type=Path)
    for name in ['blind','analyze']:
        q=sub.add_parser(name);q.add_argument('sessions',nargs='+',type=Path);q.add_argument('--allow-dry-run',action='store_true');q.add_argument('--manifest',type=Path);q.add_argument('--output',required=True,type=Path)
        if name=='analyze':q.add_argument('--mapping',required=True,type=Path);q.add_argument('--scores',nargs=2,required=True,type=Path);q.add_argument('--adjudication',type=Path)
    a=p.parse_args()
    if a.command=='precision':result=precision()
    else:
        sessions=read_sessions(a.sessions,a.allow_dry_run,json.loads(a.manifest.read_text()) if a.manifest else None)
        if a.command=='blind':result=blind(sessions,a.output)
        else:
            mapping=json.loads(a.mapping.read_text());scores,agreement=resolve_scores(mapping,a.scores,a.adjudication);result=analyze(sessions,scores,agreement)
    if a.command!='blind' and a.output:a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':main()
