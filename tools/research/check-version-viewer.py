#!/usr/bin/env python3
"""Run actual Chrome interactions and compare displayed version evidence to inputs."""
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
  const api=window.versionViewer,d=api.data;
  if(document.documentElement.dataset.ready!=='true')throw Error('viewer not ready');
  const control=id=>document.getElementById(id);
  const change=(id,value)=>{control(id).value=String(value);control(id).dispatchEvent(new Event('change'));};
  let states=0,outputCells=0,obligationChecks=0,filterChecks=0,sourceChecks=0;
  const assertions=(ok,message)=>{if(!ok)throw Error(message);};
  for(const id of ['variant','count','generations','seed']) {
    for(const option of [...control(id).options]) {
      change(id,option.value);
      assertions(control('run').options.length===api.filterRecords().length,'filter/run count mismatch');filterChecks++;
    }
    change(id,'all');
  }
  control('reset').click();
  for(const record of d.runs) {
    change('run',record.measurement_id);
    for(let cta=0;cta<Math.ceil(record.shape[0]/32);cta++) {
      change('cta',cta);
      for(let g=0;g<record.generations;g++) {
        change('generation',g);
        const read=record.events.find(e=>e.cta[0]===cta&&e.iteration===g&&e.role==='consumer_read');
        const actual=control('slot-comparison').querySelector('.actual');
        assertions(Number(actual.dataset.slot)===read.slot&&Number(actual.dataset.tag)===read.observed_generation,'actual slot/tag display mismatch');
        const cells=[...control('outputs').children],expectedCount=Math.min(32,record.shape[0]-cta*32);
        assertions(cells.length===expectedCount,'tail output count mismatch');
        let errors=0;
        cells.forEach((cell,index)=>{const position=g*record.shape[0]+cta*32+index,difference=record.output[position]-record.reference[position];
          assertions(Number(cell.dataset.actual)===record.output[position]&&Number(cell.dataset.reference)===record.reference[position],'output values mismatch');
          assertions(Number(cell.dataset.difference)===difference&&Number(cell.dataset.tag)===record.observed_generations[position],'output error/tag mismatch');
          assertions(cell.textContent.includes(String(record.output[position])),'visible output text missing');
          errors+=difference!==0;outputCells++;
        });
        assertions(Number(control('output-summary').dataset.errors)===errors,'error count mismatch');
        const slot=control('slots').querySelector(`[data-slot="${read.slot}"][data-generation="${g}"]`);
        assertions(slot.classList.contains('read')&&slot.classList.contains('current'),'selected read slot not marked');
        assertions(slot.classList.contains('wrong')===(read.slot!==g%2||read.observed_generation!==g),'slot conflict encoding mismatch');
        assertions(control('events').children.length===5,'event rows missing');
        const capture=api.state.capture;
        for(const obligation of api.relevantObligations()) {
          change('obligation',obligation.id);
          assertions(control('status').dataset.status===obligation.status,'checker verdict display mismatch');
          assertions(Number(control('positive-count').textContent)===obligation.positiveWitnessRefs.length,'positive witness count mismatch');
          assertions(Number(control('unknown-count').textContent)===obligation.unknownRefs.length,'unknown count mismatch');
          const facts=[...control('positive').querySelectorAll('pre')].map(p=>JSON.parse(p.textContent));
          assertions(JSON.stringify(facts.map(f=>f.id))===JSON.stringify(obligation.positiveWitnessRefs),'displayed positive evidence differs');
          const slice=capture.slices.find(s=>s.obligationId===obligation.id);
          assertions(Number(control('slice-summary').dataset.retained)===slice.retainedNodes,'slice retained count mismatch');
          const sourceFact=facts.find(f=>f.kind==='source-derived-barrier-boundary');
          if(sourceFact)assertions(sourceFact.sampledDeviceEvent===false,'derived boundary mislabeled sampled');
          obligationChecks++;
        }
        states++;
      }
    }
    const button=control('events').querySelector('button');button.click();
    assertions(control('source').querySelector('.highlight').textContent.includes('__LINE__'),'source navigation failed');sourceChecks++;
  }
  control('reset').click();
  const first=d.runs.find(r=>r.variant==='wrong-slot'&&r.generations===5);
  change('run',first.measurement_id);change('cta',0);change('generation',0);
  control('slots').querySelector('[data-slot="0"][data-generation="4"]').click();
  assertions(control('generation').value==='4','slot diagram click did not select generation');
  assertions(document.body.textContent.includes('不是硬件时间轴'),'missing time-axis scope disclosure');
  assertions(document.body.textContent.includes('不是采样到的硬件完成事件'),'missing derived boundary disclosure');
  const result=document.createElement('pre');result.id='browser-check-result';result.textContent=JSON.stringify({status:'passed',runs:d.runs.length,cta_results:d.captures.length,cta_generation_states:states,output_elements_checked:outputCells,obligation_checks:obligationChecks,filter_checks:filterChecks,source_navigation_checks:sourceChecks,scope:'UI bindings and interactions against saved evidence, not new semantic accuracy or user-study evidence'});document.body.append(result);
}catch(error){const result=document.createElement('pre');result.id='browser-check-result';result.textContent=JSON.stringify({status:'failed',error:String(error)});document.body.append(result);}
</script>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("html", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--chrome", default=shutil.which("google-chrome") or shutil.which("chromium"))
    parser.add_argument("--screenshot", type=Path)
    args = parser.parse_args()
    if not args.chrome:
        raise SystemExit("Chrome/Chromium unavailable; no browser validation performed")
    with tempfile.TemporaryDirectory(prefix="gpu-version-viewer-") as directory:
        temporary = Path(directory)
        path = temporary / "check.html"
        path.write_text(args.html.read_text().replace("</body>", CHECK + "</body>"))
        flags = [args.chrome, "--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run",
                 "--user-data-dir=" + str(temporary / "profile")]
        process = subprocess.run(flags + ["--dump-dom", path.as_uri()], capture_output=True, text=True, timeout=60)
        match = re.search(r'<pre id="browser-check-result">(.*?)</pre>', process.stdout, re.S)
        if not match:
            raise SystemExit("Chrome did not finish viewer checks: " + process.stderr[-2000:])
        result = json.loads(unescape(match.group(1)))
        result.update({"chrome_exit_code": process.returncode, "html_sha256": hashlib.sha256(args.html.read_bytes()).hexdigest(),
                       "checker_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                       "chrome_version": subprocess.check_output([args.chrome, "--version"], text=True).strip()})
        if args.screenshot:
            args.screenshot.parent.mkdir(parents=True, exist_ok=True)
            picture = subprocess.run(flags + ["--window-size=1440,1100", "--hide-scrollbars", "--screenshot=" + str(args.screenshot.resolve()),
                                               args.html.resolve().as_uri()], capture_output=True, text=True, timeout=60)
            result["screenshot"] = {"path": str(args.screenshot.resolve()), "exit_code": picture.returncode,
                                    "sha256": hashlib.sha256(args.screenshot.read_bytes()).hexdigest() if args.screenshot.exists() else None}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result))
        raise SystemExit(0 if result["status"] == "passed" and process.returncode == 0 else 1)


if __name__ == "__main__":
    main()
