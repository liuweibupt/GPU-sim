#!/usr/bin/env python3
"""Recompute repair success from retained complete bytes and frozen input contracts."""
import argparse,gzip,hashlib,importlib.util,json,tempfile
from pathlib import Path

def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def load(p):return json.loads(Path(p).read_text())
def verify_cutlass(root,plan_path):
 spec=importlib.util.spec_from_file_location('legacy',Path(__file__).resolve().parent.parent/'natural-bugs/cutlass_verify.py');M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)
 plan=load(plan_path);summary=load(root/'summary.json')
 if summary['plan_sha256']!=sha(plan_path):raise ValueError('plan identity changed')
 expected=plan['cutlass'];records=summary['records'];seen=set();passed=[];counts={}
 with tempfile.TemporaryDirectory(prefix='retained-repair-oracle-') as temp:
  dest=Path(temp);matrix=[];adapted=[]
  for r in records:
   index=int(r['id'].removeprefix('case-'));case=expected[index]
   if index in seen or any(r.get(k)!=v for k,v in case.items()):raise ValueError('case duplicate or contract changed')
   seen.add(index)
   if load(root/r['id']/'record.json')!=r:raise ValueError('record copies differ')
   c={**case,'variant':'candidate','beta':0};matrix.append(c)
   s={**r,**c,'outputs_checked':r['outputs'],'mismatches':sum(g['mismatches'] for g in r['groups']),'zero_k_mismatches':sum(g['zero_k_mismatches'] for g in r['groups']),'result':'passed' if r['passed'] else 'timeout' if r['timed_out'] else 'execution_error'}
   d=dest/r['id'];d.mkdir()
   for e in r['files']:
    if Path(e['path']).name!=e['path']:raise ValueError('invalid artifact path')
    (d/e['path']).symlink_to((root/r['id']/e['path']).resolve())
   (d/'record.json').write_text(json.dumps(s));adapted.append(s)
   # A nominal failure is not upgraded to success from partial valid output.
   passed.append({'id':r['id'],'partition':case['partition'],'passed':r['passed'],'timed_out':r['timed_out'],'outputs':r['outputs']})
  (dest/'matrix.json').write_text(json.dumps({'matrix':matrix}));(dest/'results.json').write_text(json.dumps({'matrix_sha256':sha(dest/'matrix.json'),'records':adapted}));counts=M.verify(dest)
 for i,c in enumerate(expected):
  if i not in seen:passed.append({'id':f'case-{i:02d}','partition':c['partition'],'passed':False,'missing':True})
 return {'family':'cutlass','status':'verified','expected_cases':len(expected),'completed_cases':len(seen),'passed_cases':sum(r['passed'] for r in passed),'all_passed':len(seen)==len(expected) and all(r['passed'] for r in passed),'cases':passed,'full_byte_verification':counts,'binary_sha256':summary['binary_sha256']}

def verify_tmem(root,plan_path):
 plan=load(plan_path);summary=load(root/'summary.json');expected=plan['tmem']
 if summary['plan_sha256']!=sha(plan_path):raise ValueError('plan identity changed')
 cases=[];seen=set();elements=errors=0
 for row in summary['records']:
  index=int(row['id'].removeprefix('case-'));case=expected[index]
  if index in seen:raise ValueError('duplicate case')
  seen.add(index);entry=row['artifact'];p=root/entry['path']
  if p.name!=entry['path'] or sha(p)!=entry['sha256']:raise ValueError('artifact changed')
  raw=gzip.decompress(p.read_bytes())
  if hashlib.sha256(raw).hexdigest()!=entry['original_sha256']:raise ValueError('decoded artifact changed')
  record=json.loads(raw)
  if record['id']!=row['id'] or any(record.get(k)!=v for k,v in case.items()):raise ValueError('case contract changed')
  params=case['parameters'];first,second,temp=case['constants'];mode=params['mode'];choice=params['choice']
  use_first={'first':True,'second':False,'select':bool(choice),'chain':choice==params['outer_choice']}[mode]
  oracle=[('selected',4096,first if use_first else second)]
  if params['columns']:oracle.append(('temporary',128*params['columns'],temp))
  outputs=record['outputs'];complete=len(outputs)==len(oracle);numeric=True;ne=nm=0
  for output,(name,size,value) in zip(outputs,oracle):
   if output['name']!=name or output['expected']!=value or len(output['actual'])!=size:raise ValueError('output contract/length changed')
   wrong=sum(v!=value for v in output['actual'])
   if wrong!=output['mismatches']:raise ValueError('wrong mismatch count')
   numeric &= wrong==0;ne+=size;nm+=wrong
  good=complete and numeric and record['call_passed'] is True and 'observation_error' not in record
  if good!=record['passed'] or good!=row['passed'] or ne!=row['elements'] or nm!=row['mismatches']:raise ValueError('stored result disagrees with full output')
  elements+=ne;errors+=nm;cases.append({'id':row['id'],'partition':case['partition'],'passed':good,'elements':ne,'mismatches':nm})
 for i,c in enumerate(expected):
  if i not in seen:cases.append({'id':f'case-{i:02d}','partition':c['partition'],'passed':False,'missing':True})
 return {'family':'tmem','status':'verified','expected_cases':len(expected),'completed_cases':len(seen),'passed_cases':sum(r['passed'] for r in cases),'all_passed':len(seen)==len(expected) and all(r['passed'] for r in cases),'cases':cases,'elements':elements,'mismatches':errors,'native_sha256':summary['native_sha256']}

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--family',choices=['cutlass','tmem'],required=True);p.add_argument('--input',type=Path,required=True);p.add_argument('--plan',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();r=(verify_cutlass if a.family=='cutlass' else verify_tmem)(a.input,a.plan);r.update(plan_sha256=sha(a.plan),summary_sha256=sha(a.input/'summary.json'),verifier_sha256=sha(__file__));a.output.write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({k:v for k,v in r.items() if k not in ['cases','full_byte_verification']}))
