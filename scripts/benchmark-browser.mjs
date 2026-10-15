// Optional developer tool: install Playwright separately; no production dependency.
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import {writeFile} from 'node:fs/promises';
const url=process.argv[2] || 'http://127.0.0.1:4173/web/';
const out=process.argv[3] || '/tmp/gpu-sim-browser-benchmark.json';
const browser=await chromium.launch({...(process.env.CHROME_BIN ? {executablePath:process.env.CHROME_BIN} : {}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'no-preference'});
const errors=[];page.on('pageerror',e=>errors.push(String(e)));
const session=await page.context().newCDPSession(page);await session.send('Performance.enable');
await page.goto(url,{waitUntil:'networkidle'});await page.waitForFunction(()=>document.querySelector('#play').getAttribute('aria-pressed')==='true');
async function measure(label){
 await page.evaluate(()=>{
  window.__perf={frames:[],longTasks:[],mutations:0};let last=performance.now();
  window.__perfRAF=requestAnimationFrame(function tick(now){window.__perf.frames.push(now-last);last=now;window.__perfRAF=requestAnimationFrame(tick);});
  window.__perfPO=new PerformanceObserver(list=>{for(const e of list.getEntries())window.__perf.longTasks.push({start:e.startTime,duration:e.duration});});window.__perfPO.observe({type:'longtask',buffered:false});
  window.__perfMO=new MutationObserver(list=>{window.__perf.mutations+=list.length;});window.__perfMO.observe(document.querySelector('#gpu-world'),{subtree:true,childList:true,attributes:true,characterData:true});
 });
 const before=(await session.send('Performance.getMetrics')).metrics;
 const start=Date.now();await page.waitForTimeout(12000);
 const after=(await session.send('Performance.getMetrics')).metrics;
 const raw=await page.evaluate(()=>{cancelAnimationFrame(window.__perfRAF);window.__perfPO.disconnect();window.__perfMO.disconnect();return {...window.__perf,domNodes:document.querySelectorAll('*').length,worldDomNodes:document.querySelector('#gpu-world').querySelectorAll('*').length,playing:document.querySelector('#play').getAttribute('aria-pressed'),selected:document.querySelector('#sample-select').value};});
 const sorted=raw.frames.slice().sort((a,b)=>a-b),metric={};for(const name of ['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount','JSHeapUsedSize','Nodes']){const a=after.find(m=>m.name===name)?.value,b=before.find(m=>m.name===name)?.value;metric[name]=name.endsWith('Size')||name==='Nodes'?a:a-b;}
 const result={label,elapsedMs:Date.now()-start,frames:raw.frames.length,averageFrameGapMs:raw.frames.reduce((a,b)=>a+b,0)/raw.frames.length,p50FrameGapMs:sorted[Math.floor(sorted.length*.5)],p95FrameGapMs:sorted[Math.floor(sorted.length*.95)],p99FrameGapMs:sorted[Math.floor(sorted.length*.99)],maxFrameGapMs:sorted.at(-1),framesOver33ms:raw.frames.filter(v=>v>33).length,framesOver50ms:raw.frames.filter(v=>v>50).length,longTaskCount:raw.longTasks.length,longTaskTimeMs:raw.longTasks.reduce((a,b)=>a+b.duration,0),maxLongTaskMs:Math.max(0,...raw.longTasks.map(t=>t.duration)),worldMutations:raw.mutations,domNodes:raw.domNodes,worldDomNodes:raw.worldDomNodes,playing:raw.playing,sample:raw.selected,metric};console.log(JSON.stringify(result));return result;
}
const traffic=await measure('traffic');
await page.locator('[data-gpu-component-id="sm-0"]').first().click();
await page.waitForFunction(()=>document.querySelector('#sample-select').value==='sm' && document.querySelector('#play').getAttribute('aria-pressed')==='true');
await page.waitForTimeout(750);
const sm=await measure('sm');
await writeFile(out,JSON.stringify({url,browser:await browser.version(),traffic,sm,errors},null,2));
await browser.close();
