import importlib.util,struct,unittest
from pathlib import Path
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('evaluate',HERE/'evaluate.py');E=importlib.util.module_from_spec(spec);spec.loader.exec_module(E)
class HiddenHarnessTests(unittest.TestCase):
 def test_contract_cases_and_determinism(self):
  a,relations=E.F.make_cases();self.assertEqual((a,relations),E.F.make_cases());self.assertEqual({t:sum(c['task']==t for c in a) for t in E.F.CONTRACTS},{'rmsnorm':11,'transpose':10,'segments':10});self.assertEqual(len(relations),4)
  for case in a:self.assertEqual(len(E.F.case_binary(case)),48+4*(len(case['input'])+len(case['offsets'])))
 def test_full_output_guard_input_and_offset_grading(self):
  for case in E.F.make_cases()[0]:
   y,x,offs,item=E.expected_buffers(case)
   for i,v in zip(case['output_indices'],case['expected']):y[(i+64)*item:(i+65)*item]=struct.pack('<q' if item==8 else '<f',v)
   raw=bytes(y)+x+offs;score,_=E.grade_bytes(case,raw);self.assertTrue(score['passed'],case['id'])
   bad=bytearray(raw);bad[0]^=1;self.assertFalse(E.grade_bytes(case,bad)[0]['passed'])
   bad=bytearray(raw);bad[len(y)]^=1;self.assertFalse(E.grade_bytes(case,bad)[0]['input_preserved'])
   bad=bytearray(raw);bad[-1]^=1;self.assertFalse(E.grade_bytes(case,bad)[0]['offsets_preserved'])
 def test_oracle_catches_wrong_value_and_int32_overflow(self):
  cases=E.F.make_cases()[0];c=next(c for c in cases if c['task']=='segments' and c['params']['n']==4097 and c['params']['segments']==1)
  self.assertEqual(c['expected'][0],4097*1048576)
  # Another long segment exceeds int32; Python oracle remains exact.
  self.assertTrue(any(abs(v)>2**31 for c in cases if c['task']=='segments' for v in c['expected']))
  c=next(c for c in cases if c['task']=='transpose' and c['expected']);y,x,o,item=E.expected_buffers(c);score,_=E.grade_bytes(c,bytes(y)+x+o);self.assertFalse(score['passed'])
if __name__=='__main__':unittest.main()
