#!/usr/bin/env python3
"""Bundle the frozen multi-file repair catalog with the identical agent query API."""
import argparse
import hashlib
import json
from pathlib import Path
import re

HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[2]
sha=lambda raw:hashlib.sha256(raw).hexdigest()

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--catalog',type=Path,default=ROOT/'out/research/repair-v2-study/frozen/catalog-before.json');p.add_argument('--outcomes',type=Path);p.add_argument('--output',type=Path,default=ROOT/'web/research/repair-study-v2');a=p.parse_args()
    raw=a.catalog.read_bytes();catalog=json.loads(raw)
    if catalog.get('format')!='repair-study-catalog-v2':raise SystemExit('Unsupported catalog')
    for task in catalog['tasks']:
        ids=set()
        for file in task['files']:
            if file['id'] in ids or sha(file['text'].encode())!=file['sha256']:raise SystemExit('Duplicate source or source hash mismatch')
            ids.add(file['id'])
        if any('after' in case.get('version','').lower() for case in task['cases']):raise SystemExit('Only before data allowed')
        evidence={e['id'] for e in task['evidence']}
        if any(not set(case['evidenceRefs'])<=evidence for case in task['cases']):raise SystemExit('Missing evidence')
    natural_path=ROOT/'lib/research/natural-diagnostic.js';query_path=ROOT/'tools/research/repair-study-v2/query.mjs'
    natural=natural_path.read_text().replace('export function ','function ').replace('export const ','const ')
    repair=re.sub(r"^import .*?;\n",'',query_path.read_text(),flags=re.M).replace('export function ','function ').replace('export const ','const ')
    bundled='const naturalQuery=(()=>{'+natural+';return {queryDiagnostic};})();\nconst repairQuery=(()=>{const queryDiagnostic=naturalQuery.queryDiagnostic;'+repair+';return {initialPacket,rawQuery,genericDerived};})();'
    encode=lambda value:json.dumps(value,ensure_ascii=False,separators=(',',':')).replace('<','\\u003c').replace('>','\\u003e').replace('&','\\u0026')
    outcomes=json.loads(a.outcomes.read_text()) if a.outcomes else None
    if outcomes is not None and outcomes.get('catalogSha256')!=sha(raw):raise SystemExit('Outcome/catalog SHA mismatch')
    ui=(HERE/'viewer.js').read_text().replace('__CATALOG_SHA__',sha(raw)).replace('__QUERY_SHA__',sha(query_path.read_bytes()))
    page=(HERE/'viewer.html').read_text().replace('__STYLE__',(HERE/'viewer.css').read_text()).replace('__CATALOG__',encode(catalog)).replace('__OUTCOMES__',encode(outcomes)).replace('__QUERY__',bundled).replace('__UI__',ui)
    a.output.mkdir(parents=True,exist_ok=True);(a.output/'index.html').write_text(page)
    manifest={'format':'repair-study-viewer-render-v1','catalogSha256':sha(raw),'htmlSha256':sha(page.encode()),'querySha256':sha(query_path.read_bytes()),'htmlBytes':len(page.encode()),'tasks':len(catalog['tasks']),'caseRecords':sum(len(t['cases']) for t in catalog['tasks']),'sourceFilesPerTask':{t['id']:len(t['files']) for t in catalog['tasks']},'outcomesEmbedded':outcomes is not None,'scope':'Archived before-only GPU observations; no new execution, hardware timeline, or human outcomes.', 'sources':{str(file.relative_to(ROOT)):sha(file.read_bytes()) for file in [Path(__file__),HERE/'viewer.html',HERE/'viewer.css',HERE/'viewer.js',query_path,natural_path]}}
    (a.output/'render-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest))

if __name__=='__main__':main()
