#!/usr/bin/env python3
"""Check the rendered UI closures against the stored experiment, using Chrome."""
import argparse
from html import unescape
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

CHECK = r'''<script>
try {
  let checks=0;
  for(let i=0;i<views.length;i++) {
    $('view').value=i;setView();
    for(const method of Object.keys(labels)) {
      $('method').value=method;render();
      const expected=current.methods[method].node_ids;
      const actual=[...retained].sort((a,b)=>a-b);
      if(JSON.stringify(actual)!==JSON.stringify([...expected].sort((a,b)=>a-b)))
        throw Error('closure mismatch '+current.view_id+' '+method);
      checks++;
    }
    selectNode(current.nodes[0].id);
    if(!retained.has(current.nodes[0].id))throw Error('custom seed lost');
    $('reset').click();
    if(JSON.stringify(seeds)!==JSON.stringify(current.seed_ids))throw Error('reset failed');
    $('retained').checked=false;$('retained').dispatchEvent(new Event('change'));
    $('next').click();$('previous').click();
    if(!$('nodes').childElementCount)throw Error('empty rendered table');
    checks+=3;
  }
  const result=document.createElement('pre');result.id='check-result';
  result.textContent=JSON.stringify({status:'passed',views:views.length,checks,closure_comparisons:views.length*4});
  document.body.append(result);
} catch(error) {
  const result=document.createElement('pre');result.id='check-result';
  result.textContent=JSON.stringify({status:'failed',error:String(error)});
  document.body.append(result);
}
</script>'''


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('html', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--chrome', default=shutil.which('google-chrome') or shutil.which('chromium'))
    args = parser.parse_args()
    if not args.chrome:
        raise SystemExit('Chrome/Chromium is required; no browser check was performed')
    with tempfile.TemporaryDirectory(prefix='gpu-trace-viewer-') as directory:
        path = Path(directory) / 'check.html'
        path.write_text(args.html.read_text().replace('</html>', CHECK + '</html>'))
        proc = subprocess.run([args.chrome, '--headless', '--no-sandbox', '--disable-gpu',
                               '--disable-dev-shm-usage', '--no-first-run',
                               '--user-data-dir=' + str(Path(directory) / 'profile'),
                               '--dump-dom', path.as_uri()], capture_output=True, text=True, timeout=60)
        match = re.search(r'<pre id="check-result">(.*?)</pre>', proc.stdout, re.S)
        if not match:
            raise SystemExit('Browser did not complete UI checks: ' + proc.stderr[-1500:])
        result = json.loads(unescape(match.group(1)))
        result['chrome_exit_code'] = proc.returncode
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result))
        raise SystemExit(0 if result['status'] == 'passed' and proc.returncode == 0 else 1)
