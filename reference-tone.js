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
      .reference-tone-btn{flex:1;min-height:44px;border:1px solid rgba(124,156,255,.28);border-radius:14px;background:rgba(124,156,255,.08);color:#e8efff;font:inherit;font-weight:700}
      .reference-tone-btn:active{transform:scale(.985)}
      .reference-tone-btn[disabled]{opacity:.45}
      .reference-tone-hint{margin-top:7px;color:var(--muted,#9aa7c3);font-size:10px;line-height:1.45}
    `;
    document.head.appendChild(style);
  }

  async function ensureAudioContext() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('이 브라우저는 기준음 재생을 지원하지 않습니다.');
    if (!toneContext || toneContext.state === 'closed') {
      toneContext = new AudioCtx({ latencyHint:'interactive' });
    }
    if (toneContext.state === 'suspended') await toneContext.resume();
    return toneContext;
  }

  function stopActiveTone() {
    for (const node of activeNodes) {
      try { node.stop?.(); } catch (_) {}
      try { node.disconnect?.(); } catch (_) {}
    }
    activeNodes = [];
  }

  async function playMidi(midi, durationMs=850) {
    if (!Number.isFinite(midi)) return;
    const ctx = await ensureAudioContext();
    stopActiveTone();

    const now = ctx.currentTime;
    const end = now + durationMs / 1000;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(440 * Math.pow(2, (midi - 69) / 12), now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.025);
    gain.gain.setValueAtTime(0.18, Math.max(now + 0.03, end - 0.08));
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    oscillator.connect(gain);
    gain.connect(ctx.destination);
    activeNodes = [oscillator, gain];

    playingUntil = performance.now() + durationMs + 250;
    oscillator.start(now);
    oscillator.stop(end + 0.02);

    const button = document.getElementById('referenceToneBtn');
    if (button) {
      const old = button.textContent;
      button.textContent = '재생 중…';
      button.disabled = true;
      setTimeout(() => {
        button.textContent = old;
        button.disabled = !Number.isFinite(state?.targetMidi);
      }, durationMs + 80);
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
        label.textContent = `${note.name} · ${note.korean} 기준음을 약 0.85초 재생합니다. 재생 중에는 마이크 판정을 잠시 무시합니다.`;
      } else {
        label.textContent = '먼저 위의 측정 기준에서 목표음을 선택하세요.';
      }
    }
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

    panel.appendChild(row);
    panel.appendChild(hint);

    document.getElementById('referenceToneBtn').addEventListener('click', () => {
      playMidi(state?.targetMidi).catch(error => {
        if (typeof showError === 'function') showError(String(error?.message || error));
      });
    });
    refreshButton();
  }

  // Prevent the iPhone speaker's reference tone from becoming practice data.
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
    setTarget = function(midi) {
      const result = originalSetTarget.call(this, midi);
      refreshButton();
      return result;
    };
  }

  window.VocalScopeReferenceTone = {
    play: playMidi,
    stop: stopActiveTone,
    get isPlaying() { return performance.now() < playingUntil; }
  };

  document.addEventListener('DOMContentLoaded', () => {
    installUi();
    refreshButton();
  });
})();