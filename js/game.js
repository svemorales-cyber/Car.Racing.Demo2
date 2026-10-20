import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js';

// The controls (key bindings, input state, car driving physics) are written in C++
// (controls/controls.cpp) and compiled to WebAssembly.
let ctl;
try{
 const bytes=await (await fetch(new URL('../controls/controls.wasm',import.meta.url))).arrayBuffer();
 ctl=(await WebAssembly.instantiate(bytes,{env:{sin:Math.sin,cos:Math.cos,exp:Math.exp}})).instance.exports;
}catch(e){
 document.getElementById('loading').textContent='Не може да се зареди controls/controls.wasm. Пусни играта през уеб сървър (виж README).';
 throw e;
}

const $=id=>document.getElementById(id);
const store={
 get(k){try{return JSON.parse(localStorage.getItem(k))}catch(e){return null}},
 set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
};
const settings=Object.assign({laps:3,diff:1,tod:'day',weather:'dry',music:1},store.get('kod-settings')||{});
if(![1,3,5].includes(settings.laps))settings.laps=3;
if(![0,1,2].includes(settings.diff))settings.diff=1;
if(!['day','sunset','night'].includes(settings.tod))settings.tod='day';
if(!['dry','rain'].includes(settings.weather))settings.weather='dry';
if(![0,1].includes(settings.music))settings.music=1;
const isRain=()=>settings.weather==='rain';
const rand=(a,b)=>a+Math.random()*(b-a);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const isTouch=matchMedia('(pointer:coarse)').matches||'ontouchstart' in window;
if(isTouch)document.body.classList.add('touch');

// ---------- renderer / scene ----------
const scene=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(64,innerWidth/innerHeight,.5,2500);
const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.setSize(innerWidth,innerHeight);
renderer.shadowMap.enabled=true;
renderer.shadowMap.type=THREE.PCFSoftShadowMap;
$('game').prepend(renderer.domElement);
const maxAniso=renderer.capabilities.getMaxAnisotropy();

const hemi=new THREE.HemisphereLight(0xcfeaff,0x334422,1.8);scene.add(hemi);
const sun=new THREE.DirectionalLight(0xffffff,3);
sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);sun.shadow.bias=-.0004;
Object.assign(sun.shadow.camera,{left:-70,right:70,top:70,bottom:-70,near:1,far:600});
scene.add(sun,sun.target);
scene.fog=new THREE.Fog(0xbfe3f5,200,900);

function canvasTex(w,h,draw,repeat=true){
 const c=document.createElement('canvas');c.width=w;c.height=h;draw(c.getContext('2d'),w,h);
 const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=maxAniso;
 if(repeat){t.wrapS=t.wrapT=THREE.RepeatWrapping}
 return t;
}
const glowTex=canvasTex(64,64,(g,w,h)=>{const r=g.createRadialGradient(32,32,0,32,32,32);r.addColorStop(0,'#fff');r.addColorStop(.35,'#fffc');r.addColorStop(1,'#fff0');g.fillStyle=r;g.fillRect(0,0,w,h)},false);

// ---------- sky ----------
const skyMat=new THREE.ShaderMaterial({
 side:THREE.BackSide,depthWrite:false,fog:false,
 uniforms:{top:{value:new THREE.Color()},bottom:{value:new THREE.Color()}},
 vertexShader:'varying vec3 vP;void main(){vP=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
 fragmentShader:'uniform vec3 top;uniform vec3 bottom;varying vec3 vP;void main(){float h=clamp(vP.y*1.6+.08,0.,1.);gl_FragColor=vec4(mix(bottom,top,pow(h,.7)),1.);}'
});
const sky=new THREE.Mesh(new THREE.SphereGeometry(1800,32,16),skyMat);scene.add(sky);
const sunDisc=new THREE.Sprite(new THREE.SpriteMaterial({map:glowTex,color:0xfff2c0,fog:false,depthWrite:false,blending:THREE.AdditiveBlending}));
sunDisc.scale.set(260,260,1);scene.add(sunDisc);
const stars=(()=>{const n=1500,a=new Float32Array(n*3);for(let i=0;i<n;i++){const v=new THREE.Vector3(rand(-1,1),rand(.05,1),rand(-1,1)).normalize().multiplyScalar(1600);a.set([v.x,v.y,v.z],i*3)}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(a,3));
 return new THREE.Points(g,new THREE.PointsMaterial({color:0xffffff,size:2.2,sizeAttenuation:false,fog:false}))})();
scene.add(stars);

// ---------- track ----------
const CP=[[-130,-60],[-110,-150],[-20,-180],[45,-145],[75,-90],[125,-75],[170,-115],[215,-105],[235,-45],[205,25],[150,65],[150,125],[100,180],[0,160],[-65,180],[-145,140],[-180,50]];
const curve=new THREE.CatmullRomCurve3(CP.map(([x,z])=>new THREE.Vector3(x,0,z)),true,'centripetal');
const N=1000;
const P=curve.getSpacedPoints(N).slice(0,N);
let L=0;for(let i=0;i<N;i++)L+=P[i].distanceTo(P[(i+1)%N]);
const DS=L/N;
const T=[],R=[],KS=[];
for(let i=0;i<N;i++){
 const t=P[(i+1)%N].clone().sub(P[(i-1+N)%N]).normalize();T.push(t);R.push(new THREE.Vector3(-t.z,0,t.x));
}
for(let i=0;i<N;i++){const a=T[(i-2+N)%N],b=T[(i+2)%N];KS.push((a.z*b.x-a.x*b.z)/(4*DS))} // signed curvature (<0 = right turn)
const ROAD=8,CURB=9.6,WALL=12.6;
const wrapI=i=>((i%N)+N)%N;
const wrapS=s=>((s%L)+L)%L;
function trackAt(s,lat=0){
 s=wrapS(s);const f=s/DS,i=Math.floor(f)%N,u=f-Math.floor(f),j=(i+1)%N;
 const x=P[i].x+(P[j].x-P[i].x)*u,z=P[i].z+(P[j].z-P[i].z)*u;
 const tx=T[i].x+(T[j].x-T[i].x)*u,tz=T[i].z+(T[j].z-T[i].z)*u,tl=Math.hypot(tx,tz);
 const rx=-tz/tl,rz=tx/tl;
 return {i,x:x+rx*lat,z:z+rz*lat,tx:tx/tl,tz:tz/tl,rx,rz,angle:Math.atan2(tx,tz)};
}
// nearest point search in a window around a hint index
function locate(x,z,hint){
 let best=null;
 const span=hint==null?N:40;
 for(let k=-span;k<=span;k++){
  const i=wrapI((hint??0)+k),j=(i+1)%N,a=P[i],b=P[j];
  const vx=b.x-a.x,vz=b.z-a.z,t=clamp(((x-a.x)*vx+(z-a.z)*vz)/(vx*vx+vz*vz),0,1);
  const px=a.x+vx*t,pz=a.z+vz*t,d=(x-px)**2+(z-pz)**2;
  if(!best||d<best.d)best={d,i,t,px,pz};
 }
 const r=R[best.i];
 return {i:best.i,s:(best.i+best.t)*DS,lat:(x-best.px)*r.x+(z-best.pz)*r.z,rx:r.x,rz:r.z,tx:T[best.i].x,tz:T[best.i].z};
}

// textures
const asphaltTex=canvasTex(256,512,(g,w,h)=>{
 g.fillStyle='#34363c';g.fillRect(0,0,w,h);
 for(let i=0;i<9000;i++){const v=40+Math.random()*40|0;g.fillStyle=`rgba(${v},${v},${v+4},.5)`;g.fillRect(Math.random()*w,Math.random()*h,2,2)}
 g.fillStyle='#2a2c31';for(let i=0;i<6;i++)g.fillRect(w*.22+rand(-8,8),0,10,h),g.fillRect(w*.72+rand(-8,8),0,10,h);
 g.fillStyle='#e8e8e8';g.fillRect(6,0,7,h);g.fillRect(w-13,0,7,h);
 g.fillStyle='#f2d45b';g.fillRect(w/2-4,0,8,h*.45);
});
asphaltTex.repeat.set(1,1);
const curbTex=canvasTex(32,64,(g,w,h)=>{g.fillStyle='#d42020';g.fillRect(0,0,w,h/2);g.fillStyle='#f4f4f4';g.fillRect(0,h/2,w,h/2)});
const grassTex=canvasTex(256,256,(g,w,h)=>{
 g.fillStyle='#3d6e2f';g.fillRect(0,0,w,h);
 for(let i=0;i<5000;i++){const v=Math.random();g.fillStyle=v<.5?'#35632a':v<.8?'#467a35':'#52853c';g.fillRect(Math.random()*w,Math.random()*h,2,3)}
});
grassTex.repeat.set(120,120);
const adTex=canvasTex(1024,64,(g,w,h)=>{
 const ads=[['KOD RACING','#1d4ed8','#fff'],['NITRO','#111','#3cf'],['DRIFT KING','#e11d48','#fff'],['TURBO','#facc15','#111']];
 ads.forEach(([t,bg,fg],k)=>{g.fillStyle=bg;g.fillRect(k*w/4,0,w/4,h);g.fillStyle=fg;g.font='bold italic 34px Arial';g.textAlign='center';g.textBaseline='middle';g.fillText(t,k*w/4+w/8,h/2+2,w/4-16)});
});
const boostTex=canvasTex(128,128,(g,w,h)=>{
 g.fillStyle='#062a4a';g.fillRect(0,0,w,h);g.strokeStyle='#3cf';g.lineWidth=14;g.lineCap='round';
 for(let k=0;k<2;k++){const y=k*64+16;g.beginPath();g.moveTo(22,y+36);g.lineTo(64,y);g.lineTo(106,y+36);g.stroke()}
});

function ribbon(o0,o1,y,vLen,mat){
 const pos=[],uv=[],idx=[];
 for(let i=0;i<=N;i++){const k=i%N,p=P[k],r=R[k],v=i*DS/vLen;
  pos.push(p.x+r.x*o0,y,p.z+r.z*o0,p.x+r.x*o1,y,p.z+r.z*o1);uv.push(0,v,1,v);
  if(i<N){const a=i*2;idx.push(a,a+1,a+2,a+1,a+3,a+2)}}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
 g.setIndex(idx);g.computeVertexNormals();
 const m=new THREE.Mesh(g,mat);m.receiveShadow=true;scene.add(m);return m;
}
function wall(off,h,uLen,mat){
 const pos=[],uv=[],idx=[];
 for(let i=0;i<=N;i++){const k=i%N,p=P[k],r=R[k],u=i*DS/uLen;
  pos.push(p.x+r.x*off,0,p.z+r.z*off,p.x+r.x*off,h,p.z+r.z*off);uv.push(u,0,u,1);
  if(i<N){const a=i*2;idx.push(a,a+2,a+1,a+1,a+2,a+3)}}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
 g.setIndex(idx);g.computeVertexNormals();
 const m=new THREE.Mesh(g,mat);m.castShadow=true;m.receiveShadow=true;scene.add(m);return m;
}
const ground=new THREE.Mesh(new THREE.PlaneGeometry(3000,3000),new THREE.MeshStandardMaterial({map:grassTex,roughness:1}));
ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;scene.add(ground);
const roadMat=new THREE.MeshStandardMaterial({map:asphaltTex,roughness:.85,polygonOffset:true,polygonOffsetFactor:-1});
const curbMat=new THREE.MeshStandardMaterial({map:curbTex,roughness:.7,polygonOffset:true,polygonOffsetFactor:-2});
ribbon(-ROAD,ROAD,.05,22,roadMat);
ribbon(-CURB,-ROAD,.07,4,curbMat);
ribbon(ROAD,CURB,.07,4,curbMat);
ribbon(-WALL,-CURB,.04,22,new THREE.MeshStandardMaterial({color:0x8a7d62,roughness:1,polygonOffset:true,polygonOffsetFactor:-1}));
ribbon(CURB,WALL,.04,22,new THREE.MeshStandardMaterial({color:0x8a7d62,roughness:1,polygonOffset:true,polygonOffsetFactor:-1}));
const wallMat=new THREE.MeshStandardMaterial({map:adTex,roughness:.6,side:THREE.DoubleSide,emissive:0xffffff,emissiveMap:adTex,emissiveIntensity:0});
wall(-WALL,1.1,60,wallMat);wall(WALL,1.1,60,wallMat);

// start line, gantry with countdown lights
const st=trackAt(0);
const checker=canvasTex(128,32,(g,w,h)=>{for(let x=0;x<16;x++)for(let y=0;y<4;y++){g.fillStyle=(x+y)%2?'#111':'#f5f5f5';g.fillRect(x*8,y*8,8,8)}},false);
const startLine=new THREE.Mesh(new THREE.PlaneGeometry(ROAD*2,3),new THREE.MeshStandardMaterial({map:checker,polygonOffset:true,polygonOffsetFactor:-3}));
startLine.rotation.order='YXZ';startLine.rotation.set(-Math.PI/2,st.angle,0);
startLine.position.set(st.x,.09,st.z);scene.add(startLine);
const gantry=new THREE.Group();gantry.position.set(st.x,0,st.z);gantry.rotation.y=st.angle;scene.add(gantry);
{const m=new THREE.MeshStandardMaterial({color:0x222831,metalness:.6,roughness:.4});
 for(const x of [-WALL-.6,WALL+.6]){const p=new THREE.Mesh(new THREE.BoxGeometry(1,9,1),m);p.position.set(x,4.5,0);p.castShadow=true;gantry.add(p)}
 const bannerTex=canvasTex(512,64,(g,w,h)=>{g.fillStyle='#0d1320';g.fillRect(0,0,w,h);g.font='bold italic 44px Arial';g.textAlign='center';g.textBaseline='middle';
  const gr=g.createLinearGradient(0,0,w,0);gr.addColorStop(0,'#3cf');gr.addColorStop(.5,'#a6f');gr.addColorStop(1,'#f4c');g.fillStyle=gr;g.fillText('KOD RACING 3D',w/2,h/2+2)},false);
 const beam=new THREE.Mesh(new THREE.BoxGeometry(WALL*2+2.2,2.2,.8),[m,m,m,m,new THREE.MeshStandardMaterial({map:bannerTex,emissive:0xffffff,emissiveMap:bannerTex,emissiveIntensity:.35}),new THREE.MeshStandardMaterial({map:bannerTex,emissive:0xffffff,emissiveMap:bannerTex,emissiveIntensity:.35})]);
 beam.position.y=9;beam.castShadow=true;gantry.add(beam);
}
const startLights=[];
for(let k=0;k<4;k++){const mat=new THREE.MeshStandardMaterial({color:0x220000,emissive:0xff0000,emissiveIntensity:0});
 const b=new THREE.Mesh(new THREE.SphereGeometry(.45,16,12),mat);b.position.set(-2.4+k*1.6,7.4,-.5);gantry.add(b);startLights.push(mat)}
function setStartLights(n,green){startLights.forEach((m,k)=>{m.emissive.set(green?0x22ff55:0xff2020);m.color.set(green?0x003300:0x220000);m.emissiveIntensity=green||k<n?3:0})}

// grandstand with crowd
{const g=new THREE.Group();const p=trackAt(-30,WALL+9);g.position.set(p.x,0,p.z);g.rotation.y=p.angle-Math.PI/2;scene.add(g);
 const crowd=canvasTex(512,64,(c,w,h)=>{c.fillStyle='#333';c.fillRect(0,0,w,h);const cols=['#e33','#3af','#fd3','#fff','#3d5','#f6c','#f80'];
  for(let i=0;i<500;i++){c.fillStyle=cols[i%cols.length];c.beginPath();c.arc(Math.random()*w,8+Math.random()*(h-10),3.5,0,7);c.fill()}});
 crowd.repeat.set(1,1);
 const seat=new THREE.MeshStandardMaterial({color:0x7a828c}),cm=new THREE.MeshStandardMaterial({map:crowd});
 for(let r=0;r<5;r++){const s=new THREE.Mesh(new THREE.BoxGeometry(60,1.2,2.4),[seat,seat,seat,seat,seat,cm]);s.position.set(0,.6+r*1.2,r*2.4);s.castShadow=s.receiveShadow=true;g.add(s)}
 const roof=new THREE.Mesh(new THREE.BoxGeometry(62,.4,14),new THREE.MeshStandardMaterial({color:0xd8dde3}));roof.position.set(0,9.5,5);roof.castShadow=true;g.add(roof);
 for(const x of [-30,0,30]){const c=new THREE.Mesh(new THREE.BoxGeometry(.5,9.5,.5),seat);c.position.set(x,4.75,11.5);g.add(c)}
}

// boost pads
const boostPads=[0.17,0.45,0.66,0.86].map((f,k)=>{
 const s=f*L,lat=[0,-3.5,3.5,0][k],p=trackAt(s,lat);
 const tex=boostTex.clone();tex.needsUpdate=true;tex.repeat.set(1,2);
 const m=new THREE.Mesh(new THREE.PlaneGeometry(4.5,8),new THREE.MeshBasicMaterial({map:tex,transparent:true,opacity:.9,polygonOffset:true,polygonOffsetFactor:-3}));
 m.rotation.order='YXZ';m.rotation.y=p.angle+Math.PI;m.rotation.x=-Math.PI/2;m.position.set(p.x,.1,p.z);scene.add(m);
 return {s,lat,tex,mesh:m};
});

// lamps (with fake light pools for the night)
const lampHeads=[],lampPools=[],lampGlows=[];
{const poleMat=new THREE.MeshStandardMaterial({color:0x4a5260,metalness:.5,roughness:.5});
 const headMat=new THREE.MeshStandardMaterial({color:0xfff4d0,emissive:0xffe2a0,emissiveIntensity:0});lampHeads.push(headMat);
 const poolMat=new THREE.MeshBasicMaterial({map:glowTex,color:0xffcf80,transparent:true,opacity:.5,blending:THREE.AdditiveBlending,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-4});lampPools.push(poolMat);
 for(let i=0;i<N;i+=34){const side=(i/34)%2?1:-1,p=trackAt(i*DS,side*(WALL+1.2)),q=trackAt(i*DS,side*(ROAD-2.5));
  const pole=new THREE.Mesh(new THREE.CylinderGeometry(.15,.2,9,8),poleMat);pole.position.set(p.x,4.5,p.z);pole.castShadow=true;scene.add(pole);
  const arm=new THREE.Mesh(new THREE.BoxGeometry(.15,.15,4),poleMat);const ax=(p.x+q.x)/2,az=(p.z+q.z)/2;
  arm.position.set(p.x+(q.x-p.x)*.35,9,p.z+(q.z-p.z)*.35);arm.lookAt(q.x,9,q.z);scene.add(arm);
  const head=new THREE.Mesh(new THREE.BoxGeometry(.8,.25,1.4),headMat);head.position.set(p.x+(q.x-p.x)*.62,8.9,p.z+(q.z-p.z)*.62);head.lookAt(q.x,8.9,q.z);scene.add(head);
  const glow=new THREE.Sprite(new THREE.SpriteMaterial({map:glowTex,color:0xffd890,transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthWrite:false}));glow.scale.set(6,6,1);glow.position.copy(head.position);scene.add(glow);lampGlows.push(glow.material);
  const pool=new THREE.Mesh(new THREE.CircleGeometry(9,24),poolMat);pool.rotation.x=-Math.PI/2;pool.position.set(ax+(q.x-ax)*.6,.12,az+(q.z-az)*.6);pool.visible=false;scene.add(pool);
 }}

// scenery: trees, buildings, mountains
function farFromTrack(x,z,min){for(let i=0;i<N;i+=4){if((P[i].x-x)**2+(P[i].z-z)**2<min*min)return false}return true}
{const trunkG=new THREE.CylinderGeometry(.35,.5,3,6),leafG=new THREE.ConeGeometry(2.6,7,7);
 const trunks=new THREE.InstancedMesh(trunkG,new THREE.MeshStandardMaterial({color:0x5b3a22}),420);
 const leaves=new THREE.InstancedMesh(leafG,new THREE.MeshStandardMaterial({color:0xffffff,flatShading:true}),420);
 trunks.castShadow=leaves.castShadow=true;
 const m=new THREE.Matrix4(),c=new THREE.Color();let n=0,tries=0;
 while(n<420&&tries<8000){tries++;const x=rand(-420,420),z=rand(-420,420);if(!farFromTrack(x,z,22))continue;
  const s=rand(.7,1.5);m.makeScale(s,s,s).setPosition(x,1.5*s,z);trunks.setMatrixAt(n,m);
  m.makeScale(s,s*rand(.85,1.2),s).setPosition(x,(3+3.5)*s,z);leaves.setMatrixAt(n,m);
  leaves.setColorAt(n,c.setHSL(rand(.25,.36),rand(.45,.65),rand(.18,.3)));n++}
 trunks.count=leaves.count=n;scene.add(trunks,leaves);
}
const windowMats=[];
{const winTex=canvasTex(64,128,(g,w,h)=>{g.fillStyle='#1a1d24';g.fillRect(0,0,w,h);for(let y=4;y<h;y+=12)for(let x=4;x<w;x+=12){g.fillStyle=Math.random()<.55?'#ffd27a':'#2a3240';g.fillRect(x,y,7,8)}});
 for(let k=0;k<55;k++){let x,z,t=0;do{const a=rand(0,Math.PI*2),r=rand(300,480);x=Math.cos(a)*r;z=Math.sin(a)*r;t++}while(!farFromTrack(x,z,40)&&t<50);
  const w=rand(14,30),h=rand(18,75),d=rand(14,30);const tex=winTex.clone();tex.needsUpdate=true;tex.repeat.set(Math.round(w/8),Math.round(h/16));
  const mat=new THREE.MeshStandardMaterial({map:tex,color:new THREE.Color().setHSL(rand(.55,.65),.1,rand(.6,.85)),emissive:0xffffff,emissiveMap:tex,emissiveIntensity:0,roughness:.6});windowMats.push(mat);
  const b=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);b.position.set(x,h/2,z);b.rotation.y=rand(0,Math.PI);b.castShadow=true;scene.add(b)}
 const mm=new THREE.MeshStandardMaterial({color:0x56645a,flatShading:true,roughness:1});
 for(let k=0;k<26;k++){const a=k/26*Math.PI*2+rand(0,.2),r=rand(850,1050),h=rand(120,280);
  const m=new THREE.Mesh(new THREE.ConeGeometry(rand(140,240),h,6),mm);m.position.set(Math.cos(a)*r,h/2-5,Math.sin(a)*r);m.rotation.y=rand(0,3);scene.add(m)}
}

// ---------- cars ----------
const NAMES=['ТИ','ВИХЪР','МЪЛНИЯ','ТИГЪР'];
const COLORS=[0x1976ff,0xff3434,0xffc928,0x20d47a];
// Car models, same order as kModels in controls.cpp (the driving numbers live there).
// w/len/h: body size, y: body centre, cab: [width, height, length, z] of the cabin, wheel: radius
const MODELS=[
 {name:'KOD GT',wins:0,desc:'Балансирана кола за начало.',w:2.1,len:4.5,h:.5,y:.62,cab:[1.62,.55,2.0,-.25],wheel:.46,wz:1.45},
 {name:'SPORT R',wins:1,desc:'По-бърза, с повече сцепление.',w:2.2,len:4.6,h:.44,y:.58,cab:[1.56,.48,1.9,-.35],wheel:.47,wz:1.5},
 {name:'DRIFT S',wins:3,desc:'Завива рязко и дрифтира лесно.',w:2.05,len:4.35,h:.54,y:.64,cab:[1.68,.6,2.15,-.4],wheel:.45,wz:1.4},
 {name:'HYPER X',wins:6,desc:'Най-бързата кола в гаража.',w:2.24,len:4.7,h:.36,y:.55,cab:[1.46,.42,1.7,-.15],wheel:.49,wz:1.55}
];
const RIMS=[
 {name:'Класика',color:0xb8c0c8,metal:.8,rough:.3,spokes:4},
 {name:'Черни',color:0x1d2024,metal:.6,rough:.35,spokes:5},
 {name:'Златни',color:0xd4a537,metal:.9,rough:.25,spokes:10},
 {name:'Неон',color:0xe8eef5,metal:1,rough:.1,spokes:6,glow:0x22d3ff}
];
const SPOILERS=['Без','Нисък','GT крило','Високо'];
function numberTex(n,col){return canvasTex(64,64,(g,w,h)=>{g.fillStyle='#fff';g.beginPath();g.arc(32,32,28,0,7);g.fill();g.fillStyle=col;g.font='bold 38px Arial';g.textAlign='center';g.textBaseline='middle';g.fillText(n,32,34)},false)}
function makeCar(color,num,opt={}){
 const M=MODELS[opt.model||0],rimStyle=RIMS[opt.rims||0],spoiler=opt.spoiler??2;
 const top=M.y+M.h/2,back=-M.len/2,[cw,ch,cl,cz]=M.cab;
 const g=new THREE.Group(),body=new THREE.Group();g.add(body);
 const paint=new THREE.MeshStandardMaterial({color,metalness:.55,roughness:.28});
 const dark=new THREE.MeshStandardMaterial({color:0x15181d,roughness:.6});
 const glass=new THREE.MeshStandardMaterial({color:0x14202c,metalness:.7,roughness:.08});
 const add=(geo,mat,x,y,z,parent=body)=>{const m=new THREE.Mesh(geo,mat);m.position.set(x,y,z);m.castShadow=true;parent.add(m);return m};
 // panels are subdivided so they can be dented locally
 const dents=[
  add(new THREE.BoxGeometry(M.w,M.h,M.len,6,2,14),paint,0,M.y,0),
  add(new THREE.BoxGeometry(M.w-.1,.22,1.3,6,1,4),paint,0,top+.08,M.len/2-.85),
  add(new THREE.BoxGeometry(cw,ch,cl,4,2,5),glass,0,top+ch/2,cz),
  add(new THREE.BoxGeometry(cw-.12,.08,cl-.4,4,1,4),paint,0,top+ch+.02,cz-.05)];
 dents[1].rotation.x=.12;
 add(new THREE.BoxGeometry(M.w+.06,.22,M.len*.71),dark,0,M.y-.24,0);
 add(new THREE.BoxGeometry(.32,.02,M.len-.1),new THREE.MeshStandardMaterial({color:0xffffff,roughness:.4}),0,top+.005,.05);
 if(spoiler===1){const lip=add(new THREE.BoxGeometry(M.w-.1,.1,.4,6,1,2),paint,0,top+.06,back+.25);lip.rotation.x=-.3;dents.push(lip)}
 if(spoiler>=2){const hi=spoiler===3,py=hi?.38:.18,wy=hi?.78:.4;
  for(const x of [-.75,.75])add(new THREE.BoxGeometry(.1,py*2+.04,.1),dark,x,top+py,back+.25);
  dents.push(add(new THREE.BoxGeometry(M.w,.08,.55,6,1,2),paint,0,top+wy,back+.2));
  if(hi)for(const x of [-M.w/2,M.w/2])add(new THREE.BoxGeometry(.06,.36,.64),dark,x,top+wy+.08,back+.2)}
 dents.forEach(m=>m.geometry.userData.orig=m.geometry.attributes.position.array.slice());
 const roofNum=new THREE.Mesh(new THREE.PlaneGeometry(.9,.9),new THREE.MeshBasicMaterial({map:numberTex(num,'#'+color.toString(16).padStart(6,'0')),transparent:true}));
 roofNum.rotation.set(-Math.PI/2,0,Math.PI);roofNum.position.set(0,top+ch+.07,cz-.05);body.add(roofNum);
 const headMat=new THREE.MeshStandardMaterial({color:0xffffff,emissive:0xfff6d8,emissiveIntensity:1.2});
 const tailMat=new THREE.MeshStandardMaterial({color:0x550000,emissive:0xff1010,emissiveIntensity:.6});
 for(const x of [-.65,.65]){add(new THREE.BoxGeometry(.45,.16,.06),headMat,x,M.y+.16,M.len/2+.01);add(new THREE.BoxGeometry(.5,.16,.06),tailMat,x,M.y+.16,back-.01)}
 const flameMat=new THREE.MeshBasicMaterial({color:0x66ccff,transparent:true,opacity:.85,blending:THREE.AdditiveBlending,depthWrite:false});
 const flames=[];
 for(const x of [-.5,.5]){const f=new THREE.Mesh(new THREE.ConeGeometry(.2,1.4,10),flameMat);f.rotation.x=-Math.PI/2;f.position.set(x,.5,back-.7);f.visible=false;body.add(f);flames.push(f)}
 // wheels: dark barrel, coloured lip and spokes
 const r=M.wheel,tireMat=new THREE.MeshStandardMaterial({color:0x111111,roughness:.9}),barrelMat=new THREE.MeshStandardMaterial({color:0x2a2d33,roughness:.6});
 const rimMat=new THREE.MeshStandardMaterial({color:rimStyle.color,metalness:rimStyle.metal,roughness:rimStyle.rough});
 const glowMat=rimStyle.glow?new THREE.MeshBasicMaterial({color:rimStyle.glow}):null;
 const spinners=[],steerers=[];
 for(const x of [-(M.w/2+.02),M.w/2+.02])for(const z of [-M.wz,M.wz]){
  const pivot=new THREE.Group();pivot.position.set(x,r,z);g.add(pivot);
  const spin=new THREE.Group();pivot.add(spin);
  const tire=new THREE.Mesh(new THREE.CylinderGeometry(r,r,.36,20),tireMat);tire.rotation.z=Math.PI/2;tire.castShadow=true;spin.add(tire);
  const barrel=new THREE.Mesh(new THREE.CylinderGeometry(r*.62,r*.62,.37,16),barrelMat);barrel.rotation.z=Math.PI/2;spin.add(barrel);
  for(const sx of [-.19,.19]){const lip=new THREE.Mesh(new THREE.TorusGeometry(r*.6,.035,6,24),glowMat||rimMat);lip.rotation.y=Math.PI/2;lip.position.x=sx;spin.add(lip)}
  const hub=new THREE.Mesh(new THREE.CylinderGeometry(r*.14,r*.14,.41,10),rimMat);hub.rotation.z=Math.PI/2;spin.add(hub);
  for(let k=0;k<rimStyle.spokes;k++){const a=k/rimStyle.spokes*Math.PI*2;
   const sp=new THREE.Mesh(new THREE.BoxGeometry(.4,rimStyle.spokes>6?.035:.07,r*.56),rimMat);
   sp.rotation.x=a;sp.position.set(0,-Math.sin(a)*r*.3,Math.cos(a)*r*.3);spin.add(sp)}
  spinners.push(spin);if(z>0)steerers.push(pivot);
 }
 return {g,body,spinners,steerers,flames,tailMat,headMat,flameMat,dents,paint};
}
const _dp=new THREE.Vector3();
function dentCar(c,wx,wy,wz,amount){
 for(const m of c.dents){
  m.updateWorldMatrix(true,false);_dp.set(wx,wy,wz);m.worldToLocal(_dp);
  const pos=m.geometry.attributes.position,a=pos.array,o=m.geometry.userData.orig;
  const len=Math.hypot(_dp.x,_dp.z)||1,ix=-_dp.x/len,iz=-_dp.z/len;
  let hit=false;
  for(let i=0;i<a.length;i+=3){
   const d=Math.hypot(a[i]-_dp.x,a[i+1]-_dp.y,a[i+2]-_dp.z);if(d>1.4)continue;
   if((a[i]-o[i])**2+(a[i+1]-o[i+1])**2+(a[i+2]-o[i+2])**2>.2)continue; // already crushed enough
   const k=amount*(1-d/1.4)**2;
   a[i]+=ix*k*.45;a[i+1]-=k*.12;a[i+2]+=iz*k*.45;hit=true;
  }
  if(hit){pos.needsUpdate=true;m.geometry.computeVertexNormals()}
 }
}
function repairCar(c){
 for(const m of c.dents){m.geometry.attributes.position.array.set(m.geometry.userData.orig);m.geometry.attributes.position.needsUpdate=true;m.geometry.computeVertexNormals()}
}
function animateCar(c,dt,speed,steer,roll,pitch,boosting,braking){
 c.spinners.forEach(s=>s.rotation.x+=speed*dt/.46);
 c.steerers.forEach(p=>p.rotation.y+=(-steer*.45-p.rotation.y)*Math.min(1,dt*12));
 c.body.rotation.z+=(roll-c.body.rotation.z)*Math.min(1,dt*6);
 c.body.rotation.x+=(pitch-c.body.rotation.x)*Math.min(1,dt*6);
 c.flames.forEach(f=>{f.visible=boosting;if(boosting){const s=rand(.8,1.4);f.scale.set(1,s,1);f.position.z=-2.6-.7*s}});
 c.flameMat.color.setHSL(rand(.52,.58),1,.6);
 c.tailMat.emissiveIntensity=braking?3:.6;
}

const player={car:makeCar(COLORS[0],1),name:NAMES[0],color:COLORS[0],x:0,z:0,angle:0,vx:0,vz:0,steer:0,nitro:0,dist:0,s:0,idx:0,lat:0,
 finished:false,finishTime:0,lapStart:0,laps:[],drift:0,driftScore:0,wrong:0,lastF:0,lastR:0,damage:0};
scene.add(player.car.g);
const headlight=new THREE.SpotLight(0xfff2d0,0,90,.55,.5,1.2);headlight.position.set(0,1,1.8);
headlight.target.position.set(0,0,25);
// ---------- garage save ----------
// money, wins and every car's colour / parts / upgrade levels, kept in localStorage
const PAINTS=[0x1976ff,0xff3434,0xffc928,0x20d47a,0xff7a1a,0xa64cff,0xff4fb8,0x18d6e8,0xf2f4f7,0x2b2f36,0x8a0f1e,0x0e3b2a];
const UPGRADES=[['engine','Двигател','⚙️','+скорост и ускорение'],['tires','Гуми','🛞','+сцепление, по-добре в дъжд'],['brakes','Спирачки','🛑','+по-късно спиране']];
const UPGRADE_COST=[400,900,1600];
const garage=(()=>{
 const g=Object.assign({money:0,wins:0,races:0,sel:0,cars:[]},store.get('kod-garage')||{});
 MODELS.forEach((m,i)=>{g.cars[i]=Object.assign({color:[0x1976ff,0xff7a1a,0xa64cff,0xf2f4f7][i],rims:i,spoiler:[2,1,3,2][i],engine:0,tires:0,brakes:0},g.cars[i]||{});
  for(const k of ['rims','spoiler'])g.cars[i][k]=clamp(g.cars[i][k]|0,0,3);
  for(const [k] of UPGRADES)g.cars[i][k]=clamp(g.cars[i][k]|0,0,3)});
 g.money=Math.max(0,g.money|0);g.wins=Math.max(0,g.wins|0);
 if(!(g.sel>=0&&g.sel<MODELS.length)||g.wins<MODELS[g.sel].wins)g.sel=0;
 return g;
})();
const saveGarage=()=>store.set('kod-garage',garage);
const unlocked=i=>garage.wins>=MODELS[i].wins;
const setupCar=i=>{const c=garage.cars[i];ctl.set_setup(i,c.engine,c.tires,c.brakes,c.spoiler)};
function buildPlayerCar(){
 const i=garage.sel,c=garage.cars[i];
 scene.remove(player.car.g);
 player.car=makeCar(c.color,1,{model:i,rims:c.rims,spoiler:c.spoiler});player.color=c.color;
 player.car.g.add(headlight,headlight.target);
 player.car.headMat.emissiveIntensity=1.2+TOD[settings.tod].night*3;
 player.car.g.position.set(player.x,0,player.z);player.car.g.rotation.y=player.angle;
 scene.add(player.car.g);
}

const bots=[1,2,3].map(k=>{const c=makeCar(COLORS[k],k+1,{model:k,rims:k-1,spoiler:[1,3,2][k-1]});scene.add(c.g);
 return {car:c,name:NAMES[k],color:COLORS[k],dist:0,lat:0,laneT:0,v:0,skill:1,offset:0,laneTimer:0,finished:false,finishTime:0,boost:0,x:0,z:0,angle:0,steer:0,damage:0}});
const cars=[player,...bots];

// bot speed profile: corner speed limit, propagated backwards for braking
function speedProfile(latAcc,top,dec){
 const v=KS.map(k=>Math.min(top,Math.sqrt(latAcc/Math.max(Math.abs(k),1e-4))));
 for(let pass=0;pass<2;pass++)for(let i=N-1;i>=0;i--){const j=(i+1)%N;v[i]=Math.min(v[i],Math.sqrt(v[j]*v[j]+2*dec*DS))}
 return v;
}
// racing line: hug the inside of corners
const lineLat=(()=>{const raw=KS.map(k=>clamp(-k*260,-5.2,5.2)),o=[];
 for(let i=0;i<N;i++){let s=0;for(let k=-25;k<=25;k++)s+=raw[wrapI(i+k)];o.push(s/51)}return o})();
const DIFF=[{lat:16,top:32,skill:[.86,.92]},{lat:20,top:38,skill:[.93,.98]},{lat:25,top:43,skill:[.98,1.03]}];
let botProfile=null,botTop=0;

// ---------- particles, skid marks ----------
const particles=[];
for(let i=0;i<280;i++){const s=new THREE.Sprite(new THREE.SpriteMaterial({map:glowTex,transparent:true,depthWrite:false,opacity:0}));s.visible=false;scene.add(s);particles.push({s,life:0,max:1,vx:0,vy:0,vz:0,grow:0})}
let pi=0;
function emit(x,y,z,vx,vy,vz,life,size,grow,color,additive=false){
 const p=particles[pi=(pi+1)%particles.length];
 p.s.position.set(x,y,z);p.s.scale.set(size,size,1);p.s.visible=true;p.s.material.color.set(color);
 p.s.material.blending=additive?THREE.AdditiveBlending:THREE.NormalBlending;
 Object.assign(p,{life,max:life,vx,vy,vz,grow});
}
function updateParticles(dt){
 for(const p of particles){if(!p.s.visible)continue;p.life-=dt;if(p.life<=0){p.s.visible=false;continue}
  p.s.position.x+=p.vx*dt;p.s.position.y+=p.vy*dt;p.s.position.z+=p.vz*dt;
  const sc=p.s.scale.x+p.grow*dt;p.s.scale.set(sc,sc,1);p.s.material.opacity=(p.life/p.max)*.6}
}
const SKIDS=1600;
const skidGeo=new THREE.PlaneGeometry(1,1);skidGeo.rotateX(-Math.PI/2);
const skids=new THREE.InstancedMesh(skidGeo,new THREE.MeshBasicMaterial({color:0x0c0c0c,transparent:true,opacity:.55,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-5}),SKIDS);
skids.frustumCulled=false;scene.add(skids);
let skidI=0;
const _m=new THREE.Matrix4(),_q=new THREE.Quaternion(),_v=new THREE.Vector3(),_s=new THREE.Vector3(),_up=new THREE.Vector3(0,1,0);
function clearSkids(){_m.makeScale(0,0,0);for(let i=0;i<SKIDS;i++)skids.setMatrixAt(i,_m);skids.instanceMatrix.needsUpdate=true}
clearSkids();
function skid(x,z,angle,len){
 _q.setFromAxisAngle(_up,angle);_m.compose(_v.set(x,.11,z),_q,_s.set(.32,1,len+.05));
 skids.setMatrixAt(skidI=(skidI+1)%SKIDS,_m);skids.instanceMatrix.needsUpdate=true;
}

// ---------- rain ----------
// wet road reflects a blurred copy of the sky
const pmrem=new THREE.PMREMGenerator(renderer);
const envScene=new THREE.Scene();
envScene.add(new THREE.Mesh(sky.geometry,skyMat));
const envSun=new THREE.Sprite(sunDisc.material);envSun.scale.set(500,500,1);envScene.add(envSun);
let envRT=null;
function skyEnv(){
 envSun.position.copy(sunDir).multiplyScalar(1500);
 if(envRT)envRT.dispose();
 envRT=pmrem.fromScene(envScene,0,1,3000);
 return envRT.texture;
}
const puddleMat=new THREE.MeshStandardMaterial({color:0x1c1e22,roughness:.03,metalness:.6,transparent:true,opacity:.85,polygonOffset:true,polygonOffsetFactor:-4});
const puddles=new THREE.Group();scene.add(puddles);
for(let k=0;k<45;k++){
 const p=trackAt(rand(0,L),rand(-6,6)),m=new THREE.Mesh(new THREE.CircleGeometry(1,20),puddleMat);
 m.rotation.x=-Math.PI/2;m.rotation.z=rand(0,3);m.scale.set(rand(1,3.2),rand(.8,1.8),1);m.position.set(p.x,.085,p.z);puddles.add(m);
}
const RAIN_N=3000,RAIN_BOX=70,RAIN_H=40;
const rainPos=new Float32Array(RAIN_N*6);
for(let i=0;i<RAIN_N;i++){const x=rand(-RAIN_BOX,RAIN_BOX),y=rand(0,RAIN_H),z=rand(-RAIN_BOX,RAIN_BOX);rainPos.set([x,y,z,x+.12,y+1.1,z],i*6)}
const rainGeo=new THREE.BufferGeometry();rainGeo.setAttribute('position',new THREE.BufferAttribute(rainPos,3));
const rainMat=new THREE.LineBasicMaterial({color:0xa8c4e0,transparent:true,opacity:.45});
const rain=new THREE.LineSegments(rainGeo,rainMat);rain.frustumCulled=false;rain.visible=false;scene.add(rain);
function updateRain(dt){
 if(!rain.visible)return;
 const fall=38*dt;
 for(let i=0;i<RAIN_N;i++){const k=i*6;let y=rainPos[k+1]-fall;if(y<0)y+=RAIN_H;rainPos[k+1]=y;rainPos[k+4]=y+1.1}
 rainGeo.attributes.position.needsUpdate=true;
 rain.position.set(camera.position.x,0,camera.position.z);
}

// ---------- audio ----------
const audio={ctx:null,muted:!!store.get('kod-muted')};
function initAudio(){
 if(audio.ctx){audio.ctx.resume();return}
 const C=window.AudioContext||window.webkitAudioContext;if(!C)return;
 const ctx=audio.ctx=new C();
 const master=audio.master=ctx.createGain();master.gain.value=audio.muted?0:.5;master.connect(ctx.destination);
 const noise=ctx.createBuffer(1,ctx.sampleRate*2,ctx.sampleRate),d=noise.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;audio.noise=noise;
 const eg=audio.engineGain=ctx.createGain();eg.gain.value=0;
 const ef=audio.engineFilter=ctx.createBiquadFilter();ef.type='lowpass';ef.frequency.value=900;ef.Q.value=4;
 audio.o1=ctx.createOscillator();audio.o1.type='sawtooth';audio.o2=ctx.createOscillator();audio.o2.type='square';audio.o2.detune.value=-1200;
 const o2g=ctx.createGain();o2g.gain.value=.5;
 audio.o1.connect(ef);audio.o2.connect(o2g).connect(ef);ef.connect(eg).connect(master);audio.o1.start();audio.o2.start();
 const loopNoise=(type,f,q)=>{const s=ctx.createBufferSource();s.buffer=noise;s.loop=true;const fl=ctx.createBiquadFilter();fl.type=type;fl.frequency.value=f;fl.Q.value=q;const g=ctx.createGain();g.gain.value=0;s.connect(fl).connect(g).connect(master);s.start();return g};
 audio.skid=loopNoise('bandpass',1400,3);audio.wind=loopNoise('highpass',700,.7);audio.rumble=loopNoise('lowpass',300,1);
 audio.rain=loopNoise('bandpass',2600,.4);
}
function setMuted(m){audio.muted=m;store.set('kod-muted',m);$('mute').textContent=m?'🔇':'🔊';if(audio.master)audio.master.gain.value=m?0:.5}
setMuted(audio.muted);
function beep(f,dur=.18,vol=.3,type='square'){if(!audio.ctx)return;const c=audio.ctx,o=c.createOscillator(),g=c.createGain();o.type=type;o.frequency.value=f;
 g.gain.setValueAtTime(vol,c.currentTime);g.gain.exponentialRampToValueAtTime(.001,c.currentTime+dur);o.connect(g).connect(audio.master);o.start();o.stop(c.currentTime+dur)}
function thud(vol){if(!audio.ctx)return;const c=audio.ctx,s=c.createBufferSource(),f=c.createBiquadFilter(),g=c.createGain();s.buffer=audio.noise;f.type='lowpass';f.frequency.value=500;
 g.gain.setValueAtTime(Math.min(1,vol),c.currentTime);g.gain.exponentialRampToValueAtTime(.001,c.currentTime+.35);s.connect(f).connect(g).connect(audio.master);s.start();s.stop(c.currentTime+.4)}
function whoosh(){if(!audio.ctx)return;const c=audio.ctx,s=c.createBufferSource(),f=c.createBiquadFilter(),g=c.createGain();s.buffer=audio.noise;f.type='bandpass';f.Q.value=2;
 f.frequency.setValueAtTime(400,c.currentTime);f.frequency.exponentialRampToValueAtTime(3000,c.currentTime+.5);g.gain.setValueAtTime(.5,c.currentTime);g.gain.exponentialRampToValueAtTime(.001,c.currentTime+.6);
 s.connect(f).connect(g).connect(audio.master);s.start();s.stop(c.currentTime+.6)}
function thunder(){if(!audio.ctx)return;const c=audio.ctx,t=c.currentTime,s=c.createBufferSource(),f=c.createBiquadFilter(),g=c.createGain();s.buffer=audio.noise;s.loop=true;f.type='lowpass';
 f.frequency.setValueAtTime(400,t);f.frequency.exponentialRampToValueAtTime(70,t+2.5);g.gain.setValueAtTime(.001,t);g.gain.exponentialRampToValueAtTime(.9,t+.08);g.gain.exponentialRampToValueAtTime(.001,t+3);
 s.connect(f).connect(g).connect(audio.master);s.start();s.stop(t+3.1)}
const GEARS=[0,9,16,23,30,37,99];
function gearOf(v){let g=1;while(g<GEARS.length-1&&v>GEARS[g])g++;return g}
function updateAudio(speed,throttle,boost,drift,grass){
 if(!audio.ctx)return;const t=audio.ctx.currentTime,v=Math.abs(speed),g=gearOf(v);
 const rpm=clamp((v-GEARS[g-1])/(GEARS[g]-GEARS[g-1]),0,1);
 const f=55+rpm*95+g*10+(boost?25:0)+(throttle&&v<1?40:0);
 audio.o1.frequency.setTargetAtTime(f,t,.05);audio.o2.frequency.setTargetAtTime(f,t,.05);
 audio.engineFilter.frequency.setTargetAtTime(500+rpm*900+(throttle?700:0),t,.08);
 audio.engineGain.gain.setTargetAtTime(state==='menu'?0:(throttle?.22:.13),t,.1);
 audio.skid.gain.setTargetAtTime(drift?clamp(drift/10,0,.35):0,t,.05);
 audio.wind.gain.setTargetAtTime(clamp((v-15)/40,0,.12)+(boost?.12:0),t,.1);
 audio.rumble.gain.setTargetAtTime(grass&&v>3?.5:0,t,.05);
 audio.rain.gain.setTargetAtTime(isRain()&&state!=='menu'?.1:0,t,.3);
}

// ---------- music ----------
// small synthwave loop, generated live: Am F C G
const music={on:false,timer:0,step:0,next:0,bus:null,intense:false};
const STEP=60/126/4;
const CHORDS=[[57,3],[53,4],[48,4],[55,4]]; // root, third
const mtof=m=>440*Math.pow(2,(m-69)/12);
function tone(type,freq,t,dur,vol,cutoff){
 const c=audio.ctx,o=c.createOscillator(),g=c.createGain(),f=c.createBiquadFilter();
 o.type=type;o.frequency.value=freq;f.type='lowpass';f.frequency.value=cutoff;
 g.gain.setValueAtTime(vol,t);g.gain.exponentialRampToValueAtTime(.001,t+dur);
 o.connect(f).connect(g).connect(music.bus);o.start(t);o.stop(t+dur+.02);
}
function noiseHit(t,dur,vol,type,freq){
 const c=audio.ctx,s=c.createBufferSource(),f=c.createBiquadFilter(),g=c.createGain();
 s.buffer=audio.noise;f.type=type;f.frequency.value=freq;
 g.gain.setValueAtTime(vol,t);g.gain.exponentialRampToValueAtTime(.001,t+dur);
 s.connect(f).connect(g).connect(music.bus);s.start(t,rand(0,1.5));s.stop(t+dur+.02);
}
function playStep(n,t){
 const c=audio.ctx,i=n%16,[root,third]=CHORDS[Math.floor(n/16)%4];
 if(i%4===0){const o=c.createOscillator(),g=c.createGain();o.frequency.setValueAtTime(140,t);o.frequency.exponentialRampToValueAtTime(42,t+.12);
  g.gain.setValueAtTime(.9,t);g.gain.exponentialRampToValueAtTime(.001,t+.3);o.connect(g).connect(music.bus);o.start(t);o.stop(t+.32)}
 if(i===4||i===12){noiseHit(t,.16,.35,'highpass',1200);tone('triangle',190,t,.1,.2,4000)}
 if(i%2===0)noiseHit(t,i%4===2?.12:.03,i%4===2?.1:.06,'highpass',7000);
 if(i%2===0)tone('sawtooth',mtof(root-24+(i%4===2?12:0)),t,STEP*1.8,.22,music.intense?900:520);
 const arp=[0,third,7,12,7,third,12,19][i%8];
 tone('square',mtof(root+arp),t,.13,music.intense?.07:.035,music.intense?3200:1800);
 if(i===0)for(const iv of [0,third,7])for(const det of [-6,6]){
  const o=c.createOscillator(),g=c.createGain(),f=c.createBiquadFilter();o.type='sawtooth';o.frequency.value=mtof(root+iv-12);o.detune.value=det;
  f.type='lowpass';f.frequency.value=900;g.gain.setValueAtTime(.001,t);g.gain.linearRampToValueAtTime(.018,t+.4);g.gain.linearRampToValueAtTime(.001,t+STEP*16);
  o.connect(f).connect(g).connect(music.bus);o.start(t);o.stop(t+STEP*16+.05)}
}
function musicTick(){
 const c=audio.ctx;
 while(music.next<c.currentTime+.15){playStep(music.step,music.next);music.next+=STEP;music.step=(music.step+1)%64}
}
function musicStart(){
 if(!audio.ctx||music.on||!settings.music)return;
 const c=audio.ctx;
 if(!music.bus){music.bus=c.createGain();music.bus.connect(audio.master)}
 music.bus.gain.cancelScheduledValues(c.currentTime);music.bus.gain.setValueAtTime(0,c.currentTime);music.bus.gain.linearRampToValueAtTime(.32,c.currentTime+2);
 music.on=true;music.step=0;music.next=c.currentTime+.1;music.timer=setInterval(musicTick,25);
}
function musicStop(){
 if(!music.on)return;
 music.on=false;clearInterval(music.timer);music.bus.gain.setTargetAtTime(0,audio.ctx.currentTime,.4);
}

// ---------- input ----------
// Order matches enum Action in controls.cpp; keys.gas etc. read and write the C++ input state.
const ACTIONS=['gas','brake','left','right','drift','boost'];
const CMD={camera:1,mute:2,respawn:3,pause:4,start:5}; // enum Command in controls.cpp
const keys={};
ACTIONS.forEach((a,i)=>Object.defineProperty(keys,a,{enumerable:true,get:()=>ctl.action_down(i)===1,set:v=>ctl.set_action(i,v?1:0)}));
const keyBuf=new Uint8Array(ctl.memory.buffer,ctl.key_buffer(),32);
function sendKey(e,down){
 const code=e.code||'',n=Math.min(code.length,31);
 for(let i=0;i<n;i++)keyBuf[i]=code.charCodeAt(i)&127;
 keyBuf[n]=0;
 return ctl.on_key(n,down?1:0,e.repeat?1:0);
}
addEventListener('keydown',e=>{
 const cmd=sendKey(e,true);if(cmd<0)return;
 e.preventDefault();
 if(cmd===CMD.camera){camMode=(camMode+1)%3;store.set('kod-cam',camMode);toast(['КАМЕРА: ПРЕСЛЕДВАНЕ','КАМЕРА: ОТДАЛЕЧ','КАМЕРА: КАПАК'][camMode])}
 if(cmd===CMD.mute)setMuted(!audio.muted);
 if(cmd===CMD.respawn&&state==='race')respawn();
 if(cmd===CMD.pause){if(state==='garage')closeGarage();else togglePause()}
 if(cmd===CMD.start&&state==='menu')startRace();
 else if(cmd===CMD.start&&state==='replay')endReplay();
});
addEventListener('keyup',e=>{if(sendKey(e,false)>=0)e.preventDefault()});
addEventListener('blur',()=>ctl.release_all());
document.querySelectorAll('[data-key]').forEach(b=>{
 const k=b.dataset.key;
 const on=e=>{e.preventDefault();keys[k]=true;b.classList.add('on')},off=e=>{e.preventDefault();keys[k]=false;b.classList.remove('on')};
 b.addEventListener('pointerdown',on);b.addEventListener('pointerup',off);b.addEventListener('pointercancel',off);b.addEventListener('pointerleave',off);
 b.addEventListener('contextmenu',e=>e.preventDefault());
});
$('mute').onclick=()=>{initAudio();setMuted(!audio.muted)};

// ---------- UI helpers ----------
let toastTimer=0;
function toast(t,color='#fff',dur=1.4){const el=$('toast');el.textContent=t;el.style.color=color;el.style.opacity=1;toastTimer=dur}
function bigMessage(html,pop=true){const m=$('message');m.innerHTML=html;m.style.display='block';if(pop){m.classList.remove('pop');void m.offsetWidth;m.classList.add('pop')}}
const fmt=t=>{if(t==null||!isFinite(t))return '—';const m=Math.floor(t/60),s=t-m*60;return (m?m+':'+(s<10?'0':''):'')+s.toFixed(2)};

// menu options
document.querySelectorAll('.seg').forEach(seg=>{
 const opt=seg.dataset.opt;
 const sync=()=>seg.querySelectorAll('button').forEach(b=>b.classList.toggle('sel',String(settings[opt])===b.dataset.v));
 seg.querySelectorAll('button').forEach(b=>b.onclick=()=>{settings[opt]=opt==='tod'||opt==='weather'?b.dataset.v:+b.dataset.v;store.set('kod-settings',settings);sync();
  if(opt==='tod'||opt==='weather')applyTimeOfDay();
  if(opt==='music'&&!settings.music)musicStop();
  showBest()});
 sync();
});
const bestKey=()=>'kod-best-'+settings.laps;
function showBest(){const b=store.get(bestKey())||{};$('best').textContent=b.race||b.lap?`🏅 Рекорд (${settings.laps} об.): ${fmt(b.race)} · Най-добра обиколка: ${fmt(b.lap)}`:''}
showBest();

// ---------- time of day ----------
const TOD={
 day:{top:0x2f7fd0,bottom:0xcde9f7,fog:0xcde9f7,near:220,far:950,hs:0xcfeaff,hg:0x3a5a2a,hi:1.7,sun:0xffffff,si:3,dir:[120,180,80],disc:0xfff4c8,night:0},
 sunset:{top:0x23306a,bottom:0xff8a4c,fog:0xe48a62,near:160,far:800,hs:0xffc59a,hg:0x3a2a2a,hi:1.1,sun:0xffa060,si:2.6,dir:[-260,70,-160],disc:0xffa040,night:.55},
 night:{top:0x01030a,bottom:0x0b1830,fog:0x0a1428,near:60,far:480,hs:0x3a4a70,hg:0x0a0a10,hi:.55,sun:0x8aa0ff,si:.45,dir:[-150,220,120],disc:0xc8d8ff,night:1}
};
let sunDir=new THREE.Vector3(),hemiBase=1;
function applyTimeOfDay(){
 const t=TOD[settings.tod];
 skyMat.uniforms.top.value.set(t.top);skyMat.uniforms.bottom.value.set(t.bottom);
 scene.fog.color.set(t.fog);scene.fog.near=t.near;scene.fog.far=t.far;
 hemi.color.set(t.hs);hemi.groundColor.set(t.hg);hemi.intensity=t.hi;sun.color.set(t.sun);sun.intensity=t.si;
 sunDir.set(...t.dir).normalize();sunDisc.material.color.set(t.disc);sunDisc.scale.setScalar(settings.tod==='night'?120:260);
 stars.visible=settings.tod==='night';
 const n=t.night;
 lampHeads.forEach(m=>m.emissiveIntensity=n*3);lampGlows.forEach(m=>m.opacity=n*.9);
 scene.traverse(o=>{if(o.material===lampPools[0])o.visible=n>0});lampPools[0].opacity=.55*n;
 windowMats.forEach(m=>m.emissiveIntensity=n*1.1);wallMat.emissiveIntensity=n*.35;
 headlight.intensity=300*n;
 cars.forEach(c=>c.car.headMat.emissiveIntensity=1.2+n*3);
 // rain: grey sky, thick fog, shiny road
 const wet=isRain();
 sunDisc.visible=!wet;
 if(wet){
  const grey=new THREE.Color(settings.tod==='night'?0x05070c:settings.tod==='sunset'?0x6b5a5a:0x7d8896);
  skyMat.uniforms.top.value.lerp(grey,.75);skyMat.uniforms.bottom.value.lerp(grey,.6);scene.fog.color.lerp(grey,.7);
  scene.fog.near*=.35;scene.fog.far*=.55;hemi.intensity*=.75;sun.intensity*=.3;stars.visible=false;
  lampPools[0].opacity=.9*n;
 }
 hemiBase=hemi.intensity;
 rain.visible=puddles.visible=wet;
 rainMat.opacity=settings.tod==='night'?.3:.45;
 const env=wet?skyEnv():null;
 roadMat.color.set(wet?0x8e8e96:0xffffff);roadMat.roughness=wet?.16:.85;roadMat.metalness=wet?.2:0;
 curbMat.roughness=wet?.2:.7;
 for(const m of [roadMat,curbMat,puddleMat]){m.envMap=env;m.envMapIntensity=settings.tod==='night'?.4:1;m.needsUpdate=true}
}
applyTimeOfDay();

// ---------- race state ----------
let state='menu',raceTime=0,countdown=0,lastRecord=false,finishFrame=0,camMode=store.get('kod-cam')??0,lastCount=0,gasDownAt=-1,shake=0,lastPos=4;
const LAPS=()=>settings.laps;
function gridSlot(k){return {d:-10-Math.floor(k/2)*9,lat:k%2?3.6:-3.6}}
function resetRace(){
 const d=DIFF[settings.diff];
 // tune the C++ physics for the chosen car; bots get a bit quicker against faster cars
 setupCar(garage.sel);
 const perf=ctl.setup_value(0)/40,lat=d.lat*(1+(perf-1)*.4);botTop=d.top*(1+(perf-1)*.6);
 botProfile=isRain()?speedProfile(lat*.78,botTop,16):speedProfile(lat,botTop,20);
 // player starts last (slot 3)
 const g=gridSlot(3),p=trackAt(g.d,g.lat);
 Object.assign(player,{x:p.x,z:p.z,angle:p.angle,vx:0,vz:0,steer:0,nitro:.25,dist:g.d,s:wrapS(g.d),idx:p.i,lat:g.lat,finished:false,finishTime:0,lapStart:0,laps:[],drift:0,driftScore:0,wrong:0,wasBoost:false,damage:0});
 bots.forEach((b,k)=>{const gs=gridSlot(k);Object.assign(b,{dist:gs.d,lat:gs.lat,laneT:gs.lat,v:0,skill:rand(...d.skill),offset:rand(-1.5,1.5),laneTimer:rand(2,5),finished:false,finishTime:0,boost:0,steer:0,avoid:0,damage:0})});
 bots.forEach(placeBot);
 raceTime=0;lastPos=4;clearSkids();recTotal=0;drops.length=0;music.intense=false;
 cars.forEach(c=>repairCar(c.car));
 particles.forEach(p=>p.s.visible=false);
 boostPads.forEach(b=>b.cool=0);
}
function placeBot(b){const p=trackAt(b.dist,b.lat);b.x=p.x;b.z=p.z;b.angle=p.angle;b.car.g.position.set(p.x,0,p.z);b.car.g.rotation.y=p.angle}
function startRace(){
 if(state!=='menu')return;
 initAudio();buildPlayerCar();resetRace();musicStart();
 $('menu').style.display='none';$('results').innerHTML='';
 state='countdown';countdown=4;lastCount=5;gasDownAt=-1;setStartLights(0,false);
 camYaw=player.angle;camera.position.set(player.x-Math.sin(player.angle)*10,4,player.z-Math.cos(player.angle)*10);
}
function respawn(){
 const p=trackAt(player.s,0);Object.assign(player,{x:p.x,z:p.z,angle:p.angle,vx:0,vz:0,lat:0});toast('ОБРАТНО НА ПИСТАТА','#9fd')
}
function togglePause(){
 if(state==='race'||state==='countdown'){pausedFrom=state;state='paused';$('pause').style.display='flex';audio.ctx&&audio.ctx.suspend()}
 else if(state==='paused'){state=pausedFrom;$('pause').style.display='none';audio.ctx&&audio.ctx.resume();last=performance.now()}
}
let pausedFrom='race';
$('resume').onclick=togglePause;
$('quit').onclick=()=>{$('pause').style.display='none';audio.ctx&&audio.ctx.resume();toMenu()};
document.addEventListener('visibilitychange',()=>{if(document.hidden&&(state==='race'||state==='countdown'))togglePause()});
function toMenu(){state='menu';musicStop();document.body.classList.remove('replaying');$('menu').style.display='flex';$('message').style.display='none';$('title').textContent='KOD RACING 3D';$('start').textContent='СТАРТ НА СЪСТЕЗАНИЕТО';showBest()}
function showCarInfo(){$('mycar').innerHTML=`🚗 <b>${MODELS[garage.sel].name}</b> · 💰 ${garage.money} · 🏆 ${garage.wins}`}

let lastReward=null;
function giveReward(pos){
 const lapMul={1:.5,3:1,5:1.5}[settings.laps],diffMul=[.8,1,1.3][settings.diff];
 const money=Math.round([600,350,200,100][pos-1]*lapMul*diffMul/10)*10;
 const before=garage.wins;
 garage.money+=money;garage.races++;if(pos===1)garage.wins++;
 const fresh=MODELS.filter(m=>m.wins>before&&m.wins<=garage.wins).map(m=>m.name);
 saveGarage();
 lastReward={money,fresh};
}
function finishPlayer(){
 player.finished=true;player.finishTime=raceTime;
 const pos=standings().indexOf(player)+1;
 giveReward(pos);
 bigMessage(pos===1?'🏆 ПОБЕДА!<small>'+fmt(raceTime)+' сек</small>':'FINISH!<small>'+pos+'-ро място · '+fmt(raceTime)+' сек</small>');
 [523,659,784,1046].forEach((f,k)=>setTimeout(()=>beep(f,.25,.25,'triangle'),k*120));
 const b=store.get(bestKey())||{};let rec=false;
 if(!b.race||raceTime<b.race){b.race=raceTime;rec=true}
 const bl=Math.min(...player.laps);if(!b.lap||bl<b.lap)b.lap=bl;
 store.set(bestKey(),b);
 state='finished';lastRecord=rec;finishFrame=recTotal;
 setTimeout(()=>{if(state==='finished')startReplay()},2200);
}
function showResults(rec){
 showCarInfo();
 const order=standings();
 const total=LAPS()*L;
 const rows=order.map((c,k)=>{const t=c.finished?c.finishTime:raceTime*total/Math.max(1,c.dist);
  return `<tr class="${c===player?'me':''}"><td>${['🥇','🥈','🥉','4.'][k]}</td><td>${c.name}</td><td>${c.finished?'':'~'}${fmt(t)}</td></tr>`}).join('');
 $('results').innerHTML=`<table>${rows}</table>`+(rec?'<p style="color:#ffd84a;font-weight:800">⭐ НОВ РЕКОРД!</p>':'')+
  `<p class="keys">Обиколки: ${player.laps.map(fmt).join(' · ')}</p>`+
  (lastReward?`<p class="reward">💰 +${lastReward.money} кредита</p>`+lastReward.fresh.map(n=>`<p class="unlock">🔓 Нова кола в гаража: ${n}!</p>`).join(''):'');
 lastReward=null;
 $('title').textContent='СЪСТЕЗАНИЕТО ЗАВЪРШИ';$('start').textContent='НОВО СЪСТЕЗАНИЕ';
 $('menu').style.display='flex';$('message').style.display='none';showBest();
 state='menu';menuOrbit=0;musicStop();
}
function standings(){
 return [...cars].sort((a,b)=>{
  if(a.finished&&b.finished)return a.finishTime-b.finishTime;
  if(a.finished!==b.finished)return a.finished?-1:1;
  return b.dist-a.dist});
}

// ---------- update ----------
// Field order of struct Car in controls.cpp.
const CAR_FIELDS=['dt','locked','finished','grass','wet','damage','x','z','angle','vx','vz','steer','nitro','wasBoost',
 'vF','vR','yaw','boosting','drifting','gas','brake','whoosh','fx','fz','rx','rz'];
const carMem=new Float64Array(ctl.memory.buffer,ctl.car_state(),CAR_FIELDS.length);
const CF=Object.fromEntries(CAR_FIELDS.map((f,i)=>[f,i]));
const CAR_STATE=['x','z','angle','vx','vz','steer','nitro'];
function updatePlayer(dt,locked){
 const pl=player,grass=Math.abs(pl.lat)>CURB;
 // hand the car to C++, drive one frame, read it back
 carMem[CF.dt]=dt;carMem[CF.locked]=locked?1:0;carMem[CF.finished]=state==='finished'?1:0;carMem[CF.grass]=grass?1:0;
 carMem[CF.wet]=isRain()?1:0;carMem[CF.damage]=pl.damage;
 for(const f of CAR_STATE)carMem[CF[f]]=pl[f];
 carMem[CF.wasBoost]=pl.wasBoost?1:0;
 ctl.drive();
 for(const f of CAR_STATE)pl[f]=carMem[CF[f]];
 pl.wasBoost=carMem[CF.wasBoost]===1;
 const vF=carMem[CF.vF],vR=carMem[CF.vR],yaw=carMem[CF.yaw],sp=Math.abs(vF);
 const boosting=carMem[CF.boosting]===1,gas=carMem[CF.gas]===1,brake=carMem[CF.brake]===1;
 const fx=carMem[CF.fx],fz=carMem[CF.fz],rx=carMem[CF.rx],rz=carMem[CF.rz];
 if(carMem[CF.whoosh]===1)whoosh();

 // track position & walls
 const loc=locate(pl.x,pl.z,pl.idx);pl.idx=loc.i;pl.lat=loc.lat;
 if(Math.abs(loc.lat)>WALL-1.1){
  const sg=Math.sign(loc.lat),pen=Math.abs(loc.lat)-(WALL-1.1);
  pl.x-=loc.rx*sg*pen;pl.z-=loc.rz*sg*pen;pl.lat=sg*(WALL-1.1);
  const vn=pl.vx*loc.rx+pl.vz*loc.rz;
  if(vn*sg>0){pl.vx-=loc.rx*vn*1.35;pl.vz-=loc.rz*vn*1.35;
   const hit=Math.abs(vn);pl.vx*=1-Math.min(.35,hit*.025);pl.vz*=1-Math.min(.35,hit*.025);
   if(hit>3){shake=Math.min(1,hit/14);thud(hit/18);flash();
    hurt(pl,hit*.012);dentCar(pl.car,pl.x+loc.rx*sg*1.2,.7,pl.z+loc.rz*sg*1.2,Math.min(1,hit/12));
    for(let k=0;k<10;k++)emit(pl.x+loc.rx*sg*1.1,.6,pl.z+loc.rz*sg*1.1,rand(-6,6),rand(2,6),rand(-6,6),.35,.5,0,0xffb040,true)}}
 }
 // progress
 let ds=loc.s-pl.s;if(ds<-L/2)ds+=L;if(ds>L/2)ds-=L;pl.s=loc.s;
 if(!locked){
  const before=Math.floor(pl.dist/L);pl.dist+=ds;const after=Math.floor(pl.dist/L);
  if(after>before&&pl.dist>0&&!pl.finished){
   if(after>=1&&after>pl.laps.length){const lt=raceTime-pl.lapStart;pl.laps.push(lt);pl.lapStart=raceTime;
    const best=Math.min(...pl.laps.slice(0,-1),(store.get(bestKey())||{}).lap??Infinity);
    if(after>=LAPS()){finishPlayer()}
    else{if(after===LAPS()-1)music.intense=true;
     toast((after===LAPS()-1?'ПОСЛЕДНА ОБИКОЛКА! ':'ОБИКОЛКА '+(after+1)+' · ')+fmt(lt)+(lt<best?' ⭐':''),after===LAPS()-1?'#ffd84a':'#fff',2.2);beep(880,.15,.2)}
   }
  }
  // wrong way
  const along=pl.vx*loc.tx+pl.vz*loc.tz;
  pl.wrong=along<-3?pl.wrong+dt:Math.max(0,pl.wrong-dt*2);
 }
 // boost pads
 for(const b of boostPads){b.cool=Math.max(0,(b.cool||0)-dt);
  let d=pl.s-b.s;if(d<-L/2)d+=L;if(d>L/2)d-=L;
  if(!locked&&b.cool===0&&Math.abs(d)<4&&Math.abs(pl.lat-b.lat)<2.8){b.cool=1.5;pl.nitro=Math.min(1,pl.nitro+.35);
   pl.vx+=fx*12;pl.vz+=fz*12;whoosh();toast('⚡ БУСТ!','#3cf',1);shake=.4;}}
 // drift scoring & nitro charge
 const slide=Math.abs(vR);
 if(!locked&&slide>3.2&&sp>11&&!grass){pl.nitro=Math.min(1,pl.nitro+dt*.2*Math.min(1,slide/7));pl.driftScore+=slide*sp*dt*.5;pl.drift=slide}
 else{if(pl.driftScore>40){toast('ДРИФТ +'+Math.round(pl.driftScore),'#f6c',1.2)}pl.driftScore=0;pl.drift=0}
 // effects
 const fwdV=vF;
 if(slide>3.2&&sp>8||(brake&&sp>18)){
  for(const side of [-1,1]){const wx=pl.x-fx*1.45+rx*side*1.07,wz=pl.z-fz*1.45+rz*side*1.07;skid(wx,wz,pl.angle,sp*dt);
   if(Math.random()<.5)emit(wx,.5,wz,rand(-1,1),rand(1,2.5),rand(-1,1),rand(.8,1.4),1.2,3.5,grass?0x9c8a60:0xdddddd)}}
 if(grass&&sp>5&&Math.random()<.6)emit(pl.x-fx*2,.4,pl.z-fz*2,rand(-1,1),rand(1,3),rand(-1,1),.9,1,2.5,0x8a7a50);
 if(boosting&&Math.random()<.8)emit(pl.x-fx*3,.5,pl.z-fz*3,-fx*4+rand(-1,1),rand(0,1),-fz*4+rand(-1,1),.25,.6,1,0x55bbff,true);
 if(isRain())spray(pl.x,pl.z,fx,fz,sp);
 damageSmoke(pl,pl.x,pl.z,fx,fz);
 const accF=(fwdV-pl.lastF)/Math.max(dt,1e-3),accR=(vR-pl.lastR)/Math.max(dt,1e-3)+yaw*sp;pl.lastF=fwdV;pl.lastR=vR;
 animateCar(pl.car,dt,fwdV,pl.steer,clamp(-accR*.004,-.09,.09),clamp(-accF*.003,-.06,.06),boosting,brake&&fwdV>1);
 pl.car.g.position.set(pl.x,0,pl.z);pl.car.g.rotation.y=pl.angle;
 updateAudio(fwdV,gas,boosting,pl.drift,grass);
 return {speed:fwdV,boosting};
}
function updateBots(dt,locked){
 const total=LAPS()*L;
 for(const b of bots){
  if(locked){b.v=0;animateCar(b.car,dt,0,0,0,0,false,false);continue}
  const i=wrapI(Math.floor(wrapS(b.dist)/DS));
  let target=botProfile[i]*b.skill;
  if(b.finished)target=Math.min(target,18);
  else if(!player.finished){const gap=b.dist-player.dist;
   if(gap>70)target*=.92;else if(gap<-70)target*=1.06;}
  // occasional nitro on straights
  if(b.boost>0){b.boost-=dt;target*=1.18}
  else if(!b.finished&&botProfile[i]>=botTop*.98&&Math.random()<dt*.06*(settings.diff+1))b.boost=rand(1,2);
  // traffic: change lane or slow down behind other cars
  for(const o of cars){if(o===b)continue;let d=o.dist-b.dist;
   if(d>0&&d<12&&Math.abs(o.lat-b.lat)<2.6){const ov=o===player?Math.hypot(player.vx,player.vz):o.v;
    const left=clamp(o.lat-3.8,-6.2,6.2),right=clamp(o.lat+3.8,-6.2,6.2);
    b.laneT=Math.abs(left-b.lat)<Math.abs(right-b.lat)?left:right;b.avoid=1.2;if(d<6)target=Math.min(target,ov*.97)}}
  b.laneTimer-=dt;if(b.laneTimer<=0){b.laneTimer=rand(2,5);b.offset=rand(-1.8,1.8)}
  b.avoid=Math.max(0,(b.avoid||0)-dt);
  if(!b.avoid)b.laneT+=(clamp(lineLat[wrapI(i+18)]+b.offset,-6,6)-b.laneT)*Math.min(1,dt*.8);
  const acc=b.boost>0?30:22;
  b.v+=clamp(target-b.v,-30*dt,acc*dt);
  b.dist+=b.v*dt;
  const dl=(b.laneT-b.lat)*Math.min(1,dt*1.6);b.lat=clamp(b.lat+dl,-ROAD+1.2,ROAD-1.2);
  const p=trackAt(b.dist,b.lat);b.x=p.x;b.z=p.z;
  const latV=dl/Math.max(dt,1e-3);
  b.angle=p.angle-Math.atan2(latV,Math.max(5,b.v));
  b.steer=clamp(-KS[i]*14+latV*.08,-1,1);
  b.car.g.position.set(b.x,0,b.z);b.car.g.rotation.y=b.angle;
  animateCar(b.car,dt,b.v,b.steer,clamp(KS[i]*b.v*b.v*.004,-.08,.08),0,b.boost>0,target<b.v-2);
  const bfx=Math.sin(b.angle),bfz=Math.cos(b.angle);
  if(isRain()&&Math.random()<.5)spray(b.x,b.z,bfx,bfz,b.v);
  damageSmoke(b,b.x,b.z,bfx,bfz);
  if(!b.finished&&b.dist>=total){b.finished=true;b.finishTime=raceTime}
 }
}
function collisions(){
 // player vs bots (in player's local frame: ellipse test)
 const pl=player,sa=Math.sin(pl.angle),ca=Math.cos(pl.angle);
 for(const b of bots){
  const dx=b.x-pl.x,dz=b.z-pl.z,al=dx*sa+dz*ca,la=dx*-ca+dz*sa;
  const e=(al/4.3)**2+(la/2.25)**2;
  if(e<1){
   const d=Math.hypot(dx,dz)||1,nx=dx/d,nz=dz/d,push=(1-Math.sqrt(e))*2.2;
   pl.x-=nx*push*.5;pl.z-=nz*push*.5;
   const tp=trackAt(b.dist,b.lat),bt=nx*tp.tx+nz*tp.tz,br=nx*tp.rx+nz*tp.rz;
   b.dist+=bt*push*.5;b.lat=clamp(b.lat+br*push*.5,-ROAD+1,ROAD-1);b.laneT=b.lat;
   const rel=(pl.vx-tp.tx*b.v)*nx+(pl.vz-tp.tz*b.v)*nz;
   if(rel>0){pl.vx-=nx*rel*.6;pl.vz-=nz*rel*.6;b.v=Math.max(0,b.v+bt*rel*.5);
    if(rel>2){shake=Math.min(1,rel/10);thud(rel/12);
     hurt(pl,rel*.012);b.damage=Math.min(1,b.damage+rel*.01);
     dentCar(pl.car,pl.x+dx/2,.7,pl.z+dz/2,Math.min(1,rel/10));dentCar(b.car,pl.x+dx/2,.7,pl.z+dz/2,Math.min(1,rel/10));for(let k=0;k<8;k++)emit(pl.x+dx/2,.8,pl.z+dz/2,rand(-5,5),rand(2,5),rand(-5,5),.3,.4,0,0xffc060,true)}}
  }
 }
 // bots vs bots (track space)
 for(let a=0;a<bots.length;a++)for(let c=a+1;c<bots.length;c++){const A=bots[a],B=bots[c],dd=B.dist-A.dist,dl=B.lat-A.lat;
  if(Math.abs(dd)<4.4&&Math.abs(dl)<2.3){const push=(2.3-Math.abs(dl))*.5,s=dl>=0?1:-1;A.lat-=s*push;B.lat+=s*push;A.laneT=A.lat;B.laneT=B.lat;
   const back=dd>0?A:B,front=dd>0?B:A;back.v=Math.min(back.v,front.v)}}
}
function hurt(c,amount){
 const before=c.damage;c.damage=Math.min(1,c.damage+amount);
 if(c!==player)return;
 if(before<.4&&c.damage>=.4)toast('⚠ ЩЕТИ ПО КОЛАТА','#ffb02e',1.4);
 if(before<.75&&c.damage>=.75)toast('🔥 ТЕЖКИ ЩЕТИ!','#ff4b2e',1.6);
}
function damageSmoke(c,x,z,fx,fz){
 if(c.damage<.35||Math.random()>c.damage*.8)return;
 emit(x+fx*1.9+rand(-.3,.3),1,z+fz*1.9+rand(-.3,.3),rand(-.5,.5),rand(1.5,3),rand(-.5,.5),rand(1,1.8),.9,3,c.damage>.7?0x2a2a2a:0x8c8c8c);
 if(c.damage>.8&&Math.random()<.3)emit(x+fx*1.9,.9,z+fz*1.9,rand(-1,1),rand(2,4),rand(-1,1),.3,.5,0,0xff7a20,true);
}
function spray(x,z,fx,fz,v){
 if(v<12||Math.random()>.35)return;
 const s=rand(-1,1);
 emit(x-fx*2.3-fz*s,.35,z-fz*2.3+fx*s,-fx*2+rand(-1,1),rand(.4,1),-fz*2+rand(-1,1),.4,.8,2.2,0xc8d0d8);
}
function flash(){const f=$('flash');f.style.transition='none';f.style.opacity=1;requestAnimationFrame(()=>{f.style.transition='opacity .4s';f.style.opacity=0})}

// ---------- replay ----------
const REC_MAX=60*14,REC_W=6;
const recBuf=Array.from({length:REC_MAX},()=>new Float32Array(cars.length*REC_W)),recTime=new Float64Array(REC_MAX);
let recTotal=0,rp=null;
function recordFrame(info){
 const f=recBuf[recTotal%REC_MAX];recTime[recTotal%REC_MAX]=raceTime;
 cars.forEach((c,k)=>{const o=k*REC_W,me=c===player;
  f[o]=c.x;f[o+1]=c.z;f[o+2]=c.angle;f[o+3]=me?info.speed:c.v;f[o+4]=c.steer;f[o+5]=(me?info.boosting:c.boost>0)?1:0});
 recTotal++;
}
function startReplay(){
 const oldest=Math.max(0,recTotal-REC_MAX);
 const first=Math.max(oldest,finishFrame-60*7);
 rp={f:first,end:recTotal-1,time:recTime[first%REC_MAX],shot:-1,shotT:0,finishShot:false,cam:new THREE.Vector3(),anchor:null,side:1};
 state='replay';$('message').style.display='none';$('wrongway').style.display='none';
 document.body.classList.add('replaying');
}
function endReplay(){
 if(state!=='replay')return;
 document.body.classList.remove('replaying');
 showResults(lastRecord);
}
const angLerp=(a,b,u)=>a+Math.atan2(Math.sin(b-a),Math.cos(b-a))*u;
function updateReplay(dt){
 const nearFinish=rp.f>finishFrame-50&&rp.f<finishFrame+25;
 const rate=nearFinish?.35:1;
 rp.time+=dt*rate;
 while(rp.f<rp.end&&recTime[(rp.f+1)%REC_MAX]<=rp.time)rp.f++;
 if(rp.f>=rp.end){endReplay();return}
 const A=recBuf[rp.f%REC_MAX],B=recBuf[(rp.f+1)%REC_MAX];
 const t0=recTime[rp.f%REC_MAX],t1=recTime[(rp.f+1)%REC_MAX],u=t1>t0?clamp((rp.time-t0)/(t1-t0),0,1):0;
 let speed=0,boost=false;
 cars.forEach((c,k)=>{const o=k*REC_W;
  const x=A[o]+(B[o]-A[o])*u,z=A[o+1]+(B[o+1]-A[o+1])*u,ang=angLerp(A[o+2],B[o+2],u),v=A[o+3],b=A[o+5]===1;
  c.car.g.position.set(x,0,z);c.car.g.rotation.y=ang;
  animateCar(c.car,dt*rate,v,A[o+4],0,0,b,false);
  const fx=Math.sin(ang),fz=Math.cos(ang);
  if(isRain())spray(x,z,fx,fz,Math.abs(v));
  damageSmoke(c,x,z,fx,fz);
  if(c===player){speed=v;boost=b}
 });
 replayCamera(dt*rate,nearFinish);
 updateAudio(speed,Math.abs(speed)>5,boost,0,false);
}
function replayCamera(dt,nearFinish){
 const g=player.car.g,px=g.position.x,pz=g.position.z,ang=g.rotation.y,fx=Math.sin(ang),fz=Math.cos(ang);
 rp.shotT-=dt;
 if(nearFinish&&!rp.finishShot){
  rp.finishShot=true;rp.shot=9;rp.shotT=99;
  const p=trackAt(3,(locate(px,pz,null).lat>0?-1:1)*(WALL+2.5));rp.anchor=new THREE.Vector3(p.x,1.6,p.z);
 }else if(rp.shotT<=0&&!rp.finishShot){
  rp.shot=(rp.shot+1)%4;rp.shotT=2.6;rp.side=-rp.side;
  if(rp.shot===0){const loc=locate(px,pz,null),p=trackAt(loc.s+45,rp.side*(WALL+3));rp.anchor=new THREE.Vector3(p.x,2.2,p.z)}
 }
 let fov=55;
 switch(rp.shot){
  case 0: case 9: // trackside, long lens
   camera.position.copy(rp.anchor);fov=rp.shot===9?24:32;break;
  case 1: // low, beside the front wheel
   camera.position.set(px+fx*1.5-fz*rp.side*4,.6,pz+fz*1.5+fx*rp.side*4);fov=62;break;
  case 2:{ // orbit
   const a=rp.time*.7;camera.position.set(px+Math.cos(a)*9,2.8,pz+Math.sin(a)*9);fov=50;break}
  default: // helicopter
   camera.position.set(px-fx*18,14,pz-fz*18);fov=48;
 }
 camera.lookAt(px+fx*(rp.shot===3?10:0),.9,pz+fz*(rp.shot===3?10:0));
 camera.fov=fov;camera.updateProjectionMatrix();
}
$('replay').addEventListener('click',endReplay);

// ---------- screen drops & lightning ----------
const dropsCv=$('drops'),dctx=dropsCv.getContext('2d'),drops=[];
function sizeDrops(){dropsCv.width=Math.max(1,innerWidth>>1);dropsCv.height=Math.max(1,innerHeight>>1)}
sizeDrops();
function updateDrops(dt,speed){
 const w=dropsCv.width,h=dropsCv.height,on=isRain()&&state!=='menu'&&state!=='paused';
 if(!on&&!drops.length)return;
 const v=Math.abs(speed);
 if(on&&drops.length<70&&Math.random()<dt*(9+v*.25))drops.push({x:rand(0,w),y:rand(0,h),r:rand(2.5,8),life:rand(1.5,3.5),age:0});
 dctx.clearRect(0,0,w,h);
 for(let i=drops.length-1;i>=0;i--){
  const d=drops[i];d.age+=dt;
  if(v>20){d.x+=(d.x-w/2)/w*v*dt*6;d.y+=(d.y-h/2)/h*v*dt*6;d.age+=dt*v/40} // wind blows them off at speed
  else if(d.r>5)d.y+=dt*d.r*3;
  const a=Math.min(1,(d.life-d.age)/.6);
  if(a<=0||d.x<-10||d.x>w+10||d.y<-10||d.y>h+10){drops.splice(i,1);continue}
  const gr=dctx.createRadialGradient(d.x-d.r*.3,d.y-d.r*.3,0,d.x,d.y,d.r);
  gr.addColorStop(0,`rgba(255,255,255,${.35*a})`);gr.addColorStop(.7,`rgba(190,210,235,${.12*a})`);gr.addColorStop(1,`rgba(20,30,45,${.25*a})`);
  dctx.fillStyle=gr;dctx.beginPath();dctx.arc(d.x,d.y,d.r,0,7);dctx.fill();
 }
}
let boltT=rand(8,15),bolt=0;
function updateLightning(dt){
 if(!isRain()||state==='menu'||state==='paused'){$('lightning').style.opacity=0;hemi.intensity=hemiBase;return}
 boltT-=dt;
 if(boltT<=0){boltT=rand(10,22);bolt=.4;setTimeout(thunder,rand(400,1400))}
 const lit=bolt>0&&(bolt>.3||(bolt<.18&&bolt>.1));
 bolt=Math.max(0,bolt-dt);
 $('lightning').style.opacity=lit?.5:0;hemi.intensity=hemiBase+(lit?2.5:0);
}

// ---------- camera ----------
let camYaw=0,menuOrbit=0;
const camTarget=new THREE.Vector3(),camLook=new THREE.Vector3();
function updateCamera(dt,speed,boosting){
 const pl=player;
 if(state==='replay'){$('speedlines').style.opacity=0;return}
 if(state==='menu'){menuOrbit+=dt*.12;const p=trackAt(-20,0),r=32;
  camera.position.set(p.x+Math.cos(menuOrbit)*r,9+Math.sin(menuOrbit*.7)*3,p.z+Math.sin(menuOrbit)*r);camera.lookAt(p.x,2,p.z);
  camera.fov=55;camera.updateProjectionMatrix();return}
 let da=pl.angle-camYaw;da=Math.atan2(Math.sin(da),Math.cos(da));camYaw+=da*Math.min(1,dt*(camMode===2?14:5));
 const sf=clamp(Math.abs(speed)/50,0,1);
 if(camMode===2){
  camera.position.set(pl.x+Math.sin(pl.angle)*.6,1.75,pl.z+Math.cos(pl.angle)*.6);
  camera.lookAt(pl.x+Math.sin(pl.angle)*20,1.4,pl.z+Math.cos(pl.angle)*20);
 }else{
  const dist=(camMode===0?8.5:14)+sf*2,h=camMode===0?3.4:6.5;
  camTarget.set(pl.x-Math.sin(camYaw)*dist,h,pl.z-Math.cos(camYaw)*dist);
  camera.position.lerp(camTarget,1-Math.pow(.0008,dt));
  camLook.set(pl.x+Math.sin(camYaw)*6,1.3,pl.z+Math.cos(camYaw)*6);camera.lookAt(camLook);
 }
 if(shake>0){camera.position.x+=rand(-1,1)*shake*.5;camera.position.y+=rand(-1,1)*shake*.35;shake=Math.max(0,shake-dt*2.5)}
 if(boosting)camera.position.y+=rand(-.04,.04);
 const fov=(camera.aspect<1?80:64)+sf*14+(boosting?8:0);camera.fov+=(fov-camera.fov)*Math.min(1,dt*4);camera.updateProjectionMatrix();
 $('speedlines').style.opacity=clamp((Math.abs(speed)-34)/18,0,1)*.9;
 $('speedlines').style.transform=`rotate(${rand(0,6)}deg)`;
}

// ---------- minimap ----------
const mm=$('minimap').getContext('2d');
const mmB=(()=>{let a=1e9,b=-1e9,c=1e9,d=-1e9;P.forEach(p=>{a=Math.min(a,p.x);b=Math.max(b,p.x);c=Math.min(c,p.z);d=Math.max(d,p.z)});return {a,b,c,d}})();
const mmS=290/Math.max(mmB.b-mmB.a,mmB.d-mmB.c);
const mmX=x=>170+(x-(mmB.a+mmB.b)/2)*mmS,mmY=z=>170+(z-(mmB.c+mmB.d)/2)*mmS;
const mmPath=new Path2D();P.forEach((p,i)=>i?mmPath.lineTo(mmX(p.x),mmY(p.z)):mmPath.moveTo(mmX(p.x),mmY(p.z)));mmPath.closePath();
const mmBase=document.createElement('canvas');mmBase.width=mmBase.height=340;
{const g=mmBase.getContext('2d');g.lineJoin='round';
 g.strokeStyle='#0008';g.lineWidth=22;g.stroke(mmPath);g.strokeStyle='#cfd6de';g.lineWidth=10;g.stroke(mmPath);
 g.fillStyle='#3cf';boostPads.forEach(b=>{const p=trackAt(b.s,b.lat);g.fillRect(mmX(p.x)-4,mmY(p.z)-4,8,8)});
 const s=trackAt(0);g.strokeStyle='#111';g.lineWidth=6;g.beginPath();g.moveTo(mmX(s.x-s.rx*9),mmY(s.z-s.rz*9));g.lineTo(mmX(s.x+s.rx*9),mmY(s.z+s.rz*9));g.stroke()}
function drawMinimap(){
 mm.clearRect(0,0,340,340);mm.drawImage(mmBase,0,0);
 for(const c of [...bots,player]){const me=c===player;mm.fillStyle='#'+c.color.toString(16).padStart(6,'0');mm.beginPath();mm.arc(mmX(c.x),mmY(c.z),me?11:8,0,7);mm.fill();
  if(me){mm.strokeStyle='#fff';mm.lineWidth=4;mm.stroke()}}
}

// ---------- garage ----------
// its own little scene: a turntable with the car on it
const gScene=new THREE.Scene();gScene.background=new THREE.Color(0x0b0f15);gScene.fog=new THREE.Fog(0x0b0f15,18,45);
const gCam=new THREE.PerspectiveCamera(38,innerWidth/innerHeight,.1,100);
gScene.add(new THREE.HemisphereLight(0xbfd8ff,0x20252c,1.4));
{const key=new THREE.SpotLight(0xffffff,420,40,.6,.5,1.6);key.position.set(4,11,5);key.castShadow=true;key.shadow.mapSize.set(1024,1024);key.shadow.bias=-.0005;gScene.add(key,key.target);
 const blue=new THREE.PointLight(0x2a8cff,60,20);blue.position.set(-6,2.5,-3);const pink=new THREE.PointLight(0xff3fd0,45,20);pink.position.set(6,2,-4);gScene.add(blue,pink);
 const floor=new THREE.Mesh(new THREE.PlaneGeometry(80,80),new THREE.MeshStandardMaterial({color:0x151a21,roughness:.45,metalness:.3}));floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;gScene.add(floor);
 const grid=new THREE.GridHelper(80,40,0x2a3442,0x1b222c);grid.position.y=.01;gScene.add(grid);
 const wallTex=canvasTex(512,128,(g,w,h)=>{g.fillStyle='#10151c';g.fillRect(0,0,w,h);g.fillStyle='#1b232e';for(let x=0;x<w;x+=64)g.fillRect(x,0,30,h);
  g.font='bold italic 52px Arial';g.textAlign='center';g.textBaseline='middle';const gr=g.createLinearGradient(0,0,w,0);gr.addColorStop(0,'#3cf');gr.addColorStop(.5,'#a6f');gr.addColorStop(1,'#f4c');g.fillStyle=gr;g.fillText('KOD GARAGE',w/2,h/2)},false);
 const wall=new THREE.Mesh(new THREE.PlaneGeometry(28,7),new THREE.MeshStandardMaterial({map:wallTex,emissive:0xffffff,emissiveMap:wallTex,emissiveIntensity:.25}));wall.position.set(0,3.5,-12);gScene.add(wall);
}
const turntable=new THREE.Group();gScene.add(turntable);
{const disc=new THREE.Mesh(new THREE.CylinderGeometry(4.2,4.4,.16,64),new THREE.MeshStandardMaterial({color:0x2a313c,metalness:.6,roughness:.35}));disc.position.y=.08;disc.receiveShadow=true;turntable.add(disc);
 const ring=new THREE.Mesh(new THREE.TorusGeometry(4.32,.05,8,96),new THREE.MeshBasicMaterial({color:0x22d3ff}));ring.rotation.x=Math.PI/2;ring.position.y=.12;gScene.add(ring)}
let gCar=null,gIdx=0,gYaw=.6,gDrag=null,gTab='look';
function gCfg(){return garage.cars[gIdx]}
function buildPreview(){
 if(gCar)turntable.remove(gCar.g);
 const c=gCfg();gCar=makeCar(c.color,1,{model:gIdx,rims:c.rims,spoiler:c.spoiler});
 gCar.g.position.y=.16;gCar.g.traverse(o=>{if(o.isMesh)o.castShadow=true});turntable.add(gCar.g);
}
const hex=c=>'#'+c.toString(16).padStart(6,'0');
// stat bars come straight from the C++ tuning (set_setup / setup_value)
const STATS=[['Скорост',0,72],['Ускорение',1,42],['Сцепление',2,19],['Спирачки',3,58]];
function statValues(i,cfg){ctl.set_setup(i,cfg.engine,cfg.tires,cfg.brakes,cfg.spoiler);return STATS.map(([,k])=>ctl.setup_value(k))}
function renderGarage(){
 const m=MODELS[gIdx],c=gCfg(),open=unlocked(gIdx);
 $('gmoney').textContent=garage.money;$('gwins').textContent=garage.wins;
 $('gname').textContent=m.name;$('gdesc').textContent=m.desc;
 $('gcount').textContent=(gIdx+1)+' / '+MODELS.length;
 $('glock').innerHTML=open?'':`🔒 Отключва се с <b>${m.wins}</b> ${m.wins===1?'победа':'победи'} (имаш ${garage.wins})`;
 $('glock').style.display=open?'none':'block';
 // bars: current setup, plus a faint preview of the next upgrade level
 const now=statValues(gIdx,c),maxed={...c,engine:3,tires:3,brakes:3};
 const next=statValues(gIdx,maxed);
 $('gstats').innerHTML=STATS.map(([n,k,max],j)=>{const v=now[j],w=clamp(v/max,0,1)*100,f=clamp(next[j]/max,0,1)*100;
  return `<div class="stat"><span>${n}</span><div class="bar"><i class="max" style="width:${f}%"></i><i style="width:${w}%"></i></div><b>${k===0?Math.round(v*7.2)+' km/h':Math.round(w)}</b></div>`}).join('');
 $('gcolors').innerHTML=PAINTS.map(p=>`<button class="sw${p===c.color?' sel':''}" data-c="${p}" style="background:${hex(p)}"></button>`).join('')+
  `<label class="sw pick${PAINTS.includes(c.color)?'':' sel'}" title="Друг цвят" style="background:${PAINTS.includes(c.color)?'conic-gradient(red,yellow,lime,cyan,blue,magenta,red)':hex(c.color)}"><input type="color" id="gcustom" value="${hex(c.color)}"></label>`;
 $('grims').innerHTML=RIMS.map((r,k)=>`<button data-v="${k}" class="${k===c.rims?'sel':''}">${r.name}</button>`).join('');
 $('gspoil').innerHTML=SPOILERS.map((n,k)=>`<button data-v="${k}" class="${k===c.spoiler?'sel':''}">${n}</button>`).join('');
 $('gtune').innerHTML=UPGRADES.map(([k,n,ic,hint])=>{const lvl=c[k],cost=UPGRADE_COST[lvl];
  const btn=lvl>=3?'<button class="up" disabled>МАКС</button>':`<button class="up" data-up="${k}" ${!open||garage.money<cost?'disabled':''}>💰 ${cost}</button>`;
  return `<div class="uprow"><div><b>${ic} ${n}</b><small>${hint}</small><div class="lvl">${[1,2,3].map(x=>`<i class="${x<=lvl?'on':''}"></i>`).join('')}</div></div>${btn}</div>`}).join('');
 $('gtab-look').style.display=gTab==='look'?'block':'none';$('gtab-tune').style.display=gTab==='tune'?'block':'none';
 document.querySelectorAll('#gtabs button').forEach(b=>b.classList.toggle('sel',b.dataset.tab===gTab));
 const pick=$('gpick');
 pick.disabled=!open||garage.sel===gIdx;
 pick.textContent=!open?'🔒 ЗАКЛЮЧЕНА':garage.sel===gIdx?'✔ ИЗБРАНА':'КАРАЙ ТАЗИ КОЛА';
 $('gpanel').classList.toggle('locked',!open);
}
function changeCar(fn){const c=gCfg();if(!unlocked(gIdx))return;fn(c);saveGarage();renderGarage()}
$('gcolors').addEventListener('click',e=>{const b=e.target.closest('[data-c]');if(!b)return;changeCar(c=>c.color=+b.dataset.c);buildPreview()});
$('gcolors').addEventListener('change',e=>{if(e.target.id!=='gcustom')return;changeCar(c=>c.color=parseInt(e.target.value.slice(1),16));buildPreview()});
$('gcolors').addEventListener('input',e=>{if(e.target.id==='gcustom'&&gCar&&unlocked(gIdx))gCar.paint.color.set(e.target.value)});
$('grims').addEventListener('click',e=>{const b=e.target.closest('[data-v]');if(!b)return;changeCar(c=>c.rims=+b.dataset.v);buildPreview()});
$('gspoil').addEventListener('click',e=>{const b=e.target.closest('[data-v]');if(!b)return;changeCar(c=>c.spoiler=+b.dataset.v);buildPreview()});
$('gtune').addEventListener('click',e=>{const b=e.target.closest('[data-up]');if(!b||b.disabled)return;const k=b.dataset.up;
 changeCar(c=>{const cost=UPGRADE_COST[c[k]];if(c[k]>=3||garage.money<cost)return;garage.money-=cost;c[k]++;beep(660,.12,.2,'triangle');setTimeout(()=>beep(990,.18,.2,'triangle'),90)})});
document.querySelectorAll('#gtabs button').forEach(b=>b.onclick=()=>{gTab=b.dataset.tab;renderGarage()});
$('gprev').onclick=()=>{gIdx=(gIdx+MODELS.length-1)%MODELS.length;buildPreview();renderGarage()};
$('gnext').onclick=()=>{gIdx=(gIdx+1)%MODELS.length;buildPreview();renderGarage()};
$('gpick').onclick=()=>{if(!unlocked(gIdx))return;garage.sel=gIdx;saveGarage();renderGarage();beep(880,.15,.2,'triangle')};
$('gback').onclick=()=>closeGarage();
$('garagebtn').onclick=()=>openGarage();
// drag to spin the car
const gView=$('gview');
gView.addEventListener('pointerdown',e=>{gDrag={x:e.clientX,yaw:gYaw};gView.setPointerCapture(e.pointerId)});
gView.addEventListener('pointermove',e=>{if(gDrag)gYaw=gDrag.yaw-(e.clientX-gDrag.x)*.01});
const endDrag=()=>{gDrag=null};gView.addEventListener('pointerup',endDrag);gView.addEventListener('pointercancel',endDrag);
function layoutGarage(){
 // keep the car in the free part of the screen, next to / above the panel
 const W=innerWidth,H=innerHeight,r=$('gpanel').getBoundingClientRect();
 gCam.aspect=W/H;
 if(W>=760)gCam.setViewOffset(W,H,r.width/2,0,W,H);else gCam.setViewOffset(W,H,0,Math.min(H*.3,(H-r.top)/2),W,H);
 gCam.updateProjectionMatrix();
}
function openGarage(){
 if(state!=='menu')return;
 initAudio();state='garage';gIdx=garage.sel;
 $('menu').style.display='none';$('garage').style.display='block';document.body.classList.add('in-garage');
 buildPreview();renderGarage();layoutGarage();
}
function closeGarage(){
 if(state!=='garage')return;
 state='menu';$('garage').style.display='none';document.body.classList.remove('in-garage');$('menu').style.display='flex';
 buildPlayerCar();resetRace();showCarInfo();
}
function updateGarage(dt){
 if(!gDrag)gYaw+=dt*.25;
 const a=innerWidth/innerHeight,d=a<1.2?Math.min(16,8/a):9.5;   // back off on narrow screens
 gCam.position.set(Math.sin(gYaw)*d,2.6,Math.cos(gYaw)*d);gCam.lookAt(0,.75,0);
}

// ---------- main loop ----------
let last=performance.now();
function animate(t){
 requestAnimationFrame(animate);
 const dt=Math.min(.033,(t-last)/1000||0);last=t;
 if(state==='garage'){updateGarage(dt);renderer.render(gScene,gCam);return}
 let info={speed:0,boosting:false};
 if(state==='countdown'){
  countdown-=dt;const n=Math.ceil(countdown-1);
  if(keys.gas&&gasDownAt<0)gasDownAt=countdown;if(!keys.gas)gasDownAt=-1;
  if(n!==lastCount&&n>=1&&n<=3){lastCount=n;bigMessage(String(n));beep(440,.22);setStartLights(4-n,false)}
  if(countdown<=1){state='race';setStartLights(4,true);bigMessage('GO!');beep(880,.5,.3);
   if(keys.gas&&gasDownAt>0&&gasDownAt<1.6){player.vx=Math.sin(player.angle)*22;player.vz=Math.cos(player.angle)*22;player.nitro=Math.min(1,player.nitro+.3);toast('🚀 СУПЕР СТАРТ!','#ffd84a',1.6);whoosh()}
   setTimeout(()=>{if(state==='race')$('message').style.display='none'},800)}
  info=updatePlayer(dt,state==='countdown');updateBots(dt,true);
 }else if(state==='race'||state==='finished'){
  raceTime+=dt;
  info=updatePlayer(dt,false);updateBots(dt,false);collisions();recordFrame(info);
 }else if(state==='replay'){
  updateReplay(dt);
 }else if(state==='menu'){
  updateAudio(0,false,false,0,false);
 }
 if(state!=='paused'){
  updateParticles(dt);updateRain(dt);updateDrops(dt,info.speed);updateLightning(dt);
  boostPads.forEach(b=>b.tex.offset.y-=dt*1.5);
  if(toastTimer>0){toastTimer-=dt;if(toastTimer<=0)$('toast').style.opacity=0}
  updateCamera(dt,info.speed,info.boosting);
  // keep sun & shadow camera around the player
  const follow=state==='menu'||state==='replay'?camera.position:player.car.g.position,fx=follow.x,fz=follow.z;
  sun.position.set(fx+sunDir.x*200,sunDir.y*200,fz+sunDir.z*200);sun.target.position.set(fx,0,fz);
  sunDisc.position.copy(camera.position).addScaledVector(sunDir,1500);sky.position.copy(camera.position);stars.position.copy(camera.position);
 }
 if(state==='race'||state==='finished'||state==='countdown'){
  const pos=standings().indexOf(player)+1;
  if(state==='race'&&pos<lastPos&&raceTime>2)toast('▲ '+pos+'-ро МЯСТО','#5f5',1);lastPos=pos;
  $('pos').textContent=pos+'/4';
  $('lap').textContent=clamp(Math.floor(player.dist/L)+1,1,LAPS())+'/'+LAPS();
  $('time').textContent=fmt(raceTime);
  $('laptime').textContent='ОБИКОЛКА '+fmt(raceTime-player.lapStart);
  const bl=player.laps.length?Math.min(...player.laps):(store.get(bestKey())||{}).lap;
  $('bestlap').textContent='НАЙ-ДОБРА '+fmt(bl);
  const v=Math.abs(info.speed);$('speed').textContent=Math.round(v*7.2);
  $('gear').textContent=info.speed<-.5?'R':v<.5?'N':gearOf(v);
  $('nitrofill').style.width=(player.nitro*100)+'%';
  $('dmgfill').style.width=(player.damage*100)+'%';
  $('wrongway').style.display=player.wrong>1.2&&state==='race'?'block':'none';
  drawMinimap();
 }
 renderer.render(scene,camera);
}
$('start').onclick=startRace;
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);renderer.setPixelRatio(Math.min(devicePixelRatio,2));sizeDrops();if(state==='garage')layoutGarage()});
buildPlayerCar();resetRace();showCarInfo();
$('loading').style.display='none';
requestAnimationFrame(animate);
