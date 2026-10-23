/** Frozen matched-information agent repair experiment with actual bounded queries. */
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,mkdtemp,rm,access} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {queryDiagnostic,validateDiagnostic} from '../../../lib/research/natural-diagnostic.js';
import {auditJSONL} from '../agent-eval/run.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
export const sha=x=>createHash('sha256').update(x).digest('hex');
const save=(p,x)=>writeFile(p,JSON.stringify(x,null,2)+'\n');
export function compact(x){
 if(Array.isArray(x)){
  if(x.length>64&&x.every(v=>typeof v==='number')){const runs=[];for(const v of x){const last=runs.at(-1);if(last&&Object.is(last.value,v))last.count++;else runs.push({value:v,count:1});}return {encoding:'lossless-run-length',length:x.length,runs};}
  return x.map(compact);
 }
 if(x&&typeof x==='object')return Object.fromEntries(Object.entries(x).map(([k,v])=>[k,compact(v)]));
 return x;
}
export function familyData(data,family){
 const cases=data.cases.filter(c=>c.family===family),eids=new Set(cases.flatMap(c=>c.evidenceRefs)),sids=new Set(cases.flatMap(c=>c.sourceRefs));
 const evidence=data.evidence.filter(e=>eids.has(e.id));for(const e of evidence)if(e.sourceId)sids.add(e.sourceId);
 return validateDiagnostic({...data,cases,evidence,sources:data.sources.filter(s=>sids.has(s.id))});
}
export function queryForCondition(data,condition,request){
 const allowed=condition==='raw'?['cases','list_cases','case','evidence','source']:['cases','list_cases','case','evidence','source','overlap','contrast'];
 if(!allowed.includes(request.op))throw Error('Operation unavailable in this condition');
 return compact(queryDiagnostic(data,Object.fromEntries(Object.entries(request).filter(([,v])=>v!==null))));
}
const querySchema={type:'object',additionalProperties:false,properties:{op:{type:'string'},id:{type:['string','null']},start:{type:['integer','null']},end:{type:['integer','null']},search:{type:['string','null']},groupBy:{type:['array','null'],items:{type:'string'}}},required:['op','id','start','end','search','groupBy']};
const schema={type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['query','final']},query:querySchema,diagnosis:{type:'string'},locations:{type:'array',items:{type:'object',additionalProperties:false,properties:{source_id:{type:'string'},start_line:{type:'integer'},end_line:{type:'integer'}},required:['source_id','start_line','end_line']}},evidence_ids:{type:'array',items:{type:'string'}},edits:{type:'array',items:{type:'object',additionalProperties:false,properties:{old:{type:'string'},new:{type:'string'}},required:['old','new']}}},required:['action','query','diagnosis','locations','evidence_ids','edits']};
export async function freeze(out,benchmark){
 await mkdir(path.join(out,'frozen'),{recursive:false});const dir=path.join(out,'frozen');
 const raw=await readFile(benchmark),data=validateDiagnostic(JSON.parse(raw));if(data.scope!=='before-only')throw Error('After/fix data not permitted');
 await writeFile(path.join(dir,'benchmark-before.json'),raw);await save(path.join(dir,'response.schema.json'),schema);
 const protocol={format:'natural-repair-agent-protocol-v1',frozenAt:new Date().toISOString(),model:'gpt-6-astra',reasoning:'low',roots:2,repetitions:3,conditions:['raw','diagnostic'],trials:12,maxQueries:2,maxCalls:3,timeoutSecondsPerCall:90,maxConcurrency:2,firstRound:'Both conditions must make one query; diagnostic must use overlap or contrast, raw uses a raw read. Then finish or make one additional query.',feedbackRounds:0,repairScoring:{patch:'Exact unique-match edits to one supplied file; no coordinator changes.',compile:'Actual candidate compilation; failures stay in denominator.',cutlass:'All 18 frozen cases required; full FP8 observed/reference bytes independently checked, unique valid group IDs and shapes, independent beta*C for zero K, memcheck complete zero summary.',tmem:'All 48 cases required; actual complete output against independently derived constants, native compiler hash bound; missing/aborted cases fail. Upstream CPU allocation lit separately scored.',resource:'No claim of performance or optimal allocation; correctness success does not prove minimal repair.'},queryResponseLimitBytes:180000,rawOps:['cases','list_cases','case','evidence','source'],diagnosticExtraOps:['overlap','contrast'],limitations:['Two selected public defects with prelocalized single-file repair boundaries. Not a held-out root-cause population.','Input visibility is prompt/cwd/tool-audit bounded, not proof of training-data exclusion.','Structured request/response uses the same backend as the UI; no visual agent or human outcome is measured.','Per-call time includes service/queue/network. Maximum calls and time equal; actual token use is measured, not forcibly equalized.','No diagnostic/repair feedback between independent trials. Different trial responses never enter one another.','Batched fresh CLI calls replay only within-trial visible history; no persisted model hidden reasoning state.']};
 const hidden=path.join(out,'hidden-v1');const hiddenHashes={};for(const f of ['plan.json','regression_0.py','regression_1.py','regression_2.py'])hiddenHashes[f]=sha(await readFile(path.join(hidden,f)));
 const tasks=[];
 for(const family of ['cutlass','tmem']){
  const d=familyData(data,family),source=d.sources.find(s=>s.path===(family==='cutlass'?'collective.hpp':'TensorMemoryAllocation.cpp'));if(!source)throw Error('Missing editable source');if(sha(source.text)!==source.sha256)throw Error('Source mismatch');
  const constraints=family==='cutlass'?'Repair the beta=0 empty-K grouped GEMM behavior on H100/SM90. beta=1 also fails positive controls and is outside this repair objective. Preserve positive-K computation and pipeline semantics.':'Repair the selected TMEM descriptor wrong values on B200/SM100 in the compiler. Preserve legal reuse and existing allocation/layout behavior; do not change the runtime test, outputs, or assertions.';
  await writeFile(path.join(dir,family+'.before'),source.text);await save(path.join(dir,family+'.data.json'),d);
  const task={id:family,family,sourceId:source.id,sourceSHA256:source.sha256,sourceFile:family+'.before',dataFile:family+'.data.json',constraints,locationRegions:family==='cutlass'?[[723,1063],[1066,1071]]:[[120,151]],locationMeaning:'A maximum-40-line cited interval hits a predeclared relevant function. This is localization, not semantic grading of explanation.',referenceRule:'Cite at least one observed failing case/fact and one passing control case/fact. IDs must belong to this family.'};tasks.push(task);
  const base=`Diagnose and repair this input implementation. ${constraints}\nYou may edit ONLY ${source.path} (${source.id}), which is supplied in full below. Return exact sequential unique-match text edits {old,new}; include whitespace exactly. No external commands, browsing, files, tests, or other tool access is available. Do not modify tests or hardcode outputs. Cite at most 40 lines per location and evidence/case IDs supporting failure and a passing control. Explain limitations in diagnosis. Location and repair success are scored separately.\nYou have at most two query requests and one final answer. Round 1 MUST query; later rounds may finish. The last round must be final. Query/answer use the required JSON schema; when querying, locations/evidence_ids/edits may be empty. When final, set query.op to 'none' with other fields null. No compilation/test feedback will be supplied.\nRaw operations: cases/list_cases (all case metadata); case(id) (case+raw facts); evidence(id); source(id,start,end,search), literal search. Numeric arrays may be reversibly encoded as {encoding:'lossless-run-length',length,runs:[{value,count}]}; this preserves every element.\n`;
  const packet=JSON.stringify(compact(d));await writeFile(path.join(dir,family+'.packet.json'),packet+'\n');
  for(const condition of protocol.conditions){const extra=condition==='diagnostic'?`Additional diagnostic operations: contrast(groupBy:['beta','hasZeroK']) groups supplied statuses; overlap(id=caseId) parses static compiler MLIR for selected-descriptor storage overlap. These are bounded derived results, not hardware timestamps. First query MUST use contrast or overlap.\n`:`This condition has ordinary raw evidence/source reads only; overlap and contrast are unavailable. First query MUST use an allowed raw operation.\n`;await writeFile(path.join(dir,`${family}.${condition}.prompt.txt`),base+extra+'\nINPUT PACKET (identical in both conditions):\n'+packet);}
 }
 await save(path.join(dir,'tasks.json'),tasks);await save(path.join(dir,'protocol.json'),protocol);
 const files=['benchmark-before.json','response.schema.json','tasks.json','protocol.json',...tasks.flatMap(t=>[t.sourceFile,t.dataFile,t.family+'.packet.json',...protocol.conditions.map(c=>`${t.family}.${c}.prompt.txt`)])];const hashes={};for(const f of files)hashes[f]=sha(await readFile(path.join(dir,f)));
 const sources={};for(const f of ['tools/research/natural-repair-eval/experiment.mjs','tools/research/natural-repair-eval/hidden_gpu.py','tools/research/natural-repair-eval/prepare_hidden.py','lib/research/natural-diagnostic.js']){const raw=await readFile(path.join(ROOT,f));sources[f]=sha(raw);const p=path.join(dir,'source',f);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,raw);}
 await save(path.join(dir,'manifest.json'),{format:'natural-repair-freeze-v1',frozenAt:protocol.frozenAt,files:hashes,hidden: hiddenHashes,sources});return protocol;
}
export async function verifyFreeze(out){const dir=path.join(out,'frozen'),m=JSON.parse(await readFile(path.join(dir,'manifest.json')));for(const [f,h]of Object.entries(m.files))if(sha(await readFile(path.join(dir,f)))!==h)throw Error('Changed freeze '+f);for(const[f,h]of Object.entries(m.hidden))if(sha(await readFile(path.join(out,'hidden-v1',f)))!==h)throw Error('Changed hidden '+f);for(const[f,h]of Object.entries(m.sources))if(sha(await readFile(path.join(ROOT,f)))!==h)throw Error('Changed execution source '+f);return {manifest:m,protocol:JSON.parse(await readFile(path.join(dir,'protocol.json'))),tasks:JSON.parse(await readFile(path.join(dir,'tasks.json')))};}
export function localization(task,data,answer){
 const locations=answer?.locations??[],valid=locations.filter(l=>l.source_id===task.sourceId&&Number.isInteger(l.start_line)&&Number.isInteger(l.end_line)&&l.start_line>=1&&l.end_line>=l.start_line&&l.end_line-l.start_line<40&&l.end_line<=data.sources.find(s=>s.id===task.sourceId).text.split('\n').length);
 const hit=valid.some(l=>task.locationRegions.some(([a,b])=>l.start_line<=b&&l.end_line>=a));const ids=answer?.evidence_ids??[],known=new Set([...data.cases,...data.evidence].map(x=>x.id));const refsValid=ids.length>0&&new Set(ids).size===ids.length&&ids.every(id=>known.has(id));
 const covers=status=>data.cases.some(c=>c.status===status&&[c.id,...c.evidenceRefs].some(id=>ids.includes(id)));const failing=['wrong_value','timeout'].some(covers),passing=covers('passed');
 return {locationHit:hit,allLocationsValid:valid.length===locations.length&&locations.length>0,referencesValid:refsValid,failureAndControlCovered:failing&&passing,supportedLocalization:hit&&valid.length===locations.length&&refsValid&&failing&&passing};
}
async function invoke(prompt,dir,round,protocol,schemaBytes){
 const tmp=await mkdtemp(path.join(os.tmpdir(),'natural-repair-')),cwd=path.join(tmp,'work');await mkdir(cwd);const schema=path.join(tmp,'schema.json'),answerPath=path.join(tmp,'answer.json');await writeFile(schema,schemaBytes);
 const args=['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--json','--color','never','--sandbox','read-only','-C',cwd,'-m',protocol.model,'-c',`model_reasoning_effort="${protocol.reasoning}"`,'-c','features.shell_tool=false','--output-schema',schema,'-o',answerPath,'-'];
 const startedAt=new Date().toISOString(),start=performance.now();let stdout='',stderr='',timedOut=false,error=null;const p=spawn('codex',args,{cwd,detached:true,stdio:['pipe','pipe','pipe']});p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.stdin.on('error',()=>{});p.stdin.end(prompt);const timer=setTimeout(()=>{timedOut=true;try{process.kill(-p.pid,'SIGKILL');}catch{}},protocol.timeoutSecondsPerCall*1000);const term=await new Promise(resolve=>{p.on('error',e=>{error=String(e);resolve({exitCode:null,signal:null});});p.on('close',(exitCode,signal)=>resolve({exitCode,signal}));});clearTimeout(timer);
 const audit=auditJSONL(stdout);let answer=null;try{answer=JSON.parse(await readFile(answerPath,'utf8'));}catch{}
 const finalEvents=audit.events.filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message');let finalMatches=false;try{finalMatches=JSON.stringify(JSON.parse(finalEvents.at(-1).item.text))===JSON.stringify(answer);}catch{}
 const valid=!timedOut&&!error&&term.exitCode===0&&audit.complete&&!audit.failed.length&&!audit.parseErrors.length&&!audit.forbidden.length&&answer&&['query','final'].includes(answer.action)&&finalMatches;
 const record={round,startedAt,finishedAt:new Date().toISOString(),wallSeconds:(performance.now()-start)/1000,command:['codex',...args],promptSHA256:sha(prompt),...term,timedOut,error,valid:Boolean(valid),finalMatches,answer,audit:{forbidden:audit.forbidden,parseErrors:audit.parseErrors,failed:audit.failed,threadId:audit.threadId},usage:audit.usage};
 await writeFile(path.join(dir,`round-${round}.prompt.txt`),prompt);await writeFile(path.join(dir,`round-${round}.jsonl`),stdout);await writeFile(path.join(dir,`round-${round}.stderr.txt`),stderr);await save(path.join(dir,`round-${round}.json`),record);await rm(tmp,{recursive:true,force:true});return record;
}
async function trial(out,task,condition,rep,protocol){
 const id=`${task.id}.${condition}.r${rep}`,dir=path.join(out,'trials',id);await mkdir(dir,{recursive:false});const data=JSON.parse(await readFile(path.join(out,'frozen',task.dataFile))),base=await readFile(path.join(out,'frozen',`${task.id}.${condition}.prompt.txt`),'utf8'),schemaBytes=await readFile(path.join(out,'frozen','response.schema.json'));
 const result={format:'natural-repair-trial-v1',id,family:task.family,condition,rep,startedAt:new Date().toISOString(),calls:[],queries:[],valid:false};let transcript='',answer=null;
 for(let round=1;round<=protocol.maxCalls;round++){
  const prompt=base+transcript+`\nROUND ${round}/${protocol.maxCalls}. ${round===1?'Return your required first query.':round===protocol.maxCalls?'Return final repair now.':'You may query once more or return final repair.'}`;const call=await invoke(prompt,dir,round,protocol,schemaBytes);result.calls.push(call);if(!call.valid){result.failure='invalid-model-call';break;}
  if(call.answer.action==='final'){
   if(round===1){result.failure='mandatory-query-skipped';break;}answer=call.answer;result.valid=true;await save(path.join(dir,'answer.json'),answer);break;
  }
  if(round===protocol.maxCalls){result.failure='query-budget-exhausted';break;}
  const req=call.answer.query;
  if(round===1&&condition==='diagnostic'&&!['overlap','contrast'].includes(req.op)){result.failure='mandatory-diagnostic-query-skipped';break;}
  const start=performance.now();let response;
  try{response=queryForCondition(data,condition,req);}catch(e){response={error:String(e)};}
  let raw=JSON.stringify(response);if(Buffer.byteLength(raw)>protocol.queryResponseLimitBytes){response={error:'Response exceeds fixed byte limit; narrow source range or evidence ID.'};raw=JSON.stringify(response);}
  const query={round,request:req,response,wallMilliseconds:performance.now()-start,responseSHA256:sha(raw)};result.queries.push(query);await save(path.join(dir,`query-${round}.json`),query);transcript+='\nYOUR PREVIOUS REQUEST:\n'+JSON.stringify(call.answer)+'\nQUERY RESPONSE:\n'+raw;
 }
 result.finishedAt=new Date().toISOString();result.scores=localization(task,data,answer);result.modelWallSeconds=result.calls.reduce((s,c)=>s+c.wallSeconds,0);result.queryMilliseconds=result.queries.reduce((s,q)=>s+q.wallMilliseconds,0);result.usage={};for(const c of result.calls)for(const u of c.usage)for(const[k,v]of Object.entries(u??{}))if(typeof v==='number')result.usage[k]=(result.usage[k]??0)+v;
 await save(path.join(dir,'result.json'),result);console.log(JSON.stringify({id,valid:result.valid,calls:result.calls.length,location:result.scores.supportedLocalization,seconds:result.modelWallSeconds}));return result;
}
async function main(){const mode=process.argv[2],out=path.resolve(process.argv[3]??'out/research/natural-repair-eval');if(mode==='freeze'){console.log(JSON.stringify(await freeze(out,path.resolve(process.argv[4]??'tools/research/natural-diagnostic/benchmark-before.json'))));return;}const{protocol,tasks,manifest}=await verifyFreeze(out);if(mode==='verify'){console.log(JSON.stringify({status:'verified',frozenAt:manifest.frozenAt}));return;}if(mode!=='run')throw Error('Use freeze/run/verify');await mkdir(path.join(out,'trials'),{recursive:false});const results=[];const cliVersion=execFileSync('codex',['--version'],{encoding:'utf8'}).trim();for(let rep=1;rep<=protocol.repetitions;rep++)for(const task of rep%2?tasks:[...tasks].reverse()){
 const conditions=rep%2?protocol.conditions:[...protocol.conditions].reverse();const batch=await Promise.all(conditions.map(c=>trial(out,task,c,rep,protocol)));results.push(...batch);await save(path.join(out,'generation-summary.json'),{protocol,cliVersion,resolvedSnapshot:null,results,completedTrials:results.length,plannedTrials:protocol.trials});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e);process.exitCode=1;});
