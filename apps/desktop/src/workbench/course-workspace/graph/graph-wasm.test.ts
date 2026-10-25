import {readFile} from 'node:fs/promises';
import {describe,it,expect} from 'vitest';
import {ForceSimulation,initializeForces,DEFAULT_FORCES} from './graph-simulation';
import {WasmForceSimulation} from './graph-wasm';
describe('independent WebAssembly solver',()=>{
 it('matches JS forces, handles coincident nodes, frees dragged nodes and stops',async()=>{
  const {instance}=await WebAssembly.instantiate(await readFile(new URL('./graph-force.wasm',import.meta.url)));
  const edges=[{from:'a',to:'b'}],nodes=initializeForces([{id:'a'},{id:'b'}],edges);
  nodes.forEach(n=>{n.x=0;n.y=0;});
  const js=new ForceSimulation(structuredClone(nodes),edges),wasm=new WasmForceSimulation(instance,structuredClone(nodes),edges,DEFAULT_FORCES);
  for(let i=0;i<4;i++){js.tick();wasm.tick();for(let j=0;j<2;j++){expect(wasm.nodes[j].x).toBeCloseTo(js.nodes[j].x,6);expect(wasm.nodes[j].y).toBeCloseTo(js.nodes[j].y,6);}}
  for(let i=0;i<16;i++)js.tick();wasm.advance(16,Infinity);
  for(let j=0;j<2;j++){expect(wasm.nodes[j].x).toBeCloseTo(js.nodes[j].x,6);expect(wasm.nodes[j].y).toBeCloseTo(js.nodes[j].y,6);}
  wasm.nodes[0].fx=100;wasm.nodes[0].fy=200;wasm.alphaTarget=.3;wasm.tick();expect(wasm.nodes[0].x).toBe(100);
  wasm.nodes[0].fx=undefined;wasm.nodes[0].fy=undefined;wasm.alphaTarget=0;wasm.tick();expect(wasm.nodes[0].x).not.toBe(100);
  for(let i=0;i<400;i++)wasm.tick();expect(wasm.tick()).toBe(false);expect(wasm.nodes.every(n=>Number.isFinite(n.x)&&Number.isFinite(n.y))).toBe(true);
 });
});

it('preserves collision pair order with reused buckets across multiple ticks',async()=>{
 const {instance}=await WebAssembly.instantiate(await readFile(new URL('./graph-force.wasm',import.meta.url)));
 const edges=Array.from({length:15},(_,i)=>({from:String(i),to:String(i+1)})),nodes=initializeForces(Array.from({length:16},(_,i)=>({id:String(i)})),edges);
 nodes.forEach((n,i)=>{n.x=(i%4)*40-60;n.y=Math.floor(i/4)*40-60;});
 const js=new ForceSimulation(structuredClone(nodes),edges),wasm=new WasmForceSimulation(instance,structuredClone(nodes),edges,DEFAULT_FORCES);
 for(let tick=0;tick<10;tick++){js.tick();wasm.tick();for(let i=0;i<nodes.length;i++){expect(wasm.nodes[i].x).toBeCloseTo(js.nodes[i].x,6);expect(wasm.nodes[i].y).toBeCloseTo(js.nodes[i].y,6);}}
});
