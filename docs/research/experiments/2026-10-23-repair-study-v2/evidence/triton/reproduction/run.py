#!/usr/bin/env python3
"""Run natural Triton frontend defects, preserving complete device outputs and IR.
No performance measurements. Every numerical/reference input is recorded.
"""
import argparse,datetime,hashlib,json,math,os,pathlib,platform,subprocess,sys,time,traceback
import torch
import triton
import triton.language as tl
@triton.jit
def softmax_kernel(X,Y,N:tl.constexpr,SHAPE:tl.constexpr,DIM:tl.constexpr):
    offs=tl.arange(0,N).reshape(SHAPE)
    x=tl.load(X+offs)
    y=tl.softmax(x,dim=DIM)
    tl.store(Y+offs,y)
@triton.jit
def constant_kernel(Y,N:tl.constexpr,VALUE:tl.constexpr,DTYPE:tl.constexpr,NEGATIVE_ZERO:tl.constexpr):
    offs=tl.arange(0,N)
    if NEGATIVE_ZERO:
        y=tl.full((N,),-0.0,DTYPE)
    else:
        y=tl.full((N,),VALUE,DTYPE)
    tl.store(Y+offs,y)
@triton.jit
def filter_kernel(Y,VALUES:tl.constexpr,CUTOFF:tl.constexpr,EVEN:tl.constexpr):
    if EVEN:
        vals:tl.constexpr=[x for x in VALUES if x>=CUTOFF if x%2==0]
    else:
        vals:tl.constexpr=[x for x in VALUES if x>=CUTOFF]
    tl.store(Y,len(vals))
    for i in tl.static_range(len(vals)):
        tl.store(Y+1+i,vals[i])
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def make_cases():
 cs=[]
 def add(f,split,**kw):cs.append({'id':f+'-'+str(sum(x['family']==f for x in cs)).zfill(2),'family':f,'split':split,**kw})
 for split,shape,dim,pattern in [('visible',(2,2),1,'linear'),('visible',(2,2),0,'linear'),('visible',(128,),0,'linear'),('hidden',(4,4),1,'linear'),('hidden',(8,8),1,'wave'),('hidden',(16,16),1,'linear'),('hidden',(4,16),0,'wave'),('hidden',(8,8),-1,'wave'),('hidden',(2,2),1,'constant'),('hidden',(32,),0,'wave'),('hidden',(2,2),1,'extreme')]:add('softmax-axis',split,shape=list(shape),dim=dim,pattern=pattern)
 for split,dtype,value,n in [('visible','float32',-0.0,32),('visible','float32',0.0,32),('visible','float32',1.0,32),('hidden','float16',-0.0,64),('hidden','float16',0.0,64),('hidden','bfloat16',-0.0,128),('hidden','bfloat16',0.0,128),('hidden','float64',-0.0,32),('hidden','float64',0.0,32),('hidden','float32',-0.0,256),('hidden','float32',-1.0,64)]:add('negative-zero',split,dtype=dtype,value=value,n=n)
 for split,values,cutoff,even in [('visible',[10,20,30,40],30,False),('visible',[10,20,30,40],0,False),('visible',[0,1,2,3,4,5],2,True),('hidden',[-5,-4,-3,0,1,2],-3,False),('hidden',[-5,-4,-3,0,1,2],-4,True),('hidden',[2,4,6],7,False),('hidden',[7,7,7],7,False),('hidden',[1,2,3,4,5,6,7,8],3,True),('hidden',[0],0,True),('hidden',[-9,-7,-5,-3],-10,True),('hidden',[32,4,16,8,64],8,False)]:add('constexpr-filter',split,values=values,cutoff=cutoff,even=even)
 return cs
def input_values(c):
 n=1
 for d in c['shape']:n*=d
 if c['pattern']=='linear':return [float((i*7)%19-9)/4 for i in range(n)]
 if c['pattern']=='wave':return [float((i*i+3*i+5)%29-14)/8 for i in range(n)]
 if c['pattern']=='constant':return [2.0]*n
 if c['pattern']=='extreme':return [-50.0,50.0,49.0,-49.0]
 raise ValueError(c)
def bits(t):return t.detach().cpu().contiguous().view(torch.uint8).flatten().tolist()
def expected(c):
 if c['family']=='softmax-axis':
  x=torch.tensor(input_values(c),dtype=torch.float64).reshape(c['shape']);return torch.softmax(x,dim=c['dim']).float()
 if c['family']=='negative-zero':return torch.full((c['n'],),c['value'],dtype=getattr(torch,c['dtype']))
 vals=[x for x in c['values'] if x>=c['cutoff'] and (not c['even'] or x%2==0)]
 return torch.tensor([len(vals)]+vals+[-777]*(len(c['values'])-len(vals)),dtype=torch.int32)
def main():
 p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=pathlib.Path);p.add_argument('--variant',choices=['before','gold'],required=True);p.add_argument('--plan',type=pathlib.Path);p.add_argument('--write-plan',type=pathlib.Path);p.add_argument('--family',choices=['softmax-axis','negative-zero','constexpr-filter']);a=p.parse_args()
 if a.write_plan:a.write_plan.parent.mkdir(parents=True,exist_ok=True);a.write_plan.write_text(json.dumps({'schema':'natural-fault-expansion-plan-v1','cases':make_cases()},indent=2)+'\n');return
 cases=json.loads(a.plan.read_text())['cases'] if a.plan else make_cases();cases=[c for c in cases if not a.family or c['family']==a.family];a.output.mkdir(parents=True,exist_ok=False)
 native=pathlib.Path(triton.__file__).parent/'_C/libtriton.so'
 summary={'schema':'natural-fault-expansion-run-v1','variant':a.variant,'started_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'python':sys.version,'torch':torch.__version__,'triton':triton.__version__,'triton_path':triton.__file__,'native_compiler_sha256':sha(native),'harness_sha256':sha(__file__),'plan_sha256':sha(a.plan) if a.plan else None,'gpu':torch.cuda.get_device_name(0),'capability':list(torch.cuda.get_device_capability()),'driver':subprocess.check_output(['nvidia-smi','--query-gpu=driver_version','--format=csv,noheader'],text=True).strip(),'source_sha256':{},'timing_scope':'Correctness only; shared local GPU may execute unrelated small kernels concurrently. No performance inference.','cases':[]}
 for path in ['language/standard.py','language/semantic.py','compiler/code_generator.py','language/core.py','runtime/interpreter.py']:summary['source_sha256'][path]=sha(pathlib.Path(triton.__file__).parent/path)
 for c in cases:
  folder=a.output/c['id'];folder.mkdir();row={'case':c,'status':'running'};start=time.monotonic()
  try:
   ref=expected(c)
   if c['family']=='softmax-axis':
    xv=input_values(c);x=torch.tensor(xv,dtype=torch.float32,device='cuda').reshape(c['shape']);y=torch.empty_like(x);k=softmax_kernel[(1,)](x,y,x.numel(),tuple(c['shape']),c['dim']);row['input_values']=xv
   elif c['family']=='negative-zero':
    y=torch.empty((c['n'],),dtype=getattr(torch,c['dtype']),device='cuda');k=constant_kernel[(1,)](y,c['n'],c['value'],getattr(tl,c['dtype']),c['value']==0.0 and math.copysign(1.0,c['value'])<0)
   else:
    y=torch.full((len(c['values'])+1,),-777,dtype=torch.int32,device='cuda');k=filter_kernel[(1,)](y,tuple(c['values']),c['cutoff'],c['even'])
   torch.cuda.synchronize();observed=y.detach().cpu();row.update(observed=observed.float().flatten().tolist(),reference=ref.float().flatten().tolist(),observed_bytes=bits(observed),reference_bytes=bits(ref),elements=ref.numel(),output_dtype=str(y.dtype))
   if c['family']=='softmax-axis':
    wrong=~torch.isclose(observed,ref,atol=1e-6,rtol=1e-5,equal_nan=False);row['maximum_absolute_error']=(observed-ref).abs().max().item()
   elif c['family']=='negative-zero':wrong=(observed.view(torch.uint8).reshape(-1,observed.element_size())!=ref.view(torch.uint8).reshape(-1,ref.element_size())).any(dim=1)
   else:wrong=observed!=ref
   row['wrong_elements']=int(wrong.sum());row['status']='pass' if row['wrong_elements']==0 else 'wrong-result'
   row['assembly']={}
   for kind,value in k.asm.items():
    if isinstance(value,bytes):row['assembly'][kind]={'sha256':hashlib.sha256(value).hexdigest(),'bytes':len(value),'omitted':'binary artifact represented by hash'}
    elif isinstance(value,str):
     path=folder/('kernel.'+kind);path.write_text(value);row['assembly'][kind]={'sha256':sha(path),'file':path.name,'bytes':path.stat().st_size}
  except Exception as e:row.update(status='exception',exception=type(e).__name__,message=str(e));(folder/'traceback.txt').write_text(traceback.format_exc())
  row['execution_wall_seconds']=time.monotonic()-start;(folder/'result.json').write_text(json.dumps(row,indent=2)+'\n');summary['cases'].append({'id':c['id'],'family':c['family'],'split':c['split'],'status':row['status'],'wrong_elements':row.get('wrong_elements'),'result_sha256':sha(folder/'result.json')});print(c['id'],row['status'],row.get('wrong_elements'),flush=True)
  (a.output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
 summary['completed_utc']=datetime.datetime.now(datetime.timezone.utc).isoformat();(a.output/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
if __name__=='__main__':main()
