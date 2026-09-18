# Lighter Desk Product, UX, Motion, and Runtime Contract

**Status:** Current implementation reference  
**Updated:** 2026-09-18  
**Scope:** Vex desktop Lighter workspace, from entry through setup, order approval, provider outcome, account review, and recovery.

This document records the implemented behavior. The older `LIGHTER_MODE_DESIGN.md` remains a historical pre-implementation proposal.

## 1. Product job

The primary product goal is to help a person use Vex to understand a market, develop a plan, and review a proposed trade. The chart, liquidity, and manual ticket supply context for that conversation. Executable actions still require a separate approval, and the desk tracks the provider outcome and subsequent position protection.

The experience follows five rules:

1. The chart, order book, ticket, account state, and Vex conversation always share one explicit environment and market scope.
2. A ticket click prepares an approval. It does not sign or broadcast by itself.
3. Provider acceptance, an open order, a partial fill, a complete fill, a rejection, a cancellation, and an unknown outcome are separate states.
4. Every blocked state gives one safe next action.
5. Dense market data stays compact, while controls retain visible focus, useful pointer targets, and reduced-motion behavior.

## 2. End-to-end journey

| Stage | UI state | Runtime source | Primary action | Exit condition |
| --- | --- | --- | --- | --- |
| Discover | Permanent Lighter entry, with campaign context while active | Welcome shell | Open Lighter | Lighter workspace mounts |
| Scope | Environment, market, product category, interval | Persisted desk state and live market list | Select market or keep the matching symbol across environments | Market data is selected |
| Analyze and plan | Open Vex conversation with visible chart, liquidity, long-plan, and short-plan prompts | Scoped chat message and fresh agent reads | Ask Vex about the visible market | Agent analysis or plan is available to review |
| Setup | Not started, in progress, approval required, reconciliation required, failed, or ready | Durable onboarding workflow plus live account, key, and fee reads | Set up, Continue setup, or Check setup | Trading account is readable |
| Draft review | Market/Limit, side, size, price protection, reduce-only, TP/SL | Live book, account balance, inventory, margin terms, market limits | Review with Vex | Draft is sent as an analysis question; no order is prepared |
| Manual preparation | Valid ticket and Long/Short or Buy/Sell actions | Strict selector derived from the draft | Prepare the chosen side | Main accepts the selector |
| Prepare | Buttons show `Preparing…` | Main process derives authoritative terms | Wait | One approval card exists |
| Approve | Modal and persistent ticket state show the pending decision | Approval repository | Confirm or Reject | Decision is stored |
| Execute | Provider submission is running | Approval runtime | Wait | Provider evidence returns |
| Track | Accepted, open, or partially filled, with exact order identity | Provider order ID, active orders, and fills | Track in Orders | Order reaches a terminal state |
| Settle | Filled, rejected, canceled, or unknown | Exact provider evidence | Protect, edit, or refresh according to state | User starts the next safe action |
| Protect | Protection is loaded for the verified filled amount | Exact fill total | Submit separate protection approval | Protection order is prepared |

### Setup projection

The renderer no longer reduces every incomplete setup to `Not connected`. The checklist carries:

- `progress`: `not_started`, `in_progress`, `action_required`, `needs_reconciliation`, `failed`, or `ready`
- a bounded user-facing detail
- one `nextAction`
- the durable workflow update time
- the three observable steps: first deposit, trading key, and fee approval

Examples include waiting for Lighter credit after an Ethereum confirmation, waiting for a trading-key confirmation, and requiring a status check after an ambiguous transition.

## 3. Information architecture

### Event entry

- A prominent welcome card separates the event title, upcoming/live badge, UTC schedule, and `Enter with Vex` action.
- Opening the card selects the campaign environment and opens Vex. It does not imply campaign registration.
- The phase refreshes once per minute while mounted; the card becomes a permanent Lighter entry after the campaign.

### Market header

- Market identity and product type are first.
- Last price and daily change are the primary numerical readout.
- Mark, index, high, low, volume, open interest, and funding follow as secondary metrics.
- Market status and chart-candle status remain distinct.
- Long market names truncate instead of pushing controls out of view.
- Product selection contains Perps, Stocks, and Spot. Core/RHC switching lives only in the market picker; the selected chain appears in the market subtitle. RHC is the default and campaign destination.

### Chart and market interaction

- The chart stays focused on market inspection, without a repeated agent-entry button. `Meta/Ctrl+K` opens Vex and focuses its composer.

- Resolution, chart type, studies, drawings, fill visibility, reset, live positioning, and expand controls keep visible keyboard focus.
- Clicking a book or trade price loads a limit price. Shift-clicking loads a protection trigger.
- The ticket shows this interaction as visible helper text.
- Line/candle changes preserve the visible logical range only during the actual chart-type transition.
- Chart fill markers use exact decimal aggregation and stay scoped to the active market and position.

### Order book and trades

- Rows keep compact exchange density with a minimum pointer target.
- The inside price remains visually pinned. Bids and asks have separate scroll regions, including stacked depth.
- Reconnecting streams expose `aria-busy`; status dots announce changes politely.
- Price, size unit, grouping, stacked/split view, depth ratio, and trade direction remain readable at the minimum column width.
- A compact book defaults to side-by-side bids and asks. The tall three-column book defaults to stacked depth. An explicit user choice overrides that automatic orientation.
- Price grouping sits with the view controls; data headers align with their numerical columns. Narrow book headers use two rows rather than clipping controls.

### Ticket

- The ticket has a 280 px minimum and a 380 px maximum width, leaving room for market context and Vex.
- Leverage/margin mode and available balance share one fixed metadata row.
- The variable-height field body scrolls independently in a short window. The account context and order actions never scroll under, or overlap, that body.
- Market keeps size, presets, slippage, flags, and primary economics in one compact scan path.
- Limit adds price, time in force, expiry, and optional TP/SL in the same field body without moving the Long/Short actions.
- Spot sells use base inventory; spot buys use settlement inventory.
- Market maximums reserve price protection and fees. Quantities floor to the venue size step.
- Base and quote minimums are both validated.
- Spot orders do not show Reduce Only.
- Reduce Only and attached TP/SL cannot produce contradictory drafts.
- The footer follows the natural form height rather than leaving a large gap above the actions. When fields overflow, only the body scrolls.
- `Review with Vex` precedes the compact Long/Short or Buy/Sell actions. It remains visible while the draft is incomplete, with validation explaining its disabled state.
- A dismissed approval remains visible as `Approval waiting` with a Review action.
- Setup is described as setup, rather than as an instant connection.

### Account dock

- Positions, Orders, Fills, and Balances use a roving tab stop with arrow, Home, and End navigation.
- Equity, available balance, unrealized PnL, and margin include the settlement unit.
- Position protection, partial close controls, open-order identity, fill history truncation, and account freshness remain explicit.
- The dock auto-folds only when the chart/book/trades minimum height cannot fit.
- Deposit and withdrawal copy matches capability: deposits use Vex approvals; withdrawal help explains the provider-side flow.

### Vex rail and sidebar

- The rail header is one compact row. Repeated explanatory copy was removed.
- Entering Lighter opens Vex and collapses the sessions sidebar to preserve conversation space.
- Vex starts at 32% of shell width, renders within 300–520 px, and remembers its proportion independently from the portfolio panel in other modes. The shell may reduce the rendered width to fit the viewport.
- Environment, market, and interval appear above a two-column prompt grid. All four flat-position prompts remain visible without horizontal scrolling; position-management prompts replace them when relevant.
- Quick prompts remain scoped to the visible chart and support keyboard focus. They request analysis or planning and do not themselves prepare or execute an order.
- The closed rail exposes one labeled `Open Vex` control. Opening it, using the shortcut, or requesting draft review restores conversation space if the sessions sidebar had squeezed it closed.
- The composer is visually separated from history.
- Sidebar collapse and expansion preserve the desk layout rather than resetting panel shares.
- Every direct Lighter grid column fills the available frame height and constrains its own overflow, so toggling the sidebar or Vex rail cannot expose an empty strip below the desk.

## 4. Responsive layout

The layout resolves from the measured desk container, not from window width alone.

| Constraint | Implemented behavior |
| --- | --- |
| Desk width at least 1020 px | Chart, order book/trades, and ticket render as three columns |
| Desk width below 1020 px | Chart above tabbed Order Book/Trades on the left; ticket spans both rows on the right |
| Chart | 360 px preferred minimum |
| Order book column | 220 px minimum |
| Ticket column | 280 px minimum, 380 px maximum |
| Bottom dock | 120 px minimum; folds to a 32 px bar when vertical space cannot satisfy primary panels |
| User resizing | Splitter positions persist as bounded shares and scale with sidebar, rail, or window changes |

The compact left column defaults to a 2:1 chart/depth ratio. Its own draggable separator persists that ratio independently from the wide book/trades split, with a 208 px depth floor. The vertical solver reserves 280 px for the chart and 208 px for depth before allocating an expanded account dock; a short window folds that dock to its tab bar. The ticket keeps the full primary height. Ticket padding, slippage controls, and account controls compact further through container queries.

## 5. Motion and feedback

Motion communicates state changes without moving the trading layout.

- Hover and pressed feedback: approximately 120 to 140 ms.
- Ticket status entry: 160 ms with a short opacity/vertical transition.
- Live connection pulse: 2.4 s and low amplitude.
- Chart reconnect pulse: 1.6 s.
- Price and depth flashes remain directional and localized to changed values.
- Loading, environment changes, and market changes preserve panel dimensions.
- `prefers-reduced-motion` collapses desk transitions and animations to their final state.

## 6. Approval and backend guarantees

### Preparation and duplicate prevention

- The renderer submits only a strict action selector.
- Main derives authoritative order terms and verifies that the session belongs to the Lighter workspace.
- Concurrent identical prepare requests share one in-flight result. A rapid double click cannot create two independently approvable cards.
- Later deliberate submissions remain separate and re-read live market state.

### Dispatch and recovery

- Desk dispatch uses explicit compare-and-set transitions and single-flight execution.
- Startup repair does not race a live dispatch.
- Approved `not_started` work and interrupted `dispatching` work are reconciled.
- Repeated settlement write failures do not leave an intent permanently stuck in `dispatching`.
- Stop/enqueue races resolve the approval intent instead of leaving a permanent undecided row.
- Workspace checks prevent a non-Lighter session from invoking Desk preparation.

### Leverage

- Leverage is displayed and entered as a whole multiplier.
- Confirm uses the real main-process preparation and signed Lighter transaction path.
- The view reconciles provider state after completion and invalidates account, limit, and overview reads.
- Cancelled and superseded leverage intents have explicit durable states.

### Provider outcome identity

- Order tracking uses the exact provider order ID.
- Fills are matched to that order, not to another fill on the same market or a nearby timestamp.
- Partial fills remain in Tracking while the remainder is open.
- Attached protection is sized from the verified filled amount.
- Truncated fill history and incomplete account reads produce a warning and block unsafe assumptions.

## 7. GTM measurement contract

Funnel events remain consent-gated and contain no wallet address, order payload, or free text.

| Event | Meaning |
| --- | --- |
| `arena_banner` | Campaign entry clicked |
| `desk_entry_cta` | Permanent Lighter entry clicked |
| `desk_enter` | Lighter workspace entered |
| `desk_setup_start` | Setup or setup-status CTA clicked |
| `desk_card` | A Desk approval card was enqueued |
| `desk_approve` | The user approved a Desk card |
| `desk_approval_rejected` | The user rejected a Desk card |
| `desk_order_accepted` | Lighter accepted or opened the order |
| `desk_order_partial` | An exact partial fill was observed |
| `desk_order_filled` | The exact order reached a filled state |
| `desk_order_canceled` | The order ended canceled |
| `desk_order_rejected` | Preparation execution or Lighter rejected the order |
| `desk_order_unknown` | The outcome could not be proven safely |

These events support aggregate conversion analysis. Durable per-journey attribution is intentionally not claimed by the current consent-gated Sentry counter.

## 8. Safety and trust language

- The interface says `Nothing signs until you confirm.`
- Unknown outcomes instruct the user to open Orders and refresh before retrying.
- Accepted but unsettled orders show that they are still confirming and must not be retried.
- Rejected and canceled outcomes are different.
- A real order, deposit, withdrawal, or leverage change requires a separate explicit approval.
- This implementation and its automated verification do not mutate a live trading account.

## 9. Implemented correction inventory

The current workstream includes:

- integer leverage display and real apply/reconcile behavior
- approval settlement repair, stop/enqueue atomicity, recovery race fixes, and workspace enforcement
- exact order/fill correlation and actual-fill protection sizing
- market/limit pricing, spot inventory, fee-aware maximum sizing, size-step flooring, and quote minimum validation
- chart range and fill-marker corrections
- workspace-scoped session reads
- bounded provider-field projection
- accurate transcript/result mapping
- compact market header, Vex rail, ticket, and account dock
- responsive ticket/book/chart priorities and persistent splitter layout
- keyboard, focus, loading, and reduced-motion improvements
- durable onboarding progress projection and truthful setup copy
- permanent Lighter discovery entry and expanded consent-gated funnel stages
- in-flight duplicate Desk preparation prevention

Component-level visual details are also recorded in `LIGHTER_PAGE_UIUX_REFINEMENT.md`.

## 10. Verification contract

Required checks for this surface are:

1. Renderer unit tests for layout, ticket, approval, chart, account, desk lane, and responsive metrics.
2. Main-process unit tests for onboarding, Desk IPC, leverage preparation/execution, account reads, and approval mapping.
3. Engine tests for approval lifecycle, recovery, repositories, and migrations.
4. Type checks, process-boundary checks, build artifact checks, unsafe-test-escape checks, and `git diff --check`.
5. A real Electron visual pass at compact and wide desktop sizes, including sidebar and chat-rail open/closed states.

The latest agent-journey and panel-layout follow-up passed 41 scoped files / 347 tests, plus 3 shell-resize tests in one additional file. The Vex app build, final renderer build, artifact check, type/boundary gates, and diff check passed. The type ratchet allows 312 pre-existing errors. Electron verification covered campaign entry, market-header cleanup, prompt visibility, sidebar states, independent conversation scrolling, and keyboard panel resizing (AI 300 → 396 px; compact depth 208 → 232 px). Native pointer dragging was not reliably observed through the computer-use tool; final pointer release and cancellation are covered by component tests.

The earlier 2026-09-18 verification snapshot for the broader workstream recorded:

- The final futures-ticket follow-up passing 3 targeted files and 46 tests, followed by the complete `lighterTrading` directory passing 35 files and 255 tests.
- 42 focused Lighter renderer files and 354 tests passing.
- 7 focused backend files and 117 tests passing.
- 924 Vex app unit-test files passing, with 12,722 tests passing and 51 skipped.
- 1,500 workspace unit-test files passing, with 22,458 tests passing and 75 skipped.
- Vex app and workspace builds passing, including type, boundary, artifact, unsafe-escape, and diff checks. The Vex app build and artifact check were repeated after the final ticket layout change.
- The final shell-height adjustment passing its 31-test sidebar regression suite.
- A real Electron pass at 1,444 x 768 with both sidebar states and both Vex-rail states, confirming that the chart, book, ticket, and account dock remain aligned without clipping or a blank lower region.
- A short-window Electron pass at 1,135 x 721 covering Market, Limit, and expanded TP/SL. The ticket metadata and order actions remained fixed, every variable field and fact remained reachable through the ticket-body scroll, and the lower Order Book panel stayed visible.

No automated test or screenshot is evidence that a live financial action was executed. Live execution requires a separately authorized canary with an explicit environment, account, market, amount, and recovery plan.

## 11. Known product limits

- Fill history is a bounded recent page. The UI reports truncation, but cursor-based history navigation is not implemented here.
- Funnel counters are aggregate, consent-gated events. They do not provide durable user-journey correlation.
- Withdrawal remains provider-side guidance because Vex has no withdrawal execution tool.
- Touch does not have a modifier-key equivalent for the Shift-click protection shortcut; direct ticket fields remain available.
- The existing aggregate funnel covers desk entry and execution states, not a complete agent-adoption funnel. AI prompt use, useful responses, and follow-through still need a separately defined measurement contract.
