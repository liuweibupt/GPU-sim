#!/usr/bin/env python3
"""Retain exact upstream pre/post files, issue statements and release-byte checks."""
import hashlib,json,pathlib,urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[3];OUT=ROOT/'out/research/natural-fault-expansion'
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def fetch(url,p):
 p.parent.mkdir(exist_ok=True,parents=True)
 if not p.exists():p.write_bytes(urllib.request.urlopen(url).read())
 return {'url':url,'path':str(p.relative_to(OUT)),'sha256':sha(p)}
def main():
 m=json.loads((OUT/'manifest.json').read_text());receipt={'files':[],'release_checks':[]}
 for n in (11735,11406):receipt['files'].append(fetch(f'https://api.github.com/repos/triton-lang/triton/issues/{n}',OUT/'upstream'/f'issue-{n}.json'))
 for c in m['cases']:
  for f in c['files']:
   for label,commit in [('parent',c['parent']),('merged',c['merge_commit'])]:receipt['files'].append(fetch(f"https://raw.githubusercontent.com/triton-lang/triton/{commit}/python/{f['path']}",OUT/'upstream'/c['id']/label/f['path']))
   r=fetch(f"https://raw.githubusercontent.com/triton-lang/triton/v3.8.0/python/{f['path']}",OUT/'upstream'/'v3.8.0'/f['path']);r['matches_installed_official_wheel']=r['sha256']==f['before_sha256'];assert r['matches_installed_official_wheel'];receipt['release_checks'].append(r)
 (OUT/'upstream-source-verification.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({'snapshots':len(receipt['files']),'release_matches':len(receipt['release_checks'])}))
if __name__=='__main__':main()
