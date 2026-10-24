import * as THREE from 'three';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import {GTAOPass} from 'three/addons/postprocessing/GTAOPass.js';
import {ShaderPass} from 'three/addons/postprocessing/ShaderPass.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';

// The controls (key bindings, input state, car driving physics) are written in C++
// (controls/controls.cpp) and compiled to WebAssembly.
// shown in the menu, and put on the file names so a browser never mixes an old cached file with a new one
const GAME_VERSION='v42';
let ctl;
try{
 const bytes=await (await fetch(new URL('../controls/controls.wasm?'+GAME_VERSION,import.meta.url))).arrayBuffer();
 ctl=(await WebAssembly.instantiate(bytes,{env:{sin:Math.sin,cos:Math.cos,exp:Math.exp}})).instance.exports;
}catch(e){
 document.getElementById('loading').textContent="Couldn't load controls/controls.wasm. Run the game from a web server (see README).";
 throw e;
}

const $=id=>document.getElementById(id);
// 3D car bodies made by artists (glTF, meshopt compressed). split into paint / glass / trim / wheels by tools/build_car.mjs
const CAR_FILES={kaze:'../models/kaze.glb',gt1:'../models/gt1.glb'},CAR_GLB={};
async function loadCarModel(f){
 const loader=new GLTFLoader().setMeshoptDecoder(MeshoptDecoder),url=new URL(f,import.meta.url).href;
 try{return (await loader.loadAsync(url)).scene}catch(e){}
 // some hosts refuse to serve .glb files: then read the base64 copy that sits next to it
 const r=await fetch(url+'.b64.txt');if(!r.ok)throw new Error('no '+f);
 const bin=Uint8Array.from(atob((await r.text()).trim()),c=>c.charCodeAt(0));
 return (await loader.parseAsync(bin.buffer,'')).scene;
}
await Promise.all(Object.entries(CAR_FILES).map(async([k,f])=>{
 try{CAR_GLB[k]=await loadCarModel(f)}catch(e){console.warn('car model '+f+' not loaded, using the built-in body',e)}}));
const store={
 get(k){try{return JSON.parse(localStorage.getItem(k))}catch(e){return null}},
 set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
};
// Progress (credits, wins, upgrades, records) is saved signed: change a single digit in the browser's
// storage and the signature no longer matches, so the edited save is refused. Nothing in a browser is
// unbreakable, but this stops the easy F12 edits. Settings stay plain, there's nothing to win there.
const SAVE_SALT='k0d|r4c1ng|3d|9f2c71e8';
function cyrb53(str,seed){let h1=0xdeadbeef^seed,h2=0x41c6ce57^seed;
 for(let i=0;i<str.length;i++){const ch=str.charCodeAt(i);h1=Math.imul(h1^ch,2654435761);h2=Math.imul(h2^ch,1597334677)}
 h1=Math.imul(h1^(h1>>>16),2246822507);h1^=Math.imul(h2^(h2>>>13),3266489909);
 h2=Math.imul(h2^(h2>>>16),2246822507);h2^=Math.imul(h1^(h1>>>13),3266489909);
 return (4294967296*(2097151&h2)+(h1>>>0)).toString(36)}
const signSave=(k,body)=>cyrb53(k+body+SAVE_SALT,7)+cyrb53(SAVE_SALT+body+k,1337);
const vault={
 tampered:false,
 get(k){
  let raw=null;try{raw=localStorage.getItem(k)}catch(e){}
  if(!raw)return null;
  const [body,sig]=raw.split('.');
  try{if(sig&&signSave(k,body)===sig)return JSON.parse(decodeURIComponent(escape(atob(body))))}catch(e){}
  vault.tampered=true;try{localStorage.removeItem(k)}catch(e){}
  return null},
 set(k,v){try{const body=btoa(unescape(encodeURIComponent(JSON.stringify(v))));localStorage.setItem(k,body+'.'+signSave(k,body))}catch(e){}},
};
// saves from before v14 were plain text that anyone could edit, so they can't be trusted: start over once
for(const k of ['kod-garage','kod-best-1','kod-best-3','kod-best-5'])try{localStorage.removeItem(k)}catch(e){}
const settings=Object.assign({laps:3,diff:1,tod:'day',weather:'dry',music:1,popups:1,gfx:matchMedia('(pointer:coarse)').matches?'low':'high'},store.get('kod-settings')||{});
if(![1,3,5].includes(settings.laps))settings.laps=3;
if(![0,1,2].includes(settings.diff))settings.diff=1;
if(!['day','sunset','night'].includes(settings.tod))settings.tod='day';
if(!['dry','rain'].includes(settings.weather))settings.weather='dry';
if(![0,1].includes(settings.music))settings.music=1;
if(!['high','low'].includes(settings.gfx))settings.gfx='high';
settings.vol=Math.min(100,Math.max(0,settings.vol??80));
if(![0,1].includes(settings.mpbots))settings.mpbots=1;
if(![0,1].includes(settings.mpstock))settings.mpstock=0;
if(![0,1].includes(settings.pull))settings.pull=0;
if(![0,1].includes(settings.pads))settings.pads=1;
if(![0,1,2].includes(settings.track))settings.track=0;
const isRain=()=>settings.weather==='rain',HIGH=settings.gfx==='high';
let simStamp=0;   // multiplayer: when the player's car was last moved by the physics
// a vertex only on collapsed triangles (a strip squeezed shut where it's skipped) gets a zero normal, which the
// shader turns into NaN: on High the AO and bloom smear that into flickering black blocks. point those up instead
{const cvn=THREE.BufferGeometry.prototype.computeVertexNormals;
 THREE.BufferGeometry.prototype.computeVertexNormals=function(){cvn.call(this);const n=this.attributes.normal;if(!n)return;const a=n.array;
  for(let i=0;i<a.length;i+=3){const l=a[i]*a[i]+a[i+1]*a[i+1]+a[i+2]*a[i+2];if(!(l>1e-12)){a[i]=0;a[i+1]=1;a[i+2]=0}}}}
const rand=(a,b)=>a+Math.random()*(b-a);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const isTouch=matchMedia('(pointer:coarse)').matches||'ontouchstart' in window;
if(isTouch)document.body.classList.add('touch');

// ---------- renderer / scene ----------
const scene=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(64,innerWidth/innerHeight,.5,3200);camera.layers.enable(1);
const renderer=new THREE.WebGLRenderer({antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.setSize(innerWidth,innerHeight);
renderer.shadowMap.enabled=true;
renderer.shadowMap.type=THREE.PCFSoftShadowMap;
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.08;
$('game').prepend(renderer.domElement);
// post effects on High graphics: ambient occlusion (contact shadows), bloom, colour grade + vignette
const noAO=[];   // see-through things (leaf cards, grass, fence, sprites) that must stay out of the AO pass
let composer=null,bloom=null;
if(HIGH){
 const pr=renderer.getPixelRatio(),w=innerWidth*pr,h=innerHeight*pr;
 composer=new EffectComposer(renderer,new THREE.WebGLRenderTarget(w,h,{type:THREE.HalfFloatType,samples:4}));
 composer.addPass(new RenderPass(scene,camera));
 const gtao=new GTAOPass(scene,camera,w,h);gtao.blendIntensity=.85;
 gtao.updateGtaoMaterial({radius:.7,distanceExponent:1.4,thickness:1,scale:1,samples:12,distanceFallOff:1});
 gtao.updatePdMaterial({lumaPhi:10,depthPhi:2,normalPhi:3,radius:6,rings:2,samples:12});
 const hideBase=gtao._overrideVisibility.bind(gtao);
 gtao._overrideVisibility=function(){hideBase();for(const o of noAO)if(o.visible){o.visible=false;this._visibilityCache.push(o)}};
 composer.addPass(gtao);
 // a NaN or infinite pixel (from any shader) is dropped here, before the bloom can blow it up into a black block
 composer.addPass(new ShaderPass({uniforms:{tDiffuse:{value:null}},vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader:'uniform sampler2D tDiffuse;varying vec2 vUv;void main(){vec4 c=texture2D(tDiffuse,vUv);bool bad=!(c.r>=0.||c.r<0.)||!(c.g>=0.||c.g<0.)||!(c.b>=0.||c.b<0.)||max(max(c.r,c.g),c.b)>6e4;gl_FragColor=bad?vec4(0.,0.,0.,1.):c;}'}));
 bloom=new UnrealBloomPass(new THREE.Vector2(innerWidth/2,innerHeight/2),.3,.55,.9);composer.addPass(bloom);
 composer.addPass(new OutputPass());
 composer.addPass(new ShaderPass({uniforms:{tDiffuse:{value:null}},
  vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
  fragmentShader:'uniform sampler2D tDiffuse;varying vec2 vUv;void main(){vec4 c=texture2D(tDiffuse,vUv);vec3 col=c.rgb;float l=dot(col,vec3(.299,.587,.114));col=mix(vec3(l),col,1.08);col=(col-.5)*1.05+.5;col*=1.-.3*smoothstep(.4,.9,distance(vUv,vec2(.5)));gl_FragColor=vec4(col,c.a);}'}));
}
const renderMain=()=>composer?composer.render():renderer.render(scene,camera);
// The first time a material or texture is drawn the GPU has to compile/upload it, and that frame stalls
// (the hitch when the race starts). Do it all up front: show what is normally hidden (smoke, flames,
// skid marks, rain, other cars), compile every shader, upload every texture, then hide them again.
function warmUp(sc,cam){
 const hidden=[];sc.traverse(o=>{if(!o.visible){hidden.push(o);o.visible=true}});
 try{
  renderer.compile(sc,cam);
  const done=new Set();
  sc.traverse(o=>{for(const m of [].concat(o.material||[]))for(const k in m){const t=m[k];if(t&&t.isTexture&&!done.has(t)){done.add(t);renderer.initTexture(t)}}});
 }finally{hidden.forEach(o=>o.visible=false)}
}
const wind={value:0};   // shared clock for swaying grass and trees
const maxAniso=renderer.capabilities.getMaxAnisotropy();

const hemi=new THREE.HemisphereLight(0xcfeaff,0x334422,1.8);scene.add(hemi);
const sun=new THREE.DirectionalLight(0xffffff,3);
const SH=HIGH?110:70;
sun.castShadow=true;sun.shadow.mapSize.setScalar(HIGH?4096:2048);sun.shadow.bias=-.0004;sun.shadow.normalBias=.03;
Object.assign(sun.shadow.camera,{left:-SH,right:SH,top:SH,bottom:-SH,near:1,far:600});
scene.add(sun,sun.target);
scene.fog=new THREE.Fog(0xbfe3f5,200,900);
// aerial perspective instead of the stock linear fog: exponential haze that thins with altitude
// (tall things poke out of it) and picks up the sun's colour when you look towards the sun.
// near = where the haze starts, far = scale of its density. The sun values are shared arrays,
// so every built-in material gets them without touching it (cloneUniforms copies typed arrays by reference).
const fogSun=new Float32Array([0,1,0]),fogSunCol=new Float32Array(3);
for(const k in THREE.ShaderLib){const u=THREE.ShaderLib[k].uniforms;if(u&&u.fogColor){u.fogSunDir={value:fogSun};u.fogSunCol={value:fogSunCol}}}
THREE.ShaderChunk.fog_pars_vertex='#ifdef USE_FOG\nvarying float vFogDepth;varying vec3 vFogWorld;\n#endif';
THREE.ShaderChunk.fog_vertex='#ifdef USE_FOG\nvFogDepth=-mvPosition.z;vFogWorld=transpose(mat3(viewMatrix))*(mvPosition.xyz-viewMatrix[3].xyz);\n#endif';
THREE.ShaderChunk.fog_pars_fragment='#ifdef USE_FOG\nuniform vec3 fogColor,fogSunDir,fogSunCol;uniform float fogNear,fogFar;varying float vFogDepth;varying vec3 vFogWorld;\n#endif';
THREE.ShaderChunk.fog_fragment=`#ifdef USE_FOG
 vec3 fRay=vFogWorld-cameraPosition;float fLen=length(fRay);fRay/=max(fLen,1e-4);
 float fk=.011*fRay.y*fLen,fH=exp(-.011*max(cameraPosition.y,0.))*(abs(fk)>1e-3?(1.-exp(-fk))/fk:1.);
 float fogFactor=1.-exp(-max(fLen-fogNear,0.)*2./fogFar*fH);
 gl_FragColor.rgb=mix(gl_FragColor.rgb,fogColor+fogSunCol*pow(max(dot(fRay,fogSunDir),0.),3.),fogFactor);
#endif`;
// value noise for shaders that need world-space variation
const NOISE_GLSL=`float gh(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
 float gn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(gh(i),gh(i+vec2(1,0)),f.x),mix(gh(i+vec2(0,1)),gh(i+vec2(1,1)),f.x),f.y);}
 float gfbm(vec2 p){return gn(p)*.5+gn(p*2.03+3.1)*.25+gn(p*4.1+7.7)*.15+gn(p*8.3+1.3)*.1;}`;
// adds a world position varying to a built-in material's shaders
const withWorldPos=sh=>{sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 vWPos;').replace('#include <begin_vertex>','#include <begin_vertex>\nvWPos=(modelMatrix*vec4(position,1.)).xyz;');
 sh.fragmentShader=sh.fragmentShader.replace('#include <common>','#include <common>\nvarying vec3 vWPos;\n'+NOISE_GLSL)};

// textures painted while a track is being built are kept by call order and handed back on the next build,
// so switching tracks only rebuilds geometry. textures made outside a build live for the whole game
let building=false,buildTexN=0;const buildTex=[],staticTex=new Set();
function canvasTex(w,h,draw,repeat=true){
 if(building){const k=buildTexN++,key=w+'x'+h+draw.toString(),hit=buildTex[k];if(hit&&hit.key===key)return hit.tex}
 const t=paintTex(w,h,draw,repeat);
 if(building)buildTex[buildTexN-1]={key:w+'x'+h+draw.toString(),tex:t};
 staticTex.add(t);return t;
}
function paintTex(w,h,draw,repeat){
 const c=document.createElement('canvas');c.width=w;c.height=h;draw(c.getContext('2d'),w,h);
 const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;t.anisotropy=maxAniso;
 if(repeat){t.wrapS=t.wrapT=THREE.RepeatWrapping}
 return t;
}
const glowTex=canvasTex(64,64,(g,w,h)=>{const r=g.createRadialGradient(32,32,0,32,32,32);r.addColorStop(0,'#fff');r.addColorStop(.35,'#fffc');r.addColorStop(1,'#fff0');g.fillStyle=r;g.fillRect(0,0,w,h)},false);

// value noise + fbm for the procedural textures. pass a period to make it tile.
function hash2(x,y){let h=(Math.imul(x,374761393)+Math.imul(y,668265263))|0;h=Math.imul(h^(h>>>13),1274126177);return ((h^(h>>>16))>>>0)/4294967296}
function vnoise(x,y,p=0){
 const xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi,u=xf*xf*(3-2*xf),v=yf*yf*(3-2*yf);
 const w=k=>p?((k%p)+p)%p:k,x0=w(xi),x1=w(xi+1),y0=w(yi),y1=w(yi+1);
 const a=hash2(x0,y0),b=hash2(x1,y0),c=hash2(x0,y1),d=hash2(x1,y1);
 return a+(b-a)*u+(c-a)*v+(a-b-c+d)*u*v;
}
function fbm(x,y,oct=4,p=0){let s=0,amp=.5,f=1,norm=0;for(let i=0;i<oct;i++){s+=amp*vnoise(x*f,y*f,p*f);norm+=amp;f*=2;amp*=.5}return s/norm}
// fills a canvas pixel by pixel; fn(x,y) returns [r,g,b]
function paintPixels(g,w,h,fn){const img=g.createImageData(w,h),d=img.data;
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const c=fn(x,y),i=(y*w+x)*4;d[i]=c[0];d[i+1]=c[1];d[i+2]=c[2];d[i+3]=c[3]??255}
 g.putImageData(img,0,0)}
const dataTex=t=>{t.colorSpace=THREE.NoColorSpace;return t};
// grey height canvas -> tangent-space normal map
function heightToNormal(src,strength){const w=src.width,h=src.height;   // reads the pixels only if it isn't cached
 return dataTex(canvasTex(w,h,g=>{const d=src.getContext('2d').getImageData(0,0,w,h).data;paintPixels(g,w,h,(x,y)=>{const H=(xx,yy)=>d[(((yy+h)%h)*w+((xx+w)%w))*4]/255;
  const nx=(H(x-1,y)-H(x+1,y))*strength,ny=(H(x,y-1)-H(x,y+1))*strength,l=Math.hypot(nx,ny,1);return [(nx/l*.5+.5)*255,(ny/l*.5+.5)*255,(1/l*.5+.5)*255]})}))}
// alpha-tested foliage thins out and vanishes in the small mip levels (far trees turn into bare sticks).
// build the mips by hand and scale each level's alpha so the share of pixels passing the test stays the same.
function keepCoverage(tex,cut=.5){
 if(tex.userData.kept)return tex;tex.userData.kept=true;
 const cov=(d,k)=>{let n=0;for(let i=3;i<d.length;i+=4)if(d[i]*k>cut*255)n++;return n/(d.length/4)};
 let src=tex.image;const target=cov(src.getContext('2d').getImageData(0,0,src.width,src.height).data,1),mips=[src];
 while(src.width>1||src.height>1){
  const c=document.createElement('canvas');c.width=Math.max(1,src.width>>1);c.height=Math.max(1,src.height>>1);
  const g=c.getContext('2d');g.drawImage(src,0,0,c.width,c.height);
  const img=g.getImageData(0,0,c.width,c.height),d=img.data;
  let lo=1,hi=8;for(let i=0;i<12;i++){const m=(lo+hi)/2;cov(d,m)<target?lo=m:hi=m}
  for(let i=3;i<d.length;i+=4)d[i]=Math.min(255,d[i]*hi);g.putImageData(img,0,0);
  mips.push(c);src=c}
 tex.mipmaps=mips;tex.generateMipmaps=false;return tex;
}
const lerp=(a,b,t)=>a+(b-a)*t,smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t)};

// ---------- sky ----------
// sky: scattering-style gradient (deep zenith, milky horizon, warm side towards the sun), sun halo + disc,
// domain-warped cumulus lit by marching a few steps towards the sun (dark bellies, bright silver edges),
// thin cirrus streaks above them. Tone mapped like the rest of the scene and baked into the reflections.
const skyMat=new THREE.ShaderMaterial({
 side:THREE.BackSide,depthWrite:false,fog:false,defines:{SHADOW_STEPS:HIGH?4:2},
 uniforms:{zenith:{value:new THREE.Color()},horizon:{value:new THREE.Color()},sunCol:{value:new THREE.Color()},sunDir:{value:new THREE.Vector3(0,1,0)},
  cloudCover:{value:.4},cloudCol:{value:new THREE.Color()},cloudDark:{value:new THREE.Color()},time:{value:0},glow:{value:1},disc:{value:1}},
 vertexShader:'varying vec3 vP;void main(){vP=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
 fragmentShader:`uniform vec3 zenith,horizon,sunCol,sunDir,cloudCol,cloudDark;uniform float cloudCover,time,glow,disc;varying vec3 vP;
 float h21(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
 float vn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y);}
 float fbm(vec2 p){float s=0.,a=.5;for(int i=0;i<6;i++){s+=a*vn(p);p=p*2.02+vec2(1.7,9.2);a*=.5;}return s;}
 float fbm3(vec2 p){float s=0.,a=.5;for(int i=0;i<3;i++){s+=a*vn(p);p=p*2.02+vec2(1.7,9.2);a*=.5;}return s/.875;}
 void main(){
  vec3 d=normalize(vP);float h=d.y,hz=max(h,0.);
  float mu=dot(d,sunDir),mu0=max(mu,0.);
  vec3 col=mix(horizon,zenith,1.-exp(-hz*4.2));
  col=mix(col,horizon*1.06+.015,exp(-abs(h-.015)*22.)*.45);                 // haze band
  col+=sunCol*pow(mu0,3.)*exp(-hz*3.)*.35*glow;                               // warm horizon on the sun side
  col*=1.-.12*(1.-mu0)*(1.-exp(-hz*3.));                                      // a touch deeper away from the sun
  col=mix(col,horizon*.72,smoothstep(0.,-.25,h));
  float clear=1.-smoothstep(.55,.92,cloudCover);
  col+=sunCol*(pow(mu0,8.)*.2+pow(mu0,64.)*.45+pow(mu0,900.)*1.2)*glow*(.35+.65*clear);
  col+=sunCol*smoothstep(.99955,.9997,mu)*16.*disc*clear;
  if(h>0.){
   vec2 wnd=vec2(time*.006,time*.002),uv=d.xz/(h+.12)*1.6+wnd;
   // cirrus: stretched, faint, high
   vec2 cu=d.xz/(h+.3)*.55+wnd*.5;
   float ci=smoothstep(.55,.85,fbm3(vec2(cu.x*.8+cu.y*.6,cu.y*2.2-cu.x*.5)*1.4))*fbm3(cu*3.);
   col=mix(col,mix(cloudCol,sunCol,.25*glow)*1.05,ci*.22*clear*smoothstep(.08,.4,h));
   // cumulus
   vec2 q=vec2(fbm3(uv*.7),fbm3(uv*.7+vec2(5.2,1.3)));
   vec2 p=uv+(q-.5)*.55;
   float n=fbm(p),cov=1.-cloudCover;
   float dens=smoothstep(cov-.08,cov+.3,n);
   if(dens>.001){
    vec2 st=normalize(sunDir.xz+1e-4)*.07*(1.-sunDir.y*.5);
    float od=0.;for(int i=1;i<=SHADOW_STEPS;i++)od+=smoothstep(cov-.08,cov+.3,fbm(p+st*float(i)));od*=4./float(SHADOW_STEPS);
    float lit=exp(-od*.75)*(1.-exp(-dens*2.5)*.35);                         // beer + powder
    vec3 cc=mix(cloudDark,cloudCol,clamp(lit*1.25,0.,1.));
    cc+=sunCol*pow(mu0,5.)*(1.-dens)*1.6*glow;                               // silver lining
    cc=mix(cc,horizon*1.05,exp(-h*7.)*.65);                                  // far clouds sink into the haze
    col=mix(col,cc,dens*smoothstep(0.,.07,h));
   }
  }
  gl_FragColor=vec4(col,1.);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
 }`
});
const sky=new THREE.Mesh(new THREE.SphereGeometry(1800,48,24),skyMat);scene.add(sky);noAO.push(sky);
// moon (night only)
const sunDisc=new THREE.Sprite(new THREE.SpriteMaterial({map:glowTex,color:0xdfe8ff,fog:false,depthWrite:false,blending:THREE.AdditiveBlending}));
sunDisc.scale.set(90,90,1);scene.add(sunDisc);noAO.push(sunDisc);
const stars=(()=>{const n=2200,a=new Float32Array(n*3);for(let i=0;i<n;i++){const v=new THREE.Vector3(rand(-1,1),rand(.05,1),rand(-1,1)).normalize().multiplyScalar(1600);a.set([v.x,v.y,v.z],i*3)}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(a,3));
 return new THREE.Points(g,new THREE.PointsMaterial({color:0xffffff,size:1.8,sizeAttenuation:false,fog:false}))})();
scene.add(stars);

// ---------- track ----------
// three circuits, each one built at load (switching reloads the page so the scenery is laid out around it)
const TRACKS=[
 // 3.3 km: long main straight into a fast right, the east sweepers, a chicane, the back straight,
 // the west hairpin and the twisty esses back onto the straight
 {name:'KOD Grand Prix',desc:'Fast sweepers, a chicane and a tight hairpin',cp:[[-170,300],[100,300],[380,300],[452,262],[462,182],[420,122],[440,40],[500,-20],[500,-120],[440,-200],[340,-230],[262,-188],[200,-232],[100,-280],[-50,-300],[-250,-300],[-385,-282],[-445,-228],[-430,-168],[-370,-150],[-250,-150],[-180,-100],[-220,-30],[-160,30],[-220,90],[-330,120],[-420,160],[-430,240],[-370,293],[-290,301]]},
 // 2.9 km, traced from Imola, anticlockwise: Tamburello and Villeneuve chicanes, the Tosa hairpin,
 // Piratella, Acque Minerali, the Variante Alta chicane and the double left of Rivazza
 {name:'Imola',desc:'Old-school: chicanes, the Tosa hairpin and the double left at Rivazza',cp:[[-302,232],[-132,224],[8,266],[128,272],[208,252],[244,224],[284,204],[320,216],[352,188],[376,148],[408,72],[438,-18],[462,-72],[488,-116],[518,-176],[552,-232],[556,-264],[528,-280],[468,-284],[348,-288],[248,-280],[198,-268],[174,-232],[158,-158],[160,-88],[174,-38],[156,-4],[108,6],[-32,6],[-140,6],[-168,-6],[-200,-4],[-232,16],[-372,102],[-472,172],[-536,212],[-556,256],[-528,288],[-452,272],[-372,246]]},
 // 3.6 km, traced from Suzuka: the esses, Degner, under the bridge to the hairpin, Spoon, then the back
 // straight over the bridge, 130R and the chicane. bridge: the later of the two crossing parts goes over
 {name:'Suzuka',desc:'Figure of eight: the esses, Spoon, 130R and the bridge',cp:[[146,-314],[356,-316],[513,-318],[576,-309],[612,-278],[616,-233],[580,-206],[502,-215],[428,-192],[360,-215],[292,-179],[225,-192],[166,-224],[108,-226],[58,-197],[27,-154],[14,-98],[18,-30],[50,24],[45,69],[9,100],[-68,78],[-158,33],[-212,-12],[-248,-44],[-274,-73],[-304,-71],[-308,-42],[-290,3],[-270,55],[-261,100],[-270,132],[-308,154],[-376,177],[-450,204],[-526,233],[-590,262],[-616,294],[-594,318],[-500,289],[-387,240],[-274,183],[-173,132],[-76,87],[-54,37],[-45,-30],[-45,-165],[-56,-210],[-34,-246],[2,-278],[58,-305]],bridge:true}];
let TRACK,CP,P,L,DS,T,R,KS,HY,bridge,lineLat,PIT_S,DRS_Z=[],WL,WR;
// ---------- pit lane ----------
// like F1: on the left of the main straight the lane splits off before the finish line, runs behind a pit
// wall past a row of garages and joins the track again after the start. 80 km/h limiter in the lane.
// lateral layout (left of the track): kerb to 9.6, run-off to the pit wall (12.75-13.25), fast lane, then
// the working lane with the boxes in front of the garages (from 22.5 out)
const PIT_WALL=13,LANE_MID=18,LANE_OUT=22.5,PIT_E=60,PIT_X=60,PIT_LIM=22.2,GARAGE_D=11,BAY=7.5,PIT_SLOTS=4;
let PIT=null,pitCrew=null;
const pitRel=s=>{let d=wrapS(s);if(d>L/2)d-=L;return d};
// where the lane is at s: null off the pit straight; out = how far left the tarmac reaches; wall = pit wall stands there
function pitZone(s){
 if(!PIT)return null;const r=pitRel(s);if(r<PIT.a||r>PIT.b)return null;
 const t=Math.min((r-PIT.a)/PIT_E,(PIT.b-r)/PIT_X);
 return t>=1?{r,out:LANE_OUT,wall:true}:{r,out:lerp(WALL,LANE_OUT,smooth(0,1,t)),wall:false};
}
const inPitArea=(x,z)=>!!PIT&&(PIT.pts.some(([px,pz])=>(px-x)**2+(pz-z)**2<17*17)||PIT.stand.some(([px,pz])=>(px-x)**2+(pz-z)**2<24*24));
// the first seconds after the lights go out cars pass through each other, so a perfect launch can't end in a pile-up
const START_GHOST=5,startGhost=()=>state==='race'&&raceTime<START_GHOST;
const pitGhost=(z,lat)=>!!z&&lat<-(CURB+.5);
const onPitTarmac=(s,lat)=>{const z=pitZone(s);return !!z&&lat<-CURB&&lat>-z.out-.6};
// strips that follow the track between two distances from the start line; lat0/lat1 may change along it
function pitStrip(r0,r1,lat0,lat1,y,mat,uLen=16,vLen=22){
 const pos=[],uv=[],idx=[],n=Math.max(1,Math.ceil((r1-r0)/2));
 for(let i=0;i<=n;i++){const r=lerp(r0,r1,i/n),a=lat0(r),b=lat1(r),p=trackAt(r,a),q=trackAt(r,b);
  pos.push(p.x,y+p.y,p.z,q.x,y+q.y,q.z);uv.push(a/uLen,r/vLen,b/uLen,r/vLen);
  if(i<n){const k=i*2;idx.push(k,k+2,k+1,k+1,k+2,k+3)}}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
 g.setIndex(idx);g.computeVertexNormals();
 const m=new THREE.Mesh(g,mat);m.receiveShadow=true;trackGroup.add(m);return m;
}
// a solid barrier along a line: two faces and a top, `t` thick, outward from lat
function pitBlock(r0,r1,lat,h,t,mat,y0=0,uLen=3){
 const pos=[],uv=[],idx=[],n=Math.max(1,Math.ceil((r1-r0)/2)),v=[];
 for(let i=0;i<=n;i++){const r=lerp(r0,r1,i/n),a=lat(r),p=trackAt(r,a),q=trackAt(r,a-t),u=r/uLen;
  v.push([[p.x,y0+p.y,p.z],[p.x,y0+h+p.y,p.z],[q.x,y0+h+q.y,q.z],[q.x,y0+q.y,q.z],u])}
 for(let i=0;i<n;i++)for(let f=0;f<3;f++){const A=v[i],B=v[i+1],k=pos.length/3;
  pos.push(...A[f],...B[f],...B[f+1],...A[f+1]);uv.push(A[4],f/3,B[4],f/3,B[4],(f+1)/3,A[4],(f+1)/3);idx.push(k,k+1,k+2,k,k+2,k+3)}
 // end caps
 for(const A of [v[0],v[n]]){const k=pos.length/3;pos.push(...A[0],...A[1],...A[2],...A[3]);uv.push(0,0,0,1,.3,1,.3,0);idx.push(k,k+1,k+2,k,k+2,k+3)}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
 g.setIndex(idx);g.computeVertexNormals();
 const m=new THREE.Mesh(g,mat.side===THREE.DoubleSide?mat:(mat.userData.ds||(mat.userData.ds=Object.assign(mat.clone(),{side:THREE.DoubleSide}))));
 m.castShadow=m.receiveShadow=true;trackGroup.add(m);return m;
}
function buildPit(){
 const {a,b,nb,r0}=PIT,g0=a+PIT_E,g1=b-PIT_X,out=r=>-(pitZone(r)?.out??WALL);
 // tarmac from the kerb to the garages, the same asphalt as the track
 pitStrip(a-4,b+4,()=>-CURB,out,.05,roadMat);
 // paint: the entry and exit lines that split off the track edge, the lane divider, the limiter lines
 const paint=new THREE.MeshStandardMaterial({color:0xf2f2ee,roughness:.6,polygonOffset:true,polygonOffsetFactor:-3});
 const ramp=(r,from,len,dir)=>-lerp(ROAD+.2,PIT_WALL-.3,smooth(0,1,dir*(r-from)/len));
 pitStrip(a,g0,r=>ramp(r,a,PIT_E,1),r=>ramp(r,a,PIT_E,1)-.25,.07,paint);
 pitStrip(g1,b,r=>ramp(r,b,PIT_X,-1),r=>ramp(r,b,PIT_X,-1)-.25,.07,paint);
 const dash=new THREE.MeshStandardMaterial({color:0xf2f2ee,roughness:.6,transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-3,
  alphaMap:canvasTex(8,64,(g,w,h)=>{g.fillStyle='#000';g.fillRect(0,0,w,h);g.fillStyle='#fff';g.fillRect(0,0,w,h*.55)})});
 // the lane itself is light concrete, with a red band along the pit wall
 pitStrip(g0,g1,()=>-PIT_WALL-.25,()=>-LANE_OUT,.06,new THREE.MeshStandardMaterial({map:concreteTex,color:0xc9c7c2,roughness:.85,polygonOffset:true,polygonOffsetFactor:-2}),8,8);
 pitStrip(g0,g1,()=>-PIT_WALL-.28,()=>-PIT_WALL-1.05,.065,new THREE.MeshStandardMaterial({color:0xc4232b,roughness:.7,polygonOffset:true,polygonOffsetFactor:-3}));
 pitStrip(g0,g1,()=>-LANE_MID+.1,()=>-LANE_MID-.1,.07,dash,1,4);
 for(const r of [g0,g1])pitStrip(r,r+.4,()=>-PIT_WALL-.3,()=>-LANE_OUT+.1,.07,paint);
 // pit wall: concrete with the catch fence on top, impact barriers on both noses
 const concrete=new THREE.MeshStandardMaterial({map:concreteTex,roughness:.9});
 pitBlock(g0,g1,()=>-PIT_WALL+.25,1.15,.5,concrete);
 const fenceMat=new THREE.MeshStandardMaterial({map:fenceTex,alphaTest:.4,alphaToCoverage:true,side:THREE.DoubleSide,metalness:.6,roughness:.45});
 {const pos=[],uv=[],idx=[],n=Math.ceil((g1-g0-6)/2);
  for(let i=0;i<=n;i++){const r=lerp(g0+3,g1-3,i/n),p=trackAt(r,-PIT_WALL);pos.push(p.x,1.15+p.y,p.z,p.x,3.9+p.y,p.z);uv.push(r/1.25,0,r/1.25,2.2);if(i<n){const k=i*2;idx.push(k,k+2,k+1,k+1,k+2,k+3)}}
  const fg=new THREE.BufferGeometry();fg.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));fg.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));fg.setIndex(idx);fg.computeVertexNormals();
  const f=new THREE.Mesh(fg,fenceMat);trackGroup.add(f);noAO.push(f)}
 const chev=new THREE.MeshStandardMaterial({map:canvasTex(128,64,(g,w,h)=>{g.fillStyle='#f6c400';g.fillRect(0,0,w,h);g.fillStyle='#111';for(let x=-64;x<w;x+=32){g.beginPath();g.moveTo(x,0);g.lineTo(x+16,0);g.lineTo(x+48,h);g.lineTo(x+32,h);g.fill()}}),roughness:.6});
 for(const [r,d] of [[g0,-1],[g1,1]]){const p=trackAt(r+d*1.6,-PIT_WALL),m=new THREE.Mesh(new THREE.BoxGeometry(1.4,1.1,3.2),chev);m.position.set(p.x,.55+p.y,p.z);m.rotation.y=p.angle;m.castShadow=true;trackGroup.add(m)}
 // the outside barrier follows the lane out to the pit building and back
 pitBlock(a-3,g0+1,r=>out(r)-.05,1,.45,concrete);pitBlock(g1-1,b+3,r=>out(r)-.05,1,.45,concrete);
 // the pit building: one unit per bay, each set square to the track where it stands. the bays on the ends
 // stay shut; the ones in between get a team each race (buildBoxes)
 const kit=new Map(),put=(mat,geo,mtx)=>{geo.applyMatrix4(mtx);if(!kit.has(mat))kit.set(mat,[]);kit.get(mat).push(geo)};
 const M=new THREE.Matrix4(),T=new THREE.Matrix4(),box=(mat,base,w,h,d,x,y,z)=>{put(mat,new THREE.BoxGeometry(w,h,d),T.copy(base).multiply(M.makeTranslation(x,y,z)))};
 const shell=new THREE.MeshStandardMaterial({color:0xe9ecef,roughness:.55}),dark=new THREE.MeshStandardMaterial({color:0x2b3036,roughness:.6,metalness:.3});
 const floorM=new THREE.MeshStandardMaterial({color:0xb9bec4,roughness:.28,metalness:.05}),backM=new THREE.MeshStandardMaterial({color:0x8d939a,roughness:.7});
 const glass=new THREE.MeshStandardMaterial({color:0x1d2c3c,roughness:.08,metalness:.7,emissive:0x0c1a28});
 const lamp=new THREE.MeshStandardMaterial({color:0xffffff,emissive:0xf4f8ff,emissiveIntensity:1.6});
 const door=new THREE.MeshStandardMaterial({map:canvasTex(64,128,(g,w,h)=>{g.fillStyle='#c9ced4';g.fillRect(0,0,w,h);for(let y=0;y<h;y+=8){g.fillStyle='#9aa1a9';g.fillRect(0,y,w,2)}}),roughness:.5,metalness:.4});
 const tyre=[],cab=[];PIT.bays=[];
 const shellW=new THREE.MeshStandardMaterial({color:0xf3f3f1,roughness:.6,side:THREE.DoubleSide});
 const bandMats=[];for(let i=0;i<nb;i++){const t=canvasTex(512,64,(g,w,h)=>{g.fillStyle='#0d3b2a';g.fillRect(0,0,w,h);g.fillStyle='#d8b55a';g.fillRect(0,0,w,3);g.fillRect(0,h-3,w,3);
   g.font='bold 30px Georgia';g.textBaseline='middle';g.fillStyle='#e9c86a';g.textAlign='left';g.fillText('♛ KRONOS',18,h/2+2);g.textAlign='right';g.fillStyle='#fff';g.font='bold 34px Arial';g.fillText(String(nb-i+20),w-18,h/2+2)},false);
  bandMats.push(new THREE.MeshStandardMaterial({map:t,roughness:.5}))}
 for(let k=0;k<=nb;k++){
  const r=r0+k*BAY,p=trackAt(r,-LANE_OUT),base=new THREE.Matrix4().makeRotationY(p.angle).setPosition(p.x,p.y,p.z);
  // the wall between two bays, then the bay itself (local: x away from the lane, y up, z along the track)
  box(shell,base,GARAGE_D,9.2,.35,GARAGE_D/2,4.6,0);
  if(k===nb)break;
  const c=trackAt(r+BAY/2,-LANE_OUT),B=new THREE.Matrix4().makeRotationY(c.angle).setPosition(c.x,c.y,c.z),shut=k===0||k===nb-1;
  PIT.bays.push(B);
  box(floorM,B,GARAGE_D,.06,BAY,GARAGE_D/2,.03,0);
  box(backM,B,.3,5,BAY,GARAGE_D,2.5,0);
  box(shell,B,GARAGE_D+.6,.45,BAY,GARAGE_D/2-.3,5.2,0);                // ceiling slab
  box(dark,B,.5,.8,BAY,.25,4.6,0);                                     // header over the door
  // first floor: glazed from floor to roof in steel mullions, a rail in front
  box(glass,B,.12,3.5,BAY-.2,1.4,7.25,0);for(const z of [-BAY/2+.1,-BAY/4,0,BAY/4])box(dark,B,.16,3.5,.1,1.36,7.25,z);
  box(shell,B,GARAGE_D-1.4,3.9,BAY,GARAGE_D/2+.7,7.4,0);box(dark,B,.05,.05,BAY,.1,6.4,0);box(dark,B,.05,1,.05,.1,5.9,-BAY/2+.2);
  box(dark,B,GARAGE_D+.6,.3,BAY+.02,GARAGE_D/2-.3,9.3,0);
  // the sponsor band over the doors, with the garage number
  put(bandMats[k%bandMats.length],new THREE.PlaneGeometry(BAY,.45).rotateY(-Math.PI/2),T.copy(B).multiply(M.makeTranslation(-.62,5.2,0)));
  // a white wave of roof over each bay, overhanging the lane
  // (a slice of cylinder turned so its axis runs away from the lane and it arches along the building)
  put(shellW,new THREE.CylinderGeometry(6,6,GARAGE_D+3.2,16,1,true,-.675,1.35).applyMatrix4(new THREE.Matrix4().set(0,1,0,0,0,0,1,0,1,0,0,0,0,0,0,1)),T.copy(B).multiply(M.makeTranslation(GARAGE_D/2-1.2,3.9,0)));
  if(shut){put(door,new THREE.BoxGeometry(.12,4.2,BAY-.35),T.copy(B).multiply(M.makeTranslation(.3,2.1,0)));continue}
  for(const z of [-1.8,1.8])box(lamp,B,6,.08,.35,GARAGE_D/2,4.95,z);    // light strips
  for(const z of [-2.6,-1.6,1.6,2.6])tyre.push([B,GARAGE_D-1,z]);
  for(const z of [-1.5,0,1.5])cab.push([B,GARAGE_D-.55,z]);
 }
 for(const [mat,list] of kit){const m=new THREE.Mesh(mergeGeos(list),mat);m.castShadow=m.receiveShadow=true;trackGroup.add(m);list.forEach(g=>g.dispose())}
 // tyre racks and tool trolleys in the team garages
 {const tg=new THREE.CylinderGeometry(.34,.34,.27,14),im=new THREE.InstancedMesh(tg,new THREE.MeshStandardMaterial({color:0x151517,roughness:.85}),tyre.length*4);let n=0;
  for(const [B,x,z] of tyre)for(let h=0;h<4;h++)im.setMatrixAt(n++,T.copy(B).multiply(M.makeTranslation(x,.14+h*.28,z)));im.castShadow=true;trackGroup.add(im);
  const cm=new THREE.InstancedMesh(new THREE.BoxGeometry(.6,1.05,1.2),new THREE.MeshStandardMaterial({color:0x3a4048,roughness:.4,metalness:.4}),cab.length);n=0;
  for(const [B,x,z] of cab)cm.setMatrixAt(n++,T.copy(B).multiply(M.makeTranslation(x,.53,z)));cm.castShadow=true;trackGroup.add(cm)}
 // a row of flags along the roof
 {const fl=[];for(let k=0;k<nb;k++)for(const z of [-2,2])fl.push([PIT.bays[k],z]);
  const pole=new THREE.InstancedMesh(new THREE.CylinderGeometry(.04,.05,3,6),dark,fl.length),flag=new THREE.InstancedMesh(new THREE.PlaneGeometry(1.4,.9).translate(.7,1.1,0),flagMat(),fl.length),col=new THREE.Color();
  fl.forEach(([B,z],n)=>{pole.setMatrixAt(n,T.copy(B).multiply(M.makeTranslation(GARAGE_D-1,11.2,z)));flag.setMatrixAt(n,T.copy(B).multiply(M.makeTranslation(GARAGE_D-1,11.2,z)).multiply(M.makeRotationY(Math.PI/2)));
   flag.setColorAt(n,col.setHSL(n*.17%1,.75,.5))});trackGroup.add(pole,flag)}
 pitBoxGroup=null;
}
// waving cloth for flags: a sine running along the flag from the pole, more at the free end
function flagMat(){
 const m=new THREE.MeshStandardMaterial({side:THREE.DoubleSide,roughness:.8});
 m.onBeforeCompile=sh=>{sh.uniforms.uWind=wind;sh.vertexShader='uniform float uWind;\n'+sh.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
  float ph=instanceMatrix[3].x*.3+instanceMatrix[3].z*.2,k=position.x/1.4;
  transformed.z+=sin(uWind*6.+ph-position.x*3.)*.18*k;transformed.y+=sin(uWind*4.+ph-position.x*2.)*.05*k;`)};
 return m;
}
// the teams of this race: one box and garage per car, in a fixed order so everyone online sees the same pit
function boxCars(){
 if(mp.on&&mp.order?.length){const hum=mp.order.map(id=>id===mp.id?player:cars.find(c=>c.remote&&c.id===id)).filter(Boolean);return [...hum,...cars.filter(c=>!hum.includes(c))].slice(0,PIT_SLOTS)}
 return cars.slice(0,PIT_SLOTS);
}
const slotRel=k=>PIT.r0+(k+1.5)*BAY;
let pitBoxGroup=null,pitBoxKey='';
// pit crew: F1 mechanics in fireproof overalls (team colour, a contrast band and side panels), gloves, boots and a
// full helmet (round shell, chin guard, dark visor). built as body + two legs + two arms on hip / shoulder pivots,
// so ours can run out to the car swinging their arms and legs, kneel at the wheels and lean on the jacks.
// the colours are baked in as vertex colours: one material, one draw call per piece
const CREW_HIP=[.11,.93],CREW_SHOULDER=[.25,1.43];
const CREW_PARTS=(()=>{
 const P={body:[],leg:[],arm:[]},at=(part,geo,col,x,y,z,s)=>{if(s)geo.scale(...s);geo.translate(x,y,z);P[part].push([geo,col])};
 const cap=(r,l,n=10)=>new THREE.CapsuleGeometry(r,l,3,n);
 // body: hips, a chest wider than the waist (lathe), a contrast band, shoulders, neck, helmet
 at('body',new THREE.CapsuleGeometry(.17,.12,3,12).rotateZ(Math.PI/2),'suit',0,.96,0,[1,1,.72]);
 {const prof=[[0,.95],[.18,.96],[.17,1.06],[.18,1.18],[.205,1.3],[.222,1.4],[.205,1.47],[.14,1.52],[.065,1.55],[0,1.555]].map(([r,y])=>new THREE.Vector2(r,y));
  const t=new THREE.LatheGeometry(prof,16);at('body',t,'suit',0,0,0,[1,1,.66])}
 at('body',new THREE.CylinderGeometry(.172,.17,.07,16,1,true),'accent',0,1.13,0,[1,1,.68]);
 for(const s of [-1,1]){at('body',new THREE.BoxGeometry(.02,.32,.14),'accent',s*.19,1.27,0);at('body',new THREE.SphereGeometry(.088,10,8),'suit',s*.215,1.44,0)}
 at('body',new THREE.CylinderGeometry(.058,.065,.1,10),'dark',0,1.6,0);
 {const shell=new THREE.SphereGeometry(.152,18,12,0,Math.PI*2,0,Math.PI*.64);at('body',shell,'helm',0,1.72,-.005,[1,1.04,1.1])}
 at('body',new THREE.TorusGeometry(.128,.04,8,18,Math.PI).rotateX(Math.PI/2).rotateY(Math.PI),'helm',0,1.63,.012,[1,1,1.05]);   // chin guard
 at('body',new THREE.SphereGeometry(.158,18,6,Math.PI/2-.95,1.9,Math.PI*.38,Math.PI*.18),'visor',0,1.72,0,[1,1.04,1.1]);     // visor
 at('body',new THREE.BoxGeometry(.03,.025,.3),'accent',0,1.875,-.01);                                                           // stripe over the top
 // a leg hangs from the hip: thigh, shin, boot
 at('leg',cap(.1,.28),'suit',0,-.24,0);at('leg',cap(.082,.3),'suit',0,-.64,.01);at('leg',new THREE.BoxGeometry(.13,.1,.28),'dark',0,-.88,.05);
 // an arm from the shoulder: upper arm, forearm a little forward, glove
 at('arm',cap(.072,.18),'suit',0,-.15,0);at('arm',cap(.062,.19),'suit',0,-.4,.04);at('arm',new THREE.SphereGeometry(.064,8,6),'dark',0,-.56,.07,[1,1.2,1]);
 return P})();
function crewPiece(part,cols){
 const geos=CREW_PARTS[part].map(([g])=>g.index?g.toNonIndexed():g);let n=0;geos.forEach(g=>n+=g.attributes.position.count);
 const pos=new Float32Array(n*3),nor=new Float32Array(n*3),col=new Float32Array(n*3),c=new THREE.Color();let o=0;
 geos.forEach((g,k)=>{const cnt=g.attributes.position.count;pos.set(g.attributes.position.array,o*3);nor.set(g.attributes.normal.array,o*3);c.set(cols[CREW_PARTS[part][k][1]]);
  for(let i=0;i<cnt;i++){col[(o+i)*3]=c.r;col[(o+i)*3+1]=c.g;col[(o+i)*3+2]=c.b}o+=cnt});
 const m=new THREE.BufferGeometry();m.setAttribute('position',new THREE.BufferAttribute(pos,3));m.setAttribute('normal',new THREE.BufferAttribute(nor,3));m.setAttribute('color',new THREE.BufferAttribute(col,3));
 return m;
}
// the crew kit for one team: the three pieces, and a whole standing figure in one geometry for the static crews
function crewKit(cols){
 const body=crewPiece('body',cols),leg=crewPiece('leg',cols),arm=crewPiece('arm',cols),M=new THREE.Matrix4();
 const whole=[body.clone()];for(const s of [-1,1]){whole.push(leg.clone().applyMatrix4(M.makeTranslation(s*CREW_HIP[0],CREW_HIP[1],0)));whole.push(arm.clone().applyMatrix4(new THREE.Matrix4().makeTranslation(s*CREW_SHOULDER[0],CREW_SHOULDER[1],0).multiply(M.makeRotationZ(s*.1))))}
 return {body,leg,arm,whole:mergeColored(whole)};
}
// one of ours, with joints
function crewRig(kit,mat,parent){
 const g=new THREE.Group(),body=new THREE.Group();g.add(body);parent.add(g);
 const mesh=geo=>{const m=new THREE.Mesh(geo,mat);m.castShadow=true;return m};
 body.add(mesh(kit.body));const legs=[],arms=[];
 for(const s of [-1,1]){const h=new THREE.Group();h.position.set(s*CREW_HIP[0],CREW_HIP[1],0);h.add(mesh(kit.leg));body.add(h);legs.push(h);
  const a=new THREE.Group();a.position.set(s*CREW_SHOULDER[0],CREW_SHOULDER[1],0);a.rotation.z=s*.1;a.add(mesh(kit.arm));body.add(a);arms.push(a)}
 return {g,body,legs,arms};
}
function buildBoxes(){
 if(!PIT?.bays)return;
 const list=boxCars(),col=c=>{const p=c.car.paint;return p?(p.userData.col||p.color).getHex():c.color},nm=c=>c===player&&mp.on?playerName():c===player?'KOD RACING':c.name;
 const key=TRACK+'|'+list.map(c=>nm(c)+col(c)).join('|');if(key===pitBoxKey&&pitBoxGroup?.parent)return;pitBoxKey=key;
 if(pitBoxGroup){pitBoxGroup.traverse(o=>{o.geometry?.dispose();for(const m of [].concat(o.material||[])){m.map?.dispose();m.emissiveMap?.dispose();m.dispose()}});pitBoxGroup.parent?.remove(pitBoxGroup)}
 const G=pitBoxGroup=new THREE.Group();trackGroup.add(G);
 const kit=new Map(),put=(mat,geo,mtx)=>{geo.applyMatrix4(mtx);if(!kit.has(mat))kit.set(mat,[]);kit.get(mat).push(geo)};
 const M=new THREE.Matrix4(),T=new THREE.Matrix4(),box=(mat,base,w,h,d,x,y,z)=>put(mat,new THREE.BoxGeometry(w,h,d),T.copy(base).multiply(M.makeTranslation(x,y,z)));
 const cyl=(mat,base,r,h,x,y,z,rx=0,rz=0)=>put(mat,new THREE.CylinderGeometry(r,r,h,12).rotateX(rx).rotateZ(rz),T.copy(base).multiply(M.makeTranslation(x,y,z)));
 const plane=(mat,base,w,h,x,y,z,ry)=>put(mat,new THREE.PlaneGeometry(w,h).rotateY(ry),T.copy(base).multiply(M.makeTranslation(x,y,z)));
 const steel=new THREE.MeshStandardMaterial({color:0x3a4048,metalness:.7,roughness:.35}),dark=new THREE.MeshStandardMaterial({color:0x22262b,roughness:.6,metalness:.3});
 const lamp=new THREE.MeshStandardMaterial({color:0xffffff,emissive:0xf4f8ff,emissiveIntensity:1.8}),rub=new THREE.MeshStandardMaterial({color:0x151517,roughness:.85});
 const door=new THREE.MeshStandardMaterial({color:0xc9ced4,roughness:.5,metalness:.4}),hose=new THREE.MeshStandardMaterial({color:0x111214,roughness:.7});
 const crewMat=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.6});
 const kioskM=new THREE.MeshStandardMaterial({color:0xe9ebee,roughness:.35,metalness:.3}),darkGlass=new THREE.MeshStandardMaterial({color:0x101820,roughness:.1,metalness:.6});
 const screenTex=paintTex(256,160,(g,w,h)=>{g.fillStyle='#05080d';g.fillRect(0,0,w,h);g.fillStyle='#e10600';g.fillRect(0,0,w,18);g.font='bold 13px Arial';g.fillStyle='#fff';g.fillText('LIVE TIMING',8,13);
  for(let r=0;r<8;r++){g.fillStyle=r%2?'#0c1420':'#09101a';g.fillRect(0,22+r*17,w,17);g.fillStyle=['#ffd21e','#fff','#fff','#4cff8a','#fff','#fff','#9fb0c2','#fff'][r];g.font='12px Arial';
   g.fillText((r+1)+'  '+['VOR','BOL','TIG','KOD','APX','NOV','ORB','ZEN'][r]+'   1:'+(20+r*.37).toFixed(3),8,35+r*17)}},false);
 const screenM=new THREE.MeshStandardMaterial({map:screenTex,emissive:0xffffff,emissiveMap:screenTex,emissiveIntensity:.9,roughness:.3});
 const garageX=LANE_OUT+PIT_LAT;   // box centre to the garage front, along local +x
 const hexS=h=>'#'+h.toString(16).padStart(6,'0');
 pitCrew=null;
 for(let k=0;k<PIT_SLOTS;k++){
  const B=PIT.bays[k+1],c=list[k];
  if(!c){put(door,new THREE.BoxGeometry(.12,4.2,BAY-.35),T.copy(B).multiply(M.makeTranslation(.3,2.1,0)));continue}
  const hex=col(c),mine=c===player,name=nm(c).toUpperCase(),teamM=new THREE.MeshStandardMaterial({color:hex,roughness:.45,metalness:.2});
  const lum=new THREE.Color(hex).getHSL({}).l,accent=lum>.6?0x1a1d22:0xf4f6f8;
  // ---- the garage: name over the door, team colour inside, a big logo on the back wall, screens, kit ----
  {const tex=paintTex(512,64,(g,w,h)=>{g.fillStyle='#10151c';g.fillRect(0,0,w,h);g.fillStyle=hexS(hex);g.fillRect(0,h-8,w,8);g.fillRect(0,0,10,h);g.fillRect(w-10,0,10,h);
    g.fillStyle='#fff';g.font='bold italic 40px Arial';g.textAlign='center';g.textBaseline='middle';g.fillText(name,w/2,h/2-3,w-40)},false);
   plane(new THREE.MeshStandardMaterial({map:tex,emissive:0xffffff,emissiveMap:tex,emissiveIntensity:.55,roughness:.5}),B,BAY-.6,.7,-.02,4.6,0,-Math.PI/2)}
  {const tex=paintTex(512,180,(g,w,h)=>{const gr=g.createLinearGradient(0,0,w,0);gr.addColorStop(0,hexS(hex));gr.addColorStop(1,'#0c1017');g.fillStyle=gr;g.fillRect(0,0,w,h);
    g.fillStyle='#ffffff22';for(let i=0;i<6;i++){g.beginPath();g.moveTo(i*110-60,h);g.lineTo(i*110+40,0);g.lineTo(i*110+70,0);g.lineTo(i*110-30,h);g.fill()}
    g.fillStyle='#fff';g.font='bold italic 74px Arial';g.textAlign='center';g.textBaseline='middle';g.fillText(name,w/2,h/2-12,w-40);g.font='bold 22px Arial';g.fillText('F1 TEAM · KOD RACING 3D',w/2,h-26)},false);
   plane(new THREE.MeshStandardMaterial({map:tex,emissive:0xffffff,emissiveMap:tex,emissiveIntensity:.35,roughness:.5}),B,BAY-.8,2.4,GARAGE_D-.42,2.7,0,-Math.PI/2)}
  for(const sd of [-1,1]){box(teamM,B,GARAGE_D-1,.5,.04,GARAGE_D/2,3.6,sd*(BAY/2-.2));box(teamM,B,GARAGE_D-1,.12,.04,GARAGE_D/2,3.2,sd*(BAY/2-.2))}   // team stripes on the side walls
  for(const z of [-2.4,2.4]){box(dark,B,.12,.75,1.2,1.6,3.7,z);plane(screenM,B,1.1,.65,1.53,3.7,z,-Math.PI/2);box(steel,B,.04,.6,.04,1.6,4.35,z)}   // hanging timing screens
  for(const z of [-2.9,2.9])for(let h=0;h<4;h++)cyl(h%2?rub:teamM,B,h%2?.33:.36,h%2?.26:.25,GARAGE_D-2.4,.14+h*.28,z);                         // tyres in blankets
  box(dark,B,.4,.06,1.7,GARAGE_D-1.4,1.05,0);for(const z of [-.85,.85])box(dark,B,.4,.36,.03,GARAGE_D-1.4,1.1,z);box(steel,B,.06,.95,.06,GARAGE_D-1.4,.5,0);   // spare front wing on its stand
  // ---- the box: painted in the team colour with the name, wheel marks, a light rig with the traffic light, jacks, hoses ----
  const bp=trackAt(slotRel(k),PIT_LAT),BB=new THREE.Matrix4().makeRotationY(bp.angle).setPosition(bp.x,bp.y,bp.z);
  {const tex=paintTex(128,256,(g,w,h)=>{g.clearRect(0,0,w,h);g.fillStyle=hexS(hex)+'55';g.fillRect(8,8,w-16,h-16);g.strokeStyle='#f4f4f0';g.lineWidth=6;g.strokeRect(6,6,w-12,h-12);
    g.fillStyle='#f4f4f0';for(const [x,y] of [[22,70],[106,70],[22,186],[106,186]]){g.fillRect(x-14,y-2,28,4);g.fillRect(x-2,y-12,4,24)}g.fillRect(14,16,w-28,5);
    g.save();g.translate(w/2,h/2);g.rotate(-Math.PI/2);g.font='bold 30px Arial';g.textAlign='center';g.textBaseline='middle';g.fillText(name,0,0,h-60);g.restore()},false);
   const m=new THREE.Mesh(new THREE.PlaneGeometry(3.6,BAY-1),new THREE.MeshStandardMaterial({map:tex,transparent:true,roughness:.6,polygonOffset:true,polygonOffsetFactor:-3}));
   m.rotation.order='YXZ';m.rotation.set(-Math.PI/2,bp.angle+Math.PI,0);m.position.set(bp.x,.075+bp.y,bp.z);G.add(m)}
  for(const z of [-1.9,1.9])box(steel,BB,garageX+2.6,.22,.22,garageX/2-1.3,4.75,z);box(steel,BB,.22,.22,4,-2.6,4.75,0);box(teamM,BB,.08,.5,3.2,-2.72,4.75,0);
  for(const z of [-1.2,-.4,.4,1.2])box(lamp,BB,3.6,.05,.22,-.4,4.6,z);
  box(dark,BB,.32,1.3,.5,-2.6,3.95,0);
  if(!mine){box(steel,BB,.06,.08,1.6,0,.1,3.6);box(steel,BB,.06,.5,.06,0,.25,2.85);box(steel,BB,.06,.08,1.6,0,.1,-3.6);box(steel,BB,.06,.5,.06,0,.25,-2.85)}   // front and rear jacks (ours move)
  for(const [x,z] of [[-1.6,1.4],[-1.6,-1.4],[1.6,1.4],[1.6,-1.4]])box(hose,BB,Math.abs(garageX-x),.04,.04,(garageX+x)/2,.03,z);              // wheel-gun air lines from the garage
  for(const z of [-3.6,3.6])for(let h=0;h<3;h++)cyl(h%2?rub:teamM,BB,.35,.25,garageX-.7,.13+h*.27,z);
  // where our car's wheels will stand: gunners kneel at them, a tyre man beside each with the new tyre
  const WZ=player.car.M?.wheelZ||[-1.3,1.3],WX=(player.car.M?.trackX||.85)+.65,zf=WZ[1],zr=WZ[0],nose=(player.car.len||4.5)/2;
  const spots=[[-WX,zf,Math.PI/2,'gun'],[-WX,zr,Math.PI/2,'gun'],[WX,zf,-Math.PI/2,'gun'],[WX,zr,-Math.PI/2,'gun'],[0,nose+1.15,Math.PI,'jack'],[0,-nose-1.15,0,'jack'],[-1.3,nose+1.8,Math.PI,'lolly'],
   [-WX-.75,zf+.7,Math.PI/2,'tyre'],[-WX-.75,zr-.7,Math.PI/2,'tyre'],[WX+.75,zf+.7,-Math.PI/2,'tyre'],[WX+.75,zr-.7,-Math.PI/2,'tyre']];
  const kit=crewKit({suit:hex,dark:0x15171a,helm:hex,visor:0x0a0d12,accent});
  // ---- the team's stand on the pit wall: engineers at their screens, under a roof in the team colour ----
  // a white kiosk on the pit wall: tinted windows, the roof in the team colour, the name, a camera on a pole
  {const wp=trackAt(slotRel(k),-(PIT_WALL+.9)),WB=new THREE.Matrix4().makeRotationY(wp.angle).setPosition(wp.x,wp.y,wp.z);
   box(kioskM,WB,1.2,2.3,2.8,0,1.15,0);box(teamM,WB,1.4,.12,3,0,2.36,0);box(teamM,WB,.04,.18,3,.7,2.24,0);
   for(const z of [-.85,0,.85])box(darkGlass,WB,.03,.8,.7,.61,1.6,z);for(const z of [-1.41,1.41])box(darkGlass,WB,.6,.8,.03,0,1.6,z);
   {const tex=paintTex(256,64,(g,w,h)=>{g.clearRect(0,0,w,h);g.fillStyle=hexS(hex);g.fillRect(6,18,26,26);g.fillStyle='#222';g.font='bold 26px Arial';g.textBaseline='middle';g.fillText(name,40,32,w-46)},false);
    plane(new THREE.MeshStandardMaterial({map:tex,transparent:true,roughness:.5}),WB,1.3,.33,.62,.75,0,Math.PI/2)}
   box(steel,WB,.05,1.5,.05,.3,3.1,1.1);box(steel,WB,.4,.04,.04,.12,3.85,1.1);put(darkGlass,new THREE.SphereGeometry(.12,10,8,0,Math.PI*2,Math.PI/2,Math.PI/2),T.copy(WB).multiply(M.makeTranslation(-.05,3.83,1.1)))}
  if(mine){
   const rig=new THREE.Group();rig.matrixAutoUpdate=false;rig.matrix.copy(BB);G.add(rig);
   const crew=spots.map(([x,z,f,kd])=>{const r=crewRig(kit,crewMat,rig);r.g.position.set(x,0,z);r.g.rotation.y=f;return Object.assign(r,{kind:kd,ph:Math.random()*6})});
   crew.forEach((c,i)=>{c.spot={x:c.g.position.x,z:c.g.position.z,f:c.g.rotation.y};c.home={x:garageX+.8+(i%3)*.7,z:-3.2+i*.6,f:-Math.PI/2};c.g.position.set(c.home.x,0,c.home.z);c.g.rotation.y=c.home.f;
    // tyre men step in to the wheel while the old one is off, then back out
    if(c.kind==='tyre'){const sd=Math.sign(c.spot.x),dz=Math.sign(c.spot.z-(c.spot.z>0?zf:zr))||1;c.spot2={x:sd*(WX+.15),z:c.spot.z-dz*.45,f:c.spot.f};
     const ty=new THREE.Group(),tm=new THREE.Mesh(new THREE.CylinderGeometry(.34,.34,.3,16).rotateZ(Math.PI/2),rub),rm=new THREE.Mesh(new THREE.CylinderGeometry(.22,.22,.31,12).rotateZ(Math.PI/2),steel);
     ty.add(tm,rm);ty.rotation.y=Math.PI/2;ty.position.set(0,1.05,.42);c.body.add(ty);c.tyre=ty}
    if(c.kind==='gun'){const gun=new THREE.Mesh(new THREE.CylinderGeometry(.055,.055,.36,8).rotateX(Math.PI/2),steel);gun.position.set(0,-.58,.2);c.arms[1].add(gun)}});
   const sign=new THREE.Group();sign.position.set(0,-.6,.08);crew[6].arms[1].add(sign);
   const stick=new THREE.Mesh(new THREE.CylinderGeometry(.025,.025,1.6,6),steel);stick.position.y=.5;sign.add(stick);
   const signFace=new THREE.MeshStandardMaterial({color:0xff2a2a,roughness:.5,emissive:0x330000}),disc=new THREE.Mesh(new THREE.CylinderGeometry(.32,.32,.04,20),signFace);disc.position.y=1.3;disc.rotation.x=Math.PI/2;sign.add(disc);
   const tlRed=new THREE.MeshStandardMaterial({color:0x330000,emissive:0xff2020,emissiveIntensity:0}),tlGreen=new THREE.MeshStandardMaterial({color:0x003300,emissive:0x22ff55,emissiveIntensity:0});
   for(const [m,y] of [[tlRed,4.3],[tlGreen,3.65]])for(const z of [-.12,.12]){const s=new THREE.Mesh(new THREE.SphereGeometry(.11,12,8),m);s.position.set(-2.78,y,z);rig.add(s)}
   // the jacks: a trolley with a long handle, pumped down to lift the car
   const jack=(z,dir)=>{const j=new THREE.Group();j.position.set(0,0,z);rig.add(j);const base=new THREE.Mesh(new THREE.BoxGeometry(.32,.14,.6),steel);base.position.set(0,.09,-dir*.1);j.add(base);
    const arm=new THREE.Group();arm.position.set(0,.18,dir*.15);j.add(arm);const h=new THREE.Mesh(new THREE.BoxGeometry(.05,.05,1.3),steel);h.position.z=dir*.65;arm.add(h);
    const bar=new THREE.Mesh(new THREE.BoxGeometry(.5,.05,.05),steel);bar.position.z=dir*1.3;arm.add(bar);return arm};
   const jackF=jack(nose+.25,1),jackR=jack(-nose-.25,-1);
   pitCrew={crew,sign,signFace,tlRed,tlGreen,done:0,jackF,jackR};PIT_S=wrapS(slotRel(k));
  }else{
   // the others' crews wait by their garage, a couple of them in the box
   for(const [x,z,f] of [[2.9,-1,-Math.PI/2],[2.9,0,-Math.PI/2],[2.9,1,-Math.PI/2],[3.3,-2.2,-Math.PI/2],[3.3,2.2,-Math.PI/2],[0,3.3,Math.PI],[-1.1,3.9,Math.PI]]){
    const P=new THREE.Matrix4().copy(BB).multiply(M.makeTranslation(x,0,z)).multiply(M.makeRotationY(f));put(crewMat,kit.whole.clone(),P)}}
  kit.whole.dispose();if(!mine){kit.body.dispose();kit.leg.dispose();kit.arm.dispose()}
 }
 for(const [mat,list] of kit){const geo=mat===crewMat?mergeColored(list):mergeGeos(list);const m=new THREE.Mesh(geo,mat);m.castShadow=m.receiveShadow=true;G.add(m);list.forEach(g=>g.dispose())}
 buildMinimap();
}
// like mergeGeos, keeping the vertex colours
function mergeColored(list){
 const parts=list.map(g=>g.index?g.toNonIndexed():g);let n=0;parts.forEach(g=>n+=g.attributes.position.count);
 const pos=new Float32Array(n*3),nor=new Float32Array(n*3),col=new Float32Array(n*3);let o=0;
 for(const g of parts){pos.set(g.attributes.position.array,o*3);nor.set(g.attributes.normal.array,o*3);col.set(g.attributes.color.array,o*3);o+=g.attributes.position.count}
 const m=new THREE.BufferGeometry();m.setAttribute('position',new THREE.BufferAttribute(pos,3));m.setAttribute('normal',new THREE.BufferAttribute(nor,3));m.setAttribute('color',new THREE.BufferAttribute(col,3));
 return m;
}
// the crew waits in the garage, runs out when the car comes down the lane, gets busy while it's in the box
// (gunners crouch on the wheels, jack men lean in), the lollipop goes green when it's done, then they walk back in
function updatePitCrew(dt){
 const P_=pitCrew;if(!P_)return;const busy=!!player.repairing,t=performance.now()/1000;
 // once the stop is done the crew goes back into the garage, until the car has left the pit lane
 if(busy)P_.served=true;else if(!player.pitSide&&!player.pit||state!=='race')P_.served=false;
 const out=state==='race'&&(busy||!P_.served&&(player.pit&&player.pit.phase!=='out'||player.pitSide&&!player.pit));
 if(P_.wasBusy&&!busy){P_.done=1.2;P_.clockT=2.5}P_.clockT=Math.max(0,(P_.clockT||0)-dt);P_.wasBusy=busy;P_.done=Math.max(0,P_.done-dt);
 const ease=(o,k,v)=>{o[k]+=(v-o[k])*Math.min(1,dt*10)};
 const S=player.pit?.phase==='stop'?player.pit:null,st=S?S.t:0;
 for(const c of P_.crew){const k=c.kind,in2=k==='tyre'&&S&&st>.45&&st<S.wheelsOn+.15,g=c.g;let to=in2?c.spot2:out||P_.done>0?c.spot:c.home;
  // to the far side of the car they go round the nose or the tail, not through it
  {const nz=P_.jackF.parent.position.z-.25+1.2,px=g.position.x,pz=g.position.z;
   if(Math.abs(to.x)>1.05&&px*Math.sign(to.x)<1.2){const sz=Math.abs(pz)>nz-.3?Math.sign(pz):to.z+pz>=0?1:-1;
    to=Math.abs(pz)<nz-.05&&Math.abs(px)>1.05?{x:px,z:sz*nz,f:to.f}:{x:Math.sign(to.x)*1.6,z:sz*nz,f:to.f}}}
  const dx=to.x-g.position.x,dz=to.z-g.position.z,d=Math.hypot(dx,dz);
  const walking=d>.05,run=out&&walking,work=busy&&!walking;
  if(walking){const st=Math.min(d,dt*(run?5.5:2.2));g.position.x+=dx/d*st;g.position.z+=dz/d*st;g.rotation.y=Math.atan2(dx,dz);c.ph+=dt*(run?12:7.5)}
  else g.rotation.y+=(to.f-g.rotation.y)*Math.min(1,dt*8);
  // pose targets: running (legs and arms swing, body bobs and leans in), at work, or standing ready
  const sw=walking?Math.sin(c.ph):0,amp=run?.8:.45;
  let by=walking?Math.abs(Math.cos(c.ph))*(run?.07:.03):0,lean=run?.18:0,l0=sw*amp,l1=-sw*amp,a0=-sw*amp*.9,a1=sw*amp*.9;
  if(work&&k==='gun'){by=-.38;lean=.32;l0=-1.45;l1=-.15;a0=a1=-1.15+Math.sin(t*16+c.ph)*.06}   // down on one knee, gun on the nut
  if(work&&k==='jack'){lean=.5;a0=a1=-1.35}                                                       // leaning on the jack
  if(k==='tyre'){c.tyre.visible=!(S&&st>S.wheelsOn);if(!walking&&(in2||out))a0=a1=-1.2;else if(c.tyre.visible)a0=a1=-.9;if(in2&&!walking){lean=.35;by=-.12}}   // the new tyre held out, then pushed on
  if(!walking&&k==='lolly')a1=busy||P_.done>0?-1.45:-.4;                                          // the lollipop held out in front of the car
  ease(c.body.position,'y',by);ease(c.body.rotation,'x',lean);
  ease(c.legs[0].rotation,'x',l0);ease(c.legs[1].rotation,'x',l1);ease(c.arms[0].rotation,'x',a0);ease(c.arms[1].rotation,'x',a1)}
 // the jack handles: up while waiting, pushed down to lift the car
 {const up=S?smooth(.15,.4,st)*(1-smooth(S.total-.45,S.total-.2,st)):0;for(const [j,d] of [[P_.jackF,1],[P_.jackR,-1]])ease(j.rotation,'x',-d*lerp(.5,-.06,up))}
 // the stop clock, F1 style: counting during the stop, the final time in green for a moment after
 const pc=$('pitclock');if(S){pc.style.display='block';pc.classList.remove('done');pc.lastChild.textContent=st.toFixed(1)}
 else if(P_.clockT<=0||state!=='race')pc.style.display='none';
 // the pole stays upright in the hand; flicked forward when it's time to go
 {const lolly=P_.crew.find(c=>c.kind==='lolly');P_.sign.rotation.x=-lolly.arms[1].rotation.x+(P_.done>0?-.5:0)}
 P_.signFace.color.set(P_.done>0?0x22cc55:0xff2a2a);P_.signFace.emissive.set(P_.done>0?0x0a3315:0x330000);
 P_.tlRed.emissiveIntensity=busy?3:0;P_.tlGreen.emissiveIntensity=P_.done>0?3:0;
}
// ---------- pit stop ----------
// across the pit entry line the game drives the car, like in F1: down the lane on the limiter, into the box,
// the stop (jacks up, wheel guns, the repairs, jacks down, lollipop up), then out to the end of the lane.
// it drives through the same inputs a pad gives the C++ car (autopilot), so the physics stays the physics
const PIT_FAST=-(PIT_WALL+LANE_MID)/2;
function pitPath(rel,phase){const box=pitRel(PIT_S);
 if(phase==='in')return rel<box-32?PIT_FAST:lerp(PIT_FAST,PIT_LAT,smooth(box-32,box-6,rel));
 if(rel<box+5)return PIT_LAT;if(rel<box+25)return lerp(PIT_LAT,PIT_FAST,smooth(box+5,box+25,rel));
 return rel<PIT.b-PIT_X?PIT_FAST:-lerp(-PIT_FAST,ROAD-2.5,smooth(PIT.b-PIT_X,PIT.b-14,rel));
}
function pitDrive(pl){
 carMem[CF.autopilot]=0;
 if(state!=='race'||pl.wrecked||pl.tumble||!pitZone(pl.s)){pl.pit=null;return}
 if(!pl.pit&&pl.pitSide){pl.pit={phase:'in',t:0};toast('BOX BOX · PIT LIMITER ON','#ffd21e',1.6)}
 const S=pl.pit;if(!S)return;
 carMem[CF.autopilot]=1;carMem[CF.steerAx]=carMem[CF.gasAx]=carMem[CF.brakeAx]=0;
 if(S.phase==='stop')return;
 const rel=pitRel(pl.s),v=Math.hypot(pl.vx,pl.vz),box=pitRel(PIT_S);
 // back on the track: your car again
 if(S.phase==='out'&&(rel>PIT.b-14||pl.lat>-(CURB+.3))){pl.pit=null;carMem[CF.autopilot]=0;toast('YOUR CAR','#5fe08a',1);return}
 // steer: pure pursuit on a point ahead on the lane line
 const look=Math.max(5,v*.45),tr=rel+look,T=trackAt(tr,pitPath(tr,S.phase)),dx=T.x-pl.x,dz=T.z-pl.z,a=pl.angle;
 const alpha=Math.atan2(dx*-Math.cos(a)+dz*Math.sin(a),dx*Math.sin(a)+dz*Math.cos(a));
 const wheel=Math.atan(2*2.5*Math.sin(alpha)/look),lock=Math.min(.6,2.5*12*3.1*.85/Math.max(25,v*v)+.11);
 carMem[CF.steerAx]=clamp(wheel/lock,-1,1);
 // speed: the limiter down the lane, braking to a stop on the box marks; full power once out past the line
 let vt=S.phase==='in'?Math.min(PIT_LIM-.7,Math.sqrt(2*4.5*Math.max(0,box-rel-.15))):rel<PIT.b-PIT_X?PIT_LIM-.7:45;
 // still off the line close to the box: creep in so it ends up square in the marks
 if(S.phase==='in'&&box-rel<10&&Math.abs(pl.lat-PIT_LAT)>.6)vt=Math.min(vt,3);
 carMem[CF.gasAx]=clamp((vt-v)*.6,0,1);carMem[CF.brakeAx]=v>vt+.3&&v>.6?clamp((v-vt)*.5,.05,1):0;
 if(S.phase==='in'&&rel>box-.6&&v<.8)startStop(pl);
}
// the work decides the time: fresh tyres always, then the body, the wing (a new nose or wing), the brakes
function startStop(pl){
 const s=pl.sys,floor=s.engine*.3,body=Math.max(0,pl.damage-floor),wing=s.aero>.3;
 const total=2.2+rand(0,.5)+body*5+(wing?2.4:0)+s.brakes*1.5;
 pl.pit={phase:'stop',t:0,total,from:{damage:pl.damage,sys:{...s},bend:pl.bend||0},floor,wheelsOn:Math.min(1.35,total-1.1),guns:0};
 pl.repairing=true;pl.vx=pl.vz=pl.yaw=0;beep(660,.12,.2,'square');
}
function updatePitStop(pl,dt){
 const S=pl.pit;if(!S||S.phase!=='stop')return 0;
 S.t+=dt;
 const k=clamp((S.t-.6)/Math.max(.5,S.total-1.2),0,1),f=S.from;
 pl.damage=lerp(f.damage,S.floor,k);for(const key in pl.sys)if(key!=='engine')pl.sys[key]=f.sys[key]*(1-k);pl.bend=f.bend*(1-k);
 // wheel guns: off, then on again
 if(S.guns===0&&S.t>.5){S.guns=1;wheelGun();gunPuff(pl)}if(S.guns===1&&S.t>S.wheelsOn+.25){S.guns=2;wheelGun();gunPuff(pl)}
 // leave early on the gas, with what's done so far
 if((keys.gas||pad.gas>.3)&&S.t>.9&&S.t<S.total-.3){S.early=true;S.total=S.t+.3}
  if(S.t>=S.total){
  pl.repairing=false;{const pc=$('pitclock');pc.lastChild.textContent=S.t.toFixed(1);pc.classList.toggle('done',!S.early)}
  if(!S.early){pl.bend=0;repairCar(pl.car);shareDamage(pl.car,'fix')}
  toast((S.early?'PIT STOP ':'PIT STOP ')+S.t.toFixed(1)+' s'+(pl.sys.engine>.25?' · ENGINE CAN\'T BE FIXED':' · GO GO GO'),S.early||pl.sys.engine>.25?'#ffb02e':'#5fe08a',2.2);beep(990,.2,.25,'triangle');
  pl.pit={phase:'out',t:0};
 }
 return S.t;
}
// the car on the jacks with its wheels off, while the stop runs
function pitStopPose(pl){
 const S=pl.pit,c=pl.car;let lift=0,off=0;
 if(S?.phase==='stop'){const t=S.t;lift=.075*smooth(.2,.45,t)*(1-smooth(S.total-.45,S.total-.2,t));off=smooth(.55,.85,t)*(1-smooth(S.wheelsOn,S.wheelsOn+.3,t))}
 c.g.position.y+=lift;
 for(const sp of c.spinners){const sd=Math.sign(sp.parent.position.x)||1;sp.position.x=sd*.5*off}
}
// a little puff of dust and air at each wheel nut when the guns go
function gunPuff(pl){const v=new THREE.Vector3();for(const sp of pl.car.spinners){sp.getWorldPosition(v);for(let i=0;i<4;i++)emit(v.x,v.y,v.z,rand(-1,1),rand(.3,1.2),rand(-1,1),.6,.25,.9,0xd8d4cc)}}
// a wheel gun: a high whirr that rises and cuts off
function wheelGun(){if(!audio.ctx)return;const c=audio.ctx;
 for(let i=0;i<4;i++){const t=c.currentTime+i*.04,s=c.createBufferSource(),f=c.createBiquadFilter(),g=c.createGain();s.buffer=audio.noise;f.type='bandpass';f.Q.value=6;
  f.frequency.setValueAtTime(1800,t);f.frequency.linearRampToValueAtTime(3600,t+.25);g.gain.setValueAtTime(.14,t);g.gain.setValueAtTime(.14,t+.24);g.gain.linearRampToValueAtTime(0,t+.28);
  s.connect(f).connect(g).connect(audio.master);s.start(t,rand(0,1.5),.3)}}

const PIT_LAT=-20.25,PIT_LEN=8;
const N=1600,BRIDGE_H=7.5;
const ROAD=8,CURB=9.6,WALL=12.6;
const wrapI=i=>((i%N)+N)%N;
const wrapS=s=>((s%L)+L)%L;
// run-off: on the outside of the corners the barrier stands further back (up to RUNOFF m more), with a gravel
// trap in front of it, so a car that runs wide ploughs into gravel before it reaches the wall, like at an F1 track.
// none on the pit straight, by the start or around the bridge; never so far that the walls of two bits cross
const RUNOFF=15,RUNOFF_STRAIGHT=7;
function findRunoff(){
 WL=new Float32Array(N).fill(WALL);WR=new Float32Array(N).fill(WALL);
 const near=new Float32Array(N);for(let i=0;i<N;i++){let m=1e9;for(let j=0;j<N;j+=3){const d=Math.abs(j-i),dd=Math.min(d,N-d);if(dd<90)continue;m=Math.min(m,(P[i].x-P[j].x)**2+(P[i].z-P[j].z)**2)}near[i]=Math.sqrt(m)}
 for(const [arr,side] of [[WL,-1],[WR,1]]){
  const raw=new Float32Array(N);for(let i=0;i<N;i++){const k=KS[i];if((k<0?-1:1)!==side)continue;raw[i]=clamp((Math.abs(k)-.005)/.015,0,1)}   // a right turn (k<0) runs wide to the left
  // from a little before the turn-in to well past the exit, where cars run wide
  let ext=new Float32Array(N);for(let i=0;i<N;i++){let m=0;for(let j=-45;j<=18;j++)m=Math.max(m,raw[wrapI(i+j)]);ext[i]=m}
  // and here and there along a straight too: a band of gravel that comes and goes, different on each side
  const str=new Float32Array(N);for(let i=0;i<N;i++)str[i]=smooth(.52,.62,fbm(i*DS/260,side*7.3+TRACK*3.1,2))*(1-smooth(.004,.008,Math.abs(KS[i])));
  const mask=new Float32Array(N);for(let i=0;i<N;i++){const r=pitRel(i*DS),p=P[i];mask[i]=Math.abs(r)<90||side<0&&PIT&&r>PIT.a-40&&r<PIT.b+40||HY[i]>0||bridge&&(p.x-bridge.x)**2+(p.z-bridge.z)**2<110*110?0:1}
  for(const a of [ext,mask,str])for(let pass=0;pass<2;pass++){const c=a.slice();for(let i=0;i<N;i++){let s=0;for(let j=-12;j<=12;j++)s+=c[wrapI(i+j)];a[i]=s/25}}
  for(let i=0;i<N;i++)arr[i]=WALL+Math.min(Math.max(RUNOFF*ext[i],RUNOFF_STRAIGHT*str[i])*mask[i],Math.max(0,near[i]/2-WALL-1.5))}
}
const wallAt=(i,side)=>side>0?WR[wrapI(i)]:WL[wrapI(i)];
const wallAtS=(s,side)=>{const f=wrapS(s)/DS,i=Math.floor(f)%N,u=f-Math.floor(f);return lerp(wallAt(i,side),wallAt(i+1,side),u)};
function setTrackData(t){
 TRACK=t;CP=TRACKS[t].cp;
 const curve=new THREE.CatmullRomCurve3(CP.map(([x,z])=>new THREE.Vector3(x,0,z)),true,'centripetal');
 P=curve.getSpacedPoints(N).slice(0,N);
 L=0;for(let i=0;i<N;i++)L+=P[i].distanceTo(P[(i+1)%N]);
 DS=L/N;T=[];R=[];KS=[];
 for(let i=0;i<N;i++){
  const t=P[(i+1)%N].clone().sub(P[(i-1+N)%N]).normalize();T.push(t);R.push(new THREE.Vector3(-t.z,0,t.x));
 }
 for(let i=0;i<N;i++){const a=T[(i-2+N)%N],b=T[(i+2)%N];KS.push((a.z*b.x-a.x*b.z)/(4*DS))} // signed curvature (<0 = right turn)
 // road height: flat everywhere except where a figure of eight crosses itself. there the later part of the
 // lap climbs over the earlier one: level across the crossing, eased up and down over 150 m either side
 HY=new Float32Array(N);bridge=null;
 if(TRACKS[t].bridge){
  let c=null;for(let i=0;i<N;i+=2)for(let j=i+300;j<Math.min(N,N-300+i);j+=2){const d=(P[i].x-P[j].x)**2+(P[i].z-P[j].z)**2;if(!c||d<c.d)c={d,i,j}}
  const up=c.j,lo=c.i,sin=Math.max(.35,Math.abs(T[up].x*T[lo].z-T[up].z*T[lo].x)),flat=(WALL+6)/sin/DS,ramp=150/DS;
  for(let k=0;k<N;k++){let d=Math.abs(k-up);d=Math.min(d,N-d);HY[k]=d<flat?BRIDGE_H:d<flat+ramp?BRIDGE_H*(.5+.5*Math.cos(Math.PI*(d-flat)/ramp)):0}
  bridge={up,lo,x:(P[up].x+P[lo].x)/2,z:(P[up].z+P[lo].z)/2};
 }
 // pit lane: splits off where the run onto the main straight gets straight (at most 150 m before the line).
 // the pit building has a garage for every car in the race (4) and a shut bay at each end
 {let lo=0;while(Math.abs(KS[wrapI(lo-1)])<.008&&!HY[wrapI(lo-1)]&&lo>-N/4)lo--;
  const a=Math.max(lo*DS+15,-150),nb=PIT_SLOTS+2,g0=a+PIT_E,r0=g0,g1=r0+nb*BAY,b=g1+PIT_X;
  PIT={a,b,nb,r0,pts:[]};PIT_S=wrapS(r0+1.5*BAY);
  // where trees and bushes must not grow: the lane, the garages and a bit behind them
  for(let r=a-10;r<=b+10;r+=6){const p=trackAt(r,-24);PIT.pts.push([p.x,p.z])}
  // and the main grandstand across the straight
  PIT.stand=[];for(let r=-120;r<=82;r+=8){const p=trackAt(r,WALL+20);PIT.stand.push([p.x,p.z])}}
 findDrsZones();
 findRunoff();
 // racing line: hug the inside of corners
 const raw=KS.map(k=>clamp(-k*260,-5.2,5.2));lineLat=[];
 for(let i=0;i<N;i++){let s=0;for(let k=-25;k<=25;k++)s+=raw[wrapI(i+k)];lineLat.push(s/51)}
}
setTrackData(settings.track);
const hAt=s=>{const f=wrapS(s)/DS,i=Math.floor(f)%N;return HY[i]+(HY[(i+1)%N]-HY[i])*(f-Math.floor(f))};
const nearBridge=(x,z,r)=>!!bridge&&(x-bridge.x)**2+(z-bridge.z)**2<r*r;
// stand a car on the road at track distance s: height, and the nose up or down the ramp
const onRoad=(c,s)=>{c.gy=hAt(s);const g=c.car.g;g.position.y=c.gy;if(bridge){g.rotation.order='YXZ';g.rotation.x=-Math.atan((hAt(s+1.5)-hAt(s-1.5))/3)}};
function trackAt(s,lat=0){
 s=wrapS(s);const f=s/DS,i=Math.floor(f)%N,u=f-Math.floor(f),j=(i+1)%N;
 const x=P[i].x+(P[j].x-P[i].x)*u,z=P[i].z+(P[j].z-P[i].z)*u;
 const tx=T[i].x+(T[j].x-T[i].x)*u,tz=T[i].z+(T[j].z-T[i].z)*u,tl=Math.hypot(tx,tz);
 const rx=-tz/tl,rz=tx/tl;
 return {i,x:x+rx*lat,z:z+rz*lat,y:HY[i]+(HY[j]-HY[i])*u,tx:tx/tl,tz:tz/tl,rx,rz,angle:Math.atan2(tx,tz)};
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
 return {i:best.i,t:best.t,s:(best.i+best.t)*DS,lat:(x-best.px)*r.x+(z-best.pz)*r.z,rx:r.x,rz:r.z,tx:T[best.i].x,tz:T[best.i].z};
}

// textures
// asphalt: 16m wide x 22m long per tile. aggregate grain, tyre-polished lines, cracks, patches, worn paint
const ASPH_W=768,ASPH_H=1056,wearAt=u=>Math.exp(-(((u-.3)/.07)**2))+Math.exp(-(((u-.7)/.07)**2));
const asphaltH=new Float32Array(ASPH_W*ASPH_H);
const asphaltTex=canvasTex(ASPH_W,ASPH_H,(g,w,h)=>{
 paintPixels(g,w,h,(x,y)=>{
  const u=x/w,grain=hash2(x*7+1,y*13+5),fine=fbm(x/8,y/8,2,132);
  asphaltH[y*w+x]=fine*.5+grain*.5+(grain>.94?.7:0);
  let v=60+(fbm(x/96,y/96,4,11)-.5)*24+(fine-.5)*12+(grain-.5)*20;
  if(grain>.94)v+=(grain-.94)*380;else if(grain<.05)v-=16;
  v-=9*wearAt(u);
  return [v-1,v,v+3];
 });
 // sealed cracks
 g.lineCap='round';
 for(let k=0;k<14;k++){let x=rand(40,w-40),y=rand(0,h),a=rand(0,Math.PI*2);
  g.strokeStyle=`rgba(18,18,20,${rand(.16,.3)})`;g.lineWidth=rand(.8,1.6);g.beginPath();g.moveTo(x,y);
  for(let i=0,n=rand(30,120)|0;i<n;i++){a+=rand(-.5,.5);x+=Math.cos(a)*4;y+=Math.sin(a)*4;g.lineTo(x,y)}g.stroke()}
 // repair patches
 for(let k=0;k<3;k++){const px=rand(40,w-160),py=rand(0,h-160),pw=rand(60,140),ph=rand(60,160);
  g.fillStyle='rgba(30,30,33,.16)';g.fillRect(px,py,pw,ph);g.strokeStyle='rgba(12,12,14,.3)';g.lineWidth=1.5;g.beginPath();
  for(let i=0;i<=24;i++){const t=i/24*4,e=Math.floor(t)%4,f=t-Math.floor(t),j=rand(-2,2);
   const pt=[[px+pw*f,py+j],[px+pw+j,py+ph*f],[px+pw*(1-f),py+ph+j],[px+j,py+ph*(1-f)]][e];i?g.lineTo(...pt):g.moveTo(...pt)}g.stroke()}
 // paint, then wear it
 // oil drips on the driving lines
 for(let k=0;k<9;k++){const x=w*(Math.random()<.5?.3:.7)+rand(-40,40),y=rand(0,h),r=rand(14,46),gr=g.createRadialGradient(x,y,0,x,y,r);
  gr.addColorStop(0,'rgba(12,12,14,.4)');gr.addColorStop(1,'rgba(12,12,14,0)');g.fillStyle=gr;g.beginPath();g.ellipse(x,y,r,r*rand(.6,1.4),rand(0,3),0,7);g.fill()}
 // dust and grit swept to the edges
 for(const [x0,dir] of [[0,1],[w,-1]]){const gr=g.createLinearGradient(x0,0,x0+dir*48,0);gr.addColorStop(0,'rgba(110,96,72,.35)');gr.addColorStop(1,'rgba(110,96,72,0)');g.fillStyle=gr;g.fillRect(Math.min(x0,x0+dir*48),0,48,h)}
 g.fillStyle='rgba(236,236,232,.92)';g.fillRect(21,0,21,h);g.fillRect(w-42,0,21,h);
 for(let i=0;i<9000;i++){const x=rand(0,w),y=rand(0,h);if(!(x<48||x>w-48))continue;
  g.fillStyle=`rgba(55,56,60,${rand(.2,.7)})`;g.fillRect(x,y,rand(1,3),rand(1,3))}
});
asphaltTex.repeat.set(1,1);
// normal map from the same stone heights, so the grain catches the light
const asphaltNormal=dataTex(canvasTex(ASPH_W,ASPH_H,(g,w,h)=>paintPixels(g,w,h,(x,y)=>{
 const H=(xx,yy)=>asphaltH[((yy+h)%h)*w+((xx+w)%w)];
 const nx=(H(x-1,y)-H(x+1,y))*2.4,ny=(H(x,y-1)-H(x,y+1))*2.4,l=Math.hypot(nx,ny,1);
 return [(nx/l*.5+.5)*255,(ny/l*.5+.5)*255,(1/l*.5+.5)*255]})));
// rubber laid down on the racing line (alpha only)
const rubberTex=dataTex(canvasTex(64,512,(g,w,h)=>paintPixels(g,w,h,(x,y)=>{
 const u=x/w,lane=Math.max(Math.exp(-(((u-.27)/.1)**2)),Math.exp(-(((u-.73)/.1)**2)));
 const v=lane*(.45+.55*fbm(x/3,y/30,3,17.07))*255;return [v,v,v]})));
// braking streaks: two narrow broken tyre lines
const brakeTex=dataTex(canvasTex(64,512,(g,w,h)=>paintPixels(g,w,h,(x,y)=>{
 const u=x/w,lane=Math.max(Math.exp(-(((u-.27)/.05)**2)),Math.exp(-(((u-.73)/.05)**2)));
 const v=lane*smooth(.35,.6,fbm(x/4,y/22,3,23.27))*255;return [v,v,v]})));
// kerb: red/white blocks, dirty towards the grass, rubber marks
const kerbTex=canvasTex(64,256,(g,w,h)=>{
 paintPixels(g,w,h,(x,y)=>{const red=y<h/2,n=(hash2(x,y)-.5)*18+(fbm(x/8,y/8,3,8)-.5)*26,dirt=smooth(.5,.85,fbm(x/12+3,y/12,3))*(x/w);
  const c=red?[190,30,32]:[232,232,228];return c.map((v,i)=>lerp(v+n,[78,70,58][i],dirt*.6))});
 g.fillStyle='rgba(20,20,22,.35)';for(let i=0;i<14;i++)g.fillRect(rand(0,w*.5),rand(0,h),rand(2,6),rand(20,60));
});
// concrete barrier with water stains and tyre smudges
const concreteTex=canvasTex(256,256,(g,w,h)=>{
 paintPixels(g,w,h,(x,y)=>{const v=148+(fbm(x/24,y/24,4,10.67)-.5)*34+(hash2(x,y)-.5)*16-smooth(.55,.9,fbm(x/5,y/70,2))*26;return [v,v-1,v-4]});
 g.fillStyle='rgba(18,18,20,.25)';for(let i=0;i<10;i++){g.beginPath();g.ellipse(rand(0,w),h*rand(.8,.95),rand(10,40),rand(3,8),0,0,7);g.fill()}
});
// catch fence: diamond wire
const fenceTex=keepCoverage(canvasTex(256,256,(g,w,h)=>{g.lineCap='round';
 for(const [col,lw] of [['rgba(70,74,78,1)',3.4],['rgba(188,194,198,1)',2.2],['rgba(236,240,242,1)',.8]]){g.strokeStyle=col;g.lineWidth=lw;
  for(let k=-4;k<=4;k++){g.beginPath();g.moveTo(k*64,0);g.lineTo(k*64+h,h);g.stroke();g.beginPath();g.moveTo(k*64+w,0);g.lineTo(k*64+w-h,h);g.stroke()}}},true),.35);
fenceTex.repeat.set(1,2.6);
const asphaltRough=dataTex(canvasTex(256,352,(g,w,h)=>{
 paintPixels(g,w,h,(x,y)=>{const u=x/w,paint=u<.06||u>.94;
  const r=paint?150:235-55*wearAt(u)+(hash2(x,y)-.5)*20;return [r,r,r]})}));
const curbTex=canvasTex(32,64,(g,w,h)=>{g.fillStyle='#d42020';g.fillRect(0,0,w,h/2);g.fillStyle='#f4f4f4';g.fillRect(0,h/2,w,h/2)});
// grass: 8m per tile. soil showing through at the bottom, then two layers of blades (short dark, long light),
// clover and dry patches. its own brightness doubles as the height for a normal map
const grassTex=canvasTex(512,512,(g,w,h)=>{
 paintPixels(g,w,h,(x,y)=>{
  const n=fbm(x/48,y/48,4,10.67),n2=fbm(x/12,y/12,3,42.67),dry=smooth(.6,.85,fbm(x/80+7,y/80+3,3,6.4)),gr=(hash2(x,y)-.5)*20;
  const r=lerp(38,60,n)+(n2-.5)*16,gg=lerp(54,78,n)+(n2-.5)*18,b=lerp(26,34,n)+(n2-.5)*8;
  return [lerp(r,112,dry*.5)+gr,lerp(gg,100,dry*.5)+gr,lerp(b,58,dry*.5)+gr*.5];
 });
 g.lineCap='round';
 const blade=(n,len,wd,cols)=>{for(let i=0;i<n;i++){const x=rand(0,w),y=rand(0,h),a=-Math.PI/2+rand(-.7,.7),l=rand(...len);
  g.strokeStyle=cols[i%cols.length];g.lineWidth=rand(...wd);g.beginPath();g.moveTo(x,y);g.quadraticCurveTo(x+Math.cos(a)*l*.5+rand(-1,1),y+Math.sin(a)*l*.5,x+Math.cos(a)*l,y+Math.sin(a)*l);g.stroke()}};
 blade(26000,[2,5],[.8,1.4],['rgba(30,52,22,.6)','rgba(44,70,30,.55)','rgba(58,84,36,.5)']);
 blade(16000,[4,9],[.7,1.2],['rgba(84,112,52,.55)','rgba(104,128,62,.5)','rgba(70,100,44,.55)','rgba(132,138,80,.35)','rgba(120,150,70,.45)']);
 for(let i=0;i<260;i++){const x=rand(0,w),y=rand(0,h);g.fillStyle=`rgba(${rand(40,60)|0},${rand(78,96)|0},${rand(34,44)|0},.7)`;
  for(let k=0;k<3;k++){const a=k/3*Math.PI*2+rand(-.3,.3);g.beginPath();g.ellipse(x+Math.cos(a)*2.2,y+Math.sin(a)*2.2,2.2,1.8,a,0,7);g.fill()}}
});
grassTex.repeat.set(375,375);
const grassNormal=heightToNormal(grassTex.image,2.2);
const dirtTex=canvasTex(256,256,(g,w,h)=>{
 paintPixels(g,w,h,(x,y)=>{const n=fbm(x/20,y/20,4,12.8),v=(hash2(x,y)-.5)*20;return [96+n*40+v,76+n*30+v,56+n*22+v]});
 for(let i=0;i<900;i++){const v=rand(90,170)|0;g.fillStyle=`rgb(${v},${v-8},${v-20})`;g.beginPath();g.ellipse(rand(0,w),rand(0,h),rand(.6,2),rand(.6,1.6),rand(0,3),0,7);g.fill()}
});
// gravel for the run-off between kerb and wall: 3 m per tile, rounded pebbles of mixed stone,
// each one lit from above with a shadow under it, packed over darker grit
const gravelTex=canvasTex(512,512,(g,w,h)=>{
 // light, warm gravel like an F1 trap: sand-coloured grit with cream, tan and the odd grey stone
 paintPixels(g,w,h,(x,y)=>{const v=176+(fbm(x/24,y/24,3,21.33)-.5)*26+(hash2(x,y)-.5)*22;return [v+18,v+4,v-30]});
 const stones=[[222,204,168],[204,184,146],[232,218,190],[186,166,130],[214,190,150],[168,160,148],[238,226,200]];
 for(let i=0;i<7000;i++){const x=rand(0,w),y=rand(0,h),r=rand(2,6.5),c=stones[Math.random()*stones.length|0],k=rand(.82,1.12),a=rand(0,3);
  // stones over an edge are drawn again on the other side so the tile wraps
  for(const [k,ox,oy] of [[0,0,0],[1,x<r?w:x>w-r?-w:0,0],[2,0,y<r?h:y>h-r?-h:0]]){if(k&&!ox&&!oy)continue;
   g.fillStyle='rgba(90,70,40,.3)';g.beginPath();g.ellipse(x+ox+r*.22,y+oy+r*.28,r*1.02,r*.82,a,0,7);g.fill();
   const gr=g.createRadialGradient(x+ox-r*.35,y+oy-r*.4,r*.1,x+ox,y+oy,r);
   gr.addColorStop(0,`rgb(${c.map(v=>Math.min(255,v*k*1.18)|0)})`);gr.addColorStop(.7,`rgb(${c.map(v=>v*k|0)})`);gr.addColorStop(1,`rgb(${c.map(v=>v*k*.74|0)})`);
   g.fillStyle=gr;g.beginPath();g.ellipse(x+ox,y+oy,r,r*rand(.7,.95),a,0,7);g.fill()}}
});
const gravelNormal=heightToNormal(gravelTex.image,3);
const adTex=canvasTex(1024,64,(g,w,h)=>{
 const ads=[['KOD RACING','#1d4ed8','#fff'],['NITRO','#111','#3cf'],['DRIFT KING','#e11d48','#fff'],['TURBO','#facc15','#111']];
 ads.forEach(([t,bg,fg],k)=>{g.fillStyle=bg;g.fillRect(k*w/4,0,w/4,h);g.fillStyle=fg;g.font='bold italic 34px Arial';g.textAlign='center';g.textBaseline='middle';g.fillText(t,k*w/4+w/8,h/2+2,w/4-16)});
});
const boostTex=canvasTex(128,128,(g,w,h)=>{
 g.fillStyle='#062a4a';g.fillRect(0,0,w,h);g.strokeStyle='#3cf';g.lineWidth=14;g.lineCap='round';
 for(let k=0;k<2;k++){const y=k*64+16;g.beginPath();g.moveTo(22,y+36);g.lineTo(64,y);g.lineTo(106,y+36);g.stroke()}
});

// the strips below belong to the current track, so they go into trackGroup (rebuilt on a track change)
function ribbon(o0,o1,y,vLen,mat,skip){
 const pos=[],uv=[],idx=[];
 const F=o=>typeof o==='function'?o:()=>o,f0=F(o0),f1=F(o1);
 for(let i=0;i<=N;i++){const k=i%N,p=P[k],r=R[k],v=i*DS/vLen,a=f0(k),b=f1(k);
  pos.push(p.x+r.x*a,y+HY[k],p.z+r.z*a,p.x+r.x*b,y+HY[k],p.z+r.z*b);uv.push(0,v,1,v);
  if(i<N&&!(skip&&skip(k))){const a=i*2;idx.push(a,a+1,a+2,a+1,a+3,a+2)}}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
 g.setIndex(idx);g.computeVertexNormals();
 const m=new THREE.Mesh(g,mat);m.receiveShadow=true;trackGroup.add(m);return m;
}
function wall(off,h,uLen,mat,y0=0,skip){
 const pos=[],uv=[],idx=[];
 const fo=typeof off==='function'?off:()=>off;
 for(let i=0;i<=N;i++){const k=i%N,p=P[k],r=R[k],u=i*DS/uLen,o=fo(k);
  pos.push(p.x+r.x*o,y0+HY[k],p.z+r.z*o,p.x+r.x*o,y0+h+HY[k],p.z+r.z*o);uv.push(u,0,u,1);
  if(i<N&&!(skip&&skip(k))){const a=i*2;idx.push(a,a+2,a+1,a+1,a+2,a+3)}}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
 g.setIndex(idx);g.computeVertexNormals();
 const m=new THREE.Mesh(g,mat);m.castShadow=true;m.receiveShadow=true;trackGroup.add(m);return m;
}
// strip with a cross-section along the track. prof=[[lateral,height],...] in increasing lateral order.
// opt.shift(k) moves it sideways per sample, opt.alpha(k) gives per-vertex alpha
function profileRibbon(prof,vLen,mat,opt={}){
 const n=prof.length,pos=[],uv=[],idx=[],col=opt.alpha?[]:null;
 for(let i=0;i<=N;i++){const k=i%N,p=P[k],r=R[k],v=i*DS/vLen,sh=opt.shift?opt.shift(k):0,a=col?opt.alpha(k):1;
  prof.forEach(([o,y],j)=>{pos.push(p.x+r.x*(o+sh),y+HY[k],p.z+r.z*(o+sh));uv.push(j/(n-1),v);if(col)col.push(1,1,1,a)});
  if(i<N&&!(opt.skip&&opt.skip(k)))for(let j=0;j<n-1;j++){const q=i*n+j,b=q+n;idx.push(q,q+1,b,q+1,b+1,b)}}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
 if(col)g.setAttribute('color',new THREE.Float32BufferAttribute(col,4));
 g.setIndex(idx);g.computeVertexNormals();
 const m=new THREE.Mesh(g,mat);m.receiveShadow=true;trackGroup.add(m);return m;
}
const mirrorProf=prof=>prof.map(([o,y])=>[-o,y]).reverse();
// terrain: flat along the circuit, rolling hills further out
function trackDist(x,z){let m=1e12;for(let i=0;i<N;i+=5){const dx=P[i].x-x,dz=P[i].z-z,d=dx*dx+dz*dz;if(d<m)m=d}return Math.sqrt(m)}
function terrainH(x,z,d=trackDist(x,z)){return smooth(38,150,d)*(fbm(x/220+3,z/220+9,4)*30-7)}
// everything that follows the track lives in trackGroup and is rebuilt when the track changes
let trackGroup=new THREE.Group();scene.add(trackGroup);
let roadMat,curbMat,wallMat,wallMatR,boostPads;
const startLights=[],lampHeads=[],lampPools=[],lampGlows=[];
function setStartLights(n,green){startLights.forEach((m,k)=>{m.emissive.set(green?0x22ff55:0xff2020);m.color.set(green?0x003300:0x220000);m.emissiveIntensity=green||k<n?3:0})}
// steel tubes between two points, merged by the caller
const _gA=new THREE.Vector3(),_gB=new THREE.Vector3(),_gQ=new THREE.Quaternion(),_gUp=new THREE.Vector3(0,1,0);
function tubeGeo(a,b,r,n=6){_gA.set(...a);_gB.set(...b);const d=_gB.clone().sub(_gA),l=d.length();
 const g=new THREE.CylinderGeometry(r,r,l,n,1,true);g.applyQuaternion(_gQ.setFromUnitVectors(_gUp,d.normalize()));g.translate((_gA.x+_gB.x)/2,(_gA.y+_gB.y)/2,(_gA.z+_gB.z)/2);return g}
// start gantry like a modern circuit's: two tapering lattice towers, an arched truss across the track with the
// sponsor banner on both faces, and the start lights hanging under it (4 columns of 2, like the F1 rig)
function buildGantry(st){
 const G=new THREE.Group();G.position.set(st.x,st.y||0,st.z);G.rotation.y=st.angle;trackGroup.add(G);
 const steelM=new THREE.MeshStandardMaterial({color:0xc9ced4,metalness:.75,roughness:.35}),tubes=[];
 const xl=PIT_WALL,xr=-(WALL+.9),H=9.6;
 for(const x0 of [xl,xr]){const c0=[[-.8,-.6],[.8,-.6],[.8,.6],[-.8,.6]],c1=[[-.3,-.3],[.3,-.3],[.3,.3],[-.3,.3]];
  for(let i=0;i<4;i++){const j=(i+1)%4;tubes.push(tubeGeo([x0+c0[i][0],0,c0[i][1]],[x0+c1[i][0],H,c1[i][1]],.06));
   // X bracing up each face
   for(let k=0;k<4;k++){const t0=k/4,t1=(k+1)/4,P=(c,t,q)=>[x0+lerp(c0[q][0],c1[q][0],t),H*t,lerp(c0[q][1],c1[q][1],t)];
    tubes.push(tubeGeo(P(0,t0,i),P(0,t1,j),.03),tubeGeo(P(0,t0,j),P(0,t1,i),.03))}}}
 // the arch: two chords front and back, laced together
 const arc=(x,z)=>[x,H+.2+1.3*Math.cos(Math.PI*(x-(xl+xr)/2)/(xl-xr)),z],n=16;
 for(const z of [-.55,.55])for(let k=0;k<n;k++){const x0=lerp(xl,xr,k/n),x1=lerp(xl,xr,(k+1)/n);tubes.push(tubeGeo(arc(x0,z),arc(x1,z),.07));
  tubes.push(tubeGeo(arc(x0,z),[x0,H-1.1,z],.03))}
 for(let k=0;k<=n;k++){const x=lerp(xl,xr,k/n);tubes.push(tubeGeo(arc(x,-.55),arc(x,.55),.03),tubeGeo([x,H-1.1,-.55],[x,H-1.1,.55],.04))}
 for(const z of [-.55,.55])tubes.push(tubeGeo([xl,H-1.1,z],[xr,H-1.1,z],.06));
 const truss=new THREE.Mesh(mergeGeos(tubes),steelM);truss.castShadow=true;G.add(truss);tubes.forEach(g=>g.dispose());
 // banner on both faces
 const tex=canvasTex(1024,96,(g,w,h)=>{const gr=g.createLinearGradient(0,0,w,0);gr.addColorStop(0,'#0c1830');gr.addColorStop(1,'#13234a');g.fillStyle=gr;g.fillRect(0,0,w,h);
  g.fillStyle='#ffffff14';for(let x=0;x<w;x+=6)g.fillRect(x,0,2,h);
  g.font='bold italic 40px Arial';g.textBaseline='middle';g.textAlign='center';
  for(const [x,t,c] of [[110,'KRONOS','#fff'],[300,'KRONOS','#fff'],[512,'KOD RACING 3D','#e10600'],[724,'KRONOS','#fff'],[914,'KRONOS','#fff']]){g.fillStyle=c;g.fillText(t,x,h/2+2,180)}},false);
 const bm=new THREE.MeshStandardMaterial({map:tex,emissive:0xffffff,emissiveMap:tex,emissiveIntensity:.3,roughness:.5,side:THREE.DoubleSide});
 const span=xl-xr-2.2;for(const z of [-.62,.62]){const p=new THREE.Mesh(new THREE.PlaneGeometry(span,1.4),bm);p.position.set((xl+xr)/2,H-.4,z);if(z<0)p.rotation.y=Math.PI;G.add(p)}
 // start lights: 4 columns, 2 red lamps each, in black housings
 startLights.length=0;const hous=new THREE.MeshStandardMaterial({color:0x111214,roughness:.6});
 for(let k=0;k<4;k++){const x=-2.1+k*1.4,mat=new THREE.MeshStandardMaterial({color:0x220000,emissive:0xff0000,emissiveIntensity:0});
  const h=new THREE.Mesh(new THREE.BoxGeometry(.7,1.7,.5),hous);h.position.set(x,H-2.05,-.3);G.add(h);
  for(const y of [H-1.6,H-2.4]){const b=new THREE.Mesh(new THREE.SphereGeometry(.24,14,10),mat);b.position.set(x,y,-.58);G.add(b)}
  startLights.push(mat)}
}
// the main grandstand opposite the pits, Bahrain style: concrete terraces with blue seats (and the odd yellow and
// orange ones), fans in them, a glazed hospitality level on top, and a white tensile roof on steel arches with a
// lattice mast at each joint. built in 12 m modules that follow the straight
function buildGrandstand(){
 const s0=-112,s1=74,MOD=12,front=WALL+5,ROWS=14,RD=.85,RH=.45,depth=ROWS*RD;
 const kit=new Map(),put=(mat,geo,mtx)=>{geo.applyMatrix4(mtx);if(!kit.has(mat))kit.set(mat,[]);kit.get(mat).push(geo)},M=new THREE.Matrix4(),T=new THREE.Matrix4();
 const concrete=new THREE.MeshStandardMaterial({map:concreteTex,color:0xd9d6cf,roughness:.92}),dark=new THREE.MeshStandardMaterial({color:0x2a2e33,roughness:.6,metalness:.3});
 const glassM=new THREE.MeshStandardMaterial({color:0x22313f,roughness:.08,metalness:.7,emissive:0x0a141e}),white=new THREE.MeshStandardMaterial({color:0xf4f4f2,roughness:.7,side:THREE.DoubleSide});
 const steelM=new THREE.MeshStandardMaterial({color:0xcfd3d8,metalness:.6,roughness:.4}),rail=new THREE.MeshStandardMaterial({color:0xdfe3e6,metalness:.5,roughness:.4});
 const seats=[],fans=[],tubes=[];const nMod=Math.floor((s1-s0)/MOD);
 const frame=(s,lat)=>{const p=trackAt(s,lat);return new THREE.Matrix4().makeRotationY(p.angle).setPosition(p.x,p.y,p.z)};
 // local frame of a module: x along the track, z away from it (into the stand), y up
 const modB=s=>{const p=trackAt(s,front);return new THREE.Matrix4().makeRotationY(p.angle-Math.PI/2).setPosition(p.x,p.y,p.z)};
 for(let m=0;m<nMod;m++){const sc=s0+(m+.5)*MOD,B=modB(sc),bx=(w,h,d,x,y,z,mat)=>put(mat,new THREE.BoxGeometry(w,h,d),T.copy(B).multiply(M.makeTranslation(x,y,z)));
  bx(MOD,1.2,.4,0,.6,-.2,concrete);                                                    // front wall
  for(let r=0;r<ROWS;r++){const y=1.2+r*RH,z=r*RD;bx(MOD,RH,RD,0,y-RH/2,z+RD/2,concrete);
   for(let k=0;k<22;k++){const x=-MOD/2+.4+k*(MOD-.8)/21;if(k===11)continue;seats.push([T.copy(B).multiply(M.makeTranslation(x,y+.18,z+.42)).clone(),r,k,m]);
    if(Math.random()<.42)fans.push(T.copy(B).multiply(M.makeTranslation(x+rand(-.05,.05),y+.2,z+.5)).clone())}}
  bx(MOD,ROWS*RH+1.2,.3,0,(ROWS*RH+1.2)/2,depth+.15,concrete);                         // back wall
  // hospitality level: glazing in steel frames over the top rows
  const hy=1.2+ROWS*RH;bx(MOD,.3,4.4,0,hy+.15,depth+2.1,concrete);bx(MOD-.1,3,.12,0,hy+1.8,depth+.2,glassM);bx(MOD,3.4,4,0,hy+1.7,depth+2.3,concrete);
  for(let k=0;k<=6;k++)bx(.08,3,.16,-MOD/2+k*MOD/6,hy+1.8,depth+.15,dark);bx(MOD,.6,.2,0,hy+3.6,depth+.15,dark);
  for(const x of [-MOD/2+.1]){tubes.push([B,[x,hy+.2,depth+.1],[x,hy+.2,-1.2]])}
  // railing at the front of the stand and of the hospitality level
  bx(MOD,.05,.05,0,2.2,0,rail);bx(MOD,.05,.05,0,hy+1,depth-.1,rail);
 }
 // seats in blues with the odd yellow / orange, people in them
 {const sg=mergeGeos([new THREE.BoxGeometry(.44,.08,.4),new THREE.BoxGeometry(.44,.42,.07).translate(0,.22,.18)]);
  const im=new THREE.InstancedMesh(sg,new THREE.MeshStandardMaterial({roughness:.55}),seats.length),c=new THREE.Color();
  const PAL=[0x1f5fbf,0x2a74d6,0x3f8fe0,0x6fb4ee,0x1f5fbf,0x2a74d6],ODD=[0xf2c21b,0xe8742a,0x8fd0f4];
  seats.forEach(([mx,r,k,m],i)=>{im.setMatrixAt(i,mx);const h=hash2(k*7+m*131,r*13);c.setHex(h<.07?ODD[(h*100|0)%3]:PAL[((k+r*3+m*5)*7+(h*60|0))%PAL.length]);im.setColorAt(i,c)});
  im.receiveShadow=true;trackGroup.add(im);
  const body=new THREE.InstancedMesh(new THREE.CapsuleGeometry(.19,.32,3,6),new THREE.MeshStandardMaterial({roughness:.8}),fans.length),head=new THREE.InstancedMesh(new THREE.SphereGeometry(.11,8,6),new THREE.MeshStandardMaterial({color:0xd9a882,roughness:.8}),fans.length);
  fans.forEach((mx,i)=>{body.setMatrixAt(i,T.copy(mx).multiply(M.makeTranslation(0,.38,0)));head.setMatrixAt(i,T.copy(mx).multiply(M.makeTranslation(0,.8,0)));body.setColorAt(i,c.setHSL(Math.random(),rand(.3,.75),rand(.3,.65)))});
  trackGroup.add(body,head)}
 // the tensile roof: one sail per module, arched front to back, sagging at the joints, scalloped front edge
 {const hy=1.2+ROWS*RH,pos=[],uv=[],idx=[],NU=10,NV=10,roofZ0=-3,roofZ1=depth+4.5;
  for(let m=0;m<nMod;m++){const sc=s0+(m+.5)*MOD,B=modB(sc),base=pos.length/3;
   for(let i=0;i<=NU;i++)for(let j=0;j<=NV;j++){const u=i/NU,v=j/NV,sag=Math.sin(Math.PI*u);
    const z=lerp(roofZ0+(1-sag)*1.6,roofZ1,v),y=hy+7.2+3.2*Math.sin(Math.PI*v)*(.55+.45*sag)-1.4*(1-sag)+v*1.5;
    const p=new THREE.Vector3(-MOD/2+u*MOD,y,z).applyMatrix4(B);pos.push(p.x,p.y,p.z);uv.push(u,v);
    if(i<NU&&j<NV){const a=base+i*(NV+1)+j;idx.push(a,a+NV+1,a+1,a+1,a+NV+1,a+NV+2)}}
   // the steel arch under each joint, columns at the back, and a lattice mast on top
   const ar=[];for(let j=0;j<=10;j++){const v=j/10,z=lerp(roofZ0+1.6,roofZ1,v),y=hy+7.2+3.2*Math.sin(Math.PI*v)*.55-1.4+v*1.5-.25;ar.push([-MOD/2,y,z])}
   for(let j=0;j<10;j++)tubes.push([B,ar[j],ar[j+1],.12]);tubes.push([B,[-MOD/2,0,depth+3.8],ar[9],.18]);
   for(let j=1;j<10;j+=2)tubes.push([B,ar[j],[-MOD/2,hy+3.8,Math.min(depth+.1,ar[j][2])],.05]);
   const top=ar[5];for(const [dx,dz] of [[-.6,-.6],[.6,-.6],[.6,.6],[-.6,.6]])tubes.push([B,[top[0]+dx*.4,top[1],top[2]+dz*.4],[top[0]+dx,top[1]+3.2,top[2]+dz],.05]);
   for(const y of [1.1,2.2,3.2])for(let q=0;q<4;q++){const c=[[-.6,-.6],[.6,-.6],[.6,.6],[-.6,.6]],a=c[q],b=c[(q+1)%4],k=lerp(.4,1,y/3.2);tubes.push([B,[top[0]+a[0]*k,top[1]+y,top[2]+a[1]*k],[top[0]+b[0]*k,top[1]+y,top[2]+b[1]*k],.04])}}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(idx);g.computeVertexNormals();
  const roof=new THREE.Mesh(g,white);roof.castShadow=true;roof.receiveShadow=true;trackGroup.add(roof)}
 {const list=tubes.map(([B,a,b,r=.08])=>tubeGeo(a,b,r).applyMatrix4(B));const tm=new THREE.Mesh(mergeGeos(list),steelM);tm.castShadow=true;trackGroup.add(tm);list.forEach(g=>g.dispose())}
 for(const [mat,list] of kit){const m=new THREE.Mesh(mergeGeos(list),mat);m.castShadow=m.receiveShadow=true;trackGroup.add(m);list.forEach(g=>g.dispose())}
}
function buildCircuit(){
const scene=trackGroup;
const ground=(()=>{
 const geo=new THREE.PlaneGeometry(4600,4600,230,230);geo.rotateX(-Math.PI/2);
 const pos=geo.attributes.position,col=new Float32Array(pos.count*3),td=new Float32Array(pos.count);
 for(let i=0;i<pos.count;i++){const x=pos.getX(i),z=pos.getZ(i),d=trackDist(x,z);pos.setY(i,terrainH(x,z,d));td[i]=d;
  const m=fbm(x/90,z/90,3),dry=smooth(.5,.75,fbm(x/300+5,z/300,2));
  col[i*3]=(.82+.3*m)*(1+.18*dry);col[i*3+1]=(.86+.22*m)*(1+.03*dry);col[i*3+2]=(.8+.2*m)*(1-.22*dry)}
 geo.setAttribute('color',new THREE.BufferAttribute(col,3));geo.setAttribute('tdist',new THREE.BufferAttribute(td,1));geo.computeVertexNormals();
 const mat=new THREE.MeshStandardMaterial({map:grassTex,vertexColors:true,roughness:1,normalMap:grassNormal,normalScale:new THREE.Vector2(.55,.55)});
 mat.normalMap.repeat.set(575,575);mat.normalMap.wrapS=mat.normalMap.wrapT=THREE.RepeatWrapping;
 // sample the grass at two scales in world space and blend in dirt by noise, so no tiling shows
 mat.onBeforeCompile=sh=>{
  sh.uniforms.dirtMap={value:dirtTex};
  withWorldPos(sh);
  sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\nattribute float tdist;varying float vTD;').replace('#include <begin_vertex>','#include <begin_vertex>\nvTD=tdist;');
  sh.fragmentShader=sh.fragmentShader.replace('#include <common>','#include <common>\nuniform sampler2D dirtMap;varying float vTD;')
  .replace('#include <map_fragment>',`
   vec2 wp=vWPos.xz;
   vec4 gc=mix(texture2D(map,wp/8.),texture2D(map,wp/23.+vec2(.37,.11)),smoothstep(.3,.7,gn(wp/47.)));
   float dn=gn(wp/31.+7.)*.65+gn(wp/9.)*.35;
   diffuseColor*=mix(gc,texture2D(dirtMap,wp/6.),smoothstep(.66,.78,dn)*smoothstep(25.,45.,vTD));
   // mown verges: light/dark stripes from the mower going back and forth
   float mown=1.-smoothstep(38.,62.,vTD),stripe=smoothstep(.4,.6,abs(fract(dot(wp,vec2(.766,.643))/20.)*2.-1.));
   diffuseColor.rgb*=mix(1.,mix(.8,1.13,stripe),mown);
   // rough meadow further out: olive and straw tones in big patches, a little clover-dark here and there
   float m1=gfbm(wp/90.),m2=gn(wp/22.+4.);
   vec3 wild=mix(vec3(1.08,1.02,.74),vec3(.82,.92,.8),smoothstep(.35,.65,m1))*mix(.86,1.06,m2);
   diffuseColor.rgb*=mix(wild,vec3(1.,1.02,.98),mown);
   // long grass and shade right against the barrier, and a touch less saturation overall
   diffuseColor.rgb*=mix(.72,1.,smoothstep(13.,17.5,vTD));
   float lum=dot(diffuseColor.rgb,vec3(.3,.59,.11));diffuseColor.rgb=mix(vec3(lum),diffuseColor.rgb,.86);`);
 };
 const g=new THREE.Mesh(geo,mat);
 g.receiveShadow=true;scene.add(g);return g;
})();
roadMat=new THREE.MeshStandardMaterial({map:asphaltTex,roughnessMap:asphaltRough,roughness:1,normalMap:asphaltNormal,normalScale:new THREE.Vector2(.7,.7),polygonOffset:true,polygonOffsetFactor:-1});
curbMat=new THREE.MeshStandardMaterial({map:kerbTex,bumpMap:kerbTex,bumpScale:.6,roughness:.7,polygonOffset:true,polygonOffsetFactor:-2});
// big-scale variation the tile can't have: resurfaced sections, lighter sun-bleached stretches, the odd dark seam
roadMat.onBeforeCompile=sh=>{withWorldPos(sh);Object.assign(sh.uniforms,roadWet);
 sh.fragmentShader=sh.fragmentShader.replace('#include <common>',`#include <common>
  uniform float uWet,uRainT;float rh(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
  // rings from drops landing: one drop per cell, each at its own moment; returns the slope of the water
  vec2 ripples(vec2 p,float t){vec2 g=vec2(0.);
   for(int k=0;k<2;k++){float sc=k==0?.7:1.1;vec2 q=p/sc+float(k)*17.,id=floor(q),f=fract(q)-.5-(vec2(rh(id),rh(id+5.))-.5)*.5;
    float ph=fract(t*(1.1+.4*rh(id+9.))+rh(id+3.)),r=length(f)/.48,w=sin((r-ph)*38.)*smoothstep(1.,.6,r)*smoothstep(.0,.15,ph)*(1.-ph);
    g+=normalize(f+1e-4)*w;}
   return g;}`)
 .replace('#include <map_fragment>',`#include <map_fragment>
  vec2 rp=vWPos.xz;float rv=gfbm(rp/48.),patchN=smoothstep(.62,.66,gn(rp/70.+11.));
  diffuseColor.rgb*=(.9+.22*rv)*mix(1.,.78,patchN)*(1.+.06*(gn(rp/3.)-.5));
  float pud=smoothstep(.48,.56,gn(rp/9.+3.)*.65+gn(rp/2.7)*.35)*uWet;
  diffuseColor.rgb*=mix(1.,.36,pud);`)
 .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\n  roughnessFactor=mix(roughnessFactor,.035,pud);')
 .replace('#include <normal_fragment_maps>',`#include <normal_fragment_maps>
  // rings only show in standing water, and only close up (further away they'd just shimmer)
  float rd=smoothstep(28.,6.,distance(cameraPosition,vWPos));
  if(pud*rd>.01){vec2 rg=ripples(rp*2.2,uRainT)*.3*pud*rd;normal=normalize(normal+(viewMatrix*vec4(rg.x,0.,rg.y,0.)).xyz);}`)};
ribbon(-ROAD,ROAD,.05,22,roadMat);
// raised kerbs
const KERB=[[ROAD-.05,.05],[ROAD+.3,.14],[CURB-.35,.14],[CURB,.06]];
profileRibbon(KERB,4,curbMat);profileRibbon(mirrorProf(KERB),4,curbMat);
// dark rubber on the racing line, heaviest through the corners
noAO.push(profileRibbon([[-1.9,.057],[1.9,.057]],22,new THREE.MeshStandardMaterial({color:0x0a0a0b,alphaMap:rubberTex,transparent:true,vertexColors:true,depthWrite:false,roughness:.55,polygonOffset:true,polygonOffsetFactor:-2}),
 {shift:k=>clamp(lineLat[k]*1.05,-5.6,5.6),alpha:k=>{let m=0;for(let j=-20;j<=20;j+=4)m=Math.max(m,Math.abs(KS[wrapI(k+j)]));return .3+.7*smooth(.004,.02,m)}}));
{// streaks where everybody brakes: just before the corners
 const zone=KS.map((_,k)=>{let ahead=0;for(let j=15;j<=50;j+=5)ahead=Math.max(ahead,Math.abs(KS[wrapI(k+j)]));return smooth(.009,.02,ahead)*(1-smooth(.006,.012,Math.abs(KS[k])))});
 const bm=new THREE.MeshStandardMaterial({color:0x070708,alphaMap:brakeTex,transparent:true,vertexColors:true,depthWrite:false,roughness:.6,polygonOffset:true,polygonOffsetFactor:-3});
 for(const off of [-.7,.8])noAO.push(profileRibbon([[-1.1,.058],[1.1,.058]],9,bm,{shift:k=>clamp(lineLat[k]+off+Math.sin(k*.05)*.3,-6,6),alpha:k=>zone[k]*.9}));
}
const gravelMat=new THREE.MeshStandardMaterial({map:gravelTex,normalMap:gravelNormal,normalScale:new THREE.Vector2(1.2,1.2),roughness:.95,polygonOffset:true,polygonOffsetFactor:-1});
// stones thrown over the kerb, dust settling against the barrier
gravelMat.onBeforeCompile=sh=>{withWorldPos(sh);sh.fragmentShader=sh.fragmentShader.replace('#include <map_fragment>',`#include <map_fragment>
  diffuseColor.rgb*=.86+.24*gfbm(vWPos.xz/6.);`)};
// the left side opens up for the pit lane
const pitSkip=k=>!!pitZone((k+.5)*DS);
ribbon(k=>-WL[k],-CURB,.04,3,gravelMat,pitSkip);
ribbon(CURB,k=>WR[k],.04,3,gravelMat);
// concrete barriers with vinyl banners, catch fence on posts behind them
const BARRIER=[[WALL-.05,0],[WALL+.05,.82],[WALL+.15,1],[WALL+.35,1],[WALL+.45,0]];
const barrierMat=new THREE.MeshStandardMaterial({map:concreteTex,roughness:.9});
// the barrier follows the run-off: pushed out on the outside of the corners
for(const prof of [BARRIER,mirrorProf(BARRIER)]){const m=profileRibbon(prof,3,barrierMat,prof===BARRIER?{shift:k=>WR[k]-WALL}:{skip:pitSkip,shift:k=>WALL-WL[k]});m.castShadow=true}
wallMat=new THREE.MeshStandardMaterial({map:adTex,roughness:.6,side:THREE.DoubleSide,emissive:0xffffff,emissiveMap:adTex,emissiveIntensity:0,polygonOffset:true,polygonOffsetFactor:-2});
wall(k=>-WL[k]+.08,.58,60,wallMat,.18,pitSkip).castShadow=false;
// the right-hand banners are seen from the other side of the strip, so flip their texture or the text reads backwards
wallMatR=wallMat.clone();wallMatR.map=wallMatR.emissiveMap=adTex.clone();wallMatR.map.repeat.set(-1,1);wallMatR.map.needsUpdate=true;
wall(k=>WR[k]-.08,.58,60,wallMatR,.18).castShadow=false;
const fenceMat=new THREE.MeshStandardMaterial({map:fenceTex,alphaTest:.4,alphaToCoverage:true,side:THREE.DoubleSide,metalness:.6,roughness:.45});
for(const sd of [-1,1]){const f=wall(k=>sd*(wallAt(k,sd)+.3),3.2,1.25,fenceMat,1,sd<0?pitSkip:null);f.castShadow=false;noAO.push(f)}
// the top of the catch fence leans in over the track, like the real panels
for(const prof of [[[WALL-.45,4.95],[WALL+.3,4.2]],mirrorProf([[WALL-.45,4.95],[WALL+.3,4.2]])]){const right=prof[0][0]>0;
 const f=profileRibbon(prof,1.25,fenceMat,right?{shift:k=>WR[k]-WALL}:{skip:pitSkip,shift:k=>WALL-WL[k]});f.castShadow=false;noAO.push(f)}
// tension cables along the fence and a rail on top
{const cable=new THREE.MeshStandardMaterial({color:0x9aa0a6,metalness:.8,roughness:.35,side:THREE.DoubleSide});
 for(const sd of [-1,1])for(const [y,hh] of [[1.02,.03],[2.6,.03],[4.12,.07]]){const c=wall(k=>sd*(wallAt(k,sd)+.32),hh,10,cable,y,sd<0?pitSkip:null);c.castShadow=false}}
{const n=Math.ceil(L/5)*2+2,posts=new THREE.InstancedMesh(new THREE.CylinderGeometry(.045,.055,4.3,8),new THREE.MeshStandardMaterial({color:0x8d939a,metalness:.75,roughness:.38}),n);
 const m=new THREE.Matrix4();let k=0;
 for(let s=0;s<L-2.5;s+=5)for(const sd of [-1,1]){if(sd<0&&pitZone(s))continue;const p=trackAt(s,sd*(wallAtS(s,sd)+.3));m.makeTranslation(p.x,2.15+p.y,p.z);posts.setMatrixAt(k++,m)}
 posts.count=Math.min(k,n);posts.castShadow=true;scene.add(posts)}

// start line, gantry with countdown lights
const st=trackAt(0);
const checker=canvasTex(128,32,(g,w,h)=>{for(let x=0;x<16;x++)for(let y=0;y<4;y++){g.fillStyle=(x+y)%2?'#111':'#f5f5f5';g.fillRect(x*8,y*8,8,8)}},false);
const startLine=new THREE.Mesh(new THREE.PlaneGeometry(ROAD*2,3),new THREE.MeshStandardMaterial({map:checker,polygonOffset:true,polygonOffsetFactor:-3}));
startLine.rotation.order='YXZ';startLine.rotation.set(-Math.PI/2,st.angle,0);
startLine.position.set(st.x,.09,st.z);scene.add(startLine);
buildPit();
// painted grid slots
{const gm=new THREE.MeshStandardMaterial({color:0xeeeeea,roughness:.6,polygonOffset:true,polygonOffsetFactor:-3});
 const mark=(d,lat,w,l)=>{const p=trackAt(d,lat),m=new THREE.Mesh(new THREE.PlaneGeometry(w,l),gm);m.rotation.order='YXZ';m.rotation.set(-Math.PI/2,p.angle,0);m.position.set(p.x,.062,p.z);scene.add(m)};
 for(let k=0;k<4;k++){const d=-10-Math.floor(k/2)*9,lat=k%2?3.6:-3.6;mark(d+2.9,lat,2.6,.18);mark(d+2.2,lat-1.25,.16,1.4);mark(d+2.2,lat+1.25,.16,1.4)}
 // the slot number and the yellow line across the box, like a real grid
 const ym=new THREE.MeshStandardMaterial({color:0xf2c21b,roughness:.6,polygonOffset:true,polygonOffsetFactor:-3});
 for(let k=0;k<4;k++){const d=-10-Math.floor(k/2)*9,lat=k%2?3.6:-3.6,p=trackAt(d+1.2,lat+.3),y=new THREE.Mesh(new THREE.PlaneGeometry(1.9,.12),ym);y.rotation.order='YXZ';y.rotation.set(-Math.PI/2,p.angle,0);y.position.set(p.x,.063,p.z);scene.add(y);
  const t=canvasTex(64,64,(g,w,h)=>{g.clearRect(0,0,w,h);g.fillStyle='#eeeeea';g.font='bold 48px Arial';g.textAlign='center';g.textBaseline='middle';g.fillText(String(k+1),w/2,h/2+2)},false);
  const q=trackAt(d+3.5,lat-.8),n=new THREE.Mesh(new THREE.PlaneGeometry(.7,.7),new THREE.MeshStandardMaterial({map:t,transparent:true,roughness:.6,polygonOffset:true,polygonOffsetFactor:-3}));
  n.rotation.order='YXZ';n.rotation.set(-Math.PI/2,q.angle+Math.PI,0);n.position.set(q.x,.063,q.z);scene.add(n)}}
// a green verge instead of gravel along the main straight, on the grandstand side
{const vm=new THREE.MeshStandardMaterial({map:grassTex,color:0x9fcf7a,roughness:1,polygonOffset:true,polygonOffsetFactor:-2});
 ribbon(CURB+.02,k=>WR[k]-.05,.045,4,vm,k=>{const r=pitRel(k*DS);return r<-200||r>320})}
buildGantry(st);

buildGrandstand();

// boost pads
// slide each pad forward to the next straight bit, so none lands in a chicane or on the bridge
const straightFrom=s0=>{for(let s=s0;s<s0+500;s+=DS*2){const i=Math.floor(wrapS(s)/DS);let m=0;for(let k=-12;k<=12;k++)m=Math.max(m,Math.abs(KS[wrapI(i+k)]));
 if(m<.004&&!HY[i]&&!nearBridge(P[i].x,P[i].z,90))return wrapS(s)}return s0};
boostPads=[0.1,0.31,0.44,0.6,0.78,0.92].map((f,k)=>{
 const s=straightFrom(f*L),lat=[0,-3.5,3.5,0,3.5,-3.5][k],p=trackAt(s,lat);
 const tex=boostTex.clone();tex.needsUpdate=true;tex.repeat.set(1,2);
 const m=new THREE.Mesh(new THREE.PlaneGeometry(4.5,8),new THREE.MeshBasicMaterial({map:tex,transparent:true,opacity:.9,polygonOffset:true,polygonOffsetFactor:-3}));
 m.rotation.order='YXZ';m.rotation.y=p.angle+Math.PI;m.rotation.x=-Math.PI/2;m.position.set(p.x,.1+p.y,p.z);scene.add(m);
 return {s,lat,tex,mesh:m};
});

// trackside life: brake boards before the big corners, marshal posts, TV towers and fans at corners,
// sponsor bridges over the straights, hospitality tents and flags by the start, a big screen
function buildTrackside(){
 const scene=trackGroup,kit=new Map(),put=(mat,geo,mtx)=>{geo.applyMatrix4(mtx);if(!kit.has(mat))kit.set(mat,[]);kit.get(mat).push(geo)};
 const M=new THREE.Matrix4(),T=new THREE.Matrix4(),frameAt=(s,lat,turn=0)=>{const p=trackAt(s,lat);return new THREE.Matrix4().makeRotationY(p.angle+turn).setPosition(p.x,p.y,p.z)};
 const box=(mat,B,w,h,d,x,y,z)=>put(mat,new THREE.BoxGeometry(w,h,d),T.copy(B).multiply(M.makeTranslation(x,y,z)));
 const free=(s,lat)=>{const p=trackAt(s,lat),r=pitRel(s);return !inPitArea(p.x,p.z)&&!nearBridge(p.x,p.z,70)&&!(lat>0&&r>-125&&r<85)&&!(Math.abs(r)<12)};
 const white=new THREE.MeshStandardMaterial({color:0xf2f4f6,roughness:.6}),steel=new THREE.MeshStandardMaterial({color:0x5b636c,metalness:.6,roughness:.4});
 const orange=new THREE.MeshStandardMaterial({color:0xff7a1a,roughness:.7}),darkM=new THREE.MeshStandardMaterial({color:0x22272d,roughness:.6});
 const skin=new THREE.MeshStandardMaterial({color:0xd9a882,roughness:.8});
 // corners: peaks of curvature, where the lap really slows down. side = the outside of the turn
 const corners=[];
 for(let i=0;i<N;i++){const k=Math.abs(KS[i]);if(k<.012)continue;let peak=true;for(let j=-15;j<=15;j++)if(Math.abs(KS[wrapI(i+j)])>k){peak=false;break}
  if(!peak||corners.some(c=>Math.abs(pitRel((c.i-i)*DS))<70))continue;
  let e=i;while(Math.abs(KS[wrapI(e-1)])>.006&&i-e<80)e--;
  corners.push({i,s:i*DS,entry:e*DS,side:KS[i]<0?-1:1,k})}
 // 1) brake boards 150 / 100 / 50 m before a corner that has a straight in front of it
 {const tex=canvasTex(384,128,(g,w,h)=>{['150','100','50'].forEach((t,k)=>{const x=k*128;g.fillStyle='#f4f4f0';g.fillRect(x,0,128,h);g.strokeStyle='#111';g.lineWidth=8;g.strokeRect(x+5,5,118,h-10);
   g.fillStyle='#111';g.font='bold 62px Arial';g.textAlign='center';g.textBaseline='middle';g.fillText(t,x+64,h/2+3)})},false);
  const mat=new THREE.MeshStandardMaterial({map:tex,roughness:.6});
  for(const c of corners){let straight=true;for(let d=60;d<=200;d+=10)if(Math.abs(KS[wrapI(Math.round((c.entry-d)/DS))])>.006)straight=false;if(!straight)continue;
   [150,100,50].forEach((d,k)=>{const s=c.entry-d,lat=c.side*(wallAtS(c.entry-d,c.side)+1.1);if(!free(s,lat))return;const B=frameAt(s,lat,Math.PI);
    const pl=new THREE.PlaneGeometry(1.4,1.4),uv=pl.attributes.uv;for(let q=0;q<uv.count;q++)uv.setX(q,(k+uv.getX(q))/3);put(mat,pl,T.copy(B).multiply(M.makeTranslation(0,2.5,0)));
    box(steel,B,.08,1.8,.08,0,.9,.05)})}}
 // 2) marshal posts every ~320 m, alternating sides: a little hut, a marshal in orange with a green flag
 {const flagG=new THREE.MeshStandardMaterial({color:0x22b04a,roughness:.8,side:THREE.DoubleSide});let side=1;
  for(let s=120;s<L-80;s+=230){side=-side;const lat=side*(wallAtS(s,side)+3.2);if(!free(s,lat))continue;const B=frameAt(s,lat,side>0?Math.PI/2:-Math.PI/2);
   box(white,B,1.8,2.2,1.6,0,1.1,-1.2);box(orange,B,2.1,.18,1.9,0,2.3,-1.2);box(darkM,B,1.2,.6,.05,0,1.5,-.38);
   box(orange,B,.4,1.1,.3,-.2,.95,.3);put(skin,new THREE.SphereGeometry(.15,10,8),T.copy(B).multiply(M.makeTranslation(-.2,1.7,.3)));
   box(steel,B,.03,1.2,.03,.15,1.5,.4);put(flagG,new THREE.PlaneGeometry(.7,.45),T.copy(B).multiply(M.makeTranslation(.5,1.85,.4)))}}
 // 3) TV towers on the outside of the first three corners, with a cameraman up top
 for(const c of corners.slice(0,3)){const lat=c.side*(wallAtS(c.s,c.side)+6.5);if(!free(c.s,lat))continue;const B=frameAt(c.s,lat);
  for(const [x,z] of [[-.8,-.8],[.8,-.8],[-.8,.8],[.8,.8]])box(steel,B,.12,5.5,.12,x,2.75,z);
  for(const y of [1.8,3.6])for(const [w,d,x,z] of [[1.7,.08,0,-.8],[1.7,.08,0,.8],[.08,1.7,-.8,0],[.08,1.7,.8,0]])box(steel,B,w,.08,d,x,y,z);
  box(darkM,B,2.2,.15,2.2,0,5.55,0);box(darkM,B,.5,.4,.9,0,6.05,-c.side*.3);box(orange,B,.4,1,.3,c.side*.5,6.1,0);put(skin,new THREE.SphereGeometry(.15,10,8),T.copy(B).multiply(M.makeTranslation(c.side*.5,6.75,0)))}
 // 4) fans on the grass banks outside a few corners: instanced bodies and heads in random colours
 {const spots=[];for(const c of corners.slice(1,9)){for(let n=0;n<90;n++){const s=c.s+rand(-35,35),lat=c.side*(wallAtS(s,c.side)+rand(3.5,11));if(free(s,lat))spots.push([s,lat])}}
  const body=new THREE.InstancedMesh(new THREE.CapsuleGeometry(.22,.7,3,6),new THREE.MeshStandardMaterial({roughness:.8}),spots.length),head=new THREE.InstancedMesh(new THREE.SphereGeometry(.13,8,6),skin,spots.length),col=new THREE.Color();
  spots.forEach(([s,lat],n)=>{const p=trackAt(s,lat),y=terrainH(p.x,p.z);body.setMatrixAt(n,M.makeTranslation(p.x,y+.6,p.z));head.setMatrixAt(n,M.makeTranslation(p.x,y+1.32,p.z));body.setColorAt(n,col.setHSL(Math.random(),rand(.4,.8),rand(.3,.6)))});
  body.castShadow=true;scene.add(body,head)}
 // 5) sponsor bridges across two straights
 {const ads=[['NITRO ENERGY','#0c1a2e','#3cf'],['KOD MOTORS','#e10600','#fff'],['APEX TYRES','#111','#ffd21e'],['VORTEX OIL','#1d4ed8','#fff']];
  const tex=canvasTex(1024,256,(g,w,h)=>{ads.forEach(([t,bg,fg],k)=>{const y=k*h/4;g.fillStyle=bg;g.fillRect(0,y,w,h/4);g.fillStyle=fg;g.font='bold italic 48px Arial';g.textAlign='center';g.textBaseline='middle';g.fillText(t,w/2,y+h/8+2)})},false);
  const mat=new THREE.MeshStandardMaterial({map:tex,emissive:0xffffff,emissiveMap:tex,emissiveIntensity:.3,roughness:.5});
  let n=0;for(const f of [.3,.62]){const s=straightFrom(f*L)+60;if(!free(s,0)||!free(s,-WALL-2)||!free(s,WALL+2))continue;scene.userData.bridges=(scene.userData.bridges||[]).concat(s);const B=frameAt(s,0),span=2*(WALL+1.6);
   for(const x of [-(WALL+1.6),WALL+1.6])box(darkM,B,.9,7.6,.9,x,3.8,0);box(darkM,B,span+1,.25,1.3,0,7.7,0);
   for(const [z,rot] of [[-.62,Math.PI],[.62,0]]){const pl=new THREE.PlaneGeometry(span,1.5),uv=pl.attributes.uv;for(let q=0;q<uv.count;q++)uv.setY(q,1-(n%4+1-uv.getY(q))/4);
    put(mat,pl,T.copy(B).multiply(M.makeTranslation(0,6.8,z)).multiply(M.makeRotationY(rot)))}n++}}
 // billboards on stilts behind the fence along the straights, alternating sides
 {const tex=canvasTex(1024,256,(g,w,h)=>{[['NITRO ENERGY','#0c1a2e','#3cf'],['KOD MOTORS','#e10600','#fff'],['APEX TYRES','#111','#ffd21e'],['VORTEX OIL','#1d4ed8','#fff']].forEach(([t,bg,fg],k)=>{const y=k*h/4;g.fillStyle=bg;g.fillRect(0,y,w,h/4);g.fillStyle=fg;g.font='bold italic 50px Arial';g.textAlign='center';g.textBaseline='middle';g.fillText(t,w/2,y+h/8+2)})},false);
  const mat=new THREE.MeshStandardMaterial({map:tex,emissive:0xffffff,emissiveMap:tex,emissiveIntensity:.25,roughness:.5});let side=1,n=0;
  for(let s=60;s<L-40;s+=95){let m=0;for(let k=-10;k<=10;k++)m=Math.max(m,Math.abs(KS[wrapI(Math.round(s/DS)+k)]));if(m>.006)continue;
   side=-side;const lat=side*(wallAtS(s,side)+4.5);if(!free(s,lat))continue;const B=frameAt(s,lat,side>0?Math.PI/2:-Math.PI/2);
   const pl=new THREE.PlaneGeometry(14,3.5),uv=pl.attributes.uv;for(let q=0;q<uv.count;q++)uv.setY(q,1-(n%4+1-uv.getY(q))/4);n++;
   put(mat,pl,T.copy(B).multiply(M.makeTranslation(0,6,0)));box(darkM,B,14.4,3.9,.25,0,6,-.15);for(const x of [-5,0,5])box(steel,B,.25,4.4,.25,x,2.2,-.2)}}
 // 6) hospitality tents behind the grandstand
 {const roof=new THREE.ConeGeometry(4.2,2.6,4).rotateY(Math.PI/4);
  for(let k=0;k<5;k++){const s=-80+k*14,lat=WALL+52+(k%2)*6,B=frameAt(s,lat);box(white,B,5.8,2.6,5.8,0,1.3,0);put(white,roof.clone(),T.copy(B).multiply(M.makeTranslation(0,3.9,0)))}}
 // 7) flags along the main straight, behind the outside fence
 {const fl=[];for(let s=90;s<200;s+=11){if(free(s,WALL+1.6))fl.push(frameAt(s,WALL+1.6))}
  const pole=new THREE.InstancedMesh(new THREE.CylinderGeometry(.04,.05,6,6),steel,fl.length),flag=new THREE.InstancedMesh(new THREE.PlaneGeometry(1.6,1).translate(.8,2.4,0),flagMat(),fl.length),col=new THREE.Color();
  fl.forEach((B,n)=>{pole.setMatrixAt(n,T.copy(B).multiply(M.makeTranslation(0,3,0)));flag.setMatrixAt(n,T.copy(B).multiply(M.makeTranslation(0,3,0)).multiply(M.makeRotationY(Math.PI/2)));flag.setColorAt(n,col.setHSL(n*.13%1,.8,.5))});
  scene.add(pole,flag)}
 // 8) a big screen on the outside of the first corner
 {const c=corners[0];if(c){const lat=c.side*(wallAtS(c.entry,c.side)+9);if(free(c.entry,lat)){const B=frameAt(c.entry,lat,Math.PI);
  const tex=canvasTex(512,288,(g,w,h)=>{const gr=g.createLinearGradient(0,0,w,h);gr.addColorStop(0,'#0b1a3a');gr.addColorStop(1,'#3a0b2e');g.fillStyle=gr;g.fillRect(0,0,w,h);
   g.font='bold italic 64px Arial';g.textAlign='center';g.textBaseline='middle';const t=g.createLinearGradient(0,0,w,0);t.addColorStop(0,'#3cf');t.addColorStop(1,'#f4c');g.fillStyle=t;g.fillText('KOD RACING',w/2,h/2-24);
   g.fillStyle='#fff';g.font='bold 34px Arial';g.fillText('LIVE',w/2,h/2+42);g.fillStyle='#e10600';g.beginPath();g.arc(w/2-58,h/2+42,10,0,7);g.fill()},false);
  put(new THREE.MeshStandardMaterial({map:tex,emissive:0xffffff,emissiveMap:tex,emissiveIntensity:.9,roughness:.4}),new THREE.PlaneGeometry(9,5),T.copy(B).multiply(M.makeTranslation(0,6.5,0)));
  box(darkM,B,9.6,5.6,.4,0,6.5,-.25);for(const x of [-3,3])box(steel,B,.3,4,.3,x,2,-.3)}}}
 for(const [mat,list] of kit){const m=new THREE.Mesh(mergeGeos(list),mat);m.castShadow=true;m.receiveShadow=true;scene.add(m);list.forEach(g=>g.dispose())}
}
buildTrackside();

// lamps (with fake light pools for the night)
lampHeads.length=lampPools.length=lampGlows.length=0;
{const poleMat=new THREE.MeshStandardMaterial({color:0x4a5260,metalness:.5,roughness:.5});
 const headMat=new THREE.MeshStandardMaterial({color:0xfff4d0,emissive:0xffe2a0,emissiveIntensity:0});lampHeads.push(headMat);
 const poolMat=new THREE.MeshBasicMaterial({map:glowTex,color:0xffcf80,transparent:true,opacity:.5,blending:THREE.AdditiveBlending,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-4});lampPools.push(poolMat);
 const LSTEP=Math.round(48/DS);   // a lamp every ~48 m, alternating sides
 for(let i=0;i<N;i+=LSTEP){const side=(i/LSTEP)%2?1:-1,p=trackAt(i*DS,side*(wallAt(i,side)+1.2)),q=trackAt(i*DS,side*(ROAD-2.5));
  if(nearBridge(p.x,p.z,70)||side<0&&pitZone(i*DS))continue;
  const pole=new THREE.Mesh(new THREE.CylinderGeometry(.15,.2,9,8),poleMat);pole.position.set(p.x,4.5,p.z);pole.castShadow=true;scene.add(pole);
  const arm=new THREE.Mesh(new THREE.BoxGeometry(.15,.15,4),poleMat);const ax=(p.x+q.x)/2,az=(p.z+q.z)/2;
  arm.position.set(p.x+(q.x-p.x)*.35,9,p.z+(q.z-p.z)*.35);arm.lookAt(q.x,9,q.z);scene.add(arm);
  const head=new THREE.Mesh(new THREE.BoxGeometry(.8,.25,1.4),headMat);head.position.set(p.x+(q.x-p.x)*.62,8.9,p.z+(q.z-p.z)*.62);head.lookAt(q.x,8.9,q.z);scene.add(head);
  const glow=new THREE.Sprite(new THREE.SpriteMaterial({map:glowTex,color:0xffd890,transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthWrite:false}));glow.scale.set(6,6,1);glow.position.copy(head.position);scene.add(glow);noAO.push(glow);lampGlows.push(glow.material);
  const pool=new THREE.Mesh(new THREE.CircleGeometry(9,24),poolMat);pool.rotation.x=-Math.PI/2;pool.position.set(ax+(q.x-ax)*.6,.12,az+(q.z-az)*.6);pool.visible=false;scene.add(pool);
 }}

// the bridge: concrete walls under the raised road on the ramps; where it spans the lower road
// they stop short and a deck carries it across
if(bridge){
 const pos=[],uv=[],idx=[];
 const deck=[],quad=(a,b,c,d,u0,u1,vh,under)=>{const n=pos.length/3;pos.push(...a,...b,...c,...d);uv.push(u0,0,u1,0,u1,vh,u0,vh);(under?deck:idx).push(n,n+1,n+2,n,n+2,n+3)};
 const overLow=(x,z)=>{for(let k=-120;k<=120;k++){const p=P[wrapI(bridge.lo+k)];if((p.x-x)**2+(p.z-z)**2<(WALL+1.5)**2)return true}return false};
 for(let i=0;i<N;i++){const j=(i+1)%N;if(HY[i]<.01&&HY[j]<.01)continue;const u0=i*DS/4,u1=u0+DS/4;
  for(const sd of [-1,1]){const o=sd*(WALL+.45),ax=P[i].x+R[i].x*o,az=P[i].z+R[i].z*o,bx=P[j].x+R[j].x*o,bz=P[j].z+R[j].z*o;
   const span=overLow(ax,az)||overLow(bx,bz),ya=span?HY[i]-1.2:-.3,yb=span?HY[j]-1.2:-.3;
   quad([ax,ya,az],[bx,yb,bz],[bx,HY[j],bz],[ax,HY[i],az],u0,u1,(HY[i]-ya)/4)}
  if(HY[i]>3){const o=WALL+.45;
   quad([P[i].x-R[i].x*o,HY[i]-1.2,P[i].z-R[i].z*o],[P[j].x-R[j].x*o,HY[j]-1.2,P[j].z-R[j].z*o],[P[j].x+R[j].x*o,HY[j]-1.2,P[j].z+R[j].z*o],[P[i].x+R[i].x*o,HY[i]-1.2,P[i].z+R[i].z*o],u0,u1,6,true)}}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
 // walls take the concrete texture; the deck underside is plain (the texture's streaks read as tyre marks up there)
 g.setIndex([...idx,...deck]);g.addGroup(0,idx.length,0);g.addGroup(idx.length,deck.length,1);g.computeVertexNormals();
 const m=new THREE.Mesh(g,[new THREE.MeshStandardMaterial({map:concreteTex,roughness:.92,side:THREE.DoubleSide}),new THREE.MeshStandardMaterial({color:0x8a8c8e,roughness:1,side:THREE.DoubleSide})]);m.castShadow=m.receiveShadow=true;scene.add(m);
}

}
building=true;buildTexN=0;buildCircuit();

// scenery: trees, buildings, mountains
const windowMats=[];
const antennaMat=new THREE.MeshStandardMaterial({color:0x330000,emissive:0xff2020,emissiveIntensity:0});
const _yAxis=new THREE.Vector3(0,1,0);
function farFromTrack(x,z,min){for(let i=0;i<N;i+=4){if((P[i].x-x)**2+(P[i].z-z)**2<min*min)return false}return true}
// sway instanced foliage with the wind clock (shadows stay still, which nobody notices)
function addSway(mat,amp){
 mat.onBeforeCompile=sh=>{sh.uniforms.uWind=wind;sh.uniforms.uAmp={value:amp};
  sh.vertexShader='uniform float uWind,uAmp;\n'+sh.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
   #ifdef USE_INSTANCING
   float ph=instanceMatrix[3].x*.21+instanceMatrix[3].z*.17;
   #else
   float ph=0.;
   #endif
   transformed.x+=sin(uWind*1.7+ph+position.y*.35)*uAmp*position.y;transformed.z+=cos(uWind*1.3+ph)*uAmp*.6*position.y;`)};
 return mat;
}
// quads -> geometry. each quad: {c:[4 corners], n: shading normal}; uv runs (0,0)(1,0)(1,1)(0,1)
const QUV=[[0,0],[1,0],[1,1],[0,1]];
function quadGeo(quads){
 const pos=[],nor=[],uv=[];
 const col=[];
 for(const q of quads)for(const i of [0,1,2,0,2,3]){const c=q.c[i];pos.push(c.x,c.y,c.z);nor.push(q.n.x,q.n.y,q.n.z);uv.push(...QUV[i]);const k=q.ao?q.ao[i]:1;col.push(k,k,k)}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
 g.setAttribute('color',new THREE.Float32BufferAttribute(col,3));
 return g;
}
const V3=(x,y,z)=>new THREE.Vector3(x,y,z);
function mergeGeos(list){
 const parts=list.map(g=>g.index?g.toNonIndexed():g);let n=0;parts.forEach(g=>n+=g.attributes.position.count);
 const pos=new Float32Array(n*3),nor=new Float32Array(n*3),uv=new Float32Array(n*2);let o=0;
 for(const g of parts){pos.set(g.attributes.position.array,o*3);nor.set(g.attributes.normal.array,o*3);uv.set(g.attributes.uv.array,o*2);o+=g.attributes.position.count}
 const m=new THREE.BufferGeometry();
 m.setAttribute('position',new THREE.BufferAttribute(pos,3));m.setAttribute('normal',new THREE.BufferAttribute(nor,3));m.setAttribute('uv',new THREE.BufferAttribute(uv,2));
 return m;
}
// pushes vertices in and out with noise so crowns aren't perfect shapes
function lumpy(geo,amount,freq,seed,radialOnly){
 const p=geo.attributes.position;
 for(let i=0;i<p.count;i++){const x=p.getX(i),y=p.getY(i),z=p.getZ(i),k=1+(fbm(x*freq+seed,(y+z)*freq+seed*.37,3)-.5)*amount;
  p.setXYZ(i,x*k,radialOnly?y:y*k,z*k)}
 geo.computeVertexNormals();return geo;
}
function buildScenery(){
const scene=trackGroup;
// trees: crowns built from alpha-tested leaf/branch cards (the usual game approach), trunks with branches
{
 const leafCardTex=keepCoverage(canvasTex(256,256,(g,w,h)=>{
  g.lineCap='round';const twigs=[];
  for(let i=0;i<5;i++){const x0=rand(60,196),y0=rand(170,236),x1=clamp(x0+rand(-70,70),30,226),y1=y0-rand(90,140);twigs.push([x0,y0,x1,y1]);
   g.strokeStyle='#4a3626';g.lineWidth=rand(1.5,3);g.beginPath();g.moveTo(x0,y0);g.quadraticCurveTo((x0+x1)/2+rand(-20,20),(y0+y1)/2,x1,y1);g.stroke()}
  for(let i=0;i<420;i++){const [x0,y0,x1,y1]=twigs[i%5],t=Math.random(),L=rand(6,12);
   // leaves on the sunny top of the card are lighter and yellower, the ones underneath bluer and darker
   const x=clamp(lerp(x0,x1,t)+rand(-24,24),L+2,w-L-2),y=clamp(lerp(y0,y1,t)+rand(-24,24),L+2,h-L-2),up=1-y/h,hue=rand(78,108)-up*10,l=rand(12,26)+up*14+(Math.random()<.08?10:0);
   g.save();g.translate(x,y);g.rotate(rand(0,Math.PI*2));
   const gr=g.createLinearGradient(0,-L*.45,0,L*.45);gr.addColorStop(0,`hsl(${hue},40%,${l+11}%)`);gr.addColorStop(1,`hsl(${hue},46%,${l-5}%)`);
   g.fillStyle=gr;g.beginPath();g.moveTo(-L,0);g.quadraticCurveTo(0,-L*.55,L,0);g.quadraticCurveTo(0,L*.55,-L,0);g.fill();
   g.strokeStyle=`hsla(${hue},40%,${l+20}%,.55)`;g.lineWidth=.8;g.beginPath();g.moveTo(-L*.85,0);g.lineTo(L*.85,0);g.stroke();g.restore()}
 },false));
 const pineCardTex=keepCoverage(canvasTex(256,128,(g,w,h)=>{
  g.strokeStyle='#3d2c1e';g.lineWidth=3;g.beginPath();g.moveTo(0,h/2);g.quadraticCurveTo(w*.5,h/2+6,w-8,h/2-4);g.stroke();
  for(let i=0;i<60;i++){const t=i/60,x=t*(w-14)+rand(-4,4),r=lerp(34,8,t)*rand(.75,1);
   g.fillStyle=`hsl(${rand(105,130)},${rand(28,40)}%,${rand(10,17)}%)`;g.beginPath();g.ellipse(x,h/2+3*Math.sin(t*3)+rand(-3,5),r*.8,r*rand(.55,.8),rand(-.3,.3),0,7);g.fill()}
  for(let i=0;i<2200;i++){const t=Math.random(),x=t*(w-12),y=h/2+3*Math.sin(t*3),L=lerp(46,10,t)*rand(.6,1),sd=Math.random()<.5?-1:1,a=sd*rand(.5,1.1)-.25;
   g.strokeStyle=`hsl(${rand(95,130)},${rand(25,42)}%,${rand(12,30)}%)`;g.lineWidth=rand(1.2,2.2);
   g.beginPath();g.moveTo(x,y);g.lineTo(x+Math.cos(a)*L*.6,y+Math.sin(a)*L);g.stroke()}
 },false));
 const barkTex=canvasTex(64,256,(g,w,h)=>{
  paintPixels(g,w,h,(x,y)=>{const n=fbm(x/3,y/40,3,21.33),v=46+50*n;return [v+14,v+4,v-6]});
  g.strokeStyle='rgba(20,14,10,.55)';for(let i=0;i<40;i++){const x=rand(0,w);g.lineWidth=rand(.6,1.6);g.beginPath();g.moveTo(x,0);g.bezierCurveTo(x+rand(-4,4),h*.3,x+rand(-4,4),h*.7,x+rand(-3,3),h);g.stroke()}
 });
 const birchTex=canvasTex(64,256,(g,w,h)=>{
  paintPixels(g,w,h,(x,y)=>{const v=200+(fbm(x/6,y/20,3,10.67)-.5)*40;return [v,v-3,v-10]});
  for(let i=0;i<70;i++){g.fillStyle=`rgba(30,26,24,${rand(.5,.9)})`;g.fillRect(rand(-8,w),rand(0,h),rand(4,22),rand(1,3.5))}
  g.fillStyle='rgba(40,34,30,.8)';for(let i=0;i<8;i++){g.beginPath();g.ellipse(rand(0,w),rand(0,h),rand(3,6),rand(2,4),0,0,7);g.fill()}
 });
 const up=V3(0,1,0),tmpQ=new THREE.Quaternion();
 function branchGeo(from,dir,len,r0,r1){const d=dir.clone().normalize();
  return new THREE.CylinderGeometry(r1,r0,len,5).applyQuaternion(tmpQ.setFromUnitVectors(up,d)).translate(from.x+d.x*len/2,from.y+d.y*len/2,from.z+d.z*len/2)}
 // crown = a handful of leaf clumps inside an ellipsoid, so the outline is lumpy with gaps like a real tree
 function broadleaf(shape={}){
  const {cyR=[5.8,6.8],rxR=[2.6,3.3],ryR=[2.1,2.7],cards=150,clumps=7,cs:cardS=1}=shape;
  const cy=rand(...cyR),rx=rand(...rxR),ry=rand(...ryR),cen=V3(0,cy,0),quads=[];
  const lumps=[];for(let i=0;i<clumps;i++){const d=V3(rand(-1,1),rand(-.5,1),rand(-1,1)).normalize(),r=rand(.45,.8);lumps.push([V3(d.x*rx*r,cy+d.y*ry*r,d.z*rx*r),rand(.38,.55)])}
  lumps.push([V3(0,cy+ry*.3,0),.6]);
  for(let i=0;i<cards;i++){
   const [lc,lr]=lumps[i%lumps.length],d=V3(rand(-1,1),rand(-.8,1),rand(-1,1)).normalize(),r=Math.pow(Math.random(),.45);
   const p=V3(lc.x+d.x*rx*lr*r,lc.y+d.y*ry*lr*r,lc.z+d.z*rx*lr*r),n=V3(rand(-1,1),rand(-1,1),rand(-1,1)).normalize();
   const t=new THREE.Vector3().crossVectors(Math.abs(n.y)>.9?V3(1,0,0):up,n).normalize(),b=new THREE.Vector3().crossVectors(n,t),s=rand(.75,1.15)*cardS;
   const cs=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([a,c])=>p.clone().addScaledVector(t,a*s).addScaledVector(b,c*s));
   // leaves deep inside and underneath the crown get less light
   const ao=cs.map(v=>{const d=Math.hypot(v.x/rx,(v.y-cy)/ry,v.z/rx);return clamp(.35+.65*smooth(.2,1,d),.3,1)*(v.y<cy-ry*.3?.8:1)});
   quads.push({c:cs,ao,n:p.clone().sub(cen).normalize().add(V3(0,.4,0)).normalize()})}
  const tr=shape.trunk||1,parts=[new THREE.CylinderGeometry(.2*tr,.4*tr,cy,8).translate(0,cy/2,0)];
  for(const [lc] of lumps){const from=V3(0,cy*rand(.45,.7),0),dir=lc.clone().sub(from);parts.push(branchGeo(from,dir,dir.length()*.85,.13*tr,.05))}
  return {crown:quadGeo(quads),trunk:mergeGeos(parts),bark:shape.bark};
 }
 function pine(){
  const H=rand(9,11.5),tiers=13,quads=[];
  for(let k=0;k<tiers;k++){const y=1.8+k*(H-2.6)/tiers,R=lerp(3.3,.55,k/(tiers-1))*rand(.85,1.1),n=k<tiers-3?8:5;
   for(let j=0;j<n;j++){const a=j/n*Math.PI*2+k*.9+rand(-.2,.2),dir=V3(Math.cos(a),0,Math.sin(a)),side=V3(-Math.sin(a),0,Math.cos(a)),w=lerp(1.6,.7,k/tiers),droop=R*rand(.22,.38);
    const base=dir.clone().multiplyScalar(.12).setY(y),tip=dir.clone().multiplyScalar(R).setY(y-droop);
    const lo=lerp(.38,.6,k/tiers);
    const n0=dir.clone().multiplyScalar(.6).add(up).normalize();
    quads.push({c:[base.clone().addScaledVector(side,-w*.2),tip.clone().addScaledVector(side,-w*.5),tip.clone().addScaledVector(side,w*.5),base.clone().addScaledVector(side,w*.2)],ao:[lo,1,1,lo],n:n0});
    // and an upright one along the same branch, or the tree is paper thin when seen from the road
    quads.push({c:[base.clone().addScaledVector(up,-w*.15),tip.clone().addScaledVector(up,-w*.35),tip.clone().addScaledVector(up,w*.35),base.clone().addScaledVector(up,w*.15)],ao:[lo,.9,1,lo],n:n0})}}
  for(let j=0;j<3;j++){const a=j/3*Math.PI,side=V3(Math.cos(a),0,Math.sin(a));
   quads.push({c:[V3(0,H-2.2,0).addScaledVector(side,-.5),V3(0,H+.4,0).addScaledVector(side,-.15),V3(0,H+.4,0).addScaledVector(side,.15),V3(0,H-2.2,0).addScaledVector(side,.5)],n:up})}
  return {crown:quadGeo(quads),trunk:new THREE.CylinderGeometry(.1,.32,H,7).translate(0,H/2,0)};
 }
 const barkMat=new THREE.MeshStandardMaterial({map:barkTex,roughness:1}),birchMat=new THREE.MeshStandardMaterial({map:birchTex,roughness:.9});
 const leafMat=addSway(new THREE.MeshStandardMaterial({map:leafCardTex,vertexColors:true,alphaTest:.45,alphaToCoverage:true,side:THREE.DoubleSide,roughness:.85}),.006);
 const needleMat=addSway(new THREE.MeshStandardMaterial({map:pineCardTex,vertexColors:true,alphaTest:.45,alphaToCoverage:true,side:THREE.DoubleSide,roughness:.9}),.004);
 const CAP=HIGH?620:330;
 const birch={cyR:[6.5,7.5],rxR:[1.7,2.1],ryR:[2.6,3.1],cards:120,clumps:6,cs:.85,trunk:.6,bark:birchMat},
  poplar={cyR:[7.5,8.5],rxR:[1.3,1.6],ryR:[4.2,4.8],cards:150,clumps:8,cs:.85,trunk:.75};
 const kinds=[[broadleaf(),leafMat],[broadleaf({rxR:[3.2,3.8],ryR:[2.4,2.9],cards:190,clumps:9}),leafMat],[broadleaf(birch),leafMat],[broadleaf(poplar),leafMat],[pine(),needleMat],[pine(),needleMat]].map(([g,mat])=>
  ({trunk:new THREE.InstancedMesh(g.trunk,g.bark||barkMat,CAP),crown:new THREE.InstancedMesh(g.crown,mat,CAP),n:0,pine:mat===needleMat}));
 const m=new THREE.Matrix4(),q=new THREE.Quaternion(),v=new THREE.Vector3(),sc=new THREE.Vector3(),c=new THREE.Color();
 let tries=0,placed=0;
 while(placed<(HIGH?2900:1500)&&tries<80000){tries++;
  // half the tries go into the first 120 m beside the circuit, where you actually see trees
  let x,z;if(tries%2){const p=trackAt(rand(0,L),(Math.random()<.5?-1:1)*(WALL+rand(14,120)));x=p.x;z=p.z}else{x=rand(-900,900);z=rand(-800,800)}
  if(fbm(x/80+2,z/80+7,3)<.5&&Math.random()>.15)continue;const d=trackDist(x,z);if(d<WALL+RUNOFF+5||inPitArea(x,z))continue;
  const pineZone=fbm(x/120+11,z/120+4,2)>.5,options=kinds.filter(k=>k.pine===pineZone&&k.n<CAP);if(!options.length)continue;
  const t=options[Math.random()*options.length|0],s=rand(.75,1.35);
  q.setFromAxisAngle(_yAxis,rand(0,6.28));m.compose(v.set(x,terrainH(x,z,d)-.15,z),q,sc.set(s,s*rand(.9,1.15),s));
  t.trunk.setMatrixAt(t.n,m);t.crown.setMatrixAt(t.n,m);
  t.crown.setColorAt(t.n,c.setHSL(rand(.18,.32),rand(.15,.35),rand(.82,1)));t.n++;placed++}
 // bushes along the fence: small leaf crowns without trunks
 const bush=new THREE.InstancedMesh(kinds[0].crown.geometry,leafMat,800);let nb=0;
 for(let i=0;i<8000&&nb<800;i++){const s0=rand(0,L),sd=Math.random()<.5?-1:1,p=trackAt(s0,sd*(wallAtS(s0,sd)+rand(3,22)));
  if(trackDist(p.x,p.z)<WALL+2.5||inPitArea(p.x,p.z))continue;const s=rand(.28,.45);
  q.setFromAxisAngle(_yAxis,rand(0,6.28));m.compose(v.set(p.x,terrainH(p.x,p.z)-6*s*.75,p.z),q,sc.set(s*1.3,s,s*1.3));bush.setMatrixAt(nb,m);bush.setColorAt(nb,c.setHSL(rand(.2,.3),.3,rand(.8,1)));nb++}
 bush.count=nb;bush.castShadow=true;bush.layers.set(1);noAO.push(bush);scene.add(bush);
 for(const t of kinds){t.trunk.count=t.crown.count=t.n;t.trunk.castShadow=t.crown.castShadow=true;t.crown.receiveShadow=true;noAO.push(t.crown);scene.add(t.trunk,t.crown)}
}
// 3D grass tufts and wildflowers on the verges: crossed quads with shading normals pointing up
{
 const tuftTex=keepCoverage(canvasTex(128,128,(g,w,h)=>{
  for(let i=0;i<110;i++){const x=rand(8,120),top=h*rand(.05,.55),lean=rand(-26,26),wd=rand(1,2.4),dry=Math.random()<.12,hue=dry?rand(45,58):rand(72,100),l=dry?rand(48,62):rand(28,44);
   const gr=g.createLinearGradient(0,h,0,top);gr.addColorStop(0,`hsl(${hue},${dry?25:40}%,${l*.7}%)`);gr.addColorStop(1,`hsl(${hue},${dry?35:45}%,${l}%)`);g.fillStyle=gr;g.beginPath();g.moveTo(x-wd,h);g.quadraticCurveTo(x+lean*.3,(h+top)/2,x+lean,top);g.quadraticCurveTo(x+lean*.3+wd*.4,(h+top)/2,x+wd,h);g.fill()}
 },false));
 const flowerTex=keepCoverage(canvasTex(128,128,(g,w,h)=>{
  for(let i=0;i<14;i++){const x=rand(14,114),top=h*rand(.25,.6);g.strokeStyle='#3d6a2a';g.lineWidth=1.6;g.beginPath();g.moveTo(x,h);g.quadraticCurveTo(x+rand(-8,8),(h+top)/2,x+rand(-6,6),top);g.stroke();
   g.fillStyle=['#f4f1e8','#f6d33c','#b07ce0','#e86a8a'][i%4];for(let p=0;p<5;p++){const a=p/5*Math.PI*2;g.beginPath();g.ellipse(x+Math.cos(a)*4,top+Math.sin(a)*4,3.2,2,a,0,7);g.fill()}
   g.fillStyle='#e8a020';g.beginPath();g.arc(x,top,2,0,7);g.fill()}
 },false));
 const cross=(()=>{const a=new THREE.PlaneGeometry(1,1).translate(0,.5,0),b=a.clone().rotateY(Math.PI/2);const g=mergeGeos([a,b]);
  const n=g.attributes.normal,p=g.attributes.position,col=[];for(let i=0;i<n.count;i++){n.setXYZ(i,0,1,0);const k=.62+.38*p.getY(i);col.push(k,k,k)}
  g.setAttribute('color',new THREE.Float32BufferAttribute(col,3));return g})();
 const scatter=(tex,count,minS,maxS,amp)=>{
  const mat=addSway(new THREE.MeshStandardMaterial({map:tex,vertexColors:true,alphaTest:.5,alphaToCoverage:true,side:THREE.DoubleSide,roughness:1}),amp);
  const im=new THREE.InstancedMesh(cross,mat,count),m=new THREE.Matrix4(),q=new THREE.Quaternion(),v=new THREE.Vector3(),sc=new THREE.Vector3(),c=new THREE.Color();
  let n=0;
  for(let i=0;i<count*3&&n<count;i++){const s0=rand(0,L),sd=Math.random()<.5?-1:1,p=trackAt(s0,sd*(wallAtS(s0,sd)+1+Math.pow(Math.random(),1.6)*70));
   if(trackDist(p.x,p.z)<WALL+1||inPitArea(p.x,p.z))continue;if(sd>0&&pitRel(s0)>-125&&pitRel(s0)<85)continue; // keep the grandstand clear
   const s=rand(minS,maxS);q.setFromAxisAngle(_yAxis,rand(0,6.28));m.compose(v.set(p.x,terrainH(p.x,p.z)-.04,p.z),q,sc.set(s*rand(1,1.6),s,s*rand(1,1.6)));
   im.setMatrixAt(n,m);im.setColorAt(n,c.setHSL(rand(.2,.3),rand(.1,.3),rand(.8,1)));n++}
  im.count=n;im.receiveShadow=true;im.layers.set(1);noAO.push(im);scene.add(im);
 };
 scatter(tuftTex,HIGH?70000:16000,.35,.9,.05);
 scatter(flowerTex,HIGH?7000:1500,.3,.5,.06);
}
// buildings: three facade styles drawn once; per-building variety comes from UV scaling/offsets
windowMats.length=0;
{
 const FW=256,FH=384; // one tile = 4 bays x 6 floors = 14m x 21m
 function facade(style){
  const lit=[],bays=4,floors=6,bw=FW/bays,fh=FH/floors;
  for(let i=0;i<bays*floors*2;i++)lit.push(Math.random()<.38?(Math.random()<.7?'#ffd9a0':'#d6ecff'):null);
  const draw=(g,pass)=>{ // pass 0 colour, 1 emissive, 2 roughness, 3 height (for the normal map)
   if(pass===3){g.fillStyle='#b4b4b4';g.fillRect(0,0,FW,FH);if(style==='brick')for(let y=0;y<FH;y+=6){g.fillStyle='#8a8a8a';g.fillRect(0,y,FW,1)}}
   else if(pass===0){
    if(style==='glass')paintPixels(g,FW,FH,(x,y)=>{const v=(fbm(x/40,y/40,3)-.5)*20;return [60+v+y/FH*30,80+v+y/FH*34,100+v+y/FH*36]});
    else if(style==='brick')paintPixels(g,FW,FH,(x,y)=>{const row=y/6|0,off=row%2?7:0,mort=y%6===0||(x+off)%14===0,
     n=(hash2((x+off)/14|0,row)-.5)*44+(hash2(x,y)-.5)*12,soot=smooth(.55,.85,fbm(x/30,y/50,3))*24;return mort?[158,152,144]:[124+n-soot,72+n*.55-soot,58+n*.45-soot]});
    else if(style==='ribbon')paintPixels(g,FW,FH,(x,y)=>{const v=196+(fbm(x/20,y/20,3)-.5)*22+(hash2(x,y)-.5)*8;return [v,v-3,v-9]});
    else paintPixels(g,FW,FH,(x,y)=>{const v=176+(fbm(x/30,y/60,4)-.5)*40-smooth(.6,1,fbm(x/6,y/90,2))*30;return [v,v-2,v-6]});
   }else g.fillStyle=pass===1?'#000':(style==='brick'?'#f0f0f0':style==='glass'?'#707070':style==='ribbon'?'#c8c8c8':'#e6e6e6'),g.fillRect(0,0,FW,FH);
   for(let f=0;f<floors;f++)for(let b=0;b<bays;b++){
    const x=b*bw,y=f*fh,L=lit[(f*bays+b)*2],L2=lit[(f*bays+b)*2+1];
    if(style==='ribbon'){
     const py=y+fh*.18,ph=fh*.5;
     if(b===0){
      if(pass===3){g.fillStyle='#ffffff';g.fillRect(0,py-3,FW,ph+6);g.fillStyle='#303030';g.fillRect(0,py,FW,ph)}
      else if(pass===0){const gr=g.createLinearGradient(0,py,0,py+ph);gr.addColorStop(0,'#5b7186');gr.addColorStop(.6,'#9db4c6');gr.addColorStop(1,'#34475a');g.fillStyle=gr;g.fillRect(0,py,FW,ph);
       g.fillStyle='#d9dad6';g.fillRect(0,py+ph,FW,3)}
      else if(pass===2){g.fillStyle='#161616';g.fillRect(0,py,FW,ph)}}
     if(pass===0){g.fillStyle='#4a4f55';for(let k=0;k<3;k++)g.fillRect(x+k*bw/3,py,2,ph);
      if(hash2(f,b+21)<.35){g.fillStyle='rgba(225,224,218,.6)';g.fillRect(x+2,py,bw-2,ph*hash2(b+3,f)*.8)}}
     else if(pass===1&&L){g.fillStyle=L;g.fillRect(x+2,py,bw-2,ph)}
    }else if(style==='glass'){
     // two panes per bay, mullions, dark spandrel at the slab
     for(let k=0;k<2;k++){const px=x+3+k*bw/2,pw=bw/2-6,py=y+4,ph=fh*.74,on=k?L2:L;
      if(pass===3){g.fillStyle='#ffffff';g.fillRect(px-2,py-2,pw+4,ph+4);g.fillStyle='#3a3a3a';g.fillRect(px,py,pw,ph)}
      else if(pass===0){const t=hash2(f*5+b*2+k,77)*.25,gr=g.createLinearGradient(px,py,px+pw,py+ph);gr.addColorStop(0,`rgb(${61-t*40},${90-t*40},${120-t*30})`);gr.addColorStop(.5,`rgb(${143-t*60},${177-t*60},${204-t*50})`);gr.addColorStop(1,'#2b3f55');g.fillStyle=gr;g.fillRect(px,py,pw,ph);
       if(hash2(f+k*3,b+50)<.25){g.fillStyle='rgba(220,220,214,.55)';g.fillRect(px,py,pw,ph*hash2(b,f+k)*.7)}}
      else if(pass===1){if(on){g.fillStyle=on;g.fillRect(px,py,pw,ph)}}
      else if(pass===2){g.fillStyle='#181818';g.fillRect(px,py,pw,ph)}}
     if(pass===3){g.fillStyle='#e0e0e0';g.fillRect(x,y+fh*.8,bw,fh*.2)}
     if(pass===0){g.fillStyle='#2e3238';g.fillRect(x,y+fh*.8,bw,fh*.2);g.fillStyle='#a9b1ba';g.fillRect(x,y,2,fh);g.fillRect(x,y+fh*.8,bw,2)}
    }else{
     const wx=x+bw*.2,ww=bw*.6,wy=y+fh*.2,wh=fh*(style==='brick'?.55:.45);
     if(pass===3){g.fillStyle='#ffffff';g.fillRect(wx-4,wy-4,ww+8,wh+8);g.fillStyle='#1e1e1e';g.fillRect(wx,wy,ww,wh);g.fillStyle='#d8d8d8';g.fillRect(wx-6,wy+wh+3,ww+12,4)}
     else if(pass===0){g.fillStyle=style==='brick'?'#e8e4dc':'#5c6168';g.fillRect(wx-3,wy-3,ww+6,wh+6);
      const gr=g.createLinearGradient(wx,wy,wx+ww,wy+wh);gr.addColorStop(0,'#2a3644');gr.addColorStop(.55,'#6d8396');gr.addColorStop(1,'#222c37');g.fillStyle=gr;g.fillRect(wx,wy,ww,wh);
      const r=hash2(f*7+b,style.length*13);
      if(r<.3){g.fillStyle='rgba(218,214,204,.85)';const bh=wh*hash2(b,f+40)*.8;g.fillRect(wx,wy,ww,bh);g.fillStyle='rgba(0,0,0,.12)';for(let yy=wy+3;yy<wy+bh;yy+=4)g.fillRect(wx,yy,ww,1)}
      else if(r<.5){g.fillStyle=`hsla(${hash2(f,b+9)*60|0},35%,58%,.8)`;g.fillRect(wx,wy,ww*.22,wh);g.fillRect(wx+ww*.78,wy,ww*.22,wh)}
      else if(r<.6){g.fillStyle='rgba(20,22,26,.6)';g.fillRect(wx,wy,ww,wh)}
      g.fillStyle=style==='brick'?'#e8e4dc':'#5c6168';g.fillRect(wx+ww/2-1,wy,2,wh);g.fillStyle='#00000040';g.fillRect(wx-4,wy+wh+3,ww+8,3);
      if(style!=='brick'){const sg=g.createLinearGradient(0,wy+wh+6,0,wy+wh+fh*.45);sg.addColorStop(0,'rgba(60,58,54,.28)');sg.addColorStop(1,'rgba(60,58,54,0)');g.fillStyle=sg;g.fillRect(wx-2,wy+wh+6,ww+4,fh*.45)}}
     else if(pass===1){if(L){g.fillStyle=L;g.fillRect(wx,wy,ww,wh)}}
     else if(pass===2){g.fillStyle='#1c1c1c';g.fillRect(wx,wy,ww,wh)}
    }
   }
  };
  const map=canvasTex(FW,FH,g=>draw(g,0)),emi=canvasTex(FW,FH,g=>draw(g,1)),rough=dataTex(canvasTex(FW,FH,g=>draw(g,2)));
  const hc=document.createElement('canvas');hc.width=FW;hc.height=FH;draw(hc.getContext('2d'),3);
  const mat=new THREE.MeshStandardMaterial({map,roughnessMap:rough,roughness:1,normalMap:heightToNormal(hc,3),metalness:style==='glass'?.35:.05,emissive:0xffffff,emissiveMap:emi,emissiveIntensity:0});
  windowMats.push(mat);return mat;
 }
 const styles=['glass','brick','concrete','ribbon'].map(facade);
 // tinted variants share the textures: bronze glass, warm render, yellow brick, sandstone office, cool grey concrete
 for(const [i,col] of [[0,0xb59c7a],[2,0xf0dcc2],[1,0xe8c9a0],[3,0xe9dcc4],[2,0xc4cad2],[1,0xbfa9a0]]){const m=styles[i].clone();m.color.set(col);windowMats.push(m);styles.push(m)}
 // shop fronts for the ground floor: one tile = 4 shops, 14m x 4.5m
 const SHOPS=['CAFE','MARKET','PIZZA','BAKERY','PHARMACY','SPORTS','BOOKS','BAR','SUSHI','FLOWERS','TECH','GYM','DINER','HOTEL','SHOES','BANK'];
 const shopMats=[0,1].map(v=>{
  const shops=[0,1,2,3].map(i=>({name:SHOPS[v*8+i*2+(Math.random()<.5?0:1)],hue:rand(0,360)|0}));
  const draw=(g,w,h,pass)=>{
   g.fillStyle=pass===0?'#55595f':pass===1?'#000':'#d0d0d0';g.fillRect(0,0,w,h);
   shops.forEach((sh,b)=>{const x=b*w/4,bw=w/4;
    if(pass===0){
     g.fillStyle=`hsl(${sh.hue},55%,32%)`;g.fillRect(x+4,4,bw-8,h*.2);
     g.fillStyle='#fff';g.font=`bold ${h*.13|0}px Arial`;g.textAlign='center';g.textBaseline='middle';g.fillText(sh.name,x+bw/2,4+h*.1,bw-16);
     const gr=g.createLinearGradient(0,h*.3,0,h*.95);gr.addColorStop(0,'#3a4450');gr.addColorStop(.5,'#8a7a62');gr.addColorStop(1,'#2a2622');g.fillStyle=gr;g.fillRect(x+8,h*.3,bw-16,h*.65);
     g.fillStyle='#22262b';g.fillRect(x+bw/2-10,h*.42,20,h*.53);g.fillStyle='#8a8f96';g.fillRect(x,0,4,h);
    }else if(pass===1){g.fillStyle=`hsl(${sh.hue},90%,60%)`;g.fillRect(x+4,4,bw-8,h*.2);g.fillStyle='rgba(255,214,160,.75)';g.fillRect(x+8,h*.3,bw-16,h*.65)}
    else{g.fillStyle='#202020';g.fillRect(x+8,h*.3,bw-16,h*.65)}
   });
  };
  const mat=new THREE.MeshStandardMaterial({map:canvasTex(512,164,(g,w,h)=>draw(g,w,h,0)),emissive:0xffffff,emissiveMap:canvasTex(512,164,(g,w,h)=>draw(g,w,h,1)),
   roughnessMap:dataTex(canvasTex(512,164,(g,w,h)=>draw(g,w,h,2))),roughness:1,metalness:.1,emissiveIntensity:0});
  windowMats.push(mat);return mat;
 });
 const roofTex=canvasTex(128,128,(g,w,h)=>paintPixels(g,w,h,(x,y)=>{const v=70+(hash2(x,y)-.5)*30+(fbm(x/20,y/20,3,6.4)-.5)*20;return [v,v,v+2]}));
 const roofMat=new THREE.MeshStandardMaterial({map:roofTex,roughness:1});
 const unitMat=new THREE.MeshStandardMaterial({color:0x9aa1a8,roughness:.6,metalness:.3});
 const cornMat=new THREE.MeshStandardMaterial({color:0xb4b8bc,roughness:.85}),tankMat=new THREE.MeshStandardMaterial({color:0x6e4c34,roughness:.9});
 // box with UVs scaled so one texture tile covers tw x th metres on the sides (and 8m on the roof)
 function facadeBox(w,h,d,mat,tw,th){
  const geo=new THREE.BoxGeometry(w,h,d),uv=geo.attributes.uv,ox=Math.random(),oy=Math.random();
  for(let f=0;f<6;f++){const side=f<2||f>3,su=f<2?d/tw:f<4?w/8:w/tw,sv=side?h/th:d/8;
   for(let i=f*4;i<f*4+4;i++)uv.setXY(i,uv.getX(i)*su+(side?ox:0),uv.getY(i)*sv+(side?oy:0))}
  return new THREE.Mesh(geo,[mat,mat,roofMat,roofMat,mat,mat]);
 }
 const addAt=(grp,mesh,x,y,z)=>{mesh.position.set(x,y,z);grp.add(mesh);return mesh};
 // the city sits in three districts around the circuit, on a rough street grid, tallest in the middle
 const DISTRICTS=[[150,-760,330],[-820,-420,260],[880,420,250]],lots=[];
 for(let k=0;k<120;k++){let x,z,t=0,dc;do{const D=DISTRICTS[k%3],r=Math.pow(Math.random(),.7)*D[2],a=rand(0,Math.PI*2);
   x=Math.round((D[0]+Math.cos(a)*r)/34)*34+rand(-3,3);z=Math.round((D[1]+Math.sin(a)*r)/34)*34+rand(-3,3);dc=r/D[2];t++}
  while((!farFromTrack(x,z,70)||lots.some(([lx,lz])=>Math.abs(lx-x)<30&&Math.abs(lz-z)<30))&&t<80);
  if(t>=80)continue;lots.push([x,z]);
  const w=rand(14,26),d=rand(14,26),h=rand(16,40)+(1-dc)*rand(10,70),st=styles[k%styles.length],grp=new THREE.Group();
  grp.position.set(x,terrainH(x,z)-2,z);grp.rotation.y=(Math.random()<.5?0:Math.PI/2)+rand(-.04,.04);scene.add(grp);
  let y=0;
  if(h<70&&Math.random()<.65){addAt(grp,facadeBox(w+.6,4.5,d+.6,shopMats[k%2],14,4.5),0,2.25,0);y=4.5}
  addAt(grp,facadeBox(w,h,d,st,14,21),0,y+h/2,0);y+=h;
  addAt(grp,new THREE.Mesh(new THREE.BoxGeometry(w+.5,.7,d+.5),cornMat),0,y+.35,0);y+=.7;
  let tw=w,td=d;
  if(h>48&&Math.random()<.55){tw=w*rand(.5,.7);td=d*rand(.5,.7);const h2=h*rand(.2,.35);
   addAt(grp,facadeBox(tw,h2,td,st,14,21),0,y+h2/2,0);y+=h2;addAt(grp,new THREE.Mesh(new THREE.BoxGeometry(tw+.4,.6,td+.4),cornMat),0,y+.3,0);y+=.6}
  for(let u=0,n=1+(Math.random()*3|0);u<n;u++){const s=rand(1.5,3.5);addAt(grp,new THREE.Mesh(new THREE.BoxGeometry(s,rand(1,2),s*rand(.8,1.5)),unitMat),rand(-tw/2+2.5,tw/2-2.5),y+.7,rand(-td/2+2.5,td/2-2.5))}
  if((st===styles[1]||st===styles[6]||st===styles[9])&&Math.random()<.7){const tx=rand(-tw/4,tw/4),tz=rand(-td/4,td/4);
   addAt(grp,new THREE.Mesh(new THREE.CylinderGeometry(1.6,1.6,2.6,14),tankMat),tx,y+3.1,tz);
   addAt(grp,new THREE.Mesh(new THREE.ConeGeometry(1.75,.8,14),tankMat),tx,y+4.8,tz);
   for(const [lx,lz] of [[-1,-1],[1,-1],[1,1],[-1,1]])addAt(grp,new THREE.Mesh(new THREE.CylinderGeometry(.08,.08,1.8,5),unitMat),tx+lx*1.1,y+.9,tz+lz*1.1)}
  if(y>58){addAt(grp,new THREE.Mesh(new THREE.CylinderGeometry(.08,.14,9,6),unitMat),tw*.2,y+4.5,td*.2);addAt(grp,new THREE.Mesh(new THREE.SphereGeometry(.35,8,6),antennaMat),tw*.2,y+9.1,td*.2)}
 }
}
}
buildScenery();building=false;
 // mountain range all around: ridged noise, grass -> rock -> snow by height, hazed by the fog
{const segA=200,segR=34,pos=[],col=[],idx=[],c=new THREE.Color(),green=new THREE.Color(0x4a6239),rock=new THREE.Color(0x7a746b),snowC=new THREE.Color(0xf1f4f7);
 for(let jr=0;jr<=segR;jr++)for(let ia=0;ia<=segA;ia++){
  const a=ia/segA*Math.PI*2,r=lerp(1300,2050,jr/segR),x=Math.cos(a)*r,z=Math.sin(a)*r;
  const ridge=1-Math.abs(fbm(x/240+40,z/240,5)*2-1),y=Math.pow(ridge,1.8)*fbm(x/520,z/520,3)*300*smooth(1300,1600,r)-12;
  const slope=fbm(x/60,z/60,2),snowLine=120+slope*45;
  c.copy(green).lerp(rock,smooth(30,110,y+slope*30)).lerp(snowC,smooth(snowLine,snowLine+40,y));
  pos.push(x,y,z);col.push(c.r,c.g,c.b);
  if(ia<segA&&jr<segR){const q=jr*(segA+1)+ia,row=segA+1;idx.push(q,q+1,q+row,q+1,q+row+1,q+row)}}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('color',new THREE.Float32BufferAttribute(col,3));
 g.setIndex(idx);g.computeVertexNormals();
 const mm=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.95});
 mm.onBeforeCompile=sh=>{withWorldPos(sh);sh.fragmentShader=sh.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
  vec2 mp=vWPos.xz;float rock=smoothstep(.06,.0,vColor.g-vColor.r),snow=step(.85,vColor.b);
  float forest=smoothstep(.45,.6,gfbm(mp/38.))*(1.-rock)*(1.-snow);
  diffuseColor.rgb*=mix(1.,.62,forest)*(.84+.32*gfbm(mp/9.));
  diffuseColor.rgb*=1.+rock*(.18*sin(vWPos.y*.45+gn(mp/30.)*6.)-.04);`)};
 const mtn=new THREE.Mesh(g,mm);noAO.push(mtn);scene.add(mtn)}

// ---------- cars ----------
const NAMES=['YOU','VORTEX','BOLT','TIGER'];
const COLORS=[0x1976ff,0xff3434,0xffc928,0x20d47a];
// Car models, same order as kModels in controls.cpp (the driving numbers live there).
// Bodies are lofted from profiles along the car: t runs from -.5 (rear bumper) to .5 (front bumper).
// bottom/belt/top are heights (belt = shoulder line, top = centre line over hood/roof/deck), half = half width.
// ws/rw: windscreen and rear window ranges in t, roofW: roof width relative to the body.
const MODELS=[
 {name:'VELOCE GT4',wins:0,desc:'Mid-engine coupe. Precise, balanced and easy to drive fast.',style:'gt4',
  len:4.45,wheelR:.35,wheelZ:[-1.21,1.27],trackX:.84,roofW:.62,ws:[.07,.21],rw:[-.26,-.06],
  bottom:[[-.5,.36],[-.44,.2],[-.3,.13],[.3,.13],[.44,.16],[.5,.26]],
  belt:[[-.5,.74],[-.42,.86],[-.3,.88],[-.15,.8],[0,.76],[.15,.77],[.3,.8],[.42,.72],[.5,.5]],
  top:[[-.5,.8],[-.46,.86],[-.36,.88],[-.28,.94],[-.18,1.1],[-.08,1.24],[0,1.28],[.07,1.26],[.14,1.06],[.21,.76],[.3,.7],[.42,.62],[.5,.5]],
  half:[[-.5,.86],[-.44,1],[-.32,1.03],[-.18,.95],[0,.9],[.15,.91],[.28,1],[.4,.97],[.47,.88],[.5,.76]]},
 {name:'KAZE GT35',wins:1,desc:'Japanese all-wheel-drive turbo monster with a wide body. Strong pull and lots of grip.',style:'r34',glb:'kaze',zones:{belt:1.052,front:.925,rear:-1.509,side:.803,wingZ:-1.801,wingY:1.193},
  len:4.6,wheelR:.36,wheelZ:[-1.34,1.34],trackX:.95,roofW:.74,ws:[.11,.24],rw:[-.26,-.15],
  bottom:[[-.5,.4],[-.45,.22],[-.3,.16],[.3,.16],[.45,.2],[.5,.32]],
  belt:[[-.5,.84],[-.45,.88],[-.3,.88],[-.1,.83],[.1,.83],[.3,.86],[.44,.85],[.5,.8]],
  top:[[-.5,.84],[-.46,.94],[-.34,.97],[-.26,.99],[-.17,1.3],[-.08,1.36],[.06,1.37],[.12,1.32],[.24,.98],[.36,.93],[.46,.88],[.5,.76]],
  half:[[-.5,.94],[-.47,.99],[-.3,1.02],[0,.96],[.3,1.02],[.47,1],[.5,.96]]},
 {name:'RYU S15',wins:3,desc:'Light drift coupe. Turns in sharply and slides easily.',style:'s15',
  len:4.45,wheelR:.35,wheelZ:[-1.3,1.25],trackX:.83,roofW:.68,ws:[.1,.23],rw:[-.24,-.14],
  bottom:[[-.5,.38],[-.44,.2],[0,.15],[.44,.18],[.5,.28]],
  belt:[[-.5,.78],[-.4,.84],[-.2,.84],[0,.82],[.25,.8],[.42,.74],[.5,.62]],
  top:[[-.5,.8],[-.45,.88],[-.33,.92],[-.24,.98],[-.15,1.22],[-.04,1.31],[.06,1.3],[.11,1.24],[.23,.86],[.36,.79],[.46,.7],[.5,.6]],
  half:[[-.5,.86],[-.44,.97],[-.25,.98],[0,.95],[.3,.97],[.45,.92],[.5,.8]]},
 {name:'APEX HYPER',wins:6,desc:'Carbon hypercar. The fastest thing in the garage.',style:'hyper',
  len:4.7,wheelR:.37,wheelZ:[-1.38,1.3],trackX:.9,roofW:.55,ws:[.03,.17],rw:[-.22,-.06],
  bottom:[[-.5,.34],[-.42,.14],[.42,.13],[.5,.2]],
  belt:[[-.5,.72],[-.4,.86],[-.25,.86],[-.08,.78],[.12,.7],[.3,.66],[.44,.56],[.5,.36]],
  top:[[-.5,.74],[-.42,.84],[-.3,.9],[-.18,.98],[-.08,1.1],[.01,1.13],[.08,1.08],[.18,.84],[.3,.62],[.42,.5],[.5,.34]],
  half:[[-.5,.86],[-.4,1.06],[-.25,1.04],[-.05,.95],[.15,.97],[.32,1.01],[.44,.95],[.5,.72]]},
 {name:'STALLION GT',wins:2,desc:'American V8 fastback. Huge pull, loves to slide.',style:'muscle',
  len:4.8,wheelR:.37,wheelZ:[-1.4,1.42],trackX:.87,roofW:.7,ws:[.08,.17],rw:[-.3,-.18],
  bottom:[[-.5,.4],[-.45,.22],[.44,.2],[.5,.34]],
  belt:[[-.5,.86],[-.4,.9],[-.2,.88],[0,.86],[.25,.86],[.42,.86],[.5,.82]],
  top:[[-.5,.88],[-.45,.98],[-.38,1],[-.28,1.1],[-.18,1.28],[-.08,1.35],[.02,1.35],[.08,1.3],[.17,1],[.3,.96],[.45,.92],[.5,.84]],
  half:[[-.5,.92],[-.45,.99],[-.25,1],[0,.97],[.3,.99],[.46,.97],[.5,.9]]},
 {name:'RENNER TURBO S',wins:4,desc:'Rear-engine German icon. Brutal launch and razor-sharp grip.',style:'911',
  len:4.54,wheelR:.36,wheelZ:[-1.17,1.28],trackX:.86,roofW:.62,ws:[.07,.2],rw:[-.24,-.08],
  bottom:[[-.5,.36],[-.44,.18],[.42,.14],[.5,.24]],
  belt:[[-.5,.76],[-.42,.86],[-.3,.88],[-.15,.82],[0,.8],[.18,.8],[.33,.82],[.43,.74],[.5,.52]],
  top:[[-.5,.78],[-.46,.86],[-.38,.92],[-.28,1],[-.18,1.14],[-.08,1.25],[0,1.3],[.07,1.27],[.14,1.06],[.2,.79],[.3,.71],[.42,.63],[.5,.5]],
  half:[[-.5,.84],[-.44,1],[-.3,1.04],[-.15,.95],[0,.9],[.15,.9],[.3,.95],[.42,.93],[.48,.85],[.5,.72]]},
 {name:'TORO V10',wins:5,desc:'Italian V10 supercar. Wedge-shaped, loud and very fast.',style:'huracan',
  len:4.52,wheelR:.36,wheelZ:[-1.25,1.37],trackX:.9,roofW:.56,ws:[.04,.17],rw:[-.24,-.08],
  bottom:[[-.5,.3],[-.42,.13],[.42,.12],[.5,.18]],
  belt:[[-.5,.74],[-.4,.86],[-.25,.86],[-.1,.78],[.1,.72],[.3,.68],[.44,.56],[.5,.36]],
  top:[[-.5,.76],[-.42,.86],[-.3,.92],[-.2,1],[-.1,1.1],[-.02,1.15],[.06,1.1],[.16,.86],[.28,.66],[.4,.52],[.5,.36]],
  half:[[-.5,.9],[-.4,1.04],[-.25,1.03],[-.05,.96],[.15,.97],[.32,1],[.44,.95],[.5,.7]]},
 {name:'STRADA GT1',wins:0,desc:'Mid-engine Le Mans GT1 built for the road. Long tail, big wing, enormous grip at speed.',style:'gt1',glb:'gt1',
  len:4.71,wheelR:.374,wheelZ:[-1.272,1.276],trackX:.85,roofW:.55,ws:[.04,.17],rw:[-.24,-.08],
  bottom:[[-.5,.3],[-.42,.13],[.42,.12],[.5,.18]],
  belt:[[-.5,.74],[-.4,.86],[-.25,.86],[-.1,.78],[.1,.72],[.3,.68],[.44,.56],[.5,.36]],
  top:[[-.5,.76],[-.42,.86],[-.3,.92],[-.2,1],[-.1,1.1],[-.02,1.15],[.06,1.1],[.16,.86],[.28,.66],[.4,.52],[.5,.36]],
  half:[[-.5,.94],[-.4,1.04],[-.25,1.03],[-.05,.96],[.15,.97],[.32,1],[.44,.95],[.5,.72]]}
];
// monotone cubic through [t,value] keys (no overshoot, so the body never ripples)
function profile(keys){
 const n=keys.length,xs=keys.map(k=>k[0]),ys=keys.map(k=>k[1]),d=[],m=[];
 for(let i=0;i<n-1;i++)d.push((ys[i+1]-ys[i])/(xs[i+1]-xs[i]));
 m[0]=d[0];m[n-1]=d[n-2];for(let i=1;i<n-1;i++)m[i]=d[i-1]*d[i]<=0?0:(d[i-1]+d[i])/2;
 for(let i=0;i<n-1;i++){if(d[i]===0){m[i]=m[i+1]=0;continue}const a=m[i]/d[i],b=m[i+1]/d[i],h=a*a+b*b;if(h>9){const k=3/Math.sqrt(h);m[i]=k*a*d[i];m[i+1]=k*b*d[i]}}
 return t=>{if(t<=xs[0])return ys[0];if(t>=xs[n-1])return ys[n-1];let i=0;while(t>xs[i+1])i++;
  const h=xs[i+1]-xs[i],s=(t-xs[i])/h,s2=s*s,s3=s2*s;
  return (2*s3-3*s2+1)*ys[i]+(s3-2*s2+s)*h*m[i]+(-2*s3+3*s2)*ys[i+1]+(s3-s2)*h*m[i+1]};
}
MODELS.forEach(M=>{for(const k of ['bottom','belt','top','half'])M[k+'F']=profile(M[k])});
// right half of the cross-section at t, from the bottom centre up to the top centre
function carSection(M,t){
 const yb=M.bottomF(t),yt=M.beltF(t),yT=M.topF(t),W=M.halfF(t),cab=clamp((yT-yt-.06)/.25,0,1);
 // straight sides with a crisp shoulder, flat-ish hood, flat side glass and roof
 const p=[[0,yb],[W*.86,yb],[W*.97,yb+.035],[W,yb+(yt-yb)*.35],[W*.995,yb+(yt-yb)*.8],[W*.955,yt-.01],[W*.92,yt+.005]];
 if(cab<=0)p.push([W*.82,lerp(yt,yT,.5)],[W*.45,lerp(yt,yT,.95)],[0,yT]);
 else{const wg=W*lerp(.9,.86,cab),wr=W*M.roofW;p.push([wg,yt+.03],[wr*1.04,yT-.07],[wr*.88,yT-.012],[0,yT])}
 return p;
}
// height of the upper surface at lateral x (for placing lamps, mirrors... on the body)
function carSurfY(M,t,x){const p=carSection(M,t);
 for(let i=p.length-1;i>5;i--){const [x0,y0]=p[i],[x1,y1]=p[i-1];if(x>=x0&&x<=x1)return lerp(y0,y1,(x-x0)/((x1-x0)||1))}
 return M.beltF(t)}
function resample(pts,n){
 const L=[0];for(let i=1;i<pts.length;i++)L.push(L[i-1]+Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]));
 const out=[],tot=L[L.length-1];let j=0;
 for(let i=0;i<n;i++){const d=tot*i/(n-1);while(j<pts.length-2&&L[j+1]<d)j++;const u=(d-L[j])/((L[j+1]-L[j])||1);
  out.push([lerp(pts[j][0],pts[j+1][0],u),lerp(pts[j][1],pts[j+1][1],u)])}
 return out;
}
// the body shell: one smooth mesh, paint + glass groups, wheel arches pushed in
function carShell(M){
 const ST=84,HM=26,ring=2*HM-2,pos=[],glass=[];
 const archR=M.wheelR+.075;
 for(let i=0;i<=ST;i++){
  const t=-.5+i/ST,z=t*M.len,W=M.halfF(t),yt=M.beltF(t),yT=M.topF(t);
  const half=resample(carSection(M,t),HM);
  // round the bumpers off: the last few % of the length pull in towards the middle
  const rf=smooth(.455,.5,Math.abs(t)),ym=(M.bottomF(t)+M.beltF(t))/2;
  if(rf>0)for(const p of half){p[0]*=1-.24*rf*rf;p[1]=lerp(p[1],ym,.3*rf*rf)}
  for(const p of half){
   if(p[0]>W*.72)for(const wz of M.wheelZ){const dz=z-wz;if(Math.abs(dz)<archR){const ay=M.wheelR+Math.sqrt(archR*archR-dz*dz)*.97;if(p[1]<ay)p[1]=ay}}
   const inWS=t>M.ws[0]&&t<M.ws[1],inRear=t>M.rw[0]&&t<M.rw[1],inRoof=t>=M.rw[1]&&t<=M.ws[0];
   // glass: the windscreen and rear window in the middle, and real side windows: from the A-pillar to the
   // C-pillar along the whole cabin side, with a strip of body (the pillars) left between them
   const side=p[1]<yT-.05&&p[0]>W*M.roofW*(inRoof?.55:1.12)&&t>M.rw[0]+.02&&t<M.ws[1]-.03;
   p[2]=p[1]>yt+.045&&((inWS||inRear)&&p[0]<W*M.roofW*.92||side)?1:0;
  }
  const full=[...half,...half.slice(1,HM-1).reverse().map(([x,y,g])=>[-x,y,g])];
  for(const [x,y,g] of full){pos.push(x,y,z);glass.push(g)}
 }
 const paintI=[],glassI=[],panI={hood:[],bumper:[],doorL:[],doorR:[]};
 // the panels that can come off: bonnet, front bumper, the two doors (each its own group of the one mesh)
 const archR2=M.wheelR+.075,dz0=M.wheelZ[0]+archR2+.08,dz1=M.wheelZ[1]-archR2-.08;
 const panelOf=(t,x,y,z)=>{const W=M.halfF(t),yt=M.beltF(t),yb=M.bottomF(t);
  if(t>.44)return 'bumper';
  if(t>M.ws[1]+.02&&y>yt-.04&&Math.abs(x)<W*.88)return 'hood';
  if(z>dz0&&z<dz1&&Math.abs(x)>W*.75&&y>yb+.07&&y<yt+.005)return x>0?'doorR':'doorL';
  return null};
 for(let i=0;i<ST;i++)for(let j=0;j<ring;j++){
  const a=i*ring+j,b=i*ring+(j+1)%ring,c=a+ring,d=b+ring,gl=glass[a]+glass[b]+glass[c]+glass[d]>=3;
  const cx=(pos[a*3]+pos[b*3]+pos[c*3]+pos[d*3])/4,cy=(pos[a*3+1]+pos[b*3+1]+pos[c*3+1]+pos[d*3+1])/4,cz=(pos[a*3+2]+pos[c*3+2])/2;
  const pn=gl?null:panelOf(cz/M.len,cx,cy,cz);
  (gl?glassI:pn?panI[pn]:paintI).push(a,b,c,b,d,c);
 }
 // nose and tail caps
 for(const [i,front] of [[0,false],[ST,true]]){
  let cx=0,cy=0;for(let j=0;j<ring;j++){cx+=pos[(i*ring+j)*3];cy+=pos[(i*ring+j)*3+1]}
  const ci=pos.length/3;pos.push(cx/ring,cy/ring,pos[i*ring*3+2]);glass.push(0);
  for(let j=0;j<ring;j++){const a=i*ring+j,b=i*ring+(j+1)%ring;front?panI.bumper.push(ci,b,a):paintI.push(ci,a,b)}
 }
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
 const all=[paintI,glassI,panI.hood,panI.bumper,panI.doorL,panI.doorR];g.setIndex(all.flat());let o=0;all.forEach((ix,k)=>{g.addGroup(o,ix.length,k);o+=ix.length});
 g.computeVertexNormals();return g;
}
const RIMS=[
 {name:'Classic',color:0xc4cad0,metal:.85,rough:.25,spokes:5,w:.09},
 {name:'Black',color:0x1d2024,metal:.6,rough:.35,spokes:10,w:.04},
 {name:'Gold',color:0xc9a043,metal:.9,rough:.25,spokes:6,w:.07},
 {name:'Neon',color:0xe8eef5,metal:1,rough:.1,spokes:7,w:.05,glow:0x22d3ff}
];
const SPOILERS=['None','Ducktail','GT wing','Swan-neck'];
const FINISHES=['Gloss','Metallic','Matte'];
const CALIPERS=[0xd42020,0xf2c21b,0x2a6cff,0x16181c,0x28c76f];
function numberTex(n,col){return canvasTex(64,64,(g,w,h)=>{g.fillStyle='#fff';g.beginPath();g.arc(32,32,28,0,7);g.fill();g.fillStyle=col;g.font='bold 38px Arial';g.textAlign='center';g.textBaseline='middle';g.fillText(n,32,34)},false)}
// shared car textures/materials
const treadTex=canvasTex(256,64,(g,w,h)=>{g.fillStyle='#1b1b1c';g.fillRect(0,0,w,h);g.strokeStyle='#0a0a0a';g.lineWidth=5;
 for(let x=0;x<w;x+=16){g.beginPath();g.moveTo(x,6);g.lineTo(x+8,h/2);g.lineTo(x,h-6);g.stroke()}g.fillStyle='#0c0c0c';g.fillRect(0,h/2-2,w,4)});
treadTex.repeat.set(3,1);
const sidewallTex=canvasTex(256,256,(g,w,h)=>{const c=w/2;g.fillStyle='#151516';g.fillRect(0,0,w,h);
 g.strokeStyle='#222326';g.lineWidth=10;g.beginPath();g.arc(c,c,c*.86,0,7);g.stroke();
 g.fillStyle='#6f7378';g.font='bold 20px Arial';g.textAlign='center';g.textBaseline='middle';
 const txt='KOD  RACING  •  PERFORMANCE  •  ';for(let i=0;i<txt.length;i++){const a=i/txt.length*Math.PI*2;
  g.save();g.translate(c+Math.cos(a)*c*.86,c+Math.sin(a)*c*.86);g.rotate(a+Math.PI/2);g.fillText(txt[i],0,0);g.restore()}},false);
const treadMat=new THREE.MeshStandardMaterial({map:treadTex,roughness:.95}),sidewallMat=new THREE.MeshStandardMaterial({map:sidewallTex,roughness:.9});
const seamMat=new THREE.MeshStandardMaterial({color:0x050506,roughness:.8}),chromeMat=new THREE.MeshStandardMaterial({color:0xd8dde2,metalness:1,roughness:.15});
const grilleTex=canvasTex(64,32,(g,w,h)=>{g.fillStyle='#0c0d0f';g.fillRect(0,0,w,h);g.fillStyle='#24272c';for(let y=0;y<h;y+=4)for(let x=(y/4%2)*3;x<w;x+=6)g.fillRect(x,y,4,2)});
const grilleMat=new THREE.MeshStandardMaterial({map:grilleTex,roughness:.6,metalness:.3});
const plateMat=new THREE.MeshStandardMaterial({roughness:.5,map:canvasTex(128,32,(g,w,h)=>{g.fillStyle='#f3f3ef';g.fillRect(0,0,w,h);g.fillStyle='#1d3fbf';g.fillRect(0,0,14,h);g.strokeStyle='#222';g.lineWidth=2;g.strokeRect(1,1,w-2,h-2);g.fillStyle='#111';g.font='bold 20px Arial';g.textAlign='center';g.textBaseline='middle';g.fillText('KOD 3D',w/2+6,h/2+1)},false)});
// soft dark patch under each car so it sits on the road
const blobMat=new THREE.MeshBasicMaterial({transparent:true,depthWrite:false,opacity:.62,polygonOffset:true,polygonOffsetFactor:-6,
 map:canvasTex(64,64,(g,w,h)=>{const r=g.createRadialGradient(32,32,4,32,32,32);r.addColorStop(0,'rgba(0,0,0,1)');r.addColorStop(.55,'rgba(0,0,0,.7)');r.addColorStop(1,'rgba(0,0,0,0)');g.fillStyle=r;g.fillRect(0,0,w,h)},false)});
const tireTread=treadTex.clone();tireTread.needsUpdate=true;tireTread.repeat.set(10,1);
const tireMat=new THREE.MeshStandardMaterial({map:tireTread,roughness:.95,side:THREE.DoubleSide});
const wallMat2=new THREE.MeshStandardMaterial({map:sidewallTex,roughness:.9,side:THREE.DoubleSide});
const seatMat=new THREE.MeshStandardMaterial({color:0x24272c,roughness:.95}),discMat=new THREE.MeshStandardMaterial({color:0x6b6e72,metalness:.8,roughness:.35});
const lensMat=new THREE.MeshPhysicalMaterial({color:0x9aa6b4,metalness:.3,roughness:.03,clearcoat:1,transparent:true,opacity:.45});
function tireGeo(r,w){
 const pts=[[.79,-.5],[.95,-.5],[.99,-.42],[1,-.3],[1,.3],[.99,.42],[.95,.5],[.79,.5]].map(([a,b])=>new THREE.Vector2(r*a,w*b));
 return new THREE.LatheGeometry(pts,32).rotateZ(Math.PI/2);
}
function wingGeo(width,chord){
 const s=new THREE.Shape();s.moveTo(0,0);s.quadraticCurveTo(chord*.28,chord*.17,chord,chord*.035);s.lineTo(chord,0);s.quadraticCurveTo(chord*.35,-chord*.05,0,0);
 return new THREE.ExtrudeGeometry(s,{depth:width,bevelEnabled:false,curveSegments:10}).rotateY(Math.PI/2).translate(-width/2,0,chord/2);
}
const carbonTex=canvasTex(64,64,(g,w,h)=>{g.fillStyle='#16181b';g.fillRect(0,0,w,h);
 for(let y=0;y<h;y+=8)for(let x=0;x<w;x+=8){const on=((x+y)/8)%2===0;const gr=g.createLinearGradient(x,y,x+8,y+8);gr.addColorStop(0,on?'#2c3036':'#1c1f23');gr.addColorStop(1,on?'#1a1d21':'#2a2e33');g.fillStyle=gr;g.fillRect(x,y,8,8)}});
carbonTex.repeat.set(6,6);
const carbonMat=new THREE.MeshPhysicalMaterial({map:carbonTex,roughness:.35,metalness:.2,clearcoat:1,clearcoatRoughness:.08});
const linerMat=new THREE.MeshStandardMaterial({color:0x0b0c0e,roughness:.9,side:THREE.DoubleSide});
// a part of a car model as plain float geometry in metres (the file stores it quantized, with the scale on the node),
// so it can be dented like the built-in bodies
function modelGeometry(node){
 const g=node.geometry.clone();
 for(const [k,a] of Object.entries(g.attributes)){if(a.array instanceof Float32Array&&!a.normalized)continue;
  const f=new Float32Array(a.count*a.itemSize);for(let i=0;i<a.count;i++)for(let j=0;j<a.itemSize;j++)f[i*a.itemSize+j]=a.getComponent(i,j);
  g.setAttribute(k,new THREE.BufferAttribute(f,a.itemSize))}
 node.updateWorldMatrix(true,false);g.applyMatrix4(node.matrixWorld);g.computeBoundingSphere();return g;
}
function makeCar(color,num,opt={}){
 const M=MODELS[opt.model||0],rimStyle=RIMS[opt.rims||0],spoiler=opt.spoiler??2,finish=opt.finish||0,st=M.style;
 const g=new THREE.Group(),body=new THREE.Group();g.add(body);
 const paint=new THREE.MeshPhysicalMaterial({color,side:THREE.DoubleSide,metalness:[.3,.75,.1][finish],roughness:[.35,.28,.72][finish],clearcoat:finish===2?0:1,clearcoatRoughness:.05});
 const dark=new THREE.MeshStandardMaterial({color:0x121417,roughness:.6});
 const glass=new THREE.MeshPhysicalMaterial({color:0x0c141c,metalness:0,roughness:.04,clearcoat:1,transparent:true,opacity:.55});
 const add=(geo,mat,x,y,z,parent=body)=>{const m=new THREE.Mesh(geo,mat);m.position.set(x,y,z);m.castShadow=true;parent.add(m);return m};
 const L2=M.len/2,W=t=>M.halfF(t),slope=t=>Math.atan2(M.topF(t+.01)-M.topF(t-.01),.02*M.len),Z=t=>t*M.len;
 const dents=[],wingParts=[];let shellRef=null;
 const headMat=new THREE.MeshStandardMaterial({color:0xffffff,emissive:0xfff6e0,emissiveIntensity:1.2});
 const tailMat=new THREE.MeshStandardMaterial({color:0x550000,emissive:0xff1010,emissiveIntensity:.6});
 const box=(w,h,d)=>new THREE.BoxGeometry(w,h,d),cyl=(r,l,n=16)=>new THREE.CylinderGeometry(r,r,l,n).rotateX(Math.PI/2);
 const yb=t=>M.bottomF(t),yt=t=>M.beltF(t);
 // ---- body from a 3D model: paint, glass and trim come from the file, the lights are put onto its surface ----
 const src=M.glb&&CAR_GLB[M.glb];
 if(src){
  // the model is one piece, so the paint itself draws the windows and the carbon wing, pixel by pixel,
  // along the car's real lines (window line, roof, pillars) instead of along its triangles
  const Z=M.zones;
  if(Z)paint.onBeforeCompile=sh=>{
   sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 vCarP,vCarN;')
    .replace('#include <begin_vertex>','#include <begin_vertex>\nvCarP=position;vCarN=normal;');
   sh.fragmentShader=sh.fragmentShader.replace('#include <common>','#include <common>\nvarying vec3 vCarP,vCarN;\nfloat carGlass,carWing;')
    .replace('#include <color_fragment>',`#include <color_fragment>
     float aa=fwidth(vCarP.y)+.004;
     carGlass=smoothstep(${Z.belt}-aa,${Z.belt}+aa,vCarP.y)*step(${Z.rear},vCarP.z)*step(vCarP.z,${Z.front})*step(abs(vCarP.x),${Z.side})
      *(1.-smoothstep(.88,.94,normalize(vCarN).y));
     carWing=step(vCarP.z,${Z.wingZ})*smoothstep(${Z.wingY}-aa,${Z.wingY}+aa,vCarP.y);
     diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.015,.02,.026),carGlass);
     diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.03,.032,.035),carWing);
`)
    .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=mix(mix(roughnessFactor,.04,carGlass),.45,carWing);')
    .replace('#include <metalnessmap_fragment>','#include <metalnessmap_fragment>\nmetalnessFactor=mix(metalnessFactor,0.,max(carGlass,carWing));')};
  if(Z)paint.customProgramCacheKey=()=>'car-zones-'+M.glb;
  let shellM=null;
  for(const node of src.children){if(!node.isMesh||node.name!=='body')continue;
   const m=new THREE.Mesh(modelGeometry(node),paint);m.castShadow=true;m.receiveShadow=true;body.add(m);
   m.geometry.userData.orig=m.geometry.attributes.position.array.slice();dents.push(m);shellM=m}
  // models split by material (tools/build_gt1.mjs) bring their own glass, trim, metal, lights and cabin
  const extra={trim:new THREE.MeshStandardMaterial({color:0x17191c,roughness:.55,metalness:.25}),metal:new THREE.MeshStandardMaterial({color:0xb8bec6,roughness:.25,metalness:.9}),
   glass,head:headMat,tail:tailMat,inside:new THREE.MeshStandardMaterial({color:0x26221f,roughness:.9})};
  let ownLights=false;
  for(const node of src.children){const mat=node.isMesh&&extra[node.name];if(!mat)continue;
   const m=new THREE.Mesh(modelGeometry(node),mat);m.castShadow=node.name!=='glass';body.add(m);if(node.name==='head'||node.name==='tail')ownLights=true}
  const ray=new THREE.Raycaster(),fwd=new THREE.Vector3();
  const decal=(x,y,dir,sx,sy,mat,lift=.012)=>{
   ray.set(new THREE.Vector3(x,y,dir*8),fwd.set(0,0,-dir));const h=shellM&&ray.intersectObject(shellM)[0];if(!h)return;
   const n=h.face.normal.clone();if(n.dot(ray.ray.direction)>0)n.negate();   // the model's faces don't all wind the same way
   const d=new THREE.Mesh(new THREE.CircleGeometry(1,28),mat);d.scale.set(sx,sy,1);
   d.position.copy(h.point).addScaledVector(n,lift);d.lookAt(h.point.clone().addScaledVector(n,2));body.add(d)};
  if(!ownLights)for(const sd of [-1,1]){
   decal(sd*.74,.68,1,.24,.065,headMat);decal(sd*.56,.66,1,.065,.065,headMat);   // light strip + projector on the front corners
   for(const x of [.48,.74])decal(sd*x,.92,-1,.085,.085,tailMat)}
 }else{
 // body shell (this is what gets dented)
 const shell=new THREE.Mesh(carShell(M),[paint,glass,paint,paint,paint,paint]);shell.castShadow=true;body.add(shell);shellRef=shell;
 shell.geometry.userData.orig=shell.geometry.attributes.position.array.slice();
 dents.push(shell);
 // ---- lights ----
 for(const sd of [-1,1]){
  if(st==='gt4'){const t=.405,x=sd*W(t)*.64,y=carSurfY(M,t,Math.abs(x));
   const refl=add(new THREE.SphereGeometry(1,20,12),chromeMat,x,y-.035,Z(t));refl.scale.set(.19,.06,.16);refl.rotation.x=-slope(t);
   const lens=add(new THREE.SphereGeometry(1,24,14),lensMat,x,y-.02,Z(t));lens.scale.set(.23,.085,.19);lens.rotation.x=-slope(t);
   const drl=add(new THREE.TorusGeometry(.75,.1,8,32),headMat,x,y+.012,Z(t));drl.rotation.x=-Math.PI/2-slope(t);drl.scale.set(.2,.16,.2);
   add(box(W(-.5)*1.6,.045,.03),tailMat,0,yt(-.5)-.05,-L2-.005);
  }else if(st==='r34'){
   add(box(.46,.14,.08),dark,sd*.56,yt(.5)-.12,L2-.02);
   for(const x of [.44,.67]){add(cyl(.062,.05),headMat,sd*x,yt(.5)-.12,L2+.02);add(cyl(.077,.04),tailMat,sd*(x-.02),yt(-.5)-.12,-L2-.01)}
  }else if(st==='s15'){const t=.44,x=sd*W(t)*.62,y=carSurfY(M,t,Math.abs(x));
   const l=add(box(.42,.07,.22),lensMat,x,y+.01,Z(t));l.rotation.set(-slope(t),sd*.18,0);
   const d=add(box(.36,.022,.03),headMat,x,y+.03,Z(t)+.1);d.rotation.y=sd*.18;
   add(box(.44,.09,.04),tailMat,sd*.55,yt(-.5)-.08,-L2-.005);
  }else if(st==='911'){const t=.415,x=sd*W(t)*.62,y=carSurfY(M,t,Math.abs(x));
   const refl=add(new THREE.SphereGeometry(1,20,12),chromeMat,x,y-.03,Z(t));refl.scale.set(.15,.11,.14);refl.rotation.x=-slope(t)-.45;
   const lens=add(new THREE.SphereGeometry(1,24,14),lensMat,x,y-.01,Z(t));lens.scale.set(.17,.13,.16);lens.rotation.x=-slope(t)-.45;
   const drl=add(new THREE.TorusGeometry(.8,.09,8,32),headMat,x,y+.02,Z(t)+.03);drl.rotation.x=-.9;drl.scale.set(.15,.12,.15);
   add(box(.5,.035,.03),tailMat,sd*.55,yt(-.5)-.07,-L2-.005);
  }else if(st==='huracan'){const t=.44,x=sd*W(t)*.6,y=carSurfY(M,t,Math.abs(x));
   const a=add(box(.38,.025,.05),headMat,x,y+.012,Z(t));a.rotation.set(-slope(t),sd*.32,0);
   const b=add(box(.16,.025,.05),headMat,x-sd*.08,y+.008,Z(t)-.08);b.rotation.set(-slope(t),-sd*.5,0);
   const l=add(box(.42,.05,.16),lensMat,x,y-.005,Z(t)-.02);l.rotation.set(-slope(t),sd*.32,0);
   const tl=add(box(.46,.03,.03),tailMat,sd*.55,yt(-.5)-.06,-L2-.005);tl.rotation.z=sd*.12;
  }else if(st==='muscle'){
   for(const x of [.47,.58])add(box(.1,.06,.04),headMat,sd*x,yt(.5)-.1,L2+.01);
   add(box(.3,.08,.06),lensMat,sd*.53,yt(.5)-.1,L2-.01);
   for(const x of [.45,.55,.65])add(box(.06,.15,.03),tailMat,sd*x,yt(-.5)-.12,-L2-.005);
  }else{const t=.47,x=sd*W(t)*.58,y=carSurfY(M,t,Math.abs(x));
   const l=add(box(.4,.028,.07),headMat,x,y+.012,Z(t));l.rotation.set(-slope(t),sd*.25,0);
   add(box(.5,.03,.03),tailMat,sd*.5,yt(-.5)-.04,-L2-.005);
  }
 }
 if(st==='hyper')add(box(W(-.5)*.9,.025,.03),tailMat,0,yt(-.5)-.04,-L2-.005);
 if(st==='911')add(box(W(-.5)*1.15,.025,.03),tailMat,0,yt(-.5)-.07,-L2-.005);
 // ---- intakes, splitter, diffuser ----
 const fz=L2+.006,fy=yb(.5);
 if(st==='gt4'){add(box(.9,.12,.03),grilleMat,0,fy+.12,fz);for(const sd of [-1,1]){const s=add(box(.34,.16,.03),grilleMat,sd*.6,fy+.14,fz-.01);s.rotation.y=sd*.12}}
 else if(st==='r34'){add(box(.66,.12,.03),grilleMat,0,yt(.5)-.12,fz);add(box(1.15,.17,.03),grilleMat,0,fy+.14,fz);for(const sd of [-1,1])add(box(.16,.07,.03),dark,sd*.62,fy+.13,fz)}
 else if(st==='s15'){add(box(.8,.14,.03),grilleMat,0,fy+.15,fz);for(const sd of [-1,1])add(box(.2,.06,.03),dark,sd*.55,fy+.1,fz)}
 else if(st==='911'){add(box(.6,.14,.03),grilleMat,0,fy+.13,fz);for(const sd of [-1,1])add(box(.3,.17,.03),grilleMat,sd*.58,fy+.14,fz)}
 else if(st==='huracan'){for(const sd of [-1,1]){const h=add(new THREE.CircleGeometry(.5,6),grilleMat,sd*.5,fy+.16,fz);h.scale.set(.5,.26,1)}add(box(.3,.06,.03),grilleMat,0,fy+.07,fz)}
 else if(st==='muscle'){add(box(.62,.22,.03),grilleMat,0,yt(.5)-.14,fz);add(box(.8,.1,.03),grilleMat,0,fy+.12,fz)}
 else{for(const sd of [-1,1])add(box(.48,.2,.03),grilleMat,sd*.48,fy+.15,fz);add(box(.3,.08,.03),grilleMat,0,fy+.08,fz)}
 add(box(W(.48)*2.05,.03,.28),carbonMat,0,fy-.015,L2-.1);
 const ry=yb(-.5);add(box(W(-.5)*1.55,.13,.32),carbonMat,0,ry+.02,-L2+.12);
 for(const x of [-.45,-.15,.15,.45])add(box(.015,.12,.3),dark,x,ry-.02,-L2+.12);
 // ---- plates, side intakes, skirts, door shut lines, mirrors ----
 add(box(.5,.11,.02),plateMat,0,st==='r34'?fy+.14:fy+.3,L2+.03).visible=['r34','s15','muscle'].includes(st);
 add(box(.5,.11,.02),plateMat,0,ry+.2,-L2-.02).rotation.y=Math.PI;
 const skirtL=M.wheelZ[1]-M.wheelZ[0]-2*(M.wheelR+.1);
 for(const sd of [-1,1]){
  add(box(.06,.07,skirtL),carbonMat,sd*(W(0)-.02),yb(0)+.05,(M.wheelZ[0]+M.wheelZ[1])/2);
  if(st==='911'){const t=-.24,si=add(new THREE.CircleGeometry(.5,28),grilleMat,sd*(W(t)+.003),lerp(yb(t),yt(t),.66),Z(t));si.scale.set(.3,.11,1);si.rotation.y=sd*Math.PI/2}
  if(st==='gt4'||st==='hyper'||st==='huracan'){const t=-.12,si=add(new THREE.CircleGeometry(.5,28),grilleMat,sd*(W(t)+.003),lerp(yb(t),yt(t),.58),Z(t));si.scale.set(.42,.17,1);si.rotation.y=sd*Math.PI/2}
  for(const t of [M.ws[1]-.05,M.rw[1]+.03]){const h=yt(t)-yb(t)-.08;add(box(.006,h,.012),seamMat,sd*(W(t)+.002),yb(t)+.04+h/2,Z(t))}
  const mt=M.ws[1]-.02,mx=sd*(W(mt)*.9+.1),my=yt(mt)+.1;
  const mir=add(new THREE.SphereGeometry(1,14,10),paint,mx,my,Z(mt));mir.scale.set(.12,.065,.085);
  add(box(.1,.025,.04),dark,mx-sd*.07,my-.03,Z(mt));
 }
 }
 // ---- exhausts (+ nitro flames) ----
 const flameMat=new THREE.MeshBasicMaterial({color:0x66ccff,transparent:true,opacity:.85,blending:THREE.AdditiveBlending,depthWrite:false});
 const ex={gt1:[[-.22,.4],[.22,.4]],gt4:[[-.1,.3],[.1,.3]],r34:[[-.5,.24]],s15:[[-.42,.24],[-.6,.24]],hyper:[[-.2,.46],[.2,.46]],muscle:[[-.62,.27],[-.5,.27],[.5,.27],[.62,.27]],'911':[[-.6,.3],[-.48,.3],[.48,.3],[.6,.3]],huracan:[[-.13,.6],[.13,.6]]}[st],flames=[];
 for(const [x,y] of ex){add(cyl(.055,.16,st==='huracan'?6:14),chromeMat,x,y,-L2+.02);
  const f=new THREE.Mesh(new THREE.ConeGeometry(.16,1.3,10),flameMat);f.rotation.x=-Math.PI/2;f.position.set(x,y,-L2-.6);f.userData.z0=-L2-.4;f.visible=false;body.add(f);flames.push(f)}
 if(!src){
 // ---- rear wing ----
 const wt=-.43,wy=M.topF(wt),ww=W(wt)*1.75;
 if(spoiler===1){const d=add(box(W(-.47)*1.55,.05,.26),paint,0,M.topF(-.47)+.025,Z(-.47));d.rotation.x=.28;dents.push(d);wingParts.push(d)}
 if(spoiler>=2){const hi=spoiler===3,h=hi?.3:.15,chord=hi?.46:.36;
  const wing=add(wingGeo(ww,chord),hi?carbonMat:paint,0,wy+h,Z(wt)+.05);wing.rotation.x=hi?-.08:-.04;wingParts.push(wing);
  for(const x of [-.42,.42]){const s=add(box(.025,h,.16),dark,x,wy+h/2,Z(wt));if(hi)s.rotation.x=-.25;wingParts.push(s)}
  if(hi)for(const x of [-ww/2,ww/2])wingParts.push(add(box(.02,.2,chord+.08),carbonMat,x,wy+h+.02,Z(wt)-.18))}
 // ---- interior (seen through the glass) ----
 const zc=lerp(M.rw[1],M.ws[0],.42)*M.len,fl=yb(0)+.16;
 for(const sd of [-1,1]){add(box(.46,.12,.5),seatMat,sd*.36,fl+.08,zc);const b=add(box(.46,.62,.12),seatMat,sd*.36,fl+.42,zc-.3);b.rotation.x=-.22}
 add(box(W(M.ws[1])*1.55,.16,.34),seatMat,0,yt(M.ws[1])-.04,Z(M.ws[1])-.32);
 const sw=add(new THREE.TorusGeometry(.17,.025,8,24),dark,.36,yt(M.ws[1])+.04,Z(M.ws[1])-.55);sw.rotation.x=-.35;
 }
 // ---- wheels: tyre, sidewall lettering, rim, brake disc + caliper ----
 const r=M.wheelR,tw=.3,tGeo=tireGeo(r,tw);
 const rimMat=new THREE.MeshStandardMaterial({color:rimStyle.color,metalness:rimStyle.metal,roughness:rimStyle.rough});
 const glowMat=rimStyle.glow?new THREE.MeshBasicMaterial({color:rimStyle.glow}):null;
 const calMat=new THREE.MeshStandardMaterial({color:opt.caliper??CALIPERS[0],roughness:.4,metalness:.3});
 const spinners=[],steerers=[];
 for(const sd of [-1,1])for(const wz of M.wheelZ){
  const liner=new THREE.Mesh(new THREE.CylinderGeometry(r+.07,r+.07,.36,20,1,true,0,Math.PI).rotateZ(Math.PI/2),linerMat);liner.position.set(sd*M.trackX,r,wz);g.add(liner);
  const pivot=new THREE.Group();pivot.position.set(sd*M.trackX,r,wz);g.add(pivot);
  const spin=new THREE.Group();pivot.add(spin);
  const tire=new THREE.Mesh(tGeo,tireMat);tire.castShadow=true;spin.add(tire);
  const wall=new THREE.Mesh(new THREE.RingGeometry(r*.79,r*.98,40),wallMat2);wall.position.x=sd*(tw/2+.002);wall.rotation.y=sd*Math.PI/2;spin.add(wall);
  const barrel=new THREE.Mesh(new THREE.CylinderGeometry(r*.79,r*.79,tw*.9,24,1,true),discMat);barrel.rotation.z=Math.PI/2;spin.add(barrel);
  const lip=new THREE.Mesh(new THREE.TorusGeometry(r*.77,.02,6,32),glowMat||rimMat);lip.rotation.y=Math.PI/2;lip.position.x=sd*tw*.42;spin.add(lip);
  for(let k=0;k<rimStyle.spokes;k++){const a=k/rimStyle.spokes*Math.PI*2;
   const sp=new THREE.Mesh(new THREE.BoxGeometry(.035,rimStyle.w,r*.66),rimMat);sp.rotation.x=a;sp.position.set(sd*tw*.4,-Math.sin(a)*r*.4,Math.cos(a)*r*.4);spin.add(sp)}
  const hub=new THREE.Mesh(new THREE.CylinderGeometry(r*.14,r*.14,.05,12),rimMat);hub.rotation.z=Math.PI/2;hub.position.x=sd*tw*.42;spin.add(hub);
  const disc=new THREE.Mesh(new THREE.CylinderGeometry(r*.66,r*.66,.025,24),discMat);disc.rotation.z=Math.PI/2;disc.position.x=sd*.02;spin.add(disc);
  const cal=new THREE.Mesh(new THREE.BoxGeometry(.07,.15,.24),calMat);cal.position.set(sd*.05,r*.42,-r*.36);cal.rotation.x=.7;pivot.add(cal);
  spinners.push(spin);if(wz>0)steerers.push(pivot);
 }
 const blob=new THREE.Mesh(new THREE.PlaneGeometry(W(0)*3.1,M.len*1.25),blobMat);blob.rotation.x=-Math.PI/2;blob.position.y=.075;blob.renderOrder=1;g.add(blob);
 dents.forEach(m=>m.geometry.userData.orig=m.geometry.attributes.position.array.slice());
 // lamps, mirrors, grille, plates, wings...: they don't bend, they get pushed along with the bodywork
 const parts=body.children.filter(o=>!dents.includes(o)&&!wingParts.includes(o));parts.forEach(o=>o.userData.p0=o.position.clone());
 return {g,body,spinners,steerers,flames,tailMat,headMat,flameMat,dents,parts,paint,wheelR:r,len:M.len,half:W(0),M,shell:shellRef,wingParts,pHit:{},pOff:{}};
}
const _dp=new THREE.Vector3();
const DENT_R=1.5,DENT_MAX=.5;
// push in by a smooth bump around the hit; each point gives less the more it's already pushed in, so panels stay smooth
const dentPush=(x,y,z,ox,oy,oz,amount,out)=>{
 const d=Math.hypot(x-_dp.x,y-_dp.y,z-_dp.z);if(d>DENT_R)return false;
 const room=Math.max(0,1-Math.hypot(x-ox,y-oy,z-oz)/DENT_MAX);if(room<=0)return false;
 // metal creases instead of bending in one smooth bowl: each point gives a bit more or less than its neighbours
 const crease=.7+.6*((Math.sin(ox*127.1+oy*311.7+oz*74.7)*43758.5)%1+1)%1;
 const len=Math.hypot(_dp.x,_dp.z)||1,k=amount*(1-d/DENT_R)**2*room*.55*crease;
 out[0]=-_dp.x/len*k;out[1]=-k*.25;out[2]=-_dp.z/len*k;return true};
const _dv=[0,0,0];
function dentCar(c,wx,wy,wz,amount){
 c.body.updateWorldMatrix(true,true);_dp.set(wx,wy,wz);c.body.worldToLocal(_dp);
 shareDamage(c,'dent',amount);
 // a knock on a corner bends the steering towards that side, the front much more than the back
 if(c===player.car)player.bend=clamp((player.bend||0)-Math.sign(_dp.x)*amount*(_dp.z>0?.35:.12),-1,1);
 {const rc=cars.find(k=>k.car===c);if(rc)breakParts(rc,_dp.x,_dp.z,amount)}
 panelHit(c,_dp,amount);
 for(const m of c.dents){
  const pos=m.geometry.attributes.position,a=pos.array,o=m.geometry.userData.orig;
  let hit=false;
  for(let i=0;i<a.length;i+=3)if(dentPush(a[i],a[i+1],a[i+2],o[i],o[i+1],o[i+2],amount,_dv)){a[i]+=_dv[0];a[i+1]+=_dv[1];a[i+2]+=_dv[2];hit=true}
  if(hit){pos.needsUpdate=true;m.geometry.computeVertexNormals()}
 }
 for(const o of c.parts){if(o.userData.off)continue;const p=o.position,q=o.userData.p0;
  if(dentPush(p.x,p.y,p.z,q.x,q.y,q.z,amount,_dv)){p.set(p.x+_dv[0],p.y+_dv[1],p.z+_dv[2]);
   // pushed far enough by a hard hit, lights, mirrors, the wing and trim come off
   if(amount>.4&&p.distanceTo(q)>.13&&Math.random()<.55)detachPart(c,o)}}
}
// body panels: every hit adds to the panel it lands on (from the same numbers on every screen online, so all see the
// same car); past its limit the panel tears off and flies, and the hole shows the dark inside (engine bay, door frame)
const PANEL_LIMIT={bumper:.7,hood:.95,doorL:1,doorR:1,wing:.6},PANEL_GROUP={hood:2,bumper:3,doorL:4,doorR:5};
const cavityMat=new THREE.MeshStandardMaterial({color:0x1a1c1f,roughness:.85,metalness:.2,side:THREE.DoubleSide});
function panelHit(c,p,a){
 if(a<.12||!c.pHit)return;const M=c.M,zn=p.z/(c.len/2);let id=null;
 if(zn>.4)id=zn<.9&&p.y>M.beltF(p.z/c.len)-.06?'hood':'bumper';
 else if(zn<-.72)id='wing';
 else if(Math.abs(p.x)>c.half*.55)id=p.x>0?'doorR':'doorL';
 if(!id||c.pOff[id])return;c.pHit[id]=(c.pHit[id]||0)+a;
 if(c.pHit[id]>=PANEL_LIMIT[id])detachPanel(c,id);
}
const _pq=new THREE.Quaternion(),_ps=new THREE.Vector3(),_pp=new THREE.Vector3();
function flyOff(c,geo,mat,kick){
 // centre the piece on itself so it tumbles about its own middle, then launch it from where it sat
 geo.computeBoundingBox();const ctr=geo.boundingBox.getCenter(new THREE.Vector3());geo.translate(-ctr.x,-ctr.y,-ctr.z);
 const m=new THREE.Mesh(geo,mat);m.castShadow=true;m.userData.shard=true;
 c.body.updateWorldMatrix(true,false);c.body.matrixWorld.decompose(_pp,_pq,_ps);m.quaternion.copy(_pq);m.position.copy(ctr).applyMatrix4(c.body.matrixWorld);scene.add(m);
 const rc=cars.find(k=>k.car===c),vx=rc?(rc===player?rc.vx:Math.sin(rc.angle)*rc.v):0,vz=rc?(rc===player?rc.vz:Math.cos(rc.angle)*rc.v):0;
 const ox=m.position.x-c.g.position.x,oz=m.position.z-c.g.position.z,ol=Math.hypot(ox,oz)||1;
 debris.push({o:m,ground:rc?.gy||0,v:new THREE.Vector3(vx*.7+ox/ol*rand(2,5)*kick,rand(2.5,5)*kick,vz*.7+oz/ol*rand(2,5)*kick),w:new THREE.Vector3(rand(-9,9),rand(-9,9),rand(-9,9))});
}
function detachPanel(c,id){
 if(c.pOff[id])return;c.pOff[id]=true;
 if(id==='wing'){for(const o of c.wingParts){if(o.userData.off||!o.visible)continue;o.visible=false;
   o.updateWorldMatrix(true,false);const geo=o.geometry.clone().applyMatrix4(new THREE.Matrix4().copy(c.body.matrixWorld).invert().multiply(o.matrixWorld));flyOff(c,geo,o.material,1)}
  const rc=cars.find(k=>k.car===c);if(rc?.sys)rc.sys.aero=Math.max(rc.sys.aero,.9);if(c===player.car&&c.wingParts.length)toast('REAR WING GONE','#ff9a3a',1.4);return}
 if(!c.shell)return;
 // copy the panel's triangles as they are now (dents and all) into a loose piece, and paint the hole dark
 const g=c.shell.geometry,gr=g.groups.find(x=>x.materialIndex===PANEL_GROUP[id]);if(!gr||!gr.count)return;
 const idx=g.index.array,pa=g.attributes.position.array,pos=new Float32Array(gr.count*3);
 for(let i=0;i<gr.count;i++){const v=idx[gr.start+i];pos[i*3]=pa[v*3];pos[i*3+1]=pa[v*3+1];pos[i*3+2]=pa[v*3+2]}
 const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(pos,3));geo.computeVertexNormals();
 c.shell.material[PANEL_GROUP[id]]=cavityMat;flyOff(c,geo,c.paint,id==='bumper'?1.3:1);
 if(c===player.car)toast({hood:'BONNET',bumper:'FRONT BUMPER',doorL:'LEFT DOOR',doorR:'RIGHT DOOR'}[id]+' GONE','#ff9a3a',1.4);
}
function restorePanels(c){
 if(c.shell)for(const k in PANEL_GROUP)c.shell.material[PANEL_GROUP[k]]=c.paint;
 for(const o of c.wingParts||[])o.visible=true;c.pHit={};c.pOff={};
}
// a part that came off flies on with the car's speed plus a kick away from it, tumbles, bounces and stays on the track
const debris=[],_dq=new THREE.Quaternion(),_de=new THREE.Euler();
function detachPart(c,o,kick=1){
 const rc=cars.find(k=>k.car===c),vx=rc?(rc===player?rc.vx:Math.sin(rc.angle)*rc.v):0,vz=rc?(rc===player?rc.vz:Math.cos(rc.angle)*rc.v):0;
 const p=new THREE.Vector3(),q=new THREE.Quaternion(),sc=new THREE.Vector3();o.updateWorldMatrix(true,false);o.matrixWorld.decompose(p,q,sc);
 o.userData.off={parent:o.parent,q:o.quaternion.clone(),s:o.scale.clone()};
 scene.add(o);o.position.copy(p);o.quaternion.copy(q);o.scale.copy(sc);
 const ox=p.x-c.g.position.x,oz=p.z-c.g.position.z,ol=Math.hypot(ox,oz)||1;
 debris.push({o,ground:rc?.gy||0,v:new THREE.Vector3(vx*.75+ox/ol*rand(2,5)*kick,rand(2,4.5)*kick,vz*.75+oz/ol*rand(2,5)*kick),w:new THREE.Vector3(rand(-10,10),rand(-10,10),rand(-10,10))});
 if(debris.length>80)reattach(debris[0].o);
}
// bits of bodywork that only exist once a car blows up: painted panels, black plastic, glass
const shardGeo=[new THREE.BoxGeometry(.5,.04,.35),new THREE.BoxGeometry(.3,.03,.6),new THREE.BoxGeometry(.25,.25,.06),new THREE.TetrahedronGeometry(.22)];
const shardDark=new THREE.MeshStandardMaterial({color:0x151515,roughness:.7}),shardGlass=new THREE.MeshStandardMaterial({color:0x223040,metalness:.4,roughness:.1,transparent:true,opacity:.7});
function shard(c){
 const r=Math.random(),mat=r<.55?c.car.paint:r<.85?shardDark:shardGlass,m=new THREE.Mesh(shardGeo[Math.random()*shardGeo.length|0],mat);
 m.position.set(c.x+rand(-1,1),.8+(c.gy||0),c.z+rand(-1,1));m.rotation.set(rand(0,6),rand(0,6),rand(0,6));m.castShadow=true;m.userData.shard=true;scene.add(m);
 const a=rand(0,Math.PI*2),sp=rand(5,14);
 debris.push({o:m,ground:c.gy||0,v:new THREE.Vector3(Math.cos(a)*sp,rand(3,9),Math.sin(a)*sp),w:new THREE.Vector3(rand(-14,14),rand(-14,14),rand(-14,14))});
}
function clearShards(){for(let i=debris.length-1;i>=0;i--)if(debris[i].o.userData.shard){scene.remove(debris[i].o);debris.splice(i,1)}}
function reattach(o){const h=o.userData.off;if(!h)return;h.parent.add(o);o.position.copy(o.userData.p0);o.quaternion.copy(h.q);o.scale.copy(h.s);o.userData.off=null;
 const i=debris.findIndex(d=>d.o===o);if(i>=0)debris.splice(i,1)}
function updateDebris(dt){
 for(const d of debris){if(d.rest)continue;d.v.y-=9.81*dt;d.o.position.addScaledVector(d.v,dt);
  d.o.quaternion.multiply(_dq.setFromEuler(_de.set(d.w.x*dt,d.w.y*dt,d.w.z*dt)));
  if(d.o.position.y<d.ground+.06){d.o.position.y=d.ground+.06;
   if(Math.abs(d.v.y)<1.5&&Math.hypot(d.v.x,d.v.z)<1.2){d.rest=true;continue}
   d.v.y*=-.3;d.v.x*=.55;d.v.z*=.55;d.w.multiplyScalar(.55)}}
}
// our own car (and on the host, the bots): tell everyone else, in the car's own coordinates
let sharing=true;const dentSent={};
function shareDamage(c,kind,amount){
 if(!mp.on||!sharing||!mp.racing)return;
 const rc=cars.find(k=>k.car===c);if(!rc||rc.remote||(rc!==player&&!mp.host))return;
 const key=carKey(rc),now=performance.now();
 if(kind==='dent'){if(amount<.05||now-(dentSent[key]||0)<70)return;dentSent[key]=now;
  mpSend({t:'dent',id:mp.id,car:key,p:[+_dp.x.toFixed(2),+_dp.y.toFixed(2),+_dp.z.toFixed(2)],a:+amount.toFixed(2)})}
 else mpSend({t:kind,id:mp.id,car:key});
}
const _rp=new THREE.Vector3();
function remoteDamage(m){
 if(m.car===mp.id)return;
 const rc=carByKey(m.car);if(!rc)return;
 if(!mp.host&&!rc.remote&&!String(m.car).startsWith('bot:'))return;
 sharing=false;
 try{
  if(m.t==='dent'&&Array.isArray(m.p)){rc.car.body.updateWorldMatrix(true,true);_rp.set(+m.p[0],+m.p[1],+m.p[2]);rc.car.body.localToWorld(_rp);
   if(isFinite(_rp.x+_rp.y+_rp.z))dentCar(rc.car,_rp.x,_rp.y,_rp.z,clamp(+m.a||0,0,1))}
  else if(m.t==='boom')boomVisual(rc);
  else if(m.t==='fix')repairCar(rc.car);
 }finally{sharing=true}
}
function repairCar(c){
 restorePanels(c);
 for(const m of c.dents){m.geometry.attributes.position.array.set(m.geometry.userData.orig);m.geometry.attributes.position.needsUpdate=true;m.geometry.computeVertexNormals()}
 for(const o of c.parts){if(o.userData.off)reattach(o);o.position.copy(o.userData.p0)}
 if(c.paint?.userData.col){c.paint.color.copy(c.paint.userData.col);c.paint.roughness-=.5;c.paint.userData.col=null}
}
function animateCar(c,dt,speed,steer,roll,pitch,boosting,braking){
 c.spinners.forEach(s=>s.rotation.x+=speed*dt/c.wheelR);
 c.steerers.forEach(p=>p.rotation.y+=(-steer*.45-p.rotation.y)*Math.min(1,dt*12));
 c.body.rotation.z+=(roll-c.body.rotation.z)*Math.min(1,dt*6);
 c.body.rotation.x+=(pitch-c.body.rotation.x)*Math.min(1,dt*6);
 c.flames.forEach(f=>{f.visible=boosting;if(boosting){const s=rand(.8,1.4);f.scale.set(1,s,1);f.position.z=f.userData.z0-.35*s}});
 c.flameMat.color.setHSL(rand(.52,.58),1,.6);
 c.tailMat.emissiveIntensity=braking?3:.6;
}

const player={car:makeCar(COLORS[0],1),name:NAMES[0],color:COLORS[0],x:0,z:0,angle:0,vx:0,vz:0,yaw:0,tyF:0,tyR:0,steer:0,nitro:0,dist:0,s:0,idx:0,lat:0,
 finished:false,finishTime:0,lapStart:0,laps:[],drift:0,driftScore:0,wrong:0,lastF:0,lastR:0,accF:0,accR:0,damage:0};
scene.add(player.car.g);
const headlight=new THREE.SpotLight(0xfff2d0,0,90,.55,.5,1.2);headlight.position.set(0,1,1.8);
headlight.target.position.set(0,0,25);
// ---------- garage save ----------
// money, wins and every car's colour / parts / upgrade levels, kept in localStorage
const PAINTS=[0xa3c4ad,0xf2c21b,0x1f3fbf,0xd42020,0x16181c,0xf2f4f7,0x8a8f96,0xff7a1a,0x28c76f,0x0e7a6e,0x6a2cff,0xff4fb8,0x18d6e8,0x8a0f1e,0x0e3b2a,0xc9a043,0x3a4552];
// [key, name, icon, what it does, cost factor]
const UPGRADES=[['engine','Engine','<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>','More power: top speed and acceleration',1.2],['turbo','Turbo','<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 12c0-3 3-4.5 5-2.5M12 12c3 0 4.5 3 2.5 5M12 12c0 3-3 4.5-5 2.5M12 12c-3 0-4.5-3-2.5-5"/></svg>','Harder pull out of corners, stronger nitro',1.1],
 ['nitro','Nitro','<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>','Faster and longer-lasting boost',.8],['tires','Tires','<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/></svg>','More grip, much better in the rain',.9],['brakes','Brakes','<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M15 3.6a9 9 0 0 1 5.4 5.4"/><path d="M14 7.5h.01M16.5 12h.01M14 16.5h.01M9.5 16.5h.01M7.5 12h.01M9.5 7.5h.01"/></svg>','Brake later into corners',.7],
 ['susp','Suspension','<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v3M12 19v3M7 5h10M7 19h10M8 8h8l-8 4h8l-8 4h8"/></svg>','Sharper steering and more downforce',.8],['weight','Weight reduction','<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8h12l2 13H4zM9.5 8a2.5 2.5 0 1 1 5 0"/></svg>','Lighter car: quicker, brakes and turns better',1]];
const STOCK={engine:0,turbo:0,nitro:0,tires:0,brakes:0,susp:0,weight:0,spoiler:2,gearing:0,balance:0};
const garage=(()=>{
 const g=Object.assign({money:0,wins:0,races:0,sel:0,cars:[]},vault.get('kod-save')||{});
 MODELS.forEach((m,i)=>{const c=g.cars[i]=Object.assign({color:[0xf2c21b,0xa3c4ad,0xf2f4f7,0xd42020,0x16181c,0x8a8f96,0x28c76f,0xf4f6f8][i],rims:[1,1,2,3,1,0,1,3][i],spoiler:[1,0,1,2,1,1,1,0][i],finish:[0,1,0,1,0,1,1,0][i],caliper:[0,0,1,2,0,1,1,2][i],gearing:0,balance:i===2?40:0},g.cars[i]||{});
  for(const k of ['rims','spoiler'])c[k]=clamp(c[k]|0,0,3);
  c.finish=clamp(c.finish|0,0,2);c.caliper=clamp(c.caliper|0,0,CALIPERS.length-1);
  c.gearing=clamp(c.gearing|0,-100,100);c.balance=clamp(c.balance|0,-100,100);
  for(const [k] of UPGRADES)c[k]=clamp(c[k]|0,0,5)});
 g.money=Math.max(0,g.money|0);g.wins=Math.max(0,g.wins|0);
 if(!(g.sel>=0&&g.sel<MODELS.length)||g.wins<MODELS[g.sel].wins)g.sel=0;
 return g;
})();
const saveGarage=()=>vault.set('kod-save',garage);
const unlocked=i=>garage.wins>=MODELS[i].wins;
const setupCfg=(i,c)=>ctl.set_setup(i,c.engine,c.turbo,c.nitro,c.tires,c.brakes,c.susp,c.weight,c.spoiler,c.gearing,c.balance);
const setupCar=i=>setupCfg(i,garage.cars[i]);
const carOpts=i=>{const c=garage.cars[i];return {model:i,rims:c.rims,spoiler:c.spoiler,finish:c.finish,caliper:CALIPERS[c.caliper]}};
// the player's paint reflects the real surroundings: a small cube map refreshed every few frames
const carCube=HIGH?new THREE.WebGLCubeRenderTarget(128,{type:THREE.HalfFloatType}):null;
const carCubeCam=carCube?new THREE.CubeCamera(.5,700,carCube):null;
let cubeTick=0;
function updateCarReflection(force){
 if(!carCubeCam||++cubeTick%6&&!force)return;
 const g=player.car.g;g.visible=false;carCubeCam.position.set(g.position.x,1.1,g.position.z);carCubeCam.update(renderer,scene);g.visible=true;
}
function buildPlayerCar(){
 const i=garage.sel,c=garage.cars[i];
 scene.remove(player.car.g);
 player.car=makeCar(c.color,1,carOpts(i));player.color=c.color;
 if(carCube){player.car.paint.envMap=carCube.texture;player.car.paint.envMapIntensity=1.1}
 player.car.g.add(headlight,headlight.target);
 player.car.headMat.emissiveIntensity=1.2+TOD[settings.tod].night*3;
 player.car.g.position.set(player.x,0,player.z);player.car.g.rotation.y=player.angle;
 scene.add(player.car.g);
}

const bots=[1,2,3].map(k=>{const c=makeCar(COLORS[k],k+1,{model:[5,1,6][k-1],rims:[0,1,2][k-1],spoiler:[1,0,1][k-1],finish:1});scene.add(c.g);
 return {car:c,name:NAMES[k],color:COLORS[k],dist:0,lat:0,laneT:0,v:0,skill:1,offset:0,laneTimer:0,finished:false,finishTime:0,boost:0,x:0,z:0,angle:0,steer:0,damage:0}});
// everyone in the current race: the player, friends online (remote) and the bots filling the grid
const cars=[player,...bots];
let raceBots=bots;
function setRoster(remotes,nBots){
 for(const c of cars)if(c.remote&&!remotes.includes(c))scene.remove(c.car.g);
 raceBots=bots.slice(0,nBots);bots.forEach((b,k)=>b.car.g.visible=k<nBots);
 cars.length=0;cars.push(player,...remotes,...raceBots);
}

// bot speed profile: corner speed limit, propagated backwards for braking
function speedProfile(latAcc,top,dec){
 const v=KS.map(k=>Math.min(top,Math.sqrt(latAcc/Math.max(Math.abs(k),1e-4))));
 for(let pass=0;pass<2;pass++)for(let i=N-1;i>=0;i--){const j=(i+1)%N;v[i]=Math.min(v[i],Math.sqrt(v[j]*v[j]+2*dec*DS))}
 return v;
}
const DIFF=[{lat:16,top:32,skill:[.86,.92]},{lat:20,top:38,skill:[.93,.98]},{lat:25,top:43,skill:[.98,1.03]}];
let botProfile=null,botTop=0;

// ---------- particles, skid marks ----------
const particles=[];
// smoke and dust: a soft puff with ragged, uneven edges (several blobs and noise), not a smooth round ball
const smokeTex=canvasTex(128,128,(g,w,h)=>{
 paintPixels(g,w,h,(x,y)=>{const dx=(x-64)/64,dy=(y-64)/64,r=Math.hypot(dx,dy),n=fbm(x/22,y/22,4,7.7),a=Math.max(0,1-r*(1.15-.5*n))**1.6*(.55+.6*n);return [255,255,255,Math.min(255,a*255)]})},false);
for(let i=0;i<280;i++){const s=new THREE.Sprite(new THREE.SpriteMaterial({map:glowTex,transparent:true,depthWrite:false,opacity:0}));s.visible=false;s.layers.set(1);noAO.push(s);scene.add(s);particles.push({s,life:0,max:1,vx:0,vy:0,vz:0,grow:0})}
let pi=0;
function emit(x,y,z,vx,vy,vz,life,size,grow,color,additive=false){
 const p=particles[pi=(pi+1)%particles.length],m=p.s.material;
 p.s.position.set(x,y,z);p.s.scale.set(size,size,1);p.s.visible=true;m.color.set(color);
 m.blending=additive?THREE.AdditiveBlending:THREE.NormalBlending;m.map=additive?glowTex:smokeTex;m.rotation=rand(0,6.28);p.spin=rand(-.6,.6);p.smoke=!additive;
 Object.assign(p,{life,max:life,vx,vy,vz,grow});
}
function updateParticles(dt){
 for(const p of particles){if(!p.s.visible)continue;p.life-=dt;if(p.life<=0){p.s.visible=false;continue}
  p.s.position.x+=p.vx*dt;p.s.position.y+=p.vy*dt;p.s.position.z+=p.vz*dt;
  const sc=p.s.scale.x+p.grow*dt;p.s.scale.set(sc,sc,1);
  // smoke fades in, then thins out as it spreads; sparks just fade
  if(p.smoke){p.s.material.rotation+=p.spin*dt;p.vx*=1-dt*.8;p.vz*=1-dt*.8;p.s.material.opacity=Math.min(1,(p.max-p.life)/.12)*(p.life/p.max)**1.3*.5}else p.s.material.opacity=(p.life/p.max)*.6}
}
const SKIDS=1600;
const skidGeo=new THREE.PlaneGeometry(1,1);skidGeo.rotateX(-Math.PI/2);
const skids=new THREE.InstancedMesh(skidGeo,new THREE.MeshBasicMaterial({color:0x0c0c0c,transparent:true,opacity:.55,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-5}),SKIDS);
skids.frustumCulled=false;scene.add(skids);
let skidI=0;
const _m=new THREE.Matrix4(),_q=new THREE.Quaternion(),_v=new THREE.Vector3(),_s=new THREE.Vector3(),_up=new THREE.Vector3(0,1,0);
function clearSkids(){_m.makeScale(0,0,0);for(let i=0;i<SKIDS;i++)skids.setMatrixAt(i,_m);skids.instanceMatrix.needsUpdate=true}
clearSkids();
function skid(x,z,angle,len,y=0){
 _q.setFromAxisAngle(_up,angle);_m.compose(_v.set(x,.11+y,z),_q,_s.set(.32,1,len+.05));
 skids.setMatrixAt(skidI=(skidI+1)%SKIDS,_m);skids.instanceMatrix.needsUpdate=true;
}

// ---------- rain ----------
// wet road reflects a blurred copy of the sky
const pmrem=new THREE.PMREMGenerator(renderer);
const envScene=new THREE.Scene();
envScene.add(new THREE.Mesh(sky.geometry,skyMat));
let envRT=null;
function skyEnv(){
 if(envRT)envRT.dispose();
 envRT=pmrem.fromScene(envScene,0,1,3000);
 return envRT.texture;
}
// falling rain: every drop is a thin streak worked out on the GPU. drops sit in a box that wraps round the
// camera, fall at a raindrop's real speed and drift with the wind; each is stretched along its speed as
// seen from the car (motion blur), so at 200 km/h the rain comes at you instead of falling
const RAIN_N=HIGH?9000:4500,RAIN_R=40,RAIN_H=24;
const rainU={uTime:{value:0},uVel:{value:new THREE.Vector2()},uWind:{value:new THREE.Vector2(1.8,.7)},uLight:{value:1},uFlash:{value:0},uGround:{value:0}};
const quadAttr=()=>{const g=new THREE.InstancedBufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute([-.5,0,0,.5,0,0,.5,1,0,-.5,1,0],3));g.setIndex([0,1,2,0,2,3]);return g};
const seeds=n=>{const a=new Float32Array(n*4);for(let i=0;i<a.length;i++)a[i]=Math.random();return new THREE.InstancedBufferAttribute(a,4)};
const rainGeo=quadAttr();rainGeo.setAttribute('seed',seeds(RAIN_N));rainGeo.instanceCount=RAIN_N;
const rainMat=new THREE.ShaderMaterial({uniforms:rainU,transparent:true,depthWrite:false,
 vertexShader:`attribute vec4 seed;uniform float uTime;uniform vec2 uVel,uWind;varying float vA,vX,vY;
 const vec3 BOX=vec3(${2*RAIN_R}.,${RAIN_H}.,${2*RAIN_R}.);
 void main(){
  float speed=8.+seed.w*2.5;
  vec3 w=seed.xyz*BOX+vec3(uWind.x,-speed,uWind.y)*uTime;
  vec3 lo=cameraPosition-vec3(${RAIN_R}.,${RAIN_H}.*.35,${RAIN_R}.),pos=lo+mod(w-lo,BOX);
  vec3 rv=vec3(uWind.x-uVel.x,-speed,uWind.y-uVel.y),dir=normalize(rv);
  float len=clamp(length(rv)*.04,.3,2.4)*(.7+.6*seed.w),dist=distance(cameraPosition,pos);
  vec3 side=normalize(cross(dir,normalize(cameraPosition-pos)))*(.012+dist*.0017);
  vec3 wp=pos+side*position.x*2.-dir*len*position.y;
  vA=(1.-smoothstep(${RAIN_R}.*.55,${RAIN_R}.,length(pos.xz-cameraPosition.xz)))*smoothstep(.4,2.5,dist);vX=position.x;vY=position.y;
  gl_Position=projectionMatrix*viewMatrix*vec4(wp,1.);
 }`,
 fragmentShader:`uniform float uLight,uFlash;varying float vA,vX,vY;
 void main(){float a=(1.-abs(vX*2.))*(.3+.7*(1.-vY))*vA;gl_FragColor=vec4(vec3(.74,.79,.86)*uLight+uFlash,a*.5);}`});
const rain=new THREE.Mesh(rainGeo,rainMat);rain.frustumCulled=false;rain.visible=false;rain.renderOrder=3;scene.add(rain);noAO.push(rain);
// splashes: each one a ring spreading on the ground plus a little crown of droplets, born again somewhere
// else near the camera every time its life runs out
const SPL_N=HIGH?1600:800,SPL_R=24;
const splashGeo=quadAttr();splashGeo.setAttribute('seed',seeds(SPL_N));splashGeo.instanceCount=SPL_N;
const splashMat=new THREE.ShaderMaterial({uniforms:rainU,transparent:true,depthWrite:false,
 vertexShader:`attribute vec4 seed;uniform float uTime,uGround;varying vec2 vUv;varying float vP,vCrown;
 float h1(float n){return fract(sin(n)*43758.5453);}
 void main(){
  float life=.42+seed.z*.2,t=uTime/life+seed.w,cyc=floor(t);vP=fract(t);
  float crown=step(.5,seed.y);vCrown=crown;
  vec2 c=cameraPosition.xz+(vec2(h1(cyc*12.9898+seed.x*78.233),h1(cyc*39.346+seed.y*11.135))-.5)*${2*SPL_R}.;
  vec3 wp;
  if(crown<.5){float r=mix(.05,.38,sqrt(vP));wp=vec3(c.x+position.x*2.*r,uGround+.07,c.y+(position.y*2.-1.)*r);}
  else{vec3 rt=normalize(vec3(viewMatrix[0][0],0.,viewMatrix[2][0]));float s=.16*(.6+seed.z);
   wp=vec3(c.x,uGround+.06,c.y)+rt*position.x*s+vec3(0.,position.y*s*.9,0.);}
  vUv=vec2(position.x+.5,position.y);gl_Position=projectionMatrix*viewMatrix*vec4(wp,1.);
 }`,
 fragmentShader:`uniform float uLight,uFlash;varying vec2 vUv;varying float vP,vCrown;
 void main(){float a;
  if(vCrown<.5){float d=length(vUv*2.-1.);a=smoothstep(.55,.8,d)*smoothstep(1.,.86,d)*pow(1.-vP,1.3)*.85;}
  else{if(vP>.32)discard;float k=vP/.32;a=0.;
   for(int i=0;i<5;i++){float fi=float(i),x=.5+(fi-2.)*.13*(.4+k),y=.15+sin(3.1416*(.15+.17*fi))*.75*k*(1.-k*.5);
    a+=smoothstep(.07,.02,length((vUv-vec2(x,y))*vec2(1.,.8)));}
   a=min(a,1.)*(1.-k)*.7;}
  gl_FragColor=vec4(vec3(.78,.83,.9)*uLight+uFlash,a);}`});
const splashes=new THREE.Mesh(splashGeo,splashMat);splashes.frustumCulled=false;splashes.visible=false;splashes.renderOrder=2;scene.add(splashes);noAO.push(splashes);
// the road's own rain: puddles in the dips that turn into mirrors, rings rippling across them
const roadWet={uWet:{value:0},uRainT:rainU.uTime};
function updateRain(dt){
 if(!rain.visible)return;
 rainU.uTime.value+=dt;
 const pl=player;rainU.uVel.value.set(state==='race'||state==='finished'?pl.vx:0,state==='race'||state==='finished'?pl.vz:0);
 rainU.uGround.value=pl.gy||0;
}

// ---------- audio ----------
const audio={ctx:null,muted:!!store.get('kod-muted')};
const masterVol=()=>audio.muted?0:.6*(settings.vol??80)/100;
function initAudio(){
 if(audio.ctx){audio.ctx.resume();return}
 const C=window.AudioContext||window.webkitAudioContext;if(!C)return;
 const ctx=audio.ctx=new C();
 const master=audio.master=ctx.createGain();master.gain.value=masterVol();master.connect(ctx.destination);
 const noise=ctx.createBuffer(1,ctx.sampleRate*2,ctx.sampleRate),d=noise.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;audio.noise=noise;
 const eg=audio.engineGain=ctx.createGain();eg.gain.value=0;
 const ef=audio.engineFilter=ctx.createBiquadFilter();ef.type='lowpass';ef.frequency.value=900;ef.Q.value=4;
 audio.o1=ctx.createOscillator();audio.o1.type='sawtooth';audio.o2=ctx.createOscillator();audio.o2.type='square';audio.o2.detune.value=-1200;
 const o2g=ctx.createGain();o2g.gain.value=.5;
 audio.o1.connect(ef);audio.o2.connect(o2g).connect(ef);ef.connect(eg).connect(master);audio.o1.start();audio.o2.start();
 const loopNoise=(type,f,q)=>{const s=ctx.createBufferSource();s.buffer=noise;s.loop=true;const fl=ctx.createBiquadFilter();fl.type=type;fl.frequency.value=f;fl.Q.value=q;const g=ctx.createGain();g.gain.value=0;s.connect(fl).connect(g).connect(master);s.start();return g};
 audio.skid=loopNoise('bandpass',1400,3);audio.wind=loopNoise('highpass',700,.7);audio.rumble=loopNoise('lowpass',300,1);
 audio.rain=loopNoise('bandpass',2600,.4);
 // the limp-mode rasp: the engine tone clipped hard and band-passed, plus a low choking noise
 const ws=ctx.createWaveShaper(),curve=new Float32Array(1024);for(let i=0;i<1024;i++){const x=i/511.5-1;curve[i]=Math.tanh(x*9)*(.8+.2*Math.sin(x*40))}ws.curve=curve;
 const rf=ctx.createBiquadFilter();rf.type='bandpass';rf.frequency.value=650;rf.Q.value=1.4;audio.rasp=ctx.createGain();audio.rasp.gain.value=0;
 audio.o1.connect(ws);ws.connect(rf).connect(audio.rasp).connect(master);
 audio.choke=loopNoise('bandpass',170,2.5);
}
// exhaust pops: short bursts of filtered noise
function pops(n){if(!audio.ctx)return;const c=audio.ctx;
 for(let i=0;i<n;i++){const t=c.currentTime+i*rand(.05,.12),s=c.createBufferSource(),f=c.createBiquadFilter(),g=c.createGain();s.buffer=audio.noise;f.type='bandpass';f.frequency.value=rand(500,1300);f.Q.value=1.3;
  g.gain.setValueAtTime(rand(.35,.6),t);g.gain.exponentialRampToValueAtTime(.001,t+.08);s.connect(f).connect(g).connect(audio.master);s.start(t,rand(0,1.5),.1)}}
function setMuted(m){audio.muted=m;store.set('kod-muted',m);if(audio.master)audio.master.gain.value=masterVol();syncSettings()}
setMuted(audio.muted);
function beep(f,dur=.18,vol=.3,type='square'){if(!audio.ctx)return;const c=audio.ctx,o=c.createOscillator(),g=c.createGain();o.type=type;o.frequency.value=f;
 g.gain.setValueAtTime(vol,c.currentTime);g.gain.exponentialRampToValueAtTime(.001,c.currentTime+dur);o.connect(g).connect(audio.master);o.start();o.stop(c.currentTime+dur)}
function thud(vol){if(pad.on)rumble(vol);if(!audio.ctx)return;const c=audio.ctx,s=c.createBufferSource(),f=c.createBiquadFilter(),g=c.createGain();s.buffer=audio.noise;f.type='lowpass';f.frequency.value=500;
 g.gain.setValueAtTime(Math.min(1,vol),c.currentTime);g.gain.exponentialRampToValueAtTime(.001,c.currentTime+.35);s.connect(f).connect(g).connect(audio.master);s.start();s.stop(c.currentTime+.4)}
function whoosh(){if(!audio.ctx)return;const c=audio.ctx,s=c.createBufferSource(),f=c.createBiquadFilter(),g=c.createGain();s.buffer=audio.noise;f.type='bandpass';f.Q.value=2;
 f.frequency.setValueAtTime(400,c.currentTime);f.frequency.exponentialRampToValueAtTime(3000,c.currentTime+.5);g.gain.setValueAtTime(.5,c.currentTime);g.gain.exponentialRampToValueAtTime(.001,c.currentTime+.6);
 s.connect(f).connect(g).connect(audio.master);s.start();s.stop(c.currentTime+.6)}
function thunder(){if(!audio.ctx)return;const c=audio.ctx,t=c.currentTime,s=c.createBufferSource(),f=c.createBiquadFilter(),g=c.createGain();s.buffer=audio.noise;s.loop=true;f.type='lowpass';
 f.frequency.setValueAtTime(400,t);f.frequency.exponentialRampToValueAtTime(70,t+2.5);g.gain.setValueAtTime(.001,t);g.gain.exponentialRampToValueAtTime(.9,t+.08);g.gain.exponentialRampToValueAtTime(.001,t+3);
 s.connect(f).connect(g).connect(audio.master);s.start();s.stop(t+3.1)}
// gear bands in m/s for a car with a 40 m/s top speed; gearScale stretches them for faster cars
const GEARS=[0,9,16,23,30,37,46];
let gearScale=1;
function gearOf(v){v/=gearScale;let g=1;while(g<GEARS.length-1&&v>GEARS[g])g++;return g}
function rpmOf(v){const g=gearOf(v);v/=gearScale;return clamp((v-GEARS[g-1])/(GEARS[g]-GEARS[g-1]),0,1)}
function updateAudio(speed,throttle,boost,drift,grass,limp){
 if(!audio.ctx)return;const t=audio.ctx.currentTime,v=Math.abs(speed),g=gearOf(v);
 const rpm=rpmOf(v);
 // limp mode: lower, rough and choking: a distorted layer, a sputtering level and a dull filter
 const f=(55+rpm*95+g*10+(boost?25:0)+(throttle&&v<1?40:0))*(limp?.74:1);
 audio.o1.frequency.setTargetAtTime(f,t,.05);audio.o2.frequency.setTargetAtTime(f,t,.05);
 audio.engineFilter.frequency.setTargetAtTime((500+rpm*900+(throttle?700:0))*(limp?.55:1),t,.08);
 audio.engineGain.gain.setTargetAtTime(state==='menu'?0:(throttle?.22:.13)*(limp?.55+Math.random()*.45:1),t,limp?.02:.1);
 audio.rasp.gain.setTargetAtTime(limp&&state!=='menu'?(throttle?.11:.06)*(.5+Math.random()*.5):0,t,.03);
 audio.choke.gain.setTargetAtTime(limp&&state!=='menu'?Math.random()*.25:0,t,.02);
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
const typing=e=>e.target&&(e.target.tagName==='INPUT'&&e.target.type!=='range'||e.target.isContentEditable);
addEventListener('keydown',e=>{
 if(typing(e)){if(e.code==='Enter'&&e.target.id==='mpcode')mpJoin();return}
 const cmd=sendKey(e,true);if(cmd<0)return;
 e.preventDefault();
 if(cmd===CMD.camera){camMode=(camMode+1)%3;store.set('kod-cam',camMode);syncSettings();toast(['CAMERA: CHASE','CAMERA: FAR','CAMERA: HOOD'][camMode])}
 if(cmd===CMD.mute)setMuted(!audio.muted);
 if(cmd===CMD.respawn&&state==='race')respawn();
 if(cmd===CMD.pause){if(state==='garage')closeGarage();else togglePause()}
 if(cmd===CMD.start&&state==='menu'&&!mp.on&&['race','results'].includes(hubPanel))startRace();
 else if(cmd===CMD.start&&state==='replay')endReplay();
});
addEventListener('keyup',e=>{if(!typing(e)&&sendKey(e,false)>=0)e.preventDefault()});
addEventListener('blur',()=>ctl.release_all());
document.querySelectorAll('[data-key]').forEach(b=>{
 const k=b.dataset.key;
 const on=e=>{e.preventDefault();keys[k]=true;b.classList.add('on')},off=e=>{e.preventDefault();keys[k]=false;b.classList.remove('on')};
 b.addEventListener('pointerdown',on);b.addEventListener('pointerup',off);b.addEventListener('pointercancel',off);b.addEventListener('pointerleave',off);
 b.addEventListener('contextmenu',e=>e.preventDefault());
});
// ---------- game pad ----------
// any standard controller. driving: left stick or d-pad steers, RT gas, LT brake / reverse (both analogue),
// A handbrake, B or RB nitro, Y camera, X back on track, Start pause. menus: d-pad / stick move between
// buttons, A presses, B goes back. it rumbles when you crash.
const pad={steer:0,gas:0,brake:0,on:false,prev:[],held:{},navT:0,focus:null};
const PB={A:0,B:1,X:2,Y:3,LB:4,RB:5,LT:6,RT:7,BACK:8,START:9,UP:12,DOWN:13,LEFT:14,RIGHT:15};
addEventListener('gamepadconnected',e=>{toast('CONTROLLER CONNECTED','#5fe08a',1.6);if(!pad.on){pad.on=true;requestAnimationFrame(padLoop)}});
addEventListener('gamepaddisconnected',()=>{if(![...navigator.getGamepads()].some(g=>g&&g.connected)){pad.on=false;pad.steer=pad.gas=pad.brake=0;keys.drift=keys.boost=false}});
function padLoop(){if(!pad.on)return;pollPad();requestAnimationFrame(padLoop)}
function rumble(k){const gp=[...navigator.getGamepads()].find(g=>g&&g.connected);try{gp?.vibrationActuator?.playEffect('dual-rumble',{duration:120+k*200,strongMagnitude:Math.min(1,k),weakMagnitude:Math.min(1,k*.6)})}catch(e){}}
function pollPad(){
 const gp=[...navigator.getGamepads()].find(g=>g&&g.connected);if(!gp)return;
 const down=i=>!!gp.buttons[i]?.pressed,val=i=>gp.buttons[i]?.value||0,hit=i=>down(i)&&!pad.prev[i];
 const driving=state==='race'||state==='countdown'||state==='finished';
 // the stick has a dead zone and a gentler centre, so small corrections are easy
 let sx=gp.axes[0]||0;sx=Math.abs(sx)<.12?0:Math.sign(sx)*((Math.abs(sx)-.12)/.88)**1.5;
 if(down(PB.LEFT))sx=-1;if(down(PB.RIGHT))sx=1;
 pad.steer=driving?sx:0;pad.gas=driving?val(PB.RT):0;pad.brake=driving?val(PB.LT):0;
 // buttons that hold an action: only touch it when the pad changes, so the keyboard keeps working too
 const hold=(name,on)=>{if(on!==!!pad.held[name]){pad.held[name]=on;keys[name]=on}};
 hold('drift',driving&&down(PB.A));hold('boost',driving&&(down(PB.B)||down(PB.RB)));
 if(driving){
  if(hit(PB.Y)){camMode=(camMode+1)%3;store.set('kod-cam',camMode);syncSettings();toast(['CAMERA: CHASE','CAMERA: FAR','CAMERA: HOOD'][camMode])}
  if(hit(PB.X)&&state==='race')respawn();
  if(hit(PB.START))togglePause();
 }else if(state==='replay'){if(hit(PB.A)||hit(PB.START))endReplay()}
 else padMenu(gp,down,hit);
 pad.prev=gp.buttons.map(b=>b.pressed);
}
// menus: move a highlight between the buttons of whatever panel is on top
function padMenu(gp,down,hit){
 const top=['ropts','settings','pause','garage','hub'].map($).find(e=>e&&getComputedStyle(e).display!=='none');if(!top)return;
 if(state==='paused'&&hit(PB.START)){togglePause();return}
 if(hit(PB.B)){for(const id of ['roptclose','setclose','gback','resume'])if(top.contains($(id))){$(id).click();return}return}
 const items=[...top.querySelectorAll('button,input[type=range]')].filter(e=>e.offsetParent!==null&&!e.disabled&&e.getBoundingClientRect().width>0);
 if(!items.length)return;
 if(!items.includes(pad.focus))setPadFocus(items.find(e=>e.id==='start'||e.id==='resume'||e.classList.contains('hgo'))||items[0]);
 const ax=gp.axes[0]||0,ay=gp.axes[1]||0;
 let dx=down(PB.LEFT)||ax<-.6?-1:down(PB.RIGHT)||ax>.6?1:0,dy=down(PB.UP)||ay<-.6?-1:down(PB.DOWN)||ay>.6?1:0;
 // first step at once, then repeat while held: a short wait, then faster
 const now=performance.now();
 if((dx||dy)&&now>=pad.navT){pad.navT=now+(pad.prevDir===dx+','+dy?140:300);pad.prevDir=dx+','+dy;
  const f=pad.focus;
  if(f.type==='range'&&dx&&!dy){f.value=+f.value+dx*f.step*2;f.dispatchEvent(new Event('input',{bubbles:true}));return}
  const a=f.getBoundingClientRect(),cx=a.x+a.width/2,cy=a.y+a.height/2;let best=null,bs=1e9;
  for(const e of items){if(e===f)continue;const r=e.getBoundingClientRect(),ex=r.x+r.width/2-cx,ey=r.y+r.height/2-cy;
   const along=ex*dx+ey*dy;if(along<=4)continue;const side=Math.abs(dx?ey:ex),sc=along+side*2.5;if(sc<bs){bs=sc;best=e}}
  if(best)setPadFocus(best);
 }else if(!dx&&!dy){pad.navT=0;pad.prevDir=''}
 if(hit(PB.A)&&pad.focus&&pad.focus.type!=='range')pad.focus.click();
 if(hit(PB.START)&&state==='menu'&&!mp.on&&hubPanel==='race')startRace();
}
function setPadFocus(e){pad.focus?.classList.remove('padfocus');pad.focus=e;e.classList.add('padfocus');e.scrollIntoView?.({block:'nearest'})}

// ---------- UI helpers ----------
let toastTimer=0;
// settings panel: graphics, music, sound, volume, camera
function syncSettings(){
 let cm=0;try{cm=camMode}catch(e){}   // camMode is declared further down
 const cur={sound:audio.muted?'0':'1',cam:String(cm)};
 document.querySelectorAll('#settings .seg').forEach(seg=>{const o=seg.dataset.opt,v=o in cur?cur[o]:String(settings[o]);seg.querySelectorAll('button').forEach(b=>b.classList.toggle('sel',b.dataset.v===v))});
 if($('vol'))$('vol').value=settings.vol;
}
let settingsFrom='menu';
function openSettings(from){settingsFrom=from;$(from).style.display='none';$('settings').style.display='flex';syncSettings()}
$('psettings').onclick=()=>openSettings('pause');
$('setclose').onclick=()=>{$('settings').style.display='none';$(settingsFrom).style.display=settingsFrom==='hub'?'block':'flex'};
$('vol').addEventListener('input',e=>{settings.vol=+e.target.value;store.set('kod-settings',settings);if(audio.master)audio.master.gain.value=masterVol()});
// the little bonus pop-ups (boost, super start, drift score) can be switched off in Settings
const popup=(t,c,d)=>{if(settings.popups!==0)toast(t,c,d)};
function toast(t,color='#fff',dur=1.4){const el=$('toast');el.textContent=t;el.style.color=color;el.style.opacity=1;toastTimer=dur}
function bigMessage(html,pop=true){const m=$('message');m.innerHTML=html;m.style.display='block';if(pop){m.classList.remove('pop');void m.offsetWidth;m.classList.add('pop')}}
const ordinal=n=>n+(['st','nd','rd'][n-1]||'th');
const fmt=t=>{if(t==null||!isFinite(t))return '—';const m=Math.floor(t/60),s=t-m*60;return (m?m+':'+(s<10?'0':''):'')+s.toFixed(2)};

// menu options
const segSyncs=[];
const syncSegs=()=>segSyncs.forEach(f=>f());
document.querySelectorAll('.seg').forEach(seg=>{
 const opt=seg.dataset.opt;
 const sync=()=>seg.querySelectorAll('button').forEach(b=>b.classList.toggle('sel',String(settings[opt])===b.dataset.v));
 if(!['sound','cam'].includes(opt))segSyncs.push(sync);
 seg.querySelectorAll('button').forEach(b=>b.onclick=()=>{if(opt==='sound'){setMuted(b.dataset.v==='0');return}
  if(opt==='cam'){camMode=+b.dataset.v;store.set('kod-cam',camMode);syncSettings();return}
  if(opt==='track'&&mp.on&&!mp.host)return;
  if(mp.on&&!mp.host&&seg.closest('#mphost,#ropts'))return;
  settings[opt]=['tod','weather','gfx'].includes(opt)?b.dataset.v:+b.dataset.v;store.set('kod-settings',settings);syncSegs();
  if(opt==='tod'||opt==='weather')applyTimeOfDay();
  if(opt==='music'&&!settings.music)musicStop();
  if(opt==='gfx')location.reload();
  if(opt==='pads')showPads();
  if(opt==='track'){const t=settings.track;settings.track=TRACK;switchTrack(t)}
  if(mp.on&&mp.host){mp.players.forEach(p=>p.ready=false);mpLobby()}
  showBest()});
 sync();
});
// race options live in their own panel so the race menu stays short; add new ones to RACE_OPTS and index.html
const RACE_OPTS=['pads','pull'];
const syncRaceOpts=()=>{const n=RACE_OPTS.filter(k=>settings[k]).length;document.querySelectorAll('.rcount').forEach(e=>e.textContent=n?` · ${n} ON`:'')};
segSyncs.push(syncRaceOpts);syncRaceOpts();
document.querySelectorAll('.ropen').forEach(b=>b.onclick=()=>{syncSegs();$('ropts').style.display='flex'});
$('roptclose').onclick=()=>{$('ropts').style.display='none'};
// the track card under the picker: outline, name, length
function drawTrackCard(){const xs=P.map(p=>p.x),zs=P.map(p=>p.z),x0=Math.min(...xs),x1=Math.max(...xs),z0=Math.min(...zs),z1=Math.max(...zs),k=Math.min(112/(x1-x0),64/(z1-z0));
 const X=x=>64+(x-(x0+x1)/2)*k,Y=z=>40+(z-(z0+z1)/2)*k;
 document.querySelectorAll('.tmap').forEach(c=>{const g=c.getContext('2d');g.clearRect(0,0,c.width,c.height);g.lineJoin='round';g.beginPath();
  P.forEach((p,i)=>i?g.lineTo(X(p.x),Y(p.z)):g.moveTo(X(p.x),Y(p.z)));g.closePath();
  g.strokeStyle='#0009';g.lineWidth=7;g.stroke();g.strokeStyle='#ffb21e';g.lineWidth=3.5;g.stroke();
  const s=trackAt(0);g.fillStyle='#fff';g.beginPath();g.arc(X(s.x),Y(s.z),4,0,7);g.fill()});
 document.querySelectorAll('.tname').forEach(e=>e.textContent=TRACKS[TRACK].name);
 document.querySelectorAll('.tdesc').forEach(e=>e.textContent=(L/1000).toFixed(1)+' km · '+TRACKS[TRACK].desc)}
drawTrackCard();
document.querySelectorAll('.gamever').forEach(e=>e.textContent='KOD Racing 3D '+GAME_VERSION);
// a newer version on the site than this one (the browser may have kept an old page for a few minutes):
// reload once, from the menu, so friends don't end up in a room with different versions
if(/^https?:$/.test(location.protocol))setTimeout(()=>fetch(new URL('../index.html',import.meta.url),{cache:'no-cache'}).then(r=>r.ok?r.text():'').then(t=>{
 const v=(t.match(/game\.js\?(v\d+)/)||[])[1];if(!v||v===GAME_VERSION)return;
 let tried=null;try{tried=sessionStorage.getItem('kod-reload')}catch(e){}
 if(tried!==v&&state==='menu'&&!mp.on){try{sessionStorage.setItem('kod-reload',v)}catch(e){}location.reload()}
 else toast('A NEW VERSION ('+v+') IS OUT · RELOAD THE PAGE','#ffd21e',4)}).catch(()=>{}),4000);
function showPads(){boostPads.forEach(b=>b.mesh.visible=!!settings.pads);buildMinimap()}
// a new track without reloading: free the old circuit and scenery, lay out the new one, re-grid the cars
function switchTrack(t){
 if(t===TRACK||!TRACKS[t])return;
 settings.track=t;store.set('kod-settings',settings);
 const gone=new Set();
 trackGroup.traverse(o=>{gone.add(o);if(o.geometry)o.geometry.dispose();
  for(const m of [].concat(o.material||[])){for(const k in m){const x=m[k];if(x&&x.isTexture&&!staticTex.has(x))x.dispose()}m.dispose()}});
 scene.remove(trackGroup);for(let i=noAO.length-1;i>=0;i--)if(gone.has(noAO[i]))noAO.splice(i,1);
 setTrackData(t);
 trackGroup=new THREE.Group();scene.add(trackGroup);
 building=true;buildTexN=0;
 try{buildCircuit();buildScenery()}finally{building=false}
 showPads();drawTrackCard();applyTimeOfDay();clearSkids();resetRace();showBest();syncSegs();
}
const bestKey=()=>'kod-rec-'+settings.laps+(TRACK?'-t'+TRACK:'');
function showBest(){const b=vault.get(bestKey())||{};$('best').textContent=b.race||b.lap?`Record (${settings.laps} lap${settings.laps>1?'s':''}): ${fmt(b.race)} · Best lap: ${fmt(b.lap)}`:''}
showBest();

// ---------- time of day ----------
const TOD={
 day:{zenith:0x2668b8,horizon:0xb7d2e8,sunSky:0xfff0d8,clouds:.42,cloud:0xffffff,cloudDark:0xb4bfcc,near:45,far:2700,hs:0xcfe3ff,hg:0x3f5a32,hi:1.5,sun:0xfff4e5,si:3.3,dir:[120,170,80],glow:1,night:0,bloom:[.16,.97]},
 sunset:{zenith:0x1b2c66,horizon:0xf08a52,sunSky:0xffa050,clouds:.5,cloud:0xffc09a,cloudDark:0x56465e,near:35,far:1700,hs:0xffc59a,hg:0x3a2a2a,hi:1,sun:0xffa060,si:2.8,dir:[-260,40,-160],glow:1.4,night:.55,bloom:[.28,.9]},
 night:{zenith:0x010309,horizon:0x0b1528,sunSky:0x10182a,clouds:.32,cloud:0x283246,cloudDark:0x080b12,near:15,far:650,hs:0x3a4a70,hg:0x0a0a10,hi:.55,sun:0x8aa0ff,si:.45,dir:[-150,220,120],glow:.15,night:1,bloom:[.42,.82]}
};
let sunDir=new THREE.Vector3(),hemiBase=1;
function applyTimeOfDay(){
 const t=TOD[settings.tod],u=skyMat.uniforms,night=settings.tod==='night';
 u.zenith.value.set(t.zenith);u.horizon.value.set(t.horizon);u.sunCol.value.set(t.sunSky);
 u.cloudCol.value.set(t.cloud);u.cloudDark.value.set(t.cloudDark);u.cloudCover.value=t.clouds;u.glow.value=t.glow;u.disc.value=night?0:1;
 sunDir.set(...t.dir).normalize();u.sunDir.value.copy(sunDir);
 scene.fog.color.set(t.horizon);scene.fog.near=t.near;scene.fog.far=t.far;
 hemi.color.set(t.hs);hemi.groundColor.set(t.hg);hemi.intensity=t.hi;sun.color.set(t.sun);sun.intensity=t.si;
 sunDisc.visible=night;stars.visible=night;
 if(bloom){bloom.strength=t.bloom[0];bloom.threshold=t.bloom[1]}
 const n=t.night;
 lampHeads.forEach(m=>m.emissiveIntensity=n*3);lampGlows.forEach(m=>m.opacity=n*.5);
 scene.traverse(o=>{if(o.material===lampPools[0])o.visible=n>0});lampPools[0].opacity=.3*n;
 windowMats.forEach(m=>m.emissiveIntensity=n*1.1);wallMat.emissiveIntensity=wallMatR.emissiveIntensity=n*.35;
 headlight.intensity=70*n;
 cars.forEach(c=>c.car.headMat.emissiveIntensity=1.2+n*3);
 // rain: grey sky, thick fog, shiny road
 const wet=isRain();
 if(wet){
  const grey=new THREE.Color(settings.tod==='night'?0x05070c:settings.tod==='sunset'?0x6b5a5a:0x7d8896);
  u.zenith.value.lerp(grey,.8);u.horizon.value.lerp(grey,.65);scene.fog.color.lerp(grey,.7);
  u.cloudCover.value=.97;u.cloudCol.value.copy(grey).multiplyScalar(1.15);u.cloudDark.value.copy(grey).multiplyScalar(.55);u.glow.value=.2;sunDisc.visible=false;
  scene.fog.near*=.35;scene.fog.far*=.55;hemi.intensity*=.75;sun.intensity*=.3;stars.visible=false;
  lampPools[0].opacity=.5*n;
 }
 fogSun.set([sunDir.x,sunDir.y,sunDir.z]);
 const fs=u.sunCol.value.clone().multiplyScalar(.35*u.glow.value);fogSunCol.set([fs.r,fs.g,fs.b]);
 hemiBase=hemi.intensity;
 rain.visible=splashes.visible=wet;roadWet.uWet.value=wet?1:0;
 rainU.uLight.value={day:1,sunset:.8,night:.32}[settings.tod];
 // the sky lights and reflects off everything (image based lighting)
 scene.environment=skyEnv();
 scene.environmentIntensity={day:.6,sunset:.55,night:.25}[settings.tod]*(wet?.85:1);
 hemi.intensity*=.55;hemiBase=hemi.intensity;
 // a wet road is darker and glossy; the stone grain flattens out under the film of water
 roadMat.color.set(wet?0x7c7c84:0xffffff);roadMat.roughness=wet?.4:1;roadMat.metalness=wet?.12:0;roadMat.normalScale.setScalar(wet?.12:.7);
 curbMat.roughness=wet?.2:.7;
}
applyTimeOfDay();

// ---------- race state ----------
let state='menu',raceTime=0,countdown=0,lastRecord=false,finishFrame=0,camMode=store.get('kod-cam')??0,lastCount=0,gasDownAt=-1,shake=0,lastPos=4;
syncSettings();
const LAPS=()=>settings.laps;
function gridSlot(k){return {d:-10-Math.floor(k/2)*9,lat:k%2?3.6:-3.6}}
function resetRace(){
 const d=DIFF[settings.diff];
 // tune the C++ physics for the chosen car; bots get a bit quicker against faster cars
 // online races with stock cars: everybody drives the factory setup, whatever they bought (or hacked)
 if(mp.on&&mp.cfg?.stock)setupCfg(garage.sel,{...garage.cars[garage.sel],...STOCK});else setupCar(garage.sel);
 gearScale=ctl.setup_value(0)/40;gauge.max=0;
 const perf=ctl.setup_value(0)/40,lat=d.lat*(1+(perf-1)*.4);botTop=d.top*(1+(perf-1)*.6);
 botProfile=isRain()?speedProfile(lat*.78,botTop,16):speedProfile(lat,botTop,20);
 // player starts last (slot 3)
 const humans=mp.on?mp.order.length:1,mySlot=mp.on?Math.max(0,mp.order.indexOf(mp.id)):3;
 const g=gridSlot(mySlot),p=trackAt(g.d,g.lat);
 Object.assign(player,{x:p.x,z:p.z,angle:p.angle,vx:0,vz:0,yaw:0,steer:0,bend:0,nitro:.25,dist:g.d,s:wrapS(g.d),idx:p.i,lat:g.lat,finished:false,finishTime:0,lapStart:0,laps:[],drift:0,driftScore:0,wrong:0,wasBoost:false,damage:0});
 for(const r of cars)if(r.remote){const gs=gridSlot(Math.max(0,mp.order.indexOf(r.id))),q=trackAt(gs.d,gs.lat);
  Object.assign(r,{dist:gs.d,lat:gs.lat,x:q.x,z:q.z,angle:q.angle,v:0,steer:0,boost:0,finished:false,finishTime:0,damage:0,buf:[],shown:null,lastN:null,off:null,lastTs:null});r.car.g.position.set(q.x,0,q.z);r.car.g.rotation.y=q.angle}
 raceBots.forEach((b,k)=>{const gs=gridSlot(mp.on?humans+k:k);Object.assign(b,{dist:gs.d,lat:gs.lat,laneT:gs.lat,v:0,skill:rand(...d.skill),offset:rand(-1.5,1.5),laneTimer:rand(2,5),finished:false,finishTime:0,boost:0,steer:0,avoid:0,damage:0,buf:[],shown:null,lastN:null,off:null,lastTs:null})});
 raceBots.forEach(placeBot);
 raceTime=0;lastPos=cars.length;clearSkids();recTotal=0;drops.length=0;music.intense=false;
 clearShards();hitCool={};
 cars.forEach(c=>{repairCar(c.car);tumbleReset(c);c.knockLat=0;c.yawOff=0;c.spinVel=0;c.sys=freshSys();c.wrecked=c.dnf=c.repairing=c.pitHint=c.pitSide=c.wasPit=false;c.pit=null;c.misfire=0;c.critAt=null});
 particles.forEach(p=>p.s.visible=false);
 boostPads.forEach(b=>b.cool=0);
 cars.forEach(c=>{c.marks=[];c.ghost=false;c.drsZone=null;c.drsOk=c.drsOpen=c.limp=false;c.hicT=0});$('drs').className='';
 buildBoxes();
}
function placeBot(b){const p=trackAt(b.dist,b.lat);b.x=p.x;b.z=p.z;b.angle=p.angle;b.car.g.position.set(p.x,0,p.z);b.car.g.rotation.y=p.angle;onRoad(b,b.dist)}
function startRace(){
 if(state!=='menu')return;
 if(!mp.on)setRoster([],3);
 initAudio();buildPlayerCar();resetRace();musicStart();
 hideHub();$('results').innerHTML='';
 state='countdown';countdown=4;lastCount=5;gasDownAt=-1;setStartLights(0,false);
 camYaw=player.angle;camera.position.set(player.x-Math.sin(player.angle)*10,4,player.z-Math.cos(player.angle)*10);
 warmUp(scene,camera);updateCarReflection(true);
}
function respawn(){
 const p=trackAt(player.s,0);Object.assign(player,{x:p.x,z:p.z,angle:p.angle,vx:0,vz:0,yaw:0,lat:0});tumbleReset(player);toast('BACK ON TRACK','#9fd')
}
function togglePause(){
 if(state==='race'||state==='countdown'){pausedFrom=state;state='paused';$('pause').style.display='flex';audio.ctx&&audio.ctx.suspend()}
 else if(state==='paused'){state=pausedFrom;$('pause').style.display='none';audio.ctx&&audio.ctx.resume();last=performance.now()}
}
let pausedFrom='race';
$('resume').onclick=togglePause;
$('quit').onclick=()=>{$('pause').style.display='none';audio.ctx&&audio.ctx.resume();toMenu()};
document.addEventListener('visibilitychange',()=>{if(document.hidden&&(state==='race'||state==='countdown'))togglePause()});
function toMenu(){state='menu';musicStop();document.body.classList.remove('replaying');$('message').style.display='none';
 mpOut();
 showHub(mp.on?'mp':'race');showBest()}

let lastReward=null;
function giveReward(pos){
 const lapMul={1:.5,3:1,5:1.5}[settings.laps],diffMul=[.8,1,1.3][settings.diff];
 const money=Math.round(([900,550,320,160][pos-1]??100)*lapMul*diffMul/10)*10;
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
 bigMessage(pos===1?'VICTORY!<small>'+fmt(raceTime)+' s</small>':'FINISH!<small>'+ordinal(pos)+' place · '+fmt(raceTime)+' s</small>');
 [523,659,784,1046].forEach((f,k)=>setTimeout(()=>beep(f,.25,.25,'triangle'),k*120));
 const b=vault.get(bestKey())||{};let rec=false;
 if(!b.race||raceTime<b.race){b.race=raceTime;rec=true}
 const bl=Math.min(...player.laps);if(!b.lap||bl<b.lap)b.lap=bl;
 vault.set(bestKey(),b);
 state='finished';lastRecord=rec;finishFrame=recTotal;
 setTimeout(()=>{if(state==='finished')startReplay()},2200);
}
function showResults(rec){
 const order=standings();
 const total=LAPS()*L;
 const rows=order.map((c,k)=>{const t=c.finished?c.finishTime:raceTime*total/Math.max(1,c.dist);
  return `<tr class="${c===player?'me':''}"><td>${(k+1)+'.'}</td><td>${esc(c.name)}${c.remote?' <small>(online)</small>':''}</td><td>${c.dnf?'DNF':c.gone&&!c.finished?'left':(c.finished?'':'~')+fmt(t)}</td></tr>`}).join('');
 $('results').innerHTML=`<table>${rows}</table>`+(rec?'<p style="color:#ffd84a;font-weight:800">NEW RECORD!</p>':'')+
  `<p class="keys">Laps: ${player.laps.map(fmt).join(' · ')}</p>`+
  (lastReward?`<p class="reward">+${lastReward.money} credits</p>`+lastReward.fresh.map(n=>`<p class="unlock">New car in the garage: ${n}!</p>`).join(''):'');
 lastReward=null;
 $('rtitle').textContent=player.dnf?'WRECKED · DNF':mp.on?'ONLINE RACE':'RACE COMPLETE';
 $('again').style.display=mp.on?'none':'block';$('rdone').textContent=mp.on?'BACK TO THE ROOM':'CONTINUE';
 $('message').style.display='none';showBest();
 state='menu';menuOrbit=0;musicStop();
 mpOut();
 showHub('results');
}
// timing tower: every car's time at each 20 m of the race, so a gap is how long ago the leader was where they are now
let towerT=0;
const abbr=c=>((c===player&&mp.on?playerName():c.name)||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,3)||'???';
const paintHex=c=>{const p=c.car.paint;return '#'+(p?(p.userData.col||p.color).getHex():c.color).toString(16).padStart(6,'0')};
function updateTower(dt){
 for(const c of cars){if(!c.marks)c.marks=[];const bin=Math.floor(Math.max(0,c.dist)/20);for(let k=c.marks.length;k<=bin&&k<5000;k++)c.marks[k]=raceTime}
 towerT-=dt;if(towerT>0)return;towerT=.25;
 const st=standings(),el=$('twrows'),lead=st[0];
 if(el.children.length!==st.length)el.innerHTML=st.map(()=>'<div class="r"><span class="p"></span><i class="c"></i><span class="n"></span><span class="g"></span></div>').join('');
 st.forEach((c,k)=>{const r=el.children[k],bin=Math.floor(Math.max(0,c.dist)/20),inPit=c.ghost||c.repairing;
  r.className='r'+(c===player?' me':'')+(inPit?' pit':'')+(c.dnf||c.gone?' out':'');
  r.children[0].textContent=k+1;r.children[1].style.background=paintHex(c);r.children[2].textContent=abbr(c);
  r.children[3].textContent=c.dnf?'DNF':c.gone?'OUT':inPit?'PIT':k===0?'LEADER':c.finished&&lead.finished?'+'+(c.finishTime-lead.finishTime).toFixed(3)
   :lead.dist-c.dist>L?'+'+Math.floor((lead.dist-c.dist)/L)+' LAP':lead.marks?.[bin]!=null&&c.marks?.[bin]!=null?'+'+Math.max(0,c.marks[bin]-lead.marks[bin]).toFixed(3):''});
}
function standings(){
 return [...cars].sort((a,b)=>{
  if(!!a.dnf!==!!b.dnf)return a.dnf?1:-1;
  if(a.finished&&b.finished)return a.finishTime-b.finishTime;
  if(a.finished!==b.finished)return a.finished?-1:1;
  if(!!a.gone!==!!b.gone)return a.gone?1:-1;
  return b.dist-a.dist});
}

// ---------- update ----------
// Field order of struct Car in controls.cpp.
const CAR_FIELDS=['dt','locked','finished','grass','wet','damage','x','z','angle','vx','vz','steer','nitro','wasBoost',
 'vF','vR','yaw','boosting','drifting','gas','brake','whoosh','fx','fz','rx','rz','slipF','slipR','wheel','hbTime','pull','steerAx','gasAx','brakeAx','pwrMul','gripFMul','gripRMul','brakeMul','aeroMul','tyrePull','pitLimit','topMul','drs','autopilot','counterT','flick','flickSide'];
const carMem=new Float64Array(ctl.memory.buffer,ctl.car_state(),CAR_FIELDS.length);
const CF=Object.fromEntries(CAR_FIELDS.map((f,i)=>[f,i]));
let tyreEls=null,sysEls=null,statusKey='';
const cstat=$('carstat').getContext('2d');
function drawCarStatus(){
 const s=player.sys||freshSys(),crit=player.damage>=CRITICAL&&!player.wrecked,blink=(performance.now()/350|0)%2;
 const lines=[],flat=k=>s[k]>=.7,NAME={fl:'FRONT LEFT',fr:'FRONT RIGHT',rl:'REAR LEFT',rr:'REAR RIGHT'};
 if(player.wrecked)lines.push(['x','CAR DESTROYED']);
 else{
  for(const k of ['fl','fr','rl','rr'])if(flat(k))lines.push(['x','PUNCTURE '+NAME[k]+' · BOX BOX']);else if(s[k]>=.4)lines.push(['b',NAME[k]+' TYRE DAMAGED']);
  if(s.engine>=.7)lines.push(['x','ENGINE CRITICAL · LIMP MODE']);else if(player.limp)lines.push(['x','LIMP MODE · −20% TOP SPEED']);else if(s.engine>=.3)lines.push(['b','ENGINE DAMAGED · CAN\'T BE FIXED']);
  if(s.aero>=.5)lines.push([s.aero>=.8?'x':'b','REAR WING DAMAGED']);
  if(s.brakes>=.5)lines.push([s.brakes>=.8?'x':'b','BRAKES DAMAGED']);
 }
 const key=lines.map(l=>l.join()).join('|')+blink+state+crit+Object.values(s).map(v=>v>=.7?3:v>=.5?2:v>=.25?1:0).join('');
 if(key===statusKey)return;statusKey=key;
 $('critwarn').style.display=crit&&state!=='finished'?'block':'none';
 const show=state==='race'||state==='countdown'||state==='finished';   // always there while racing, like the F1 car status
 $('carpanel').style.display=show?'flex':'none';if(!show)return;
 $('carmsg').innerHTML=lines.slice(0,4).map(([c,t])=>`<div class="${c}">${t}</div>`).join('');
 // top view: wings, four tyres, engine, brakes, painted green / yellow / orange / red
 const g=cstat,W=140,H=220,col=v=>v>=.7?(blink?'#ff3b2e':'#8a1a14'):v>=.5?'#ff9a3a':v>=.25?'#ffd23f':'#3ddc84';
 g.clearRect(0,0,W,H);g.lineJoin='round';
 g.fillStyle='#ffffff14';g.strokeStyle=crit?(blink?'#ff3b2e':'#ffffff55'):'#ffffff55';g.lineWidth=3;
 g.beginPath();g.moveTo(70,22);g.bezierCurveTo(98,26,100,70,98,110);g.lineTo(98,180);g.quadraticCurveTo(96,204,70,206);g.quadraticCurveTo(44,204,42,180);g.lineTo(42,110);g.bezierCurveTo(40,70,42,26,70,22);g.fill();g.stroke();
 const box=(x,y,w,h,v,r=5)=>{g.fillStyle=col(v);g.beginPath();g.roundRect(x,y,w,h,r);g.fill()};
 box(34,10,72,10,s.aero*.6,3);                     // front wing
 box(30,208,80,10,s.aero,3);                       // rear wing
 box(16,46,22,40,s.fl);box(102,46,22,40,s.fr);box(16,140,22,42,s.rl);box(102,140,22,42,s.rr);
 box(52,132,36,44,s.engine,6);                      // engine
 g.fillStyle='#0b1016';g.font='bold 15px Arial';g.textAlign='center';g.textBaseline='middle';g.fillText('ENG',70,154);
 for(const [x,y] of [[40,66],[100,66],[40,161],[100,161]]){g.fillStyle=col(s.brakes);g.beginPath();g.arc(x,y,5,0,7);g.fill()}
}
const CAR_STATE=['x','z','angle','vx','vz','yaw','steer','nitro'];
// ---------- crashes & rollovers ----------
// A hard side hit (another car or the wall) turns a car into a 3D rigid body, simulated in C++ (tumble_step):
// it can roll over, slide on its roof and land back on its wheels. Field order of struct Body in controls.cpp.
const BODY_FIELDS=['px','py','pz','vx','vy','vz','qw','qx','qy','qz','wx','wy','wz','hx','hy','hz','rest','hit'];
const BF=Object.fromEntries(BODY_FIELDS.map((f,i)=>[f,i]));
const bodyMem=k=>new Float64Array(ctl.memory.buffer,ctl.body_state(k),BODY_FIELDS.length);
// closing speed (m/s) at which a hit rolls a car: lowest for a hit square into its side, higher end-on
const ROLL_SIDE=9.5,ROLL_END=13;
const rollSpeed=(nx,nz,ang)=>{const end=Math.abs(nx*Math.sin(ang)+nz*Math.cos(ang));return lerp(ROLL_SIDE,ROLL_END,end)};
const _tq=new THREE.Quaternion(),_tv=new THREE.Vector3(),_yAx=new THREE.Vector3(0,1,0);
// (nx,nz): horizontal direction the hit pushes the car; power 0..1
// no two crashes alike: a soft one may only lift the car onto two wheels and drop it back, a hard one
// sends it barrel rolling, flipping end over end, corkscrewing or flying
const ROLL_STYLES=['tip','roll','barrel','flip','cork','launch'];
function rollStyle(k,endOn){
 const w={tip:k<.35?3:k<.6?1:0,roll:2,barrel:k>.3?1+k*2:0,flip:(endOn?2.5:.4)+k,cork:.6+k*1.5,launch:k>.45?k*1.6:0};
 let r=Math.random()*Object.values(w).reduce((a,b)=>a+b,0);for(const st of ROLL_STYLES){r-=w[st];if(r<=0)return st}return 'roll';
}
function startTumble(c,vx,vz,nx,nz,power){
 if(c.tumble||c.finished&&c!==player)return;
 const slot=cars.indexOf(c);if(slot<0)return;
 const fx=Math.sin(c.angle),fz=Math.cos(c.angle),rx=-fz,rz=fx;
 const endOn=Math.abs(nx*fx+nz*fz)>.7,b=bodyMem(slot),k=clamp(power,0,1),style=rollStyle(k,endOn);
 // spin about the axis square to the push (roof goes the way the car is pushed: w = s * up x n), then the style's twist
 let s=2.5+k*7,ax=nz,az=-nx,wy=rand(-1,1)*(.5+k*2),vy=1.2+k*4;
 if(style==='tip'){s=3+k*.4;vy=s*.75;wy*=.3}   // pivots on the far wheels: the middle rises with the spin
 else if(style==='barrel'){s*=1.5;vy+=1.5}
 else if(style==='flip'){const sg=Math.sign(nx*fx+nz*fz)||1;ax=-rx*sg;az=-rz*sg;s=2.2+k*2;vy+=1}   // end over end, nose or tail first
 else if(style==='cork'){const sg=Math.sign(nx*rx+nz*rz)||1;ax=ax*.7+fx*.6*sg;az=az*.7+fz*.6*sg;wy=(Math.random()<.5?-1:1)*(2+k*3);vy+=1}
 else if(style==='launch'){vy=5+k*5;s*=.8;wy*=1.5}
 const al=Math.hypot(ax,az)||1;
 b.fill(0);
 _tq.setFromAxisAngle(_yAx,c.angle);
 Object.assign(b,{[BF.px]:c.x,[BF.py]:.62,[BF.pz]:c.z,[BF.vx]:vx,[BF.vy]:vy,[BF.vz]:vz,
  [BF.qw]:_tq.w,[BF.qx]:_tq.x,[BF.qy]:_tq.y,[BF.qz]:_tq.z,
  [BF.wx]:ax/al*s,[BF.wy]:wy,[BF.wz]:az/al*s,
  [BF.hx]:.95,[BF.hy]:.62,[BF.hz]:c.car.len*.48});
 c.tumble={slot,t:0,flat:0,style};
 hurt(c,style==='tip'?.04:.12+k*.15);
 if(c===player){shake=1;flash();thud(1)}
}
function stepTumble(c,dt){
 const T=c.tumble,b=bodyMem(T.slot),st=ctl.tumble_step(T.slot,dt);
 // the barriers still hold it: push the box back and take away its speed into the wall
 const loc=locate(b[BF.px],b[BF.pz],c.idx??null);if(c===player)c.idx=loc.i;
 const tz=pitZone(loc.s),thi=WR[loc.i]-1,tlo=tz?-(tz.out-1):-(WL[loc.i]-1);
 if(loc.lat>thi||loc.lat<tlo){const sg=Math.sign(loc.lat),pen=sg>0?loc.lat-thi:tlo-loc.lat;
  b[BF.px]-=loc.rx*sg*pen;b[BF.pz]-=loc.rz*sg*pen;const vn=b[BF.vx]*loc.rx+b[BF.vz]*loc.rz;
  if(vn*sg>0){b[BF.vx]-=loc.rx*vn*1.4;b[BF.vz]-=loc.rz*vn*1.4}}
 // the car's origin sits under the middle of the box
 _tq.set(b[BF.qx],b[BF.qy],b[BF.qz],b[BF.qw]);
 _tv.set(0,-b[BF.hy],0).applyQuaternion(_tq);
 c.car.g.position.set(b[BF.px]+_tv.x,b[BF.py]+_tv.y+(c.gy||0),b[BF.pz]+_tv.z);c.car.g.quaternion.copy(_tq);
 c.x=b[BF.px];c.z=b[BF.pz];if(c===player){c.vx=b[BF.vx];c.vz=b[BF.vz]}
 _tv.set(0,0,1).applyQuaternion(_tq);if(Math.hypot(_tv.x,_tv.z)>.2)c.angle=Math.atan2(_tv.x,_tv.z);
 c.v=Math.hypot(b[BF.vx],b[BF.vz]);
 // hitting the ground hard: damage, a dent on that side, sparks
 if(b[BF.hit]>1.2){
  hurt(c,b[BF.hit]*.009);
  _tv.set(0,1,0).applyQuaternion(_tq);
  dentCar(c.car,c.x-_tv.x,.4,c.z-_tv.z,Math.min(1,b[BF.hit]/3));
  for(let k=0;k<8;k++)emit(c.x+rand(-1,1),.3+(c.gy||0),c.z+rand(-1,1),rand(-5,5),rand(1,4),rand(-5,5),.3,.4,0,0xffb040,true);
  if(c===player){thud(Math.min(1,b[BF.hit]/3));shake=Math.min(1,b[BF.hit]/3)}}
 if(c.v>3&&Math.random()<.5)emit(c.x,.3+(c.gy||0),c.z,rand(-1,1),rand(.5,2),rand(-1,1),.9,1.4,3,0xb8b2a6);   // dust
 T.t+=dt;if(st===2)T.flat+=dt;
 // on its wheels: drive on. on its side or roof (or stuck): put back on its wheels after a moment
 if(st===1||T.flat>1.2||T.t>10)endTumble(c,st===1,b);
}
function endTumble(c,onWheels,b){
 c.tumble=null;
 c.car.g.quaternion.identity();c.car.g.position.y=c.gy||0;c.car.g.rotation.set(0,c.angle,0);
 if(c===player){
  if(onWheels){c.vx=b[BF.vx];c.vz=b[BF.vz]}else{c.vx=c.vz=0;toast('BACK ON YOUR WHEELS','#9fd',1.4)}
  c.yaw=0;return}
 // a bot goes back onto its racing line where it ended up
 const loc=locate(c.x,c.z,null);let d=loc.s-wrapS(c.dist);if(d<-L/2)d+=L;if(d>L/2)d-=L;
 c.dist+=d;c.lat=c.laneT=clamp(loc.lat,-ROAD+1.2,ROAD-1.2);c.v=onWheels?Math.hypot(b[BF.vx],b[BF.vz]):0;c.knockLat=0;c.yawOff=0;c.spinVel=0;
}
const tumbleReset=c=>{if(c.tumble){c.tumble=null}c.car.g.quaternion.identity();c.car.g.position.y=c.gy||0;c.car.g.rotation.set(0,c.angle,0)};

function updatePlayer(dt,locked){
 const pl=player,grass=Math.abs(pl.lat)>CURB&&!onPitTarmac(pl.s,pl.lat);
 let vF=0,vR=0,yaw=0,boosting=false,gas=false,brake=false,fx=Math.sin(pl.angle),fz=Math.cos(pl.angle),rx=-fz,rz=fx;
 if(pl.tumble){stepTumble(pl,dt);fx=Math.sin(pl.angle);fz=Math.cos(pl.angle);rx=-fz;rz=fx;vF=pl.v}
 else{
 // hand the car to C++, drive one frame, read it back
 carMem[CF.dt]=dt;carMem[CF.locked]=locked?1:0;carMem[CF.finished]=state==='finished'?1:0;carMem[CF.grass]=grass?1:0;
 carMem[CF.wet]=isRain()?1:0;carMem[CF.damage]=pl.damage;carMem[CF.pull]=settings.pull?player.bend||0:0;
 carMem[CF.steerAx]=pad.steer;carMem[CF.gasAx]=pad.gas;carMem[CF.brakeAx]=pad.brake;
 // with Damage pull off the car never steers itself: a flat tyre only costs grip and speed
 {const e=sysEffects(pl,dt);carMem[CF.pwrMul]=e.pw;carMem[CF.gripFMul]=e.gf;carMem[CF.gripRMul]=e.gr;carMem[CF.brakeMul]=e.br;carMem[CF.aeroMul]=e.ae;carMem[CF.tyrePull]=settings.pull?e.pull+e.wob:0;carMem[CF.topMul]=e.top;rimSparks(pl,dt);updateDrs(pl,e.limp,locked)}
 if(pl.wrecked)carMem[CF.finished]=1;
 if(pl.repairing)carMem[CF.locked]=1;
 // pit lane speed limiter
 carMem[CF.pitLimit]=pl.pitSide&&state==='race'?PIT_LIM:0;
 if(!!pl.pitSide!==!!pl.wasPit&&state==='race'){pl.wasPit=pl.pitSide;toast(pl.pitSide?'PIT LIMITER · 80 km/h':'PIT EXIT · LIMITER OFF',pl.pitSide?'#ffd21e':'#5fe08a',1.4)}
 for(const f of CAR_STATE)carMem[CF[f]]=pl[f];
 carMem[CF.wasBoost]=pl.wasBoost?1:0;
 pitDrive(pl);
 ctl.drive();simStamp=performance.now()/1000;   // when this position was true (sent on the next frame's start)
 for(const f of CAR_STATE)pl[f]=carMem[CF[f]];
 pl.wasBoost=carMem[CF.wasBoost]===1;
 vF=carMem[CF.vF];vR=carMem[CF.vR];yaw=carMem[CF.yaw];
 boosting=carMem[CF.boosting]===1;gas=carMem[CF.gas]===1;brake=carMem[CF.brake]===1;
 fx=carMem[CF.fx];fz=carMem[CF.fz];rx=carMem[CF.rx];rz=carMem[CF.rz];
 if(carMem[CF.whoosh]===1)whoosh();
 // limp mode: lifting off makes the sick engine pop and bang through the exhaust
 if(pl.limp&&pl.prevGas&&!gas&&Math.abs(vF)>8){backfire();pops(3+(Math.random()*3|0))}pl.prevGas=gas;
 }
 const sp=Math.abs(vF);

 // track position & walls
 const loc=locate(pl.x,pl.z,pl.idx);pl.idx=loc.i;pl.lat=loc.lat;
 // how far the car reaches sideways (towards the walls) at its current heading
 const fa=Math.abs(Math.sin(pl.angle)*loc.rx+Math.cos(pl.angle)*loc.rz),reach=pl.car.len/2*fa+pl.car.half*Math.sqrt(Math.max(0,1-fa*fa)),lim=WALL-.12-reach;
 // along the pit straight the left side is open out to the garages; where the pit wall stands, which side
 // of it you're on decides which wall holds you
 const pz=pitZone(loc.s);if(!pz)pl.pitSide=false;else if(!pz.wall)pl.pitSide=loc.lat<-PIT_WALL;
 // in the pit lane cars pass through each other, from the entry line until back on the track
 pl.ghost=pitGhost(pz,loc.lat);
 const wr=lerp(WR[loc.i],WR[(loc.i+1)%N],clamp(loc.t??0,0,1)),wl=lerp(WL[loc.i],WL[(loc.i+1)%N],clamp(loc.t??0,0,1));
 let lo=-(lim-WALL+wl),hi=lim-WALL+wr;
 if(pz){lo=pz.wall&&!pl.pitSide?-(PIT_WALL-.37-reach):-(pz.out-.12-reach);if(pz.wall&&pl.pitSide)hi=-(PIT_WALL+.37+reach)}
 if(!pl.tumble&&(loc.lat>hi||loc.lat<lo)){
  const sg=loc.lat>hi?1:-1,pen=sg>0?loc.lat-hi:lo-loc.lat;
  pl.x-=loc.rx*sg*pen;pl.z-=loc.rz*sg*pen;pl.lat=sg>0?hi:lo;
  const vn=pl.vx*loc.rx+pl.vz*loc.rz;
  if(vn*sg>0){pl.vx-=loc.rx*vn*1.35;pl.vz-=loc.rz*vn*1.35;pl.yaw*=.6;
   const hit=Math.abs(vn);pl.vx*=1-Math.min(.35,hit*.025);pl.vz*=1-Math.min(.35,hit*.025);
   if(hit>3){shake=Math.min(1,hit/14);thud(hit/18);flash();
    // dent the corner that touched: the end of the car pointing at the wall when it's turned, the side otherwise
    const fwd=Math.sin(pl.angle)*loc.rx+Math.cos(pl.angle)*loc.rz,end=fa>.35?Math.sign(fwd*sg)*pl.car.len*.42:0;
    const cx=pl.x+loc.rx*sg*pl.car.half+Math.sin(pl.angle)*end,cz=pl.z+loc.rz*sg*pl.car.half+Math.cos(pl.angle)*end;
    hurt(pl,hit*.0075);dentCar(pl.car,cx,.7,cz,Math.min(1,hit/12));
    for(let k=0;k<10;k++)emit(cx,.6+(pl.gy||0),cz,rand(-6,6),rand(2,6),rand(-6,6),.35,.5,0,0xffb040,true)}
   const rw=lerp(ROLL_SIDE+1,ROLL_END+4,fa);if(hit>rw)startTumble(pl,pl.vx,pl.vz,-sg*loc.rx,-sg*loc.rz,(hit-rw)/12)}
 }
 // pit stop: the game drives in the lane (pitDrive, before the physics), here the stop itself runs
 {updatePitStop(pl,dt);
  if(state==='race'&&pl.damage>=.6&&!pl.pitHint){pl.pitHint=true;setTimeout(()=>{if(!player.wrecked&&state==='race')toast('BOX BOX · pit lane on the left, yellow box','#ffd21e',3)},1900)}}
 // progress
 let ds=loc.s-pl.s;if(ds<-L/2)ds+=L;if(ds>L/2)ds-=L;pl.s=loc.s;
 if(!locked){
  const before=Math.floor(pl.dist/L);pl.dist+=ds;const after=Math.floor(pl.dist/L);
  if(after>before&&pl.dist>0&&!pl.finished){
   if(after>=1&&after>pl.laps.length){const lt=raceTime-pl.lapStart;pl.laps.push(lt);pl.lapStart=raceTime;
    const best=Math.min(...pl.laps.slice(0,-1),(vault.get(bestKey())||{}).lap??Infinity);
    if(after>=LAPS()){finishPlayer()}
    else{if(after===LAPS()-1)music.intense=true;
     toast((after===LAPS()-1?'FINAL LAP! ':'LAP '+(after+1)+' · ')+fmt(lt)+(lt<best?' · BEST':''),after===LAPS()-1?'#ffd84a':'#fff',2.2);beep(880,.15,.2)}
   }
  }
  // wrong way
  const along=pl.vx*loc.tx+pl.vz*loc.tz;
  pl.wrong=along<-3?pl.wrong+dt:Math.max(0,pl.wrong-dt*2);
 }
 // boost pads
 for(const b of boostPads){b.cool=Math.max(0,(b.cool||0)-dt);if(pl.tumble||!settings.pads)continue;
  let d=pl.s-b.s;if(d<-L/2)d+=L;if(d>L/2)d-=L;
  if(!locked&&b.cool===0&&Math.abs(d)<4&&Math.abs(pl.lat-b.lat)<2.8){b.cool=1.5;pl.nitro=Math.min(1,pl.nitro+.35);
   pl.vx+=fx*12;pl.vz+=fz*12;whoosh();popup('BOOST!','#3cf',1);shake=.4;}}
 // drift scoring & nitro charge
 const slide=Math.abs(vR);
 if(!locked&&slide>3.2&&sp>11&&!grass){pl.nitro=Math.min(1,pl.nitro+dt*.2*Math.min(1,slide/7));pl.driftScore+=slide*sp*dt*.5;pl.drift=slide}
 else{if(pl.driftScore>40){popup('DRIFT +'+Math.round(pl.driftScore),'#f6c',1.2)}pl.driftScore=0;pl.drift=0}
 // effects
 const fwdV=vF;
 if(slide>3.2&&sp>8||(brake&&sp>18)){
  const heavy=clamp((slide-3)/6,0,1);
  for(const side of [-1,1]){const wx=pl.x-fx*1.45+rx*side*1.07,wz=pl.z-fz*1.45+rz*side*1.07;skid(wx,wz,pl.angle,sp*dt,pl.gy||0);
   for(let k=0,n=heavy>.5?2:1;k<n;k++)if(Math.random()<.45+heavy*.5)
    emit(wx,.45+(pl.gy||0),wz,rand(-1,1)+rx*side*heavy*2,rand(.4,1.4)+heavy*.6,rand(-1,1)+rz*side*heavy*2,rand(1,1.6)+heavy*1.2,.9+heavy*.9,1.8+heavy*1.6,grass?0xb8a47a:0xe6e6e2)}}
 if(grass&&sp>5&&Math.random()<.6)emit(pl.x-fx*2,.4+(pl.gy||0),pl.z-fz*2,rand(-1,1),rand(1,3),rand(-1,1),.9,1,2.5,0x8a7a50);
 if(boosting&&Math.random()<.8)emit(pl.x-fx*3,.5+(pl.gy||0),pl.z-fz*3,-fx*4+rand(-1,1),rand(0,1),-fz*4+rand(-1,1),.25,.6,1,0x55bbff,true);
 if(isRain())spray(pl.x,pl.z,fx,fz,sp,pl.gy||0);
 damageSmoke(pl,pl.x,pl.z,fx,fz);
 // body roll and pitch from smoothed accelerations: the raw frame-to-frame numbers jitter, and the body wobbled like jelly
 const k=Math.min(1,dt*7);pl.accF+=(((fwdV-pl.lastF)/Math.max(dt,1e-3))-(pl.accF||0))*k;pl.accR+=(((vR-pl.lastR)/Math.max(dt,1e-3)+yaw*sp)-(pl.accR||0))*k;pl.lastF=fwdV;pl.lastR=vR;
 const accF=pl.accF||0,accR=pl.accR||0;
 pl.wheelVis=pl.tumble?0:clamp(carMem[CF.wheel]/.45,-1.6,1.6);
 animateCar(pl.car,dt,fwdV,pl.wheelVis,pl.tumble?0:clamp(-accR*.004,-.09,.09),pl.tumble?0:clamp(-accF*.003,-.06,.06),boosting,brake&&fwdV>1);
 if(!pl.tumble){pl.car.g.position.set(pl.x,0,pl.z);pl.car.g.rotation.y=pl.angle;onRoad(pl,loc.s);pitStopPose(pl)}
 // tyres past their limit: front scrub (understeer) squeals too, not just slides
 pl.tyF+=(carMem[CF.slipF]-pl.tyF)*Math.min(1,dt*10);pl.tyR+=(carMem[CF.slipR]-pl.tyR)*Math.min(1,dt*10);
 const scrub=sp>8&&!grass?Math.max(0,pl.tyF-1.25,pl.tyR-1.1)*4:0;
 updateAudio(fwdV,gas,boosting,Math.max(pl.drift,scrub),grass,pl.limp);
 return {speed:fwdV,boosting,gas};
}
function updateBots(dt,locked){
 if(mp.on&&!mp.host)return;
 const total=LAPS()*L;
 for(const b of raceBots){
  if(locked){b.v=0;animateCar(b.car,dt,0,0,0,0,false,false);continue}
  if(b.tumble){stepTumble(b,dt);animateCar(b.car,dt,0,0,0,0,false,false);if(!b.finished&&b.dist>=total){b.finished=true;b.finishTime=raceTime}continue}
  const i=wrapI(Math.floor(wrapS(b.dist)/DS));
  let target=botProfile[i]*b.skill;
  if(b.wrecked){target=0;b.laneT=Math.sign(b.lat||1)*(ROAD-1.3)}
  if(b.finished)target=Math.min(target,18);
  else if(!player.finished){const gap=b.dist-player.dist;
   if(gap>70)target*=.92;else if(gap<-70)target*=1.06;}
  // occasional nitro on straights
  if(b.boost>0){b.boost-=dt;target*=1.18}
  else if(!b.finished&&botProfile[i]>=botTop*.98&&Math.random()<dt*.06*(settings.diff+1))b.boost=rand(1,2);
  // traffic: change lane or slow down behind other cars
  for(const o of cars){if(o===b||o.gone)continue;let d=o.dist-b.dist;
   if(d>0&&d<12&&Math.abs(o.lat-b.lat)<2.6){const ov=o===player?Math.hypot(player.vx,player.vz):o.v;
    const left=clamp(o.lat-3.8,-6.2,6.2),right=clamp(o.lat+3.8,-6.2,6.2);
    b.laneT=Math.abs(left-b.lat)<Math.abs(right-b.lat)?left:right;b.avoid=1.2;if(d<6)target=Math.min(target,ov*.97)}}
  b.laneTimer-=dt;if(b.laneTimer<=0){b.laneTimer=rand(2,5);b.offset=rand(-1.8,1.8)}
  b.avoid=Math.max(0,(b.avoid||0)-dt);
  if(!b.avoid)b.laneT+=(clamp(lineLat[wrapI(i+18)]+b.offset,-6,6)-b.laneT)*Math.min(1,dt*.8);
  // pulls like the player's car: full thrust low down, then the power runs out with speed
  const acc=(b.boost>0?24:18)*Math.min(1,.38/Math.max(.05,b.v/46));
  b.v+=clamp(target-b.v,-30*dt,acc*dt);
  b.dist+=b.v*dt;
  // a hit knocks it sideways and spins it a little; both fade as the driver catches it
  b.knockLat=(b.knockLat||0)*Math.exp(-2.5*dt);
  b.spinVel=(b.spinVel||0)*Math.exp(-1.1*dt);b.yawOff=(b.yawOff||0)+b.spinVel*dt;
  if(Math.abs(b.spinVel)<.7){b.yawOff=Math.atan2(Math.sin(b.yawOff),Math.cos(b.yawOff));b.yawOff*=Math.exp(-1.8*dt)}   // caught it
  if(Math.abs(b.yawOff)>.35)b.v*=Math.exp(-dt*1.4*Math.min(1,Math.abs(Math.sin(b.yawOff))+.3));   // sideways: scrubbing speed
  const dl=(b.laneT-b.lat)*Math.min(1,dt*1.6)+b.knockLat*dt;b.lat=clamp(b.lat+dl,-ROAD+1.2,ROAD-1.2);
  const p=trackAt(b.dist,b.lat);b.x=p.x;b.z=p.z;
  const latV=dl/Math.max(dt,1e-3);
  b.angle=p.angle-Math.atan2(latV,Math.max(5,b.v))+b.yawOff;
  b.steer=clamp(-KS[i]*14+latV*.08,-1,1);
  b.car.g.position.set(b.x,0,b.z);b.car.g.rotation.y=b.angle;onRoad(b,b.dist);
  animateCar(b.car,dt,b.v,b.steer,clamp(KS[i]*b.v*b.v*.004,-.08,.08),0,b.boost>0,target<b.v-2);
  const bfx=Math.sin(b.angle),bfz=Math.cos(b.angle);
  if(isRain()&&Math.random()<.5)spray(b.x,b.z,bfx,bfz,b.v,b.gy||0);
  damageSmoke(b,b.x,b.z,bfx,bfz);
  if(!b.finished&&b.dist>=total){b.finished=true;b.finishTime=raceTime}
 }
}
// which car a network message is about: a player's peer id, or 'bot:k' for the k-th bot
const carKey=c=>c===player?mp.id:c.remote?c.id:'bot:'+raceBots.indexOf(c);
const carByKey=k=>k===mp.id?player:k?.startsWith?.('bot:')?raceBots[+k.slice(4)]:cars.find(c=>c.remote&&c.id===k);
let hitCool={};
// spin from a push at the point where two cars touch: the contact sits on this car's box towards the other one
function contactSpin(x,z,ang,ox,oz,Jx,Jz){
 const sa=Math.sin(ang),ca=Math.cos(ang),dx=ox-x,dz=oz-z,al=dx*sa+dz*ca,la=dx*-ca+dz*sa;
 const ac=clamp(al*.55,-2.1,2.1),lc=clamp(la*.55,-.95,.95),rx=sa*ac-ca*lc,rz=ca*ac+sa*lc;
 return (rz*Jx-rx*Jz)/2.1;   // + turns the nose from +z towards +x
}
// another computer says its car hit ours (or, on the host, one of the bots): take our half of the impulse
function takeHit(m){
 const c=carByKey(m.to);if(!c||c.remote||(state!=='race'&&state!=='finished'))return;
 if(hitCool[m.id]>raceTime&&c===player)return;   // we already felt this one ourselves
 if(c.ghost||startGhost())return;
 if(c===player)hitCool[m.id]=raceTime+.45;
 const nx=+m.nx,nz=+m.nz,j=clamp(+m.j||0,0,30),rel=clamp(+m.rel||0,0,60),cx=(+m.hx+c.x)/2,cz=(+m.hz+c.z)/2;
 if(!isFinite(nx+nz+j+rel+cx+cz)||c.tumble)return;
 if(c===player){
  c.vx+=nx*j;c.vz+=nz*j;c.yaw-=contactSpin(c.x,c.z,c.angle,+m.hx,+m.hz,nx*j,nz*j)*.85;
  if(rel>2){shake=Math.min(1,rel/10);thud(rel/12)}
 }else{
  const tp=trackAt(c.dist,c.lat),bt=nx*tp.tx+nz*tp.tz,br=nx*tp.rx+nz*tp.rz;
  c.v=Math.max(0,c.v+bt*j);c.knockLat=(c.knockLat||0)+br*j*1.2;
  c.spinVel=clamp((c.spinVel||0)+contactSpin(c.x,c.z,tp.angle+(c.yawOff||0),+m.hx,+m.hz,nx*j,nz*j)*3.2,-8,8);
 }
 if(rel>2){hurt(c,rel*.008);dentCar(c.car,cx,.7,cz,Math.min(1,rel/10))}
 const ang=c===player?c.angle:Math.atan2(trackAt(c.dist,c.lat).tx,trackAt(c.dist,c.lat).tz),rr=rollSpeed(nx,nz,ang);
 if(rel>rr)startTumble(c,c===player?c.vx:Math.sin(ang)*c.v+nx*j,c===player?c.vz:Math.cos(ang)*c.v+nz*j,nx,nz,(rel-rr)/12);
}
// while there's no contact (ghost start, or either car in the pit lane) the other cars look see-through
function ghostLook(c,on){if(!!c.ghostLook===on)return;c.ghostLook=on;
 // materials shared with our own car (tyres, liners...) stay as they are, or ours would fade too
 const mine=new Set();player.car.g.traverse(o=>{for(const m of [].concat(o.material||[]))mine.add(m)});
 c.car.g.traverse(o=>{for(const m of [].concat(o.material||[])){if(mine.has(m))continue;if(!m.userData.g0)m.userData.g0={t:m.transparent,o:m.opacity,d:m.depthWrite};const g=m.userData.g0;
  m.transparent=on||g.t;m.opacity=on?g.o*.4:g.o;m.depthWrite=on?false:g.d;m.needsUpdate=true}})}
function collisions(){
 for(const o of cars)if(o!==player)ghostLook(o,(state==='race'||state==='finished')&&(startGhost()||!!player.ghost||!!o.ghost));
 // player vs bots (in player's local frame: ellipse test)
 const pl=player,sa=Math.sin(pl.angle),ca=Math.cos(pl.angle);
 // friends' cars (and the bots on a client) are driven elsewhere, so only our car gets pushed
 for(const o of cars){if(o===pl||o.gone||!(o.remote||mp.on&&!mp.host)||Math.abs((o.gy||0)-(pl.gy||0))>2)continue;
  if(o.remote){const ol=locate(o.x,o.z,o.idx??null);o.idx=ol.i;o.ghost=pitGhost(pitZone(ol.s),ol.lat)}
  if(pl.ghost||o.ghost||startGhost())continue;
  const dx=o.x-pl.x,dz=o.z-pl.z,al=dx*sa+dz*ca,la=dx*-ca+dz*sa,e=(al/4.3)**2+(la/2.25)**2;
  if(e<1){const d=Math.hypot(dx,dz)||1,nx=dx/d,nz=dz/d,push=(1-Math.sqrt(e))*2.2;pl.x-=nx*push*.6;pl.z-=nz*push*.6;
   const rel=(pl.vx-Math.sin(o.angle)*o.v)*nx+(pl.vz-Math.cos(o.angle)*o.v)*nz,key=carKey(o);
   if(rel>0&&!(hitCool[key]>raceTime)&&!pl.tumble){
    // our half of the impulse here; the other car gets its half on its own computer through a 'hit' message
    hitCool[key]=raceTime+.45;const j=rel*.8;
    pl.vx-=nx*j;pl.vz-=nz*j;pl.yaw-=contactSpin(pl.x,pl.z,pl.angle,o.x,o.z,-nx*j,-nz*j)*.85;
    mpSend({t:'hit',id:mp.id,to:key,nx,nz,j,rel,hx:pl.x,hz:pl.z});
    if(rel>2){shake=Math.min(1,rel/10);thud(rel/12);hurt(pl,rel*.008);dentCar(pl.car,pl.x+dx/2,.7,pl.z+dz/2,Math.min(1,rel/10));
     for(let k=0;k<8;k++)emit(pl.x+dx/2,.8+(pl.gy||0),pl.z+dz/2,rand(-5,5),rand(2,5),rand(-5,5),.3,.4,0,0xffc060,true)}
    const rp=rollSpeed(nx,nz,pl.angle);if(rel>rp)startTumble(pl,pl.vx,pl.vz,-nx,-nz,(rel-rp)/12);
   }else if(rel>0)pl.vx-=nx*rel*.5,pl.vz-=nz*rel*.5}}
 if(mp.on&&!mp.host)return;
 for(const b of raceBots){
  if(b.tumble||pl.tumble||pl.ghost||startGhost()||Math.abs((b.gy||0)-(pl.gy||0))>2)continue;
  const dx=b.x-pl.x,dz=b.z-pl.z,al=dx*sa+dz*ca,la=dx*-ca+dz*sa;
  const e=(al/4.3)**2+(la/2.25)**2;
  if(e<1){
   const d=Math.hypot(dx,dz)||1,nx=dx/d,nz=dz/d,push=(1-Math.sqrt(e))*2.2;
   pl.x-=nx*push*.5;pl.z-=nz*push*.5;
   const tp=trackAt(b.dist,b.lat),bt=nx*tp.tx+nz*tp.tz,br=nx*tp.rx+nz*tp.rz;
   b.dist+=bt*push*.5;b.lat=clamp(b.lat+br*push*.5,-ROAD+1,ROAD-1);b.laneT=b.lat;
   const rel=(pl.vx-tp.tx*b.v)*nx+(pl.vz-tp.tz*b.v)*nz;
   if(rel>0){
    // equal masses, a bit of bounce: each car gets half of the closing speed (plus the bounce) along the normal
    const j=rel*.8;
    pl.vx-=nx*j;pl.vz-=nz*j;b.v=Math.max(0,b.v+bt*j);b.knockLat=(b.knockLat||0)+br*j*1.2;
    // hit off-centre, the cars spin. the push goes through the bot's bumper or door (a box face),
    // not through its middle, so a nudge on a rear corner swings its tail round (a PIT manoeuvre)
    // the bot's body axes, turned by however far it is already spinning
    const ha=tp.angle+(b.yawOff||0),htx=Math.sin(ha),htz=Math.cos(ha),hrx=-htz,hrz=htx;
    const ab=-(dx*htx+dz*htz),lb=-(dx*hrx+dz*hrz),end=Math.abs(ab)/2.2>Math.abs(lb)/1;
    const ft=end?-Math.sign(ab):0,fr=end?0:-Math.sign(lb),ct=end?Math.sign(ab)*2.1:clamp(ab*.5,-2,2),cr=end?clamp(lb*.7,-.95,.95):Math.sign(lb)*.95;
    const Jx=(htx*ft+hrx*fr)*j,Jz=(htz*ft+hrz*fr)*j,cx=htx*ct+hrx*cr,cz=htz*ct+hrz*cr;
    // spin = (r x J)/I, + turns the nose from +z towards +x
    const I=2.1,spinB=(cz*Jx-cx*Jz)/I,spinP=((cz+dz)*-Jx-(cx+dx)*-Jz)/I;
    b.spinVel=clamp((b.spinVel||0)+spinB*3.2,-8,8);
    pl.yaw-=spinP*.85;
    // a hard enough hit rolls a car over: easiest square into its side, but end-on works too
    const rb=rollSpeed(nx,nz,Math.atan2(tp.tx,tp.tz)),rp=rollSpeed(nx,nz,pl.angle);
    if(rel>rb)startTumble(b,tp.tx*b.v+nx*j,tp.tz*b.v+nz*j,nx,nz,(rel-rb)/12);
    if(rel>rp)startTumble(pl,pl.vx,pl.vz,-nx,-nz,(rel-rp)/12);
    if(rel>2){shake=Math.min(1,rel/10);thud(rel/12);
     hurt(pl,rel*.008);hurt(b,rel*.008);
     dentCar(pl.car,pl.x+dx/2,.7,pl.z+dz/2,Math.min(1,rel/10));dentCar(b.car,pl.x+dx/2,.7,pl.z+dz/2,Math.min(1,rel/10));for(let k=0;k<8;k++)emit(pl.x+dx/2,.8+(pl.gy||0),pl.z+dz/2,rand(-5,5),rand(2,5),rand(-5,5),.3,.4,0,0xffc060,true)}}
  }
 }
 // bots vs bots (track space)
 if(mp.on&&!mp.host)return;
 for(let a=0;a<raceBots.length;a++)for(let c=a+1;c<raceBots.length;c++){const A=raceBots[a],B=raceBots[c],dd=B.dist-A.dist,dl=B.lat-A.lat;
  if(Math.abs(dd)<4.4&&Math.abs(dl)<2.3){const push=(2.3-Math.abs(dl))*.5,s=dl>=0?1:-1;A.lat-=s*push;B.lat+=s*push;A.laneT=A.lat;B.laneT=B.lat;
   const back=dd>0?A:B,front=dd>0?B:A;back.v=Math.min(back.v,front.v)}}
}
const CRITICAL=.85,DMG_RATE=.5;   // cars are built to take a beating: every crash does half of what it used to
function hurt(c,amount){
 amount*=DMG_RATE;
 const before=c.damage;c.damage=Math.min(1,c.damage+amount);
 const live=!c.wrecked&&(state==='race'||state==='finished')&&!c.finished;
 // past critical the car is held together by luck: the next proper hit (or 100%) and it goes up
 // (the crash that makes it critical doesn't count: a hit lasts a few frames, and you get to see the warning)
 if(before<CRITICAL&&c.damage>=CRITICAL)c.critAt=raceTime;
 if(live&&(c.damage>=1||before>=CRITICAL&&amount>=.015&&raceTime-(c.critAt??-9)>1.2))wreck(c);
 if(c!==player)return;
 if(before<CRITICAL&&c.damage>=CRITICAL&&!c.wrecked){bigMessage('CRITICAL DAMAGE<small>One more hit and the car is finished · box now</small>');thud(.8);
  // the big words only for a moment, then the warning sign by the car status stays up
  setTimeout(()=>{if(state==='race'&&!player.wrecked&&$('message').textContent.startsWith('CRITICAL DAMAGE'))$('message').style.display='none'},2200)}
 if(before<.4&&c.damage>=.4)toast('CAR DAMAGED','#ffb02e',1.4);
 if(before<.75&&c.damage>=.75)toast('HEAVY DAMAGE!','#ff4b2e',1.6);
}
// which parts a hit breaks depends on where it lands: the nose takes the engine (radiator) and a front
// wheel, the tail the wing and a rear wheel, the sides their wheels. a wheel past 70% is a flat tyre
const SYS_NAMES={engine:'ENGINE',aero:'WING',brakes:'BRAKES',fl:'FRONT-LEFT TYRE',fr:'FRONT-RIGHT TYRE',rl:'REAR-LEFT TYRE',rr:'REAR-RIGHT TYRE'};
const freshSys=()=>({engine:0,aero:0,brakes:0,fl:0,fr:0,rl:0,rr:0});
function breakParts(c,lx,lz,a){
 const s=c.sys||(c.sys=freshSys()),left=lx>0,front=lz>.8,rear=lz<-.8,side=Math.abs(lx)>.45;
 if(a<.2)return;   // scrapes and taps dent the paint, they don't break anything
 a*=.6;
 const add=(k,v)=>{const was=s[k];s[k]=Math.min(1,s[k]+v);
  if(c===player&&state==='race'){const lim=k.length===2?.7:.5;if(was<lim&&s[k]>=lim)toast(SYS_NAMES[k]+(k.length===2?' PUNCTURE':' DAMAGED'),'#ff7a2e',1.8)}};
 if(front){add('engine',a*.26);add('brakes',a*.08);if(side||Math.random()<.5)add(left?'fl':'fr',a*.36)}
 else if(rear){add('aero',a*.42);if(side||Math.random()<.5)add(left?'rl':'rr',a*.32)}
 else{add(lz>0?(left?'fl':'fr'):(left?'rl':'rr'),a*.28);add('brakes',a*.06)}
}
// turn broken parts into what the C++ car feels: less power (and the odd misfire), less grip, longer braking,
// less downforce, a pull towards a flat tyre
// DRS: on the longest straights, from lap 2. crossing into a zone within a second of the car ahead enables it, and the flap
// then opens by itself on full throttle (closes on the brakes). in limp mode the car's computer keeps it shut
function findDrsZones(){
 // walk the lap once from a corner, so a straight across the start line counts once
 const ok=i=>Math.abs(KS[i%N])<.003,runs=[];let k0=0;while(ok(k0)&&k0<N)k0++;let i0=-1;
 for(let k=k0;k<=k0+N;k++){if(ok(k)&&i0<0)i0=k;if(!ok(k)&&i0>=0){runs.push([i0,k]);i0=-1}}
 DRS_Z=runs.map(([a,b])=>({s0:wrapS(a*DS+50),len:(b-a)*DS-80})).filter(z=>z.len>150)
  .sort((a,b)=>b.len-a.len).slice(0,2);
}
const inDrs=s=>DRS_Z.find(z=>wrapS(s-z.s0)<z.len);
function carAhead(c){let best=null;for(const o of cars){if(o===c||o.dnf||o.gone||o.finished)continue;const d=o.dist-c.dist;if(d>0&&d<L/2&&(!best||d<best.dist-c.dist))best=o}return best}
function updateDrs(pl,limp,locked){
 // from the second lap on, like in F1
 const z=state==='race'&&!locked&&pl.dist>L?inDrs(pl.s):null;
 if(z!==pl.drsZone){pl.drsZone=z;pl.drsOk=false;
  if(z){const a=carAhead(pl),t=a?.marks?.[Math.floor(Math.max(0,pl.dist)/20)];pl.drsOk=t!=null&&raceTime-t<1;
   if(pl.drsOk)toast(limp?'DRS DISABLED · LIMP MODE':'DRS ENABLED',limp?'#ff4b2e':'#4cff8a',1.2)}}
 pl.drsOpen=!!z&&pl.drsOk&&!limp&&(keys.gas||pad.gas>.6)&&!keys.brake&&!(pad.brake>.1);
 carMem[CF.drs]=pl.drsOpen?1:0;
 const el=$('drs'),cls=!z?'':limp&&pl.drsOk?'dis':pl.drsOpen?'open':pl.drsOk?'ok':'zone';if(el.className!==cls)el.className=cls;
}
function sysEffects(c,dt){
 const s=c.sys||freshSys(),flat=k=>s[k]>=.7?(s[k]-.5)*2:0;
 let pw=1-.4*s.engine,top=0;
 // limp mode (engine failing, or the whole car critical): the engine hiccups, a new power level every 1-2 s with a
 // short dip, so the car shudders on the straights. it pulls about half as hard as healthy (0-100 in twice the time),
 // top speed -20%
 const limp=s.engine>=.7||c.damage>=CRITICAL&&!c.wrecked;c.limp=limp;
 if(limp){c.hicT=(c.hicT||0)-dt;c.hicDip=Math.max(0,(c.hicDip||0)-dt);
  if(c.hicT<=0){c.hicT=rand(1,2);c.hicPw=rand(.62,.68);c.hicDip=rand(.1,.18);if(c===player){shake=Math.max(shake,.15);if(pad.on)rumble(.25)}}
  pw=(c.hicPw||.65)*(c.hicDip>0?.72:1);
  top=Math.min(1,.8/((1-.08*c.damage)*(.78+.22*pw)))}
 const flats=['fl','fr','rl','rr'].filter(k=>s[k]>=.7).length;
 if(flats){pw*=1-.22*Math.min(2,flats);c.wob=(c.wob||0)+dt*(6+Math.hypot(c.vx||0,c.vz||0)*.4)}
 return {wob:flats?Math.sin(c.wob)*.05*flats:0,pw,gf:1-.12*Math.max(s.fl,s.fr)-.4*Math.max(flat('fl'),flat('fr')),gr:1-.12*Math.max(s.rl,s.rr)-.4*Math.max(flat('rl'),flat('rr')),
  br:1-.5*s.brakes,ae:1-.85*s.aero,top,limp,pull:(flat('fr')-flat('fl'))*.6+(flat('rr')-flat('rl'))*.3};
}
// a tyre past 70% is flat: the rim scrapes the road and sparks fly at speed, the pad shakes
function rimSparks(c,dt){
 const s=c.sys;if(!s)return;const v=Math.hypot(c.vx,c.vz);if(v<6)return;
 const fx=Math.sin(c.angle),fz=Math.cos(c.angle),rx=-fz,rz=fx;
 for(const [k,f,side] of [['fl',1.3,-1],['fr',1.3,1],['rl',-1.35,-1],['rr',-1.35,1]])if(s[k]>=.7&&Math.random()<dt*v*.6){
  const x=c.x+fx*f+rx*side*.85,z=c.z+fz*f+rz*side*.85;
  for(let i=0;i<3;i++)emit(x,.12+(c.gy||0),z,-fx*rand(2,6)+rand(-2,2),rand(.5,2.5),-fz*rand(2,6)+rand(-2,2),rand(.12,.3),.18,0,0xffb84a,true)}
 if(pad.on&&['fl','fr','rl','rr'].some(k=>s[k]>=.7)&&Math.random()<dt*3)rumble(.15);
}
function backfire(){const pl=player,fx=Math.sin(pl.angle),fz=Math.cos(pl.angle);
 for(let k=0;k<5;k++)emit(pl.x-fx*2.3,.45+(pl.gy||0),pl.z-fz*2.3,-fx*rand(2,5),rand(.2,1),-fz*rand(2,5),.18,.4,1.2,0xff8a2a,true);thud(.35)}
// 100%: the engine lets go in a cloud of smoke and flames, the car rolls to a stop and is out of the race
function wreck(c){
 c.wrecked=true;
 boomVisual(c);shareDamage(c.car,'boom');
 if(c===player){bigMessage('CAR DESTROYED<small>The car blew up · out of the race</small>');setTimeout(()=>{if(state==='race'&&player.wrecked&&!player.finished)retirePlayer()},2600)}
 else{c.dnf=true;c.finished=true;c.finishTime=raceTime;toast(c.name+' IS OUT','#ff7a2e',1.8)}
}
function boomVisual(c){
 const y0=.6+(c.gy||0);
 for(let k=0;k<70;k++)emit(c.x+rand(-1.2,1.2),y0,c.z+rand(-1.2,1.2),rand(-7,7),rand(3,11),rand(-7,7),rand(.3,.9),rand(.8,1.8),3,k%4?0xff7a1a:0xffd25a,true);
 for(let k=0;k<45;k++)emit(c.x+rand(-1,1),y0+.4,c.z+rand(-1,1),rand(-3,3),rand(2,6),rand(-3,3),rand(1,2.4),rand(1,2),2.6,k%2?0x1e1e1e:0x3a3a3a);
 thud(1.6);if(c===player)shake=1;
 // everything bolted on comes off and flies
 for(const o of c.car.parts)if(!o.userData.off)detachPart(c.car,o,2.2);
 for(const k of ['hood','bumper','doorL','doorR','wing'])detachPanel(c.car,k);
 for(let k=0;k<14;k++)shard(c);
 // what's left is burnt
 const pm=c.car.paint;if(pm&&!pm.userData.col){pm.userData.col=pm.color.clone();pm.color.set(0x181818);pm.roughness+=.5}
 if(c.remote)toast(c.name+' BLEW UP','#ff7a2e',1.8);
}
function retirePlayer(){
 player.finished=true;player.dnf=true;player.finishTime=raceTime;lastReward=null;
 state='finished';lastRecord=false;finishFrame=recTotal;
 setTimeout(()=>{if(state==='finished')startReplay()},1200);
}
function damageSmoke(c,x,z,fx,fz){
 if(c.damage<.35||Math.random()>c.damage*.8)return;
 const y=c.car.g.position.y;
 emit(x+fx*1.9+rand(-.3,.3),1+y,z+fz*1.9+rand(-.3,.3),rand(-.5,.5),rand(1.5,3),rand(-.5,.5),rand(1,1.8),.9,3,c.damage>.7?0x2a2a2a:0x8c8c8c);
 if(c.damage>.8&&Math.random()<.3)emit(x+fx*1.9,.9+y,z+fz*1.9,rand(-1,1),rand(2,4),rand(-1,1),.3,.5,0,0xff7a20,true);
}
function spray(x,z,fx,fz,v,y=0){
 if(v<8||Math.random()>Math.min(.9,v/45))return;
 // the tyres throw water up and back; in the air it hangs and drifts on with the car for a moment
 for(let k=0;k<2;k++){const s=(k?1:-1)*rand(.6,1);
  emit(x-fx*2.4-fz*s,.3+y,z-fz*2.4+fx*s,fx*v*.25+rand(-1,1),rand(.6,1.8),fz*v*.25+rand(-1,1),rand(.45,.8),.6,2.6,0xb8c0c8)}
}
function flash(){const f=$('flash');f.style.transition='none';f.style.opacity=1;requestAnimationFrame(()=>{f.style.transition='opacity .4s';f.style.opacity=0})}

// ---------- replay ----------
const REC_MAX=60*14,REC_W=11;   // x z angle speed steer boost | y + quaternion (for rollovers)
const MAX_CARS=8,recBuf=Array.from({length:REC_MAX},()=>new Float32Array(MAX_CARS*REC_W)),recTime=new Float64Array(REC_MAX);
let recTotal=0,rp=null;
function recordFrame(info){
 const f=recBuf[recTotal%REC_MAX];recTime[recTotal%REC_MAX]=raceTime;
 cars.forEach((c,k)=>{const o=k*REC_W,me=c===player;
  f[o]=c.x;f[o+1]=c.z;f[o+2]=c.angle;f[o+3]=me?info.speed:c.v;f[o+4]=me?player.wheelVis||0:c.steer;f[o+5]=(me?info.boosting:c.boost>0)?1:0;
  const g=c.car.g;f[o+6]=g.position.y;f[o+7]=g.quaternion.x;f[o+8]=g.quaternion.y;f[o+9]=g.quaternion.z;f[o+10]=g.quaternion.w});
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
const _rq=new THREE.Quaternion();
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
  c.car.g.position.set(x,A[o+6]+(B[o+6]-A[o+6])*u,z);
  _tq.set(A[o+7],A[o+8],A[o+9],A[o+10]);c.car.g.quaternion.slerpQuaternions(_tq,_rq.set(B[o+7],B[o+8],B[o+9],B[o+10]),u);
  animateCar(c.car,dt*rate,v,A[o+4],0,0,b,false);
  const fx=Math.sin(ang),fz=Math.cos(ang);
  if(isRain())spray(x,z,fx,fz,Math.abs(v),c.car.g.position.y);
  damageSmoke(c,x,z,fx,fz);
  if(c===player){speed=v;boost=b}
 });
 replayCamera(dt*rate,nearFinish);
 updateAudio(speed,Math.abs(speed)>5,boost,0,false);
}
function replayCamera(dt,nearFinish){
 const g=player.car.g,px=g.position.x,py=g.position.y,pz=g.position.z,ang=g.rotation.y,fx=Math.sin(ang),fz=Math.cos(ang);
 rp.shotT-=dt;
 if(nearFinish&&!rp.finishShot){
  rp.finishShot=true;rp.shot=9;rp.shotT=99;
  const p=trackAt(3,(locate(px,pz,null).lat>0?-1:1)*(WALL+2.5));rp.anchor=new THREE.Vector3(p.x,1.6+p.y,p.z);
 }else if(rp.shotT<=0&&!rp.finishShot){
  rp.shot=(rp.shot+1)%4;rp.shotT=2.6;rp.side=-rp.side;
  if(rp.shot===0){const loc=locate(px,pz,null),p=trackAt(loc.s+45,rp.side*(WALL+3));rp.anchor=new THREE.Vector3(p.x,2.2+p.y,p.z)}
 }
 let fov=55;
 switch(rp.shot){
  case 0: case 9: // trackside, long lens
   camera.position.copy(rp.anchor);fov=rp.shot===9?24:32;break;
  case 1: // low, beside the front wheel
   camera.position.set(px+fx*1.5-fz*rp.side*4,.6+py,pz+fz*1.5+fx*rp.side*4);fov=62;break;
  case 2:{ // orbit
   const a=rp.time*.7;camera.position.set(px+Math.cos(a)*9,2.8+py,pz+Math.sin(a)*9);fov=50;break}
  default: // helicopter
   camera.position.set(px-fx*18,14+py,pz-fz*18);fov=48;
 }
 camera.lookAt(px+fx*(rp.shot===3?10:0),.9+py,pz+fz*(rp.shot===3?10:0));
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
 if(on&&drops.length<70&&Math.random()<dt*(9+v*.25))drops.push({x:rand(0,w),y:rand(0,h),r:rand(1.5,5.5),life:rand(1.5,3.5),age:0});
 dctx.clearRect(0,0,w,h);
 for(let i=drops.length-1;i>=0;i--){
  const d=drops[i];d.age+=dt;
  if(v>20){d.x+=(d.x-w/2)/w*v*dt*6;d.y+=(d.y-h/2)/h*v*dt*6;d.age+=dt*v/40} // wind blows them off at speed
  else if(d.r>5)d.y+=dt*d.r*3;
  const a=Math.min(1,(d.life-d.age)/.6);
  if(a<=0||d.x<-10||d.x>w+10||d.y<-10||d.y>h+10){drops.splice(i,1);continue}
  const gr=dctx.createRadialGradient(d.x-d.r*.3,d.y-d.r*.3,0,d.x,d.y,d.r);
  gr.addColorStop(0,`rgba(255,255,255,${.16*a})`);gr.addColorStop(.75,`rgba(200,215,235,${.05*a})`);gr.addColorStop(1,`rgba(30,40,55,${.14*a})`);
  dctx.fillStyle=gr;dctx.beginPath();dctx.arc(d.x,d.y,d.r,0,7);dctx.fill();
 }
}
let boltT=rand(8,15),bolt=0;
function updateLightning(dt){
 if(!isRain()||state==='menu'||state==='paused'){$('lightning').style.opacity=0;hemi.intensity=hemiBase;rainU.uFlash.value=0;return}
 boltT-=dt;
 if(boltT<=0){boltT=rand(10,22);bolt=.4;setTimeout(thunder,rand(400,1400))}
 const lit=bolt>0&&(bolt>.3||(bolt<.18&&bolt>.1));
 bolt=Math.max(0,bolt-dt);
 $('lightning').style.opacity=lit?.5:0;hemi.intensity=hemiBase+(lit?2.5:0);rainU.uFlash.value=lit?.5:0;
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
 // pit stop: a TV shot of the box from its front corner on the lane side while the crew works
 if(pl.pit&&(pl.pit.phase==='stop'||pl.pit.phase==='in'&&pitRel(PIT_S)-pitRel(pl.s)<14)){
  const b=pitRel(PIT_S),c=trackAt(b+8.5,PIT_LAT+4.6),t=trackAt(b-.5,PIT_LAT);
  camTarget.set(c.x,3.1+c.y,c.z);camera.position.lerp(camTarget,1-Math.pow(.02,dt));camLook.set(t.x,.65+t.y,t.z);camera.lookAt(camLook);
  camera.fov+=(50-camera.fov)*Math.min(1,dt*4);camera.updateProjectionMatrix();camYaw=pl.angle;$('speedlines').style.opacity=0;return}
 let look=pl.angle;
 const spd=Math.hypot(pl.vx,pl.vz);
 if(camMode!==2&&spd>6){let slip=Math.atan2(pl.vx,pl.vz)-pl.angle;slip=Math.atan2(Math.sin(slip),Math.cos(slip));look+=clamp(slip,-.9,.9)*.6}
 let da=look-camYaw;da=Math.atan2(Math.sin(da),Math.cos(da));camYaw+=da*Math.min(1,dt*(camMode===2?14:4));
 const sf=clamp(Math.abs(speed)/50,0,1);
 if(camMode===2){
  const gy=pl.gy||0;camera.position.set(pl.x+Math.sin(pl.angle)*.6,1.75+gy,pl.z+Math.cos(pl.angle)*.6);
  camera.lookAt(pl.x+Math.sin(pl.angle)*20,1.4+hAt(pl.s+20),pl.z+Math.cos(pl.angle)*20);
 }else{
  const dist=(camMode===0?8.5:14)+sf*2,h=camMode===0?3.4:6.5;
  camTarget.set(pl.x-Math.sin(camYaw)*dist,h+(pl.gy||0),pl.z-Math.cos(camYaw)*dist);
  camera.position.lerp(camTarget,1-Math.pow(.0008,dt));
  const cl=locate(camera.position.x,camera.position.z,pl.idx),cmax=cl.lat<0&&pitZone(cl.s)?pitZone(cl.s).out-.5:wallAt(cl.i,cl.lat>0?1:-1)-.5;
  if(Math.abs(cl.lat)>cmax){const e=Math.abs(cl.lat)-cmax,sg=Math.sign(cl.lat);camera.position.x-=cl.rx*sg*e;camera.position.z-=cl.rz*sg*e;camera.position.y+=Math.min(2,e*.6)}
  camLook.set(pl.x+Math.sin(camYaw)*6,1.3+(pl.gy||0),pl.z+Math.cos(camYaw)*6);camera.lookAt(camLook);
 }
 if(shake>0){camera.position.x+=rand(-1,1)*shake*.5;camera.position.y+=rand(-1,1)*shake*.35;shake=Math.max(0,shake-dt*2.5)}
 if(boosting)camera.position.y+=rand(-.04,.04);
 const fov=(camera.aspect<1?80:64)+sf*14+(boosting?8:0);camera.fov+=(fov-camera.fov)*Math.min(1,dt*4);camera.updateProjectionMatrix();
 $('speedlines').style.opacity=clamp((Math.abs(speed)-34)/18,0,1)*.9;
 $('speedlines').style.transform=`rotate(${rand(0,6)}deg)`;
}

// ---------- minimap ----------
const mm=$('minimap').getContext('2d');
let mmB,mmS;
const mmX=x=>170+(x-(mmB.a+mmB.b)/2)*mmS,mmY=z=>170+(z-(mmB.c+mmB.d)/2)*mmS;
const mmBase=document.createElement('canvas');mmBase.width=mmBase.height=340;
function buildMinimap(){
 mmB={a:1e9,b:-1e9,c:1e9,d:-1e9};P.forEach(p=>{mmB.a=Math.min(mmB.a,p.x);mmB.b=Math.max(mmB.b,p.x);mmB.c=Math.min(mmB.c,p.z);mmB.d=Math.max(mmB.d,p.z)});
 mmS=290/Math.max(mmB.b-mmB.a,mmB.d-mmB.c);
 const mmPath=new Path2D();P.forEach((p,i)=>i?mmPath.lineTo(mmX(p.x),mmY(p.z)):mmPath.moveTo(mmX(p.x),mmY(p.z)));mmPath.closePath();
 const g=mmBase.getContext('2d');g.clearRect(0,0,340,340);g.lineJoin='round';
 g.strokeStyle='#0008';g.lineWidth=22;g.stroke(mmPath);g.strokeStyle='#cfd6de';g.lineWidth=10;g.stroke(mmPath);
 g.fillStyle='#3cf';if(settings.pads)boostPads.forEach(b=>{const p=trackAt(b.s,b.lat);g.fillRect(mmX(p.x)-4,mmY(p.z)-4,8,8)});
 // the pit lane: a thin yellow line beside the main straight, the box a square on it
 {g.strokeStyle='#ffd21e';g.lineWidth=3;g.beginPath();for(let r=PIT.a;r<=PIT.b;r+=4){const z=pitZone(r),p=trackAt(r,z?-(z.out+(z.wall?PIT_WALL:WALL))/2:-WALL);r===PIT.a?g.moveTo(mmX(p.x),mmY(p.z)):g.lineTo(mmX(p.x),mmY(p.z))}g.stroke();
  const pp=trackAt(PIT_S,PIT_LAT);g.fillStyle='#ffd21e';g.fillRect(mmX(pp.x)-5,mmY(pp.z)-5,10,10)}
 const s=trackAt(0);g.strokeStyle='#111';g.lineWidth=6;g.beginPath();g.moveTo(mmX(s.x-s.rx*9),mmY(s.z-s.rz*9));g.lineTo(mmX(s.x+s.rx*9),mmY(s.z+s.rz*9));g.stroke()}
buildMinimap();boostPads.forEach(b=>b.mesh.visible=!!settings.pads);
function drawMinimap(){
 mm.clearRect(0,0,340,340);mm.drawImage(mmBase,0,0);
 for(const c of [...cars.filter(c=>c!==player&&!c.gone),player]){const me=c===player;mm.fillStyle='#'+c.color.toString(16).padStart(6,'0');mm.beginPath();mm.arc(mmX(c.x),mmY(c.z),me?11:8,0,7);mm.fill();
  if(me){mm.strokeStyle='#fff';mm.lineWidth=4;mm.stroke()}}
}

// ---------- speedometer ----------
// analogue km/h dial with a segmented rev ring around it, digital speed + gear in the middle
// and a nitro arc in the gap at the bottom. the static face is drawn once and cached.
const gauge={cv:$('gauge'),base:null,size:0,max:0,shown:0,rpm:0};
const gctx=gauge.cv.getContext('2d');
const G_START=Math.PI*.75,G_SWEEP=Math.PI*1.5;   // 7:30 round to 4:30
const HUD_FONT='Rajdhani, "Arial Narrow", Arial, sans-serif';
function gaugeLayout(){
 const top=ctl.setup_value(5)*7.2;            // nitro top speed of the current setup, km/h
 gauge.max=Math.ceil(top*1.05/40)*40;
 gauge.step=[20,40,50,80,100].find(st=>gauge.max/st<=8)||100;
 gauge.base=null;
}
function buildGaugeFace(){
 const S=gauge.cv.clientWidth||230,dpr=Math.min(devicePixelRatio||1,2),px=Math.round(S*dpr);
 gauge.size=S;gauge.cv.width=gauge.cv.height=px;
 const b=document.createElement('canvas');b.width=b.height=px;
 const g=b.getContext('2d');g.scale(dpr,dpr);
 const c=S/2,R=S/2-6,max=gauge.max,step=gauge.step;
 const face=g.createRadialGradient(c,c*.75,R*.05,c,c,R);
 face.addColorStop(0,'#1d2533');face.addColorStop(.7,'#0c1018');face.addColorStop(1,'#05070a');
 g.shadowColor='#000c';g.shadowBlur=R*.08;g.fillStyle=face;g.beginPath();g.arc(c,c,R,0,Math.PI*2);g.fill();g.shadowBlur=0;
 g.lineWidth=1.5;g.strokeStyle='#ffffff2e';g.stroke();
 // red band over the last part of the scale
 g.strokeStyle='#e5262688';g.lineWidth=R*.045;g.beginPath();g.arc(c,c,R*.775,G_START+G_SWEEP*.86,G_START+G_SWEEP);g.stroke();
 // ticks: long + number every step, medium at half steps, short at quarters
 g.textAlign='center';g.textBaseline='middle';
 for(let q=0;q<=max/step*4+1e-6;q++){
  const v=q*step/4,a=G_START+G_SWEEP*v/max,major=q%4===0,half=q%2===0;
  const r1=R*.8,r0=r1-R*(major?.13:half?.085:.05);
  g.strokeStyle=major?'#f4f7fb':half?'#ffffffaa':'#ffffff66';g.lineWidth=major?2.2:1.1;
  g.beginPath();g.moveTo(c+Math.cos(a)*r0,c+Math.sin(a)*r0);g.lineTo(c+Math.cos(a)*r1,c+Math.sin(a)*r1);g.stroke();
  if(major){g.fillStyle=v/max>.86?'#ff6a5a':'#dfe6ee';g.font=`700 ${Math.round(R*.135)}px ${HUD_FONT}`;
   g.fillText(String(v),c+Math.cos(a)*R*.6,c+Math.sin(a)*R*.6)}
 }
 g.fillStyle='#8d9aab';g.font=`600 ${Math.round(R*.1)}px ${HUD_FONT}`;g.fillText('KM/H',c,c+R*.5);
 g.fillText('N₂O',c,c+R*.86);
 gauge.base=b;
}
function drawGauge(dt,v,gear,gas,boosting){
 if(!gauge.max)gaugeLayout();
 if(!gauge.base||gauge.cv.clientWidth!==gauge.size)buildGaugeFace();
 const g=gctx,S=gauge.size,dpr=gauge.cv.width/S,c=S/2,R=S/2-6;
 g.setTransform(1,0,0,1,0,0);g.clearRect(0,0,gauge.cv.width,gauge.cv.height);g.drawImage(gauge.base,0,0);
 g.setTransform(dpr,0,0,dpr,0,0);
 const kmh=v*7.2;gauge.shown+=(kmh-gauge.shown)*Math.min(1,dt*10);
 // engine revs: idle when stopped, blips with the throttle on the line
 const want=v<.5?(gas?.62:.1):.1+.9*rpmOf(v);
 gauge.rpm+=(want-gauge.rpm)*Math.min(1,dt*(want>gauge.rpm?9:5));
 // rev ring
 const segs=36,lit=gauge.rpm*segs,shift=gauge.rpm>.92&&(performance.now()/80|0)%2===0;
 g.lineWidth=R*.07;
 for(let i=0;i<segs;i++){
  const a0=G_START+G_SWEEP*i/segs+.012,a1=G_START+G_SWEEP*(i+1)/segs-.012,f=i/segs;
  g.strokeStyle=i<lit?(shift?'#ff2b2b':f>.82?'#ff3b30':f>.66?'#ffc93a':'#4fd2ff'):'#ffffff12';
  g.beginPath();g.arc(c,c,R*.915,a0,a1);g.stroke();
 }
 // nitro arc in the bottom gap
 const nl=Math.PI*.72,nw=Math.PI*.44;
 g.lineWidth=R*.05;g.lineCap='round';
 g.strokeStyle='#ffffff14';g.beginPath();g.arc(c,c,R*.915,nl,nl-nw,true);g.stroke();
 if(player.nitro>.005){
  g.strokeStyle=boosting?'#9df3ff':'#2fb8ff';g.shadowColor='#2fb8ff';g.shadowBlur=boosting?14:6;
  g.beginPath();g.arc(c,c,R*.915,nl,nl-nw*player.nitro,true);g.stroke();g.shadowBlur=0;
 }
 g.lineCap='butt';
 // gear
 g.fillStyle='#0008';g.strokeStyle=shift?'#ff3b30':'#ffffff33';g.lineWidth=1.5;
 g.beginPath();g.roundRect(c-R*.13,c-R*.4,R*.26,R*.24,R*.05);g.fill();g.stroke();
 g.fillStyle=gear==='R'?'#ff6a5a':'#ffd84a';g.font=`700 ${Math.round(R*.21)}px ${HUD_FONT}`;
 g.textAlign='center';g.textBaseline='middle';g.fillText(String(gear),c,c-R*.27);
 // digital speed
 g.fillStyle='#ffffff';g.font=`700 ${Math.round(R*.34)}px ${HUD_FONT}`;
 g.fillText(String(Math.round(gauge.shown)),c,c+R*.27);
 // needle
 const a=G_START+G_SWEEP*clamp(gauge.shown/gauge.max,0,1);
 g.save();g.translate(c,c);g.rotate(a);
 g.shadowColor='#ff3b1f';g.shadowBlur=10;g.fillStyle='#ff4524';
 g.beginPath();g.moveTo(-R*.14,-R*.03);g.lineTo(R*.8,-R*.007);g.lineTo(R*.8,R*.007);g.lineTo(-R*.14,R*.03);g.closePath();g.fill();
 g.restore();
 const hub=g.createRadialGradient(c-R*.02,c-R*.02,0,c,c,R*.09);hub.addColorStop(0,'#5a6270');hub.addColorStop(1,'#14181f');
 g.fillStyle=hub;g.beginPath();g.arc(c,c,R*.085,0,Math.PI*2);g.fill();
 g.strokeStyle='#ff4524';g.lineWidth=1.5;g.stroke();
}
document.fonts?.ready.then(()=>{gauge.base=null});

// ---------- garage ----------
// showroom scene: glossy floor, light strips, turntable
const gScene=new THREE.Scene();gScene.background=new THREE.Color(0x1b1d21);
const gCam=new THREE.PerspectiveCamera(36,innerWidth/innerHeight,.1,100);
// a real workshop: block walls, epoxy floor, roller doors, tool cabinets, tyre racks, a lift and tube lights
{
 const R=17,H=8,box=(w,h,d,mat,x,y,z,ry=0)=>{const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);m.position.set(x,y,z);m.rotation.y=ry;m.castShadow=m.receiveShadow=true;gScene.add(m);return m};
 const floorTex=canvasTex(1024,1024,(g,w,h)=>{paintPixels(g,w,h,(x,y)=>{const v=96+(fbm(x/90,y/90,4,11.38)-.5)*22+(hash2(x,y)-.5)*10+(hash2(x>>1,y>>1)>.985?18:0);return [v,v+1,v+4]});
  g.strokeStyle='rgba(0,0,0,.25)';g.lineWidth=2;for(let i=0;i<=4;i++){g.beginPath();g.moveTo(i*w/4,0);g.lineTo(i*w/4,h);g.stroke();g.beginPath();g.moveTo(0,i*h/4);g.lineTo(w,i*h/4);g.stroke()}});
 floorTex.repeat.set(4,4);
 const floor=new THREE.Mesh(new THREE.PlaneGeometry(R*2,R*2),new THREE.MeshStandardMaterial({map:floorTex,roughness:.28,metalness:.15}));floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;gScene.add(floor);
 // yellow bay markings around the car
 const lineMat=new THREE.MeshStandardMaterial({color:0xe8b81c,roughness:.6});
 for(const [w,d,x,z] of [[.14,11,-3.4,0],[.14,11,3.4,0],[6.94,.14,0,-5.5]]){const m=new THREE.Mesh(new THREE.PlaneGeometry(w,d),lineMat);m.rotation.x=-Math.PI/2;m.position.set(x,.005,z);gScene.add(m)}
 const blockTex=canvasTex(512,512,(g,w,h)=>{paintPixels(g,w,h,(x,y)=>{const row=y/32|0,off=row%2?32:0,mort=y%32<2||(x+off)%64<2;
  const v=mort?132:178+(hash2((x+off)/64|0,row)-.5)*18+(hash2(x,y)-.5)*12;return [v,v,v+3]})});
 blockTex.repeat.set(10,2.4);
 const wallMat=new THREE.MeshStandardMaterial({map:blockTex,roughness:.92}),darkWall=new THREE.MeshStandardMaterial({color:0x2c3036,roughness:.8});
 for(const [x,z,ry] of [[0,-R,0],[0,R,Math.PI],[-R,0,Math.PI/2],[R,0,-Math.PI/2]]){
  const w=new THREE.Mesh(new THREE.PlaneGeometry(R*2,H),wallMat);w.position.set(x,H/2,z);w.rotation.y=ry;w.receiveShadow=true;gScene.add(w);
  const base=new THREE.Mesh(new THREE.PlaneGeometry(R*2,1.2),darkWall);base.position.set(x*.999,.6,z*.999);base.rotation.y=ry;gScene.add(base)}
 const ceil=new THREE.Mesh(new THREE.PlaneGeometry(R*2,R*2),new THREE.MeshStandardMaterial({color:0x2a2d32,roughness:1}));ceil.rotation.x=Math.PI/2;ceil.position.y=H;gScene.add(ceil);
 // roller doors on the back wall with the sign above
 const doorTex=canvasTex(256,256,(g,w,h)=>{for(let y=0;y<h;y+=16){const gr=g.createLinearGradient(0,y,0,y+16);gr.addColorStop(0,'#9aa1a8');gr.addColorStop(.5,'#c5cbd1');gr.addColorStop(1,'#7c838a');g.fillStyle=gr;g.fillRect(0,y,w,16)}});
 const doorMat=new THREE.MeshStandardMaterial({map:doorTex,metalness:.6,roughness:.45});
 for(const x of [-7,7]){const d=new THREE.Mesh(new THREE.PlaneGeometry(9,5.2),doorMat);d.position.set(x,2.6,-R+.02);gScene.add(d);box(9.4,.3,.3,darkWall,x,5.35,-R+.15)}
 const signTex=canvasTex(1024,160,(g,w,h)=>{g.fillStyle='#101318';g.fillRect(0,0,w,h);g.font='bold italic 104px Rajdhani, Arial';g.textAlign='center';g.textBaseline='middle';g.fillStyle='#ffb21e';g.fillText('KOD GARAGE',w/2,h/2+4)},false);
 const sign=new THREE.Mesh(new THREE.PlaneGeometry(9,1.4),new THREE.MeshStandardMaterial({map:signTex,emissive:0xffffff,emissiveMap:signTex,emissiveIntensity:.6}));sign.position.set(0,6.6,-R+.03);gScene.add(sign);
 // tool cabinets + workbench + tool wall on the left
 const cabTex=canvasTex(128,128,(g,w,h)=>{g.fillStyle='#b5161b';g.fillRect(0,0,w,h);g.fillStyle='#7a0d10';for(let y=10;y<h;y+=22)g.fillRect(6,y,w-12,2);g.fillStyle='#d8dde2';for(let y=18;y<h;y+=22)g.fillRect(w/2-14,y,28,3)});
 const cabMat=new THREE.MeshStandardMaterial({map:cabTex,roughness:.45,metalness:.3});
 for(const z of [-9,-6.6]){box(.8,1.1,2.2,cabMat,-R+.45,.55,z)}
 box(1,1,4.5,new THREE.MeshStandardMaterial({color:0x3a3f46,roughness:.6,metalness:.4}),-R+.55,.5,-2.5);box(1.1,.08,4.7,new THREE.MeshStandardMaterial({color:0x8a6a48,roughness:.8}),-R+.55,1.04,-2.5);
 const pegTex=canvasTex(256,128,(g,w,h)=>{g.fillStyle='#6d5a43';g.fillRect(0,0,w,h);g.fillStyle='#4a3c2c';for(let y=6;y<h;y+=12)for(let x=6;x<w;x+=12)g.fillRect(x,y,2,2);
  g.strokeStyle='#cfd5db';g.lineWidth=5;for(let i=0;i<9;i++){const x=16+i*27,l=rand(30,70);g.beginPath();g.moveTo(x,20);g.lineTo(x,20+l);g.stroke();g.beginPath();g.arc(x,20,6,0,7);g.stroke()}},false);
 const peg=new THREE.Mesh(new THREE.PlaneGeometry(4.5,2),new THREE.MeshStandardMaterial({map:pegTex,roughness:.9}));peg.position.set(-R+.03,2.4,-2.5);peg.rotation.y=Math.PI/2;gScene.add(peg);
 // tyre racks + oil drums on the right
 const tyreMat=new THREE.MeshStandardMaterial({color:0x151617,roughness:.9}),rackMat=new THREE.MeshStandardMaterial({color:0x2f5fb8,roughness:.5,metalness:.5});
 for(const z of [-8,-3.5]){for(const y of [.05,1.6,3.15])box(1.1,.08,3.6,rackMat,R-.6,y,z);for(const dz of [-1.6,1.6])for(const dx of [-.5,.5])box(.08,3.3,.08,rackMat,R-.6+dx,1.65,z+dz);
  for(const y of [.55,2.1,3.65])for(let i=0;i<5;i++){const t=new THREE.Mesh(new THREE.TorusGeometry(.33,.14,10,24),tyreMat);t.position.set(R-.6,y,z-1.3+i*.65);t.rotation.y=Math.PI/2;t.castShadow=true;gScene.add(t)}}
 const drumMat=new THREE.MeshStandardMaterial({color:0x1f6f3a,roughness:.5,metalness:.4});
 for(const [x,z] of [[R-1,3.5],[R-1.9,3.9],[R-1.1,4.6]]){const d=new THREE.Mesh(new THREE.CylinderGeometry(.42,.42,1.1,20),drumMat);d.position.set(x,.55,z);d.castShadow=true;gScene.add(d)}
 // two-post lift in the corner
 const liftMat=new THREE.MeshStandardMaterial({color:0x2a64c8,roughness:.4,metalness:.5});
 for(const x of [7,12.5]){box(.45,4.6,.45,liftMat,x,2.3,10);box(1.6,.12,.25,new THREE.MeshStandardMaterial({color:0x3c4148,metalness:.6,roughness:.4}),x+(x<10?.8:-.8),1.2,10)}
 box(6,.25,.35,liftMat,9.75,4.5,10);
 // fluorescent tubes
 const tubeMat=new THREE.MeshBasicMaterial({color:0xf4f8ff});
 for(let i=-2;i<=2;i++)for(const z of [-6,0,6]){const t=new THREE.Mesh(new THREE.BoxGeometry(2.6,.08,.16),tubeMat);t.position.set(i*5.5,H-.15,z);gScene.add(t)}
 gScene.add(new THREE.HemisphereLight(0xf2f5ff,0x3a3c40,.9));
 for(const z of [-6,0,6]){const p=new THREE.PointLight(0xf4f6ff,60,24,1.6);p.position.set(0,H-.6,z);gScene.add(p)}
 const key=new THREE.SpotLight(0xffffff,230,30,.6,.6,1.5);key.position.set(3,H-.4,5);key.castShadow=true;key.shadow.mapSize.set(2048,2048);key.shadow.bias=-.0004;gScene.add(key,key.target);
 const fill=new THREE.SpotLight(0xdfe8ff,120,30,.6,.8,1.5);fill.position.set(-5,H-.4,-4);gScene.add(fill,fill.target);
}
const turntable=new THREE.Group();gScene.add(turntable);
{const disc=new THREE.Mesh(new THREE.CylinderGeometry(3.6,3.7,.08,96),new THREE.MeshStandardMaterial({color:0x2a2e34,metalness:.6,roughness:.35}));disc.position.y=.04;disc.receiveShadow=true;turntable.add(disc);
 const ring=new THREE.Mesh(new THREE.TorusGeometry(3.66,.02,8,128),new THREE.MeshBasicMaterial({color:0xffb21e}));ring.rotation.x=Math.PI/2;ring.position.y=.085;gScene.add(ring)}
// reflections of the workshop itself, captured once from car height
gScene.environment=pmrem.fromScene(gScene,.02,.1,60,{position:new THREE.Vector3(0,1,0)}).texture;gScene.environmentIntensity=.8;

let gCar=null,gIdx=0,gYaw=.6,gDrag=null,gTab='car',gHover=null;
const gCfg=()=>garage.cars[gIdx];
function buildPreview(){
 if(gCar)turntable.remove(gCar.g);
 gCar=makeCar(gCfg().color,1,carOpts(gIdx));
 gCar.g.position.y=.08;gCar.g.traverse(o=>{if(o.isMesh)o.castShadow=true});turntable.add(gCar.g);
}
const hex=c=>'#'+c.toString(16).padStart(6,'0');
// numbers for the stat panel, all derived from the C++ tuning
function carStats(i,cfg){
 setupCfg(i,cfg);
 const top=ctl.setup_value(0),acc=ctl.setup_value(1),grip=ctl.setup_value(2),brk=ctl.setup_value(3),steer=ctl.setup_value(4),ntop=ctl.setup_value(5),burn=ctl.setup_value(6);
 let v=0,t=0;while(v<27.78&&t<20){const rel=Math.max(v,1)/top;v+=(acc*Math.min(1,.32/rel)*(1-.5*rel*rel)-(.8+v*.012+v*v*.00042))*.01;t+=.01}   // same force model as drive()
 const s={top:top*7.2,ntop:ntop*7.2,t100:t*1.75,hp:Math.round(acc*9+top*3.2),handling:grip*steer,braking:brk,nitro:1/burn};
 s.pi=Math.round(s.top*.9+s.hp*.32+s.handling*3+s.braking*1.1-s.t100*14+40);
 return s;
}
const PI_CLASSES=[[0,'D','#5fb0ff'],[600,'C','#4fd18b'],[700,'B','#ffd84a'],[800,'A','#ff8a3a'],[900,'S','#ff3b5c'],[1000,'X','#c56bff']];
const piClass=pi=>{let c=PI_CLASSES[0];for(const k of PI_CLASSES)if(pi>=k[0])c=k;return c};
const STATROWS=[['TOP SPEED','top',v=>Math.round(v)+' km/h',v=>v/460],['0-100 KM/H','t100',v=>v.toFixed(2)+' s',v=>(7-v)/5.5],['POWER','hp',v=>v+' hp',v=>v/800],
 ['HANDLING','handling',v=>Math.round(v),v=>v/80],['BRAKING','braking',v=>Math.round(v),v=>v/110],['NITRO','ntop',v=>Math.round(v)+' km/h',v=>v/650]];
function renderStats(){
 const c=gCfg(),now=carStats(gIdx,c),nxt=gHover?carStats(gIdx,gHover):null,[,cl,col]=piClass(now.pi);
 $('gpi').textContent=now.pi;$('gpiClass').textContent=cl;$('gpiClass').style.background=col;
 $('gstats').innerHTML=STATROWS.map(([label,k,f,n])=>{const w=clamp(n(now[k]),0,1)*100,w2=nxt?clamp(n(nxt[k]),0,1)*100:w;
  const better=nxt&&(k==='t100'?nxt[k]<now[k]-.005:nxt[k]>now[k]+.5);
  return `<div class="gst"><span>${label}</span><div class="bar"><i style="width:${w}%"></i>${nxt&&w2>w?`<i class="up" style="left:${w}%;width:${w2-w}%"></i>`:''}</div><b class="${better?'gain':''}">${f(nxt&&better?nxt[k]:now[k])}</b></div>`}).join('');
 setupCfg(garage.sel,garage.cars[garage.sel]);
}
const UPG_COST=[150,350,650,1000,1500],CAR_COST=[1,1.2,1.1,1.5,1.25,1.4,1.5,1.6];
const upgCost=(k,lvl)=>Math.round(UPG_COST[lvl]*UPGRADES.find(u=>u[0]===k)[4]*CAR_COST[gIdx]/10)*10;
function deltaText(k,c){
 const a=carStats(gIdx,c),b=carStats(gIdx,{...c,[k]:c[k]+1}),out=[];
 if(b.top-a.top>=1)out.push(`+${Math.round(b.top-a.top)} km/h`);
 if(b.hp-a.hp>=1)out.push(`+${b.hp-a.hp} hp`);
 if(a.t100-b.t100>=.01)out.push(`−${(a.t100-b.t100).toFixed(2)} s`);
 if(b.handling-a.handling>=.5)out.push(`+${Math.round(b.handling-a.handling)} handling`);
 if(b.braking-a.braking>=.5)out.push(`+${Math.round(b.braking-a.braking)} braking`);
 if(b.ntop-a.ntop>=1)out.push(`+${Math.round(b.ntop-a.ntop)} nitro km/h`);
 if(k==='nitro')out.push('longer boost');
 return out.slice(0,3).join(' · ');
}
const TABS={
 car:()=>{const m=MODELS[gIdx],s=carStats(gIdx,gCfg());
  return `<div class="gh">SPECIFICATIONS</div><div class="spec">
   <div><small>Top speed</small><b>${Math.round(s.top)} km/h</b></div><div><small>With nitro</small><b>${Math.round(s.ntop)} km/h</b></div>
   <div><small>0-100 km/h</small><b>${s.t100.toFixed(2)} s</b></div><div><small>Power</small><b>${s.hp} hp</b></div>
   <div><small>Class</small><b>${piClass(s.pi)[1]} ${s.pi}</b></div><div><small>Unlock</small><b>${m.wins?m.wins+' win'+(m.wins>1?'s':''):'Starter car'}</b></div></div>
   <p class="gnote">${m.desc}</p>`},
 paint:()=>{const c=gCfg();
  return `<div class="gh">COLOUR</div><div id="gcolors">${PAINTS.map(p=>`<button class="sw${p===c.color?' sel':''}" data-c="${p}" style="background:${hex(p)}"></button>`).join('')}
   <label class="sw pick${PAINTS.includes(c.color)?'':' sel'}" title="Custom color" style="background:${PAINTS.includes(c.color)?'conic-gradient(red,yellow,lime,cyan,blue,magenta,red)':hex(c.color)}"><input type="color" id="gcustom" value="${hex(c.color)}"></label></div>
   <div class="gh">FINISH</div><div class="cards3">${FINISHES.map((f,k)=>`<button class="gcard${k===c.finish?' sel':''}" data-finish="${k}"><b>${f}</b><small>${['Deep clear coat','Metal flake shine','Flat satin look'][k]}</small></button>`).join('')}</div>`},
 wheels:()=>{const c=gCfg();
  return `<div class="gh">RIMS</div><div class="cards2">${RIMS.map((r,k)=>`<button class="gcard${k===c.rims?' sel':''}" data-rims="${k}"><span class="dot" style="background:${hex(r.color)}${r.glow?';box-shadow:0 0 10px '+hex(r.glow):''}"></span><b>${r.name}</b><small>${r.spokes}-spoke</small></button>`).join('')}</div>
   <div class="gh">BRAKE CALIPERS</div><div id="gcalipers">${CALIPERS.map((p,k)=>`<button class="sw${k===c.caliper?' sel':''}" data-cal="${k}" style="background:${hex(p)}"></button>`).join('')}</div>`},
 aero:()=>{const c=gCfg(),info=[['Clean look','No downforce, no drag'],['Ducktail lip','+ a little grip'],['GT wing','+ grip in fast corners, − top speed'],['Swan-neck wing','Most downforce, most drag']];
  return `<div class="gh">REAR WING</div><div class="cards2">${SPOILERS.map((n,k)=>`<button class="gcard${k===c.spoiler?' sel':''}" data-spoiler="${k}" data-hov="spoiler:${k}"><b>${n}</b><small>${info[k][1]}</small></button>`).join('')}</div>`},
 perf:()=>{const c=gCfg(),open=unlocked(gIdx);
  return `<div class="gh">UPGRADES <small>stage 1-5</small></div>`+UPGRADES.map(([k,n,ic,hint])=>{const lvl=c[k],max=lvl>=5,cost=max?0:upgCost(k,lvl);
   return `<div class="uprow" data-hov="${k}:${lvl+1}"><div class="upic">${ic}</div><div class="upmain"><b>${n}</b><small>${hint}</small>
    <div class="lvl">${[1,2,3,4,5].map(x=>`<i class="${x<=lvl?'on':''}"></i>`).join('')}</div>${max?'':`<em>${deltaText(k,c)}</em>`}</div>
    ${max?'<button class="up" disabled>MAX</button>':`<button class="up" data-up="${k}" ${!open||garage.money<cost?'disabled':''}>STAGE ${lvl+1}<small>${cost} CR</small></button>`}</div>`}).join('')},
 setup:()=>{const c=gCfg();
  return `<div class="gh">GEARING</div><div class="slider"><span>Acceleration</span><input type="range" id="sgear" min="-100" max="100" step="5" value="${c.gearing}"><span>Top speed</span></div>
   <div class="gh">BALANCE</div><div class="slider"><span>Grip</span><input type="range" id="sbal" min="-100" max="100" step="5" value="${c.balance}"><span>Drift</span></div>
   <p class="gnote">Short gears pull harder out of corners, long gears give more top speed. Moving the balance towards drift makes the car slide earlier and turn in harder with the handbrake.</p>
   <button class="gbtn wide" id="sreset">Reset setup</button>`}
};
const CAM={car:{d:9.2,h:2.6,ly:.6},paint:{d:7.4,h:2.2,ly:.7,yaw:.75},wheels:{d:4.6,h:.9,ly:.45,yaw:1.25},aero:{d:7,h:3.4,ly:.9,yaw:2.55},perf:{d:6.6,h:1.6,ly:.6,yaw:.35},setup:{d:8,h:2,ly:.6,yaw:1.57}};
function renderGarage(){
 const m=MODELS[gIdx],open=unlocked(gIdx);
 $('gmoney').textContent=garage.money;$('gwins').textContent=garage.wins;
 $('gname').textContent=m.name;$('gdesc').textContent=m.desc;$('gcount').textContent=(gIdx+1)+' / '+MODELS.length;
 $('glock').innerHTML=open?'':`Locked · win <b>${m.wins}</b> race${m.wins>1?'s':''} to unlock (you have ${garage.wins})`;$('glock').style.display=open?'none':'block';
 document.querySelectorAll('#gnav button').forEach(b=>b.classList.toggle('sel',b.dataset.tab===gTab));
 $('gcontent').innerHTML=TABS[gTab]();$('gside').classList.toggle('locked',!open&&gTab!=='car');
 $('gstrip').innerHTML=MODELS.map((mm,k)=>{const s=carStats(k,garage.cars[k]),[,cl,col]=piClass(s.pi),lock=!unlocked(k);
  return `<button class="gcarcard${k===gIdx?' sel':''}${lock?' lock':''}" data-car="${k}"><i style="background:${col}">${cl}</i><b>${mm.name}</b><small>${lock?'Locked · '+mm.wins+' wins':k===garage.sel?'In use':s.pi+' PI'}</small></button>`}).join('');
 renderStats();
 const pick=$('gpick');pick.disabled=!open||garage.sel===gIdx;
 pick.textContent=!open?'LOCKED':garage.sel===gIdx?'SELECTED':'DRIVE THIS CAR';
}
function changeCar(fn,rebuild){const c=gCfg();if(!unlocked(gIdx))return;fn(c);saveGarage();if(rebuild)buildPreview();renderGarage()}
const gc=$('gcontent');
gc.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b||b.disabled)return;const d=b.dataset;
 if(d.c)changeCar(c=>c.color=+d.c,true);
 else if(d.finish)changeCar(c=>c.finish=+d.finish,true);
 else if(d.rims)changeCar(c=>c.rims=+d.rims,true);
 else if(d.cal)changeCar(c=>c.caliper=+d.cal,true);
 else if(d.spoiler)changeCar(c=>c.spoiler=+d.spoiler,true);
 else if(d.up)changeCar(c=>{const k=d.up,cost=upgCost(k,c[k]);if(c[k]>=5||garage.money<cost)return;garage.money-=cost;c[k]++;gHover=null;
  beep(660,.12,.2,'triangle');setTimeout(()=>beep(990,.18,.2,'triangle'),90)});
 else if(b.id==='sreset')changeCar(c=>{c.gearing=0;c.balance=0});
});
gc.addEventListener('change',e=>{if(e.target.id==='gcustom')changeCar(c=>c.color=parseInt(e.target.value.slice(1),16),true)});
gc.addEventListener('input',e=>{
 if(e.target.id==='gcustom'&&gCar&&unlocked(gIdx))gCar.paint.color.set(e.target.value);
 if(e.target.id==='sgear'||e.target.id==='sbal'){const c=gCfg();if(!unlocked(gIdx))return;c[e.target.id==='sgear'?'gearing':'balance']=+e.target.value;saveGarage();renderStats()}
});
// hovering an upgrade / wing previews its effect on the stat bars
gc.addEventListener('pointerover',e=>{const r=e.target.closest('[data-hov]');if(!r)return;const [k,v]=r.dataset.hov.split(':');const c=gCfg();
 if(k==='spoiler'?+v!==c.spoiler:+v<=5){gHover={...c,[k]:+v};renderStats()}});
gc.addEventListener('pointerout',e=>{if(e.target.closest('[data-hov]')&&!e.relatedTarget?.closest?.('[data-hov]')){gHover=null;renderStats()}});
document.querySelectorAll('#gnav button').forEach(b=>b.onclick=()=>{gTab=b.dataset.tab;gHover=null;renderGarage()});
$('gstrip').addEventListener('click',e=>{const b=e.target.closest('[data-car]');if(!b)return;gIdx=+b.dataset.car;gHover=null;buildPreview();renderGarage()});
$('gprev').onclick=()=>{gIdx=(gIdx+MODELS.length-1)%MODELS.length;buildPreview();renderGarage()};
$('gnext').onclick=()=>{gIdx=(gIdx+1)%MODELS.length;buildPreview();renderGarage()};
$('gpick').onclick=()=>{if(!unlocked(gIdx))return;garage.sel=gIdx;saveGarage();renderGarage();beep(880,.15,.2,'triangle')};
$('gback').onclick=()=>closeGarage();
// drag to spin the car
const gView=$('gview');
gView.addEventListener('pointerdown',e=>{gDrag={x:e.clientX,yaw:gYaw};gView.setPointerCapture(e.pointerId)});
gView.addEventListener('pointermove',e=>{if(gDrag)gYaw=gDrag.yaw-(e.clientX-gDrag.x)*.01});
const endDrag=()=>{gDrag=null};gView.addEventListener('pointerup',endDrag);gView.addEventListener('pointercancel',endDrag);
function layoutGarage(){
 // keep the car in the free part of the screen, between the menu and the side panel
 const W=innerWidth,H=innerHeight,r=$('gside').getBoundingClientRect();
 gCam.aspect=W/H;
 if(W>=760)gCam.setViewOffset(W,H,(r.width-130)/2,H*.04,W,H);else gCam.setViewOffset(W,H,0,Math.min(H*.28,(H-r.top)/2),W,H);
 gCam.updateProjectionMatrix();
}
function openGarage(){
 if(state!=='menu')return;
 initAudio();state='garage';gIdx=garage.sel;gTab='car';gHover=null;
 hideHub();$('garage').style.display='block';document.body.classList.add('in-garage');
 buildPreview();renderGarage();layoutGarage();
}
function closeGarage(){
 if(state!=='garage')return;
 state='menu';$('garage').style.display='none';document.body.classList.remove('in-garage');
 buildPlayerCar();showHub(mp.on?'mp':'race');
 if(mp.on)mpSend({t:'car',id:mp.id,car:myCarCfg()});
}
const gLook=new THREE.Vector3();let gDist=9.2,gH=2.6,gLy=.6;
function updateGarage(dt){
 const cam=CAM[gTab],k=Math.min(1,dt*3);
 if(cam.yaw!==undefined&&!gDrag){let d=cam.yaw-gYaw;d=Math.atan2(Math.sin(d),Math.cos(d));gYaw+=d*k}
 else if(!gDrag)gYaw+=dt*.22;
 const a=innerWidth/innerHeight,far=a<1.2?Math.min(1.9,1.2/a):1;   // back off on narrow screens
 gDist+=(cam.d*far-gDist)*k;gH+=(cam.h-gH)*k;gLy+=(cam.ly-gLy)*k;
 gCam.position.set(Math.sin(gYaw)*gDist,gH,Math.cos(gYaw)*gDist);gLook.set(0,gLy,0);gCam.lookAt(gLook);
}

// ---------- main menu (hub) ----------
// the workshop is the backdrop: your car on the turntable, menu on the left, a panel on the right
let hubPanel='race';
const esc=t=>String(t).replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
function hubInfo(){
 if(vault.tampered&&!$('savewarn')){const p=document.createElement('p');p.id='savewarn';p.className='hsub warn';
  p.textContent='Your save was edited outside the game, so it was reset.';document.querySelector('#hpanel section[data-p=race]').prepend(p)}
 const s=carStats(garage.sel,garage.cars[garage.sel]),[,cl,col]=piClass(s.pi);setupCar(garage.sel);
 $('hpiClass').textContent=cl;$('hpiClass').style.background=col;$('hpi').textContent=s.pi;
 $('hcarname').textContent=MODELS[garage.sel].name;
 $('hcarstats').textContent=`${Math.round(s.top)} km/h · 0-100 in ${s.t100.toFixed(2)} s · ${s.hp} hp`;
 $('hmoney').textContent=garage.money;$('hwins').textContent=garage.wins;$('hname').textContent=playerName();
}
function showHub(panel=hubPanel){
 state='menu';hubPanel=panel;
 document.body.classList.add('in-hub');$('hub').style.display='block';
 document.querySelectorAll('#hnav button').forEach(b=>b.classList.toggle('sel',b.dataset.p===(panel==='results'?(mp.on?'mp':'race'):panel)));
 document.querySelectorAll('#hpanel section').forEach(sec=>sec.classList.toggle('on',sec.dataset.p===panel));
 if(gIdx!==garage.sel||!gCar){gIdx=garage.sel;buildPreview()}
 hubInfo();mpRender();layoutHub();
}
function hideHub(){document.body.classList.remove('in-hub');$('hub').style.display='none'}
document.querySelectorAll('#hnav button').forEach(b=>b.onclick=()=>{const p=b.dataset.p;initAudio();
 if(p==='garage'){openGarage();return}
 if(p==='settings'){openSettings('hub');return}
 showHub(p)});
function layoutHub(){
 const W=innerWidth,H=innerHeight;gCam.aspect=W/H;
 if(W>=760)gCam.setViewOffset(W,H,W*.11,H*.03,W,H);else gCam.setViewOffset(W,H,0,H*.2,W,H);
 gCam.updateProjectionMatrix();
}
let hubYaw=.6;
function updateHubCam(dt){
 hubYaw+=dt*.18;const a=innerWidth/innerHeight,far=a<1.2?Math.min(1.9,1.2/a):1;
 gCam.position.set(Math.sin(hubYaw)*9.2*far,2.4,Math.cos(hubYaw)*9.2*far);gCam.lookAt(0,.6,0);
}

// ---------- multiplayer ----------
// Peer to peer over WebRTC (PeerJS). The host's browser is the server: it runs the bots and passes
// every player's position on to the others. Rooms are found by a short code through the free PeerJS
// matchmaking server, so nothing has to be hosted. ?peer=host:port uses your own PeerJS server instead.
const INVITE=(new URLSearchParams(location.search).get('room')||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
const MP_MAX=4,MP_RATE=1/30,MP_RATE_RELAY=1/15,CODE_CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const mp={on:false,host:false,peer:null,conns:new Map(),conn:null,id:'',code:'',players:[],order:[],sendT:0,racing:false,seen:new Map(),hostSeen:0,beatT:0,
 fast:null,fasts:new Map(),rtt:new Map(),rtt0:0,pings:{},pings0:[],seq:0,racers:[],loaded:new Set(),waiting:false,goAt:0,waitT:0};
// a closed tab or phone app often never reports its connection as closed, so everyone says "still here"
// once a second and whoever goes quiet for MP_TIMEOUT seconds is dropped
const MP_BEAT=1,MP_TIMEOUT=12;
const nowS=()=>performance.now()/1000;
const playerName=()=>store.get('kod-name')||'Driver';
$('mpname').value=playerName();
$('mpname').addEventListener('change',e=>{const n=e.target.value.trim().slice(0,12)||'Driver';e.target.value=n;store.set('kod-name',n);$('hname').textContent=n;
 if(mp.on){mpSend({t:'name',id:mp.id,name:n});if(mp.host){mp.players.find(p=>p.id===mp.id).name=n;mpLobby()}}});
const myCarCfg=()=>{const i=garage.sel,c=garage.cars[i];return {m:i,c:c.color,r:c.rims,s:c.spoiler,f:c.finish,k:c.caliper}};
function mpStatus(t,ok=false){$('mpstatus').textContent=t;$('mpstatus').classList.toggle('ok',ok)}
function loadPeer(){
 if(window.Peer)return Promise.resolve();
 return new Promise((res,rej)=>{const sc=document.createElement('script');sc.src='https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js';
  sc.onload=res;sc.onerror=()=>rej(new Error('script'));document.head.appendChild(sc)});
}
// many phone networks and some Wi-Fi won't let two players connect directly. STUN servers help them find a
// way through; when there is none, a TURN server relays the race between them (free public ones, several,
// so one being down doesn't stop the game)
const ICE_SERVERS=[
 {urls:['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302','stun:stun2.l.google.com:19302']},
 {urls:'stun:stun.cloudflare.com:3478'},
 {urls:['turn:eu-0.turn.peerjs.com:3478','turn:us-0.turn.peerjs.com:3478'],username:'peerjs',credential:'peerjsp'},
 {urls:['turn:openrelay.metered.ca:80','turn:openrelay.metered.ca:443','turn:openrelay.metered.ca:443?transport=tcp','turns:openrelay.metered.ca:443'],username:'openrelayproject',credential:'openrelayproject'}];
// ---------- relay ----------
// when two players can't connect directly at all, the room runs through a public MQTT broker over a secure
// websocket (port 443/8084/8884, which networks almost never block). the host listens on every broker; a
// player who can't get through directly uses the first broker that answers. it looks like a PeerJS
// connection to the rest of the code: send(), open, peer, 'open' / 'data' / 'close' events
const RELAY_BROKERS=['wss://broker.emqx.io:8084/mqtt','wss://broker.hivemq.com:8884/mqtt','wss://test.mosquitto.org:8081/mqtt'];
const relayTopic=(code,who)=>'kodracing3d/v1/'+code.toLowerCase()+'/'+who;
const brokerList=()=>{const q=new URLSearchParams(location.search).get('relay');return q?[q]:RELAY_BROKERS};
let mqttLoading=null;
function loadMqtt(){if(window.mqtt)return Promise.resolve();
 return mqttLoading||(mqttLoading=new Promise((res,rej)=>{const sc=document.createElement('script');sc.src='https://cdn.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js';
  sc.onload=res;sc.onerror=()=>{mqttLoading=null;rej(new Error('mqtt'))};document.head.appendChild(sc)}))}
function brokerConnect(url,ms=10000){return new Promise((res,rej)=>{let cl;
 try{cl=mqtt.connect(url,{connectTimeout:ms,reconnectPeriod:0,clean:true,keepalive:90})}catch(e){rej(e);return}
 const t=setTimeout(()=>{try{cl.end(true)}catch(e){}rej(new Error('timeout'))},ms+300);
 cl.once('connect',()=>{clearTimeout(t);res(cl)});cl.on('error',e=>console.warn('relay',url,e&&e.message))})}
class RelayConn{
 constructor(client,out,peer,wrap){this.client=client;this.out=out;this.peer=peer;this.wrap=wrap;this.open=true;this.h={}}
 on(ev,fn){(this.h[ev]=this.h[ev]||[]).push(fn);return this}
 emit(ev,a){(this.h[ev]||[]).forEach(f=>{try{f(a)}catch(e){console.error(e)}})}
 send(m){if(this.open)try{this.client.publish(this.out,JSON.stringify(this.wrap?{f:this.wrap,m}:m),{qos:0})}catch(e){}}
 close(){if(!this.open)return;this.open=false;this.emit('close')}
}
// host: listen on every broker that answers (and keep trying the ones that don't), a new player shows up with their first 'hello'
async function relayHost(code){
 try{await loadMqtt()}catch(e){return}
 mp.relay=[];
 const hosting=()=>mp.on&&mp.host&&mp.code===code;
 const warned=new Set();
 const listen=url=>brokerConnect(url).then(cl=>{
  if(!hosting()){cl.end(true);return}
  mp.relay.push(cl);const conns=new Map();
  cl.subscribe(relayTopic(code,'host'));
  cl.on('message',(topic,buf)=>{let w;try{w=JSON.parse(buf.toString())}catch(e){return}
   const f=String(w&&w.f||'').slice(0,64),m=w&&w.m;if(!f||!m)return;
   let c=conns.get(f);
   if(!c||!c.open){if(m.t!=='hello')return;c=new RelayConn(cl,relayTopic(code,f),f);conns.set(f,c);mpAccept(c);c.emit('open')}
   c.emit('data',m)});
  cl.on('close',()=>{mp.relay=(mp.relay||[]).filter(x=>x!==cl);for(const c of conns.values())c.close();
   if(hosting())setTimeout(()=>hosting()&&listen(url),3000)});
 }).catch(e=>{if(!warned.has(url)){warned.add(url);console.warn('relay',url,e&&e.message)}if(hosting())setTimeout(()=>hosting()&&listen(url),5000)});
 brokerList().forEach(listen);
}
// player: the first broker that answers carries this player's room
async function relayJoin(code,id){
 await loadMqtt();
 let cl=null;for(const url of brokerList()){try{cl=await brokerConnect(url);break}catch(e){console.warn('relay',url,e.message)}}
 if(!cl)throw new Error('no broker');
 await new Promise(res=>cl.subscribe(relayTopic(code,id),res));
 const conn=new RelayConn(cl,relayTopic(code,'host'),'host',id);
 cl.on('message',(t,buf)=>{let m;try{m=JSON.parse(buf.toString())}catch(e){return}conn.emit('data',m)});
 cl.on('close',()=>conn.close());
 return {conn,client:cl};
}
function peerOpts(){
 const config={iceServers:ICE_SERVERS},q=new URLSearchParams(location.search).get('peer');if(!q)return {debug:0,config};
 const [host,port]=q.split(':');return {host,port:+port||443,path:'/',secure:!!port&&+port===443,debug:0,config};
}
const roomId=code=>'kodracing3d-'+code.toLowerCase();
const newCode=()=>Array.from({length:5},()=>CODE_CHARS[Math.random()*CODE_CHARS.length|0]).join('');
function peerError(err){
 const why={'peer-unavailable':'Room not found. Check the code — the host must keep the game open.','network':'Lost the connection to the matchmaking server.',
  'server-error':'The matchmaking server is not answering. Try again in a minute.','browser-incompatible':'This browser can\'t play online.','socket-error':'Lost the connection to the matchmaking server.'}[err.type];
 mpStatus(why||'Connection problem: '+(err.type||err.message));
}
async function mpCreate(){
 if(mp.on)return;
 mpStatus('Creating room…',true);
 try{await loadPeer()}catch(e){mpStatus('Could not load the online module. Check your internet connection.');return}
 const tryCode=attempt=>{
  const code=newCode(),peer=new Peer(roomId(code),peerOpts());
  peer.on('open',()=>{Object.assign(mp,{on:true,host:true,peer,code,id:'host',conns:new Map(),racing:false,
    players:[{id:'host',name:playerName(),car:myCarCfg(),here:true,ready:false,v:GAME_VERSION}]});mpStatus('Room open. Send the code to your friends!',true);mpLobby();mpRender();relayHost(code)});
  peer.on('connection',conn=>conn.metadata?.fast?mpAcceptFast(conn):mpAccept(conn));
  peer.on('error',err=>{if(err.type==='unavailable-id'&&attempt<4){peer.destroy();tryCode(attempt+1)}else{peerError(err);if(!mp.on)peer.destroy()}});
  peer.on('disconnected',()=>{if(mp.on&&!peer.destroyed)peer.reconnect()});
 };
 tryCode(0);
}
// joining goes in three steps, each one shown, and none of them can hang: reach the matchmaking server,
// open a direct line to the host, get the room back. a step that stalls is tried once more, then explained
let joining=null;
async function mpJoin(){
 if(mp.on||joining)return;
 const code=$('mpcode').value.toUpperCase().replace(/[^A-Z0-9]/g,'');$('mpcode').value=code;
 if(code.length<4){mpStatus('Enter the room code your friend sent you.');return}
 mpStatus('Joining room '+code+'… (connecting)',true);$('mpjoin').disabled=true;
 const job=joining={code,done:false};
 const myId='r'+Math.random().toString(36).slice(2,10);
 const finish=msg=>{if(joining!==job||job.done)return;job.done=true;joining=null;clearTimeout(job.timer);clearInterval(job.hello);$('mpjoin').disabled=false;
  if(!mp.on){try{job.peer&&job.peer.destroy()}catch(e){}try{job.relay&&job.relay.end(true)}catch(e){}if(msg)mpStatus(msg)}};
 // wire a connection (direct or relayed) into the room
 const attach=(conn,id,peer,how)=>{
  if(joining!==job||job.done||mp.on)return;
  clearTimeout(job.timer);
  if(job.peer&&job.peer!==peer)try{job.peer.destroy()}catch(e){}
  Object.assign(mp,{on:true,host:false,peer,conn,code,id,racing:false,hostSeen:nowS(),relayClient:job.relay&&how==='relay'?job.relay:null});
  conn.on('data',m=>{if(joining===job&&m&&(m.t==='lobby'||m.t==='nope'))finish();mpOnMessage(m,conn)});
  conn.on('close',()=>{if(mp.on&&mp.conn===conn){mpEnd();mpStatus('The host closed the room.')}});
  const hello={t:'hello',name:playerName(),car:myCarCfg(),v:GAME_VERSION};conn.send(hello);
  // the relay doesn't promise delivery: say hello again until the room answers
  if(how==='relay')job.hello=setInterval(()=>{if(joining===job&&mp.conn===conn)conn.send(hello);else clearInterval(job.hello)},2000);
  mpStatus('Joining room '+code+'… (waiting for the host'+(how==='relay'?', relayed':'')+')',true);
  job.timer=setTimeout(()=>{if(joining!==job)return;const msg='Connected, but the host didn\'t let you in. Ask them to check their game, then try again.';
   if(mp.on)mpEnd(true);finish(msg);mpStatus(msg)},15000);
 };
 // plan B: through the relay
 const viaRelay=async why=>{
  if(joining!==job||job.done||job.relaying||mp.on)return;job.relaying=true;
  mpStatus('Joining room '+code+'… (direct connection blocked, trying the relay)',true);
  try{const {conn,client}=await relayJoin(code,myId);job.relay=client;attach(conn,myId,null,'relay')}
  catch(e){console.warn('relay join',e&&e.message);finish(why||'Couldn\'t reach your friend directly or through the relay. Check your internet and the room code, then try again.')}
 };
 const forceRelay=new URLSearchParams(location.search).has('forcerelay');
 if(forceRelay){viaRelay();return}
 // plan A: direct, through PeerJS
 try{await loadPeer()}catch(e){viaRelay();return}
 const peer=new Peer(peerOpts());job.peer=peer;
 job.timer=setTimeout(()=>viaRelay(),9000);
 peer.on('open',id=>{
  if(joining!==job||job.done||job.relaying)return;
  mpStatus('Joining room '+code+'… (connecting to your friend)',true);
  clearTimeout(job.timer);job.timer=setTimeout(()=>viaRelay(),10000);
  const conn=peer.connect(roomId(code),{reliable:true,serialization:'json'});
  conn.on('open',()=>{if(job.relaying)return;attach(conn,id,peer,'direct');
   const fast=peer.connect(roomId(code),{reliable:false,serialization:'json',metadata:{fast:1}});
   fast.on('open',()=>{if(mp.conn===conn)mp.fast=fast;else fast.close()});
   fast.on('data',m=>{if(m&&m.t==='s'&&mp.conn===conn)mpOnMessage(m,fast)});
   fast.on('close',()=>{if(mp.fast===fast)mp.fast=null})});
 });
 peer.on('error',err=>{
  if(joining!==job||job.done)return;
  if(err.type==='peer-unavailable'){finish('Room '+code+' not found. Check the code: the host must have the room open right now.');return}
  viaRelay()});
}
// the car positions go on a second, unordered line: a lost packet is sent again, but it doesn't hold up the
// ones behind it (on the main line everything waits for it, and the cars stutter, then jump)
function mpAcceptFast(conn){
 conn.on('open',()=>{if(mp.conns.has(conn.peer))mp.fasts.set(conn.peer,conn);else conn.close()});
 conn.on('data',m=>{if(m&&m.t==='s'&&mp.conns.has(conn.peer))mpOnMessage(m,conn)});
 conn.on('close',()=>{if(mp.fasts.get(conn.peer)===conn)mp.fasts.delete(conn.peer)});
}
function mpAccept(conn){
 conn.on('open',()=>{
  if(mp.players.length>=MP_MAX){conn.send({t:'nope',why:'The room is full.'});setTimeout(()=>conn.close(),300);return}
  if(mp.players.some(p=>!p.here)){conn.send({t:'nope',why:'A race is running in this room. Try again when it ends.'});setTimeout(()=>conn.close(),300);return}
  mp.conns.set(conn.peer,conn);mp.seen.set(conn.peer,nowS());
 });
 conn.on('data',m=>mpOnMessage(m,conn));
 conn.on('close',()=>mpDrop(conn.peer));
 conn.on('error',()=>mpDrop(conn.peer));
}
// host: a player is gone (left, closed the game or stopped answering)
function mpDrop(id){
 const c=mp.conns.get(id);if(!c)return;
 mp.conns.delete(id);mp.seen.delete(id);mp.rtt.delete(id);delete mp.pings?.[id];try{c.close()}catch(e){}try{mp.fasts.get(id)?.close()}catch(e){}mp.fasts.delete(id);
 const p=mp.players.find(p=>p.id===id);mp.players=mp.players.filter(p=>p.id!==id);
 if(p)toast(p.name+' left','#ffb02e',1.6);mpGone(id);mpBroadcast({t:'left',id});mpLobby();mpShowWaiting();mpCheckStart();
}
// host: to every client (except one). client: to the host.
function mpBroadcast(m,except){for(const [id,c] of mp.conns)if(id!==except&&c.open)c.send(m)}
function mpSend(m){if(!mp.on)return;if(mp.host)mpBroadcast(m);else if(mp.conn?.open)mp.conn.send(m)}
// positions: on the fast line where there is one; through a relay only every other one (public brokers, slower)
function mpBroadcastFast(m,except){for(const [id,c] of mp.conns){if(id===except||!c.open)continue;if(c instanceof RelayConn&&m.n&1)continue;const f=mp.fasts.get(id);(f?.open?f:c).send(m)}}
function mpSendFast(m){if(!mp.on)return;if(mp.host)mpBroadcastFast(m);else{const c=mp.fast?.open?mp.fast:mp.conn;if(c?.open)c.send(m)}}
// one-way delay to whoever sent a position: half the ping (plus, for another player, the host's leg to them)
// the ping: the quickest of the last few. a frame that froze or a packet sent twice only ever makes one slower
const pingOf=(a,r)=>{a.push(r);if(a.length>6)a.shift();return Math.min(...a)};
const mpLead=o=>clamp((mp.host?(mp.rtt.get(o.id)||.08)/2:(mp.rtt0||.08)/2+(o.lead||0)),0,.25);
function mpLobby(){
 if(!mp.host)return;
 mp.cfg={v:GAME_VERSION,laps:settings.laps,tod:settings.tod,weather:settings.weather,diff:settings.diff,bots:settings.mpbots,stock:settings.mpstock,pull:settings.pull,pads:settings.pads,track:TRACK};
 mpBroadcast({t:'lobby',players:mp.players,cfg:mp.cfg,code:mp.code});mpRender();
}
function mpOnMessage(m,conn){try{mpOnMessage0(m,conn)}catch(e){console.error('multiplayer message failed',m&&m.t,e)}}
function mpOnMessage0(m,conn){
 if(!m||typeof m!=='object')return;
 if(mp.host){
  const from=conn.peer;
  if(mp.conns.has(from))mp.seen.set(from,nowS());
  if(m.t==='hb'){if(m.ts!=null)conn.send({t:'po',ts:m.ts});return}
  if(m.t==='po'){const r=performance.now()/1000-m.ts;if(r>=0&&r<5)mp.rtt.set(from,pingOf(mp.pings[from]=mp.pings[from]||[],r));return}
  if(m.t==='bye'){mpDrop(from);return}
  if(m.t==='hello'){if(!mp.conns.has(from)||mp.players.some(p=>p.id===from))return;
   mp.players.push({id:from,name:String(m.name||'Driver').slice(0,12),car:m.car,here:true,ready:false,v:String(m.v||'').slice(0,8)});
   toast(String(m.name||'Driver').slice(0,12)+' joined','#5fe08a',1.6);beep(880,.12,.2,'triangle');mpLobby();return}
  if(m.id!==from)return;   // clients only speak for themselves
  const p=mp.players.find(p=>p.id===from);
  if(m.t==='name'&&p){p.name=String(m.name).slice(0,12);mpLobby();return}
  if(m.t==='car'&&p){p.car=m.car;mpLobby();return}
  if(m.t==='ready'&&p){p.ready=!!m.v;mpLobby();return}
  if(m.t==='out'&&p){p.here=true;mpLobby()}
  if(m.t==='loaded'){mpLoaded(from);return}
  if(m.t==='s'){m.l=+((mp.rtt.get(from)||.08)/2).toFixed(3);mpBroadcastFast(m,from)}else mpBroadcast(m,from);
  mpHandle(m);
  return;
 }
 mp.hostSeen=nowS();
 if(m.t==='hb'){if(m.ts!=null)conn.send({t:'po',ts:m.ts,id:mp.id});return}
 if(m.t==='po'){const r=performance.now()/1000-m.ts;if(r>=0&&r<5)mp.rtt0=pingOf(mp.pings0=mp.pings0||[],r);return}
 if(m.t==='bye'){mpEnd();mpStatus('The host closed the room.');return}
 if(m.t==='nope'){mpStatus(m.why);mpEnd(true);return}
 if(m.t==='lobby'){mp.players=m.players;mp.cfg=m.cfg;Object.assign(settings,{laps:m.cfg.laps,tod:m.cfg.tod,weather:m.cfg.weather,diff:m.cfg.diff,mpbots:m.cfg.bots,mpstock:m.cfg.stock?1:0,pull:m.cfg.pull?1:0,pads:m.cfg.pads===0?0:1});showPads();
  // the room races on the host's track
  if(TRACKS[m.cfg.track])switchTrack(m.cfg.track|0);
  syncSegs();if(state==='menu')applyTimeOfDay();if(m.cfg.v!==GAME_VERSION)mpStatus('The host runs '+(m.cfg.v?'version '+String(m.cfg.v).slice(0,8):'an older version')+', you run '+GAME_VERSION+'. Everyone needs the same one: reload the page (Ctrl+F5, on a phone pull down to refresh).');
  else mpStatus('Connected to room '+mp.code+'.',true);mpRender();return}
 mpHandle(m);
}
// messages both sides act on
function mpHandle(m){
 if(m.t==='go'){mpStartRace(m);return}
 if(m.t==='ld'){if(!mp.host&&mp.waiting){mp.loaded=new Set(m.ids);mpShowWaiting()}return}
 if(m.t==='cd'){if(!mp.host)mpBeginCountdown(m.lead-(mp.rtt0||0)/2);return}
 if(m.t==='hit'){if(m.to===mp.id||mp.host&&String(m.to).startsWith('bot:'))takeHit(m);return}
 if(m.t==='dent'||m.t==='boom'||m.t==='fix'){remoteDamage(m);return}
 if(m.t==='left'||m.t==='out'){if(m.id!==mp.id)mpGone(m.id,m.t==='out');return}
 if(m.t==='s'){
  if(mp.waiting&&!mp.host&&state==='countdown'){const mv=(m.b||[]).concat([m.p]).some((p,k)=>{const o=k<(m.b||[]).length?raceBots[k]:cars.find(c=>c.remote&&c.id===m.id),f=o?.p0;return f&&Math.hypot(p[0]-f[0],p[1]-f[1])>3});
   if(mv){mpBeginCountdown(-3);bigMessage('GO!<small>the race had already started</small>')}}
  const r=cars.find(c=>c.remote&&c.id===m.id);if(r&&!r.gone){r.lead=m.l||0;pushSample(r,m.p,m.ts,m.n)}
  if(m.b&&!mp.host)m.b.forEach((p,k)=>{const b=raceBots[k];if(b)pushSample(b,p,m.ts,m.n)});
 }
}
function mpGone(id,stillHere){
 const r=cars.find(c=>c.remote&&c.id===id);
 if(r&&(state==='race'||state==='countdown'||state==='finished'||state==='replay')){if(!r.finished){r.gone=true;r.car.g.visible=false}}
 mpShowWaiting();
 if(!stillHere&&!mp.host){mp.players=mp.players.filter(p=>p.id!==id);mpRender()}
}
function mpOut(){
 if(!mp.on||!mp.racing)return;
 mp.racing=false;mpSend({t:'out',id:mp.id});
 if(mp.host){mp.players.find(p=>p.id==='host').here=true;mpLobby()}
}
function mpLeave(){
 if(!mp.on)return;
 mpSend({t:'bye',id:mp.id});
 joining=null;$('mpjoin').disabled=false;
 mpEnd();mpStatus('');
}
function mpEnd(quiet){
 joining=null;$('mpjoin').disabled=false;
 const wasClient=mp.on&&!mp.host;
 try{mp.peer&&mp.peer.destroy()}catch(e){}
 for(const cl of mp.relay||[])try{cl.end(true)}catch(e){}
 try{mp.relayClient&&mp.relayClient.end(true)}catch(e){}
 mp.relay=[];mp.relayClient=null;
 Object.assign(mp,{on:false,host:false,peer:null,conns:new Map(),conn:null,id:'',code:'',players:[],order:[],racing:false,seen:new Map(),hostSeen:0,fast:null,fasts:new Map(),rtt:new Map(),rtt0:0,pings:{},pings0:[],waiting:false,goAt:0});
 for(const r of cars)if(r.remote){r.gone=true;r.car.g.visible=false}
 if(wasClient&&['countdown','race','finished','replay','paused'].includes(state)){
  // the bots were driven by the host, so this race can't go on
  $('pause').style.display='none';audio.ctx&&audio.ctx.resume();toMenu();showHub('mp');return}
 if(state==='menu')showHub(hubPanel==='results'?'race':hubPanel);else mpRender();
}
// the ping next to each player in the lobby: the host sees everyone's, a player sees their own line to the host
function mpPingText(p){
 let r=0,relay=false;
 if(mp.host&&p.id!=='host'){r=mp.rtt.get(p.id)||0;relay=mp.conns.get(p.id) instanceof RelayConn}
 else if(!mp.host&&(p.id==='host'||p.id===mp.id)){r=mp.rtt0;relay=!!mp.relayClient&&!mp.peer}
 if(!r)return '';const ms=Math.round(r*1000);
 return ` · <span style="color:${ms<80?'#5fe08a':ms<160?'#ffd21e':'#ff6a4a'}">${ms} ms${relay?' (relay)':''}</span>`}
const mpVer=p=>p.id===mp.id?GAME_VERSION:p.id==='host'?mp.cfg?.v:p.v;
function mpRender(){
 $('mpout').hidden=mp.on;$('mpin').hidden=!mp.on;
 if(!mp.on)return;
 $('mproom').textContent=mp.code;
 $('mpcount').textContent=mp.players.length+' / '+MP_MAX;
 $('mptrack').textContent=mp.host?'':'Track: '+TRACKS[TRACK].name;
 $('mplist').innerHTML=mp.players.map(p=>`<div class="mpp"><i style="background:${hex(p.car?.c??0x888888)}"></i><div><b>${esc(p.name)}</b>${p.id===mp.id?' <small>(you)</small>':''}<br><small>${esc(MODELS[p.car?.m|0]?.name||'')}${mpPingText(p)}</small></div><span class="mptags">${p.id==='host'?'<em>HOST</em>':''}${mpVer(p)!==GAME_VERSION?'<em class="nrdy">'+(mpVer(p)?esc(mpVer(p)):'OLD VERSION')+'</em>':''}${p.here===false?'<em>RACING</em>':p.ready?'<em class="rdy">READY</em>':'<em class="nrdy">NOT READY</em>'}</span></div>`).join('');
 $('mphost').style.display=mp.host?'block':'none';
 $('mpwait').style.display=mp.host?'none':'block';
 const me=mp.players.find(p=>p.id===mp.id),nReady=mp.players.filter(p=>p.ready).length,all=nReady===mp.players.length;
 $('mpready').textContent=me?.ready?'READY (tap to cancel)':'READY';$('mpready').classList.toggle('on',!!me?.ready);
 $('mpwait').textContent=(all?'Everyone is ready. Waiting for the host to start the race…':`Ready: ${nReady} / ${mp.players.length}. The race starts when everyone is ready.`)+(mp.cfg?.stock?' Stock cars: everyone races on factory settings.':'');$('mpstart').style.display=mp.host?'block':'none';
 // everyone must run the same version (an old game doesn't know the shared start, nor the new packets)
 const odd=mp.players.filter(p=>mpVer(p)!==GAME_VERSION);
 $('mpstart').disabled=!all||!!odd.length||(mp.players.length<2&&!settings.mpbots);
 $('mpstart').textContent=odd.length?'DIFFERENT GAME VERSIONS':all?'START RACE':`WAITING FOR READY (${nReady}/${mp.players.length})`;
 if(mp.host&&!odd.length&&/older version/.test($('mpstatus').textContent))mpStatus('Room open. Send the code to your friends!',true);
 if(mp.host&&odd.length)mpStatus(odd.map(p=>p.name).join(', ')+' '+(odd.length>1?'run':'runs')+' an older version. Ask them to reload the page (Ctrl+F5, on a phone pull down to refresh), then they can join again.');
}
$('mpcreate').onclick=()=>{initAudio();mpCreate()};
$('mpjoin').onclick=()=>{initAudio();mpJoin()};
$('mpleave').onclick=mpLeave;
$('mpready').onclick=()=>{if(!mp.on)return;const me=mp.players.find(p=>p.id===mp.id);const v=!me?.ready;
 if(mp.host){if(me)me.ready=v;mpLobby()}else{if(me)me.ready=v;mpSend({t:'ready',id:mp.id,v});mpRender()}};
$('mpcopy').onclick=()=>{
 const url=location.origin+location.pathname+'?room='+mp.code;
 const done=()=>{toast('Invite link copied','#5fe08a',1.4);mpStatus('Link copied: '+url,true)};
 navigator.clipboard?.writeText(url).then(done,()=>mpStatus('Invite link: '+url,true))??mpStatus('Invite link: '+url,true);
};
$('mpstart').onclick=()=>{
 if(!mp.host||!mp.players.every(p=>p.ready))return;
 // everyone still in the room, in random grid order
 const order=mp.players.map(p=>p.id).sort(()=>Math.random()-.5);
 const go={t:'go',order,players:mp.players,cfg:mp.cfg};
 mpBroadcast(go);mpStartRace(go);
};
// remote cars: built from each player's garage settings, with a name tag
function nameTag(name,color){
 const c=document.createElement('canvas');c.width=256;c.height=64;const g=c.getContext('2d');
 g.font='bold 34px Arial';const w=Math.min(240,g.measureText(name).width+36);
 g.fillStyle='#000a';g.beginPath();g.roundRect((256-w)/2,8,w,48,12);g.fill();g.fillStyle=hex(color);g.fillRect((256-w)/2+10,22,8,20);
 g.fillStyle='#fff';g.textAlign='center';g.textBaseline='middle';g.fillText(name,128+8,33,w-36);
 const t=new THREE.CanvasTexture(c);t.colorSpace=THREE.SRGBColorSpace;
 const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:t,depthWrite:false,transparent:true}));sp.scale.set(3.6,.9,1);sp.position.y=2.3;noAO.push(sp);return sp;
}
function mpStartRace(go){
 // drop whatever we were doing
 if(state==='replay')document.body.classList.remove('replaying');
 if(state==='paused'){$('pause').style.display='none';audio.ctx&&audio.ctx.resume()}
 if(state==='garage'){$('garage').style.display='none';document.body.classList.remove('in-garage')}
 $('settings').style.display='none';$('ropts').style.display='none';
 Object.assign(settings,{laps:go.cfg.laps,tod:go.cfg.tod,weather:go.cfg.weather,diff:go.cfg.diff});syncSegs();applyTimeOfDay();
 for(const c of cars)if(c.remote){scene.remove(c.car.g)}
 const remotes=go.players.filter(p=>p.id!==mp.id).map(p=>{
  const cfg=p.car||{m:0,c:0x888888},car=makeCar(cfg.c,2,{model:cfg.m|0,rims:cfg.r|0,spoiler:cfg.s??2,finish:cfg.f|0,caliper:CALIPERS[cfg.k|0]});
  car.headMat.emissiveIntensity=1.2+TOD[settings.tod].night*3;car.g.add(nameTag(p.name,cfg.c));scene.add(car.g);
  return {remote:true,id:p.id,name:p.name,color:cfg.c,car,dist:0,lat:0,x:0,z:0,angle:0,v:0,steer:0,boost:0,finished:false,finishTime:0,damage:0,buf:[]}});
 mp.order=go.order;mp.cfg=go.cfg;mp.racing=true;mp.sendT=0;
 if(mp.host)mp.players.forEach(p=>{p.here=false;p.ready=false});
 setRoster(remotes,go.cfg.bots?Math.max(0,MP_MAX-go.order.length):0);
 Object.assign(mp,{racers:go.players,loaded:new Set(),waiting:true,goAt:0,waitT:nowS()});
 state='menu';startRace();mpShowWaiting();
 // loaded: the race is built and the first frames (the slow ones) are drawn. say so, then wait for the others
 requestAnimationFrame(()=>requestAnimationFrame(()=>{if(!mp.on||!mp.waiting)return;if(mp.host)mpLoaded('host');else mpSend({t:'loaded',id:mp.id})}));
}
// a shared start: nobody's lights come on until every player has the race loaded, then the host gives the
// signal and everyone's countdown runs on the clock from that moment (moved by half the ping), not frame by frame
function mpShowWaiting(){
 if(!mp.waiting||state!=='countdown')return;
 const all=(mp.racers||[]).filter(p=>mp.order.includes(p.id)&&!cars.find(c=>c.remote&&c.id===p.id)?.gone),left=all.filter(p=>!mp.loaded.has(p.id));
 bigMessage('WAITING FOR PLAYERS<small>'+(all.length-left.length)+' / '+all.length+' ready'+(left.length?' · loading: '+left.map(p=>esc(p.name)).join(', '):'')+'</small>',false);
}
function mpLoaded(id){
 if(!mp.host||!mp.waiting)return;
 mp.loaded.add(id);mpBroadcast({t:'ld',ids:[...mp.loaded]});mpShowWaiting();mpCheckStart();
}
function mpCheckStart(){
 if(!mp.host||!mp.waiting||mp.goAt)return;
 const need=mp.order.filter(id=>id==='host'||mp.conns.has(id));
 // everyone in (someone who left doesn't count); a player whose game hangs is not waited for forever
 if(!need.every(id=>mp.loaded.has(id))&&nowS()-mp.waitT<30)return;
 const lead=.8;mpBroadcast({t:'cd',lead});mpBeginCountdown(lead);
}
function mpBeginCountdown(lead){
 if(!mp.waiting)return;
 mp.waiting=false;mp.goAt=nowS()+Math.max(-3,lead);
 if(state==='countdown'&&lead>0)bigMessage('GET READY',false);
}
// the others are drawn where they are now on their own screen, not where the last packet said they were:
// the packets are put on a smooth timeline (the sender's clock, lined up by the quickest packet), the car is
// placed between the two around a moment just behind the newest one, then carried forward by its speed and
// turn rate over that gap plus the network delay (half the ping). small misses are blended out, not jumped
const MP_DELAY=.05;
function pushSample(o,p,ts,n){
 const now=performance.now()/1000;
 if(n!=null){if(o.lastN!=null&&n<=o.lastN&&n>o.lastN-5000)return;o.lastN=n}   // unordered line: an old one that came late
 o.dist=p[6];o.lat=p[7];if(p[8]&&!o.finished){o.finished=true;o.finishTime=p[9];if(p[9]<0){o.dnf=true;o.finishTime=raceTime}}
 if(ts!=null&&ts===o.lastTs)return;o.lastTs=ts;   // the same moment again (no physics step in between): nothing new
 let t=now;
 if(ts!=null){const d=now-ts;o.off=o.off==null||!o.buf.length||d<o.off?d:o.off+(d-o.off)*.004;t=ts+o.off}
 if(o.buf.length&&t<=o.buf[o.buf.length-1].t)t=o.buf[o.buf.length-1].t+.001;
 if(!o.buf.length)o.p0=[p[0],p[1]];   // where it stood on the grid
 o.buf.push({t,p});if(o.buf.length>12)o.buf.shift()}
function puppet(o,dt){
 const b=o.buf;if(!b.length)return;
 const now=performance.now()/1000,t=now-MP_DELAY,L=b.length-1;let i=L;while(i>0&&b[i-1].t>t)i--;
 const sA=b[Math.max(0,i-1)],sB=b[i],A=sA.p,B=sB.p,u=sB.t>sA.t?clamp((t-sA.t)/(sB.t-sA.t),0,1):1;
 // speed and turn rate from the newest packets, over at least 60 ms (a shorter gap magnifies the rounding)
 let j=L;while(j>0&&b[L].t-b[j].t<.06)j--;
 const k0=b[j],k1=b[L],kd=k1.t-k0.t;let vx=0,vz=0,yr=0;
 if(kd>.005){vx=(k1.p[0]-k0.p[0])/kd;vz=(k1.p[1]-k0.p[1])/kd;yr=Math.atan2(Math.sin(k1.p[2]-k0.p[2]),Math.cos(k1.p[2]-k0.p[2]))/kd}
 let x=A[0]+(B[0]-A[0])*u,z=A[1]+(B[1]-A[1])*u,a=angLerp(A[2],B[2],u);
 const h=B.length>14?0:Math.min(.3,Math.max(0,t-sB.t)+MP_DELAY+mpLead(o));   // rolling over: no guessing
 if(h>0){const ca=Math.cos(yr*h/2),sa=Math.sin(yr*h/2);x+=(vx*ca+vz*sa)*h;z+=(-vx*sa+vz*ca)*h;a+=yr*h}
 // blend from where it was drawn, carried on by its speed, into the new place: no jumps on a new packet
 // (by the real time since the last frame: the game's frame step is capped, and on a slow device the car would drag behind)
 const rdt=o.shown?Math.min(.25,now-o.shown.t):0;
 if(o.shown&&Math.hypot(x-o.shown.x,z-o.shown.z)<8){const k=1-Math.exp(-rdt*12),ex=o.shown.x+vx*rdt,ez=o.shown.z+vz*rdt;
  x=ex+(x-ex)*k;z=ez+(z-ez)*k;a=angLerp(o.shown.a+yr*rdt,a,k)}
 o.shown={x,z,a,t:now};
 o.x=x;o.z=z;o.angle=a;o.v=B[3];o.steer=B[4];o.boost=B[5];
 o.car.g.position.set(o.x,0,o.z);o.car.g.rotation.set(0,o.angle,0);onRoad(o,o.dist||0);
 // rolling over on their screen: their packets carry the full pose
 if(B.length>14){o.car.g.position.y=B[10];o.car.g.quaternion.set(B[11],B[12],B[13],B[14])}
 animateCar(o.car,dt,o.v,o.steer,0,0,o.boost>0,false);
}
const carPacket=(c,v,b)=>[+c.x.toFixed(2),+c.z.toFixed(2),+c.angle.toFixed(3),+v.toFixed(1),+(c===player?c.wheelVis||0:c.steer).toFixed(2),b?1:0,+c.dist.toFixed(1),+c.lat.toFixed(2),c.finished?1:0,c.dnf?-1:+(c.finishTime||0).toFixed(3),...(c.tumble?[+c.car.g.position.y.toFixed(2),...c.car.g.quaternion.toArray().map(q=>+q.toFixed(3))]:[])];
function mpTick(dt){
 if(!mp.on)return;
 const now=nowS();
 // if this game itself was stuck (loading shaders, tab in the background), that silence isn't the others' fault
 if(now-(mp.lastTick||now)>2){mp.hostSeen=now;for(const id of mp.seen.keys())mp.seen.set(id,now)}
 mp.lastTick=now;
 if(now-mp.beatT>=MP_BEAT){mp.beatT=now;mpSend({t:'hb',id:mp.id,ts:performance.now()/1000});if(!mp.racing&&state==='menu')mpRender();mpCheckStart();if(!mp.host&&mp.waiting&&state==='countdown'&&now-mp.waitT>40)mpBeginCountdown(0);
  if(mp.host){for(const [id,t] of mp.seen)if(now-t>MP_TIMEOUT)mpDrop(id)}
  else if(now-mp.hostSeen>MP_TIMEOUT){mpEnd();mpStatus('Lost the connection to the host.');return}
 }
 if(!mp.racing)return;
 const live=state==='countdown'||state==='race'||state==='finished';
 if(live){
  for(const c of cars)if(c.remote&&!c.gone)puppet(c,dt);
  if(!mp.host)for(const b of raceBots)puppet(b,dt);
  mp.sendT+=dt;
  if(mp.sendT>=(!mp.host&&!mp.fast?.open&&mp.relayClient?MP_RATE_RELAY:MP_RATE)){mp.sendT=0;
   const m={t:'s',id:mp.id,n:++mp.seq,ts:+(performance.now()/1000-simStamp<.25?simStamp:performance.now()/1000).toFixed(3),p:carPacket(player,Math.hypot(player.vx,player.vz)*Math.sign(player.vx*Math.sin(player.angle)+player.vz*Math.cos(player.angle)||1),player.car.flames[0]?.visible)};
   if(mp.host)m.b=raceBots.map(b=>carPacket(b,b.v,b.boost>0));
   mpSendFast(m)}
 }
}
addEventListener('beforeunload',()=>{if(mp.on)mpLeave()});
addEventListener('pagehide',()=>{if(mp.on)mpLeave()});

// ---------- main loop ----------
let last=performance.now();
function animate(t){
 requestAnimationFrame(animate);
 const dt=Math.min(.033,(t-last)/1000||0);last=t;
 mpTick(dt);
 if(state==='garage'){updateGarage(dt);renderer.render(gScene,gCam);return}
 if(state==='menu'){updateHubCam(dt);updateAudio(0,false,false,0,false);renderer.render(gScene,gCam);return}
 let info={speed:0,boosting:false};
 if(state==='countdown'&&mp.on&&mp.racing&&(mp.waiting||!mp.goAt||nowS()<mp.goAt)){
  // online: lights off until everyone is in and the start time has come
  info=updatePlayer(dt,true);updateBots(dt,true);updateCarReflection();
 }else if(state==='countdown'){
  if(mp.on&&mp.racing&&mp.goAt)countdown=Math.min(countdown,4-(nowS()-mp.goAt));else countdown-=dt;
  const n=Math.ceil(countdown-1);
  if(keys.gas&&gasDownAt<0)gasDownAt=countdown;if(!keys.gas)gasDownAt=-1;
  if(n!==lastCount&&n>=1&&n<=3){lastCount=n;bigMessage(String(n));beep(440,.22);setStartLights(4-n,false)}
  if(countdown<=1){state='race';setStartLights(4,true);bigMessage('GO!<small>ghost start · no contact for '+START_GHOST+' s</small>');beep(880,.5,.3);
   if(keys.gas&&gasDownAt>0&&gasDownAt<1.6){player.vx=Math.sin(player.angle)*22;player.vz=Math.cos(player.angle)*22;player.nitro=Math.min(1,player.nitro+.3);popup('SUPER START!','#ffd84a',1.6);whoosh()}
   setTimeout(()=>{if(state==='race')$('message').style.display='none'},800)}
  info=updatePlayer(dt,state==='countdown');updateBots(dt,true);updateCarReflection();
 }else if(state==='race'||state==='finished'){
  raceTime+=dt;
  info=updatePlayer(dt,false);updateBots(dt,false);collisions();recordFrame(info);updateCarReflection();
 }else if(state==='replay'){
  updateReplay(dt);updateCarReflection();
 }else if(state==='menu'){
  updateAudio(0,false,false,0,false);
 }
 if(state!=='paused'){
  updateParticles(dt);updateDebris(dt);updatePitCrew(dt);updateRain(dt);updateDrops(dt,info.speed);updateLightning(dt);
  boostPads.forEach(b=>b.tex.offset.y-=dt*1.5);
  skyMat.uniforms.time.value+=dt;wind.value+=dt;
  antennaMat.emissiveIntensity=TOD[settings.tod].night>0&&(performance.now()/700|0)%2?4:0;
  if(toastTimer>0){toastTimer-=dt;if(toastTimer<=0)$('toast').style.opacity=0}
  updateCamera(dt,info.speed,info.boosting);
  // keep sun & shadow camera around the player
  const follow=state==='menu'||state==='replay'?camera.position:player.car.g.position,fx=follow.x,fz=follow.z;
  sun.position.set(fx+sunDir.x*200,sunDir.y*200,fz+sunDir.z*200);sun.target.position.set(fx,0,fz);
  sunDisc.position.copy(camera.position).addScaledVector(sunDir,1500);sky.position.copy(camera.position);stars.position.copy(camera.position);
 }
 if(state==='race'||state==='finished'||state==='countdown'){
  const pos=standings().indexOf(player)+1;
  if(state==='race'&&pos<lastPos&&raceTime>2)toast('UP TO '+ordinal(pos).toUpperCase()+' PLACE','#5f5',1);lastPos=pos;
  $('pos').textContent=pos;updateTower(dt);
  $('lap').textContent=clamp(Math.floor(player.dist/L)+1,1,LAPS())+'/'+LAPS();
  $('time').textContent=fmt(raceTime);
  $('laptime').textContent='LAP '+fmt(raceTime-player.lapStart);
  const bl=player.laps.length?Math.min(...player.laps):(vault.get(bestKey())||{}).lap;
  $('bestlap').textContent='BEST '+fmt(bl);
  const v=Math.abs(info.speed);
  drawGauge(dt,v,info.speed<-.5?'R':v<.5?'N':gearOf(v),info.gas,info.boosting);
  $('dmgfill').style.width=(player.damage*100)+'%';
  drawCarStatus();
  {const s=player.sys||freshSys(),col=v=>v<.25?'':v<.5?'w':v<.7?'b':'x',el=sysEls||(sysEls=Object.fromEntries([...document.querySelectorAll('#sys [data-s]')].map(e=>[e.dataset.s,e])));
   el.engine.className=col(s.engine);el.aero.className=col(s.aero);el.brakes.className=col(s.brakes);el.tyres.className=col(Math.max(s.fl,s.fr,s.rl,s.rr))}
  {const col=u=>u<.85?'#3ddc84':u<1.2?'#ffd23f':'#ff4d3d',t=tyreEls||(tyreEls=[...document.querySelectorAll('#tyres i')]);
   t[0].style.backgroundColor=t[1].style.backgroundColor=col(player.tyF);t[2].style.backgroundColor=t[3].style.backgroundColor=col(player.tyR)}
  $('wrongway').style.display=player.wrong>1.2&&state==='race'?'block':'none';
  drawMinimap();
 }
 renderMain();
}
$('start').onclick=startRace;
$('again').onclick=startRace;
$('rdone').onclick=()=>showHub(mp.on?'mp':'race');
addEventListener('resize',()=>{if(state==='menu')layoutHub();camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);renderer.setPixelRatio(Math.min(devicePixelRatio,2));composer?.setSize(innerWidth,innerHeight);sizeDrops();if(state==='garage')layoutGarage()});
buildPlayerCar();setRoster([],3);resetRace();
warmUp(scene,camera);warmUp(gScene,gCam);renderMain();   // one frame behind the loading screen also builds the post effects
$('loading').style.display='none';
showHub(INVITE?'mp':'race');
if(INVITE){$('mpcode').value=INVITE;mpStatus('Invited to room '+INVITE+'. Enter your name and press JOIN.',true)}
requestAnimationFrame(animate);
