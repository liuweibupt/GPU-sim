#!/usr/bin/env python3
"""Browser exercise of the study UI; generated answers are explicitly software tests."""
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
const api=window.humanStudy,$=id=>document.getElementById(id),insist=(ok,message)=>{if(!ok)throw Error(message);};
insist(document.documentElement.dataset.ready==='true','ready marker');insist(!api.readiness.formalReady,'development bundle must block formal');
$('consent').checked=true;$('mode').value='formal';$('start').click();insist($('setup-error').textContent.includes('Formal enrollment pending'),'formal guard');insist(api.state.session===null,'no formal data');
const sessions=[];let queries=0,records=0,sourceLinks=0,downloads=0;
const nativeClick=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){insist(this.href.startsWith('blob:')&&this.download.endsWith('.json'),'safe download');downloads++;};
for(let slot=0;slot<12;slot++){
 $('mode').value='dry-run';$('slot').value=slot;$('participant').value='SOFTWARE-'+slot;$('start').click();
 insist(api.state.session.status==='running','started');let iterations=0;
 while(api.state.session.status==='running'){
  insist(++iterations<=6,'finite schedule');const task=api.state.tasks[api.state.index];
  insist(task.condition==='raw'?$('derived-tab').disabled:!$('derived-tab').disabled,'condition control');
  insist(JSON.stringify(api.state.packet)===JSON.stringify(api.materialPacket({...task,condition:'raw'},api.dataset)),'equal raw information');
  for(const option of $('record').options){$('record').value=option.value;$('record').dispatchEvent(new Event('change'));insist($('record-text').textContent.length>0,'visible record');records++;}
  $('search').value='id';$('find').click();insist($('search-result').textContent.includes('匹配'),'search');
  if(task.condition==='raw'){let denied=false;try{queryDerived('contrast');}catch(error){denied=true;}insist(denied,'baseline cannot access derived query');}
  else{
   $('derived-tab').click();$('contrast').click();insist($('derived-text').textContent.length>0,'derived query');queries++;
   if(task.adapter==='repair-v2'){for(const op of ['observed','source_links']){queryDerived(op);insist(JSON.parse($('derived-text').textContent).scope,'generic API scope');queries++;}}
   if(task.adapter==='natural'&&task.family==='tmem')for(const option of $('case').options){$('case').value=option.value;$('overlap').click();queries++;const result=JSON.parse($('derived-text').textContent);insist(result.caseId===option.value,'query case identity');const bar=$('derived-bars').querySelector('button');if(bar){bar.click();insist($('search-result').textContent.includes(result.sourceId),'source navigation');sourceLinks++;$('derived-tab').click();}}
  }
  if(task.stage==='main')$('packet-download').click();
  $('diagnosis').value='SOFTWARE GENERATED TEST ANSWER — NOT A PERSON';$('evidence-ids').value=api.state.packet.evidence[0].id;$('locations').value='software-check';$('repair').value='unvalidated placeholder';$('basis').value='inferred';$('confidence').value=50;
  $('submit').click();insist(!$('answer-error').textContent,'valid response');
 }
 const exported=api.exportSession();insist(exported.status==='completed'&&exported.responses.length===6,'complete export');insist(!('startedMonotonicMs' in exported),'private clock origin omitted');insist(exported.responses.filter(r=>r.stage==='main').length===4,'four real main');sessions.push(exported);$('download').click();
}
$('participant').value='SOFTWARE-WITHDRAW';$('slot').value=0;$('start').click();$('withdraw').click();insist(api.exportSession().status==='withdrawn'&&api.exportSession().responses[0].reason==='withdrawn','withdrawal retained');sessions.push(api.exportSession());
$('participant').value='SOFTWARE-TIMEOUT';$('start').click();api.state.taskStarted=performance.now()-301000;api.tick();insist(api.state.session.responses[0].reason==='timeout','timeout draft retained');insist(api.state.session.responses[0].elapsedMs===300000,'timeout capped');$('withdraw').click();sessions.push(api.exportSession());
$('discard').click();insist(api.state.session===null&&$('download').disabled,'delete memory');
HTMLAnchorElement.prototype.click=nativeClick;
insist(!document.querySelector('script[src]'),'offline scripts only');insist(document.documentElement.scrollWidth<=window.innerWidth,'no horizontal overflow');
const node=document.createElement('pre');node.id='browser-check-result';node.textContent=JSON.stringify({status:'passed',scope:'SOFTWARE DRY-RUN ONLY; zero human participants.',completedSoftwareSessions:12,withdrawalAndTimeoutSessions:2,records,queries,sourceLinks,downloads,formalGuard:true,rawPacketParity:true,timeoutAndWithdrawal:true,memoryDeletion:true,sessions});document.body.append(node);
}catch(error){const node=document.createElement('pre');node.id='browser-check-result';node.textContent=JSON.stringify({status:'failed',error:String(error),stack:error.stack});document.body.append(node);}
</script>'''


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('html',type=Path);p.add_argument('--output',required=True,type=Path);p.add_argument('--sessions',type=Path);p.add_argument('--screenshot',type=Path);p.add_argument('--chrome',default=shutil.which('google-chrome') or shutil.which('chromium'));a=p.parse_args()
    if not a.chrome:raise SystemExit('Chrome not available; no browser pass claimed')
    with tempfile.TemporaryDirectory(prefix='human-study-check-') as tmp:
        folder=Path(tmp);probe=folder/'probe.html';probe.write_text(a.html.read_text().replace('</body>',CHECK+'</body>'))
        flags=[a.chrome,'--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--window-size=1440,1100','--user-data-dir='+str(folder/'profile')]
        result=subprocess.run(flags+['--dump-dom',probe.as_uri()],capture_output=True,text=True,timeout=60)
        match=re.search(r'<pre id="browser-check-result">(.*?)</pre>',result.stdout,re.S)
        if not match:raise SystemExit('Chrome did not finish: '+result.stderr[-1000:])
        report=json.loads(unescape(match[1]));sessions=report.pop('sessions',[])
        if a.sessions:
            a.sessions.mkdir(parents=True,exist_ok=True)
            for session in sessions:(a.sessions/(session['participantId']+'.json')).write_text(json.dumps(session,ensure_ascii=False,indent=2)+'\n')
        report.update({'chromeVersion':subprocess.check_output([a.chrome,'--version'],text=True).strip(),'chromeExitCode':result.returncode,'htmlSha256':hashlib.sha256(a.html.read_bytes()).hexdigest(),'checkerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()})
        if a.screenshot:
            a.screenshot.parent.mkdir(parents=True,exist_ok=True)
            shot=subprocess.run(flags+['--screenshot='+str(a.screenshot.resolve()),a.html.resolve().as_uri()],capture_output=True,text=True,timeout=60)
            report['screenshot']={'exitCode':shot.returncode,'sha256':hashlib.sha256(a.screenshot.read_bytes()).hexdigest() if a.screenshot.exists() else None}
        a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
        raise SystemExit(0 if report['status']=='passed' and result.returncode==0 else 1)

if __name__=='__main__':main()
