'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {JSDOM,VirtualConsole}=require('jsdom');
const root=path.resolve(__dirname,'..');
const DAY_KEY='vocalScopeIntegratedRecordingV3a',HISTORY_KEY='vocalScopePracticeHistoryV1';

async function fixture(seed={},options={}){
  const errors=[],virtualConsole=new VirtualConsole();
  virtualConsole.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(fs.readFileSync(path.join(root,'index.html'),'utf8'),{
    url:'https://vocal-scope.test/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole,
  });
  const w=dom.window,$=id=>w.document.getElementById(id);
  w.TextEncoder=TextEncoder;
  for(const [key,value] of Object.entries(seed))w.localStorage.setItem(key,value);
  const canvas=new Proxy({},{get:(_,key)=>key==='measureText'?text=>({width:text.length*6}):()=>{}});
  w.HTMLCanvasElement.prototype.getContext=()=>canvas;
  w.HTMLElement.prototype.scrollIntoView=()=>{};w.scrollTo=()=>{};
  w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};
  w.HTMLMediaElement.prototype.pause=()=>{};w.HTMLMediaElement.prototype.load=()=>{};
  w.confirm=()=>true;w.isSecureContext=true;
  Object.defineProperty(w.document,'hidden',{value:false,configurable:true});
  const style=w.document.createElement('style');style.textContent=fs.readFileSync(path.join(root,'styles.css'),'utf8');w.document.head.appendChild(style);
  let now=10000,nextId=1;const jobs=new Map();
  w.performance.now=()=>now;w.Date.now=()=>1800000000000+now;
  w.setTimeout=(fn,ms=0)=>{const id=nextId++;jobs.set(id,{fn,at:now+ms,period:0});return id;};
  w.setInterval=(fn,ms)=>{const id=nextId++;jobs.set(id,{fn,at:now+ms,period:ms});return id;};
  w.clearTimeout=w.clearInterval=id=>jobs.delete(id);
  w.requestAnimationFrame=fn=>w.setTimeout(()=>fn(now),0);
  const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
  async function advance(ms){
    await flush();const end=now+ms;let iterations=0;
    while(true){
      const item=[...jobs].filter(([,j])=>j.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!item)break;
      if(++iterations>50000)throw new Error('Virtual timer loop');
      const [id,job]=item;now=job.at;if(job.period)job.at+=job.period;else jobs.delete(id);
      job.fn();await flush();
    }
    now=end;await flush();
  }
  class Param{constructor(){this.value=0;}setValueAtTime(v){this.value=v;}exponentialRampToValueAtTime(){}linearRampToValueAtTime(){}cancelScheduledValues(){}}
  class Node{constructor(){this.gain=this.frequency=new Param();}connect(){}disconnect(){}start(){}stop(){}}
  const audioEvents=[];
  class AudioContext extends w.EventTarget{
    constructor(){super();this.state='running';this.destination={};this.sampleRate=options.sampleRate||48000;this.started=now;
      this.audioWorklet={addModule:async url=>audioEvents.push({type:'worklet',url})};}
    get currentTime(){return (now-this.started)/1000;}
    resume(){audioEvents.push({type:'resume'});this.state='running';return Promise.resolve();}close(){this.state='closed';return Promise.resolve();}
    createGain(){return new Node();}
    createOscillator(){const osc=new Node();osc.start=when=>audioEvents.push({type:'toneStart',when,hz:osc.frequency.value,context:this});osc.stop=when=>audioEvents.push({type:'toneStop',when,context:this});return osc;}
    createMediaStreamSource(){return new Node();}
    createAnalyser(){const context=this;return{fftSize:4096,getFloatTimeDomainData(samples){
      const end=Math.round(context.currentTime*context.sampleRate);
      const hz=440*2**(((w.VocalScope?.state.targetMidi??45)+(w.qaOffset||0)/100-69)/12);
      const amplitude=Math.SQRT2*10**(w.qaDb/20);
      for(let i=0;i<samples.length;i++){
        const time=(end-samples.length+i)/context.sampleRate;
        samples[i]=typeof w.qaSample==='function'?w.qaSample(time):amplitude*Math.sin(2*Math.PI*hz*time);
      }
    }};}
    createBuffer(channels,length,sampleRate){const pcm=new w.Float32Array(length);return{duration:length/sampleRate,getChannelData:()=>pcm};}
    createBufferSource(){
      const node=new Node();let timer;
      node.connect=destination=>{node.destination=destination;};
      node.start=(when=this.currentTime)=>{
        audioEvents.push({type:'voice',when,buffer:node.buffer,context:this,direct:node.destination===this.destination});
        timer=w.setTimeout(()=>node.onended?.(),1000*(when-this.currentTime+node.buffer.duration));
      };
      node.stop=()=>{w.clearTimeout(timer);};return node;
    }
  }
  w.AudioContext=AudioContext;
  w.AudioWorkletNode=class extends Node{
    constructor(context){super();let timer;
      this.port={onmessage:null,postMessage:()=>{
        timer=w.setTimeout(()=>{
          const samples=new w.Float32Array(context.sampleRate*3);samples[0]=0.125;samples[1]=-0.25;
          this.port.onmessage?.({data:{type:'clip',samples}});
        },3020);
      },close:()=>w.clearTimeout(timer)};
    }
  };
  w.navigator.mediaDevices={getUserMedia:async constraints=>{
    audioEvents.push({type:'mic',constraints});
    const track={readyState:'live',getSettings:()=>options.micSettings||{echoCancellation:false,noiseSuppression:false,autoGainControl:false},stop(){}};
    return {getAudioTracks:()=>[track],getTracks:()=>[track]};
  }};
  w.qaOffset=80;w.qaDb=-30;
  w.Worker=class{
    postMessage(message){
      const midi=(w.VocalScope.state.targetMidi??45)+w.qaOffset/100;
      const result=w.qaActualPitch?w.PitchCore.detectPitch(message.samples,message.sampleRate,message.options):{frequency:w.qaNoPitch?null:440*2**((midi-69)/12),confidence:w.qaNoPitch?0:0.98,db:-25};
      w.setTimeout(()=>this.onmessage?.({data:{type:'result',...result}}),1);
    }
    terminate(){this.onmessage=null;}
  };
  for(const file of ['pitch-core.js','judgement-core.js','level-core.js','a-prime.js','app.js','history.js','history-share.js','vocal-scope-patch.js','reference-tone.js','phrase-practice.js','recording.js','judgement-practice.js']){
    vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),dom.getInternalVMContext(),{filename:file});
  }
  await new Promise(resolve=>w.document.addEventListener('DOMContentLoaded',resolve,{once:true}));await flush();
  const change=(id,value)=>{$(id).value=value;$(id).dispatchEvent(new w.Event('change'));};
  const training=on=>{$('trainingEnabledToggle').checked=on;$('trainingEnabledToggle').dispatchEvent(new w.Event('change'));};
  return{w,dom,$,change,training,advance,flush,errors,audioEvents,
    day:()=>JSON.parse(w.localStorage.getItem(DAY_KEY)),
    records:()=>w.VocalHistory.readSessions(),
    seed:()=>Object.fromEntries(Array.from({length:w.localStorage.length},(_,i)=>{const key=w.localStorage.key(i);return[key,w.localStorage.getItem(key)];})),
    async close(){if(w.VocalScope.state.measuring)w.VocalScope.stopMeasurement();await flush();dom.window.close();},
  };
}
module.exports={fixture,DAY_KEY,HISTORY_KEY};
