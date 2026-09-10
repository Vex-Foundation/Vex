# Lighter live handler-chain harness

Environment-gated tests that drive the REAL chain the desktop app runs for a
Lighter funding, onboarding, trading or Settings action, against the owner's
Robinhood Chain account. Nothing here is a fixture: every step is the production
function.

Three different production routes are driven, and each step says which one it
takes:

    a prepared-action write (every Lighter write):
      prepare tool -> prepared-action follow-up -> approval enqueue
                   -> the approval decision     -> the resume tool
                   -> reconciliation read

    an ordinary mutating tool (`uniswap__swap_execute`):
      tool dispatch -> pendingApproval -> enqueueApprovalIntent
                    -> the approval decision -> the resume tool

    a user-originated Settings action (the leverage change):
      prepareLighterLeverage -> the human's Confirm
                             -> confirmLighterLeverage({ proposalId })
                             -> the transaction proof

| step | file | flag |
| --- | --- | --- |
| 0 | (no file: `ensureIntegrationEnabled`, inside every Lighter step) | none |
| 1 | `funding-swap.test.ts` (ETH -> USDG on Robinhood Chain) | `VEX_LIGHTER_LIVE_FUNDING_SWAP=1` |
| 2 | `deposit.test.ts` | `VEX_LIGHTER_LIVE_DEPOSIT=1` |
| 3 | `key-registration.test.ts` | `VEX_LIGHTER_LIVE_KEY_REGISTRATION=1` |
| 4 | `fee-authorization.test.ts` | `VEX_LIGHTER_LIVE_FEE_AUTHORIZATION=1` |
| 5 | `leverage.test.ts` (Settings path, TxType 20) | `VEX_LIGHTER_LIVE_LEVERAGE=1` |
| 6 | `ioc-order.test.ts` (open) | `VEX_LIGHTER_LIVE_IOC_ORDER=1` |
| 7 | `cancel.test.ts` (also measures the provider's IMR) | `VEX_LIGHTER_LIVE_CANCEL=1` |
| 8 | `capital-share.test.ts` (writes and restores the share) | `VEX_LIGHTER_LIVE_CAPITAL_SHARE=1` |
| 9 | `ioc-order.test.ts` with `VEX_LIGHTER_LIVE_IOC_SIDE=sell` (close) | `VEX_LIGHTER_LIVE_IOC_ORDER=1` |
| 10 | `order-status.test.ts` | `VEX_LIGHTER_LIVE_ORDER_STATUS=1` |
| C | `cleanup.test.ts` (the executable cleanup owner) | `VEX_LIGHTER_LIVE_CLEANUP=1` |

With every flag unset every gated file skips. Three files are deliberately NOT
gated and prove the money-path decisions with pure values (no vault, no
database, no network): `deposit-amount-gate.test.ts` for the deposit amount,
`../live-sizing.test.ts` for the order sizing, the margin-fraction source, the
depth gate and the fill matching, and the second `describe` in `cleanup.test.ts`
for the cleanup marker contract, its refusals and its verdict.

Run the steps ONE AT A TIME, in the order above. Step 1 buys the USDG step 2
deposits; step 4 signs with the key step 3 registers; steps 6 to 9 trade under
the fee authorization step 4 installs and at the leverage step 5 set.

CLOSE WHAT YOU OPEN, AND THE CLEANUP STEP IS WHAT CLOSES IT. Step 6 writes
`cleanup-required.json` into its evidence directory the MOMENT its first fill
lands, naming the market, the size and this run's intent ids. That file is a
REMINDER, not a cleanup: step C is the one executable owner that reconciles
those intents and drives the close through
`lighter__position_close_prepare` -> approval -> `lighter__position_close`, sized
by the production prepare from the account's own live position. See "Step C"
below for the rule about when to run it.

## Step 0: the onboarding workflow row

Every step calls `ensureIntegrationEnabled` after the wallet gate and before its
prepare. The wallet-level `lighter_onboarding_workflows` row is what
`lighter.deposit.prepare` and `lighter.key.register.prepare` advance; without it
`resolveOrAdoptExistingAccount` has no `integration_enabled` state to adopt the
wallet's existing Lighter master account from.

The only production writer is `setLighterIntegrationEnabled`
(`@vex-agent/db/repos/lighter-integration-settings.js`), which the settings IPC
handler calls when the user turns the Lighter integration on
(`vex-app/src/main/ipc/settings.ts`, `CH.settings.setLighterIntegration`). The
harness calls THAT function with the same three arguments and nothing else, only
when the row is absent, and records the workflow row before and after in the
run's `target` evidence.

An existing row in any state other than `integration_enabled`,
`account_resolved`, `key_generated_encrypted` or
`key_registration_approval_pending` is a REFUSAL, never a repair: a workflow
parked in `failed`, `ambiguous` or a mid-deposit state is durable evidence of an
unfinished money path, and moving it by hand would destroy the state the
operator has to look at.

## Which production functions this drives

- `dispatchTool` (`@vex-agent/tools/dispatcher.js`) under the context the live
  turn loop builds (`buildToolContext`), so the prepare call is
  `modelOriginated` exactly as a model-emitted call is.
- `resolvePreparedActionFollowUp` + `dispatchPreparedActionFollowUp`
  (`engine/core/turn-loop-tool-batch/prepared-follow-up.ts`): the turn loop's
  own trusted hop, which synthesizes the confirm call and writes the approval
  through the shared enqueue transaction.
- `prepareApprove` (`engine/core/approval-runtime.js`): THE SAME FUNCTION the
  IPC approve handler calls (`main/ipc/approvals/decision.ts`,
  `registerApproveHandler`). The approved tool context is built inside it by
  `approval-runtime/post-tx/dispatch-approved/resumed-tool-context.ts` from the
  durable row. Nothing in this directory forges an approved context, writes an
  approval row by hand, or sets `approved` on a tool context.
- `discardContinuation`: the continuation `prepareApprove` returns is the
  AGENT'S OBSERVATION TURN (a model request). The IPC handler fires it in the
  background; the harness discards it, because it is not part of the money path.

- `assertApprovalActionKind` + `enqueueApprovalIntent`
  (`engine/core/turn-loop-tool-batch/approval-stop.ts`): the OTHER approval
  route. An ordinary mutating tool such as `uniswap__swap_execute` has no
  prepared-action follow-up; it comes back with `pendingApproval` and the
  orchestrator enqueues the card itself (`turn-loop-tool-batch.ts:322`). Step 1
  drives exactly that pair, through `dispatchAndEnqueueExecuteApproval`.
- `prepareLighterLeverage` (`main/lighter/leverage-preparation.ts`) and
  `confirmLighterLeverage` (`main/lighter/leverage-execution.ts`): the two
  functions the Settings IPC handlers call
  (`main/ipc/settings-lighter-trading.ts`). Step 5 drives them, with the harness
  supplying the human's Confirm - see the note below.

`runTool` is never imported: it dispatches with `approved: true` and would skip
the approval gate this harness exists to prove.

## Step 5 is the one step with no approval card, and the harness is the human

The leverage change is a USER-ORIGINATED Settings action, not an agent action.
In the app the user opens Settings -> Lighter, reads the confirmation modal that
main's own proposal DTO fills in, and clicks Confirm; that click is the consent
and there is no approval row anywhere. So there is nothing for
`prepareApprove` to decide in step 5, and the harness supplies the Confirm
itself. It records that fact explicitly in its `target` evidence rather than
letting a reader assume a card was involved.

Everything else about the path is the production path: the selector goes into
`prepareLighterLeverage`, which resolves and PERSISTS the proposal; only the
resulting `proposalId` goes into `confirmLighterLeverage`, which reloads the
stored proposal, revalidates every invariant against live state and signs. The
harness never assembles a proposal, never passes a snapshot into the confirm and
never re-signs.

## Environment

Every step needs all of these:

| variable | meaning |
| --- | --- |
| `VEX_DB_URL` | the Vex Postgres the app uses. The rows this harness writes ARE the evidence and are never deleted. |
| `VEX_LIGHTER_LIVE_ACCOUNT_INDEX` | must be `24226`. Any other value is refused before anything is prepared. |
| `VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE` | path to a file (mode 600) containing the Vex master password. A FILE, not a value, so the password never reaches a command line, a process listing or a shell history. |
| `VEX_LIGHTER_LIVE_EVIDENCE_DIR` | directory the run writes its JSON evidence into. |
| the step's own flag | see the table above. |

Per-step variables:

| variable | step | meaning |
| --- | --- | --- |
| `VEX_LIGHTER_LIVE_SWAP_ETH_AMOUNT` | 1 | the native ETH to swap, in human decimals, for example `0.01`. Refused when unset, when the production decimal parser rejects it, or when it exceeds the wallet's live balance minus a 0.005 ETH reserve kept back for the fee leg and the deposit that follow. |
| `VEX_LIGHTER_LIVE_DEPOSIT_AMOUNT` | 2 | the deposit amount in human USDG decimals, for example `3`. Refused when unset, when the production decimal parser rejects it, when it is below the environment's own minimum deposit (1 USDG on RHC), or when it exceeds the wallet's live USDG balance. Never rounded or resized. Use the whole-number USDG step 1 reports as CONFIRMED RECEIVED, never the amount its quote predicted. |
| `VEX_LIGHTER_LIVE_LEVERAGE_MARKET_ID` | 5 | required: the market index (0..254) whose leverage this run changes. |
| `VEX_LIGHTER_LIVE_LEVERAGE_TARGET` | 5 | required: a whole-number leverage such as `10`, or the word `max` (which main resolves to the market's own minimum initial margin fraction). |
| `VEX_LIGHTER_LIVE_LEVERAGE_MARGIN_MODE` | 5 | `cross` (the default) or `isolated`. |
| `VEX_LIGHTER_LIVE_MARKET_ID` | 6, 8, 9 | the perpetual market the order steps trade and the capital-share step prices. Default `0` (ETH); `1` is BTC. The market's symbol goes into the evidence directory name, so a BTC run and an ETH run never write into the same place. |
| `VEX_LIGHTER_LIVE_IOC_SIDE` | 9 | `sell` turns step 6's file into the reduce-only CLOSE, sized from the account's own live position. |
| `VEX_LIGHTER_LIVE_CANCEL_ORDER_ID` | 7 | cancel-only mode: cancel an order a previous run left resting, without placing another. |
| `VEX_LIGHTER_LIVE_STATUS_INTENT_ID`, `VEX_LIGHTER_LIVE_RESUME_SESSION_ID` | 10 | the intent and session a step-6 run recorded. |
| `VEX_LIGHTER_LIVE_CLEANUP_MARKET_IDS` | C | optional comma-separated market indices to clean up IN ADDITION to every market a `cleanup-required.json` names, for example `0,1`. Use it when a step died before its marker landed, or when an earlier run left a position no marker covers. An entry that is not a market index (0..254) refuses the whole step. |

Optional:

| variable | meaning |
| --- | --- |
| `VEX_CONFIG_DIR` | absolute override for `~/.config/vex`. Required for the dry run; leave unset for a live run so the real vault, keystore and `config.json` are used. |
| `VEX_LIGHTER_SIGNER_BINARY_PATH` | signer-helper override, honoured because the harness runs unpackaged. Leave unset to use `vex-app/resources/lighter-signer/`. |
| `VEX_LIGHTER_LIVE_DRY_RUN` | `1` stops each test one step before the approval decision. See below. |

Two REAL side effects of the production unlock apply, and are not suppressed:
`adoptUnlockedPassword` strips managed secrets from the install's `.env` file
and reopens Studio MCP admission if a host is configured. That is what an
ordinary unlock does on this machine.

## The gates, in the order they fire

1. `VEX_LIGHTER_LIVE_EVIDENCE_DIR` must be set.
2. `VEX_LIGHTER_LIVE_ACCOUNT_INDEX` must be exactly `24226`.
3. `VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE` must name a readable, non-empty file,
   and the password in it must decrypt the vault.
4. The wallet resolved from that unlocked install must be
   `0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA`.

All four refuse with a `LiveHarnessRefusal` naming the exact mismatch, before any
tool runs, before the database is touched and before anything is signed. Gate 3
is the one exception to the refusal wording: an install with no vault at all
fails with the production `LocalSecretVaultError: Secret vault is not
configured.` verbatim, because rewrapping it would hide the real cause.

Steps 1 and 2 add their own amount gates, and they run FIRST, before gate 2, so a
mistyped amount is a no-op rather than an unresolved intent to reconcile. For the
deposit (step 2):

1. `VEX_LIGHTER_LIVE_DEPOSIT_AMOUNT` must be set.
2. It must parse with the production decimal parser (`decimalToBaseUnits`) and be
   at or above the environment's own minimum deposit.
3. It must not exceed the wallet's live USDG balance, read through the
   production reader that backs `lighter__account_onboarding_status`.

Then, after the approval card exists and BEFORE the decision, the card's
`amountUnits`, `walletAddress`, `depositTo`, `beneficiaryAddress` and
`environment` are compared against what this run asked for. A mismatch stops the
run with nothing signed.

## How the order steps size, and what they refuse

Three decisions, all made from live provider state and all recorded in the
`sizing` evidence file:

1. THE INITIAL MARGIN FRACTION COMES FROM ONE NAMED SOURCE, ON ONE SCALE.
   Lighter states the same concept in two units: a MARKET's
   `default_initial_margin_fraction` is an integer on a 10000 scale (5000 is 50
   percent), while a POSITION row's `initial_margin_fraction` is a PERCENT
   STRING (`"50.00"`). The traded market's own position row wins when it exists,
   converted by `positionInitialMarginFractionToProviderScale`
   (`src/tools/lighter/margin-fraction.ts`, the repository's single owner of
   every Lighter scale change); otherwise the market's own default, which is
   already on that scale and is NOT converted. The account is read with
   `activeOnly: false`, because `activeOnly: true` hides a market that carries a
   leverage setting but no open position - exactly the row this decision needs.
   The rows are filtered BY MARKET: taking the first row that parses reads
   another market's leverage into this market's sizing.

2. THE ORDER IS TWICE THE EXCHANGE MINIMUM. The smallest size Lighter accepts is
   `max(min_base_amount, min_quote_amount / price)`; the steps send two of them.
   A partial fill of a minimum-sized order leaves a residual BELOW the minimum,
   which a reduce-only close is not allowed to touch, so the account would be
   stranded holding an unclosable position. At twice the minimum even a fill of
   barely more than half still leaves a closable size. Sizes are computed in
   whole ticks of the market's own size precision, not in floats.

3. THE BOOK MUST BE DEEP ENOUGH, CHECKED IMMEDIATELY BEFORE PREPARING. The best
   level on the side the order crosses must hold at least three times the order
   size, or the step refuses. An IOC larger than the level it crosses walks the
   book, and the prices beyond the top level were never priced by the sizing
   gate. It is a bound and not a guarantee - the book can move between the read
   and the fill - which is why the order also carries its own limit price.

The step then REFUSES, before anything is prepared, when the account's available
collateral cannot carry the required margin, naming both numbers and pointing at
Settings -> Lighter.

After the fill, the open leg requires a POSITIVE fill whose trades carry THIS
run's own client order index (read back from the durable execution-intent row and
matched against `bid_client_id_str` / `ask_client_id_str`), and the account must
then hold the intended exposure. "The account has some trades" and "the exchange
cancelled it" are not the claim; an IOC that filled nothing proves nothing about
the money path.

The close leg requires ZERO residual exposure on the market. A residual is
reported as a residual: `lighter__position_close_prepare` is run, the provider's
verbatim answer is recorded, and the step stops with the residual and its value
named. It never sends a second unapproved order.

## The exact commands

Run each from `vex-app/`. Replace the two paths; keep the password file at mode
600 and delete it when the run is finished.

Step 1 - swap native ETH for USDG on Robinhood Chain, so step 2 has something to
deposit. The card must show chain 4663, the input amount, the USDG output
address, a minimum output and a per-gas ceiling, or the run stops with nothing
signed. It prints the whole-number USDG it CONFIRMED RECEIVED; that number, not
the quote's prediction, is step 2's amount:

    cd vex-app && \
    VEX_DB_URL="$VEX_DB_URL" \
    VEX_LIGHTER_LIVE_ACCOUNT_INDEX=24226 \
    VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE=/run/user/1000/vex-live-password \
    VEX_LIGHTER_LIVE_EVIDENCE_DIR=/home/kubas/Vex/agents-colab/agents_dm/lighter-live-evidence \
    VEX_LIGHTER_LIVE_SWAP_ETH_AMOUNT=0.01 \
    VEX_LIGHTER_LIVE_FUNDING_SWAP=1 \
    pnpm exec vitest run src/main/lighter/__tests__/live/funding-swap.test.ts

Step 2 - deposit the confirmed USDG into the owner's Lighter account:

    cd vex-app && \
    VEX_DB_URL="$VEX_DB_URL" \
    VEX_LIGHTER_LIVE_ACCOUNT_INDEX=24226 \
    VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE=/run/user/1000/vex-live-password \
    VEX_LIGHTER_LIVE_EVIDENCE_DIR=/home/kubas/Vex/agents-colab/agents_dm/lighter-live-evidence \
    VEX_LIGHTER_LIVE_DEPOSIT_AMOUNT=3 \
    VEX_LIGHTER_LIVE_DEPOSIT=1 \
    pnpm exec vitest run src/main/lighter/__tests__/live/deposit.test.ts

Step 3 - register the trading key:

    cd vex-app && \
    VEX_DB_URL="$VEX_DB_URL" \
    VEX_LIGHTER_LIVE_ACCOUNT_INDEX=24226 \
    VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE=/run/user/1000/vex-live-password \
    VEX_LIGHTER_LIVE_EVIDENCE_DIR=/home/kubas/Vex/agents-colab/agents_dm/lighter-live-evidence \
    VEX_LIGHTER_LIVE_KEY_REGISTRATION=1 \
    pnpm exec vitest run src/main/lighter/__tests__/live/key-registration.test.ts

Step 4 - authorize Vex trading fees:

    cd vex-app && \
    VEX_DB_URL="$VEX_DB_URL" \
    VEX_LIGHTER_LIVE_ACCOUNT_INDEX=24226 \
    VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE=/run/user/1000/vex-live-password \
    VEX_LIGHTER_LIVE_EVIDENCE_DIR=/home/kubas/Vex/agents-colab/agents_dm/lighter-live-evidence \
    VEX_LIGHTER_LIVE_FEE_AUTHORIZATION=1 \
    pnpm exec vitest run src/main/lighter/__tests__/live/fee-authorization.test.ts

Step 5 - change the leverage on one market through the Settings path (the
harness supplies the human's Confirm; nothing else about the path is
simulated). BTC at the market maximum, cross, is the owner's first case; run it
once per market and target:

    cd vex-app && \
    VEX_DB_URL="$VEX_DB_URL" \
    VEX_LIGHTER_LIVE_ACCOUNT_INDEX=24226 \
    VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE=/run/user/1000/vex-live-password \
    VEX_LIGHTER_LIVE_EVIDENCE_DIR=/home/kubas/Vex/agents-colab/agents_dm/lighter-live-evidence \
    VEX_LIGHTER_LIVE_LEVERAGE_MARKET_ID=1 \
    VEX_LIGHTER_LIVE_LEVERAGE_TARGET=max \
    VEX_LIGHTER_LIVE_LEVERAGE_MARGIN_MODE=cross \
    VEX_LIGHTER_LIVE_LEVERAGE=1 \
    pnpm exec vitest run src/main/lighter/__tests__/live/leverage.test.ts

Step 6 - one IOC perpetual buy at twice the market minimum (the round-2 unit
measurement). `VEX_LIGHTER_LIVE_MARKET_ID` picks the market; evidence lands under
`ioc-order-<symbol>-*`:

    cd vex-app && \
    VEX_DB_URL="$VEX_DB_URL" \
    VEX_LIGHTER_LIVE_ACCOUNT_INDEX=24226 \
    VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE=/run/user/1000/vex-live-password \
    VEX_LIGHTER_LIVE_EVIDENCE_DIR=/home/kubas/Vex/agents-colab/agents_dm/lighter-live-evidence \
    VEX_LIGHTER_LIVE_MARKET_ID=1 \
    VEX_LIGHTER_LIVE_IOC_ORDER=1 \
    pnpm exec vitest run src/main/lighter/__tests__/live/ioc-order.test.ts

Step 7 - place one resting GTT limit order and cancel it. It also records the
account's `cross_initial_margin_requirement` immediately BEFORE the order is
placed and immediately AFTER it is provably resting (`imr-before`, `imr-after`),
which is the only way to learn whether the provider's own IMR already counts
resting orders - the number Vex's capital ceiling must not double-count:

    cd vex-app && \
    VEX_DB_URL="$VEX_DB_URL" \
    VEX_LIGHTER_LIVE_ACCOUNT_INDEX=24226 \
    VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE=/run/user/1000/vex-live-password \
    VEX_LIGHTER_LIVE_EVIDENCE_DIR=/home/kubas/Vex/agents-colab/agents_dm/lighter-live-evidence \
    VEX_LIGHTER_LIVE_CANCEL=1 \
    pnpm exec vitest run src/main/lighter/__tests__/live/cancel.test.ts

Step 8 - the agent capital share. It moves no funds, but it DOES write the
durable per-wallet share twice and restore it, so read `01-prior-limits.json`
first if anything goes wrong. Both shares are computed from the account's live
collateral, its committed margin and the order's required margin, so the run
proves the ceiling rather than a guess about the owner's balance. The accepted
prepare leaves an intent that is NEVER approved and expires on its own:

    cd vex-app && \
    VEX_DB_URL="$VEX_DB_URL" \
    VEX_LIGHTER_LIVE_ACCOUNT_INDEX=24226 \
    VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE=/run/user/1000/vex-live-password \
    VEX_LIGHTER_LIVE_EVIDENCE_DIR=/home/kubas/Vex/agents-colab/agents_dm/lighter-live-evidence \
    VEX_LIGHTER_LIVE_MARKET_ID=1 \
    VEX_LIGHTER_LIVE_CAPITAL_SHARE=1 \
    pnpm exec vitest run src/main/lighter/__tests__/live/capital-share.test.ts

Step 9 - CLOSE what step 6 opened, as a reduce-only IOC sell sized from the
account's own live position (the same file; evidence lands under
`ioc-close-<symbol>-*`). This is the ORDER-path close, and it proves the
`lighter__order_create_*` chain closes an exposure it opened. It is not the
cleanup owner: step C is, it runs regardless of what step 9 did, and it is the
step that must leave the account flat.

    cd vex-app && \
    VEX_DB_URL="$VEX_DB_URL" \
    VEX_LIGHTER_LIVE_ACCOUNT_INDEX=24226 \
    VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE=/run/user/1000/vex-live-password \
    VEX_LIGHTER_LIVE_EVIDENCE_DIR=/home/kubas/Vex/agents-colab/agents_dm/lighter-live-evidence \
    VEX_LIGHTER_LIVE_MARKET_ID=1 \
    VEX_LIGHTER_LIVE_IOC_ORDER=1 \
    VEX_LIGHTER_LIVE_IOC_SIDE=sell \
    pnpm exec vitest run src/main/lighter/__tests__/live/ioc-order.test.ts

Step 10 - reconcile one settled order intent in its own session and prove the
fill ledger self-heals (`lighter__order_status` reads the account's trades once
when `lighter_fills` holds no row for a filled intent; the step reads the ledger
back from the database and refuses to pass on the tool's word alone). Signs
nothing. `VEX_LIGHTER_LIVE_STATUS_INTENT_ID` is the order intent from a step 6
run's `prepared` evidence file; `VEX_LIGHTER_LIVE_RESUME_SESSION_ID` is that
run's session from its `target` file:

    cd vex-app && \
    VEX_DB_URL="$VEX_DB_URL" \
    VEX_LIGHTER_LIVE_ACCOUNT_INDEX=24226 \
    VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE=/run/user/1000/vex-live-password \
    VEX_LIGHTER_LIVE_EVIDENCE_DIR=/home/kubas/Vex/agents-colab/agents_dm/lighter-live-evidence \
    VEX_LIGHTER_LIVE_ORDER_STATUS=1 \
    VEX_LIGHTER_LIVE_STATUS_INTENT_ID=<intent id> \
    VEX_LIGHTER_LIVE_RESUME_SESSION_ID=<session id> \
    pnpm exec vitest run src/main/lighter/__tests__/live/order-status.test.ts

Step C - THE CLEANUP STEP, and the only thing in this directory that closes a
position on its own. It reads every `cleanup-required.json` under the evidence
directory (plus any market named in `VEX_LIGHTER_LIVE_CLEANUP_MARKET_IDS`),
reconciles that run's intents through `lighter__order_status`, reads the live
position, and closes what is open through
`lighter__position_close_prepare` -> the approval card -> `lighter__position_close`,
then polls the account until it is flat. It sizes nothing itself: the production
prepare reads the position, so a partial fill, a short, or a position no marker
recorded is closed at its real size:

    cd vex-app && \
    VEX_DB_URL="$VEX_DB_URL" \
    VEX_LIGHTER_LIVE_ACCOUNT_INDEX=24226 \
    VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE=/run/user/1000/vex-live-password \
    VEX_LIGHTER_LIVE_EVIDENCE_DIR=/home/kubas/Vex/agents-colab/agents_dm/lighter-live-evidence \
    VEX_LIGHTER_LIVE_CLEANUP=1 \
    pnpm exec vitest run src/main/lighter/__tests__/live/cleanup.test.ts

WHEN TO RUN IT, and this is a rule, not a suggestion:

- run it after the opening steps (6 and later) REGARDLESS of their outcome -
  a refusal, a failed assertion or a crashed process is exactly when an open
  position is most likely and least visible;
- run it AGAIN at the end of the whole session, as the last thing the run does;
- if a step died before its marker landed, name the market yourself:
  `VEX_LIGHTER_LIVE_CLEANUP_MARKET_IDS=1`;
- re-running it is safe and idempotent. Markers are durable evidence and are
  never deleted, so a second run re-reads them, finds the intents terminal and
  the account flat, and reports `flat` without preparing anything.

WHAT IT REPORTS, per market, and never softens:

- `flat` - a live account read proved zero exposure;
- `residual` - exposure remains. Its size, its value and the provider's verbatim
  refusal are named. A RESIDUAL IS REPORTED AS A RESIDUAL, NEVER AS CLEANUP,
  and it is never chased with a second unapproved order;
- `unresolved` - something was submitted whose outcome the provider has not
  confirmed. The intent id is named, nothing is resubmitted, and the exposure is
  reported as unsettled rather than as a residual, because a number that can
  still move is not a residual.

The step FAILS unless every market is `flat`, and the failure lists every market
that is not, with its outcome. One market's failure does not stop the markets
behind it: each is attempted, its failure is collected verbatim, and the summary
carries all of them. Evidence lands as `01-target`, `02-markers`, then
`position-<symbol>`, `close-<symbol>` and `after-<symbol>` per market, then
`summary`.

Everything gated skipped, the pure contract files green (the ordinary state, and
what CI sees):

    cd vex-app && pnpm exec vitest run src/main/lighter/__tests__/live

## Dry-run mode, and its one honest limit

`VEX_LIGHTER_LIVE_DRY_RUN=1` runs the four gates, the prepare tool, the trusted
follow-up hop and the approval ENQUEUE, asserts the durable rows and the card
content, and then stops.

It stops BEFORE the decision, not after it, and that is a limitation of the
production design rather than a choice: `prepareApprove` commits the decision
and dispatches the approved resume tool in ONE call, so there is no supported
way to record an approval without also signing. A dry run that "decided" would
have signed. The row a dry run leaves behind is a real, undecided approval card;
it expires on its own (`APPROVAL_TTL_MS`, one hour) and nothing was signed.

Run a dry run ONLY against a throwaway install and a throwaway database:

    cd vex-app && \
    VEX_CONFIG_DIR=/tmp/vex-live-dryrun/config \
    VEX_DB_URL=postgres://.../throwaway \
    VEX_LIGHTER_LIVE_DRY_RUN=1 \
    VEX_LIGHTER_LIVE_ACCOUNT_INDEX=24226 \
    VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE=/tmp/vex-live-dryrun/password \
    VEX_LIGHTER_LIVE_EVIDENCE_DIR=/tmp/vex-live-dryrun/evidence \
    VEX_LIGHTER_LIVE_KEY_REGISTRATION=1 \
    pnpm exec vitest run src/main/lighter/__tests__/live/key-registration.test.ts

A dry run applies migrations (`runMigrations`) because a throwaway database has
none; a live run never does, because the app's own database is already migrated.

The deposit dry run is the same, plus the amount:

    cd vex-app && \
    VEX_CONFIG_DIR=/tmp/vex-live-dryrun/config \
    VEX_DB_URL=postgres://.../throwaway \
    VEX_LIGHTER_LIVE_DRY_RUN=1 \
    VEX_LIGHTER_LIVE_ACCOUNT_INDEX=24226 \
    VEX_LIGHTER_LIVE_MASTER_PASSWORD_FILE=/tmp/vex-live-dryrun/password \
    VEX_LIGHTER_LIVE_EVIDENCE_DIR=/tmp/vex-live-dryrun/evidence \
    VEX_LIGHTER_LIVE_DEPOSIT_AMOUNT=3 \
    VEX_LIGHTER_LIVE_DEPOSIT=1 \
    pnpm exec vitest run src/main/lighter/__tests__/live/deposit.test.ts

To watch the amount gates refuse, point `VEX_DB_URL` at an unreachable database
and set the amount to nothing, to `abc` or to `0.5`: the run stops with the
refusal and never with a connection error, which is the proof that no row was
written. The balance gate cannot be demonstrated that way without a real vault,
so `deposit-amount-gate.test.ts` proves it (and the card-binding checks) over
values instead - the same functions the live run calls.

## Evidence

Each run creates `"$VEX_LIGHTER_LIVE_EVIDENCE_DIR"/<test>-<timestamp>/` and
writes one numbered JSON file per step as the step completes, so a run that dies
after a signature still leaves the transaction identity on disk. The same record
is printed to stdout as one JSON line.

Recorded per step: the resolved target (environment, account, wallet, session
id, and the onboarding workflow row before and after step 0); the prepare output
and the durable approval card; the approval decision and the resume tool's own
output; every reconciliation attempt, not only the last, because on a money path
the SEQUENCE of provider answers is the evidence; and the provider's own
read-back - the quote, the card and the confirmed USDG received for step 1; the
account collateral before and after plus the L1 transaction hash, block and
credited amount for step 2; Lighter `apiKeys` for step 3; `fees_status` for step
4; the proposal, the confirm result, the observed account row, the raw `getTx`
transaction proof and one raw `account_all_positions` WebSocket frame for step 5;
the authenticated trades, the matched fills and the exposure before and after for
steps 6 and 9; the inactive-order read and the two IMR readings for step 7; the
prior limits row, both derived shares with their inequalities, the preview
advisory, the prepare answers and the restore for step 8; the markers found, the
reconciliation of every intent they name, the close card's critical args, the
close result and every flat-poll attempt for step C.

Two evidence files are not numbered steps and exist for the operator rather than
the record: `cleanup-required.json`, written by step 6 the moment its first fill
lands and read by step C, and `01-prior-limits.json`, written by step 8 before it
touches the durable share.

Never recorded: the master password, any private key, any signed payload, any
auth token.

## The database rows are the evidence

Nothing is deleted, and each run prints the SQL to read its rows back:
`approval_queue`, `approval_intents` and `messages` for the run's session, plus
the full intent rows by approval id.

## The provider-depth gaps this harness works around

All three are in projections this lane does not own.

1. `projectAccount` (`protocols/lighter/projectors.ts`) keeps `collateral`,
   `available_balance`, the positions and the assets, and drops the
   ACCOUNT-LEVEL MARGIN AGGREGATES - `cross_initial_margin_requirement` among
   them. That aggregate is what the capital-share arithmetic compares a budget
   against and what step 7 measures against a resting order, so those readings
   come from the provider's own row through the production client
   (`readRawAccount`).
2. `projectTrade` drops every ACCOUNT-RELATIVE field on a fill:
   `taker_position_size_before`, `taker_position_sign_changed`,
   `ask_account_pnl`, `bid_account_pnl`, `taker_fee`, `integrator_taker_fee`.
   Those are exactly the round-2 unit measurement, so step 6 records the
   authenticated response verbatim and the projected tool output beside it.
3. The approval preview's key allow-list
   (`engine/core/approval-intent-preview.ts`, `PREVIEW_KEY_ALLOWLIST`) has no
   `walletAddress` key, so the SPENDING WALLET is not a field on any approval
   card; what a swap card does carry is the chain, inside its spendability line.
   Step 1 therefore asserts the session's selected wallet - which is what the
   executor resolves the signing wallet from - and NAMES the gap in its `card`
   evidence rather than pretending the card showed it.

`projectMarketDetail` used to drop every margin field and no longer does: it now
carries `margin.{scale,defaultInitialFraction,minInitialFraction,maintenanceFraction,closeoutFraction}`
plus `markPrice` and `indexPrice`. The order steps still read the RAW
`orderBookDetails` row through the production client, for a different reason: on
a money path the provider's own response is the specification, and the raw row is
what goes into the evidence.
