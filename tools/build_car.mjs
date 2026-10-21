// Splits a single-mesh car OBJ into game parts by position/normal and writes a compressed GLB.
// usage: node build_car.mjs in.obj out.glb
import fs from 'fs';
import {Document,NodeIO} from '@gltf-transform/core';
import {weld,dedup,prune,meshopt,reorder} from '@gltf-transform/functions';
import {MeshoptEncoder,MeshoptSimplifier} from 'meshoptimizer';
const [inp,out]=process.argv.slice(2);
const V=[],N=[],F=[];
for(const l of fs.readFileSync(inp,'utf8').split('\n')){
 const a=l.trim().split(/\s+/);
 if(a[0]==='v')V.push(a.slice(1,4).map(Number));
 else if(a[0]==='vn')N.push(a.slice(1,4).map(Number));
 else if(a[0]==='f'){const c=a.slice(1).map(s=>s.split('/').map(x=>x?+x:0));for(let i=1;i+1<c.length;i++)F.push([c[0],c[i],c[i+1]])}
}
// model units -> metres; the car's nose is +z, y up, wheels touch y=0
const S=4.6/1.89,R=0.15,WZ=[0.55,-0.55],WY=0.15;
const parts={};const put=(name,tri)=>{(parts[name]||(parts[name]={p:[],n:[]}));for(const [vi,,ni] of tri){const v=V[vi-1],n=ni?N[ni-1]:[0,1,0];parts[name].p.push(v[0]*S,v[1]*S,v[2]*S);parts[name].n.push(...n)}};
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const labels=[],cents=[];
for(const t of F){
 const A=V[t[0][0]-1],B=V[t[1][0]-1],C=V[t[2][0]-1];
 const c=[(A[0]+B[0]+C[0])/3,(A[1]+B[1]+C[1])/3,(A[2]+B[2]+C[2])/3];
 let n=cross(sub(B,A),sub(C,A));const l=Math.hypot(...n)||1;n=n.map(x=>x/l);
 const ax=Math.abs(c[0]),z=c[2],y=c[1];
 let part='paint';
 for(let w=0;w<2;w++){const r=Math.hypot(y-WY,z-WZ[w]);
  if(r<R+0.008&&ax>0.25)part=(r>R*0.68?'tyre':'rim')+(w===0?'F':'R')+(c[0]>0?'L':'R')}
 labels.push(part);cents.push(c);
}
// smooth the paint/glass/trim borders: a face takes the label most of its neighbours have (wheels stay as they are)
const vf=new Map();F.forEach((t,i)=>t.forEach(([vi])=>{if(!vf.has(vi))vf.set(vi,[]);vf.get(vi).push(i)}));
const soft=l=>l==='paint'||l==='glass'||l==='trim';
for(let it=0;it<2;it++){
 const next=labels.slice();
 F.forEach((t,i)=>{if(!soft(labels[i]))return;const votes={};
  for(const [vi] of t)for(const j of vf.get(vi))if(soft(labels[j]))votes[labels[j]]=(votes[labels[j]]||0)+1;
  let best=labels[i],bv=-1;for(const k in votes)if(votes[k]>bv){bv=votes[k];best=k}next[i]=best});
 labels.splice(0,labels.length,...next);
}
const count={};
F.forEach((t,i)=>{const l=labels[i]==='paint'?'body':null;count[labels[i]]=(count[labels[i]]||0)+1;if(l)put(l,t)});
console.log(count);
const doc=new Document(),buf=doc.createBuffer(),scene=doc.createScene('car');
for(const [name,d] of Object.entries(parts)){
 let p=d.p;const nn=d.n;
 // wheels are stored around their own centre so they can spin
 let off=[0,0,0];
 const m=name.match(/^(tyre|rim)(F|R)(L|R)$/);
 const node=doc.createNode(name);
 if(m){off=[ (m[3]==='L'?0.40:-0.40)*S, WY*S, WZ[m[2]==='F'?0:1]*S];p=p.map((v,i)=>v-off[i%3]);node.setTranslation(off)}
 const prim=doc.createPrimitive()
  .setAttribute('POSITION',doc.createAccessor().setType('VEC3').setArray(new Float32Array(p)).setBuffer(buf))
  .setAttribute('NORMAL',doc.createAccessor().setType('VEC3').setArray(new Float32Array(nn)).setBuffer(buf));
 node.setMesh(doc.createMesh(name).addPrimitive(prim));scene.addChild(node);
}
await MeshoptEncoder.ready;
await doc.transform(weld(),dedup(),reorder({encoder:MeshoptEncoder}),meshopt({encoder:MeshoptEncoder,level:'medium'}),prune());
const io=new NodeIO().registerExtensions((await import('@gltf-transform/extensions')).ALL_EXTENSIONS).registerDependencies({'meshopt.encoder':MeshoptEncoder});
await io.write(out,doc);
console.log('wrote',out,fs.statSync(out).size,'bytes');
