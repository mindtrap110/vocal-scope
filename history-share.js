'use strict';

(() => {
  const HISTORY_KEY = 'vocalScopePracticeHistoryV1';
  const PHRASE_KEY = 'vocalScopeLyricPhrasesV1';
  const EXPORT_SCHEMA = 'vocal-scope-practice-history';
  const EXPORT_VERSION = 1;
  const DEFAULT_SUMMARY_LIMIT = 6;

  const $ = id => document.getElementById(id);
  const V = () => window.VocalScope;
  const H = () => window.VocalHistory;

  function readJsonArray(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  }

  function readSessions() {
    const sessions = H()?.readSessions?.();
    return Array.isArray(sessions) ? sessions : readJsonArray(HISTORY_KEY);
  }

  function noteName(midi) {
    if (!Number.isFinite(midi)) return '미설정';
    return V()?.noteFromMidi?.(midi)?.name || `MIDI ${Math.round(midi)}`;
  }

  function dateTime(value) {
    const date = new Date(Number(value));
    if (Number.isNaN(date.getTime())) return '날짜 미상';
    return date.toLocaleString('ko-KR', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }

  function duration(ms) {
    const value = Math.max(0, Number(ms) || 0);
    if (value < 1000) return `${Math.round(value)}ms`;
    if (value < 60000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}초`;
    const minutes = Math.floor(value / 60000);
    const seconds = Math.round((value % 60000) / 1000);
    return `${minutes}분 ${seconds}초`;
  }

  function signed(value, suffix = 'c') {
    if (!Number.isFinite(value)) return '—';
    const rounded = Math.round(value);
    return `${rounded > 0 ? '+' : ''}${rounded}${suffix}`;
  }

  function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function techniqueFor(session) {
    try {
      return H()?.getTechnique?.(session) || session?.technique || null;
    } catch (_) {
      return session?.technique || null;
    }
  }

  function intervalsFor(session) {
    try {
      const intervals = H()?.getIntervals?.(session);
      return Array.isArray(intervals) ? intervals : [];
    } catch (_) {
      return [];
    }
  }

  function cleanText(value) {
    return String(value || '').replace(/\r\n?/g, '\n').trim();
  }

  function modeOf(session) {
    if (session?.plan?.type === 'phrase') return '가사 구절';
    if (session?.plan?.type === 'interval') return '연속음 간격';
    if (Number.isFinite(session?.targetMidi)) return '목표음';
    return '자유 측정';
  }

  function commonLine(session) {
    const parts = [
      `유효 음성 ${duration(session?.voicedMs)}`,
      `음역 ${noteName(session?.minMidi)}–${noteName(session?.maxMidi)}`,
      `음정 표본 ${Number(session?.sampleCount) || 0}개`,
    ];
    return parts.join(' · ');
  }

  function sessionLines(session, index) {
    const mode = modeOf(session);
    const tech = techniqueFor(session);
    const lines = [`${index + 1}. ${dateTime(session?.createdAt)} · ${mode}`];

    if (mode === '가사 구절') {
      lines.push(`   구절: ${cleanText(session?.plan?.label) || '이름 없음'}`);
      const lyrics = cleanText(session?.plan?.lyrics);
      if (lyrics) lines.push(`   가사: ${lyrics.replace(/\n/g, ' / ')}`);
      if (Number.isFinite(session?.plan?.startMidi)) lines.push(`   첫 음 기준: ${noteName(session.plan.startMidi)}`);
      lines.push(`   ${commonLine(session)}`);
      return lines;
    }

    if (mode === '연속음 간격') {
      const intervals = intervalsFor(session);
      const errors = intervals.map(item => Math.abs(item?.errorCents)).filter(Number.isFinite);
      const intervalMedian = median(errors);
      const label = cleanText(session?.plan?.label) || '간격 훈련';
      lines.push(`   경로: ${label} · 발성 ${Number(tech?.utteranceCount) || 0}회 · 이동 ${intervals.length}개`);
      lines.push(`   간격 절대 오차 중앙값: ${Number.isFinite(intervalMedian) ? `${Math.round(intervalMedian)}c` : '분석 없음'}`);
      if (intervals.length) {
        const details = intervals.slice(0, 8).map(item =>
          `${noteName(item?.fromExpectedMidi)}→${noteName(item?.toExpectedMidi)} ${signed(item?.errorCents)}`
        );
        lines.push(`   이동별 오차: ${details.join(', ')}${intervals.length > details.length ? ' …' : ''}`);
      }
      lines.push(`   ${commonLine(session)}`);
      return lines;
    }

    if (mode === '목표음') {
      lines.push(`   목표: ${noteName(session?.targetMidi)} · ±15c 정확률 ${Math.round(Number(session?.accuracy) || 0)}%`);
      lines.push(`   초기 착지 ${signed(tech?.landingCents)} · 유지 ${signed(tech?.sustainCents)} · 드리프트 ${signed(tech?.driftCentsPerSec, 'c/s')}`);
      lines.push(`   평균 절대 오차 ${Math.round(Number(session?.avgAbsCents) || 0)}c · 평균 치우침 ${signed(session?.biasCents)} · 최장 정확 유지 ${duration(session?.longestInTuneMs)}`);
      lines.push(`   ${commonLine(session)} · 발성 ${Number(tech?.utteranceCount) || 0}회`);
      return lines;
    }

    lines.push(`   ${commonLine(session)} · 발성 ${Number(tech?.utteranceCount) || 0}회`);
    return lines;
  }

  function buildSummary(allSessions, options = {}) {
    const sessions = Array.isArray(allSessions) ? allSessions : [];
    const requested = options.limit === 'all' ? sessions.length : Math.max(1, Number(options.limit) || DEFAULT_SUMMARY_LIMIT);
    const selected = sessions.slice(0, requested);
    const typeCounts = selected.reduce((counts, session) => {
      const mode = modeOf(session);
      counts[mode] = (counts[mode] || 0) + 1;
      return counts;
    }, {});
    const totalVoiced = selected.reduce((sum, session) => sum + Math.max(0, Number(session?.voicedMs) || 0), 0);
    const appVersion = V()?.APP_VERSION || '알 수 없음';
    const build = V()?.BUILD_ID || '알 수 없음';
    const scope = selected.length === sessions.length
      ? `전체 ${selected.length}개`
      : `전체 ${sessions.length}개 중 최근 ${selected.length}개`;

    const lines = [
      '# 보컬 스코프 연습 기록',
      '',
      '아래 기록을 보컬 코치처럼 분석해 주세요.',
      '- 반복되는 강점과 문제 경향을 구분해 주세요.',
      '- 가장 먼저 교정할 항목 1~2개와 구체적인 연습법을 제안해 주세요.',
      '- 다음 연습에서 확인할 수치와 10분 루틴을 만들어 주세요.',
      '- 데이터가 부족한 결론은 추정이라고 표시해 주세요.',
      '',
      '해석 주의:',
      '- cent는 반음의 1/100이며, 목표음 기록의 정확률은 ±15 cent 기준입니다.',
      '- 가사 구절 기록은 기준 멜로디 없이 실제 음정 흐름과 음역만 저장하므로 멜로디 정확도로 평가하면 안 됩니다.',
      '- 오디오 녹음은 없고 음정 분석 데이터만 있습니다.',
      '',
      `앱 버전: ${appVersion} (${build})`,
      `공유 범위: ${scope}`,
      `유효 음성 합계: ${duration(totalVoiced)}`,
      `유형: ${Object.entries(typeCounts).map(([name, count]) => `${name} ${count}개`).join(' · ') || '기록 없음'}`,
      '',
      '## 세션별 기록',
    ];

    if (!selected.length) lines.push('저장된 연습 기록이 없습니다.');
    selected.forEach((session, index) => {
      lines.push(...sessionLines(session, index), '');
    });
    if (selected.length < sessions.length) {
      lines.push(`※ 나머지 ${sessions.length - selected.length}개 세션은 이 요약에서 생략되었습니다. 전체 원본은 JSON 내보내기로 공유할 수 있습니다.`);
    }
    return lines.join('\n').trim();
  }

  function buildExportPayload(sessions = readSessions()) {
    const records = Array.isArray(sessions) ? sessions : [];
    const phraseIds = new Set(records
      .filter(session => session?.plan?.type === 'phrase' && session.plan.phraseId)
      .map(session => session.plan.phraseId));
    return {
      schema: EXPORT_SCHEMA,
      schemaVersion: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      app: {
        name: '보컬 스코프',
        version: V()?.APP_VERSION || null,
        build: V()?.BUILD_ID || null,
      },
      contents: {
        containsAudio: false,
        containsPitchPoints: true,
        containsLyricsWhenUsed: true,
      },
      fieldGuide: {
        points: '[세션 시작 후 경과 밀리초, 감지된 MIDI 음정] 배열',
        cents: '반음의 1/100. 양수는 기준보다 높고 음수는 낮음',
        accuracy: '목표음이 있는 세션에서 ±15 cent 안에 든 음정 표본의 비율',
        landingCents: '각 발성의 첫 안정 검출 후 0.2~0.5초 중앙 오차',
        sustainCents: '각 발성의 0.5~1.5초 중앙 오차',
        driftCentsPerSec: '발성을 유지하는 동안 초당 음정 변화',
        phraseWarning: 'plan.type이 phrase인 기록은 기준 멜로디가 없으므로 멜로디 정확도로 평가하지 않음',
      },
      suggestedAnalysis: '반복되는 강점과 문제 경향을 찾고, 교정 우선순위 1~2개와 다음 10분 연습 루틴을 제안해 주세요. 근거가 부족한 결론은 추정이라고 표시해 주세요.',
      recordCount: records.length,
      sessions: records,
      phraseLibrary: readJsonArray(PHRASE_KEY).filter(phrase => phraseIds.has(phrase?.id)),
    };
  }

  function buildDetailedText(sessions) {
    const payload = buildExportPayload(sessions);
    return [
      '# 보컬 스코프 상세 연습 기록',
      '',
      '이 파일에는 선택한 연습 기록의 요약 수치와 전체 음정 좌표가 들어 있습니다.',
      '아래 데이터를 보컬 코치처럼 분석해 반복되는 강점과 문제 경향, 교정 우선순위 1~2개, 다음 10분 연습 루틴을 제안해 주세요.',
      '가사 구절 기록은 기준 멜로디가 없으므로 멜로디 정확도로 평가하지 말고, 근거가 부족한 결론은 추정이라고 표시해 주세요.',
      '음성 녹음은 포함되어 있지 않습니다.',
      '',
      JSON.stringify(payload, null, 2),
    ].join('\n');
  }

  function showToast(message) {
    const toast = $('saveToast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (!copied) throw new Error('copy failed');
  }

  async function shareText(text, title) {
    if (navigator.share) {
      await navigator.share({ title, text });
      return 'shared';
    }
    await copyText(text);
    return 'copied';
  }

  function rangeValue(total) {
    const input = $('shareHistoryRange');
    const maximum = Math.max(1, Number(total) || 1);
    const entered = Math.round(Number(input?.value));
    const fallback = Math.min(DEFAULT_SUMMARY_LIMIT, maximum);
    const value = Math.min(maximum, Math.max(1, Number.isFinite(entered) ? entered : fallback));
    if (input) input.value = String(value);
    return value;
  }

  async function withBusyButton(button, busyLabel, task) {
    if (!button || button.disabled) return;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = busyLabel;
    try {
      await task();
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.warn('history share', error);
        showToast('공유하지 못했습니다. 요약 복사를 이용해 주세요.');
      }
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  async function shareSummary() {
    const button = $('shareChatGptBtn');
    await withBusyButton(button, '공유 준비 중…', async () => {
      const sessions = readSessions();
      if (!sessions.length) return showToast('공유할 연습 기록이 없습니다.');
      const result = await shareText(buildSummary(sessions, { limit: rangeValue(sessions.length) }), '보컬 스코프 연습 기록');
      showToast(result === 'copied' ? '요약을 복사했습니다. ChatGPT에 붙여넣으세요.' : '공유 시트를 열었습니다. ChatGPT를 선택하세요.');
    });
  }

  async function copySummary() {
    const button = $('copyHistorySummaryBtn');
    await withBusyButton(button, '복사 중…', async () => {
      const sessions = readSessions();
      if (!sessions.length) return showToast('복사할 연습 기록이 없습니다.');
      await copyText(buildSummary(sessions, { limit: rangeValue(sessions.length) }));
      showToast('요약을 복사했습니다. ChatGPT에 붙여넣으세요.');
    });
  }

  function localDateStamp() {
    const now = new Date();
    const parts = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((value, index) =>
      index === 0 ? String(value) : String(value).padStart(2, '0')
    );
    return parts.join('-');
  }

  async function shareOrDownloadFile({ content, filename, type }) {
    const blob = new Blob([content], { type });
    const file = typeof File === 'function' ? new File([blob], filename, { type }) : null;
    if (file && navigator.share && navigator.canShare?.({ files: [file] })) {
      // Send only the file. Some iOS share extensions discard the attachment
      // when a separate text payload is supplied alongside it.
      await navigator.share({ files: [file] });
      return 'shared';
    }
    const url = URL.createObjectURL(file || blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    return 'downloaded';
  }

  function selectedSessions() {
    const sessions = readSessions();
    return {
      all: sessions,
      selected: sessions.slice(0, rangeValue(sessions.length)),
    };
  }

  async function shareDetailedFile() {
    const button = $('shareDetailedHistoryBtn');
    await withBusyButton(button, '상세 파일 만드는 중…', async () => {
      const { all, selected } = selectedSessions();
      if (!all.length) return showToast('공유할 연습 기록이 없습니다.');
      const filename = `vocal-scope-chatgpt-${selected.length}-records-${localDateStamp()}.txt`;
      const result = await shareOrDownloadFile({
        content: buildDetailedText(selected),
        filename,
        type: 'text/plain;charset=utf-8',
      });
      showToast(result === 'shared'
        ? `최근 ${selected.length}개 상세 파일을 공유합니다.`
        : `최근 ${selected.length}개 상세 TXT 파일을 저장했습니다.`);
    });
  }

  async function exportJson() {
    const button = $('exportHistoryJsonBtn');
    await withBusyButton(button, '파일 만드는 중…', async () => {
      const { all, selected } = selectedSessions();
      if (!all.length) return showToast('내보낼 연습 기록이 없습니다.');
      const filename = `vocal-scope-history-${selected.length}-records-${localDateStamp()}.json`;
      const result = await shareOrDownloadFile({
        content: JSON.stringify(buildExportPayload(selected), null, 2),
        filename,
        type: 'application/json',
      });
      showToast(result === 'shared'
        ? `최근 ${selected.length}개 JSON 파일을 공유합니다.`
        : `최근 ${selected.length}개 JSON 파일을 저장했습니다.`);
    });
  }

  async function shareSession(id) {
    const sessions = readSessions();
    const session = sessions.find(item => item?.id === id);
    if (!session) return showToast('공유할 기록을 찾지 못했습니다.');
    try {
      const result = await shareText(buildSummary([session], { limit: 'all' }), `보컬 스코프 · ${modeOf(session)}`);
      showToast(result === 'copied' ? '이 기록을 복사했습니다.' : '공유 시트를 열었습니다.');
    } catch (error) {
      if (error?.name !== 'AbortError') {
        console.warn('session share', error);
        showToast('공유하지 못했습니다.');
      }
    }
  }

  function openShareDialog() {
    const sessions = readSessions();
    const count = $('shareHistoryCount');
    const range = $('shareHistoryRange');
    const buttons = [$('shareChatGptBtn'), $('copyHistorySummaryBtn'), $('shareDetailedHistoryBtn'), $('exportHistoryJsonBtn')];
    if (count) count.textContent = sessions.length
      ? `저장된 연습 기록 ${sessions.length}개`
      : '아직 저장된 연습 기록이 없습니다';
    if (range) {
      range.disabled = !sessions.length;
      range.max = String(Math.max(1, sessions.length));
      range.value = String(sessions.length
        ? Math.min(sessions.length, Math.max(1, Math.round(Number(range.value)) || DEFAULT_SUMMARY_LIMIT))
        : 1);
    }
    buttons.forEach(button => { if (button) button.disabled = !sessions.length; });
    $('historyDialog')?.close();
    $('shareHistoryDialog')?.showModal();
  }

  function mount() {
    $('historyShareBtn')?.addEventListener('click', openShareDialog);
    $('shareAllHistoryBtn')?.addEventListener('click', openShareDialog);
    $('shareChatGptBtn')?.addEventListener('click', shareSummary);
    $('copyHistorySummaryBtn')?.addEventListener('click', copySummary);
    $('shareDetailedHistoryBtn')?.addEventListener('click', shareDetailedFile);
    $('exportHistoryJsonBtn')?.addEventListener('click', exportJson);
  }

  document.addEventListener('DOMContentLoaded', mount);
  window.VocalHistoryShare = {
    buildSummary,
    buildExportPayload,
    buildDetailedText,
    shareSession,
    openShareDialog,
  };
})();
