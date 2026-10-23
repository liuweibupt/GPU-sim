#!/usr/bin/env python3
"""Freeze unpublished input variants without looking at candidate responses."""
import hashlib,json
from pathlib import Path
import argparse

def prepare(out):
 out.mkdir(parents=True,exist_ok=False)
 source=Path('tools/research/natural-bugs/tmem_upstream_regression.py').read_text();modules={};tmem=[]
 configs=[('select',64,False,1),('select',32,False,1),('select',0,False,1),('select',64,True,1),('first',64,False,1),('second',64,False,1),('chain',64,False,0),('chain',64,False,1)]
 for n,constants in enumerate([(3,5,7),(11,13,17),(-2,9,23)]):
  a,b,c=constants;text=source
  for old,new in [('], 3, ttgl.float32',f'], {a}, ttgl.float32'),('], 5, ttgl.float32',f'], {b}, ttgl.float32'),('], 7, ttgl.float32',f'], {c}, ttgl.float32'),('expected = 3 if',f'expected = {a} if'),(' else 5',f' else {b}'),('full_like(temporary, 7)',f'full_like(temporary, {c})')]:text=text.replace(old,new)
  name=f'regression_{n}.py';(out/name).write_text(text);modules[name]=hashlib.sha256(text.encode()).hexdigest()
  for choice in [0,1]:
   for mode,columns,early,outer in configs:tmem.append({'partition':'known' if n==0 else 'hidden','module':name,'constants':list(constants),'parameters':dict(choice=choice,mode=mode,columns=columns,early=early,outer_choice=outer)})
 inputs=[('known',[128,256,128],128,128),('known',[0,128,256],128,128),('hidden',[0],128,128),('hidden',[128,256],256,128),('hidden',[128,0,256,0],128,128),('hidden',[0,0,0,0,0],128,256),('hidden',[0,128,0,256,128],128,256),('hidden',[128,256,0,128,0,256,0,128],256,256)]
 cutlass=[dict(partition=partition,k=ks,m=m,n=n,host_shapes=host,tool='normal') for partition,ks,m,n in inputs for host in [0,1]]
 cutlass += [dict(partition='hidden-sanitizer',k=[128,0,256,0],m=128,n=128,host_shapes=host,tool='memcheck') for host in [0,1]]
 doc={'format':'natural-repair-hidden-plan-v1','cutlass':cutlass,'tmem':tmem,'modules':modules,'limits':['CUTLASS beta=0 only: old beta=1 has a separate positive-control failure.','TMEM hidden cases are new constant substitutions in the same 16-configuration regression; not independent root causes.','Known public regressions are withheld from prompts only, not proven absent from training.']}
 (out/'plan.json').write_text(json.dumps(doc,indent=2)+'\n');print(json.dumps({'cutlass':len(cutlass),'tmem':len(tmem),'plan_sha256':hashlib.sha256((out/'plan.json').read_bytes()).hexdigest()}))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);prepare(p.parse_args().output)
