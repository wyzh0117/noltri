import type { WorkspaceGraph } from '@noltri/schema';
export interface GraphCamera {x:number;y:number;scale:number}
export interface GraphPaintOptions {theme:'light'|'dark';selected:string|null;hovered:string|null;labels:'auto'|'all'|'none';arrows:boolean}
const rgb=(hex:string):number[]=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255);
export class GraphRenderer {
  readonly engine: 'webgl'|'canvas';
  private gl:WebGLRenderingContext|null;
  private context:CanvasRenderingContext2D|null;
  private program?:WebGLProgram;
  private buffer?:WebGLBuffer;
  private overlay:CanvasRenderingContext2D;
  constructor(private canvas:HTMLCanvasElement, private labels:HTMLCanvasElement, forceCanvas=false) {
    this.gl=forceCanvas?null:canvas.getContext('webgl',{antialias:true,alpha:true,preserveDrawingBuffer:true});
    this.engine=this.gl?'webgl':'canvas';this.context=this.gl?null:canvas.getContext('2d');
    this.overlay=labels.getContext('2d')!;
    const gl=this.gl;
    if(gl){
      const shader=(type:number,source:string):WebGLShader=>{const s=gl.createShader(type)!;gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s)??'Graph shader');return s;};
      const p=gl.createProgram()!;
      gl.attachShader(p,shader(gl.VERTEX_SHADER,'attribute vec2 a_position;attribute vec3 a_color;attribute float a_size;uniform vec2 u_view;uniform vec3 u_camera;uniform float u_dpr;varying vec3 v_color;void main(){vec2 screen=a_position*u_camera.z+u_camera.xy+u_view/2.0;gl_Position=vec4(screen/u_view*vec2(2.,-2.)+vec2(-1.,1.),0.,1.);gl_PointSize=a_size*u_dpr;v_color=a_color;}'));
      gl.attachShader(p,shader(gl.FRAGMENT_SHADER,'precision mediump float;varying vec3 v_color;uniform bool u_points;void main(){if(u_points&&distance(gl_PointCoord,vec2(.5))>.5)discard;gl_FragColor=vec4(v_color,1.);}'));
      gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error('Graph shader link');this.program=p;this.buffer=gl.createBuffer()!;
    }
  }
  resize(width:number,height:number):void {const dpr=Math.min(3,window.devicePixelRatio||1);for(const c of [this.canvas,this.labels]){c.width=Math.max(1,Math.round(width*dpr));c.height=Math.max(1,Math.round(height*dpr));c.style.width=`${width}px`;c.style.height=`${height}px`;}}
  draw(graph:WorkspaceGraph,positions:Float32Array,camera:GraphCamera,options:GraphPaintOptions):void {
    const dpr=Math.min(3,window.devicePixelRatio||1), width=this.canvas.width/dpr,height=this.canvas.height/dpr;
    const overlay=this.overlay;overlay.setTransform(dpr,0,0,dpr,0,0);overlay.clearRect(0,0,width,height);
    const byId=new Map(graph.nodes.map((n,i)=>[n.id,i])),accent=options.theme==='dark'?'#FF4545':'#2656D9',normal=options.theme==='dark'?'#b3b4ba':'#777b86',edgeColor=options.theme==='dark'?'#44464e':'#d1d3da';
    const adjacent=new Set<string>();if(options.hovered){adjacent.add(options.hovered);for(const e of graph.edges){if(e.from===options.hovered)adjacent.add(e.to);if(e.to===options.hovered)adjacent.add(e.from);}}
    const project=(i:number)=>({x:positions[i*2]*camera.scale+camera.x+width/2,y:positions[i*2+1]*camera.scale+camera.y+height/2});
    const size=(i:number)=>Math.max(3,Math.min(18,Math.min(30,Math.max(8,3*Math.sqrt(graph.nodes[i].weight+1)))*Math.sqrt(camera.scale)));
    const color=(i:number)=>graph.nodes[i].linked?accent:graph.nodes[i].color??normal;
    const lines:number[]=[],points:number[]=[],pairs=new Set<string>();
    for(const e of graph.edges){const a=byId.get(e.from),b=byId.get(e.to);if(a===undefined||b===undefined)continue;const key=[e.from,e.to].sort().join('\0');if(pairs.has(key))continue;pairs.add(key);const c=rgb(e.kind==='link'||e.kind==='embed'?accent:edgeColor);for(const i of [a,b])lines.push(positions[i*2],positions[i*2+1],...c,1);}
    for(let i=0;i<graph.nodes.length;i++){const p=project(i);if(p.x<-40||p.y<-40||p.x>width+40||p.y>height+40)continue;points.push(positions[i*2],positions[i*2+1],...rgb(color(i)),size(i)*2);}
    if(this.gl&&this.program&&this.buffer){
      const gl=this.gl,p=this.program;gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.useProgram(p);gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
      for(const [name,count,offset] of [['a_position',2,0],['a_color',3,8],['a_size',1,20]] as const){const a=gl.getAttribLocation(p,name);gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,count,gl.FLOAT,false,24,offset);}
      gl.uniform2f(gl.getUniformLocation(p,'u_view'),width,height);gl.uniform3f(gl.getUniformLocation(p,'u_camera'),camera.x,camera.y,camera.scale);gl.uniform1f(gl.getUniformLocation(p,'u_dpr'),dpr);
      gl.uniform1i(gl.getUniformLocation(p,'u_points'),0);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(lines),gl.DYNAMIC_DRAW);gl.drawArrays(gl.LINES,0,lines.length/6);
      gl.uniform1i(gl.getUniformLocation(p,'u_points'),1);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(points),gl.DYNAMIC_DRAW);gl.drawArrays(gl.POINTS,0,points.length/6);
    }else if(this.context){
      const ctx=this.context;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,width,height);ctx.lineWidth=1;
      for(const e of graph.edges){const a=byId.get(e.from),b=byId.get(e.to);if(a===undefined||b===undefined)continue;const p=project(a),q=project(b);ctx.strokeStyle=e.kind==='link'||e.kind==='embed'?accent:edgeColor;ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(q.x,q.y);ctx.stroke();}
      for(let i=0;i<graph.nodes.length;i++){const p=project(i);if(p.x<-40||p.y<-40||p.x>width+40||p.y>height+40)continue;ctx.fillStyle=color(i);ctx.beginPath();ctx.arc(p.x,p.y,size(i),0,Math.PI*2);ctx.fill();}
    }
    if(options.arrows)for(const e of graph.edges){const a=byId.get(e.from),b=byId.get(e.to);if(a===undefined||b===undefined)continue;const p=project(a),q=project(b),angle=Math.atan2(q.y-p.y,q.x-p.x),r=size(b)+3,x=q.x-Math.cos(angle)*r,y=q.y-Math.sin(angle)*r;overlay.fillStyle=e.kind==='link'?accent:normal;overlay.beginPath();overlay.moveTo(x,y);overlay.lineTo(x-Math.cos(angle-.45)*6,y-Math.sin(angle-.45)*6);overlay.lineTo(x-Math.cos(angle+.45)*6,y-Math.sin(angle+.45)*6);overlay.fill();}
    const occupied=new Set<string>();overlay.font='12px system-ui';overlay.textBaseline='middle';
    for(let i=0;i<graph.nodes.length;i++){
      const n=graph.nodes[i],p=project(i),active=n.id===options.selected||n.id===options.hovered;
      if(active){overlay.strokeStyle=color(i);overlay.lineWidth=1.5;overlay.beginPath();overlay.arc(p.x,p.y,size(i)+4,0,Math.PI*2);overlay.stroke();}
      if(p.x<0||p.y<0||p.x>width||p.y>height)continue;
      const key=`${Math.floor(p.x/100)}:${Math.floor(p.y/20)}`;
      if(!active&&(options.labels==='none'||(options.labels==='auto'&&(occupied.has(key)||(graph.nodes.length>1000&&camera.scale<.4&&n.weight<3)))))continue;
      occupied.add(key);overlay.globalAlpha=adjacent.size>0&&!adjacent.has(n.id)?.4:1;overlay.fillStyle=n.linked?accent:options.theme==='dark'?'#dedee5':'#383b45';
      const title=n.title.length>35?n.title.slice(0,34)+'…':n.title;overlay.fillText(title,p.x+size(i)+6,p.y);
      if(n.kind==='unresolved'){overlay.setLineDash([2,3]);overlay.strokeStyle=accent;overlay.beginPath();overlay.moveTo(p.x+size(i)+6,p.y+8);overlay.lineTo(p.x+size(i)+6+overlay.measureText(title).width,p.y+8);overlay.stroke();overlay.setLineDash([]);}
      overlay.globalAlpha=1;
    }
  }
  async snapshot():Promise<Blob>{const out=document.createElement('canvas');out.width=this.canvas.width;out.height=this.canvas.height;const ctx=out.getContext('2d')!;ctx.fillStyle=getComputedStyle(this.canvas).backgroundColor==='rgba(0, 0, 0, 0)'?getComputedStyle(document.body).backgroundColor:getComputedStyle(this.canvas).backgroundColor;ctx.fillRect(0,0,out.width,out.height);ctx.drawImage(this.canvas,0,0);ctx.drawImage(this.labels,0,0);return new Promise((resolve,reject)=>out.toBlob(b=>b?resolve(b):reject(new Error('无法生成截图')),'image/png'));}
  dispose():void{if(this.gl){if(this.buffer)this.gl.deleteBuffer(this.buffer);if(this.program)this.gl.deleteProgram(this.program);}}
}
