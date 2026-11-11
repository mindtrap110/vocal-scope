'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {fixture, DAY_KEY} = require('./training-fixture.cjs');

const DATE = '2026-11-10';
const APRIME_KEY = 'vocalScopeIntegratedRecordingAPrime';
const targets = 'A2 D#3 F3 D#3 G3 D3 B2 C3 C#3 C3 A2 A#2';
const day = f => JSON.parse(f.w.localStorage.getItem(APRIME_KEY));
const initial = f => f.records().find(r => r.training?.protocol === 'a-prime' && r.training?.stage === 'initial');

// Exercise the real worklet across a ring wrap, and ensure it emits only the
// requested 3 s of PCM rather than copying the initial waiting period.
const received = [];
let Processor;
const rate = 48000;
const worklet = {
  sampleRate: rate, currentFrame: 0,
  AudioWorkletProcessor: class { constructor(){this.port={postMessage:value=>received.push(value)};} },
  registerProcessor: (_,type)=>{Processor=type;},
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','a-prime-pcm.js'),'utf8'), worklet);
const processor = new Processor(), onset = 71427;
const sampleAt = n => ((n % 64) - 32) / 128;
for(let frame=0;frame<onset+3*rate+256;frame+=128){
  worklet.currentFrame=frame;
  if(frame===71680)processor.port.onmessage({data:{onsetFrame:onset}});
  processor.process([[Float32Array.from({length:128},(_,i)=>sampleAt(frame+i))]]);
}
assert.equal(received.length,1);
assert.equal(received[0].type,'clip');
assert.equal(received[0].samples.length,3*rate);
assert.ok(received[0].samples.every((value,index)=>value===sampleAt(onset+index)));
const broken=new Processor();broken.port.onmessage({data:{onsetFrame:0}});
for(let frame=0;frame<=3*rate;frame+=128){
  worklet.currentFrame=frame;
  if(frame!==1024)broken.process([[new Float32Array(128)]]);
}
assert.equal(received[1].type,'gap');

async function startInitial(f,offset){
  f.w.qaOffset=offset;
  f.$('measureBtn').click();await f.advance(2100);
  f.$('measureBtn').click();await f.advance(3450);
}
function expectBlind(f){
  for(const selector of ['.hero','.graph-card'])assert.equal(f.w.getComputedStyle(f.w.document.querySelector(selector)).display,'none');
  assert.equal(f.$('judgementResult').textContent,'');
  assert.ok(f.$('judgementResult').classList.contains('hidden'));
}
function fillLive(f){f.change('aPrimeLiveDirection','low');f.change('aPrimeLiveConfidence','3');}
function reveal(f){f.change('aPrimePlaybackDirection','high');f.change('aPrimePlaybackConfidence','2');f.$('measureBtn').click();}
async function readFile(w,file,method){
  return new Promise((resolve,reject)=>{
    const reader=new w.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader[method](file);
  });
}
function readZipEntries(arrayBuffer){
  const bytes=Buffer.from(arrayBuffer), entries=new Map();
  let offset=0;
  while(bytes.readUInt32LE(offset)===0x04034b50){
    assert.equal(bytes.readUInt16LE(offset+8),0);
    const size=bytes.readUInt32LE(offset+18),nameLength=bytes.readUInt16LE(offset+26),extraLength=bytes.readUInt16LE(offset+28);
    const name=bytes.subarray(offset+30,offset+30+nameLength).toString('utf8');
    const data=offset+30+nameLength+extraLength;
    entries.set(name,bytes.subarray(data,data+size));offset=data+size;
  }
  return entries;
}

(async()=>{
  const f=await fixture({}, {micSettings:{echoCancellation:false,autoGainControl:true}});
  const b=f.$('measureBtn');
  assert.equal(f.$('judgementProtocol').value,'v3a');
  f.training(true);f.change('judgementDate',DATE);f.$('judgementTargets').value=targets;
  await startInitial(f,150);
  assert.equal(f.day().step,'judgement');
  assert.equal(f.audioEvents.filter(event=>event.type==='worklet').length,0);
  const legacy=f.records()[0],legacyProgress=f.w.localStorage.getItem(DAY_KEY);
  f.change('judgementProtocol','a-prime');
  await startInitial(f,150);
  assert.equal(day(f).step,'aPrimeListenReady');
  assert.equal(f.w.localStorage.getItem(DAY_KEY),legacyProgress);
  const measured=initial(f);
  assert.equal(measured.assessment.medianCents,legacy.assessment.medianCents);
  assert.equal(measured.levelDb,legacy.levelDb);
  assert.deepEqual(JSON.parse(JSON.stringify(measured.training.micSettings)),{fallbackConstraints:false,echoCancellation:false,noiseSuppression:null,autoGainControl:true});
  assert.ok(f.$('aPrimeMicStatus').textContent.includes('잡음 제거: 확인 불가'));
  const requested=f.audioEvents.findLast(event=>event.type==='mic').constraints.audio;
  for(const field of ['echoCancellation','noiseSuppression','autoGainControl'])assert.equal(requested[field],false);
  expectBlind(f);
  assert.equal(b.disabled,true);
  assert.equal(f.$('aPrimeCsvBtn').disabled,true);
  assert.equal(f.$('aPrimeWavBtn').disabled,true);
  assert.ok(!f.w.VocalHistoryShare.buildExportPayload(f.records()).sessions.some(row=>row.id===measured.id));
  f.training(false);f.w.VocalHistory.openSession(measured.id);
  assert.equal(f.$('sessionDialog').open,false,'turning off training must not reveal an unfinished result');
  f.training(true);expectBlind(f);
  f.change('aPrimeLiveDirection','low');assert.equal(b.disabled,true);
  f.change('aPrimeLiveConfidence','3');assert.equal(b.disabled,false);
  assert.equal(b.textContent,'재생');

  // iOS-style suspended context: resume is called in the click stack, then
  // schedule the existing 12 partials and the unchanged PCM on one clock.
  f.audioEvents.findLast(event=>event.type==='toneStart').context.state='suspended';
  const mark=f.audioEvents.length;
  b.click();assert.ok(f.audioEvents.slice(mark).some(event=>event.type==='resume'));
  await f.flush();
  const events=f.audioEvents.slice(mark),tone=events.filter(event=>event.type==='toneStart'),voice=events.find(event=>event.type==='voice');
  assert.equal(tone.length,12);assert.equal(tone[0].hz,110);
  assert.ok(events.filter(event=>event.type==='toneStop').every(event=>Math.abs(event.when-tone[0].when-1)<1e-8));
  assert.equal(voice.context,tone[0].context);
  assert.ok(Math.abs(voice.when-tone[0].when-1.5)<1e-8);
  assert.equal(voice.direct,true);assert.equal(voice.buffer.duration,3);
  assert.equal(voice.buffer.getChannelData(0)[0],0.125);assert.equal(voice.buffer.getChannelData(0)[1],-0.25);
  assert.equal(initial(f).training.preRevealPlays,1);assert.equal(b.disabled,true);
  b.click();await f.advance(4490);expectBlind(f);
  assert.equal(day(f).step,'aPrimeListenReady');
  await f.advance(20);expectBlind(f);
  assert.equal(day(f).step,'aPrimePlaybackJudgement');
  assert.equal(f.audioEvents.filter(event=>event.type==='voice').length,1);
  assert.equal(b.disabled,true);
  assert.equal(f.$('aPrimeLiveFields').disabled,true);
  f.change('aPrimeLiveDirection','high');assert.equal(f.$('aPrimeLiveDirection').value,'low');
  reveal(f);
  assert.equal(day(f).step,'aPrimeResult');
  assert.match(f.$('judgementResult').textContent,/\+150\.0¢/);
  assert.equal(f.$('aPrimeLiveFields').disabled,true);assert.equal(f.$('aPrimePlaybackFields').disabled,true);
  assert.equal(initial(f).training.realtimeJudgement.direction,'low');
  assert.equal(initial(f).training.playbackJudgement.direction,'high');
  assert.equal(b.textContent,'다음 시행');
  for(let i=0;i<2;i++){f.$('aPrimeReplayBtn').click();await f.advance(4510);}
  assert.equal(initial(f).training.preRevealPlays,1);assert.equal(initial(f).training.postRevealPlays,2);

  f.$('aPrimeCorrectionBtn').click();await f.advance(2200);
  assert.equal(day(f).step,'screenCorrection');b.click();await f.flush();
  assert.equal(initial(f).training.screenCorrectionUsed,true);
  assert.equal(f.records()[0].training.mixedWithReference,true);
  f.w.qaOffset=0;b.click();await f.advance(3450);
  assert.equal(day(f).step,'retryResult');b.click();
  await startInitial(f,50);fillLive(f);b.click();await f.advance(4510);reveal(f);
  assert.equal(day(f).step,'aPrimeResult');assert.ok(f.$('aPrimeCorrectionBtn').classList.contains('hidden'));
  assert.equal(initial(f).training.screenCorrectionUsed,false);
  assert.equal(f.audioEvents.filter(event=>event.type==='worklet').length,2);

  const downloads=[];
  f.w.navigator.canShare=()=>true;
  f.w.navigator.share=async({files})=>{downloads.push(files[0]);};
  f.$('aPrimeCsvBtn').click();await f.flush();f.$('aPrimeWavBtn').click();await f.flush();
  assert.equal(downloads.length,2);
  assert.equal(downloads[0].name,`vocal-scope-a-prime-${DATE}.csv`);
  const [header,row1,row2]=String(await readFile(f.w,downloads[0],'readAsText')).trim().split(/\r?\n/).map(line=>line.split(','));
  assert.equal(header.length,17);
  assert.deepEqual(row1.slice(0,1),[DATE]);assert.match(row1[1],/^\d{4}-\d\d-\d\dT.*Z$/);
  assert.deepEqual(row1.slice(2),['1','A2','150','-30','low','3','high','2','1','2','true','false','unknown','true','false']);
  assert.deepEqual(row2.slice(2,13),['2','D#3','50','-30','low','3','high','2','1','0','false']);
  assert.equal(downloads[1].name,`vocal-scope-a-prime-wav-${DATE}.zip`);
  const entries=readZipEntries(await readFile(f.w,downloads[1],'readAsArrayBuffer'));
  assert.deepEqual([...entries.keys()],[`${DATE}_01_A2.wav`,`${DATE}_02_D#3.wav`]);
  for(const wav of entries.values()){
    assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt16LE(20),1);
    assert.equal(wav.readUInt32LE(24),rate);assert.equal(wav.readUInt32LE(40),rate*3*2);
    assert.equal(wav.readInt16LE(44),4096);assert.equal(wav.readInt16LE(46),-8192);
  }

  const reloaded=await fixture(f.seed());
  assert.equal(day(reloaded).step,'aPrimeResult');assert.equal(reloaded.$('aPrimeLiveFields').disabled,true);
  assert.equal(reloaded.$('aPrimeCsvBtn').disabled,false);assert.equal(reloaded.$('aPrimeWavBtn').disabled,true);
  reloaded.change('judgementProtocol','v3a');assert.equal(reloaded.day().step,'judgement');
  assert.equal(reloaded.w.localStorage.getItem(DAY_KEY),legacyProgress);
  assert.deepEqual(reloaded.errors,[]);await reloaded.close();

  // A half-listened clip cannot be played a second time to complete the same trial.
  b.click();await startInitial(f,80);fillLive(f);b.click();await f.advance(2000);
  f.w.dispatchEvent(new f.w.CustomEvent('vs:visibility',{detail:{hidden:true}}));await f.flush();
  assert.equal(day(f).step,'initialInvalid');assert.equal(day(f).cursor,2);
  assert.equal(f.records()[0].training.stage,'discarded');assert.equal(f.records()[0].training.preRevealPlays,1);
  assert.ok(!f.w.VocalHistoryShare.buildExportPayload(f.records()).sessions.some(row=>row.id===f.records()[0].id));
  expectBlind(f);
  await startInitialFromRetry(f);
  const interrupted=await fixture(f.seed());
  assert.equal(day(interrupted).step,'initialInvalid');assert.equal(day(interrupted).cursor,2);
  assert.equal(interrupted.records()[0].training.stage,'discarded');
  assert.deepEqual(interrupted.errors,[]);await interrupted.close();
  assert.deepEqual(f.errors,[]);await f.close();
  console.log('A′: exact 3 s PCM, same assessment and level, gated single replay and locked judgements, timing, 17 CSV fields, WAV archive, correction, interruption and independent mode resume passed');
})().catch(error=>{console.error(error);process.exitCode=1;});

async function startInitialFromRetry(f){
  f.$('measureBtn').click();await f.advance(3450);assert.equal(day(f).step,'aPrimeListenReady');
}
