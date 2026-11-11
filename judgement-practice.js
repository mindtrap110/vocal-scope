'use strict';
(() => {
  const KEY = 'vocalScopeIntegratedRecordingV3a';
  const APRIME_KEY = 'vocalScopeIntegratedRecordingAPrime';
  const PROTOCOL_KEY = 'vocalScopeJudgementProtocol';
  const MODE_KEY = 'vocalScopeTrainingModeV1';
  const LEVEL_KEY = 'vocalScopeLevelSettingsV1';
  const RULE_KEY = 'vocalScopeCorrectionRulesV3a';
  const C = window.VocalJudgementCore;
  const A = window.VocalAPrime;
  const $ = id => document.getElementById(id);
  const V = () => window.VocalScope;
  const H = () => window.VocalHistory;
  const T = () => window.VocalScopeReferenceTone;
  let day = null, protocol = 'v3a';
  let enabled = false, normalTarget = null;
  let correctionRules = { threshold: 100, maximum: 3 };
  let levelSettings = { targetDb: null, toleranceDb: 4 }, liveLevelDb = null;
  const runtime = { context: null, stage: 'initial', onset: null, timer: null, startedAt: null, token: 0, preparing: false, take: null, replay: null };
  const clips = new Map();
  const aPrime = () => protocol === A.PROTOCOL;
  const dayKey = () => aPrime() ? APRIME_KEY : KEY;
  const round = () => day?.rounds?.[day.cursor];
  const current = () => H().readSessions().find(s => s.id === day?.pendingId);
  const active = () => enabled && !!day && day.step !== 'done';
  const pitchHidden = () => active() && day.step !== 'screenCorrection';
  const show = (id, yes) => $(id)?.classList.toggle('hidden', !yes);
  const cents = n => Number.isFinite(n) ? `${n < 0 ? '−' : '+'}${Math.abs(n).toFixed(1)}¢` : '유효 결과 없음';
  function error(text = '') { $('judgementActionError').textContent = text; }
  function correctionCount() {
    return Math.max(0,...H().readSessions().filter(s=>s.training?.dayId===day?.dayId&&s.training?.protocol===protocol).map(s=>s.training.correctionIndex||0));
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
  function persist() { try { localStorage.setItem(dayKey(), JSON.stringify(day)); return true; } catch (_) { error('진행을 저장하지 못했습니다.'); return false; } }
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
    $('judgementBlockOrder').textContent=aPrime()?'A′ · 12회 · 실시간 판단 → 듣기 → 재생 판단':'v3a · 화면 1블록 × 12회';
    $('trainingExportDate').value = $('judgementDate').value;
    if(day?.step==='done')render();
  }
  function configure() {
    const date = $('judgementDate').value;
    const rounds = C.buildRounds(date, C.parseNotes($('judgementTargets').value));
    day = { dayId: date, protocol, correctionIndex:null, rounds, cursor: 0, feedbackLevel: aPrime()?0:Number($('judgementFeedback').value), step: 'referenceReady', pendingId: null, initialSessionId: null };
    leaveOtherPractice();
    persist();
  }
  function context(stage) {
    const training=C.training(day, round(), stage, stage === 'initial' ? null : day.initialSessionId);
    if(!aPrime())return training;
    return {...training,protocol,...(stage==='initial'?{
      realtimeJudgement:null,playbackJudgement:null,preRevealPlays:0,postRevealPlays:0,screenCorrectionUsed:false,
    }:{})};
  }
  function changeProtocol() {
    const select=$('judgementProtocol');
    if(runtime.preparing||runtime.replay||V().state.measuring||day?.step==='referencePlaying'){select.value=protocol;return;}
    const next=select.value===A.PROTOCOL?A.PROTOCOL:'v3a';
    if(next===protocol)return;
    interrupt();
    protocol=next;
    try{localStorage.setItem(PROTOCOL_KEY,protocol);}catch(_){}
    error();restore();updateOrder();V().clearDisplayedPitch();render();
  }
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
    disposeTake();
    const recordVoice=aPrime()&&stage==='initial';
    if(recordVoice)setAPrimeAnswers();
    liveLevelDb=null;
    runtime.stage=stage; runtime.onset=null; runtime.startedAt=null; runtime.context=context(stage); runtime.preparing=true; day.pendingId=null;
    day.step=stage==='correction'?'screenCorrection':'capturing';
    V().setTarget(round().targetMidi,{transient:true}); render(); persist();
    const token=++runtime.token;
    try {
      if(stage==='correction') await T().startTrainingContinuous(round().targetMidi,{allowPitch:true});
      if(token!==runtime.token){T().stop();return;}
      if(recordVoice){
        await V().startMeasurement({prepareInput:async input=>{
          const take=await A.connectCapture({...input,version:V().APP_VERSION});
          if(token!==runtime.token){take.dispose();throw new Error('A′ 녹음 준비가 중단되었습니다.');}
          runtime.take=take;
          runtime.context.micSettings=take.micSettings;
        }});
      }else await V().startMeasurement();
      if(token!==runtime.token){if(V().state.measuring)V().stopMeasurement('training-interrupted');return;}
      if(!V().state.measuring)throw new Error('마이크를 시작하지 못했습니다.');
      runtime.startedAt=performance.now();
      if(stage!=='correction')runtime.timer=setInterval(()=>{
        const now=performance.now();
        $('judgementCountdown').textContent=runtime.onset==null?'발성을 기다립니다':`${(Math.max(0,3000-(now-runtime.onset))/1000).toFixed(1)}초`;
        if(runtime.onset!=null&&now-runtime.onset>=3000){
          // The worklet returns exactly 3 s of PCM. Give its message a short
          // window to arrive before closing the input context.
          if(!recordVoice||runtime.take?.clip||runtime.take?.failed||now-runtime.onset>=3450)V().stopMeasurement('training-complete');
        }
        else if(now-runtime.startedAt>=8000)V().stopMeasurement('training-no-voice');
      },60);
      render();
    } catch(e) {clearTimer();T().stop();disposeTake();runtime.context=null;if(stage==='correction')day.pendingId=day.initialSessionId;day.step=stage==='correction'?initialResultStep():stage==='retry'?'retryReady':'initialReady';persist();render();error(e.message);}
    finally {runtime.preparing=false;render();}
  }
  function onSaved(e) {
    if(!runtime.context||e.detail.record.training?.dayId!==day?.dayId)return;
    day.pendingId=e.detail.record.id; if(runtime.stage==='initial')day.initialSessionId=day.pendingId;
  }
  function onStop(e) {
    if(!runtime.context){queueMicrotask(render);return;}
    clearTimer();T().stop();
    const rec=current(), stage=runtime.stage, clip=runtime.take?.clip; runtime.context=null;disposeTake();
    if(!rec){day.step=stage==='retry'?'retryReady':stage==='correction'?initialResultStep():'initialReady';persist();render();return error('기록을 저장하지 못했습니다. 다시 녹음해 주세요.');}
    if(stage==='correction') {
      if(aPrime()&&!H().updateTraining(day.initialSessionId,{screenCorrectionUsed:true}))error('화면 교정 여부를 저장하지 못했습니다.');
      day.step='retryReady';
    }
    else if(rec.assessment?.status!=='ok'||e.detail.reason!=='training-complete'){
      if(!H().updateTraining(rec.id,{stage:'discarded',judgement:null,autoScore:null,correctionIndex:null}))return error('실패한 시도를 저장하지 못했습니다.');
      day.step=stage==='retry'?'retryInvalid':'initialInvalid';
    } else if(aPrime()&&stage==='initial'){
      if(!clip)discardAPrimeTake(rec,'3초 녹음이 완성되지 않았습니다. 같은 시행을 다시 불러 주세요.');
      else {clips.set(rec.id,clip);day.step='aPrimeListenReady';}
    } else day.step=stage==='initial'?'judgement':'retryResult';
    persist();render();
    queueMicrotask(render);
  }
  function disposeTake() { runtime.take?.dispose();runtime.take=null; }
  function initialResultStep() { return aPrime()?'aPrimeResult':'initialResult'; }
  function aPrimeInitial() { return H().readSessions().find(s=>s.id===day?.initialSessionId&&A.isInitial(s)); }
  function aPrimeAnswer(prefix) { return {direction:$(`${prefix}Direction`).value,confidence:Number($(`${prefix}Confidence`).value)}; }
  function setAPrimeAnswer(prefix,value) {
    $(`${prefix}Direction`).value=value?.direction??'';
    $(`${prefix}Confidence`).value=value?.confidence==null?'':String(value.confidence);
  }
  function setAPrimeAnswers(realtime, playback) {
    setAPrimeAnswer('aPrimeLive',realtime);setAPrimeAnswer('aPrimePlayback',playback);
  }
  function discardAPrimeTake(rec, message) {
    if(A.isPending(rec)){
      clips.delete(rec.id);
      H().updateTraining(rec.id,{stage:'discarded',correctionIndex:null});
    }
    day.pendingId=null;day.initialSessionId=null;day.step='initialInvalid';
    setAPrimeAnswers();persist();render();error(message);
  }
  async function listenAPrime(postReveal) {
    if(!enabled||!aPrime()||runtime.replay||runtime.preparing||V().state.measuring)return;
    const rec=aPrimeInitial(),clip=clips.get(rec?.id);
    if(!rec||!clip)return;
    if(postReveal){
      if(A.isPending(rec)||!['aPrimeResult','retryResult'].includes(day.step))return;
    }else{
      const realtimeJudgement=aPrimeAnswer('aPrimeLive');
      if(day.step!=='aPrimeListenReady'||rec.training.preRevealPlays!==0||!A.validJudgement(realtimeJudgement))return;
      if(!H().updateTraining(rec.id,{realtimeJudgement}))return error('실시간 판단을 저장하지 못했습니다.');
    }
    error();
    const request={record:rec,postReveal,started:false};
    runtime.replay=request;render();
    try {
      const playback=await T().playTrainingWithRecording(rec.training.targetMidi,clip);
      if(runtime.replay!==request)return;
      if(!playback)throw new Error('재생을 시작하지 못했습니다. 다시 눌러 주세요.');
      request.started=true;
      const counter=postReveal?'postRevealPlays':'preRevealPlays';
      if(!H().updateTraining(rec.id,{[counter]:(rec.training[counter]||0)+1})){
        T().stop();throw new Error('재생 횟수를 저장하지 못했습니다.');
      }
      render();
      const completed=await playback.ended;
      if(runtime.replay!==request)return;
      if(!postReveal){
        if(completed){day.step='aPrimePlaybackJudgement';persist();}
        else discardAPrimeTake(rec,'듣기가 중단되었습니다. 같은 시행을 다시 녹음해 주세요.');
      }else if(!completed)error('다시 듣기가 중단되었습니다.');
    }catch(e){
      if(runtime.replay!==request)return;
      if(!postReveal&&request.started)discardAPrimeTake(rec,`${e.message} 같은 시행을 다시 녹음해 주세요.`);
      else error(e.message);
    }finally{
      if(runtime.replay===request){runtime.replay=null;render();}
    }
  }
  function submitAPrimeAnswer() {
    const rec=aPrimeInitial();
    if(day.step!=='aPrimePlaybackJudgement'||!A.isPending(rec)||rec.training.preRevealPlays!==1)return;
    const realtimeJudgement=rec.training.realtimeJudgement,playbackJudgement=aPrimeAnswer('aPrimePlayback');
    if(!A.validJudgement(realtimeJudgement)||!A.validJudgement(playbackJudgement))return;
    if(!H().updateTraining(rec.id,{realtimeJudgement,playbackJudgement}))return error('두 판단을 저장하지 못했습니다.');
    day.step='aPrimeResult';persist();render();
  }
  async function exportAPrime(format) {
    if(!enabled||!aPrime()||runtime.replay||runtime.preparing||V().state.measuring)return;
    const date=$('trainingExportDate').value;
    if(!C.validDate(date))return error('내보낼 날짜를 선택해 주세요.');
    const rows=A.sessionRows(H().readSessions(),date);
    if(!rows.length)return error('해당 날짜에 판단을 마친 A′ 시행이 없습니다.');
    try {
      const options={fallbackOnShareError:true};
      if(format==='csv')Object.assign(options,{content:A.buildCSV(rows),filename:`vocal-scope-a-prime-${date}.csv`,type:'text/csv;charset=utf-8'});
      else {
        const names=new Set();
        const files=rows.filter(row=>clips.has(row.id)).map(row=>{
          const original=A.wavName(row);let name=original,copy=2;
          while(names.has(name))name=`${original.slice(0,-4)}_${copy++}.wav`;
          names.add(name);
          return {name,bytes:A.encodeWav(clips.get(row.id))};
        });
        if(!files.length)return error('현재 페이지에 남아 있는 WAV 녹음이 없습니다.');
        Object.assign(options,{content:A.makeZip(files),filename:`vocal-scope-a-prime-wav-${date}.zip`,type:'application/zip'});
      }
      error();await window.VocalHistoryShare.shareOrDownloadFile(options);
    }catch(e){if(e?.name!=='AbortError')error('A′ 파일을 내보내지 못했습니다. 다시 시도해 주세요.');}
  }
  function renderAPrime(step) {
    const mode=enabled&&aPrime();
    const result=['aPrimeResult','retryResult'].includes(step);
    const panel=mode&&(result||['aPrimeListenReady','aPrimePlaybackJudgement'].includes(step));
    show('aPrimeJudgements',panel);
    show('aPrimePlaybackFields',panel&&(result||step==='aPrimePlaybackJudgement'));
    $('aPrimeLiveFields').disabled=result||!!runtime.replay||step==='aPrimePlaybackJudgement';
    $('aPrimePlaybackFields').disabled=result||!!runtime.replay;
    $('aPrimeLockStatus').textContent=result?'두 판단이 저장되어 잠겼습니다.':runtime.replay?'기준음 → 0.5초 쉼 → 내 녹음 재생 중…':'';
    if(panel){
      const rec=aPrimeInitial(),t=rec?.training;
      if(result)setAPrimeAnswers(t?.realtimeJudgement,t?.playbackJudgement);
      else if(step==='aPrimePlaybackJudgement')setAPrimeAnswer('aPrimeLive',t?.realtimeJudgement);
      show('aPrimeReplayBtn',result);
      $('aPrimeReplayBtn').disabled=!!runtime.replay||!clips.has(rec?.id);
      show('aPrimeCorrectionBtn',step==='aPrimeResult'&&needsCorrection());
      $('aPrimeCorrectionBtn').disabled=!!runtime.replay;
      $('aPrimePlayCount').textContent=`공개 전 ${t?.preRevealPlays??0}/1회 · 공개 후 ${t?.postRevealPlays??0}회${clips.has(rec?.id)?'':' · 녹음 없음'}`;
      const names=['에코 제거','잡음 제거','자동 증폭'];
      $('aPrimeMicStatus').textContent='브라우저 마이크 설정 · '+A.MIC_FIELDS.map((key,i)=>{
        const value=t?.micSettings?.[key];
        return `${names[i]}: ${value===false?'끔':value==null?'확인 불가':'켜짐'}`;
      }).join(' · ')+(t?.micSettings?.fallbackConstraints?' · 호환 입력':'');
    }
    show('aPrimeExports',mode);
    if(mode){
      const rows=A.sessionRows(H().readSessions(),$('trainingExportDate').value);
      const count=rows.filter(row=>clips.has(row.id)).length;
      const busy=!!runtime.replay||runtime.preparing||V().state.measuring;
      $('aPrimeCsvBtn').disabled=busy||!rows.length;
      $('aPrimeWavBtn').disabled=busy||!count;
      $('aPrimeArchiveStatus').textContent=`선택 날짜의 완료 기록 ${rows.length}회 · WAV ${count}개. WAV는 이 페이지를 닫거나 새로고침하면 사라집니다.`;
    }
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
    if(runtime.preparing||runtime.replay)return;
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
      case 'aPrimeListenReady':return listenAPrime(false);
      case 'aPrimePlaybackJudgement':return submitAPrimeAnswer();
      case 'aPrimeResult':return advance();
      case 'initialResult':return needsCorrection()?startCorrection():advance();
      case 'screenCorrection':return V().stopMeasurement('training-complete');
      case 'retryResult':return advance();
    }
  }
  function interrupt(){
    if(!enabled)return;
    const replay=runtime.replay;runtime.replay=null;
    runtime.token++;clearTimer();T().stop();
    if(replay&&!replay.postReveal&&replay.started)discardAPrimeTake(replay.record,'듣기가 중단되었습니다. 같은 시행을 다시 녹음해 주세요.');
    else if(replay)render();
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
    show('judgementFeedbackField',enabled&&!aPrime());show('trainingExportControls',enabled);show('judgementActionError',enabled);
    show('judgementOrderControls',enabled);show('judgementOrderHelp',active());
    show('judgementCorrectionRules',enabled);
    $('judgementCorrectionCount').textContent=`교정 ${correctionCount()}/${correctionRules.maximum}`;
    $('judgementCorrectionThreshold').disabled=active()&&day.step!=='referenceReady';
    $('judgementCorrectionMaximum').disabled=active()&&day.step!=='referenceReady';
    show('judgementLevelControls',enabled);updateLevelMeter();
    show('recordingSaveControl',!enabled);show('resetBtn',!enabled);
    const button=$('measureBtn'),r=round(),rec=current(),step=day?.step;
    $('judgementProtocol').disabled=runtime.preparing||!!runtime.replay||V().state.measuring||step==='referencePlaying';
    $('judgementSetupHint').textContent=aPrime()?'기준음 → 3초 발성 → 실시간 판단 → 한 번 듣기 → 재생 판단 → 결과 순서로 진행합니다.':'아래의 기존 녹음 버튼으로 기준음 → ② → 판단 → 교정 → 재시도를 진행합니다.';
    renderAPrime(step);
    if(!enabled){
      $('judgementBadge').textContent='일반 녹음';
      button.textContent=V().state.measuring?'측정 종료':'마이크로 측정 시작';button.disabled=runtime.preparing;
      $('judgementResult').textContent='';$('judgementCorrectionLive').textContent='';$('judgementCountdown').textContent='';
      return;
    }
    $('judgementBadge').textContent=!day?'설정':step==='done'?'완료':`${aPrime()?'A′ · ':''}${r.trial}/12`;
    if(r){$('judgementLabel').textContent=C.label(context(step==='retryReady'||step==='retryResult'||step==='retryInvalid'?'retry':step?.includes('Correction')?'correction':'initial'),r.targetMidi);$('judgementTarget').textContent=r.targetNote;$('judgementProgress').textContent=`블록 ${r.block} · ${C.BLOCK_LABELS[r.method]}`;}
    show('judgementAnswerForm',step==='judgement');show('judgementCorrectionLive',step==='screenCorrection');
    const aPrimeBlind=aPrime()&&['capturing','aPrimeListenReady','aPrimePlaybackJudgement'].includes(step);
    show('judgementLabel',!aPrimeBlind);show('judgementTarget',!aPrimeBlind);
    show('judgementPitchLock',active()&&step!=='screenCorrection'&&step!=='aPrimeResult');show('judgementResult',['initialResult','aPrimeResult','retryResult'].includes(step));
    $('judgementResult').textContent=step==='initialResult'?`오차 중앙값: ${cents(rec?.assessment.medianCents)}\n판단 ${rec?.training.autoScore?.correct?'정답':'오답'} (±25¢ 기준)`:step==='retryResult'?`재시도 오차 중앙값: ${cents(rec?.assessment.medianCents)}`:'';
    if(step==='aPrimeResult')$('judgementResult').textContent=`오차 중앙값: ${cents(rec?.assessment?.medianCents)}`;
    if(['initialResult','aPrimeResult','retryResult'].includes(step)&&Number.isFinite(rec?.levelDb))$('judgementResult').textContent+=`\n입력 크기: ${rec.levelDb.toFixed(1)} dBFS`;
    const texts={referenceReady:'기준음 듣기',referencePlaying:'기준음 재생 중',initialReady:'② 3초 부르기',capturing:'녹음 정지',judgement:'결과 보기',initialResult:needsCorrection()?'화면 교정 시작':'다음 회차',screenCorrection:'교정 녹음 정지',retryReady:'재시도 · 3초 녹음',retryResult:'다음 회차',initialInvalid:'다시 부르기',retryInvalid:'재시도 다시 녹음',done:'새 날짜·목표음으로 녹음 준비'};
    Object.assign(texts,{aPrimeListenReady:'재생',aPrimePlaybackJudgement:'재생 판단 저장 · 결과 공개',aPrimeResult:'다음 시행'});
    button.textContent=runtime.replay?'재생 중…':texts[step]||'기준음 듣기 · 녹음 준비';
    button.disabled=runtime.preparing||!!runtime.replay||step==='referencePlaying'||step==='judgement'&&!C.validJudgement(answer())||step==='screenCorrection'&&runtime.startedAt==null;
    if(step==='aPrimeListenReady')button.disabled||=!clips.has(rec?.id)||rec?.training.preRevealPlays!==0||!A.validJudgement(aPrimeAnswer('aPrimeLive'));
    if(step==='aPrimePlaybackJudgement')button.disabled||=!A.validJudgement(aPrimeAnswer('aPrimeLive'))||!A.validJudgement(aPrimeAnswer('aPrimePlayback'));
    if(step==='done'&&$('judgementDate').value===day.dayId){button.textContent='12회 녹음 완료';button.disabled=true;}
    const instructions={referenceReady:'기준음을 2초 듣고, 같은 녹음 버튼으로 ②를 시작하세요.',referencePlaying:'목표음을 듣습니다. 2초 후 자동으로 멈춥니다.',initialReady:'기준음 꺼짐. ②는 중간 음량으로 3초 유지하세요.',capturing:'음정과 그래프를 숨기고 녹음합니다.',judgement:'방향·크기·확신도를 입력해야 결과를 볼 수 있습니다.',initialInvalid:'유효한 0.5~2.5초 결과가 없습니다. 실패한 시도는 discarded로 저장했습니다.',retryInvalid:'유효한 결과가 없습니다. 실패한 재시도는 discarded로 저장했습니다.',screenCorrection:'기준음을 켠 채 화면을 보며 2초 맞춘 뒤 녹음을 정지하세요. 이 과정은 평가하지 않습니다.',retryReady:'기준음 꺼짐. 화면을 가리고 3초 재시도합니다. 판단은 입력하지 않습니다.',done:'12회 완료. 하루 JSON에 모든 단계와 실패한 시도를 포함합니다.'};
    if(aPrime())Object.assign(instructions,{
      initialInvalid:'이 시행의 평가를 완료하지 못했습니다. 같은 목표음을 다시 녹음하세요.',
      aPrimeListenReady:'부를 때 느낀 방향과 확신도를 선택하면 재생할 수 있습니다. 공개 전에는 한 번만 들을 수 있습니다.',
      aPrimePlaybackJudgement:'녹음을 듣고 느낀 방향과 확신도를 입력하세요. 저장하면 두 판단이 잠기고 오차가 공개됩니다.',
      aPrimeResult:'두 판단과 측정 결과를 비교하세요. 여기서 다시 듣거나 다음 시행으로 갈 수 있습니다.',
      done:'12회 완료. 페이지를 닫기 전에 WAV가 필요하면 내보내세요.',
    });
    $('judgementInstruction').textContent=instructions[step]||'';
    if(step!=='capturing')$('judgementCountdown').textContent='';if(step!=='screenCorrection')$('judgementCorrectionLive').textContent='';
  }
  function restore(){
    try{day=JSON.parse(localStorage.getItem(dayKey())||'null');}catch(_){day=null;}
    if(!day?.rounds?.length){day=null;return;}
    $('judgementDate').value=day.dayId;$('judgementTargets').value=day.rounds.map(r=>r.targetNote).join(' ');
    if(aPrime()){restoreAPrime();return;}
    $('judgementFeedback').value=String(day.feedbackLevel);
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
  function restoreAPrime(){
    const initial=aPrimeInitial();
    const complete=initial&&!A.isPending(initial);
    setAPrimeAnswers(initial?.training.realtimeJudgement,initial?.training.playbackJudgement);
    if(day.step==='referencePlaying')day.step='referenceReady';
    if(day.step==='capturing'||['aPrimeListenReady','aPrimePlaybackJudgement','aPrimeResult'].includes(day.step)){
      if(complete){
        day.step=day.step==='capturing'?'retryReady':'aPrimeResult';
        day.pendingId=initial.id;
      }else if(!initial||!clips.has(initial.id)||day.step==='capturing'){
        const abandoned=initial||H().readSessions().find(s=>A.isPending(s)&&s.training.dayId===day.dayId&&s.training.trial===day.cursor+1);
        discardAPrimeTake(abandoned,'페이지를 다시 열면 미완료 녹음은 복원되지 않습니다. 같은 시행을 다시 불러 주세요.');
      }
    }else if(day.step==='screenCorrection'){
      const correction=initial&&H().readSessions().find(s=>s.training?.initialSessionId===initial.id&&s.training.stage==='correction');
      if(correction){H().updateTraining(initial.id,{screenCorrectionUsed:true});day.step='retryReady';day.pendingId=correction.id;}
      else {day.step='aPrimeResult';day.pendingId=initial?.id??null;}
    }
    persist();
  }
  function init(){
    try{const saved=JSON.parse(localStorage.getItem(RULE_KEY)||'null');if(saved&&Number.isFinite(saved.threshold)&&saved.threshold>=0&&Number.isInteger(saved.maximum)&&saved.maximum>=0)correctionRules=saved;}catch(_){}
    $('judgementCorrectionThreshold').value=String(correctionRules.threshold);$('judgementCorrectionMaximum').value=String(correctionRules.maximum);
    ['judgementCorrectionThreshold','judgementCorrectionMaximum'].forEach(id=>$(id).addEventListener('change',saveCorrectionRules));
    const feedback=$('judgementFeedback').closest('label');feedback.classList.add('judgement-wide-field');$('judgementSetup').before(feedback);
    try{const saved=JSON.parse(localStorage.getItem(LEVEL_KEY)||'null');if(saved&&Number.isFinite(saved.toleranceDb)&&saved.toleranceDb>=0&&(saved.targetDb===null||Number.isFinite(saved.targetDb)&&saved.targetDb>=-160&&saved.targetDb<=0))levelSettings={targetDb:saved.targetDb,toleranceDb:saved.toleranceDb};}catch(_){}
    $('judgementLevelTarget').value=levelSettings.targetDb??'';$('judgementLevelTolerance').value=String(levelSettings.toleranceDb);
    try{if(localStorage.getItem(PROTOCOL_KEY)===A.PROTOCOL)protocol=A.PROTOCOL;}catch(_){}
    $('judgementProtocol').value=protocol;
    $('judgementDate').value=localDate();restore();
    try{const mode=JSON.parse(localStorage.getItem(MODE_KEY)||'null');enabled=mode?.enabled===true;normalTarget=Number.isFinite(mode?.normalTarget)?mode.normalTarget:null;}catch(_){enabled=false;}
    if(enabled){leaveOtherPractice();V().clearDisplayedPitch();}
    updateOrder();render();
    window.dispatchEvent(new CustomEvent('vs:training-mode-change',{detail:{enabled}}));
    $('trainingEnabledToggle').addEventListener('change',e=>setEnabled(e.target.checked));
    $('judgementDate').addEventListener('change',updateOrder);
    $('judgementProtocol').addEventListener('change',changeProtocol);
    for(const id of ['aPrimeLiveDirection','aPrimeLiveConfidence','aPrimePlaybackDirection','aPrimePlaybackConfidence'])$(id).addEventListener('change',render);
    $('aPrimeReplayBtn').addEventListener('click',()=>listenAPrime(true));
    $('aPrimeCorrectionBtn').addEventListener('click',()=>{if(aPrime()&&enabled&&!runtime.replay&&!runtime.preparing&&day?.step==='aPrimeResult'&&needsCorrection())startCorrection();});
    $('aPrimeCsvBtn').addEventListener('click',()=>exportAPrime('csv'));
    $('aPrimeWavBtn').addEventListener('click',()=>exportAPrime('wav'));
    $('trainingExportDate').addEventListener('change',render);
    ['judgementLevelTarget','judgementLevelTolerance'].forEach(id=>$(id).addEventListener('change',saveLevelSettings));
    $('judgementSetup').addEventListener('submit',e=>{e.preventDefault();handleButton();});
    $('judgementAnswerForm').addEventListener('submit',e=>{e.preventDefault();if(C.validJudgement(answer()))submitAnswer();});
    ['judgementDirection','judgementSize','judgementConfidence'].forEach(id=>$(id).addEventListener('change',updateAnswer));
    $('judgementFeedback').addEventListener('change',()=>{if(day&&!aPrime()){day.feedbackLevel=Number($('judgementFeedback').value);persist();}});
    $('trainingExportBtn').addEventListener('click',()=>window.VocalHistoryShare.exportTrainingDay($('trainingExportDate').value));
    window.addEventListener('vs:pitch',e=>{if(!runtime.context)return;if(runtime.onset==null){runtime.onset=e.detail.now;runtime.take?.markOnset();}if(day.step==='screenCorrection')$('judgementCorrectionLive').textContent=`교정 실시간: ${cents((e.detail.midi-round().targetMidi)*100)} · 평가 제외`;});
    window.addEventListener('vs:input-level',e=>{liveLevelDb=e.detail.db;updateLevelMeter();});
    window.addEventListener('vs:history-saved',onSaved);window.addEventListener('vs:measurement-stop',onStop);
    window.addEventListener('vs:visibility',e=>{if(e.detail.hidden)interrupt();});window.addEventListener('pagehide',interrupt);
    window.addEventListener('vs:history-session-deleted',e=>{clips.delete(e.detail?.id);render();});
    window.addEventListener('vs:history-cleared',()=>{interrupt();clips.clear();day=null;localStorage.removeItem(KEY);localStorage.removeItem(APRIME_KEY);render();});
  }
  window.VocalJudgementPractice={handleButton,isEnabled:()=>enabled,isActive:active,isPitchHidden:pitchHidden,getSessionContext:()=>enabled&&runtime.context?{...runtime.context}:null};
  document.addEventListener('DOMContentLoaded',init);
})();
