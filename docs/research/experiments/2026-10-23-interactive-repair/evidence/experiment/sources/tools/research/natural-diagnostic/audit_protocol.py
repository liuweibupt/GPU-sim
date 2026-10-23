#!/usr/bin/env python3
"""Blind, read-only input/protocol audit. Never opens trial/model-response files."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[3]
def sha(raw): return hashlib.sha256(raw).hexdigest()
def insist(value,message):
    if not value: raise ValueError(message)
def decode(value):
    if isinstance(value,list): return [decode(x) for x in value]
    if isinstance(value,dict):
        if value.get('encoding')=='lossless-run-length':
            result=[]
            for run in value['runs']:
                insist(type(run['count']) is int and run['count']>0,'invalid RLE count')
                result.extend([run['value']]*run['count'])
            insist(len(result)==value['length'],'RLE length mismatch');return result
        return {k:decode(v) for k,v in value.items()}
    return value
def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--experiment',type=Path,default=ROOT/'out/research/natural-repair-eval');a=p.parse_args()
    frozen=a.experiment/'frozen';manifest=json.loads((frozen/'manifest.json').read_text());protocol=json.loads((frozen/'protocol.json').read_text())
    checks=[]
    for relative,expected in manifest['files'].items():
        insist(sha((frozen/relative).read_bytes())==expected,'frozen input mismatch '+relative);checks.append('input:'+relative)
    for relative,expected in manifest['hidden'].items():
        insist(sha((a.experiment/'hidden-v1'/relative).read_bytes())==expected,'hidden hash changed '+relative);checks.append('hidden-hash-only:'+relative)
    for relative,expected in manifest['sources'].items():
        insist(sha((ROOT/relative).read_bytes())==expected,'current source mismatch '+relative)
        insist(sha((frozen/'source'/relative).read_bytes())==expected,'source snapshot mismatch '+relative);checks.append('execution-source:'+relative)
    data=json.loads((frozen/'benchmark-before.json').read_text())
    insist(data['scope']=='before-only' and all(c['version']=='input' for c in data['cases']),'later variant in input')
    expected_paths={'collective.hpp','TensorMemoryAllocation.cpp'}|{f'source-{i:02d}.mlir' for i in range(2,9)}
    insist({s['path'] for s in data['sources']}==expected_paths,'unexpected benchmark source inventory')
    for source in data['sources']:
        insist(sha(source['text'].encode())==source['sha256'],'benchmark source hash changed')
    forbidden={'source_commit','commit','issue','fix','patch','repaired_cases','regressed_cases','possible_selected_lifetime_overlaps','selected_source_static_overlap'}
    def inspect(obj):
        if isinstance(obj,dict):
            insist(not (set(obj)&forbidden),'later outcome/diagnosis metadata found')
            for key,value in obj.items():
                if key!='text':inspect(value)
        elif isinstance(obj,list):
            for value in obj:inspect(value)
        elif isinstance(obj,str):insist('github.com/' not in obj and 'guards.patch' not in obj,'external answer pointer found')
    inspect(data)
    family_checks=[]
    for family in ['cutlass','tmem']:
        raw=(frozen/f'{family}.raw.prompt.txt').read_text();diagnostic=(frozen/f'{family}.diagnostic.prompt.txt').read_text()
        marker='\nINPUT PACKET (identical in both conditions):\n'
        insist(raw.count(marker)==diagnostic.count(marker)==1,'input packet marker changed')
        raw_packet=raw.split(marker)[1];diagnostic_packet=diagnostic.split(marker)[1]
        insist(raw_packet==diagnostic_packet,'condition packets differ')
        insist(raw_packet+'\n'==(frozen/f'{family}.packet.json').read_text(),'packet snapshot mismatch')
        family_data=json.loads((frozen/f'{family}.data.json').read_text())
        insist(decode(json.loads(raw_packet))==family_data,'RLE decoding differs from raw facts')
        expected_cases=[c for c in data['cases'] if c['family']==family]
        insist(family_data['cases']==expected_cases,'family cases differ from before-only projection')
        primary=next(s for s in family_data['sources'] if s['path']==('collective.hpp' if family=='cutlass' else 'TensorMemoryAllocation.cpp'))
        insist((frozen/f'{family}.before').read_text()==primary['text'],'editable file differs from packet')
        family_checks.append({'family':family,'rawAndDiagnosticPacketIdentical':True,'packetSha256':sha(raw_packet.encode()),'packetBytes':len(raw_packet.encode()),'rleDecodesToCompleteFamilyData':True,'cases':len(expected_cases),'sourceSHA256':primary['sha256'],'sourceLines':len(primary['text'].splitlines()),'fullEditableFilePresent':True})
    insist(protocol['model']=='gpt-6-astra' and protocol['reasoning']=='low','different registered model/config')
    insist(protocol['conditions']==['raw','diagnostic'] and protocol['maxQueries']==2 and protocol['maxCalls']==3 and protocol['timeoutSecondsPerCall']==90,'budget changed')
    # A static fact can be shared by a failing and passing case. This only audits
    # the frozen scorer logic; it does not open any submitted answer.
    shared=[]
    for fact in data['evidence']:
        if fact['kind']!='compiler-ir':continue
        linked=[c for c in data['cases'] if fact['id'] in c['evidenceRefs']]
        if {'wrong_value','passed'}<={c['status'] for c in linked}:
            shared.append({'factId':fact['id'],'kind':fact['kind'],'linkedCaseIds':[c['id'] for c in linked],'statuses':sorted({c['status'] for c in linked})})
    helper=ROOT/'tools/research/agent-eval/run.mjs'
    report={'format':'natural-repair-blind-protocol-review-v1','reviewedAt':datetime.now(timezone.utc).isoformat(),
        'reviewer':'diagnostic_integration_map; implementation author independently inspecting evaluator inputs and scoring code, not independent of the tool design',
        'status':'matched-input-checks-passed-with-scoring-caveat','reviewScope':'Frozen protocol, source code and input artifacts only. No trial answers, patches, model responses, or outcome files opened.',
        'freezeManifestSHA256':sha((frozen/'manifest.json').read_bytes()),'frozenAt':protocol['frozenAt'],'integrityChecks':checks,'families':family_checks,
        'benchmarkBoundary':{'onlyInputVersions':True,'sourceTextsUnchanged':True,'neutralMetadata':True,'noRepairOutcomeOrPatchMetadata':True,'noSavedOverlapConclusion':True,'trainingContaminationExcluded':False},
        'queryImplementation':{'sha256':manifest['sources']['lib/research/natural-diagnostic.js'],'sameImplementationAsViewer':True,'pureQueries':True,'rawOps':protocol['rawOps'],'diagnosticExtraOps':protocol['diagnosticExtraOps'],'derivationsUseOnlySuppliedBeforeFacts':True,'derivedResultsCarryRawRefs':True},
        'budget':{key:protocol[key] for key in ['model','reasoning','repetitions','trials','maxQueries','maxCalls','timeoutSecondsPerCall','queryResponseLimitBytes','maxConcurrency']},
        'findings':[{'severity':'measurement-caveat','id':'shared-static-fact-reference-credit','detail':'Frozen localization() covers statuses through any case.evidenceRefs. A shared compiler-ir fact can therefore receive failure-and-control credit without citing two execution observations. Preserve frozen scores; report an additional strict score counting case IDs or device-output/execution-observation facts only.','sharedFacts':shared},
                    {'severity':'provenance-caveat','id':'transitive-helper-not-prefrozen','detail':'experiment.mjs imports auditJSONL from tools/research/agent-eval/run.mjs, which is not in the freeze source list. Its hash is recorded now as a supplementary audit, not as pre-execution freezing.','helperPath':str(helper.relative_to(ROOT)),'currentSHA256':sha(helper.read_bytes())}],
        'limitations':['No human participant or visual interaction outcome is measured; the model receives text queries from the same backend.',
            'Only two selected public root causes. Three repetitions of one model/configuration do not create six independent root causes or developers.',
            'Both tasks provide the complete prelocalized editable file and name the defect scope. Localization is within a supplied file, not repository-wide discovery.',
            'Both groups must query first; diagnostic must query overlap/contrast. This measures a mandated diagnostic workflow, not voluntary tool adoption.',
            'Maximum calls/query count and per-call time are equal; actual tokens and prompt lengths differ by tool descriptions, returned query data and number of calls.',
            'Raw already receives all source and observations, so extra diagnostic data are derived organization/computation rather than additional raw measurement.',
            'Runtime time includes service, network and queue delays. Actual endpoint execution/model identity beyond registered alias was not independently verified here.',
            'The prompt/cwd/tool audit limits visible experimental input; it cannot prove absence of public-bug training contamination.',
            'A correct patch does not establish minimality, production performance or generality. Function-range localization is not explanation-quality scoring.'],
        'reviewScriptSHA256':sha(Path(__file__).read_bytes())}
    destination=a.experiment/'protocol-review.json';destination.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'status':report['status'],'families':family_checks,'sharedStaticFacts':len(shared),'report':str(destination)}))
if __name__=='__main__':main()
