import {tilePayload,transferPackets} from '../lib/dataflow.js';
const NS='http://www.w3.org/2000/svg';
function svg(tag,attrs={}){const n=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);return n;}
function el(tag,text){const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;}
const routes={read:'DRAM → Load',consume:'SRAM → Tensor',result:'寄存器 → Store / SRAM',write:'Store → DRAM'};
function sizeLabel(payload,reference){
  if(!payload)return '大小未知';
  if(reference)return `引用 ${payload.rows}×${payload.cols}`;
  if(payload.bytes!=null)return `≈${Number((payload.bytes/1024).toFixed(2))} KiB`;
  return `${payload.elements.toLocaleString('en-US')} 元素`;
}
export function createPacketLayer(scene,paths,panel,onSelect){
  const layer=svg('g',{'aria-label':'按 tile 大小绘制的数据包'});scene.append(layer);
  let signature='',nodes=[],bytesPerElement=null,last;
  panel.replaceChildren();
  const toolbar=el('div');toolbar.className='packet-toolbar';
  const label=el('label','包大小单位 '),units=el('select');units.setAttribute('aria-label','数据包大小单位');
  for(const[v,t]of [['','元素数（Trace tile）'],['2','估算字节 · 2 B / 元素'],['4','估算字节 · 4 B / 元素']]){const o=el('option',t);o.value=v;units.append(o);}label.append(units);toolbar.append(label);
  const totals=el('span');toolbar.append(totals);panel.append(toolbar);
  const note=el('p','一个方包代表一次 tile 搬运，包体随大小对数缩放，标签给出数值；菱形包是 Tensor 引用的已加载 tile，不重复计入搬运量。每条通道最多显示 3 包，完整任务见清单。');note.className='muted';panel.append(note);
  const details=el('details'),summary=el('summary','当前数据包清单'),list=el('div');list.className='packet-list';details.append(summary,list);panel.append(details);
  units.addEventListener('change',()=>{bytesPerElement=units.value?Number(units.value):null;signature='';if(last)update(...last);});
  function update(active,model,time){
    last=[active,model,time];const packets=transferPackets(active,model);
    const key=JSON.stringify(packets.map(p=>[p.route,p.event.id,p.payloadEvent.id,p.consumers]));
    if(signature!==key){signature=key;nodes=[];layer.replaceChildren();list.replaceChildren();
      for(const route of Object.keys(routes)){
        const all=packets.filter(p=>p.route===route);
        all.slice(0,3).forEach((p,i)=>{
          const payload=tilePayload(p.payloadEvent,bytesPerElement);
          const side=p.reference?18:Math.max(18,Math.min(42,10+Math.log2((payload?.elements??256)+1)*2));
          const g=svg('g',{class:`data-packet ${p.reference?'packet-reference':''}`,tabindex:0,role:'button','aria-label':`${routes[route]} ${p.event.id} ${sizeLabel(payload,p.reference)}`});
          const rect=svg('rect',{x:-side/2,y:-side/2,width:side,height:side,rx:p.reference?2:5});if(p.reference)rect.setAttribute('transform','rotate(45)');g.append(rect);
          const seam=svg('path',{d:`M ${-side/2+3} -4 H ${side/2-3} M 0 ${-side/2+3} V ${side/2-3}`,class:'packet-seam'});if(!p.reference)g.append(seam);
          const text=svg('text',{y:side/2+14,'text-anchor':'middle'});text.textContent=sizeLabel(payload,p.reference);g.append(text);
          const title=svg('title');title.textContent=`${routes[route]} · ${p.event.name}\n${sizeLabel(payload,p.reference)}${payload?` · tile ${payload.rows}×${payload.cols}`:''}${p.reference?`\n来源 ${p.payloadEvent.id} → ${p.consumers.join(', ')}`:''}`;g.append(title);
          g.addEventListener('click',()=>onSelect(p.event.id));g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();onSelect(p.event.id);}});layer.append(g);nodes.push({g,p,i,count:Math.min(3,all.length)});
        });
        if(all.length>3){const pos=paths[route].getPointAtLength(paths[route].getTotalLength()/2);const more=svg('text',{x:pos.x+(route==='read'?-58:route==='result'?58:0),y:route==='consume'?200:pos.y-28,class:'packet-more','text-anchor':'middle'});more.textContent=`+${all.length-3} 包`;layer.append(more);}
      }
      // Keep large traces bounded; the list can be expanded in chunks without duplicating volumes.
      let shown=0;const more=el('button','再显示 40 个包');more.type='button';
      function append(){for(const p of packets.slice(shown,shown+40)){const b=el('button',`${routes[p.route]} · ${p.event.id} · ${sizeLabel(tilePayload(p.payloadEvent,bytesPerElement),p.reference)}${p.reference?` · ${p.payloadEvent.id} 被 ${p.consumers.length} 个任务引用`:''}`);b.type='button';b.addEventListener('click',()=>onSelect(p.event.id));list.insertBefore(b,more);}shown+=40;more.hidden=shown>=packets.length;}
      more.addEventListener('click',append);list.append(more);append();
    }
    for(const{g,p,i,count}of nodes){const progress=Math.max(0,Math.min(1,(time-p.event.start)/(p.event.end-p.event.start||1)));const path=paths[p.route];const pos=path.getPointAtLength(path.getTotalLength()*(.15+.7*progress));const offset=(i-(count-1)/2)*62;g.setAttribute('transform',`translate(${pos.x+(['read','result'].includes(p.route)?offset:0)},${pos.y+(['consume','write'].includes(p.route)?offset:0)})`);}
    const transfers=packets.filter(p=>!p.reference),known=transfers.map(p=>tilePayload(p.payloadEvent,bytesPerElement)).filter(Boolean);
    const total=known.reduce((n,p)=>n+(p.bytes??p.elements),0);
    totals.textContent=`当前 ${transfers.length} 个搬运任务 · 整包总量 ${bytesPerElement?'≈'+Number((total/1024).toFixed(2))+' KiB':total.toLocaleString('en-US')+' 元素'}${known.length<transfers.length?'（另有大小未知）':''} · ${packets.length-transfers.length} 个 tile 引用`;
    summary.textContent=`当前数据包清单 (${packets.length})`;
  }
  return {update};
}
