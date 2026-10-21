import {seamSegments} from './geometry.js';
import {projection,makeGrid,denseGrid,controlGrid,curvePoint,validGrid} from './mapping.js';

export function projectedSeam(model,params,aspect){
  const segments=seamSegments(model.screens),points=[];
  for(let i=0;i<segments.length;i+=6){
    const a=segments.slice(i,i+3),b=segments.slice(i+3,i+6);
    for(let j=0;j<=4;j++)points.push(projection(a.map((x,k)=>x+(b[k]-x)*j/4),model.eye,params,aspect));
  }
  points.sort((a,b)=>a[0]-b[0]);
  return points.filter((p,i)=>!i||Math.abs(p[0]-points[i-1][0])>1e-8);
}
function sampler(points){
  return x=>{
    if(x<=points[0][0])return points[0][1];
    if(x>=points.at(-1)[0])return points.at(-1)[1];
    let lo=0,hi=points.length-1;
    while(hi-lo>1){const m=(lo+hi)>>1;if(points[m][0]<x)lo=m;else hi=m;}
    const a=points[lo],b=points[hi];return a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0]);
  };
}
export function seamSignature(model,params,aspect){return JSON.stringify([model.capturedAt,model.eye,params,aspect]);}

// Bind a new cage around the current picture; never resample the video pixels.
// Two bands share the seam anchors, while keeping separate editing regions.
export function buildSeamGrid(g,points,{nx=g.nx,ny=g.ny+1,signature=null,fit=true}={}){
  if(points.length<2||!points.every(p=>p.every(Number.isFinite)))throw Error('当前模型没有可用的幕面接缝');
  if(ny<2||ny>24)throw Error('拼接网格需要 2–24 行；请先调整行数');
  const frozen=denseGrid(g),xs=frozen.nodes.map(p=>p[0]),ys=frozen.nodes.map(p=>p[1]);
  const lowX=Math.min(...xs,points[0][0]),highX=Math.max(...xs,points.at(-1)[0]);
  const seamMin=Math.min(...points.map(p=>p[1])),seamMax=Math.max(...points.map(p=>p[1]));
  const lowY=Math.min(...ys,seamMin-.08),highY=Math.max(...ys,seamMax+.08);
  if(Math.max(Math.abs(lowX),Math.abs(highX),Math.abs(lowY),Math.abs(highY))>7.5)throw Error('接缝离画面过远，请先调整整体投射参数');
  const value=sampler(points),span=highX-lowX;
  const row=Math.max(1,Math.min(ny-1,Math.round(ny*(value((lowX+highX)/2)-lowY)/(highY-lowY))));
  function create(cols){
    const next=makeGrid(cols,ny),dx=span/cols;
    // Keep endpoints of a partially covered seam as real anchors when possible.
    const columns=Array.from({length:cols+1},(_,i)=>lowX+i*dx);
    for(const end of [points[0][0],points.at(-1)[0]]){
      const i=Math.round((end-lowX)/dx);
      if(i>0&&i<cols&&end-columns[i-1]>.2*dx&&columns[i+1]-end>.2*dx)columns[i]=end;
    }
    for(let j=0;j<=ny;j++)for(let i=0;i<=cols;i++){
      const x=columns[i],s=value(x),upper=j<=row,t=upper?j/row:(j-row)/(ny-row);
      const y=upper?lowY+(s-lowY)*t:s+(highY-s)*t;
      const hx=Math.min(i?x-columns[i-1]:dx,i<cols?columns[i+1]-x:dx)/3;
      const epsilon=span*1e-4,slope=(value(x+epsilon)-value(x-epsilon))/(2*epsilon);
      const hy=(j===row?Math.min((s-lowY)/row,(highY-s)/(ny-row)):upper?(s-lowY)/row:(highY-s)/(ny-row))/3;
      const id=j*(cols+1)+i;
      next.nodes[id]=[x,y];next.handles[id]=[[hx,slope*hx*(upper?t:1-t)],[0,hy]];next.manual[id]=true;
    }
    let error=0;
    for(let i=0;i<=cols*32;i++){
      const p=curvePoint(next,i/(cols*32),row/ny);
      if(p[0]>=points[0][0]&&p[0]<=points.at(-1)[0])error=Math.max(error,Math.abs(p[1]-value(p[0])));
    }
    next.seam={row,signature,fitError:error};
    next.snapOrigins=next.nodes.map(p=>[...p]);
    next.base={nx:frozen.nx,ny:frozen.ny,nodes:frozen.nodes.map(p=>[...p])};
    next.layoutOnly=!!g.layoutOnly;next.reference=next.layoutOnly?null:controlGrid(next);
    return next;
  }
  let next=create(nx);
  // Add columns only when needed to follow the real curved join closely.
  while(fit&&next.seam.fitError>.0006&&next.nx<32)next=create(Math.min(32,next.nx*2));
  if(!validGrid(next))throw Error('当前投射无法生成不交叉的拼接网格，请先减少整体拉伸');
  return next;
}

export function resizeSeamGrid(g,nx,ny){
  const points=Array.from({length:g.nx*32+1},(_,i)=>curvePoint(g,i/(g.nx*32),g.seam.row/g.ny));
  if(points.some((p,i)=>i&&p[0]<=points[i-1][0]))throw Error('拼接线横向发生回折，暂不能改变网格密度');
  return buildSeamGrid(g,points,{nx,ny,signature:g.seam.signature,fit:false});
}

// Screen-space tolerance stays constant as the editor is zoomed.
export function snapMovement(g,id,delta,{width,height,enabled=true,threshold=7,shiftAxis=-1}={}){
  const guides=[],start=g.nodes[id];
  if(!enabled||!start)return {delta,guides};
  const origin=g.snapOrigins?.[id]||g.reference?.nodes[id]||[id%(g.nx+1)/g.nx,Math.floor(id/(g.nx+1))/g.ny];
  const result=[...delta];
  for(let k=0;k<2;k++){
    if(k===shiftAxis)continue;
    const scale=k===0?width:height,at=start[k]+result[k];
    const candidates=[origin[k],start[k]].sort((a,b)=>Math.abs(a-at)-Math.abs(b-at));
    if(Math.abs(candidates[0]-at)*scale<=threshold){
      result[k]=candidates[0]-start[k];guides.push({axis:k,value:candidates[0]});
    }
  }
  return {delta:result,guides};
}
