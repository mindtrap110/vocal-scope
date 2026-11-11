(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VocalAPrime = api;
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict';

  const PROTOCOL = 'a-prime';
  const MIC_FIELDS = ['echoCancellation', 'noiseSuppression', 'autoGainControl'];
  const DIRECTIONS = { high: '높음', match: '맞음', low: '낮음' };

  function validJudgement(judgement) {
    return Object.hasOwn(DIRECTIONS, judgement?.direction) && [1, 2, 3].includes(judgement.confidence);
  }
  function judgementText(judgement) {
    return validJudgement(judgement) ? `${DIRECTIONS[judgement.direction]} · 확신도 ${judgement.confidence}` : '미입력';
  }
  function isInitial(record) {
    return record?.training?.protocol === PROTOCOL && record.training.stage === 'initial';
  }
  function isPending(record) {
    return isInitial(record) && !(validJudgement(record.training.realtimeJudgement) && validJudgement(record.training.playbackJudgement));
  }
  function isBlind(record) {
    const t = record?.training;
    return isPending(record) || (t?.protocol === PROTOCOL && t.stage === 'discarded' && Object.hasOwn(t, 'realtimeJudgement'));
  }
  function sessionRows(records, date) {
    return records.filter(record => isInitial(record) && !isPending(record) && record.training.dayId === date)
      .sort((a, b) => a.createdAt - b.createdAt || a.training.trial - b.training.trial);
  }

  function micSettings(stream, fallbackConstraints) {
    let actual;
    try { actual = stream?.getAudioTracks?.()[0]?.getSettings?.(); } catch (_) {}
    const info = { fallbackConstraints: !!fallbackConstraints };
    for (const key of MIC_FIELDS) {
      const value = actual?.[key];
      // Echo cancellation may also report a named cancellation mode.
      info[key] = typeof value === 'boolean' || (key === 'echoCancellation' && typeof value === 'string') ? value : null;
    }
    return info;
  }

  async function connectCapture({ audioContext, source, stream, fallbackConstraints, version }) {
    if (!audioContext.audioWorklet || typeof root.AudioWorkletNode !== 'function') {
      throw new Error('이 브라우저는 A′ 녹음에 필요한 오디오 기능을 지원하지 않습니다. Safari에서 다시 열어 주세요.');
    }
    const url = new URL(`./a-prime-pcm.js?v=${version}`, root.document.baseURI);
    await audioContext.audioWorklet.addModule(url.href);
    if (audioContext.state === 'closed') throw new Error('마이크 연결이 중단되었습니다.');
    const node = new root.AudioWorkletNode(audioContext, 'vocal-a-prime-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: 'explicit',
    });
    let disposed = false, marked = false;
    const take = {
      clip: null,
      failed: false,
      micSettings: micSettings(stream, fallbackConstraints),
      markOnset() {
        if (disposed || marked) return;
        marked = true;
        try { node.port.postMessage({ onsetFrame: Math.round(audioContext.currentTime * audioContext.sampleRate) }); }
        catch (_) { take.failed = true; }
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        node.port.onmessage = null;
        node.onprocessorerror = null;
        try { node.port.close(); } catch (_) {}
        try { source.disconnect(node); } catch (_) {}
        try { node.disconnect(); } catch (_) {}
      },
    };
    node.port.onmessage = ({ data }) => {
      if (disposed) return;
      if (data?.type === 'clip' && data.samples?.length === Math.round(audioContext.sampleRate * 3)) {
        take.clip = { samples: data.samples, sampleRate: audioContext.sampleRate };
      } else take.failed = true;
    };
    node.onprocessorerror = () => { take.failed = true; };
    try { source.connect(node); node.connect(audioContext.destination); }
    catch (error) { take.dispose(); throw error; }
    return take;
  }

  const CSV_HEADER = [
    'session_date', 'recorded_at_iso', 'trial', 'target_note', 'error_cents', 'level_dbfs',
    'realtime_direction', 'realtime_confidence', 'playback_direction', 'playback_confidence',
    'pre_reveal_plays', 'post_reveal_plays', 'screen_correction_used',
    'echo_cancellation', 'noise_suppression', 'auto_gain_control', 'mic_fallback',
  ];
  function csvCell(value) {
    const string = String(value ?? '');
    return /[",\r\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
  }
  function buildCSV(rows) {
    const lines = rows.map(record => {
      const t = record.training;
      const mic = t.micSettings || {};
      return [t.dayId, new Date(record.createdAt).toISOString(), t.trial, t.targetNote,
        record.assessment?.medianCents, record.levelDb, t.realtimeJudgement.direction, t.realtimeJudgement.confidence,
        t.playbackJudgement.direction, t.playbackJudgement.confidence, t.preRevealPlays, t.postRevealPlays,
        !!t.screenCorrectionUsed, ...MIC_FIELDS.map(key => mic[key] ?? 'unknown'), mic.fallbackConstraints ?? 'unknown'];
    });
    return '\ufeff' + [CSV_HEADER, ...lines].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  function writeTag(view, at, tag) {
    for (let i = 0; i < tag.length; i++) view.setUint8(at + i, tag.charCodeAt(i));
  }
  function encodeWav({ samples, sampleRate }) {
    const bytes = new Uint8Array(44 + 2 * samples.length);
    const view = new DataView(bytes.buffer);
    writeTag(view, 0, 'RIFF'); view.setUint32(4, bytes.length - 8, true);
    writeTag(view, 8, 'WAVEfmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeTag(view, 36, 'data'); view.setUint32(40, bytes.length - 44, true);
    for (let i = 0; i < samples.length; i++) {
      const sample = Math.min(1, Math.max(-1, samples[i]));
      view.setInt16(44 + 2 * i, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
    return bytes;
  }

  function wavName(record) {
    const t = record.training;
    return `${t.dayId}_${String(t.trial).padStart(2, '0')}_${t.targetNote}.wav`;
  }

  // Stored ZIP entries keep the download to one file without a dependency or
  // async compression between the export tap and the iOS share sheet.
  function makeZip(files) {
    const table = Uint32Array.from({ length: 256 }, (_, n) => {
      for (let i = 0; i < 8; i++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
      return n;
    });
    const entries = files.map(({ name, bytes }) => {
      const encoded = new TextEncoder().encode(name);
      let crc = 0xffffffff;
      for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
      return { name: encoded, bytes, crc: (crc ^ 0xffffffff) >>> 0 };
    });
    const localSize = entries.reduce((n, e) => n + 30 + e.name.length + e.bytes.length, 0);
    const directorySize = entries.reduce((n, e) => n + 46 + e.name.length, 0);
    const zip = new Uint8Array(localSize + directorySize + 22);
    const view = new DataView(zip.buffer);
    const u16 = (at, value) => view.setUint16(at, value, true);
    const u32 = (at, value) => view.setUint32(at, value, true);
    let local = 0, central = localSize;
    for (const e of entries) {
      u32(local, 0x04034b50); u16(local + 4, 20); u16(local + 6, 0x800); u16(local + 12, 0x21);
      u32(local + 14, e.crc); u32(local + 18, e.bytes.length); u32(local + 22, e.bytes.length); u16(local + 26, e.name.length);
      zip.set(e.name, local + 30); zip.set(e.bytes, local + 30 + e.name.length);
      u32(central, 0x02014b50); u16(central + 4, 20); u16(central + 6, 20); u16(central + 8, 0x800); u16(central + 14, 0x21);
      u32(central + 16, e.crc); u32(central + 20, e.bytes.length); u32(central + 24, e.bytes.length); u16(central + 28, e.name.length);
      u32(central + 42, local); zip.set(e.name, central + 46);
      local += 30 + e.name.length + e.bytes.length; central += 46 + e.name.length;
    }
    u32(central, 0x06054b50); u16(central + 8, entries.length); u16(central + 10, entries.length);
    u32(central + 12, directorySize); u32(central + 16, localSize);
    return zip;
  }

  return { PROTOCOL, MIC_FIELDS, validJudgement, judgementText, isInitial, isPending, isBlind, sessionRows,
    micSettings, connectCapture, buildCSV, encodeWav, wavName, makeZip };
});
