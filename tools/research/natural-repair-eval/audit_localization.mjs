/** Explicit post-hoc audit; never replaces the frozen primary scores. */
import {readFile,writeFile} from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
const root=path.resolve(process.argv[2]??'out/research/natural-repair-eval');
const gen=JSON.parse(await readFile(path.join(root,'generation-summary.json'))),tasks=JSON.parse(await readFile(path.join(root,'frozen/tasks.json'))),rows=[];
for(const trial of gen.results){
 const task=tasks.find(t=>t.family===trial.family),data=JSON.parse(await readFile(path.join(root,'frozen',task.dataFile))),a=JSON.parse(await readFile(path.join(root,'trials',trial.id,'answer.json')));
 const locations=a.locations.map(l=>{const s=data.sources.find(s=>s.id===l.source_id);return {...l,exists:Boolean(s),valid:Boolean(s&&Number.isInteger(l.start_line)&&Number.isInteger(l.end_line)&&l.start_line>=1&&l.end_line>=l.start_line&&l.end_line-l.start_line<40&&l.end_line<=s.text.split('\n').length)};});
 const observed=new Set(data.evidence.filter(e=>['execution-observation','device-output'].includes(e.kind)).map(e=>e.id));
 const coverage=data.cases.filter(c=>a.evidence_ids.includes(c.id)||c.evidenceRefs.some(id=>observed.has(id)&&a.evidence_ids.includes(id))).map(c=>({id:c.id,status:c.status}));
 const failure=coverage.some(c=>['timeout','wrong_value'].includes(c.status)),control=coverage.some(c=>c.status==='passed');
 rows.push({id:trial.id,original:trial.scores,providedSourceLocations:locations,strictObservedCoverage:coverage,strictFailureAndControlCovered:failure&&control,providedSourceLocationsValid:locations.length>0&&locations.every(l=>l.valid),postHocSupported:trial.scores.locationHit&&trial.scores.referencesValid&&failure&&control&&locations.length>0&&locations.every(l=>l.valid)});
}
const source=await readFile(new URL(import.meta.url));const report={format:'natural-repair-posthoc-localization-audit-v1',createdAt:new Date().toISOString(),sourceSHA256:createHash('sha256').update(source).digest('hex'),scope:'Secondary audit after seeing generated locations. Original frozen scores remain unchanged. Accept locations in any supplied source; require actual case/output evidence for failure and control, not a shared static IR fact alone.',rows};await writeFile(path.join(root,'localization-posthoc-audit.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({trials:rows.length,originalSupported:rows.filter(x=>x.original.supportedLocalization).length,locationHits:rows.filter(x=>x.original.locationHit).length,secondarySupported:rows.filter(x=>x.postHocSupported).length}));
