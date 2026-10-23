#!/usr/bin/env python3
"""Freeze public contracts and undisclosed deterministic test cases before code generation."""
import argparse, array, hashlib, json, math, random, struct
from datetime import datetime, timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'out/research/agent-kernel-eval'
HERE=Path(__file__).resolve().parent
FLOAT_SENTINEL=987654.25
INT_SENTINEL=0x13579BDF2468ACE
GUARD=64
HEADER=struct.Struct('<IIiiiiiifIII')
CONTRACTS={
 'rmsnorm': {'task_id':1,'signature':'extern "C" cudaError_t launch_rmsnorm(const float* x, float* y, int rows, int cols, int x_stride, int y_stride, float epsilon, cudaStream_t stream);','semantics':'For each row r and 0<=c<cols, y[r*y_stride+c] = x[r*x_stride+c] / sqrt(sum_k(x[r*x_stride+k]^2)/cols + epsilon). No affine weights. Row strides are in elements. Input and output do not alias. Do not modify row padding or inputs.','domain':'0<=rows<=4096; 1<=cols<=4096; cols<=x_stride,y_stride<=8192; finite FP32 abs(x)<=1024; 1e-6<=epsilon<=1e-2. rows=0 is a successful no-op. All products fit signed int.','comparison':'Full logical output versus independent double-precision CPU formula, rounded to FP32; abs error <=2e-5 + 2e-4*abs(reference). All padding and guard bytes exactly unchanged.','public_example':'A contiguous 3-row, 8-column matrix is one legal example; the interface supports the full declared domain.'},
 'transpose': {'task_id':2,'signature':'extern "C" cudaError_t launch_transpose(const float* x, float* y, int rows, int cols, int x_stride, int y_stride, cudaStream_t stream);','semantics':'Transpose: for 0<=r<rows,0<=c<cols set y[c*y_stride+r] = x[r*x_stride+c]. Input is rows-by-cols; output cols-by-rows. Strides are in FP32 elements. No aliasing. Do not modify input, padding, or guards. Preserve FP32 bits including signed zero.','domain':'0<=rows,cols<=4096; cols<=x_stride<=8192; rows<=y_stride<=8192; finite FP32 inputs. Either zero dimension is a successful no-op. All index products fit signed int.','comparison':'Every logical output must match independent CPU indexing bit-for-bit. Padding and guard bytes unchanged.','public_example':'A contiguous 16-by-16 matrix is one legal example; non-contiguous row strides and tails are supported.'},
 'segments': {'task_id':3,'signature':'extern "C" cudaError_t launch_segments(const int32_t* x, const int32_t* offsets, int64_t* y, int n, int segments, cudaStream_t stream);','semantics':'For 0<=s<segments, y[s] = sum of x[i] for offsets[s]<=i<offsets[s+1], accumulating exactly in int64. offsets are nondecreasing, offsets[0]=0, offsets[segments]=n. Empty segments produce 0. Inputs/offsets/output do not alias; input and offsets are read-only.','domain':'0<=n<=1048576; 0<=segments<=65535; each int32 x is in [-1048576,1048576]. If segments=0 then n=0. The mathematical sum fits int64; avoid int32 overflow.','comparison':'All output int64 values exactly equal an independent Python integer sum. All input/offset/guard bytes unchanged.','public_example':'Three contiguous segments of length 4 are one legal example; empty and unequal-length segments are supported.'}}
COMMON='''Write one complete CUDA C++17 translation unit for the contract below, targeting NVIDIA RTX 4090 sm_89 with CUDA 12.6. Return JSON with exactly source (the entire compilable source as a string, no Markdown fences) and notes (short implementation description). Include <cuda_runtime.h> and <cstdint> where needed. Implement exactly the named extern "C" host launcher plus any kernels/helpers. Do not define main. Do not use tools, shell, browsing, files, or external context: all task information is in this prompt. Do not use host I/O, filesystem/network access, process execution, CPU computation of the output, host/device allocation, library calls such as cuBLAS, cudaMemcpy, or synchronization of the entire device. The caller supplies device pointers and a valid CUDA stream. Enqueue only your computation on that stream, and return cudaSuccess for a valid no-op, otherwise return cudaGetLastError() or a launch error. You may use CUDA math, shuffle/shared-memory reductions, and the ordinary C++ standard headers. Prefer simple correct code. There is no repair round or feedback. Tests may exercise any valid contract input.\n'''

def sha(b):return hashlib.sha256(b).hexdigest()
def f32(v):return struct.unpack('<f',struct.pack('<f',v))[0]
def bytes4(values,integer=False):return struct.pack('<' + ('i' if integer else 'f')*len(values),*values)
def make_cases():
 rng=random.Random(20261023_918371)
 cases=[];relations=[]
 def add(task,d,x,offsets=None,relation=None):
  c={'id':f'{task}-c{sum(v["task"]==task for v in cases):02d}','task':task,'params':d,'input':x,'offsets':offsets or []}
  if task=='rmsnorm':
   expected=[];indices=[]
   for r in range(d['rows']):
    vals=x[r*d['xs']:r*d['xs']+d['cols']];scale=1/math.sqrt(sum(float(v)*v for v in vals)/d['cols']+d['epsilon'])
    for col,v in enumerate(vals):expected.append(f32(v*scale));indices.append(r*d['ys']+col)
  elif task=='transpose':
   indices=[col*d['ys']+row for row in range(d['rows']) for col in range(d['cols'])];expected=[x[row*d['xs']+col] for row in range(d['rows']) for col in range(d['cols'])]
  else:expected=[sum(x[offsets[s]:offsets[s+1]]) for s in range(d['segments'])];indices=list(range(d['segments']))
  c.update(expected=expected,output_indices=indices);cases.append(c)
  if relation:relations.append({'task':task,'base':relation[0]['id'],'derived':c['id'],'kind':relation[1]})
  return c
 for rows,cols,xs,ys in [(0,7,11,13),(1,1,5,3),(2,3,7,9),(3,31,37,35),(5,33,41,39),(7,65,71,73),(4,127,137,131),(3,257,263,269),(2,1025,1031,1033)]:
  eps=f32(rng.choice([1e-6,3e-5,1e-3]));x=[f32(rng.uniform(-40,40)) for _ in range(rows*xs)]
  if rows and cols==3:x[:cols]=[0.,-0.,0.]
  add('rmsnorm',dict(rows=rows,cols=cols,xs=xs,ys=ys,epsilon=eps),x)
 base=next(c for c in cases if c['task']=='rmsnorm' and c['params']['cols']==31)
 add('rmsnorm',dict(base['params']),[-v for v in base['input']],relation=(base,'negate'))
 scaled=dict(base['params']);scaled['epsilon']=f32(scaled['epsilon']*4)
 add('rmsnorm',scaled,[f32(v*2) for v in base['input']],relation=(base,'equal'))
 for rows,cols,xs,ys in [(0,9,13,3),(9,0,3,13),(1,1,5,7),(1,33,37,5),(31,33,41,37),(33,31,39,41),(7,65,71,11),(65,7,13,71),(257,17,23,263)]:
  x=[f32(rng.uniform(-100,100)) for _ in range(rows*xs)]
  if x:x[0]=-0.0
  add('transpose',dict(rows=rows,cols=cols,xs=xs,ys=ys,epsilon=0.),x)
 base=next(c for c in cases if c['task']=='transpose' and c['params']['rows']==31)
 add('transpose',dict(base['params']),[-v for v in base['input']],relation=(base,'negate'))
 for lengths in [[],[0],[1],[0,0,3,0,1],[31,32,33],[257,0,2,65],[4097],[1]*257,[4097,0,17,8193]]:
  offsets=[0]
  for length in lengths:offsets.append(offsets[-1]+length)
  x=[rng.randint(-1048576,1048576) for _ in range(offsets[-1])]
  if len(lengths)==1 and lengths[0]==4097:x=[1048576]*4097
  add('segments',dict(rows=0,cols=0,xs=0,ys=0,epsilon=0.,n=len(x),segments=len(lengths)),x,offsets)
 base=next(c for c in cases if c['task']=='segments' and c['params']['segments']==4)
 add('segments',dict(base['params']),[-v for v in base['input']],base['offsets'],relation=(base,'negate'))
 return cases,relations

def case_binary(case):
 d=case['params'];task=case['task'];input_count=len(case['input']);output_count=d.get('segments',0) if task=='segments' else (d['rows'] if task=='rmsnorm' else d['cols'])*d['ys']
 header=HEADER.pack(0x314b4741,CONTRACTS[task]['task_id'],d['rows'],d['cols'],d['xs'],d['ys'],d.get('n',0),d.get('segments',0),d['epsilon'],input_count,output_count,len(case['offsets']))
 return header+bytes4(case['input'],task=='segments')+bytes4(case['offsets'],True)

def freeze(out):
 frozen=out/'frozen'
 if frozen.exists():raise SystemExit('Refusing to replace existing freeze')
 frozen.mkdir(parents=True)
 cases,relations=make_cases()
 public=json.dumps(CONTRACTS,indent=2)+'\n';(frozen/'public-contracts.json').write_text(public)
 schema={'type':'object','additionalProperties':False,'properties':{'source':{'type':'string'},'notes':{'type':'string'}},'required':['source','notes']};(frozen/'response.schema.json').write_text(json.dumps(schema,indent=2)+'\n')
 prompts={}
 for task,contract in CONTRACTS.items():
  text=COMMON+'\n'+json.dumps(contract,indent=2)+'\n';(frozen/f'{task}.prompt.txt').write_text(text);prompts[task]=sha(text.encode())
 (frozen/'hidden-cases.json').write_text(json.dumps({'cases':cases,'metamorphic_relations':relations},separators=(',',':'))+'\n')
 binaries=frozen/'cases';binaries.mkdir()
 for c in cases:(binaries/f'{c["id"]}.bin').write_bytes(case_binary(c))
 sources={p.name:sha(p.read_bytes()) for p in HERE.iterdir() if p.is_file() and p.suffix in ('.py','.mjs','.cu')}
 manifest={'schema':'ai-kernel-hidden-freeze-v1','frozen_at':datetime.now(timezone.utc).isoformat(),'model':'gpt-6-astra','reasoning':'low','candidates_per_task':2,'planned_model_calls':6,'call_timeout_seconds':90,'max_model_concurrency':2,'feedback_repairs':0,'public_contract_sha256':sha(public.encode()),'prompt_sha256':prompts,'hidden_generator_sha256':sha(Path(__file__).read_bytes()),'hidden_cases_sha256':sha((frozen/'hidden-cases.json').read_bytes()),'case_counts':{task:sum(c['task']==task for c in cases) for task in CONTRACTS},'metamorphic_relations':len(relations),'binary_sha256':{p.name:sha(p.read_bytes()) for p in sorted(binaries.iterdir())},'sources_sha256':sources,'hidden_boundary':'Cases/oracle/generator are absent from fresh candidate cwd and prompts; tools disabled and transcripts audited. Task contracts are public; this is not a natural-bug holdout.','runtime_budget':{'compile_seconds_per_candidate':90,'functional_seconds_per_candidate':60,'sanitizer_seconds_per_candidate_per_tool':90,'sanitizer_tools':['memcheck','racecheck','initcheck','synccheck']}}
 (frozen/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest,indent=2))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--out',type=Path,default=OUT);a=p.parse_args();freeze(a.out)
