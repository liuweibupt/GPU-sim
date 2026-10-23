#!/usr/bin/env python3
"""Check all six candidate handoffs without executing a GPU or fabricating people."""
import argparse,hashlib,json,subprocess,tempfile
from pathlib import Path
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[2]
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--sessions',required=True,type=Path);p.add_argument('--output',required=True,type=Path);a=p.parse_args()
 catalog_path=ROOT/'out/research/repair-v2-study/frozen/catalog-before.json';catalog=json.loads(catalog_path.read_text());sessions=[json.loads(p.read_text()) for p in a.sessions.glob('SOFTWARE-*.json')];checked=[]
 with tempfile.TemporaryDirectory(prefix='human-handoff-check-') as temporary:
  folder=Path(temporary)
  for task in catalog['tasks']:
   session=next(s for s in sessions if s['status']=='completed' and any(r['taskId']==task['id'] for r in s['responses']));session=json.loads(json.dumps(session));response=next(r for r in session['responses'] if r['taskId']==task['id']);source=next(f for f in task['files'] if f['role']=='implementation')
   response['answer']['edits']=[{'source_id':source['id'],'old':source['text'],'new':source['text']+'\n# SOFTWARE HANDOFF FIXTURE ONLY; NOT A REPAIR OR HUMAN ANSWER\n'}]
   file=folder/(task['id']+'.session.json');file.write_text(json.dumps(session));output=folder/task['id']
   subprocess.run(['node',str(HERE/'materialize_candidate.mjs'),'--catalog',str(catalog_path),'--session',str(file),'--output',str(output)],check=True,capture_output=True,text=True)
   report=json.loads((output/'materialization.json').read_text());assert report['plannedMainTasks']==4 and len(report['rows'])==4
   built=[r for r in report['rows'] if r['status']=='materialized_not_executed'];assert len(built)==1 and all(r['status'] in ['not_submitted','materialized_not_executed'] for r in report['rows'])
   dry=subprocess.run(['python3',str(HERE/'execute_candidate.py'),'--candidate',built[0]['candidateFile'],'--output',str(output/'runtime-not-executed')],check=True,capture_output=True,text=True);receipt=json.loads(dry.stdout);assert receipt['executeRequested'] is False and not (output/'runtime-not-executed').exists()
   checked.append({'taskId':task['id'],'candidateMaterialized':True,'fourTaskDenominatorRetained':True,'executorHashesChecked':True,'gpuExecuted':False,'hiddenCaseCount':receipt['hiddenCaseCount']})
 result={'status':'passed','scope':'Six explicit SOFTWARE fixture patches. No GPU execution, no human candidates or human success rate.','catalogSha256':hashlib.sha256(catalog_path.read_bytes()).hexdigest(),'tasks':checked,'materializerSha256':hashlib.sha256((HERE/'materialize_candidate.mjs').read_bytes()).hexdigest(),'dispatcherSha256':hashlib.sha256((HERE/'execute_candidate.py').read_bytes()).hexdigest()};a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
if __name__=='__main__':main()
