'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const C=require('../judgement-core.js');
const {fixture,HISTORY_KEY}=require('./training-fixture.cjs');
const notes='E3 D#3 F3 D#3 G3 D3 B2 C3 C#3 C3 A2 A#2',date='2026-10-28';
assert.equal(crypto.createHash('sha256').update(C.windowMedian.toString()).digest('hex'),'769e832e1fa3ead952bece3d2c913b7716bc950730f141e46d41e9a6513854a5');
assert.throws(()=>C.buildRounds(date,Array(24).fill(45)));
for(const d of [date,'2026-10-29'])assert.ok(C.buildRounds(d,C.parseNotes(notes)).every(r=>r.block===1&&r.method==='screen'));
async function initial(f,offset){f.w.qaOffset=offset;f.$('measureBtn').click();await f.advance(2100);f.$('measureBtn').click();await f.advance(3400);assert.equal(f.day().step,'judgement');}
function judge(f){f.change('judgementDirection','high');f.change('judgementSize','more');f.change('judgementConfidence','3');f.$('measureBtn').click();}
(async()=>{
 const old={id:'old',createdAt:1,training:{dayId:'2026-10-20',method:'beat',stage:'correction'},points:[]};
 let f=await fixture({[HISTORY_KEY]:JSON.stringify([old])});
 assert.equal(f.w.VocalJudgementPractice.isEnabled(),false);
 f.$('measureBtn').click();await f.advance(3300);f.$('measureBtn').click();await f.flush();
 assert.equal(f.records()[0].training,null);
 f.training(true);f.change('judgementDate',date);f.$('judgementTargets').value=notes;
 const offsets=[150,-150,150,150,50,100,0,0,0,0,0,0];
 for(let i=0;i<12;i++){
  await initial(f,offsets[i]);
  assert.equal(f.w.getComputedStyle(f.w.document.querySelector('.hero')).display,'none');
  assert.equal(f.w.getComputedStyle(f.w.document.querySelector('.graph-card')).display,'none');
  assert.equal(f.$('frequencyValue').textContent,'— Hz');assert.equal(f.$('judgementResult').textContent,'');
  assert.equal(f.day().rounds[i].targetMidi,C.parseNotes(notes)[i]);
  judge(f);
  if(i<3){
   assert.equal(f.$('measureBtn').textContent,'화면 교정 시작');f.$('measureBtn').click();await f.advance(2200);
   assert.equal(f.day().step,'screenCorrection');f.$('measureBtn').click();await f.flush();
   f.w.qaOffset=0;
   if(i===0){f.$('measureBtn').click();await f.advance(500);f.$('measureBtn').click();await f.flush();assert.equal(f.records()[0].training.stage,'discarded');assert.equal(f.records()[0].training.correctionIndex,null);}
   f.$('measureBtn').click();await f.advance(3400);assert.equal(f.day().step,'retryResult');f.$('measureBtn').click();
  }else{assert.equal(f.$('measureBtn').textContent,'다음 회차');f.$('measureBtn').click();}
  assert.ok(f.$('judgementCorrectionCount').textContent.includes(`${Math.min(i+1,3)}/3`));
  if(i===2){const restored=await fixture(f.seed());await f.close();f=restored;}
 }
 assert.equal(f.day().step,'done');assert.equal(f.$('measureBtn').textContent,'12회 녹음 완료');
 const exported=C.exportDay(f.records(),date);assert.equal(exported.sessions.length,19);
 assert.equal(exported.sessions.filter(s=>s.training.stage==='initial').length,12);
 assert.ok(exported.sessions.every(s=>s.training.protocol==='v3a'&&s.training.block===1&&s.training.method==='screen'&&s.training.trial<=12));
 for(let trial=1;trial<=12;trial++){
  const sessions=exported.sessions.filter(s=>s.training.trial===trial);assert.equal(sessions.length,trial===1?4:trial<=3?3:1);
  assert.ok(sessions.every(s=>s.training.correctionIndex===(trial<=3&&s.training.stage!=='discarded'?trial:null)));
 }
 assert.equal(JSON.stringify(f.records().find(s=>s.id==='old')),JSON.stringify(old));
 assert.deepEqual(f.errors,[]);await f.close();
 const custom=await fixture();custom.training(true);custom.change('judgementDate',date);custom.$('judgementTargets').value=notes;
 custom.change('judgementCorrectionThreshold','40');custom.change('judgementCorrectionMaximum','1');
 await initial(custom,50);judge(custom);assert.equal(custom.$('measureBtn').textContent,'화면 교정 시작');
 const reload=await fixture(custom.seed());assert.equal(reload.$('judgementCorrectionThreshold').value,'40');assert.equal(reload.$('judgementCorrectionMaximum').value,'1');
 await reload.close();await custom.close();
 console.log('v3a: 12 ordered trials; first 3 >100c only; 50c and 100c skipped; all linked indices; resume, settings, hidden pitch, old records passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
