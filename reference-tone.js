'use strict';

(() => {
  let toneContext = null;
  let playingUntil = 0;
  let activeNodes = [];

  function ensureStyles() {
    if (document.getElementById('referenceToneStyles')) return;
    const style = document.createElement('style');
    style.id = 'referenceToneStyles';
    style.textContent = `
      .reference-tone-row{display:flex;gap:8px;margin-top:12px}
      .reference-tone-btn{flex:1;min-height:46px;border:1px solid rgba(124,156,255,.28);border-radius:14px;background:rgba(124,156,255,.08);color:#e8efff;font:inherit;font-weight:750}
      .reference-tone-btn:active{transform:scale(.985)}
      .reference-tone-btn[disabled]{opacity:.45}
      .reference-tone-hint{margin-top:7px;color:var(--muted,#9aa7c3);font-size:11px;line-height:1.45}
      .reference-tone-status{margin-top:5px;font-size:11px;line-height:1.4;color:#8ee8d3}
      .reference-tone-status.error{color:#ffb4b4}
    `;
    document.head.appendChild(style);
  }

  function setStatus(text, error=false) {
    const el = document.getElementById('referenceToneStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('error', !!error);
  }

  async function ensureAudioContext() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('이 브라우저는 기준음 재생을 지원하지 않습니다.');

    if (!toneContext || toneContext.state === 'closed') {
      try {
        toneContext = new AudioCtx({ latencyHint:'interactive' });
      } catch (_) {
        toneContext = new AudioCtx();
      }
    }

    if (toneContext.state === 'suspended' || toneContext.state === 'interrupted') {
      await toneContext.resume();
    }

    // iOS sometimes needs one silent buffer started directly from the tap gesture.
    if (toneContext.state !== 'running') {
      try {
        const buffer = toneContext.createBuffer(1, 1, toneContext.sampleRate || 44100);
        const source = toneContext.createBufferSource();
        source.buffer = buffer;
        source.connect(toneContext.destination);
        source.start(0);
        await toneContext.resume();
      } catch (_) {}
    }

    if (toneContext.state !== 'running') {
      throw new Error('오디오가 시작되지 않았습니다. iPhone 음량을 확인한 뒤 다시 눌러 주세요.');
    }
    return toneContext;
  }

  function stopActiveTone() {
    for (const node of activeNodes) {
      try { node.stop?.(); } catch (_) {}
      try { node.disconnect?.(); } catch (_) {}
    }
    activeNodes = [];
  }

  function midiFrequency(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  async function playMidi(midi, durationMs=1100) {
    if (!Number.isFinite(midi)) {
      setStatus('먼저 목표음을 선택해 주세요.', true);
      return;
    }

    const ctx = await ensureAudioContext();
    stopActiveTone();

    const f0 = midiFrequency(midi);
    const now = ctx.currentTime + 0.015;
    const end = now + durationMs / 1000;

    // A2/G2 같은 저음 순수 사인파는 iPhone 스피커에서 매우 작게 들릴 수 있다.
    // 기본 주파수에 2·3·4배 고조파를 섞어 음높이는 유지하면서 휴대폰에서도 잘 들리게 한다.
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(0.32, now + 0.035);
    master.gain.setValueAtTime(0.32, Math.max(now + 0.05, end - 0.12));
    master.gain.exponentialRampToValueAtTime(0.0001, end);
    master.connect(ctx.destination);

    const partials = [
      { multiple:1, gain:0.78 },
      { multiple:2, gain:0.32 },
      { multiple:3, gain:0.18 },
      { multiple:4, gain:0.10 }
    ];

    const nodes = [master];
    for (const part of partials) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f0 * part.multiple, now);
      gain.gain.setValueAtTime(part.gain, now);
      osc.connect(gain);
      gain.connect(master);
      osc.start(now);
      osc.stop(end + 0.03);
      nodes.push(osc, gain);
    }
    activeNodes = nodes;

    playingUntil = performance.now() + durationMs + 300;

    const note = typeof noteFromMidi === 'function' ? noteFromMidi(midi) : { name:'기준음' };
    setStatus(`${note.name} · ${f0.toFixed(1)} Hz 재생 중`);

    const button = document.getElementById('referenceToneBtn');
    if (button) {
      const old = button.dataset.idleText || button.textContent || '🔊 기준음 듣기';
      button.dataset.idleText = old;
      button.textContent = '🔊 재생 중…';
      button.disabled = true;
      setTimeout(() => {
        button.textContent = old;
        button.disabled = !Number.isFinite(state?.targetMidi);
        setStatus('재생 완료');
      }, durationMs + 120);
    }
  }

  function refreshButton() {
    const button = document.getElementById('referenceToneBtn');
    const label = document.getElementById('referenceToneHint');
    if (!button) return;

    const midi = state?.targetMidi;
    const enabled = Number.isFinite(midi);
    button.disabled = !enabled;

    if (label) {
      if (enabled) {
        const note = noteFromMidi(midi);
        const hz = midiFrequency(midi).toFixed(1);
        label.textContent = `${note.name} · ${note.korean} · ${hz} Hz — 버튼을 누르면 약 1.1초 재생됩니다.`;
      } else {
        label.textContent = '먼저 위의 측정 기준에서 목표음을 선택하세요.';
      }
    }
    setStatus('');
  }

  function installUi() {
    ensureStyles();
    const panel = document.getElementById('targetPanel');
    if (!panel || document.getElementById('referenceToneBtn')) return;

    const row = document.createElement('div');
    row.className = 'reference-tone-row';
    row.innerHTML = '<button id="referenceToneBtn" type="button" class="reference-tone-btn">🔊 기준음 듣기</button>';

    const hint = document.createElement('div');
    hint.id = 'referenceToneHint';
    hint.className = 'reference-tone-hint';

    const status = document.createElement('div');
    status.id = 'referenceToneStatus';
    status.className = 'reference-tone-status';
    status.setAttribute('aria-live', 'polite');

    panel.appendChild(row);
    panel.appendChild(hint);
    panel.appendChild(status);

    document.getElementById('referenceToneBtn').addEventListener('click', async () => {
      const midi = state?.targetMidi;
      try {
        await playMidi(midi);
      } catch (error) {
        console.error('reference tone', error);
        setStatus(String(error?.message || error), true);
      }
    });

    refreshButton();
  }

  // 스피커의 기준음을 사용자의 발성으로 저장하지 않는다.
  if (typeof onPitchResult === 'function') {
    const originalPitchResult = onPitchResult;
    onPitchResult = function(result) {
      if (performance.now() < playingUntil) {
        state.workerBusy = false;
        return;
      }
      return originalPitchResult.call(this, result);
    };
  }

  if (typeof setTarget === 'function') {
    const originalSetTarget = setTarget;
    setTarget = function(midi, options={}) {
      const result = originalSetTarget.call(this, midi, options);
      refreshButton();
      return result;
    };
  }

  window.VocalScopeReferenceTone = {
    play: playMidi,
    stop: stopActiveTone,
    get contextState() { return toneContext?.state || 'not-created'; },
    get isPlaying() { return performance.now() < playingUntil; }
  };

  document.addEventListener('DOMContentLoaded', () => {
    installUi();
    refreshButton();
  });
})();