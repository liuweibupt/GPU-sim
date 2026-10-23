#!/usr/bin/env python3
"""Freeze upstream records and isolated official-wheel / exact-hunk backport sources.
The original public defect is retained; this is a release + backport comparison,
not an exact-parent native compiler experiment. No model outcomes enter selection.
"""
import argparse,hashlib,json,pathlib,shutil,subprocess,urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[3]
OUT=ROOT/'out/research/natural-fault-expansion'
PRS={'softmax-axis':11409,'negative-zero':11426,'constexpr-filter':10888}
FILES={'softmax-axis':['triton/language/standard.py','triton/language/core.py'],
 'negative-zero':['triton/language/semantic.py','triton/runtime/interpreter.py'],
 'constexpr-filter':['triton/compiler/code_generator.py']}
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def get(url,path):
 if not path.exists():path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(urllib.request.urlopen(url).read())
 return json.loads(path.read_bytes())
def main():
 before=OUT/'runtime-before'; gold=OUT/'runtime-gold'; upstream=OUT/'upstream';upstream.mkdir(exist_ok=True,parents=True)
 if gold.exists():raise RuntimeError('Refuse to overwrite gold')
 shutil.copytree(before,gold,ignore=shutil.ignore_patterns('__pycache__'))
 meta={'schema':'natural-fault-expansion-v1','scope':'Official Triton 3.8.0 wheel plus exact merged Python source patch hunks; native compiler shared unchanged.', 'selection':'Three independent merged upstream defects feasible on SM89; selection preceded agent experiments. Tool authors have not developed new analysis for these faults.','cases':[]}
 for family,n in PRS.items():
  pr=get(f'https://api.github.com/repos/triton-lang/triton/pulls/{n}',upstream/f'pr-{n}.json'); commit=pr['merge_commit_sha']
  co=get(f'https://api.github.com/repos/triton-lang/triton/commits/{commit}',upstream/f'commit-{n}.json')
  assert pr['merged_at'] and co['parents']
  item={'id':family,'pr':pr['html_url'],'merge_commit':commit,'parent':co['parents'][0]['sha'],'merged_at':pr['merged_at'],'comparison':'v3.8.0 wheel with selected exact upstream Python source hunks backported','files':[]}
  for path in FILES[family]:
   f=next(f for f in co['files'] if f['filename']=='python/'+path)
   patch='--- a/'+path+'\n+++ b/'+path+'\n'+f['patch']+'\n';pp=upstream/f'{family}-{path.rsplit("/",1)[1]}.patch';pp.write_text(patch)
   r=subprocess.run(['patch','--batch','--fuzz=0','-p1','-i',str(pp.resolve())],cwd=gold,capture_output=True,text=True)
   (upstream/(pp.name+'.log')).write_text(r.stdout+r.stderr)
   if r.returncode:raise RuntimeError(r.stdout+r.stderr)
   for kind,base in [('before',before),('gold',gold)]:
    dst=OUT/'sources'/family/kind/path;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(base/path,dst)
   item['files'].append({'path':path,'before_sha256':sha(before/path),'gold_sha256':sha(gold/path),'patch_sha256':sha(pp)})
  meta['cases'].append(item)
 # Genuine dependency/caller context; no invented distractors.
 paths=['triton/__init__.py','triton/compiler/compiler.py','triton/compiler/code_generator.py','triton/runtime/jit.py','triton/runtime/interpreter.py','triton/language/__init__.py','triton/language/core.py','triton/language/semantic.py','triton/language/standard.py','triton/language/math.py']
 for kind,base in [('before',before),('gold',gold)]:
  for p in paths:
   dst=OUT/'context'/kind/p;dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(base/p,dst)
 meta['context_files']=[{'path':p,'before_sha256':sha(before/p),'gold_sha256':sha(gold/p)} for p in paths]
 natives=list((before/'triton/_C').glob('libtriton*.so')); assert len(natives)==1
 meta['native_compiler_sha256']=sha(natives[0]); assert sha(gold/natives[0].relative_to(before))==meta['native_compiler_sha256']
 meta['runtime_file_manifest']={kind:[{'path':str(p.relative_to(base)),'sha256':sha(p)} for p in sorted(base.rglob('*')) if p.is_file() and '__pycache__' not in str(p)] for kind,base in [('before',before),('gold',gold)]}
 # The complete release license and wheel provenance accompany source snapshots.
 for p in before.glob('*.dist-info/METADATA'):shutil.copyfile(p,upstream/'wheel-METADATA.txt')
 for p in before.glob('*.dist-info/RECORD'):shutil.copyfile(p,upstream/'wheel-RECORD.csv')
 get('https://pypi.org/pypi/triton/3.8.0/json',upstream/'pypi-3.8.0.json')
 for p in before.glob('*.dist-info/licenses/LICENSE'):shutil.copyfile(p,upstream/'LICENSE')
 (OUT/'manifest.json').write_text(json.dumps(meta,indent=2)+'\n');print(json.dumps({k:v for k,v in meta.items() if k!='runtime_file_manifest'},indent=2))
if __name__=='__main__':main()
