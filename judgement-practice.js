'use strict';
(() => {
  const KEY = 'vocalScopeIntegratedRecordingV3a';
  const MODE_KEY = 'vocalScopeTrainingModeV1';
  const LEVEL_KEY = 'vocalScopeLevelSettingsV1';
  const RULE_KEY = 'vocalScopeCorrectionRulesV3a';
  const C = window.VocalJudgementCore;
  const $ = id => document.getElementById(id);
  const V = () => window.VocalScope;
  const H = () => window.VocalHistory;
  const T = () => window.VocalScopeReferenceTone;
  let day = null;
  let enabled = false, normalTarget = null;
  let correctionRules = { threshold: 100, maximum: 3 };
  let levelSettings = { targetDb: null, toleranceDb: 4 }, liveLevelDb = null;
  const runtime = { context: null, stage: 'initial', onset: null, timer: null, startedAt: null, token: 0, beatStart: null, preparing: false };
  const round = () => day?.rounds?.[day.cursor];
  const current = () => H().readSessions().find(s => s.id === day?.pendingId);
  const active = () => enabled && !!day && day.step !== 'done';
  const pitchHidden = () => active() && day.step !== 'screenCorrection';
  const show = (id, yes) => $(id)?.classList.toggle('hidden', !yes);
  const cents = n => Number.isFinite(n) ? `${n < 0 ? '−' : '+'}${Math.abs(n).toFixed(1)}¢` : '유효 결과 없음';
  function error(text = '') { $('judgementActionError').textContent = text; }
  function correctionCount() {
    return Math.max(0,...H().readSessions().filter(s=>s.training?.dayId===day?.dayId&&s.training?.protocol==='v3a').map(s=>s.training.correctionIndex||0));
  }
  function needsCorrection() {
    const rec=current();
    return Number.isFinite(rec?.assessment?.medianCents)&&Math.abs(rec.assessment.medianCents)>correctionRules.threshold&&(Number.isInteger(rec.training.correctionIndex)||correctionCount()<correctionRules.maximum);
  }
  function saveCorrectionRules() {
    const threshold=$('judgementCorrectionThreshold'),maximum=$('judgementCorrectionMaximum');
    for(const input of [threshold,maximum])if(!input.checkValidity()){input.reportValidity();return;}
    correctionRules={threshold:Number(threshold.value),maximum:Number(maximum.value)};
    try{localStorage.setItem(RULE_KEY,JSON.stringify(correctionRules));}catch(_){error('교정 설정을 저장하지 못했습니다.');}
    render();
  }
  function startCorrection() {
    const rec=current(),index=rec.training.correctionIndex??correctionCount()+1;
    if(!H().updateTraining(rec.id,{correctionIndex:index}))return error('교정 순번을 저장하지 못했습니다.');
    day.correctionIndex=index;persist();return capture('correction');
  }
  function updateLevelMeter() {
    const visible=active()&&day.step==='capturing'&&['initial','retry'].includes(runtime.stage);
    show('judgementLevelMeter',visible);
    const {targetDb,toleranceDb}=levelSettings,hasTarget=Number.isFinite(targetDb);
    const min=Math.min(-80,hasTarget?targetDb-toleranceDb-8:-80);
    const pct=db=>Math.max(0,Math.min(100,(db-min)/-min*100));
    const meter=$('judgementLevelMeter'),fill=$('judgementLevelFill'),band=$('judgementLevelBand');
    const db=visible?liveLevelDb:null;
    fill.style.width=`${Number.isFinite(db)?pct(db):0}%`;
    fill.classList.toggle('in-range',hasTarget&&Number.isFinite(db)&&Math.abs(db-targetDb)<=toleranceDb);
    show('judgementLevelBand',hasTarget);
    if(hasTarget){band.style.left=`${pct(targetDb-toleranceDb)}%`;band.style.width=`${pct(targetDb+toleranceDb)-pct(targetDb-toleranceDb)}%`;}
    meter.setAttribute('aria-valuemin',String(min));
    if(Number.isFinite(db)){meter.setAttribute('aria-valuenow',String(Math.max(min,Math.min(0,db))));meter.setAttribute('aria-valuetext',`${db.toFixed(1)} dBFS`);}
    else{meter.removeAttribute('aria-valuenow');meter.setAttribute('aria-valuetext','입력 대기');}
    $('judgementLevelRange').textContent=hasTarget?`목표 범위 ${(targetDb-toleranceDb).toFixed(1)} ~ ${(targetDb+toleranceDb).toFixed(1)} dBFS`:'목표 미설정 · 마이크 입력 기준 dBFS(보통 음수)';
  }
  function saveLevelSettings() {
    const target=$('judgementLevelTarget'),tolerance=$('judgementLevelTolerance');
    for(const input of [target,tolerance])if(!input.checkValidity()){input.reportValidity();return;}
    levelSettings={targetDb:target.value===''?null:Number(target.value),toleranceDb:Number(tolerance.value)};
    try{localStorage.setItem(LEVEL_KEY,JSON.stringify(levelSettings));}catch(_){error('목표 크기 설정을 저장하지 못했습니다.');}
    updateLevelMeter();
  }
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(day)); return true; } catch (_) { error('진행을 저장하지 못했습니다.'); return false; } }
  function clearTimer() { clearInterval(runtime.timer); clearTimeout(runtime.timer); runtime.timer = null; }
  function localDate() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  function leaveOtherPractice() {
    window.VocalPhrasePractice?.deactivate?.({restoreTarget:true});
    if (window.VocalTrainer?.isActive?.()) window.VocalTrainer.stop();
  }
  function setEnabled(next) {
    if (runtime.preparing || next === enabled) { render(); return; }
    interrupt();
    if (V().state.measuring) V().stopMeasurement('mode-change');
    if (next) { leaveOtherPractice(); normalTarget=V().state.targetMidi; }
    enabled=next;
    if (!enabled) V().setTarget(normalTarget);
    V().clearDisplayedPitch(); error();
    try { localStorage.setItem(MODE_KEY,JSON.stringify({enabled,normalTarget})); } catch (_) { error('훈련 설정을 저장하지 못했습니다.'); }
    render();
    window.dispatchEvent(new CustomEvent('vs:training-mode-change',{detail:{enabled}}));
  }
  function updateOrder() {
    $('judgementBlockOrder').textContent='v3a · 화면 1블록 × 12회';
    $('trainingExportDate').value = $('judgementDate').value;
    if(day?.step==='done')render();
  }
  function configure() {
    const date = $('judgementDate').value;
    const rounds = C.buildRounds(date, C.parseNotes($('judgementTargets').value));
    day = { dayId: date, protocol:'v3a', correctionIndex:null, rounds, cursor: 0, feedbackLevel: Number($('judgementFeedback').value), step: 'referenceReady', pendingId: null, initialSessionId: null };
    leaveOtherPractice();
    persist();
  }
  function context(stage) { return C.training(day, round(), stage, stage === 'initial' ? null : day.initialSessionId); }
  function clearAnswer() { ['judgementDirection','judgementSize','judgementConfidence'].forEach(id => {$(id).value='';}); $('judgementSize').disabled=false; }
  function answer() { return { direction:$('judgementDirection').value, size:$('judgementDirection').value==='match'?null:$('judgementSize').value, confidence:Number($('judgementConfidence').value) }; }
  function updateAnswer() { $('judgementSize').disabled=$('judgementDirection').value==='match'; if ($('judgementSize').disabled) $('judgementSize').value=''; render(); }
  async function reference() {
    const token = ++runtime.token;
    day.step='referencePlaying'; V().setTarget(round().targetMidi,{transient:true}); render(); persist();
    try {
      await T().playTraining(round().targetMidi, 2000);
      if (token !== runtime.token) { T().stop(); return; }
      runtime.timer=setTimeout(()=>{ T().stop(); clearTimer(); day.step='initialReady'; persist(); render(); },2000);
    } catch(e) {if(token!==runtime.token)return;day.step='referenceReady'; render(); error(e.message);}
  }
  async function capture(stage) {
    clearTimer(); T().stop(); error(); clearAnswer();
    liveLevelDb=null;
    runtime.stage=stage; runtime.onset=null; runtime.startedAt=null; runtime.context=context(stage); runtime.preparing=true; day.pendingId=null;
    day.step=stage==='correction'?'screenCorrection':'capturing';
    V().setTarget(round().targetMidi,{transient:true}); render(); persist();
    const token=++runtime.token;
    try {
      if(stage==='correction') await T().startTrainingContinuous(round().targetMidi,{allowPitch:true});
      if(token!==runtime.token){T().stop();return;}
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
    finally {runtime.preparing=false;render();}
  }
  function onSaved(e) {
    if(!runtime.context||e.detail.record.training?.dayId!==day?.dayId)return;
    day.pendingId=e.detail.record.id; if(runtime.stage==='initial')day.initialSessionId=day.pendingId;
  }
  function onStop(e) {
    if(!runtime.context){queueMicrotask(render);return;}
    clearTimer();T().stop();
    const rec=current(), stage=runtime.stage; runtime.context=null;
    if(!rec){day.step=stage==='retry'?'retryReady':stage==='correction'?'initialResult':'initialReady';persist();render();return error('기록을 저장하지 못했습니다. 다시 녹음해 주세요.');}
    if(stage==='correction') day.step='retryReady';
    else if(rec.assessment?.status!=='ok'||e.detail.reason!=='training-complete'){
      if(!H().updateTraining(rec.id,{stage:'discarded',judgement:null,autoScore:null,correctionIndex:null}))return error('실패한 시도를 저장하지 못했습니다.');
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
    day.cursor++;day.pendingId=null;day.initialSessionId=null;day.correctionIndex=null;day.step=round()?'referenceReady':'done';
    persist(); V().clearDisplayedPitch();render();
  }
  async function handleButton() {
    error();
    if(runtime.preparing)return;
    if(!enabled){
      runtime.preparing=true;render();
      try {await V().startMeasurement();} finally {runtime.preparing=false;render();}
      return;
    }
    if(!day||day.step==='done'){try{configure();}catch(e){error(e.message);return;} }
    switch(day.step){
      case 'referenceReady':return reference();
      case 'initialReady':case 'initialInvalid':return capture('initial');
      case 'retryReady':case 'retryInvalid':return capture('retry');
      case 'capturing':return V().stopMeasurement('user');
      case 'judgement':return submitAnswer();
      case 'initialResult':return needsCorrection()?startCorrection():advance();
      case 'screenCorrection':return V().stopMeasurement('training-complete');
      case 'retryResult':return advance();
    }
  }
  function interrupt(){
    if(!enabled)return;
    runtime.token++;clearTimer();T().stop();
    if(V()?.state.measuring&&runtime.context){V().stopMeasurement('training-interrupted');return;}
    if(day?.step==='referencePlaying'){day.step='referenceReady';persist();render();}
  }
  function render(){
    document.body.classList.toggle('training-enabled',enabled);
    document.body.classList.toggle('judgement-active',active());
    document.body.classList.toggle('judgement-screen-correction',enabled&&day?.step==='screenCorrection');
    $('trainingEnabledToggle').checked=enabled;$('trainingEnabledToggle').disabled=runtime.preparing;
    $('trainingToggleLabel').textContent=enabled?'켜짐':'꺼짐';
    $('judgementModeHelp').textContent=enabled?'같은 녹음 버튼으로 훈련을 진행합니다. 훈련을 꺼도 진행 상황은 보관됩니다.':'훈련을 켜면 같은 녹음 버튼에 기준음·판단 입력·교정·재시도가 적용됩니다.';
    show('judgementSetup',enabled&&!active()); show('judgementActive',enabled&&!!day);
    show('judgementFeedbackField',enabled);show('trainingExportControls',enabled);show('judgementActionError',enabled);
    show('judgementOrderControls',enabled);show('judgementOrderHelp',active());
    show('judgementCorrectionRules',enabled);
    $('judgementCorrectionCount').textContent=`교정 ${correctionCount()}/${correctionRules.maximum}`;
    $('judgementCorrectionThreshold').disabled=active()&&day.step!=='referenceReady';
    $('judgementCorrectionMaximum').disabled=active()&&day.step!=='referenceReady';
    show('judgementLevelControls',enabled);updateLevelMeter();
    show('recordingSaveControl',!enabled);show('resetBtn',!enabled);
    const button=$('measureBtn'),r=round(),rec=current(),step=day?.step;
    if(!enabled){
      $('judgementBadge').textContent='일반 녹음';
      button.textContent=V().state.measuring?'측정 종료':'마이크로 측정 시작';button.disabled=runtime.preparing;
      $('judgementResult').textContent='';$('judgementCorrectionLive').textContent='';$('judgementCountdown').textContent='';
      return;
    }
    $('judgementBadge').textContent=!day?'설정':step==='done'?'완료':`${r.trial}/12`;
    if(r){$('judgementLabel').textContent=C.label(context(step==='retryReady'||step==='retryResult'||step==='retryInvalid'?'retry':step?.includes('Correction')?'correction':'initial'),r.targetMidi);$('judgementTarget').textContent=r.targetNote;$('judgementProgress').textContent=`블록 ${r.block} · ${C.BLOCK_LABELS[r.method]}`;}
    show('judgementAnswerForm',step==='judgement');show('judgementCorrectionLive',step==='screenCorrection');
    show('judgementPitchLock',active()&&step!=='screenCorrection');show('judgementResult',step==='initialResult'||step==='retryResult');
    $('judgementResult').textContent=step==='initialResult'?`오차 중앙값: ${cents(rec?.assessment.medianCents)}\n판단 ${rec?.training.autoScore?.correct?'정답':'오답'} (±25¢ 기준)`:step==='retryResult'?`재시도 오차 중앙값: ${cents(rec?.assessment.medianCents)}`:'';
    if(['initialResult','retryResult'].includes(step)&&Number.isFinite(rec?.levelDb))$('judgementResult').textContent+=`\n입력 크기: ${rec.levelDb.toFixed(1)} dBFS`;
    const texts={referenceReady:'기준음 듣기',referencePlaying:'기준음 재생 중',initialReady:'② 3초 부르기',capturing:'녹음 정지',judgement:'결과 보기',initialResult:needsCorrection()?'화면 교정 시작':'다음 회차',screenCorrection:'교정 녹음 정지',retryReady:'재시도 · 3초 녹음',retryResult:'다음 회차',initialInvalid:'다시 부르기',retryInvalid:'재시도 다시 녹음',done:'새 날짜·목표음으로 녹음 준비'};
    button.textContent=texts[step]||'기준음 듣기 · 녹음 준비';
    button.disabled=runtime.preparing||step==='referencePlaying'||step==='judgement'&&!C.validJudgement(answer())||step==='screenCorrection'&&runtime.startedAt==null;
    if(step==='done'&&$('judgementDate').value===day.dayId){button.textContent='12회 녹음 완료';button.disabled=true;}
    const instructions={referenceReady:'기준음을 2초 듣고, 같은 녹음 버튼으로 ②를 시작하세요.',referencePlaying:'목표음을 듣습니다. 2초 후 자동으로 멈춥니다.',initialReady:'기준음 꺼짐. ②는 중간 음량으로 3초 유지하세요.',capturing:'음정과 그래프를 숨기고 녹음합니다.',judgement:'방향·크기·확신도를 입력해야 결과를 볼 수 있습니다.',initialInvalid:'유효한 0.5~2.5초 결과가 없습니다. 실패한 시도는 discarded로 저장했습니다.',retryInvalid:'유효한 결과가 없습니다. 실패한 재시도는 discarded로 저장했습니다.',screenCorrection:'기준음을 켠 채 화면을 보며 2초 맞춘 뒤 녹음을 정지하세요. 이 과정은 평가하지 않습니다.',retryReady:'기준음 꺼짐. 화면을 가리고 3초 재시도합니다. 판단은 입력하지 않습니다.',done:'12회 완료. 하루 JSON에 모든 단계와 실패한 시도를 포함합니다.'};
    $('judgementInstruction').textContent=instructions[step]||'';
    if(step!=='capturing')$('judgementCountdown').textContent='';if(step!=='screenCorrection')$('judgementCorrectionLive').textContent='';
  }
  function restore(){
    try{day=JSON.parse(localStorage.getItem(KEY)||'null');}catch(_){day=null;}
    if(!day?.rounds?.length){day=null;return;}
    $('judgementDate').value=day.dayId;$('judgementTargets').value=day.rounds.map(r=>r.targetNote).join(' ');$('judgementFeedback').value=String(day.feedbackLevel);
    const interrupted=H().readSessions().find(s=>s.training?.dayId===day.dayId&&s.training.protocol==='v3a'&&s.training.trial===day.cursor+1&&['initial','retry'].includes(s.training.stage)&&!s.training.judgement&&s.assessment?.status!=='ok');
    if(interrupted){
      const stage=interrupted.training.stage;
      // Recover the UI without rewriting a previous date's stored record.
      if(day.dayId>=localDate())H().updateTraining(interrupted.id,{stage:'discarded',judgement:null,autoScore:null,correctionIndex:null});
      day.pendingId=interrupted.id;day.initialSessionId=stage==='retry'?interrupted.training.initialSessionId:interrupted.id;day.step=stage==='retry'?'retryInvalid':'initialInvalid';
    }
    const pending=H().readSessions().find(s=>s.training?.dayId===day.dayId&&s.training.protocol==='v3a'&&s.training.stage==='initial'&&!s.training.judgement&&s.assessment?.status==='ok');
    if(pending){day.cursor=pending.training.trial-1;day.pendingId=pending.id;day.initialSessionId=pending.id;day.step='judgement';}
    else if(['capturing','screenCorrection','referencePlaying'].includes(day.step)){const rec=current();day.step=rec?.training.stage==='correction'?'retryReady':rec?.training.stage==='retry'&&rec.assessment?.status==='ok'?'retryResult':day.initialSessionId?'retryReady':'referenceReady';}
    persist();
  }
  function init(){
    try{const saved=JSON.parse(localStorage.getItem(RULE_KEY)||'null');if(saved&&Number.isFinite(saved.threshold)&&saved.threshold>=0&&Number.isInteger(saved.maximum)&&saved.maximum>=0)correctionRules=saved;}catch(_){}
    $('judgementCorrectionThreshold').value=String(correctionRules.threshold);$('judgementCorrectionMaximum').value=String(correctionRules.maximum);
    ['judgementCorrectionThreshold','judgementCorrectionMaximum'].forEach(id=>$(id).addEventListener('change',saveCorrectionRules));
    const feedback=$('judgementFeedback').closest('label');feedback.classList.add('judgement-wide-field');$('judgementSetup').before(feedback);
    try{const saved=JSON.parse(localStorage.getItem(LEVEL_KEY)||'null');if(saved&&Number.isFinite(saved.toleranceDb)&&saved.toleranceDb>=0&&(saved.targetDb===null||Number.isFinite(saved.targetDb)&&saved.targetDb>=-160&&saved.targetDb<=0))levelSettings={targetDb:saved.targetDb,toleranceDb:saved.toleranceDb};}catch(_){}
    $('judgementLevelTarget').value=levelSettings.targetDb??'';$('judgementLevelTolerance').value=String(levelSettings.toleranceDb);
    $('judgementDate').value=localDate();restore();
    try{const mode=JSON.parse(localStorage.getItem(MODE_KEY)||'null');enabled=mode?.enabled===true;normalTarget=Number.isFinite(mode?.normalTarget)?mode.normalTarget:null;}catch(_){enabled=false;}
    if(enabled){leaveOtherPractice();V().clearDisplayedPitch();}
    updateOrder();render();
    window.dispatchEvent(new CustomEvent('vs:training-mode-change',{detail:{enabled}}));
    $('trainingEnabledToggle').addEventListener('change',e=>setEnabled(e.target.checked));
    $('judgementDate').addEventListener('change',updateOrder);
    ['judgementLevelTarget','judgementLevelTolerance'].forEach(id=>$(id).addEventListener('change',saveLevelSettings));
    $('judgementSetup').addEventListener('submit',e=>{e.preventDefault();handleButton();});
    $('judgementAnswerForm').addEventListener('submit',e=>{e.preventDefault();if(C.validJudgement(answer()))submitAnswer();});
    ['judgementDirection','judgementSize','judgementConfidence'].forEach(id=>$(id).addEventListener('change',updateAnswer));
    $('judgementFeedback').addEventListener('change',()=>{if(day){day.feedbackLevel=Number($('judgementFeedback').value);persist();}});
    $('trainingExportBtn').addEventListener('click',()=>window.VocalHistoryShare.exportTrainingDay($('trainingExportDate').value));
    window.addEventListener('vs:pitch',e=>{if(!runtime.context)return;if(runtime.onset==null)runtime.onset=e.detail.now;if(day.step==='screenCorrection')$('judgementCorrectionLive').textContent=`교정 실시간: ${cents((e.detail.midi-round().targetMidi)*100)} · 평가 제외`;});
    window.addEventListener('vs:input-level',e=>{liveLevelDb=e.detail.db;updateLevelMeter();});
    window.addEventListener('vs:history-saved',onSaved);window.addEventListener('vs:measurement-stop',onStop);
    window.addEventListener('vs:visibility',e=>{if(e.detail.hidden)interrupt();});window.addEventListener('pagehide',interrupt);
    window.addEventListener('vs:history-cleared',()=>{interrupt();day=null;localStorage.removeItem(KEY);render();});
  }
  window.VocalJudgementPractice={handleButton,isEnabled:()=>enabled,isActive:active,isPitchHidden:pitchHidden,getSessionContext:()=>enabled&&runtime.context?{...runtime.context}:null};
  document.addEventListener('DOMContentLoaded',init);
})();
