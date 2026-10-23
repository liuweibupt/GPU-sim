#!/usr/bin/env python3
"""Render an offline, bounded evidence viewer from audited normalized traces."""
import argparse
from collections import Counter, defaultdict
import csv
import gzip
import hashlib
import json
from pathlib import Path


PAGE = r'''<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>多卡 GPU 指令证据查看器</title>
<style>
:root{font:15px/1.55 system-ui,sans-serif;color:#172b42;background:#f2f5f8}body{margin:0}main{max-width:1320px;margin:auto;padding:30px}h1{font-size:27px;margin:0}h2{font-size:19px;margin:0 0 12px}p{margin:8px 0}section{background:white;border:1px solid #d9e1ea;border-radius:10px;padding:20px;margin:20px 0}.lead{max-width:1040px;color:#47596d}.tag{display:inline-block;padding:3px 9px;border-radius:5px;background:#e9eff5;margin:3px;font-size:13px}.unknown{background:#fff1d7;color:#775219}.controls{display:flex;gap:14px;align-items:center;flex-wrap:wrap}select,input,button{font:inherit;padding:6px 9px;border:1px solid #acbccb;border-radius:5px;background:white;color:inherit}select{max-width:100%}button{cursor:pointer}button:hover{background:#eef4fa}.mono,code{font:12px/1.5 ui-monospace,monospace;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;padding:7px 9px;border-bottom:1px solid #e2e8ef;vertical-align:top}th{background:#f3f6fa;position:sticky;top:0}tr.selected{background:#d8eafa}tr.removed{color:#758597;background:#f8fafc}.scroll{max-height:510px;overflow:auto}.grid{display:grid;grid-template-columns:1.25fr 1fr;gap:20px}.small{font-size:13px;color:#54667b}.bar{height:9px;background:#d9e8f7;border-radius:4px}.bar span{display:block;height:9px;background:#426d9c;border-radius:4px}canvas{width:100%;height:140px;display:block;cursor:crosshair;background:#f7f9fb}#detail{white-space:pre-wrap;max-height:300px;overflow:auto}.legend{display:flex;gap:15px;flex-wrap:wrap;font-size:12px}.dot{display:inline-block;width:10px;height:10px;margin-right:4px}#error{color:#a01c28;white-space:pre-wrap}a{color:#245d92}details summary{cursor:pointer}pre{overflow:auto;font-size:12px;max-height:400px}#relations{max-height:190px;overflow:auto}@media(max-width:850px){main{padding:14px}.grid{grid-template-columns:1fr}h1{font-size:22px}}
</style><main>
<h1>多卡 GPU 指令证据查看器</h1>
<p class="lead">从真实采集 trace 导出的规范化 CTA 程序，查看跨架构结构、候选关联与证据缺口。指令序号只表示所选 warp 内的规范化记录顺序。</p>
<div><span class="tag">离线复用</span><span class="tag">候选关系可检查</span><span class="tag unknown">数值版本 / 协议正确性：未知</span></div>
<div id="error" role="alert"></div>
<section><h2>全量覆盖与显示范围</h2><div id="coverage"></div>
<p class="small">全量统计按每个模板的物理 CTA 重数加权。下方只展开确定性选中的 CTA / warp；不把这些视图当作全部 kernel，也不把缓存模板当作新的独立样本。</p></section>
<section><h2>选择证据与检索方式</h2><div class="controls">
<label>视图 <select id="view"></select></label>
<label>检索 <select id="method"><option value="full">完整所选 warp</option><option value="order_ancestors">顺序前缀</option><option value="register_ancestors">寄存器语法祖先</option><option value="protocol_assisted" selected>寄存器＋符号关联祖先</option></select></label>
<button id="reset">恢复实验 seed</button></div>
<p id="scope" class="small"></p><p id="identity" class="mono"></p>
<p class="small">点击下图或表格改变 seed。关联来自已有边：寄存器最后写者、相同符号 barrier、静态 scoreboard 均是候选；缺失 lane mask / 实际完成事件时，不能据此推出精确数据依赖或跨 warp happens-before。</p>
<canvas id="strip" aria-label="规范化指令顺序及保留节点图"></canvas>
<div class="legend"><span><i class="dot" style="background:#526b87"></i>其他指令</span><span><i class="dot" style="background:#007f80"></i>TMA</span><span><i class="dot" style="background:#7750a5"></i>tensor / tcgen</span><span><i class="dot" style="background:#bd741a"></i>wait / barrier</span><span><i class="dot" style="background:#dce2e9"></i>未保留</span><span>黑框：当前 seed</span></div>
<p id="stats"></p><div id="comparison"></div></section>
<div class="grid"><section><h2>逐指令检查</h2><div class="controls"><label><input id="retained" type="checkbox" checked> 只显示保留节点</label><button id="previous">上一页</button><button id="next">下一页</button><span id="page" class="small"></span></div>
<div class="scroll"><table><thead><tr><th>ordinal / PC</th><th>opcode</th><th>源 → 目的寄存器</th></tr></thead><tbody id="nodes"></tbody></table></div></section>
<section><h2>当前节点与直接候选关联</h2><p id="explanation"></p><pre id="detail"></pre><div id="relations"></div>
<p class="small">TMA byte 与符号地址字段保留转换器语义；符号 ID 不是原始地址，等待指令的出现不等于等待时长。此页不显示模拟器的 latency_cycles。</p>
<h2>保持未知的信息</h2><div id="unknown"></div><p class="small">本页没有故障真值、优化后的重新执行或参与者测量。缩小候选集合只说明结构检索行为，不能报告诊断准确率或人类理解提升。</p></section></div>
<section><details><summary>来源与可复现信息</summary><pre id="provenance"></pre></details></section>
</main><script id="evidence-data" type="application/json">__DATA__</script>
<script>
'use strict';
const $=id=>document.getElementById(id);
const data=JSON.parse($('evidence-data').textContent);
const views=data.views.views;
let current=null, seeds=[], retained=new Set(), page=0;
const methodTypes={full:null,order_ancestors:new Set(['order']),register_ancestors:new Set(['syntactic_register']),protocol_assisted:new Set(['syntactic_register','symbolic_barrier_candidate','static_scoreboard_candidate'])};
const labels={full:'完整 warp',order_ancestors:'顺序前缀',register_ancestors:'寄存器候选',protocol_assisted:'寄存器＋符号关联'};
const fmt=n=>Number(n).toLocaleString('en-US');
function elem(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function table(headers,rows){const t=elem('table'),h=elem('thead'),tr=elem('tr');headers.forEach(x=>tr.append(elem('th',x)));h.append(tr);t.append(h);const b=elem('tbody');for(const row of rows){const r=elem('tr');row.forEach(x=>r.append(elem('td',x)));b.append(r);}t.append(b);return t;}
function closure(method){if(method==='full')return new Set(current.nodes.map(n=>n.id));const incoming=new Map();for(const e of current.edges){if(!methodTypes[method].has(e.type))continue;if(!incoming.has(e.target))incoming.set(e.target,[]);incoming.get(e.target).push(e.source);}const result=new Set(seeds),stack=[...seeds];while(stack.length){for(const id of incoming.get(stack.pop())||[]){if(!result.has(id)){result.add(id);stack.push(id);}}}return result;}
function color(n){const text=[n.opcode,...(n.mechanisms||[])].join(' ').toUpperCase();if(/TMA|UTMALD/.test(text))return '#007f80';if(/WAIT|BAR|SYNCS/.test(text))return '#bd741a';if(/TCGEN|UTCHMMA|HGMMA|HMMA|MMA/.test(text))return '#7750a5';return '#526b87';}
function explain(n){if(!n)return '';const op=n.opcode;const common='这是按字段生成的阅读提示，未验证逻辑数据版本。';if(op.includes('SIM_WAIT'))return '此项是解析器规范化后的等待记录；不能把它当作原始 SASS 指令或真实等待时长。'+common;if(/UTMALDG|UTMASTG/.test(op))return `此项属于 TMA 搬运指令族；记录 tma_bytes=${n.tma_bytes??'未知'}。相同 barrier 符号提示可检查的关联，尚不证明传输完成或目标布局正确。`+common;if(/UTCHMMA/.test(op))return '此项属于 tcgen05 MMA 对应的 SASS 指令族；出现一次计算记录不等于结果已经可读，需进一步核查完成协议与 TMEM 生存期。'+common;if(/HGMMA|HMMA|MMA/.test(op))return '此项属于矩阵计算指令族。寄存器名和规范化顺序可供检查，但缓存缺少逐 lane 数值和逻辑 tensor 区域。'+common;if(/BAR|WAIT|SYNCS/.test(op))return '此项包含同步或等待相关记录。当前候选边只连接同一 warp 中的字段，不证明跨 warp happens-before 或正确的 phase。'+common;return '此项显示指令名、PC 和寄存器字段。候选前驱使用最后出现的同名写寄存器；缺少 active mask 时，这不等于精确的数据来源。'+common;}
function draw(){const c=$('strip'),w=Math.max(400,Math.round(c.getBoundingClientRect().width)),h=140,dpr=window.devicePixelRatio||1;c.width=w*dpr;c.height=h*dpr;const ctx=c.getContext('2d');ctx.scale(dpr,dpr);const cols=Math.min(current.nodes.length,Math.floor(w/5)),rows=Math.ceil(current.nodes.length/cols),cw=w/cols,ch=Math.min(14,115/rows);c._layout={cols,cw,ch};current.nodes.forEach((n,i)=>{const x=(i%cols)*cw,y=Math.floor(i/cols)*ch;ctx.fillStyle=retained.has(n.id)?color(n):'#dce2e9';ctx.fillRect(x,y,Math.max(1,cw-.6),Math.max(.8,ch-.6));if(seeds.includes(n.id)){ctx.strokeStyle='#111';ctx.lineWidth=1.4;ctx.strokeRect(x,y,Math.max(1,cw-.6),Math.max(.8,ch-.6));}});ctx.fillStyle='#526477';ctx.font='12px sans-serif';ctx.fillText('按行从左至右：ordinal 0 → '+(current.nodes.length-1)+'；非硬件时间轴',4,136);}
function selectNode(id){seeds=[id];page=0;render();}
function renderNodes(){const filtered=current.nodes.filter(n=>!$('retained').checked||retained.has(n.id));const pages=Math.max(1,Math.ceil(filtered.length/70));page=Math.min(page,pages-1);$('page').textContent=`${page+1} / ${pages} · ${fmt(filtered.length)} 条`;$('nodes').replaceChildren();for(const n of filtered.slice(page*70,(page+1)*70)){const tr=elem('tr',undefined,seeds.includes(n.id)?'selected':retained.has(n.id)?'':'removed');tr.tabIndex=0;tr.addEventListener('click',()=>selectNode(n.id));tr.addEventListener('keydown',e=>{if(e.key==='Enter')selectNode(n.id);});tr.append(elem('td',`${n.ordinal} / 0x${Number(n.pc).toString(16)}`,'mono'));tr.append(elem('td',n.opcode,'mono'));tr.append(elem('td',`${(n.sources||[]).join(', ')} → ${(n.destinations||[]).join(', ')}`,'mono'));$('nodes').append(tr);}const n=current.nodes.find(x=>x.id===seeds[0]);$('detail').textContent=JSON.stringify(n,null,2);const relations=current.edges.filter(e=>e.source===seeds[0]||e.target===seeds[0]);$('relations').replaceChildren(table(['源 → 目标','关系（候选）'],relations.map(e=>[`${e.source} → ${e.target}`,e.type])));}
function render(){retained=closure($('method').value);draw();renderNodes();$('explanation').textContent=explain(current.nodes.find(n=>n.id===seeds[0]));$('stats').textContent=`seed ${seeds.join(', ')}：保留 ${fmt(retained.size)} / ${fmt(current.nodes.length)} 个节点（${(100*retained.size/current.nodes.length).toFixed(1)}%）。当前是交互查询，不是新的计时测量。`;$('comparison').replaceChildren(table(['同一 seed 的方法','保留节点','比例'],Object.keys(labels).map(m=>{const count=closure(m).size;return [labels[m],fmt(count),(100*count/current.nodes.length).toFixed(1)+'%'];})));}
function setView(){current=views[Number($('view').value)];seeds=[...current.seed_ids];page=0;$('scope').textContent=`${current.gpu} · ${current.case} · CTA ${current.cta_id} / template ${current.template_id} / warp ${current.warp_id} · 选中 warp ${fmt(current.nodes.length)} 条规范化指令。${current.display_group==='supplemental'?'补充 tensor warp，仅展示，不纳入 12 个主样本的统计。':'主实验视图。'}`;$('identity').textContent=`trace SHA256: ${current.trace_sha256}\ncache SHA256: ${current.cache_sha256}`;render();}
function start(){if(!views.length)throw Error('没有可显示的 audited view');views.forEach((v,i)=>{const o=elem('option',`${v.gpu} · ${v.category} · ${v.case}`);o.value=i;$('view').append(o);});$('coverage').replaceChildren(table(['GPU','case','launch','物理 CTA','展开规范化指令'],data.coverage.map(r=>[r.gpu,fmt(r.cases),fmt(r.launches),fmt(r.ctas),fmt(r.instructions)])));$('unknown').textContent=JSON.stringify(data.views.capabilities,null,2);$('provenance').textContent=JSON.stringify({input_sha256:data.input_sha256,renderer_sha256:data.renderer_sha256,selection_policy:data.views.selection_policy,summary:data.summary},null,2);$('view').value=Math.max(0,views.findIndex(v=>v.gpu==='B200'&&v.category==='gemm'));setView();$('view').addEventListener('change',setView);$('method').addEventListener('change',()=>{page=0;render();});$('reset').addEventListener('click',()=>{seeds=[...current.seed_ids];page=0;render();});$('retained').addEventListener('change',()=>{page=0;renderNodes();});$('previous').addEventListener('click',()=>{page=Math.max(0,page-1);renderNodes();});$('next').addEventListener('click',()=>{page++;renderNodes();});$('strip').addEventListener('click',e=>{const r=e.target.getBoundingClientRect(),l=e.target._layout,index=Math.floor((e.clientY-r.top)/l.ch)*l.cols+Math.floor((e.clientX-r.left)/l.cw);if(current.nodes[index])selectNode(current.nodes[index].id);});window.addEventListener('resize',draw);document.documentElement.dataset.ready='true';}
try{start();}catch(e){$('error').textContent='无法显示数据：'+e.message;document.documentElement.dataset.ready='error';throw e;}
</script></html>'''


def render(source, output):
    names = ('selected-views.json', 'summary.json', 'launches.csv', 'cases.csv')
    raw = {name: (source / name).read_bytes() if (source / name).exists()
           else gzip.decompress((source / (name + '.gz')).read_bytes()) for name in names}
    views, summary = json.loads(raw[names[0]]), json.loads(raw[names[1]])
    supplemental = 'supplemental-views.json'
    if supplemental in summary.get('artifacts', {}):
        names += (supplemental,)
        raw[supplemental] = ((source / supplemental).read_bytes() if (source / supplemental).exists()
                             else gzip.decompress((source / (supplemental + '.gz')).read_bytes()))
    if summary.get('validation', {}).get('errors') != 0:
        raise ValueError('refusing to display an incomplete or failed audit')
    for name in names:
        if name == 'summary.json':
            continue
        expected = summary['artifacts'][name]
        if (hashlib.sha256(raw[name]).hexdigest() != expected['sha256'] or
                len(raw[name]) != expected['bytes']):
            raise ValueError('artifact differs from audited input: ' + name)
    for view in views['views']:
        view['display_group'] = 'primary'
    if supplemental in raw:
        extra = json.loads(raw[supplemental])
        for view in extra['views']:
            view['display_group'] = 'supplemental'
        views['views'].extend(extra['views'])
        views['supplemental_selection_policy'] = extra['selection_policy']
    if not views.get('views'):
        raise ValueError('empty views')
    for view in views['views']:
        ids = {n['id'] for n in view['nodes']}
        if len(ids) != len(view['nodes']) or not set(view['seed_ids']) <= ids:
            raise ValueError('invalid node or seed identities')
        if any(e['source'] not in ids or e['target'] not in ids for e in view['edges']):
            raise ValueError('dangling relation')
    launches = list(csv.DictReader(raw['launches.csv'].decode().splitlines()))
    cases = list(csv.DictReader(raw['cases.csv'].decode().splitlines()))
    coverage = defaultdict(lambda: Counter())
    for row in cases:
        coverage[row['gpu']]['cases'] += 1
    for row in launches:
        c = coverage[row['gpu']]
        c['launches'] += 1
        c['ctas'] += int(row['physical_ctas'])
        c['instructions'] += int(row['physical_normalized_instructions'])
    data = {'views': views, 'summary': summary,
            'coverage': [dict(gpu=gpu, **values) for gpu, values in sorted(coverage.items())],
            'input_sha256': {name: hashlib.sha256(value).hexdigest() for name, value in raw.items()},
            'renderer_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    # Prevent embedded JSON from ending its script element, including unusual trace names.
    embedded = json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(PAGE.replace('__DATA__', embedded), encoding='utf-8')
    print(output.resolve())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    render(args.input, args.output)
