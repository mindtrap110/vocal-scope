/* AudioWorklet: copy microphone PCM to memory, never to the speakers. */
class VocalAPrimeCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.length = Math.round(3 * sampleRate);
    this.ring = new Float32Array(this.length + Math.round(sampleRate));
    this.end = 0;
    this.available = 0;
    this.onset = null;
    this.finished = false;
    this.port.onmessage = ({ data }) => {
      if (!Number.isInteger(data?.onsetFrame) || this.onset !== null) return;
      this.onset = data.onsetFrame;
      this.finishIfReady();
    };
  }

  finishIfReady() {
    if (this.finished || this.onset === null || this.end < this.onset + this.length) return;
    this.finished = true;
    if (this.onset < this.end - this.available) {
      this.port.postMessage({ type: 'gap' });
      return;
    }
    const pcm = new Float32Array(this.length);
    const offset = this.onset % this.ring.length;
    const head = Math.min(this.length, this.ring.length - offset);
    pcm.set(this.ring.subarray(offset, offset + head));
    pcm.set(this.ring.subarray(0, this.length - head), head);
    this.port.postMessage({ type: 'clip', samples: pcm }, [pcm.buffer]);
  }

  process(inputs) {
    // The output buffers are initialized to silence by Web Audio. Connecting
    // the silent output keeps the worklet running without mic monitoring.
    const samples = inputs[0]?.[0];
    if (this.finished || !samples?.length) return true;
    if (currentFrame !== this.end) this.available = 0;
    const offset = currentFrame % this.ring.length;
    const head = Math.min(samples.length, this.ring.length - offset);
    this.ring.set(samples.subarray(0, head), offset);
    this.ring.set(samples.subarray(head), 0);
    this.end = currentFrame + samples.length;
    this.available = Math.min(this.ring.length, this.available + samples.length);
    this.finishIfReady();
    return true;
  }
}

registerProcessor('vocal-a-prime-capture', VocalAPrimeCapture);
