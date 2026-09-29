'use strict';

(() => {
  const STORAGE_KEY = 'vocalScopeLyricPhrasesV1';
  const SELECTED_KEY = 'vocalScopeSelectedLyricPhraseV1';
  const MAX_PHRASES = 30;

  const runtime = {
    active: false,
    activePhrase: null,
    selectedId: null,
    previousTarget: null,
    takeNumber: 0,
    lastResult: '',
  };

  const V = () => window.VocalScope;
  const $ = id => document.getElementById(id);

  function makeId() {
    return `phrase-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function cleanLine(value, max) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function cleanLyrics(value) {
    return String(value || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\t ]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 240);
  }

  function normalizePhrase(value) {
    if (!value || typeof value !== 'object') return null;
    const title = cleanLine(value.title, 40);
    const lyrics = cleanLyrics(value.lyrics);
    if (!title || !lyrics) return null;
    const midi = Number(value.startMidi);
    return {
      id: cleanLine(value.id, 80) || makeId(),
      title,
      lyrics,
      startMidi: Number.isFinite(midi) && midi >= 36 && midi <= 96 ? Math.round(midi) : null,
      updatedAt: Number(value.updatedAt) || Date.now(),
    };
  }

  function readPhrases() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizePhrase).filter(Boolean).slice(0, MAX_PHRASES);
    } catch (_) {
      return [];
    }
  }

  function writePhrases(phrases) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(phrases.slice(0, MAX_PHRASES)));
      return true;
    } catch (error) {
      console.warn('phrase storage', error);
      V()?.showError?.('구절을 저장하지 못했습니다. Safari 저장 공간을 확인해 주세요.');
      return false;
    }
  }

  function rememberSelection(id) {
    runtime.selectedId = id || null;
    try {
      if (runtime.selectedId) localStorage.setItem(SELECTED_KEY, runtime.selectedId);
      else localStorage.removeItem(SELECTED_KEY);
    } catch (_) {}
  }

  function selectedPhrase() {
    const phrases = readPhrases();
    return phrases.find(item => item.id === runtime.selectedId) || phrases[0] || null;
  }

  function noteLabel(midi) {
    if (!Number.isFinite(midi)) return '';
    const note = V()?.noteFromMidi?.(midi);
    return note ? `${note.name} · ${note.korean}` : '';
  }

  function duration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '0초';
    return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}초`;
  }

  function currentDisplayPhrase() {
    return runtime.active && runtime.activePhrase ? runtime.activePhrase : selectedPhrase();
  }

  function populateNoteOptions() {
    const select = $('phraseStartMidiInput');
    if (!select || select.options.length > 1) return;
    for (let octave = 2; octave <= 5; octave++) {
      for (let pc = 0; pc < 12; pc++) {
        const midi = 12 * (octave + 1) + pc;
        const note = V()?.noteFromMidi?.(midi);
        if (!note) continue;
        const option = document.createElement('option');
        option.value = String(midi);
        option.textContent = `${note.name} · ${note.korean}`;
        select.appendChild(option);
      }
    }
  }

  function renderLibrary() {
    const host = $('phraseLibraryList');
    if (!host) return;
    host.replaceChildren();
    const phrases = readPhrases();
    if (!phrases.length) {
      const empty = document.createElement('p');
      empty.className = 'phrase-library-empty';
      empty.textContent = '저장된 구절이 없습니다. 짧게 반복할 가사를 먼저 만들어 보세요.';
      host.appendChild(empty);
      return;
    }

    phrases.forEach(phrase => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `phrase-library-row${phrase.id === runtime.selectedId ? ' selected' : ''}`;
      const text = document.createElement('span');
      const title = document.createElement('strong');
      const lyrics = document.createElement('small');
      const chevron = document.createElement('span');
      title.textContent = phrase.title;
      lyrics.textContent = phrase.lyrics.replace(/\n/g, ' / ');
      chevron.textContent = '›';
      text.append(title, lyrics);
      button.append(text, chevron);
      button.addEventListener('click', () => selectPhrase(phrase.id));
      host.appendChild(button);
    });
  }

  function render() {
    const phrase = currentDisplayPhrase();
    const empty = $('phraseEmpty');
    const ready = $('phraseReady');
    const card = $('phraseCard');
    if (!empty || !ready || !card) return;

    empty.classList.toggle('hidden', !!phrase);
    ready.classList.toggle('hidden', !phrase);
    card.classList.toggle('active', runtime.active);
    if (!phrase) {
      renderLibrary();
      return;
    }

    $('phraseTitle').textContent = phrase.title;
    $('phraseLyrics').textContent = phrase.lyrics;
    const start = $('phraseStartNote');
    start.classList.toggle('hidden', !Number.isFinite(phrase.startMidi));
    start.textContent = Number.isFinite(phrase.startMidi) ? `첫 음 ${noteLabel(phrase.startMidi)}` : '';

    const measuring = !!V()?.state?.measuring;
    const badge = $('phraseModeBadge');
    badge.classList.toggle('active', runtime.active && !measuring);
    badge.classList.toggle('live', runtime.active && measuring);
    badge.textContent = runtime.active ? (measuring ? `테이크 ${runtime.takeNumber} 측정 중` : '구절 모드 준비') : '준비';

    const practice = $('phrasePracticeBtn');
    practice.classList.toggle('live', runtime.active && measuring);
    if (!runtime.active) practice.textContent = '이 구절 연습';
    else if (measuring) practice.textContent = `테이크 ${runtime.takeNumber} 종료`;
    else practice.textContent = runtime.takeNumber ? '다시 부르기' : '첫 테이크 시작';

    const tone = $('phraseToneBtn');
    tone.disabled = measuring || !Number.isFinite(phrase.startMidi);
    tone.textContent = Number.isFinite(phrase.startMidi) ? '첫 음 듣기' : '첫 음 미설정';
    $('phraseDeactivateBtn').classList.toggle('hidden', !runtime.active);
    $('phraseEditBtn').disabled = measuring || !!phrase.temporary;
    $('phraseLibraryBtn').disabled = measuring;
    const targetButton = $('targetBtn');
    if (targetButton) targetButton.disabled = runtime.active;

    const result = $('phraseLastResult');
    result.classList.toggle('hidden', !runtime.lastResult);
    result.textContent = runtime.lastResult;
    renderLibrary();
  }

  function openLibrary() {
    if (V()?.state?.measuring) {
      V()?.showError?.('현재 테이크를 끝낸 뒤 구절을 바꿔 주세요.');
      return;
    }
    renderLibrary();
    $('phraseLibraryDialog')?.showModal();
  }

  function openEditor(id = null) {
    if (V()?.state?.measuring) {
      V()?.showError?.('현재 테이크를 끝낸 뒤 구절을 편집해 주세요.');
      return;
    }
    const phrase = id ? readPhrases().find(item => item.id === id) : null;
    $('phraseEditorId').value = phrase?.id || '';
    $('phraseTitleInput').value = phrase?.title || '';
    $('phraseLyricsInput').value = phrase?.lyrics || '';
    $('phraseStartMidiInput').value = Number.isFinite(phrase?.startMidi) ? String(phrase.startMidi) : '';
    $('phraseEditorHeading').textContent = phrase ? '구절 편집' : '구절 만들기';
    $('phraseDeleteBtn').classList.toggle('hidden', !phrase);
    $('phraseEditorError').textContent = '';
    updateLyricsCount();
    $('phraseLibraryDialog')?.close();
    $('phraseEditorDialog')?.showModal();
    setTimeout(() => $('phraseTitleInput')?.focus(), 80);
  }

  function closeEditor() {
    $('phraseEditorDialog')?.close();
  }

  function updateLyricsCount() {
    const count = $('phraseLyricsInput')?.value?.length || 0;
    if ($('phraseLyricsCount')) $('phraseLyricsCount').textContent = String(count);
  }

  function saveEditor(event) {
    event.preventDefault();
    const id = cleanLine($('phraseEditorId').value, 80);
    const title = cleanLine($('phraseTitleInput').value, 40);
    const lyrics = cleanLyrics($('phraseLyricsInput').value);
    const startValue = $('phraseStartMidiInput').value;
    const startMidi = startValue === '' ? null : Number(startValue);
    if (!title || !lyrics) {
      $('phraseEditorError').textContent = '구절 이름과 가사를 모두 입력해 주세요.';
      return;
    }

    const phrases = readPhrases();
    const phrase = normalizePhrase({ id: id || makeId(), title, lyrics, startMidi, updatedAt: Date.now() });
    const index = phrases.findIndex(item => item.id === phrase.id);
    if (index >= 0) phrases.splice(index, 1);
    phrases.unshift(phrase);
    if (!writePhrases(phrases)) return;
    rememberSelection(phrase.id);
    if (runtime.active && runtime.activePhrase?.id === phrase.id) runtime.activePhrase = { ...phrase };
    runtime.lastResult = '';
    closeEditor();
    render();
  }

  function deleteEditedPhrase() {
    const id = cleanLine($('phraseEditorId').value, 80);
    if (!id) return;
    const phrase = readPhrases().find(item => item.id === id);
    if (!phrase || !confirm(`‘${phrase.title}’ 구절을 삭제할까요?`)) return;
    if (runtime.active && runtime.activePhrase?.id === id) deactivate({ restoreTarget: true });
    const remaining = readPhrases().filter(item => item.id !== id);
    if (!writePhrases(remaining)) return;
    rememberSelection(remaining[0]?.id || null);
    closeEditor();
    render();
  }

  function selectPhrase(id) {
    const phrase = readPhrases().find(item => item.id === id);
    if (!phrase) return;
    if (runtime.active) deactivate({ restoreTarget: true });
    rememberSelection(id);
    runtime.lastResult = '';
    $('phraseLibraryDialog')?.close();
    render();
  }

  function activate(phrase = selectedPhrase()) {
    const normalized = normalizePhrase(phrase);
    if (!normalized) {
      openEditor();
      return false;
    }
    if (V()?.state?.measuring) {
      V()?.showError?.('현재 측정을 끝낸 뒤 가사 구절 연습을 시작해 주세요.');
      return false;
    }
    if (window.VocalTrainer?.isActive?.()) window.VocalTrainer.stop();
    runtime.active = true;
    runtime.activePhrase = { ...normalized, temporary: !!phrase.temporary };
    runtime.previousTarget = Number.isFinite(V()?.state?.targetMidi) ? V().state.targetMidi : null;
    runtime.takeNumber = 0;
    runtime.lastResult = '';
    V()?.setTarget?.(null, { transient: true });
    render();
    return true;
  }

  function deactivate({ restoreTarget = true } = {}) {
    if (!runtime.active) return;
    if (V()?.state?.measuring) V()?.stopMeasurement?.('phrase-end');
    const previous = runtime.previousTarget;
    runtime.active = false;
    runtime.activePhrase = null;
    runtime.previousTarget = null;
    runtime.takeNumber = 0;
    if (restoreTarget) V()?.setTarget?.(Number.isFinite(previous) ? previous : null);
    render();
  }

  async function togglePractice() {
    if (V()?.state?.measuring) {
      if (runtime.active) V()?.stopMeasurement?.('phrase-take');
      else V()?.showError?.('현재 측정을 먼저 종료해 주세요.');
      return;
    }
    if (!runtime.active && !activate()) return;
    await V()?.startMeasurement?.();
    render();
  }

  async function playStartTone() {
    const phrase = currentDisplayPhrase();
    if (!Number.isFinite(phrase?.startMidi)) return;
    try {
      if (window.VocalScopeReferenceTone?.play) await window.VocalScopeReferenceTone.play(phrase.startMidi, 1100);
      else await V()?.playReferenceTone?.(phrase.startMidi, 900);
    } catch (error) {
      V()?.showError?.(String(error?.message || error));
    }
  }

  function showLatestResult() {
    if (!runtime.active || !runtime.activePhrase) return;
    const sessions = window.VocalHistory?.readSessions?.() || [];
    const latest = sessions.find(item =>
      item?.plan?.type === 'phrase' &&
      item.plan.phraseId === runtime.activePhrase.id
    );
    if (!latest) {
      runtime.lastResult = `테이크 ${runtime.takeNumber}: 분석 가능한 음정이 없어 기록되지 않았습니다.`;
      render();
      return;
    }
    const low = V()?.noteFromMidi?.(latest.minMidi)?.name || '—';
    const high = V()?.noteFromMidi?.(latest.maxMidi)?.name || '—';
    runtime.lastResult = `테이크 ${runtime.takeNumber} 저장 · 실제 음역 ${low}–${high} · 유효 음성 ${duration(latest.voicedMs)}`;
    render();
  }

  function getPlanSnapshot() {
    if (!runtime.active || !runtime.activePhrase) return null;
    const phrase = runtime.activePhrase;
    return {
      type: 'phrase',
      phraseId: phrase.id,
      label: phrase.title,
      lyrics: phrase.lyrics,
      startMidi: Number.isFinite(phrase.startMidi) ? phrase.startMidi : null,
    };
  }

  function startFromPlan(plan) {
    if (!plan || plan.type !== 'phrase' || V()?.state?.measuring) return false;
    const saved = readPhrases().find(item => item.id === plan.phraseId);
    const phrase = saved || normalizePhrase({
      id: plan.phraseId || makeId(),
      title: plan.label || '과거 가사 구절',
      lyrics: plan.lyrics || '가사 정보 없음',
      startMidi: plan.startMidi,
      updatedAt: Date.now(),
    });
    if (!phrase) return false;
    if (saved) rememberSelection(saved.id);
    const activated = activate({ ...phrase, temporary: !saved });
    if (activated) {
      document.getElementById('phraseCard')?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }
    return activated;
  }

  function wireUi() {
    populateNoteOptions();
    try {
      runtime.selectedId = localStorage.getItem(SELECTED_KEY);
    } catch (_) {}
    const phrases = readPhrases();
    if (!phrases.some(item => item.id === runtime.selectedId)) rememberSelection(phrases[0]?.id || null);

    $('phraseLibraryBtn')?.addEventListener('click', openLibrary);
    $('phraseCreateBtn')?.addEventListener('click', () => openEditor());
    $('phraseLibraryCreateBtn')?.addEventListener('click', () => openEditor());
    $('phraseEditBtn')?.addEventListener('click', () => openEditor(currentDisplayPhrase()?.id));
    $('phraseEditorCloseBtn')?.addEventListener('click', closeEditor);
    $('phraseEditorForm')?.addEventListener('submit', saveEditor);
    $('phraseLyricsInput')?.addEventListener('input', updateLyricsCount);
    $('phraseDeleteBtn')?.addEventListener('click', deleteEditedPhrase);
    $('phrasePracticeBtn')?.addEventListener('click', togglePractice);
    $('phraseToneBtn')?.addEventListener('click', playStartTone);
    $('phraseDeactivateBtn')?.addEventListener('click', () => deactivate({ restoreTarget: true }));

    window.addEventListener('vs:measurement-start', () => {
      if (!runtime.active) return;
      runtime.takeNumber += 1;
      runtime.lastResult = '';
      render();
    });
    window.addEventListener('vs:measurement-stop', () => {
      if (!runtime.active) return;
      setTimeout(showLatestResult, 0);
    });
    window.addEventListener('vs:target-change', () => {
      if (!runtime.active) render();
    });
    render();
  }

  document.addEventListener('DOMContentLoaded', wireUi);

  window.VocalPhrasePractice = {
    isActive: () => runtime.active,
    getPlanSnapshot,
    startFromPlan,
    deactivate,
    openEditor,
    readPhrases,
  };
})();
