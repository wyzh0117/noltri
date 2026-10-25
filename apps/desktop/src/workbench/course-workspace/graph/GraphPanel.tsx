import {useEffect,useMemo,useRef,useState,type ReactElement} from 'react';
import type {ContentLocation,NavigationOptions,WorkspaceGraph,WorkspaceGraphNode,WorkspaceGraphRequest} from '@noltri/schema';
import type {WorkbenchApi} from '../../api';
import {IconButton} from '../ui/Icon';
import {GraphRenderer,type GraphCamera} from './graph-renderer';
import {DEFAULT_FORCES,ForceSimulation,initializeForces,type ForceSettings} from './graph-simulation';
import type {GraphWorkerMessage} from './graph-worker';
import './graph.css';
import {ObjectPreview} from '../tools/LinkPreview';
const STORE='noltri:workspace-graph:settings';
const EMPTY:WorkspaceGraph={layoutKey:'empty',revision:0,nodes:[],edges:[]};
interface Settings {view:'subject'|'advanced';advancedScope:'focus'|'discipline'|'all';depth:number;filter:string;groups:{query:string;color:string}[];showTags:boolean;showAttachments:boolean;showUnresolved:boolean;showOrphans:boolean;incoming:boolean;outgoing:boolean;interconnect:boolean;arrows:boolean;labels:'auto'|'all'|'none';forces:ForceSettings}
const defaults:Settings={view:'subject',advancedScope:'focus',depth:1,filter:'',groups:[],showTags:true,showAttachments:false,showUnresolved:false,showOrphans:true,incoming:true,outgoing:true,interconnect:false,arrows:false,labels:'auto',forces:DEFAULT_FORCES};
function read<T>(key:string,fallback:T):T{try{return JSON.parse(localStorage.getItem(key)??'null')??fallback;}catch{return fallback;}}
function save(key:string,value:unknown):void{try{localStorage.setItem(key,JSON.stringify(value));}catch{/* View remains usable without cache. */}}
export interface GraphPanelProps {api:WorkbenchApi;focus:ContentLocation;onNavigate:(location:ContentLocation,options?:NavigationOptions)=>void;expanded:boolean;onExpandedChange:(expanded:boolean)=>void;theme?:'light'|'dark';wholeDiscipline?:boolean;onWholeDisciplineChange?:(whole:boolean)=>void}
export function GraphPanel({api,focus,onNavigate,expanded,onExpandedChange,theme='light',wholeDiscipline,onWholeDisciplineChange}:GraphPanelProps):ReactElement{
  const [settings,setSettings]=useState<Settings>(()=>{const s=read<Partial<Settings>>(STORE,{});return {...defaults,...s,forces:{...DEFAULT_FORCES,...s.forces}};});
  const [wholeLocal,setWholeLocal]=useState(false),whole=wholeDiscipline??wholeLocal;
  const [graph,setGraph]=useState<WorkspaceGraph>(EMPTY),[error,setError]=useState(''),[loading,setLoading]=useState(false),[tick,setTick]=useState(0);
  const [settingsOpen,setSettingsOpen]=useState(false),[hovered,setHovered]=useState<string|null>(null),[menu,setMenu]=useState<{node:WorkspaceGraphNode;x:number;y:number}|null>(null),[choices,setChoices]=useState<ContentLocation[]>([]);
  const [engine,setEngine]=useState(''),[forceCanvas,setForceCanvas]=useState(false),[timeline,setTimeline]=useState<number|null>(null),[playing,setPlaying]=useState(false);
  const [preview,setPreview]=useState<WorkspaceGraphNode|null>(null),[previewError,setPreviewError]=useState(''),[previewResource,setPreviewResource]=useState<{url:string;type:string}|null>(null);
  const previewHeld=useRef(false),hoverTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const container=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null),labelCanvas=useRef<HTMLCanvasElement>(null),renderer=useRef<GraphRenderer|null>(null),worker=useRef<Worker|null>(null);
  const graphRef=useRef(graph),positions=useRef<Float32Array>(new Float32Array()),camera=useRef<GraphCamera>({x:0,y:0,scale:1}),version=useRef(0),raf=useRef(0),size=useRef({width:310,height:280}),hasCamera=useRef(false),autoFit=useRef(true);
  const fallback=useRef<ForceSimulation|null>(null),fallbackTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const paintOptions=useRef({theme,selected:null as string|null,hovered,labels:settings.labels,arrows:settings.arrows});
  const disciplineId='disciplineId'in focus?focus.disciplineId:undefined;
  const setWhole=(value:boolean):void=>{setWholeLocal(value);onWholeDisciplineChange?.(value);};
  const knownTimes=useMemo(()=>[...new Set(graph.edges.flatMap(e=>e.createdAt?[Date.parse(e.createdAt)]:[]).filter(Number.isFinite))].sort((a,b)=>a-b),[graph]);
  const displayGraph=useMemo(()=>timeline===null?graph:{...graph,edges:graph.edges.filter(e=>!e.createdAt||Date.parse(e.createdAt)<=timeline)},[graph,timeline]);
  graphRef.current=displayGraph;
  paintOptions.current={theme,selected:'courseId'in focus?focus.courseId:focus.kind==='discipline'?focus.disciplineId:focus.subdisciplineId,hovered,labels:settings.labels,arrows:settings.arrows};
  const redraw=():void=>{if(raf.current)return;raf.current=requestAnimationFrame(()=>{raf.current=0;renderer.current?.draw(graphRef.current,positions.current,camera.current,paintOptions.current);});};
  const fit=():void=>{const p=positions.current;if(!p.length)return;let left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity;for(let i=0;i<p.length;i+=2){left=Math.min(left,p[i]);right=Math.max(right,p[i]);top=Math.min(top,p[i+1]);bottom=Math.max(bottom,p[i+1]);}camera.current={x:0,y:0,scale:Math.min(2,Math.max(1/128,Math.min((size.current.width-80)/Math.max(100,right-left),(size.current.height-60)/Math.max(100,bottom-top))))};camera.current.x=-(left+right)/2*camera.current.scale;camera.current.y=-(top+bottom)/2*camera.current.scale;hasCamera.current=true;redraw();};
  const request=useMemo(()=>JSON.stringify({...settings,subjectScope:whole&&settings.view==='subject'?'whole-discipline':'local',focus:whole&&settings.view==='subject'&&disciplineId?{kind:'discipline',disciplineId}:focus,disciplineId}),[settings,whole,focus,disciplineId]);
  useEffect(()=>{let active=true;setLoading(true);setError('');void api.selectWorkspaceGraph(JSON.parse(request) as WorkspaceGraphRequest).then(g=>{if(active){setGraph(g);setLoading(false);}},e=>{if(active){setError(e instanceof Error?e.message:String(e));setLoading(false);}});return()=>{active=false;};},[api,request,tick]);
  useEffect(()=>{const refresh=()=>setTick(t=>t+1);window.addEventListener('noltri:workspace-changed',refresh);return()=>window.removeEventListener('noltri:workspace-changed',refresh);},[]);
  useEffect(()=>{save(STORE,settings);},[settings]);
  useEffect(()=>{redraw();},[theme,hovered,settings.labels,settings.arrows,focus,displayGraph]);
  useEffect(()=>{
    if(!canvas.current||!labelCanvas.current||!container.current)return;
    let r:GraphRenderer;
    try{r=new GraphRenderer(canvas.current,labelCanvas.current,forceCanvas);}catch{setForceCanvas(true);return;}
    renderer.current=r;setEngine(r.engine);
    const resize=()=>{const rect=container.current!.getBoundingClientRect();size.current={width:Math.max(1,rect.width),height:Math.max(1,rect.height)};r.resize(size.current.width,size.current.height);redraw();};
    const observer=new ResizeObserver(resize);observer.observe(container.current);resize();
    const lost=(e:Event)=>{e.preventDefault();setForceCanvas(true);setError('GPU 上下文已丢失，已切换 Canvas 渲染。');};canvas.current.addEventListener('webglcontextlost',lost);
    return()=>{observer.disconnect();canvas.current?.removeEventListener('webglcontextlost',lost);r.dispose();renderer.current=null;};
  },[forceCanvas]);
  useEffect(()=>{
    const previous=read<{camera:GraphCamera;positions:Record<string,{x:number;y:number}>}>(`noltri:graph-layout:${graph.layoutKey}`,{camera:{x:0,y:0,scale:1},positions:{}});
    const valid=Number.isFinite(previous.camera?.x)&&Number.isFinite(previous.camera?.y)&&Number.isFinite(previous.camera?.scale)&&previous.camera.scale>=1/128&&previous.camera.scale<=8;
    hasCamera.current=valid&&Object.keys(previous.positions??{}).length>0;autoFit.current=!hasCamera.current;camera.current=valid?previous.camera:{x:0,y:0,scale:1};
    const initial=initializeForces(graph.nodes,graph.edges,new Map(Object.entries(previous.positions??{}).filter(([,p])=>Number.isFinite(p.x)&&Number.isFinite(p.y)).map(([id,p])=>[id,{id,...p,vx:0,vy:0,radius:8}])));
    positions.current=new Float32Array(initial.flatMap(n=>[n.x,n.y]));if(!hasCamera.current)fit();
    let w:Worker|null=null;
    try{w=new Worker(new URL('./graph-worker.ts',import.meta.url),{type:'module'});worker.current=w;}
    catch{setEngine(e=>`${e} / JS 主线程回退`);}
    const frame=(p:Float32Array):void=>{positions.current=p;if(autoFit.current)fit();else redraw();};
    if(w){const v=++version.current,started=performance.now();let settled=false;w.onmessage=(event:MessageEvent<{version:number;positions:Float32Array;engine:string;active:boolean}>)=>{if(event.data.version===v){frame(event.data.positions);setEngine(`${renderer.current?.engine??'canvas'} / ${event.data.engine}`);if(!event.data.active&&!settled){settled=true;window.dispatchEvent(new CustomEvent('noltri:graph-settled',{detail:{nodes:graph.nodes.length,edges:graph.edges.length,engine:event.data.engine,elapsedMs:performance.now()-started}}));}}};w.onerror=()=>{setError('布局 Worker 出错；当前坐标已保留，可重新载入。');};w.postMessage({type:'graph',version:v,graph,settings:settings.forces,positions:previous.positions} satisfies GraphWorkerMessage);}
    else{fallback.current=new ForceSimulation(initial,graph.edges,settings.forces);const step=()=>{const sim=fallback.current;if(!sim)return;const active=sim.tick();frame(new Float32Array(sim.nodes.flatMap(n=>[n.x,n.y])));if(active)fallbackTimer.current=setTimeout(step,16);};step();}
    return()=>{const p=positions.current;const saved:Record<string,{x:number;y:number}>={};graph.nodes.forEach((n,i)=>{if(Number.isFinite(p[i*2])&&Number.isFinite(p[i*2+1]))saved[n.id]={x:p[i*2],y:p[i*2+1]};});save(`noltri:graph-layout:${graph.layoutKey}`,{camera:camera.current,positions:saved});w?.terminate();worker.current=null;if(fallbackTimer.current)clearTimeout(fallbackTimer.current);fallback.current=null;};
  },[graph.layoutKey,graph.revision,graph.nodes,graph.edges]);
  useEffect(()=>{worker.current?.postMessage({type:'settings',settings:settings.forces} satisfies GraphWorkerMessage);if(fallback.current){fallback.current.settings=settings.forces;fallback.current.alpha=.3;}},[settings.forces]);
  useEffect(()=>()=>{if(raf.current)cancelAnimationFrame(raf.current);},[]);
  useEffect(()=>{if(!playing||!knownTimes.length)return;const timer=setInterval(()=>setTimeline(t=>{const i=knownTimes.findIndex(v=>v>(t??knownTimes[0]));if(i<0){setPlaying(false);return null;}return knownTimes[Math.min(knownTimes.length-1,i+Math.ceil(Math.min(100,Math.max(5,.5*Math.sqrt(graph.edges.length))))-1)];}),1000);return()=>clearInterval(timer);},[playing,knownTimes,graph.edges.length]);
  useEffect(()=>{
    if(hoverTimer.current)clearTimeout(hoverTimer.current);
    if(hovered)hoverTimer.current=setTimeout(()=>setPreview(graph.nodes.find(n=>n.id===hovered)??null),300);
    else hoverTimer.current=setTimeout(()=>{if(!previewHeld.current)setPreview(null);},400);
    return()=>{if(hoverTimer.current)clearTimeout(hoverTimer.current);};
  },[hovered,graph.nodes]);
  useEffect(()=>{
    let active=true,url='';setPreviewResource(null);setPreviewError('');if(!preview)return;
    if(preview.kind==='attachment'){void api.getAttachmentContent(preview.id.slice(11)).then(blob=>{if(active){url=URL.createObjectURL(blob);setPreviewResource({url,type:blob.type});}},e=>{if(active)setPreviewError(String(e));});return()=>{active=false;if(url)URL.revokeObjectURL(url);};}
    return()=>{active=false;};
  },[preview,api]);
  useEffect(()=>{
    const persist=()=>{const current=graphRef.current,p=positions.current;const stored:Record<string,{x:number;y:number}>={};current.nodes.forEach((n,i)=>{if(Number.isFinite(p[i*2])&&Number.isFinite(p[i*2+1]))stored[n.id]={x:p[i*2],y:p[i*2+1]};});save(`noltri:graph-layout:${current.layoutKey}`,{camera:camera.current,positions:stored});};
    window.addEventListener('pagehide',persist);window.addEventListener('beforeunload',persist);return()=>{window.removeEventListener('pagehide',persist);window.removeEventListener('beforeunload',persist);};
  },[]);
  const locate=(event:{clientX:number;clientY:number})=>{const rect=container.current!.getBoundingClientRect();return{x:event.clientX-rect.left-size.current.width/2,y:event.clientY-rect.top-size.current.height/2};};
  const hit=(p:{x:number;y:number}):WorkspaceGraphNode|undefined=>{const cam=camera.current;let best:WorkspaceGraphNode|undefined,min=18;graph.nodes.forEach((n,i)=>{const distance=Math.hypot(p.x-positions.current[i*2]*cam.scale-cam.x,p.y-positions.current[i*2+1]*cam.scale-cam.y);if(distance<min){min=distance;best=n;}});return best;};
  const drag=useRef<{pointer:number;node?:WorkspaceGraphNode;x:number;y:number;camera:GraphCamera;moved:boolean}|null>(null);
  const open=(node:WorkspaceGraphNode,options:NavigationOptions={origin:'graph',preserveGraphContext:whole}):void=>{
    setMenu(null);
    if(node.kind==='tag'){window.dispatchEvent(new CustomEvent('noltri:workspace-search',{detail:`tag:${node.title}`}));return;}
    if(node.kind==='attachment'){setPreview(node);return;}
    if(node.kind==='unresolved'){setError(`待建立引用：${node.title}`);return;}
    let targets=node.targets;
    if(node.kind==='chapter'&&'courseId'in focus){const local=targets.filter(t=>'courseId'in t&&t.courseId===focus.courseId);if(local.length)targets=local;}
    const inCurrent=targets.filter(t=>'disciplineId'in t&&t.disciplineId===disciplineId);if(inCurrent.length)targets=inCurrent;
    const unique=[...new Map(targets.map(t=>[JSON.stringify({...t,viaParentId:undefined}),t])).values()];
    if(unique.length===1)onNavigate(unique[0],options);else if(unique.length>1)setChoices(unique);else setError(`${node.title}没有可用内容位置`);
  };
  const pin=(id:string,x?:number,y?:number)=>{worker.current?.postMessage({type:'pin',id,x,y} satisfies GraphWorkerMessage);if(fallback.current){const n=fallback.current.nodes.find(n=>n.id===id);if(n){n.fx=x;n.fy=y;}fallback.current.alphaTarget=x===undefined?0:.3;}};
  const snapshot=async()=>{try{const blob=await renderer.current?.snapshot();if(!blob)return;if(navigator.clipboard&&typeof ClipboardItem!=='undefined')await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);else{const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='noltri-graph.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}catch(e){setError(e instanceof Error?e.message:String(e));}};
  const update=<K extends keyof Settings>(key:K,value:Settings[K])=>setSettings(s=>({...s,[key]:value}));
  return <section className="cw-graph" aria-label="课程知识图谱">
    <header className="cw-graph-toolbar"><select aria-label="图谱类型" value={settings.view} onChange={e=>update('view',e.target.value as Settings['view'])}><option value="subject">学科图谱</option><option value="advanced">高级网络</option></select><span className="cw-graph-count">{graph.nodes.length} 节点</span><IconButton icon="settings" label="图谱设置" aria-expanded={settingsOpen} onClick={()=>setSettingsOpen(!settingsOpen)}/><IconButton icon={expanded?'back':'graph'} label={expanded?'收起图谱':'展开图谱'} onClick={()=>{if(expanded&&settings.view==='subject'&&whole)setWhole(false);onExpandedChange(!expanded);}}/></header>
    {focus.kind==='discipline'&&settings.view==='subject'&&!whole?<button className="cw-graph-whole" type="button" onClick={()=>{setWhole(true);onExpandedChange(true);}}>展开本学科全部节点</button>:whole&&settings.view==='subject'?<button type="button" className="cw-graph-whole" onClick={()=>{setWhole(false);onExpandedChange(false);}}>返回局部学科图</button>:null}
    <div ref={container} className="cw-graph-surface" tabIndex={0} role="group" aria-label={`知识图谱，${graph.nodes.length} 个节点；方向键平移，F 适配，Enter 打开所选节点`}
      onKeyDown={e=>{autoFit.current=false;if(e.key.toLowerCase()==='f'){fit();e.preventDefault();}else if(e.key==='Enter'){const n=graph.nodes.find(n=>n.id===paintOptions.current.selected)??graph.nodes[0];if(n)open(n);}else if(e.key.startsWith('Arrow')){e.preventDefault();camera.current={...camera.current,x:camera.current.x+(e.key==='ArrowLeft'?30:e.key==='ArrowRight'?-30:0),y:camera.current.y+(e.key==='ArrowUp'?30:e.key==='ArrowDown'?-30:0)};redraw();}}}
      onWheel={e=>{e.preventDefault();autoFit.current=false;const p=locate(e),c=camera.current,next=Math.max(1/128,Math.min(8,c.scale*Math.exp(-e.deltaY*.0012)));camera.current={scale:next,x:p.x-(p.x-c.x)/c.scale*next,y:p.y-(p.y-c.y)/c.scale*next};redraw();}}
      onPointerDown={e=>{if(e.button!==0)return;autoFit.current=false;setMenu(null);const p=locate(e);drag.current={pointer:e.pointerId,node:hit(p),x:e.clientX,y:e.clientY,camera:{...camera.current},moved:false};e.currentTarget.setPointerCapture(e.pointerId);}}
      onPointerMove={e=>{const p=locate(e),d=drag.current;if(!d){const n=hit(p);setHovered(n?.id??null);if((e.metaKey||e.ctrlKey)&&n)setPreview(n);return;}if(d.pointer!==e.pointerId)return;if(Math.hypot(e.clientX-d.x,e.clientY-d.y)>5)d.moved=true;if(!d.moved)return;if(d.node){const x=(p.x-camera.current.x)/camera.current.scale,y=(p.y-camera.current.y)/camera.current.scale;pin(d.node.id,x,y);const i=graph.nodes.findIndex(n=>n.id===d.node!.id);positions.current[i*2]=x;positions.current[i*2+1]=y;}else camera.current={...d.camera,x:d.camera.x+e.clientX-d.x,y:d.camera.y+e.clientY-d.y};redraw();}}
      onPointerUp={e=>{const d=drag.current;drag.current=null;if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);if(!d)return;if(d.node){pin(d.node.id);if(!d.moved)open(d.node,{origin:'graph',preserveGraphContext:whole,openIn:e.metaKey||e.ctrlKey?e.shiftKey?'split':'new-tab':'current'});}}}
      onPointerCancel={()=>{if(drag.current?.node)pin(drag.current.node.id);drag.current=null;}}
      onContextMenu={e=>{e.preventDefault();const node=hit(locate(e));if(node)setMenu({node,x:Math.min(e.clientX,window.innerWidth-220),y:Math.min(e.clientY,window.innerHeight-200)});}}
      onPointerLeave={()=>{if(!drag.current)setHovered(null);}}>
      <canvas key={forceCanvas?'canvas':'gpu'} ref={canvas} aria-hidden="true"/><canvas ref={labelCanvas} className="cw-graph-labels" aria-hidden="true"/>
      {!graph.nodes.length&&!loading?<span className="cw-graph-empty">此范围还没有关系</span>:null}
      {hovered?<span className="cw-graph-hover">{graph.nodes.find(n=>n.id===hovered)?.title}<button type="button" onClick={()=>setPreview(graph.nodes.find(n=>n.id===hovered)??null)}>预览</button></span>:null}
    </div>
    <footer className="cw-graph-footer"><button type="button" onClick={fit}>适配</button><button type="button" onClick={()=>void snapshot()}>复制截图</button><small>{loading?'正在更新…':engine}</small></footer>
    {error?<div className="cw-graph-error" role="alert">{error}<button type="button" onClick={()=>setTick(t=>t+1)}>重试</button></div>:null}
    {settingsOpen?<div className="cw-graph-settings" role="dialog" aria-label="图谱设置"><header><strong>图谱设置</strong><IconButton icon="close" label="关闭图谱设置" onClick={()=>setSettingsOpen(false)}/></header>
      {settings.view==='advanced'?<><label>范围<select aria-label="高级网络范围" value={settings.advancedScope} onChange={e=>update('advancedScope',e.target.value as Settings['advancedScope'])}><option value="focus">当前课程</option><option value="discipline">本学科</option><option value="all">全部资料</option></select></label><label>Depth<input type="number" min="1" max="5" value={settings.depth} onChange={e=>update('depth',Math.max(1,Math.min(5,Number(e.target.value))))}/></label><label>Filters<input value={settings.filter} onChange={e=>update('filter',e.target.value)} placeholder="tag:主题 AND 内容"/></label>{(['showTags','showAttachments','showUnresolved','showOrphans','incoming','outgoing','interconnect','arrows'] as const).map((key,i)=><label key={key}><input type="checkbox" checked={settings[key]} onChange={e=>update(key,e.target.checked)}/>{['标签','附件','待建引用','孤立节点','入链','出链','邻居互连','箭头'][i]}</label>)}<p>待建引用缺少正文，不应用文件内容谓词。</p><strong>Groups（首个匹配组生效）</strong>{settings.groups.map((group,i)=><div className="cw-graph-group" key={i}><input aria-label={`分组 ${i+1} 查询`} value={group.query} onChange={e=>update('groups',settings.groups.map((g,j)=>j===i?{...g,query:e.target.value}:g))}/><input type="color" aria-label={`分组 ${i+1} 颜色`} value={group.color} onChange={e=>update('groups',settings.groups.map((g,j)=>j===i?{...g,color:e.target.value}:g))}/><button type="button" onClick={()=>update('groups',settings.groups.filter((_,j)=>j!==i))}>移除</button></div>)}<button type="button" onClick={()=>update('groups',[...settings.groups,{query:'',color:'#888888'}])}>添加分组</button></>:null}
      <label>标签<select value={settings.labels} onChange={e=>update('labels',e.target.value as Settings['labels'])}><option value="auto">自动</option><option value="all">全部</option><option value="none">隐藏</option></select></label>
      {([['center','向心力',0,1,.01],['repulsion','斥力',0,20,.1],['linkStrength','连线强度',0,1,.01],['linkDistance','连线长度',30,500,1]] as const).map(([key,label,min,max,step])=><label key={key}>{label} <output>{settings.forces[key]}</output><input type="range" min={min} max={max} step={step} value={settings.forces[key]} onChange={e=>update('forces',{...settings.forces,[key]:Number(e.target.value)})}/></label>)}
      <strong>时间推移</strong><small>未知时间：{graph.edges.filter(e=>!e.createdAt).length} 条关系</small><input aria-label="时间推移位置" type="range" disabled={!knownTimes.length} min={0} max={Math.max(0,knownTimes.length-1)} value={timeline===null?knownTimes.length-1:Math.max(0,knownTimes.indexOf(timeline))} onChange={e=>setTimeline(knownTimes[Number(e.target.value)]??null)}/><button type="button" disabled={!knownTimes.length} onClick={()=>{setPlaying(!playing);if(timeline===null)setTimeline(knownTimes[0]);}}>{playing?'暂停':'播放'}</button><button type="button" onClick={()=>{setTimeline(null);setPlaying(false);}}>显示全部</button>{timeline?<time>{new Date(timeline).toLocaleString()}</time>:null}
    </div>:null}
    {menu?<div className="cw-graph-menu" role="menu" style={{position:'fixed',left:menu.x,top:menu.y}}><strong>{menu.node.title}</strong><button role="menuitem" onClick={()=>open(menu.node)}>打开 / 定位归属</button>{graph.edges.some(e=>e.to===menu.node.id&&e.target)?<button role="menuitem" onClick={()=>{setChoices([...new Map(graph.edges.filter(e=>e.to===menu.node.id&&e.target).map(e=>[JSON.stringify(e.target),e.target!])).values()]);setMenu(null);}}>定位引用目标</button>:null}<button role="menuitem" onClick={()=>open(menu.node,{origin:'graph',openIn:'new-tab',preserveGraphContext:whole})}>在新标签打开</button><button role="menuitem" onClick={()=>open(menu.node,{origin:'graph',openIn:'split',preserveGraphContext:whole})}>分屏打开</button><button role="menuitem" onClick={()=>{setPreview(menu.node);setMenu(null);}}>预览</button><button role="menuitem" onClick={()=>void snapshot()}>复制图谱截图</button><button role="menuitem" onClick={()=>setMenu(null)}>关闭</button></div>:null}
    {choices.length?<div role="dialog" aria-label="选择课程章节路径" className="cw-graph-choices"><strong>选择课程 / 章节路径</strong>{choices.map((target,i)=><button type="button" key={i} onClick={()=>{setChoices([]);onNavigate(target,{origin:'graph',preserveGraphContext:whole});}}>{graph.nodes.find(n=>'courseId'in target&&n.id===target.courseId)?.title??target.kind} / {'courseChapterId'in target?graph.nodes.find(n=>n.targets.some(t=>'courseChapterId'in t&&t.courseChapterId===target.courseChapterId))?.title:''}{'disciplineId'in target?` · ${graph.nodes.find(n=>n.id===target.disciplineId)?.title??''}`:''}</button>)}<button type="button" onClick={()=>setChoices([])}>取消</button></div>:null}
    {preview?<div className="cw-graph-preview" role="dialog" aria-label="图谱节点预览" onPointerEnter={()=>{previewHeld.current=true;}} onPointerLeave={()=>{previewHeld.current=false;if(!hovered)setPreview(null);}}><header><strong>{preview.title}</strong><IconButton icon="close" label="关闭预览" onClick={()=>setPreview(null)}/></header>{previewError?<p role="alert">{previewError}</p>:previewResource?<>{previewResource.type.startsWith('image/')?<img src={previewResource.url} alt={preview.title}/>:previewResource.type.startsWith('audio/')?<audio controls src={previewResource.url}/>:previewResource.type.startsWith('video/')?<video controls src={previewResource.url}/>:<p>附件已读取，可下载查看。</p>}<a href={previewResource.url} download={preview.title}>下载附件</a></>:preview.targets.length?<ObjectPreview api={api} target={preview.targets.find(t=>'courseId'in t&&'courseId'in focus&&t.courseId===focus.courseId)??preview.targets[0]} onLink={(raw,occurrence)=>{const target=preview.targets.find(t=>'courseId'in t);if(target&&'courseId'in target)void api.resolveKnowledgeLink({courseId:occurrence?.courseId??target.courseId,entryId:occurrence?.entryId,referenceFrom:occurrence?.referenceFrom},raw).then(result=>{if(result.status==='resolved')onNavigate(result.target as ContentLocation,{origin:'link',preserveGraphContext:true});});}}/>:<p>{preview.kind==='unresolved'?'此引用尚未建立。':'正在读取内容…'}</p>}<button type="button" onClick={()=>{open(preview);setPreview(null);}}>打开内容</button></div>:null}
  </section>;
}
