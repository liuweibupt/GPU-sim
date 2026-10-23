#!/usr/bin/env python3
"""Compile exact model candidates and independently grade hidden output bytes."""
import argparse, hashlib, importlib.util, json, math, os, re, signal, struct, subprocess, time
from datetime import datetime,timezone
from pathlib import Path
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('kernel_freeze',HERE/'freeze.py');F=importlib.util.module_from_spec(spec);spec.loader.exec_module(F)
NVCC='/usr/local/cuda-12.6/bin/nvcc';SANITIZER='/usr/local/cuda-13.1/bin/compute-sanitizer'

def command(argv,directory,name,timeout):
 directory.mkdir(parents=True,exist_ok=True);start=time.monotonic();p=subprocess.Popen([str(x) for x in argv],stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
 timed_out=False
 try:stdout,stderr=p.communicate(timeout=timeout)
 except subprocess.TimeoutExpired:
  timed_out=True;os.killpg(p.pid,signal.SIGKILL);stdout,stderr=p.communicate()
 (directory/(name+'.stdout.txt')).write_bytes(stdout);(directory/(name+'.stderr.txt')).write_bytes(stderr)
 result={'argv':[str(x) for x in argv],'started_utc':datetime.now(timezone.utc).isoformat(),'elapsed_seconds':time.monotonic()-start,'exit_code':p.returncode,'timed_out':timed_out,'stdout_sha256':F.sha(stdout),'stderr_sha256':F.sha(stderr)}
 (directory/(name+'.command.json')).write_text(json.dumps(result,indent=2)+'\n');return result

def verify(out):
 frozen=out/'frozen';m=json.loads((frozen/'manifest.json').read_text());hidden=(frozen/'hidden-cases.json').read_bytes()
 if F.sha(hidden)!=m['hidden_cases_sha256'] or F.sha((HERE/'freeze.py').read_bytes())!=m['hidden_generator_sha256']:raise ValueError('Hidden freeze changed')
 for name,digest in m['binary_sha256'].items():
  if F.sha((frozen/'cases'/name).read_bytes())!=digest:raise ValueError('Hidden binary changed')
 generation=json.loads((out/'generation-summary.json').read_text())
 for candidate in generation['results']:
  if candidate['sourceSHA256'] and F.sha((out/'candidates'/candidate['id']/'candidate.cu').read_bytes())!=candidate['sourceSHA256']:raise ValueError('Candidate source modified')
  if candidate['startedAt']<=m['frozen_at']:raise ValueError('Generation did not follow freeze')
 return m,json.loads(hidden),generation

def expected_buffers(case):
 d=case['params'];integer=case['task']=='segments';outcount=d['segments'] if integer else (d['rows'] if case['task']=='rmsnorm' else d['cols'])*d['ys'];item=8 if integer else 4
 pattern=struct.pack('<q',F.INT_SENTINEL) if integer else struct.pack('<f',F.FLOAT_SENTINEL)
 y=bytearray(pattern*(outcount+2*F.GUARD));p=struct.pack('<i',0x13579bdf)
 x=p*F.GUARD+F.bytes4(case['input'],integer)+p*F.GUARD;offs=p*F.GUARD+F.bytes4(case['offsets'],True)+p*F.GUARD
 return y,x,offs,item

def grade_bytes(case,actual):
 y,x,offs,item=expected_buffers(case);expected_length=len(y)+len(x)+len(offs)
 if len(actual)!=expected_length:return {'passed':False,'error':'output-binary-size','expected_bytes':expected_length,'actual_bytes':len(actual)},[]
 actual_y=actual[:len(y)];actual_x=actual[len(y):len(y)+len(x)];actual_offsets=actual[len(y)+len(x):]
 values=[];mismatches=[];max_abs=0.;logical=set()
 for logical_index,(i,expected) in enumerate(zip(case['output_indices'],case['expected'])):
  position=(i+F.GUARD)*item;logical.update(range(position,position+item));raw=actual_y[position:position+item];value=struct.unpack('<q' if item==8 else '<f',raw)[0];values.append(value)
  error=abs(value-expected);max_abs=max(max_abs,error) if math.isfinite(error) else float('inf')
  if case['task']=='rmsnorm':good=math.isfinite(value) and error<=2e-5+2e-4*abs(expected)
  else:good=raw==struct.pack('<q' if item==8 else '<f',expected)
  if not good:mismatches.append({'logical_index':logical_index,'storage_index':i,'expected':expected,'actual':value})
 padding_errors=sum(a!=b for i,(a,b) in enumerate(zip(actual_y,y)) if i not in logical)
 result={'passed':not mismatches and padding_errors==0 and actual_x==x and actual_offsets==offs,'logical_elements':len(values),'numerical_mismatches':len(mismatches),'max_abs_error':max_abs if math.isfinite(max_abs) else 'nonfinite','output_guard_or_padding_changed_bytes':padding_errors,'input_preserved':actual_x==x,'offsets_preserved':actual_offsets==offs,'first_mismatches':mismatches[:5]}
 return result,values

def grade_directory(hidden,task,directory):
 results=[];values={}
 for case in hidden['cases']:
  if case['task']!=task:continue
  p=directory/(case['id']+'.actual.bin')
  if not p.exists():result={'passed':False,'error':'missing-output'}
  else:result,values[case['id']]=grade_bytes(case,p.read_bytes())
  results.append({'case':case['id'],**result})
 relations=[]
 for r in hidden['metamorphic_relations']:
  if r['task']!=task:continue
  a,b=values.get(r['base']),values.get(r['derived']);errors=0
  if a is None or b is None or len(a)!=len(b):errors=-1
  else:
   for x,y in zip(a,b):
    wanted=-x if r['kind']=='negate' else x
    if task=='rmsnorm':good=math.isfinite(y) and math.isfinite(wanted) and abs(y-wanted)<=4e-5+4e-4*abs(wanted)
    elif task=='transpose':good=struct.pack('<f',y)==struct.pack('<f',wanted)
    else:good=y==wanted
    errors+=not good
  relations.append({**r,'passed':errors==0,'mismatches':errors})
 return {'passed':all(r['passed'] for r in results+relations),'cases':results,'metamorphic':relations,'elements_checked':sum(r.get('logical_elements',0) for r in results)}

def compile_all(out):
 manifest,hidden,generation=verify(out);rows=[]
 command([NVCC,'--version'],out,'nvcc-version',10)
 for c in generation['results']:
  directory=out/'candidates'/c['id'];row={'candidate':c['id'],'task':c['task'],'generation_valid':c['valid'],'source_sha256':c['sourceSHA256'],'harness_sha256':F.sha((HERE/'harness.cu').read_bytes())}
  if not c['valid']:row['stage']='generation_failed';rows.append(row);continue
  text=(directory/'candidate.cu').read_text();forbidden=re.findall(r'\b(?:cudaMalloc\w*|cudaFree\w*|cudaMemcpy\w*|cudaDeviceSynchronize|system|popen|fopen|fstream|ifstream|ofstream)\b',text)
  row['forbidden_host_api_mentions']=forbidden
  if forbidden:row['stage']='interface_policy_failed';rows.append(row);continue
  argv=[NVCC,'-std=c++17','-O2','-lineinfo','-arch=sm_89',f'-DTASK_ID={F.CONTRACTS[c["task"]]["task_id"]}',HERE/'harness.cu',directory/'candidate.cu','-o',directory/'candidate-runner']
  result=command(argv,directory,'compile',90);row['compile']=result;row['stage']='compiled' if result['exit_code']==0 and not result['timed_out'] else 'compile_failed'
  if row['stage']=='compiled':row['binary_sha256']=F.sha((directory/'candidate-runner').read_bytes())
  rows.append(row);print(json.dumps({'candidate':c['id'],'stage':row['stage']}),flush=True)
 (out/'compile-summary.json').write_text(json.dumps({'candidates':rows},indent=2)+'\n')

def run_all(out):
 manifest,hidden,generation=verify(out);compiled=json.loads((out/'compile-summary.json').read_text());rows=[]
 if (out/'evaluation-summary.json').exists():raise ValueError('Refusing to overwrite GPU evaluation')
 command(['nvidia-smi','--query-gpu=name,compute_cap,driver_version,utilization.gpu,memory.used','--format=csv,noheader'],out,'gpu-before',10)
 command(['nvidia-smi','--query-compute-apps=pid,used_memory','--format=csv,noheader'],out,'gpu-processes-before',10)
 command([SANITIZER,'--version'],out,'sanitizer-version',10)
 for c in compiled['candidates']:
  row=dict(c);row['functional']=[];row['sanitizers']=[];directory=out/'candidates'/c['candidate'];cases=[out/'frozen/cases'/(x['id']+'.bin') for x in hidden['cases'] if x['task']==c['task']]
  if c['stage']!='compiled':rows.append(row);continue
  executable=directory/'candidate-runner'
  if F.sha(executable.read_bytes())!=c['binary_sha256']:raise ValueError('Compiled binary changed')
  for repeat in (1,2):
   actual=directory/f'functional-r{repeat}';cmd=command([executable,actual,*cases],directory,f'functional-r{repeat}',60);score=grade_directory(hidden,c['task'],actual);row['functional'].append({'repeat':repeat,'command':cmd,**score})
   print(json.dumps({'candidate':c['candidate'],'phase':f'functional-{repeat}','passed':score['passed'],'exit':cmd['exit_code']}),flush=True)
  for tool in manifest['runtime_budget']['sanitizer_tools']:
   actual=directory/('sanitizer-'+tool);log=directory/('sanitizer-'+tool+'.log')
   cmd=command([SANITIZER,'--tool',tool,'--error-exitcode','86','--log-file',log,executable,actual,*cases],directory,'sanitizer-'+tool,90)
   text=log.read_text() if log.exists() else '';reported_zero=bool(re.search(r'ERROR SUMMARY: 0 errors',text) or re.search(r'RACECHECK SUMMARY: 0 hazards',text))
   score=grade_directory(hidden,c['task'],actual);row['sanitizers'].append({'tool':tool,'command':cmd,'zero_error_summary':reported_zero,'log_sha256':F.sha(text.encode()),'passed':cmd['exit_code']==0 and reported_zero and score['passed'],'output_checks':score})
   print(json.dumps({'candidate':c['candidate'],'phase':tool,'passed':row['sanitizers'][-1]['passed'],'exit':cmd['exit_code']}),flush=True)
  row['passed']=all(r['passed'] and r['command']['exit_code']==0 for r in row['functional']) and all(r['passed'] for r in row['sanitizers']);rows.append(row)
  (out/'evaluation-progress.json').write_text(json.dumps({'candidates':rows},indent=2)+'\n')
 result={'schema':'ai-cuda-hidden-evaluation-v1','completed_utc':datetime.now(timezone.utc).isoformat(),'hidden_cases_sha256':manifest['hidden_cases_sha256'],'candidate_count':len(rows),'pass_count':sum(c.get('passed',False) for c in rows),'candidates':rows,'scope':'Functional/guard/metamorphic/sanitizer evaluation only; no GPU performance, natural-bug discovery, human-replacement, or independent-model claim.'}
 (out/'evaluation-summary.json').write_text(json.dumps(result,indent=2)+'\n');command(['nvidia-smi','--query-compute-apps=pid,used_memory','--format=csv,noheader'],out,'gpu-processes-after',10)

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('mode',choices=['compile','run']);p.add_argument('--out',type=Path,default=F.OUT);a=p.parse_args();(compile_all if a.mode=='compile' else run_all)(a.out.resolve())
