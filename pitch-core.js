(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PitchCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function rmsDb(samples) {
    let sum = 0;
    let mean = 0;
    for (let i = 0; i < samples.length; i++) mean += samples[i];
    mean /= Math.max(1, samples.length);
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i] - mean;
      sum += x * x;
    }
    const rms = Math.sqrt(sum / Math.max(1, samples.length));
    return 20 * Math.log10(Math.max(rms, 1e-8));
  }

  function downsample2(input) {
    const out = new Float32Array(Math.floor(input.length / 2));
    for (let i = 0, j = 0; j < out.length; i += 2, j++) {
      out[j] = 0.5 * (input[i] + input[i + 1]);
    }
    return out;
  }

  function removeDcInPlace(samples) {
    let mean = 0;
    for (let i = 0; i < samples.length; i++) mean += samples[i];
    mean /= Math.max(1, samples.length);
    for (let i = 0; i < samples.length; i++) samples[i] -= mean;
  }

  function yin(samples, sampleRate, opts) {
    const minHz = opts?.minHz ?? 65;
    const maxHz = opts?.maxHz ?? 1200;
    const threshold = opts?.threshold ?? 0.16;

    const minTau = Math.max(2, Math.floor(sampleRate / maxHz));
    const maxTau = Math.min(Math.floor(sampleRate / minHz), Math.floor(samples.length / 2) - 2);
    if (maxTau <= minTau + 2) return null;

    const yinBuf = new Float32Array(maxTau + 1);
    const limit = samples.length - maxTau - 1;

    for (let tau = minTau; tau <= maxTau; tau++) {
      let sum = 0;
      for (let i = 0; i < limit; i++) {
        const d = samples[i] - samples[i + tau];
        sum += d * d;
      }
      yinBuf[tau] = sum;
    }

    yinBuf[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= maxTau; tau++) {
      running += yinBuf[tau];
      yinBuf[tau] = running > 0 ? (yinBuf[tau] * tau) / running : 1;
    }

    let tauEstimate = -1;
    for (let tau = minTau; tau <= maxTau; tau++) {
      if (yinBuf[tau] < threshold) {
        while (tau + 1 <= maxTau && yinBuf[tau + 1] < yinBuf[tau]) tau++;
        tauEstimate = tau;
        break;
      }
    }

    if (tauEstimate < 0) {
      let best = minTau;
      for (let tau = minTau + 1; tau <= maxTau; tau++) {
        if (yinBuf[tau] < yinBuf[best]) best = tau;
      }
      if (yinBuf[best] > 0.34) return null;
      tauEstimate = best;
    }

    const x0 = tauEstimate > 1 ? tauEstimate - 1 : tauEstimate;
    const x2 = tauEstimate + 1 <= maxTau ? tauEstimate + 1 : tauEstimate;
    let betterTau = tauEstimate;
    if (x0 !== tauEstimate && x2 !== tauEstimate) {
      const s0 = yinBuf[x0], s1 = yinBuf[tauEstimate], s2 = yinBuf[x2];
      const denom = 2 * (2 * s1 - s2 - s0);
      if (Math.abs(denom) > 1e-12) betterTau = tauEstimate + (s2 - s0) / denom;
    }

    const frequency = sampleRate / betterTau;
    const confidence = clamp(1 - yinBuf[tauEstimate], 0, 1);
    if (!Number.isFinite(frequency) || frequency < minHz * 0.92 || frequency > maxHz * 1.08) return null;
    return { frequency, confidence, periodicity: 1 - yinBuf[tauEstimate] };
  }

  function detectPitch(input, sampleRate, opts) {
    if (!input || input.length < 1024) return { frequency: null, confidence: 0, db: -160 };
    const db = rmsDb(input);
    const work = downsample2(input);
    removeDcInPlace(work);
    const result = yin(work, sampleRate / 2, opts);
    return result ? { ...result, db } : { frequency: null, confidence: 0, db };
  }

  function frequencyToMidi(frequency) {
    return 69 + 12 * Math.log2(frequency / 440);
  }

  function midiToFrequency(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  return { clamp, rmsDb, yin, detectPitch, frequencyToMidi, midiToFrequency };
});
