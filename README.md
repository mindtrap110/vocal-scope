# 보컬 스코프 3.5.0

기존 녹음 버튼에 2026-10-14 판단 보정 명세를 통합한 정적 PWA입니다. 별도 훈련 시작 버튼이나 M1 화면은 없습니다.

## 사용

1. 연습 녹음 영역에 날짜(YYYY-MM-DD), 피드백 단계, 목표음 24개를 입력합니다. 목표음은 공백 또는 /로 나눠 붙여 넣습니다.
2. 기존 녹음 버튼으로 목표음을 2초 듣습니다. 자동으로 멈춘 뒤 같은 버튼으로 ② 녹음을 시작하고 3초 부릅니다.
3. ②의 음정과 그래프는 판단 전까지 숨깁니다. 방향·크기·확신도를 입력하면 결과 보기 버튼이 켜집니다. 맞음은 크기 입력을 비활성화합니다.
4. 결과는 assessment.medianCents 그대로 표시합니다. ±25¢ 안은 맞음, 그 밖은 오차 부호에 맞는 방향이 정답입니다.
5. 오차가 25¢를 넘으면 지정된 블록의 교정을 진행하고, 기준음을 끈 3초 재시도를 합니다. 재시도에는 판단을 입력하지 않습니다.
6. 하루 JSON 내보내기는 날짜에 해당하는 두 블록의 initial/correction/retry/discarded를 전부 포함하며 createdAt 순서로 정렬합니다.

## 고정된 구조

- 하루 2블록 × 12회 = 24회. 사용자가 붙여 넣은 순서를 유지하고 앱은 새 순서를 생성하지 않습니다.
- 입력 날짜의 일이 홀수면 beat → screen, 짝수면 screen → beat입니다. 순서 변경 기능은 없습니다.
- 피드백 단계는 사용자가 직접 설정합니다. 0은 전부, 1은 짝수 회차, 2는 3·6·9… 회차입니다. 확인하지 않는 회차도 judgement와 autoScore를 저장하며 교정과 재시도는 하지 않습니다.
- initial/retry의 assessment.status가 ok가 아니거나 발성이 중단되면 discarded로 저장하고 같은 발성 단계만 다시 진행합니다.
- 기존 500~2500ms 중앙값 함수는 변경하지 않았습니다. 짧고 끊긴 구간의 처리도 그대로 유지합니다.

## 교정

- beat: 마이크와 녹음을 끄고 기준음만 재생합니다. 사용자가 끄거나 최대 6초 뒤 멈춥니다. Y/N을 필수 입력한 후 points가 빈 교정 레코드와 시작·끝 시각을 저장합니다.
- screen: 기준음을 켠 채 마이크·녹음·실시간 음정 표시를 사용합니다. 사용자가 2초 맞춘 뒤 정지하면 기준음도 멈춥니다. points와 mixedWithReference=true를 보존하며 이 세션을 재시도 결과로 표시하거나 평가하지 않습니다.
- 기준음은 12개 배음의 진폭을 각각 1/n으로 합성하고 시작·끝에 20ms 페이드를 적용합니다. C4=60, A4=440Hz입니다.
- 기존 getUserMedia 옵션과 출력 AudioContext 구성을 유지했습니다. 실제 iPhone의 에어팟 출력·내장 마이크 입력은 기기에서 확인해야 합니다.

## 저장과 내보내기

각 새 발성 레코드의 training에는 dayId, block, method, trial, stage, targetNote, targetMidi, judgement, autoScore, beatHeard, mixedWithReference, initialSessionId, feedbackLevel을 저장합니다.

- judgement/autoScore는 initial에서만, beatHeard는 beat correction에서만 채웁니다.
- correction/retry의 initialSessionId는 같은 회차의 initial 레코드 ID입니다.
- 판단이 없는 기록도 제외하지 않습니다.
- 파일명은 vocal-scope-training-YYYY-MM-DD.json입니다.
- 음성 파일은 IndexedDB에 별도로 저장하고, 기존 녹음 목록에서 재생·공유·파일 저장할 수 있습니다.
- 이전에 training=null로 저장된 레코드의 판단·회차는 새로 추정해서 채우지 않습니다.

## 검증

- node tests/judgement-test.cjs: assessment 함수 해시 동일성, MIDI, 날짜, 순서, 저장 스키마, 채점, 모든 단계의 내보내기
- NODE_PATH=/path/to/test/node_modules node tests/judgement-flow-test.cjs: jsdom 26.1.0에서 명세 확인 1~5, 24회/두 블록, 실패 시도, Y/N, 피드백 단계, 12배음 및 20ms 페이드
- BROWSER_EXECUTABLE=/path/to/chromium BROWSER_FAKE_AUDIO=/path/to/voice-80.wav node tests/judgement-browser-test.cjs: Playwright에서 A2보다 80¢ 낮은 48kHz 모노 WAV로 두 블록의 실제 분석·MediaRecorder·IndexedDB·하루 파일 다운로드 검증

정적 파일을 GitHub Pages 같은 HTTPS 호스팅에 배포합니다. 녹음과 기록은 이 기기의 브라우저 저장소에 보관되므로 중요한 파일은 별도로 내보내세요.
