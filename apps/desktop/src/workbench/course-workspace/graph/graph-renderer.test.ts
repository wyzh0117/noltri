import {it,expect,vi} from 'vitest';
import type {WorkspaceGraph} from '@noltri/schema';
import {GraphRenderer} from './graph-renderer';
it('reuses typed GPU buffers and refreshes coordinates, theme colors, and changed graph topology',()=>{
 vi.stubGlobal('window',{devicePixelRatio:1});
 const uploads:{buffer:Float32Array;values:number[]}[]=[],draws:number[]=[];
 const gl=new Proxy({getShaderParameter:()=>true,getProgramParameter:()=>true,getAttribLocation:()=>0,bufferData:(_target:unknown,data:Float32Array)=>uploads.push({buffer:data,values:[...data]}),drawArrays:(_mode:unknown,_first:unknown,count:number)=>draws.push(count)},{get:(object,key)=>key in object?object[key as keyof typeof object]:()=>({})});
 const overlay=new Proxy({},{get:()=>()=>({})}),canvas={width:500,height:500,style:{},getContext:()=>gl} as unknown as HTMLCanvasElement,labels={...canvas,getContext:()=>overlay} as unknown as HTMLCanvasElement;
 const graph={layoutKey:'test',revision:1,nodes:[{id:'a',title:'A',kind:'course',weight:1,linked:true},{id:'b',title:'B',kind:'course',weight:1,linked:false}],edges:[{from:'a',to:'b',kind:'link'},{from:'b',to:'a',kind:'link'}]} as WorkspaceGraph;
 const renderer=new GraphRenderer(canvas,labels),options={theme:'light' as const,selected:null,hovered:null,labels:'none' as const,arrows:false},camera={x:0,y:0,scale:1};
 try{renderer.draw(graph,new Float32Array([0,0,20,20]),camera,options);renderer.draw(graph,new Float32Array([5,6,25,26]),camera,options);
  expect(uploads[0].buffer).toBe(uploads[2].buffer);expect(uploads[2].values.slice(0,2)).toEqual([5,6]);expect(draws).toEqual([2,2,2,2]);
  renderer.draw(graph,new Float32Array([5,6,25,26]),camera,{...options,theme:'dark'});expect(uploads[4].values[2]).not.toBe(uploads[2].values[2]);
  renderer.draw({...graph,edges:[]},new Float32Array([5,6,25,26]),camera,options);expect(draws.at(-2)).toBe(0);expect(draws.at(-1)).toBe(2);
 }finally{renderer.dispose();vi.unstubAllGlobals();}
});
