# Element catalogue: how to build every R3 app element

Every element VEX Desktop and VEX Cloud `/app` share in R3 Minimal, written so an agent can build it without guessing. Read `APP-R3.md` first (where each element sits), and open the images in `reference-images/app/` (index `reference-images/app/INDEX.md`) while you build. The website's elements (counters, spread captions, prints, flows, parameter tables) are in `DESIGN.md` section 4; the home card is section 26 here.

**Where the facts come from.** Desktop: `vex-app/docs/design/R3-MINIMAL.md` and the shipped renderer (Vex-Foundation/Vex, branch `design/r3-minimal`). Web: the VEX Cloud web spec and the shipped web app (private). The kit: the desktop reference renders in `vex-app/docs/design/r3/`. Where a spec, the kit and the code disagree, the code wins and both are named. Paths: `R/` = `vex-app/src/renderer/`, `G/` = `R/styles/global-css/`.

**How each entry reads.** Anatomy, sizes and tokens, states, light and dark, widths, accessibility, do and don't, reference implementation. Colour values are in `APP-R3.md` section 1 and `tokens.css` (the app block).

---

## 0. Laws every element obeys

1. **One blue.** `#0000C0` by day, periwinkle `#A3ABFF` at night for blue type and lines; the action fill is `#0000C0` in both rooms (a 1px periwinkle edge at night). `#0000FF` / `#6470FF` only for a primary hover. No second accent.
2. **One blue fill per view.** Send, Approve, Confirm or Unlock; never two. The refusing choice is an ink outline (Reject) or an ink fill (Stop). A key that cannot act yet is a dotted outline, never a faded fill.
3. **Status is a fill plus a word.** Never a fill alone, never a colour. Failures are ink, never red. The fills are in section 4.
4. **Trading green and red only on trading values**: a signed uPnL or P&L, Long and Short, Buy and Sell side words, bids and asks, the B and S ratio, a 24 hour change on the Board, the Lighter trading P&L. Never on a status, a state word or a snapshot change (the Portfolio total's change is ink). Candles keep their own pair inside the chart.
5. **Square and flat.** Radius 0 everywhere, focus rings included. No shadow, blur, glass, glow or gradient ramp. The only hatches and dot screens are the state swatches, the hatch bands on cards and callouts, and the hologram.
6. **Type.** Instrument Sans for every word in sentence case; JetBrains Mono, tabular, for every figure, address, time and duration; Instrument Serif 400 at display sizes only (never under 32, never bold). Caps only on tiny tags. No pixel font anywhere in the apps.
7. **Missing data says so.** "Not available" in muted (both apps' shipped money lines and tables; the desktop spec writes "Not quoted" for approval lines); never a sample value, never a computed guess. Loading is a word and a quiet bar, never a skeleton of fake numbers.
8. **Focus.** A square 2px ring in the focus token (`#0000FF`, night `#A3ABFF`), offset 2 or 3 outside the control. Fields turn their border blue instead.
9. **Motion** only for a state change, spatial continuity, or attention once (an approval, a failure). Desktop durations `fast 100ms`, `base 150ms`, `slow 240ms`, `reveal 300ms`; curves `standard (.4,0,.2,1)`, `out (.25,1,.5,1)`, `inout (.76,0,.24,1)`, no fourth curve. Reduced motion collapses every duration to instant and the hologram to one still frame. Nothing slides under reduced motion.
10. **No veils.** Nothing dims the window; the dither backdrop is gone.
11. **Words come from the code.** New strings only as proposals for the owner. No em dash or en dash in any string, alt text, comment, doc or commit.

---

## 1. Line icons

Calm stroke icons replace the px sprite in the app's navigation and chrome (the px sprite stays only where a pixel icon is part of a picture, such as the website).

- **Anatomy.** A 16 x 16 grid, stroke 1.5, square caps, mitre joins, no fill, `currentColor`. Sizes 14, 16, 20.
- **Set.** About 95 icons: nav (`new`, `search`, `chat`, `missions`, `portfolio`, `board`, `lighter`, `studio`, `settings`, `strategies`, `markets`, `activity`), chrome (`panelL`, `panelR`, chevrons, `lock`, `shield`, `bell`, `menu`, `dots`, `refresh`, `ext`, `copy`), money (`wallet`, `swap`, `candles`), states (`warning`, `info`, `question`, `offline`), message keys (`branch`, `thumbsDown`). Path data: R3-MINIMAL appendix A.
- **Colour.** Ink 2 at rest, blue on the selected row; never two colours in one icon.
- **Accessibility.** Decorative beside a word (`aria-hidden`); an icon-only key carries an accessible name and a tooltip.
- **Do / don't.** Do pair every nav icon with its word (except the rail, where the tooltip names it). Don't use filled, duotone or emoji icons; don't bring the px sprite back into the app chrome.
- **Code.** Desktop `R/components/icons/line/` (`line-icons.tsx`, `LineSvg.tsx`, the `LINE_ICONS` registry). Web: the VEX Cloud web app (private).

## 2. Type roles

See `APP-R3.md` section 2 for the full table. In short: greeting serif 52 blue; page head serif 40 blue; approval sentence sans 21 / 500; state word sans 15 / 500; reading 15 / 1.6; composer 16 / 24; rows 14; meta 13; group heads 12 / 500 muted; tags 11 / 600 caps; money headline mono 34 / 500; figures mono 13 tabular.

- **Code.** Desktop `G/type.css` (`.vex-num`, the micro label register redefined as Sans in sentence case), `G/fonts.css`. Web: the VEX Cloud web app (private).
- **Don't** set Departure Mono, tracked caps eyebrows, or a serif under 32 inside the app.

## 3. The flat vx token

The product mark in working views: the white vx in a `#0000C0` disc.

- **Anatomy.** An SVG circle (night: radius 48.5 of 100 with a 3 stroke in `#A3ABFF`) and the white glyph, 60 x 48 at (20, 26) in a 100 box.
- **Sizes.** 22 in the top bar chip, 24 beside Vex's messages, 44 when the avatar is off (web stage 56).
- **Where.** Beside each Vex turn, in the token chip, in the avatar off state. The 3D coin appears only on brand moments (welcome, wake, unlock, the web boot and loading token, sign in).
- **Do / don't.** Don't redraw the vx; use the path. Don't put the 3D coin in a working view.
- **Code.** Desktop `R/components/ui/vx-token.tsx`. Web: the VEX Cloud web app (private).

## 4. Swatch and state word

State by fill, always drawn beside its word.

| Fill | Drawn as | States |
|---|---|---|
| outline | 1.5px border, empty | Ready |
| dot screen | 1px border, `radial-gradient(currentColor .8px, transparent 1px)` on a 3px grid | Listening, Waking up, Probing, Applying, Loading |
| hatch | 1px border, `repeating-linear-gradient(45deg, currentColor 0 1px, transparent 1px 3px)` | Thinking |
| solid | `currentColor` fill, 1px border | Working, Running, Done, Confirmed, Filled |
| target | 1px border with an inner square inset 2px | Waiting for approval (blue), Setup |
| ink hatch | the hatch in ink | Concerned |
| ink cross | two diagonals across the box, in ink | Error, Failed, Status unknown, Not submitted |
| dotted outline | 1.5px dotted border | Sleeping, Paused |

- **Sizes.** 10 x 10 (1.5px border, 1px for patterned fills); large 12 x 12 in the Vex sidebar state line.
- **Colour.** Blue (periwinkle at night) for every state except the two warning states, which are ink (paper at night). A muted outline for an empty control (Needs you at zero).
- **Words.** Ready (the rest word; "Idle" is gone), Listening, Thinking, Working, Waiting for approval, Done, Concerned, Error, Sleeping, Waking up; on rows also Running, Paused, Failed, Confirmed. Scoped: "This chat: Ready", "This mission: Working", "This project: Ready".
- **Motion.** The swatch never animates as decoration; under reduced motion nothing steps.
- **Accessibility.** The swatch is `aria-hidden`; the word carries the meaning.
- **Code.** Desktop `R/components/ui/swatch.tsx`, `state-word.tsx` (the `data-s` values `done`, `ongoing`, `warning`, `draft`, `idle`, `error` plus R3's `listening`, `thinking`, `awaiting`, `concerned`, `sleeping`). Web: the VEX Cloud web app (private).

## 5. The token chip (the Vex toggle)

At the right of the top bar. The one control that shows and hides the Vex sidebar.

- **Anatomy.** The flat token (22), the state swatch, the state word, the timer in mono 12 muted while a turn is live, then after a 1px quiet divider "1 mission running".
- **Sizes.** 32 high, padding 0 10 0 5, gap 8, 13 type, a 1px quiet rule, transparent (night: paper 2 on desktop). Phone: 44 high.
- **States.** Pressed (Vex shown): the full rule and the selection wash (`data-shown`). Hidden: it keeps the token, the fill, the word, the timer and the background tail. Hover: the hover wash.
- **Word.** Desktop: the state word without a scope (the Vex sidebar carries "This chat:"). Web: the scoped word when the shell has one, else the mood's default; the web spec writes "This chat: Ready", the shipped chip shows "Ready".
- **Accessibility.** A `<button>` with `aria-pressed` (shown), `aria-controls` the panel, the name "Hide Vex" / "Show Vex", the state and tail as its description, `aria-keyshortcuts` (desktop Cmd/Ctrl+Shift+Period, web Cmd/Ctrl+Shift+B).
- **Don't** put the chip on the welcome (Vex is the centre there), or show "Idle" while a mission runs.
- **Code.** Desktop `R/features/vex/VexTokenChip.tsx`, `vex-toggle-shortcut.ts`, `G/title-bar.css`. Web: the VEX Cloud web app (private).

## 6. Needs you

A persistent top bar control on every screen (phone included), independent of Vex, plus the same list in the Vex sidebar and on a page.

- **Control.** "Needs you · N": 32 high, padding 0 10, gap 8, 13 / 500, a 1px rule (ink when N is above zero), the idle swatch at zero and the target above zero, the count in mono 12 muted. A failed read shows "Needs you · ?" with Retry (desktop).
- **Panel.** Opens under the control: 380 wide, a 1.5px ink frame, padding 6 0, heading 12 / 500 muted; each row a 14 swatch, the title (the action, 14 / 500), a 12.5 muted meta line (the session or project, the network on web, "expires {time} UTC" or "since {time}"), "Review" or "Open" (13 / 500 blue); a 1px quiet rule between rows; "Nothing needs you." at zero.
- **What counts.** Pending approvals plus missions paused for a decision (desktop: `paused_error` Recover, `paused_plan_acceptance` Review contract, `paused_user_form` Fill in the form). A sleeping or user paused mission never counts.
- **It never approves.** Review opens the card (on the chat on screen it moves focus to the card's details, "Review ↓").
- **Needs you page** (desktop route `needsYou`): decisions grouped by session or project, the first expanded as the full card, the others as rows (1px rule, a grid of 18px, 1fr and auto, padding 13 16, title 15.5 / 500, Reject and Review keys at the right).
- **Code.** Desktop `R/features/vex/NeedsYouControl.tsx`, `needs-you/`, `needs-you.ts`, `R/features/appShell/screens/NeedsYouScreen.tsx`. Web: the VEX Cloud web app (private).

## 7. The top bar

Anatomy, clusters and per-OS reserves: `APP-R3.md` section 4. Element rules:

- **Title** 14 / 500 with the mode in 13 muted; ellipsis before any control leaves. A mission badge is 26 high (quiet rule, 12.5, swatch and word: "Mission · Accepted", "Paused on error", "Ended").
- **Notices · N** (desktop): a 32 high pill, a 1px rule, 13. Its panel is 420 wide at right 12, top 50, a 1.5px ink frame.
- **Network and Pause all** (web): quiet outline controls, never the loudest thing in the bar; the network pill is unfilled. Pause all opens an anchored panel with its scope (section 22).
- **Code.** Desktop `R/features/appShell/RunningHead.tsx`, `G/title-bar.css`. Web: the VEX Cloud web app (private).

## 8. Left sidebar rows

- **Nav row.** 34 high, padding 0 10, gap 11, a 16 icon in ink 2, 14 type. Selected: the selection fill, blue type 500, a blue icon. A 12px gap above and below the group.
- **Session row.** 34 high; the name 14 with an ellipsis; at the right a time in mono 11.5 muted, or a swatch and a word in 12 muted (Running, Paused, Waiting, Sleeping). Hover: Pin and Remove keys (24 x 24) on desktop, a "..." row menu on web; double click renames (desktop); a hover card 320 wide (1px ink frame, padding 14 16).
- **Group head.** 12 / 500 muted, padding 14 10 4.
- **Search.** The Search row becomes a 38 high field (1px blue border, field ground) with tabs All, Agent, Mission under it on desktop (13, the active one blue 500 with a 1.5px underline, counts in mono 11); matches marked with a blue wash (`rgba(0,0,192,.14)`, night `rgba(163,171,255,.22)`); Escape closes it.
- **Account row.** Pinned to the foot, a 1px quiet rule above, padding 12 18 14; a 30 avatar with a 1px rule and the vx in blue; name 14 / 500, a 12 muted status line, an up and down chevron. Its menu is a flat panel (desktop 316 wide, 1.5px ink frame): Personalize, Memory, Sessions, Agent Scan, How Vex works, Settings, Lock Vex, runtime status. On web the account menu also holds the bell on chat routes.
- **Update card** (desktop): above the account row, a 1px rule, field ground, padding 12 14, a 14 / 500 title with a download icon, 30 high keys; a critical update takes a 1.5px ink frame; downloading shows a 2px bar and the percentage.
- **Don't** number sessions, show counters, or put money in the sidebar.
- **Code.** See `APP-R3.md` section 5.

## 9. The Vex sidebar

Anatomy and order: `APP-R3.md` section 7. Element rules:

- **State line.** Padding 14 18 0; the 12 swatch, the scope 400 muted and the word 500 at 15, the timer in mono 12 muted at the right.
- **Narration.** One line built only from real parts (the live word, the tool title, the last user message), for example "Calling {tool title} to answer “{message}”"; 13.5 / 1.5 ink 2. When there is nothing true to say there is no line.
- **Background line.** 13 ink 2, a running swatch, "{n} mission running · {title}". Only `running` missions are counted and named; a sleeping mission keeps its own word and is never "running".
- **Plate.** 280 high, a 1px quiet rule above, the print (position 50% 82%), her bust with the face at least 90 px, a short beam of dots to a small token at its base. The plate ground shows while the print loads.
- **Foot.** "Show avatar" and the switch (section 17).
- **Accessibility.** One announcer for state changes (desktop `VexStateAnnouncer`, a 1 s quiet window); the plate's art is `aria-hidden`; the word is real text.
- **Don't** put money tables, BOOK figures or a second primary in the sidebar.

## 10. Vex, the K2 hologram

Vex is the K2 halftone portrait projected from the vx token. She replaces the old pixel girl and the eagle in every app and on the home.

- **Drawing.** A hex dot screen (about 7,000 dots stamped from an atlas) in her own three inks: day white dots for skin and tee, ink `#0A0D18` for the hair and every line, `#0000FF` irises, `#0000C0` for the vx on her tee, a white rim round the hair; night white at 0.9, the blue lifted to periwinkle, a periwinkle rim round the hair. Her blue hair streaks are quieter than in the first renders. She stands in a beam of the same halftone dots as the sky's clouds (never smooth lines), densest just above the token.
- **Beam ink by ground.** Blue `#0000C0` at 0.4 on paper; white at 0.66 on the print by day (the web home's value; it replaced the spec's earlier 0.9) and 0.46 at night.
- **Moods per agent state.**

| State | Fill and word | Her |
|---|---|---|
| Ready | outline | calm, looking at you |
| Listening | dot screen | eyes down on the composer |
| Thinking | hatch | finger on her chin, eyes up |
| Working | solid | narrowed, focused eyes |
| Waiting for approval | target (blue) | brows up, her palm raised toward the transcript (screen left) |
| Done | solid | the grin and the peace sign, held by the real edge, never a timer loop |
| Concerned | ink hatch | worried brows, a small frown |
| Error | ink cross | a pout, half lidded eyes |
| Sleeping | dotted outline | head lowered, eyes closed, dimmed |
| Waking up | dot screen | rises, yawns, rubs an eye, smiles on Ready |

  Precedence (desktop): awaiting, then live (thinking or working), then error, concerned, sleeping, running, done, listening, ready. Web derives the mood from `agentStateOf` plus typing, a turn just done, a provider limit and the wake (`vexMoodOf`), so the chip, the panel and her face never disagree.
- **Behaviour at rest.** By default she looks at you (the viewer), now and then glances away, blinks, and her hair moves in the wind; a long hover makes her blush, a click makes her giggle. Her idle pool plays one action at a time: blow (a small dot cloud), bird (a small white pixel bird from her palm: her own gesture, the only bird left anywhere), blush, whistle (notes in white dots), hum. A "look at you" chain runs after a gesture or the wake ends and when the user returns from a lock. Gestures play only at rest (Ready), never during approval, working or error.
- **Episodes.** The wake from the token (the coin presses, lies flat, the beam rises, she assembles asleep, yawns, rubs an eye, blinks, smiles), the close back into the token (the top leaves first, the beam falls, the coin turns upright, `CLOSE_MS` 1.94 s), the reopen from the token, every gesture. Episodes run at **30 fps**; idle life (blink, gaze, wind, the beam's shimmer) at **10 fps**, with a 250 ms clock cap. Nothing paints while the window is hidden or the plate is off screen. Reduced motion, Save-Data and `?still` paint one settled frame.
- **Wake and sleep.** On every desktop launch she wakes from the token and smiles on "Ready"; the wake never holds a stage and holds or loops on the real wait. She sleeps on lock ("Sleeping · Locked") and looks at you once unlocked.
- **The token toggle.** On the welcome and the home her token is a button ("Hide Vex"): pressed, she closes into the upright coin; pressed again, she wakes from it. States `shown`, `closing`, `token`, `opening`.
- **Avatar optional.** "Show avatar" on by default. Off: no hologram anywhere; the flat token stands for her (desktop with a thin state ring that never moves: a faint full ring for Ready, arcs for thinking and working, a badge for awaiting, an ink ring broken in four for error, dashed for sleeping; web the flat token alone) and the word, the narration and Needs you stay.
- **Sizes.** Her face stays at about 90 px or more wherever she is the subject. Stages: sidebar plate 280; welcome 268 to 300; phone welcome 238 x 240; phone sheet thumb 128; wake and unlock at scale 1.0.
- **No state word under her on the welcome.**
- **Code.** Web: the VEX Cloud web app (private). Desktop port `R/components/vex/k2/` (`VexK2.tsx`, `K2TokenButton.tsx`, `k2-engine.ts`, `k2-emotion.ts`, `k2-time.ts`), `R/features/vex/vex-emotion.ts`, `VexPortraitPlate.tsx`, `VexStatus.tsx`, `vex-dock.ts`, `vex-hide.ts`.
- **Don't** draw her in pixel blocks (the 59 x 128 B sprite is retired), give her a target ring eye, mirror her face, move her body for a "breath", put her in a working view other than the sidebar plate, or generate new art of her without the owner.

## 11. The welcome

Layout: `APP-R3.md` section 8.

- **Stage.** Vex centred over her token, no state word.
- **Greeting.** Serif 52 / 1.02 in blue (periwinkle at night), centred, margin 16 0 24; one line from the real greeting source (captures: desktop "Evening. Markets never sleep.", "Night shift?"; web "What should we do this afternoon?").
- **Composer.** 720 wide (section 13).
- **Task rows.** Under the composer, 42 high, 15 ink 2, a blue line icon, a 1px quiet rule between rows; a press prefills (web) or starts the task. Dock padding 0 40 30 (0 28 20 at 1024).
- **Web guest.** The home's four tiles and the guest line; the sign in sheet keeps a pending prompt ("Held for sign-in · kept 15 min").
- **Code.** Desktop `R/features/appShell/SessionWelcomeHero.tsx`. Web: the VEX Cloud web app (private).

## 12. The transcript

A centred column, max 760. Day label 12 muted centred, margin 26 0 18.

- **User block.** Right anchored, text left aligned, max width 560, 15 / 1.55, a 2px blue rule on its right edge (night periwinkle) with 14 padding; "You · 12:28" above it in 12 muted.
- **Vex's turn.** A grid of 28px and 1fr with a 12 gap; the flat token (24) hangs at the left; paragraphs 15 / 1.6.
- **Finished steps fold into one quiet row** (30 high, 13 muted): chevron, "{n} tool calls · {titles} · {source}" (web "Used {n} tools"), the duration in mono 12 at the right. Opened: each step 36 high (title 500, word 13 muted, duration mono 12); a step opens inline to a paper 2 well (padding 10 14) with Args and Output. Desktop folds a long run from `TOOL_GROUP_MIN_CALLS = 6` (an earlier owner rule, kept; the mockups fold from 2).
- **Live row.** The swatch (working, thinking or target), the title in blue 500, its scope in 13 muted ("ETH on Base", "1d candles"), the timer in mono 12 blue at the right. A live row always carries a word and a timer. A failed row's word is ink 500 with the cross.
- **Result line.** A 1px quiet rule, field ground, padding 7 10, 13 ink 2, figures in mono 12.5; it states scope, currency and freshness ("Wallet balance $12.00 on Base · SOL $151.20 · as of 12:29").
- **Reasoned** is a closed row (36 high); opened, italic 14 ink 2 with a 1px rule on its left. Turn stats show on hover only.
- **Turn error callout.** A 1.5px ink frame, an 8px hatch band, padding 12 16 12 24, never red: the error swatch with "This turn failed", the cause, the hint, a code trailer (11.5 muted), Dismiss. While the failing session is on screen this card is the only report (no toast, no Notices row).
- **Code.** Desktop `R/features/appShell/SessionTranscript.tsx`, `TranscriptMessage.tsx`, `ToolLedger/`, `TurnIsland/`, `ReasonedBlock.tsx`, `G/chat-transcript.css`. Web: the VEX Cloud web app (private).

## 13. The composer

A white field as wide as the column (760; 720 on the welcome; 540 beside Vex at 1024 desktop).

- **Anatomy.** A 1px rule, field ground, padding 14 14 10 18; text 16 / 24, min height 48, the placeholder in muted ("What do you want Vex to do?" desktop, "Ask Vex…" web). The bar under it (gap 8, margin-top 6):
  - **Options control:** "{model name} · Reasoning: {effort}" in one control, 30 high, a 1px quiet rule, padding 0 9, 13, "Reasoning:" and the dot muted, a chevron. The name comes from the model catalogue, else the id (the desktop capture shows the id `claude-sonnet-4`). Web shows the model and its source ("script · Built-in model").
  - **Permission as its promise:** "Funds require approval" (or "Full access"), 13 / 500 blue with a lock (web: a shield) icon; the tooltip explains Restricted or Full access.
  - **Meter:** desktop "Context 21%" (the real share) and five cells 4 x 10, 2 gap, filled cells blue; web "Daily budget", five cells and "Resets {time}".
  - **Send:** 36 x 36. No text: a dotted 1px blue outline with a blue arrow. With text: the view's one blue fill. While a turn runs: the named stop key replaces it.
  - **Stop:** named, 36 high, padding 0 12, ink fill, paper type, 13 / 500, a 9 x 9 square: "Stop agent" or "Stop mission" (desktop).
- **Waiting for approval.** The field takes the 1.5px ink frame and a tag on its top edge (right 14, top -11, 22 high, field ground, a 1px ink border, 12 / 500, the target swatch, "Waiting for approval"). Typing turns Vex to Listening.
- **Mission strip.** Above the field while a mission runs: 44 high, a 1px rule, 13.5, the word in 500, the contract's own limits in 12.5 muted with mono figures, and only the controls that apply (Edit contract, Stop mission, Continue now, Recover).
- **Accessibility.** Each control is named; Enter sends, Shift+Enter breaks a line; the stop key names its scope.
- **Code.** Desktop `R/features/appShell/SessionComposer.tsx`, `ComposerSendControl.tsx`, `ReasoningEffortSelect.tsx`, `MissionRail.tsx`, `G/composer.css`. Web: the VEX Cloud web app (private).

## 14. The approval card

The approval is an inline card in the transcript, the only framed thing on screen. Safety is unchanged from V10.

- **Frame.** A 1.5px ink frame, paper ground, a 10px hatch band on the left (45deg, a 1px line every 4px, a 1px ink rule on its inner edge); inner padding 16 20 18. No veil, no scrim: Vex points at it from the sidebar and the composer says "Waiting for approval".
- **Order, top to bottom.**
  1. Top row: the target swatch, "Approval needed" (12 / 500 muted), the expiry at the right ("Expires at {time} UTC", mono figures), the REAL FUNDS stamp and the risk tags (HIGH RISK).
  2. The plain sentence as the title (21 / 500), built only from present arguments ("Bridge 1 USDC from Base to Arbitrum."); else "{tool title}: review the signed fields".
  3. Source row: "From your {wallet} {address}" and "{amount} {symbol} available on {chain}" at the right (13.5, a 1px quiet rule above).
  4. Money lines as a definition list (columns 150 and 1fr, rows padding 8 0, 1px quiet rules): You send, You receive, Minimum receipt, Costs, Total debit (600, a 1.5px ink rule below). A missing value reads "Not available" in muted (the spec writes "Not quoted"); Total debit shows only when every part is known.
  5. Risk sentences, each 13 / 1.45 ink 2 with a 2px ink rule at its left and a 600 ink lead ("High risk:", "Unverified, audit unavailable:").
  6. "All signed fields" (38 high, 13.5 / 500 blue, chevron), closed; opened, a paper 2 well with tool id, action kind, origin, ISO expiry and the raw arguments in mono 12.
  7. Footer: the optional Reason field (40 high), Reject, the action button. Sticky at short heights (a 1px quiet rule above).
- **Buttons.** Reject is the ink outline key and takes the first focus (2px ring, offset 3). The action button is the view's blue fill, named by the tool family: "Approve bridge", "Approve order", "Approve swap", "Approve transfer", else "Approve". Desktop Lighter's "Approve and execute trade" is now "Approve order". Web pairs are 44 px high.
- **Armed second click.** High or critical risk, destructive and `user_wallet_broadcast`: the first press arms the key for 4 seconds with the label "Click again to confirm approve" (the kit draws "Click again to approve bridge"; the app keeps its own).
- **Safety flow.** REAL FUNDS on every desktop approval; Reject first focus; the 4 s second click; Lock Vex refused while signing; nothing signs until the user confirms. Web money forms keep the real funds acknowledgement checkbox in the footer, and an edited amount re-quotes, clears the checkbox and holds Approve until the terms are ready. While a quote is pending, the web card may show the live market price ("Market price · read {time}") and the free balance, labelled as not the quote.
- **Variants.** Desktop Lighter "Review order" replaces the ticket inline in its 338 column (padding 12 14 12 16, the sentence at 18, columns 112 and 1fr). Web phone: an approval opens straight to the decision.
- **Code.** Desktop `R/features/appShell/ApprovalCard.tsx`, `ApprovalCard/` (`ApprovalDecisionActions.tsx`, `ApprovalDetails.tsx`, `approval-money-lines.ts`, `approval-sentence.ts`, `risk.ts`, `lighter-order-facts.ts`), `ApprovalsRegion.tsx`, `G/approval.css`. Web: the VEX Cloud web app (private).
- **Don't** put a dither veil or scrim behind it, show raw tool names as its title (`BridgeExecute`, "Wallet broadcast" belong under All signed fields), or invent a quote.

## 15. Money outcomes

Three failure kinds, each with the consequence and the next step: "Not submitted" (ink cross: nothing was placed), "Submitted, awaiting confirmation" (dot screen), "Status unknown" (the spec's block draws the hatch, the shipped desktop rows the ink cross; check it). Web history also says "Filled". Block: a 1.5px ink frame, an 8px hatch band, padding 12 16 12 22, head 14 / 600, text 13 / 1.45 ink 2, keys below. Every activity row ends in a word with its swatch (Confirmed, Submitted awaiting confirmation, Status unknown, Failed).

## 16. Buttons

| Kind | Look | Use |
|---|---|---|
| primary | `#0000C0` fill, paper type (night a 1px periwinkle edge), hover blue hi | the one action of the view |
| outline ink | a 1px ink border, transparent | Reject, Back, Cancel |
| ink fill | ink fill, paper type | Stop agent, Stop mission |
| quiet | no border until hover, ink 2 type | row keys, page keys |
| link | blue 13 / 500 | Review, Open, Add wallet |
| unavailable | a dotted 1px outline, never a faded fill | a key that cannot act yet |

- **Sizes.** 40 high, padding 0 18, 14 / 500; small 32 high, padding 0 12, 13; phone targets 44.
- **Accessibility.** Native `<button>`; the 2px focus ring; names say what happens ("Approve bridge", not "OK").
- **Don't** round, shadow or gradient a button; don't place two primaries.
- **Code.** Desktop `R/components/ui/button.tsx`. Web: the VEX Cloud web app (private).

## 17. Fields and controls

- **Field.** 42 high (38 to 40 inside cards and the wizard), padding 0 12, 15, field ground, a 1px rule; focus turns the border blue. Errors as an ink line under it, never red.
- **Switch.** 32 x 18, a 10 x 10 thumb at 3 inset, off thumb muted, on the blue fill. Square.
- **Checkbox.** 16 x 16, a 1.5px ink border, on the fill with a white tick.
- **Segmented control.** 30 to 32 high, 13, a 1px rule; selected the selection fill and blue 500.
- **Tabs.** Underline tabs: 13 to 14, the active one blue 500 with a 1.5px or 2px underline; the Studio strip 40 high.
- **Menu.** Field ground, a 1px ink border, padding 4 0, min width 180, items 32 high 13.5, the selection fill, a shortcut at the right (12 muted).
- **Code.** Desktop `R/components/ui/input.tsx`, `tabs.tsx`, `menu.tsx`, `select-menu.tsx`. Web: the VEX Cloud web app (private).

## 18. Tags and stamps

- **Stamp.** REAL FUNDS: 22 high, padding 0 8, ink fill and paper type (night: paper fill, `#1B1412` type), 11 / 600 caps, tracking `.1em`.
- **Outline tag.** HIGH RISK: 22 high, a 1px ink border, 11 / 600 caps, `.08em`. Authored in sentence case, capitalised by the style.
- **Page tags.** 20 high, 12, sentence case.
- **Code.** Desktop `R/components/ui/stamp.tsx`, `chip.tsx`. Web: the VEX Cloud web app (private).

## 19. Tables and figures

- **Table.** Header 12 muted with a 1px rule under it, padding 8 0; rows 36 high; figures mono 13 right aligned; column gap 18. Row actions sit in a menu (dots, muted).
- **Figures.** English formatting (`1,234.56`); the minus is U+2212 (on the web through one shared formatter); no `.toFixed(` in JSX on the web. A missing value is "Not available".
- **Freshness.** Money figures say when they were read ("balances as of {time}").
- **Trading values** take `text-trade-up` / `text-trade-down` (law 4); the Long or Short word in trading colour 600.
- **Money headline.** Mono 34 / 1.1, 500, `-.03em` (web `vx-figure` 33).
- **Code.** Desktop `R/features/appShell/screens/PortfolioScreen.tsx`. Web: the VEX Cloud web app (private).

## 20. Trading surfaces

- **Lighter desk** (desktop): left sidebar on the rail; market bar 58 high (picker 36 high 15 / 600, last price mono 20 / 500 with its change in trading colour, key figures mono 12.5); chart toolbar 36 high (timeframes 24 high mono 11.5, the active outlined 1px blue); the order book rows 22 high mono 11.5, bids in trade up, asks in trade down, depth bars at 14% and 12% of the colour, a 6 high B and S ratio bar; the ticket column 338 with Long and Short keys 48 high in trade fills and the line "Nothing signs until you confirm."; "Review with Vex" as an outline key.
- **Candles** keep their own pair inside the chart only (desktop `#22C55E` / `#EF4444`; web `--vx-candle-up/down`).
- **Board** (desktop page): a three column grid, a tile padding 16 18 14 with a 34 icon box, name 15 / 600, price mono 26 / 500, the 24 hour change in trading colour, four stats under a quiet rule; the selected tile a 1.5px blue outline drawn inside. Ask Vex lives in the Vex sidebar.
- **Web Markets** (Watchlist, Scanner): the page kit, regime strips in words ("Not available", never a lone dot).
- **Code.** Desktop `R/features/appShell/lighterTrading/`, `G/lighter-*.css`, `R/features/appShell/screens/BoardScreen.tsx`, `G/board.css`. Web: the VEX Cloud web app (private).

## 21. Pages

- **Page head.** The title once: in the top bar (web sets the page title only there; desktop reading pages add the serif 40 head). Section heads 15 / 600 with a link at the right (13 / 500 blue).
- **Portfolio.** "Total value of your {n} on-chain wallets · Lighter is shown separately" (13 muted), the money headline, the change since the snapshot in ink, scope chips as a segmented control; Wallets and Balances tables; the Lighter account apart (Equity, Available, Margin in use, Unrealized trading PnL), positions with uPnL in trading colour; activity rows ending in a word and a swatch.
- **Settings.** Desktop: one page with its own nav (236 wide, four groups App, Security and wallets, The agent, Connections; items 34 high with a status word), a body column max 680, section titles 22 / 500 with a status word, rows padding 14 0. Web: Settings replaces the left nav with its grouped nav; pages per `wx20` to `wx29`. Both carry "Show avatar".
- **Empty and loading blocks.** A 1px quiet frame, padding 18, min height 150: a 12 muted scope word, a 15 / 500 sentence, a 13.5 / 1.5 line, a blue 13.5 / 500 next step. Loading: a word and a quiet bar (120 x 2, a blue segment 34% wide) only while a real pending state lasts.
- **Code.** Desktop `R/features/appShell/screens/`, `G/settings.css`, `G/memory.css`. Web: the VEX Cloud web app (private).

## 22. Overlays (no veil)

| Surface | Values |
|---|---|
| popover (Needs you 380, Notices 420, profile menu 316) | paper, a 1.5px ink frame, never a shadow |
| hover card | 320 wide, field ground, a 1px ink border, padding 14 16 |
| tooltip | ink fill, paper type (night: paper fill) |
| menu | section 17 |
| sheet over the centre | from under the top bar to the foot, paper, head 56 (16 / 500), body padding 0 28, foot 68 with a 1px quiet rule above; both sidebars stand; Escape closes |
| inline panel (new session, vault reset) | a 1.5px ink frame, padding 22 24 20, max 470 to 720, title 21 to 22 / 500 |
| anchored panel (web Pause all) | anchored to its button, no scrim, with what stops and what stays |
| blocking dialog (destructive confirm, token launch, "Trade with real funds?") | the flat paper scrim at 62% (night 66%) or transparent per call; the native `<dialog>` with focus on the safe choice |
| toast | top centre at 56, min 300, max 460, padding 10 12 10 14, paper, a 1px ink border (warn 1.5px; failure 1.5px with a 7px hatch band); three at a time, then "+N more in the notification center" |
| connection banner | a 40 high row of the centre column under the top bar, paper 2, a 1px ink rule below ("Offline: waiting for the network to come back") |
| error boundary | in the centre only, sidebars live: serif 40 title, 15 / 1.55 text, Try again and Reload window, a technical card |

- **Code.** Desktop `R/components/ui/sheet.tsx`, `dialog.tsx`, `hover-card.tsx`, `tooltip.tsx`, `notification-toast.tsx`, `toast-host.tsx`, `connection-banner.tsx`, `error-boundary.tsx`, `G/overlay.css`. Web: the VEX Cloud web app (private).
- **Don't** use the dot screen dither backdrop (`vx-mask`) inside the app, a shadow, or a modal for an approval.

## 23. Brand moments

- **Desktop wake.** Title "Waking the desk" (serif 56, blue), the lead "Vex is starting the local services on this machine.", a 360 x 2 progress line, the five stage lines ("Waking the desk", "Starting services", "Preparing the ledger", "Reading your setup", "Ready"; rows 30 high, the current one 500 ink with the solid swatch), a version stamp at the bottom right (mono 12 muted). Unlock: "Welcome back.", the master password field (42 high), "Unlock →", errors as the ink callout. The handoff to the shell is a 240ms crossfade. Code: `R/features/secrets/`, `G/chronos-gate.css`.
- **Desktop first run and wizard.** The stage plate with Vex per state, a crumb (System check, Docker, Services, Database, Setup), probe rows with OK, Ready, Setup, Paused, Probing, Applying; the wizard "Step N of 7 · {name}", a named stepper, the serif title, a form max 600, a fixed footer with Back and one primary. Code: `R/features/systemCheck/`, `docker/`, `database/`, `wizard/`, `G/wizard.css`.
- **Web boot and loading.** The turning 3D vx token from pre-rendered frames (no flock, no "LOADING" caps), "Loading" in Sans, a Reload line after 10 s, a still frame under reduced motion. Code: the VEX Cloud web app (private).
- **Prints.** The shipped plateau print, day or night; the plate ground behind it while it loads.

## 24. The phone (web)

Layout: `APP-R3.md` section 11. Element rules: every target 44 px; the tab bar's current tab alone carries the accent wash and the blue word (so Send stays the one blue fill on a chat); the Vex sheet opens compact (state, narration, Needs you, a 128 portrait, "Show the full portrait", "Show avatar"); approvals open straight to the decision with a sticky 44 high footer. Code: the VEX Cloud web app (private).

## 25. Accessibility checklist (both apps)

Contrast at least 4.5:1 for text (muted measures 5.97:1 on paper, 6.18:1 at night; trading colours from 5.20:1); 44 px targets on the phone; a square 2px focus ring on every control; every state readable as a word; one announcer for Vex's state; the hologram `aria-hidden`; Reject first focus on every approval; reduced motion respected everywhere.

## 26. Home card, suggestion tiles, News stack and compact nav (the site, VEX Cloud `/`)

The public site keeps the V10 website language (Departure Mono captions and labels, prints, counters). Decision text: `SKILL.md` section 11. Real captures: `reference-images/site-home/real-home-*`.

- **Card, P1 Quiet (chosen 2026-10-14).** No paper rectangle: the vx, the greeting (white serif on a print burn), the composer (its own white field) and the tiles (each with its own paper fill) stand directly on the print. Paper returns only under a live first reply.
- **Composer** with the guest line in its foot beside the five budget cells; budget figures are read from the server (`usePublicBudgets()`), never typed into copy. "Preview chat, not the full app" under it.
- **Suggestion tiles.** Four even tiles, 4 x 1 at 1440 and 2 x 2 at 390, a px icon and a short label: "Analyze BTC 4h", "Today's top movers", "Is this token safe?", "How VEX works" (`HOME_TILES`). A press prefills the full prompt and never sends it; every tile runs for a guest.
- **Vex** stands beside the card: K2 rising from her vx token on a beam of dots, about 50 px from the column at 1920 (her right edge dissolves through a Bayer mask where it meets the screen edge). Hovering her reveals the four products on an arc (VEX DESKTOP, VEX CLOUD, $VEX, CLOUD) as paper labels with status swatches (`.vx-vex-label`). Her token toggles her (section 10).
- **News stack.** One hub (Releases, Announcements, Posts) as a dismissible stack at the bottom right (an exception to the top centre toast rule).
- **Compact nav after scroll.** ONLY the vx logo at the top left and a mini "Ask Vex..." field.
- **Code.** The VEX Cloud web app (private).
