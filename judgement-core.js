(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VocalJudgementCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';
  const WINDOW = { startMs: 500, endMs: 2500, gapMs: 360, toleranceCents: 25 };
  const BLOCK_LABELS = { beat: '맥놀이', screen: '화면' };
  const STAGE_LABELS = { initial: '②', correction: '교정', retry: '재시도', discarded: '다시 부르기 전 실패' };

  function median(values) {
    const a = values.filter(Number.isFinite).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function normalizePoints(points) {
    return (Array.isArray(points) ? points : []).map(p => Array.isArray(p)
      ? { t: p[0], m: p[1] } : { t: p.t, m: p.m ?? p.midi })
      .filter(p => Number.isFinite(p.t) && Number.isFinite(p.m)).sort((a, b) => a.t - b.t);
  }

  // t=0 is the first reliable pitch frame, not the microphone button press.
  // A partial or fragmented window never counts as an in-tune trial.
  function windowMedian(points, targetMidi, options = {}) {
    const cfg = { ...WINDOW, ...options };
    const all = normalizePoints(points);
    const onsetMs = Number.isFinite(options.onsetMs) ? options.onsetMs : all[0]?.t;
    const selected = all.filter(p => p.t - onsetMs >= cfg.startMs && p.t - onsetMs <= cfg.endMs);
    const values = Number.isFinite(targetMidi) ? selected.map(p => (p.m - targetMidi) * 100) : [];
    const observedMedianCents = median(values);
    const coverageMs = selected.length > 1 ? selected.at(-1).t - selected[0].t : 0;
    const complete = all.length > 0 && all.at(-1).t - onsetMs >= cfg.endMs;
    const gaps = selected.slice(1).map((p, i) => p.t - selected[i].t);
    const edgeCoverage = selected.length > 0 && selected[0].t - onsetMs <= cfg.startMs + 180
      && selected.at(-1).t - onsetMs >= cfg.endMs - 180;
    const fragmented = gaps.some(gap => gap > cfg.gapMs);
    const valid = Number.isFinite(observedMedianCents) && complete && edgeCoverage && !fragmented && selected.length >= 8 && coverageMs >= 1400;
    return {
      method: 'onset-window-median-v1', startMs: cfg.startMs, endMs: cfg.endMs,
      onsetMs: Number.isFinite(onsetMs) ? onsetMs : null, sampleCount: selected.length,
      coverageMs, complete, status: valid ? 'ok' : fragmented ? 'fragmented' : !complete ? 'too-short' : 'insufficient',
      medianCents: valid ? Math.round(observedMedianCents * 10) / 10 : null,
      observedMedianCents: Number.isFinite(observedMedianCents) ? Math.round(observedMedianCents * 10) / 10 : null,
    };
  }

  function actualDirection(cents) {
    if (!Number.isFinite(cents)) return null;
    return Math.abs(cents) <= WINDOW.toleranceCents ? 'match' : cents > 0 ? 'high' : 'low';
  }

  function validJudgement(j) {
    return ['high', 'match', 'low'].includes(j?.direction)
      && (j.direction === 'match' ? j.size === null : ['lt_semitone', 'semitone_to_tone', 'more', 'octave'].includes(j.size))
      && [1, 2, 3].includes(j?.confidence);
  }
  function judgementCorrect(j, cents) {
    return Number.isFinite(cents) && validJudgement(j) ? j.direction === actualDirection(cents) : null;
  }
  function shouldShowFeedback(level, trial) {
    return level === 1 ? trial % 2 === 0 : level === 2 ? trial % 3 === 0 : true;
  }
  function validDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const d = new Date(date + 'T12:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
  }
  function noteName(midi) {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    return Number.isFinite(midi) ? names[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1) : '—';
  }
  function parseNotes(text) {
    const names = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    return String(text).trim().split(/[\s,/]+/).filter(Boolean).map(token => {
      const m = /^([A-G])([#♯b♭]?)(-?\d)$/i.exec(token);
      if (!m) throw new Error('음 이름을 확인해 주세요: ' + token);
      const midi = 12 * (Number(m[3]) + 1) + names[m[1].toUpperCase()] + (m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0);
      if (midi < 0 || midi > 127) throw new Error('MIDI 범위를 벗어난 음입니다: ' + token);
      return midi;
    });
  }
  function blockMethods(first) {
    if (!['screen', 'beat'].includes(first)) throw new Error('블록 순서를 선택해 주세요.');
    return first === 'screen' ? ['screen', 'beat'] : ['beat', 'screen'];
  }
  function buildRounds(date, notes, first) {
    if (!validDate(date)) throw new Error('유효한 날짜를 YYYY-MM-DD로 입력해 주세요.');
    const methods = blockMethods(first);
    if (notes.length !== 24) throw new Error('목표음을 순서대로 정확히 24개 붙여 넣어 주세요.');
    return notes.map((targetMidi, i) => ({ block: i < 12 ? 1 : 2, method: methods[i < 12 ? 0 : 1], trial: i + 1, targetNote: noteName(targetMidi), targetMidi }));
  }
  function training(day, round, stage, initialSessionId = null) {
    return { dayId: day.dayId, ...round, stage, judgement: null, autoScore: null,
      beatHeard: null, mixedWithReference: stage === 'correction' && round.method === 'screen',
      initialSessionId, feedbackLevel: day.feedbackLevel };
  }
  function label(t, midi) {
    if (Number.isInteger(t?.trial)) return t.dayId + ' · 블록' + t.block + ' ' + BLOCK_LABELS[t.method] + ' · ' + t.trial + '회 · ' + STAGE_LABELS[t.stage] + ' · ' + t.targetNote;
    return (t.date || t.dayId || '') + ' · ' + (t.block || '') + ' · ' + (t.round || '') + '회 · ' + (STAGE_LABELS[t.stage] || t.stage) + ' · ' + noteName(midi);
  }
  function exportDay(records, date) {
    if (!validDate(date)) throw new Error('내보낼 날짜를 입력해 주세요.');
    return { schema: 'vocal-scope-training', schemaVersion: 1, dayId: date,
      sessions: records.filter(s => s.training?.dayId === date).slice().sort((a, b) => a.createdAt - b.createdAt) };
  }
  return { WINDOW, BLOCK_LABELS, STAGE_LABELS, median, windowMedian, actualDirection,
    validJudgement, judgementCorrect, shouldShowFeedback, validDate, noteName, parseNotes, blockMethods, buildRounds, training, label, exportDay };
});
