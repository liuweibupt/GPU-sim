// Recognize explicit operation semantics only; profile category names are not evidence.
export const stages = [
  {op:'cp.dram2sram_tma', label:'Load · DRAM → SRAM'},
  {op:'wgmma.m64n64k16', label:'Tensor · 矩阵乘加'},
  {op:'st.reg2sram', label:'Store · 寄存器 → SRAM'},
  {op:'cp.sram2dram_tma', label:'Store · SRAM → DRAM'},
];
export function buildDataflow(trace) {
  const events = new Map(trace.events.map(event => [event.id,event]));
  const nodes = new Map(events);
  for (const node of trace.metrics?.omittedNodes ?? []) nodes.set(node.id,node);
  const incoming = new Map(), outgoing = new Map();
  for (const event of nodes.values()) {
    const edges = [ ['completion',event.dependencies ?? []], ['issue',event.args?.issueDependencies ?? event.issueDependencies ?? []] ];
    for (const [kind,ids] of edges) for (const source of new Set(ids)) {
      const edge = {source,target:event.id,kind};
      if (!incoming.has(event.id)) incoming.set(event.id,[]);
      if (!outgoing.has(source)) outgoing.set(source,[]);
      incoming.get(event.id).push(edge); outgoing.get(source).push(edge);
    }
  }
  return {events,nodes,incoming,outgoing};
}
export function reachable(model,id,direction) {
  const found = new Set(), stack = [id];
  const map = direction === 'upstream' ? model.incoming : model.outgoing;
  while (stack.length) for (const edge of map.get(stack.pop()) ?? []) {
    const next = direction === 'upstream' ? edge.source : edge.target;
    if (next !== id && !found.has(next)) {found.add(next); stack.push(next);}
  }
  return found;
}
export function eventState(event,time) {
  if (!event || event.start == null || time < event.start) return '未开始';
  if (event.end == null) return '未完成（结束未知）';
  return time < event.end ? '进行中' : '已完成';
}

export function moduleOf(event) {
  const op=event.args?.op;
  if(op==='cp.dram2sram_tma')return 'load';
  if(op==='wgmma.m64n64k16')return 'tensor';
  if(op==='st.reg2sram'||op==='cp.sram2dram_tma')return 'store';
  return null;
}
export function flowGroups(events,level='sm') {
  const groups=new Map();
  for(const event of events) {
    if(!moduleOf(event)||event.args?.smId==null)continue;
    const {smId,threadBlockId}=event.args;
    if(level==='cta'&&threadBlockId==null)continue;
    const id=JSON.stringify(level==='cta'?[smId,threadBlockId]:[smId]);
    if(!groups.has(id))groups.set(id,{id,smId,threadBlockId:level==='cta'?threadBlockId:null,label:`SM ${smId}${level==='cta'?` / CTA ${threadBlockId}`:''}`,events:[]});
    groups.get(id).events.push(event);
  }
  return [...groups.values()];
}
export function activityWindows(events) {
  const changes=new Map();
  for(const event of events){const kind=moduleOf(event);if(!kind||event.end<=event.start)continue;
    for(const [time,delta]of [[event.start,1],[event.end,-1]]){if(!changes.has(time))changes.set(time,[]);changes.get(time).push([kind,delta]);}}
  const times=[...changes.keys()].sort((a,b)=>a-b),counts={load:0,tensor:0,store:0},windows=[];
  times.forEach((time,i)=>{for(const [kind,delta]of changes.get(time))counts[kind]+=delta;
    if(i+1<times.length)windows.push({start:time,end:times[i+1],...counts,overlap:counts.tensor>0&&(counts.load>0||counts.store>0)});});
  return windows;
}

// Tile payloads, not cache-line packets. A dependency reference is not another copy.
export function tilePayload(event,bytesPerElement=null) {
  const {rows,cols}=event?.args?.tile??{};
  if(!Number.isSafeInteger(rows)||!Number.isSafeInteger(cols)||rows<=0||cols<=0||!Number.isSafeInteger(rows*cols))return null;
  const elements=rows*cols;
  return {rows,cols,elements,bytes:bytesPerElement==null?null:elements*bytesPerElement};
}
export function transferPackets(active,model) {
  const packets=[];const refs=new Map();
  for(const event of active){const op=event.args?.op;
    if(op==='cp.dram2sram_tma')packets.push({route:'read',event,payloadEvent:event,reference:false});
    if(op==='cp.sram2dram_tma')packets.push({route:'write',event,payloadEvent:event,reference:false});
    if(op==='st.reg2sram')packets.push({route:'result',event,payloadEvent:event,reference:false});
    if(moduleOf(event)==='tensor')for(const edge of model.incoming.get(event.id)??[]){
      const source=model.events.get(edge.source);
      if(edge.kind!=='completion'||moduleOf(source??{})!=='load')continue;
      if(!refs.has(source.id))refs.set(source.id,{route:'consume',event,payloadEvent:source,reference:true,consumers:[]});
      refs.get(source.id).consumers.push(event.id);
    }
  }
  return packets.concat([...refs.values()]);
}
