'use strict';

(() => {
  const STORAGE_KEY = 'vocalScopePracticeHistoryV1';
  const MAX_SESSIONS = 30;
  const MAX_GRAPH_POINTS = 900;
  const CAPTURE_INTERVAL_MS = 90;
  const PHRASE_GAP_MS = 360;
  const LANDING_START_MS = 200;
  const LANDING_END_MS = 500;
  const SUSTAIN_START_MS = 500;
  const SUSTAIN_END_MS = 1500;
  const DRIFT_START_MS = 200;
  const DRIFT_MAX_END_MS = 4000;
  const MIN_PHRASE_MS = 650;
  let live = null;
  let selectedSessionId = null;

  function nowDateLabel(ts) {
    const d = new Date(ts), today = new Date();
    const date = d.toDateString() === today.toDateString() ? '오늘' : `${d.getMonth()+1}/${d.getDate()}`;
    const time = d.toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit', hour12:false });
    return `${date} ${time}`;
  }
  function fullDateLabel(ts) {
    return new Date(ts).toLocaleString('ko-KR', { year:'numeric', month:'long', day:'numeric', weekday:'short', hour:'2-digit', minute:'2-digit', hour12:false });
  }
  function readSessions() {
    try { const p = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); return Array.isArray(p) ? p : []; }
    catch (_) { return []; }
  }
  function writeSessions(items) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_SESSIONS))); return true; }
    catch (e) { console.warn('practice history storage', e); return false; }
  }
  function avg(v) { return v.length ? v.reduce((a,b)=>a+b,0)/v.length : 0; }
  function medianValue(v) {
    const nums = v.filter(Number.isFinite);
    if (!nums.length) return null;
    const a=[...nums].sort((x,y)=>x-y), m=Math.floor(a.length/2);
    return a.length%2 ? a[m] : (a[m-1]+a[m])/2;
  }
  function formatDuration(ms) {
    if (!Number.isFinite(ms)) return '0초';
    if (ms < 60000) return `${(ms/1000).toFixed(ms < 10000 ? 1 : 0)}초`;
    return `${Math.floor(ms/60000)}분 ${Math.round((ms%60000)/1000)}초`;
  }
  function signedCent(v) {
    if (!Number.isFinite(v)) return '—';
    const n=Math.round(v); return `${n>0?'+':''}${n} cent`;
  }
  function signedCentShort(v) {
    if (!Number.isFinite(v)) return '—';
    const n=Math.round(v); return `${n>0?'+':''}${n}c`;
  }
  function signedDrift(v) {
    if (!Number.isFinite(v)) return '—';
    const n=Math.round(v); return `${n>0?'+':''}${n} cent/s`;
  }
  function signedDriftShort(v) {
    if (!Number.isFinite(v)) return '—';
    const n=Math.round(v); return `${n>0?'+':''}${n}c/s`;
  }
  function describeTarget(s) {
    if (Number.isFinite(s.targetMidi)) { const n=noteFromMidi(s.targetMidi); return `${n.name} · ${n.korean}`; }
    return '자유 측정';
  }
  function freeDeviation(m) { return (m-Math.round(m))*100; }

  function beginSession() {
    live={startedAt:Date.now(), startedPerf:performance.now(), targetMidi:state.targetMidi, points:[], lastCapturePerf:0, lastReliablePerf:null, voicedMs:0};
    updateRecordingPill();
  }
  function captureReliablePitch(result) {
    if (!live || !state.measuring || !state.lastGood) return;
    const perf=performance.now(), db=Number(result?.db), conf=Number(result?.confidence), freq=Number(result?.frequency);
    if (!Number.isFinite(freq) || conf<0.58 || !Number.isFinite(db) || db<state.gateDb || perf-state.lastGood.now>180) return;
    if (perf-live.lastCapturePerf<CAPTURE_INTERVAL_MS) return;
    if (live.lastReliablePerf!=null) { const dt=perf-live.lastReliablePerf; if (dt<=240) live.voicedMs+=dt; }
    live.lastReliablePerf=perf; live.lastCapturePerf=perf;
    live.points.push({t:Math.round(perf-live.startedPerf), m:Math.round(state.lastGood.midi*1000)/1000});
  }
  function compressPoints(points) {
    if (points.length<=MAX_GRAPH_POINTS) return points.map(p=>[p.t,p.m]);
    const step=points.length/MAX_GRAPH_POINTS, out=[];
    for(let i=0;i<MAX_GRAPH_POINTS;i++){const p=points[Math.min(points.length-1,Math.floor(i*step))];out.push([p.t,p.m]);}
    return out;
  }

  function normalizePoints(points) {
    if (!Array.isArray(points)) return [];
    return points.map(p => Array.isArray(p) ? {t:Number(p[0]),m:Number(p[1])} : {t:Number(p.t),m:Number(p.m)})
      .filter(p=>Number.isFinite(p.t)&&Number.isFinite(p.m)).sort((a,b)=>a.t-b.t);
  }
  function splitPhrases(points) {
    const p=normalizePoints(points), out=[];
    let current=[];
    for(const point of p){
      if(current.length && point.t-current[current.length-1].t>PHRASE_GAP_MS){out.push(current);current=[];}
      current.push(point);
    }
    if(current.length)out.push(current);
    return out.filter(seg=>seg.length>=5 && seg[seg.length-1].t-seg[0].t>=MIN_PHRASE_MS);
  }
  function centForMidi(midi,targetMidi){return (midi-targetMidi)*100;}
  function medianInWindow(segment,targetMidi,startMs,endMs){
    const t0=segment[0].t;
    const values=segment.filter(p=>p.t-t0>=startMs&&p.t-t0<=endMs).map(p=>centForMidi(p.m,targetMidi));
    return medianValue(values);
  }
  function robustSlope(segment,targetMidi){
    const t0=segment[0].t, endRel=Math.min(DRIFT_MAX_END_MS,segment[segment.length-1].t-t0);
    const pts=segment.filter(p=>p.t-t0>=DRIFT_START_MS&&p.t-t0<=endRel).map(p=>({x:(p.t-t0)/1000,y:centForMidi(p.m,targetMidi)}));
    if(pts.length<5 || pts[pts.length-1].x-pts[0].x<0.6)return null;
    const slopes=[];
    for(let i=0;i<pts.length-1;i++){
      for(let j=i+1;j<pts.length;j++){
        const dx=pts[j].x-pts[i].x;
        if(dx>=0.25)slopes.push((pts[j].y-pts[i].y)/dx);
      }
    }
    return medianValue(slopes);
  }
  function analyzeTechnique(points,targetMidi){
    if(!Number.isFinite(targetMidi))return null;
    const phrases=splitPhrases(points), utterances=[];
    phrases.forEach((seg,index)=>{
      const t0=seg[0].t, durationMs=seg[seg.length-1].t-t0;
      const landing=medianInWindow(seg,targetMidi,LANDING_START_MS,LANDING_END_MS);
      const sustain=durationMs>=1200?medianInWindow(seg,targetMidi,SUSTAIN_START_MS,SUSTAIN_END_MS):null;
      const drift=robustSlope(seg,targetMidi);
      if(!Number.isFinite(landing)&&!Number.isFinite(sustain)&&!Number.isFinite(drift))return;
      utterances.push({
        index:index+1,startMs:t0,durationMs:Math.round(durationMs),
        landingCents:Number.isFinite(landing)?Math.round(landing*10)/10:null,
        sustainCents:Number.isFinite(sustain)?Math.round(sustain*10)/10:null,
        driftCentsPerSec:Number.isFinite(drift)?Math.round(drift*10)/10:null
      });
    });
    if(!utterances.length)return null;
    const landing=medianValue(utterances.map(x=>x.landingCents));
    const sustain=medianValue(utterances.map(x=>x.sustainCents));
    const drift=medianValue(utterances.map(x=>x.driftCentsPerSec));
    return {
      landingCents:Number.isFinite(landing)?Math.round(landing*10)/10:null,
      sustainCents:Number.isFinite(sustain)?Math.round(sustain*10)/10:null,
      driftCentsPerSec:Number.isFinite(drift)?Math.round(drift*10)/10:null,
      utteranceCount:utterances.length,
      utterances:utterances.slice(0,20)
    };
  }
  function getTechnique(s){
    if(s?.technique && Number.isFinite(s.technique.utteranceCount))return s.technique;
    return analyzeTechnique(s?.points || [], s?.targetMidi);
  }

  function buildSessionRecord() {
    if (!live || live.points.length<5 || live.voicedMs<700) return null;
    const target=live.targetMidi;
    const deviations=live.points.map(p=>Number.isFinite(target)?(p.m-target)*100:freeDeviation(p.m));
    const inTune=deviations.map(c=>Math.abs(c)<=TARGET_TOLERANCE_CENTS);
    const accuracy=100*inTune.filter(Boolean).length/inTune.length, avgAbs=avg(deviations.map(Math.abs)), bias=avg(deviations);
    let longest=0, streak=0, lastT=null;
    for(let i=0;i<live.points.length;i++){
      const p=live.points[i], dt=lastT==null?0:Math.min(220,Math.max(0,p.t-lastT));
      if(inTune[i]){streak+=dt;longest=Math.max(longest,streak);}else streak=0;
      lastT=p.t;
    }
    const midis=live.points.map(p=>p.m);
    const med=medianValue(deviations);
    return {
      id:`${live.startedAt}-${Math.random().toString(36).slice(2,7)}`, createdAt:live.startedAt,
      durationMs:Math.max(0,Date.now()-live.startedAt), voicedMs:Math.round(live.voicedMs),
      targetMidi:Number.isFinite(target)?target:null, accuracy:Math.round(accuracy*10)/10,
      avgAbsCents:Math.round(avgAbs*10)/10, biasCents:Math.round(bias*10)/10,
      medianCents:Number.isFinite(med)?Math.round(med*10)/10:null, longestInTuneMs:Math.round(longest),
      minMidi:Math.min(...midis), maxMidi:Math.max(...midis), sampleCount:live.points.length,
      technique:analyzeTechnique(live.points,target),
      points:compressPoints(live.points)
    };
  }
  function saveLiveSession() {
    const record=buildSessionRecord(); live=null; updateRecordingPill();
    if(!record)return;
    const sessions=readSessions(); sessions.unshift(record); writeSessions(sessions); renderHistory(); showSavedToast(record);
  }
  function discardLiveSession(){live=null;updateRecordingPill();}
  function updateRecordingPill(){
    const el=document.getElementById('historyLiveStatus'); if(!el)return;
    el.textContent=live&&state.measuring?'이번 연습 기록 중':'자동 저장';
    el.classList.toggle('live',!!(live&&state.measuring));
  }
  function showSavedToast(record){
    const t=document.getElementById('saveToast');if(!t)return;
    const target=Number.isFinite(record.targetMidi)?noteFromMidi(record.targetMidi).name:'자유 측정';
    t.textContent=`${target} 연습 기록을 저장했습니다`;t.classList.add('show');clearTimeout(showSavedToast.timer);
    showSavedToast.timer=setTimeout(()=>t.classList.remove('show'),2300);
  }
  function trendForTarget(targetMidi){
    const a=readSessions().filter(s=>s.targetMidi===targetMidi).slice(0,5);if(a.length<2)return null;
    return a[0].accuracy-avg(a.slice(1).map(s=>s.accuracy));
  }
  function buildTechniqueDiagnosis(tech){
    if(!tech)return '1초 이상 이어진 목표음 발성이 부족해 착지·유지·드리프트를 계산하지 못했습니다.';
    const l=tech.landingCents,s=tech.sustainCents,d=tech.driftCentsPerSec;
    if(Number.isFinite(l)&&Math.abs(l)<=15&&Number.isFinite(s)&&s<-15&&Number.isFinite(d)&&d<-8)return '처음에는 목표음에 잘 착지했지만, 유지하면서 음정이 아래로 떨어졌습니다.';
    if(Number.isFinite(l)&&Math.abs(l)<=15&&Number.isFinite(s)&&s>15&&Number.isFinite(d)&&d>8)return '처음에는 목표음에 잘 착지했지만, 유지하면서 음정이 위로 올라갔습니다.';
    if(Number.isFinite(l)&&Math.abs(l)>15&&Number.isFinite(s)&&Math.abs(s)<=15)return '첫 착지는 목표음에서 벗어났지만, 0.5~1.5초 사이에 목표음을 찾아 들어갔습니다.';
    if(Number.isFinite(l)&&Math.abs(l)>15)return `첫 착지부터 목표음보다 ${l<0?'낮게':'높게'} 시작하는 경향이 보였습니다.`;
    if(Number.isFinite(s)&&Math.abs(s)<=15&&Number.isFinite(d)&&Math.abs(d)<=8)return '착지와 유지가 모두 목표음 근처에 있고, 시간에 따른 드리프트도 작았습니다.';
    if(Number.isFinite(d)&&d<-8)return '발성 중 시간이 지날수록 음정이 낮아지는 경향이 보였습니다.';
    if(Number.isFinite(d)&&d>8)return '발성 중 시간이 지날수록 음정이 높아지는 경향이 보였습니다.';
    return '착지와 유지 구간을 따로 확인해 어느 단계에서 오차가 생겼는지 비교해 보세요.';
  }
  function buildCoachText(s){
    const p=[],tech=getTechnique(s);
    if(Number.isFinite(s.targetMidi)){
      p.push(buildTechniqueDiagnosis(tech));
      if(tech){
        if(Number.isFinite(tech.landingCents)&&Math.abs(tech.landingCents)>15)p.push('다음 반복에서는 소리를 길게 유지하기보다 먼저 시작 0.5초 안에 목표음 중심에 바로 들어가는 데 집중하세요.');
        else if(Number.isFinite(tech.sustainCents)&&Math.abs(tech.sustainCents)>15)p.push('첫 음은 그대로 두고, 그 뒤 1초 동안 같은 높이를 유지하는 데 집중하세요.');
        if(Number.isFinite(tech.driftCentsPerSec)&&Math.abs(tech.driftCentsPerSec)>12)p.push(`드리프트는 ${signedDrift(tech.driftCentsPerSec)}입니다. 처음 맞춘 높이를 기준으로 2~3초 동안 선을 수평으로 만드는 연습이 좋습니다.`);
      }
      const trend=trendForTarget(s.targetMidi);
      if(trend!=null&&Math.abs(trend)>=4)p.push(trend>0?`최근 같은 목표음 기록보다 ±15 cent 정확률이 약 ${Math.round(trend)}%p 좋아졌습니다.`:`최근 같은 목표음 평균보다 ±15 cent 정확률이 약 ${Math.abs(Math.round(trend))}%p 낮았습니다.`);
    }else{
      if(s.avgAbsCents<=10)p.push('각 음의 중심에 가까이 머문 비율이 좋았습니다.');
      else p.push('자유 측정은 전체 흐름 확인용입니다. 착지·유지·드리프트 진단은 목표음을 선택한 연습에서 계산됩니다.');
    }
    return p.join(' ');
  }

  function renderHistory(){
    const list=document.getElementById('recentHistoryList'), empty=document.getElementById('historyEmpty'), summary=document.getElementById('historySummary');
    if(!list||!empty||!summary)return;
    const sessions=readSessions();list.innerHTML='';empty.classList.toggle('hidden',sessions.length>0);
    if(!sessions.length){summary.innerHTML='<strong>아직 기록 없음</strong><span>측정을 끝내면 자동 저장됩니다.</span>';return;}
    const recent=sessions.slice(0,5), targetRecent=recent.filter(s=>Number.isFinite(s.targetMidi)).map(s=>({s,tech:getTechnique(s)})).filter(x=>x.tech);
    if(targetRecent.length){
      const landingAbs=medianValue(targetRecent.map(x=>x.tech.landingCents).filter(Number.isFinite).map(Math.abs));
      const sustainAbs=medianValue(targetRecent.map(x=>x.tech.sustainCents).filter(Number.isFinite).map(Math.abs));
      const drift=medianValue(targetRecent.map(x=>x.tech.driftCentsPerSec).filter(Number.isFinite));
      summary.innerHTML=`<strong>최근 착지 ${Number.isFinite(landingAbs)?Math.round(landingAbs)+'c':'—'} · 유지 ${Number.isFinite(sustainAbs)?Math.round(sustainAbs)+'c':'—'}</strong><span>드리프트 중앙값 ${Number.isFinite(drift)?signedDriftShort(drift):'—'} · 기록 ${sessions.length}개</span>`;
    }else{
      const accuracyAvg=avg(recent.map(s=>s.accuracy)), best=Math.max(...recent.map(s=>s.accuracy));
      summary.innerHTML=`<strong>최근 ${recent.length}회 평균 ${Math.round(accuracyAvg)}%</strong><span>최근 최고 ${Math.round(best)}% · 기록 ${sessions.length}개</span>`;
    }
    recent.slice(0,3).forEach(s=>{
      const row=document.createElement('button');row.type='button';row.className='history-row';
      const tech=getTechnique(s);
      const score=Number.isFinite(s.targetMidi)?`${Math.round(s.accuracy)}% 정확`:`${noteFromMidi(s.minMidi).name}–${noteFromMidi(s.maxMidi).name}`;
      const detail=Number.isFinite(s.targetMidi)&&tech?`착지 ${signedCentShort(tech.landingCents)} · 드리프트 ${signedDriftShort(tech.driftCentsPerSec)}`:`전체 평균 오차 ${Math.round(s.avgAbsCents)}c`;
      row.innerHTML=`<span class="history-row-main"><strong>${describeTarget(s)}</strong><small>${nowDateLabel(s.createdAt)} · ${formatDuration(s.voicedMs)} 유효</small></span><span class="history-row-score"><strong>${score}</strong><small>${detail}</small></span><span class="history-chevron">›</span>`;
      row.addEventListener('click',()=>openSession(s.id));list.appendChild(row);
    });
  }
  function renderAllHistory(){
    const host=document.getElementById('allHistoryList');if(!host)return;const sessions=readSessions();host.innerHTML='';
    if(!sessions.length){host.innerHTML='<p class="history-empty">저장된 연습 기록이 없습니다.</p>';return;}
    sessions.forEach(s=>{
      const b=document.createElement('button');b.type='button';b.className='all-history-row',tech=getTechnique(s);
      const sub=Number.isFinite(s.targetMidi)&&tech?`착지 ${signedCentShort(tech.landingCents)} · 유지 ${signedCentShort(tech.sustainCents)} · ${signedDriftShort(tech.driftCentsPerSec)}`:`${Math.round(s.avgAbsCents)}c 전체 평균 오차`;
      b.innerHTML=`<span><strong>${describeTarget(s)}</strong><small>${fullDateLabel(s.createdAt)}</small></span><span><strong>${Math.round(s.accuracy)}%</strong><small>${sub}</small></span>`;
      b.addEventListener('click',()=>{document.getElementById('historyDialog').close();openSession(s.id);});host.appendChild(b);
    });
  }
  function renderUtteranceBreakdown(tech){
    const host=document.getElementById('sessionUtteranceList'),count=document.getElementById('sessionTechniqueCount');if(!host||!count)return;
    host.innerHTML='';
    if(!tech?.utterances?.length){count.textContent='분석 가능한 발성 없음';host.innerHTML='<p class="utterance-empty">목표음을 1.5초 이상 이어서 내면 발성별 분석이 생깁니다.</p>';return;}
    count.textContent=`발성 ${tech.utteranceCount}회 기준`;
    tech.utterances.forEach((u,i)=>{
      const row=document.createElement('div');row.className='utterance-row';
      row.innerHTML=`<span class="utterance-index">${i+1}회</span><span><small>초기 착지</small><strong>${signedCentShort(u.landingCents)}</strong></span><span><small>유지</small><strong>${signedCentShort(u.sustainCents)}</strong></span><span><small>드리프트</small><strong>${signedDriftShort(u.driftCentsPerSec)}</strong></span><span class="utterance-duration">${formatDuration(u.durationMs)}</span>`;
      host.appendChild(row);
    });
  }
  function openSession(id){
    const s=readSessions().find(x=>x.id===id);if(!s)return;selectedSessionId=id;
    const tech=getTechnique(s);
    document.getElementById('sessionTitle').textContent=describeTarget(s);document.getElementById('sessionDate').textContent=fullDateLabel(s.createdAt);
    document.getElementById('sessionLanding').textContent=tech?signedCent(tech.landingCents):'—';
    document.getElementById('sessionSustain').textContent=tech?signedCent(tech.sustainCents):'—';
    document.getElementById('sessionDrift').textContent=tech?signedDrift(tech.driftCentsPerSec):'—';
    document.getElementById('sessionTechniqueHint').textContent=Number.isFinite(s.targetMidi)?buildTechniqueDiagnosis(tech):'착지·유지·드리프트는 목표음을 선택한 연습에서 계산됩니다.';
    document.getElementById('sessionAccuracy').textContent=`${Math.round(s.accuracy)}%`;document.getElementById('sessionError').textContent=`${Math.round(s.avgAbsCents)} cent`;
    document.getElementById('sessionBias').textContent=signedCent(s.biasCents);document.getElementById('sessionLongest').textContent=formatDuration(s.longestInTuneMs);
    document.getElementById('sessionVoiced').textContent=formatDuration(s.voicedMs);document.getElementById('sessionRange').textContent=`${noteFromMidi(s.minMidi).name} – ${noteFromMidi(s.maxMidi).name}`;
    document.getElementById('sessionCoach').textContent=buildCoachText(s);renderUtteranceBreakdown(tech);
    const retry=document.getElementById('retryTargetBtn');retry.classList.toggle('hidden',!Number.isFinite(s.targetMidi));
    retry.onclick=()=>{setTarget(s.targetMidi);document.getElementById('sessionDialog').close();window.scrollTo({top:0,behavior:'smooth'});};
    document.getElementById('deleteSessionBtn').onclick=()=>deleteSession(id);
    document.getElementById('sessionDialog').showModal();requestAnimationFrame(()=>drawSessionGraph(s));
  }
  function deleteSession(id){
    writeSessions(readSessions().filter(s=>s.id!==id));selectedSessionId=null;document.getElementById('sessionDialog').close();renderHistory();renderAllHistory();
  }
  function drawSessionGraph(s){
    const canvas=document.getElementById('historyCanvas');if(!canvas||!s?.points?.length)return;
    const rect=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,3);canvas.width=Math.max(1,Math.round(rect.width*dpr));canvas.height=Math.max(1,Math.round(rect.height*dpr));
    const ctx=canvas.getContext('2d'),W=rect.width,H=rect.height;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,H);ctx.fillStyle='#0a1120';ctx.fillRect(0,0,W,H);
    const points=normalizePoints(s.points),midis=points.map(p=>p.m),center=Number.isFinite(s.targetMidi)?s.targetMidi:medianValue(midis);
    const low=Math.floor(Math.min(center-3,Math.min(...midis)-1)),high=Math.ceil(Math.max(center+3,Math.max(...midis)+1)),span=Math.max(6,high-low);
    const labelW=36,left=labelW,right=W-8,top=10,bottom=H-20,dur=Math.max(1,points[points.length-1].t),x=t=>left+(t/dur)*(right-left),y=m=>top+(high-m)/span*(bottom-top);
    ctx.font='10px -apple-system,BlinkMacSystemFont,sans-serif';ctx.textAlign='right';ctx.textBaseline='middle';
    for(let m=low;m<=high;m++){const yy=y(m);ctx.strokeStyle='rgba(255,255,255,.065)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(right,yy);ctx.stroke();ctx.fillStyle='rgba(180,193,220,.58)';ctx.fillText(noteFromMidi(m).name,labelW-6,yy);}
    if(Number.isFinite(s.targetMidi)){
      const upper=y(s.targetMidi+0.15),lower=y(s.targetMidi-0.15);ctx.fillStyle='rgba(95,224,174,.08)';ctx.fillRect(left,upper,right-left,lower-upper);
      const yy=y(s.targetMidi);ctx.save();ctx.setLineDash([6,5]);ctx.strokeStyle='rgba(124,156,255,.95)';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(right,yy);ctx.stroke();ctx.restore();
      splitPhrases(points).forEach(seg=>{
        const t0=seg[0].t, tEnd=seg[seg.length-1].t;
        const lx1=x(Math.min(tEnd,t0+LANDING_START_MS)),lx2=x(Math.min(tEnd,t0+LANDING_END_MS));
        if(lx2>lx1){ctx.fillStyle='rgba(124,156,255,.07)';ctx.fillRect(lx1,top,lx2-lx1,bottom-top);}
        const sx1=x(Math.min(tEnd,t0+SUSTAIN_START_MS)),sx2=x(Math.min(tEnd,t0+SUSTAIN_END_MS));
        if(sx2>sx1){ctx.fillStyle='rgba(101,225,194,.045)';ctx.fillRect(sx1,top,sx2-sx1,bottom-top);}
      });
    }
    ctx.strokeStyle='#68e0c3';ctx.lineWidth=2;ctx.lineJoin='round';ctx.lineCap='round';ctx.beginPath();let drawing=false,lastT=null;
    points.forEach(p=>{const xx=x(p.t),yy=y(p.m);if(!drawing||lastT==null||p.t-lastT>PHRASE_GAP_MS){ctx.moveTo(xx,yy);drawing=true;}else ctx.lineTo(xx,yy);lastT=p.t;});ctx.stroke();
    ctx.textAlign='left';ctx.textBaseline='top';ctx.fillStyle='rgba(154,167,195,.62)';ctx.fillText('시작',left,bottom+5);ctx.textAlign='right';ctx.fillText(formatDuration(dur),right,bottom+5);
  }
  function clearAllHistory(){
    if(!confirm('저장된 연습 기록을 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.'))return;
    localStorage.removeItem(STORAGE_KEY);renderHistory();renderAllHistory();
  }

  function installHooks(){
    const originalStart=startMeasurement, originalStop=stopMeasurement, originalResult=onPitchResult, originalReset=resetSession, originalSetTarget=setTarget;
    startMeasurement=async function(...args){const was=state.measuring,ret=await originalStart.apply(this,args);if(!was&&state.measuring)beginSession();return ret;};
    stopMeasurement=function(...args){if(state.measuring&&live)saveLiveSession();return originalStop.apply(this,args);};
    onPitchResult=function(result){const ret=originalResult.call(this,result),perf=performance.now();if(state.measuring&&state.lastGood&&perf-state.lastGood.now<180)captureReliablePitch(result);return ret;};
    resetSession=function(...args){const ret=originalReset.apply(this,args);if(state.measuring)beginSession();else discardLiveSession();return ret;};
    setTarget=function(midi){const changed=state.targetMidi!==midi;if(changed&&state.measuring&&live)saveLiveSession();const ret=originalSetTarget.call(this,midi);if(changed&&state.measuring)beginSession();return ret;};
  }
  function wireHistoryUi(){
    document.getElementById('historyAllBtn')?.addEventListener('click',()=>{renderAllHistory();document.getElementById('historyDialog').showModal();});
    document.getElementById('clearAllHistoryBtn')?.addEventListener('click',clearAllHistory);
    window.addEventListener('resize',()=>{if(document.getElementById('sessionDialog')?.open&&selectedSessionId){const s=readSessions().find(x=>x.id===selectedSessionId);if(s)drawSessionGraph(s);}});
  }
  installHooks();
  document.addEventListener('DOMContentLoaded',()=>{wireHistoryUi();renderHistory();updateRecordingPill();});
})();