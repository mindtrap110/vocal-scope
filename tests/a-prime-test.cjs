'use strict';
const assert = require('node:assert/strict');
const A = require('../a-prime.js');
const {fixture, DAY_KEY} = require('./training-fixture.cjs');

const DATE = '2026-11-10';
const APRIME_KEY = 'vocalScopeIntegratedRecordingAPrime';
const targets = 'A2 D#3 F3 D#3 G3 D3 B2 C3 C#3 C3 A2 A#2';
const day = f => JSON.parse(f.w.localStorage.getItem(APRIME_KEY));
const initial = f => f.records().find(r => r.training?.protocol === 'a-prime' && r.training?.stage === 'initial');

// Copy exact PCM from overlapping analyser frames even when the reported
// clock advances by one render quantum between the two reads.
const rate = 48000;
const onset = 71427, take = A.createCapture();
const sampleAt = n => Math.fround(0.2*Math.sin(n*0.029)+0.02*Math.cos(n*0.00131));
function frame(end, clockOffset = 0) {
  return {samples:Float32Array.from({length:4096},(_,i)=>sampleAt(end-4096+i)),sampleRate:rate,frameEnd:end+clockOffset,db:-20};
}
take.append(frame(onset-1024));
take.markOnset({currentTime:onset/rate,sampleRate:rate});
for(let i=0,end=onset+512;end<onset+3*rate+2100;end+=2016,i++){
  const event=frame(end,i%4===1?128:i%4===3?-128:0);
  take.append(event);
  structuredClone(event.samples,{transfer:[event.samples.buffer]});
}
assert.equal(take.failure,null);
assert.equal(take.clip.samples.length,3*rate);
assert.ok(take.clip.samples.every((value,index)=>value===sampleAt(onset+index)));
const broken=A.createCapture();broken.markOnset({currentTime:onset/rate,sampleRate:rate});
broken.append(frame(onset+512));broken.append(frame(onset+512+4800));
assert.equal(broken.failure,'gap');assert.equal(broken.clip,null);

function expectedSample(midi, offset, index){
  const hz=440*2**((midi+offset/100-69)/12);
  return Math.fround(Math.SQRT2*10**(-30/20)*Math.sin(2*Math.PI*hz*((48+index)/rate)));
}

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
function fillLive(f){f.change('aPrimeLiveDirection','low');f.change('aPrimeLiveSize','lt_semitone');f.change('aPrimeLiveConfidence','3');}
function reveal(f){f.change('aPrimePlaybackDirection','high');f.change('aPrimePlaybackSize','semitone_to_tone');f.change('aPrimePlaybackConfidence','2');f.$('measureBtn').click();}
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
  f.change('aPrimeLiveConfidence','3');assert.equal(b.disabled,true);
  f.change('aPrimeLiveSize','lt_semitone');assert.equal(b.disabled,false);
  assert.equal(b.textContent,'재생');

  // The same 12-partial reference is rendered offline. Only one native play()
  // call occurs in the click stack, using the already prepared WAV.
  const offline=f.audioEvents.filter(event=>event.context instanceof f.w.OfflineAudioContext);
  assert.deepEqual(offline.filter(event=>event.type==='toneStart').map(event=>[event.when,event.hz]),
    Array.from({length:12},(_,i)=>[0,110*(i+1)]));
  assert.deepEqual(offline.filter(event=>event.type==='toneStop').map(event=>event.when),Array(12).fill(1));
  await assert.rejects(f.w.VocalScopeReferenceTone.prepareTrainingRecording(45,{samples:new Float32Array(rate*3),sampleRate:rate}),/소리가 들어 있지 않습니다/);
  f.w.qaRejectPlay=true;b.click();await f.flush();
  assert.equal(initial(f).training.preRevealPlays,0);
  assert.equal(b.disabled,false);expectBlind(f);
  assert.match(f.$('judgementActionError').textContent,/재생을 시작하지 못했습니다/);
  f.w.qaRejectPlay=false;
  const mark=f.audioEvents.length;
  b.click();assert.deepEqual(f.audioEvents.slice(mark).map(event=>event.type),['mediaPlay']);
  const blob=f.audioEvents[mark].blob;
  assert.equal(blob.type,'audio/wav');
  const listenWav=Buffer.from(await readFile(f.w,blob,'readAsArrayBuffer'));
  const voiceStart=rate*1.5;
  assert.equal(listenWav.toString('ascii',0,4),'RIFF');
  assert.equal(listenWav.readUInt32LE(24),rate);
  assert.equal(listenWav.readUInt32LE(40),rate*4.5*2);
  assert.ok(listenWav.subarray(44,44+2*rate).some(value=>value!==0),'reference present');
  assert.ok(listenWav.subarray(44+2*rate,44+2*voiceStart).every(value=>value===0),'half-second silence');
  for(let i=0;i<rate*3;i++){
    const sample=expectedSample(45,150,i);
    assert.equal(listenWav.readInt16LE(44+2*(voiceStart+i)),Math.round(sample*(sample<0?32768:32767))||0);
  }
  await f.flush();
  assert.deepEqual(f.audioEvents.slice(mark).map(event=>event.type),['mediaPlay']);
  assert.equal(initial(f).training.preRevealPlays,1);assert.equal(b.disabled,true);
  b.click();await f.advance(4490);expectBlind(f);
  assert.equal(day(f).step,'aPrimeListenReady');
  await f.advance(20);expectBlind(f);
  assert.equal(day(f).step,'aPrimePlaybackJudgement');
  assert.equal(f.audioEvents.slice(mark).filter(event=>event.type==='mediaPlay').length,1);
  assert.equal(b.disabled,true);
  assert.equal(f.$('aPrimeLiveFields').disabled,true);
  f.change('aPrimeLiveDirection','high');assert.equal(f.$('aPrimeLiveDirection').value,'low');
  const replay=f.$('aPrimeReplayBtn');
  assert.equal(replay.disabled,false);
  replay.click();await f.advance(4510);expectBlind(f);
  assert.equal(initial(f).training.preRevealPlays,2);
  assert.match(f.$('aPrimePlayCount').textContent,/공개 전 2\/2회/);
  assert.equal(replay.disabled,true);
  replay.click();await f.flush();
  assert.equal(f.audioEvents.slice(mark).filter(event=>event.type==='mediaPlay').length,2);
  f.change('aPrimePlaybackDirection','high');f.change('aPrimePlaybackConfidence','2');
  assert.equal(b.disabled,true,'size is required for a non-match playback judgement');
  reveal(f);
  assert.equal(day(f).step,'aPrimeResult');
  assert.match(f.$('judgementResult').textContent,/\+150\.0¢/);
  assert.equal(f.$('aPrimeLiveFields').disabled,true);assert.equal(f.$('aPrimePlaybackFields').disabled,true);
  assert.equal(initial(f).training.realtimeJudgement.direction,'low');
  assert.equal(initial(f).training.playbackJudgement.direction,'high');
  assert.equal(initial(f).training.realtimeJudgement.size,'lt_semitone');
  assert.equal(initial(f).training.playbackJudgement.size,'semitone_to_tone');
  assert.equal(b.textContent,'다음 시행');
  for(let i=0;i<2;i++){f.$('aPrimeReplayBtn').click();await f.advance(4510);}
  assert.equal(initial(f).training.preRevealPlays,2);assert.equal(initial(f).training.postRevealPlays,2);

  f.$('aPrimeCorrectionBtn').click();await f.advance(2200);
  assert.equal(day(f).step,'screenCorrection');b.click();await f.flush();
  assert.equal(initial(f).training.screenCorrectionUsed,true);
  assert.equal(f.records()[0].training.mixedWithReference,true);
  f.w.qaOffset=0;b.click();await f.advance(3450);
  assert.equal(day(f).step,'retryResult');b.click();
  await startInitial(f,50);fillLive(f);f.change('aPrimeLiveDirection','match');
  assert.equal(f.$('aPrimeLiveSize').disabled,true);assert.equal(f.$('aPrimeLiveSize').value,'');
  b.click();await f.advance(4510);
  f.change('aPrimePlaybackDirection','low');f.change('aPrimePlaybackSize','octave');
  f.change('aPrimePlaybackDirection','match');f.change('aPrimePlaybackConfidence','2');
  assert.equal(f.$('aPrimePlaybackSize').disabled,true);assert.equal(f.$('aPrimePlaybackSize').value,'');
  b.click();
  assert.equal(day(f).step,'aPrimeResult');assert.ok(f.$('aPrimeCorrectionBtn').classList.contains('hidden'));
  assert.equal(initial(f).training.screenCorrectionUsed,false);
  assert.equal(f.audioEvents.filter(event=>event.type==='worklet').length,0,'A′ must work without loading AudioWorklet');
  assert.equal(f.audioEvents.filter(event=>event.type==='inputConnect').length,5);
  assert.ok(f.audioEvents.filter(event=>event.type==='inputConnect').every(event=>event.analyser),'no extra graph connection');

  const downloads=[];
  f.w.navigator.canShare=()=>true;
  f.w.navigator.share=async({files})=>{downloads.push(files[0]);};
  f.$('aPrimeCsvBtn').click();await f.flush();f.$('aPrimeWavBtn').click();await f.flush();
  assert.equal(downloads.length,2);
  assert.equal(downloads[0].name,`vocal-scope-a-prime-${DATE}.csv`);
  const [header,row1,row2]=String(await readFile(f.w,downloads[0],'readAsText')).trim().split(/\r?\n/).map(line=>line.split(','));
  assert.equal(header.length,19);
  assert.deepEqual(header.slice(-2),['realtime_size','playback_size']);
  assert.deepEqual(row1.slice(0,1),[DATE]);assert.match(row1[1],/^\d{4}-\d\d-\d\dT.*Z$/);
  assert.deepEqual(row1.slice(2),['1','A2','150','-30','low','3','high','2','2','2','true','false','unknown','true','false','lt_semitone','semitone_to_tone']);
  assert.deepEqual(row2.slice(2,13),['2','D#3','50','-30','match','3','match','2','1','0','false']);
  assert.deepEqual(row2.slice(-2),['','']);
  const old=JSON.parse(JSON.stringify(initial(f)));
  old.training.realtimeJudgement={direction:'high',confidence:2};
  old.training.playbackJudgement={direction:'low',confidence:3};
  assert.equal(A.isBlind(old),false);
  assert.ok(A.buildCSV(A.sessionRows([old],DATE)).endsWith(',,\r\n'));
  assert.equal(downloads[1].name,`vocal-scope-a-prime-wav-${DATE}.zip`);
  const entries=readZipEntries(await readFile(f.w,downloads[1],'readAsArrayBuffer'));
  assert.deepEqual([...entries.keys()],[`${DATE}_01_A2.wav`,`${DATE}_02_D#3.wav`]);
  for(const [name,wav] of entries){
    assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt16LE(20),1);
    assert.equal(wav.readUInt32LE(24),rate);assert.equal(wav.readUInt32LE(40),rate*3*2);
    const first=name.includes('_01_');
    const sample=expectedSample(first?45:51,first?150:50,0);
    assert.equal(wav.readInt16LE(44),Math.round(sample*(sample<0?32768:32767)));
    if(first)assert.deepEqual(wav.subarray(44),listenWav.subarray(44+2*voiceStart),'replayed voice has the same samples as exported WAV');
  }

  const reloaded=await fixture(f.seed());
  assert.equal(day(reloaded).step,'aPrimeResult');assert.equal(reloaded.$('aPrimeLiveFields').disabled,true);
  assert.equal(reloaded.$('aPrimeCsvBtn').disabled,false);assert.equal(reloaded.$('aPrimeWavBtn').disabled,true);
  reloaded.change('judgementProtocol','v3a');assert.equal(reloaded.day().step,'judgement');
  assert.equal(reloaded.w.localStorage.getItem(DAY_KEY),legacyProgress);
  assert.deepEqual(reloaded.errors,[]);await reloaded.close();

  // An interrupted start consumes one listen, but never unlocks judgement.
  b.click();await startInitial(f,80);fillLive(f);b.click();await f.advance(2000);
  f.w.dispatchEvent(new f.w.CustomEvent('vs:visibility',{detail:{hidden:true}}));await f.flush();
  assert.equal(day(f).step,'aPrimeListenReady');
  assert.equal(initial(f).training.preRevealPlays,1);
  assert.equal(f.$('aPrimeLiveFields').disabled,true);
  assert.equal(b.disabled,false);
  b.click();await f.advance(2000);
  f.w.dispatchEvent(new f.w.CustomEvent('vs:visibility',{detail:{hidden:true}}));await f.flush();
  assert.equal(day(f).step,'initialInvalid');assert.equal(day(f).cursor,2);
  assert.equal(f.records()[0].training.stage,'discarded');assert.equal(f.records()[0].training.preRevealPlays,2);
  assert.ok(!f.w.VocalHistoryShare.buildExportPayload(f.records()).sessions.some(row=>row.id===f.records()[0].id));
  expectBlind(f);
  await startInitialFromRetry(f);
  const interrupted=await fixture(f.seed());
  assert.equal(day(interrupted).step,'initialInvalid');assert.equal(day(interrupted).cursor,2);
  assert.equal(interrupted.records()[0].training.stage,'discarded');
  interrupted.w.qaNoPitch=true;interrupted.$('measureBtn').click();await interrupted.advance(8100);
  assert.equal(day(interrupted).step,'initialInvalid');assert.match(interrupted.$('judgementActionError').textContent,/마이크 신호는 들어왔지만/);
  interrupted.w.qaSample=()=>0;interrupted.$('measureBtn').click();await interrupted.advance(8100);
  assert.equal(day(interrupted).step,'initialInvalid');assert.match(interrupted.$('judgementActionError').textContent,/소리 신호가 잡히지 않았습니다/);
  assert.deepEqual(interrupted.errors,[]);await interrupted.close();
  assert.deepEqual(f.errors,[]);await f.close();
  console.log('A′: same mic and measurement, single WAV (reference + silence + unchanged voice), sizes, two-listen limit, locking, CSV/WAV and resume passed');
})().catch(error=>{console.error(error);process.exitCode=1;});

async function startInitialFromRetry(f){
  f.$('measureBtn').click();await f.advance(3450);assert.equal(day(f).step,'aPrimeListenReady');
}
