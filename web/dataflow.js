import {createFlowModules} from './flow-modules.js';
import {buildDataflow,reachable,eventState} from '../lib/dataflow.js';
const ns = 'http://www.w3.org/2000/svg';
function el(tag,text,cls) {const n=document.createElement(tag); if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;}
function svg(tag,attrs={}) {const n=document.createElementNS(ns,tag);for(const [k,v]of Object.entries(attrs))n.setAttribute(k,v);return n;}
export function createDataflow(root,onSelect,onSeek) {
  let trace,model,selected,badges=[];
  const moduleRoot=el('div');
  const modules=createFlowModules(moduleRoot,onSelect,onSeek);
  function update(view) {
    if (!view.trace) return;
    const changed = trace !== view.trace;
    if(changed){trace=view.trace;model=buildDataflow(trace);}
    if(changed || selected !== view.selectedEventId) {selected=view.selectedEventId;render();}
    modules.update(view,model);
    for(const {node,event} of badges) {const status=eventState(event,view.time);node.textContent=status;node.dataset.state=status;}
  }

  function task(id) {
    const event=model.nodes.get(id), full=model.events.has(id);
    const box=el('div',null,'flow-task');
    const button=el('button',event?.name ?? id);button.type='button';button.disabled=!full;
    button.title=event?.name ?? id;button.addEventListener('click',()=>onSelect(id));
    const badge=el('span',null,'flow-status');badges.push({node:badge,event});
    box.append(button,el('small',`${id} · ${event?.componentId ?? '未完成节点'} · ${event?.start ?? '?'} → ${event?.end ?? '?'} ${trace.meta.timeUnit}`),badge);
    return box;
  }
  function render() {
    root.replaceChildren();badges=[];
    root.append(moduleRoot);
    const upstream=reachable(model,selected,'upstream'),downstream=reachable(model,selected,'downstream');
    root.append(el('h3','任务依赖追踪'));
    root.append(el('p','实线 → 完成依赖；虚线 ⇢ 发射顺序。依赖可能包含同步约束，不等同于逐字节消费关系。点击任务可继续向前或向后追踪。','muted'));
    if(!model.nodes.has(selected)){root.append(el('p','从上方活动任务、架构图或时间线选择一个任务，查看上下游连线。','empty'));return;}
    root.append(el('p',`全部递归关联：上游 ${upstream.size} 个 · 下游 ${downstream.size} 个（包含两种依赖）。下图展示直接依赖。`));
    const incoming=model.incoming.get(selected)??[],outgoing=model.outgoing.get(selected)??[];
    // Bound the graph, while keeping every direct edge accessible in the lists below.
    const before=incoming.slice(0,6),after=outgoing.slice(0,6);
    const height=Math.max(160,Math.max(before.length,after.length)*62+35);
    const chart=svg('svg',{viewBox:`0 0 1000 ${height}`,class:'flow-graph',role:'img','aria-label':'所选任务的直接上游与下游依赖图'});
    const defs=svg('defs'),marker=svg('marker',{id:'flow-arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:7,markerHeight:7,orient:'auto-start-reverse'});
    marker.append(svg('path',{d:'M 0 0 L 10 5 L 0 10 z',fill:'#96bccc'}));defs.append(marker);chart.append(defs);
    const cy=height/2;
    function link(x1,y1,x2,y2,edge){const path=svg('path',{d:`M ${x1} ${y1} C ${(x1+x2)/2} ${y1}, ${(x1+x2)/2} ${y2}, ${x2} ${y2}`,class:`flow-edge ${edge.kind}`,'marker-end':'url(#flow-arrow)'});const title=svg('title');title.textContent=`${edge.source} → ${edge.target} · ${edge.kind==='issue'?'发射顺序':'完成依赖'}`;path.append(title);chart.append(path);}
    before.forEach((edge,i)=>link(290,40+i*62,365,cy,edge));after.forEach((edge,i)=>link(635,cy,710,40+i*62,edge));
    function graphTask(id,x,y){const foreign=svg('foreignObject',{x,y:y-25,width:280,height:55});const b=el('button',null,'flow-graph-task');const e=model.nodes.get(id);b.append(el('strong',`${id} · ${e?.args?.op??'操作未知'}`),el('small',e?.name??'未完成节点'));b.title=e?.name??id;b.disabled=!model.events.has(id);b.addEventListener('click',()=>onSelect(id));foreign.append(b);chart.append(foreign);}
    graphTask(selected,360,cy);before.forEach((e,i)=>graphTask(e.source,5,40+i*62));after.forEach((e,i)=>graphTask(e.target,715,40+i*62));root.append(chart);
    root.append(el('p',`图中显示前 ${before.length} / ${incoming.length} 条上游边、${after.length} / ${outgoing.length} 条下游边；完整关联可在下面展开。`,'muted'));
    const lists=el('div',null,'flow-relations');
    for(const [label,edges,field]of [['上游 / 前置任务',incoming,'source'],['下游 / 后继任务',outgoing,'target']]){
      const column=el('details');column.append(el('summary',`${label} (${edges.length})`));
      let loaded=false;column.addEventListener('toggle',()=>{if(!column.open||loaded)return;loaded=true;for(const edge of edges){const box=task(edge[field]);box.prepend(el('small',edge.kind==='issue'?'⇢ 发射顺序':'→ 完成依赖'));column.append(box);}update({trace,selectedEventId:selected,time:Number(root.dataset.time)||0});});lists.append(column);
    }
    root.append(lists);
  }
  return {update(view){root.dataset.time=view.time;update(view);}};
}
