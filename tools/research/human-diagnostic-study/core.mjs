/** Six fixed roots, immediate explanation study. No human data are synthesized here. */
export const FORMAT = 'gpu-human-diagnostic-study-v2';
const requireValue = (ok, message) => { if (!ok) throw Error(message); };
export function readiness(manifest) {
  const reasons=[],tasks=manifest.tasks||[],main=tasks.filter(t=>t.stage==='main'),practice=tasks.filter(t=>t.stage==='practice');
  const materialsReady=main.length===6&&practice.length===2&&tasks.every(t=>t.materialPacketSha256&&t.rootCauseId&&!t.synthetic)&&new Set(tasks.map(t=>t.rootCauseId)).size===tasks.length;
  if(!materialsReady)reasons.push('six-real-main-and-two-practice-materials-required');
  for(const task of main){if(!task.materialsReviewed||!task.rubricSha256||!task.equalInformationAuditSha256)reasons.push(`expert-review-pending:${task.id}`);if(!task.repairHarnessSha256)reasons.push(`repair-harness-map-missing:${task.id}`);}
  if(!manifest.preregistration?.frozenSha256)reasons.push('protocol-not-finally-frozen');
  return {materialsReady,formalReady:reasons.length===0,reasons,independentMainRoots:new Set(main.map(t=>t.rootCauseId)).size,design:'simple-six-root-immediate-v2',institutionalReview:manifest.institutionalReview||{status:'awaiting-local-investigator-determination'},note:'Six actual task packets are operational. Expert review and final protocol freeze precede formal enrollment. Institutional applicability is determined locally; software does not assume approval is always required.'};
}
export function schedule(manifest,slot,mode='dry-run'){
  requireValue(Number.isInteger(slot)&&slot>=0,'Non-negative allocation slot required');requireValue(['dry-run','formal'].includes(mode),'Unknown mode');
  const ready=readiness(manifest);requireValue(ready.materialsReady,'Actual six-root task materials unavailable');requireValue(mode!=='formal'||ready.formalReady,'Formal enrollment pending: '+ready.reasons.join(', '));
  const main=manifest.tasks.filter(t=>t.stage==='main'),offset=Math.floor(slot/2)%6,parity=slot%2;
  const ordered=manifest.tasks.filter(t=>t.stage==='practice').map(t=>({...t,condition:'practice-both'}));
  for(let i=0;i<4;i++)ordered.push({...main[(offset+i)%6],condition:(i+parity)%2?'diagnostic':'raw'});
  requireValue(new Set(ordered.map(t=>t.rootCauseId)).size===ordered.length,'Participant would repeat a root cause');return ordered;
}
export function materialPacket(task,dataset){
  if(task.adapter==='repair-v2'){
    const original=dataset.repair.tasks.find(t=>t.id===task.catalogTaskId);requireValue(original,'Missing actual task');
    return {cases:original.cases,sources:original.files,evidence:original.evidence,limits:original.limits,sourceScope:'Exact same before-only multi-file packet in both conditions.'};
  }
  const natural=dataset.natural,cases=natural.cases.filter(c=>c.family===task.family),sourceIds=new Set(cases.flatMap(c=>c.sourceRefs)),evidenceIds=new Set(cases.flatMap(c=>c.evidenceRefs));
  return {cases,sources:natural.sources.filter(s=>sourceIds.has(s.id)),evidence:natural.evidence.filter(e=>evidenceIds.has(e.id)),limits:natural.limits,sourceScope:'Before-only development practice; excluded from primary scoring.'};
}
export function validateAnswer(answer,task,dataset){
  const errors=[],packet=materialPacket(task,dataset),ids=new Set([...packet.cases.map(c=>c.id),...packet.evidence.map(e=>e.id)]);
  if(!answer.diagnosis?.trim())errors.push('请填写解释或明确写“未定位”。');
  if(!Number.isInteger(answer.confidence)||answer.confidence<0||answer.confidence>100)errors.push('信心必须为 0–100。');
  if(!['observed','inferred','unknown'].includes(answer.evidenceBasis))errors.push('请选择证据解释。');
  if(answer.evidenceIds.some(id=>!ids.has(id)))errors.push('当前任务不存在该证据 ID。');
  if(!Array.isArray(answer.edits)){errors.push('补丁必须是 JSON 数组；没有补丁请填 []。');return errors;}
  const texts=new Map(packet.sources.map(s=>[s.id,s.text]));
  for(const edit of answer.edits){const file=packet.sources.find(s=>s.id===edit.source_id);if(!file||file.role!=='implementation'||typeof edit.old!=='string'||typeof edit.new!=='string'||!edit.old||edit.old===edit.new){errors.push('补丁须是 implementation 文件中的非空精确替换。');break;}const before=texts.get(file.id);const at=before.indexOf(edit.old);if(at<0||before.indexOf(edit.old,at+1)!==-1){errors.push('旧文本须按顺序在候选文件中恰好出现一次。');break;}texts.set(file.id,before.slice(0,at)+edit.new+before.slice(at+edit.old.length));}
  return errors;
}
