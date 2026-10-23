#!/usr/bin/env python3
"""Render a self-contained viewer of measured SM89 version tags and bound proofs."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path


PAGE = r'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GPU 版本错误：实机观测与可审查证据</title><style>
:root{font:15px/1.55 system-ui,sans-serif;color:#193044;background:#f2f5f7;--green:#137653;--red:#a23542;--amber:#86602a;--blue:#1d6489}*{box-sizing:border-box}body{margin:0}main{max-width:1440px;margin:auto;padding:28px}h1{font-size:29px;line-height:1.3;margin:0 0 10px}h2{font-size:19px;margin:0 0 12px}h3{font-size:15px;margin:16px 0 8px}p{margin:8px 0}.lead{max-width:1100px;color:#4a5d6e}.tag{display:inline-block;padding:4px 9px;border-radius:5px;background:#e9eff3;font-size:12px;margin:2px}.bad{color:var(--red);background:#fbe9eb}.good{color:var(--green);background:#e4f4ec}.derived{color:var(--amber);background:#fff1dc}.unknown{color:var(--amber);background:#fff1dc}.muted{color:#586d7d}.small{font-size:12px}.mono,code,pre{font:12px/1.55 ui-monospace,monospace;overflow-wrap:anywhere}section,.panel{background:white;border:1px solid #d6e0e6;border-radius:10px;padding:20px;margin:18px 0}.row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}.filters label{font-size:13px;display:flex;flex-direction:column;gap:4px}select,button{font:inherit;border:1px solid #9eafbd;border-radius:5px;background:white;color:inherit;padding:7px 9px}button{cursor:pointer}button:hover{background:#eef4f8}button:focus-visible,select:focus-visible{outline:3px solid #75b5e0;outline-offset:2px}select{max-width:100%}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:18px}.card{border:1px solid #dce4e9;border-radius:8px;padding:13px;background:white}.card strong{display:block;font-size:24px}.card span{font-size:12px;color:#516777}.grid{display:grid;grid-template-columns:1.1fr 1fr;gap:18px}.grid section{margin:0}table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;padding:8px;border-bottom:1px solid #dfe7ec;vertical-align:top}th{background:#f1f5f7;position:sticky;top:0}tr.mismatch{background:#fdf0f1}.scroll{max-height:440px;overflow:auto}.slot-chart{overflow:auto;padding:8px 0}.slot-cell{min-width:155px;white-space:normal;font-size:12px;text-align:left;padding:10px;height:112px;width:100%;background:#f5f8fa;border:1px solid #d4dfe6;border-radius:7px}.slot-cell.written{border-left:5px solid var(--blue)}.slot-cell.read{box-shadow:inset 0 0 0 2px var(--green)}.slot-cell.read.wrong{box-shadow:inset 0 0 0 2px var(--red)}.slot-cell.current{outline:2px solid #172f44;outline-offset:2px}.slot-cell strong{display:block;font-size:16px}.slot-cell span{display:block;margin-top:3px}.legend{display:flex;gap:15px;flex-wrap:wrap;font-size:12px}.legend i{display:inline-block;width:10px;height:10px;margin-right:5px}.comparison{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}.comparison>div{padding:12px;border-radius:8px;background:#eef3f7}.comparison .actual.bad{background:#fbe9eb}.comparison .actual.good{background:#e4f4ec}.comparison strong{display:block;font-size:21px}#status{font-size:17px;font-weight:600;padding:7px 12px;border-radius:6px;display:inline-block}.fact{border:1px solid #dce5eb;border-radius:7px;padding:9px;margin:7px 0}.fact>summary{cursor:pointer;overflow-wrap:anywhere}.fact.hardware{border-left:4px solid var(--green)}.fact.source-derived{border-left:4px solid var(--amber)}.fact.contract{border-left:4px solid #668197}.fact pre{max-height:250px;overflow:auto;white-space:pre-wrap;margin-bottom:0}#source{max-height:320px;overflow:auto;white-space:pre;background:#f4f7f9;padding:12px;border-radius:6px}#source .line{display:block}#source .highlight{background:#ffe1a6;font-weight:600}#source .number{display:inline-block;width:35px;color:#6d7b85}#selection-id,#hashes{white-space:pre-wrap}.notice{border-left:4px solid var(--amber);background:#fff7e9;padding:11px;font-size:13px}.error{color:var(--red);white-space:pre-wrap}.proof-counts{display:flex;gap:15px;flex-wrap:wrap;margin:12px 0}.proof-counts b{font-size:18px}.link-button{padding:1px 4px;font-size:12px;border-color:#b8c8d3;color:var(--blue)}details>summary{cursor:pointer}#provenance{max-height:420px;overflow:auto;white-space:pre-wrap}.empty{color:#677d8d;padding:9px;background:#f4f7f9;border-radius:5px}@media(max-width:950px){.grid{grid-template-columns:1fr}.cards{grid-template-columns:repeat(2,1fr)}main{padding:14px}h1{font-size:24px}.comparison{grid-template-columns:1fr}}
</style></head><body><main>
<h1>GPU 版本错误：实机观测与可审查证据</h1>
<p class="lead">两个 shared-memory slot 在不同代次交替使用。正确候选读取当前 slot；受控错误候选读取另一个已初始化的 slot。这里可以对照真实 GPU 输出、实际版本标签与固定源码合同，检查“读了哪一代”。</p>
<div><span class="tag">RTX 4090 · SM89</span><span class="tag">整数精确检查</span><span class="tag derived">实验编写的受控故障</span><span class="tag">离线、单文件</span></div>
<p class="notice">这不是自然产生的 AI 错误，也没有执行 TMA / tcgen05 / TMEM。绿色采样记录是实际设备输出；黄色 barrier 边界与顺序由已绑定的固定源码合同推导，不是采样到的硬件完成事件。</p>
<div id="error" class="error" role="alert"></div><div id="overview" class="cards"></div>
<section><h2>选择一次实机运行</h2><div class="row filters">
<label>候选<select id="variant"><option value="all">全部候选</option><option value="correct">correct</option><option value="wrong-slot">wrong-slot</option></select></label>
<label>元素数 N<select id="count"></select></label><label>总代次数<select id="generations"></select></label><label>seed<select id="seed"></select></label>
<button id="reset">清除筛选</button><span id="filter-count" class="small muted"></span></div>
<div class="row" style="margin-top:14px"><label>运行 <select id="run"></select></label><label>CTA <select id="cta"></select></label><label>当前代次 g <select id="generation"></select></label></div>
<p id="selection-id" class="mono"></p><div id="slot-comparison" class="comparison"></div>
<p id="run-summary" class="small muted"></p><p id="sanitizer-summary" class="small"></p></section>
<section><h2>两个 slot 的逻辑代次图</h2>
<p class="small muted">每一列表示该代次 producer 写入之后、consumer 读取时的逻辑状态。slot 内容按初始化合同与实际 producer 标签重建；未读取 slot 的状态不是额外采样。列顺序不是硬件时间轴，按钮只切换查询代次。</p>
<div class="legend"><span><i style="background:#1d6489"></i>蓝色左边：本代写入</span><span><i style="background:#137653"></i>绿色框：实际读取符合预期</span><span><i style="background:#a23542"></i>红色框：实际读取另一代</span><span>黑色外框：当前选择</span></div>
<div id="slots" class="slot-chart"></div></section>
<div class="grid"><section><h2>当前 CTA / 代次的数值错误</h2><p id="output-summary"></p><div class="scroll"><table><thead><tr><th>元素 index</th><th>actual</th><th>reference</th><th>actual − reference</th><th>实际 tag</th></tr></thead><tbody id="outputs"></tbody></table></div>
<p class="small muted">展示全部有效元素，尾块不填充成伪造的输出。reference 独立计算；差值为整数。shared slot 标签和每个有效输出的 observed_generation 均来自本次实机返回值。</p>
<h3>实际采样记录</h3><div class="scroll"><table><thead><tr><th>角色 / thread</th><th>slot / 实测 tag</th><th>源码</th></tr></thead><tbody id="events"></tbody></table></div>
<p class="small muted">producer_complete 与 consumer_read 同在 barrier 之后，不能推断前一个采样事件先于后一个；reader_done 与 reuse_ready 同理。事件数组位置只是固定存储位置。</p></section>
<section><h2>检查器结论与证据</h2><label>本代义务 <select id="obligation"></select></label><div style="margin-top:12px"><span id="status"></span></div><p id="reason"></p>
<div class="proof-counts"><span>正面证据 <b id="positive-count"></b></span><span>未知边界 <b id="unknown-count"></b></span></div>
<p id="slice-summary" class="small muted"></p><div id="positive"></div><h3>unknown / 未建立的证据</h3><div id="unknown"></div>
<h3>离线检查器接口消融</h3><div id="ablations"></div><p class="small muted">这里只显示已保存的接口消融统计：遮蔽 consumer value token，或移除 HB edges。其他原始观测 facts 仍然保留；不是删除原始 tag，也不是额外 GPU 故障或重新采集。</p></section></div>
<section><h2>源码与来源绑定</h2><p id="source-label" class="small"></p><pre id="source"></pre><p id="hashes" class="mono"></p>
<p class="small muted">源码推导的 barrier 返回边界只用于这个已审查的固定 kernel。该页面不宣称一般 CUDA 自动分析、诊断准确率、性能优化或人类理解提升。</p>
<details><summary>输入、生成器与桥接 provenance</summary><pre id="provenance"></pre></details></section>
</main><script id="version-data" type="application/json">__DATA__</script><script>
'use strict';
const $=id=>document.getElementById(id), data=JSON.parse($('version-data').textContent);
const state={record:null,capture:null,generation:0,obligation:null,sourceLine:null};
const labels={satisfied:'满足（在当前证据范围内）',violated:'违例（有正面冲突证据）',unknown:'未知（证据不足）'};
const roleNames={producer_write:'producer 写入',producer_complete:'producer 的 barrier 后记录',consumer_read:'consumer 读取',reader_done:'reader 的 barrier 后记录',reuse_ready:'producer 的可复用阶段记录'};
const kindNames={'value-generation':'值 / 版本身份','completion-token-generation':'完成 token 的版本','completion-before-consume':'完成先于读取','reader-before-reuse':'reader 完成先于复用'};
function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function fmt(value){return Number(value).toLocaleString('en-US');}
function setOptions(element,items,selected){element.replaceChildren();for(const [value,label]of items){const option=el('option',label);option.value=String(value);element.append(option);}if(items.some(item=>String(item[0])===String(selected)))element.value=String(selected);}
function eventAt(record,cta,g,role){const event=record.events.find(e=>e.cta[0]===cta&&e.iteration===g&&e.role===role);if(!event)throw Error('缺少实际采样事件 '+role);return event;}
function selectedCTA(){return Number($('cta').value);}
function currentEvents(){return state.record.events.filter(e=>e.cta[0]===selectedCTA()&&e.iteration===state.generation);}
function relevantObligations(){return state.capture.obligations.filter(o=>Number(o.derivation.sourceRequestId.split(':')[1])===state.generation);}
function statusClass(status){return status==='satisfied'?'good':status==='violated'?'bad':'unknown';}
function filterRecords(){return data.runs.filter(r=>( $('variant').value==='all'||r.variant===$('variant').value)&&['count','generations','seed'].every(key=>$(key).value==='all'||Number($(key).value)===(key==='count'?r.shape[0]:r[key])));}
function refreshFilters(preferred){const previous=preferred||$('run').value,records=filterRecords();setOptions($('run'),records.map(r=>[r.measurement_id,`${r.variant} · N=${r.shape[0]} · G=${r.generations} · seed=${r.seed}`]),previous);$('filter-count').textContent=`${records.length} / ${data.runs.length} 次实机运行`;if(!records.length)throw Error('筛选无结果');selectRun();}
function selectRun(){state.record=data.runs.find(r=>r.measurement_id===$('run').value);if(!state.record)throw Error('无效运行');const priorCTA=$('cta').value,priorG=$('generation').value;setOptions($('cta'),Array.from({length:Math.ceil(state.record.shape[0]/32)},(_,i)=>[i,String(i)]),priorCTA);setOptions($('generation'),Array.from({length:state.record.generations},(_,i)=>[i,`g=${i}`]),priorG);render();}
function showSource(line){state.sourceLine=line;const first=Math.max(1,line-6),last=Math.min(data.sourceLines.length,line+6);$('source').replaceChildren();for(let n=first;n<=last;n++){const row=el('span',undefined,'line'+(n===line?' highlight':''));row.append(el('span',n,'number'),document.createTextNode(data.sourceLines[n-1]));$('source').append(row);}$('source-label').textContent=`version_probe.cu:${line} · 冻结的实际编译源码快照`;$('source').dataset.line=String(line);}
function sourceButton(line){const b=el('button',`line ${line}`,'link-button');b.addEventListener('click',()=>showSource(line));return b;}
function renderSlots(){const table=el('table'),head=el('tr');head.append(el('th','slot'));for(let g=0;g<state.record.generations;g++)head.append(el('th',`代次 g=${g}`));table.append(head);const snapshots=[],tags=[-1,-1];for(let g=0;g<state.record.generations;g++){const write=eventAt(state.record,selectedCTA(),g,'producer_write'),read=eventAt(state.record,selectedCTA(),g,'consumer_read');tags[write.slot]=write.observed_generation;snapshots.push({tags:[...tags],write,read});}for(let slot=0;slot<2;slot++){const tr=el('tr');tr.append(el('th',`slot ${slot}`));snapshots.forEach((snapshot,g)=>{const td=el('td'),isRead=snapshot.read.slot===slot,isWrite=snapshot.write.slot===slot,wrong=isRead&&(snapshot.read.slot!==g%2||snapshot.read.observed_generation!==g);const b=el('button',undefined,'slot-cell'+(isWrite?' written':'')+(isRead?' read':'')+(wrong?' wrong':'')+(g===state.generation?' current':''));b.dataset.slot=slot;b.dataset.generation=g;b.dataset.tag=snapshot.tags[slot];b.append(el('strong',`tag ${snapshot.tags[slot]}`),el('span',isWrite?'实际 producer 写入':'保留先前版本'),el('span',isRead?`实际 consumer 读取 tag ${snapshot.read.observed_generation}`:'本代未读取此 slot'),el('span',slot===g%2?'合同要求读取此 slot':'','muted'));b.addEventListener('click',()=>{$('generation').value=g;render();});td.append(b);tr.append(td);});table.append(tr);}$('slots').replaceChildren(table);}
function renderOutputs(){const count=state.record.shape[0],start=selectedCTA()*32,end=Math.min(count,start+32),rows=[];$('outputs').replaceChildren();for(let index=start;index<end;index++){const offset=state.generation*count+index,actual=state.record.output[offset],reference=state.record.reference[offset],tag=state.record.observed_generations[offset],difference=actual-reference;const tr=el('tr',undefined,difference!==0?'mismatch':'');tr.dataset.index=index;tr.dataset.actual=actual;tr.dataset.reference=reference;tr.dataset.difference=difference;tr.dataset.tag=tag;[index,actual,reference,difference,tag].forEach(value=>tr.append(el('td',String(value),'mono')));$('outputs').append(tr);rows.push({index,actual,reference,difference,tag});}const errors=rows.filter(r=>r.difference!==0).length;$('output-summary').textContent=`当前 ${rows.length} 个有效输出，${errors} 个数值不符；实际 tag ${eventAt(state.record,selectedCTA(),state.generation,'consumer_read').observed_generation}，预期 tag ${state.generation}。`;$('output-summary').dataset.errors=errors;$('events').replaceChildren();for(const event of currentEvents()){const tr=el('tr');tr.append(el('td',`${roleNames[event.role]} / thread ${event.thread}`),el('td',`slot ${event.slot} / tag ${event.observed_generation}`));const td=el('td');td.append(sourceButton(event.source_line));tr.append(td);$('events').append(tr);}}
function renderFact(fact){const derived=fact.kind.startsWith('source-derived'),hardware=fact.kind==='hardware-event';const detail=el('details',undefined,'fact '+(hardware?'hardware':derived?'source-derived':'contract'));const label=hardware?'实际采样':derived?'源码推导':'合同 / 身份绑定';detail.append(el('summary',`${label} · ${fact.kind} · ${fact.id}`));if(fact.sourceLine||fact.source_line)detail.append(sourceButton(fact.sourceLine||fact.source_line));detail.append(el('pre',JSON.stringify(fact,null,2)));return detail;}
function renderProof(){state.obligation=state.capture.obligations.find(o=>o.id===$('obligation').value);if(!state.obligation)throw Error('没有选中义务');const obligation=state.obligation,lookup=new Map(state.capture.evidence.map(f=>[f.id,f]));$('status').textContent=labels[obligation.status];$('status').className=statusClass(obligation.status);$('status').dataset.status=obligation.status;$('reason').textContent=obligation.derivation.reasons.join(' · ');$('positive-count').textContent=obligation.positiveWitnessRefs.length;$('unknown-count').textContent=obligation.unknownRefs.length;$('positive').replaceChildren(...obligation.positiveWitnessRefs.map(id=>renderFact(lookup.get(id))));$('unknown').replaceChildren(...obligation.unknownRefs.map(id=>renderFact(lookup.get(id))));if(!obligation.unknownRefs.length)$('unknown').append(el('p','当前完整输入没有返回 unknown 边界。这是依赖实际标签与固定源码合同的条件结论。','empty'));const slice=state.capture.slices.find(s=>s.obligationId===obligation.id);$('slice-summary').textContent=`证据切片：保留 ${slice.retainedNodes} / ${slice.fullNodes} 个节点；正面见证与未知边界均在已保存切片内。它只说明证据保留，不代表诊断准确率。`;$('slice-summary').dataset.retained=slice.retainedNodes;$('slice-summary').dataset.full=slice.fullNodes;const matched=data.ablations.filter(a=>a.measurement===state.record.measurement_id&&a.cta===selectedCTA());$('ablations').replaceChildren(...matched.map(a=>el('p',`${a.mode==='mask-consumer-value-token'?'遮蔽 consumer value token':'移除检查器 HB edges（保留 facts）'}：${a.unknown} 个相关义务返回 unknown。`,'small')));}
function render(){state.generation=Number($('generation').value);state.capture=data.captures.find(c=>c.measurement===state.record.measurement_id&&c.cta===selectedCTA());if(!state.capture)throw Error('缺少CTA检查结果');const read=eventAt(state.record,selectedCTA(),state.generation,'consumer_read'),wrong=read.slot!==state.generation%2||read.observed_generation!==state.generation;$('selection-id').textContent=`${state.record.measurement_id}\nCTA ${selectedCTA()} · generation ${state.generation} · 固定 block 64 threads`;$('slot-comparison').replaceChildren();const expected=el('div'),actual=el('div',undefined,'actual '+(wrong?'bad':'good'));expected.append(el('span','合同预期'),el('strong',`slot ${state.generation%2} · tag ${state.generation}`));actual.append(el('span','实际 consumer_read'),el('strong',`slot ${read.slot} · tag ${read.observed_generation}`));actual.dataset.slot=read.slot;actual.dataset.tag=read.observed_generation;$('slot-comparison').append(expected,actual);$('run-summary').textContent=`本次运行全部 ${state.record.output.length} 个输出：${state.record.correctness.value_mismatches} 个数值不符，${state.record.correctness.version_mismatches} 个版本不符。初始化 tag -1 在checker中映射为逻辑generation 0；raw tag g映射为g+1。`;$('sanitizer-summary').textContent='固定代表形状 N=65、G=5、seed=20261023：memcheck / synccheck / racecheck 对两个候选均为0 tool errors；wrong-slot 的数值与版本仍然错误。Sanitizer不是对每个运行逐一执行。';renderSlots();renderOutputs();const prior=$('obligation').value,obligations=relevantObligations();setOptions($('obligation'),obligations.map(o=>[o.id,`${kindNames[o.kind]||o.kind} · ${o.id}`]),prior);renderProof();$('hashes').textContent=`CUDA source SHA256: ${data.suiteSourceHashes['version_probe.cu']}\nrunner SHA256: ${data.suiteSourceHashes['run_version_probe.py']}\nbinary SHA256: ${data.binarySha256}\n当前原始stdout SHA256: ${state.record.recordRef.sha256}`;showSource(read.source_line);}
function start(){const cards=[['72','实机运行；36 correct / 36 controlled wrong-slot'],[fmt(data.counts.normal_output_elements),'实际返回的有效输出元素'],[fmt(data.counts.normal_events),'设备实际写入的事件记录'],['6 / 6','代表形状 sanitizer检查：0 tool errors']];$('overview').replaceChildren(...cards.map(([n,label])=>{const c=el('div',undefined,'card');c.append(el('strong',n),el('span',label));return c;}));for(const key of ['count','generations','seed']){const values=[...new Set(data.runs.map(r=>key==='count'?r.shape[0]:r[key]))].sort((a,b)=>a-b);setOptions($(key),[['all','全部'],...values.map(v=>[v,String(v)])],'all');$(key).addEventListener('change',()=>refreshFilters());}$('variant').addEventListener('change',()=>refreshFilters());$('run').addEventListener('change',selectRun);$('cta').addEventListener('change',render);$('generation').addEventListener('change',render);$('obligation').addEventListener('change',renderProof);$('reset').addEventListener('click',()=>{for(const key of ['variant','count','generations','seed'])$(key).value='all';refreshFilters();});$('provenance').textContent=JSON.stringify(data.provenance,null,2);const initial=data.runs.find(r=>r.variant==='wrong-slot'&&r.shape[0]===33&&r.generations===5)||data.runs[0];refreshFilters(initial.measurement_id);document.documentElement.dataset.ready='true';}
window.versionViewer={data,state,selectedCTA,relevantObligations,filterRecords};
try{start();}catch(error){$('error').textContent='无法显示证据：'+String(error);document.documentElement.dataset.ready='error';throw error;}
</script></body></html>'''


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def build_data(suite_path, bridge_path):
    suite_bytes = (suite_path / "summary.json").read_bytes()
    bridge_bytes = (bridge_path / "summary.json").read_bytes()
    suite, bridge = json.loads(suite_bytes), json.loads(bridge_bytes)
    if suite.get("status") != "completed" or bridge["inputSummarySha256"] != sha(suite_bytes):
        raise ValueError("completed suite and exact bridge input binding required")
    if len(suite["runs"]) != 72 or len(suite["sanitizers"]) != 6:
        raise ValueError("viewer scope expects the frozen 72-run/6-sanitizer experiment")
    for name, digest in suite["source_hashes"].items():
        if sha((suite_path / name).read_bytes()) != digest:
            raise ValueError("suite source snapshot hash mismatch: " + name)
    if any(item["tool_error_count"] != 0 for item in suite["sanitizers"]):
        raise ValueError("viewer sanitizer narrative requires explicit zero-error results")
    by_id = {record["measurement_id"]: record for record in suite["runs"]}
    captures, counts, input_hashes = [], Counter(), {}
    for row in bridge["rows"]:
        raw = (bridge_path / row["file"]).read_bytes()
        if sha(raw) != row.get("resultSha256") or len(raw) != row.get("resultBytes"):
            raise ValueError("CTA result differs from bridge-bound hash/size: " + row["file"])
        document = json.loads(raw)
        record = by_id[row["measurement"]]
        if (row["count"], row["generations"], row["seed"], row["variant"]) != (record["shape"][0], record["generations"], record["seed"], record["variant"]):
            raise ValueError("bridge row differs from measured run")
        run = document["run"]
        evidence = {fact["id"]: fact for fact in run["evidence"]}
        slices = {item["obligationId"]: item for item in document["slices"]}
        for obligation in run["obligations"]:
            if obligation["status"] not in ("satisfied", "violated", "unknown"):
                raise ValueError("unexpected checker status")
            counts[obligation["status"]] += 1
            references = obligation["positiveWitnessRefs"] + obligation["unknownRefs"]
            if not set(references) <= evidence.keys():
                raise ValueError("dangling obligation evidence")
            item = slices[obligation["id"]]
            retained = {fact["id"] for fact in item["run"]["evidence"]}
            if item["status"] != obligation["status"] or not set(references) <= retained:
                raise ValueError("stored slice lost status or witness references")
        captures.append({"measurement": row["measurement"], "cta": row["cta"],
                         "obligations": run["obligations"], "evidence": run["evidence"],
                         "slices": [{key: item[key] for key in ("obligationId", "fullNodes", "retainedNodes", "status")}
                                    for item in document["slices"]]})
        input_hashes[row["file"]] = sha(raw)
    if any(counts[key] != bridge["obligationCounts"].get(key, 0) for key in ("satisfied", "violated", "unknown")):
        raise ValueError("CTA results differ from bridge aggregate counts")
    source = (suite_path / "version_probe.cu").read_text()
    provenance = {"suite_summary_sha256": sha(suite_bytes), "bridge_summary_sha256": sha(bridge_bytes),
                  "bridge_cta_file_sha256": input_hashes, "bridge_source_sha256": bridge["sourceSha256"],
                  "renderer_sha256": sha(Path(__file__).read_bytes()), "bridge_counts": bridge["obligationCounts"],
                  "limitations": bridge["limitations"], "source_barrier_contract": suite["operator_contract"]}
    return {"runs": suite["runs"], "captures": captures, "ablations": bridge["ablations"],
            "counts": suite["counts"], "suiteSourceHashes": suite["source_hashes"],
            "binarySha256": suite["binary_sha256"], "sourceLines": source.splitlines(), "provenance": provenance}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", type=Path, required=True)
    parser.add_argument("--bridge", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit("refusing to overwrite existing viewer")
    data = build_data(args.suite.resolve(), args.bridge.resolve())
    embedded = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    html = PAGE.replace("__DATA__", embedded)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(html, encoding="utf-8")
    manifest = {"html_sha256": sha(args.output.read_bytes()), "html_bytes": args.output.stat().st_size,
                "renderer_sha256": sha(Path(__file__).read_bytes()), "runs": len(data["runs"]),
                "cta_results": len(data["captures"]), "inputs": data["provenance"]}
    (args.output.parent / "render-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({key: manifest[key] for key in ("html_sha256", "html_bytes", "runs", "cta_results")}))


if __name__ == "__main__":
    main()
