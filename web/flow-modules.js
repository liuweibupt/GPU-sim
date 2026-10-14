import {createPacketLayer} from './flow-packets.js';
import {moduleOf,flowGroups,activityWindows} from '../lib/dataflow.js';
const NS='http://www.w3.org/2000/svg';
function el(tag,text,cls){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;}
function svg(tag,attrs={}){const n=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);return n;}
const names={load:'Load',tensor:'Tensor',store:'Store'};
const colors={load:'#62c5ed',tensor:'#ba9aef',store:'#6bdec0'};
export function createFlowModules(root,onSelect,onSeek) {
  let trace,model,level='sm',groupId,group,groups=[],lastView,selectedId,scopeKey,chart,cursor,x,cards={},paths={},clock,summary,windows=[],lastActive='',packetLayer;
  const controls=el('div',null,'module-controls'),levelSelect=el('select'),groupSelect=el('select');
  levelSelect.setAttribute('aria-label','数据流分组层级');groupSelect.setAttribute('aria-label','数据流 SM 或 CTA');
  for(const[value,label]of [['sm','按 SM'],['cta','按 CTA']]){const o=el('option',label);o.value=value;levelSelect.append(o);}
  controls.append(levelSelect,groupSelect);clock=el('span');controls.append(clock);
  const jump=el('button','定位首次访存 / 计算重叠');jump.type='button';controls.append(jump);
  jump.addEventListener('click',()=>{const w=windows.find(w=>w.overlap);if(w)onSeek(w.start);});
  const packetPanel=el('div',null,'packet-panel');
  const stage=el('div',null,'module-stage'),lanes=el('div',null,'module-lanes');summary=el('p',null,'module-summary');
  root.append(controls,stage,packetPanel,summary,lanes,el('p','发光模块表示该组当前正在执行的任务；流动连线表示搬运或当前消费者的依赖。各模块独立工作，可同时高亮。','muted'));
  levelSelect.addEventListener('change',()=>{level=levelSelect.value;chooseGroups(group?.smId,group?.threadBlockId);render();update(lastView,model);});
  groupSelect.addEventListener('change',()=>{groupId=groupSelect.value;group=groups.find(g=>g.id===groupId);render();update(lastView,model);});
  function chooseGroups(sm,cta){groups=flowGroups(trace.events,level);group=groups.find(g=>g.smId===sm&&(level==='sm'||g.threadBlockId===cta))??groups[0];groupId=group?.id;groupSelect.replaceChildren();for(const g of groups){const o=el('option',g.label);o.value=g.id;groupSelect.append(o);}groupSelect.value=groupId??'';levelSelect.value=level;}
  function render(){
    stage.replaceChildren();lanes.replaceChildren();packetPanel.replaceChildren();packetLayer=null;cards={};paths={};lastActive='';cursor=null;
    if(!group){stage.append(el('p','此记录没有可按 SM / CTA 分组的 Load、Tensor、Store 操作。'));windows=[];jump.disabled=true;return;}
    windows=activityWindows(group.events);jump.disabled=!windows.some(w=>w.overlap);
    const scene=svg('svg',{viewBox:'0 0 1000 390',class:'module-scene','aria-label':`${group.label} 的并行模块与数据流`});
    const defs=svg('defs'),marker=svg('marker',{id:'module-arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto'});marker.append(svg('path',{d:'M0 0 L10 5 L0 10Z',fill:'#83a7b8'}));defs.append(marker);scene.append(defs);
    function path(id,d,label,lx,ly){const p=svg('path',{d,class:'module-path','marker-end':'url(#module-arrow)'});scene.append(p);paths[id]=p;const t=svg('text',{x:lx,y:ly,class:'module-edge-label','text-anchor':'middle'});t.textContent=label;scene.append(t);}
    path('read','M200 255 L200 150','DRAM → SRAM',105,207);
    path('consume','M350 85 L650 85','已加载的 SRAM 操作数',500,65);
    path('result','M800 150 L800 255','计算结果',877,207);
    path('write','M650 320 L350 320','SRAM → DRAM 写回',500,350);
    const positions={load:[50,20],tensor:[650,20],store:[650,255],memory:[50,255]};
    for(const[kind,[px,py]]of Object.entries(positions)){
      const foreign=svg('foreignObject',{x:px,y:py,width:300,height:135});const card=el('div',null,`module-card module-${kind}`);card.dataset.module=kind;
      card.append(el('h3',kind==='memory'?'DRAM / 数据存储':names[kind]));const status=el('p'),tasks=el('div',null,'module-live-tasks');card.append(status,tasks);foreign.append(card);scene.append(foreign);cards[kind]={card,status,tasks};
    }
    stage.append(scene);
    packetLayer=createPacketLayer(scene,paths,packetPanel,onSelect);
    const bounds=group.events.reduce((a,e)=>({start:Math.min(a.start,e.start),end:Math.max(a.end,e.end)}),{start:Infinity,end:-Infinity});
    x=t=>110+(t-bounds.start)/(bounds.end-bounds.start||1)*855;
    chart=svg('svg',{viewBox:'0 0 1000 190',class:'module-timeline','aria-label':'Load Tensor Store 共享时间轴'});
    for(const w of windows.filter(w=>w.overlap))chart.append(svg('rect',{x:x(w.start),y:23,width:x(w.end)-x(w.start),height:130,class:'module-overlap'}));
    ['load','tensor','store'].forEach((kind,i)=>{const y=38+i*42,label=svg('text',{x:8,y:y+14});label.textContent=names[kind];chart.append(label);
      // Union bands retain parallel intervals without overplotting hundreds of tasks.
      const bands=[];for(const w of windows.filter(w=>w[kind]>0)){const last=bands.at(-1);if(last&&last.end===w.start)last.end=w.end;else bands.push({start:w.start,end:w.end});}
      for(const band of bands){const rect=svg('rect',{x:x(band.start),y,width:Math.max(1,x(band.end)-x(band.start)),height:22,rx:3,fill:colors[kind]});const title=svg('title');title.textContent=`${names[kind]} ${band.start}–${band.end} ${trace.meta.timeUnit}`;rect.append(title);chart.append(rect);}
    });
    for(let i=0;i<=4;i++){const t=bounds.start+(bounds.end-bounds.start)*i/4,label=svg('text',{x:x(t),y:178,'text-anchor':i===4?'end':'middle'});label.textContent=`${Math.round(t)} ${trace.meta.timeUnit}`;chart.append(label);}
    cursor=svg('line',{y1:22,y2:155,class:'module-cursor'});chart.append(cursor);
    chart.addEventListener('click',e=>{const rect=chart.getBoundingClientRect(),px=(e.clientX-rect.left)/rect.width*1000;onSeek(Math.max(bounds.start,Math.min(bounds.end,bounds.start+(px-110)/855*(bounds.end-bounds.start))));});
    lanes.append(chart);
  }
  function update(view,nextModel){
    if(!view?.trace)return;lastView=view;model=nextModel;
    let rebuild=false;
    if(trace!==view.trace){trace=view.trace;chooseGroups();rebuild=true;selectedId=undefined;scopeKey=undefined;}
    const scope=JSON.stringify(view.scope??null);
    if(scope!==scopeKey){scopeKey=scope;if(view.scope?.smId!=null){level=view.scope.threadBlockId!=null?'cta':'sm';chooseGroups(view.scope.smId,view.scope.threadBlockId);rebuild=true;}}
    if(selectedId!==view.selectedEventId){selectedId=view.selectedEventId;const e=model.events.get(selectedId);if(e?.args?.smId!=null&&moduleOf(e)){const match=groups.find(g=>g.smId===e.args.smId&&(level==='sm'||g.threadBlockId===e.args.threadBlockId));if(match&&match.id!==groupId){group=match;groupId=match.id;groupSelect.value=groupId;rebuild=true;}}}
    if(rebuild)render();
    if(!group)return;
    clock.textContent=`${group.label} · ${Number(view.time.toFixed(2))} ${trace.meta.timeUnit}`;
    const active=group.events.filter(e=>e.start<=view.time&&view.time<e.end),counts={load:0,tensor:0,store:0};for(const e of active)counts[moduleOf(e)]++;
    const overlapping=counts.tensor>0&&(counts.load>0||counts.store>0);
    const duration=windows.filter(w=>w.overlap).reduce((sum,w)=>sum+w.end-w.start,0);
    summary.textContent=`${overlapping?'● 访存与计算正在并行':'当前：'+(active.length?Object.keys(counts).filter(k=>counts[k]).map(k=>names[k]).join(' + ')+' 执行中':'无进行中任务')} · 本组访存 / 计算重叠共 ${duration} ${trace.meta.timeUnit}（泳道底色标出重叠区间，点击时间轴定位）`;
    summary.classList.toggle('is-overlap',overlapping);
    const signature=active.map(e=>e.id).join('|');
    for(const kind of ['load','tensor','store']){const c=cards[kind];c.card.classList.toggle('is-active',counts[kind]>0);c.status.textContent=`${counts[kind]} 个任务正在执行`;
      if(signature!==lastActive){c.tasks.replaceChildren();for(const e of active.filter(e=>moduleOf(e)===kind).slice(0,2)){const b=el('button',`${e.id} · ${e.name}`);b.type='button';b.title=e.name;b.addEventListener('click',()=>onSelect(e.id));c.tasks.append(b);}}
    }
    lastActive=signature;
    packetLayer?.update(active,model,view.time);
    const read=counts.load>0,write=active.some(e=>e.args.op==='cp.sram2dram_tma');
    const dependencyPairs=(targetKind,sourceKind)=>active.filter(e=>moduleOf(e)===targetKind).flatMap(e=>(model.incoming.get(e.id)??[]).filter(edge=>edge.kind==='completion'&&moduleOf(model.events.get(edge.source)??{})===sourceKind));
    const consume=dependencyPairs('tensor','load'),result=dependencyPairs('store','tensor');
    for(const [id,edges] of [['consume',consume],['result',result]]) {let title=paths[id].querySelector('title');if(!title){title=svg('title');paths[id].append(title);}title.textContent=edges.length?edges.slice(0,8).map(e=>`${e.source} → ${e.target}`).join('\n'):'当前没有此方向的消费者';}
    for(const[id,on]of Object.entries({read,write,consume:consume.length>0,result:result.length>0}))paths[id].classList.toggle('is-flowing',on);
    cards.memory.card.classList.toggle('is-active',read||write);cards.memory.status.textContent=read&&write?'读取与写回同时进行':read?'正在读取':write?'正在写回':'等待访存任务';
    if(cursor){cursor.setAttribute('x1',x(view.time));cursor.setAttribute('x2',x(view.time));cursor.style.display=x(view.time)<110||x(view.time)>965?'none':'';}
  }
  return {update};
}
