#!/usr/bin/env node
/** Stage-separated, warm-file-cache CPU costs on exact real-hardware bridge captures. */
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import {checkProtocol} from '../../../lib/research/protocol.js';
import {sliceEvidence} from '../../../lib/research/evidence.js';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const sha=x=>createHash('sha256').update(x).digest('hex');
const json=x=>JSON.stringify(x)+'\n';
const insist=(v,m)=>{if(!v)throw Error(m);};
const sources=['tools/research/costs/analysis-cost.mjs','lib/research/protocol.js','lib/research/evidence.js'];

export function quantiles(values) {
  const a=[...values].sort((x,y)=>x-y);
  insist(a.length>0,'empty distribution');
  const q=p=>{const x=(a.length-1)*p,lo=Math.floor(x),hi=Math.ceil(x);return a[lo]+(a[hi]-a[lo])*(x-lo);};
  return {n:a.length,min:a[0],p05:q(.05),median:q(.5),p95:q(.95),max:a.at(-1)};
}
export function selectedQueries(run) {
  // Three reproducible user query classes. A single query retrieves its complete
  // evidence slice, possibly retaining other obligations sharing those subjects.
  const wanted=[run.obligations.find(o=>o.kind==='value-generation'),
    run.obligations.find(o=>o.kind==='completion-before-consume'),
    run.obligations.findLast(o=>o.kind==='reader-before-reuse')];
  return [...new Map(wanted.filter(Boolean).map(o=>[o.id,o])).values()].map(o=>({id:o.id,subjects:o.subjectIds}));
}
export function verifySlice(run,slice,id) {
  const obligation=run.obligations.find(o=>o.id===id);
  insist(JSON.stringify(slice.obligations.find(o=>o.id===id))===JSON.stringify(obligation),'slice changed obligation');
  for(const ref of [...obligation.positiveWitnessRefs,...obligation.unknownRefs])
    insist(slice.evidence.some(f=>f.id===ref),'slice dropped evidence');
}

function prepare(inputs,output) {
  mkdirSync(output,{recursive:false});mkdirSync(join(output,'captures'));
  mkdirSync(join(output,'source-snapshots'));
  for(const path of sources)writeFileSync(join(output,'source-snapshots',path.replaceAll('/','__')),readFileSync(join(ROOT,path)));
  const entries=[],inputManifests=[];
  for(const [name,input] of inputs) {
    const rawSummary=readFileSync(join(input,'summary.json')),summary=JSON.parse(rawSummary);
    inputManifests.push({name,path:input,sha256:sha(rawSummary),rows:summary.rows.length});
    for(const [i,row] of summary.rows.entries()) {
      const filename=row.file??row.result,raw=readFileSync(join(input,filename));
      insist(sha(raw)===row.resultSha256&&raw.length===row.resultBytes,'compressed evidence binding failed');
      const unpacked=gunzipSync(raw);
      insist(sha(unpacked)===row.uncompressedSha256&&unpacked.length===row.uncompressedBytes,'decompressed evidence binding failed');
      const stored=JSON.parse(unpacked),capture=stored.capture,run=checkProtocol(capture);
      insist(JSON.stringify(run)===JSON.stringify(stored.run),'recomputed protocol result changed');
      const queries=selectedQueries(run);insist(queries.length>0,'no query available');
      const sliceSummaries=queries.map(q=>{const slice=sliceEvidence(run,q.subjects);verifySlice(run,slice,q.id);
        return {...q,bytes:Buffer.byteLength(JSON.stringify(slice)),sha256:sha(JSON.stringify(slice))};});
      const serialized=Buffer.from(json(capture)),path=`captures/${name}-${i}.json`;
      writeFileSync(join(output,path),serialized);
      entries.push({id:`${name}-${i}`,family:name,path,sha256:sha(serialized),inputBytes:serialized.length,
        originalResult:{path:join(input,filename),sha256:sha(raw),bytes:raw.length,uncompressedBytes:unpacked.length},
        device:row.device??'NVIDIA B200',variant:row.variant,generations:row.generations??row.iterations,
        events:capture.events.length,observedEvents:capture.facts.filter(f=>['hardware-event','hardware-instrumentation-record'].includes(f.kind)).length,
        facts:capture.facts.length,hbEdges:capture.hb.length,obligations:run.obligations.length,
        queries:sliceSummaries,runSha256:sha(JSON.stringify(run)),runBytes:Buffer.byteLength(JSON.stringify(run))});
    }
  }
  const sourceHashes=Object.fromEntries(sources.map(path=>[path,sha(readFileSync(join(ROOT,path)))]));
  const manifest={format:'real-capture-cost-inputs-v1',inputManifests,entries,sourceHashes,
    transformation:'Exact capture object parsed from SHA-verified real-hardware bridge result, serialized compactly; no synthesized events or expanded states.',
    preparationExcluded:'Full archive read/gunzip/parse, provenance/hash verification and independent checkProtocol recomputation are preparation, never included in stage timing.'};
  writeFileSync(join(output,'inputs.json'),JSON.stringify(manifest,null,2)+'\n');
  console.log(json({status:'prepared',captures:entries.length,bytes:entries.reduce((n,e)=>n+e.inputBytes,0)}));
}

function random(seed) {return ()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/4294967296;};}
function shuffle(a,rng) {for(let i=a.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function memory(){const m=process.memoryUsage();return {rss:m.rss,heapUsed:m.heapUsed,external:m.external};}
function worker(input,output,session,warmups,samples) {
  const manifest=JSON.parse(readFileSync(join(input,'inputs.json')));
  for(const [path,hash] of Object.entries(manifest.sourceHashes))insist(sha(readFileSync(join(ROOT,path)))===hash,'analysis source changed');
  const rng=random(20261023+session),rows=[];
  const timed=fn=>{const t=performance.now(),value=fn();return {value,us:(performance.now()-t)*1000};};
  const environment={node:process.version,cpu:os.cpus()[0].model,platform:os.platform(),release:os.release(),
    affinity:readFileSync('/proc/self/status','utf8').match(/^Cpus_allowed_list:\s*(.*)$/m)?.[1],
    loadAverageBefore:os.loadavg(),start:new Date().toISOString(),memoryBefore:memory()};
  for(const entry of shuffle([...manifest.entries],rng)) {
    let queryIndex=0;
    // First read checks content before warm-up. Repeated reads below deliberately
    // use the OS page cache. They are never described as cold storage performance.
    insist(sha(readFileSync(join(input,entry.path)))===entry.sha256,'capture changed');
    for(let sample=-warmups;sample<samples;sample++) {
      const before=memory();
      const read=timed(()=>readFileSync(join(input,entry.path)));
      const parse=timed(()=>JSON.parse(read.value)); // Includes Buffer -> UTF-8 string conversion.
      const check=timed(()=>checkProtocol(parse.value));
      const query=entry.queries[queryIndex++%entry.queries.length];
      const slice=timed(()=>sliceEvidence(check.value,query.subjects));
      const serializeRun=timed(()=>JSON.stringify(check.value));
      const serializeSlice=timed(()=>JSON.stringify(slice.value));
      // Verification and byte-length accounting are deliberately outside timed spans.
      insist(sha(serializeRun.value)===entry.runSha256,'checker result changed during benchmark');
      insist(sha(serializeSlice.value)===query.sha256,'slice result changed during benchmark');
      const after=memory();
      if(sample>=0)rows.push({session,sample,id:entry.id,family:entry.family,device:entry.device,variant:entry.variant,
        generations:entry.generations,query:query.id,inputBytes:entry.inputBytes,events:entry.events,obligations:entry.obligations,
        read_us:read.us,parse_us:parse.us,check_protocol_us:check.us,slice_us:slice.us,
        serialize_run_us:serializeRun.us,serialize_slice_us:serializeSlice.us,
        runBytes:entry.runBytes,sliceBytes:query.bytes,rssBefore:before.rss,rssAfter:after.rss,
        heapUsedBefore:before.heapUsed,heapUsedAfter:after.heapUsed,externalBefore:before.external,externalAfter:after.external});
    }
  }
  const resourceUsage=process.resourceUsage();
  writeFileSync(output,rows.map(json).join(''));
  writeFileSync(output+'.environment.json',JSON.stringify({...environment,end:new Date().toISOString(),
    loadAverageAfter:os.loadavg(),memoryAfter:memory(),resourceUsage,
    maxRssBytes:resourceUsage.maxRSS*1024,unit:'Linux maxRSS is KiB, converted to bytes.'},null,2)+'\n');
}

function run(input,output,sessions,warmups,samples,affinity) {
  insist(sessions>=3&&warmups>=5&&samples>=10,'require >=3 sessions, >=5 warmups and >=10 samples per capture per session');
  mkdirSync(output,{recursive:false});const environments=[],rows=[],commands=[];
  for(let session=0;session<sessions;session++) {
    const path=join(output,`session-${session}.jsonl`),args=[process.execPath,fileURLToPath(import.meta.url),'worker',input,path,String(session),String(warmups),String(samples)];
    const argv=affinity?['taskset','-c',affinity,...args]:args;
    const result=spawnSync(argv[0],argv.slice(1),{encoding:'utf8',maxBuffer:10*1024*1024});
    commands.push({argv,status:result.status});
    writeFileSync(join(output,`session-${session}.stderr.txt`),result.stderr??'');
    insist(result.status===0,`worker failed ${result.stderr}`);
    rows.push(...readFileSync(path,'utf8').trim().split('\n').map(JSON.parse));
    environments.push(JSON.parse(readFileSync(path+'.environment.json')));
  }
  const stages=['read_us','parse_us','check_protocol_us','slice_us','serialize_run_us','serialize_slice_us'];
  const groups=new Map();
  for(const row of rows){const key=JSON.stringify([row.family,row.device,row.generations]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  const distributions=[...groups].map(([key,values])=>({group:JSON.parse(key),captures:new Set(values.map(v=>v.id)).size,
    inputBytes:quantiles(values.map(v=>v.inputBytes)),events:quantiles(values.map(v=>v.events)),
    stages:Object.fromEntries(stages.map(stage=>[stage,quantiles(values.map(v=>v[stage]))])),
    perSession:Object.fromEntries(Array.from({length:sessions},(_,session)=>[session,Object.fromEntries(stages.map(stage=>[stage,quantiles(values.filter(v=>v.session===session).map(v=>v[stage]))]))]))}));
  const summary={format:'real-capture-analysis-cost-v1',inputManifest:{path:join(input,'inputs.json'),sha256:sha(readFileSync(join(input,'inputs.json')))},
    sessions,warmups,samplesPerCaptureSession:samples,totalSamples:rows.length,environments,commands,distributions,
    timingScopes:{read_us:'Synchronous readFileSync of compact capture JSON; warm OS page cache; allocation included.',
      parse_us:'JSON.parse plus Buffer-to-UTF8 conversion; no disk read, gzip, imports or capture construction.',
      check_protocol_us:'Full checkProtocol including input validation, graph reachability, structured clones and witness construction.',
      slice_us:'One reproducible requested value/completion/reuse query, with complete evidence-preserving slice construction and its internal validation.',
      serialize_run_us:'JSON.stringify of one recomputed run including witnesses; no write/hash/gzip.',
      serialize_slice_us:'JSON.stringify of one complete slice; no write/hash/gzip. Never concatenate all slices.'},
    limitations:['Descriptive shared-host CPU measurements, affinity recorded; shared memory/NUMA/system contention not isolated.',
      'Warm page cache and JIT warmups; allocations and naturally occurring GC remain within stage times. No forced GC, no cold-cache claim.',
      'Input is the exact source-bound capture from previous hardware bridges; acquisition, raw numeric oracle, semantic mapping and archive inflation costs excluded.',
      'Process RSS is sampled across stages and maxRSS is process-wide, not causal or per-operation allocation.',
      'Three selected query classes per capture; not latency for all possible queries or concatenated full-slice export. Earlier string-limit failure remains a scaling limit.']};
  writeFileSync(join(output,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  console.log(json({status:'complete',samples:rows.length,output}));
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [mode,...args]=process.argv.slice(2);
  if(mode==='prepare')prepare(args.slice(1).map(s=>{const split=s.indexOf('=');insist(split>0,'name=path input required');return[s.slice(0,split),resolve(s.slice(split+1))];}),resolve(args[0]));
  else if(mode==='worker')worker(args[0],args[1],Number(args[2]),Number(args[3]),Number(args[4]));
  else if(mode==='run')run(resolve(args[0]),resolve(args[1]),Number(args[2]??3),Number(args[3]??5),Number(args[4]??10),args[5]);
  else throw Error('usage: analysis-cost.mjs prepare OUTPUT tma=BRIDGE tcgen05=BRIDGE | run INPUT OUTPUT [SESSIONS WARMUPS SAMPLES CPU_AFFINITY]');
}
