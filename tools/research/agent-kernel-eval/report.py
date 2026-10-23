#!/usr/bin/env python3
"""Audit saved generation/output evidence and package a reviewable bundle without ELF files."""
import argparse,csv,gzip,hashlib,importlib.util,io,json,shutil,tarfile
from datetime import datetime,timezone
from pathlib import Path
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('evaluation',HERE/'evaluate.py');E=importlib.util.module_from_spec(spec);spec.loader.exec_module(E)

def archive(entries,destination):
 index=[]
 with destination.open('wb') as raw:
  with gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=0) as compressed:
   with tarfile.open(fileobj=compressed,mode='w') as tar:
    for name,path in sorted(entries):
     data=path.read_bytes();info=tarfile.TarInfo(name);info.size=len(data);info.mtime=0;info.mode=0o644;tar.addfile(info,io.BytesIO(data));index.append({'path':name,'bytes':len(data),'sha256':E.F.sha(data)})
 return index

def main(out):
 m,h,g=E.verify(out);summary=json.loads((out/'evaluation-summary.json').read_text());checks=[];counts={'functional_cases':0,'functional_elements':0,'functional_metamorphic':0,'sanitizer_cases':0,'sanitizer_elements':0,'sanitizer_metamorphic':0,'sanitizer_calls':0};usage={};table=[]
 styles={'rmsnorm-candidate-1':'256-thread shared-memory tree reduction','rmsnorm-candidate-2':'warp shuffles + eight shared warp sums','transpose-candidate-1':'32×33 shared tile; 32×8 threads','transpose-candidate-2':'32×33 shared tile; 32×8 threads (same strategy)','segments-candidate-1':'256-thread int64 shared-memory tree','segments-candidate-2':'256-thread int64 shared-memory tree (same strategy)'}
 for c in summary['candidates']:
  directory=out/'candidates'/c['candidate'];record=json.loads((directory/'result.json').read_text());answer=json.loads((directory/'answer.json').read_text());events=[json.loads(line) for line in (directory/'source.jsonl').read_text().splitlines() if line.strip()];final=json.loads([e['item']['text'] for e in events if e.get('type')=='item.completed' and e.get('item',{}).get('type')=='agent_message'][-1]);assert final==answer;assert (directory/'candidate.cu').read_text()==answer['source'];assert E.F.sha((directory/'prompt.txt').read_bytes())==m['prompt_sha256'][c['task']]
  assert not any(e.get('item') and e['item'].get('type') not in ('reasoning','agent_message') for e in events)
  assert not any(x in (directory/'prompt.txt').read_text() for x in ['hidden-cases.json','20261023918371','rmsnorm-c00','transpose-c00','segments-c00'])
  for u in record['usage']:
   for key,value in u.items():
    if isinstance(value,int):usage[key]=usage.get(key,0)+value
  for phase in c['functional']:
   score=E.grade_directory(h,c['task'],directory/f'functional-r{phase["repeat"]}')
   assert score=={key:phase[key] for key in score};counts['functional_cases']+=len(score['cases']);counts['functional_elements']+=score['elements_checked'];counts['functional_metamorphic']+=len(score['metamorphic'])
  for phase in c['sanitizers']:
   score=E.grade_directory(h,c['task'],directory/('sanitizer-'+phase['tool']));assert score==phase['output_checks'];counts['sanitizer_calls']+=1;counts['sanitizer_cases']+=len(score['cases']);counts['sanitizer_elements']+=score['elements_checked'];counts['sanitizer_metamorphic']+=len(score['metamorphic'])
  deterministic=all((directory/'functional-r1'/p.name).read_bytes()==p.read_bytes() for p in (directory/'functional-r2').glob('*.actual.bin'))
  max_error=max((case.get('max_abs_error',0) for p in c['functional'] for case in p['cases']),default=0)
  table.append({'candidate':c['candidate'],'task':c['task'],'source_sha256':record['sourceSHA256'],'strategy':styles[c['candidate']],'compiled':c['stage']=='compiled','functional_repeats_passed':sum(p['passed'] for p in c['functional']),'sanitizers_passed':sum(p['passed'] for p in c['sanitizers']),'all_passed':c.get('passed',False),'repeat_outputs_bitwise_identical':deterministic,'max_abs_error':max_error,'unique_hidden_cases':m['case_counts'][c['task']],'functional_output_elements':sum(p['elements_checked'] for p in c['functional']),'generation_seconds':record['wallSeconds']})
  checks.append({'candidate':c['candidate'],'raw_final_answer_matches_saved_source':True,'prompt_hash_matches_freeze':True,'source_unmodified':True,'tool_items':0,'full_output_scores_recomputed':True,'repeat_outputs_bitwise_identical':deterministic})
 report={'schema':'ai-cuda-hidden-summary-v1','verified_utc':datetime.now(timezone.utc).isoformat(),'model':'gpt-6-astra','reasoning':'low','models':1,'operators':3,'candidates':6,'generation_valid':sum(r['valid'] for r in g['results']),'compiled':sum(r['compiled'] for r in table),'all_checks_passed':sum(r['all_passed'] for r in table),'source_hashes_unique':len({r['source_sha256'] for r in table}),'unique_hidden_cases':sum(m['case_counts'].values()),'unique_metamorphic_relations':len(h['metamorphic_relations']),'counts':counts,'usage':usage,'frozen_at':m['frozen_at'],'first_generation_at':min(r['startedAt'] for r in g['results']),'hidden_generator_sha256':m['hidden_generator_sha256'],'hidden_cases_sha256':m['hidden_cases_sha256'],'table':table,'limits':['Single model/configuration; two samples per known operator, not independent models or humans.','All six use the same no-tools generation condition; no tool-condition comparison.','Simple public operator contracts and authored synthetic hidden cases, not held-out natural bugs or blind root-cause discovery.','Tests cover finite inputs within the contract, not every allowed shape/value; sanitizer passes are not a proof.','No feedback, repair, candidate edits, or hidden-test retuning; common transpose/segment strategies are very similar.','Hidden from candidate prompts/cwds at generation; evaluator authored tasks and tests. This is not a formally isolated secret-evaluation service.','No GPU performance or human-understanding measurement. Ceiling results do not establish broader capability or human replacement.']}
 (out/'summary.json').write_text(json.dumps(report,indent=2)+'\n');(out/'verification.json').write_text(json.dumps({'verified_utc':report['verified_utc'],'checks':checks,'freeze_precedes_every_generation':True,'hidden_unchanged':True,'candidate_edits':0,'feedback_rounds':0,'gpu_harness_edits_after_freeze':0},indent=2)+'\n')
 md='# Actual AI-generated CUDA candidates with frozen hidden tests\n\nSix candidates were actually returned by Codex CLI `gpt-6-astra` / low reasoning and compiled unchanged for an RTX 4090 (SM89). All six passed the finite hidden suite and four sanitizer tools. This is a ceiling result on three standard public operator contracts, not a human-replacement, natural-bug, or tool-condition comparison.\n\n'
 md+='| Candidate | Implementation visible in saved source | Unique hidden cases | Functional full-output checks | Sanitizer tools clean | Max absolute error |\n| --- | --- | ---: | ---: | ---: | ---: |\n'
 for r in table:md+=f'| {r["candidate"]} | {r["strategy"]} | {r["unique_hidden_cases"]} | {r["functional_output_elements"]} | {r["sanitizers_passed"]}/4 | {r["max_abs_error"]} |\n'
 md+=f'\nThere are 31 unique hidden input cases (11 RMSNorm, 10 transpose, 10 segmented sum) and four unique metamorphic relations. Across two candidate samples and two functional repetitions, {counts["functional_cases"]} case executions compare {counts["functional_elements"]:,} actual output elements and check {counts["functional_metamorphic"]} metamorphic relations. The {counts["sanitizer_calls"]} sanitizer invocations separately check {counts["sanitizer_cases"]} case executions, {counts["sanitizer_elements"]:,} output elements, and {counts["sanitizer_metamorphic"]} relations. Repeated checks do not create additional independent tasks.\n'
 md+='\nThe numerical oracle uses Python double precision followed by FP32 rounding for RMSNorm (atol 2e-5, rtol 2e-4), direct byte-preserving indexing for transpose, and Python integer sums for int64 segmented outputs. Each logical element is checked. Output guards/padding and input/offset bytes must remain unchanged. Hidden cases exercise empty inputs/segments, tails, non-contiguous strides, signed zero, zero RMS rows, and a segmented sum exceeding int32 range. Metamorphic checks cover sign reversal and RMSNorm input/epsilon joint scaling; RMSNorm relation tolerance is twice the elementwise tolerance to account for both compared evaluations. Two functional repeats produced bit-identical complete captured buffers.\n'
 md+='\n## Provenance and fixed budget\n\n'
 md+=f'- Frozen at {m["frozen_at"]}; first candidate call {report["first_generation_at"]}.\n- Hidden generator SHA-256: `{m["hidden_generator_sha256"]}`.\n- Hidden case SHA-256: `{m["hidden_cases_sha256"]}`.\n- Six fresh ephemeral calls, at most two concurrent; 90 seconds per call; zero repair rounds. Public contracts and response schema only in the prompt. No hidden files, paths, oracle, or evaluator code were supplied.\n- CLI user configuration ignored, shell tool disabled, empty temporary cwd, full JSONL audited. Zero tool items and generation timeouts. Model alias and CLI version are saved; CLI does not expose a resolved model snapshot.\n- Candidate source bytes exactly equal the structured model response, with no manual fixes. Six unique source hashes do not imply six distinct algorithm families: both transpose candidates and both segment candidates use closely related strategies.\n'
 md+='- Build budget 90 seconds/candidate; functional budget 60 seconds/candidate/repetition; sanitizer budget 90 seconds/candidate/tool. memcheck, racecheck, initcheck and synccheck all ran. No compile, launch, timeout, numerical, metamorphic, guard, or sanitizer failure was observed. Failure categories are retained separately by the harness.\n- Executed evaluator/harness/generator sources are preserved under `executed-source-snapshots/`. Command JSON legacy `started_utc` was recorded after process completion; treat it as completion/recording time, as documented in `execution-notes.json`. The current runner renames the field `finished_utc`; original logs are retained. Actual durations and generation/freeze timestamps are unaffected. No candidate, hidden fixture, or GPU harness was changed.\n'
 md+='\n## Fairness and interpretation boundaries\n\n'+''.join('- '+s+'\n' for s in report['limits'])
 md+='\nThe no-tools setting is a fixed provenance/isolation control for all candidates, not an experimental comparison. Shared hardware execution was coordinated with the cost-measurement agent; no GPU timing benchmark was performed. Public operator contracts include supported ranges and tolerances, while concrete shapes, strides, values, seeds, references and relations were withheld until after generation. The coordinator authored both contracts and tests, so this is a reproducible local holdout protocol rather than an independently administered evaluation. CUDA source was inspected for prohibited host APIs; this is not a formal sandbox proof.\n\nRaw prompts, responses, JSONL, exact sources, compiler logs, execution/sanitizer logs, complete compressed inputs and actual outputs, source snapshots and SHA indices are included in `publish/`; compiled ELF files are excluded.\n'
 (out/'report.md').write_text(md)
 publish=out/'publish'
 if publish.exists():shutil.rmtree(publish)
 publish.mkdir()
 for name in ['summary.json','report.md','verification.json','execution-notes.json','generation-summary.json','compile-summary.json','evaluation-summary.json','nvcc-version.stdout.txt','nvcc-version.stderr.txt','nvcc-version.command.json','sanitizer-version.stdout.txt','sanitizer-version.stderr.txt','sanitizer-version.command.json','gpu-before.stdout.txt','gpu-before.stderr.txt','gpu-before.command.json','gpu-processes-before.stdout.txt','gpu-processes-before.stderr.txt','gpu-processes-before.command.json','gpu-processes-after.stdout.txt','gpu-processes-after.stderr.txt','gpu-processes-after.command.json','validation-tests.txt']:
  if (out/name).exists():shutil.copy2(out/name,publish/name)
 shutil.copytree(out/'executed-source-snapshots',publish/'executed-source-snapshots')
 dest=publish/'frozen';dest.mkdir()
 for p in (out/'frozen').iterdir():
  if p.is_file() and p.name!='hidden-cases.json':shutil.copy2(p,dest/p.name)
 (dest/'hidden-cases.json.gz').write_bytes(gzip.compress((out/'frozen/hidden-cases.json').read_bytes(),mtime=0))
 index=archive([(p.name,p) for p in (out/'frozen/cases').glob('*.bin')],dest/'inputs.tar.gz');(dest/'input-index.json').write_text(json.dumps(index,indent=2)+'\n')
 for row in table:
  src=out/'candidates'/row['candidate'];dst=publish/'candidates'/row['candidate'];dst.mkdir(parents=True)
  for p in src.iterdir():
   if p.is_file() and p.name!='candidate-runner':shutil.copy2(p,dst/p.name)
  index=archive([(str(p.relative_to(src)),p) for p in src.glob('*/*.actual.bin')],dst/'actual-outputs.tar.gz');(dst/'output-index.json').write_text(json.dumps(index,indent=2)+'\n')
 manifest=[]
 for p in sorted(publish.rglob('*')):
  if p.is_file():manifest.append({'path':str(p.relative_to(publish)),'bytes':p.stat().st_size,'sha256':E.F.sha(p.read_bytes())})
 (publish/'bundle-manifest.json').write_text(json.dumps({'schema':'ai-kernel-review-bundle-v1','no_elf':True,'files':manifest},indent=2)+'\n')
 print(json.dumps({'pass_count':report['all_checks_passed'],'counts':counts,'publish':str(publish),'bundle_files':len(manifest),'bundle_bytes':sum(x['bytes'] for x in manifest)},indent=2))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--out',type=Path,default=E.F.OUT);a=p.parse_args();main(a.out.resolve())
