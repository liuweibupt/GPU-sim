/** Convert untouched participant exact edits to the existing GPU executor format. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {applyEdits,RESPONSE_SCHEMA} from '../repair-study-v2/core.mjs';
const args=process.argv.slice(2),get=key=>args[args.indexOf(key)+1];
for(const key of ['--catalog','--session','--output'])if(!args.includes(key))throw Error('Required '+key);
const catalogRaw=await fs.readFile(get('--catalog')),catalog=JSON.parse(catalogRaw),session=JSON.parse(await fs.readFile(get('--session'),'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
if(session.format!=='gpu-human-diagnostic-study-v2'||session.catalogSha256!==sha(catalogRaw))throw Error('Participant export/catalog binding mismatch');
if(session.status==='running')throw Error('No feedback or patch execution during an active session');
const output=get('--output');await fs.mkdir(output,{recursive:false});const rows=[];
for(const assignment of session.taskOrder.filter(t=>t.stage==='main')){
 const response=session.responses.find(r=>r.taskId===assignment.id),task=catalog.tasks.find(t=>t.id===assignment.id);
 if(!task)throw Error('Unknown task');
 const row={taskId:task.id,condition:assignment.condition,participantId:session.participantId,mode:session.mode,status:'not_submitted',candidateTreeSHA256:null};
 if(response?.answer?.edits?.length){try{
  const query=Object.fromEntries(Object.keys(RESPONSE_SCHEMA.properties.query.properties).map(key=>[key,key==='op'?'none':null]));
  const answer={action:'final',query,diagnosis:response.answer.diagnosis,locations:[],citations:[],edits:response.answer.edits};
  const candidate=applyEdits(task,answer),file=path.join(output,task.id+'.candidate.json');await fs.writeFile(file,JSON.stringify(candidate,null,2)+'\n');row.status='materialized_not_executed';row.candidateTreeSHA256=candidate.candidateTreeSHA256;row.candidateFile=file;
 }catch(error){row.status='invalid_candidate';row.reason=error.message;}}
 rows.push(row);
}
const result={format:'human-candidate-materialization-v2',scope:session.mode==='formal'?'Exact participant edits only; no repair success until independent GPU validation.':'SOFTWARE DRY-RUN CANDIDATES; NOT HUMAN EVIDENCE',sessionSha256:sha(await fs.readFile(get('--session'))),catalogSha256:sha(catalogRaw),plannedMainTasks:rows.length,rows};await fs.writeFile(path.join(output,'materialization.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
