#!/usr/bin/env python3
"""Validate measured TMA viewer DOM against all embedded records using real Chrome."""
import argparse
import hashlib
from html import unescape
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

CHECK = r'''<script>
try {
 const api=window.modernViewer,d=api.data,$=id=>document.getElementById(id),assert=(ok,message)=>{if(!ok)throw Error(message);};
 assert(document.documentElement.dataset.ready==='true','viewer not ready');
 const change=(id,value)=>{$(id).value=String(value);$(id).dispatchEvent(new Event('change'));};
 let states=0,elements=0,eventsChecked=0,sourceChecks=0,completedSlotChecks=0,variants=new Set();
 for(const suite of d.suites){
  change('gpu',suite.id);
  assert($('case').options.length===new Set(suite.runs.map(api.caseKey)).size,'case selector mismatch');
  for(const run of suite.runs){
   change('variant',run.variant);change('case',api.caseKey(run));variants.add(run.variant);
   assert(api.state.run.measurement_id===run.measurement_id,'run selection mismatch');
   for(let g=0;g<run.generations;g++){
    change('generation',g);const n=run.shape[0]*run.shape[1],offset=g*n;
    const wait=run.events.find(e=>e.role==='wait_returned_true'&&e.iteration===g),read=run.events.find(e=>e.role==='consumer_sample'&&e.iteration===g);
    assert(Number($('expected').dataset.slot)===g%2&&Number($('expected').dataset.tag)===run.expected_generations[offset],'source expectation display mismatch');
    assert($('wait').dataset.success===String(wait.wait_success)&&Number($('wait').dataset.slot)===wait.slot&&Number($('wait').dataset.tag)===wait.observed_generation&&Number($('wait').dataset.parity)===wait.phase_parity,'wait record display mismatch');
    assert(Number($('actual').dataset.slot)===read.slot&&Number($('actual').dataset.tag)===read.observed_generation,'consumer record display mismatch');
    const cells=[...$('outputs').children];assert(cells.length===n,'output cell count mismatch');
    let valueErrors=0,tagErrors=0;
    cells.forEach((cell,i)=>{const p=offset+i,delta=run.output[p]-run.reference[p];
     assert(Number(cell.dataset.actual)===run.output[p]&&Number(cell.dataset.reference)===run.reference[p]&&Number(cell.dataset.difference)===delta,'output payload mismatch');
     assert(Number(cell.dataset.tag)===run.observed_generations[p]&&Number(cell.dataset.expectedTag)===run.expected_generations[p],'output tag mismatch');
     assert(cell.querySelector('strong').textContent===String(run.output[p]),'visible output differs from data attributes');
     assert(cell.classList.contains('bad')===(delta!==0||run.observed_generations[p]!==run.expected_generations[p]),'error encoding mismatch');
     valueErrors+=delta!==0;tagErrors+=run.observed_generations[p]!==run.expected_generations[p];elements++;
    });
    assert(Number($('output-summary').dataset.valueErrors)===valueErrors&&Number($('output-summary').dataset.tagErrors)===tagErrors,'output error counts mismatch');
    assert($('generations').children.length===run.generations&&$('generations').querySelector('.current').dataset.generation===String(g),'generation navigation mismatch');
    const recorded=api.completedRead();assert(recorded.length===1,'consumed slot/tag completion is not uniquely observed');
    const completion=recorded[0];assert(completion.wait_success===true&&completion.slot===read.slot&&completion.observed_generation===read.observed_generation,'consumed completion mismatch');
    const completionButton=$('consumed-completion').querySelector('button');assert(completionButton.dataset.event===completion.id,'wrong consumed completion event');
    completionButton.click();assert(JSON.parse($('raw').textContent).id===completion.id,'completion navigation mismatch');completedSlotChecks++;
    const rows=[...$('events').children],selectedEvents=run.events.filter(e=>e.iteration===g);assert(rows.length===selectedEvents.length,'event rows mismatch');
    rows.forEach((row,index)=>{const e=selectedEvents[index];assert(row.dataset.event===e.id,'event row binding mismatch');row.querySelector('button').click();assert(JSON.stringify(JSON.parse($('raw').textContent))===JSON.stringify(e),'raw event content mismatch');assert($('provenance').textContent.includes(e.recordRef.sha256)&&$('provenance').textContent.includes(e.recordRef.source_sha256)&&$('provenance').textContent.includes(e.recordRef.json_pointer),'provenance absent');assert(Number($('source').querySelector('.highlight').dataset.line)===e.source_line,'source navigation mismatch');eventsChecked++;});
    states++;
   }
   const contract=$('contracts').querySelector('[data-line]');contract.click();assert(Number($('source').querySelector('.highlight').dataset.line)===Number(contract.dataset.line),'source contract navigation mismatch');sourceChecks++;
  }
 }
 change('gpu','B200');change('variant','wrong-slot');change('case','1x17/5/20261023');change('generation',2);
 $('generations').querySelector('[data-generation="4"]').click();assert($('generation').value==='4','generation card click failed');change('generation',2);
 assert(variants.size===3,'variant coverage mismatch');assert(document.body.textContent.includes('不是硬件时间轴'),'time-axis boundary missing');assert(document.body.textContent.includes('不是新采样的硬件事件'),'source/event boundary missing');assert($('diagnosis').textContent.includes('旧代际'),'fault diagnosis missing');
 assert(document.documentElement.scrollWidth<=window.innerWidth,'horizontal page overflow');
 const result=document.createElement('pre');result.id='browser-check-result';result.textContent=JSON.stringify({status:'passed',gpus:d.suites.length,runs:d.suites.reduce((n,s)=>n+s.runs.length,0),generation_states:states,output_elements_checked:elements,event_record_checks:eventsChecked,consumed_slot_completion_checks:completedSlotChecks,source_contract_checks:sourceChecks,variants:[...variants],scope:'UI bindings/interactions against saved measured evidence; no new GPU execution or semantic/user-study result'});document.body.append(result);
}catch(error){const result=document.createElement('pre');result.id='browser-check-result';result.textContent=JSON.stringify({status:'failed',error:String(error),stack:error.stack});document.body.append(result);}
</script>'''


TC_CHECK = r'''<script>
try {
 const api=window.tcgenViewer,d=api.data,$=id=>document.getElementById(id),assert=(ok,message)=>{if(!ok)throw Error(message);};
 const change=(id,value)=>{$(id).value=String(value);$(id).dispatchEvent(new Event('change'));};
 assert(document.documentElement.dataset.ready==='true','tcgen viewer not ready');
 let iterations=0,elements=0,eventChecks=0,sameParityWrong=0;
 for(const entry of d.runs){
  const r=entry.record;change('tc-variant',r.variant);assert(api.state.run.name===entry.name,'TC run binding mismatch');
  for(let g=0;g<r.iterations;g++){
   change('tc-iteration',g);const es=r.events.filter(e=>e.iteration===g),selected=es.find(e=>e.role==='input_selected'),n=r.shape[0]*r.shape[1],base=g*n;
   assert($('tc-expected').textContent===selected.expected_generation&&$('tc-expected').dataset.generation===selected.expected_generation,'required generation precision loss');
   assert($('tc-observed').textContent===selected.observed_generation&&$('tc-observed').dataset.generation===selected.observed_generation,'observed generation precision loss');
   assert(typeof selected.expected_generation==='string'&&typeof selected.observed_generation==='string','generation is not a string');
   const same=BigInt(selected.expected_generation)%2n===BigInt(selected.observed_generation)%2n;
   if(r.variant==='wrong-version'){assert(same&&selected.expected_generation!==selected.observed_generation,'same-parity wrong generation case missing');sameParityWrong++;}
   assert($('tc-phase').dataset.phase===String(selected.barrier_phase),'barrier phase mismatch');
   const waits=es.filter(e=>e.role==='mma_wait_success'&&e.wait_success);assert(Number($('tc-waits').dataset.successes)===waits.length,'wait count mismatch');
   let errors=0;const cells=[...$('tc-outputs').children];assert(cells.length===n,'TC output cell count mismatch');
   cells.forEach((c,i)=>{const a=r.output[base+i],b=r.reference[base+i],delta=a-b;assert(Number(c.dataset.actual)===a&&Number(c.dataset.reference)===b&&Number(c.dataset.difference)===delta,'TC output values mismatch');assert(c.querySelector('strong').textContent===String(a),'TC visible output mismatch');assert(c.classList.contains('bad')===(delta!==0),'TC error marking mismatch');errors+=delta!==0;elements++;});
   assert(Number($('tc-output-summary').dataset.errors)===errors,'TC mismatch count mismatch');
   const readers=es.filter(e=>e.role==='tmem_reader_done'),rows=[...$('tc-readers').children];assert(rows.length===readers.length,'reader row count mismatch');rows.forEach((row,i)=>assert(row.dataset.event===readers[i].id&&Number(row.dataset.value)===readers[i].representative_value,'TMEM sample mismatch'));
   const eventRows=[...$('tc-events').children];assert(eventRows.length===es.length,'TC event count mismatch');eventRows.forEach((row,i)=>{row.querySelector('button').click();assert(JSON.stringify(JSON.parse($('tc-raw').textContent))===JSON.stringify(es[i]),'TC raw event mismatch');assert($('tc-provenance').textContent.includes(entry.raw_sha256)&&$('tc-provenance').textContent.includes(d.source_sha256),'TC source/raw hashes missing');assert(Number($('tc-source').querySelector('.highlight').dataset.line)===es[i].source_line,'TC source navigation mismatch');eventChecks++;});
   iterations++;
  }
 }
 change('tc-variant','wrong-version');change('tc-iteration',0);
 assert(document.body.textContent.includes('不是 TMEM tag'),'TC metadata domain disclosure missing');assert(document.body.textContent.includes('不是硬件时间轴'),'TC time-axis boundary missing');assert(document.documentElement.scrollWidth<=window.innerWidth,'TC horizontal overflow');
 const result=document.createElement('pre');result.id='browser-check-result';result.textContent=JSON.stringify({status:'passed',representative_runs:d.runs.length,full_suite_runs:d.summary_totals.runs,iteration_states:iterations,output_elements_checked:elements,event_record_checks:eventChecks,same_parity_wrong_generation_states:sameParityWrong,generation_string_precision_preserved:true,scope:'Three measured representative runs; DOM checks against raw saved records, not all 36 runs or a new GPU execution'});document.body.append(result);
}catch(error){const result=document.createElement('pre');result.id='browser-check-result';result.textContent=JSON.stringify({status:'failed',error:String(error),stack:error.stack});document.body.append(result);}
</script>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("html", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--chrome", default=shutil.which("google-chrome") or shutil.which("chromium"))
    parser.add_argument("--screenshot", type=Path)
    args = parser.parse_args()
    if not args.chrome:
        raise SystemExit("Chrome unavailable; no browser verification claimed")
    with tempfile.TemporaryDirectory(prefix="modern-gpu-viewer-") as directory:
        temp = Path(directory)
        probe = temp / "check.html"
        html = args.html.read_text()
        checks = TC_CHECK if 'id="tc-evidence-data"' in html else CHECK
        probe.write_text(html.replace("</body>", checks + "</body>"))
        flags = [args.chrome, "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--window-size=1440,1280", "--user-data-dir=" + str(temp / "profile")]
        result = subprocess.run(flags + ["--dump-dom", probe.as_uri()], capture_output=True, text=True, timeout=60)
        match = re.search(r'<pre id="browser-check-result">(.*?)</pre>', result.stdout, re.S)
        if not match:
            raise SystemExit("Browser did not complete checks: " + result.stderr[-2000:])
        report = json.loads(unescape(match.group(1)))
        report.update({"chrome_exit_code": result.returncode, "chrome_version": subprocess.check_output([args.chrome, "--version"], text=True).strip(),
                       "html_sha256": hashlib.sha256(args.html.read_bytes()).hexdigest(), "checker_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()})
        if args.screenshot:
            args.screenshot.parent.mkdir(parents=True, exist_ok=True)
            screenshot = subprocess.run(flags + ["--hide-scrollbars", "--screenshot=" + str(args.screenshot.resolve()), args.html.resolve().as_uri()], capture_output=True, text=True, timeout=60)
            report["screenshot"] = {"path": str(args.screenshot.resolve()), "exit_code": screenshot.returncode,
                                    "sha256": hashlib.sha256(args.screenshot.read_bytes()).hexdigest() if args.screenshot.exists() else None}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(report, ensure_ascii=False))
        raise SystemExit(0 if report["status"] == "passed" and result.returncode == 0 else 1)


if __name__ == "__main__":
    main()
