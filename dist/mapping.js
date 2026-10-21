// Top-left UV origin. Each anchor owns symmetric horizontal/vertical Bezier
// handles. Preview, picking and export share the same tessellated bicubic map.
const cache=new WeakMap(),mapCache=new WeakMap(),inverseCache=new WeakMap();
export function controlGrid(g){
  const {base,reference,layoutOnly,...control}=g;return structuredClone(control);
}
const copyGrid=g=>({...controlGrid(g),...(g.base?{base:g.base,reference:g.reference,layoutOnly:!!g.layoutOnly}:{})});
const clearCache=g=>{cache.delete(g);mapCache.delete(g);inverseCache.delete(g);};
export function makeGrid(nx=8,ny=4){
  const g={nx,ny,kind:'bezier',subdivisions:8,
    nodes:Array.from({length:(nx+1)*(ny+1)},(_,i)=>[i%(nx+1)/nx,Math.floor(i/(nx+1))/ny]),
    handles:[],manual:Array((nx+1)*(ny+1)).fill(false)};
  return autoHandles(g);
}
export function triangles(g){
  const out=[];
  for(let j=0;j<g.ny;j++)for(let i=0;i<g.nx;i++){
    const a=j*(g.nx+1)+i,b=a+1,c=a+g.nx+1,d=c+1;out.push([a,b,d],[a,d,c]);
  }return out;
}
export function sourceNode(g,i){return [i%(g.nx+1)/g.nx,Math.floor(i/(g.nx+1))/g.ny];}
export function mirrorNode(g,id){return Math.floor(id/(g.nx+1))*(g.nx+1)+g.nx-id%(g.nx+1);}
export function cross(a,b,c){return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);}
export function autoHandles(g){
  g.kind='bezier';g.subdivisions=8;g.handles??=[];g.manual??=Array(g.nodes.length).fill(false);
  g.nodes.forEach((p,id)=>{
    if(g.manual[id]&&g.handles[id])return;
    const x=id%(g.nx+1),y=Math.floor(id/(g.nx+1));
    const a=g.nodes[id-(x?1:0)],b=g.nodes[id+(x<g.nx?1:0)];
    const c=g.nodes[id-(y?g.nx+1:0)],d=g.nodes[id+(y<g.ny?g.nx+1:0)];
    g.handles[id]=[
      [0,1].map(k=>(b[k]-a[k])/(x&&x<g.nx?6:3)),
      [0,1].map(k=>(d[k]-c[k])/(y&&y<g.ny?6:3))
    ];
  });clearCache(g);return g;
}
function linear(g,u,v){
  const i=Math.min(g.nx-1,Math.max(0,Math.floor(u*g.nx))),j=Math.min(g.ny-1,Math.max(0,Math.floor(v*g.ny)));
  const x=u*g.nx-i,y=v*g.ny-j,a=j*(g.nx+1)+i,b=a+1,c=a+g.nx+1,d=c+1;
  const ids=x>=y?[a,b,d]:[a,d,c],w=x>=y?[1-x,x-y,y]:[1-y,x,y-x];
  return [0,1].map(k=>ids.reduce((s,id,n)=>s+g.nodes[id][k]*w[n],0));
}
const bernstein=t=>[(1-t)**3,3*t*(1-t)**2,3*t*t*(1-t),t**3];
export function curvePoint(g,u,v){
  if(!g.handles)return linear(g,u,v);
  const x=Math.min(g.nx-1,Math.max(0,Math.floor(u*g.nx))),y=Math.min(g.ny-1,Math.max(0,Math.floor(v*g.ny)));
  const bx=bernstein(u*g.nx-x),by=bernstein(v*g.ny-y),result=[0,0];
  for(let j=0;j<4;j++)for(let i=0;i<4;i++){
    const id=(y+(j>=2?1:0))*(g.nx+1)+x+(i>=2?1:0),p=g.nodes[id],h=g.handles[id];
    const sx=i===1?1:i===2?-1:0,sy=j===1?1:j===2?-1:0,w=bx[i]*by[j];
    result[0]+=(p[0]+sx*h[0][0]+sy*h[1][0])*w;
    result[1]+=(p[1]+sx*h[0][1]+sy*h[1][1])*w;
  }return result;
}
export function controlDense(g){
  if(!g.handles)return g;
  if(cache.has(g))return cache.get(g);
  const nx=g.nx*8,ny=g.ny*8,d={nx,ny,nodes:[]};
  for(let j=0;j<=ny;j++)for(let i=0;i<=nx;i++)d.nodes.push(curvePoint(g,i/nx,j/ny));
  cache.set(g,d);return d;
}
function sameControl(a,b){return a.nx===b.nx&&a.ny===b.ny&&JSON.stringify([a.nodes,a.handles])===JSON.stringify([b.nodes,b.handles]);}
export function denseGrid(g){
  if(!g.base)return controlDense(g);
  if(g.layoutOnly||sameControl(g,g.reference))return g.base;
  if(mapCache.has(g))return mapCache.get(g);
  const ref=controlDense(g.reference),dest=controlDense(g);
  const d={nx:g.base.nx,ny:g.base.ny,nodes:g.base.nodes.map(p=>{
    const uv=inverseDense(ref,...p);
    return uv?linear(dest,...uv):[...p];
  })};mapCache.set(g,d);return d;
}
// Reposition the editing cage independently of the frozen image mapping.
// No image is rasterized or resampled when switching or placing controls.
export function setLayoutOnly(g,enabled){
  if(!!g.layoutOnly===enabled)return g;
  const next=controlGrid(g),base=denseGrid(g);
  next.base={nx:base.nx,ny:base.ny,nodes:base.nodes.map(p=>[...p])};
  next.layoutOnly=enabled;next.reference=enabled?null:controlGrid(g);
  next.snapOrigins=g.nodes.map(p=>[...p]);
  return next;
}
function validControl(g,maxX=32,maxY=24){
  if(!g||!Number.isInteger(g.nx)||!Number.isInteger(g.ny)||g.nx<1||g.nx>maxX||g.ny<1||g.ny>maxY||!Array.isArray(g.nodes))return false;
  if(g.nodes.length!==(g.nx+1)*(g.ny+1)||!g.nodes.every(p=>p.length===2&&p.every(n=>Number.isFinite(n)&&Math.abs(n)<=8)))return false;
  if(g.handles&&(g.handles.length!==g.nodes.length||!g.handles.every(h=>h.length===2&&h.every(v=>v.length===2&&v.every(n=>Number.isFinite(n)&&Math.abs(n)<=4)))))return false;
  const d=controlDense(g),threshold=.015/(d.nx*d.ny);
  return triangles(d).every(t=>cross(...t.map(i=>d.nodes[i]))>threshold);
}
export function validGrid(g){
  if(!validControl(g))return false;
  if(g.seam&&(!Number.isInteger(g.seam.row)||g.seam.row<1||g.seam.row>=g.ny))return false;
  if(g.snapOrigins&&(!Array.isArray(g.snapOrigins)||g.snapOrigins.length!==g.nodes.length||!g.snapOrigins.every(p=>p.length===2&&p.every(Number.isFinite))))return false;
  if(!g.base)return !g.reference&&!g.layoutOnly;
  if(g.base.handles||!validControl(g.base,256,192))return false;
  if(!g.layoutOnly&&(!validControl(g.reference)||g.reference.nx!==g.nx||g.reference.ny!==g.ny))return false;
  return validControl(denseGrid(g),256,192);
}
export function forward(g,u,v){return linear(denseGrid(g),u,v);}
function inverseDense(d,u,v){
  let lookup=inverseCache.get(d);
  if(!lookup){
    const xs=d.nodes.map(p=>p[0]),ys=d.nodes.map(p=>p[1]),low=[Math.min(...xs)-1e-6,Math.min(...ys)-1e-6];
    const span=[Math.max(...xs)+1e-6-low[0],Math.max(...ys)+1e-6-low[1]],n=32,bins=Array.from({length:n*n},()=>[]);
    const cell=(x,k)=>Math.max(0,Math.min(n-1,Math.floor((x-low[k])/span[k]*n)));
    for(const ids of triangles(d)){
      const ps=ids.map(id=>d.nodes[id]),lo=[0,1].map(k=>cell(Math.min(...ps.map(p=>p[k]))-1e-6,k)),hi=[0,1].map(k=>cell(Math.max(...ps.map(p=>p[k]))+1e-6,k));
      for(let y=lo[1];y<=hi[1];y++)for(let x=lo[0];x<=hi[0];x++)bins[y*n+x].push(ids);
    }
    lookup={bins,cell,n};inverseCache.set(d,lookup);
  }
  const p=[u,v];
  for(const ids of lookup.bins[lookup.cell(v,1)*lookup.n+lookup.cell(u,0)]){
    const [a,b,c]=ids.map(i=>d.nodes[i]),det=cross(a,b,c);
    if(u<Math.min(a[0],b[0],c[0])-1e-6||u>Math.max(a[0],b[0],c[0])+1e-6||
       v<Math.min(a[1],b[1],c[1])-1e-6||v>Math.max(a[1],b[1],c[1])+1e-6)continue;
    const wa=cross(p,b,c)/det,wb=cross(a,p,c)/det,wc=1-wa-wb;
    if(Math.min(wa,wb,wc)>=-1e-6)return [0,1].map(k=>wa*sourceNode(d,ids[0])[k]+wb*sourceNode(d,ids[1])[k]+wc*sourceNode(d,ids[2])[k]);
  }return null;
}
export function inverse(g,u,v){return inverseDense(denseGrid(g),u,v);}
export function controlInverse(g,u,v){return inverseDense(controlDense(g),u,v);}
export function controlSource(g,id){return inverse(g,...g.nodes[id])||sourceNode(g,id);}
export function resampleGrid(g,nx,ny){
  const next=makeGrid(nx,ny),epsilon=1e-5;
  next.nodes=next.nodes.map((_,id)=>{
    const [u,v]=sourceNode(next,id),a=Math.max(0,u-epsilon),b=Math.min(1,u+epsilon),c=Math.max(0,v-epsilon),d=Math.min(1,v+epsilon);
    const pa=curvePoint(g,a,v),pb=curvePoint(g,b,v),pc=curvePoint(g,u,c),pd=curvePoint(g,u,d);
    next.handles[id]=[[0,1].map(k=>(pb[k]-pa[k])/(b-a)/nx/3),[0,1].map(k=>(pd[k]-pc[k])/(d-c)/ny/3)];
    next.manual[id]=true;return curvePoint(g,u,v);
  });
  if(g.base){
    next.base=denseGrid(g);next.layoutOnly=!!g.layoutOnly;
    next.reference=g.layoutOnly?null:controlGrid(next);
    next.snapOrigins=next.nodes.map(p=>[...p]);
  }
  return validGrid(next)?next:null;
}
export function pinned(g,id,{protect=0,boundary=false,region='both'}={}){
  const x=id%(g.nx+1),y=Math.floor(id/(g.nx+1));
  if(g.seam&&(region==='roof'?y>=g.seam.row:region==='wrap'?y<=g.seam.row:false))return true;
  return (boundary&&(x===0||x===g.nx||y===0||y===g.ny))||(protect>0&&Math.abs(x/g.nx-.5)<=protect/2+1/g.nx);
}
function finishEdit(old,next,options){
  autoHandles(next);
  next.nodes.forEach((_,id)=>{
    if(pinned(old,id,options)){next.nodes[id]=[...old.nodes[id]];if(old.handles)next.handles[id]=structuredClone(old.handles[id]);}
  });
  clearCache(next);return validGrid(next)?next:null;
}
export function movePoint(g,id,delta,options={}){
  if(g.layoutOnly)options={...options,boundary:true};
  if(pinned(g,id,options))return null;
  const next=copyGrid(g),other=options.symmetry?mirrorNode(g,id):id;
  if(options.symmetry&&pinned(g,other,options))return null;
  const change=options.symmetry&&other===id?[0,delta[1]]:delta;
  next.nodes[id]=next.nodes[id].map((n,k)=>n+change[k]);
  if(options.symmetry&&other!==id){
    next.nodes[other][0]-=delta[0];next.nodes[other][1]+=delta[1];
  }
  return finishEdit(g,next,options);
}
export function moveHandle(g,id,axis,vector,options={}){
  if(g.layoutOnly)options={...options,boundary:true};
  if(pinned(g,id,options))return null;
  const next=copyGrid(g);if(!next.handles)autoHandles(next);
  const other=options.symmetry?mirrorNode(g,id):id;
  if(options.symmetry&&pinned(g,other,options))return null;
  const previous=next.handles[id][axis],delta=vector.map((v,k)=>v-previous[k]);
  // Horizontal tangents change orientation when columns are mirrored; vertical
  // tangents do not. Apply mirrored increments to preserve pre-existing edits.
  if(options.symmetry&&other===id)delta[axis===0?1:0]=0;
  next.handles[id][axis]=previous.map((v,k)=>v+delta[k]);next.manual[id]=true;
  if(options.symmetry&&other!==id){
    next.handles[other][axis]=next.handles[other][axis].map((v,k)=>v+delta[k]*(k===axis?1:-1));
    next.manual[other]=true;
  }
  return validGrid(next)?next:null;
}
export function moveLine(g,kind,index,delta,options={}){
  if(g.layoutOnly)options={...options,boundary:true};
  const {radius=1.5}=options,next=copyGrid(g);
  const change=Array.isArray(delta)?delta:(kind==='row'?[0,delta]:[delta,0]);
  next.nodes.forEach((p,id)=>{
    if(pinned(g,id,options))return;
    const col=id%(g.nx+1),row=Math.floor(id/(g.nx+1)),distance=Math.abs((kind==='row'?row:col)-index);
    if(distance>=radius)return;
    const w=(1+Math.cos(Math.PI*distance/radius))/2;
    p[0]+=change[0]*w;p[1]+=change[1]*w;
  });return finishEdit(g,next,options);
}
export function projection(p,eye,s,aspect){
  const [x,y,z]=p.map((v,i)=>v-eye[i]),h=s.fov*Math.PI/180;
  return [.5+Math.atan2(-x,-y)/(h*s.scaleX)+s.offsetX,
    s.horizon+s.offsetY-Math.atan2(z,Math.hypot(x,y))/(h/aspect*s.scaleY)];
}
export function projectionDirection(uv,s,aspect){
  const h=s.fov*Math.PI/180,theta=(uv[0]-.5-s.offsetX)*h*s.scaleX;
  const phi=(s.horizon+s.offsetY-uv[1])*h/aspect*s.scaleY,c=Math.cos(phi);
  if(Math.abs(phi)>=Math.PI/2)return null;
  return [-Math.sin(theta)*c,-Math.cos(theta)*c,Math.sin(phi)];
}
