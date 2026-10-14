'use strict';
(() => {
  const KEY = 'vocalScopeIntegratedRecordingV1';
  const C = window.VocalJudgementCore;
  const $ = id => document.getElementById(id);
  const V = () => window.VocalScope;
  const H = () => window.VocalHistory;
  const T = () => window.VocalScopeReferenceTone;
  let day = null;
  const runtime = { context: null, stage: 'initial', onset: null, timer: null, startedAt: null, token: 0, beatStart: null };
  const round = () => day?.rounds?.[day.cursor];
  const current = () => H().readSessions().find(s => s.id === day?.pendingId);
  const active = () => !!day && day.step !== 'done';
  const pitchHidden = () => active() && day.step !== 'screenCorrection';
  const show = (id, yes) => $(id)?.classList.toggle('hidden', !yes);
  const cents = n => Number.isFinite(n) ? `${n < 0 ? '−' : '+'}${Math.abs(n).toFixed(1)}¢` : '유효 결과 없음';
  function error(text = '') { $('judgementActionError').textContent = text; }
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(day)); return true; } catch (_) { error('진행을 저장하지 못했습니다.'); return false; } }
  function clearTimer() { clearInterval(runtime.timer); clearTimeout(runtime.timer); runtime.timer = null; }
  function localDate() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  function updateOrder() {
    const date = $('judgementDate').value;
    $('judgementBlockOrder').textContent = C.validDate(date) ? Number(date.slice(-2)) % 2 ? '블록 1 맥놀이 → 블록 2 화면' : '블록 1 화면 → 블록 2 맥놀이' : '연습 날짜를 입력하세요.';
    $('trainingExportDate').value = date;
    if(day?.step==='done')render();
  }
  function configure() {
    const date = $('judgementDate').value;
    const rounds = C.buildRounds(date, C.parseNotes($('judgementTargets').value));
    day = { dayId: date, rounds, cursor: 0, feedbackLevel: Number($('judgementFeedback').value), step: 'referenceReady', pendingId: null, initialSessionId: null };
    window.VocalPhrasePractice?.deactivate?.({restoreTarget:true});
    if (window.VocalTrainer?.isActive?.()) window.VocalTrainer.stop();
    persist();
  }
  function context(stage) { return C.training(day, round(), stage, stage === 'initial' ? null : day.initialSessionId); }
  function clearAnswer() { ['judgementDirection','judgementSize','judgementConfidence'].forEach(id => {$(id).value='';}); $('judgementSize').disabled=false; }
  function answer() { return { direction:$('judgementDirection').value, size:$('judgementDirection').value==='match'?null:$('judgementSize').value, confidence:Number($('judgementConfidence').value) }; }
  function updateAnswer() { $('judgementSize').disabled=$('judgementDirection').value==='match'; if ($('judgementSize').disabled) $('judgementSize').value=''; render(); }
  async function reference() {
    const token = ++runtime.token;
    day.step='referencePlaying'; V().setTarget(round().targetMidi); render(); persist();
    try {
      await T().playTraining(round().targetMidi, 2000);
      if (token !== runtime.token) return;
      runtime.timer=setTimeout(()=>{ T().stop(); clearTimer(); day.step='initialReady'; persist(); render(); },2000);
    } catch(e) {day.step='referenceReady'; render(); error(e.message);}
  }
  async function capture(stage) {
    clearTimer(); T().stop(); error(); clearAnswer();
    runtime.stage=stage; runtime.onset=null; runtime.startedAt=null; runtime.context=context(stage); day.pendingId=null;
    day.step=stage==='correction'?'screenCorrection':'capturing';
    V().setTarget(round().targetMidi); render(); persist();
    const token=++runtime.token;
    try {
      if(stage==='correction') await T().startTrainingContinuous(round().targetMidi,{allowPitch:true});
      if(token!==runtime.token)return;
      await V().startMeasurement();
      if(token!==runtime.token){if(V().state.measuring)V().stopMeasurement('training-interrupted');return;}
      if(!V().state.measuring)throw new Error('마이크를 시작하지 못했습니다.');
      runtime.startedAt=performance.now();
      if(stage!=='correction')runtime.timer=setInterval(()=>{
        const now=performance.now();
        $('judgementCountdown').textContent=runtime.onset==null?'발성을 기다립니다':`${(Math.max(0,3000-(now-runtime.onset))/1000).toFixed(1)}초`;
        if(runtime.onset!=null&&now-runtime.onset>=3000)V().stopMeasurement('training-complete');
        else if(now-runtime.startedAt>=8000)V().stopMeasurement('training-no-voice');
      },60);
      render();
    } catch(e) {clearTimer();T().stop();runtime.context=null;if(stage==='correction')day.pendingId=day.initialSessionId;day.step=stage==='correction'?'initialResult':stage==='retry'?'retryReady':'initialReady';persist();render();error(e.message);}
  }
  async function beatCorrection() {
    if(V().state.measuring)V().stopMeasurement('training-interrupted');
    const token=++runtime.token; runtime.beatStart=Date.now(); day.step='beatCorrection'; render(); persist();
    try { await T().startTrainingContinuous(round().targetMidi); if(token!==runtime.token)return; runtime.beatStart=Date.now();runtime.timer=setTimeout(stopBeat,6000); }
    catch(e){day.step='initialResult';render();error(e.message);}
  }
  function stopBeat() {runtime.token++;clearTimer();T().stop();day.beatStart=runtime.beatStart;day.beatEnd=Date.now();day.step='beatAnswer';$('judgementBeatDetected').value='';persist();render();}
  function saveBeat() {
    const value=$('judgementBeatDetected').value; if(!['Y','N'].includes(value))return;
    if(!H().saveTrainingEvent({...context('correction'),beatHeard:value==='Y'},day.beatStart,day.beatEnd))return error('교정 기록을 저장하지 못했습니다.');
    day.step='retryReady';persist();render();
  }
  function onSaved(e) {
    if(!runtime.context||e.detail.record.training?.dayId!==day?.dayId)return;
    day.pendingId=e.detail.record.id; if(runtime.stage==='initial')day.initialSessionId=day.pendingId;
  }
  function onStop(e) {
    if(!runtime.context)return;
    clearTimer();T().stop();
    const rec=current(), stage=runtime.stage; runtime.context=null;
    if(!rec){day.step=stage==='retry'?'retryReady':stage==='correction'?'initialResult':'initialReady';persist();render();return error('기록을 저장하지 못했습니다. 다시 녹음해 주세요.');}
    if(stage==='correction') day.step='retryReady';
    else if(rec.assessment?.status!=='ok'||e.detail.reason!=='training-complete'){
      if(!H().updateTraining(rec.id,{stage:'discarded',judgement:null,autoScore:null}))return error('실패한 시도를 저장하지 못했습니다.');
      day.step=stage==='retry'?'retryInvalid':'initialInvalid';
    } else day.step=stage==='initial'?'judgement':'retryResult';
    persist();render();
    queueMicrotask(render);
  }
  function submitAnswer() {
    const j=answer(),rec=current();if(!C.validJudgement(j)||!rec)return;
    const autoScore={errorCents:rec.assessment.medianCents,correct:C.judgementCorrect(j,rec.assessment.medianCents)};
    if(!H().updateTraining(rec.id,{judgement:j,autoScore}))return error('판단을 저장하지 못했습니다.');
    if(!C.shouldShowFeedback(rec.training.feedbackLevel,round().trial)){advance();return;}
    day.step='initialResult';persist();render();
  }
  function advance() {
    clearTimer();T().stop();runtime.context=null;runtime.stage='initial';
    day.cursor++;day.pendingId=null;day.initialSessionId=null;day.step=round()?'referenceReady':'done';
    persist(); V().clearDisplayedPitch();render();
  }
  async function handleButton() {
    error();
    if(!day||day.step==='done'){try{configure();}catch(e){error(e.message);return;} }
    switch(day.step){
      case 'referenceReady':return reference();
      case 'initialReady':case 'initialInvalid':return capture('initial');
      case 'retryReady':case 'retryInvalid':return capture('retry');
      case 'capturing':return V().stopMeasurement('user');
      case 'judgement':return submitAnswer();
      case 'initialResult':return Math.abs(current().assessment.medianCents)>25 ? round().method==='beat'?beatCorrection():capture('correction') : advance();
      case 'beatCorrection':return stopBeat();
      case 'beatAnswer':return saveBeat();
      case 'screenCorrection':return V().stopMeasurement('training-complete');
      case 'retryResult':return advance();
    }
  }
  function interrupt(){
    runtime.token++;clearTimer();T().stop();
    if(day?.step==='beatCorrection'){stopBeat();return;}
    if(V()?.state.measuring&&runtime.context){V().stopMeasurement('training-interrupted');return;}
    if(day?.step==='referencePlaying'){day.step='referenceReady';persist();render();}
  }
  function render(){
    document.body.classList.toggle('judgement-active',active());
    document.body.classList.toggle('judgement-screen-correction',day?.step==='screenCorrection');
    show('judgementSetup',!active()); show('judgementActive',!!day);
    const button=$('measureBtn'),r=round(),rec=current(),step=day?.step;
    $('judgementBadge').textContent=!day?'설정':step==='done'?'완료':`${r.trial}/24`;
    if(r){$('judgementLabel').textContent=C.label(context(step==='retryReady'||step==='retryResult'||step==='retryInvalid'?'retry':step?.includes('Correction')||step==='beatAnswer'?'correction':'initial'),r.targetMidi);$('judgementTarget').textContent=r.targetNote;$('judgementProgress').textContent=`블록 ${r.block} · ${C.BLOCK_LABELS[r.method]}`;}
    show('judgementAnswerForm',step==='judgement');show('judgementBeatField',step==='beatAnswer');show('judgementCorrectionLive',step==='screenCorrection');
    show('judgementPitchLock',active()&&step!=='screenCorrection');show('judgementResult',step==='initialResult'||step==='retryResult');
    $('judgementResult').textContent=step==='initialResult'?`오차 중앙값: ${cents(rec?.assessment.medianCents)}\n판단 ${rec?.training.autoScore?.correct?'정답':'오답'} (±25¢ 기준)`:step==='retryResult'?`재시도 오차 중앙값: ${cents(rec?.assessment.medianCents)}`:'';
    const texts={referenceReady:'기준음 듣기',referencePlaying:'기준음 재생 중',initialReady:'② 3초 부르기',capturing:'녹음 정지',judgement:'결과 보기',initialResult:rec&&Math.abs(rec.assessment.medianCents)>25?'교정 시작':'다음 회차',beatCorrection:'기준음 끄기',beatAnswer:'Y/N 저장',screenCorrection:'교정 녹음 정지',retryReady:'재시도 · 3초 녹음',retryResult:'다음 회차',initialInvalid:'다시 부르기',retryInvalid:'재시도 다시 녹음',done:'새 날짜·목표음으로 녹음 준비'};
    button.textContent=texts[step]||'기준음 듣기 · 녹음 준비';
    button.disabled=step==='referencePlaying'||step==='judgement'&&!C.validJudgement(answer())||step==='beatAnswer'&&!['Y','N'].includes($('judgementBeatDetected').value)||step==='screenCorrection'&&runtime.startedAt==null;
    if(step==='done'&&$('judgementDate').value===day.dayId){button.textContent='24회 녹음 완료';button.disabled=true;}
    const instructions={referenceReady:'기준음을 2초 듣고, 같은 녹음 버튼으로 ②를 시작하세요.',referencePlaying:'목표음을 듣습니다. 2초 후 자동으로 멈춥니다.',initialReady:'기준음 꺼짐. ②는 중간 음량으로 3초 유지하세요.',capturing:'음정과 그래프를 숨기고 녹음합니다.',judgement:'방향·크기·확신도를 입력해야 결과를 볼 수 있습니다.',initialInvalid:'유효한 0.5~2.5초 결과가 없습니다. 실패한 시도는 discarded로 저장했습니다.',retryInvalid:'유효한 결과가 없습니다. 실패한 재시도는 discarded로 저장했습니다.',beatCorrection:'마이크 꺼짐. 겹쳐 부르며 맞춘 뒤 기준음을 끄세요. 최대 6초.',beatAnswer:'겹치기 시작할 때 울렁임이 들렸는지 Y/N을 입력하세요.',screenCorrection:'기준음을 켠 채 화면을 보며 2초 맞춘 뒤 녹음을 정지하세요. 이 과정은 평가하지 않습니다.',retryReady:'기준음 꺼짐. 화면을 가리고 3초 재시도합니다. 판단은 입력하지 않습니다.',done:'24회 완료. 하루 JSON에 모든 단계와 실패한 시도를 포함합니다.'};
    $('judgementInstruction').textContent=instructions[step]||'';
    if(step!=='capturing')$('judgementCountdown').textContent='';if(step!=='screenCorrection')$('judgementCorrectionLive').textContent='';
  }
  function restore(){
    try{day=JSON.parse(localStorage.getItem(KEY)||'null');}catch(_){day=null;}
    if(!day?.rounds?.length){day=null;return;}
    $('judgementDate').value=day.dayId;$('judgementTargets').value=day.rounds.map(r=>r.targetNote).join(' ');$('judgementFeedback').value=String(day.feedbackLevel);
    const interrupted=H().readSessions().find(s=>s.training?.dayId===day.dayId&&s.training.trial===day.cursor+1&&['initial','retry'].includes(s.training.stage)&&!s.training.judgement&&s.assessment?.status!=='ok');
    if(interrupted){const stage=interrupted.training.stage;H().updateTraining(interrupted.id,{stage:'discarded',judgement:null,autoScore:null});day.pendingId=interrupted.id;day.initialSessionId=stage==='retry'?interrupted.training.initialSessionId:interrupted.id;day.step=stage==='retry'?'retryInvalid':'initialInvalid';}
    const pending=H().readSessions().find(s=>s.training?.dayId===day.dayId&&s.training.stage==='initial'&&!s.training.judgement&&s.assessment?.status==='ok');
    if(pending){day.cursor=pending.training.trial-1;day.pendingId=pending.id;day.initialSessionId=pending.id;day.step='judgement';}
    else if(['capturing','screenCorrection','referencePlaying'].includes(day.step)){const rec=current();day.step=rec?.training.stage==='correction'?'retryReady':rec?.training.stage==='retry'&&rec.assessment?.status==='ok'?'retryResult':day.initialSessionId?'retryReady':'referenceReady';}
    else if(day.step==='beatCorrection')day.step='initialResult';
    persist();
  }
  function init(){
    const feedback=$('judgementFeedback').closest('label');feedback.classList.add('judgement-wide-field');$('judgementSetup').before(feedback);
    $('judgementDate').value=localDate();restore();updateOrder();render();
    $('judgementDate').addEventListener('change',updateOrder);
    $('judgementSetup').addEventListener('submit',e=>{e.preventDefault();handleButton();});
    $('judgementAnswerForm').addEventListener('submit',e=>{e.preventDefault();if(C.validJudgement(answer()))submitAnswer();});
    ['judgementDirection','judgementSize','judgementConfidence'].forEach(id=>$(id).addEventListener('change',updateAnswer));
    $('judgementBeatDetected').addEventListener('change',render);
    $('judgementFeedback').addEventListener('change',()=>{if(day){day.feedbackLevel=Number($('judgementFeedback').value);persist();}});
    $('trainingExportBtn').addEventListener('click',()=>window.VocalHistoryShare.exportTrainingDay($('trainingExportDate').value));
    window.addEventListener('vs:pitch',e=>{if(!runtime.context)return;if(runtime.onset==null)runtime.onset=e.detail.now;if(day.step==='screenCorrection')$('judgementCorrectionLive').textContent=`교정 실시간: ${cents((e.detail.midi-round().targetMidi)*100)} · 평가 제외`;});
    window.addEventListener('vs:history-saved',onSaved);window.addEventListener('vs:measurement-stop',onStop);
    window.addEventListener('vs:visibility',e=>{if(e.detail.hidden)interrupt();});window.addEventListener('pagehide',interrupt);
    window.addEventListener('vs:history-cleared',()=>{interrupt();day=null;localStorage.removeItem(KEY);render();});
  }
  window.VocalJudgementPractice={handleButton,isActive:active,isPitchHidden:pitchHidden,getSessionContext:()=>runtime.context?{...runtime.context}:null};
  document.addEventListener('DOMContentLoaded',init);
})();
