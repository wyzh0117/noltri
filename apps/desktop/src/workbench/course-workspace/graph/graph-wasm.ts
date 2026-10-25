import type {ForceNode,ForceEdge,ForceSettings} from './graph-simulation';
interface ForceExports extends WebAssembly.Exports {memory:WebAssembly.Memory;initialize:(n:number,m:number)=>void;nodes_ptr:()=>number;edges_ptr:()=>number;prepare:()=>void;tick:(center:number,repulsion:number,strength:number,distance:number,target:number)=>number;get_alpha:()=>number;set_alpha:(alpha:number)=>void}
export class WasmForceSimulation {
  alphaTarget=0;
  private exports:ForceExports;
  private pointer:number;
  constructor(instance:WebAssembly.Instance,public nodes:ForceNode[],edges:readonly ForceEdge[],public settings:ForceSettings){
    const e=this.exports=instance.exports as ForceExports;e.initialize(nodes.length,edges.length);this.pointer=e.nodes_ptr();
    const data=new Float64Array(e.memory.buffer,this.pointer,nodes.length*8);
    nodes.forEach((n,i)=>data.set([n.x,n.y,n.vx,n.vy,n.radius,Number.NaN,Number.NaN,0],i*8));
    const indices=new Map(nodes.map((n,i)=>[n.id,i])),links=new Uint32Array(e.memory.buffer,e.edges_ptr(),edges.length*2);
    edges.forEach((link,i)=>links.set([indices.get(link.from)??nodes.length,indices.get(link.to)??nodes.length],i*2));e.prepare();
  }
  get alpha():number{return this.exports.get_alpha();}
  set alpha(value:number){this.exports.set_alpha(value);}
  tick():boolean{return this.advance(1,Infinity);}
  advance(maxSteps:number,maxMs:number):boolean{
    let data=new Float64Array(this.exports.memory.buffer,this.pointer,this.nodes.length*8);
    this.nodes.forEach((n,i)=>{data[i*8+5]=n.fx??Number.NaN;data[i*8+6]=n.fy??Number.NaN;});
    const {center,repulsion,linkStrength,linkDistance}=this.settings,started=performance.now();
    let active=1,steps=0;
    do{active=this.exports.tick(center,repulsion,linkStrength,linkDistance,this.alphaTarget);steps++;}while(active===1&&steps<maxSteps&&performance.now()-started<maxMs);
    // The allocator can grow memory while building its quadtree.
    data=new Float64Array(this.exports.memory.buffer,this.pointer,this.nodes.length*8);
    this.nodes.forEach((n,i)=>{n.x=data[i*8];n.y=data[i*8+1];n.vx=data[i*8+2];n.vy=data[i*8+3];});
    return active===1;
  }
}
