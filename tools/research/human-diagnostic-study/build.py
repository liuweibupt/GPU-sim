#!/usr/bin/env python3
"""Build actual six-root human task preparation; no scoring keys enter the web bundle."""
import argparse,hashlib,json,re
from pathlib import Path
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[2]
sha=lambda raw:hashlib.sha256(raw).hexdigest()
canonical=lambda value:json.dumps(value,sort_keys=True,separators=(',',':')).encode()
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=Path,default=ROOT/'web/research/human-study');p.add_argument('--manifest',type=Path);p.add_argument('--catalog',type=Path,default=ROOT/'out/research/repair-v2-study/frozen/catalog-before.json');a=p.parse_args()
 raw=a.catalog.read_bytes();repair=json.loads(raw);natural=json.loads((ROOT/'tools/research/natural-diagnostic/benchmark-before.json').read_text());data={'format':'human-actual-materials-v2','natural':natural,'repair':repair}
 assert natural['scope']=='before-only' and len(repair['tasks'])==6
 private=json.loads((HERE/'private/executor-map.json').read_text());assert private['catalogSha256']==sha(raw)
 tasks=[];audits=[]
 for family in ['cutlass','tmem']:
  cases=[c for c in natural['cases'] if c['family']==family];sources=[s for s in natural['sources'] if any(s['id'] in c['sourceRefs'] for c in cases)];evidence=[e for e in natural['evidence'] if any(e['id'] in c['evidenceRefs'] for c in cases)]
  tasks.append({'id':'practice-'+family,'rootCauseId':'old-development-'+family,'stage':'practice','adapter':'natural','family':family,'title':'练习 · '+family,'prompt':'体验原始材料与诊断关系入口，引用一个失败和一个通过记录。此题仅熟悉界面，不进入主要评分。','synthetic':False,'developmentCase':True,'usedForToolEvaluation':True,'materialsReviewed':False,'timeLimitSeconds':300,'materialPacketSha256':sha(canonical({'cases':cases,'sources':sources,'evidence':evidence}))})
 for original in repair['tasks']:
  spec=next(s for s in private['tasks'] if s['taskId']==original['id']);key=json.loads((ROOT/spec['rubricPath']).read_text());packet={'cases':original['cases'],'sources':original['files'],'evidence':original['evidence'],'limits':original['limits']};ph=sha(canonical(packet));audit={'taskId':original['id'],'rawPacketSha256':ph,'diagnosticRawPacketSha256':ph,'method':'materialPacket ignores condition; both conditions render identical actual before files and observations. Derived queries alone differ.','expertReview':'pending'};audits.append(audit)
  tasks.append({'id':original['id'],'catalogTaskId':original['id'],'rootCauseId':'main-root-'+str(len(tasks)-1).zfill(2),'stage':'main','adapter':'repair-v2','family':None,'title':original['id'],'prompt':original['objective']+' 请解释故障、定位来源、引用失败与通过对照，并给出可证伪预测。','synthetic':False,'developmentCase':False,'usedForToolEvaluation':True,'toolExposureScope':'Fixed known task pool also used in the agent evaluation; not a new held-out human task corpus.','materialsReviewed':False,'timeLimitSeconds':720,'materialPacketSha256':ph,'rubricSha256':spec['rubricSha256'],'repairHarnessSha256':spec['repairHarnessSha256'],'equalInformationAuditSha256':sha(canonical(audit))})
 manifest=json.loads(a.manifest.read_text()) if a.manifest else {'format':'gpu-human-diagnostic-manifest-v2','protocolVersion':'simple-six-root-immediate-v2','design':'six-fixed-roots-immediate-explanation','status':'actual-materials-ready-review-and-enrollment-pending','preregistration':{'status':'draft-not-registered','frozenSha256':None},'institutionalReview':{'status':'awaiting-local-investigator-determination','applicability':None,'reference':None,'note':'Approval, exemption or not-required with documented local determination; no claim of approval.'},'tasks':tasks}
 manifest['dataSha256']=sha(canonical(data));manifest['catalogSha256']=sha(raw);manifest.pop('manifestSha256',None);manifest['manifestSha256']=sha(canonical(manifest))
 natural_path=ROOT/'lib/research/natural-diagnostic.js';query_path=ROOT/'tools/research/repair-study-v2/query.mjs';natural_js=natural_path.read_text().replace('export function ','function ').replace('export const ','const ');repair_js=re.sub(r'^import .*?;\n','',query_path.read_text(),flags=re.M).replace('export function ','function ').replace('export const ','const ')
 query='const naturalQuery=(()=>{'+natural_js+';return {queryDiagnostic};})();const queryDiagnostic=naturalQuery.queryDiagnostic;const repairQuery=(()=>{const queryDiagnostic=naturalQuery.queryDiagnostic;'+repair_js+';return {rawQuery};})();'
 core=(HERE/'core.mjs').read_text().replace('export function ','function ').replace('export const ','const ')
 encode=lambda value:json.dumps(value,ensure_ascii=False,separators=(',',':')).replace('<','\\u003c').replace('>','\\u003e').replace('&','\\u0026')
 page=(HERE/'study.html').read_text().replace('__STYLE__',(HERE/'study.css').read_text()).replace('__MANIFEST__',encode(manifest)).replace('__DATA__',encode(data)).replace('__QUERY__',query).replace('__CORE__',core).replace('__UI__',(HERE/'study.js').read_text())
 a.output.mkdir(parents=True,exist_ok=True);(a.output/'index.html').write_text(page);(a.output/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n');(a.output/'information-audit.json').write_text(json.dumps({'scope':'Exact raw-material equality, not an expert semantic or usability judgment.','tasks':audits},indent=2)+'\n')
 files=[Path(__file__),HERE/'core.mjs',HERE/'study.html',HERE/'study.css',HERE/'study.js',natural_path,query_path]
 result={'format':'gpu-human-study-render-v2','htmlSha256':sha(page.encode()),'manifestSha256':manifest['manifestSha256'],'dataSha256':manifest['dataSha256'],'catalogSha256':sha(raw),'realMainTasks':6,'realPracticeTasks':2,'syntheticTasks':0,'scope':'Actual before-only six-root materials; zero human observations. Expert review and enrollment pending.','sourceSha256':{str(f.relative_to(ROOT)):sha(f.read_bytes()) for f in files}}
 (a.output/'render-manifest.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
if __name__=='__main__':main()
