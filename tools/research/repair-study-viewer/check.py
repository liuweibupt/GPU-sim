#!/usr/bin/env python3
"""Check all catalog cases, source files and shared query interactions in Chrome."""
import argparse
import hashlib
from html import unescape
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

CHECK=r'''<script>
try{
const api=window.repairStudyViewer,$=id=>document.getElementById(id),assert=(ok,msg)=>{if(!ok)throw Error(msg);};
assert(document.documentElement.dataset.ready==='true','ready marker');let cases=0,sources=0,queries=0,links=0,samples=0,searches=0,downloads=0;
const saved=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){assert(this.href.startsWith('blob:')&&this.download.endsWith('.before.json'),'download');downloads++;};
for(const task of api.catalog.tasks){api.selectTask(task.id);assert($('source').options.length===task.files.length,'all candidate files visible');assert($('case-list').children.length===task.cases.length,'all cases visible');
 for(const file of task.files){const first=api.readSource(file.id),all=file.text.split('\n');assert(first.lines.map(l=>l.text).join('\n')===all.slice(0,120).join('\n'),'source beginning');assert($('source-hash').textContent.includes(file.sha256),'file hash');const last=api.readSource(file.id,Math.max(1,all.length-10));assert(last.end===all.length,'source tail available');assert($('source-next').disabled,'end navigation');sources++;}
 for(const c of task.cases){api.selectCase(c.id);assert(JSON.stringify(JSON.parse($('parameters').textContent))===JSON.stringify(c.parameters),'actual parameters');for(const id of c.evidenceRefs){api.showEvidence(id);const fact=task.evidence.find(e=>e.id===id);assert(JSON.parse($('evidence-raw').textContent).id===id,'evidence identity');assert(fact.rawRefs.every(ref=>$('raw-refs').textContent.includes(ref.sha256)),'provenance hashes');const rows=api.sampleRows().rows;if(rows.length){const visible=[...$('output-table').querySelectorAll('tbody tr')];visible.forEach((row,index)=>{const expected=rows[index],format=n=>Object.is(n,-0)?'-0':String(n);assert(row.children[0].textContent===String(expected.index)&&row.children[1].textContent===format(expected.actual)&&row.children[2].textContent===format(expected.reference),'exact sample binding');samples++;});if(rows.length>16){$('output-next').click();assert($('output-page').textContent.startsWith('17'), 'output pagination');$('output-prev').click();}}}
 for(const op of ['observed','source_links','contrast']){const got=api.derived(op);assert(got.scope,'query scope retained');queries++;if(op==='source_links'){const buttons=[...$('relations').querySelectorAll('button')];assert(buttons.length===got.links.length,'explicit link count');buttons.forEach((b,i)=>{b.click();assert(api.state.source.id===got.links[i].sourceId,'explicit source navigation');links++;});}}
 cases++;}
 const text=task.files[0].text.split('\n').find(line=>line.trim().length>=3).trim().slice(0,25);$('source-search').value=text;const result=api.searchSource();assert(result.totalMatches>0,'search matching source');const first=$('search-results').querySelector('button');first.click();assert($('source-lines').querySelector('.highlight'),'source search jump');searches++;
 $('status').value='passed';$('status').dispatchEvent(new Event('change'));assert($('case-list').querySelectorAll('button').length===task.cases.filter(c=>c.status==='passed').length,'status filtering');$('status').value='all';$('status').dispatchEvent(new Event('change'));$('export-task').click();
}
const original=api.state.outcomes;
if(original)for(const task of api.catalog.tasks){api.selectTask(task.id);const expected=original.rows.filter(r=>r.taskId===task.id),rendered=[...$('outcome-table').querySelectorAll('tbody tr')];assert(rendered.length===expected.length,'all actual outcome rows retained');rendered.forEach((tr,i)=>{const row=expected[i];assert(tr.children[0].textContent===row.condition&&tr.children[1].textContent===String(row.repeat)&&tr.children[2].textContent===row.status,'actual outcome identity/status');assert(tr.children[3].textContent===`${row.passedCases}/${row.totalCases}`,'actual complete-case count');assert(tr.children[5].textContent===(row.sourceSha256??'—')&&tr.children[6].textContent===(row.validationSha256??'—'),'actual tree/receipt identity');});}
const fixture={format:'repair-study-viewer-outcomes-v1',catalogSha256:api.catalogSha256,rows:[{taskId:api.catalog.tasks[0].id,condition:'raw',repeat:1,status:'passed',passedCases:4,totalCases:4,wallSeconds:1,sourceSha256:'a'.repeat(64),validationSha256:'b'.repeat(64)}]};api.selectTask(api.catalog.tasks[0].id);api.loadOutcomes(fixture);assert($('outcome-table').textContent.includes('4/4'),'outcome import fixture rendering');
for(const bad of [{...fixture,catalogSha256:'c'.repeat(64)},{...fixture,rows:[{...fixture.rows[0],passedCases:3}]},{...fixture,rows:[fixture.rows[0],fixture.rows[0]]}]){let rejected=false;try{api.loadOutcomes(bad);}catch(error){rejected=true;}assert(rejected,'mismatched/partial/duplicate outcomes rejected');}
api.state.outcomes=original;api.selectTask(api.catalog.tasks[0].id);HTMLAnchorElement.prototype.click=saved;assert(!document.querySelector('script[src]'),'self-contained offline scripts');assert(document.documentElement.scrollWidth<=innerWidth,'page width');
const out=document.createElement('pre');out.id='browser-check-result';out.textContent=JSON.stringify({status:'passed',tasks:api.catalog.tasks.length,cases,sourceFiles:sources,derivedQueries:queries,sourceLinks:links,sampleCells:samples,searches,downloads,outcomeImportValidation:true,actualEmbeddedOutcomeRows:original?.rows.length??0,actualEmbeddedPassRows:original?.rows.filter(r=>r.status==='passed').length??0,scope:'UI software checks against frozen before observations and embedded actual outcome rows. Additional import rejection tests use synthetic fixtures. This is rendering verification, not new GPU/human evidence.'});document.body.append(out);
}catch(error){const out=document.createElement('pre');out.id='browser-check-result';out.textContent=JSON.stringify({status:'failed',error:String(error),stack:error.stack});document.body.append(out);}
</script>'''

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('html',type=Path);p.add_argument('--output',required=True,type=Path);p.add_argument('--screenshot',type=Path);p.add_argument('--chrome',default=shutil.which('google-chrome') or shutil.which('chromium'));a=p.parse_args()
    if not a.chrome:raise SystemExit('Chrome unavailable')
    with tempfile.TemporaryDirectory(prefix='repair-viewer-check-') as directory:
        folder=Path(directory);probe=folder/'check.html';probe.write_text(a.html.read_text().replace('</body>',CHECK+'</body>'))
        flags=[a.chrome,'--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--window-size=1440,1100','--user-data-dir='+str(folder/'profile')]
        process=subprocess.run(flags+['--dump-dom',probe.as_uri()],capture_output=True,text=True,timeout=60);match=re.search(r'<pre id="browser-check-result">(.*?)</pre>',process.stdout,re.S)
        if not match:raise SystemExit('No browser check result: '+process.stderr[-1000:])
        result=json.loads(unescape(match[1]));result.update({'chromeExitCode':process.returncode,'chromeVersion':subprocess.check_output([a.chrome,'--version'],text=True).strip(),'htmlSha256':hashlib.sha256(a.html.read_bytes()).hexdigest(),'checkerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()})
        if a.screenshot:
            a.screenshot.parent.mkdir(parents=True,exist_ok=True);shot=subprocess.run(flags+['--screenshot='+str(a.screenshot.resolve()),a.html.resolve().as_uri()],capture_output=True,text=True,timeout=60);result['screenshot']={'exitCode':shot.returncode,'sha256':hashlib.sha256(a.screenshot.read_bytes()).hexdigest() if a.screenshot.exists() else None}
        a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result));raise SystemExit(0 if result['status']=='passed' and process.returncode==0 else 1)

if __name__=='__main__':main()
