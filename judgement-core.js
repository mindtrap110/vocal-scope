(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VocalJudgementCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';
  const WINDOW = { startMs: 500, endMs: 2500, gapMs: 360, toleranceCents: 25 };
  const M1_NOTES = [41, 45, 48, 50, 52, 53, 55, 57];
  const A_NOTES = [45, 47, 48, 50, 52];
  const BLOCK_LABELS = { m1: 'M1', beats: '맥놀이', screen: '화면' };
  const STAGE_LABELS = { initial: '②', correction: '교정', retry: '재시도' };

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

  function validJudgement(judgement) {
    return ['high', 'match', 'low'].includes(judgement?.direction)
      && ['sub-semitone', 'semitone-tone', 'larger', 'octave'].includes(judgement?.size)
      && [1, 2, 3].includes(Number(judgement?.confidence));
  }

  function judgementCorrect(judgement, cents) {
    const actual = actualDirection(cents);
    return actual && validJudgement(judgement) ? judgement.direction === actual : null;
  }

  function shouldShowFeedback(mode, round) {
    return mode === 'even' ? round % 2 === 0 : mode === 'third' ? round % 3 === 0 : true;
  }

  function shuffle(values, random = Math.random) {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function defaultOrders(random = Math.random) {
    const a = Array.from({ length: 22 }, (_, i) => A_NOTES[i % A_NOTES.length]);
    return { m1: shuffle(M1_NOTES, random), a: shuffle([...a, 53, 55], random) };
  }

  function noteName(midi) {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
  }

  function parseNotes(text) {
    const names = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
    const tokens = String(text).trim().split(/[\s,→·]+/).filter(Boolean);
    return tokens.map(token => {
      const m = /^([A-G])([#♯b♭]?)([2-5])$/i.exec(token);
      if (!m) throw new Error(`음 이름을 확인해 주세요: ${token}`);
      return 12 * (Number(m[3]) + 1) + names[m[1].toUpperCase()] + (m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0);
    });
  }

  function validateOrders(m1, a) {
    if (m1.length !== 8 || new Set(m1).size !== 8 || m1.some(n => !M1_NOTES.includes(n))) {
      throw new Error('M1에는 F2 A2 C3 D3 E3 F3 G3 A3를 한 번씩 넣어 주세요.');
    }
    if (a.length !== 24 || a.some(n => !Number.isInteger(n) || !((n >= 45 && n <= 52) || n === 53 || n === 55)) || a.filter(n => n >= 53).length > 2) {
      throw new Error('A에는 A2~E3의 음 24개를 넣고, F3·G3는 합쳐 최대 2회만 넣어 주세요.');
    }
  }

  function buildRounds(m1, a, firstBlock) {
    validateOrders(m1, a);
    const second = firstBlock === 'beats' ? 'screen' : 'beats';
    return [
      ...m1.map((targetMidi, i) => ({ routine: 'M1', block: 'm1', blockNumber: 0, round: i + 1, targetMidi })),
      ...a.map((targetMidi, i) => ({ routine: 'A', block: i < 12 ? firstBlock : second, blockNumber: i < 12 ? 1 : 2, round: i % 12 + 1, targetMidi })),
    ];
  }

  function label(training, targetMidi) {
    return `${training.date} · ${BLOCK_LABELS[training.block] || training.block} · ${training.round}회 · ${STAGE_LABELS[training.stage] || training.stage} · ${noteName(targetMidi)}`;
  }

  function stats(records) {
    const valid = records.filter(s => s.assessment?.status === 'ok' && Number.isFinite(s.assessment.medianCents));
    const judged = valid.filter(s => validJudgement(s.training?.judgement));
    const correct = judged.filter(s => judgementCorrect(s.training.judgement, s.assessment.medianCents));
    const matched = judged.filter(s => s.training.judgement.direction === 'match');
    const confidence = [1, 2, 3].map(value => {
      const subset = judged.filter(s => Number(s.training.judgement.confidence) === value);
      return { value, count: subset.length, correct: subset.filter(s => judgementCorrect(s.training.judgement, s.assessment.medianCents)).length };
    });
    return {
      count: records.length, validCount: valid.length, judgedCount: judged.length, correctCount: correct.length,
      directionAccuracy: judged.length ? correct.length / judged.length * 100 : null,
      matchCount: matched.length, matchCorrectCount: matched.filter(s => Math.abs(s.assessment.medianCents) <= 25).length,
      absoluteMedianCents: median(valid.map(s => Math.abs(s.assessment.medianCents))),
      within25: valid.filter(s => Math.abs(s.assessment.medianCents) <= 25).length,
      within100: valid.filter(s => Math.abs(s.assessment.medianCents) <= 100).length,
      confidence,
    };
  }

  function dailyReport(records, dayId) {
    const selected = records.filter(s => s.training?.dayId === dayId && !s.training.excluded);
    // Retests of an invalid attempt replace it in reports, without deleting source data.
    const latest = new Map();
    [...selected].sort((a, b) => a.createdAt - b.createdAt).forEach(s => {
      latest.set(`${s.training.roundId}:${s.training.stage}`, s);
    });
    const trials = [...latest.values()];
    const m1 = trials.filter(s => s.training.routine === 'M1' && s.training.stage === 'initial');
    const blocks = ['beats', 'screen'].map(block => {
      const initial = trials.filter(s => s.training.block === block && s.training.stage === 'initial');
      const retries = trials.filter(s => s.training.block === block && s.training.stage === 'retry');
      const paired = retries.filter(s => s.assessment?.status === 'ok');
      const roundIds = new Set(paired.map(s => s.training.roundId));
      const before = initial.filter(s => roundIds.has(s.training.roundId));
      const correction = trials.filter(s => s.training.block === block && s.training.stage === 'correction');
      return { block, initial: stats(initial), retry: stats(retries), beforeRetry: stats(before),
        beatY: correction.filter(s => s.training.beatDetected === 'Y').length,
        beatN: correction.filter(s => s.training.beatDetected === 'N').length,
      };
    });
    return { m1: stats(m1), m1WithoutA3: stats(m1.filter(s => s.targetMidi !== 57)),
      m1ByNote: m1.map(s => ({ targetMidi: s.targetMidi, cents: s.assessment?.medianCents ?? null })), blocks };
  }

  return { WINDOW, M1_NOTES, A_NOTES, BLOCK_LABELS, STAGE_LABELS, median, windowMedian,
    actualDirection, validJudgement, judgementCorrect, shouldShowFeedback, defaultOrders,
    noteName, parseNotes, validateOrders, buildRounds, label, stats, dailyReport };
});
