'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'sw.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const version=/const APP_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(root,'app.js'),'utf8'))[1];
const base='https://vocal-scope.test/';
const key=value=>new URL(typeof value==='string'?value:value.url,base).href;
const stores=new Map(),handlers={},fetches=[];
let online=false,waiting=false,claimed=false,cacheName;
const caches={
  async open(name){
    if(!stores.has(name))stores.set(name,new Map());
    const entries=stores.get(name);
    return{
      async addAll(requests){for(const request of requests){
        assert.equal(request.cache,'reload');
        const url=new URL(key(request)),file=url.pathname==='/'?'index.html':url.pathname.slice(1);
        assert.ok(fs.existsSync(path.join(root,file)),`Missing offline asset ${file}`);
        entries.set(key(request),new Response(fs.readFileSync(path.join(root,file))));
      }},
      async put(request,response){entries.set(key(request),response);},
    };
  },
  async match(request){for(const entries of stores.values())if(entries.has(key(request)))return entries.get(key(request)).clone();},
  async keys(){return [...stores.keys()];},
  async delete(name){return stores.delete(name);},
};
vm.runInNewContext(source,{
  self:{addEventListener(name,handler){handlers[name]=handler;},skipWaiting(){waiting=true;},clients:{claim(){claimed=true;}}},
  caches,Response,
  Request:class{constructor(url,options={}){this.url=key(url);this.cache=options.cache;}},
  async fetch(request,options){fetches.push({url:key(request),cache:options.cache});if(!online)throw new Error('Offline');return new Response('fresh response');},
});
async function lifecycle(name){let task;handlers[name]({waitUntil(promise){task=promise;}});await task;}
async function request(url,mode='same-origin'){
  let task;handlers.fetch({request:{url:key(url),mode,method:'GET'},respondWith(promise){task=promise;}});return task;
}
(async()=>{
  await lifecycle('install');assert.equal(waiting,true);
  cacheName=(await caches.keys())[0];assert.ok(cacheName.includes('v3a'));
  stores.set('vocal-scope-old',new Map());await lifecycle('activate');
  assert.equal(claimed,true);assert.deepEqual(await caches.keys(),[cacheName]);
  const urls=[...html.matchAll(/(?:src|href)="(\.\/[^"?]+\.(?:js|css)\?v=[^"]+)"/g)].map(match=>match[1]);
  assert.equal(urls.length,13);
  for(const url of urls){
    assert.equal(new URL(url,base).search,`?v=${version}`);
    assert.ok(await caches.match(url),`Missing versioned offline asset ${url}`);
    assert.ok((await request(url)).ok);
  }
  assert.ok(await caches.match(`./pitch-worker.js?v=${version}`));
  const worker=fs.readFileSync(path.join(root,'pitch-worker.js'),'utf8');
  assert.ok(worker.includes(`./pitch-core.js?v=${version}`));
  assert.ok((await (await request('./','navigate')).text()).includes('judgementCorrectionThreshold'));
  online=true;
  assert.equal(await (await request(`./judgement-practice.js?v=${version}`)).text(),'fresh response');
  assert.equal(await (await request('./','navigate')).text(),'fresh response');
  assert.ok(fetches.every(fetch=>fetch.cache==='no-store'));
  console.log(`Service worker ${version}: versioned assets, offline fallback, fresh updates passed`);
})().catch(error=>{console.error(error);process.exitCode=1;});
