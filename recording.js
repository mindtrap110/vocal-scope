'use strict';

(() => {
  const DB_NAME = 'vocalScopeAudioV1';
  const DB_VERSION = 1;
  const STORE_NAME = 'recordings';
  const ENABLED_KEY = 'vocalScopeRecordingEnabledV1';
  const AUDIO_BITS_PER_SECOND = 128000;

  const state = {
    supported: false,
    enabled: false,
    recorder: null,
    current: null,
    dbPromise: null,
    libraryUrls: [],
    sessionUrl: null,
    sessionRecording: null,
    sessionRenderToken: 0,
  };

  const $ = id => document.getElementById(id);
  const V = () => window.VocalScope;

  function toast(message) {
    const element = $('saveToast');
    if (!element) return;
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove('show'), 2600);
  }

  function duration(ms) {
    const value = Math.max(0, Number(ms) || 0);
    if (value < 1000) return `${Math.round(value)}ms`;
    if (value < 60000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}초`;
    const totalSeconds = Math.round(value / 1000);
    return `${Math.floor(totalSeconds / 60)}분 ${totalSeconds % 60}초`;
  }

  function bytes(value) {
    const size = Math.max(0, Number(value) || 0);
    if (size < 1024) return `${Math.round(size)}B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10240 ? 1 : 0)}KB`;
    return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)}MB`;
  }

  function fullDate(timestamp) {
    return new Date(timestamp).toLocaleString('ko-KR', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }

  function chooseMimeType(MediaRecorderClass = window.MediaRecorder) {
    if (!MediaRecorderClass) return '';
    const candidates = [
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
    ];
    if (typeof MediaRecorderClass.isTypeSupported !== 'function') return '';
    return candidates.find(type => {
      try { return MediaRecorderClass.isTypeSupported(type); } catch (_) { return false; }
    }) || '';
  }

  function normalizeMimeType(value) {
    const type = String(value || '').toLowerCase();
    if (type.includes('mp4')) return 'audio/mp4';
    if (type.includes('ogg')) return 'audio/ogg';
    if (type.includes('webm')) return 'audio/webm';
    return type || 'audio/webm';
  }

  function extensionForMime(value) {
    const type = normalizeMimeType(value);
    if (type.includes('mp4')) return 'm4a';
    if (type.includes('ogg')) return 'ogg';
    return 'webm';
  }

  function safeName(value) {
    return String(value || '연습')
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 36) || '연습';
  }

  function filenameFor(record) {
    const date = new Date(record?.createdAt || Date.now());
    const stamp = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
      String(date.getHours()).padStart(2, '0') + String(date.getMinutes()).padStart(2, '0') + String(date.getSeconds()).padStart(2, '0'),
    ].join('-');
    return `vocal-scope-${stamp}-${safeName(record?.label)}.${record?.extension || extensionForMime(record?.mimeType)}`;
  }

  function practiceLabel() {
    const phrase = window.VocalPhrasePractice?.getPlanSnapshot?.();
    if (phrase?.label) return phrase.label;
    const interval = window.VocalTrainer?.getPlanSnapshot?.();
    if (interval?.label) return `간격 ${interval.label}`;
    const target = V()?.state?.targetMidi;
    if (Number.isFinite(target)) return `목표음 ${V()?.noteFromMidi?.(target)?.name || Math.round(target)}`;
    return '자유 측정';
  }

  function openDatabase() {
    if (state.dbPromise) return state.dbPromise;
    state.dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB unavailable'));
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(request.error || new Error('recording database open failed'));
      request.onblocked = () => reject(new Error('recording database blocked'));
    }).catch(error => {
      state.dbPromise = null;
      throw error;
    });
    return state.dbPromise;
  }

  async function getAllRecordings() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve((request.result || []).sort((a, b) => b.createdAt - a.createdAt));
      request.onerror = () => reject(request.error || tx.error);
    });
  }

  async function putRecording(record) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error || new Error('recording save failed'));
      tx.onabort = () => reject(tx.error || new Error('recording save aborted'));
    });
  }

  async function deleteRecordingById(id) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('recording delete failed'));
    });
  }

  async function clearRecordingStore() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('recording clear failed'));
    });
  }

  function readEnabled() {
    try { return localStorage.getItem(ENABLED_KEY) === 'true'; } catch (_) { return false; }
  }

  function writeEnabled(value) {
    try { localStorage.setItem(ENABLED_KEY, value ? 'true' : 'false'); } catch (_) {}
  }

  function renderState() {
    const toggle = $('recordingEnabledToggle');
    const label = $('recordingToggleLabel');
    const status = $('recordingStatus');
    const isRecording = state.recorder?.state === 'recording';
    if (toggle) {
      toggle.checked = state.enabled;
      toggle.disabled = !state.supported || !!V()?.state?.measuring;
    }
    if (label) label.textContent = isRecording ? '녹음 중' : (state.enabled ? '켜짐' : '꺼짐');
    if (status) {
      status.classList.toggle('live', isRecording);
      status.textContent = !state.supported
        ? '이 브라우저에서는 녹음을 저장할 수 없습니다.'
        : isRecording
          ? '현재 측정의 음성을 녹음하고 있습니다.'
          : state.enabled
            ? '다음 측정을 시작하면 음성도 함께 저장합니다.'
            : '필요할 때 켜면 다음 측정부터 녹음합니다.';
    }
  }

  async function refreshStorageSummary() {
    const element = $('recordingStorageSummary');
    if (!element) return;
    if (!state.supported) {
      element.textContent = '녹음 저장 미지원';
      return;
    }
    try {
      const recordings = await getAllRecordings();
      const total = recordings.reduce((sum, item) => sum + (Number(item.size) || Number(item.blob?.size) || 0), 0);
      element.textContent = `저장된 녹음 ${recordings.length}개 · ${bytes(total)}`;
    } catch (error) {
      console.warn('recording summary', error);
      element.textContent = '저장 공간을 확인하지 못했습니다';
    }
  }

  function createRecorder(stream, mimeType) {
    const options = { audioBitsPerSecond: AUDIO_BITS_PER_SECOND };
    if (mimeType) options.mimeType = mimeType;
    try {
      return new MediaRecorder(stream, options);
    } catch (firstError) {
      try { return new MediaRecorder(stream); } catch (_) { throw firstError; }
    }
  }

  function startRecording() {
    renderState();
    if (!state.enabled || !state.supported) return;
    const stream = V()?.getCurrentStream?.();
    if (!stream?.getAudioTracks?.().some(track => track.readyState === 'live')) {
      toast('녹음을 시작할 마이크 입력을 찾지 못했습니다.');
      return;
    }
    const mimeType = chooseMimeType();
    let recorder;
    try {
      recorder = createRecorder(stream, mimeType);
    } catch (error) {
      console.warn('MediaRecorder start', error);
      toast('이 기기에서 녹음을 시작하지 못했습니다.');
      return;
    }
    const capture = {
      id: `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      createdAt: Date.now(),
      startedPerf: performance.now(),
      label: practiceLabel(),
      chunks: [],
      sessionIds: new Set(),
      requestedMimeType: mimeType,
      stopReason: 'user',
      finalized: false,
    };
    recorder.ondataavailable = event => {
      if (event.data?.size) capture.chunks.push(event.data);
    };
    recorder.onerror = event => {
      console.warn('MediaRecorder error', event.error || event);
      toast('녹음 중 오류가 발생했습니다. 음정 기록은 계속됩니다.');
    };
    recorder.onstop = () => finalizeCapture(capture, recorder);
    try {
      recorder.start(1000);
      state.recorder = recorder;
      state.current = capture;
      renderState();
    } catch (error) {
      console.warn('MediaRecorder start call', error);
      toast('녹음을 시작하지 못했습니다. 음정 측정만 계속합니다.');
    }
  }

  function stopRecording(reason = 'user') {
    const recorder = state.recorder;
    const capture = state.current;
    if (!recorder || !capture) {
      setTimeout(renderState, 0);
      return;
    }
    capture.stopReason = reason;
    if (recorder.state !== 'inactive') {
      try { recorder.stop(); } catch (error) { console.warn('MediaRecorder stop', error); }
    }
    renderState();
    setTimeout(renderState, 0);
  }

  async function finalizeCapture(capture, recorder) {
    if (capture.finalized) return;
    capture.finalized = true;
    if (state.recorder === recorder) state.recorder = null;
    if (state.current === capture) state.current = null;
    renderState();
    if (!capture.chunks.length) {
      toast('녹음 데이터가 없어 음정 기록만 저장했습니다.');
      return;
    }
    const chunkType = capture.chunks.find(chunk => chunk.type)?.type;
    const mimeType = normalizeMimeType(recorder.mimeType || chunkType || capture.requestedMimeType);
    const blob = new Blob(capture.chunks, { type: mimeType });
    if (!blob.size) return;
    const record = {
      id: capture.id,
      createdAt: capture.createdAt,
      durationMs: Math.max(0, Math.round(performance.now() - capture.startedPerf)),
      label: capture.label,
      mimeType,
      extension: extensionForMime(mimeType),
      size: blob.size,
      sessionIds: [...capture.sessionIds],
      stopReason: capture.stopReason,
      blob,
      schemaVersion: 1,
    };
    try {
      await putRecording(record);
      toast(`녹음 저장 완료 · ${duration(record.durationMs)} · ${bytes(record.size)}`);
      await refreshStorageSummary();
      if ($('recordingLibraryDialog')?.open) await renderLibrary();
    } catch (error) {
      console.warn('recording save', error);
      toast(error?.name === 'QuotaExceededError'
        ? '저장 공간이 부족해 녹음을 저장하지 못했습니다.'
        : '녹음을 기기에 저장하지 못했습니다.');
    }
  }

  function revokeUrls(urls) {
    urls.splice(0).forEach(url => URL.revokeObjectURL(url));
  }

  function createAudio(record, urlList) {
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(record.blob);
    urlList.push(url);
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = url;
    audio.setAttribute('playsinline', '');
    return audio;
  }

  function fileFor(record) {
    if (typeof File !== 'function') return null;
    return new File([record.blob], filenameFor(record), { type: record.mimeType || record.blob.type || 'audio/mp4' });
  }

  async function shareRecording(record) {
    const file = fileFor(record);
    if (file && navigator.share && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
        console.warn('recording share', error);
      }
    }
    downloadRecording(record);
    toast('공유를 지원하지 않아 녹음 파일로 저장했습니다.');
  }

  function downloadRecording(record) {
    const url = URL.createObjectURL(record.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filenameFor(record);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function actionButton(label, handler, className = 'recording-action-btn') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', handler);
    return button;
  }

  async function removeRecording(record, { confirmDelete = true } = {}) {
    if (confirmDelete && !confirm('이 녹음 파일을 기기에서 삭제할까요? 복구할 수 없습니다.')) return false;
    try {
      await deleteRecordingById(record.id);
      toast('녹음 파일을 삭제했습니다.');
      await refreshStorageSummary();
      return true;
    } catch (error) {
      console.warn('recording delete', error);
      toast('녹음 파일을 삭제하지 못했습니다.');
      return false;
    }
  }

  async function renderLibrary() {
    const host = $('recordingLibraryList');
    const summary = $('recordingLibrarySummary');
    if (!host || !summary) return;
    revokeUrls(state.libraryUrls);
    host.innerHTML = '';
    const recordings = await getAllRecordings();
    const total = recordings.reduce((sum, item) => sum + (Number(item.size) || Number(item.blob?.size) || 0), 0);
    summary.textContent = recordings.length
      ? `녹음 ${recordings.length}개 · ${bytes(total)} · 최신순`
      : '저장된 녹음이 없습니다.';
    $('clearAllRecordingsBtn')?.classList.toggle('hidden', !recordings.length);
    recordings.forEach(record => {
      const row = document.createElement('article');
      row.className = 'recording-library-row';
      const head = document.createElement('div');
      head.className = 'recording-library-head';
      const title = document.createElement('strong');
      title.textContent = record.label || '연습 녹음';
      const meta = document.createElement('small');
      meta.textContent = `${fullDate(record.createdAt)} · ${duration(record.durationMs)} · ${bytes(record.size || record.blob?.size)}`;
      head.append(title, meta);
      const audio = createAudio(record, state.libraryUrls);
      const actions = document.createElement('div');
      actions.className = 'recording-row-actions';
      actions.append(
        actionButton('공유', () => shareRecording(record)),
        actionButton('파일 저장', () => downloadRecording(record)),
        actionButton('삭제', async () => {
          if (await removeRecording(record)) await renderLibrary();
        }, 'recording-action-btn danger')
      );
      row.append(head, audio, actions);
      host.appendChild(row);
    });
  }

  async function openLibrary() {
    if (!state.supported) return toast('이 브라우저에서는 녹음 저장을 지원하지 않습니다.');
    try {
      await renderLibrary();
      $('recordingLibraryDialog')?.showModal();
    } catch (error) {
      console.warn('recording library', error);
      toast('녹음 목록을 불러오지 못했습니다.');
    }
  }

  function setSessionPanelEmpty(message = '이 연습 기록에는 연결된 녹음이 없습니다.') {
    const empty = $('sessionRecordingEmpty');
    const content = $('sessionRecordingContent');
    const badge = $('sessionRecordingBadge');
    if (empty) empty.textContent = message;
    empty?.classList.remove('hidden');
    content?.classList.add('hidden');
    if (badge) badge.textContent = '녹음 없음';
    state.sessionRecording = null;
    if (state.sessionUrl) URL.revokeObjectURL(state.sessionUrl);
    state.sessionUrl = null;
    const player = $('sessionRecordingPlayer');
    if (player) {
      player.pause();
      player.removeAttribute('src');
      player.load();
    }
  }

  function setSessionPanelRecord(record) {
    const empty = $('sessionRecordingEmpty');
    const content = $('sessionRecordingContent');
    const badge = $('sessionRecordingBadge');
    const meta = $('sessionRecordingMeta');
    const player = $('sessionRecordingPlayer');
    if (state.sessionUrl) URL.revokeObjectURL(state.sessionUrl);
    state.sessionUrl = URL.createObjectURL(record.blob);
    state.sessionRecording = record;
    empty?.classList.add('hidden');
    content?.classList.remove('hidden');
    if (badge) badge.textContent = '녹음 저장됨';
    if (meta) meta.textContent = `${duration(record.durationMs)} · ${bytes(record.size || record.blob?.size)} · ${record.extension?.toUpperCase() || 'AUDIO'}`;
    if (player) {
      player.src = state.sessionUrl;
      player.load();
    }
  }

  async function renderSessionRecording(sessionId) {
    const token = ++state.sessionRenderToken;
    setSessionPanelEmpty('연결된 녹음을 확인하고 있습니다…');
    try {
      const recordings = await getAllRecordings();
      if (token !== state.sessionRenderToken) return;
      const record = recordings.find(item => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId));
      if (record) setSessionPanelRecord(record);
      else setSessionPanelEmpty();
    } catch (error) {
      console.warn('session recording', error);
      if (token === state.sessionRenderToken) setSessionPanelEmpty('녹음 파일을 불러오지 못했습니다.');
    }
  }

  async function unlinkHistorySession(sessionId) {
    try {
      const recordings = await getAllRecordings();
      for (const record of recordings) {
        if (!Array.isArray(record.sessionIds) || !record.sessionIds.includes(sessionId)) continue;
        const remaining = record.sessionIds.filter(id => id !== sessionId);
        if (remaining.length) await putRecording({ ...record, sessionIds: remaining });
        else await deleteRecordingById(record.id);
      }
      await refreshStorageSummary();
    } catch (error) {
      console.warn('unlink recording', error);
    }
  }

  async function clearAllRecordings({ confirmDelete = true } = {}) {
    if (confirmDelete && !confirm('저장된 녹음 파일을 모두 삭제할까요? 복구할 수 없습니다.')) return false;
    try {
      await clearRecordingStore();
      revokeUrls(state.libraryUrls);
      setSessionPanelEmpty();
      await refreshStorageSummary();
      if ($('recordingLibraryDialog')?.open) await renderLibrary();
      if (confirmDelete) toast('모든 녹음 파일을 삭제했습니다.');
      return true;
    } catch (error) {
      console.warn('clear recordings', error);
      toast('녹음 파일을 삭제하지 못했습니다.');
      return false;
    }
  }

  function onToggle() {
    const toggle = $('recordingEnabledToggle');
    if (V()?.state?.measuring) {
      if (toggle) toggle.checked = state.enabled;
      return toast('측정을 끝낸 뒤 녹음 설정을 바꿔 주세요.');
    }
    state.enabled = !!toggle?.checked;
    writeEnabled(state.enabled);
    renderState();
  }

  function wireEvents() {
    $('recordingEnabledToggle')?.addEventListener('change', onToggle);
    $('recordingLibraryBtn')?.addEventListener('click', openLibrary);
    $('clearAllRecordingsBtn')?.addEventListener('click', () => clearAllRecordings());
    $('recordingLibraryDialog')?.addEventListener('close', () => revokeUrls(state.libraryUrls));
    $('sessionRecordingShareBtn')?.addEventListener('click', () => {
      if (state.sessionRecording) shareRecording(state.sessionRecording);
    });
    $('sessionRecordingDownloadBtn')?.addEventListener('click', () => {
      if (state.sessionRecording) downloadRecording(state.sessionRecording);
    });
    $('sessionRecordingDeleteBtn')?.addEventListener('click', async () => {
      const record = state.sessionRecording;
      if (record && await removeRecording(record)) setSessionPanelEmpty();
    });
    $('sessionDialog')?.addEventListener('close', () => {
      state.sessionRenderToken += 1;
      setSessionPanelEmpty();
    });

    window.addEventListener('vs:measurement-start', startRecording);
    window.addEventListener('vs:measurement-stop', event => stopRecording(event.detail?.reason || 'user'));
    window.addEventListener('vs:history-saved', event => {
      const id = event.detail?.record?.id;
      if (id && state.current) state.current.sessionIds.add(id);
    });
    window.addEventListener('vs:history-session-open', event => renderSessionRecording(event.detail?.id));
    window.addEventListener('vs:history-session-deleted', event => unlinkHistorySession(event.detail?.id));
    window.addEventListener('vs:history-cleared', () => clearAllRecordings({ confirmDelete: false }));
    window.addEventListener('vs:visibility', event => {
      if (event.detail?.hidden && state.recorder && V()?.state?.measuring) V().stopMeasurement('background');
    });
    window.addEventListener('pagehide', () => {
      if (state.recorder && V()?.state?.measuring) V().stopMeasurement('pagehide');
      else stopRecording('pagehide');
    });
  }

  async function init() {
    state.supported = !!(window.indexedDB && window.MediaRecorder);
    state.enabled = state.supported && readEnabled();
    wireEvents();
    renderState();
    if (state.supported) {
      try {
        await openDatabase();
        await refreshStorageSummary();
      } catch (error) {
        console.warn('recording init', error);
        state.supported = false;
        state.enabled = false;
        renderState();
        refreshStorageSummary();
      }
    } else refreshStorageSummary();
  }

  document.addEventListener('DOMContentLoaded', init);
  window.VocalRecording = {
    getAllRecordings,
    clearAllRecordings,
    openLibrary,
    chooseMimeType,
    extensionForMime,
    filenameFor,
    isEnabled: () => state.enabled,
    isRecording: () => state.recorder?.state === 'recording',
  };
})();
