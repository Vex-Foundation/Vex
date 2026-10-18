# App reference images (R3 Minimal: VEX Desktop)

The approved R3 Minimal desktop mockups and real captures of the built desktop app. The screens of the unreleased VEX Cloud web app are not part of this public copy. Open the images that match your screen before any app work, then build from `references/APP-R3.md` (layout) and `references/ELEMENTS.md` (elements). All JPEG, at most 1600 wide, each under 400 KB; 22 files, about 3.6 MB.

Light = Celeris, dark = Chronos ("Night Ledger"). Frames are 1440 x 900 windows.

- **`mock-*`** are the approved mockups: the reference renders of `vex-app/docs/design/R3-MINIMAL.md` (Vex-Foundation/Vex `vex-app/docs/design/r3/`). Their names and figures are samples, never values.
- **`real-*`** are captures of the built desktop app (review of 2026-10-17 and 18), with fixture data. Where a mockup and a capture differ, the capture is what ships.

## Desktop mockups

| File | Shows | Use it for |
|---|---|---|
| `mock-desktop-welcome-light.jpg`, `-dark.jpg` | the welcome: left sidebar 264, no Vex sidebar, Vex on her token centred (no state word under her), the serif greeting, the 720 composer, four task rows, "Needs you · 0" in the top bar | any welcome or empty start screen |
| `mock-desktop-chat-working-light.jpg`, `-dark.jpg` | a chat while Vex works: the top bar chip "Working 0:02", the user block on the blue rule, the folded "2 tool calls" row, the result line with freshness, the live row with its timer, the composer with the options control, "Funds require approval", "Context 21%" and "Stop agent"; the Vex sidebar "This chat: Working", narration, "1 mission running", Needs you, the 280 portrait plate, "Show avatar" | the transcript, the composer, the Vex sidebar |
| `mock-desktop-vex-hidden-light.jpg` | the same chat with Vex hidden: zero width, the transcript recentred, the chip keeps the token, the fill and "Working 0:02" | the toggle, the centred column |
| `mock-desktop-approval-light.jpg`, `-dark.jpg` | the inline approval card: hatch band, "Approval needed", expiry, REAL FUNDS, HIGH RISK, the plain sentence, the source row, money lines, risk sentences, "All signed fields", Reason, Reject focused, "Approve bridge"; the composer's "Waiting for approval" tag; Vex with her palm toward the card; Needs you · 1 | approvals and money confirmations |
| `mock-desktop-needs-you-page-light.jpg` | the Needs you page: decisions grouped by session, the first as the full card, the others as rows with Reject and Review | the decision list |
| `mock-desktop-portfolio-light.jpg` | Portfolio as a page: what the total includes, the mono headline, the snapshot change in ink, Wallets and Balances tables, the Lighter account apart with uPnL in trading colours, activity rows ending in a word | money pages, tables, trading colours |
| `mock-desktop-lighter-light.jpg` | the Lighter desk: the rail, the market bar, the chart (candles keep their pair), the order book in trade up and down, the 338 ticket with Long and Short trade fills | trading surfaces |
| `mock-desktop-wake-light.jpg` | the wake: the 720 print plate, Vex rising from the token mid yawn, "Waking the desk", the five stage lines and the progress line | boot and gate screens |
| `mock-desktop-unlock-dark.jpg` | unlock at night: Vex awake over "Ready", "Welcome back.", the master password field, "Unlock →" | sign in, gates |
| `mock-desktop-system-states-light.jpg` | system states (1440 x 2032): Vex stills (Looking at you, Working, Concerned, Error, Sleeping) with their words, toasts (info, warn, failure with the hatch band, "+2 more in the notification center"), the update card in six states, the three money outcomes (Not submitted, Submitted awaiting confirmation, Status unknown), empty blocks, loading and could not load | toasts, update card, money outcomes, empty and loading states |

## The kit (desktop design source, light and dark)

| File | Shows | Use it for |
|---|---|---|
| `mock-kit-1-tokens-type-states-light.jpg` | tokens, the type scale, the state swatches with words, buttons, fields, switches, the left sidebar open and as a rail, the title bar variants | every primitive |
| `mock-kit-2-composer-transcript-approval-light.jpg` | the composer in every state, messages and tool rows (done, live, failed, open), the turn error, the approval card with the raw fields open and the armed second click | conversation and approval parts |
| `mock-kit-3-vex-sidebar-states-light.jpg`, `-dark.jpg` | the Vex sidebar in R3b order (state, narration, background work, Needs you, the plate, Show avatar) and her ten portraits with words (Ready, Looking at you, Listening, Thinking, Working, Waiting for approval, Done, Concerned, Error, Sleeping), the hidden chip variants, and avatar off (the 44 flat token beside the state; the shipped desktop adds a thin state ring) | Vex's moods, the state line, the chip, avatar off |

## Real captures of the built desktop app

| File | Shows | Use it for |
|---|---|---|
| `real-desktop-welcome-waking-light.jpg` | the built desktop welcome mid wake: Vex rubbing an eye on her token, "Evening. Markets never sleep.", the composer, the four task rows | the welcome as it ships |
| `real-desktop-welcome-token-only-light.jpg` | the welcome after the token press: Vex closed into the upright coin, the stage collapsed, the greeting and composer moved up | the token toggle |
| `real-desktop-chat-ready-dark.jpg` | a built chat at night: "This chat: Ready", "2 missions running", the folded tool row, Reasoned, the composer at rest (dotted send key) | Chronos in a working view |
| `real-desktop-approval-light.jpg` | the built approval card with "Not available" money lines, the risk sentences, "Approve bridge"; Vex's palm toward it; "Needs you · 1" | how missing quotes read |
| `real-desktop-portfolio-dark.jpg` | the built Portfolio at night | money pages in Chronos |

## Retired

The V10 Spread renders (d1 to d8, the agent states with the eagle, the BOOK head, the handoff, the v0.3.1 compares and the round 1 phone mockup) were removed on 2026-10-18 with the spread itself. They stay in the git history of Vex-Foundation/Vex before `design/r3-minimal`.
