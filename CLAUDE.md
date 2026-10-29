# CLAUDE.md — 달무티 웹 게임

이 파일은 Claude(Claude Code 등)가 이 프로젝트를 이어서 작업할 때 읽는 컨텍스트 문서입니다.

## 프로젝트 개요

- **무엇**: 카드 게임 "달무티"를 브라우저에서 플레이하는 웹 게임. **혼자 하기**(1인 + AI) / **같이 하기**(방 만들기·코드 참가, 빈 자리는 AI)
- **형태**: 빌드 도구 없음. 프론트는 `index.html` + `engine.js`(Vanilla JS), 멀티는 Node 서버 `server.js`(`ws` 의존성 하나)
- **외부 의존성**: Google Fonts (Gowun Batang, IBM Plex Sans KR, IM Fell English SC). 오프라인이면 시스템 폰트로 fallback
- **실행**
  - 혼자 하기: `index.html`을 브라우저로 열면 끝 (file:// 가능)
  - 같이 하기: `npm install && npm start` → `http://localhost:3000` (같은 네트워크 친구는 터미널에 찍힌 `http://<IP>:3000`). `PORT` 환경변수로 포트 변경
  - 프론트를 다른 곳(정적 호스팅)에 두고 서버만 따로 띄우면 `index.html`의 `SERVER_URL`에 `wss://...` 지정

## 파일 구조

```
dalmuti-game/
├── index.html    # 스타일, 마크업, UI(렌더링·입력·싱글/멀티 연결)
├── engine.js     # 게임 엔진 (룰·AI·상태 머신). 브라우저(window.Dalmuti)·Node(require) 공용
├── server.js     # 멀티플레이 서버 (정적 파일 + WebSocket, 방 관리, 권위 서버)
├── package.json  # npm start, 의존성 ws
└── CLAUDE.md     # 이 문서
```

## 코드 컨벤션

- UI 텍스트, 주석, 로그 메시지는 **한국어**
- 변수명, 함수명은 **영어** (camelCase)
- 색상은 모두 `:root`의 CSS 변수 토큰으로 정의. 의도적으로 다크 단일 테마 (`color-scheme: dark`)
- 카드 크기는 `--cw`, `--ch` 변수로 제어 (720px 이상에서 커짐)

## 게임 룰 (구현 기준)

- 덱 80장: 숫자 n은 n장(1~12, 합 78장) + 광대(J, 내부값 13) 2장
- **숫자가 작을수록 강함.** 광대는 단독으로 내면 13, 다른 숫자와 섞으면 그 숫자로 취급
- 선은 같은 숫자 카드를 원하는 장수만큼 냄. 다음 사람은 **같은 장수 + 더 작은 숫자** 또는 패스
- 패스해도 다음 차례에 다시 낼 수 있음. 마지막으로 낸 사람을 제외한 활성 플레이어가 연속으로 전부 패스하면 판 정리, 마지막으로 낸 사람이 새 선 (그 사람이 이미 손을 털었다면 다음 활성 플레이어가 선)
- 세금: 대노예 → 대달무티 2장, 소노예 → 소달무티 1장 (가장 낮은 숫자). 달무티는 같은 장수를 골라서 돌려줌
- 혁명: 딜 직후 광대 2장을 가진 사람이 선언하면 그 라운드 세금 없음. 대노예가 선언하면 **대혁명** (`G.order.reverse()`)
- 손을 턴 순서 = 다음 라운드 자리 순서. 점수는 1등 `n-1`점 ~ 꼴찌 0점, 누적

## 아키텍처

### 구조

- `engine.js`의 `createGame(seats, io)`가 게임 하나를 만든다. 상태 `G`는 엔진 안에만 있고, 밖에서는 입력 함수와 `view(me)`로만 접근
  - `seats`: `[{name, human}]` (순서 = 플레이어 id)
  - `io`: `{later(fn,ms), speed(), changed(), toast(msg, toId?), turnMs?}` — 타이머·알림을 호스트(브라우저/서버)가 주입. `turnMs`는 사람 차례 제한시간 (서버 `TURN_MS` 30초, 싱글은 없음)
  - 반환: `{start, play(id, ids|null), taxReturn(id, ids), revolution(id, call), nextRound(), setAI(id, on), view(me), isAI(id)}`
  - 입력 함수는 phase·차례·소유 카드·중복·`isValid`를 전부 검증하고 틀리면 무시 (서버에서 그대로 신뢰 경계로 씀)
- `view(me)`: 플레이어별로 필터링한 상태. **손패는 자기 것만**, 다른 사람은 `count`만. 로그의 `secret`(세금 카드 내용)은 당사자(`who`)에게만
- 싱글: `index.html`이 엔진을 직접 만들고 `changed`에서 `V=game.view(0)` 후 `render()`
- 멀티: 서버가 엔진을 돌리고 `changed`마다 각 접속자에게 `view(seat)`를 보냄. 클라이언트는 받은 `V`로만 렌더
- `send(t, d)`가 싱글이면 엔진 함수, 멀티면 WebSocket으로 보냄 → UI 코드는 모드를 몰라도 됨

### 멀티플레이 프로토콜 (JSON, 필드 `t`)

| 방향 | 메시지 |
|---|---|
| C→S | `create{sid,name,n,pub}`, `join{sid,name,code}`, `list`(방 밖에서만), `start`(방장), `play{ids}`, `pass`, `tax{ids}`, `rev{call}`, `next`(방장), `leave` |
| S→C | `room{code,n,pub,host,started,members}`, `rooms{list:[{code,host,count,n}]}`, `state{view}`, `toast{msg}`, `error{msg,fatal?}` |

- 방 코드: 4글자 대문자 (`I`, `O` 제외). 초대 링크 `?room=CODE`
- 공개 방(`pub`)은 "멀티플레이 로비" 화면(`openBrowse`)의 방 목록에 보인다 (대기 중·자리 남음·접속자 있음, 최대 20개). 로비는 별도 WebSocket으로 `list`를 보내 구독하고, 서버는 `broadcastRoom` 때마다 구독자에게 `rooms`를 다시 보냄. 로비를 닫거나 방에 들어가면 연결을 끊음. 시작 메뉴(`openSetup`)는 이름·싱글플레이·로비 진입만
- `sid`: 브라우저 localStorage `dalmuti-sid`. 같은 sid로 다시 들어오면 **같은 자리로 복귀** (새로고침·재접속). 현재 방은 `dalmuti-room`에 저장해 자동 재참가
- 게임 중 연결이 끊기면 `setAI(seat, true)`로 AI가 대신 두고, 돌아오면 해제. 혁명/세금 반환 대기 중이었다면 AI가 즉시 처리
- 방장이 나가면 접속 중인 다음 사람에게 넘어감. 대기실에서 전원 이탈 시 즉시, 게임 중 전원 이탈 시 10분 뒤 방 삭제
- 서버는 `/`, `/index.html`, `/engine.js`만 서빙 (나머지 404). WebSocket `maxPayload` 4KB, 30초 ping으로 죽은 연결 정리

### 엔진 상태 `G`

| 필드 | 설명 |
|---|---|
| `players[]` | `{id, name, human, ai, hand[], score}`. `ai`는 AI가 두는지 (봇 또는 연결 끊긴 사람). 싱글은 `id 0`이 사람 |
| `n` | 인원 수 (4~8) |
| `order[]` | 신분 순서 = 자리 순서 (index 0 = 대달무티). 플레이도 이 순서로 돈다 |
| `phase` | `deal` → `revolution`(사람이 광대 2장일 때 `revBy`가 결정 대기, 선언 후에도 잠시 유지) → `tax` / `taxReturn` → `play` → `roundEnd` |
| `pile` | 바닥 카드 `{cards, count, value, by}` 또는 `null`(선) |
| `turn` | 현재 차례 플레이어 id |
| `lastPlayer`, `passStreak` | 판 종료 판정용 |
| `finished[]` | 손을 턴 순서 |
| `lastAction{}` | 좌석에 표시하는 직전 행동 (패스 / 낸 카드) |
| `fresh` | 세금으로 새로 받은 카드 id (초록 점 표시). 그 사람이 행동하면 지워짐 |
| `clearing` | 판 정리 애니메이션 중 플래그 |
| `taxCtx` | 세금 반환 대기 `{by, to, k, give}` (`give`는 `view`에서 `by`에게만) |
| `step` | 차례가 바뀔 때마다 증가. 예약된 AI 타이머가 낡았는지 판정 |
| `deadline` | 사람 차례 마감 시각(ms). `schedule()`이 잡고, 넘기면 바닥이 있으면 자동 패스·선이면 `aiChoose`로 자동 내기. `view`에는 남은 시간 `turnLeft`로만 나감 (클라이언트는 받은 시점 기준 `V.deadline` 계산). 혁명·세금 반환 대기에는 제한 없음 |
| `log[]` | `{msg, kind, who[], secret}`. `msg`가 null이면 `who`에게만 보임 |

카드 객체: `{id, v}` (v = 1~12, 광대 13)

### 흐름 함수

```
start()
  └ startRound() ─ 딜
      └ checkRevolution() ─ resolveRevolution(id, call)
          └ doTax() ─ nextTax() ─(사람 달무티면 taxReturn 대기) finishTaxReturn()
              └ startPlay() ─ schedule() ─ act(id, cards|null) 반복
                  └ endRound() ─ 결과 모달 → nextRound() → startRound()
```

- `act(id, cards)`: 내기/패스를 처리하는 **유일한 상태 변경 지점**. 사람·AI 모두 여기로 들어옴
- `isValid(cards, pile)`: 조합 유효성 검사 (숫자 1종 + 광대, 장수/숫자 비교). 순수 함수
- `nextActive(id)`: 손을 털지 않은 다음 좌석
- `io.later(fn, ms)`: 가드가 걸린 `setTimeout`. 브라우저는 `token`(새 게임 시 `token++`), 서버는 "방이 살아 있고 같은 게임인지"로 이전 타이머를 무효화. **엔진에서 타이머를 만들 때는 반드시 `io.later`를 쓸 것**

### AI (`aiChoose(hand, pile)`, `aiTaxBack(hand, give, k)` — 순수 함수)

- 선: 약한 숫자 절반 중에서 장수가 많은 묶음을 우선 정리. 한 종류 + 광대만 남으면 전부 털기
- 응수: 낼 수 있는 후보마다 점수 = `숫자×10 − 묶음 쪼개기 페널티 − 광대 사용 페널티`, 다 털 수 있으면 +1000
- 1·2 같은 강한 카드는 손패가 많을 때 확률적으로 아낌 (패스)
- 혁명: 대노예면 무조건, 하위 절반이면 선언
- 세금 반환: 받은 카드를 제외한 가장 약한 숫자부터 돌려줌 (광대는 안 줌)

### 렌더링

- `render()`가 `V`(현재 view)를 읽어 `renderSeats / renderTable / renderMe / renderLog / renderModal`을 매번 innerHTML로 다시 그림 (상태가 작아서 충분히 빠름)
- 멀티에서는 좌석에 `AI` / `자리 비움` 태그, 속도 조절 숨김, 다음 라운드는 방장만
- 손패는 `layoutHand()`가 컨테이너 너비에 맞춰 카드 간격(`step`)을 계산해 absolute 배치. 창 크기 변경 시 재계산
- 카드 탭 시 바닥 장수만큼 같은 숫자를 자동 선택 (`tapCard`). 낼 수 없는 카드는 `.dim`

## 부가 기능

- **투명도 슬라이더**: `--op` CSS 변수 (10~100%), `localStorage` 키 `dalmuti-op`에 저장
- **Esc**: `html.ghost` 토글 → 3% 투명도로 즉시 숨김. 숨긴 상태에서는 Enter/P 단축키 무시
- **단축키**: Enter 내기, P 패스. 카드를 골라 둔 상태에선 패스 버튼·P 모두 잠김 (내기를 누르려다 패스하는 실수 방지). 버튼은 패스 왼쪽 작게 / 내기 오른쪽 크게, 낼 게 없으면 패스가 주 버튼
- **효과음**: Web Audio로 합성(`sfx(kind)`, 음원 파일 없음) — 카드 착지 `card`, 패스 `pass`, 내 차례 `turn`, 판 정리 `sweep`, 라운드 끝 `end`, 마지막 5초 `tick`. `cueSounds()`가 직전 렌더와 비교해 트리거. 헤더 소리 버튼, `localStorage` 키 `dalmuti-sound`. Esc(ghost) 중엔 무음
- **속도**: 느림 1000ms / 보통 600ms / 빠름 280ms (`speed`)

## 확장 아이디어 (다음 작업 후보)

1. **배포**: 프론트는 정적 호스팅, `server.js`는 상시 프로세스가 가능한 곳(WebSocket + 메모리 방 상태)에 두고 `SERVER_URL` 지정. 서버리스 함수(Vercel Functions 등)는 메모리 방 상태를 유지할 수 없어 그대로는 안 됨
2. **테스트**: `isValid`, `aiChoose`는 순수 함수, 엔진은 `createGame`에 가짜 `io`를 넣으면 Node에서 바로 시뮬레이션 가능
3. **AI 고도화**: 남은 카드 카운팅(이미 나온 1·2 추적), 상대 손패 수 기반 공격성 조절
4. **저장**: 진행 중 게임을 `localStorage`에 직렬화해서 새로고침 후 이어하기

## 주의사항

- 상태를 바꾸는 코드는 엔진(`act` / 흐름 함수) 안에서만. UI는 `V`를 읽기만 하고 입력은 `send()`로
- 새 정보를 `view`에 추가할 때는 다른 사람에게 보이면 안 되는 값(손패, 세금 카드)이 새지 않는지 확인
- 서버 메시지 핸들러는 신뢰 경계. 타입 검사(`isIds` 등) 후 엔진에 넘기고, 판정은 엔진이 함
- `G.order`는 대혁명 때 뒤집히고 라운드 끝에 `finished`로 교체됨. 자리 관련 로직은 항상 `order` 기준으로 계산할 것
- 모달이 열려 있을 때(`modalKind` 또는 `#modal` 표시 중)는 키보드 단축키가 막혀 있음
