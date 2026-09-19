# Vex 셸 3모드 분리 설계 — Agent / Studio / Lighter

*작성 2026-09-17. 이 문서는 모달에서 셸 모드로 옮기기 전의 설계 기준과 제안이다. 구현 이후의 현재 상태 문서로 읽지 말 것. 기준 트리: `~/Projects/vex-2026-09-17` (main `7531273cc`, 0.2.10). 인용은 `vex-app/src` 기준 경로.*

Current implemented behavior is documented in [`LIGHTER_DESK_PRODUCT_UX.md`](./LIGHTER_DESK_PRODUCT_UX.md).

---

## 0. 한 줄 요약

Vex 셸에는 이미 "모드" 개념(`runtimeMode: "agent" | "studio"`)이 있고 Studio가 그 정석 패턴이다. Lighter만 그 패턴을 안 따르고 **에이전트 채팅 위에 뜨는 모달**로 붙어 있어서 화면·대화·상태가 전부 뒤섞인다. 해법은 Lighter를 **세 번째 `runtimeMode`** 로 승격하고, **전용 트레이딩 세션**을 갖게 하는 것. 그러면 세 모드가 같은 셸 프레임 위에서 각자 다른 내용물을 갖고, Lighter는 영구 왼쪽 레일 대신 상단 탐색을 사용한다. 단, **진입 문법은 지금 그대로**: 헤더 토글은 `Agent | Studio`로 두고, Lighter는 BOOK 레일의 `Lighter` 버튼이나 `light it up`으로 **들어가는** 화면이다.

---

## 1. 현황 분석

### 1.1 저장소 구성

```
vex-2026-09-17/
├─ src/vex-agent/        에이전트 런타임·툴 카탈로그·DB 마이그레이션 (vex-app이 path alias로 참조)
├─ src/lib/              공용 유틸 (zod-locale 등, main 빌드가 사용)
├─ bridge/               vex-mcp 브리지 바이너리 (Studio용)
├─ VEX_STUDIO.md         Studio 엔지니어링 정본
└─ vex-app/              Electron 앱
   ├─ src/main/          882 파일 · 20.6만 줄 — agent, lighter, studio, sessions, database, ipc, secrets, wallet …
   ├─ src/renderer/      1,100 파일 · 23.4만 줄 — features/{appShell, wizard, setup, wallets, …}, stores, styles
   ├─ src/shared/        234 파일 — zod 스키마 (IPC 경계 계약)
   ├─ src/preload/       63 파일 — 채널 브리지
   ├─ resources/migrations/  SQL 마이그레이션 (vex-agent에서 복사, 현재 최신 162)
   └─ docs/              설계 문서들 (이 문서 포함)
```

### 1.2 셸 프레임 (공통)

- `features/appShell/AppShell.tsx` — 3열 CSS 그리드 `사이드바 | 센터 | 우측 트랙(BOOK)`. 폭은 `lib/shell-columns.ts`의 `computeShellColumns()`가 해결 (사이드바 264–420, BOOK 300–520, 센터 ≥ 640, 사이드바 자동 접힘 < 1024).
- 모드 분기는 딱 두 곳: 사이드바(`StudioSidebar` vs `SessionsList`, `AppShell.tsx:263`) 와 센터(`StudioCenter` vs `SessionPanel`, `:305`).
- `ShellStatusStrip` + `GlobalApprovals`는 모드와 무관하게 **한 번만** 마운트 (preload가 이벤트 종류당 구독자 1개만 허용).
- `BookPanel.tsx`는 `runtimeMode` + `activeSessionId/activeProjectId`로 4갈래 분기해서 세션 스코프 / 프로젝트 스코프 / 웰컴 포트폴리오를 그림.
- 풀스크린 오버레이 화면은 `ShellRoute` 유니온 (`memory | sessions | howItWorks | agentScan | assets | settings | tokenHistory`) → `ShellScreens.tsx`가 디스패치.
- 영속 상태(`stores/uiStore/persistence.ts` 화이트리스트): `runtimeMode`, `activeProjectId`, 테마, 사이드바/BOOK 폭·열림, 섹션 순서 등. `activeSessionId`는 **비영속**.
- 스타일: `styles/globals.css`가 `global-css/*.css`를 순서대로 `@import`. 모드별 CSS 파일은 없고 `[data-vex-runtime-mode="studio"]` 속성 셀렉터로 `shell.css` 안에서 오버라이드.

### 1.3 Agent 모드 (기본)

| 항목 | 현재 |
|---|---|
| 목적 | 사용자가 로컬 에이전트와 세션 단위로 대화. 에이전트가 제안 → 사용자가 승인 |
| 사이드바 | `SessionsList` — 새 세션, 필터(All/Agent/Mission), 검색, 그룹(고정/오늘/어제/이전), $VEX 위젯, `SidebarProfile` 푸터 |
| 센터 | `SessionPanel` — 히어로↔도킹을 같은 DOM에서 `data-phase`로 전환, 트랜스크립트, `ApprovalsRegion`, 미션 레일/컨트롤, 컴포저 |
| 우측 | BOOK 레일 — 포트폴리오/포지션/지갑/세션 활동 카드 스택 (`book/`) |
| 세션 모델 | `sessions(mode: agent|mission, permission, title, pinned_at …)`. **종류/워크스페이스 구분 컬럼 없음** |
| 진입 | 기본. Studio에서 `⌘⇧A` 또는 토글 |

문제점
- 컴포저 오케스트레이션 `composer-submit.ts` 648줄에 "light it up" 가로채기까지 섞임.
- 2차 네비(`SidebarProfile` 메뉴: Memory/Sessions/Agent Scan/Settings)와 사이드바가 목적지를 나눠 갖고 있어 "여기서 어디로 갈 수 있나"가 한 곳에 없음.
- 모드 토글 `RuntimeModeToggle`이 상태에 따라 자리를 옮김 (세션 없으면 히어로, 있으면 사이드바 헤더).

### 1.4 Studio 모드

| 항목 | 현재 |
|---|---|
| 목적 | **외부 코딩 에이전트**(Claude Code 등)가 MCP 소켓으로 Vex를 조종. 앱 안 UI는 채팅이 아니라 워크스페이스(터미널·파일탐색기·뷰어) |
| 사이드바 | `StudioSidebar` — `SessionsList`와 요소 단위로 동일한 크롬, 내용만 Projects + Explorer |
| 센터 | `StudioCenter` — 프로젝트 없으면 `StudioWelcome`, 있으면 keep-alive 워크스페이스(최대 4개, 숨김이지 언마운트 아님) |
| 우측 | 같은 BOOK 레일, 스코프만 `{kind:"project"}` |
| 상태 | `activeProjectId`(영속), 탐색기/터미널 레지스트리는 React 밖 모듈 |
| 세션 | 프로젝트당 backing session 1개, `scope='vex_studio'` — 에이전트 목록에서 제외 |
| 키바인딩 | `studio/keybindings.ts` 순수 테이블 + `useStudioKeybindings` 리스너 1개 + 소유 모듈 디스패치 |

문제점
- `⌘⇧A`는 Studio→Agent만 동작 (리스너가 `StudioCenter` 안에만 있음). 셸 레벨 단축키가 없음.
- 모드 토글이 3군데(에이전트 히어로, Studio 웰컴, Studio 사이드바)에 관례로 복제됨.

### 1.5 Lighter (현재는 "모드"가 아님)

| 항목 | 현재 |
|---|---|
| 목적 | Lighter Core / Robinhood Chain 무기한·현물 트레이딩. 주문은 전부 승인 카드→CONFIRM 경로(카드는 에이전트 PREPARE 또는 §7.11 데스크 레인이 만든다) |
| 진입 | (a) BOOK 레일 탭 옆 `Lighter` 버튼(`book/BookRailStack.tsx:344`), (b) 에이전트 컴포저에 정확히 `light it up` 입력. 둘 다 `window` 이벤트 → `AppShell`의 **로컬 `useState`** `lighterTradingOpen` |
| 화면 | `LighterTradingDialog` 풀스크린 **모달**. 열리면 `SessionPanel`을 언마운트하고 **같은 활성 세션**을 모달 안 채팅 열로 옮겨 붙임 |
| 대화 | 전용 세션 없음. `<SessionPanel surface="embedded">`로 앱 전역 `activeSessionId` 재사용. "Review" 버튼은 그 세션 컴포저 드래프트에 글을 써 넣는 방식이라 드래프트가 이미 있으면 막힘 |
| 데이터 | 호가/체결/캔들은 WS 라이브. 포지션/주문/잔고는 15초 REST 폴링. main에 `order-stream.ts`가 있지만 렌더러에 배선 안 됨 |
| 주문 IPC | 렌더러 → main 주문 채널 **없음** (의도된 설계: 서명은 에이전트 승인 루프만) |
| 승인 | `ApprovalSummaryDto`에 Lighter 전용 kind 없음, `preview.namespace === "lighter"`로 식별 |
| 설정 | Settings `lighterPoints` 섹션(계정 연결·포인트) + `LighterTradingSetupSection`(자본 비율·레버리지) |
| 영속 | 없음. 환경(core/rhc)·마켓·해상도 전부 모달 로컬 state, 닫으면 소실 |

문제점 (사용자가 본 그 위화감의 원인)
1. 모드가 아니라 모달 → 사이드바·BOOK·상태바가 뒤에 그대로 있고, 그 위에 다른 앱이 뜬 느낌.
2. 대화가 하나뿐이라 에이전트 페이지 대화가 Lighter로 "이사"함. 닫으면 다시 돌아옴. 트레이딩 대화와 일반 대화가 같은 트랜스크립트에 섞임.
3. 열 때마다 초기화 — 어느 마켓을 보고 있었는지 기억 못 함.
4. 나가는 길이 모달 닫기(✕)뿐이고, 들어간 뒤엔 어디에 있는지 셸이 말해주지 않음 (사이드바·상태바는 여전히 에이전트 것).

---

## 2. 목표: 세 모드의 정의

| | **Agent** | **Studio** | **Lighter** |
|---|---|---|---|
| 한 문장 | 내 에이전트와 대화하며 온체인 행동을 승인 | 외부 코딩 에이전트에게 Vex를 빌려줌 | 차트·호가·티켓 앞에서 트레이딩 에이전트와 거래 |
| 주 객체 | 세션 | 프로젝트(폴더) | 마켓 + 트레이딩 세션 |
| 진입/이탈 | 기본 | 헤더 토글 | BOOK `Lighter` 버튼 · `light it up` → 들어감 / 사이드바 `← Agent` → 나감 |
| 사이드바 | 세션 목록 | 프로젝트 + 파일 탐색기 | 환경 스위치(Core/RHC) · 마켓 워치리스트 · 트레이딩 세션 목록 |
| 센터 | 트랜스크립트 + 컴포저 | 터미널/파일 워크스페이스 | 차트 + 호가/체결 + 주문 티켓 + 하단(포지션/주문/잔고) |
| 우측 트랙 | BOOK 레일(포트폴리오) | BOOK 레일(프로젝트 스코프) | **트레이딩 대화 레일** (Lighter 전용 세션의 SessionPanel) |
| 대화 | 일반 세션 | 없음(외부 에이전트) | `workspace='lighter'` 세션만. 에이전트 목록에 안 보임 |
| 승인 | 인라인 카드 | GlobalApprovals | 티켓 자리에 카드 (이미 결정된 사항) + GlobalApprovals |
| 영속 | `runtimeMode` | `activeProjectId` | `lighterEnvironment`, `lighterMarketId`, 워치리스트 — **모드 자체는 비영속**(재시작하면 Agent) |
| 단축키 | — | `⌘⇧A` (Studio 안에서만) | 없음 (버튼으로 들어가는 화면) |

원칙
- **한 프레임, 세 내용물.** 그리드·리사이즈·접힘·상태바는 공유. Agent/Studio는 사이드바·센터·우측 슬롯을 쓰고, Lighter는 탐색을 상단 바로 옮겨 센터·우측 슬롯에 더 넓은 폭을 준다.
- **모달 제거.** Lighter는 오버레이가 아니라 자리를 차지하는 모드.
- **진입 문법은 유지.** 헤더 토글은 `Agent | Studio`. Lighter는 토글의 세 번째 칸이 아니라 BOOK 버튼/`light it up`으로 들어가고 `← Agent`로 나오는 화면.
- **대화는 모드에 속한다.** Lighter 세션은 Lighter 모드에서만 만들어지고 보인다.
- **승인 없이 서명 금지.** 모든 주문 변경은 승인 카드를 지나 CONFIRM으로만 실행된다. 카드를 누가 만드느냐는 둘: 에이전트(채팅 PREPARE) 또는 메인의 데스크 레인(§7.11, 렌더러는 선택자만 보내고 조건은 메인이 만든다). 렌더러가 서명할 조건을 메인에 넘기는 IPC는 금지.

---

## 3. Lighter 모드 설계

### 3.1 레이아웃

```
┌ 상단 탐색: ← Agent · Lighter · RHC/Core · Markets & sessions · New session ┐
├ 센터 (≥640) ─────────────────────────────────────┬ 우측 트랙 (300–520) ┤
│ 마켓바: ETH-PERP · 3,205.10 · 24h · 펀딩          │ 트레이딩 대화        │
│ ┌────────────────────────────┬───────────────┐   │ ┌────────────────┐ │
│ │ 차트                       │ 호가/체결      │   │ │ 트랜스크립트     │ │
│ │                            │               │   │ │ [승인 카드]     │ │
│ ├────────────────────────────┴───────────────┤   │ └────────────────┘ │
│ │ 주문 티켓 (승인 카드가 대체)                 │   │ [컴포저]           │
│ ├────────────────────────────────────────────┤   │                    │
│ │ 포지션 | 주문 | 잔고 (접힘 가능)              │   │                    │
│ └────────────────────────────────────────────┘   │                    │
└─────────────────────────────────────────────────┴────────────────────┘
```

- **우측 트랙 = 대화.** 앞서 결정한 "≥1600px에서 4번째 열, 좁으면 드로어"는 셸의 BOOK 트랙이 이미 그 역할을 함: 넓으면 열려 있고, `computeShellColumns`가 센터 최소폭을 못 지키면 스파인(48px)으로 접힘 → 스파인 클릭으로 오버레이 드로어. 별도 드로어 구현 불필요.
- 티켓은 센터 안 고정 열(현재 `--lit-ticket-width`). 승인 카드가 티켓을 대체하는 규칙은 유지.
- 하단 계정 패널은 센터 안 접힘 도크. 센터 높이가 부족하면 접힘 상태를 기본으로.
- 차트 확장(`chartExpanded`)은 센터 안에서 티켓·하단 숨김으로 처리.

### 3.2 상단 탐색 `LighterSidebar`

44px 상단 바가 **`← Agent` 뒤로 버튼 + "Lighter" + 현재 환경**을 항상 표시하고, 영구 왼쪽 레일은 예약하지 않는다. `Markets & sessions`는 상단 바 아래의 오버레이 드로어를 열며 차트 폭을 바꾸지 않는다. 내용:
1. **현재 환경** Core / RHC — 바와 데스크 팔레트에 텍스트와 색으로 함께 표시.
2. **워치리스트** — 즐겨찾기 마켓 + 최근 가격·24h 변화(퍼블릭 stats 스트림 재사용). 클릭 = 활성 마켓 전환 후 드로어 닫힘.
3. **트레이딩 세션** — `workspace='lighter'` 세션만, `SessionGroups` 재사용(고정/오늘/어제/이전). 선택 후 드로어 닫힘.
4. **상단 액션** — 새 세션, 설정, 테마, 프로필. 드로어는 Escape 또는 바깥 클릭으로 닫힘.

### 3.3 센터 `LighterCenter`

- 현재 `TradingWorkspace`(차트/호가/티켓/하단 슬롯)와 리디자인한 컴포넌트를 **모달 없이** 그대로 호스팅. `LighterTradingDialog`의 오케스트레이션 본문을 `useLighterWorkspace()` 훅으로 추출해서 센터가 사용.
- 마켓바(`MarketBar`)는 센터 상단 고정.
- 마켓이 없거나 계정 연결이 없을 때의 **웰컴 상태** `LighterWelcome` — Studio 웰컴과 같은 문법: 목적 한 문장, "마켓 열기", "Settings에서 Lighter 계정 연결", 모드 토글.

### 3.4 우측 트랙 `LighterChatRail`

- `BookPanel`의 모드 분기에 `lighter` 갈래 추가: 활성 트레이딩 세션이 있으면 `<SessionPanel surface="embedded">`, 없으면 스타터 프롬프트 3개(Chart / Flow / Risk — 기존 `LighterConversation` 빈 상태 재사용).
- ~~Review 흐름~~: 티켓의 Long/Short는 §7.11 데스크 레인으로 바뀌었다(컴포저를 거치지 않음). 세션이 없으면 세션 생성 화면으로.
- 승인 카드: 세션 스코프 `ApprovalsRegion`이 대화 레일에 뜨고, Lighter 주문 승인만 티켓 자리에도 복제 표시 (현재 `isLighterOrderApproval` 유지).

### 3.5 전용 트레이딩 세션

옵션 비교
- (A) `scope='lighter'` — Studio 방식. 하지만 세션 CRUD 쿼리 전부가 `VEX_APP_SESSION_SCOPE`를 하드코딩(`main/database/sessions/{create,rename,delete,branch,mission-goal}.ts`)이라 손댈 곳이 많고, scope는 "누가 소유하는 세션인가"의 의미라 오용.
- **(B) 컬럼 추가 `sessions.workspace TEXT NULL CHECK (workspace IN ('lighter'))`** — 마이그레이션 1개. `sessionCreateInputSchema`(agent arm)에 `workspace?: "lighter"`, `sessionListItemSchema`에 `workspace`, 목록 쿼리는 그대로 두고 렌더러에서 필터(`filterSessionsByWorkspace`). **권장.**

세부
- 에이전트 모드 `SessionsList`는 `workspace === null`만, Lighter 탐색 드로어는 `workspace === "lighter"`만.
- Lighter 세션은 `mode: "agent"`(미션 아님) 고정. 제목 기본값 `"{SYMBOL} · {날짜}"`.
- 툴 표면 제한(그 세션에선 Lighter 툴만)은 **범위 밖**. 필요해지면 `workspace`를 main 쪽 세션 컨텍스트에 넘겨 시스템 프롬프트/툴 필터에 쓰면 됨 — 컬럼이 그 훅 역할.
- 마이그레이션 번호: 이 트리의 최신은 162. 공식 앱과 DB를 공유하지 않는 것이 전제(9/16 충돌 사고 참고). 격리 인스턴스 `vex-0917`에서만 적용.

### 3.6 진입 / 이탈 / 영속

- `RuntimeMode = "agent" | "studio" | "lighter"`. **`RuntimeModeToggle`은 `Agent | Studio` 2세그먼트 그대로** — Lighter 모드에서는 토글이 마운트되지 않음(상단 탐색이 다름).
- 진입: BOOK 레일 `Lighter` 버튼과 `light it up` 둘 다 `setRuntimeMode("lighter")`. `LighterTradingHost`, `workspace-command.ts`의 window 이벤트, `AppShell`의 `lighterTradingOpen` 삭제. 컴포저의 문구 감지는 유지.
- 이탈: Lighter 상단 탐색 `← Agent` → `setRuntimeMode("agent")`. `Esc`는 드로어를 닫는 데만 쓰고 모드는 바꾸지 않음.
- 영속: `runtimeMode` 저장 시 `"lighter"`는 `"agent"`로 강등(`coerceRuntimeMode`가 아니라 persist 단계에서) — 버튼으로 들어가는 화면이라 재시작 후 자동 복귀하지 않음. 대신 `lighterEnvironment`("core"|"rhc"), `lighterMarketId`(환경별), `lighterWatchlist`(환경별 marketId 배열), `lighterBottomOpen`은 영속. `activeLighterSessionId`는 비영속(`activeSessionId`와 동일 규칙).
- 마켓 컨텍스트가 대화에 붙어 다니도록 새 Lighter 세션 생성 시 initial turn에 환경·마켓을 명시(현재 `buildLighterReviewMessage`가 하는 방식).

### 3.7 데이터

- 1단계는 현재 훅 그대로(퍼블릭 WS + 계정 15초 폴링).
- 2단계: main의 `order-stream.ts`를 preload 이벤트로 노출(`onAccountOrders`)해서 하단 패널·승인 카드가 체결을 즉시 반영. 폴링은 폴백.

### 3.8 스타일

- 모드 스코프는 관례대로 `[data-vex-runtime-mode="lighter"]` 속성 셀렉터. 새 전역 파일 추가 금지.
- 현재 `lighter-trading.css`(2,043줄)는 `lighter-workspace.css`(레이아웃) / `lighter-ticket.css` / `lighter-book.css` / `lighter-account.css` / `lighter-sidebar.css`로 분할, `globals.css` 매니페스트에 순서대로 등록. 토큰(`--lit-*`)은 `tokens.css` 옆 `lighter-tokens.css`로 승격.
- **톤앤매너 = Vex 셸 기반 환경 팔레트(2026-09-19).** 현재 레이아웃·반경·그림자 체계는 Vex 셸을 유지하되, 데스크와 인접 Vex 채팅 레일의 `data-lighter-environment`가 같은 의미 토큰을 다시 매핑한다. Core는 그래파이트/틸, RHC는 올리브 블랙/라임으로 캔버스·면·선·포커스·선택·액션을 구분하며, 채팅 헤더·트랜스크립트 바닥·컴포저·전송 액션뿐 아니라 라이브 Thinking 패널·Reasoned/Thought 행·tool 내부 상태도 선택한 환경과 이어진다. RHC 차트의 상승/하락 색은 환경 라임과 혼동되지 않도록 별도의 부드러운 틸/레드로 유지하며, Core/RHC 텍스트 레이블도 함께 표시해 색만으로 환경을 전달하지 않는다. 숫자는 Inter Tight `tabular-nums`(거래소 관례).

---

## 4. Agent / Studio 쪽 개선 (모드 분리를 위해 같이 손대는 최소치)

1. **BOOK 레일 `Lighter` 버튼** — `aria-haspopup="dialog"` 제거(더 이상 다이얼로그가 아님), 클릭은 모드 전환. Studio 모드의 BOOK에도 같은 버튼이 있으므로 Studio→Lighter→`← Agent` 경로가 생김: `← Agent` 대신 **들어오기 전 모드로 복귀**(`lighterReturnMode` 비영속 슬롯).
2. **모드 토글 무변경** — `RuntimeModeToggle`은 `Agent | Studio` 그대로, 마운트 지점도 그대로.
3. **`BookPanel` 분기를 모드 레지스트리로** — `{agent, studio, lighter}` → `(state) => ReactNode` 맵. 4갈래 if/else 제거.
4. **`composer-submit.ts`에서 Lighter 가로채기 제거** — 문구 감지는 남기되 결과가 모드 전환이면 컴포저가 아니라 `AppShell` 레벨 커맨드 디스패치로.
5. `SidebarProfile` 메뉴는 그대로 둠(범위 밖). 단 Lighter 모드에서도 같은 푸터를 쓰므로 자동으로 접근 가능.

---

## 5. 구현 단계와 검증 기준

| 단계 | 내용 | 검증 |
|---|---|---|
| **P0 정리** | 리디자인한 5개 파일 모듈화: `useTradeTicketForm`, `ticket-model.ts`, `decimal.ts` 공용화, Dialog 내부 컴포넌트 파일 분리, CSS 분할 | 기존 lighterTrading 테스트 137개 그대로 통과, 타입에러 0 |
| **P1 모드 승격** | `RuntimeMode` 3값(토글은 무변경), `AppShell` 3분기, Lighter 상단 탐색(`← Agent` + 환경 + 마켓/세션 드로어), `LighterCenter`, `LighterChatRail`, 모달·Host·window 이벤트 삭제, BOOK 버튼·`light it up` → 모드 전환, 영속 슬롯 4개 + persist 강등 | `AppShell` e2e: BOOK 버튼/`light it up`으로 진입 → `← Agent`로 들어오기 전 모드 복귀, 재시작 후 Agent로 시작하되 마켓·환경 복원. 기존 Studio 테스트 무변경 통과 |
| **P2 전용 세션** | 마이그레이션 `sessions.workspace`, 스키마·IPC·목록 필터, Lighter 탐색 드로어 세션 목록, Review → Lighter 세션 컴포저, 웰컴/스타터 | 에이전트 목록에 Lighter 세션 미노출·역방향도 동일(단위 테스트), Review 후 드래프트 충돌 0, 승인 카드가 티켓 자리+대화 레일 양쪽에 표시 |
| **P3 완성도** | 워치리스트, `order-stream` 렌더러 배선, CSS 분할·토큰 승격, Studio/Agent 토글 자리 통일, BookPanel 레지스트리 | 격리 인스턴스에서 수동 QA (`docs/QA_MATRIX.md` 형식으로 항목 추가) |

각 단계는 독립적으로 머지 가능. P1이 끝나면 사용자가 본 "구별 안 됨" 문제는 해소되고, P2가 끝나야 "대화가 이사 다니는" 문제가 해소된다.

---

## 6. 결정이 필요한 것

1. **우측 트랙 = 대화 레일** 방식(3.1) 동의? 대안은 센터 안 4번째 열 + 자체 드로어(현재 리디자인 구현) — 셸 리사이저와 이중이 되어 비추천.
2. 전용 세션 저장 방식 **(B) `workspace` 컬럼** 동의? 마이그레이션 1개 추가됨.
3. Lighter 모드 진입 시 **BOOK 포트폴리오 카드**(지갑 잔고 등)는 대화 레일에 밀려 안 보임. 하단 계정 패널의 "잔고" 탭이 대신함 — 괜찮은지.
4. 이탈 버튼은 상단 탐색의 `← Agent`로 고정해 드로어 상태와 무관하게 항상 보인다.
5. P0(코드 정리)를 P1보다 먼저 할지, P1 하면서 같이 할지. 추천: **P1을 하면서 P0** — 어차피 Dialog를 해체하면서 훅 추출이 일어남.

---

## 7. 진입 후 워크스페이스 — perps 데스크 설계

*§3은 "어떻게 들어가고 셸이 어떻게 바뀌나". §7은 "들어간 다음 화면이 어떻게 일하나". 기준: Binance Futures / Hyperliquid의 문법, 단 서명 경로는 Vex 그대로(모든 변경은 에이전트 PREPARE→승인→CONFIRM).*

### 7.0 현재 상태 (리디자인 직후 기준)

| | 현재 | 문제 |
|---|---|---|
| 리사이즈 | 하단 도크 높이 하나만 드래그 가능 (`TradingWorkspace.tsx` 인라인 포인터 코드) | 차트↔호가, 호가↔티켓 폭 고정. 세로 큰 화면·작은 화면 모두 같은 비율 |
| 호가/체결 | 280px, 가격·수량·누적 3열, 체결은 별도 패널 | 넓고 정보 밀도는 낮음. 티켓이 밀려서 "바로 주문"이 안 됨 |
| 티켓 | 모드 7개(Market/Limit/SL/SL-limit/TP/TP-limit/OCO) 탭 + 필드 17개가 항상 펼쳐짐 | 시장가 롱 하나 넣는 데 스캔할 요소가 너무 많음. 레버리지·마진모드·예상 청산가·수수료 없음 |
| 마켓바 | 심볼·최종가·마크·인덱스·24h | 펀딩률/다음 펀딩 카운트다운·OI 없음(데이터는 `publicStats`에 이미 있음) |
| 포지션 표 | side·size·entry·value·uPnL·liq | 마크·마진·레버리지·ROE%·TP/SL 없음. 행 액션(Close/Protect) 없음 |
| 주문 표 | 읽기 전용 | Cancel 없음 |
| 체결 | 없음 | 마이그레이션 162가 fills를 저장하지만 읽기 IPC 없음 |
| AI | 채팅 열 + 스타터 3개, 티켓 Review → 컴포저 드래프트 | 답을 보고 매매로 이어지는 다리가 없음: 에이전트 답변 → 티켓 프리필 경로 없음. 화면 컨텍스트(어느 마켓·포지션)가 질문에 자동으로 안 붙음 |

### 7.1 레이아웃 — 섹션마다 끌어서 조절 (목업 v5 확정)

```
마켓바  ETH-PERP ▾ │ 3,205.10 │ Mark 3,205.4 │ Index 3,204.9 │ Funding +0.0081% · 03:12:40 │ OI $412M │ 24h Vol $1.2B │ H/L
┌ 차트 ──────────────────────────────┃ 티켓 (300, 내용 높이) ─┐
│                                    ┃ Long | Short            │
│                                    ┃ Market Limit ▾  10x·Cross│
│                                    ┃ 수량 [  ] 25 50 75 100  │
│                                    ┃ Slip 0.1 0.5 1 [  ]%    │
│                                    ┃ ☐ Reduce-Only  ☑ TP/SL  │
│                                    ┃ Take Profit [      USD] │
│                                    ┃ Stop Loss   [      USD] │
│                                    ┃ Cost Max · Liq Fee      │
│                                    ┃ [ Long ETH · Market ]   │
│                                    ┠━━━━━━━━━━━━━━━━━━━━━━━━┨ S2 (기본 자동 = 내용 높이)
│                                    ┃ Book | Trades      0.1 ▾│
│                                    ┃ 3,205.3 · spread · mark │ ← 고정
│                                    ┃  Size  Bid │ Ask  Size  │
│                                    ┃  0.90 3205.2│3205.4 0.60│
├━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┻━━━━━━━━━━━━━━━━━━━━━━━━┤ S3
│ 포지션 1 │ 주문 2 │ 체결 │ 잔고                  Cancel all ⌄ │
│ ETH  Long 0.50  Entry 3,180  Mark  Liq  $160·10x  +$12.7 (7.9%)  Protect Close │
└──────────────────────────────────────────────────────────────┘
   S1 = 차트↔우측 열 폭, S2 = 티켓↕호가, S3 = 차트+열↕하단, S4 = 채팅 레일(셸 리사이저)
```

> **2026-09-17 후속: §7.7로 대체.** 우측 열 세로 쌓기(2열)는 Binance 분석 후 **항상 3열 `차트 | 호가+체결 | 티켓`**으로 바뀌었다. 아래 2열 근거는 이력으로 남긴다.

- **왜 3열이 아니라 2열 + 세로 쌓기인가.** Vex는 채팅 레일이 4번째 열이라 1440에서 데스크 폭이 ~810px. `차트 | 호가 | 티켓` 3열이면 차트가 ~290px로 무용. 호가+티켓을 **300px 한 열**에 세로로 쌓으면 차트가 ~500px, 1920에선 ~980px.
- **티켓 위, 호가 아래.** 업계(하이퍼리퀴드·Binance) 표준이 우상단 티켓. "바로 진입"은 Long/Short가 차트 옆 눈높이에 있는 것. 티켓은 기본 **자동(내용 높이)**, 호가가 나머지를 받음. 세로 양보 순서는 고정: 호가가 먼저 자기 바닥(140 = 헤더·인사이드 행·컬럼 라벨·비율 바 + 한쪽 1단)까지 양보하고, 그다음 티켓이 바닥(240)까지 줄며 내부 스크롤, 독은 사용자가 정한 높이를 지킨다. 독이 접히는 건 오직 독 최소(120)로도 두 바닥이 안 들어갈 때뿐(`dockSqueezed`). S2 드래그는 티켓 높이를 열 대비 비율로 **고정**(`ticketShare`), 더블클릭이면 다시 자동(`null`) — 2026-09-17 "섹션별 리사이징이 자유롭지 않다"는 피드백으로 S2 복귀.
- **호가는 Bid | Ask 좌우 배치**, mid·스프레드·mark 행을 호가 영역 **맨 위에 고정**. 세로 배치는 아래쪽(bid 깊은 단)만 잘리는 비대칭이 생기지만, 좌우 배치는 양쪽이 같이 잘리고 best bid/ask는 항상 보임. 누적 바는 중앙선에서 바깥으로.
- **하단 독은 센터 전체 폭**(차트+우측 열 밑). 포지션 표 10열이 차트 폭만으론 안 들어감. **접기**: 활성 탭 재클릭 또는 `⌄` → 32px 스트립. 200px이 차트/호가로 돌아옴 — 900 높이에서 Protect를 펼쳐도 호가가 안 죽는 이유.
- **스플리터 4개, 비율 저장.** S1 우측 열 폭(데스크 폭의 27% 기본, 260px–50%), S2 티켓 높이(자동 기본, 고정 시 열 대비 비율, 240px–열−141), S3 하단 높이(데스크 높이의 20% 기본, 120px–60%이되 차트+열이 381 아래로 못 내려감, +접힘 32), S4 셸 우측 트랙 300–520(§3.1). S1·S2·S3은 px가 아니라 **데스크 대비 비율**로 저장해 창·사이드바·채팅 레일 크기가 바뀌면 차트·열·독이 같은 비율로 함께 줄고 늘어난다(`resolveLighterLayout`이 매 프레임 px로 환산). 세 손잡이 모두 더블클릭 = 기본값.
- 구현: `TradingWorkspace`의 인라인 포인터/키보드 코드를 `useSplitter({axis, min, max, value, onChange, onReset?})` 훅 하나로 추출해 재사용(드래그는 px, 저장은 비율; `onReset`은 S2가 더블클릭을 "자동으로 복귀"로 쓰기 위한 훅). 화살표 키·`role="separator"` aria는 지금 것 그대로.
- **영속**: lighterAnalysisStore `desk.layout: {panelShare, ticketShare | null, bottomShare, bottomCollapsed}` (coerce + 화이트리스트; 이전 px 저장값은 기본 비율로 대체). 채팅 레일 폭은 셸의 BOOK 폭 슬롯이 이미 영속.
- 접기: 하단 → 32px 스트립, 차트 확장(현재 있음). 호가 열 자체 접기·레이아웃 프리셋은 만들지 않음.

### 7.2 호가/체결 축소 + 바로 진입

- 호가는 우측 열 하단, 폭 = 열 폭(300). **좌우 2단 × (수량 | 가격)** — 왼쪽 bid(수량·가격), 오른쪽 ask(가격·수량), 단마다 누적 배경 바. 3열 "Total"은 없음(좌우 배치에선 자리 없음, 툴팁으로).
- **Book | Trades 탭**을 같은 영역에. 고정 상단 행에 mid·스프레드 bps·mark.
- 클릭 = 지정가 (현재 `pricePick` 유지). 티켓이 Market이면 **Limit으로 자동 전환**하고 가격 채움. `⇧`+클릭 = 트리거 가격(스탑/TP 모드일 때).
- 티켓 상단은 **2단으로 끝**: `Long | Short` 큰 세그먼트 → `Market | Limit | ▾ 더보기`(SL/TP/OCO는 메뉴) + 같은 줄 오른쪽 `10x · Cross ›` 칩. 수량 + 단위 토글 + `25 50 75 100%` 칩. 한 줄에 Reduce-only 체크 + Market이면 슬리피지 칩 / Limit이면 `Post-only / IOC` 칩.
- **`▸ Protect (TP / SL)`** 접힘 섹션(기본 접힘): 펼치면 TP·SL 가격 2개 + 각 목표에서의 예상 손익. OCO 모드는 이 섹션이 대체 — 별도 탭 삭제.
- 요약은 **2×2**: Cost(필요 마진) · Max(최대 수량) / Est. liq · Fee. 마진 = 명목/레버리지, 청산가는 Lighter 공식(초기·유지 마진 비율은 `marketMaximum`/leverage overview에서).
- 버튼 아래 한 줄 `Available $… · Margin used …%`. 담보·마진 바·Deposit/Withdraw는 하단 **Balances 탭**으로 이동(티켓에서 제거).
- `10x · Cross ›` 칩은 표시 전용 — 클릭 시 Settings 레버리지 표로 이동(레버리지·자본비율은 Settings-only 원칙).
- 주 버튼 라벨은 상태 서술: `Long ETH · Market 0.50`. 누르면 Review(§7.4)로 이어짐.

### 7.3 perps 정합 — 표와 마켓바

**마켓바** 추가: 펀딩률 + 다음 펀딩 카운트다운, OI(quote), 24h 고/저/거래량. 마크 vs 최종가 색 구분. 전부 `lighterTradingPublicStatsEventSchema.stats`(`markPrice`, `indexPrice`, `openInterestQuote`, `daily`, `funding`)에 이미 있음 — 스키마 변경 0.

**포지션 표** 컬럼: Symbol · Side · Size · Entry · **Mark** · **Liq** · **Margin / Lev** · **uPnL (ROE%)** · **TP/SL** · Actions
- Mark: 활성 마켓은 라이브 stats, 나머지는 스냅샷 폴링값.
- Lev/마진모드: `getLighterLeverageOverview` IPC(Settings가 쓰는 것) 재사용 → `LighterCenter`에서 1회 로드·15초 폴링과 같은 주기. Margin = value / leverage, ROE% = uPnL / margin.
- TP/SL: 오픈 주문 중 `reduceOnly && triggerPrice` 인 것을 마켓·side로 매칭해 표시. 없으면 `Protect` 버튼.
- Actions: **Protect**(티켓을 `Protect` 섹션 펼친 상태로 프리필) · **Close**(시장가 전량 청산 제안).

**주문 표**: Type · Side · Price · Trigger · Size · Filled · TIF · RO · **Cancel**. 상단에 `Cancel all`.

**체결 탭**: `lighter_fills`(마이그레이션 162) 읽기 IPC 1개 추가 `lighterTrading.listFills({environment, marketId?, limit})`. P3.

**잔고 탭**: 담보 · 가용 · uPnL · **마진 사용률 바** · `Deposit / Withdraw` 버튼(에이전트 제안).

**행 액션의 실행 경로** — 렌더러엔 주문 IPC가 없고 만들지도 않는다. 두 가지:
- (a) 컴포저 드래프트에 문장을 써 넣고 사용자가 전송 (현재 Review 방식).
- (b) 트레이딩 세션에 **즉시 전송** → 에이전트가 PREPARE → 승인 카드가 티켓 자리에 → 사용자가 Confirm.
- 제안: **신규 주문은 (a)**(사용자가 문장을 다듬을 여지), **Close / Cancel / Cancel all은 (b)**(파라미터가 없고 어차피 승인 카드에서 한 번 더 확인함). 결정 필요 → §7.6.

### 7.4 AI에게 묻고 → 보고 → 매매하는 루프

세 가지 다리를 놓는다.

1. **화면 컨텍스트가 질문에 자동으로 붙는다.** 채팅 레일 헤더에 컨텍스트 칩 `ETH-PERP · RHC · Long 0.50 @3,180 · uPnL +$12`. 전송 시 `buildDeskContext()`가 한 줄 프리앰블로 메시지 앞에 붙음(현재 `buildLighterReviewMessage`가 하는 방식을 일반 질문으로 확장). 에이전트가 "어느 마켓 얘기냐"를 되묻지 않게.
2. **상태별 퀵 프롬프트** (스타터 3개를 대체):
   - 포지션 없음: `Read this chart` · `Where's the liquidity?` · `Plan a long, 1% risk` · `Plan a short, 1% risk`
   - 포지션 있음: `Should I trim?` · `Set a protective stop` · `What invalidates this?`
   - 컨텍스트 진입점: 호가 벽 우클릭 `Ask about this level`, 포지션 행 `Review this position`.
3. **답변 → 티켓.** 에이전트가 `lighter_order_preview`(읽기 전용) 툴을 돌린 행에 **`Load into ticket`** 칩. 클릭하면 preview 파라미터가 `TradeTicketPrefill`로 들어가고 Protect 섹션까지 채워짐 → 사용자가 확인·수정 → Review. 에이전트가 바로 PREPARE까지 간 경우는 지금처럼 **승인 카드가 티켓 자리**에 뜸. 즉 "제안"은 티켓으로, "실행"은 승인 카드로 — 두 경로가 공존.
   - 구현: 트랜스크립트 툴 행(`ToolLedger`)에 `toolName === "lighter_order_preview"` 훅 → `LighterCenter`가 `onPreviewLoad` 콜백 제공. 렌더러에서 preview 결과 JSON을 파싱하는 zod 스키마 1개 추가(`shared/schemas`). 에이전트가 preview를 먼저 호출하도록 유도하는 건 main 쪽 Lighter 세션 시스템 프롬프트(§3.5 `workspace` 훅)에서 — 선택.

승인 카드는 대화 레일(세션 `ApprovalsRegion`)과 티켓 자리 양쪽에 뜨되 티켓 쪽이 주(§3.4).

### 7.5 단계 (§5의 P1 이후에 얹음)

| 단계 | 내용 | 검증 |
|---|---|---|
| **W1 레이아웃·티켓** | `useSplitter` 추출 + S1/S2/S3, `lighterLayout` 영속, 우측 열 티켓↕호가 세로 쌓기, 호가 Bid|Ask 좌우 + 고정 mid 행 + Book/Trades 탭, 하단 독 전체 폭 + 접기, 티켓 2단 구조 + Protect 접힘 + 요약 2×2 + 레버리지 칩, 마켓바 펀딩/OI | 렌더러만. 스플리터 드래그·키보드·리셋·재시작 복원 테스트, TradeTicket 기존 15개 + Protect 접힘/OCO 대체 테스트, 마켓바 값 테스트 |
| **W2 perps 표** | 포지션 표 Mark/Liq/Margin/ROE/TP-SL, 주문 표 Cancel 열, 잔고 마진 바, 레버리지 overview 재사용 | 계산 순수 함수 단위 테스트(마진·ROE·TP/SL 매칭), AccountPanel 테스트 갱신 |
| **W3 액션·AI 컨텍스트** | Close/Cancel/Cancel-all 즉시 전송(결정 시), Protect 프리필, `buildDeskContext`, 상태별 퀵 프롬프트, 컨텍스트 진입점 | 전송 메시지 문자열 스냅샷 테스트, 프리필 → 티켓 상태 테스트 |
| **W4 답변→티켓·체결** | `lighter_order_preview` 툴 행 `Load into ticket`, preview 결과 스키마, `listFills` IPC + 체결 탭 | preview JSON → prefill 변환 테스트, IPC 스키마 라운드트립 |

### 7.6 결정이 필요한 것 (§6에 추가)

6. 행 액션 실행 경로 — Close/Cancel/Cancel-all은 **즉시 전송(b)**, 신규 주문은 드래프트(a)로 가도 되는지.
7. ~~호가 220px 세로 열~~ → **목업 v5로 확정**: 우측 300px 열에 티켓 위·호가 아래, 호가 Bid|Ask 좌우, 하단 독 전체 폭·접기. (2026-09-17 "너가 하고싶은거 다해봐")
8. SL/TP/OCO를 `Protect` 접힘 섹션으로 합치고 모드 탭 7개 → `Market | Limit | ▾`로 줄이는 것.
9. `Load into ticket`은 에이전트가 `order_preview`를 호출할 때만 뜸 — Lighter 세션 시스템 프롬프트에 "제안 전 preview 호출" 힌트를 넣을지(main 쪽 변경).

### 7.7 Binance 레이아웃 개편 (2026-09-17 구현 반영)

Binance Futures 화면을 분석해 §7.1~7.2를 다음처럼 바꿨다. 서명 경로·승인 카드·Settings-only 레버리지는 그대로.

```
마켓바  Core|RHC  BTC ▾  76,470.7  Mark · 24h · OI · Funding   Perps|Stocks|Spot  [vx Ask Vex ⌘K]  ● Live
┌ 차트 (≥360) ───────────┃ Order Book (≥220) ┃ 티켓 (≥260) ─────────┐
│                        ┃ Price Size  Sum   ┃ Cross · 2x ›          │
│                        ┃ asks ↓ (빨강 바)   ┃ Market | Limit        │
│                        ┃ 76,470.7 spread   ┃ Avbl · Size · slider  │
│                        ┃ bids ↓ (초록 바)   ┃ ☐ Reduce-Only ☐ TP/SL │
│                        ┃ B 52% ━━━━ 48% S  ┃ Order Value · Cost …  │
│                        ┠━━━━━━━━━━━━━━━━━━┨ [ Long ]  [ Short ]   │
│                        ┃ Trades            ┃                       │
├━━━━━━━━━━━━━━━━━━━━━━━━┻━━━━━━━━━━━━━━━━━━┻━━━━━━━━━━━━━━━━━━━━━━┤
│ Positions │ Open Orders │ Trade History │ Assets                       │
└──────────────────────────────────────────────────────────────────────┘
```

- **항상 3열.** `차트 | 호가+체결 | 티켓`. 바닥 360 / 220 / 260, 두 열은 데스크 폭 대비 비율 저장(`bookShare` 기본 0.20, `ticketShare` 0.25, 상한 50%), 호가 열이 먼저 풀리고 티켓은 남는 폭에서. 채팅 레일(BOOK 트랙, 300–520)이 넓으면 차트가 먼저 줄어드는 게 정상 — 1440에서 레일 360이면 차트 ~500.
- **호가는 세로 스택.** asks가 위에서 인사이드로, bids가 인사이드에서 아래로. 행은 `Price | Size | Sum`(Sum은 사이즈 단위 누적, 220 바닥에서 세 열이 들어가도록 라벨은 `Sum`만), 깊이 바는 오른쪽에서 안으로. 헤더 오른쪽에 `BTC|USD` 단위 스위치 + 스택/좌우 뷰 토글, 라벨 행 끝에 그룹핑 셀렉트. 행 높이 **18px**(글자 11px) — 같은 높이에 행 10% 더.
- **체결은 별도 패널.** 호가 열 안에서 호가 아래, 세로 스플리터로 비율 조절(`tradesShare` 0.32 기본, 120px–70%).
- **티켓 순서(Binance).** 레버리지 칩 → `Market | Limit` → Avbl → 가격/사이즈(Qty|Risk 토글 + 슬라이더) → 슬리피지 또는 TIF(GTC/IOC/Post-Only) → `Reduce-Only · TP/SL` 체크 → 요약 → 맨 아래 `Long | Short` 두 버튼(누르는 쪽이 프리뷰). **`More` 셀렉트는 삭제**: 진입에 붙이는 보호는 `TP/SL` 체크박스 하나, 기존 포지션의 스탑/TP는 Positions 탭 `Set stop loss and take profit`(oco 프리필)이나 에이전트 핸드오프로만 티켓에 들어온다. 그렇게 들어온 모드는 세 번째 눌린 탭(`SL + TP` 등)으로 표시되고, Market/Limit을 누르면 빠져나온다. `PROTECTION_MODES` 상수 제거.
- **Ask Vex는 동사, 레일은 명사 (Copilot 패턴).** 상시 커맨드 바(`AskVexBar`, 38px)와 ⌘K 팔레트는 둘 다 만들었다가 뺐다: 레일 컴포저와 입력창이 두 개가 되고, 레일 스코프 스트립의 퀵 프롬프트와 겹치고, `Chat with Vex` 헤딩 옆에 `Ask Vex`가 서면 다른 기능처럼 읽힌다. 남긴 것: (1) 레일 헤딩은 `vx Vex`(답하는 쪽의 이름), (2) 마켓바 `Ask Vex ⌘K` 필과 ⌘K/Ctrl+K는 `useLighterDesk.askVex` — 레일이 접혀 있으면 열고 레일 컴포저에 커서를 둔다, 세션이 없으면 새 세션 모달. 데스크에 두 번째 입력창은 없다. (3) 티켓 `Preview` 옆 `Ask Vex`: 드래프트 사실(`buildAskAboutDraftMessage`)을 질문으로 즉시 보내는 세컨드 오피니언, 아무것도 PREPARE하지 않는다. (4) Positions 행 `Ask`(기존). 답은 전부 레일에 도착.

### 7.8 출시 폴리시 (2026-09-18 구현 반영)

GTM/UX 관점의 마무리. 흐름은 그대로, 언어·바닥 폭·키보드만 손봤다.

- **상태 언어 하나.** 계정 없음 = `Not connected` 한 명사 + `Connect Lighter` 한 동사. 독 헤더 상태(`No account` → `Not connected`), 독 빈 상태, 티켓 게이트가 같은 두 단어. `ambiguous_account`만 `Open Settings`(가야 할 곳이 다르니). 레일 헤딩 옆 `Desk` 칩은 삭제 — 뷰가 하나인데 탭처럼 읽혔다. 컴포저 플레이스홀더는 데스크에서 회전을 멈추고 `Ask about this market, or describe an order.` 한 문장(`LIGHTER_DESK_PLACEHOLDER`) — 스왑/브리지 예문이 라이브 호가 옆에서 돌지 않게.
- **계정 없는 첫 화면.** 티켓은 대시로 채운 폼이 아니라 게이트 한 블록(`data-gate="not-connected"`): 상태 · 한 문장 · `Connect Lighter`. 차트·호가·체결은 그대로 산다. `openTradingSettings`는 누른 버튼의 rect를 `origin`으로 넘겨 Settings가 그 버튼에서 모프한다(`data-vex-morph="trigger"`).
- **바닥 폭(540/220/260)에서 잘림 0.** 세 열을 컨테이너 쿼리 컨테이너로(`.lit-chart-panel`, `.lit-book-column`, `.lit-ticket` — 전부 그리드 트랙이라 안전). 티켓 사실표 `Max Buy Price` → `Max Buy` + 긴 라벨은 `title`, `Fee (Taker 0.0003%)` → `Fee (Taker)` + 요율은 `title`, 슬리피지 필드는 ≤300에서 라벨이 위로. 호가 미드 행은 ≤260에서 스프레드 글자를 내리고 행 `title`로(마크 숫자가 우선). 차트 툴바는 ≤640에서 스터디 리드아웃, ≤600에서 30m·12h(선택된 게 아니면) 숨김 + 탭 30px — 이전의 `@media (max-width: 700px)` 뷰포트 쿼리는 열 안에서 무의미했다.
- **키보드.** Escape가 확장 차트를 접는다(위 레이어 — 피커·스터디 메뉴·드로잉 — 가 `preventDefault`했으면 양보). 차트 툴바 포커스 링을 데스크 토큰(`--lit-focus`, offset 3)으로 통일.
- 확인한 것: DOM 감사에서 라벨 없는 아이콘 버튼 0, 바닥 폭 오버플로 스캔 0, ⌘K → 레일 컴포저 포커스, Escape → 접힘. AAPL 같은 주식 마켓은 장외 시간에 차트가 비는데 이건 데이터 문제라 여기서 안 다뤘다.

### 7.9 Connect Lighter = 온보딩 채팅 (2026-09-18)

계좌를 만드는 화면은 앱에 없다. 온보딩은 처음부터 에이전트의 일이었다(가이드 §05~06: `lighter__account_onboarding_status` → 첫 입금 카드 `LIGHTER:DEPOSIT` → 키 등록 카드 `LIGHTER:KEY.REGISTER` → 수수료 승인 카드). 그래서 티켓 게이트와 도크의 `Connect Lighter`는 Settings(포인트·레버리지 카드, 이미 연결된 지갑용)로 가지 않고 **Deposit 버튼과 같은 채널**로 트레이딩 세션에 `buildConnectMessage`를 보낸다. 상태 확인 후 빠진 단계만, 한 단계에 승인 카드 하나씩. 세션이 없으면 세션 생성 화면으로(`openCreateSession`).

- `desk-messages.ts` `buildConnectMessage({ environment })`; `useLighterDesk.connectLighter`; `AccountActions.onConnect`; `TradeTicket` `onConnect` prop.
- `onOpenSettings`는 `ambiguous_account`의 `Open Settings`와 레버리지 칩에만 남는다.
- Settings → Lighter 빈 상태 문구는 "Open the Lighter desk and press Connect Lighter"로 정정(이전 "Open the Lighter panel"은 존재하지 않는 화면을 가리켰다).

### 7.10 데스크 레버리지 시트 + 폭에 따른 스택 레이아웃 (2026-09-18)

레버리지는 Settings까지 가지 않고 티켓에서 바꾼다. 티켓 마진 칩(`Cross · 26x ›`, `aria-label="Leverage and margin mode"`)이 데스크 위에 **Settings와 같은 시트** `LighterLeverageSheet`를 연다(슬라이더 1x~마켓 최대, 숫자 입력, Max, Cross/Isolated). Apply → 기존 `LighterLeverageConfirmModal`(메인의 제안, 사용자 서명, Confirm은 `{ proposalId }`만). 렌더러가 직접 쓰는 IPC는 없다.

- `DeskLeverage.tsx`: 저장된 연결(`useLighterStoredConnections`)에서 `{environment, accountIndex}`로 지갑 주소를 찾아(`walletForLighterAccount`) `useLighterLeverageChange` + `useLighterLeverageOverview` 스코프를 만든다. 개요가 오기 전엔 `LEVERAGE_LOADING`, 지갑을 못 찾으면 `LEVERAGE_SHEET_NO_WALLET`, 마켓이 목록에 없으면 `LEVERAGE_SHEET_MARKET_MISSING`. 시트는 마운트 때 한 번 초안을 읽으므로 행이 도착하면 `key`로 다시 마운트한다.
- **칩이 실제 숫자를 보인다.** 이전엔 사이즈 0 포지션 행을 `positions`에서 버려서 레버리지를 바꿔도 칩이 마켓 기본값(2x)에 머물렀다. 계정 DTO에 `marginTerms[]`(모든 포지션 행의 `marketId · initialMarginFraction · marginMode`, 사이즈 0 포함)를 추가하고 `resolveTicketMargin(market, marginTerms)`가 마켓 기본값보다 계정 조건을 우선한다(`source: "account" | "market"`). 확인 뒤 settle 경로가 계정 쿼리를 무효화하므로 칩이 곧바로 따라온다.
- Settings의 레버리지 표는 읽기 전용 + `Change` 버튼으로 같은 시트를 연다(`LighterLeverageTable` → `LighterTradingSetupSection`).
- **스택 레이아웃.** 데스크 본체 폭 < `LIGHTER_STACK_BELOW`(1100, 레일이 열린 폭)이면 `.lit-desk-upper[data-stacked]`: 차트가 왼쪽 두 행, 오른쪽은 티켓(`fit-content(62%)`, 넘치면 열 스크롤 + 사이드 버튼 고정) 위 / 호가·체결 아래. 호가와 체결은 그 아래 패널에서 탭(`role="tablist" aria-label="Book panel"`, 두 패널이 `heading` prop으로 같은 탭을 그린다)으로 바꾼다. 스택에선 호가 열 스플리터와 체결 높이 스플리터를 그리지 않는다. 넓어지면 저장된 3열 레이아웃으로 돌아간다.
- 확인한 것: 레일 열림(본체 1070) 스택 + 오버플로 스캔 0, 탭 전환, 칩 → 시트(현재 25.97x cross, 최대 50x, 초안 26) → Close, 레일 접힘(1475) 3열 복귀.

### 7.11 데스크 레인: Close · Cancel · 티켓 진입은 LLM 없이 (2026-09-18)

"거래마다 AI를 부르는 게 맞나"에 대한 답. 파라미터가 화면에 이미 다 있는 세 동작(포지션 Close, 주문 Cancel, 티켓 Long/Short)은 모델을 부르지 않는다. Studio MCP 레인과 같은 구조로 **메인이 결정론적으로 제안을 만들고 같은 승인 카드에 넣는다**. Confirm은 카드 id만 나른다. 카드 뒤에 에이전트 턴은 없다. 도구는 그대로, 부르는 쪽만 AI에서 버튼으로 바뀌었다.

경로: 렌더러 `window.vex.lighterTrading.prepareDeskAction({ sessionId, environment, action })` → 메인 `lighter-desk.ts` `deskActionToPrepareCall`이 선택자를 기존 prepare 도구 호출로 바꾼다 → 엔진 `prepareDeskApproval`(origin `"desk"`, 마이그레이션 164) → 카드 `enqueued { approvalId }` 또는 `refused { reason }` → 렌더러는 pending 쿼리만 무효화 → 티켓 자리에 카드 → Confirm → `dispatch-approved/desk.ts`가 execute 도구를 `approved + approvalId`로 부른다. 결과(`toolOutput`)는 승인 응답에 실려 온다.

- 선택자(`lighterDeskActionSchema`, 전부 strict): `close { marketId }` → `lighter.position.close.prepare`에 **slippageBps 100 고정**; `cancel { marketId, orderId }` → `lighter.order.cancel.prepare`; `order { marketId, draft }` → 티켓 초안 그대로 `lighter.order.preview`(market은 IOC + 30분 만료, 보호 주문은 reduce-only + 1440분, OCO는 `lighter.position.protect`). 렌더러는 슬리피지·만료 같은 정책 값을 보낼 수 없다.
- 카드 필터 `isLighterOrderApproval`은 `order.create · order.cancel · position.close · position.protect` 네 도구를 받는다.
- 티켓 카피: 사이드 버튼은 `Long 0.5 ETH`처럼 동작 그 자체(이전 `Preview …`), 대기 중 `Preparing…`, 각주 "Nothing signs until you confirm the card." 결과는 각주 자리 `.lit-review-outcome`(`data-tone` ok/warn/error): "Order sent." / "Close sent." / "Cancel sent." / 실패는 도구 출력 그대로 / 미확정은 "Outcome unknown. Check the account panel before retrying."
- **보호 주문 후속.** TP/SL을 붙인 진입이 succeeded면 `protectionPrefill`이 반대 사이드·같은 사이즈·reduce-only OCO(한 다리면 stop-loss/take-profit)를 티켓에 싣고 "Protection is loaded below; send it once the entry fills."라고 말한다. 진입이 체결되기 전 보호를 자동으로 보내지 않는다.
- 훅은 자기가 만든 카드 id(`lastDesk`)만 결과로 읽는다. 에이전트가 채팅에서 만든 카드가 같은 자리에서 풀려도 티켓 각주는 조용하다.
- 프로세스 시작 후 첫 sweep 사이클에 `reconcileAbandonedDeskDispatches`가 한 번만 돈다(`origin='desk' AND execution_status='dispatching'` → indeterminate). 매 사이클 돌면 살아 있는 dispatch를 미확정으로 찍는다.
- AI 경로로 남는 것: Ask Vex, Load into ticket, 채팅 주문, Cancel all, Review, Deposit, Withdraw, Connect.
- 빠진 것: `buildLighterReviewMessage`, `buildClosePositionMessage`, `buildCancelOrderMessage`, `useLighterDesk.reviewInChat`.

### 7.12 승인 카드: 사람용 요약 + 카드가 뜨면 호가 칸까지 (2026-09-18)

"카드 크기가 너무 별로야" — 원인은 둘이었다. 260px 티켓 칸에 signed field 27개가 키 이름 그대로 쌓였고, 그 좁은 칸에서 Reason 입력과 REJECT/APPROVE가 두 줄로 접혔다.

- **사람용 행.** `ApprovalCard/lighter-order-facts.ts` `lighterOrderFacts(criticalArgs)`가 `toolId`로 카드를 골라 라벨·값 행을 만든다(`order.create` → 진입, `groupingType: "one-cancels-the-other"`면 OCO, `position.close`, `order.cancel`; 그 외는 null이라 기존 카드 그대로). 진입: Action `Buy 0.0002 BTC` · Market `BTC perp · Robinhood Chain` · Order `Market IOC` · Trigger · Price(`Worst …`) · Notional · Expires(GTC만). OCO: 두 다리 `X trigger · Y bound`. Close: Action `Close 0.5 BTC long` · Worst price · Max slippage. Cancel: Action `Cancel order 12345` · Order `Buy Limit GTC at 75000` · Open `0.3 remaining · 0.2 filled`. 값이 없는 행은 뺀다.
- `ApprovalDetails`는 그 행을 `data-testid="order-facts"`로 먼저 그리고, 원래의 `critical-args` 목록은 `<details>` "All signed fields" 아래로 접는다. 서명되는 필드는 하나도 빠지지 않고, 접힌 채로도 DOM에 남는다.
- ~~**카드가 뜨면 호가 칸을 합친다.**~~ (§7.14에서 모달로 대체) `LighterCenter`가 pending 카드가 있으면 `.lit-desk-upper[data-approving]`: 3열 그리드가 `minmax(0,1fr) (bookWidth + 1 + ticketWidth)px` 두 열이 되고 호가 열과 티켓 스플리터는 숨긴다(스택에선 티켓 열이 두 행을 차지). 카드가 풀리면 저장된 3열로 돌아온다. 드래그 폭은 카드가 없을 때 그대로 조절된다. 섹션 `aria-label`은 `Order approval` / `Order ticket`.
- 확인한 것: 데스크 레인 카드 481px(220 + 1 + 260), 호가 숨김, 행 5개, 상세 접힘, Reason + REJECT/APPROVE 한 줄, Reject 뒤 220/260 복귀.

### 7.13 홈에서 데스크로: Arena 배너 + 칩 (2026-09-18)

Lighter 모드 진입은 정확한 명령 "light it up"과 세션 책 레일의 `Lighter` 버튼뿐이었다. 둘 다 이미 안에 있는 사람 것이다. 캠페인 첫날 앱을 켠 사람은 홈에서 데스크로 가는 문이 없었다.

- `lighterTrading/arena-campaign.ts`: `ARENA_CAMPAIGN { name, venue, startsAt 2026-09-18T11:00Z, endsAt 2026-10-16T11:00Z }`, `arenaCampaignPhase(now)` → `upcoming | live | over`, `arenaCampaignDay(date)`는 UTC 기준 "Sep 18"(캠페인 시계가 UTC다).
- `ArenaCampaignNotice.tsx`: 히어로 헤드라인 아래 `role="status"` 캡슐(`data-vex-area="arena-campaign-notice" data-phase`). upcoming "Perps Trading Arena starts Sep 18, 11:00 UTC, on Lighter Robinhood Chain." / live "… is live on Lighter Robinhood Chain through Oct 16." + 점 / over면 null. 버튼 "Open the desk" = `saveDesk({ environment: "rhc" })` 뒤 `enterLighterMode()`. 시계는 마운트 때 한 번 읽는다(히어로 인사와 같은 규칙).
- 첫 번째 퀵액션 칩 "Trade perps on Lighter"는 초안에 "Light it up."을 채운다. Send가 `isLighterWorkspaceCommand`로 세션을 만들지 않고 데스크를 연다. 유일하게 채팅이 아닌 곳으로 가는 칩이라 `composer-quick-actions.ts`에 그 사실을 적어 뒀다. `how-vex-works-content.md`의 칩 문단도 네 개로.
- 확인한 것: 배너 → 데스크 진입 + RHC 선택(`desk.environment === "rhc"`), 칩 → 초안 "Light it up.", 경계 시각 테스트(10:59:59 / 11:00:00 양 끝).

### 7.14 승인 카드는 출처로 갈린다: 데스크 클릭은 모달, 에이전트 제안은 채팅 (2026-09-18)

"승인카드가 그냥 매뉴얼이면 팝업으로하고, 아니면 채팅만뜨는게어때." §7.12의 호가 칸 병합은 카드가 뜰 때마다 데스크 그리드가 움직였고, 같은 카드가 채팅 레일에도 겹쳐 떴다.

- **출처.** `approvalOriginSchema`에 `desk`가 들어간다(DB 제약 164는 이미 허용, `normaliseIntentOrigin`도 통과). 데스크 레인/티켓이 만든 카드는 `origin: "desk"`, 채팅에서 모델이 만든 카드는 `agent`. 배우 줄은 "You, from the Lighter desk". 데스크 카드엔 Reject 사유 입력이 없다(사유는 모델에게 가는 transcript라 읽을 사람이 없다; `ApprovalDecisionActions rejectReasonInput`).
- **데스크 카드 = 모달.** `lighterTrading/DeskApprovalDialog.tsx`가 `origin === "desk"`인 pending 카드를 `<dialog data-vex-area="lighter-desk-approval">`(560px, "Approve order" / "Nothing signs until you confirm.")에 띄운다. 배경 클릭으로는 안 닫히고 ESC는 숨기기만 한다(카드는 AWAITING 배지에 남아 만료까지 pending, 새 카드가 오면 다시 열린다). 티켓 칸·호가 칸은 그대로다. `data-approving` 그리드 분기와 `.lit-ticket-approvals` CSS는 제거.
- **에이전트 카드 = 채팅 레일만.** `ApprovalsRegion`이 `origin !== "desk"` 행만 그린다. 레일 헤더는 "Vex's proposals land here". 승인 경로는 변하지 않는다: 렌더러는 selector만 보내고, main이 proposal을 만들며, Confirm은 id만 싣는다.
- 확인한 것: 단위 — 데스크/에이전트 혼합에서 티켓 유지 + 다이얼로그에 데스크 카드만, 에이전트만이면 닫힘, ESC 뒤 새 id로 재오픈, 채팅 레일에서 데스크 행 제외, 배우 줄·사유 입력 유무. 라이브 — 2026-09-18 03:42 dev 인스턴스(RHC, BTC): 티켓 Long 0.0002 BTC → `dialog[lighter-desk-approval]`가 데스크 위에 열림, "Approve order / Nothing signs until you confirm.", 카드 REQUESTED BY "You, from the Lighter desk", Buy 0.0002 BTC · Market IOC · Worst 76903.8 · Notional ≈ 15.38, Reason 입력 없음. 같은 카드는 채팅 레일(`.lit-chat-shell`)에 없고 상단 AWAITING 1 배지의 닫힌 글로벌 패널에만 있다. Reject → 다이얼로그 닫히고 카드 0. 두 번 반복(두 번째는 Size 입력 잔여값 "0.00020.0002" → "Enter a size greater than zero."로 버튼 비활성, 지우고 재입력). 서명 없음.


### 7.15 티켓 게이트에 온보딩 체크리스트 (2026-09-18)

"저게뭔말이야?" — 계좌 없는 지갑의 티켓은 문장 하나("first deposit, trading key, and fee approval, one approval card each")로 세 단계를 설명했는데, 어디까지 왔는지는 말하지 않았다. 사용자 선택: 문장에 붙여서 체크리스트로.

- **읽기 IPC.** `vex:lighterTrading:getOnboardingChecklist` `{sessionId, environment}` → `{deposit, key, fee}` (`done | todo`, fee는 `not_required`도). main의 `lighter/onboarding-checklist.ts`가 낮은 조각들로 직접 조립한다: 세션 하이드레이트 → 지갑 주소(`resolveSelectedAddressForRead`), 퍼블릭 `readLighterAccount` → deposit, 볼트 스코프(`listUnlockedLighterTradingCredentialScopes`) → key, `inspectLighterFeeAuthorization` → fee(`ready`=done, `disabled`=not_required, 나머지 todo). 엔진 read 툴의 모델 텍스트는 파싱하지 않는다. 주소만 건너고 키 재료는 없다. 실패는 `provider.unavailable`(retryable)이고 티켓은 문장만 남긴다.
- **렌더러.** `useLighterOnboardingChecklist`는 `accountGap === "not_onboarded"`일 때만 켜지고 20초마다 다시 읽는다(카드 승인 뒤 표시가 따라오게). `TradeTicket` 게이트의 `<ol class="lit-ticket-steps">`는 세 줄을 항상 나열하고(First deposit / Trading key / Fee approval), 읽기가 끝나면 Done / To do / Not needed를 붙인다. Done은 `--lit-positive`.
- 확인한 것: 단위 — 리졸버 3(계좌 없음=전부 todo·fee 안 읽음, 볼트+fee ready=전부 done, disabled/blocked 매핑), IPC 4(DB 준비·실패 코드·잘못된 세션 거부), 티켓(마크 없는 초기 → 체크리스트 마크·`data-state`). 라이브 — 2026-09-18 03:33 dev 인스턴스(Core, 계좌 없는 지갑): 문장 아래 1 First deposit / 2 Trading key / 3 Fee approval 세 줄에 전부 To do, 그 밑 Connect Lighter.

### 7.16 퍼널 카운트: Sentry 옵트인 사용자만 (2026-09-18)

GTM에서 "배너 클릭 → 데스크 진입 → 첫 카드 → 승인" 중 어디서 새는지 볼 수 없었다. 사용자 선택: 새 동의 UI 없이 기존 Sentry 옵트인만 쓴다. 옵트인 안 한 사용자는 세지 않는다.

- **채널.** `vex:telemetry:funnelStep` `{step: arena_banner | desk_enter | desk_card | desk_approve, environment}`. enum과 베뉴만 건너고 자유 텍스트는 없다. main(`ipc/telemetry.ts registerFunnelHandler`)은 `prefs.telemetry.enabled`가 꺼져 있으면 캡처도 로그도 없이 `recorded:false`.
- **Sentry.** `captureFunnelStep`은 SDK가 초기화됐을 때만(=옵트인 뒤에만 로드) `captureMessage`. 태그 `funnelStep`/`environment`, fingerprint `["lighter.funnel", step, environment]`로 단계·베뉴당 이슈 하나, 메시지엔 프로세스 시퀀스 번호가 붙는다 — 앱이 켜둔 dedupe 통합이 같은 메시지 연속 두 건을 버리기 때문(Long 카드 두 번 → 한 번으로 세는 사고). 사용자 식별자는 없다: 단계별 집계 건수가 퍼널이고, 사용자 단위 전환율은 못 센다.
- **렌더러.** `lighterTrading/funnel.ts recordFunnelStep`(fire-and-forget, `renderer-error-report`처럼 브리지 옵셔널 체인). 배너 `openArenaDesk` → `arena_banner`(rhc), `enterLighterMode` → `desk_enter`(데스크 마지막 베뉴), 데스크 레인 `enqueued` → `desk_card`, 데스크 자신의 카드가 approved로 돌아오면 → `desk_approve`(에이전트 카드는 제외).
- 확인한 것: 단위 — lifecycle(미초기화면 no-op, 연속 두 건 메시지 다름·태그/fingerprint 고정), IPC 3(동의 없음 드롭·동의 있음 전달·enum 밖 거부), 데스크 레인(enqueued 뒤 한 번·타인 카드 제외·approve 마지막 호출), 브리지 표면.
