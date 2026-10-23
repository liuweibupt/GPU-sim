'use strict';
const manifest = JSON.parse(document.getElementById('study-manifest').textContent);
const dataset = JSON.parse(document.getElementById('study-data').textContent);
const $ = id => document.getElementById(id);
const state = {session:null, tasks:[], index:-1, taskStarted:0, record:null, packet:null, timer:null, deleted:false};
const now = () => Math.round(performance.now());
const textNode = (tag,text) => {const element=document.createElement(tag);element.textContent=text;return element;};
const task = () => state.tasks[state.index];
function log(action, detail={}) {if(state.session)state.session.events.push({sequence:state.session.events.length,elapsedMs:now()-state.session.startedMonotonicMs,taskId:task()?.id||null,action,...detail});}
function download(value, name) {const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
const ready=readiness(manifest);$('readiness').textContent=ready.formalReady?'技术检查通过；正式招募仍须采用研究负责人确认的参与者说明。':`实际 main 材料已备齐 ${ready.independentMainRoots}/6；专家审核和正式招募未完成，当前可演练四题对照流程。`;
function options(node, rows) {node.replaceChildren(...rows.map(([value,label])=>{const o=textNode('option',label);o.value=value;return o;}));}
function showRecord(key) {
  const [kind,id]=key.split(':');const record=state.packet[kind]?.find(r=>r.id===id);if(!record)throw Error('Material record unavailable');
  state.record=record;$('record').value=key;$('record-text').textContent=kind==='sources'?record.text.split('\n').map((line,i)=>`${i+1}: ${line}`).join('\n'):JSON.stringify(record,null,2);$('search-result').textContent='';log('open-record',{kind,id});
}
function showRaw() {$('raw-pane').hidden=false;$('derived-pane').hidden=true;log('raw-tab');}
function showDerived() {if(task().condition==='raw')return;$('raw-pane').hidden=true;$('derived-pane').hidden=false;log('derived-tab');}
function queryDerived(op) {
  if(task().condition==='raw')throw Error('Derived queries disabled in baseline');
  let result;
  if(task().adapter==='repair-v2') {const original=dataset.repair.tasks.find(t=>t.id===task().catalogTaskId);const request={op:'derived',derived_op:op==='overlap'?'source_links':op};if(op==='contrast')request.groupBy=$('group-by').value.split(',').map(x=>x.trim()).filter(Boolean);else request.id=$('case').value;result=repairQuery.rawQuery(original,'diagnostic',request);}
  else if(task().family) result=queryDiagnostic({format:dataset.natural.format,scope:dataset.natural.scope,...state.packet},op==='overlap'?{op,id:$('case').value}:{op,family:task().family,groupBy:task().family==='cutlass'?['beta','hasZeroK']:['mode','columns','early']});
  else result={scope:'Synthetic navigation practice only; no GPU execution or hidden diagnosis.',records:state.packet.evidence.map(e=>({id:e.id,rawRefs:e.rawRefs})),sourceIds:state.packet.sources.map(s=>s.id)};
  $('derived-text').textContent=JSON.stringify(result,null,2);$('derived-bars').replaceChildren();
  if(result.allocations){const max=Math.max(128,...result.allocations.map(a=>a.interval[1]));for(const allocation of result.allocations){const row=textNode('div','');row.className='allocation';const name=textNode('code',allocation.ssa),track=textNode('div','');track.className='track';const bar=textNode('button',allocation.interval.join('–'));bar.style.left=100*allocation.interval[0]/max+'%';bar.style.width=100*(allocation.interval[1]-allocation.interval[0])/max+'%';bar.onclick=()=>{showRaw();showRecord('sources:'+result.sourceId);$('search-result').textContent=`关联到 ${result.sourceId}:${allocation.line}（完整文件保留）`;log('source-link',{sourceId:result.sourceId,line:allocation.line});};track.append(bar);row.append(name,track);$('derived-bars').append(row);}}
  if(result.links)for(const link of result.links){const b=textNode('button',link.evidenceId+' → '+link.path);b.onclick=()=>{showRaw();showRecord('sources:'+link.sourceId);};$('derived-bars').append(b);}
  log('derived-query',{op,caseId:$('case').value,resultSourceIds:result.sourceId?[result.sourceId]:[]});
}
function openNext() {
  state.index++;if(state.index>=state.tasks.length){finish('completed');return;}
  const current=task();state.packet=materialPacket(current,dataset);state.taskStarted=now();
  $('progress').textContent=`任务 ${state.index+1} / ${state.tasks.length}`;$('stage').textContent=current.stage.toUpperCase();$('title').textContent=current.title;$('prompt').textContent=current.prompt;
  $('condition').textContent=current.condition==='raw'?'当前界面：原始材料。可搜索、下载完整记录与源码。':current.condition==='diagnostic'?'当前界面：原始材料 + 诊断关系。两条件的原始信息相同。':'练习：体验两种资料入口。';
  $('origin').textContent=current.stage==='practice'?'旧公开故障，仅练习，不进入主要评分。':'实际 GPU 故障材料；固定六任务池，也用于技术 agent 实验。研究结论限定于该任务池，不声称额外未见任务泛化。';
  $('material-scope').textContent=`${state.packet.cases?.length||0} 个用例，${state.packet.sources.length} 份完整文本，${state.packet.evidence.length} 条证据。`;
  options($('record'),['cases','evidence','sources'].flatMap(kind=>(state.packet[kind]||[]).map(record=>[kind+':'+record.id,`${kind} · ${record.id} ${record.path||''}`])));
  options($('case'),(state.packet.cases||[]).map(c=>[c.id,c.id+' · '+c.status]));
  $('derived-tab').disabled=current.condition==='raw';$('case').disabled=false;$('overlap').disabled=current.adapter==='repair-v2'||current.family==='cutlass';$('observed').disabled=current.adapter!=='repair-v2';$('source-links').disabled=current.adapter!=='repair-v2';$('group-by').value='';
  $('derived-text').textContent='';$('derived-bars').replaceChildren();$('search').value='';
  for(const id of ['diagnosis','locations','evidence-ids','repair'])$(id).value='';
  $('edits-json').value='[]';$('search-links').replaceChildren();$('confidence').value='50';$('basis').value='';$('familiar').checked=false;$('answer-error').textContent='';
  $('raw-pane').hidden=false;$('derived-pane').hidden=true;showRecord($('record').value);log('task-start',{stage:current.stage,condition:current.condition,rootCauseId:current.rootCauseId});tick();
}
function answer() {return {diagnosis:$('diagnosis').value.trim(),locations:$('locations').value.trim(),evidenceIds:$('evidence-ids').value.split(',').map(x=>x.trim()).filter(Boolean),repair:$('repair').value.trim(),edits:(()=>{try{return JSON.parse($('edits-json').value);}catch{return null;}})(),confidence:Number($('confidence').value),evidenceBasis:$('basis').value,priorFamiliarity:$('familiar').checked};}
function saveAnswer(reason='submitted') {
  const current=task(),value=answer(),errors=validateAnswer(value,current,dataset);
  if(reason==='submitted'&&errors.length){$('answer-error').textContent=errors.join(' ');return false;}
  const elapsedMs=Math.min(now()-state.taskStarted,current.timeLimitSeconds*1000);
  state.session.responses.push({taskId:current.id,rootCauseId:current.rootCauseId,stage:current.stage,condition:current.condition,synthetic:current.synthetic,developmentCase:current.developmentCase,reason,elapsedMs,timeLimitSeconds:current.timeLimitSeconds,answer:value,validationErrors:errors});
  log('task-end',{reason,elapsedMs});return true;
}
function tick() {if(!state.session||state.session.status!=='running')return;const remaining=Math.max(0,task().timeLimitSeconds-Math.floor((now()-state.taskStarted)/1000));$('clock').textContent=`剩余 ${Math.floor(remaining/60)}:${String(remaining%60).padStart(2,'0')}`;if(remaining===0){saveAnswer('timeout');openNext();}}
function finish(status) {state.session.status=status;state.session.finishedElapsedMs=now()-state.session.startedMonotonicMs;clearInterval(state.timer);$('run').hidden=true;$('finish').hidden=false;$('finish-title').textContent=status==='completed'?'流程结束':'已停止';$('finish-status').textContent=`${state.session.mode} · 已保存 ${state.session.responses.length} 个任务。退出或超时记录保留原状态，不伪装为成功。`;$('result-summary').textContent=JSON.stringify({participantId:state.session.participantId,mode:state.session.mode,status,responses:state.session.responses.length,events:state.session.events.length,scope:'Software rehearsal is not human evidence.'},null,2);log('session-end',{status});}
function start() {
  $('setup-error').textContent='';try{
    const participantId=$('participant').value,slot=Number($('slot').value),mode=$('mode').value;
    if(!/^[A-Za-z0-9_-]{3,32}$/.test(participantId))throw Error('代号只能含字母、数字、下划线和短横线，3–32 字符。');
    if(!$('consent').checked)throw Error('请先阅读并选择是否同意此次流程演练。');
    state.tasks=schedule(manifest,slot,mode);state.index=-1;state.deleted=false;
    state.session={format:FORMAT,mode,participantId,allocationSlot:slot,manifestSha256:manifest.manifestSha256,dataSha256:manifest.dataSha256,catalogSha256:manifest.catalogSha256,protocolVersion:manifest.protocolVersion,experience:$('experience').value,consentScope:mode==='dry-run'?'software-rehearsal-only':'investigator-confirmed-information-required',startedMonotonicMs:now(),status:'running',taskOrder:state.tasks.map(t=>({id:t.id,rootCauseId:t.rootCauseId,stage:t.stage,condition:t.condition})),responses:[],events:[]};
    $('setup').hidden=true;$('run').hidden=false;$('finish').hidden=true;log('session-start',{slot,mode});openNext();state.timer=setInterval(tick,250);
  }catch(error){$('setup-error').textContent=error.message;}
}
$('start').onclick=start;$('record').onchange=()=>showRecord($('record').value);$('raw-tab').onclick=showRaw;$('derived-tab').onclick=showDerived;
$('find').onclick=()=>{const needle=$('search').value;const matches=needle?state.packet.sources.flatMap(source=>source.text.split('\n').flatMap((line,index)=>line.includes(needle)?[{id:source.id,line:index+1,text:line}]:[])):[];$('search-result').textContent=needle?`共 ${matches.length} 处匹配，显示前 40 处。`:'请输入搜索文本。';$('search-links').replaceChildren(...matches.slice(0,40).map(match=>{const b=textNode('button',`${match.id}:${match.line} ${match.text.slice(0,90)}`);b.onclick=()=>{showRecord('sources:'+match.id);$('search-result').textContent=`定位到 ${match.id}:${match.line}`;};return b;}));log('search',{queryLength:needle.length,matches:matches.length});};
$('overlap').onclick=()=>queryDerived('overlap');$('contrast').onclick=()=>queryDerived('contrast');$('observed').onclick=()=>queryDerived('observed');$('source-links').onclick=()=>queryDerived('source_links');$('packet-download').onclick=()=>{download(state.packet,task().id+'.raw.json');log('download-material');};
$('submit').onclick=()=>{if(saveAnswer())openNext();};$('withdraw').onclick=()=>{saveAnswer('withdrawn');finish('withdrawn');};
$('download').onclick=()=>{if(state.deleted)return;state.session.feedback=$('feedback').value.trim();download(exportSession(),state.session.participantId+'.'+state.session.mode+'.json');};
$('discard').onclick=()=>{state.session=null;state.tasks=[];state.packet=null;state.record=null;state.deleted=true;clearInterval(state.timer);for(const id of ['feedback','diagnosis','locations','evidence-ids','repair','edits-json'])$(id).value='';$('record-text').textContent='';$('derived-text').textContent='';$('result-summary').textContent='本页内存记录已删除；此前已下载的文件须另行删除。';$('download').disabled=true;};
document.addEventListener('visibilitychange',()=>log('visibility',{hidden:document.hidden}));
function exportSession(){if(!state.session)throw Error('No session');const output=structuredClone(state.session);delete output.startedMonotonicMs;return output;}
window.humanStudy={state,manifest,dataset,readiness:ready,schedule,materialPacket,start,openNext,answer,saveAnswer,tick,finish,exportSession};
document.documentElement.dataset.ready='true';
