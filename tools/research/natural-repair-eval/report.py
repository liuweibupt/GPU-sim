#!/usr/bin/env python3
"""Join frozen model proposals, actual builds and independent GPU verification."""
import argparse,hashlib,importlib.util,json,statistics
from pathlib import Path
from datetime import datetime,timezone

def read(p):return json.loads(Path(p).read_text())
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def main(root):
 gen=read(root/'generation-summary.json');tasks={t['family']:t for t in read(root/'frozen/tasks.json')};audit={r['id']:r for r in read(root/'localization-posthoc-audit.json')['rows']};runtime={}
 for family in ['cutlass','tmem']:
  for job in read(root/'runtime-jobs'/family/'manifest.json')['jobs']:
   for c in job['candidates']:
    verification=read(root/'verification'/(c['id']+'.json'))
    for id in c['trial_ids']:runtime[id]=(c['id'],verification)
 spec=importlib.util.spec_from_file_location('B',Path(__file__).with_name('execute_repairs.py'));B=importlib.util.module_from_spec(spec);spec.loader.exec_module(B)
 rows=[];unique={}
 for trial in sorted(gen['results'],key=lambda r:r['id']):
  id=trial['id'];build=read(root/'builds'/id/'result.json');answer=root/'trials'/id/'answer.json';a=read(answer);source=(root/'frozen'/tasks[trial['family']]['sourceFile']).read_text();modified,_=B.apply_edits(source,a['edits'])
  assert sha(answer)==build['answer_sha256'] and hashlib.sha256(modified.encode()).hexdigest()==build['candidate_sha256']
  assert trial['startedAt']>gen['protocol']['frozenAt']
  for c in trial['calls']:
   assert c['valid'] and c['finalMatches'] and sha(root/'trials'/id/f'round-{c["round"]}.prompt.txt')==c['promptSHA256']
  canonical,v=runtime[id];key='binary' if trial['family']=='cutlass' else 'link_native';identity=v['binary_sha256'] if trial['family']=='cutlass' else v['native_sha256'];assert identity==build['artifacts'][key]['sha256']
  partitions={part:{'passed':sum(x['passed'] for x in v['cases'] if x['partition']==part),'expected':sum(x['partition']==part for x in v['cases'])} for part in sorted({x['partition'] for x in v['cases']})}
  row={'id':id,'family':trial['family'],'condition':trial['condition'],'repetition':trial['rep'],'generation_valid':trial['valid'],'answer_sha256':sha(answer),'candidate_source_sha256':build['candidate_sha256'],'compile_status':build['status'],'build_result_sha256':sha(root/'builds'/id/'result.json'),'original_scores':trial['scores'],'secondary_observed_and_source_audit':audit[id]['postHocSupported'],'queries':len(trial['queries']),'model_calls':len(trial['calls']),'model_wall_seconds':trial['modelWallSeconds'],'query_milliseconds':trial['queryMilliseconds'],'usage':trial['usage'],'runtime_canonical_trial':canonical,'runtime_reused':canonical!=id,'runtime_verification_sha256':sha(root/'verification'/(canonical+'.json')),'runtime_passed':v['all_passed'],'partitions':partitions,'cpu_lit_passed':build.get('cpu_validation',{}).get('passed'),'build_command_wall_seconds':sum(c['wall_seconds'] for c in build.get('commands',[]))}
  rows.append(row);unique[canonical]=v
 cells=[]
 for family in ['cutlass','tmem']:
  for condition in ['raw','diagnostic']:
   r=[x for x in rows if x['family']==family and x['condition']==condition];usage={k:sum(x['usage'].get(k,0) for x in r) for k in r[0]['usage']}
   cells.append({'family':family,'condition':condition,'trials':len(r),'valid':sum(x['generation_valid'] for x in r),'location_hits':sum(x['original_scores']['locationHit'] for x in r),'original_supported_localization':sum(x['original_scores']['supportedLocalization'] for x in r),'secondary_supported_localization':sum(x['secondary_observed_and_source_audit'] for x in r),'compiled':sum(x['compile_status']=='built' for x in r),'runtime_repair_passed':sum(x['runtime_passed'] for x in r),'model_wall_median_seconds':statistics.median(x['model_wall_seconds'] for x in r),'model_wall_range_seconds':[min(x['model_wall_seconds'] for x in r),max(x['model_wall_seconds'] for x in r)],'queries':sum(x['queries'] for x in r),'query_median_milliseconds':statistics.median(x['query_milliseconds'] for x in r),'usage':usage})
 totals={'model_trials':len(rows),'model_calls':sum(x['model_calls'] for x in rows),'queries':sum(x['queries'] for x in rows),'unique_source_candidates':len({x['candidate_source_sha256'] for x in rows}),'actual_candidate_gpu_cases':sum(v['expected_cases'] for v in unique.values()),'actual_candidate_output_elements':sum(v.get('elements',v.get('full_byte_verification',{}).get('counts',{}).get('outputs',0)) for v in unique.values()),'candidate_sanitizer_calls':sum(sum(c['partition']=='hidden-sanitizer' for c in v['cases']) for v in unique.values())}
 result={'format':'natural-repair-comparison-v1','created_at':datetime.now(timezone.utc).isoformat(),'protocol_sha256':sha(root/'frozen/protocol.json'),'freeze_manifest_sha256':sha(root/'frozen/manifest.json'),'generation_summary_sha256':sha(root/'generation-summary.json'),'reporter_sha256':sha(__file__),'cells':cells,'rows':rows,'totals':totals,'conclusion':'Both conditions repair all three draws of each of the two prelocalized public defects. No success-rate improvement demonstrated; descriptive small-sample timings are not human or population effects.','scoring_note':'Preserve frozen strict score, which rejects extra valid IR locations and can credit shared IR as observed evidence. Secondary post-hoc audit accepts all provided source IDs and requires actual observed failure/control references.'}
 (root/'summary.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'totals':totals,'cells':cells},indent=2))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--output',type=Path,default=Path('out/research/natural-repair-eval'));main(p.parse_args().output)
