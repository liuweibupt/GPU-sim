/** Six fresh prompt-only candidate calls; generated source is never repaired. */
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
const output=path.resolve(process.argv[2]??'out/research/agent-kernel-eval'),frozen=path.join(output,'frozen');
const hash=v=>createHash('sha256').update(v).digest('hex');
const manifest=JSON.parse(await readFile(path.join(frozen,'manifest.json')));
if(hash(await readFile(path.join(frozen,'hidden-cases.json')))!==manifest.hidden_cases_sha256)throw Error('Hidden cases changed');
const version=execFileSync('codex',['--version'],{encoding:'utf8'}).trim();
async function call(task,rep){
 const id=`${task}-candidate-${rep}`,dir=path.join(output,'candidates',id);await mkdir(dir,{recursive:true});
 try{await access(path.join(dir,'result.json'));throw Error('Refusing rerun '+id);}catch(e){if(e.code!=='ENOENT')throw e;}
 const prompt=await readFile(path.join(frozen,task+'.prompt.txt'),'utf8');if(hash(prompt)!==manifest.prompt_sha256[task])throw Error('Prompt changed');
 const temp=await mkdtemp(path.join(os.tmpdir(),'ai-cuda-candidate-'));const cwd=path.join(temp,'work');await mkdir(cwd);const schema=path.join(temp,'schema.json'),answerFile=path.join(temp,'answer.json');await writeFile(schema,await readFile(path.join(frozen,'response.schema.json')));
 const args=['exec','--ignore-user-config','--ephemeral','--skip-git-repo-check','--json','--color','never','--sandbox','read-only','-C',cwd,'-m','gpt-6-astra','-c','model_reasoning_effort="low"','-c','features.shell_tool=false','--output-schema',schema,'-o',answerFile,'-'];
 const start=performance.now(),startedAt=new Date().toISOString();let stdout='',stderr='',timedOut=false,spawnError=null;const child=spawn('codex',args,{cwd,detached:true,stdio:['pipe','pipe','pipe']});child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.stdin.on('error',()=>{});child.stdin.end(prompt);
 const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGKILL');}catch{}},90000);
 const termination=await new Promise(resolve=>{child.on('error',e=>{spawnError=String(e);resolve({exitCode:null,signal:null});});child.on('close',(exitCode,signal)=>resolve({exitCode,signal}));});clearTimeout(timer);
 const events=[],parseErrors=[];for(const [i,line]of stdout.split('\n').entries())if(line.trim())try{events.push(JSON.parse(line));}catch{parseErrors.push(i+1);}
 const tools=events.filter(e=>(e.item&&!['agent_message','reasoning'].includes(e.item.type))||/tool|command|function_call|web_search/i.test(e.type??''));let answer=null,answerError=null;try{answer=JSON.parse(await readFile(answerFile,'utf8'));}catch(e){answerError=String(e);}
 const validAnswer=answer&&Object.keys(answer).sort().join(',')==='notes,source'&&typeof answer.source==='string'&&answer.source.length>0&&typeof answer.notes==='string';
 const valid=!timedOut&&!spawnError&&termination.exitCode===0&&!parseErrors.length&&!tools.length&&events.some(e=>e.type==='turn.completed')&&!events.some(e=>['error','turn.failed'].includes(e.type))&&validAnswer;
 if(validAnswer)await writeFile(path.join(dir,'candidate.cu'),answer.source); // Exact response string, no prefix/suffix or manual fixes.
 await writeFile(path.join(dir,'prompt.txt'),prompt);await writeFile(path.join(dir,'source.jsonl'),stdout);await writeFile(path.join(dir,'stderr.txt'),stderr);if(answer)await writeFile(path.join(dir,'answer.json'),JSON.stringify(answer,null,2)+'\n');
 const result={id,task,rep,startedAt,finishedAt:new Date().toISOString(),wallSeconds:(performance.now()-start)/1000,cliVersion:version,requestedModel:'gpt-6-astra',resolvedSnapshot:null,reasoningEffort:'low',budget:{timeoutSeconds:90,repairRounds:0},command:['codex',...args],freshCwd:cwd,initialCwdEmpty:true,promptSHA256:hash(prompt),sourceSHA256:validAnswer?hash(answer.source):null,valid,timedOut,spawnError,...termination,parseErrors,toolContamination:tools,answerError,usage:events.filter(e=>e.type==='turn.completed').map(e=>e.usage),threadId:events.find(e=>e.type==='thread.started')?.thread_id??null};
 await writeFile(path.join(dir,'result.json'),JSON.stringify(result,null,2)+'\n');await rm(temp,{recursive:true,force:true});console.log(JSON.stringify({id,valid,wallSeconds:result.wallSeconds,sourceSHA256:result.sourceSHA256}));return result;
}
const results=[];for(const task of ['rmsnorm','transpose','segments'])results.push(...await Promise.all([1,2].map(rep=>call(task,rep))));
await writeFile(path.join(output,'generation-summary.json'),JSON.stringify({finishedAt:new Date().toISOString(),fixtureSHA256:manifest.hidden_cases_sha256,cliVersion:version,plannedCalls:6,actualCalls:results.length,results,scope:'Two candidates per operator from one model/configuration; no feedback and no human/independent-model inference.'},null,2)+'\n');
