import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';

const rad=THREE.MathUtils.degToRad,deg=THREE.MathUtils.radToDeg;
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const yaw=v=>((v+180)%360+360)%360-180;
const direction=(h,p)=>new THREE.Vector3(Math.sin(rad(h))*Math.cos(rad(p)),
  -Math.cos(rad(h))*Math.cos(rad(p)),Math.sin(rad(p)));
const vector=v=>Array.isArray(v)&&v.length===3&&v.every(n=>Number.isFinite(n)&&Math.abs(n)<10000);

// Three.js 0.180's horizontal rotation hook leaves vertical rotation, pan and
// dolly unchanged. Keep the adapter here instead of modifying the vendor files.
class HorizontalOrbitControls extends OrbitControls {
  _rotateLeft(angle){super._rotateLeft(this.reverseHorizontal?-angle:angle);}
}

// Observation is independent of the projection eye and the source-to-screen map.
export class ViewControls {
  constructor(camera,canvas,eye,defaults,onChange){
    this.camera=camera;this.canvas=canvas;this.eye=new THREE.Vector3(...eye);
    // Observation height is independent of the source-to-screen projection eye.
    this.eye.z=defaults.heightMeters??1.5;
    this.defaults={yaw:defaults.yaw,pitch:defaults.pitch,hfov:defaults.horizontalFov};
    this.head={...this.defaults};this.mode='orbit';this.editing=false;this.look=null;
    this.freeHFov=null;this.onChange=onChange;this.reverseHorizontal=true;
    const orbit=this.orbit=new HorizontalOrbitControls(camera,canvas);
    orbit.reverseHorizontal=true;
    orbit.enableDamping=true;orbit.dampingFactor=.09;orbit.minDistance=.15;orbit.maxDistance=90;
    orbit.minPolarAngle=0;orbit.maxPolarAngle=Math.PI;
    camera.position.set(12,17,10);orbit.target.set(0,3.5,2.3);orbit.update();
    orbit.addEventListener('change',()=>this.onChange?.());
    canvas.addEventListener('pointerdown',e=>{
      if(this.mode!=='eye'||this.editing||e.button!==0||this.look)return;
      e.preventDefault();canvas.setPointerCapture(e.pointerId);
      this.look={id:e.pointerId,x:e.clientX,y:e.clientY,...this.head};
      canvas.style.cursor='grabbing';
    });
    canvas.addEventListener('pointermove',e=>{
      if(!this.look||e.pointerId!==this.look.id)return;
      const r=canvas.getBoundingClientRect(),s=this.look;
      // Drag the view like a panorama. Sensitivity follows the visible field.
      this.setAngles({yaw:s.yaw-(e.clientX-s.x)*s.hfov/r.width*(this.reverseHorizontal?-1:1),
        pitch:s.pitch+(e.clientY-s.y)*camera.fov/r.height});
    });
    for(const event of ['pointerup','pointercancel','lostpointercapture'])
      canvas.addEventListener(event,e=>{if(e.pointerId===this.look?.id)this.endLook();});
    canvas.addEventListener('contextmenu',e=>{if(this.mode==='eye')e.preventDefault();});
    // Zoom the field of view, keeping the observation position and direction fixed.
    canvas.addEventListener('wheel',e=>{
      if(this.mode!=='eye')return;
      e.preventDefault();
      const pixels=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?canvas.clientHeight:1);
      this.setAngles({hfov:this.head.hfov+pixels*.04});
    },{passive:false});
    window.addEventListener('blur',()=>this.endLook());
  }
  endLook(){
    const id=this.look?.id;this.look=null;
    if(id!==undefined&&this.canvas.hasPointerCapture(id))this.canvas.releasePointerCapture(id);
    this.canvas.style.cursor=this.editing?'crosshair':this.mode==='eye'?'grab':'default';
  }
  flushOrbit(){
    if(this.mode==='eye')return;
    this.orbit.enableDamping=false;this.orbit.update();this.orbit.enableDamping=true;
  }
  setEditing(editing){
    this.endLook();this.flushOrbit();this.editing=editing;
    this.orbit.enabled=this.mode!=='eye'&&!editing;this.endLook();
  }
  setReverseHorizontal(enabled){
    this.endLook();this.flushOrbit();
    this.reverseHorizontal=!!enabled;this.orbit.reverseHorizontal=this.reverseHorizontal;
    this.onChange?.();
  }
  setMode(mode){
    if(!['orbit','eye','top','under'].includes(mode))return;
    this.endLook();this.flushOrbit();this.mode=mode;
    const c=this.camera,o=this.orbit;c.up.set(0,0,1);
    if(mode==='eye')this.applyEye();
    else{
      this.freeHFov=null;
      if(mode==='orbit'){c.position.set(12,17,10);o.target.set(0,3.5,2.3);}
      if(mode==='top'){c.position.set(0,4,34);c.up.set(0,-1,0);o.target.set(0,4,0);}
      if(mode==='under'){c.position.set(0,12,-9);o.target.set(0,3.5,5.25);}
      o.update();
    }
    o.enabled=mode!=='eye'&&!this.editing;
    this.resize();this.endLook();this.onChange?.();
  }
  applyEye(){
    const c=this.camera;c.position.copy(this.eye);c.up.set(0,0,1);
    c.lookAt(this.eye.clone().add(direction(this.head.yaw,this.head.pitch)));
    c.updateMatrixWorld();
  }
  resize(){
    const c=this.camera,h=this.mode==='eye'?this.head.hfov:this.freeHFov;
    c.fov=h===null?55:deg(2*Math.atan(Math.tan(rad(h)/2)/c.aspect));
    c.updateProjectionMatrix();this.onChange?.();
  }
  angles(){
    if(this.mode==='eye')return {...this.head};
    const d=this.camera.getWorldDirection(new THREE.Vector3());
    return {yaw:yaw(deg(Math.atan2(d.x,-d.y))),pitch:deg(Math.asin(clamp(d.z,-1,1))),
      hfov:deg(2*Math.atan(Math.tan(rad(this.camera.fov)/2)*this.camera.aspect))};
  }
  setAngles(values){
    this.flushOrbit();
    const next=this.angles();
    if(Number.isFinite(values.yaw))next.yaw=yaw(values.yaw);
    if(Number.isFinite(values.pitch))next.pitch=clamp(values.pitch,-89,89);
    if(Number.isFinite(values.hfov))next.hfov=clamp(values.hfov,20,150);
    if(this.mode==='eye'){this.head=next;this.applyEye();}
    else{
      // Turn in place when using numeric view controls, even in the free view.
      if(Number.isFinite(values.yaw)||Number.isFinite(values.pitch)){
        const distance=this.camera.position.distanceTo(this.orbit.target);
        this.camera.up.set(0,0,1);
        this.orbit.target.copy(this.camera.position).addScaledVector(direction(next.yaw,next.pitch),distance);
        this.orbit.update();
      }
      if(Number.isFinite(values.hfov))this.freeHFov=next.hfov;
    }
    this.resize();this.onChange?.();
  }
  reset(){this.setAngles(this.defaults);}
  update(){
    if(this.mode==='eye')this.applyEye();
    else if(!this.editing)this.orbit.update();
  }
  save(){
    return {mode:this.mode,head:{...this.head},freeHFov:this.freeHFov,reverseHorizontal:this.reverseHorizontal,
      position:this.camera.position.toArray(),target:this.orbit.target.toArray(),up:this.camera.up.toArray()};
  }
  load(data){
    if(!data||!['orbit','eye','top','under'].includes(data.mode))return;
    this.setReverseHorizontal(data.reverseHorizontal===true);
    this.head={...this.defaults};
    for(const k of ['yaw','pitch','hfov'])if(Number.isFinite(data.head?.[k]))this.head[k]=data.head[k];
    this.head.yaw=yaw(this.head.yaw);this.head.pitch=clamp(this.head.pitch,-89,89);this.head.hfov=clamp(this.head.hfov,20,150);
    this.setMode(data.mode);
    if(data.mode!=='eye'&&vector(data.position)&&vector(data.target)){
      this.camera.position.fromArray(data.position);this.orbit.target.fromArray(data.target);
      if(vector(data.up)&&new THREE.Vector3(...data.up).length()>.01)this.camera.up.fromArray(data.up).normalize();
      this.freeHFov=Number.isFinite(data.freeHFov)?clamp(data.freeHFov,20,150):null;
      this.orbit.update();this.resize();
    }
    this.onChange?.();
  }
}

// Convert Blender's bottom-left UV convention to the app's top-left convention.
// Conversion uses the actual input aspect, including nonstandard video sizes.
export function eyeProjection(p,aspect){
  return {fov:p['水平视域（度）'],scaleX:p['横向缩放'],
    scaleY:p['垂直视域（度）']*p['纵向缩放']/(p['水平视域（度）']/aspect),
    offsetX:-p['水平偏移']/p['横向缩放'],offsetY:p['垂直偏移']/p['纵向缩放'],
    horizon:p['地平线位置（从上到下%）']/100};
}
