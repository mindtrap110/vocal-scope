'use strict';
const assert=require('node:assert/strict');
const L=require('../level-core.js'),C=require('../judgement-core.js');
const {fixture}=require('./training-fixture.cjs');
const targets=Array(12).fill('A2').join(' '),date='2026-10-20';

// Known PCM power, overlapping buffers, and loud input outside the assessment
// window provide an independent numeric oracle, rather than averaging dB.
for(const rate of [44100,48000]){
  const onset=100,window=L.createWindow();window.onsetMs=onset;
  const sampleAt=time=>time>=onset+500&&time<onset+2500?0.01:0.9;
  for(let ms=42;ms<=3100;ms+=42){
    const end=Math.round(ms*rate/1000),endMs=end/rate*1000;
    const samples=Float32Array.from({length:4096},(_,i)=>sampleAt((end-4096+i)/rate*1000));
    L.captureFrame(window,samples,rate,end,endMs);
    const count=window.sampleCount;L.captureFrame(window,samples,rate,end,endMs);assert.equal(window.sampleCount,count);
  }
  assert.equal(L.levelDb(window),-40);
  assert.ok(Math.abs(window.sampleCount-2*rate)<=2,`${rate} Hz counted each sample once: ${window.sampleCount}`);
}
const energy=L.createWindow();energy.onsetMs=0;
for(let end=200;end<=2800;end+=100){
  const samples=Float32Array.from({length:200},(_,i)=>end-200+i<1500?0.01:0.1);
  L.captureFrame(energy,samples,1000,end,end);
}
assert.equal(L.levelDb(energy),Math.round(10*Math.log10((0.01**2+0.1**2)/2)*10)/10);
assert.notEqual(L.levelDb(energy),-30);
assert.equal(L.levelDb(L.createWindow()),null);
assert.equal(L.frameDb(new Float32Array(4096)),null);
const partial=L.createWindow();partial.onsetMs=0;
L.captureFrame(partial,new Float32Array(2000).fill(0.1),1000,2000,2000);
assert.equal(L.levelDb(partial),-20);assert.equal(partial.sampleCount,1500);

function setup(f,dayId=date){f.training(true);f.change('judgementDate',dayId);f.$('judgementTargets').value=targets;}
function judge(f,direction='match'){
  f.change('judgementDirection',direction);if(direction!=='match')f.change('judgementSize','lt_semitone');
  f.change('judgementConfidence','3');f.$('measureBtn').click();
}
async function startInitial(f){f.$('measureBtn').click();await f.advance(2100);f.$('measureBtn').click();await f.flush();}
function pitchIsHidden(f){
  assert.equal(f.w.VocalJudgementPractice.isPitchHidden(),true);
  for(const selector of ['.hero','.graph-card'])assert.equal(f.w.getComputedStyle(f.w.document.querySelector(selector)).display,'none');
  assert.equal(f.$('noteName').textContent,'—');assert.equal(f.$('frequencyValue').textContent,'— Hz');
}
async function exported(f,dayId=date){
  let file;f.w.navigator.canShare=()=>true;f.w.navigator.share=async({files})=>{file=files[0];};
  await f.w.VocalHistoryShare.exportTrainingDay(dayId);
  assert.equal(file.name,`vocal-scope-training-${dayId}.json`);
  const text=await new Promise((resolve,reject)=>{const reader=new f.w.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsText(file);});
  return JSON.parse(text);
}

(async()=>{
  // Same 3-second synthetic vowel, through the real pitch detector and app
  // recording controller. Hardware microphones and human repeatability are not mocked as proof.
  const f=await fixture();f.w.qaOffset=0;f.w.qaActualPitch=true;
  const scale=Math.sqrt(2*10**(-30/10)/(1+0.35**2+0.2**2));
  f.w.qaSample=time=>scale*(Math.sin(2*Math.PI*110*time)+0.35*Math.sin(2*Math.PI*220*time)+0.2*Math.sin(2*Math.PI*330*time));
  assert.equal(f.$('judgementLevelTarget').value,'');assert.equal(f.$('judgementLevelTolerance').value,'4');
  setup(f);
  for(let trial=1;trial<=2;trial++){
    await startInitial(f);await f.advance(700);pitchIsHidden(f);
    assert.equal(f.$('judgementLevelMeter').classList.contains('hidden'),false);
    assert.ok(parseFloat(f.$('judgementLevelFill').style.width)>0);
    if(trial===1){
      assert.equal(f.$('judgementLevelBand').classList.contains('hidden'),true);
      assert.equal(f.$('judgementLevelFill').classList.contains('in-range'),false);
      f.change('judgementLevelTarget','-30');
      assert.equal(f.$('judgementLevelBand').classList.contains('hidden'),false);
      assert.equal(f.$('judgementLevelFill').classList.contains('in-range'),true);
      f.change('judgementLevelTarget','-45');assert.equal(f.$('judgementLevelFill').classList.contains('in-range'),false);
      f.change('judgementLevelTolerance','20');assert.equal(f.$('judgementLevelFill').classList.contains('in-range'),true);
      f.change('judgementLevelTolerance','4');f.change('judgementLevelTarget','-30');
    }
    await f.advance(2700);assert.equal(f.day().step,'judgement');pitchIsHidden(f);
    assert.equal(f.$('judgementLevelMeter').classList.contains('hidden'),true);
    assert.equal(f.$('judgementResult').textContent,'');
    assert.equal(f.records()[0].assessment.status,'ok');assert.equal(f.records()[0].training.stage,'initial');
    assert.ok(Math.abs(f.records()[0].levelDb-(-30))<=0.1);
    judge(f);assert.ok(f.$('judgementResult').textContent.includes('dBFS'));f.$('measureBtn').click();
  }
  const repeated=f.records().map(s=>s.levelDb),differenceDb=Math.abs(repeated[0]-repeated[1]);
  assert.ok(differenceDb<=2);
  const day=await exported(f);assert.equal(day.sessions.length,2);assert.equal(day.initialLevelDbMedian,-30);
  assert.ok(day.sessions.every(s=>Number.isFinite(s.levelDb)));
  const restored=await fixture(f.seed());assert.equal(restored.$('judgementLevelTarget').value,'-30');assert.equal(restored.$('judgementLevelTolerance').value,'4');
  assert.equal(JSON.stringify(restored.records()),JSON.stringify(f.records()));await restored.close();
  assert.deepEqual(f.errors,[]);await f.close();

  // Screen correction is measured, marked as mixed, and excluded from the
  // daily initial median. Its deliberately shorter recording still has level.
  const screen=await fixture();setup(screen);screen.w.qaDb=-25;screen.w.qaOffset=180;
  await startInitial(screen);await screen.advance(3400);judge(screen,'high');
  screen.w.qaDb=-20;screen.$('measureBtn').click();await screen.advance(2000);
  assert.equal(screen.$('judgementLevelMeter').classList.contains('hidden'),true);
  screen.$('measureBtn').click();await screen.flush();
  assert.equal(screen.records()[0].training.stage,'correction');assert.equal(screen.records()[0].training.mixedWithReference,true);
  assert.equal(screen.records()[0].levelDb,-20);assert.ok(screen.records()[0].points.length>0);
  screen.w.qaDb=-28;screen.w.qaOffset=0;screen.$('measureBtn').click();await screen.advance(700);pitchIsHidden(screen);
  assert.equal(screen.$('judgementLevelMeter').classList.contains('hidden'),false);
  await screen.advance(2700);assert.equal(screen.day().step,'retryResult');
  assert.equal(screen.records()[0].training.stage,'retry');assert.equal(screen.records()[0].levelDb,-28);
  const screenDay=await exported(screen);assert.equal(screenDay.initialLevelDbMedian,-25);assert.equal(screenDay.sessions.length,3);
  const general=screen.w.VocalHistoryShare.buildExportPayload(screen.records());assert.ok(general.sessions.every(s=>Object.hasOwn(s,'levelDb')));
  screen.training(false);screen.w.VocalHistory.openSession(screen.records()[1].id);
  assert.ok(screen.$('sessionLevel').textContent.includes('기준음 포함'));
  assert.deepEqual(screen.errors,[]);await screen.close();

  // Once onset is known, subsequent pitch gaps do not delete quiet/noisy input
  // from the RMS window; a no-onset discarded recording has no invented value.
  const gap=await fixture();setup(gap);await startInitial(gap);await gap.advance(500);gap.w.qaNoPitch=true;await gap.advance(2900);
  assert.equal(gap.day().step,'initialInvalid');assert.equal(gap.records()[0].training.stage,'discarded');
  assert.equal(gap.records()[0].levelDb,-30);assert.deepEqual(gap.errors,[]);await gap.close();
  const silent=await fixture();setup(silent);silent.w.qaNoPitch=true;
  await startInitial(silent);await silent.advance(8300);
  assert.equal(silent.records()[0].levelDb,null);assert.equal(silent.records()[0].training.stage,'discarded');
  assert.deepEqual(silent.errors,[]);await silent.close();

  const mixed=[
    {createdAt:3,levelDb:-10,training:{dayId:date,stage:'correction'}},
    {createdAt:1,levelDb:-30.1,training:{dayId:date,stage:'initial'}},
    {createdAt:2,levelDb:-30.2,training:{dayId:date,stage:'initial'}},
    {createdAt:4,levelDb:-50,training:{dayId:date,stage:'retry'}},
    {createdAt:5,levelDb:-60,training:{dayId:date,stage:'discarded'}},
    {createdAt:6,training:{dayId:date,stage:'initial'}},
    {createdAt:7,levelDb:0,training:{dayId:'2026-10-21',stage:'initial'}},
  ];
  const before=JSON.stringify(mixed);assert.equal(C.exportDay(mixed,date).initialLevelDbMedian,-30.15);assert.equal(JSON.stringify(mixed),before);
  assert.equal(C.exportDay([],date).initialLevelDbMedian,null);
  console.log(JSON.stringify({syntheticVowelLevelDb:repeated,differenceDb,within2Db:differenceDb<=2,windowClipping:'passed',screenCorrection:'passed',dailyExport:'passed',pitchHidden:'passed',settings:'passed'},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
