import {importMedia,compatiblePreview,exportMedia} from './browser-media.js';
import * as THREE from 'three';
import {ViewControls,eyeProjection} from './view-controls.js';
import {LineSegments2} from 'three/addons/lines/LineSegments2.js';
import {LineSegmentsGeometry} from 'three/addons/lines/LineSegmentsGeometry.js';
import {LineMaterial} from 'three/addons/lines/LineMaterial.js';
import {seamSegments} from './geometry.js';
import {projectedSeam,buildSeamGrid,resizeSeamGrid,seamSignature,snapMovement} from './seam-grid.js';
import {createHall,updateHallVisibility,FLOOR_HEIGHT} from './hall.js';
import {makeGrid,triangles,sourceNode,validGrid,forward,inverse,projection,projectionDirection,moveLine,
  autoHandles,denseGrid,curvePoint,movePoint,moveHandle,resampleGrid,mirrorNode,controlInverse,controlSource,setLayoutOnly,pinned} from './mapping.js';

const $=id=>document.getElementById(id), video=$('video');
let config,model,eyePreset,seatsData,hall,viewer,source=null,token,grid=makeGrid(),params,selected=[.5,.5],line={kind:'row',index:3};
let previewAbort=null,previewUrl=null,exportUrls=[],sampleAbort=null;
let undoStack=[],redoStack=[],currentJob=null,proxyBusy=false,proxyTried=false,toastTimer,sourceSerial=0;
let warpRenderer,renderer,scene,camera,orbit,warpScene,warpCamera,rtCamera,target,warpMesh,warpMaterial;
let screenMeshes=[],marker,seamLine,eyeDot,raycaster=new THREE.Raycaster(),viewRect,drag=null;
let texture=null,lastCoverage=0,lastSaved='',currentSourceUrl='',sourceOverlayDirty=true;
let editMode='point',activeNode=22,handleHits=[],editorView={zoom:1,panX:0,panY:0};
let snapGuides=[],seamPreview=null;
const kinds=['wrap','roof','combined','warp'];
const clone=x=>structuredClone(x);
const defaultParams=()=>({fov:model.horizontalFov,scaleX:1,scaleY:1,offsetX:0,offsetY:0,horizon:.85});
const aspect=()=>source?source.width/source.height:4398/1886;
const isImage=()=>source?.kind==='image';
const state=()=>({grid:clone(grid),projection:clone(params)});
function toast(message){$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),4200);$('status').textContent=message;}
async function api(path){
  const r=await fetch(path);if(!r.ok)throw Error('无法加载工作台资源');
  return r.json();
}
function remember(){undoStack.push(state());if(undoStack.length>80)undoStack.shift();redoStack=[];}
function restore(s){grid=clone(s.grid);params=clone(s.projection);line.index=Math.min(line.index,line.kind==='row'?grid.ny:grid.nx);activeNode=Math.min(activeNode,grid.nodes.length-1);updateAll();}
function undo(){if(!undoStack.length)return;redoStack.push(state());restore(undoStack.pop());}
function redo(){if(!redoStack.length)return;undoStack.push(state());restore(redoStack.pop());}
function setMode(kind){editMode=kind;if(kind!=='point'){const c=controlInverse(grid,...forward(grid,...selected))||selected;line.kind=kind;line.index=Math.max(0,Math.min(kind==='row'?grid.ny:grid.nx,Math.round(c[kind==='row'?1:0]*(kind==='row'?grid.ny:grid.nx))));}updateAll();}
function setStatus(){ $('lineLabel').textContent=editMode==='point'?`点 ${activeNode%(grid.nx+1)}, ${Math.floor(activeNode/(grid.nx+1))}`:`${line.kind==='row'?'行':'列'} ${line.index}`;}
function preserveLayoutBoundary(next){
  grid.nodes.forEach((p,id)=>{
    if(pinned(grid,id,{boundary:!!grid.layoutOnly,region:$('editRegion').value})){
      next.nodes[id]=[...p];
      if(grid.handles)next.handles[id]=clone(grid.handles[id]);
      if(grid.manual)next.manual[id]=grid.manual[id];
    }
  });
}
function actualSeam(){
  const signature=seamSignature(model,params,aspect());
  if(seamPreview?.signature!==signature)seamPreview={signature,points:projectedSeam(model,params,aspect())};
  return seamPreview;
}
function placeholderTexture(){
  const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=512;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#555';ctx.fillRect(0,0,1024,512);
  for(let y=0;y<6;y++)for(let x=0;x<12;x++){
    ctx.fillStyle=(x+y)%2?'#666':'#777';ctx.fillRect(x*1024/12,y*512/6,1024/12,512/6);
    ctx.fillStyle='#ddd';ctx.font='16px sans-serif';ctx.fillText(`${x+1}:${y+1}`,x*1024/12+8,y*512/6+24);
  }
  const result=new THREE.CanvasTexture(canvas);result.colorSpace=THREE.NoColorSpace;
  return result;
}
function clearMedia(){
  if(currentJob)return;
  sampleAbort?.abort();sampleAbort=null;
  previewAbort?.abort();if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=null;
  for(const item of config.sources)URL.revokeObjectURL(item.url);
  config.sources=[];sourceOptions();
  sourceSerial++;source=null;currentSourceUrl='';proxyBusy=false;proxyTried=false;
  video.pause();video.removeAttribute('src');video.load();$('stillImage').removeAttribute('src');$('videoFile').value='';
  texture?.dispose();texture=placeholderTexture();warpMaterial.uniforms.sourceTex.value=texture;
  $('sourceName').textContent='未选择素材';$('sourceSize').textContent='—';$('sourceSelect').value='';
  $('sourceEmpty').textContent='选择图片或视频';$('sourceEmpty').style.display='grid';
  $('timecode').textContent='00:00.000 / 00:00.000';$('timeline').value=0;$('timeline').max=1;$('play').textContent='▶';
  syncMediaControls();resize();updateAll();toast('素材已清空，恢复测试网格；映射参数保留');
}

function setupRenderers(){
  renderer=new THREE.WebGLRenderer({canvas:$('sceneCanvas'),antialias:true,alpha:false,preserveDrawingBuffer:true});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.outputColorSpace=THREE.LinearSRGBColorSpace;
  renderer.toneMapping=THREE.NoToneMapping;renderer.setClearColor(new THREE.Color().setRGB(.32,.32,.32,THREE.LinearSRGBColorSpace));
  warpRenderer=new THREE.WebGLRenderer({canvas:$('warpCanvas'),antialias:true,alpha:false,preserveDrawingBuffer:true});
  warpRenderer.setPixelRatio(Math.min(devicePixelRatio,1.5));warpRenderer.outputColorSpace=THREE.LinearSRGBColorSpace;
  warpRenderer.toneMapping=THREE.NoToneMapping;warpRenderer.setClearColor(new THREE.Color().setRGB(.28,.28,.28,THREE.LinearSRGBColorSpace));
  scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(55,1,.05,250);camera.up.set(0,0,1);
  viewer=new ViewControls(camera,renderer.domElement,model.eye,eyePreset.camera,syncViewControls);orbit=viewer.orbit;
  viewer.setMode('eye');
  hall=createHall(model,seatsData);scene.add(hall.group);
  eyeDot=new THREE.Mesh(new THREE.SphereGeometry(.12,16,12),new THREE.MeshBasicMaterial({color:0xdddddd}));
  eyeDot.position.fromArray(model.eye);eyeDot.visible=false;scene.add(eyeDot);
  marker=new THREE.Mesh(new THREE.SphereGeometry(.11,20,14),new THREE.MeshBasicMaterial({color:0xffdd83,depthTest:false}));
  marker.renderOrder=10;scene.add(marker);
  const halo=new THREE.Mesh(new THREE.SphereGeometry(.18,16,12),new THREE.MeshBasicMaterial({color:0xffdd83,transparent:true,opacity:.2,depthTest:false}));
  marker.add(halo);
  // A diagnostic texture remains available even before a video has loaded.
  texture=placeholderTexture();
  warpScene=new THREE.Scene();warpCamera=new THREE.OrthographicCamera(0,1,0,-1,.1,10);warpCamera.position.z=1;
  rtCamera=new THREE.OrthographicCamera(0,1,0,-1,.1,10);rtCamera.position.z=1;
  target=new THREE.WebGLRenderTarget(2048,1024,{minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,depthBuffer:false});
  target.texture.colorSpace=THREE.NoColorSpace;
  warpMaterial=new THREE.ShaderMaterial({
    uniforms:{sourceTex:{value:texture},showGrid:{value:1},gridSize:{value:new THREE.Vector2(grid.nx,grid.ny)},
      selectedLine:{value:new THREE.Vector2(0,3)},markerUV:{value:new THREE.Vector2(...selected)},showMarker:{value:1}},
    vertexShader:`attribute vec2 controlUV;varying vec2 vUV,vControl;void main(){vUV=uv;vControl=controlUV;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader:`precision highp float;uniform sampler2D sourceTex;uniform float showGrid,showMarker;uniform vec2 gridSize,selectedLine,markerUV;varying vec2 vUV,vControl;
      void main(){vec4 pixel=texture2D(sourceTex,vec2(vUV.x,1.0-vUV.y));vec3 c=pixel.rgb*pixel.a;
        vec2 g=vControl*gridSize;vec2 d=abs(g-floor(g+.5))/max(fwidth(g),vec2(.0001));
        float ln=1.-smoothstep(.45,1.1,min(d.x,d.y));
        float sv=selectedLine.x<.5?g.y:g.x;float sd=abs(sv-selectedLine.y)/max(fwidth(sv),.0001);
        float highlight=selectedLine.x<0.?0.:1.-smoothstep(.7,1.6,sd);
        c=mix(c,vec3(.85),ln*showGrid*.7);
        c=mix(c,vec3(1.,.83,.43),highlight*showGrid*.95);
        vec2 dd=(vUV-markerUV)/max(fwidth(vUV),vec2(.00001));float r=length(dd);
        float dotMask=(1.-smoothstep(3.,4.,r))*showMarker;c=mix(c,vec3(1.,.87,.5),dotMask);
        gl_FragColor=vec4(c,1.);}`,
    side:THREE.DoubleSide,depthTest:false,depthWrite:false
  });
  warpMesh=new THREE.Mesh(new THREE.BufferGeometry(),warpMaterial);warpScene.add(warpMesh);rebuildGridGeometry();
  for(const [key,s] of Object.entries(model.screens)){
    const positions=[],atlas=[];
    for(const t of s.triangles) t.vertices.forEach((vi,j)=>{positions.push(...s.vertices[vi]);atlas.push(...t.uv[j]);});
    const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    geo.setAttribute('uv',new THREE.Float32BufferAttribute(atlas,2));geo.computeVertexNormals();
    const mat=new THREE.ShaderMaterial({
      uniforms:{mapped:{value:target.texture},mapBounds:{value:new THREE.Vector4(0,0,1,1)},eye:{value:new THREE.Vector3(...model.eye)},hSpan:{value:1},
        vSpan:{value:1},shift:{value:new THREE.Vector2()},diagnostic:{value:1}},
      vertexShader:`varying vec3 world;void main(){world=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*viewMatrix*vec4(world,1.);}`,
      fragmentShader:`precision highp float;varying vec3 world;uniform vec3 eye;uniform float hSpan,vSpan,diagnostic;uniform vec2 shift;uniform sampler2D mapped;uniform vec4 mapBounds;
        void main(){vec3 d=world-eye;vec2 q=vec2(.5+atan(-d.x,-d.y)/hSpan+shift.x,shift.y-atan(d.z,length(d.xy))/vSpan);
          vec2 t=(q-mapBounds.xy)/mapBounds.zw;
          vec4 c=texture2D(mapped,vec2(t.x,1.-t.y));bool outside=t.x<0.||t.x>1.||t.y<0.||t.y>1.||c.a<.5;
          if(outside){float stripe=step(.5,fract((gl_FragCoord.x+gl_FragCoord.y)/16.));c=vec4(mix(vec3(.11,.13,.16),vec3(.3,.16,.18),stripe)*diagnostic,1.);}
          gl_FragColor=vec4(c.rgb,1.);}`,
      side:THREE.DoubleSide
    });
    const mesh=new THREE.Mesh(geo,mat);mesh.userData.key=key;scene.add(mesh);screenMeshes.push(mesh);
    const edges=new THREE.LineSegments(new THREE.EdgesGeometry(geo,35),new THREE.LineBasicMaterial({color:0xcccccc,transparent:true,opacity:.65}));
    mesh.add(edges);
  }
  const seamGeometry=new LineSegmentsGeometry();seamGeometry.setPositions(seamSegments(model.screens));
  const seamMaterial=new LineMaterial({linewidth:3,worldUnits:false,depthTest:false,depthWrite:false,toneMapped:false});
  seamMaterial.color.setRGB(1,.82,.08,THREE.LinearSRGBColorSpace);
  seamLine=new LineSegments2(seamGeometry,seamMaterial);
  seamLine.name='天幕与环幕接缝';seamLine.renderOrder=20;seamLine.visible=$('showSeam').checked;scene.add(seamLine);
  new ResizeObserver(resize).observe($('sceneStage'));
  new ResizeObserver(resize).observe($('warpStage'));
  new ResizeObserver(()=>{sourceOverlayDirty=true;}).observe($('sourceStage'));
  resize();updateAll();animate();
}
function rebuildGridGeometry(){
  const pos=[],uv=[],controls=[],dense=denseGrid(grid);
  const controlUV=dense.nodes.map((p,id)=>grid.base?(controlInverse(grid,...p)||[-100,-100]):sourceNode(dense,id));
  for(const tri of triangles(dense)) for(const id of tri){
    pos.push(dense.nodes[id][0],-dense.nodes[id][1],0);uv.push(...sourceNode(dense,id));controls.push(...controlUV[id]);
  }
  warpMesh.geometry.dispose();warpMesh.geometry=new THREE.BufferGeometry();
  warpMesh.geometry.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  warpMesh.geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  warpMesh.geometry.setAttribute('controlUV',new THREE.Float32BufferAttribute(controls,2));
  warpMaterial.uniforms.gridSize.value.set(grid.nx,grid.ny);
}
function resize(){
  if(!renderer)return;
  const a=$('sceneStage').getBoundingClientRect(),b=$('warpStage').getBoundingClientRect();
  if(a.width&&a.height){renderer.setSize(a.width,a.height,false);camera.aspect=a.width/a.height;viewer.resize();}
  if(b.width&&b.height){
    warpRenderer.setSize(b.width,b.height,false);
    const w=Math.min(b.width/1.1,b.height/1.1*aspect())*editorView.zoom,h=w/aspect();
    viewRect={x:(b.width-w)/2+editorView.panX,y:(b.height-h)/2+editorView.panY,w,h};
    warpCamera.left=-viewRect.x/w;warpCamera.right=(b.width-viewRect.x)/w;
    warpCamera.top=viewRect.y/h;warpCamera.bottom=-(b.height-viewRect.y)/h;warpCamera.updateProjectionMatrix();
    const d=devicePixelRatio;$('warpOverlay').width=Math.round(b.width*d);$('warpOverlay').height=Math.round(b.height*d);
  }
  const limit=Math.min(2048,renderer.capabilities.maxTextureSize);
  target.setSize(Math.max(16,Math.round(Math.min(limit,limit*aspect()))),Math.max(16,Math.round(Math.min(limit,limit/aspect()))));
  sourceOverlayDirty=true;drawWarpOverlay();
}
function updateAll(){
  if(!renderer)return;
  rebuildGridGeometry();
  const dense=denseGrid(grid),xs=dense.nodes.map(p=>p[0]),ys=dense.nodes.map(p=>p[1]);
  const lo=[Math.min(...xs),Math.min(...ys)],hi=[Math.max(...xs),Math.max(...ys)];
  rtCamera.left=lo[0];rtCamera.right=hi[0];rtCamera.top=-lo[1];rtCamera.bottom=-hi[1];rtCamera.updateProjectionMatrix();
  const h=params.fov*Math.PI/180;
  for(const m of screenMeshes){
    m.material.uniforms.mapBounds.value.set(lo[0],lo[1],hi[0]-lo[0],hi[1]-lo[1]);
    m.material.uniforms.hSpan.value=h*params.scaleX;m.material.uniforms.vSpan.value=h/aspect()*params.scaleY;
    m.material.uniforms.shift.value.set(params.offsetX,params.horizon+params.offsetY);
    m.material.uniforms.diagnostic.value=$('diagnostic').checked?1:0;
  }
  warpMaterial.uniforms.selectedLine.value.set(editMode==='point'?-1:line.kind==='row'?0:1,line.index);
  warpMaterial.uniforms.markerUV.value.set(...selected);
  document.querySelectorAll('.control').forEach(el=>{
    const k=el.dataset.key;el.querySelector('input').value=params[k];el.querySelector('output').textContent=params[k].toFixed(3);
  });
  ['point','row','col'].forEach(m=>$('mode'+m[0].toUpperCase()+m.slice(1)).classList.toggle('active',editMode===m));
  $('warpOverlay').style.cursor=editMode==='point'?'crosshair':'move';
  $('gridCols').value=grid.nx;$('gridRows').value=grid.ny;
  $('smoothPoint').disabled=editMode!=='point';
  $('mirrorEdit').disabled=editMode!=='point';
  $('layoutOnly').checked=!!grid.layoutOnly;
  $('editRegion').hidden=!grid.seam;
  if(!grid.seam)$('editRegion').value='both';
  $('addSeam').textContent=grid.seam?'重建拼接线':'添加拼接线';
  $('addSeam').title=grid.seam?'按当前投射重新对齐实际接缝，保留画面，并重新布置控制网格':'按实际幕面接缝增加一行控制点，保留画面，并重新布置控制网格';
  $('undo').disabled=!undoStack.length;$('redo').disabled=!redoStack.length;
  setStatus();sourceOverlayDirty=true;updateMarker();drawWarpOverlay();updateSizes();
}
function updateMarker(){
  if(!marker)return;
  const q=forward(grid,...selected),dir=projectionDirection(q,params,aspect());
  $('sourceCoord').textContent=source?`${Math.round(selected[0]*source.width)}, ${Math.round(selected[1]*source.height)}`:selected.map(n=>n.toFixed(3)).join(', ');
  $('destCoord').textContent=q.map(n=>n.toFixed(3)).join(', ');
  if(dir){
    raycaster.set(new THREE.Vector3(...model.eye),new THREE.Vector3(...dir).normalize());
    const hits=raycaster.intersectObjects(screenMeshes,false);
    // Keep coincident seam triangles from producing duplicate location labels.
    if(hits.length){
      const hit=hits[0];marker.visible=true;marker.position.copy(hit.point);
      const key=hit.object.userData.key;$('surfaceCoord').textContent=key==='roof'?'天幕':'环幕';
      $('markerInfo').textContent=`定位于${key==='roof'?'天幕':'环幕'}`;
      return;
    }
  }
  marker.visible=false;$('surfaceCoord').textContent='未落在幕面';$('markerInfo').textContent='此点未落在幕面，调整位置或缩放';
}
function drawWarpOverlay(){
  if(!viewRect)return;
  const c=$('warpOverlay'),ctx=c.getContext('2d'),d=devicePixelRatio;
  ctx.setTransform(d,0,0,d,0,0);ctx.clearRect(0,0,c.width/d,c.height/d);
  const r=viewRect,pt=p=>[r.x+p[0]*r.w,r.y+p[1]*r.h];
  ctx.strokeStyle='#a0a0a0';ctx.lineWidth=1;ctx.setLineDash([4,4]);ctx.strokeRect(r.x,r.y,r.w,r.h);ctx.setLineDash([]);
  const mirror=$('mirrorEdit').checked&&editMode==='point';
  if(mirror){
    ctx.strokeStyle='#ffffff70';ctx.setLineDash([3,5]);ctx.beginPath();
    ctx.moveTo(r.x+r.w*.5,0);ctx.lineTo(r.x+r.w*.5,c.height/d);ctx.stroke();ctx.setLineDash([]);
  }
  if($('protect').checked){ctx.fillStyle='#ffffff10';ctx.fillRect(r.x+r.w*.38,r.y,r.w*.24,r.h);}
  if(grid.seam){
    ctx.beginPath();actualSeam().points.forEach((p,i)=>i?ctx.lineTo(...pt(p)):ctx.moveTo(...pt(p)));
    ctx.strokeStyle='#ffd55b70';ctx.setLineDash([3,4]);ctx.lineWidth=1;ctx.stroke();ctx.setLineDash([]);
  }
  for(let row=0;row<=grid.ny;row++)drawLine('row',row);
  for(let col=0;col<=grid.nx;col++)drawLine('col',col);
  function drawLine(kind,index){
    const active=editMode===kind&&line.index===index,n=(kind==='row'?grid.nx:grid.ny)*8;
    ctx.beginPath();
    for(let j=0;j<=n;j++){const p=pt(kind==='row'?curvePoint(grid,j/n,index/grid.ny):curvePoint(grid,index/grid.nx,j/n));j?ctx.lineTo(...p):ctx.moveTo(...p);}
    const join=kind==='row'&&grid.seam?.row===index;
    ctx.strokeStyle=join?'#ffcc44':active?'#ffdc85':'#eeeeee90';ctx.lineWidth=join?2.5:active?2:1;ctx.stroke();
  }
  grid.nodes.forEach((p,id)=>{
    const [x,y]=pt(p),active=editMode==='point'&&(id===activeNode||(mirror&&id===mirrorNode(grid,activeNode))),size=active?5:3;
    const join=grid.seam?.row===Math.floor(id/(grid.nx+1));
    ctx.fillStyle=join?'#ffcc44':active?'#ffdc85':'#e5e5e5';ctx.strokeStyle='#333';ctx.lineWidth=1;
    ctx.fillRect(x-size,y-size,size*2,size*2);ctx.strokeRect(x-size,y-size,size*2,size*2);
  });
  handleHits=[];
  if(editMode==='point'&&$('showHandles').checked){
    const g=grid.handles?grid:autoHandles(clone(grid)),p=g.nodes[activeNode],h=g.handles[activeNode],a=pt(p);
    for(let axis=0;axis<2;axis++)for(const sign of [-1,1]){
      const end=pt(p.map((n,k)=>n+sign*h[axis][k]));
      ctx.strokeStyle=axis===0?'#ffe4a3':'#ededed';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...end);ctx.stroke();
      ctx.fillStyle='#444';ctx.beginPath();ctx.arc(...end,4.5,0,Math.PI*2);ctx.fill();ctx.stroke();
      handleHits.push({axis,sign,point:end});
    }
  }
  if(snapGuides.length){
    ctx.strokeStyle='#a5e3ed';ctx.setLineDash([5,4]);ctx.lineWidth=1;
    for(const guide of snapGuides){
      ctx.beginPath();
      if(guide.axis===0){const x=r.x+guide.value*r.w;ctx.moveTo(x,0);ctx.lineTo(x,c.height/d);}
      else{const y=r.y+guide.value*r.h;ctx.moveTo(0,y);ctx.lineTo(c.width/d,y);}ctx.stroke();
    }ctx.setLineDash([]);
  }
  const mark=pt(forward(grid,...selected));drawCross(ctx,...mark,'#ffe9a3');
}
function drawCross(ctx,x,y,color){ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(x,y,7,0,Math.PI*2);ctx.moveTo(x-12,y);ctx.lineTo(x+12,y);ctx.moveTo(x,y-12);ctx.lineTo(x,y+12);ctx.stroke();}
function sourceRect(){
  const r=$('sourceStage').getBoundingClientRect(),w=Math.min(r.width,r.height*aspect()),h=w/aspect();
  return {x:(r.width-w)/2,y:(r.height-h)/2,w,h,width:r.width,height:r.height};
}
function drawSourceOverlay(){
  const c=$('sourceOverlay'),r=sourceRect(),d=devicePixelRatio;
  c.width=Math.round(r.width*d);c.height=Math.round(r.height*d);
  const ctx=c.getContext('2d');ctx.setTransform(d,0,0,d,0,0);
  if(!source||!r.w||!r.h)return;
  ctx.strokeStyle='#eeeeee40';ctx.lineWidth=.6;
  for(const kind of ['row','col'])for(let i=0;i<=(kind==='row'?grid.ny:grid.nx);i++){
    ctx.strokeStyle=editMode===kind&&line.index===i?'#ffdc8580':'#eeeeee40';ctx.beginPath();let connected=false;
    const steps=(kind==='row'?grid.nx:grid.ny)*8;
    for(let j=0;j<=steps;j++){
      const p=kind==='row'?curvePoint(grid,j/steps,i/grid.ny):curvePoint(grid,i/grid.nx,j/steps);
      const uv=inverse(grid,...p);if(!uv){connected=false;continue;}
      const q=[r.x+uv[0]*r.w,r.y+uv[1]*r.h];connected?ctx.lineTo(...q):ctx.moveTo(...q);connected=true;
    }ctx.stroke();
  }
  drawCross(ctx,r.x+selected[0]*r.w,r.y+selected[1]*r.h,'#ffe8a0');
}
function animate(){
  requestAnimationFrame(animate);
  if(!renderer)return;
  viewer.update();
  updateHallVisibility(hall,camera,$('showSeats').checked,$('hideSeatsBelow').checked);
  const sg=$('showGrid').checked;warpMaterial.uniforms.showGrid.value=sg?1:0;
  warpMaterial.uniforms.showMarker.value=sg?1:0;
  const clear=renderer.getClearColor(new THREE.Color());
  renderer.setRenderTarget(target);renderer.setClearColor(0x000000,0);renderer.clear();renderer.render(warpScene,rtCamera);
  renderer.setRenderTarget(null);renderer.setClearColor(clear,1);
  renderer.render(scene,camera);
  // Always keep the editable mesh visible in its dedicated panel.
  warpMaterial.uniforms.showGrid.value=0;warpMaterial.uniforms.showMarker.value=0;
  warpRenderer.render(warpScene,warpCamera);
  if(sourceOverlayDirty){drawSourceOverlay();sourceOverlayDirty=false;}
  if(!isImage()&&video.readyState>=1){
    $('timeline').value=video.currentTime;
    $('timecode').textContent=`${timecode(video.currentTime)} / ${timecode(video.duration)}`;
    $('play').textContent=video.paused?'▶':'Ⅱ';
  }
}
function timecode(t){if(!Number.isFinite(t))return '00:00.000';return `${String(Math.floor(t/60)).padStart(2,'0')}:${(t%60).toFixed(3).padStart(6,'0')}`;}
function canvasPoint(e,id){const r=$(id).getBoundingClientRect();return [e.clientX-r.left,e.clientY-r.top];}
function normalizedWarp(e){const [x,y]=canvasPoint(e,'warpOverlay');return [(x-viewRect.x)/viewRect.w,(y-viewRect.y)/viewRect.h];}
function nearestLine(q){
  const src=controlInverse(grid,...q)||selected;const n=line.kind==='row'?grid.ny:grid.nx;
  return Math.max(0,Math.min(n,Math.round(src[line.kind==='row'?1:0]*n)));
}
function applyDrag(delta,shift=false,disableSnap=false){
  let shiftAxis=-1;
  if(shift){shiftAxis=Math.abs(delta[0]*viewRect.w)>Math.abs(delta[1]*viewRect.h)?1:0;delta[shiftAxis]=0;}
  snapGuides=[];
  if(drag.type==='point'||drag.type==='line'){
    const id=drag.type==='point'?drag.id:drag.snapId;
    const snapped=snapMovement(drag.original,id,delta,{width:viewRect.w,height:viewRect.h,enabled:$('snapPoints').checked&&!disableSnap,shiftAxis});
    delta=snapped.delta;snapGuides=snapped.guides;
  }
  const options={radius:+$('influence').value,protect:$('protect').checked?.24:0,boundary:$('lockBoundary').checked,
    symmetry:drag.type!=='line'&&$('mirrorEdit').checked,region:$('editRegion').value};
  let next;
  if(drag.type==='point')next=movePoint(drag.original,drag.id,delta,options);
  else if(drag.type==='handle'){
    const g=drag.original.handles?drag.original:autoHandles(clone(drag.original));
    next=moveHandle(g,drag.id,drag.axis,g.handles[drag.id][drag.axis].map((v,k)=>v+delta[k]*drag.sign),options);
  }else next=moveLine(drag.original,drag.kind,drag.index,delta,options);
  if(next){grid=next;updateAll();}
  else{snapGuides=[];drawWarpOverlay();$('status').textContent='已限制移动：固定区域或网格翻折';}
}
function nearestAnchor(q){
  const c=controlInverse(grid,...q)||[.5,.5];
  const col=Math.max(0,Math.min(grid.nx,Math.round(c[0]*grid.nx))),row=Math.max(0,Math.min(grid.ny,Math.round(c[1]*grid.ny)));
  return row*(grid.nx+1)+col;
}
function endDrag(){drag=null;snapGuides=[];drawWarpOverlay();}
function sceneHit(e){
  const r=$('sceneCanvas').getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2((e.clientX-r.left)/r.width*2-1,1-(e.clientY-r.top)/r.height*2),camera);
  return raycaster.intersectObjects(screenMeshes.filter(m=>m.visible),false)[0];
}
function initInteractions(){
  $('sourceOverlay').addEventListener('pointerdown',e=>{
    if(!source)return;video.pause();
    const [x,y]=canvasPoint(e,'sourceOverlay'),r=sourceRect();
    const u=(x-r.x)/r.w,v=(y-r.y)/r.h;if(u<0||u>1||v<0||v>1)return;
    selected=[u,v];const c=controlInverse(grid,...forward(grid,u,v))||selected;
    activeNode=Math.round(c[1]*grid.ny)*(grid.nx+1)+Math.round(c[0]*grid.nx);
    line.index=Math.round(c[line.kind==='row'?1:0]*(line.kind==='row'?grid.ny:grid.nx));updateAll();
  });
  $('warpOverlay').addEventListener('pointerdown',e=>{
    if(e.button===1||(e.button===0&&e.altKey)){
      e.preventDefault();drag={type:'pan',where:'warp',start:[e.clientX,e.clientY],pan:[editorView.panX,editorView.panY]};
      e.currentTarget.setPointerCapture(e.pointerId);return;
    }
    if(e.button!==0)return;
    video.pause();const q=normalizedWarp(e),p=canvasPoint(e,'warpOverlay');
    if(editMode==='point'){
      const handle=handleHits.find(h=>Math.hypot(h.point[0]-p[0],h.point[1]-p[1])<9);
      if(handle)drag={type:'handle',id:activeNode,axis:handle.axis,sign:handle.sign};
      else{
        let distance=11,id=-1;
        grid.nodes.forEach((n,i)=>{const d=Math.hypot((n[0]-q[0])*viewRect.w,(n[1]-q[1])*viewRect.h);if(d<distance){distance=d;id=i;}});
        if(id<0){const uv=inverse(grid,...q);if(uv){selected=uv;updateAll();}return;}
        activeNode=id;drag={type:'point',id};
      }
      selected=controlSource(grid,activeNode);
    }else{line.index=nearestLine(q);drag={type:'line',kind:editMode,index:line.index,snapId:nearestAnchor(q)};}
    remember();Object.assign(drag,{original:clone(grid),start:q,where:'warp'});
    e.currentTarget.setPointerCapture(e.pointerId);updateAll();
  });
  $('warpOverlay').addEventListener('pointermove',e=>{
    if(!drag||drag.where!=='warp')return;
    if(drag.type==='pan'){editorView.panX=drag.pan[0]+e.clientX-drag.start[0];editorView.panY=drag.pan[1]+e.clientY-drag.start[1];resize();return;}
    const q=normalizedWarp(e);applyDrag(q.map((n,k)=>n-drag.start[k]),e.shiftKey,e.altKey);
  });
  $('warpOverlay').addEventListener('pointerup',endDrag);
  $('warpOverlay').addEventListener('pointercancel',endDrag);
  $('warpOverlay').addEventListener('wheel',e=>{
    e.preventDefault();const q=normalizedWarp(e),p=canvasPoint(e,'warpOverlay');
    editorView.zoom=Math.max(.5,Math.min(8,editorView.zoom*Math.exp(-e.deltaY*.0015)));resize();
    editorView.panX+=p[0]-(viewRect.x+q[0]*viewRect.w);editorView.panY+=p[1]-(viewRect.y+q[1]*viewRect.h);resize();
  },{passive:false});
  $('warpOverlay').oncontextmenu=e=>e.preventDefault();
  $('sceneCanvas').addEventListener('pointerdown',e=>{
    if(!$('drag3D').checked||e.button!==0)return;const hit=sceneHit(e);if(!hit)return;
    const q=projection(hit.point.toArray(),model.eye,params,aspect()),uv=inverse(grid,...q);if(!uv)return;
    video.pause();selected=uv;line.index=nearestLine(q);
    const c=controlInverse(grid,...q)||uv;
    activeNode=Math.max(0,Math.min(grid.nodes.length-1,Math.round(c[1]*grid.ny)*(grid.nx+1)+Math.round(c[0]*grid.nx)));
    if(editMode==='point')selected=controlSource(grid,activeNode);
    remember();drag={type:editMode==='point'?'point':'line',id:activeNode,snapId:nearestAnchor(q),kind:editMode,index:line.index,original:clone(grid),start:q,where:'scene'};
    e.currentTarget.setPointerCapture(e.pointerId);updateAll();
  });
  $('sceneCanvas').addEventListener('pointermove',e=>{
    if(!drag||drag.where!=='scene')return;const hit=sceneHit(e);if(!hit)return;
    const q=projection(hit.point.toArray(),model.eye,params,aspect());applyDrag(q.map((n,k)=>n-drag.start[k]),e.shiftKey,e.altKey);
  });
  $('sceneCanvas').addEventListener('pointerup',endDrag);
  $('sceneCanvas').addEventListener('pointercancel',endDrag);
  $('drag3D').onchange=()=>viewer.setEditing($('drag3D').checked);
  $('reverseLookX').onchange=()=>viewer.setReverseHorizontal($('reverseLookX').checked);
  $('modePoint').onclick=()=>setMode('point');$('modeRow').onclick=()=>setMode('row');$('modeCol').onclick=()=>setMode('col');
  $('showHandles').onchange=drawWarpOverlay;
  $('mirrorEdit').onchange=drawWarpOverlay;
  $('snapPoints').onchange=()=>{snapGuides=[];drawWarpOverlay();};
  $('editRegion').onchange=()=>{snapGuides=[];drawWarpOverlay();};
  $('addSeam').onclick=()=>{
    try{
      const seam=actualSeam();
      const next=buildSeamGrid(grid,seam.points,{ny:grid.seam?grid.ny:grid.ny+1,signature:seam.signature});
      remember();grid=next;line={kind:'row',index:next.seam.row};editMode='row';
      activeNode=next.seam.row*(next.nx+1)+Math.floor(next.nx/2);selected=controlSource(grid,activeNode);
      $('editRegion').value='both';updateAll();
      toast('拼接控制线已就位，画面保持不动；可选择天幕或环幕单独调整');
    }catch(e){toast(e.message);}
  };
  $('layoutOnly').onchange=()=>{
    remember();grid=setLayoutOnly(grid,$('layoutOnly').checked);updateAll();
    toast(grid.layoutOnly?'仅调整控制网格，画面保持不动；外边界固定':'已锁定控制网格位置，继续拖动即可变形');
  };
  $('fitEditor').onclick=()=>{editorView={zoom:1,panX:0,panY:0};resize();};
  $('smoothPoint').onclick=()=>{
    const next=clone(grid);next.manual??=Array(next.nodes.length).fill(false);next.manual[activeNode]=false;
    if($('mirrorEdit').checked)next.manual[mirrorNode(grid,activeNode)]=false;
    autoHandles(next);preserveLayoutBoundary(next);
    if(validGrid(next)){remember();grid=next;updateAll();}else toast('平滑会使附近网格翻折，请先移动交点');
  };
  $('undo').onclick=undo;$('redo').onclick=redo;
  $('resetLine').onclick=()=>{
    const next=clone(grid);for(let i=0;i<next.nodes.length;i++){
      const s=sourceNode(next,i),axis=line.kind==='row'?1:0;
      if(editMode==='point'?(i===activeNode||($('mirrorEdit').checked&&i===mirrorNode(grid,activeNode))):Math.round(s[axis]*(axis?grid.ny:grid.nx))===line.index){
        next.nodes[i]=next.reference?[...next.reference.nodes[i]]:s;
        if(next.reference?.handles){next.handles[i]=clone(next.reference.handles[i]);next.manual[i]=true;}
        else if(next.manual)next.manual[i]=false;
      }
    }
    autoHandles(next);preserveLayoutBoundary(next);
    if(validGrid(next)){remember();grid=next;updateAll();}else toast('该线重置后会交叉，请先撤销附近变形或重置整个网格');
  };
  $('resetGrid').onclick=()=>{remember();grid=makeGrid(grid.nx,grid.ny);updateAll();};
  $('resetAll').onclick=()=>{remember();grid=makeGrid();activeNode=22;params=defaultParams();$('protect').checked=false;updateAll();toast('已恢复宽度优先映射');};
  $('applyDensity').onclick=()=>{
    const nx=+$('gridCols').value,ny=+$('gridRows').value;
    if(!Number.isInteger(nx)||!Number.isInteger(ny)||nx<1||nx>32||ny<1||ny>24){toast('列数为 1–32，行数为 1–24 的整数');return;}
    let next;
    try{next=grid.seam?resizeSeamGrid(grid,nx,ny):resampleGrid(grid,nx,ny);}catch(e){toast(e.message);return;}
    if(!next){toast('现有变形无法安全转换到该密度');return;}
    remember();grid=next;activeNode=Math.round(selected[1]*ny)*(nx+1)+Math.round(selected[0]*nx);
    line.index=Math.round(selected[line.kind==='row'?1:0]*(line.kind==='row'?ny:nx));updateAll();
  };
  $('protect').onchange=drawWarpOverlay;$('lockBoundary').onchange=()=>{};
  $('diagnostic').onchange=updateAll;$('showRoof').onchange=()=>{screenMeshes.find(m=>m.userData.key==='roof').visible=$('showRoof').checked;};
  $('showSeam').onchange=()=>{seamLine.visible=$('showSeam').checked;};
  $('showSeats').onchange=$('hideSeatsBelow').onchange=()=>updateHallVisibility(hall,camera,$('showSeats').checked,$('hideSeatsBelow').checked);
  $('toggleParameters').onclick=()=>setParametersVisible($('mappingParameters').hidden);
  document.querySelectorAll('.control').forEach(el=>{
    const input=el.querySelector('input');input.addEventListener('pointerdown',remember);
    input.addEventListener('keydown',e=>{if(e.key.startsWith('Arrow'))remember();});
    input.oninput=()=>{params[el.dataset.key]=+input.value;updateAll();};
  });
  $('fitWidth').onclick=()=>{remember();params.fov=model.horizontalFov;params.scaleX=1;params.offsetX=0;updateAll();toast('已按完整幕面视域对齐宽度，纵向参数保留');};
  $('fitHeight').onclick=()=>{
    remember();const elev=Object.values(model.screens).flatMap(s=>s.vertices).map(p=>{
      const d=p.map((v,i)=>v-model.eye[i]);return Math.atan2(d[2],Math.hypot(d[0],d[1]));
    }),min=Math.min(...elev),max=Math.max(...elev),span=(max-min)/.96;
    params.scaleY=span/(params.fov*Math.PI/180/aspect());params.offsetY=.98+min/span-params.horizon;updateAll();
    toast('纵向已覆盖两块幕；已有局部网格变形保留');
  };
  $('humanProjection').onclick=applyEyeProjection;
  for(const [id,view] of [['viewOrbit','orbit'],['viewEye','eye'],['viewTop','top'],['viewUnder','under']])$(id).onclick=()=>setView(view);
  $('openViewSettings').onclick=()=>{
    syncViewControls();
    $('viewDialog').open?$('viewDialog').close():$('viewDialog').show();
  };
  document.querySelectorAll('.view-control').forEach(el=>{
    for(const input of el.querySelectorAll('input')){
      input.oninput=()=>{
        if(input.value!==''&&Number.isFinite(input.valueAsNumber))viewer.setAngles({[el.dataset.viewKey]:input.valueAsNumber});
      };
      input.onchange=()=>{input.value=viewer.angles()[el.dataset.viewKey].toFixed(1);};
    }
  });
  $('resetView').onclick=()=>viewer.reset();
  $('play').onclick=async()=>{if(isImage()||!source)return;if(video.paused){try{await video.play();}catch(e){toast('无法播放，请使用兼容预览');}}else video.pause();};
  $('timeline').oninput=()=>{if(isImage())return;video.pause();video.currentTime=Math.min(+$('timeline').value,lastFrameTime());};
  $('prevFrame').onclick=()=>step(-1);$('nextFrame').onclick=()=>step(1);
  $('mute').onclick=()=>{video.muted=!video.muted;$('mute').textContent=video.muted?'取消静音':'静音';};
  $('loopPlayback').onclick=()=>{
    const enabled=video.loop=!video.loop;
    $('loopPlayback').classList.toggle('active',enabled);
    $('loopPlayback').setAttribute('aria-pressed',String(enabled));
    $('loopPlayback').title=enabled?'关闭循环播放':'开启循环播放';
  };
  $('outWidth').oninput=updateSizes;
  $('chooseVideo').onclick=()=>$('videoFile').click();
  $('clearMedia').onclick=clearMedia;
  $('videoFile').onchange=e=>{if(e.target.files[0])uploadMedia(e.target.files[0]).catch(e=>toast(e.message));};
  $('sourceSelect').onchange=()=>loadSource(config.sources.find(s=>s.id===$('sourceSelect').value)).catch(e=>toast(e.message));
  $('proxy').onclick=()=>makeProxy().catch(e=>toast(e.message));
  $('exportVideo').onclick=()=>startExport(false).catch(e=>toast(e.message));
  $('exportImage').onclick=()=>startExport(true).catch(e=>toast(e.message));
  $('cancelExport').onclick=()=>currentJob?.abort();
  $('saveProject').onclick=saveProject;
  $('loadProject').onclick=()=>$('projectFile').click();
  $('projectFile').onchange=e=>{if(e.target.files[0])loadProject(e.target.files[0]).catch(e=>toast(e.message));};
  $('help').onclick=()=>$('helpDialog').showModal();$('closeHelp').onclick=()=>$('helpDialog').close();
  $('openOutput').onclick=()=>{$('viewDialog').close();$('outputDialog').showModal();};
  document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
  $('toggleSource').onclick=()=>{$('sourcePanel').hidden=!$('sourcePanel').hidden;sourceOverlayDirty=true;};
  $('closeSource').onclick=()=>{$('sourcePanel').hidden=true;};
  for(const [button,panel] of [['maximizeScene','scenePanel'],['maximizeWarp','warpPanel']])$(button).onclick=()=>{
    const enlarge=!$(panel).classList.contains('maximized');
    document.querySelectorAll('.view-panel').forEach(el=>el.classList.remove('maximized'));
    if(enlarge)$(panel).classList.add('maximized');
    resize();
  };
  let splitting=false;
  const splitAt=y=>{const r=$('workspace').getBoundingClientRect();$('workspace').style.setProperty('--split',`${Math.max(20,Math.min(80,(y-r.top)/r.height*100))}%`);};
  $('splitter').onpointerdown=e=>{splitting=true;e.currentTarget.setPointerCapture(e.pointerId);e.currentTarget.classList.add('dragging');};
  $('splitter').onpointermove=e=>{if(splitting)splitAt(e.clientY);};
  $('splitter').onpointerup=$('splitter').onpointercancel=()=>{splitting=false;$('splitter').classList.remove('dragging');};
  $('splitter').onkeydown=e=>{if(['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();splitAt($('splitter').getBoundingClientRect().top+(e.key==='ArrowUp'?-20:20));}};
  window.addEventListener('keydown',e=>{
    if(e.key==='Escape'){$('viewDialog').close();document.querySelectorAll('.maximized').forEach(el=>el.classList.remove('maximized'));resize();}
    if(e.target.matches('input,select,textarea'))return;
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();}
    if(e.code==='Space'){e.preventDefault();$('play').click();}
  });
  video.onloadedmetadata=()=>{
    if(isImage()||!source)return;
    $('timeline').max=lastFrameTime();$('sourceEmpty').style.display='none';
    if(texture)texture.dispose();texture=new THREE.VideoTexture(video);texture.colorSpace=THREE.NoColorSpace;
    texture.minFilter=THREE.LinearFilter;texture.magFilter=THREE.LinearFilter;warpMaterial.uniforms.sourceTex.value=texture;
    video.currentTime=Math.min(video.duration*.28,1.5);resize();updateAll();
  };
  video.onerror=()=>{if(isImage()||!source)return;if(!proxyBusy&&!proxyTried){toast('浏览器无法直接解码该素材，正在准备兼容预览');makeProxy().catch(e=>toast(e.message));}
    else if(!proxyBusy)toast('预览解码失败，请重新选择视频或重试兼容预览');};
}
function lastFrameTime(){return source&&!isImage()?Math.max(0,(source.frames-1)/source.fps):0;}
function step(n){if(!source||isImage())return;video.pause();video.currentTime=Math.min(Math.max(0,video.currentTime+n/source.fps),lastFrameTime());}
function setView(view){viewer.setMode(view);}
function setParametersVisible(visible){
  $('mappingParameters').hidden=!visible;
  $('toggleParameters').classList.toggle('active',visible);
  $('toggleParameters').setAttribute('aria-pressed',String(visible));
  $('toggleParameters').title=visible?'收起右侧参数菜单':'展开右侧参数菜单';
  resize();
}
function syncViewControls(){
  if(!viewer)return;
  $('reverseLookX').checked=viewer.reverseHorizontal;
  ['Orbit','Eye','Top','Under'].forEach(v=>{
    const active=v.toLowerCase()===viewer.mode;
    $('view'+v).classList.toggle('active',active);$('view'+v).setAttribute('aria-pressed',String(active));
  });
  if(eyeDot)eyeDot.visible=viewer.mode!=='eye';
  const angles=viewer.angles();
  document.querySelectorAll('.view-control').forEach(el=>{
    const value=angles[el.dataset.viewKey];
    for(const input of el.querySelectorAll('input'))if(document.activeElement!==input)input.value=value.toFixed(1);
  });
}
function applyEyeProjection(){
  remember();params=eyeProjection(eyePreset.parameters,aspect());
  grid=makeGrid(grid.nx,grid.ny);
  updateAll();setView('eye');viewer.reset();
  toast('已载入人眼投射，网格已复位；可撤销');
}
async function loadSource(s){
  if(!s)return;previewAbort?.abort();if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=null;source=s;sourceSerial++;video.pause();proxyBusy=false;proxyTried=false;
  const serial=sourceSerial;
  video.removeAttribute('src');video.load();
  $('stillImage').removeAttribute('src');
  syncMediaControls();
  $('sourceName').textContent=s.name;$('sourceSize').textContent=`${s.width} × ${s.height}`;
  $('outWidth').value=isImage()?s.width:s.width+s.width%2;$('sourceSelect').value=s.id;
  currentSourceUrl=s.url;resize();updateAll();
  $('sourceEmpty').style.display='grid';$('sourceEmpty').textContent='正在载入素材…';
  if(isImage()){
    const image=new Image();image.src=currentSourceUrl;
    try{await image.decode();}
    catch(e){if(serial!==sourceSerial)return;$('sourceEmpty').textContent='图片预览失败，请重新导入';throw Error('无法载入图片预览');}
    if(serial!==sourceSerial)return;
    $('stillImage').src=image.src;$('sourceEmpty').style.display='none';
    if(texture)texture.dispose();texture=new THREE.Texture(image);texture.needsUpdate=true;
    texture.colorSpace=THREE.NoColorSpace;texture.minFilter=THREE.LinearFilter;texture.magFilter=THREE.LinearFilter;
    warpMaterial.uniforms.sourceTex.value=texture;resize();updateAll();
    toast(`已载入图片 ${s.width}×${s.height}，映射参数保留`);return;
  }
  video.src=currentSourceUrl;video.load();toast(`已载入 ${s.width}×${s.height} · ${s.fps.toFixed(2)} fps，映射参数保留`);
}
function syncMediaControls(){
  const still=isImage(),empty=!source;
  for(const id of ['play','prevFrame','nextFrame','timeline','mute','proxy','loopPlayback'])$(id).disabled=still||empty;
  $('clearMedia').disabled=(empty&&!sampleAbort)||!!currentJob;
  $('chooseVideo').disabled=$('sourceSelect').disabled=!!currentJob;
  video.hidden=still;$('stillImage').hidden=!still;
  $('proxy').hidden=still;$('exportVideo').hidden=still;$('bitrateSetting').hidden=still;
  $('exportVideo').disabled=!!currentJob||still||empty;$('exportImage').disabled=!!currentJob||empty;
  $('exportImage').textContent=still?'输出图片':'输出当前帧';
  $('outWidth').step=still?'1':'2';
  if(still){$('timecode').textContent='静态图片';$('timeline').value=0;$('play').textContent='▶';}
}
function sourceOptions(){
  $('sourceSelect').replaceChildren(new Option('未选择素材',''),...config.sources.map(s=>{const o=document.createElement('option');o.value=s.id;o.textContent=s.name;return o;}));
}
async function uploadMedia(file){
  if(currentJob)return;
  sampleAbort?.abort();sampleAbort=null;sourceSerial++;
  $('chooseVideo').disabled=true;toast('正在读取本地素材…');
  try{const data=await importMedia(file);config.sources.push(data);sourceOptions();await loadSource(data);}
  finally{$('chooseVideo').disabled=false;$('videoFile').value='';}
}
async function preloadSample(){
  const abort=sampleAbort=new AbortController(),serial=sourceSerial;
  $('sourceName').textContent='正在载入 21-9…';$('clearMedia').disabled=false;
  try{
    const response=await fetch(new URL('./samples/21-9-h264.mp4',import.meta.url),{signal:abort.signal});
    if(!response.ok)throw Error('测试视频暂时无法载入，可自行导入素材');
    const file=new File([await response.blob()],'21-9.mp4',{type:'video/mp4'});
    if(abort.signal.aborted||serial!==sourceSerial)return;
    const data=await importMedia(file);
    if(abort.signal.aborted||serial!==sourceSerial){URL.revokeObjectURL(data.url);return;}
    config.sources.push(data);sourceOptions();await loadSource(data);
  }catch(e){
    if(!abort.signal.aborted&&serial===sourceSerial){
      $('sourceName').textContent='未选择素材';toast(e.message);
    }
  }finally{
    if(sampleAbort===abort){sampleAbort=null;$('clearMedia').disabled=!source||!!currentJob;}
  }
}
async function makeProxy(){
  if(!source||isImage()||proxyBusy)return;
  proxyBusy=true;proxyTried=true;$('proxy').disabled=true;
  const serial=sourceSerial,abort=previewAbort=new AbortController();
  try{
    const url=await compatiblePreview(source,abort.signal,p=>{if(serial===sourceSerial)$('status').textContent=`兼容预览 ${Math.round(p*100)}%`;});
    if(serial!==sourceSerial){URL.revokeObjectURL(url);return;}
    previewUrl=url;video.src=url;video.load();toast('兼容预览已就绪，导出仍读取原始文件');
  }catch(e){if(e.name!=='AbortError')throw e;}
  finally{if(serial===sourceSerial){proxyBusy=false;$('proxy').disabled=false;}}
}
const even=n=>Math.max(2,Math.round(n/2)*2);
function dimensions(kind,width){
  const s=model.screens,height=n=>isImage()?Math.max(1,Math.round(n)):even(n);
  if(kind==='warp')return [width,height(width/aspect())];
  if(kind==='combined')return [width,height(width*(s.roof.physical[1]+s.wrap.physical[1])/s.wrap.physical[0])];
  return [width,height(width*s[kind].physical[1]/s[kind].physical[0])];
}
function updateSizes(){
  if(!model)return;let w=+$('outWidth').value||source?.width||4398;if(!isImage())w+=w%2;
  for(const k of kinds)$('size'+k[0].toUpperCase()+k.slice(1)).textContent=dimensions(k,w).join(' × ');
}
async function startExport(image){
  if(!source)throw Error('请先导入图片或视频');if(currentJob)throw Error('请等待当前导出完成');
  if(isImage()&&!image)throw Error('静态图片请使用“输出图片”');
  const selectedKinds=[...document.querySelectorAll('input[name=kind]:checked')].map(e=>e.value);
  if(!selectedKinds.length)throw Error('至少选择一种输出规格');
  // Request the destination in the click gesture, before worker/codec awaits.
  let directory=null;
  if($('saveToFolder').checked&&window.showDirectoryPicker){
    try{directory=await window.showDirectoryPicker({mode:'readwrite',id:'dual-screen-exports'});}
    catch(e){if(e.name==='AbortError')return;throw Error('无法打开输出文件夹；可以关闭文件夹输出后下载小文件');}
  }
  video.pause();previewAbort?.abort();
  const abort=currentJob=new AbortController();
  const snapshot=state(),exportSource=source;
  for(const url of exportUrls)URL.revokeObjectURL(url);exportUrls=[];$('exportFiles').replaceChildren();
  $('exportProgress').hidden=false;$('cancelExport').hidden=false;$('progress').value=0;$('progressText').textContent='准备导出…';syncMediaControls();
  try{
    await exportMedia({source:exportSource,model,state:snapshot,kinds:selectedKinds,width:+$('outWidth').value,
      bitrate:+$('bitrate').value,image,start:image&&!isImage()?Math.min(video.currentTime,lastFrameTime()):0,
      dimensions,directory,signal:abort.signal,
      onProgress:(value,stage)=>{$('progress').value=value;$('progressText').textContent=stage;},
      onFile:f=>{
        const a=document.createElement(f.url?'a':'div');a.textContent=`${f.url?'↓':'✓'} ${f.name}`;
        if(f.url){a.href=f.url;a.download=f.name;exportUrls.push(f.url);}
        $('exportFiles').append(a);
      }});
    toast(directory?'导出完成，已写入所选文件夹':'导出完成，请点击文件名下载');
  }catch(e){
    const message=e.name==='AbortError'||abort.signal.aborted?'已取消导出':e.message;
    $('progressText').textContent=message;toast(message);
  }finally{currentJob=null;syncMediaControls();$('cancelExport').hidden=true;}
}
function saveProject(){
  const payload={version:3,title:'双幕映射工程',modelCapturedAt:model.capturedAt,source:source?{name:source.name,width:source.width,height:source.height,kind:source.kind||'video'}:null,
    state:state(),view:viewer.save(),editor:{protect:$('protect').checked,boundary:$('lockBoundary').checked,symmetry:$('mirrorEdit').checked,snap:$('snapPoints').checked,region:$('editRegion').value,showSeam:$('showSeam').checked,showSeats:$('showSeats').checked,hideSeatsBelow:$('hideSeatsBelow').checked,influence:+$('influence').value,selected,line,editMode,activeNode},
    panel:{parameters:!$('mappingParameters').hidden},output:{width:+$('outWidth').value,bitrate:+$('bitrate').value}};
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download='双幕映射工程.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),5000);toast('工程已保存，素材保留在原位置');
}
async function loadProject(file){
  const data=JSON.parse(await file.text());
  if(![1,2,3].includes(data.version)||!data.state||!validGrid(data.state.grid))throw Error('工程格式无效或网格发生翻折');
  const p=data.state.projection;
  if(!['fov','scaleX','scaleY','offsetX','offsetY','horizon'].every(k=>Number.isFinite(p[k]))||p.scaleX<=0||p.scaleY<=0)throw Error('工程投射参数无效');
  remember();restore(data.state);
  $('mirrorEdit').checked=data.editor?.symmetry??true;
  $('snapPoints').checked=data.editor?.snap??true;
  $('editRegion').value=grid.seam&&['roof','wrap'].includes(data.editor?.region)?data.editor.region:'both';
  $('showSeam').checked=data.editor?.showSeam??true;seamLine.visible=$('showSeam').checked;
  $('showSeats').checked=data.editor?.showSeats??true;$('hideSeatsBelow').checked=data.editor?.hideSeatsBelow??true;
  if(data.editor){$('protect').checked=!!data.editor.protect;$('lockBoundary').checked=!!data.editor.boundary;
    $('influence').value=data.editor.influence||1.5;selected=data.editor.selected||[.5,.5];line=data.editor.line||{kind:'row',index:3};
    editMode=['point','row','col'].includes(data.editor.editMode)?data.editor.editMode:'point';
    activeNode=Math.max(0,Math.min(grid.nodes.length-1,data.editor.activeNode??Math.floor(grid.nodes.length/2)));}
  if(data.output){$('outWidth').value=data.output.width;$('bitrate').value=data.output.bitrate;}
  if(data.view)viewer.load(data.view);
  setParametersVisible(data.panel?.parameters??true);
  updateAll();toast('映射工程已打开；请确认当前素材是否对应');
}
async function main(){
  [config,eyePreset,seatsData]=await Promise.all([api(new URL('./scene.json',import.meta.url)).then(scene=>({scene,sources:[]})),api(new URL('./eye-preset.json',import.meta.url)),api(new URL('./seats.json',import.meta.url))]);
  model=config.scene;params=defaultParams();
  setupRenderers();initInteractions();sourceOptions();syncMediaControls();
  $('folderOption').hidden=!window.showDirectoryPicker;$('saveToFolder').checked=!!window.showDirectoryPicker;
  preloadSample();
  // Expose deterministic geometry and state for integration verification.
  window.mappingStudio={getState:state,setState:restore,getModel:()=>model,getSource:()=>source,
    getMarker:()=>({visible:marker.visible,world:marker.position.toArray(),source:selected}),
    getMarkerScreen:()=>{const p=marker.position.clone().project(camera),r=$('sceneCanvas').getBoundingClientRect();return [r.left+(p.x+1)*r.width/2,r.top+(1-p.y)*r.height/2];},
    setPoint:p=>{selected=p;updateAll();},setView,projection,forward,moveLine,
    getEditor:()=>({viewRect,activeNode,editMode,handles:handleHits,editorView,snapGuides,region:$('editRegion').value}),
    getSceneInfo:()=>({camera:camera.position.toArray(),direction:camera.getWorldDirection(new THREE.Vector3()).toArray(),view:viewer.save(),angles:viewer.angles(),orbitEnabled:orbit.enabled,children:scene.children.map(c=>({type:c.type,geometry:c.geometry?.type,key:c.userData.key})),minPolar:orbit.minPolarAngle,maxPolar:orbit.maxPolarAngle,
      seam:{visible:seamLine.visible,segments:seamLine.geometry.attributes.instanceStart.count,width:seamLine.material.linewidth},
      floor:{height:FLOOR_HEIGHT,side:hall.floor.material.side,triangles:hall.floor.geometry.attributes.position.count/3},
      seats:{count:hall.count,rows:hall.rows,visible:hall.seats.visible,show:$('showSeats').checked,hideBelow:$('hideSeatsBelow').checked}}),
    renderers:()=>({renderer,warpRenderer})};
}
main().catch(e=>{console.error(e);toast('启动失败：'+e.message);$('sourceEmpty').textContent='启动失败，请检查浏览器支持 WebGL 2，并刷新重试';});
