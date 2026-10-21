function boundaryEdges(screen){
  const counts=new Map();
  for(const t of screen.triangles)for(let i=0;i<3;i++){
    const key=[t.vertices[i],t.vertices[(i+1)%3]].sort((a,b)=>a-b).join(',');
    counts.set(key,(counts.get(key)||0)+1);
  }
  return [...counts].filter(([,count])=>count===1).map(([key])=>key.split(',').map(Number));
}
// Match actual shared mesh boundaries, excluding floor edges, open sides and
// the roof's unshared front edge. Model coordinates are already in world space.
export function seamSegments(screens,tolerance=1e-4){
  const {wrap,roof}=screens;
  const roofEdges=new Set(boundaryEdges(roof).map(e=>e.join(',')));
  const matched=wrap.vertices.map(p=>roof.vertices.findIndex(q=>Math.hypot(...p.map((v,k)=>v-q[k]))<tolerance));
  return boundaryEdges(wrap)
    .filter(e=>e.every(id=>matched[id]>=0)&&roofEdges.has(e.map(id=>matched[id]).sort((a,b)=>a-b).join(',')))
    .flatMap(e=>e.flatMap(id=>wrap.vertices[id]));
}
