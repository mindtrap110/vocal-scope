'use strict';

(() => {
  const KEY = 'vocalScopeJudgementDayV1';
  const C = window.VocalJudgementCore;
  const $ = id => document.getElementById(id);
  const V = () => window.VocalScope;
  const H = () => window.VocalHistory;
  const T = () => window.VocalScopeReferenceTone;
  let day = null;
  const runtime = { active: false, token: 0, timer: null, waitTimer: null, resolveWait: null,
    context: null, onset: null, captureStart: null, stage: 'initial', continuous: false, finishing: false };

  function localDate() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
  function currentRound() { return day?.rounds?.[day.cursor] || null; }
  function session(id) { return H()?.readSessions?.().find(s => s.id === id) || null; }
  function latest() { return session(day?.pendingId); }
  function signed(value) { return Number.isFinite(value) ? `${value > 0 ? '+' : ''}${Math.round(value)} cent` : '유효 결과 없음'; }
  function escape(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch])); }
  function show(id, visible) { $(id)?.classList.toggle('hidden', !visible); }
  function error(message = '') { $('judgementActionError').textContent = message; }
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(day)); return true; }
    catch (_) { error('진행을 저장하지 못했습니다. 저장 공간을 확인해 주세요.'); return false; }
  }
  function isBusy() { return ['preparing', 'capturing'].includes(day?.step); }
  function isPitchHidden() { return runtime.active && !(day?.step === 'capturing' && runtime.stage === 'correction' && currentRound()?.block === 'screen'); }
  function clearWaits() {
    clearInterval(runtime.timer);
    clearTimeout(runtime.waitTimer);
    runtime.timer = null;
    runtime.waitTimer = null;
    runtime.resolveWait?.(false);
    runtime.resolveWait = null;
  }
  function delay(ms, token) {
    return new Promise(resolve => {
      runtime.resolveWait = resolve;
      runtime.waitTimer = setTimeout(() => {
        runtime.resolveWait = null;
        runtime.waitTimer = null;
        resolve(runtime.token === token && runtime.active);
      }, ms);
    });
  }
  function stopTone() {
    T()?.stop?.();
    runtime.continuous = false;
    $('judgementToneStatus').textContent = '기준음 꺼짐';
    $('judgementToneToggleBtn').textContent = '지속 기준음 켜기';
  }
  function resetAnswer() {
    ['judgementDirection', 'judgementSize', 'judgementConfidence'].forEach(id => { $(id).value = ''; });
  }
  function closeSheets() { document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()); }

  function randomizeOrders() {
    const orders = C.defaultOrders();
    $('judgementM1Order').value = orders.m1.map(C.noteName).join(' ');
    $('judgementAOrder').value = orders.a.map(C.noteName).join(' ');
  }
  function setDateOrder() {
    const number = Number($('judgementDate').value.split('-')[2]);
    $('judgementFirstBlock').value = number % 2 ? 'beats' : 'screen';
  }

  function startDay(event) {
    event.preventDefault();
    if (V()?.state?.measuring) { $('judgementSetupError').textContent = '현재 측정을 끝낸 뒤 시작해 주세요.'; return; }
    try {
      const m1 = C.parseNotes($('judgementM1Order').value);
      const a = C.parseNotes($('judgementAOrder').value);
      const rounds = C.buildRounds(m1, a, $('judgementFirstBlock').value);
      const existingPending = H()?.readSessions?.().find(s => s.training?.requiresJudgement && !s.training.judgement && !s.training.excluded);
      if (existingPending) throw new Error('판단을 입력하지 않은 측정이 있습니다. 저장된 훈련을 먼저 이어서 완료해 주세요.');
      day = { id: `judgement-${Date.now()}`, date: $('judgementDate').value, rounds,
        feedbackMode: $('judgementFeedback').value, firstBlock: $('judgementFirstBlock').value,
        cursor: 0, step: 'ready', pendingId: null, initialId: null, correctionId: null,
        throatBefore: $('judgementThroatBefore').value.trim(), throatAfter: '', schemaVersion: 1 };
      if (!persist()) return;
      window.VocalPhrasePractice?.deactivate?.({ restoreTarget: true });
      if (window.VocalTrainer?.isActive?.()) window.VocalTrainer.stop();
      activate();
    } catch (err) { $('judgementSetupError').textContent = err.message; }
  }

  function activate() {
    closeSheets();
    runtime.active = true;
    if (currentRound()) V()?.setTarget?.(currentRound().targetMidi);
    render();
    $('judgementCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function captureContext(stage) {
    const round = currentRound();
    const check = round.routine === 'M1' || C.shouldShowFeedback(day.feedbackMode, round.round);
    return { date: day.date, dayId: day.id, roundId: `${day.id}-${day.cursor}`, ...round, stage,
      feedbackMode: day.feedbackMode, feedbackVisible: stage === 'retry' || check,
      requiresJudgement: stage !== 'correction', judgement: null, revealed: stage === 'correction',
      beatDetected: stage === 'retry' ? session(day.correctionId)?.training?.beatDetected || null : null,
      initialSessionId: stage === 'initial' ? null : day.initialId,
      correctionSessionId: stage === 'retry' ? day.correctionId : null,
      throatBefore: day.throatBefore, evaluationWindowMs: [500, 2500],
    };
  }

  async function beginCapture(stage = 'initial') {
    if (!runtime.active || isBusy() || !currentRound()) return;
    const token = ++runtime.token;
    error();
    closeSheets();
    clearWaits();
    stopTone();
    runtime.stage = stage;
    runtime.context = captureContext(stage);
    runtime.onset = null;
    runtime.captureStart = null;
    day.pendingId = null;
    day.step = 'preparing';
    resetAnswer();
    render();
    persist();
    try {
      if (stage === 'initial') {
        $('judgementInstruction').textContent = '① 기준음을 한 번 듣습니다.';
        await T().play(currentRound().targetMidi, 1100);
        if (!await delay(1400, token)) return;
        stopTone();
        $('judgementInstruction').textContent = '기준음 꺼짐 · 2초 쉬고 발성합니다.';
        if (!await delay(2000, token)) return;
      } else if (stage === 'retry') {
        $('judgementInstruction').textContent = '기준음과 화면을 끕니다. 2초 쉰 뒤 같은 음을 3초 유지하세요.';
        if (!await delay(2000, token)) return;
      } else {
        if (day.initialId) H().updateTraining(day.initialId, { correctionStarted: true });
        await T().startContinuous(currentRound().targetMidi, { allowPitch: true });
        runtime.continuous = true;
      }
      if (token !== runtime.token || !runtime.active) return;
      day.step = 'capturing';
      render();
      await V().startMeasurement();
      if (token !== runtime.token || !runtime.active) {
        if (V()?.state?.measuring) V().stopMeasurement('judgement-interrupted');
        return;
      }
      if (!V()?.state?.measuring) throw new Error('마이크를 시작하지 못했습니다. 권한을 확인하고 다시 눌러 주세요.');
      runtime.captureStart = performance.now();
      runtime.timer = setInterval(tick, 70);
      tick();
    } catch (err) {
      clearWaits();
      stopTone();
      runtime.context = null;
      day.step = stage === 'initial' ? 'ready' : stage === 'retry' ? 'corrected' : 'result';
      persist();
      render();
      error(err.message);
    }
  }

  function tick() {
    if (day.step !== 'capturing') return;
    const now = performance.now();
    const correction = runtime.stage === 'correction';
    const base = correction ? runtime.captureStart : runtime.onset;
    const holdMs = correction ? 2000 : 3000;
    if (base == null) {
      $('judgementCountdown').textContent = '발성을 기다립니다';
      if (now - runtime.captureStart > 8000) V().stopMeasurement('judgement-no-voice');
      return;
    }
    const remaining = Math.max(0, holdMs - (now - base));
    $('judgementCountdown').textContent = `${(remaining / 1000).toFixed(1)}초`;
    if (!remaining) V().stopMeasurement('judgement-complete');
  }

  function onPitch(event) {
    if (!runtime.active || day.step !== 'capturing') return;
    if (runtime.onset == null) runtime.onset = event.detail.now;
    if (runtime.stage === 'correction' && currentRound().block === 'screen') {
      const cents = (event.detail.midi - currentRound().targetMidi) * 100;
      $('judgementCorrectionLive').textContent = `교정용 실시간 추정: ${signed(cents)} · 기준음이 섞인 값은 평가에서 제외`;
    }
  }

  function onHistorySaved(event) {
    if (!runtime.active || !runtime.context || event.detail.record.training?.dayId !== day?.id) return;
    day.pendingId = event.detail.record.id;
    if (runtime.stage === 'initial') day.initialId = day.pendingId;
    if (runtime.stage === 'correction') day.correctionId = day.pendingId;
    persist();
  }

  function onMeasurementStop(event) {
    if (!runtime.active || day?.step !== 'capturing') return;
    clearWaits();
    stopTone();
    const complete = event.detail?.reason === 'judgement-complete';
    const record = latest();
    if (record && !complete) H().updateTraining(record.id, { interrupted: true }, { ...record.assessment, medianCents: null, status: 'interrupted' });
    if (runtime.stage === 'correction') {
      // Two-second corrections cannot fill a 0.5–2.5 s evaluation window.
      // Speaker tone + voice is also a mixed signal, so never use it as a score.
      if (record) H().updateTraining(record.id, { referenceOverlap: true }, { ...record.assessment, medianCents: null, status: 'correction-only' });
      day.step = complete ? 'corrected' : 'result';
    } else {
      day.step = record ? 'judgement' : runtime.stage === 'retry' ? 'corrected' : 'ready';
      if (!record) error('유효한 음정이 잡히지 않았습니다. 같은 단계를 다시 측정해 주세요.');
    }
    runtime.context = null;
    persist();
    render();
  }

  function submitJudgement(event) {
    event.preventDefault();
    const record = latest();
    if (!record || day.step !== 'judgement') return;
    const judgement = { direction: $('judgementDirection').value, size: $('judgementSize').value, confidence: Number($('judgementConfidence').value) };
    if (!C.validJudgement(judgement)) return error('방향·크기·확신도를 모두 선택해 주세요.');
    const patch = { judgement, judgementSavedAt: Date.now(), revealed: !!record.training.feedbackVisible };
    if (!H().updateTraining(record.id, patch)) return error('판단을 저장하지 못했습니다. 결과는 아직 숨겨져 있습니다.');
    day.step = 'result';
    persist();
    error();
    render();
  }

  function needsCorrection() {
    const record = session(day.initialId);
    return currentRound()?.routine === 'A' && record?.training.feedbackVisible
      && record.assessment?.status === 'ok' && Math.abs(record.assessment.medianCents) > 25;
  }

  function next() {
    if (!runtime.active || isBusy()) return;
    error();
    if (day.step === 'corrected') {
      if (currentRound().block === 'beats') {
        const answer = $('judgementBeatDetected').value;
        if (!['Y', 'N'].includes(answer)) return error('겹쳐 부르기 시작할 때의 울렁임 Y/N을 먼저 선택해 주세요.');
        if (!day.correctionId || !H().updateTraining(day.correctionId, { beatDetected: answer })) return error('울렁임 판단을 저장하지 못했습니다. 교정을 다시 진행해 주세요.');
        H().updateTraining(day.initialId, { beatDetected: answer });
      }
      beginCapture('retry');
      return;
    }
    if (day.step === 'result') {
      const record = latest();
      if (record?.assessment?.status !== 'ok') return;
      if (record.training.stage === 'initial' && needsCorrection()) { beginCapture('correction'); return; }
      advance();
    }
  }

  function repeat() {
    const record = latest();
    const stage = record?.training.stage || runtime.stage;
    if (record && !H().updateTraining(record.id, { excluded: true })) return error('이전 시도를 저장하지 못했습니다.');
    day.step = 'ready';
    persist();
    beginCapture(stage);
  }

  function advance() {
    runtime.stage = 'initial';
    day.cursor += 1;
    day.pendingId = null;
    day.initialId = null;
    day.correctionId = null;
    day.step = currentRound() ? 'ready' : 'done';
    $('judgementBeatDetected').value = '';
    if (currentRound()) V().setTarget(currentRound().targetMidi);
    persist();
    render();
  }

  function interrupt() {
    if (!runtime.active || !isBusy()) { stopTone(); return; }
    runtime.token += 1;
    clearWaits();
    stopTone();
    if (V()?.state?.measuring) V().stopMeasurement('judgement-interrupted');
    else {
      day.step = runtime.stage === 'initial' ? 'ready' : runtime.stage === 'retry' ? 'corrected' : 'result';
      runtime.context = null;
      persist();
      render();
    }
  }

  function pause() {
    interrupt();
    stopTone();
    runtime.active = false;
    V()?.clearDisplayedPitch?.();
    persist();
    render();
  }

  async function previewOnce() {
    if (isBusy() || day.step === 'judgement' || day.step === 'corrected') return;
    stopTone();
    try { await T().play(currentRound().targetMidi); $('judgementToneStatus').textContent = '기준음 1회 재생'; }
    catch (err) { error(err.message); }
  }

  async function toggleContinuous() {
    if (runtime.continuous) { stopTone(); return; }
    if (isBusy() || day.step === 'judgement' || day.step === 'corrected') return;
    try {
      await T().startContinuous(currentRound().targetMidi);
      runtime.continuous = true;
      $('judgementToneToggleBtn').textContent = '지속 기준음 끄기';
      $('judgementToneStatus').textContent = `${C.noteName(currentRound().targetMidi)} 지속 재생 중`;
    } catch (err) { error(err.message); }
  }

  function resultText(record) {
    if (!record?.training.judgement) return '';
    const j = record.training.judgement;
    const directions = { high: '높음', match: '맞음', low: '낮음' };
    const sizes = { 'sub-semitone': '반음 미만', 'semitone-tone': '반음~온음', larger: '그 이상', octave: '옥타브' };
    const lines = [`내 판단: ${directions[j.direction]} · ${sizes[j.size]} · 확신도 ${j.confidence}`];
    if (!record.training.feedbackVisible) lines.push('이 회차는 판단만 기록합니다. 실제 오차는 공개하지 않습니다.');
    else if (record.assessment?.status !== 'ok') lines.push('0.5~2.5초 구간을 완성하지 못했거나 발성이 끊겼습니다. 이 결과는 통계에 포함하지 않습니다.');
    else {
      lines.push(`0.5~2.5초 오차 중앙값: ${signed(record.assessment.medianCents)}`);
      lines.push(`실제 방향: ${directions[C.actualDirection(record.assessment.medianCents)]} · 방향 판단 ${C.judgementCorrect(j, record.assessment.medianCents) ? '정답' : '오답'} (±25 cent 기준)`);
    }
    return lines.join('\n');
  }

  function reportHtml() {
    const report = C.dailyReport(H().readSessions(), day.id);
    const format = value => Number.isFinite(value) ? Math.round(value) : '—';
    const statLine = s => `유효 ${s.validCount}회 · 방향 ${s.correctCount}/${s.judgedCount} (${format(s.directionAccuracy)}%) · ‘맞음’ 정밀도 ${s.matchCorrectCount}/${s.matchCount}`;
    const confidenceLine = s => s.confidence.map(c => `확신 ${c.value}: ${c.correct}/${c.count}`).join(' · ');
    let html = `<h3>${escape(day.date)} 결과</h3><p>M1: ${statLine(report.m1)}</p><p>|오차| 중앙값 ${format(report.m1.absoluteMedianCents)}c · ±25c ${report.m1.within25}/${report.m1.validCount} · ±100c ${report.m1.within100}/${report.m1.validCount}</p><p>${confidenceLine(report.m1)}</p>`;
    html += `<p>A3 제외 |오차| 중앙값: ${format(report.m1WithoutA3.absoluteMedianCents)}c · 진단 기준선과 비교용</p>`;
    html += `<p>피드백 단계: ${escape({ all:'매 회차', even:'짝수 회차', third:'3회에 1회' }[day.feedbackMode])} · 연습 전 목 상태: ${escape(day.throatBefore || '미입력')}</p>`;
    html += `<p>${report.m1ByNote.map(s => `${C.noteName(s.targetMidi)} ${signed(s.cents)}`).map(escape).join(' · ')}</p>`;
    html += '<div class="judgement-table-wrap"><table><thead><tr><th>블록</th><th>재시도 |오차| 중앙값</th><th>재시도 ±25c</th><th>교정 전 |오차| 중앙값</th><th>울렁임 Y/N</th></tr></thead><tbody>';
    report.blocks.forEach(b => {
      html += `<tr><th>${C.BLOCK_LABELS[b.block]}</th><td>${format(b.retry.absoluteMedianCents)}c</td><td>${b.retry.validCount ? `${b.retry.within25}/${b.retry.validCount} (${Math.round(b.retry.within25/b.retry.validCount*100)}%)` : '유효 결과 없음'}</td><td>${format(b.beforeRetry.absoluteMedianCents)}c</td><td>${b.block === 'beats' ? `${b.beatY}/${b.beatN}` : '해당 없음'}</td></tr>`;
    });
    html += '</tbody></table></div>';
    report.blocks.forEach(b => { html += `<p>${C.BLOCK_LABELS[b.block]}: ${statLine(b.initial)}<br>${confidenceLine(b.initial)}</p>`; });
    html += '<p class="judgement-note">교정 전 중앙값은 유효한 재시도가 있는 같은 회차의 ② 결과입니다. 유효 결과가 없으면 —로 표시합니다. 전체 표본은 기록 JSON에 보존됩니다.</p>';
    return html;
  }

  function render() {
    document.body.classList.toggle('judgement-active', runtime.active);
    document.body.classList.toggle('judgement-blind', isPitchHidden());
    show('judgementSetup', !runtime.active);
    show('judgementResume', !runtime.active && !!day);
    show('judgementActive', runtime.active);
    if (!runtime.active) {
      $('judgementBadge').textContent = day ? '진행 저장됨' : '준비';
      if (day) $('judgementResumeText').textContent = `${day.date} · ${Math.min(day.cursor + 1, 32)}/32회차 · ${day.step === 'done' ? '결과 보기' : '이어서 진행 가능'}`;
      return;
    }
    const round = currentRound();
    const record = latest();
    const done = day.step === 'done';
    $('judgementBadge').textContent = done ? '완료' : '훈련 중';
    $('judgementLabel').textContent = round ? C.label({ ...round, date: day.date, stage: runtime.stage }, round.targetMidi) : `${day.date} · 전체 완료`;
    $('judgementTarget').textContent = round ? C.noteName(round.targetMidi) : '완료';
    $('judgementProgress').textContent = `${Math.min(day.cursor + 1, 32)}/32회차`;
    const instruction = {
      ready: '① 기준음 → 2초 쉼 → ② 중간 음량으로 3초 유지. 실제 음정은 숨깁니다.',
      preparing: '기준음과 쉼을 준비합니다. 아직 부르지 마세요.',
      capturing: runtime.stage === 'correction'
        ? round?.block === 'beats' ? '맥놀이 교정: 겹치기 시작할 때의 울렁임을 기억하고, 느려지는 쪽으로 2초 맞추세요.' : '화면 교정: 기준음을 켜고 실시간 오차를 보며 2초 맞추세요.'
        : '기준음 꺼짐 · 화면 숨김. 중간 음량으로 3초 유지하세요.',
      judgement: '③ 방향·크기·확신도를 먼저 선택하세요. 저장한 뒤에만 실제 결과가 공개됩니다.',
      result: record?.training.stage === 'initial' && needsCorrection() ? '④ 결과 확인 완료. 다음은 이 블록의 ⑤ 교정입니다.' : '결과를 확인하고 다음 회차로 이동하세요.',
      corrected: '⑤ 교정 완료. 기준음을 끄고 화면을 가린 채 1회 재시도합니다.',
      done: '오늘 순서를 완료했습니다. 연습 후 목 상태를 남기고 기록을 공유할 수 있습니다.',
    };
    $('judgementInstruction').textContent = instruction[day.step] || '';
    if (!isBusy()) $('judgementCountdown').textContent = '';
    show('judgementPitchLock', !done && !(day.step === 'capturing' && runtime.stage === 'correction' && round.block === 'screen'));
    $('judgementPitchLock').textContent = day.step === 'result' && record?.training.feedbackVisible ? '실시간 화면은 숨김 · 아래에 확정 결과 공개' : '음정·그래프·기록 결과 숨김';
    show('judgementCorrectionLive', day.step === 'capturing' && runtime.stage === 'correction' && round.block === 'screen');
    show('judgementCaptureBtn', day.step === 'ready');
    show('judgementAnswerForm', day.step === 'judgement');
    const answerButton = $('judgementAnswerForm').querySelector('button');
    answerButton.textContent = record?.training.feedbackVisible === false ? '판단만 저장' : '판단 저장 → 결과 공개';
    show('judgementResult', day.step === 'result');
    if (day.step === 'result') $('judgementResult').textContent = resultText(record);
    else $('judgementResult').textContent = '';
    show('judgementBeatField', day.step === 'corrected' && round?.block === 'beats');
    show('judgementNextBtn', day.step === 'corrected' || (day.step === 'result' && record?.assessment?.status === 'ok'));
    $('judgementNextBtn').textContent = day.step === 'corrected' ? '기준음 끄기 → 숨기고 재시도' : record?.training.stage === 'initial' && needsCorrection() ? `⑤ ${C.BLOCK_LABELS[round.block]} 교정 시작` : '다음 회차';
    show('judgementRepeatBtn', day.step === 'result' && record?.assessment?.status !== 'ok');
    show('judgementToneControls', day.step === 'ready' || day.step === 'result');
    show('judgementReport', done);
    if (done) $('judgementReport').innerHTML = reportHtml();
    show('judgementThroatAfterField', done);
    $('judgementPauseBtn').textContent = done ? '결과 저장 · 일반 화면으로' : '잠시 중단 · 진행 저장';
    if (runtime.continuous && !isBusy()) $('judgementToneStatus').textContent = `${C.noteName(round.targetMidi)} 지속 재생 중`;
    if (runtime.stage === 'correction' && isBusy()) $('judgementToneStatus').textContent = '교정 중 지속 기준음 켜짐 · 종료 시 자동으로 끔';
  }

  function restore() {
    try { day = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { day = null; }
    if (!day?.rounds?.length) { day = null; return; }
    const unanswered = H().readSessions().find(s => s.training?.dayId === day.id && s.training.requiresJudgement && !s.training.judgement && !s.training.excluded);
    if (unanswered) {
      const cursor = day.rounds.findIndex((_, i) => `${day.id}-${i}` === unanswered.training.roundId);
      if (cursor >= 0) day.cursor = cursor;
      day.pendingId = unanswered.id;
      day.initialId = unanswered.training.stage === 'initial' ? unanswered.id : unanswered.training.initialSessionId;
      day.correctionId = unanswered.training.correctionSessionId || null;
      day.step = 'judgement';
    }
    if (day.step === 'capturing' || day.step === 'preparing') {
      const pending = latest();
      day.step = pending?.training.requiresJudgement && !pending.training.judgement ? 'judgement' : pending?.training.stage === 'correction' ? 'corrected' : 'ready';
    }
    if (day.step === 'judgement' && !latest()) day.step = 'ready';
    runtime.stage = latest()?.training.stage || 'initial';
    $('judgementThroatAfter').value = day.throatAfter || '';
    if (day.step === 'judgement') activate();
  }

  function init() {
    $('judgementDate').value = localDate();
    setDateOrder();
    randomizeOrders();
    $('judgementDate').addEventListener('change', setDateOrder);
    $('judgementShuffleBtn').addEventListener('click', randomizeOrders);
    $('judgementSetup').addEventListener('submit', startDay);
    $('judgementCaptureBtn').addEventListener('click', () => beginCapture('initial'));
    $('judgementAnswerForm').addEventListener('submit', submitJudgement);
    $('judgementNextBtn').addEventListener('click', next);
    $('judgementRepeatBtn').addEventListener('click', repeat);
    $('judgementPauseBtn').addEventListener('click', pause);
    $('judgementResumeBtn').addEventListener('click', activate);
    $('judgementToneOnceBtn').addEventListener('click', previewOnce);
    $('judgementToneToggleBtn').addEventListener('click', toggleContinuous);
    $('judgementThroatAfter').addEventListener('change', () => {
      if (!day) return;
      day.throatAfter = $('judgementThroatAfter').value.trim();
      if (!H().updateTrainingDay(day.id, { throatAfter: day.throatAfter })) error('연습 후 목 상태를 기록에 저장하지 못했습니다.');
      persist();
    });
    window.addEventListener('vs:pitch', onPitch);
    window.addEventListener('vs:history-saved', onHistorySaved);
    window.addEventListener('vs:measurement-stop', onMeasurementStop);
    window.addEventListener('vs:visibility', event => { if (event.detail.hidden) interrupt(); });
    window.addEventListener('pagehide', interrupt);
    window.addEventListener('vs:history-cleared', () => { if (runtime.active) pause(); day = null; localStorage.removeItem(KEY); render(); });
    restore();
    render();
  }

  window.VocalJudgementPractice = {
    isActive: () => runtime.active,
    isPitchHidden,
    getSessionContext: () => runtime.context ? { ...runtime.context } : null,
    getDailyReport: () => day ? C.dailyReport(H().readSessions(), day.id) : null,
  };
  document.addEventListener('DOMContentLoaded', init);
})();
