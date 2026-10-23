#!/usr/bin/env python3
"""Dispatch an unchanged materialized candidate through the recorded real GPU executor.
Default prints a verified command; --execute runs it. No model is called and no repair
is attempted. Missing/invalid candidates remain in materialization.json's denominator.
"""
import argparse,hashlib,json,subprocess
from pathlib import Path
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[2]
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--candidate',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--execute',action='store_true');a=p.parse_args()
 candidate=json.loads(a.candidate.read_text());mapping=json.loads((HERE/'private/executor-map.json').read_text());entry=next(row for row in mapping['tasks'] if row['taskId']==candidate['taskId'])['executor']
 for file_key,hash_key in [('executor','executorSha256'),('verifier','verifierSha256'),('runner','runnerSha256'),('hiddenPlan','hiddenSpecSHA256')]:
  if sha(ROOT/entry[file_key])!=entry[hash_key]:raise SystemExit('Frozen executor input changed: '+file_key)
 command=['python3',str(ROOT/entry['executor']),'--candidate',str(a.candidate.resolve()),'--output',str(a.output.resolve()),'--base',str(ROOT/entry['baseDirectory'])]
 print(json.dumps({'taskId':candidate['taskId'],'candidateTreeSHA256':candidate['candidateTreeSHA256'],'command':command,'executeRequested':a.execute,'hiddenCaseCount':len(entry['hiddenCaseIds']),'scope':'Command preparation is not GPU validation or human repair success.'}),flush=True)
 if a.execute:raise SystemExit(subprocess.run(command,cwd=ROOT).returncode)
if __name__=='__main__':main()
