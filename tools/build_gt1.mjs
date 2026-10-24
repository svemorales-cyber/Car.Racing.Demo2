// Turns the SketchUp GT1 export (inches, nose -z) into a game car: wheels removed (the game draws its own),
// triangles grouped by material into body / trim / metal / glass / head / tail / inside, scaled to 4.71 m,
// nose to +z, simplified for phones and meshopt-compressed.
// usage: node build_gt1.mjs gt1.obj gt1.glb
import fs from 'fs';
import {Document,NodeIO} from '@gltf-transform/core';
import {weld,dedup,prune,meshopt,reorder,simplify} from '@gltf-transform/functions';
import {MeshoptEncoder,MeshoptSimplifier} from 'meshoptimizer';
const [inp,out]=process.argv.slice(2);
const GROUP={M_0020_Red:'body',
 M_911gt1_misc__spec_:'trim',M_0136_Charcoal:'trim',M_0135_DarkGray:'trim',Fencing_Chain_Link:'trim',_Color_008_1:'trim',Color_M02:'trim',Color_A08:'trim',Color_A02:'trim',Color_A09:'trim',_0136_Charcoal_2:'trim',M_0129_WhiteSmoke:'trim',
 Metal_Aluminum_Anodized:'metal',Translucent_Glass_Gray:'glass',Mirror_01:'glass',Mirror_02:'head',Aluminum:'head',
 vehiclelights128__spec_RL_:'tail',M_0014_DarkSalmon:'tail',Metal_Corrugated_Shiny:'tail',M_0018_Brown:'tail',
 Carpet_Plush_Charcoal:'inside',Leather_Red_Brown:'inside',Matte__FF808040__prim_env_9_spec_:'inside',Matte__FFCCCCCC:'inside'};
const TYRES=new Set(['Tyre_Side','Profiel02']);
const S=4.71/2162,CX=-314.5,FLOOR=-378,CZ=192;
const WHEELS=[[-702.7,-206.1,-393.7],[73.5,-206.1,-393.7],[-708.2,-197.5,776],[78.9,-197.5,776]];
const V=[],N=[];let mat='';const parts={},dropped={};
const tf=v=>[-(v[0]-CX)*S,(v[1]-FLOOR)*S,-(v[2]-CZ)*S],tn=n=>[-n[0],n[1],-n[2]];
for(const l of fs.readFileSync(inp,'utf8').split('\n')){
 const a=l.trim().split(/\s+/);
 if(a[0]==='v')V.push(a.slice(1,4).map(Number));
 else if(a[0]==='vn')N.push(a.slice(1,4).map(Number));
 else if(a[0]==='usemtl')mat=a[1];
 else if(a[0]==='f'){
  const c=a.slice(1).map(s=>s.split('/').map(x=>x?+x:0));
  for(let i=1;i+1<c.length;i++){const t=[c[0],c[i],c[i+1]],P=t.map(([vi])=>V[vi-1]);
   const cen=[0,1,2].map(k=>(P[0][k]+P[1][k]+P[2][k])/3);
   // inside a wheel (tyre, rim, disc, hub): the game has its own wheels
   const inWheel=WHEELS.some(w=>Math.hypot(cen[1]-w[1],cen[2]-w[2])<176&&Math.abs(cen[0]-w[0])<100);
   if(TYRES.has(mat)||inWheel||!GROUP[mat]){dropped[mat]=(dropped[mat]||0)+1;continue}
   const g=GROUP[mat],d=parts[g]||(parts[g]={p:[],n:[]});
   // flipping x and z keeps the winding (a rotation), so faces still face out
   for(const [vi,,ni] of t){d.p.push(...tf(V[vi-1]));d.n.push(...(ni?tn(N[ni-1]):[0,1,0]))}
  }
 }
}
console.log('kept',Object.fromEntries(Object.entries(parts).map(([k,d])=>[k,d.p.length/9])),'dropped',dropped);
const doc=new Document(),buf=doc.createBuffer(),scene=doc.createScene('car');
for(const [name,d] of Object.entries(parts)){
 const prim=doc.createPrimitive()
  .setAttribute('POSITION',doc.createAccessor().setType('VEC3').setArray(new Float32Array(d.p)).setBuffer(buf))
  .setAttribute('NORMAL',doc.createAccessor().setType('VEC3').setArray(new Float32Array(d.n)).setBuffer(buf));
 const node=doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim));scene.addChild(node);
}
await MeshoptEncoder.ready;await MeshoptSimplifier.ready;
await doc.transform(weld(),dedup(),simplify({simplifier:MeshoptSimplifier,ratio:+(process.argv[4]||.3),error:.0015}),reorder({encoder:MeshoptEncoder}),meshopt({encoder:MeshoptEncoder,level:'medium'}),prune());
for(const m of doc.getRoot().listMeshes()){const p=m.listPrimitives()[0],ix=p.getIndices();console.log(m.getName(),'tris',(ix?ix.getCount():p.getAttribute('POSITION').getCount())/3)}
const io=new NodeIO().registerExtensions((await import('@gltf-transform/extensions')).ALL_EXTENSIONS).registerDependencies({'meshopt.encoder':MeshoptEncoder});
await io.write(out,doc);
console.log('wrote',out,fs.statSync(out).size,'bytes');
