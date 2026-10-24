// KOD Racing 3D service worker: the game is downloaded once, after that it starts from the browser's cache,
// also without internet (online multiplayer still needs it, of course).
// - the page itself: network first, so a new version on the site shows up straight away; the cached copy offline
// - everything else (the game, the car models, the physics, three.js and the fonts from their CDNs): from the
//   cache, downloaded on first use. The files carry the version (?v41), and each version has its own cache,
//   so an update downloads the new files and the old cache is thrown away.
const VERSION='v41',CACHE='kod-racing-'+VERSION;
const CORE=['./','css/style.css?'+VERSION,'js/game.js?'+VERSION,'controls/controls.wasm?'+VERSION,'models/kaze.glb','models/gt1.glb'];
// other sites whose files are safe to keep: fixed versions of libraries, and fonts
const CDN=['cdn.jsdelivr.net','unpkg.com','fonts.googleapis.com','fonts.gstatic.com'];

self.addEventListener('install',e=>{
 e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
 e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('kod-racing-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
 const r=e.request;if(r.method!=='GET')return;
 const u=new URL(r.url),same=u.origin===location.origin;
 if(r.mode==='navigate'){
  e.respondWith(fetch(r).then(res=>{if(res.ok){const c=res.clone();caches.open(CACHE).then(k=>k.put('./',c))}return res})
   .catch(()=>caches.match('./',{cacheName:CACHE}).then(m=>m||caches.match(r))));
  return;
 }
 if(!same&&!CDN.includes(u.hostname))return;   // the multiplayer servers and anything else: straight to the network
 e.respondWith(caches.open(CACHE).then(c=>c.match(r).then(hit=>hit||fetch(r).then(res=>{
  if(res.ok||res.type==='opaque')c.put(r,res.clone());
  return res}))));
});
