#!/usr/bin/env python3
"""Independent CPU oracle: reconstruct expected values from frozen input contracts.
Uses saved device bytes, not the runner's claimed pass flag/reference values.
"""
import argparse,collections,hashlib,json,math,pathlib,struct

def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def count(c):
 if c['family']=='softmax-axis':return math.prod(c['shape'])
 if c['family']=='negative-zero':return c['n']
 return len(c['values'])+1
def input_values(c):
 n=count(c)
 if c['pattern']=='linear':return [((i*7)%19-9)/4 for i in range(n)]
 if c['pattern']=='wave':return [((i*i+3*i+5)%29-14)/8 for i in range(n)]
 if c['pattern']=='constant':return [2.0]*n
 if c['pattern']=='extreme':return [-50.0,50.0,49.0,-49.0]
 raise ValueError('unexpected input pattern')
def oracle(c,raw):
 n=count(c)
 if c['family']=='softmax-axis':
  assert len(raw)==n*4
  xs=input_values(c);obs=struct.unpack('<'+'f'*n,raw);shape=c['shape'];axis=c['dim']%len(shape);stride=math.prod(shape[axis+1:]);width=shape[axis];expected=[]
  for j in range(n):
   start=(j//(width*stride))*(width*stride)+j%stride;group=[xs[start+k*stride] for k in range(width)];m=max(group);expected.append(math.exp(xs[j]-m)/sum(math.exp(x-m)for x in group))
  wrong=sum(not(math.isfinite(x)and abs(x-y)<=1e-6+1e-5*abs(y))for x,y in zip(obs,expected));return wrong,max(abs(x-y)for x,y in zip(obs,expected))
 if c['family']=='negative-zero':
  dtype=c['dtype'];value=c['value'];fmts={'float16':'e','float32':'f','float64':'d'}
  if dtype=='bfloat16':b=struct.pack('<f',value)[2:]
  else:b=struct.pack('<'+fmts[dtype],value)
  assert len(raw)==n*len(b)
  return sum(raw[i*len(b):(i+1)*len(b)]!=b for i in range(n)),None
 vals=[v for v in c['values'] if v>=c['cutoff'] and(not c['even'] or v%2==0)];expected=[len(vals)]+vals+[-777]*(len(c['values'])-len(vals));assert len(raw)==n*4
 obs=struct.unpack('<'+'i'*n,raw);return sum(x!=y for x,y in zip(obs,expected)),None

def verify(run,plan,expected_sources=None,expected_native=None,family=None):
 run=pathlib.Path(run);plan=pathlib.Path(plan);summary=json.loads((run/'summary.json').read_text());fullplan=json.loads(plan.read_text());spec={c['id']:c for c in fullplan['cases']};seen=set();rows=[]
 assert summary['plan_sha256']==sha(plan),'plan SHA mismatch'
 if expected_native:assert summary['native_compiler_sha256']==expected_native,'native compiler mismatch'
 if expected_sources:
  for path,want in expected_sources.items():assert summary['source_sha256'][path]==want,'library source mismatch: '+path
 for q in summary['cases']:
  cid=q['id'];assert cid not in seen and cid in spec,'duplicate/unknown case';seen.add(cid);p=run/cid/'result.json';assert sha(p)==q['result_sha256'],'result SHA mismatch';r=json.loads(p.read_text());assert r['case']==spec[cid],'case differs from plan'
  if r['status']=='exception':rows.append({'id':cid,'family':spec[cid]['family'],'split':spec[cid]['split'],'status':'execution_error','elements':0,'wrong_elements':None});continue
  assert isinstance(r['observed_bytes'],list) and all(type(v)is int and 0<=v<=255 for v in r['observed_bytes']),'invalid device bytes'
  wrong,maximum=oracle(spec[cid],bytes(r['observed_bytes']));assert wrong==r['wrong_elements'],'runner wrong count differs';assert(r['status']=='pass')==(wrong==0),'runner status differs'
  for kind,asm in r['assembly'].items():
   if 'file'in asm:assert sha(p.parent/asm['file'])==asm['sha256'],'assembly SHA mismatch'
  rows.append({'id':cid,'family':spec[cid]['family'],'split':spec[cid]['split'],'status':'passed'if wrong==0 else'wrong_value','elements':count(spec[cid]),'wrong_elements':wrong,'maximum_absolute_error':maximum,'result_sha256':sha(p)})
 expected_ids={c['id']for c in fullplan['cases']if family is None or c['family']==family};assert seen==expected_ids,'missing planned cases'
 return {'schema':'natural-fault-expansion-independent-verification-v1','status':'verified','plan_sha256':sha(plan),'summary_sha256':sha(run/'summary.json'),'verifier_sha256':sha(__file__),'cases':rows,'counts':dict(collections.Counter(r['status']for r in rows)),'total_elements':sum(r['elements']for r in rows),'wrong_elements':sum(r['wrong_elements']or 0 for r in rows),'native_compiler_sha256':summary['native_compiler_sha256'],'source_sha256':summary['source_sha256'],'harness_sha256':summary['harness_sha256']}
def main():
 p=argparse.ArgumentParser();p.add_argument('--run',type=pathlib.Path,required=True);p.add_argument('--plan',type=pathlib.Path,required=True);p.add_argument('--output',type=pathlib.Path,required=True);a=p.parse_args();r=verify(a.run,a.plan);a.output.write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({k:r[k]for k in ('status','counts','total_elements','wrong_elements')}))
if __name__=='__main__':main()
