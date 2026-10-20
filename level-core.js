(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VocalLevelCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function dbFromPower(squareSum, sampleCount) {
    const power = sampleCount > 0 ? squareSum / sampleCount : 0;
    return Number.isFinite(power) && power > 0 ? 10 * Math.log10(power) : null;
  }
  function frameDb(samples) {
    let squareSum = 0, sampleCount = 0;
    for (const sample of samples) {
      if (Number.isFinite(sample)) { squareSum += sample * sample; sampleCount++; }
    }
    return dbFromPower(squareSum, sampleCount);
  }
  function createWindow() {
    return { onsetMs: null, squareSum: 0, sampleCount: 0, lastFrameEnd: null };
  }
  // AnalyserNode returns overlapping snapshots of the most recent fftSize
  // PCM samples. Count each audio sample once and clip to onset + 500..2500ms.
  // endMs uses the same session clock as assessment; frameEnd uses audio frames.
  function captureFrame(window, samples, sampleRate, frameEnd, endMs) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(frameEnd) || !Number.isFinite(endMs)) return;
    const previousEnd = window.lastFrameEnd;
    if (previousEnd !== null && frameEnd <= previousEnd) return;
    window.lastFrameEnd = frameEnd;
    if (!Number.isFinite(window.onsetMs)) return;
    const startFrame = frameEnd - samples.length;
    const start = Math.max(0, previousEnd === null ? 0 : previousEnd - startFrame,
      Math.ceil(samples.length + (window.onsetMs + 500 - endMs) * sampleRate / 1000));
    const end = Math.min(samples.length,
      Math.ceil(samples.length + (window.onsetMs + 2500 - endMs) * sampleRate / 1000));
    for (let i = start; i < end; i++) {
      const sample = samples[i];
      if (Number.isFinite(sample)) { window.squareSum += sample * sample; window.sampleCount++; }
    }
  }
  function levelDb(window) {
    if (!window) return null;
    const db = dbFromPower(window.squareSum, window.sampleCount);
    return Number.isFinite(db) ? Math.round(db * 10) / 10 : null;
  }
  return { frameDb, createWindow, captureFrame, levelDb };
});
