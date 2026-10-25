use std::collections::HashMap;
use std::cell::RefCell;
use std::hash::{Hasher,BuildHasherDefault};
#[derive(Default)] struct GridHash(u64);
impl Hasher for GridHash {fn finish(&self)->u64{self.0}fn write(&mut self,bytes:&[u8]){for &b in bytes{self.0=(self.0.rotate_left(5)^(b as u64)).wrapping_mul(0x517cc1b727220a95);}}fn write_i32(&mut self,value:i32){self.0=(self.0.rotate_left(5)^(value as u32 as u64)).wrapping_mul(0x517cc1b727220a95);}}
// Independent implementation; no external physics code or binary is embedded.
#[derive(Clone, Copy)]
struct Cell { x:f64,y:f64,size:f64,mass:f64,cx:f64,cy:f64,children:[usize;4],point:usize }
impl Cell {fn new(x:f64,y:f64,size:f64)->Self{Self{x,y,size,mass:0.,cx:0.,cy:0.,children:[usize::MAX;4],point:usize::MAX}}}
struct Simulation {nodes:Vec<[f64;8]>,edges:Vec<[u32;2]>,degree:Vec<f64>,cells:Vec<Cell>,next:Vec<usize>,alpha:f64}
thread_local!{static SIM:RefCell<Simulation>=RefCell::new(Simulation{nodes:vec![],edges:vec![],degree:vec![],cells:vec![],next:vec![],alpha:1.});}
#[no_mangle] pub extern "C" fn initialize(n:usize,m:usize){SIM.with(|s|{let mut s=s.borrow_mut();s.nodes=vec![[0.;8];n];s.edges=vec![[0;2];m];s.degree=vec![0.;n];s.next=vec![usize::MAX;n];s.alpha=1.;});}
#[no_mangle] pub extern "C" fn nodes_ptr()->*const f64{SIM.with(|s|s.borrow().nodes.as_ptr() as *const f64)}
#[no_mangle] pub extern "C" fn edges_ptr()->*const u32{SIM.with(|s|s.borrow().edges.as_ptr() as *const u32)}
#[no_mangle] pub extern "C" fn set_alpha(alpha:f64){SIM.with(|s|s.borrow_mut().alpha=alpha);}
#[no_mangle] pub extern "C" fn get_alpha()->f64{SIM.with(|s|s.borrow().alpha)}
#[no_mangle] pub extern "C" fn prepare(){SIM.with(|s|{let mut s=s.borrow_mut();s.degree.fill(0.);for i in 0..s.edges.len(){let [a,b]=s.edges[i];if (a as usize)<s.degree.len()&&(b as usize)<s.degree.len(){s.degree[a as usize]+=1.;s.degree[b as usize]+=1.;}}});}
fn insert(cells:&mut Vec<Cell>,next:&mut [usize],nodes:&[[f64;8]],ci:usize,ni:usize,depth:usize){
 let x=nodes[ni][0];let y=nodes[ni][1];let c=cells[ci];
 cells[ci].cx=(c.cx*c.mass+x)/(c.mass+1.);cells[ci].cy=(c.cy*c.mass+y)/(c.mass+1.);cells[ci].mass+=1.;
 if c.children[0]==usize::MAX && (c.point==usize::MAX||depth>=24){next[ni]=c.point;cells[ci].point=ni;return;}
 if c.children[0]==usize::MAX {let h=c.size/2.;let first=cells.len();for i in 0..4{cells.push(Cell::new(c.x+(i%2) as f64*h,c.y+(i/2) as f64*h,h));}cells[ci].children=[first,first+1,first+2,first+3];cells[ci].point=usize::MAX;
  let old=c.point;let quadrant=(if nodes[old][0]>=c.x+h{1}else{0})+(if nodes[old][1]>=c.y+h{2}else{0});insert(cells,next,nodes,first+quadrant,old,depth+1);
 }
 let h=c.size/2.;let quadrant=(if x>=c.x+h{1}else{0})+(if y>=c.y+h{2}else{0});let child=cells[ci].children[quadrant];insert(cells,next,nodes,child,ni,depth+1);
}
fn push(node:&mut [f64;8],x:f64,y:f64,mass:f64,charge:f64,index:usize){let mut dx=node[0]-x;let mut dy=node[1]-y;if dx==0.&&dy==0.{let a=index as f64*2.399963;dx=a.cos()*0.01;dy=a.sin()*0.01;}let d2=(dx*dx+dy*dy).max(900.);node[2]+=dx*charge*mass/d2;node[3]+=dy*charge*mass/d2;}
#[no_mangle] pub extern "C" fn tick(center:f64,repulsion:f64,strength:f64,distance:f64,target:f64)->i32{SIM.with(|s|{
 let mut s=s.borrow_mut();let s=&mut *s;let n=s.nodes.len();if n==0{return 0;}
 s.alpha+=(target-s.alpha)*(1.-0.001f64.powf(1./300.));let alpha=s.alpha;
 let(mut minx,mut miny,mut maxx,mut maxy)=(f64::INFINITY,f64::INFINITY,f64::NEG_INFINITY,f64::NEG_INFINITY);
 for node in &s.nodes{minx=minx.min(node[0]);maxx=maxx.max(node[0]);miny=miny.min(node[1]);maxy=maxy.max(node[1]);}
 s.cells.clear();s.next.fill(usize::MAX);s.cells.push(Cell::new(minx,miny,(maxx-minx).max(maxy-miny).max(1.)+1.));
 for i in 0..n{insert(&mut s.cells,&mut s.next,&s.nodes,0,i,0);}
 let charge=repulsion.powi(3)*alpha;let mut stack=Vec::with_capacity(128);
 for i in 0..n{stack.clear();stack.push(0);while let Some(ci)=stack.pop(){let c=s.cells[ci];if c.mass==0.{continue;}let x=s.nodes[i][0];let y=s.nodes[i][1];let contains=x>=c.x&&x<=c.x+c.size&&y>=c.y&&y<=c.y+c.size;let d2=(x-c.cx).powi(2)+(y-c.cy).powi(2);
  if !contains&&c.size*c.size<0.81*d2{push(&mut s.nodes[i],c.cx,c.cy,c.mass,charge,i);continue;}
  if c.children[0]!=usize::MAX{for child in c.children{stack.push(child);}}else{let mut other=c.point;while other!=usize::MAX{if other!=i{let p=s.nodes[other];push(&mut s.nodes[i],p[0],p[1],1.,charge,i);}other=s.next[other];}}
 }
 s.nodes[i][2]-=s.nodes[i][0]*center*alpha*0.01;s.nodes[i][3]-=s.nodes[i][1]*center*alpha*0.01;
 }
 for edge in &s.edges{let a=edge[0]as usize;let b=edge[1]as usize;if a>=n||b>=n||a==b{continue;}let mut dx=s.nodes[b][0]+s.nodes[b][2]-s.nodes[a][0]-s.nodes[a][2];let mut dy=s.nodes[b][1]+s.nodes[b][3]-s.nodes[a][1]-s.nodes[a][3];if dx==0.&&dy==0.{dx=0.01;}let d=(dx*dx+dy*dy).sqrt();let f=(d-distance)/d*alpha*strength/s.degree[a].max(s.degree[b]).max(1.)*0.5;dx*=f;dy*=f;s.nodes[a][2]+=dx;s.nodes[a][3]+=dy;s.nodes[b][2]-=dx;s.nodes[b][3]-=dy;}
 let mut grid:HashMap<(i32,i32),Vec<usize>,BuildHasherDefault<GridHash>>=HashMap::with_capacity_and_hasher(n,Default::default());
 for(i,p)in s.nodes.iter().enumerate(){grid.entry(((p[0]/120.).floor()as i32,(p[1]/120.).floor()as i32)).or_default().push(i);}
 for i in 0..n{let gx=(s.nodes[i][0]/120.).floor()as i32;let gy=(s.nodes[i][1]/120.).floor()as i32;for x in gx-1..=gx+1{for y in gy-1..=gy+1{if let Some(bucket)=grid.get(&(x,y)){for &j in bucket{if i>=j{continue;}let mut dx=s.nodes[j][0]-s.nodes[i][0];let mut dy=s.nodes[j][1]-s.nodes[i][1];if dx==0.&&dy==0.{dx=0.01;dy=0.007;}let d=(dx*dx+dy*dy).sqrt();let radius=60.+(s.nodes[i][4]+s.nodes[j][4])*0.5;if d>=radius{continue;}let f=(radius-d)/d*0.25;s.nodes[i][2]-=dx*f;s.nodes[i][3]-=dy*f;s.nodes[j][2]+=dx*f;s.nodes[j][3]+=dy*f;}}}}}
 for node in &mut s.nodes{if node[5].is_finite(){node[0]=node[5];node[2]=0.;}else{node[2]*=0.6;node[0]+=node[2];}if node[6].is_finite(){node[1]=node[6];node[3]=0.;}else{node[3]*=0.6;node[1]+=node[3];}}
 if s.alpha>0.001||target>0.{1}else{0}
})}
