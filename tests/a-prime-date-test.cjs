'use strict';
const assert=require('node:assert/strict');
const {fixture,DAY_KEY}=require('./training-fixture.cjs');
const C=require('../judgement-core.js');

const APRIME_KEY='vocalScopeIntegratedRecordingAPrime';
const yesterday='2026-11-12', today='2026-11-13';
const notes='A2 D#3 F3 D#3 G3 D3 B2 C3 C#3 C3 A2 A#2';
const nextNotes='G2 A2 B2 C3 D3 E3 F3 G3 A3 B3 C4 D4';
const savedDay=(dayId,protocol,targets)=>({
  dayId,protocol,correctionIndex:null,rounds:C.buildRounds(dayId,C.parseNotes(targets)),
  cursor:0,feedbackLevel:0,step:'referenceReady',pendingId:null,initialSessionId:null,
});
const activeDay=f=>JSON.parse(f.w.localStorage.getItem(APRIME_KEY));
const choose=(f,date)=>f.change('judgementDate',date);
const press=f=>f.$('measureBtn').click();
const judge=(f,prefix,direction,size)=>{
  f.change(prefix+'Direction',direction);
  if(size)f.change(prefix+'Size',size);
  f.change(prefix+'Confidence','2');
};

(async()=>{
  const legacy=savedDay('2026-11-10','v3a',notes);
  const f=await fixture({
    [APRIME_KEY]:JSON.stringify(savedDay(yesterday,'a-prime',notes)),
    [DAY_KEY]:JSON.stringify(legacy),
    vocalScopeJudgementProtocol:'a-prime',
    vocalScopeTrainingModeV1:JSON.stringify({enabled:true}),
  });
  const date=f.$('judgementDate');
  assert.equal(date.value,yesterday,'the previous version’s active day survives the update');
  assert.equal(f.w.getComputedStyle(f.$('judgementDateField')).display,'grid');
  assert.equal(f.w.getComputedStyle(f.$('judgementSetup')).display,'none');
  press(f);
  assert.equal(date.disabled,true);
  choose(f,today);
  assert.equal(date.value,yesterday,'date cannot change during the reference');
  await f.advance(2100);
  assert.equal(date.disabled,false);
  press(f);await f.advance(1200);
  assert.equal(date.disabled,true);
  choose(f,today);assert.equal(date.value,yesterday);
  await f.advance(2400);
  assert.equal(activeDay(f).step,'aPrimeListenReady');
  assert.equal(date.disabled,false);
  const initial=f.records()[0];
  assert.equal(initial.training.dayId,yesterday);
  judge(f,'aPrimeLive','low','lt_semitone');
  press(f);await f.flush();
  assert.equal(date.disabled,true);
  choose(f,today);assert.equal(date.value,yesterday);
  await f.advance(4510);
  assert.equal(date.disabled,false);
  judge(f,'aPrimePlayback','high','semitone_to_tone');
  choose(f,today);
  assert.equal(f.w.getComputedStyle(f.$('judgementSetup')).display,'grid');
  assert.equal(f.$('trainingExportDate').value,today);
  assert.equal(f.$('judgementResult').textContent,'');
  f.$('judgementTargets').value=nextNotes;
  press(f);await f.advance(2100);
  press(f);await f.advance(3500);
  const next=f.records().find(r=>r.training.dayId===today);
  assert.equal(next.training.trial,1);
  assert.equal(next.training.targetNote,'G2');
  assert.equal(f.$('aPrimeLiveDirection').value,'');
  judge(f,'aPrimeLive','match');
  press(f);await f.advance(4510);
  judge(f,'aPrimePlayback','match');press(f);
  press(f);
  assert.equal(activeDay(f).cursor,1);

  choose(f,yesterday);await f.flush();
  assert.equal(activeDay(f).step,'aPrimePlaybackJudgement');
  assert.equal(f.$('judgementResult').textContent,'');
  assert.equal(f.$('judgementTargets').value,notes);
  assert.equal(f.$('aPrimeLiveSize').value,'lt_semitone');
  assert.equal(f.$('aPrimePlaybackSize').value,'semitone_to_tone');
  assert.equal(f.$('aPrimeLiveFields').disabled,true);
  assert.match(f.$('aPrimePlayCount').textContent,/공개 전 1\/2회/);
  f.$('aPrimeReplayBtn').click();await f.advance(4510);
  press(f);
  assert.equal(activeDay(f).step,'aPrimeResult');
  assert.equal(f.records().find(r=>r.id===initial.id).training.preRevealPlays,2);
  assert.deepEqual(JSON.parse(f.w.localStorage.getItem(DAY_KEY)),legacy);

  const files=[];
  f.w.navigator.canShare=()=>true;
  f.w.navigator.share=async({files:[file]})=>{files.push(file);};
  // Export remains selectable independently of the date being practiced.
  async function exportDate(expectedDate,note){
    f.$('aPrimeCsvBtn').click();await f.flush();
    const file=files.shift();
    assert.equal(file?.name,`vocal-scope-a-prime-${expectedDate}.csv`);
    const csv=await new Promise((resolve,reject)=>{
      const reader=new f.w.FileReader();
      reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsText(file);
    });
    const rows=csv.trim().split(/\r?\n/).slice(1).map(row=>row.split(','));
    assert.deepEqual(rows.map(row=>[row[0],row[3]]),[[expectedDate,note]]);
  }
  await exportDate(yesterday,'A2');
  f.change('trainingExportDate',today);
  await exportDate(today,'G2');
  assert.equal(date.value,yesterday);
  assert.deepEqual(f.errors,[]);

  const reloaded=await fixture(f.seed());
  assert.equal(reloaded.$('judgementDate').value,yesterday);
  assert.equal(activeDay(reloaded).step,'aPrimeResult');
  choose(reloaded,today);
  assert.equal(activeDay(reloaded).cursor,1);
  assert.equal(reloaded.$('judgementTarget').textContent,'A2');
  assert.deepEqual(reloaded.errors,[]);
  await reloaded.close();

  const finished=await fixture({
    ...f.seed(),
    [APRIME_KEY]:JSON.stringify({...savedDay(yesterday,'a-prime',notes),cursor:12,step:'done'}),
  });
  assert.equal(finished.$('judgementDate').disabled,false);
  assert.equal(finished.$('measureBtn').disabled,true);
  choose(finished,today);
  assert.equal(activeDay(finished).cursor,1);
  choose(finished,yesterday);
  assert.equal(activeDay(finished).step,'done');
  assert.equal(finished.$('measureBtn').disabled,true);
  assert.deepEqual(finished.errors,[]);
  await finished.close();await f.close();
  console.log('A′ dates: prior progress, audio lock, switching with pending judgements, separate date exports and reload passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
