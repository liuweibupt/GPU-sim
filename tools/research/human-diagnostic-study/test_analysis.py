import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('analysis',Path(__file__).with_name('analyze.py'));analysis=importlib.util.module_from_spec(spec);spec.loader.exec_module(analysis)

def session():
    return {'format':analysis.FORMAT,'mode':'dry-run','participantId':'SIM-1','manifestSha256':'f','status':'completed','taskOrder':[{'id':'a','stage':'main'},{'id':'b','stage':'main'}],'responses':[{'taskId':name,'rootCauseId':name,'stage':'main','condition':condition,'elapsedMs':1000,'timeLimitSeconds':60,'reason':'submitted','answer':{'confidence':50,'priorFamiliarity':False,'evidenceBasis':'inferred','diagnosis':'test','locations':'','evidenceIds':[],'repair':'','edits':[]}} for name,condition in [('a','raw'),('b','diagnostic')]]}

class AnalysisTests(unittest.TestCase):
    def test_dry_run_never_silently_becomes_human_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'x.json';path.write_text(json.dumps(session()))
            with self.assertRaisesRegex(ValueError,'Dry-run'):analysis.read_sessions([path])
            self.assertEqual(len(analysis.read_sessions([path],True)),1)
    def test_duplicate_participant_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'x.json';path.write_text(json.dumps(session()))
            with self.assertRaisesRegex(ValueError,'Duplicate participant'):analysis.read_sessions([path,path],True)
    def test_blind_packet_strips_condition_identity_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)/'blind';analysis.blind([session()],folder);raw=(folder/'rater-packet.json').read_text();packet=json.loads(raw)
            for answer in packet['answers']:
                self.assertEqual(set(answer),{'blindId','taskId','answer'})
            self.assertNotIn('SIM-1',raw);self.assertNotIn('elapsedMs',raw)
    def test_failure_aware_duration_and_score_difference(self):
        s=session();scores={('SIM-1','a'):{'score':8},('SIM-1','b'):{'score':2}}
        result=analysis.analyze([s],scores,{})
        self.assertEqual(result['primary']['estimate'],-6);self.assertEqual(result['secondary']['restrictedTimeDifferenceSeconds'],59)
        self.assertIsNone(result['primary']['participantBootstrap95Interval']);self.assertIn('NOT HUMAN EVIDENCE',result['scope'])
    def test_scoring_requires_two_raters_and_adjudication(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths=[]
            for i,score in enumerate([1,2]):
                path=Path(tmp)/f'{i}.csv';path.write_text(f'blind_id,rater_id,mechanism,localization,evidence,counterfactual\nb,R{i},{score},1,1,1\n');paths.append(path)
            mapping=[{'blindId':'b','participantId':'p','taskId':'a'}]
            with self.assertRaisesRegex(ValueError,'disagreement'):analysis.resolve_scores(mapping,paths)

if __name__=='__main__':unittest.main()
