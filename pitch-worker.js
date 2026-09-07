importScripts('./pitch-core.js');

self.onmessage = (event) => {
  const { type, samples, sampleRate, options } = event.data || {};
  if (type !== 'analyze' || !samples || !sampleRate) return;
  try {
    const input = samples instanceof Float32Array ? samples : new Float32Array(samples);
    const result = self.PitchCore.detectPitch(input, sampleRate, options || {});
    self.postMessage({ type: 'result', ...result, timestamp: performance.now() });
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || String(error) });
  }
};
