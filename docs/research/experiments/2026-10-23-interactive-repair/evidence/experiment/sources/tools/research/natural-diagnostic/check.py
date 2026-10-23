#!/usr/bin/env python3
"""Exercise the generated natural-fault page with real headless Chrome."""
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
try {
const api=window.naturalDiagnostic,d=api.data,$=id=>document.getElementById(id),assert=(ok,message)=>{if(!ok)throw Error(message);};
assert(document.documentElement.dataset.ready==='true','not ready');
const change=(id,value)=>{$(id).value=String(value);$(id).dispatchEvent(new Event('change'));};
let cases=0,sourceChecks=0,allocationChecks=0,outputCells=0,exportChecks=0;
for(const family of ['tmem','cutlass']){
 change('family',family);change('version','all');change('status','all');
 assert($('case-list').children.length===d.cases.filter(c=>c.family===family).length,'case filter count');
 for(const item of d.cases.filter(c=>c.family===family)){
  $('case-list').querySelector(`[data-case="${item.id}"]`).click();
  assert(api.state.case.id===item.id&&$('selection-status').dataset.status===item.status,'selected case/status');
  assert(JSON.stringify(JSON.parse($('parameters').textContent))===JSON.stringify(item.parameters),'visible parameters');
  assert($('comparison').children.length===d.cases.filter(c=>c.pairKey===item.pairKey).length,'paired variants');
  for(const id of item.sourceRefs){change('source-select',id);const source=d.sources.find(s=>s.id===id);assert($('source-full').textContent===source.text&&$('source-hash').textContent.includes(source.sha256),'source text/hash');sourceChecks++;}
  for(const id of item.evidenceRefs){change('evidence-select',id);const fact=d.evidence.find(e=>e.id===id);assert(JSON.parse($('evidence-raw').textContent).id===id,'evidence identity');assert(fact.rawRefs.every(ref=>$('provenance').textContent.includes(ref.sha256)),'raw hashes');}
  const fact=d.evidence.find(e=>e.id===item.evidenceRefs[0]);
  if(family==='tmem'){
   const overlaps=api.query({op:'overlap',id:item.id});
   const bars=[...$('allocations').querySelectorAll('button')];assert(bars.length===overlaps.allocations.length,'allocation count');
   bars.forEach((bar,i)=>{const allocation=overlaps.allocations[i];assert(Number(bar.dataset.lo)===allocation.interval[0]&&Number(bar.dataset.hi)===allocation.interval[1],'allocation interval');bar.click();assert(Number($('source-lines').querySelector('.highlight').dataset.line)===allocation.line,'allocation source navigation');allocationChecks++;});
   fact.outputs.forEach((out,index)=>{change('output-name',index);const verify=()=>{for(const row of $('output-table').querySelectorAll('tbody tr')){const at=Number(row.dataset.index);assert(Number(row.dataset.actual)===out.actual[at]&&Number(row.dataset.reference)===out.referenceValue,'output binding');assert(Number(row.children[1].textContent)===out.actual[at]&&row.classList.contains('mismatch')===(out.actual[at]!==out.referenceValue),'visible output');outputCells++;}};verify();if(out.actual.length>64){$('output-next').click();verify();api.state.outputPage=Math.ceil(out.actual.length/64)-2;$('output-next').click();verify();assert($('output-next').disabled,'last page control');}});
  } else {
   fact.groups.forEach((out,index)=>{change('output-name',index);const rows=[...$('output-table').querySelectorAll('tbody tr')];assert(rows.length===out.first16.observed.length,'cutlass sample rows');rows.forEach((row,i)=>{assert(Number(row.children[1].textContent)===out.first16.observed[i]&&Number(row.children[2].textContent)===out.first16.reference[i]&&Number(row.children[3].textContent)===out.first16.c[i],'cutlass sample value');outputCells++;});});
   if(!fact.outputsChecked)assert($('output-count').textContent.includes('未知')&&$('output-table').textContent==='','failed output marked unknown');
   $('source-anchors').querySelector('button').click();assert($('source-full').textContent.includes('Prologue GMMAs'),'source anchor');
  }
  const exported=api.exportSelection();assert(exported.case.id===item.id&&exported.evidence.length===item.evidenceRefs.length&&exported.sources.length===item.sourceRefs.length,'export selection');assert(exported.sources.every(s=>s.sha256&&s.text),'export source binding');exportChecks++;cases++;
 }
}
change('family','cutlass');change('version','before');change('status','timeout');assert($('case-list').children.length===10,'timeout filtering');
change('status','wrong_value');assert($('case-list').children.length===1&&document.querySelector('.detail').hidden,'empty filter');
$('reset').click();assert(api.state.case.id==='t-before-00','reset');
const peer=$('comparison').querySelector('[data-case="t-after-00"]');peer.click();assert(api.state.case.id==='t-after-00'&&$('selection-status').dataset.status==='passed','paired-version navigation');
change('source-select','t-source-after');$('source-search').value='getLiveIntervals';$('search').click();assert($('search-results').children.length>0,'literal source search');$('search-results').querySelector('button').click();assert($('source-lines').querySelector('.highlight').textContent.includes('getLiveIntervals'),'search navigation');
const nativeClick=HTMLAnchorElement.prototype.click;let download=null;HTMLAnchorElement.prototype.click=function(){download={href:this.href,name:this.download};};$('export').click();HTMLAnchorElement.prototype.click=nativeClick;assert(download.href.startsWith('blob:')&&download.name.endsWith('.diagnostic.json')&&api.lastExport.case.id===api.state.case.id,'download handler');
assert(document.body.textContent.includes('不是硬件时间轴'),'timeline boundary');assert(document.documentElement.scrollWidth<=window.innerWidth,'horizontal overflow');
$('reset').click();
const result=document.createElement('pre');result.id='browser-check-result';result.textContent=JSON.stringify({status:'passed',cases,sourceChecks,allocationChecks,outputCells,exportChecks,filterAndSearchChecks:true,downloadHandlerChecked:true,scope:'DOM and interactions checked against frozen evidence; no new GPU execution, agent outcome, or human study.'});document.body.append(result);
}catch(error){const result=document.createElement('pre');result.id='browser-check-result';result.textContent=JSON.stringify({status:'failed',error:String(error),stack:error.stack});document.body.append(result);}
</script>'''

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('html',type=Path);p.add_argument('--output',type=Path,required=True);p.add_argument('--screenshot',type=Path)
    p.add_argument('--chrome',default=shutil.which('google-chrome') or shutil.which('chromium'));a=p.parse_args()
    if not a.chrome:raise SystemExit('Chrome unavailable; no browser verification claimed')
    with tempfile.TemporaryDirectory(prefix='natural-diagnostic-check-') as directory:
        folder=Path(directory);probe=folder/'check.html';probe.write_text(a.html.read_text().replace('</body>',CHECK+'</body>'))
        flags=[a.chrome,'--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--window-size=1440,1200','--user-data-dir='+str(folder/'profile')]
        result=subprocess.run(flags+['--dump-dom',probe.as_uri()],capture_output=True,text=True,timeout=60)
        match=re.search(r'<pre id="browser-check-result">(.*?)</pre>',result.stdout,re.S)
        if not match:raise SystemExit('Browser did not complete checks: '+result.stderr[-1000:])
        report=json.loads(unescape(match[1]));report.update({'chromeExitCode':result.returncode,'chromeVersion':subprocess.check_output([a.chrome,'--version'],text=True).strip(),'htmlSha256':hashlib.sha256(a.html.read_bytes()).hexdigest(),'checkerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()})
        if a.screenshot:
            a.screenshot.parent.mkdir(parents=True,exist_ok=True)
            shot=subprocess.run(flags+['--hide-scrollbars','--screenshot='+str(a.screenshot.resolve()),a.html.resolve().as_uri()],capture_output=True,text=True,timeout=60)
            report['screenshot']={'exitCode':shot.returncode,'sha256':hashlib.sha256(a.screenshot.read_bytes()).hexdigest() if a.screenshot.exists() else None}
        a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False))
        raise SystemExit(0 if report['status']=='passed' and result.returncode==0 else 1)
if __name__=='__main__':main()
