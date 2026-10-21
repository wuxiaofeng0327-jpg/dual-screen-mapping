import * as THREE from 'three';

export const FLOOR_HEIGHT=0;

// Preview-only furnishings. They never join the projection/picking meshes.
export function createHall(model,data){
  const group=new THREE.Group();group.name='影院环境';
  const roof=model.screens.roof,back=Math.max(...roof.vertices.map(p=>p[1]));
  const rear=Math.max(back,data.bounds[1][1]+1,model.eye[1]+1);
  // Reuse the actual rounded screen footprint and extend its rear edge behind
  // the last seat row. Winding is explicitly upward for back-face culling.
  const points=roof.vertices.map(p=>[p[0],Math.abs(p[1]-back)<1e-4?rear:p[1],FLOOR_HEIGHT]);
  const positions=[];
  for(const t of roof.triangles){
    let [a,b,c]=t.vertices.map(i=>points[i]);
    const cross=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    if(Math.abs(cross)<1e-10)continue;
    if(cross<0)[b,c]=[c,b];
    positions.push(...a,...b,...c);
  }
  const fg=new THREE.BufferGeometry();
  fg.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));fg.computeVertexNormals();
  const floor=new THREE.Mesh(fg,new THREE.MeshBasicMaterial({
    color:new THREE.Color().setRGB(.20,.20,.20,THREE.LinearSRGBColorSpace),
    side:THREE.FrontSide,transparent:false,depthWrite:true
  }));
  floor.name='单面地面';floor.userData.key='floor';group.add(floor);

  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(data.positions,3));
  geometry.setAttribute('normal',new THREE.Float32BufferAttribute(data.normals,3));
  const palette=data.materials.map(m=>new THREE.Color(...m.color).convertLinearToSRGB());
  geometry.setAttribute('color',new THREE.Float32BufferAttribute(data.materialIndices.flatMap(i=>palette[i].toArray()),3));
  const seats=new THREE.InstancedMesh(geometry,new THREE.MeshLambertMaterial({vertexColors:true}),data.instances.length);
  seats.name='影院座椅';seats.userData.key='seats';
  data.instances.forEach((item,i)=>seats.setMatrixAt(i,new THREE.Matrix4().fromArray(item.matrix)));
  seats.instanceMatrix.needsUpdate=true;seats.computeBoundingBox();seats.computeBoundingSphere();group.add(seats);
  group.add(new THREE.AmbientLight(0xffffff,.9));
  const light=new THREE.DirectionalLight(0xffffff,.8);light.position.set(-5,-3,12);group.add(light);
  return {group,floor,seats,count:data.instances.length,rows:new Set(data.instances.map(i=>i.row)).size};
}

export function updateHallVisibility(hall,camera,showSeats,hideBelow){
  if(hall)hall.seats.visible=showSeats&&!(hideBelow&&camera.position.z<FLOOR_HEIGHT);
}
