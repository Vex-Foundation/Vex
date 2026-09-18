# Lighter Page UI/UX Refinement

**Status:** Implemented and verified on 2026-09-18  
**Scope:** The complete Lighter desktop surface: market header, chart, book and trades, futures and spot ticket, account dock, Vex rail, responsive layout, motion, accessibility, and the backend states required by those flows.

## Product hierarchy

The primary goal is agent use: the trading surface should help the user ask Vex a useful question and act on a reviewed answer.

1. Confirm the environment, market, product, live price, and data freshness.
2. Ask Vex to analyze the chart, find liquidity, or plan a long or short.
3. Review the answer beside the chart and live depth.
4. If drafting manually, choose behavior and size, inspect economics, and use `Review with Vex` for a second opinion.
5. Prepare the chosen action through its explicit order flow.
6. Confirm or reject the separate approval.
7. Track the exact provider order and fill outcome.
8. Protect the verified filled amount or continue from the account dock.

Vex opens on desk entry. Its independent default share of 32% of the shell leaves room to read answers, while its single header and two-column prompt grid avoid a large introduction. Every quick prompt is visible without sideways scrolling. Asking Vex restores conversation space if the sessions sidebar had squeezed it closed. Analysis prompts and draft review do not automatically prepare a trade.

## User journey and control ownership

The design must preserve Vex's existing theme tokens, typography, glass surfaces, corner radii, focus treatment, and restrained motion. Emphasis comes from hierarchy and contrast using those tokens, rather than a second visual identity for the desk.

| User intent | Where the user acts | Next visible state | What must remain available |
| --- | --- | --- | --- |
| Discover the event or desk | Welcome event card | Lighter opens with Vex visible; campaign entry selects RHC | Clear event phase and schedule |
| Change market or environment | Market picker | Chart, depth, ticket and agent scope follow the selection | Selected chain and product identity |
| Understand the market | Agent prompt or composer | Scoped analysis in the conversation | Chart and depth alongside the answer |
| Develop a trade plan | Long/short planning prompt | Agent proposal to read and refine | Risk intent and current market scope |
| Review a manual draft | Ticket's `Review with Vex` | Draft terms are sent as a question | Entered ticket fields; no automatic order submission |
| Prepare a manual order | Long/Short or Buy/Sell | Separate review and approval | Exact direction, quantity and terms |
| Decide on a pending action | Approval card or ticket Review | Stored approve/reject result | Pending state remains recoverable after dismissing a dialog |
| Check execution | Order result and account dock | Accepted, partial, filled, rejected, canceled or unknown | Exact order identity and the correct next action |
| Recover space | Panel separators, collapse control, right-rail `Open Vex` | Resized or restored surface | Draft values, scope and saved layout preferences |

Only the right rail owns the general agent-entry control. The ticket owns draft review, which carries actual entered order terms. Product tabs select products; environment controls live in the market picker. These actions must not appear interchangeable.

Acceptance is based on the journey above, not button count: no duplicate general AI entry while the panel is open, no hidden primary prompt, no footer covering fields, no sibling panel moving when a list is scrolled, and no lost draft when a panel or sidebar toggles.

## Futures ticket layout

The ticket uses three vertical regions:

- **Fixed context:** leverage/margin mode and available balance.
- **Scrollable fields:** order type, price, size, presets, slippage, time in force, expiry, Reduce-Only, TP/SL, and order facts.
- **Visible action area:** approval status, validation, `Review with Vex`, Long/Short or Buy/Sell, and confirmation copy.

The action area follows the form's natural height, removing the large blank gap between fields and actions. When content exceeds the panel height, the field body shrinks and scrolls while context and actions remain visible. The ticket spans the full primary height in both compact and wide layouts.

### Market flow

`Market → Size → Percentage → Slippage → Order flags → Economics → Review with Vex / manual preparation`

- Slippage remains on one row at the 280 px ticket floor.
- The four primary facts remain compact and legible.
- Secondary fee and maximum-price facts remain in the same scroll region.

### Limit flow

`Limit → Price → Size → Percentage → Time in force → Expiry → Order flags → Economics → Review with Vex / manual preparation`

- Price can be loaded from the book, while Shift-click loads a protection trigger.
- The body scrolls when Limit fields exceed the available height.
- GTC, IOC, and Post-Only stay grouped as one order-behavior choice.

### TP/SL flow

- TP/SL expands inside the field body and leaves the Long/Short actions fixed.
- Take Profit and Stop Loss remain separate, labeled price inputs.
- The UI states that protection is prepared as a separate approval after the entry fills.
- Reduce-Only and attached TP/SL are mutually exclusive, preventing a contradictory draft.

### Leverage flow

- The ticket chip opens the leverage sheet instead of editing account state inline.
- Leverage is displayed and entered as a whole multiplier.
- Confirm uses the main-process prepare, approval, signing, and reconciliation path.
- Completion refreshes provider-backed account, limits, and overview state.

## Responsive behavior

| Constraint | Behavior |
| --- | --- |
| Desk width at least 1,020 px | Chart, order book/trades, and ticket use three columns. |
| Desk width below 1,020 px | Chart and tabbed Order Book/Trades form the left column; the ticket spans both rows on the right. |
| Compact height allocation | Chart and depth default to 2:1 and have their own draggable separator, with a 208 px depth floor. The dock folds if it cannot leave 280 px for the chart plus that depth floor. |
| Ticket width | Bounded to 280–380 px, with compact internal padding through container queries. |
| AI width | Independent 32% default share; rendered at 300–520 px, subject to available shell space. |
| Short height | Within the ticket, only the fields scroll; metadata and actions stay visible. The other panels retain their own scroll regions. |
| Sidebar or Vex rail toggle | Stored splitter shares are bounded and reprojected into the new available width. |

All direct grid columns fill the shell height and constrain their own overflow. This prevents the blank lower strip and panel clipping previously exposed by sidebar and Vex-rail changes.

The compact book defaults to side-by-side bids and asks so both remain visible in a shallow panel. A manual orientation choice persists while mounted. Grouping moved into the book toolbar, and narrow headers wrap the controls onto a second row. Numerical column labels now align with the depth rows.

## Independent panel controls

| Panel | Resize behavior | Scroll ownership |
| --- | --- | --- |
| Chart | Flexible space after ticket/book widths; compact height has its own separator | Chart pan/zoom remains inside the chart |
| Order book | Independent width in wide mode; independent height below the chart in compact mode | Bids and asks scroll separately; inside price and headers stay fixed |
| Trades | Independent height under the wide book; shared depth height as a compact tab | Trade list scrolls inside its panel |
| Ticket | Independent width, with a full-height column | Fields scroll; context and review/order actions remain visible |
| Account | Independent height and collapse control | Account table scrolls on both axes inside the dock |
| Vex | Independent share of shell width, separate from other app modes | Conversation scrolls without moving the desk or composer |

Desk separators support dragging, arrow keys, and double-click reset. Shell separators support dragging and arrow keys, report their current width to assistive technology, and settle interrupted gestures. Ratios persist independently, so adjusting compact depth does not overwrite the wide book/trades ratio. Pixel floors and ceilings protect readable controls when a window becomes too small to preserve every preferred ratio. Panel scroll boundaries contain the gesture instead of scrolling a neighboring surface.

## Event discovery and AI entry

- The welcome event is a distinct card with an upcoming/live badge, event title, UTC schedule, and a solid `Enter with Vex` action.
- The card opens Lighter on Robinhood Chain with Vex visible. It does not claim to register the user in the campaign.
- Campaign phase refreshes every minute while the welcome screen stays open. After the event, the card becomes a permanent Lighter entry.
- Core/RHC switching lives only inside the market picker. The header shows the selected chain as a small part of market identity, with no duplicate environment buttons.
- RHC remains the default environment and the campaign destination. A deliberate Core selection remains available and is remembered.
- The open Vex panel is the primary input surface. There is no repeated `Ask Vex` button in the market bar or chart footer.
- Closing the agent leaves one labeled `Open Vex` control in the right rail. It opens the panel in one click, including after automatic folding. `Meta/Ctrl+K` also opens the panel and focuses its composer.
- `Review with Vex` is a draft action: it sends the entered order terms for review. It does not prepare or submit an order.

## Visual and motion rules

- Market identity and last price lead the header; secondary statistics follow.
- Dense market rows keep exchange-level information density and reliable pointer targets.
- Live status uses a restrained pulse and semantic announcements.
- Price and depth changes use short, local directional feedback.
- Ticket status messages enter over 160 ms without shifting the action area.
- Buttons expose visible keyboard focus and a small pressed response.
- `prefers-reduced-motion` collapses transitions and animations to their final state.

## Accessibility and interaction targets

| Surface | User action | Stable semantic target |
| --- | --- | --- |
| Market header | Open market picker | `.lit-market-select[data-lit-market-picker-trigger="true"]` |
| Market picker | Change environment | Named Core/RHC radio group |
| Market header | Change product | Named pressed-button group |
| Chart | Change resolution, study, drawing, or view | Named toolbar controls |
| Order book | Load a price or protection trigger | `.lit-book-row` with a complete accessible description |
| Ticket | Change order type or size mode | Named pressed-button groups |
| Ticket | Open leverage settings | `Leverage and margin mode` button |
| Ticket | Prepare an order | Named Long/Short or Buy/Sell buttons in `.lit-side-actions` |
| Account dock | Change account view | Roving tabs with arrow, Home, and End navigation |
| Vex rail | Use a scoped prompt | `.lit-desk-quick > button` |

## GTM contract

The experience keeps one consent-gated event path. It measures entry, setup, approval, provider acceptance, partial fill, fill, cancellation, rejection, and unknown outcomes. Events exclude wallet addresses, order payloads, and free text. The page does not create a second analytics pipeline.

The permanent Lighter entry remains available outside campaign periods. Campaign presentation can add context, but it does not own product discovery.

## Backend alignment

The UI refinement required runtime changes where presentation depended on stronger facts:

- whole-number leverage preparation, execution, durable cancellation, and provider reconciliation
- strict Lighter workspace enforcement for Desk IPC
- duplicate preparation prevention and single-flight dispatch
- recovery for approved, interrupted, and repeatedly unsettled Desk intents
- atomic resolution of stop/enqueue races
- exact provider order-ID and fill correlation
- protection sizing from verified filled quantity
- spot base-inventory handling, fee-aware maximums, size-step flooring, and quote-minimum validation
- workspace-scoped session reads and bounded provider-field projection
- durable onboarding progress and one truthful next action

These contracts are detailed in `LIGHTER_DESK_PRODUCT_UX.md`.

## Key implementation files

- `src/renderer/features/appShell/lighterTrading/TradeTicket.tsx`
- `src/renderer/features/appShell/lighterTrading/LighterCenter.tsx`
- `src/renderer/features/appShell/lighterTrading/MarketBar.tsx`
- `src/renderer/features/appShell/lighterTrading/MarketChart.tsx`
- `src/renderer/features/appShell/lighterTrading/OrderBook.tsx`
- `src/renderer/features/appShell/lighterTrading/AccountPanel.tsx`
- `src/renderer/features/appShell/lighterTrading/LighterChatRail.tsx`
- `src/renderer/styles/global-css/lighter-ticket.css`
- `src/renderer/styles/global-css/lighter-desk.css`
- `src/renderer/styles/global-css/lighter-market-bar.css`
- `src/renderer/styles/global-css/lighter-chart.css`
- `src/renderer/styles/global-css/lighter-book.css`
- `src/renderer/styles/global-css/lighter-account.css`
- `src/renderer/styles/global-css/lighter-chat.css`

## Verification snapshot

### Latest agent journey and independent-panel follow-up

- Lighter, store, shell, conversation handoff, BookPanel, and campaign regression suite: 41 files and 347 tests passed.
- Shell resize regression: 1 file and 3 tests passed, covering final pointer release, cancellation/restart, and keyboard control. Combined scoped coverage: 42 files, 350 tests.
- Vex app build and artifact check passed. Type/boundary gates and the renderer build were repeated after the shell resize changes. The type ratchet permits 312 existing errors; this is not a zero-error type-check claim.
- Actual Electron checks covered event-card entry, the compact market header, visible agent prompts, sidebar expansion/collapse, and the `Open Vex` state.
- Keyboard resizing changed the AI panel from 300 to 396 px and compact depth from 208 to 232 px; the corresponding sibling panels reflowed. Conversation scrolling left the chart and ticket in place.
- Pointer release/cancellation behavior is covered by component tests. The computer-use drag gesture did not produce a reliable native resize observation, so native pointer dragging is not claimed as verified by this pass.
- `git diff --check` passed.

### Earlier workstream checks

These are the earlier checks for the broader backend and ticket work, not a rerun of the complete application suite after this layout follow-up.

- Final ticket regression: 3 files and 46 tests passed.
- Complete `lighterTrading` directory rerun: 35 files and 255 tests passed.
- Focused Lighter renderer suite: 42 files and 354 tests passed.
- Focused backend suite: 7 files and 117 tests passed.
- Full Vex app unit suite: 924 files and 12,722 tests passed; 51 tests skipped.
- Full workspace unit suite: 1,500 files and 22,458 tests passed; 75 tests skipped.
- Vex app and workspace builds passed, including type, process-boundary, artifact, unsafe-escape, and diff checks. The Vex app build and artifact check were repeated after the final ticket layout change.
- Real Electron verification passed at 1,444 x 768 across both sidebar states and both Vex-rail states.
- Short-window Electron verification passed at 1,135 x 721 for Market, Limit, and expanded TP/SL. Fixed context and actions stayed visible, all variable controls remained reachable, and the lower Order Book panel stayed available.

The visual pass did not press Long/Short, approve a transaction, or change live leverage. It verifies the user interface and code paths without mutating a trading account.
