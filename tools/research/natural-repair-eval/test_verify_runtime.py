import gzip,hashlib,importlib.util,json,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('runtime',Path(__file__).with_name('verify_runtime.py'));M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)
class RuntimeVerifier(unittest.TestCase):
 def make(self,root,alter=None):
  case={'partition':'hidden','module':'x.py','constants':[11,13,17],'parameters':{'choice':0,'mode':'select','columns':0,'early':False,'outer_choice':1}}
  plan=root/'plan.json';plan.write_text(json.dumps({'tmem':[case]}));r={'id':'case-00',**case,'call_passed':True,'passed':True,'outputs':[{'name':'selected','actual':[13]*4096,'expected':13,'mismatches':0}]}
  if alter:alter(r)
  raw=json.dumps(r).encode();p=root/'case-00.json.gz';p.write_bytes(gzip.compress(raw))
  row={'id':'case-00','passed':True,'elements':4096,'mismatches':0,'artifact':{'path':p.name,'sha256':M.sha(p),'original_sha256':hashlib.sha256(raw).hexdigest()}}
  summary={'plan_sha256':M.sha(plan),'native_sha256':'0'*64,'records':[row]};(root/'summary.json').write_text(json.dumps(summary));return plan
 def test_good_full_output(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);plan=self.make(root);self.assertTrue(M.verify_tmem(root,plan)['all_passed'])
 def test_forged_pass_is_recomputed(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);plan=self.make(root,lambda r:r['outputs'][0]['actual'].__setitem__(12,17))
   with self.assertRaises(ValueError):M.verify_tmem(root,plan)
 def test_truncated_output_rejected(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);plan=self.make(root,lambda r:r['outputs'][0]['actual'].pop())
   with self.assertRaises(ValueError):M.verify_tmem(root,plan)
 def test_missing_cases_are_failure(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);plan=self.make(root);s=json.loads((root/'summary.json').read_text());s['records']=[];(root/'summary.json').write_text(json.dumps(s));r=M.verify_tmem(root,plan);self.assertFalse(r['all_passed']);self.assertEqual(r['expected_cases'],1);self.assertEqual(r['passed_cases'],0)
 def test_changed_expected_value_rejected(self):
  with tempfile.TemporaryDirectory() as t:
   root=Path(t);plan=self.make(root,lambda r:r['outputs'][0].update(expected=17))
   with self.assertRaises(ValueError):M.verify_tmem(root,plan)
if __name__=='__main__':unittest.main()
