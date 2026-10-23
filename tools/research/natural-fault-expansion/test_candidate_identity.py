import hashlib,json,pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from evaluate_candidate import candidate_tree_sha
class CandidateIdentityTests(unittest.TestCase):
 def test_js_locale_order_matches_core_control(self):
  base=pathlib.Path(__file__).resolve().parents[3]/'out/research/natural-fault-expansion/core-control-candidates'
  for family in ('softmax-axis','negative-zero','constexpr-filter'):
   c=json.loads((base/(family+'.json')).read_text());self.assertEqual(candidate_tree_sha(c['files']),c['candidateTreeSHA256'])
 def test_punctuation_order_is_not_python_sort(self):
  paths=['pkg/a.py','pkg/a_b.py','pkg/a-b.py','pkg/z.py','pkg/__init__.py'];files=[{'path':p,'sha256':'f'*64}for p in paths]
  py=hashlib.sha256(json.dumps(sorted(files,key=lambda f:f['path']),separators=(',',':')).encode()).hexdigest();self.assertNotEqual(py,candidate_tree_sha(files))
if __name__=='__main__':unittest.main()
