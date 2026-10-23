#!/usr/bin/env python3
"""Bind built candidates to bounded Modal jobs; never edits their code or binaries."""
import argparse,hashlib,json,shutil
from pathlib import Path

def main():
 p=argparse.ArgumentParser();p.add_argument('--family',choices=['cutlass','tmem'],required=True);p.add_argument('--output',type=Path,default=Path('out/research/natural-repair-eval'));a=p.parse_args();root=a.output.resolve();dest=root/'runtime-jobs'/a.family;dest.mkdir(parents=True,exist_ok=False)
 candidates=[];groups={}
 for directory in sorted((root/'builds').glob(a.family+'.*')):
  r=json.loads((directory/'result.json').read_text())
  if r['status']!='built':continue
  key=r['candidate_sha256']
  if key in groups:groups[key]['trial_ids'].append(directory.name);continue
  row={'id':directory.name,'trial_ids':[directory.name],'build_result':str(directory/'result.json'),'candidate_source_sha256':key,'artifacts':r['artifacts']};groups[key]=row;candidates.append(row)
 hidden=root/'hidden-v1';sources=[str(Path('tools/research/natural-repair-eval/hidden_gpu.py').resolve()),str(hidden/'plan.json')]
 if a.family=='tmem':sources += [str(p) for p in sorted(hidden.glob('regression_*.py'))]
 jobs=[]
 for n in range(0,len(candidates),2):
  batch=candidates[n:n+2];job={'sources':list(sources),'commands':[{'name':'identity','argv':['nvidia-smi','--query-gpu=name,compute_cap,driver_version','--format=csv,noheader'],'timeout':10}],'artifact_patterns':[]}
  if a.family=='tmem':
   old=json.loads(Path('out/research/natural-bugs/tmem/job-pair-v2.json').read_text());job.update(cpu=8,memory_mb=16384,image={k:v for k,v in old['image'].items() if k!='files'});job['image']['files']=[]
  for row in batch:
   name=row['id'];art=row['artifacts']
   if a.family=='cutlass':
    source=Path(row['build_result']).parent/art['binary']['path'];target=dest/(name+'.bin');shutil.copyfile(source,target)
    if hashlib.sha256(target.read_bytes()).hexdigest()!=art['binary']['sha256']:raise ValueError('binary changed')
    job['sources'].append(str(target));job['commands'].append({'name':name,'argv':['python','hidden_gpu.py','--family','cutlass','--plan','plan.json','--output',name,'--binary',target.name],'timeout':240,'continue_on_failure':True});job['artifact_patterns'].append(name+'/**/*')
   else:
    wheel=Path(row['build_result']).parent/art['wheel']['path'];remote='/opt/candidates/'+name+'/'+wheel.name
    if hashlib.sha256(wheel.read_bytes()).hexdigest()!=art['wheel']['sha256']:raise ValueError('wheel changed')
    job['image']['files'].append({'local':str(wheel),'remote':remote})
    job['commands'] += [{'name':'install-'+name,'argv':['/opt/repro/bin/python','-m','pip','install','--no-deps','--force-reinstall','--no-compile',remote],'timeout':90},{'name':name,'argv':['/opt/repro/bin/python','hidden_gpu.py','--family','tmem','--plan','plan.json','--output',name,'--native-sha256',art['link_native']['sha256']],'timeout':180,'continue_on_failure':True}]
    job['artifact_patterns'] += [name+'/summary.json',name+'/case-*.json.gz',name+'/compiler/**/*']
  file=dest/f'job-{n//2}.json';file.write_text(json.dumps(job,indent=2)+'\n');jobs.append({'path':str(file),'candidates':batch})
 (dest/'manifest.json').write_text(json.dumps({'family':a.family,'jobs':jobs,'unique_sources':len(candidates),'trials':sum(len(x['trial_ids']) for x in candidates)},indent=2)+'\n');print(json.dumps({'family':a.family,'jobs':[j['path'] for j in jobs],'unique_sources':len(candidates)}))
if __name__=='__main__':main()
