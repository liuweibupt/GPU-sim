#!/usr/bin/env python3
"""Bundle the natural diagnostic viewer with exact data and shared query source."""
import argparse
import hashlib
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).parent
def sha(raw): return hashlib.sha256(raw).hexdigest()
def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--data',type=Path,default=ROOT/'web/research/natural-bugs/data.json')
    p.add_argument('--output',type=Path,default=ROOT/'web/research/natural-bugs/index.html')
    a=p.parse_args(); raw=a.data.read_bytes(); data=json.loads(raw)
    query=(ROOT/'lib/research/natural-diagnostic.js').read_text().replace('export function ','function ').replace('export const ','const ')
    ui=(HERE/'viewer.js').read_text().replace('__DATA_SHA__',sha(raw))
    encoded=json.dumps(data,ensure_ascii=False,separators=(',',':')).replace('<','\\u003c').replace('>','\\u003e').replace('&','\\u0026')
    page=(HERE/'viewer.html').read_text().replace('__STYLE__',(HERE/'viewer.css').read_text()).replace('__DATA__',encoded).replace('__QUERY__',query).replace('__UI__',ui)
    a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(page)
    manifest={'format':'natural-diagnostic-render-v1','htmlSha256':sha(a.output.read_bytes()),'dataSha256':sha(raw),'htmlBytes':a.output.stat().st_size,
              'sources':{str(path.relative_to(ROOT)):sha(path.read_bytes()) for path in [Path(__file__),HERE/'viewer.html',HERE/'viewer.js',HERE/'viewer.css',ROOT/'lib/research/natural-diagnostic.js']}}
    (a.output.parent/'render-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest))
if __name__=='__main__':main()
