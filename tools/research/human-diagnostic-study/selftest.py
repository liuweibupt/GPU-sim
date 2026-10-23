#!/usr/bin/env python3
"""Exercise export→blind packet→two simulated raters→analysis using software sessions only."""
import argparse
import csv
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('study_analysis',HERE/'analyze.py');analysis=importlib.util.module_from_spec(spec);spec.loader.exec_module(analysis)

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('sessions',type=Path);p.add_argument('--output',required=True,type=Path);a=p.parse_args()
    paths=sorted(a.sessions.glob('SOFTWARE-*.json'));sessions=analysis.read_sessions(paths,allow_dry_run=True)
    assert len(sessions)==14 and all(s['mode']=='dry-run' and s['participantId'].startswith('SOFTWARE-') for s in sessions)
    try:analysis.read_sessions(paths)
    except ValueError:rejects_dry_run=True
    else:raise AssertionError('Dry-run unexpectedly accepted as human')
    formal=json.loads(paths[0].read_text());formal['mode']='formal'
    with tempfile.TemporaryDirectory(prefix='study-analysis-selftest-') as directory:
        tmp=Path(directory);fake=tmp/'fake.json';fake.write_text(json.dumps(formal))
        try:analysis.read_sessions([fake])
        except ValueError:rejects_relabel=True
        else:raise AssertionError('Relabeling unexpectedly accepted')
        blind=tmp/'blind';receipt=analysis.blind(sessions,blind);mapping=json.loads((blind/'PRIVATE-unblinding-map.json').read_text())
        scores=[]
        for rater in ['SOFTWARE-RATER-A','SOFTWARE-RATER-B']:
            score=tmp/(rater+'.csv');scores.append(score)
            with score.open('w',newline='') as stream:
                writer=csv.DictWriter(stream,fieldnames=['blind_id','rater_id',*analysis.DIMENSIONS,'suspected_unblinding','justification']);writer.writeheader()
                for row in mapping:writer.writerow({'blind_id':row['blindId'],'rater_id':rater,**{key:0 for key in analysis.DIMENSIONS},'suspected_unblinding':'false','justification':'SOFTWARE ZERO-SCORE FIXTURE; NOT A HUMAN RATING'})
        scored,agreement=analysis.resolve_scores(mapping,scores);result=analysis.analyze(sessions,scored,agreement)
        assert result['participants']==14 and result['completeMainPairs']==12 and result['excludedFromPairedEstimate']==2
        assert 'NOT HUMAN EVIDENCE' in result['scope'] and result['primary']['estimate']==0
        packet=json.loads((blind/'rater-packet.json').read_text())
        assert all(set(item)=={'blindId','taskId','answer'} for item in packet['answers'])
        output={'status':'passed','scope':'Software fixtures only: zero real participants and zero real rater judgments.','softwareSessions':14,'completeSoftwareSessions':12,'nonpracticeAnswersBlinded':receipt['responses'],'simulatedRaters':2,'rejectsDryRunByDefault':rejects_dry_run,'rejectsModeRelabelWithoutManifest':rejects_relabel,'keepsWithdrawalsAndMissingPairs':True,'blindMetadataRemoved':True,'analysisFunctionSha256':hashlib.sha256((HERE/'analyze.py').read_bytes()).hexdigest(),'sessionHashes':{path.name:hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}}
        a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(output,indent=2)+'\n');print(json.dumps(output))

if __name__=='__main__':main()
