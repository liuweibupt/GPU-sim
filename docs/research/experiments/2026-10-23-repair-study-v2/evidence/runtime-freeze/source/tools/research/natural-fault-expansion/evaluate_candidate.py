#!/usr/bin/env python3
"""Run an untouched repair-study-v2 candidate against all 11 cases of its family.
Writes exactly the candidate files into an isolated official-wheel overlay; never
repairs an edit, changes the harness, or modifies the shared runtime installation.
"""
import argparse,ast,hashlib,json,os,pathlib,shutil,subprocess,time
from verify import verify,sha
ROOT=pathlib.Path(__file__).resolve().parents[3];DEFAULT=ROOT/'out/research/natural-fault-expansion'
PYTHON='/home/liuwei/.cache/embodied_longwam_20261019/runtime/venv/bin/python'
def candidate_tree_sha(files):
 # Match core.applyEdits exactly. Python code-point sorting differs from JS
 # localeCompare for real repository paths containing underscores/punctuation.
 script="import fs from 'node:fs';import{createHash}from'node:crypto';const files=JSON.parse(fs.readFileSync(0,'utf8'));const tree=files.map(({path,sha256})=>({path,sha256})).sort((a,b)=>a.path.localeCompare(b.path));process.stdout.write(createHash('sha256').update(JSON.stringify(tree)).digest('hex'));"
 return subprocess.check_output(['node','--input-type=module','-e',script],input=json.dumps(files),text=True).strip()
def overlay(before,dest,files):
 shutil.copytree(before,dest,copy_function=os.link,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
 for f in files:
  if f['role']!='implementation':continue
  p=dest/f['path'];p.parent.mkdir(exist_ok=True,parents=True)
  if p.exists():p.unlink()
  p.write_text(f['text'])
def evaluate(candidate,output,base=DEFAULT,python=PYTHON,timeout=180):
 candidate=pathlib.Path(candidate);output=pathlib.Path(output);base=pathlib.Path(base);output.mkdir(parents=True,exist_ok=False)
 c=json.loads(candidate.read_text());catalog=json.loads((base/'catalog.json').read_text());task=next(t for t in catalog['tasks']if t['id']==c['taskId']);spec=next(t for t in json.loads((base/'private-plan.json').read_text())['tasks']if t['id']==c['taskId']);manifest=json.loads((base/'manifest.json').read_text())
 assert c['format']=='repair-study-candidate-v2'
 wanted={f['path']:f for f in task['files']};assert len(c['files'])==len(wanted)and{f['path']for f in c['files']}==set(wanted),'candidate file set differs'
 for f in c['files']:
  old=wanted[f['path']];assert f['id']==old['id']and f['role']==old['role']and f['beforeSHA256']==old['sha256'],'candidate before provenance mismatch'
  assert hashlib.sha256(f['text'].encode()).hexdigest()==f['sha256'],'candidate source SHA mismatch'
  assert f['changed']==(f['text']!=old['text'])
  if f['role']!='implementation':assert f['text']==old['text'],'non-implementation edit'
 assert candidate_tree_sha(c['files'])==c['candidateTreeSHA256'],'candidate tree SHA mismatch'
 shutil.copyfile(candidate,output/'candidate.json');runtime=output/'runtime';overlay(base/'runtime-before',runtime,c['files']);native=runtime/'triton/_C/libtriton.so';assert sha(native)==manifest['native_compiler_sha256']
 family=c['taskId'].removeprefix('triton-');receipt={'candidateTreeSHA256':c['candidateTreeSHA256'],'hiddenSpecSHA256':spec['hiddenSpecSHA256'],'buildStatus':'failed','verifierStatus':'missing','cases':[],'candidate_json_sha256':sha(candidate),'evaluator_sha256':sha(__file__),'native_compiler_sha256':sha(native),'family':family}
 receipt['applied_sources']={f['path']:sha(runtime/f['path'])for f in c['files']if f['role']=='implementation'}
 for f in c['files']:
  if f['role']=='implementation':assert receipt['applied_sources'][f['path']]==f['sha256']
 env={k:os.environ[k]for k in ('PATH','HOME','LD_LIBRARY_PATH','CUDA_VISIBLE_DEVICES','CUDA_HOME','LANG','LC_ALL')if k in os.environ};env.update(PYTHONPATH=str(runtime.resolve()),TRITON_CACHE_DIR=str((output/'cache').resolve()),PYTHONNOUSERSITE='1')
 command=[python,str(ROOT/'tools/research/natural-fault-expansion/run.py'),'--output',str((output/'run').resolve()),'--variant','before','--plan',str((base/'plan.json').resolve()),'--family',family];receipt['command']=command;started=time.monotonic()
 try:
  r=subprocess.run(command,env=env,cwd=output.resolve(),capture_output=True,text=True,timeout=timeout);(output/'stdout.log').write_text(r.stdout);(output/'stderr.log').write_text(r.stderr);receipt['process_exit_code']=r.returncode
  if r.returncode==0:
   source_hashes={p.removeprefix('triton/'):h for p,h in receipt['applied_sources'].items()if p in ['triton/language/standard.py','triton/language/semantic.py','triton/compiler/code_generator.py','triton/language/core.py','triton/runtime/interpreter.py']}
   v=verify(output/'run',base/'plan.json',source_hashes,manifest['native_compiler_sha256'],family=family);vp=output/'independent-verification.json';vp.write_text(json.dumps(v,indent=2)+'\n');receipt['verifierStatus']=v['status'];receipt['verifierReceiptSHA256']=sha(vp);receipt['buildStatus']='passed' if all(r['status']!='execution_error'for r in v['cases'])else'failed';receipt['cases']=[{'id':r['id'],'status':r['status']}for r in v['cases']if r['id']in spec['hiddenCaseIds']];receipt['visibleCases']=[{'id':r['id'],'status':r['status']}for r in v['cases']if r['id']not in spec['hiddenCaseIds']];receipt['allCaseCount']=len(v['cases'])
 except subprocess.TimeoutExpired as e:
  receipt['timeout_seconds']=timeout;(output/'stdout.log').write_bytes(e.stdout or b'');(output/'stderr.log').write_bytes(e.stderr or b'')
 except Exception as e:receipt['validation_error']=type(e).__name__+': '+str(e)
 receipt['wall_seconds']=time.monotonic()-started;(output/'runtime-record.json').write_text(json.dumps(receipt,indent=2)+'\n');return receipt

def main():
 p=argparse.ArgumentParser();p.add_argument('--candidate',type=pathlib.Path,required=True);p.add_argument('--output',type=pathlib.Path,required=True);p.add_argument('--base',type=pathlib.Path,default=DEFAULT);p.add_argument('--python',default=PYTHON);p.add_argument('--timeout',type=int,default=180);a=p.parse_args();r=evaluate(a.candidate,a.output,a.base,a.python,a.timeout);print(json.dumps({k:r.get(k)for k in ('buildStatus','verifierStatus','cases','wall_seconds')},indent=2))
if __name__=='__main__':main()
