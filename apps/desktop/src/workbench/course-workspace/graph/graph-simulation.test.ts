import {describe,it,expect} from 'vitest';
import {ForceSimulation,initializeForces,DEFAULT_FORCES} from './graph-simulation';
describe('independent force worker engine',()=>{
  it('keeps exact overlap finite, applies settings and unlocks after drag',()=>{
    const nodes=initializeForces([{id:'a'},{id:'b'}],[{from:'a',to:'b'}]);nodes.forEach(n=>{n.x=0;n.y=0;});
    const sim=new ForceSimulation(nodes,[{from:'a',to:'b'}],DEFAULT_FORCES);nodes[0].fx=40;nodes[0].fy=30;sim.alphaTarget=.3;sim.tick();expect([nodes[0].x,nodes[0].y]).toEqual([40,30]);
    nodes[0].fx=undefined;nodes[0].fy=undefined;sim.alphaTarget=0;sim.tick();expect(nodes.every(n=>Number.isFinite(n.x)&&Number.isFinite(n.y))).toBe(true);expect(nodes[0].x).not.toBe(40);
    for(let i=0;i<400;i++)sim.tick();expect(sim.alpha).toBeLessThan(.001);expect(sim.tick()).toBe(false);
  });
  it('retains coordinates and initializes additions near their neighbor without dropping large graphs',()=>{
    const old=initializeForces([{id:'a'}],[]);old[0].x=900;old[0].y=800;
    const next=initializeForces([{id:'a'},{id:'b'}],[{from:'a',to:'b'}],new Map(old.map(n=>[n.id,n])));expect(next[0].x).toBe(900);expect(Math.hypot(next[1].x-900,next[1].y-800)).toBeCloseTo(40);
    const ids=Array.from({length:1000},(_,i)=>({id:String(i)}));const nodes=initializeForces(ids,[]);const sim=new ForceSimulation(nodes,[]);sim.tick();expect(nodes).toHaveLength(1000);expect(nodes.every(n=>Number.isFinite(n.x))).toBe(true);
  });
});
