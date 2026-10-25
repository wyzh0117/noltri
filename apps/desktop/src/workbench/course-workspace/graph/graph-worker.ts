import { ForceSimulation, initializeForces, type ForceSettings } from './graph-simulation';
import type { WorkspaceGraph } from '@noltri/schema';
import {WasmForceSimulation} from './graph-wasm';
const wasmReady=fetch(new URL('./graph-force.wasm',import.meta.url)).then(r=>{if(!r.ok)throw new Error('WASM unavailable');return r.arrayBuffer();}).then(bytes=>WebAssembly.instantiate(bytes)).then(result=>result.instance).catch(()=>null);
let latestGraphVersion=0,engine='javascript';
export type GraphWorkerMessage =
  | {type:'graph';version:number;graph:WorkspaceGraph;settings:ForceSettings;positions?:Record<string,{x:number;y:number}>}
  | {type:'pin';id:string;x?:number;y?:number}
  | {type:'settings';settings:ForceSettings}
  | {type:'stop'};
let simulation: Pick<ForceSimulation,'nodes'|'settings'|'alpha'|'alphaTarget'|'tick'> | undefined, version = 0, timer: ReturnType<typeof setTimeout> | undefined;
function run(): void {
  timer = undefined;
  if (!simulation) return;
  const started=performance.now();let active=true,steps=0;
  if(simulation instanceof WasmForceSimulation)active=simulation.advance(16,16);
  else do {active=simulation.tick();steps++;}while(active&&steps<8&&performance.now()-started<8);
  const positions = new Float32Array(simulation.nodes.length * 2);
  simulation.nodes.forEach((n,i) => {positions[i*2]=n.x;positions[i*2+1]=n.y;});
  postMessage({version,positions,alpha:simulation.alpha,active,engine}, {transfer:[positions.buffer]});
  if (active) timer = setTimeout(run, 0);
}
function wake(): void { if (timer === undefined) timer = setTimeout(run,0); }
self.onmessage = async (event: MessageEvent<GraphWorkerMessage>) => {
  const m=event.data;
  if (m.type === 'stop') { latestGraphVersion++; if(timer)clearTimeout(timer);timer=undefined;simulation=undefined;return; }
  if (m.type === 'graph') {
    latestGraphVersion=m.version;const instance=await wasmReady;if(latestGraphVersion!==m.version)return;
    const previous = new Map(simulation?.nodes.map(n=>[n.id,n]) ?? []);
    for(const [id,p] of Object.entries(m.positions??{})) if(!previous.has(id)) previous.set(id,{id,...p,vx:0,vy:0,radius:8});
    const reuse=previous.size>0;
    const nodes=initializeForces(m.graph.nodes,m.graph.edges,previous);
    try{simulation=instance?new WasmForceSimulation(instance,nodes,m.graph.edges,m.settings):new ForceSimulation(nodes,m.graph.edges,m.settings);engine=instance?'wasm':'javascript';}
    catch{simulation=new ForceSimulation(nodes,m.graph.edges,m.settings);engine='javascript';}
    if(reuse)simulation.alpha=0.3;
    version=m.version;
  } else if (m.type==='pin' && simulation) {
    const n=simulation.nodes.find(n=>n.id===m.id);
    if(n){n.fx=m.x;n.fy=m.y;if(m.x!==undefined)n.x=m.x;if(m.y!==undefined)n.y=m.y;}
    simulation.alphaTarget=m.x===undefined?0:0.3;simulation.alpha=Math.max(0.3,simulation.alpha);
  } else if (m.type==='settings' && simulation) {simulation.settings=m.settings;simulation.alpha=0.3;}
  wake();
};
