#!/usr/bin/env python3
"""Wait for every frozen model trial, verify freezes, then run Triton candidates once.
This orchestrator never prompts a model, changes a candidate, or retries a failure.
"""
import collections,datetime,hashlib,json,pathlib,subprocess,sys,time,traceback
ROOT=pathlib.Path('/home/liuwei/GPU-sim');BASE=ROOT/'out/research/natural-fault-expansion';STUDY=ROOT/'out/research/repair-v2-study'
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def save(name,d):(BASE/name).write_text(json.dumps(d,indent=2)+'\n')
def freezes():
 checked=[]
 for name in ['repair-v2-tools-frozen','repair-v2-runtime-frozen']:
  d=ROOT/'out/research'/name;m=json.loads((d/'manifest.json').read_text());files=m['sources'].items()if'sources'in m else[(x['path'],x['sha256'])for x in m['files']]
  for p,h in files:
   assert sha(ROOT/p)==h,'live frozen source differs: '+p
   assert sha(d/'source'/p)==h,'frozen snapshot differs: '+p
   checked.append({'path':p,'sha256':h})
  checked.append({'path':str((d/'manifest.json').relative_to(ROOT)),'sha256':sha(d/'manifest.json')})
 d=STUDY/'frozen';m=json.loads((d/'manifest.json').read_text())
 for p,h in m['files'].items():assert sha(d/p)==h,'study frozen file differs: '+p
 return checked

def main():
 schedule=json.loads((STUDY/'frozen/schedule.json').read_text());assert len(schedule)==36 and len({x['id']for x in schedule})==36
 started=now();last=-1;deadline=time.monotonic()+7200
 while True:
  done=[]
  for t in schedule:
   p=STUDY/'trials'/t['id']/'result.json'
   try:d=json.loads(p.read_text())
   except (FileNotFoundError,json.JSONDecodeError):continue
   if not d.get('finishedAt'):continue
   assert d['id']==t['id']and d['taskId']==t['taskId'];datetime.datetime.fromisoformat(d['finishedAt'].replace('Z','+00:00'))
   done.append({'id':t['id'],'finishedAt':d['finishedAt'],'result_sha256':sha(p)})
  if len(done)!=last:print(now(),'generation finished',len(done),'/36',flush=True);last=len(done)
  if len(done)==36:break
  if time.monotonic()>deadline:raise TimeoutError('All-generation gate exceeded two hours; no GPU candidates executed')
  time.sleep(15)
 frozen=freezes();allfinished=max(x['finishedAt']for x in done);gate={'schema':'triton-all-generation-gate-v1','gateStartedAt':started,'allGenerationFinishedAt':allfinished,'gatePassedAt':now(),'scheduledTrials':36,'finishedTrials':done,'frozenFilesVerified':frozen,'rule':'All 36 final result.json files existed and had finishedAt before any candidate execution; no feedback to model generation.'};save('generation-gate.json',gate)
 trials=[x for x in schedule if x['taskId'].startswith('triton-')];assert len(trials)==18
 batch={'schema':'triton-physical-candidate-batch-v1','startedAt':now(),'gate_receipt_sha256':sha(BASE/'generation-gate.json'),'allGenerationFinishedAt':allfinished,'maxConcurrentCandidateRunners':1,'rows':[],'scope':'Correctness only. Root may run independent Liger kernels concurrently; no timing speedup inference.'};save('candidate-batch.json',batch)
 for t in trials:
  folder=STUDY/'trials'/t['id'];result=json.loads((folder/'result.json').read_text());candidate=folder/'candidate.json';row={**t,'generation_result_sha256':sha(folder/'result.json'),'startedAt':now(),'status':'not-executed'}
  if not candidate.exists()or not result.get('patchApplicable'):
   row['reason']='No applicable candidate from frozen model output';row['finishedAt']=now();batch['rows'].append(row);save('candidate-batch.json',batch);continue
  c=json.loads(candidate.read_text());assert c['candidateTreeSHA256']==result['candidateTreeSHA256'];row['candidateTreeSHA256']=c['candidateTreeSHA256'];row['candidate_json_sha256']=sha(candidate)
  if 'firstGPUCandidateStartedAt'not in batch:
   batch['firstGPUCandidateStartedAt']=now();gate['firstGPUCandidateStartedAt']=batch['firstGPUCandidateStartedAt'];assert datetime.datetime.fromisoformat(batch['firstGPUCandidateStartedAt'])>datetime.datetime.fromisoformat(allfinished.replace('Z','+00:00'));save('generation-gate.json',gate);batch['gate_receipt_sha256']=sha(BASE/'generation-gate.json')
  out=BASE/'candidate-evaluations'/t['id'];assert not out.exists(),'Refuse replay/overwrite of a candidate';command=[sys.executable,str(ROOT/'tools/research/natural-fault-expansion/evaluate_candidate.py'),'--candidate',str(candidate),'--output',str(out)];print(now(),'evaluate',t['id'],flush=True)
  try:
   proc=subprocess.run(command,cwd=ROOT,capture_output=True,text=True,timeout=240);out.mkdir(exist_ok=True,parents=True);(out/'orchestrator-stdout.log').write_text(proc.stdout);(out/'orchestrator-stderr.log').write_text(proc.stderr);row['process_exit_code']=proc.returncode
   rp=out/'runtime-record.json'
   if rp.exists():
    r=json.loads(rp.read_text());row.update(status='executed',runtime_record=str(rp.relative_to(ROOT)),runtime_record_sha256=sha(rp),buildStatus=r['buildStatus'],verifierStatus=r['verifierStatus'],hiddenPassed=sum(x['status']=='passed'for x in r['cases']),hiddenExpected=8,hiddenSuccess=r['buildStatus']=='passed'and r['verifierStatus']=='verified'and len(r['cases'])==8 and all(x['status']=='passed'for x in r['cases']),allCasesSuccess=r['buildStatus']=='passed'and r['verifierStatus']=='verified'and r.get('allCaseCount')==11 and all(x['status']=='passed'for x in r['cases']+r.get('visibleCases',[])))
    vp=out/'independent-verification.json'
    if vp.exists():
     v=json.loads(vp.read_text());row['attempted_case_count']=len(v['cases']);row['completed_device_case_count']=sum(x['status']in('passed','wrong_value')for x in v['cases']);row['output_elements']=v['total_elements'];row['wrong_elements']=v['wrong_elements']
   else:row.update(status='evaluator-failed',reason='No runtime receipt; failure retained without retry')
  except subprocess.TimeoutExpired as e:
   out.mkdir(exist_ok=True,parents=True);(out/'orchestrator-stdout.log').write_bytes(e.stdout or b'');(out/'orchestrator-stderr.log').write_bytes(e.stderr or b'');row.update(status='evaluator-timeout',reason='240 second orchestration limit; no retry')
  row['finishedAt']=now();batch['rows'].append(row);save('candidate-batch.json',batch);print(now(),'result',t['id'],row['status'],row.get('hiddenPassed'),flush=True)
 batch['finishedAt']=now();batch['frozenFilesVerifiedAfterExecution']=freezes();batch['total_completed_device_cases']=sum(x.get('completed_device_case_count',0)for x in batch['rows']);batch['total_output_elements']=sum(x.get('output_elements',0)for x in batch['rows']);batch['cells']=[{'taskId':tid,'condition':condition,'trials':3,'hidden_success':sum(x.get('hiddenSuccess',False)for x in batch['rows']if x['taskId']==tid and x['condition']==condition),'all_cases_success':sum(x.get('allCasesSuccess',False)for x in batch['rows']if x['taskId']==tid and x['condition']==condition)}for tid in sorted({x['taskId']for x in trials})for condition in('raw','diagnostic')];save('candidate-batch.json',batch)
 print(json.dumps({k:batch[k]for k in('finishedAt','cells','total_completed_device_cases','total_output_elements')},indent=2),flush=True)
 publication=BASE/'publication-final';subprocess.run([sys.executable,str(ROOT/'tools/research/natural-fault-expansion/publish.py'),'--output',str(publication)],check=True,cwd=ROOT)
 subprocess.run([sys.executable,str(publication/'reproduction/publish.py'),'--verify-package',str(publication),'--receipt',str(BASE/'offline-final-verification.json')],check=True,cwd=ROOT,stdout=(BASE/'offline-final-verification.log').open('w'))
 print(now(),'publication and offline re-verification complete',flush=True)
if __name__=='__main__':
 try:main()
 except Exception:
  save('candidate-gate-error.json',{'time':now(),'traceback':traceback.format_exc()});raise
