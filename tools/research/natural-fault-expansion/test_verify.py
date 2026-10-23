import copy,hashlib,importlib.util,json,pathlib,shutil,struct,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('natural_fault_verify',pathlib.Path(__file__).with_name('verify.py'));v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v)
class VerifierTests(unittest.TestCase):
 def test_signed_zero_is_bitwise(self):
  c={'family':'negative-zero','dtype':'float32','value':-0.0,'n':2};self.assertEqual(v.oracle(c,struct.pack('<ff',-0.0,-0.0))[0],0);self.assertEqual(v.oracle(c,struct.pack('<ff',0.0,0.0))[0],2)
 def test_softmax_independent_oracle(self):
  c={'family':'softmax-axis','shape':[2,2],'dim':1,'pattern':'constant'};self.assertEqual(v.oracle(c,struct.pack('<ffff',.5,.5,.5,.5))[0],0);self.assertEqual(v.oracle(c,struct.pack('<ffff',1,1,1,1))[0],4)
 def test_filter_multiple_conditions(self):
  c={'family':'constexpr-filter','values':[-2,-1,0,1,2],'cutoff':0,'even':True};self.assertEqual(v.oracle(c,struct.pack('<iiiiii',2,0,2,-777,-777,-777))[0],0)
 def test_truncated_output_rejected(self):
  c={'family':'negative-zero','dtype':'float32','value':-0.0,'n':2}
  with self.assertRaises(AssertionError):v.oracle(c,b'\0'*4)
 def test_whole_family_missing_is_rejected(self):
  base=ROOT/'out/research/natural-fault-expansion';src=base/'run-gold-v2'
  with tempfile.TemporaryDirectory()as td:
   out=pathlib.Path(td)/'run';shutil.copytree(src,out);p=out/'summary.json';d=json.loads(p.read_text());d['cases']=[c for c in d['cases']if c['family']!='softmax-axis'];p.write_text(json.dumps(d))
   with self.assertRaisesRegex(AssertionError,'missing planned cases'):v.verify(out,base/'plan.json')
 def test_tampered_bytes_with_rehashed_record_rejected(self):
  base=ROOT/'out/research/natural-fault-expansion';src=base/'run-gold-v2'
  with tempfile.TemporaryDirectory()as td:
   out=pathlib.Path(td)/'run';shutil.copytree(src,out);p=out/'negative-zero-00/result.json';d=json.loads(p.read_text());d['observed_bytes']=[0]*len(d['observed_bytes']);p.write_text(json.dumps(d));sp=out/'summary.json';s=json.loads(sp.read_text());next(c for c in s['cases']if c['id']=='negative-zero-00')['result_sha256']=v.sha(p);sp.write_text(json.dumps(s))
   with self.assertRaisesRegex(AssertionError,'runner wrong count differs'):v.verify(out,base/'plan.json')
if __name__=='__main__':unittest.main()
