'use strict';

(() => {
  const STORAGE_KEY = 'vocalScopePracticeHistoryV1';
  const MAX_SESSIONS = 30;
  const CAPTURE_INTERVAL_MS = 90;
  const PHRASE_GAP_MS = 360;
  const ANALYSIS_VERSION = 2;
  const TARGET_TOLERANCE_CENTS = 15;

  let patchLive = null;
  let wakeLock = null;
  let wentHiddenAt = null;

  function readSessions() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
  }
  function writeSessions(items) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_SESSIONS)));
      return true;
    } catch (error) {
      console.warn('short-session storage', error);
      return false;
    }
  }
  function median(values) {
    const nums = values.filter(Number.isFinite).sort((a,b)=>a-b);
    if (!nums.length) return null;
    const m = Math.floor(nums.length / 2);
    return nums.length % 2 ? nums[m] : (nums[m - 1] + nums[m]) / 2;
  }
  function average(values) {
    const nums = values.filter(Number.isFinite);
    return nums.length ? nums.reduce((a,b)=>a+b,0) / nums.length : 0;
  }
  function normalizePoints(points) {
    if (!Array.isArray(points)) return [];
    return points.map(p => Array.isArray(p)
      ? { t:Number(p[0]), m:Number(p[1]) }
      : { t:Number(p.t), m:Number(p.m) })
      .filter(p => Number.isFinite(p.t) && Number.isFinite(p.m))
      .sort((a,b)=>a.t-b.t);
  }
  function segment(points) {
    const src = normalizePoints(points), out = [];
    let current = [];
    for (const point of src) {
      if (current.length && point.t - current[current.length - 1].t > PHRASE_GAP_MS) {
        out.push(current);
        current = [];
      }
      current.push(point);
    }
    if (current.length) out.push(current);
    return out;
  }
  function noteInfo(midi) {
    try { return noteFromMidi(midi); }
    catch (_) { return { name:'—', korean:'—', midi:Math.round(midi) }; }
  }
  function medianWindow(seg, referenceMidi, fromMs, toMs) {
    if (!seg.length) return null;
    const t0 = seg[0].t;
    return median(seg
      .filter(p => p.t - t0 >= fromMs && p.t - t0 <= toMs)
      .map(p => (p.m - referenceMidi) * 100));
  }
  function robustSlope(seg, referenceMidi) {
    if (!seg.length) return null;
    const t0 = seg[0].t;
    const pts = seg
      .filter(p => p.t - t0 >= 200 && p.t - t0 <= 4000)
      .map(p => ({ x:(p.t - t0) / 1000, y:(p.m - referenceMidi) * 100 }));
    if (pts.length < 5 || pts[pts.length - 1].x - pts[0].x < 0.6) return null;
    const slopes = [];
    for (let i = 0; i < pts.length - 1; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dx = pts[j].x - pts[i].x;
        if (dx >= 0.25) slopes.push((pts[j].y - pts[i].y) / dx);
      }
    }
    return median(slopes);
  }
  function analyzeAllUtterances(points, targetMidi) {
    const utterances = [];
    segment(points).forEach((seg, index) => {
      if (!seg.length) return;
      const medianMidi = median(seg.map(p=>p.m));
      if (!Number.isFinite(medianMidi)) return;
      const centerMidi = Math.round(medianMidi);
      const ref = Number.isFinite(targetMidi) ? targetMidi : centerMidi;
      const durationMs = Math.max(0, seg[seg.length - 1].t - seg[0].t);
      const landing = medianWindow(seg, ref, 200, 500);
      const sustain = durationMs >= 500 ? medianWindow(seg, ref, 500, 1500) : null;
      const drift = robustSlope(seg, ref);
      const note = noteInfo(centerMidi);
      utterances.push({
        index:index + 1,
        startMs:seg[0].t,
        endMs:seg[seg.length - 1].t,
        durationMs:Math.round(Math.max(CAPTURE_INTERVAL_MS, durationMs + CAPTURE_INTERVAL_MS)),
        medianMidi:Math.round(medianMidi * 1000) / 1000,
        centerMidi,
        noteName:note.name,
        noteKorean:note.korean,
        centerOffsetCents:Math.round((medianMidi - centerMidi) * 1000) / 10,
        landingCents:Number.isFinite(landing) ? Math.round(landing * 10) / 10 : null,
        sustainCents:Number.isFinite(sustain) ? Math.round(sustain * 10) / 10 : null,
        driftCentsPerSec:Number.isFinite(drift) ? Math.round(drift * 10) / 10 : null
      });
    });
    if (!utterances.length) return null;
    const landing = median(utterances.map(u=>u.landingCents));
    const sustain = median(utterances.map(u=>u.sustainCents));
    const drift = median(utterances.map(u=>u.driftCentsPerSec));
    return {
      analysisVersion:ANALYSIS_VERSION,
      referenceMode:Number.isFinite(targetMidi) ? 'target' : 'nearest-note',
      landingCents:Number.isFinite(landing) ? Math.round(landing * 10) / 10 : null,
      sustainCents:Number.isFinite(sustain) ? Math.round(sustain * 10) / 10 : null,
      driftCentsPerSec:Number.isFinite(drift) ? Math.round(drift * 10) / 10 : null,
      utteranceCount:utterances.length,
      utterances:utterances.slice(0, 20)
    };
  }
  function estimateVoicedMs(points) {
    return segment(points).reduce((sum, seg) => {
      if (!seg.length) return sum;
      return sum + Math.max(CAPTURE_INTERVAL_MS,
        seg[seg.length - 1].t - seg[0].t + CAPTURE_INTERVAL_MS);
    }, 0);
  }
  function compressPoints(points, limit=900) {
    const p = normalizePoints(points);
    if (p.length <= limit) return p.map(x=>[x.t,x.m]);
    const step = p.length / limit, out = [];
    for (let i=0; i<limit; i++) {
      const point = p[Math.min(p.length-1,Math.floor(i*step))];
      out.push([point.t,point.m]);
    }
    return out;
  }
  function buildCompatibleRecord(live) {
    const points = normalizePoints(live?.points || []);
    if (!points.length) return null;
    const target = Number.isFinite(live.targetMidi) ? live.targetMidi : null;
    const deviations = points.map(p => target != null ? (p.m - target) * 100 : (p.m - Math.round(p.m)) * 100);
    const inTune = deviations.map(c => Math.abs(c) <= TARGET_TOLERANCE_CENTS);
    const accuracy = 100 * inTune.filter(Boolean).length / inTune.length;
    const avgAbs = average(deviations.map(Math.abs));
    const bias = average(deviations);
    const midis = points.map(p=>p.m);
    const voicedMs = estimateVoicedMs(points);
    let longest = 0, streak = 0, lastT = null;
    for (let i=0; i<points.length; i++) {
      const dt = lastT == null ? CAPTURE_INTERVAL_MS : Math.min(220, Math.max(0, points[i].t - lastT));
      if (inTune[i]) { streak += dt; longest = Math.max(longest, streak); }
      else streak = 0;
      lastT = points[i].t;
    }
    return {
      id:`${live.startedAt}-${Math.random().toString(36).slice(2,7)}`,
      createdAt:live.startedAt,
      durationMs:Math.max(voicedMs, Date.now() - live.startedAt),
      voicedMs:Math.round(voicedMs),
      targetMidi:target,
      accuracy:Math.round(accuracy * 10) / 10,
      avgAbsCents:Math.round(avgAbs * 10) / 10,
      biasCents:Math.round(bias * 10) / 10,
      medianCents:Math.round((median(deviations) || 0) * 10) / 10,
      longestInTuneMs:Math.round(longest),
      minMidi:Math.min(...midis),
      maxMidi:Math.max(...midis),
      sampleCount:points.length,
      technique:analyzeAllUtterances(points, target),
      points:compressPoints(points)
    };
  }
  function refreshRecentPreview() {
    const list = document.getElementById('recentHistoryList');
    const summary = document.getElementById('historySummary');
    const empty = document.getElementById('historyEmpty');
    if (!list || !summary || !empty) return;
    const sessions = readSessions();
    list.innerHTML = '';
    empty.classList.toggle('hidden', sessions.length > 0);
    if (!sessions.length) {
      summary.innerHTML = '<strong>아직 기록 없음</strong><span>짧은 발성도 자동 저장됩니다.</span>';
      return;
    }
    summary.innerHTML = `<strong>최근 기록 ${Math.min(5,sessions.length)}회</strong><span>짧은 발성 포함 · 전체 ${sessions.length}개</span>`;
    sessions.slice(0,3).forEach((s, idx) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'history-row';
      const target = Number.isFinite(s.targetMidi) ? noteInfo(s.targetMidi) : null;
      const title = target ? `${target.name} · ${target.korean}` : '자유 측정';
      const tech = s.technique;
      const detail = tech?.utteranceCount ? `발성 ${tech.utteranceCount}회 · ${Math.round(s.voicedMs || 0)}ms 유효` : `${Math.round(s.avgAbsCents || 0)}c 평균 오차`;
      const score = Number.isFinite(s.targetMidi) ? `${Math.round(s.accuracy || 0)}% 정확` : `${noteInfo(s.minMidi).name}–${noteInfo(s.maxMidi).name}`;
      row.innerHTML = `<span class="history-row-main"><strong>${title}</strong><small>${new Date(s.createdAt).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',hour12:false})} · ${detail}</small></span><span class="history-row-score"><strong>${score}</strong><small>탭하여 상세 보기</small></span><span class="history-chevron">›</span>`;
      row.addEventListener('click', () => {
        const allBtn = document.getElementById('historyAllBtn');
        allBtn?.click();
        requestAnimationFrame(() => {
          const rows = document.querySelectorAll('#allHistoryList .all-history-row');
          rows[idx]?.click();
        });
      });
      list.appendChild(row);
    });
  }

  function beginPatchSession() {
    patchLive = {
      startedAt:Date.now(),
      startedPerf:performance.now(),
      targetMidi:Number.isFinite(state.targetMidi) ? state.targetMidi : null,
      points:[],
      lastCapturePerf:0
    };
  }
  function capturePatchPoint(result) {
    if (!patchLive || !state.measuring || !state.lastGood) return;
    const now = performance.now();
    const db = Number(result?.db), conf = Number(result?.confidence), freq = Number(result?.frequency);
    if (!Number.isFinite(freq) || conf < 0.58 || !Number.isFinite(db) || db < state.gateDb || now - state.lastGood.now > 180) return;
    if (now - patchLive.lastCapturePerf < CAPTURE_INTERVAL_MS) return;
    patchLive.lastCapturePerf = now;
    patchLive.points.push({ t:Math.round(now - patchLive.startedPerf), m:Math.round(state.lastGood.midi * 1000) / 1000 });
  }
  function enhanceNewestRecord(beforeCount) {
    const sessions = readSessions();
    if (!patchLive?.points?.length) return false;
    if (sessions.length > beforeCount) {
      const newest = sessions[0];
      if (newest && Math.abs(Number(newest.createdAt) - patchLive.startedAt) < 5000) {
        newest.technique = analyzeAllUtterances(newest.points || patchLive.points, newest.targetMidi);
        newest.voicedMs = Math.max(Number(newest.voicedMs) || 0, estimateVoicedMs(newest.points || patchLive.points));
        writeSessions(sessions);
        return true;
      }
    }
    const record = buildCompatibleRecord(patchLive);
    if (!record) return false;
    sessions.unshift(record);
    writeSessions(sessions);
    const toast = document.getElementById('saveToast');
    if (toast) {
      toast.textContent = '짧은 발성도 연습 기록에 저장했습니다';
      toast.classList.add('show');
      setTimeout(()=>toast.classList.remove('show'), 2300);
    }
    return true;
  }

  async function requestWakeLock() {
    if (!state.measuring || document.hidden || !navigator.wakeLock?.request) return;
    try {
      if (!wakeLock || wakeLock.released) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener?.('release', () => { wakeLock = null; }, { once:true });
      }
    } catch (error) {
      console.debug('wake lock unavailable', error);
    }
  }
  async function releaseWakeLock() {
    try { await wakeLock?.release?.(); } catch (_) {}
    wakeLock = null;
  }
  async function recoverCaptureAfterForeground() {
    if (!state.measuring) return;
    await requestWakeLock();
    const track = state.stream?.getAudioTracks?.()[0];
    if (!track || track.readyState !== 'live') {
      try { stopMeasurement(); } catch (_) {}
      if (typeof showError === 'function') showError('iOS가 백그라운드에서 마이크 입력을 종료했습니다. 현재 PWA에서는 지속적인 백그라운드 녹음을 보장할 수 없어, 다시 측정을 시작해 주세요.');
      return;
    }
    try {
      if (state.audioContext?.state === 'suspended') await state.audioContext.resume();
      if (typeof setStatus === 'function') setStatus('실시간 측정 중', 'live');
    } catch (error) {
      console.warn('capture resume', error);
    }
  }

  document.addEventListener('visibilitychange', (event) => {
    if (!state?.measuring) return;
    event.stopImmediatePropagation();
    if (document.hidden) {
      wentHiddenAt = Date.now();
      return;
    }
    recoverCaptureAfterForeground();
    wentHiddenAt = null;
  }, true);

  const originalStart = startMeasurement;
  const originalStop = stopMeasurement;
  const originalResult = onPitchResult;
  const originalReset = resetSession;
  const originalSetTarget = setTarget;

  startMeasurement = async function(...args) {
    const was = state.measuring;
    const result = await originalStart.apply(this, args);
    if (!was && state.measuring) {
      beginPatchSession();
      requestWakeLock();
    }
    return result;
  };
  onPitchResult = function(result) {
    const value = originalResult.call(this, result);
    capturePatchPoint(result);
    return value;
  };
  stopMeasurement = function(...args) {
    const before = readSessions().length;
    const hadPatch = !!patchLive?.points?.length;
    const value = originalStop.apply(this, args);
    if (hadPatch) {
      enhanceNewestRecord(before);
      refreshRecentPreview();
    }
    patchLive = null;
    releaseWakeLock();
    return value;
  };
  resetSession = function(...args) {
    const value = originalReset.apply(this, args);
    if (state.measuring) beginPatchSession();
    else patchLive = null;
    return value;
  };
  setTarget = function(midi) {
    const changed = state.targetMidi !== midi;
    const value = originalSetTarget.call(this, midi);
    if (changed && state.measuring) beginPatchSession();
    return value;
  };

  window.VocalScopeCaptureCapabilities = {
    get currentStream() { return state.stream || null; },
    get isMeasuring() { return !!state.measuring; },
    get wasBackgroundedAt() { return wentHiddenAt; },
    screenWakeLock: !!navigator.wakeLock?.request,
    mediaRecorder: typeof MediaRecorder !== 'undefined',
    trueBackgroundRecordingInIOSPWA: false,
    requestWakeLock,
    recoverCaptureAfterForeground
  };
})();