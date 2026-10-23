import concurrent.futures
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time

REPO = Path('/home/liuwei/GPU-sim')
ROOT = REPO/'out/research/natural-repair-eval'
EXECUTOR = REPO/'tools/research/natural-repair-eval/execute_repairs.py'
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
snapshot=json.loads((ROOT/'executor-source-snapshot/manifest.json').read_text())
expected=next(x['sha256'] for x in snapshot['files'] if x['path']=='execute_repairs.py')
print(json.dumps({'phase':'waiting_for_all_generation','utc':datetime.now(timezone.utc).isoformat()}),flush=True)
while True:
    try:
        generation=json.loads((ROOT/'generation-summary.json').read_text())
        if generation.get('completedTrials')==12: break
    except (FileNotFoundError,json.JSONDecodeError): pass
    time.sleep(5)
if sha(EXECUTOR)!=expected: raise ValueError('Executor changed after source snapshot')
started=datetime.now(timezone.utc).isoformat()
spec=importlib.util.spec_from_file_location('executor',EXECUTOR); module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
tasks={x['family']:x for x in json.loads((ROOT/'frozen/tasks.json').read_text())}
trials=[f'{family}.{condition}.r{rep}' for family in ['cutlass','tmem'] for condition in ['diagnostic','raw'] for rep in [1,2,3]]
groups={};invalid=[]
for trial in trials:
    family=trial.split('.')[0];task=tasks[family];answer=ROOT/'trials'/trial/'answer.json'
    try:
        source=(ROOT/'frozen'/task['sourceFile']).read_text()
        if hashlib.sha256(source.encode()).hexdigest()!=task['sourceSHA256']:raise ValueError('Frozen source changed')
        candidate,_=module.apply_edits(source,json.loads(answer.read_text())['edits'])
        key=(family,hashlib.sha256(candidate.encode()).hexdigest())
        groups.setdefault(key,[]).append(trial)
    except Exception as error:
        invalid.append(trial)

def execute(trial,reuse=None):
    if sha(EXECUTOR)!=expected: raise ValueError('Executor changed during build run')
    family=trial.split('.')[0];task=tasks[family];answer=ROOT/'trials'/trial/'answer.json';output=ROOT/'builds'/trial
    argv=[sys.executable,str(EXECUTOR),'--family',family,'--answer',str(answer),'--output',str(output),
          '--before-source',str(ROOT/'frozen'/task['sourceFile']),'--expected-before-sha256',task['sourceSHA256']]
    if reuse: argv+=['--reuse',str(ROOT/'builds'/reuse)]
    if not answer.exists():
        output.mkdir(parents=True,exist_ok=False)
        result={'schema':'natural-agent-repair-build-v1','family':family,'status':'no_answer','gpu_executed':False,
                'source_dependency_audit':[],'error':'No original candidate answer was produced; no replacement fabricated.'}
        (output/'result.json').write_text(json.dumps(result,indent=2)+'\n');exit_code=1
    else:
        logs=ROOT/'build-logs';logs.mkdir(exist_ok=True)
        with (logs/(trial+'.stdout.txt')).open('wb') as stdout,(logs/(trial+'.stderr.txt')).open('wb') as stderr:
            proc=subprocess.run(argv,cwd=REPO,stdout=stdout,stderr=stderr)
        exit_code=proc.returncode;result=json.loads((output/'result.json').read_text())
    row={'trial':trial,'argv':argv,'exit_code':exit_code,'status':result['status'],'candidate_sha256':result.get('candidate_sha256'),
         'cpu_validation':result.get('cpu_validation'),'reused_from':reuse,'result_sha256':sha(output/'result.json')}
    print(json.dumps(row),flush=True);return row

results=[]; representatives=[values[0] for values in groups.values()]+invalid
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    futures={trial:pool.submit(execute,trial) for trial in representatives}
    for trial in representatives:results.append(futures[trial].result())
for values in groups.values():
    first=values[0];built=next(x for x in results if x['trial']==first)['status']=='built'
    for trial in values[1:]:results.append(execute(trial,first if built else None))
results.sort(key=lambda x:trials.index(x['trial']))
summary={'schema':'natural-agent-repair-build-batch-v1','started_utc':started,'finished_utc':datetime.now(timezone.utc).isoformat(),
         'generation_summary_sha256_at_start':hashlib.sha256(json.dumps(generation,sort_keys=True).encode()).hexdigest(),
         'executor_sha256':expected,'max_cpu_parallelism':2,'ordering':trials,'results':results,
         'counts':{'trials':len(results),'unique_valid_candidate_sources':len(groups),'built':sum(x['status']=='built' for x in results)},
         'scope':'All agent generation completed before any patch checking or compilation; no manual edits and no GPU execution.'}
(ROOT/'build-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary['counts']),flush=True)
