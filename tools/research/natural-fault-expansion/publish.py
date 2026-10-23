#!/usr/bin/env python3
"""Curate source/text evidence and independently verify an unpacked package offline.
No runtime wheel, native ELF/cubin, cache, GPU or network is needed for verification.
"""
import argparse,collections,hashlib,json,pathlib,shutil,types
ROOT=pathlib.Path(__file__).resolve().parents[3];BASE=ROOT/'out/research/natural-fault-expansion'
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def safe_relative(value):
 p=pathlib.PurePosixPath(value)
 if p.is_absolute() or any(x in ('..','.')for x in p.parts) or '\\'in value:raise ValueError('Unsafe archive path')
 return p

def verify_package(package):
 package=pathlib.Path(package).resolve();manifest=json.loads((package/'publication-manifest.json').read_text());seen=set()
 for r in manifest['files']:
  rel=str(safe_relative(r['path']));assert rel not in seen,'duplicate publication entry';seen.add(rel);p=package/rel;assert p.is_file()and not p.is_symlink(),'missing/nonregular artifact';assert p.stat().st_size==r['bytes']and sha(p)==r['sha256'],'publication file identity differs: '+rel
  assert p.read_bytes()[:4]!=b'\x7fELF'and p.suffix not in ('.so','.o','.whl','.pyc','.cubin'),'native binary included'
 # Execute the hash-verified source without creating __pycache__ in the archive.
 assert {str(p.relative_to(package))for p in package.rglob('*')if p.is_file()}==seen|{'publication-manifest.json'},'unexpected archive file'
 vp=package/'reproduction/verify.py';verifier=types.ModuleType('archived_natural_fault_verify');verifier.__file__=str(vp);exec(compile(vp.read_text(),str(vp),'exec'),verifier.__dict__)
 origin=json.loads((package/'manifest.json').read_text());plan=package/'plan.json';private=json.loads((package/'private-plan.json').read_text());results=[]
 for name,category in [('run-before','screening-confounded'),('run-gold','screening-confounded'),('run-before-v2','final-before-control'),('run-gold-v2','combined-upstream-gold-control')]:
  d=package/name
  if not d.exists():continue
  v=verifier.verify(d,plan,expected_native=origin['native_compiler_sha256']);results.append({'directory':name,'category':category,'status':v['status'],'case_count':len(v['cases']),'counts':v['counts'],'output_elements':v['total_elements'],'wrong_elements':v['wrong_elements']})
 for pattern in ('isolated-gold-*','candidate-evaluations/*'):
  for d in sorted(package.glob(pattern)):
   if not d.is_dir():continue
   rp=d/'runtime-record.json';assert rp.exists(),'evaluation has no runtime receipt';r=json.loads(rp.read_text());cp=d/'candidate.json';c=json.loads(cp.read_text());assert c['candidateTreeSHA256']==r['candidateTreeSHA256'],'candidate identity differs'
   for f in c['files']:
    assert hashlib.sha256(f['text'].encode()).hexdigest()==f['sha256'],'candidate file content differs'
    if f['role']=='implementation':assert r['applied_sources'][f['path']]==f['sha256'],'applied library source differs'
   category='model-candidate'if pattern.startswith('candidate')else('single-root-core-applyEdits-gold-control'if d.name.startswith('isolated-gold-core-')else'single-root-upstream-gold-control')
   if r['verifierStatus']!='verified':
    assert r['buildStatus']!='passed','unverified result cannot claim build pass';results.append({'directory':str(d.relative_to(package)),'category':category,'status':'execution-failed-or-incomplete','case_count':0,'failure_receipt_sha256':sha(rp)});continue
   archived=d/'independent-verification.json';assert sha(archived)==r['verifierReceiptSHA256'],'verifier receipt SHA differs';previous=json.loads(archived.read_text())
   keys=['triton/language/standard.py','triton/language/semantic.py','triton/compiler/code_generator.py','triton/language/core.py','triton/runtime/interpreter.py'];sources={p.removeprefix('triton/'):h for p,h in r['applied_sources'].items()if p in keys}
   v=verifier.verify(d/'run',plan,expected_sources=sources,expected_native=origin['native_compiler_sha256'],family=r['family'])
   assert [(x['id'],x['status'],x['wrong_elements'])for x in v['cases']]==[(x['id'],x['status'],x['wrong_elements'])for x in previous['cases']],'recomputed outcomes differ'
   task_spec=next(t for t in private['tasks']if t['id']==c['taskId']);hidden_ids=set(task_spec['hiddenCaseIds']);assert r['hiddenSpecSHA256']==task_spec['hiddenSpecSHA256']==sha(plan),'hidden contract identity differs'
   for key,expected in [('cases',[x for x in v['cases']if x['id']in hidden_ids]),('visibleCases',[x for x in v['cases']if x['id']not in hidden_ids])]:
    actual=r[key];assert len(actual)==len(expected)and len({x['id']for x in actual})==len(actual),'runtime adapter case count/uniqueness differs'
    assert {x['id']:x['status']for x in actual}=={x['id']:x['status']for x in expected},'runtime adapter partition/status differs: '+key
   assert {x['id']for x in r['cases']}==hidden_ids,'runtime hidden IDs differ'
   assert r['allCaseCount']==len(v['cases']),'runtime adapter total differs'
   expected_build='failed'if any(x['status']=='execution_error'for x in v['cases'])else'passed';assert r['buildStatus']==expected_build,'runtime build status differs from actual compile outcomes'
   results.append({'directory':str(d.relative_to(package)),'category':category,'status':v['status'],'case_count':len(v['cases']),'counts':v['counts'],'output_elements':v['total_elements'],'wrong_elements':v['wrong_elements'],'candidateTreeSHA256':r['candidateTreeSHA256']})
 for d in sorted((package/'interrupted-attempts').glob('*')):
  if not d.is_dir():continue
  interrupted=json.loads((d/'external-interruption.json').read_text());partial=json.loads((d/'partial-tree-manifest.json').read_text());cp=d/'candidate.json';c=json.loads(cp.read_text())
  assert sha(cp)==interrupted['candidate_json_sha256']and c['candidateTreeSHA256']==interrupted['candidateTreeSHA256'],'interrupted candidate identity differs'
  assert interrupted['runtime_receipt_exists']is False and interrupted['summary_exists']is False,'interruption state changed'
  assert partial['completed_device_cases_with_verified_arrays']==0,'incomplete attempt claimed verified arrays'
  for record in partial['files']:
   rel=str(safe_relative(record['path']));f=d/rel
   if f.exists():assert sha(f)==record['sha256']and f.stat().st_size==record['bytes'],'preserved incomplete artifact differs'
  canonical=package/'candidate-evaluations'/interrupted['trial']/'candidate.json';assert canonical.exists()and sha(canonical)==sha(cp),'physical replay changed candidate bytes'
  results.append({'directory':str(d.relative_to(package)),'category':'externally-interrupted-incomplete-physical-attempt','status':'retained-incomplete-attempt','case_count':0,'output_elements':0,'complete_saved_device_arrays':0,'actual_device_execution':'No complete output/receipt; unknown whether any device operation began.','candidateTreeSHA256':c['candidateTreeSHA256'],'included_in_18_complete_candidate_denominator':False})
 return {'schema':'natural-fault-expansion-offline-verification-v1','publication_manifest_sha256':sha(package/'publication-manifest.json'),'files_checked':len(seen),'verifier_sha256':sha(vp),'plan_sha256':sha(plan),'runs':results,'run_categories':dict(collections.Counter(x['category']for x in results)),'scope':'Offline numerical/bitwise oracle, complete output lengths, source and artifact identities; no GPU execution, download, runtime wheel or native binary needed.'}

def publish(output):
 output=pathlib.Path(output);output.mkdir(parents=True,exist_ok=False);receipt=[]
 def copy(src,dest):
  raw=src.read_bytes()
  if raw[:4]==b'\x7fELF' or src.suffix in ('.so','.o','.whl','.pyc','.cubin'):raise ValueError('Forbidden native artifact: '+str(src))
  dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dest);receipt.append({'path':str(dest.relative_to(output)),'source':str(src.relative_to(ROOT)),'sha256':sha(src),'bytes':src.stat().st_size})
 for f in BASE.iterdir():
  if f.is_file() and f.suffix in ('.json','.log','.py','.txt'):copy(f,output/f.name)
 for name in ('upstream','context','sources','visible-kernels','run-before','run-gold','run-before-v2','run-gold-v2','control-candidates','core-control-candidates'):
  for f in (BASE/name).rglob('*'):
   if f.is_file():copy(f,output/f.relative_to(BASE))
 for pattern in ('isolated-gold-*','candidate-evaluations/*'):
  for d in BASE.glob(pattern):
   if not d.is_dir():continue
   for f in d.iterdir():
    if f.is_file()and f.suffix in ('.json','.log','.txt'):copy(f,output/f.relative_to(BASE))
   for f in (d/'run').rglob('*'):
    if f.is_file():copy(f,output/f.relative_to(BASE))
 for d in (BASE/'interrupted-attempts').glob('*'):
  if not d.is_dir():continue
  for f in d.iterdir():
   if f.is_file()and f.suffix in ('.json','.log','.txt'):copy(f,output/f.relative_to(BASE))
 for f in (ROOT/'tools/research/natural-fault-expansion').iterdir():
  if f.is_file():copy(f,output/'reproduction'/f.name)
 record={'schema':'natural-fault-expansion-publication-v1','files':receipt,'excluded':'Full installed runtime trees, cache directories, wheels and ELF/cubin bytes are omitted. Native compiler/uploaded identities remain in SHA receipts. GPU outputs and compiler text remain complete.'};(output/'publication-manifest.json').write_text(json.dumps(record,indent=2)+'\n');return {'files':len(receipt),'bytes':sum(x['bytes']for x in receipt),'manifest_sha256':sha(output/'publication-manifest.json')}

def main():
 p=argparse.ArgumentParser();group=p.add_mutually_exclusive_group(required=True);group.add_argument('--output',type=pathlib.Path);group.add_argument('--verify-package',type=pathlib.Path);p.add_argument('--receipt',type=pathlib.Path);a=p.parse_args();result=verify_package(a.verify_package)if a.verify_package else publish(a.output)
 if a.receipt:a.receipt.write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result,indent=2))
if __name__=='__main__':main()
