'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const C=require('../judgement-core.js');
const {fixture,DAY_KEY,HISTORY_KEY}=require('./training-fixture.cjs');
const SETTING_KEY='vocalScopeCorrectionModeV1';
const notes='F3 B2 A2 A2 E3 B2 D#3 C#3 A#2 C3 A2 D3 / C3 D3 C3 G3 C#3 D3 E3 E3 A#2 D#3 B2 D#3';
const targets=C.parseNotes(notes);
assert.equal(crypto.createHash('sha256').update(C.windowMedian.toString()).digest('hex'),'769e832e1fa3ead952bece3d2c913b7716bc950730f141e46d41e9a6513854a5');
for(const date of ['2026-10-20','2026-10-21']){
  assert.deepEqual(C.correctionMethods(date),['screen','screen']);
  assert.ok(C.buildRounds(date,targets).every(r=>r.method==='screen'));
}
assert.deepEqual(C.correctionMethods('2026-10-20','compare'),['screen','beat']);
assert.deepEqual(C.correctionMethods('2026-10-21','compare'),['beat','screen']);
assert.throws(()=>C.correctionMethods('2026-02-30'));
assert.throws(()=>C.correctionMethods('2026-10-20','unknown'));
assert.throws(()=>C.buildRounds('2026-10-20',targets.slice(1)));
const oldRecord={id:'previous-day',createdAt:1791990000000,endedAt:1791990003000,durationMs:3000,voicedMs:3000,targetMidi:45,plan:null,training:{dayId:'2026-10-15',block:1,method:'beat',trial:1,targetNote:'A2',targetMidi:45,stage:'correction',judgement:null,autoScore:null,beatHeard:true,mixedWithReference:false,initialSessionId:'old-initial',feedbackLevel:0},assessment:null,points:[],sampleCount:0,minMidi:null,maxMidi:null};
const previous=JSON.stringify(oldRecord);

function noBeat(f){assert.equal(f.$('judgementBeatField').classList.contains('hidden'),true);assert.ok(!['beatCorrection','beatAnswer'].includes(f.day()?.step));}
function judge(f,direction='high'){
  f.change('judgementDirection',direction);
  if(direction!=='match')f.change('judgementSize','lt_semitone');
  f.change('judgementConfidence','2');
  assert.equal(f.$('measureBtn').disabled,false);f.$('measureBtn').click();
}
async function initial(f,offset=80){
  f.w.qaOffset=offset;f.$('measureBtn').click();await f.advance(2100);
  assert.equal(f.day().step,'initialReady');
  f.$('measureBtn').click();await f.advance(3400);
  assert.equal(f.day().step,'judgement');
}

(async()=>{
  const normal=await fixture();
  normal.$('measureBtn').click();await normal.advance(4200);
  assert.equal(normal.w.VocalScope.state.measuring,true);
  assert.equal(normal.day(),null);
  normal.$('measureBtn').click();await normal.flush();
  assert.equal(normal.w.VocalScope.state.measuring,false);
  assert.equal(normal.records().length,1);assert.equal(normal.records()[0].training,null);
  assert.deepEqual(normal.errors,[]);await normal.close();

  const output=[];
  for(const date of ['2026-10-20','2026-10-21']){
    const f=await fixture({[HISTORY_KEY]:JSON.stringify([oldRecord]),vocalScopeTrainingFirstMethodV1:'beat'});
    assert.equal(f.w.VocalJudgementPractice.isEnabled(),false);
    assert.equal(f.$('judgementCorrectionMode').value,'screen_only');
    f.training(true);f.change('judgementDate',date);f.$('judgementTargets').value=notes;
    assert.ok(f.$('judgementBlockOrder').textContent.includes('블록 1 화면 → 블록 2 화면'));
    for(let trial=1;trial<=24;trial++){
      await initial(f);noBeat(f);
      assert.equal(f.day().rounds[trial-1].targetMidi,targets[trial-1]);
      assert.equal(f.$('judgementCorrectionMode').disabled,true);
      judge(f);noBeat(f);assert.equal(f.$('measureBtn').textContent,'화면 교정 시작');
      f.$('measureBtn').click();await f.advance(2200);noBeat(f);
      assert.equal(f.day().step,'screenCorrection');assert.equal(f.w.VocalScope.state.measuring,true);
      f.$('measureBtn').click();await f.flush();noBeat(f);assert.equal(f.day().step,'retryReady');
      f.w.qaOffset=0;f.$('measureBtn').click();await f.advance(3400);noBeat(f);
      assert.equal(f.day().step,'retryResult');
      assert.equal(f.$('judgementAnswerForm').classList.contains('hidden'),true);
      f.$('measureBtn').click();
    }
    assert.equal(f.day().step,'done');
    const exported=f.w.VocalJudgementCore.exportDay(f.records(),date);
    assert.equal(exported.sessions.length,72);
    let sharedFile;
    f.w.navigator.canShare=()=>true;
    f.w.navigator.share=async({files})=>{sharedFile=files[0];};
    await f.w.VocalHistoryShare.exportTrainingDay(date);
    assert.equal(sharedFile?.name,`vocal-scope-training-${date}.json`);
    const sharedText=await new Promise((resolve,reject)=>{
      const reader=new f.w.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsText(sharedFile);
    });
    assert.equal(JSON.stringify(JSON.parse(sharedText)),JSON.stringify(exported));
    assert.ok(exported.sessions.every(s=>s.training?.method==='screen'&&s.training.dayId===date));
    for(const block of [1,2])assert.equal(exported.sessions.filter(s=>s.training.block===block).length,36);
    assert.equal(exported.sessions.filter(s=>s.training.stage==='initial').length,24);
    assert.equal(exported.sessions.filter(s=>s.training.stage==='retry').length,24);
    assert.ok(exported.sessions.filter(s=>s.training.stage==='correction').every(s=>s.training.mixedWithReference&&s.points.length>0&&s.training.beatHeard===null));
    assert.equal(JSON.stringify(f.records().find(s=>s.id===oldRecord.id)),previous);
    const restored=await fixture(f.seed());
    assert.equal(restored.day().correctionMode,'screen_only');assert.ok(restored.day().rounds.every(r=>r.method==='screen'));
    assert.equal(JSON.stringify(restored.records().find(s=>s.id===oldRecord.id)),previous);
    const nextDate=date==='2026-10-20'?'2026-10-21':'2026-10-22';restored.change('judgementDate',nextDate);
    assert.equal(restored.$('judgementCorrectionMode').value,'screen_only');
    assert.deepEqual(restored.errors,[]);await restored.close();
    output.push({dayId:date,block1:'screen',block2:'screen',records:72,beatQuestionShown:false});
    assert.deepEqual(f.errors,[]);await f.close();
  }

  // Comparison follows the requested day parity, not the previous manual order.
  for(const [date,method] of [['2026-10-20','screen'],['2026-10-21','beat']]){
    const f=await fixture();f.training(true);f.change('judgementCorrectionMode','compare');f.change('judgementDate',date);f.$('judgementTargets').value=notes;
    await initial(f);judge(f);f.$('measureBtn').click();await f.advance(2200);
    assert.equal(f.day().rounds[0].method,method);assert.notEqual(f.day().rounds[12].method,method);
    if(method==='beat'){
      assert.equal(f.day().step,'beatCorrection');assert.equal(f.w.VocalScope.state.measuring,false);
      f.$('measureBtn').click();assert.equal(f.$('judgementBeatField').classList.contains('hidden'),false);
      f.change('judgementBeatDetected','N');f.$('measureBtn').click();
      assert.equal(f.records()[0].training.beatHeard,false);
    }else{noBeat(f);assert.equal(f.day().step,'screenCorrection');f.$('measureBtn').click();await f.flush();}
    assert.equal(f.records()[0].training.method,method);assert.deepEqual(f.errors,[]);await f.close();
  }

  // Legacy in-progress plans and earlier records are not silently re-assigned.
  const legacyRounds=targets.map((targetMidi,i)=>({block:i<12?1:2,method:i<12?'screen':'beat',trial:i+1,targetNote:C.noteName(targetMidi),targetMidi}));
  const legacy={dayId:'2026-10-15',rounds:legacyRounds,cursor:0,feedbackLevel:0,step:'referenceReady',pendingId:null,initialSessionId:null};
  const old=await fixture({[DAY_KEY]:JSON.stringify(legacy),[HISTORY_KEY]:JSON.stringify([oldRecord])});
  assert.equal(JSON.stringify(old.day().rounds),JSON.stringify(legacyRounds));
  assert.equal(old.$('judgementCorrectionMode').value,'compare');
  assert.equal(JSON.stringify(old.records()[0]),previous);
  old.training(true);old.change('judgementCorrectionMode','screen_only');
  assert.ok(old.day().rounds.every(r=>r.method==='screen'));assert.equal(JSON.stringify(old.records()[0]),previous);
  await old.close();

  // Changing mode between rounds must not re-label any already-saved session.
  const switched=await fixture();switched.training(true);switched.change('judgementDate','2026-10-21');
  switched.change('judgementCorrectionMode','compare');switched.$('judgementTargets').value=notes;
  await initial(switched,0);judge(switched,'match');switched.$('measureBtn').click();
  assert.equal(switched.day().step,'referenceReady');
  const saved=JSON.stringify(switched.records());
  assert.equal(switched.records()[0].training.method,'beat');
  switched.change('judgementCorrectionMode','screen_only');
  assert.equal(switched.w.localStorage.getItem(SETTING_KEY),'screen_only');
  assert.equal(JSON.stringify(switched.records()),saved);
  assert.ok(switched.day().rounds.every(r=>r.method==='screen'));
  await initial(switched,0);judge(switched,'match');switched.$('measureBtn').click();
  assert.equal(switched.records()[0].training.method,'screen');
  assert.equal(switched.records()[1].training.method,'beat');
  const resumed=await fixture(switched.seed());
  assert.equal(resumed.$('judgementCorrectionMode').value,'screen_only');
  assert.equal(JSON.stringify(resumed.records()),JSON.stringify(switched.records()));
  await resumed.close();assert.deepEqual(switched.errors,[]);await switched.close();

  // Even legacy recovery must leave earlier-date records exactly as stored.
  const interrupted={...oldRecord,id:'old-interrupted',assessment:{status:'too-short',medianCents:null},training:{...oldRecord.training,stage:'initial',beatHeard:null}};
  const interruptedBefore=JSON.stringify(interrupted);
  const recovery=await fixture({[DAY_KEY]:JSON.stringify({...legacy,step:'capturing',pendingId:interrupted.id}),[HISTORY_KEY]:JSON.stringify([interrupted])});
  assert.equal(recovery.day().step,'initialInvalid');
  assert.equal(JSON.stringify(recovery.records()[0]),interruptedBefore);
  assert.deepEqual(recovery.errors,[]);await recovery.close();
  console.log(JSON.stringify({screenOnly:output,comparisonParity:'passed',priorRecordsUnchanged:true,assessmentUnchanged:true},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
