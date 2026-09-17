'use strict';

const $ = (id) => document.getElementById(id);
const NOTE_NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
const KOREAN = ['도','도♯','레','레♯','미','파','파♯','솔','솔♯','라','라♯','시'];
const ANALYZE_INTERVAL = 42;
const HISTORY_MS = 12000;
const TARGET_TOLERANCE_CENTS = 15;
const APP_VERSION = '3.0.0';
const BUILD_ID = '2026-09-18-a';

const state = {
  measuring: false,
  audioContext: null,
  stream: null,
  source: null,
  analyser: null,
  worker: null,
  timer: null,
  workerBusy: false,
  noiseFloor: -72,
  gateDb: -64,
  smoothedMidi: null,
  recentRawMidi: [],
  pitchWindow: [],
  history: [],
  frozen: false,
  frozenHistory: [],
  graphCenter: 55,
  targetMidi: null,
  selectedOctave: 2,
  targetExactMs: 0,
  targetStreakMs: 0,
  targetVoicedMs: 0,
  lastTargetTick: null,
  octaveCandidate: null,
  octaveCandidateCount: 0,
  lastGood: null,
  ignorePitchUntil: 0,
  wakeLock: null,
  hiddenAt: null,
  captureStartedAt: null,
  usedFallbackConstraints: false,
  lastError: null,
};

function emit(name, detail={}) {
  window.dispatchEvent(new CustomEvent(`vs:${name}`, { detail }));
}
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function median(values) {
  const nums = values.filter(Number.isFinite);
  if (!nums.length) return null;
  const a = [...nums].sort((x,y)=>x-y);
  const m = Math.floor(a.length/2);
  return a.length % 2 ? a[m] : (a[m-1]+a[m])/2;
}
function stddev(values) {
  if (values.length < 2) return 0;
  const avg = values.reduce((a,b)=>a+b,0)/values.length;
  return Math.sqrt(values.reduce((s,x)=>s+(x-avg)**2,0)/values.length);
}
function noteFromMidi(midi) {
  const rounded = Math.round(midi);
  const pc = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  return { midi: rounded, pc, octave, name: `${NOTE_NAMES[pc]}${octave}`, korean: `${octave - 2}옥 ${KOREAN[pc]}` };
}
function midiToFrequency(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }
function formatSigned(value, digits=0) {
  if (!Number.isFinite(value)) return '—';
  const n = value.toFixed(digits);
  return value > 0 ? `+${n}` : n;
}
function isDialogOpen(dialog) { return dialog?.open === true; }

function setStatus(text, kind='idle') {
  if ($('micStatus')) $('micStatus').textContent = text;
  if ($('micDot')) $('micDot').className = `dot ${kind}`;
}
function setQuality(text, kind='waiting') {
  if ($('qualityBadge')) $('qualityBadge').textContent = text;
  if ($('qualityBadge')) $('qualityBadge').className = `quality ${kind}`;
}

function setTarget(midi, options={}) {
  const old = state.targetMidi;
  state.targetMidi = Number.isFinite(midi) ? midi : null;
  state.targetExactMs = 0;
  state.targetStreakMs = 0;
  state.targetVoicedMs = 0;
  state.lastTargetTick = null;
  if (state.targetMidi == null) {
    $('targetBtn').textContent = '자유 측정';
    $('targetPanel').classList.add('hidden');
    $('freeModeBtn').classList.add('selected');
    if (!options.transient) localStorage.removeItem('vocalScopeTarget');
  } else {
    const n = noteFromMidi(state.targetMidi);
    $('targetBtn').textContent = `${n.name} · ${n.korean}`;
    $('targetTitle').textContent = `${n.name} · ${n.korean}`;
    $('targetPanel').classList.remove('hidden');
    $('freeModeBtn').classList.remove('selected');
    state.selectedOctave = n.octave;
    if (!options.transient) localStorage.setItem('vocalScopeTarget', String(state.targetMidi));
  }
  buildTargetPicker();
  updateTargetPanel(null, performance.now());
  drawGraph();
  if (old !== state.targetMidi) emit('target-change', { oldMidi: old, targetMidi: state.targetMidi, measuring: state.measuring, transient: !!options.transient });
}

function buildTargetPicker() {
  const tabs = $('octaveTabs');
  const grid = $('noteGrid');
  if (!tabs || !grid) return;
  tabs.innerHTML = '';
  grid.innerHTML = '';
  for (let octave = 2; octave <= 5; octave++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `octave-tab ${octave === state.selectedOctave ? 'active' : ''}`;
    b.textContent = `${octave - 2}옥`;
    b.onclick = () => { state.selectedOctave = octave; buildTargetPicker(); };
    tabs.appendChild(b);
  }
  for (let pc = 0; pc < 12; pc++) {
    const midi = 12 * (state.selectedOctave + 1) + pc;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `note-choice ${state.targetMidi === midi ? 'selected' : ''}`;
    b.innerHTML = `${NOTE_NAMES[pc]}${state.selectedOctave}<small>${state.selectedOctave - 2}옥 ${KOREAN[pc]}</small>`;
    b.onclick = () => { setTarget(midi); $('targetDialog').close(); };
    grid.appendChild(b);
  }
}

function stabilizeMidi(rawMidi) {
  const recentMedian = median(state.recentRawMidi.slice(-5));
  let candidate = rawMidi;
  if (recentMedian != null) {
    const diff = rawMidi - recentMedian;
    const octaveLike = Math.abs(Math.abs(diff) - 12) < 1.15;
    if (octaveLike) {
      const dir = Math.sign(diff);
      if (state.octaveCandidate === dir) state.octaveCandidateCount++;
      else { state.octaveCandidate = dir; state.octaveCandidateCount = 1; }
      if (state.octaveCandidateCount < 3) candidate = rawMidi - 12 * dir;
      else { state.octaveCandidate = null; state.octaveCandidateCount = 0; }
    } else {
      state.octaveCandidate = null;
      state.octaveCandidateCount = 0;
    }
  }
  state.recentRawMidi.push(candidate);
  if (state.recentRawMidi.length > 9) state.recentRawMidi.shift();
  if (state.smoothedMidi == null) state.smoothedMidi = candidate;
  else {
    const d = candidate - state.smoothedMidi;
    const alpha = Math.abs(d) > 1.2 ? 0.78 : Math.abs(d) > 0.45 ? 0.58 : 0.38;
    state.smoothedMidi += alpha * d;
  }
  return state.smoothedMidi;
}

function updateNoiseModel(db, hasReliablePitch) {
  const likelyNoise = !hasReliablePitch || db < state.noiseFloor + 4;
  if (likelyNoise && Number.isFinite(db)) {
    const a = db > state.noiseFloor ? 0.012 : 0.05;
    state.noiseFloor = (1-a)*state.noiseFloor + a*db;
    state.noiseFloor = clamp(state.noiseFloor, -95, -28);
  }
  state.gateDb = clamp(Math.max(state.noiseFloor + 7.5, -66), -66, -26);
}

function updateDiagnostics(db, confidence, hasReliablePitch, audible) {
  const levelPct = clamp(((db + 70) / 50) * 100, 0, 100);
  $('levelBar').style.width = `${levelPct}%`;
  $('dbValue').textContent = Number.isFinite(db) ? `${db.toFixed(1)} dB` : '— dB';
  $('noiseValue').textContent = `${state.noiseFloor.toFixed(1)} dB`;
  $('gateValue').textContent = `${state.gateDb.toFixed(1)} dB`;
  $('confidenceText').textContent = `신뢰도 ${Math.round((confidence || 0) * 100)}%`;
  if (db > -2) {
    $('inputStatus').textContent = '입력 너무 큼';
    $('diagnosticHint').textContent = '마이크 입력이 너무 큽니다. iPhone을 조금 더 멀리 두면 음정 검출이 더 안정적일 수 있습니다.';
  } else if (!audible) {
    $('inputStatus').textContent = '입력 약함';
    $('diagnosticHint').textContent = '목소리가 주변 소음과 충분히 구분되지 않습니다. iPhone을 조금 더 가까이 두거나 더 조용한 곳에서 측정해 보세요.';
  } else if (!hasReliablePitch) {
    $('inputStatus').textContent = '소리는 감지됨';
    $('diagnosticHint').textContent = '음량은 충분하지만 음의 주기가 선명하지 않습니다. 모음을 짧게 끊더라도 음높이를 분명하게 내 보세요.';
  } else {
    $('inputStatus').textContent = '음정 추적 중';
    $('diagnosticHint').textContent = '입력 상태가 좋습니다. 짧은 발성도 연습 기록에 저장됩니다.';
  }
}

function updateTargetPanel(midi, now) {
  if (state.targetMidi == null) return;
  let targetCents = null;
  if (Number.isFinite(midi)) {
    targetCents = (midi - state.targetMidi) * 100;
    const dt = state.lastTargetTick == null ? 0 : clamp(now - state.lastTargetTick, 0, 150);
    state.targetVoicedMs += dt;
    if (Math.abs(targetCents) <= TARGET_TOLERANCE_CENTS) {
      state.targetExactMs += dt;
      state.targetStreakMs += dt;
    } else state.targetStreakMs = 0;
    state.lastTargetTick = now;
  } else {
    state.targetStreakMs = 0;
    state.lastTargetTick = null;
  }
  const accuracy = state.targetVoicedMs > 0 ? 100*state.targetExactMs/state.targetVoicedMs : 0;
  $('targetAccuracy').textContent = `${Math.round(accuracy)}%`;
  $('holdTime').textContent = `${(state.targetExactMs/1000).toFixed(1)}초`;
  $('streakTime').textContent = `${(state.targetStreakMs/1000).toFixed(1)}초`;
  $('targetCent').textContent = targetCents == null ? '—' : `${formatSigned(targetCents,0)} cent`;
}

function pushHistory(midi, now) {
  state.history.push({ t: now, midi: Number.isFinite(midi) ? midi : null });
  const cutoff = now - HISTORY_MS - 800;
  while (state.history.length && state.history[0].t < cutoff) state.history.shift();
}
function calculateStability(currentMidi, now) {
  state.pitchWindow = state.pitchWindow.filter(p=>p.t > now-2000);
  if (!Number.isFinite(currentMidi)) return null;
  state.pitchWindow.push({ t:now, midi:currentMidi });
  const note = Math.round(currentMidi);
  const values = state.pitchWindow.filter(p=>Math.round(p.midi)===note).map(p=>(p.midi-note)*100);
  if (values.length < 5) return null;
  return Math.round(clamp(100 - stddev(values)*3.2, 0, 100));
}
function updatePitchUI(midi, frequency, confidence, now) {
  const n = noteFromMidi(midi);
  const cents = (midi - n.midi)*100;
  const stability = calculateStability(midi, now);
  $('noteName').textContent = n.name;
  $('noteKorean').textContent = n.korean;
  $('frequencyValue').textContent = `${frequency.toFixed(1)} Hz`;
  $('centValue').textContent = `${formatSigned(cents,0)} cent`;
  $('stabilityValue').textContent = stability == null ? '측정 중' : `${stability}%`;
  $('centNeedle').style.left = `${clamp(cents+50,0,100)}%`;
  if (Math.abs(cents) <= 15) {
    setQuality('정확한 구간','good');
    $('centHint').textContent = '중심 음정에 안정적으로 들어와 있습니다.';
  } else if (cents < 0) {
    setQuality('조금 낮음','warn');
    $('centHint').textContent = `${Math.abs(Math.round(cents))} cent 낮습니다.`;
  } else {
    setQuality('조금 높음','warn');
    $('centHint').textContent = `${Math.abs(Math.round(cents))} cent 높습니다.`;
  }
  updateTargetPanel(midi, now);
  state.lastGood = { midi, frequency, confidence, now };
}
function clearPitchUI(reason='신호 대기') {
  $('noteName').textContent = '—';
  $('noteKorean').textContent = '음을 내면 표시됩니다';
  $('frequencyValue').textContent = '— Hz';
  $('centValue').textContent = '— cent';
  $('stabilityValue').textContent = '—';
  $('centNeedle').style.left = '50%';
  $('centHint').textContent = '0 cent에 가까울수록 정확합니다.';
  setQuality(reason,'waiting');
  updateTargetPanel(null, performance.now());
}

function onPitchResult(result) {
  state.workerBusy = false;
  if (!state.measuring) return;
  const now = performance.now();
  const db = Number.isFinite(result.db) ? result.db : -160;
  const conf = Number.isFinite(result.confidence) ? result.confidence : 0;
  const rawFreq = Number.isFinite(result.frequency) ? result.frequency : null;
  if (now < state.ignorePitchUntil) {
    pushHistory(null, now);
    return;
  }
  const hasCandidate = rawFreq != null && conf >= 0.58;
  updateNoiseModel(db, hasCandidate);
  const audible = db >= state.gateDb;
  const reliable = hasCandidate && audible;
  updateDiagnostics(db, conf, reliable, audible);
  if (!reliable) {
    pushHistory(null, now);
    clearPitchUI(audible ? '음정 불안정' : '신호 대기');
    emit('gap', { now, db, confidence:conf, audible });
    drawGraph();
    return;
  }
  const rawMidi = window.PitchCore.frequencyToMidi(rawFreq);
  const midi = stabilizeMidi(rawMidi);
  const displayFrequency = midiToFrequency(midi);
  updatePitchUI(midi, displayFrequency, conf, now);
  pushHistory(midi, now);
  emit('pitch', { now, midi, frequency:displayFrequency, rawFrequency:rawFreq, confidence:conf, db, gateDb:state.gateDb });
  drawGraph();
}
function analyzeFrame() {
  if (!state.measuring || state.workerBusy || !state.analyser || !state.worker) return;
  if (state.audioContext?.state === 'suspended') return;
  const buf = new Float32Array(state.analyser.fftSize);
  state.analyser.getFloatTimeDomainData(buf);
  state.workerBusy = true;
  state.worker.postMessage({ type:'analyze', samples:buf, sampleRate:state.audioContext.sampleRate, options:{minHz:65,maxHz:1200,threshold:0.16} }, [buf.buffer]);
}
function withTimeout(promise, ms, label='작업') {
  return Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error(`${label} 시간 초과`)),ms))]);
}
async function getMicStream() {
  const preferred = { audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:1}, video:false };
  try {
    state.usedFallbackConstraints = false;
    return await withTimeout(navigator.mediaDevices.getUserMedia(preferred), 10000, '마이크 연결');
  } catch (firstError) {
    if (firstError?.name === 'NotAllowedError') throw firstError;
    try {
      state.usedFallbackConstraints = true;
      return await withTimeout(navigator.mediaDevices.getUserMedia({audio:true,video:false}), 10000, '마이크 연결');
    } catch (_) { throw firstError; }
  }
}
async function requestWakeLock() {
  if (!state.measuring || document.hidden || !navigator.wakeLock?.request) return;
  try {
    if (!state.wakeLock || state.wakeLock.released) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener?.('release',()=>{ state.wakeLock=null; },{once:true});
    }
  } catch (_) {}
}
async function releaseWakeLock() {
  try { await state.wakeLock?.release?.(); } catch (_) {}
  state.wakeLock = null;
}

async function startMeasurement() {
  if (state.measuring) { stopMeasurement('user'); return; }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showError('이 기능은 HTTPS로 열린 Safari 또는 홈 화면 웹 앱에서만 마이크를 사용할 수 있습니다.');
    return;
  }
  $('measureBtn').disabled = true;
  setStatus('마이크 연결 중','idle');
  try {
    cleanupAudio(false);
    state.stream = await getMicStream();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    state.audioContext = new AudioCtx({latencyHint:'interactive'});
    if (state.audioContext.state === 'suspended') await withTimeout(state.audioContext.resume(),3000,'오디오 엔진 시작');
    state.source = state.audioContext.createMediaStreamSource(state.stream);
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 4096;
    state.analyser.smoothingTimeConstant = 0;
    state.source.connect(state.analyser);
    state.worker = new Worker('./pitch-worker.js');
    state.worker.onmessage = e => {
      if (e.data?.type === 'result') onPitchResult(e.data);
      else if (e.data?.type === 'error') { state.workerBusy=false; console.error(e.data.message); }
    };
    state.worker.onerror = e => { state.workerBusy=false; console.error('pitch worker',e); };
    const track = state.stream.getAudioTracks?.()[0];
    if (track) track.onended = () => {
      if (!state.measuring) return;
      emit('force-save', { reason:'track-ended' });
      stopMeasurement('track-ended');
      showError('마이크 입력이 중단되었습니다. 오디오 장치가 바뀌었거나 iOS가 입력을 종료했을 수 있습니다. 다시 측정을 시작해 주세요.');
    };
    state.measuring = true;
    state.captureStartedAt = Date.now();
    state.workerBusy = false;
    state.noiseFloor = -72;
    state.gateDb = -64;
    state.lastTargetTick = null;
    state.timer = setInterval(analyzeFrame, ANALYZE_INTERVAL);
    $('measureBtn').textContent = '측정 종료';
    $('measureBtn').classList.add('live');
    setStatus('실시간 측정 중','live');
    $('inputStatus').textContent = state.usedFallbackConstraints ? '호환 모드 입력' : '입력 분석 중';
    emit('measurement-start', { startedAt:state.captureStartedAt, startedPerf:performance.now(), targetMidi:state.targetMidi, fallbackConstraints:state.usedFallbackConstraints });
    requestWakeLock();
    analyzeFrame();
  } catch (error) {
    state.lastError = String(error?.message || error || '알 수 없는 오류');
    cleanupAudio(false);
    const text = state.lastError;
    if (error?.name === 'NotAllowedError') showError('마이크 접근이 허용되지 않았습니다. Safari의 사이트 설정에서 마이크를 허용한 뒤 다시 시도해 주세요.');
    else if (error?.name === 'NotFoundError') showError('사용 가능한 마이크를 찾지 못했습니다. 오디오 장치를 확인한 뒤 다시 시도해 주세요.');
    else showError(`오디오 엔진을 시작하지 못했습니다. ${text}`);
    setStatus('마이크 시작 실패','error');
  } finally { $('measureBtn').disabled = false; }
}
function stopMeasurement(reason='user') {
  if (!state.measuring) return;
  const stoppedAt = Date.now();
  emit('measurement-stop', { stoppedAt, reason, targetMidi:state.targetMidi });
  state.measuring = false;
  cleanupAudio(false);
  releaseWakeLock();
  $('measureBtn').textContent = '마이크로 측정 시작';
  $('measureBtn').classList.remove('live');
  setStatus('측정 대기 중','idle');
  $('inputStatus').textContent = '마이크 미사용';
  $('confidenceText').textContent = '신뢰도 —';
  $('levelBar').style.width = '0%';
  clearPitchUI();
}
function cleanupAudio(markStopped=true) {
  if (state.timer) { clearInterval(state.timer); state.timer=null; }
  try { state.worker?.terminate(); } catch (_) {}
  state.worker=null; state.workerBusy=false;
  try { state.source?.disconnect(); } catch (_) {}
  state.source=null;
  if (state.stream) {
    for (const track of state.stream.getTracks()) { try { track.onended=null; track.stop(); } catch (_) {} }
    state.stream=null;
  }
  if (state.audioContext && state.audioContext.state !== 'closed') { try { state.audioContext.close(); } catch (_) {} }
  state.audioContext=null; state.analyser=null;
  if (markStopped) state.measuring=false;
}
function resetSession() {
  state.history=[]; state.frozenHistory=[]; state.frozen=false; state.recentRawMidi=[]; state.pitchWindow=[]; state.smoothedMidi=null;
  state.targetExactMs=0; state.targetStreakMs=0; state.targetVoicedMs=0; state.lastTargetTick=null; state.lastGood=null;
  $('freezeBtn').textContent='고정'; $('freezeBtn').classList.remove('active');
  if (state.targetMidi != null) updateTargetPanel(null,performance.now());
  drawGraph();
  emit('reset', { measuring:state.measuring });
}
function showError(message) {
  $('errorText').textContent=message;
  if (!isDialogOpen($('errorDialog'))) $('errorDialog').showModal();
}

async function playReferenceTone(midi, durationMs=700) {
  if (!Number.isFinite(midi)) return;
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let ctx = state.audioContext;
  let own = false;
  try {
    if (!ctx || ctx.state === 'closed') { ctx = new AudioCtx(); own = true; }
    if (ctx.state === 'suspended') await ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    osc.type='sine'; osc.frequency.value=midiToFrequency(midi);
    gain.gain.setValueAtTime(0.0001,t);
    gain.gain.exponentialRampToValueAtTime(0.055,t+0.025);
    gain.gain.setValueAtTime(0.055,t+Math.max(0.08,durationMs/1000-0.06));
    gain.gain.exponentialRampToValueAtTime(0.0001,t+durationMs/1000);
    osc.connect(gain); gain.connect(ctx.destination);
    state.ignorePitchUntil = performance.now()+durationMs+260;
    osc.start(t); osc.stop(t+durationMs/1000+0.02);
    if (own) osc.onended = ()=>{ try { ctx.close(); } catch (_) {} };
    emit('reference-tone', { midi, durationMs });
  } catch (error) { console.warn('reference tone',error); }
}

function resizeCanvas() {
  const canvas=$('pitchCanvas'); if(!canvas)return;
  const rect=canvas.getBoundingClientRect(), dpr=Math.min(window.devicePixelRatio||1,3);
  const w=Math.max(1,Math.round(rect.width*dpr)), h=Math.max(1,Math.round(rect.height*dpr));
  if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;} drawGraph();
}
function drawGraph() {
  const canvas=$('pitchCanvas'); if(!canvas)return;
  const ctx=canvas.getContext('2d'); if(!ctx||!canvas.width||!canvas.height)return;
  const dpr=Math.min(window.devicePixelRatio||1,3), W=canvas.width/dpr,H=canvas.height/dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,H);ctx.fillStyle='#0a1120';ctx.fillRect(0,0,W,H);
  const data=state.frozen?state.frozenHistory:state.history;
  const now=state.frozen&&data.length?data[data.length-1].t:performance.now();
  const valid=data.filter(p=>Number.isFinite(p.midi));
  const desiredCenter=state.targetMidi??(valid.length?valid[valid.length-1].midi:state.graphCenter);
  state.graphCenter=state.graphCenter*0.82+desiredCenter*0.18;
  const yMin=Math.floor(state.graphCenter-6),yMax=yMin+12,labelW=38,plotX=labelW,plotW=W-labelW-8,top=10,bottom=H-22,plotH=bottom-top;
  const xFor=t=>plotX+clamp((t-(now-HISTORY_MS))/HISTORY_MS,0,1)*plotW;
  const yFor=midi=>top+(yMax-midi)/(yMax-yMin)*plotH;
  ctx.font='10px -apple-system,BlinkMacSystemFont,sans-serif';ctx.textAlign='right';ctx.textBaseline='middle';
  for(let m=yMin;m<=yMax;m++){
    const y=yFor(m);ctx.strokeStyle=m%12===0?'rgba(255,255,255,.14)':'rgba(255,255,255,.065)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(plotX,y);ctx.lineTo(W-8,y);ctx.stroke();ctx.fillStyle='rgba(180,193,220,.58)';ctx.fillText(noteFromMidi(m).name,labelW-7,y);
  }
  ctx.textAlign='center';ctx.textBaseline='top';
  for(let s=0;s<=12;s+=3){const x=plotX+(s/12)*plotW;ctx.strokeStyle='rgba(255,255,255,.035)';ctx.beginPath();ctx.moveTo(x,top);ctx.lineTo(x,bottom);ctx.stroke();ctx.fillStyle='rgba(154,167,195,.55)';ctx.fillText(s===12?'지금':`−${12-s}s`,x,bottom+5);}
  if(state.targetMidi!=null&&state.targetMidi>=yMin-1&&state.targetMidi<=yMax+1){const y=yFor(state.targetMidi);ctx.save();ctx.setLineDash([6,5]);ctx.strokeStyle='rgba(124,156,255,.9)';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(plotX,y);ctx.lineTo(W-8,y);ctx.stroke();ctx.restore();}
  ctx.strokeStyle='#68e0c3';ctx.lineWidth=2.2;ctx.lineJoin='round';ctx.lineCap='round';ctx.beginPath();let drawing=false,prevT=null;
  for(const p of data){if(p.t<now-HISTORY_MS||!Number.isFinite(p.midi)){drawing=false;prevT=p.t;continue;}const x=xFor(p.t),y=yFor(p.midi);if(!drawing||(prevT!=null&&p.t-prevT>170)){ctx.moveTo(x,y);drawing=true;}else ctx.lineTo(x,y);prevT=p.t;}ctx.stroke();
  if(!valid.length){ctx.fillStyle='rgba(154,167,195,.7)';ctx.font='13px -apple-system,BlinkMacSystemFont,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('측정을 시작하면 음정 흐름이 나타납니다',plotX+plotW/2,top+plotH/2);}
}
function toggleFreeze(){state.frozen=!state.frozen;if(state.frozen){state.frozenHistory=state.history.map(p=>({...p}));$('freezeBtn').textContent='해제';$('freezeBtn').classList.add('active');}else{$('freezeBtn').textContent='고정';$('freezeBtn').classList.remove('active');}drawGraph();}

async function recoverForeground() {
  if (!state.measuring) return;
  requestWakeLock();
  const track=state.stream?.getAudioTracks?.()[0];
  if(!track||track.readyState!=='live'){
    emit('force-save',{reason:'background-track-ended'});
    stopMeasurement('background-track-ended');
    showError('백그라운드에 있는 동안 iOS가 마이크 입력을 종료했습니다. 현재 웹 앱에서는 백그라운드 녹음을 보장할 수 없으므로 다시 측정을 시작해 주세요.');
    return;
  }
  try {
    if(state.audioContext?.state==='suspended')await state.audioContext.resume();
    setStatus('실시간 측정 중','live');
  } catch (_) {}
}

function wireUi(){
  $('measureBtn').addEventListener('click',startMeasurement);
  $('resetBtn').addEventListener('click',resetSession);
  $('freezeBtn').addEventListener('click',toggleFreeze);
  $('targetBtn').addEventListener('click',()=>$('targetDialog').showModal());
  $('helpBtn').addEventListener('click',()=>$('helpDialog').showModal());
  $('freeModeBtn').addEventListener('click',()=>{setTarget(null);$('targetDialog').close();});
  $('reloadBtn').addEventListener('click',()=>location.reload());
  window.addEventListener('resize',resizeCanvas);
  window.addEventListener('orientationchange',()=>setTimeout(resizeCanvas,180));
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){state.hiddenAt=Date.now();releaseWakeLock();emit('visibility',{hidden:true});}
    else{emit('visibility',{hidden:false,hiddenMs:state.hiddenAt?Date.now()-state.hiddenAt:0});state.hiddenAt=null;recoverForeground();}
  });
  window.addEventListener('pagehide',()=>{ if(state.measuring)emit('force-save',{reason:'pagehide'}); });
}

async function init(){
  wireUi();buildTargetPicker();
  const saved=Number(localStorage.getItem('vocalScopeTarget'));
  if(Number.isFinite(saved)&&saved>=36&&saved<=96)setTarget(saved);else setTarget(null);
  resizeCanvas();
  if('serviceWorker'in navigator){try{const reg=await navigator.serviceWorker.register('./sw.js');reg.update?.();}catch(e){console.warn('service worker',e);}}
  setInterval(()=>{if(!state.frozen)drawGraph();},500);
  emit('ready',{version:APP_VERSION,build:BUILD_ID});
}

document.addEventListener('DOMContentLoaded',init);

window.VocalScope={
  APP_VERSION,BUILD_ID,state,noteFromMidi,midiToFrequency,setTarget,startMeasurement,stopMeasurement,playReferenceTone,showError,requestWakeLock,recoverForeground,
  getCurrentStream:()=>state.stream,
  getDiagnostics:()=>({version:APP_VERSION,build:BUILD_ID,measuring:state.measuring,targetMidi:state.targetMidi,noiseFloor:state.noiseFloor,gateDb:state.gateDb,audioContextState:state.audioContext?.state||'none',trackState:state.stream?.getAudioTracks?.()[0]?.readyState||'none',fallbackConstraints:state.usedFallbackConstraints,lastError:state.lastError})
};