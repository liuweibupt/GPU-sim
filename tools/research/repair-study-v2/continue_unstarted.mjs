/** Administrative recovery: terminate interrupted trials; never redraw them. */
import {readFile,writeFile,readdir,access} from 'node:fs/promises';
import path from 'node:path';
import {verifyFreeze,runTrial} from './run.mjs';
import {budgetedQuery,scoreLocalization} from './core.mjs';
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const save=(p,d)=>writeFile(p,JSON.stringify(d,null,2)+'\n');
const exists=async p=>{try{await access(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const directory=path.resolve(process.argv[2]);
const study=await verifyFreeze(directory), observedAt=new Date().toISOString();
const receipt={format:'repair-study-external-interruption-v1',observedAt,observedShellExitCode:143,
  cause:'Unknown external SIGTERM of the long-running orchestration shell; no claim about its origin.',
  decision:'Keep completed trials. Terminally mark already-started incomplete trials as infrastructure interruptions without new sampling. Execute only never-started schedule entries with the unchanged frozen runTrial.',
  interrupted:[],continued:[]};
for(const t of study.schedule){
  const dir=path.join(directory,'trials',t.id);
  if(await exists(path.join(dir,'result.json')) || !await exists(dir))continue;
  const names=(await readdir(dir)).filter(n=>/^round-\d+\.json$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
  const calls=await Promise.all(names.map(n=>json(path.join(dir,n))));
  if(calls.some(c=>c.answer?.action==='final'))throw Error('Unexpected retained final answer: requires separate audit, no replacement permitted');
  const task=study.catalog.tasks.find(x=>x.id===t.taskId),spec=study.privatePlan.tasks.find(x=>x.id===t.taskId),state={queries:0,responseCharacters:0};
  const queries=[];
  for(const call of calls){
    if(call.valid&&call.answer.action==='query'){
      const q=await json(path.join(dir,`query-${call.round}.json`));
      const replay=budgetedQuery(task,t.condition,call.answer.query,state,study.protocol);
      if(JSON.stringify(q.response)!==JSON.stringify(replay.response))throw Error('Partial query replay differs');
      queries.push(q);
    }
  }
  const usage={};for(const c of calls)for(const u of c.usage??[])for(const[k,v]of Object.entries(u??{}))if(typeof v==='number')usage[k]=(usage[k]??0)+v;
  const result={format:'repair-study-trial-v2',...t,startedAt:calls[0]?.startedAt??null,finishedAt:observedAt,
    calls,queries,valid:false,failure:'external-runner-interruption',budget:state,
    wallSeconds:calls.length?(new Date(observedAt)-new Date(calls[0].startedAt))/1000:null,
    modelWallSeconds:calls.reduce((s,c)=>s+c.wallSeconds,0),queryWallMilliseconds:queries.reduce((s,q)=>s+q.wallMilliseconds,0),
    localization:scoreLocalization(task,spec,null,study.protocol),patchApplicable:false,candidateTreeSHA256:null,usage,
    interruption:{observedShellExitCode:143,inFlightCallMayBeUnrecorded:true,callCountAndTokensAreRetainedLowerBounds:true,
      trialWallScope:'First retained call start through administrative interruption observation, including unobserved gap; not a completed trial latency.',
      originalCallFilesUnchanged:true,modelResampled:false}};
  await save(path.join(dir,'result.json'),result);receipt.interrupted.push({id:t.id,retainedCalls:calls.length,retainedQueries:queries.length});
}
await save(path.join(directory,'external-interruption.json'),receipt);
const remaining=[];for(const t of study.schedule)if(!await exists(path.join(directory,'trials',t.id)))remaining.push(t);
for(let i=0;i<remaining.length;i+=study.protocol.maxConcurrency){
  await Promise.all(remaining.slice(i,i+study.protocol.maxConcurrency).map(async t=>{
    const result=await runTrial(directory,t,study);receipt.continued.push({id:t.id,valid:result.valid,failure:result.failure});
    console.log(JSON.stringify({id:t.id,valid:result.valid,patchApplicable:result.patchApplicable,seconds:result.wallSeconds}));
  }));
  await save(path.join(directory,'external-interruption.json'),receipt);
}
receipt.continuationFinishedAt=new Date().toISOString();await save(path.join(directory,'external-interruption.json'),receipt);
