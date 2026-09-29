'use strict';

(() => {
  const STORAGE_KEY='vocalScopePracticeHistoryV1';
  const DRAFT_KEY='vocalScopePracticeDraftV3';
  const MAX_SESSIONS=80;
  const CAPTURE_INTERVAL_MS=80;
  const PHRASE_GAP_MS=360;
  let live=null;
  let selectedSessionId=null;
  let draftTimer=null;

  const P=()=>window.VocalPracticeCore;
  const V=()=>window.VocalScope;
  function note(m){return V()?.noteFromMidi?.(m)||{name:'—',korean:'—'};}
  function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));}
  function readSessions(){try{const p=JSON.parse(localStorage.getItem(STORAGE_KEY)||'[]');return Array.isArray(p)?p:[];}catch(_){return[];}}
  function writeSessions(items){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(items.slice(0,MAX_SESSIONS)));return true;}catch(e){console.warn('history storage',e);return false;}}
  function signed(v,suffix=' cent'){if(!Number.isFinite(v))return'—';const n=Math.round(v);return`${n>0?'+':''}${n}${suffix}`;}
  function signedShort(v,suffix='c'){if(!Number.isFinite(v))return'—';const n=Math.round(v);return`${n>0?'+':''}${n}${suffix}`;}
  function duration(ms){if(!Number.isFinite(ms))return'0초';if(ms<1000)return`${Math.max(0,Math.round(ms))}ms`;if(ms<60000)return`${(ms/1000).toFixed(ms<10000?1:0)}초`;return`${Math.floor(ms/60000)}분 ${Math.round((ms%60000)/1000)}초`;}
  function dateLabel(ts){const d=new Date(ts),today=new Date();const date=d.toDateString()===today.toDateString()?'오늘':`${d.getMonth()+1}/${d.getDate()}`;return`${date} ${d.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',hour12:false})}`;}
  function fullDate(ts){return new Date(ts).toLocaleString('ko-KR',{year:'numeric',month:'long',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false});}
  function describe(s){if(s?.plan?.type==='phrase')return s.plan.label||'가사 구절';if(s?.plan?.type==='interval'){const a=note(s.plan.pattern?.[0]),b=note(s.plan.pattern?.[1]);return`${a.name} ↔ ${b.name}`;}if(Number.isFinite(s?.targetMidi)){const n=note(s.targetMidi);return`${n.name} · ${n.korean}`;}return'자유 측정';}
  function getTechnique(s){if(s?.technique?.analysisVersion===3&&Array.isArray(s.technique.utterances))return s.technique;return P().analyzeTechnique(s?.points||[],{targetMidi:s?.targetMidi,plan:s?.plan,gapMs:PHRASE_GAP_MS,captureIntervalMs:CAPTURE_INTERVAL_MS});}
  function getIntervals(s,tech=getTechnique(s)){return P().analyzeIntervals(tech,s?.plan||null);}
  function intervalScore(s){const ints=getIntervals(s);if(!ints.length)return null;return P().median(ints.map(x=>Math.abs(x.errorCents)));}

  function beginSession(detail={}){const plan=window.VocalPhrasePractice?.getPlanSnapshot?.()||window.VocalTrainer?.getPlanSnapshot?.()||null;live={id:`${Date.now()}-${Math.random().toString(36).slice(2,7)}`,startedAt:detail.startedAt||Date.now(),startedPerf:Number.isFinite(detail.startedPerf)?detail.startedPerf:performance.now(),targetMidi:plan?null:(Number.isFinite(detail.targetMidi)?detail.targetMidi:V()?.state?.targetMidi??null),plan,points:[],lastCapturePerf:-Infinity,updatedAt:Date.now()};saveDraft();updatePill();}
  function capture(detail){if(!live||!Number.isFinite(detail?.midi))return;const now=Number.isFinite(detail.now)?detail.now:performance.now();if(now-live.lastCapturePerf<CAPTURE_INTERVAL_MS)return;live.lastCapturePerf=now;live.points.push({t:Math.max(0,Math.round(now-live.startedPerf)),m:Math.round(detail.midi*1000)/1000});live.updatedAt=Date.now();if(live.points.length===1)updatePill('짧은 발성도 저장 중');}
  function buildRecord(src,{recovered=false}={}){const points=P().normalizePoints(src?.points||[]);if(!points.length)return null;const metrics=P().sessionMetrics(points,src.targetMidi);if(!metrics)return null;const tech=P().analyzeTechnique(points,{targetMidi:src.targetMidi,plan:src.plan,gapMs:PHRASE_GAP_MS,captureIntervalMs:CAPTURE_INTERVAL_MS});return{id:src.id||`${src.startedAt}-${Math.random().toString(36).slice(2,7)}`,createdAt:src.startedAt||Date.now(),durationMs:Math.max(metrics.voicedMs,Date.now()-(src.startedAt||Date.now())),voicedMs:metrics.voicedMs,targetMidi:Number.isFinite(src.targetMidi)?src.targetMidi:null,plan:src.plan||null,accuracy:metrics.accuracy,avgAbsCents:metrics.avgAbsCents,biasCents:metrics.biasCents,medianCents:metrics.medianCents,longestInTuneMs:metrics.longestInTuneMs,minMidi:metrics.minMidi,maxMidi:metrics.maxMidi,sampleCount:metrics.sampleCount,technique:tech,points:points.map(p=>[p.t,p.m]),recovered:!!recovered,analysisVersion:3};}
  function saveLive({silent=false}={}){if(!live)return null;const record=buildRecord(live);live=null;clearDraft();updatePill();if(!record)return null;const sessions=readSessions().filter(s=>s.id!==record.id);sessions.unshift(record);writeSessions(sessions);renderHistory();if(!silent)toast(record.sampleCount<=4?'짧은 발성도 저장했습니다':'연습 기록을 저장했습니다');return record;}
  function discardLive(){live=null;clearDraft();updatePill();}
  function saveDraft(){if(!live?.points?.length)return;try{localStorage.setItem(DRAFT_KEY,JSON.stringify({...live,updatedAt:Date.now()}));}catch(_){} }
  function clearDraft(){try{localStorage.removeItem(DRAFT_KEY);}catch(_){} }
  function recoverDraft(){try{const d=JSON.parse(localStorage.getItem(DRAFT_KEY)||'null');if(!d?.points?.length)return;const age=Date.now()-Number(d.updatedAt||d.startedAt||0);if(age<0||age>12*60*60*1000){clearDraft();return;}const sessions=readSessions();if(sessions.some(s=>s.id===d.id)){clearDraft();return;}const r=buildRecord(d,{recovered:true});if(r){sessions.unshift(r);writeSessions(sessions);clearDraft();toast('중단된 측정 기록을 복구했습니다');}}catch(_){clearDraft();}}
  function toast(text){const t=document.getElementById('saveToast');if(!t)return;t.textContent=text;t.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>t.classList.remove('show'),2200);}
  function updatePill(custom){const el=document.getElementById('historyLiveStatus');if(!el)return;el.textContent=custom||(live?'이번 연습 기록 중':'자동 저장');el.classList.toggle('live',!!live);}

  function recentSummary(sessions){const recent=sessions.slice(0,5);const target=recent.filter(s=>Number.isFinite(s.targetMidi)).map(s=>getTechnique(s)).filter(Boolean);const interval=recent.filter(s=>s.plan?.type==='interval').map(s=>intervalScore(s)).filter(Number.isFinite);if(interval.length)return`<strong>최근 간격 오차 ${Math.round(P().median(interval))}c</strong><span>최근 ${recent.length}회 · 기록 ${sessions.length}개</span>`;if(target.length){const la=P().median(target.map(t=>Math.abs(t.landingCents)).filter(Number.isFinite)),su=P().median(target.map(t=>Math.abs(t.sustainCents)).filter(Number.isFinite)),dr=P().median(target.map(t=>t.driftCentsPerSec).filter(Number.isFinite));return`<strong>최근 착지 ${Number.isFinite(la)?Math.round(la)+'c':'—'} · 유지 ${Number.isFinite(su)?Math.round(su)+'c':'—'}</strong><span>드리프트 ${Number.isFinite(dr)?signedShort(dr,'c/s'):'—'} · 기록 ${sessions.length}개</span>`;}return`<strong>최근 기록 ${recent.length}회</strong><span>짧은 발성 포함 · 전체 ${sessions.length}개</span>`;}
  function renderHistory(){const list=document.getElementById('recentHistoryList'),empty=document.getElementById('historyEmpty'),summary=document.getElementById('historySummary');if(!list||!empty||!summary)return;const sessions=readSessions();list.innerHTML='';empty.classList.toggle('hidden',sessions.length>0);if(!sessions.length){summary.innerHTML='<strong>아직 기록 없음</strong><span>신뢰 가능한 음정이 한 번이라도 잡히면 저장됩니다.</span>';return;}summary.innerHTML=recentSummary(sessions);sessions.slice(0,3).forEach(s=>{const tech=getTechnique(s),ints=getIntervals(s,tech),row=document.createElement('button');row.type='button';row.className='history-row';let score,detail;if(s.plan?.type==='interval'){const sc=intervalScore(s);score=Number.isFinite(sc)?`간격 ${Math.round(sc)}c`:'간격 분석';detail=`발성 ${tech?.utteranceCount||0}회 · 이동 ${ints.length}개`;}else if(Number.isFinite(s.targetMidi)){score=`${Math.round(s.accuracy||0)}% 정확`;detail=`착지 ${signedShort(tech?.landingCents)} · 유지 ${signedShort(tech?.sustainCents)}`;}else{score=`${note(s.minMidi).name}–${note(s.maxMidi).name}`;detail=s.plan?.type==='phrase'?`가사 구절 · ${duration(s.voicedMs)} 유효`:`발성 ${tech?.utteranceCount||0}회 · ${duration(s.voicedMs)} 유효`;}row.innerHTML=`<span class="history-row-main"><strong>${escapeHtml(describe(s))}</strong><small>${dateLabel(s.createdAt)}${s.recovered?' · 복구됨':''}</small></span><span class="history-row-score"><strong>${score}</strong><small>${detail}</small></span><span class="history-chevron">›</span>`;row.addEventListener('click',()=>openSession(s.id));list.appendChild(row);});}
  function renderAll(){const host=document.getElementById('allHistoryList');if(!host)return;const sessions=readSessions();host.innerHTML='';if(!sessions.length){host.innerHTML='<p class="history-empty">저장된 연습 기록이 없습니다.</p>';return;}sessions.forEach(s=>{const b=document.createElement('button');b.type='button';b.className='all-history-row';const tech=getTechnique(s),sc=intervalScore(s);const metric=s.plan?.type==='interval'?(Number.isFinite(sc)?`간격 오차 ${Math.round(sc)}c`:'간격 분석'):(Number.isFinite(s.targetMidi)?`${Math.round(s.accuracy||0)}% 정확`:`${duration(s.voicedMs)} 유효`);const detail=s.plan?.type==='phrase'?`${s.sampleCount||0}개 음정 표본`:`발성 ${tech?.utteranceCount||0}회 · ${s.sampleCount||0}점`;b.innerHTML=`<span><strong>${escapeHtml(describe(s))}</strong><small>${fullDate(s.createdAt)}</small></span><span><strong>${metric}</strong><small>${detail}</small></span>`;b.addEventListener('click',()=>{document.getElementById('historyDialog').close();openSession(s.id);});host.appendChild(b);});}

  function ensureIntervalPanel(){if(document.getElementById('sessionIntervalPanel'))return;const u=document.querySelector('#sessionDialog .utterance-panel');if(!u)return;const p=document.createElement('div');p.id='sessionIntervalPanel';p.className='interval-panel';p.innerHTML='<div class="interval-panel-title"><span>발성 간 간격 분석</span><small>발성 중앙값 기준</small></div><div id="sessionIntervalList" class="interval-list"></div>';u.insertAdjacentElement('afterend',p);}
  function ensurePhrasePanel(){if(document.getElementById('sessionPhrasePanel'))return;const title=document.querySelector('#sessionDialog .technique-title-row');if(!title)return;const panel=document.createElement('div');panel.id='sessionPhrasePanel';panel.className='phrase-session-panel hidden';const name=document.createElement('strong');name.id='sessionPhraseName';const lyrics=document.createElement('p');lyrics.id='sessionPhraseLyrics';panel.append(name,lyrics);title.insertAdjacentElement('beforebegin',panel);}
  function injectStyles(){if(document.getElementById('historyV3Styles'))return;const s=document.createElement('style');s.id='historyV3Styles';s.textContent=`.utterance-row-v3{grid-template-columns:48px 58px repeat(3,minmax(0,1fr));}.utterance-note strong{font-size:13px!important;color:#e8efff}.interval-panel{margin-top:10px;border:1px solid rgba(124,156,255,.16);border-radius:16px;padding:11px;background:rgba(124,156,255,.035)}.interval-panel-title{display:flex;justify-content:space-between;gap:8px;margin-bottom:7px;color:#dce6fb;font-size:11px;font-weight:750}.interval-panel-title small{color:var(--muted);font-size:9px;font-weight:500}.interval-list{display:grid;gap:7px}.interval-row{border-top:1px solid rgba(255,255,255,.06);padding-top:8px}.interval-row:first-child{border-top:0;padding-top:0}.interval-route{display:flex;justify-content:space-between;gap:8px}.interval-route strong{font-size:12px}.interval-route small{color:var(--muted);font-size:9px}.interval-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:7px}.interval-metrics span{border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:7px;background:rgba(255,255,255,.02)}.interval-metrics small{display:block;color:var(--muted);font-size:8px}.interval-metrics strong{display:block;font-size:11px;margin-top:3px}.interval-error strong{color:var(--accent2)}@media(max-width:420px){.utterance-row-v3{grid-template-columns:42px 52px repeat(3,minmax(0,1fr));gap:4px}.utterance-row-v3 small{font-size:7px}.utterance-row-v3 strong{font-size:10px}.interval-metrics{grid-template-columns:1fr}.interval-metrics span{display:flex;justify-content:space-between;align-items:center}}`;document.head.appendChild(s);}
  function renderUtterances(s,tech){const host=document.getElementById('sessionUtteranceList'),count=document.getElementById('sessionTechniqueCount');if(!host||!count)return;host.innerHTML='';if(!tech?.utterances?.length){count.textContent='분석 가능한 발성 없음';host.innerHTML='<p class="utterance-empty">신뢰 가능한 음정이 잡히면 짧은 발성도 이곳에 표시됩니다.</p>';return;}count.textContent=`발성 ${tech.utteranceCount}회`;tech.utterances.forEach(u=>{const actual=note(u.centerMidi),expected=Number.isFinite(u.expectedMidi)?note(u.expectedMidi):null,row=document.createElement('div');row.className='utterance-row utterance-row-v3';row.innerHTML=`<span class="utterance-index">${u.index}회</span><span class="utterance-note"><strong>${expected?`${expected.name}→${actual.name}`:actual.name}</strong><small>중앙값 ${expected?signedShort(u.referenceOffsetCents):signedShort(u.centerOffsetCents)}</small></span><span><small>초기 착지</small><strong>${signedShort(u.landingCents)}</strong></span><span><small>유지</small><strong>${signedShort(u.sustainCents)}</strong></span><span><small>드리프트</small><strong>${signedShort(u.driftCentsPerSec,'c/s')}</strong></span>`;host.appendChild(row);});}
  function renderIntervals(s,tech){ensureIntervalPanel();const host=document.getElementById('sessionIntervalList');if(!host)return;const ints=getIntervals(s,tech);host.innerHTML='';if(!ints.length){host.innerHTML='<p class="utterance-empty">발성을 두 번 이상 나누어 내면 이동량이 표시됩니다.</p>';return;}ints.forEach((x,i)=>{const a=tech.utterances[i],b=tech.utterances[i+1],row=document.createElement('div');row.className='interval-row';const from=Number.isFinite(a.expectedMidi)?note(a.expectedMidi).name:note(a.centerMidi).name,to=Number.isFinite(b.expectedMidi)?note(b.expectedMidi).name:note(b.centerMidi).name;row.innerHTML=`<div class="interval-route"><strong>${from} → ${to}</strong><small>발성 ${x.fromIndex} → ${x.toIndex}</small></div><div class="interval-metrics"><span><small>실제 이동량</small><strong>${signed(x.actualCents)}</strong></span><span><small>목표 이동량</small><strong>${signed(x.targetCents)}</strong></span><span class="interval-error"><small>간격 오차</small><strong>${signed(x.errorCents)}</strong></span></div>`;host.appendChild(row);});}
  function coachText(s,tech,ints){if(s?.plan?.type==='phrase')return'이 기록은 정답 멜로디와 비교하지 않고 실제 음정 흐름을 저장합니다. 같은 구절을 반복한 뒤 시작음, 음 전환 위치, 끝음과 전체 음역을 그래프에서 비교하세요.';const c=P().classify(tech,ints);const extra=[];if(s.sampleCount<=4)extra.push('짧은 발성이라 세부 지표 일부는 표시되지 않을 수 있지만, 중앙 음정과 간격 분석에는 사용됩니다.');if(s.plan?.type==='interval'&&ints.length){const up=ints.filter(x=>x.targetCents>0),down=ints.filter(x=>x.targetCents<0);if(up.length&&down.length){const ue=P().median(up.map(x=>Math.abs(x.errorCents))),de=P().median(down.map(x=>Math.abs(x.errorCents)));if(Number.isFinite(ue)&&Number.isFinite(de)&&Math.abs(ue-de)>=12)extra.push(`${ue>de?'상행':'하행'} 간격에서 오차가 더 큽니다.`);}}return[c.text,...extra].join(' ');}
  function configureSessionMode(s){
    ensurePhrasePanel();
    const isPhrase=s?.plan?.type==='phrase';
    document.getElementById('sessionPhrasePanel')?.classList.toggle('hidden',!isPhrase);
    document.querySelector('#sessionDialog .technique-title-row')?.classList.toggle('hidden',isPhrase);
    document.querySelector('#sessionDialog .technique-grid')?.classList.toggle('hidden',isPhrase);
    document.getElementById('sessionTechniqueHint')?.classList.toggle('hidden',isPhrase);
    document.querySelector('#sessionDialog .utterance-panel')?.classList.toggle('hidden',isPhrase);
    document.getElementById('sessionIntervalPanel')?.classList.toggle('hidden',isPhrase);
    if(isPhrase){
      document.getElementById('sessionPhraseName').textContent=s.plan.label||'가사 구절';
      document.getElementById('sessionPhraseLyrics').textContent=s.plan.lyrics||'가사 정보 없음';
      document.querySelector('#sessionDialog .session-main-score span').textContent='기록된 음정 표본';
      document.getElementById('sessionAccuracy').textContent=`${s.sampleCount||0}개`;
      document.getElementById('sessionErrorLabel').textContent='반음 중심 평균 거리 · 참고';
      document.getElementById('sessionBiasLabel').textContent='반음 중심 평균 치우침';
      document.getElementById('sessionLongestLabel').textContent='첫 음 기준';
      document.getElementById('sessionLongest').textContent=Number.isFinite(s.plan.startMidi)?note(s.plan.startMidi).name:'미설정';
      document.getElementById('historyGraphNote').textContent='청록색은 실제로 부른 음정 흐름입니다. 정답 멜로디는 판정하지 않으며, 첫 음을 설정한 경우 그래프 시작 부분에 파란 점선으로 표시됩니다.';
    }else{
      document.getElementById('sessionErrorLabel').textContent='전체 평균 절대 오차 · 참고';
      document.getElementById('sessionBiasLabel').textContent='전체 평균 치우침';
      document.getElementById('sessionLongestLabel').textContent='최장 정확 유지';
      document.getElementById('historyGraphNote').textContent='청록색 = 실제 음정 · 파란 점선 = 목표음 · 옅은 파랑 = 초기 착지 창 · 옅은 청록 = 유지 구간 창. 각 창은 발성이 다시 시작될 때마다 새로 계산됩니다.';
    }
    document.getElementById('sessionVoicedLabel').textContent='유효 음성 시간';
    document.getElementById('sessionRangeLabel').textContent='측정 음역';
  }
  function openSession(id){
    const s=readSessions().find(x=>x.id===id);
    if(!s)return;
    selectedSessionId=id;
    const tech=getTechnique(s),ints=getIntervals(s,tech),isPhrase=s.plan?.type==='phrase';
    configureSessionMode(s);
    document.getElementById('sessionTitle').textContent=describe(s);
    document.getElementById('sessionDate').textContent=fullDate(s.createdAt);
    document.getElementById('sessionLanding').textContent=tech?signed(tech.landingCents):'—';
    document.getElementById('sessionSustain').textContent=tech?signed(tech.sustainCents):'—';
    document.getElementById('sessionDrift').textContent=tech?signed(tech.driftCentsPerSec,' cent/s'):'—';
    document.getElementById('sessionTechniqueHint').textContent=P().classify(tech,ints).text;
    if(!isPhrase){
      document.getElementById('sessionAccuracy').textContent=s.plan?.type==='interval'?(Number.isFinite(intervalScore(s))?`${Math.round(intervalScore(s))} cent`:'—'):`${Math.round(s.accuracy||0)}%`;
      document.querySelector('#sessionDialog .session-main-score span').textContent=s.plan?.type==='interval'?'간격 오차 중앙값':'±15 cent 전체 정확률';
      document.getElementById('sessionLongest').textContent=duration(s.longestInTuneMs);
    }
    document.getElementById('sessionError').textContent=`${Math.round(s.avgAbsCents||0)} cent`;
    document.getElementById('sessionBias').textContent=signed(s.biasCents);
    document.getElementById('sessionVoiced').textContent=duration(s.voicedMs);
    document.getElementById('sessionRange').textContent=`${note(s.minMidi).name} – ${note(s.maxMidi).name}`;
    document.getElementById('sessionCoach').textContent=coachText(s,tech,ints);
    renderUtterances(s,tech);
    renderIntervals(s,tech);
    const retry=document.getElementById('retryTargetBtn');
    retry.classList.remove('hidden');
    if(isPhrase){
      retry.textContent='이 가사 구절 다시 연습';
      retry.onclick=()=>{window.VocalPhrasePractice?.startFromPlan?.(s.plan);document.getElementById('sessionDialog').close();};
    }else if(s.plan?.type==='interval'){
      retry.textContent='이 간격으로 다시 훈련';
      retry.onclick=()=>{V().setTarget(s.plan.baseMidi);window.VocalTrainer?.start?.(s.plan.delta);document.getElementById('sessionDialog').close();window.scrollTo({top:0,behavior:'smooth'});};
    }else if(Number.isFinite(s.targetMidi)){
      retry.textContent='이 목표음으로 다시 연습';
      retry.onclick=()=>{V().setTarget(s.targetMidi);document.getElementById('sessionDialog').close();window.scrollTo({top:0,behavior:'smooth'});};
    }else retry.classList.add('hidden');
    document.getElementById('deleteSessionBtn').onclick=()=>deleteSession(id);
    document.getElementById('sessionDialog').showModal();
    requestAnimationFrame(()=>drawGraph(s));
  }
  function deleteSession(id){writeSessions(readSessions().filter(s=>s.id!==id));selectedSessionId=null;document.getElementById('sessionDialog').close();renderHistory();renderAll();}
  function drawGraph(s){
    const canvas=document.getElementById('historyCanvas');
    if(!canvas||!s?.points?.length)return;
    const pts=P().normalizePoints(s.points),rect=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,3);
    canvas.width=Math.max(1,Math.round(rect.width*dpr));
    canvas.height=Math.max(1,Math.round(rect.height*dpr));
    const ctx=canvas.getContext('2d'),W=rect.width,H=rect.height;
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,H);ctx.fillStyle='#0a1120';ctx.fillRect(0,0,W,H);
    const mids=pts.map(p=>p.m),phraseStart=s.plan?.type==='phrase'&&Number.isFinite(s.plan.startMidi)?s.plan.startMidi:null;
    const center=Number.isFinite(s.targetMidi)?s.targetMidi:(Number.isFinite(phraseStart)?phraseStart:P().median(mids));
    const rangeMids=Number.isFinite(phraseStart)?[...mids,phraseStart]:mids;
    const low=Math.floor(Math.min(center-3,Math.min(...rangeMids)-1)),high=Math.ceil(Math.max(center+3,Math.max(...rangeMids)+1));
    const span=Math.max(6,high-low),left=36,right=W-8,top=18,bottom=H-20,dur=Math.max(1,pts[pts.length-1].t);
    const x=t=>left+(t/dur)*(right-left),y=m=>top+(high-m)/span*(bottom-top);
    ctx.font='10px -apple-system,BlinkMacSystemFont,sans-serif';ctx.textAlign='right';ctx.textBaseline='middle';
    for(let m=low;m<=high;m++){const yy=y(m);ctx.strokeStyle='rgba(255,255,255,.065)';ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(right,yy);ctx.stroke();ctx.fillStyle='rgba(180,193,220,.58)';ctx.fillText(note(m).name,left-6,yy);}
    if(Number.isFinite(s.targetMidi)){const yy=y(s.targetMidi);ctx.save();ctx.setLineDash([6,5]);ctx.strokeStyle='rgba(124,156,255,.95)';ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(right,yy);ctx.stroke();ctx.restore();}
    if(Number.isFinite(phraseStart)){const yy=y(phraseStart);ctx.save();ctx.setLineDash([6,5]);ctx.strokeStyle='rgba(124,156,255,.95)';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(x(Math.min(dur,1200)),yy);ctx.stroke();ctx.restore();ctx.fillStyle='rgba(174,191,255,.82)';ctx.font='9px -apple-system,BlinkMacSystemFont,sans-serif';ctx.textAlign='left';ctx.textBaseline='bottom';ctx.fillText(`첫 음 ${note(phraseStart).name}`,left+3,yy-4);}
    const segs=P().segmentPhrases(pts,PHRASE_GAP_MS),isPhrase=s.plan?.type==='phrase';
    segs.forEach((seg,i)=>{
      const t0=seg[0].t,t1=seg[seg.length-1].t,expected=s.plan?.pattern?.length?Number(s.plan.pattern[i%s.plan.pattern.length]):null;
      if(Number.isFinite(expected)){const yy=y(expected);ctx.save();ctx.setLineDash([5,4]);ctx.strokeStyle='rgba(124,156,255,.8)';ctx.beginPath();ctx.moveTo(x(t0),yy);ctx.lineTo(x(t1),yy);ctx.stroke();ctx.restore();}
      if(!isPhrase){
        const lx1=x(Math.min(t1,t0+200)),lx2=x(Math.min(t1,t0+500));
        if(lx2>lx1){ctx.fillStyle='rgba(124,156,255,.07)';ctx.fillRect(lx1,top,lx2-lx1,bottom-top);}
        const sx1=x(Math.min(t1,t0+500)),sx2=x(Math.min(t1,t0+1500));
        if(sx2>sx1){ctx.fillStyle='rgba(101,225,194,.045)';ctx.fillRect(sx1,top,sx2-sx1,bottom-top);}
        ctx.fillStyle='rgba(202,214,239,.72)';ctx.font='9px -apple-system,BlinkMacSystemFont,sans-serif';ctx.textAlign='left';ctx.textBaseline='top';ctx.fillText(`발성 ${i+1}`,Math.min(right-34,x(t0)+2),3);
      }
      ctx.strokeStyle='#68e0c3';ctx.lineWidth=2;ctx.beginPath();seg.forEach((p,j)=>{j?ctx.lineTo(x(p.t),y(p.m)):ctx.moveTo(x(p.t),y(p.m));});ctx.stroke();
    });
    ctx.textAlign='left';ctx.textBaseline='top';ctx.fillStyle='rgba(154,167,195,.62)';ctx.fillText('시작',left,bottom+5);ctx.textAlign='right';ctx.fillText(duration(dur),right,bottom+5);
  }
  function clearAll(){if(!confirm('저장된 연습 기록을 모두 삭제할까요?'))return;localStorage.removeItem(STORAGE_KEY);renderHistory();renderAll();}

  function onTargetChange(e){if(!live||!V()?.state?.measuring)return;const d=e.detail||{};if(d.transient&&window.VocalTrainer?.isActive?.()){saveLive({silent:true});beginSession({startedAt:Date.now(),startedPerf:performance.now(),targetMidi:null});return;}if(!d.transient){saveLive({silent:true});beginSession({startedAt:Date.now(),startedPerf:performance.now(),targetMidi:d.targetMidi});}}
  window.addEventListener('vs:measurement-start',e=>beginSession(e.detail));
  window.addEventListener('vs:pitch',e=>capture(e.detail));
  window.addEventListener('vs:measurement-stop',()=>saveLive());
  window.addEventListener('vs:force-save',()=>saveDraft());
  window.addEventListener('vs:target-change',onTargetChange);
  window.addEventListener('vs:reset',()=>{if(V()?.state?.measuring){discardLive();beginSession({startedAt:Date.now(),startedPerf:performance.now(),targetMidi:V().state.targetMidi});}else discardLive();});

  document.addEventListener('DOMContentLoaded',()=>{injectStyles();ensureIntervalPanel();ensurePhrasePanel();recoverDraft();renderHistory();updatePill();document.getElementById('historyAllBtn')?.addEventListener('click',()=>{renderAll();document.getElementById('historyDialog').showModal();});document.getElementById('clearAllHistoryBtn')?.addEventListener('click',clearAll);window.addEventListener('resize',()=>{if(document.getElementById('sessionDialog')?.open&&selectedSessionId){const s=readSessions().find(x=>x.id===selectedSessionId);if(s)drawGraph(s);}});draftTimer=setInterval(()=>{if(live?.points?.length)saveDraft();},1500);});
  window.addEventListener('pagehide',()=>{if(live?.points?.length)saveDraft();});
  window.VocalHistory={readSessions,saveLive,getTechnique,getIntervals,openSession};
})();
