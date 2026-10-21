import {denseGrid,triangles,sourceNode} from './mapping.js';

// A map is computed once at output resolution, in a worker. Each output pixel
// then samples the original decoded frame once; the 2048px preview is never used.
function inverseLookup(grid){
  const d=denseGrid(grid),size=64,lo=[Infinity,Infinity],hi=[-Infinity,-Infinity];
  for(const p of d.nodes)for(let k=0;k<2;k++){lo[k]=Math.min(lo[k],p[k]-1e-6);hi[k]=Math.max(hi[k],p[k]+1e-6);}
  const sx=size/(hi[0]-lo[0]),sy=size/(hi[1]-lo[1]);
  const cx=x=>Math.max(0,Math.min(size-1,Math.floor((x-lo[0])*sx)));
  const cy=y=>Math.max(0,Math.min(size-1,Math.floor((y-lo[1])*sy)));
  const bins=Array.from({length:size*size},()=>[]);
  for(const ids of triangles(d)){
    const [a,b,c]=ids.map(i=>d.nodes[i]),uv=ids.map(i=>sourceNode(d,i));
    const abx=b[0]-a[0],aby=b[1]-a[1],acx=c[0]-a[0],acy=c[1]-a[1],det=abx*acy-aby*acx;
    const minx=Math.min(a[0],b[0],c[0])-1e-6,maxx=Math.max(a[0],b[0],c[0])+1e-6;
    const miny=Math.min(a[1],b[1],c[1])-1e-6,maxy=Math.max(a[1],b[1],c[1])+1e-6;
    const t={ax:a[0],ay:a[1],abx,aby,acx,acy,inv:1/det,uv,minx,maxx,miny,maxy};
    for(let y=cy(miny);y<=cy(maxy);y++)for(let x=cx(minx);x<=cx(maxx);x++)bins[y*size+x].push(t);
  }
  return (u,v,result,index)=>{
    if(u<lo[0]||u>hi[0]||v<lo[1]||v>hi[1])return;
    for(const t of bins[cy(v)*size+cx(u)]){
      if(u<t.minx||u>t.maxx||v<t.miny||v>t.maxy)continue;
      const x=u-t.ax,y=v-t.ay,b=(x*t.acy-y*t.acx)*t.inv,c=(t.abx*y-t.aby*x)*t.inv,a=1-b-c;
      if(a>=-1e-6&&b>=-1e-6&&c>=-1e-6){
        result[index]=a*t.uv[0][0]+b*t.uv[1][0]+c*t.uv[2][0];
        result[index+1]=a*t.uv[0][1]+b*t.uv[1][1]+c*t.uv[2][1];return;
      }
    }
  };
}
export function buildUVMap({kind,width,height,source,model,state},progress=()=>{}){
  const map=new Float32Array(width*height*2);map.fill(-10);
  const sample=inverseLookup(state.grid),p=state.projection,h=p.fov*Math.PI/180,eye=model.eye;
  const project=(x,y,z,index)=>{
    x-=eye[0];y-=eye[1];z-=eye[2];
    sample(.5+Math.atan2(-x,-y)/(h*p.scaleX)+p.offsetX,
      p.horizon+p.offsetY-Math.atan2(z,Math.hypot(x,y))/(h/(source.width/source.height)*p.scaleY),map,index);
  };
  if(kind==='warp'){
    for(let y=0;y<height;y++){
      for(let x=0;x<width;x++)sample((x+.5)/width,(y+.5)/height,map,(y*width+x)*2);
      if(y%128===0)progress(y/height);
    }
  }else{
    const s=model.screens,scale=width/s.wrap.physical[0],rh=Math.round(s.roof.physical[1]*scale),rw=Math.round(s.roof.physical[0]*scale);
    const areas=kind==='combined'?[[s.roof,rw,rh,Math.floor((width-rw)/2),0],[s.wrap,width,height-rh,0,rh]]:[[s[kind],width,height,0,0]];
    for(let area=0;area<areas.length;area++){
      const [screen,w,hh,ox,oy]=areas[area];
      for(let n=0;n<screen.triangles.length;n++){
        const t=screen.triangles[n],uv=t.uv.map(([u,v])=>[u*w-.5,v*hh-.5]);
        const [a,b,c]=uv,abx=b[0]-a[0],aby=b[1]-a[1],acx=c[0]-a[0],acy=c[1]-a[1],det=abx*acy-aby*acx;
        if(Math.abs(det)<1e-8)continue;
        const xmin=Math.max(0,Math.floor(Math.min(a[0],b[0],c[0]))),xmax=Math.min(w-1,Math.ceil(Math.max(a[0],b[0],c[0])));
        const ymin=Math.max(0,Math.floor(Math.min(a[1],b[1],c[1]))),ymax=Math.min(hh-1,Math.ceil(Math.max(a[1],b[1],c[1])));
        const [pa,pb,pc]=t.vertices.map(i=>screen.vertices[i]);
        for(let y=ymin;y<=ymax;y++)for(let x=xmin;x<=xmax;x++){
          const dx=x-a[0],dy=y-a[1],wb=(dx*acy-dy*acx)/det,wc=(abx*dy-aby*dx)/det,wa=1-wb-wc;
          if(wa>=-1e-7&&wb>=-1e-7&&wc>=-1e-7)project(
            wa*pa[0]+wb*pb[0]+wc*pc[0],wa*pa[1]+wb*pb[1]+wc*pc[1],wa*pa[2]+wb*pb[2]+wc*pc[2],
            ((y+oy)*width+x+ox)*2);
        }
        if(n%32===0)progress((area+n/screen.triangles.length)/areas.length);
      }
    }
  }
  progress(1);return map;
}
