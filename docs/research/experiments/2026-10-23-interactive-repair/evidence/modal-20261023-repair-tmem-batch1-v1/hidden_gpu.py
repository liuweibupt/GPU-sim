#!/usr/bin/env python3
"""Execute frozen repair regressions; the candidate cannot modify this evaluator."""
import argparse,gzip,hashlib,importlib.util,json,os,subprocess,time
from pathlib import Path
from collections import Counter

def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def save(p,x):p.write_text(json.dumps(x,indent=2)+'\n')
def cutlass(args,root,plan):
 binary=args.binary.resolve();binary.chmod(0o700);records=[]
 for index,case in enumerate(plan['cutlass']):
  cwd=root/f'case-{index:02d}';cwd.mkdir();(cwd/'shapes.txt').write_text(''.join(f'{i} {case["m"]}x{case["n"]}x{k}\n' for i,k in enumerate(case['k'])))
  argv=[str(binary),'--benchmark=shapes.txt','--iterations=0','--raster=h','--swizzle=1','--alpha=1','--beta=0',f'--host-shapes={case["host_shapes"]}']
  if case['tool']=='memcheck':argv=['compute-sanitizer','--tool','memcheck','--error-exitcode','86']+argv
  start=time.monotonic();r={'id':f'case-{index:02d}',**case,'argv':argv}
  try:
   p=subprocess.run(argv,cwd=cwd,capture_output=True,timeout=30 if case['tool']=='memcheck' else 10);stdout,stderr=p.stdout,p.stderr;r.update(exit_code=p.returncode,timed_out=False)
  except subprocess.TimeoutExpired as e:stdout,stderr=e.stdout or b'',e.stderr or b'';r.update(exit_code=None,timed_out=True)
  r['wall_seconds']=time.monotonic()-start;(cwd/'stdout.txt').write_bytes(stdout);(cwd/'stderr.txt').write_bytes(stderr)
  r['groups']=[json.loads(line[len('EVIDENCE '):]) for line in stdout.decode(errors='replace').splitlines() if line.startswith('EVIDENCE {')]
  r['mismatches']=sum(x['mismatches']+x['zero_k_mismatches'] for x in r['groups']);r['outputs']=sum(x['outputs'] for x in r['groups'])
  r['passed']=not r['timed_out'] and r['exit_code']==0 and len(r['groups'])==len(case['k']) and r['mismatches']==0
  r['sanitizer_clean']=case['tool']=='memcheck' and r['passed'] and b'ERROR SUMMARY: 0 errors' in stdout+stderr
  if case['tool']=='memcheck':r['passed'] &= r['sanitizer_clean']
  r['files']=[{'path':p.name,'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted(cwd.iterdir()) if p.is_file()];save(cwd/'record.json',r);records.append(r)
  save(root/'summary.json',{'format':'natural-repair-cutlass-runtime-v1','plan_sha256':sha(args.plan),'binary_sha256':sha(binary),'records':records})
  print(json.dumps({'case':r['id'],'passed':r['passed'],'timeout':r['timed_out']}),flush=True)

def tmem(args,root,plan):
 os.environ['TRITON_CACHE_DIR']=str(root/'cache');os.environ['PYTHONDONTWRITEBYTECODE']='1'
 import torch,triton
 from triton._C import libtriton
 if list(torch.cuda.get_device_capability()) != [10,0]:raise ValueError('SM100 required')
 if sha(libtriton.__file__)!=args.native_sha256:raise ValueError('candidate native compiler mismatch')
 summary={'format':'natural-repair-tmem-runtime-v1','plan_sha256':sha(args.plan),'native_sha256':sha(libtriton.__file__),'torch':torch.__version__,'triton':triton.__version__,'gpu':torch.cuda.get_device_name(),'capability':list(torch.cuda.get_device_capability()),'records':[]}
 for index,case in enumerate(plan['tmem']):
  name=case['module'];src=args.plan.parent/name
  if sha(src)!=plan['modules'][name]:raise ValueError('frozen module changed')
  spec=importlib.util.spec_from_file_location(name[:-3],src);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  allocations=[];compiled=[];empty=torch.empty;hook=triton.knobs.runtime.jit_post_compile_hook
  def observe_empty(*a,**kw):
   t=empty(*a,**kw)
   if len(allocations)<2:allocations.append(t)
   return t
  def observe_compile(**kw):
   k=kw['fn'].jit_function.device_caches[kw['compile']['device']][0][kw['key']]
   directory=root/'compiler'/k.hash;directory.mkdir(parents=True,exist_ok=True)
   files=[]
   for key,path in k.metadata_group.items():
    p=Path(path)
    if p.suffix=='.cubin':continue
    data=p.read_bytes();dest=directory/p.name;dest.write_bytes(data);files.append({'path':str(dest.relative_to(root)),'sha256':sha(dest)})
   compiled.append({'kernel_hash':k.hash,'artifacts':files})
  torch.empty=observe_empty;triton.knobs.runtime.jit_post_compile_hook=observe_compile
  r={'id':f'case-{index:02d}',**case,'compiled':compiled};start=time.monotonic()
  try:module.test_tmem_selected_descriptor_lifetime(**case['parameters']);r['call_passed']=True
  except Exception as e:r.update(call_passed=False,error_type=type(e).__name__,error=str(e))
  finally:torch.empty=empty;triton.knobs.runtime.jit_post_compile_hook=hook
  r['wall_seconds']=time.monotonic()-start;r['outputs']=[]
  try:
   torch.cuda.synchronize()
   if len(allocations)!=2:raise ValueError('expected two output allocations')
   p=case['parameters'];a,b,c=case['constants'];expected=a if p['mode']=='first' or (p['mode']=='select' and p['choice']) else b
   if p['mode']=='chain':expected=a if p['choice']==p['outer_choice'] else b
   for label,t,value in [('selected',allocations[0],expected)]+([('temporary',allocations[1],c)] if p['columns'] else []):
    values=t.detach().cpu().contiguous().reshape(-1).tolist();r['outputs'].append({'name':label,'actual':values,'expected':value,'mismatches':sum(x!=value for x in values)})
   r['numeric_passed']=all(x['mismatches']==0 for x in r['outputs'])
  except Exception as e:r.update(numeric_passed=False,observation_error=str(e))
  r['passed']=r['call_passed'] and r['numeric_passed'];raw=json.dumps(r).encode();dest=root/f'case-{index:02d}.json.gz';dest.write_bytes(gzip.compress(raw,mtime=0))
  summary['records'].append({'id':r['id'],'partition':case['partition'],'parameters':case['parameters'],'constants':case['constants'],'passed':r['passed'],'call_passed':r['call_passed'],'numeric_passed':r['numeric_passed'],'elements':sum(len(x['actual']) for x in r['outputs']),'mismatches':sum(x['mismatches'] for x in r['outputs']),'artifact':{'path':dest.name,'sha256':sha(dest),'original_sha256':hashlib.sha256(raw).hexdigest()}})
  save(root/'summary.json',summary);print(json.dumps({'case':r['id'],'passed':r['passed']}),flush=True)

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--family',choices=['cutlass','tmem'],required=True);p.add_argument('--plan',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--binary',type=Path);p.add_argument('--native-sha256');a=p.parse_args();a.output.mkdir(parents=True,exist_ok=False);plan=json.loads(a.plan.read_text());(cutlass if a.family=='cutlass' else tmem)(a,a.output.resolve(),plan)
