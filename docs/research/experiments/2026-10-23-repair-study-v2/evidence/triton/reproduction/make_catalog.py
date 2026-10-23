#!/usr/bin/env python3
"""Create model-visible before-only source/observation catalog and separate scoring plan."""
import ast,hashlib,json,pathlib
ROOT=pathlib.Path(__file__).resolve().parents[3];OUT=ROOT/'out/research/natural-fault-expansion'
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def main():
 manifest=json.loads((OUT/'manifest.json').read_text());plan=json.loads((OUT/'plan.json').read_text());harness=(ROOT/'tools/research/natural-fault-expansion/run.py').read_text();h_ast=ast.parse(harness)
 cat={'format':'repair-study-catalog-v2','tasks':[]};private={'format':'repair-study-private-v2','tasks':[]}
 specs={'softmax-axis':('triton/language/standard.py','softmax','softmax_kernel','Repair incorrect softmax results while preserving the input shape and normalizing along the requested axis. Inputs are finite contiguous float32 arrays; compare with a float64 CPU stable softmax rounded to float32 at atol 1e-6, rtol 1e-5.'),'negative-zero':('triton/language/semantic.py','scalar_constant','constant_kernel','Repair scalar-constant construction so IEEE floating-point signed zero is preserved, while positive zero and nonzero constants remain correct. Exact output bytes are the contract for float16, bfloat16, float32 and float64.'),'constexpr-filter':('triton/compiler/code_generator.py','visit_ListComp','filter_kernel','Repair constexpr list comprehension semantics: every if predicate filters entries in original order and multiple predicates combine by AND. The device result begins with count, followed by accepted integers and unchanged sentinel -777 for unused capacity. Exact integer equality is required.')}
 for family,(target,fn,kernel,objective) in specs.items():
  files=[]
  for idx,p in enumerate(sorted((OUT/'context/before').rglob('*.py'))):
   path=str(p.relative_to(OUT/'context/before'));files.append({'id':f'source-{idx:02d}','path':path,'text':p.read_text(),'sha256':sha(p),'role':'implementation'})
  k=next(n for n in h_ast.body if isinstance(n,ast.FunctionDef) and n.name==kernel);text='import triton\nimport triton.language as tl\n\n'+ '\n'.join(harness.splitlines()[min(x.lineno for x in k.decorator_list)-1:k.end_lineno])+'\n';sp=OUT/'visible-kernels'/f'{family}.py';sp.parent.mkdir(exist_ok=True);sp.write_text(text)
  files.append({'id':'test-kernel','path':'tests/visible_kernel.py','text':text,'sha256':sha(sp),'role':'test'})
  cases=[];evidence=[]
  for c in plan['cases']:
   if c['family']!=family or c['split']!='visible':continue
   rp=OUT/'run-before-v2'/c['id']/'result.json';r=json.loads(rp.read_text());cid=c['id'];eid='observation-'+cid
   payload={k:v for k,v in r.items() if k in ('case','status','input_values','observed','reference','observed_bytes','reference_bytes','elements','output_dtype','wrong_elements','maximum_absolute_error')}
   cases.append({'id':cid,'status':'passed' if r['status']=='pass' else 'wrong_value','parameters':{k:v for k,v in c.items() if k not in ('id','family','split')},'evidenceRefs':[eid]})
   evidence.append({'id':eid,'kind':'device-output','caseIds':[cid],'observed':True,'text':f"Complete actual RTX 4090 output compared against independent declared reference: {r['wrong_elements']} / {r['elements']} elements differ. Floating-point signed zero uses byte equality where required.",'payload':payload,'sourceId':'test-kernel','rawRefs':[{'id':'raw-'+cid,'sha256':sha(rp)},{'id':'test-kernel','sha256':sha(sp)}]})
  taskid='triton-'+family
  cat['tasks'].append({'id':taskid,'family':'Triton GPU frontend/runtime semantics','split':'holdout','objective':objective,'files':files,'cases':cases,'evidence':evidence,'limits':['Holdout means these root causes were held out from this project diagnostic-tool development, not secret from model pretraining.','Public source identifiers and original source content are preserved; model-training contamination is not excluded.','This is a multi-file supplied-library search task, not arbitrary whole-repository bug discovery.','Only before device observations are visible. Every listed implementation file is editable; test artifacts and references are immutable.','All library files originate from the same official Triton 3.8.0 wheel. The native compiler is fixed.','Static source provenance does not imply dynamic root-cause attribution; only test-kernel evidence is source-linked.']})
  f=next(f for f in files if f['path']==target);node=next(n for n in ast.walk(ast.parse(f['text'])) if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name==fn)
  private['tasks'].append({'id':taskid,'rootCauseId':'triton-pr-'+str(next(x for x in manifest['cases'] if x['id']==family)['pr'].split('/')[-1]),'relevantRegions':[{'source_id':f['id'],'start_line':node.lineno,'end_line':node.end_lineno}], 'hiddenCaseIds':[c['id'] for c in plan['cases'] if c['family']==family and c['split']=='hidden'],'hiddenSpecSHA256':sha(OUT/'plan.json'),'requirePassingControl':True})
 for name,data in [('catalog.json',cat),('private-plan.json',private)]: (OUT/name).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
 print(json.dumps({'tasks':[{'id':t['id'],'files':len(t['files']),'visible':len(t['cases'])} for t in cat['tasks']],'catalog_sha256':sha(OUT/'catalog.json'),'private_sha256':sha(OUT/'private-plan.json')},indent=2))
if __name__=='__main__':main()
