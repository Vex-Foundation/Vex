# Hyperliquid client

Privileged HyperCore client used only by Vex's trusted runtime. The renderer
never imports this package, receives a signing capability, or receives a raw
Hyperliquid API response.

## SDK verification record

- Dependency: `@nktkas/hyperliquid` **exactly** `0.33.1`.
- The in-repository signing regression ports the official
  `hyperliquid-python-sdk` vectors verified on 2026-07-11. It asserts all
  13 ECDSA `r`/`s`/`v` signatures byte-for-byte, plus the L1 action hash; it
  is not a recovery-only check.
- Re-run: `pnpm vitest run src/__tests__/hyperliquid/hyperliquid-signing.test.ts`.
- The SDK package and transitive dependencies had no install hooks, npm
  provenance attestation was present, and `pnpm audit` was clean at the
  verification point. These are supply-chain observations, not a reason to
  loosen the exact pin.
- `decimal.js@10.6.0` is a direct exact dependency. It was previously only
  transitive through the SDK; Vex imports it directly for exact financial
  decimal arithmetic.
- Upgrades require a separate dependency review, lockfile diff review, and a
  passing byte-exact signing-vector suite before use.

## Network selection

`VEX_HYPERLIQUID_NETWORK=mainnet|testnet` selects the API endpoints. Omission
defaults to `mainnet`. Testnet runs the atomicity/reconciliation acceptance
matrix against the identical production code with only the SDK testnet flag
changed; the supervised user-wallet mainnet micro-quicktest occurs after M2.

## Coverage matrix

| Capability | Status | Location / rationale |
|---|---|---|
| L1 and user-signed action construction/signing | Implemented — Phase 1 | `signer.ts`, byte-exact vectors |
| Perp/spot metadata, market/account/info reads | Implemented — Phase 1 | `info.ts`, `meta-cache.ts` |
| Order placement, normal TP/SL grouping, plain user-opt-out entry, full-position TP/SL, close, modify, cancel, leverage/margin, TWAP | Implemented client support — Phase 1 | `exchange.ts`; `openPosition` is callable only by the protocol layer when resolved user policy has `requireStopLoss=false`; it cannot bypass validation and must never be model-selected |
| Transfers, vault actions, staking, rewards, builder-fee approval | Implemented — Phase 5 | `exchange.ts` plus agent handlers; builder allowance is disclosed in first-entry acknowledgement and is never a separate confirmation gate |
| WebSocket user/order/asset subscriptions | Implemented client support — Phase 1 | `subscriptions.ts`; lifecycle owner is added with runtime integration |
| Hyperliquid policy resolver, main-owned preferences provider, and first-entry acknowledgement gate | Implemented — Phase 4a | `src/lib/hyperliquid-policy.ts` remains canonical; Electron registers its fail-closed provider before engine startup and disables HL mutations until the user acknowledges the risk disclosure |
| Core/spot reads, trading manifests, semantic discovery, and prompt guidance | Implemented — Phase 2 | `src/vex-agent/tools/protocols/hyperliquid/` |
| Atomic perp-open availability | Implemented — owner decision 2026-07-13 | The release gate was REMOVED: `hyperliquid.perp.open` (and `hl_open`) is available whenever a Hyperliquid policy provider is active, like every other mutating tool. The §8.1 testnet matrix remains available as an optional validation harness |
| §8.1 testnet atomicity evidence runner | Implemented — optional validation harness | `pnpm hyperliquid:testnet-matrix` forces `api.hyperliquid-testnet.xyz`, uses only `VEX_HL_TESTNET_PK`, writes redacted evidence, and exits non-zero unless every parent/child, rejection, timeout/CLOID, and consolidation case passes |
| Protection invariant, SL consolidation, partial-response compensation | Implemented — Phase 2 | Runtime gate plus handlers; reconciler/watchdog confirmation is Phase 3 |
| Synchronous filled-open consolidation | Implemented — safety remediation | A confirmed fill places and verifies one full-position `positionTpsl` before cancelling the identified fixed-size child, then verifies `PROTECTED`; unknown/offline outcomes remain reconciler-owned |
| Deterministic order timeout recovery | Implemented — safety remediation | Every submitted order receives a CLOID; transport timeouts query `orderStatus` by CLOID and return per-order `confirmed` / `not_found` / `unknown` recovery outcomes |
| Spot precision validation | Implemented — safety remediation | Spot meta caches base-token `szDecimals`; spot prices use MAX_DECIMALS=8 and orders enforce lot precision and the $10 non-reduce-only minimum before signing |
| Approval preview and user-owned SL opt-out indication | Implemented — Phase 2 | Typed gate DTO; UI display is Phase 4 |
| Position snapshot capture, reconciliation, MTM, and external close/liquidation mapping | Implemented — Phase 3 | `src/vex-agent/sync/hyperliquid-reconciler.ts` via `hyperliquid_reconcile.position` synthetic captures |
| Generic `loop_defer` mark-price watches and monotonic wake promotion | Implemented — Phase 3 | Generic wake registry plus `hyperliquid-market-watcher.ts`; the scheduler itself has no HL-specific branch |
| Agent candle store, WebSocket watches, and technical scans | Implemented — Phase 9 | `hyperliquid_candles` + `hyperliquid_candle_watches`, `hyperliquid-market-watcher.ts`, and `hyperliquid.market.{watchCandles,candles,scan}` |
| Offline-fill protection consolidation | Implemented — Phase 3, detection/wake only | Reconciler records `CONSOLIDATING` and wakes/notifies the owning mission; only the normal approval-gated `perp.setTpsl` path signs the replacement and cancels the child |
| Durable session risk proposals and user-confirmed activation | Implemented — Phase 4a | Migration `037_hyperliquid_session_policies.sql`; immutable agent/user rows, one active session/wallet policy, main-side max-leverage validation, and main-owned policy cache |
| Positions dashboard, live main-process push, and protection freshness states | Implemented — Phase 4a | Strict renderer DTOs only; positions derive protected/UNPROTECTED/consolidating/stale from `protectionState` and reconciler `confirmedAt` |
| Typed Hyperliquid transcript cards | Implemented — Phase 4a | A shared discriminated display-block schema with literal `namespace: "hyperliquid"`; JSON/markdown alone cannot receive the branded frame |
| Version-aware mission contract risk envelope | Implemented — Phase 4b | New v2 contracts hash typed `hyperliquidRisk`; recorded v1 material and verification remain byte-for-byte legacy forever |
| Position chart | Implemented — Phase 4b | Main-cached candle snapshots only, direct `lightweight-charts@5.2.0` canvas lifecycle, and entry/SL/liquidation/live-mark lines; Apache-2.0, no React wrapper |
| Bridge2 native-USDC funding from Arbitrum One | Implemented — Phase 5 | `hyperliquid.deposit` transfers 6-decimal native USDC to the pinned mainnet Bridge2 address; 5 USDC irreversible floor, sender-only credit, balance preflight, and mined-receipt guard |
| USD-class transfer and external USDC/spot sends | Implemented — Phase 5 | `transfer.usdClass`, `withdraw`, and `transfer.send`; egress has a typed recipient preview and a fail-closed own-account/foreign classifier |
| Vault/HLP reads and transfers | Implemented — Phase 5 | Agent-mediated only; no direct renderer mutation form; collateral-reducing actions re-check protected perp maintenance headroom |
| HYPE staking and rewards | Implemented — Phase 5 | Delegation, staking-balance transfer, summary, and reward-claim tools use exact base-unit integer input |
| Builder fee allowance and order attachment | Implemented — safety remediation | First-entry acknowledgement discloses the 0.025% fee on filled notional. Order flow starts one non-blocking, memoized per-session venue check/approval when missing and attaches `{ b, f:25 }` only after a later `maxBuilderFee >= 25` confirmation; a failed attempt never blocks an order and may retry on a later order. |
| Hypervexing workspace enter/exit and mode-scoped hot aliases | Implemented — Phase 8 | Electron main owns transient per-session mode state. Entry is agent-tool-only; renderer IPC exposes exit only. In Hypervexing mode, direct `hl_*` aliases use the same protocol runtime gates as `execute_tool`; normal mode exposes neither aliases nor compact index. |
| `scheduleCancel` arming | Excluded by design | The action cancels every open order, including protective stops; client support is retained for auditability only |
| Perp/spot deployer, validator, gossip, cSigner, multisig/abstraction, aqav2, HIP-3 liquidator actions | Excluded by design | Infrastructure/deployer surface or unacceptable risk |
| Subaccounts and borrow/lend | Deferred | Separate product/security design |

## Candle-analysis workflow

Use `hyperliquid.market.watchCandles` to backfill and keep one `(coin, interval)` local history fresh, then use `hyperliquid.market.candles` for rows or `hyperliquid.market.scan` for compact signals. An unwatched read/scan makes one snapshot request without persistence; a later wake condition can reuse the scanner's pure candle evaluators instead of duplicating indicator logic.

## Boundary rules

All financial values cross this package as canonical decimal strings. No
binary-float arithmetic is used for validation, price caps, or trigger prices.
`hl_mark_price` wake conditions are bounded to a 50% deviation from the live
mark at registration; the scheduled `after_ms`/`wake_at` remains their fallback.
The signer resolves the selected wallet only for the signing operation and
never logs or serializes private key material.

## Atomic-open release gate (RETIRED — owner decision 2026-07-13)

The capability flag and its catalog/runtime blocks were removed: every
Hyperliquid tool is live in the workspace as soon as the policy provider is
active. The testnet matrix below remains a supported OPTIONAL validation
harness for signing/atomicity changes. Historical description follows.

Run the supervised matrix with a funded, clean, **throwaway testnet** wallet:

```sh
VEX_HL_TESTNET_PK=0x... pnpm hyperliquid:testnet-matrix
```

The runner always constructs testnet clients directly; it does not consult the
runtime network default, resolve a Vex wallet, or access the vault. It refuses
to start if that test wallet already has an order or position in the selected
market, writes only redacted request/result summaries to the git-ignored
`.claude/plan/hl-matrix-evidence.json` by default, cleans every tracked order
and position, prints a PASS/FAIL table, and exits non-zero for any failed case.
Set `VEX_HL_MATRIX_EVIDENCE_PATH=/tmp/hl-matrix.json` to retain evidence in a
separate protected location, or `VEX_HL_TESTNET_COIN=...` to select another
testnet Core perp.

The matrix covers a resting parent plus SL child, an accepted parent with a
rejected child and its production compensation classifier, an entirely
rejected invalid-tick bundle, forced response-loss CLOID recovery with a
repeat CLOID submission, a marketable IOC fill followed by synchronous
full-position-stop consolidation, and validation-only plain-entry behavior for
the user-owned `requireStopLoss=false` path. The coordinator may set
`VEX_HYPERLIQUID_ATOMIC_OPEN_ENABLED=1` only after one full-PASS run with its
retained evidence reviewed for this release configuration; that flag must stay
scoped to the reviewed release configuration.

`openPosition` is deliberately a narrowly scoped client capability for the
user-owned `requireStopLoss=false` setting. The protocol protection gate, not
model parameters, selects it; with `requireStopLoss=true` it always selects
atomic `openWithStopLoss`, and an explicitly supplied SL always retains the
atomic path even when the user opted out of mandatory coverage. An SL-less
capture is marked `unprotected_by_user_choice`.

## Offline-fill protection

An atomic `normalTpsl` entry uses a fixed-size, reduce-only SL child. If its
entry fills while Vex is offline, that child still covers the filled size and
reduce-only execution cannot increase the position. The reconciler therefore
records `CONSOLIDATING`, not `UNPROTECTED`, and wakes/notifies the owning
mission. It does not sign in the background. The woken agent must use the
ordinary gated `perp.setTpsl` path to place a full-position stop and only then
cancel the transient child. Scale-ins, non-reduce order changes, and TWAP stay
blocked until that full-position stop is the sole coverage.

Repeated cancellation failures retain the truthful `CONSOLIDATING` coverage
state but add a `protectionEscalation: "UNPROTECTED"` audit marker, producing
the existing actionable notice and reduce-only-close proposal. This preserves
the signing trust boundary without falsely claiming the fixed-size child has
disappeared.

## Funding and builder-fee boundaries

`hyperliquid.deposit` funds the selected Hyperliquid account by sending native
USDC on Arbitrum One to the pinned mainnet Bridge2 contract. It accepts only
`amountUsd`; the recipient is never a model parameter. The handler rejects an
amount below 5 USDC before resolving a signing wallet because the venue does
not credit sub-minimum transfers and they are permanently lost. It preflights
the selected wallet's native-USDC balance, confirms the mined ERC-20 receipt,
then records an Arbitrum funding capture. Bridge2 credits the sender's
Hyperliquid account in less than one minute; use `hyperliquid.account.overview`
to verify the credited balance. Testnet deposits are deliberately unsupported
until a separately verified testnet bridge address is approved.

Hyperliquid withdrawals have a 1 USDC venue fee. CCTP/native-USDC migration
availability is rendered only from runtime/provider state; when it cannot be
verified Vex shows it as unavailable rather than making a static compatibility
claim.

The release bundle, not source code, supplies the builder address. The
first-entry acknowledgement is the user's disclosure and consent for the
configured 0.025% fee on filled notional. Before attaching a builder field,
order flow starts one non-blocking, memoized `maxBuilderFee` check for the
session; if missing, that task best-effort submits `approveBuilderFee` and the
current order goes without a builder field. A later order attaches the builder
field `{ b, f:25 }` only after HyperCore confirms `maxBuilderFee >= 25`.
Missing release config, a failed allowance, or an unavailable confirmation
never block a user order and never attach an unconfirmed fee; a later order
may retry the venue check. The standalone approval tool remains an ordinary
mutation: restricted sessions require their normal approval; full sessions do
not impose a special builder-only confirmation.

## How it works in the agent workflow

### Normal mode

Normal Vex sessions retain the standard protocol workflow. The protocol
navigation summary names `hyperliquid` as a venue, `discover_tools` finds the
relevant facet, and `execute_tool` calls its canonical `hyperliquid.*` tool
ID. There are no Hyperliquid shortcut aliases or compact Hyperliquid index in
the normal tool menu or prompt. This keeps the ordinary surface explicit and
prevents a stale workspace request from broadening an unrelated session.

### Entering and leaving Hypervexing

Only the agent can request entry by calling `hyperliquid.workspace.enter`.
That non-financial local-presentation tool emits a session-scoped event; the
Electron main process records the transient mode for that session, checks the
main-owned first-entry acknowledgement, and pushes the renderer event. The
mode is never persisted, so a restart starts in normal mode. If acknowledgement
is still needed, the renderer shows the risk card before its transition.

While that session is in Hypervexing mode, the agent receives a compact hot
set: `hl_markets`, `hl_positions`, `hl_orders`, `hl_book`, `hl_account`,
`hl_open`, `hl_close`, `hl_set_stop`, `hl_cancel_orders`, `hl_leverage`,
`hl_risk_setup`, and `hl_exit`. Each is only a lossless alias to the matching
canonical tool ID; it invokes `executeProtocolTool`, never a special execution
path. All trading and market-analysis verbs (including `hl_open`, `hl_scan`, `hl_candles`, `hl_watch`) are hot aliases whenever the policy provider is active.
The prompt also adds a compact index for every non-hot `hyperliquid.*` tool so
the agent can call `execute_tool` without another discovery round. The static
protocol prompt remains cacheable; this mode suffix is added per turn so entry
and exit cannot leave a cached index behind.

The in-workspace EXIT control is the sole renderer-originated mode request. It
sends the active session ID to main and does not flip renderer state
optimistically. Main updates the same session map used by agent entry and
pushes the authoritative normal-mode event. An IPC failure leaves the current
mode visible with a retry path rather than claiming an exit that the engine did
not receive. The agent can also call `hyperliquid.workspace.exit`.

### Trade gate chain

A perp entry follows one chain whether reached by `execute_tool` or `hl_open`:

1. Main resolves the policy snapshot from defaults, user preferences, an
   active user-confirmed session proposal, and an accepted mission v2 risk
   envelope. Later layers can tighten limits; the model cannot loosen them.
2. The protection gate validates the requested entry, estimated liquidation,
   maintenance headroom, stop direction/distance, and current protection
   state. Mandatory stop loss is the default; only the user's setting can opt
   out, and a supplied stop always keeps the protected path.
3. The approval gate applies session permission and special egress rules.
   Foreign sends and withdrawals always require approval; internal USD-class
   transfers and withdrawals to the selected session EVM wallet auto-run only
   in full sessions. `egressAlwaysApprove` remains persisted and patchable for
   compatibility, but no longer changes the gate. The builder fee follows the
   first-entry acknowledgement and ordinary session permission.
4. Before any signing or account mutation, the client revalidates the complete
   entry/SL/TP bundle against live metadata, tick, lot, minimum-notional, and
   leverage rules. Only then does it apply the requested leverage/margin mode;
   a rejected bundle cannot alter account settings or start builder allowance work.
5. The trusted runtime signs with the selected master EVM key and submits an
   atomic `normalTpsl` entry plus reduce-only stop child when protection is
   required. Stop losses are not guaranteed fills.
6. A confirmed immediate fill is consolidated synchronously into one
   full-position stop before the transient child is cancelled. The capture
   pipeline records the result, projects it to local Postgres, and main pushes
   typed position updates to the UI.

The atomic parent/child acceptance matrix is a release capability, not merely
a test reminder. `VEX_HYPERLIQUID_ATOMIC_OPEN_ENABLED` is fail-closed when
absent: it hides and hard-blocks `hyperliquid.perp.open` and `hl_open` until
the supervised testnet matrix passes. Risk-reducing close and stop tools remain
available so the capability gate cannot strand an existing position.

### Reconciliation, wakes, and safety boundaries

The periodic reconciler compares HyperCore state with projected positions and
creates synthetic captures for external fills, cancellations, liquidation,
and mark-to-market changes. It never signs. An offline fill covered only by a
fixed-size normal-TPSL child becomes `CONSOLIDATING`: the child still covers
the filled position, scale-ins and TWAP remain blocked, and a price/watch wake
asks the agent to place the full-position stop through the normal gated tool
path. Repeated failure escalates truthfully to the existing unprotected notice
and reduce-only-close proposal.

`loop_defer` price watches use generic, exact-decimal conditions. Hyperliquid
mark ticks can only promote an existing pending mission wake; they never create
parallel loops or postpone a due wake. Builder attachment is separate: after
the first-entry disclosure, order flow starts one non-blocking, memoized venue
check/allowance task when `maxBuilderFee` is missing, and only a later successful
`maxBuilderFee` confirmation enables `{ b, f:25 }`. Missing or failed venue
allowance is safe no-builder behavior and can retry on a later order.
Foreign withdrawals and sends always require approval even in focused mode;
own-account funding follows the same restricted/full session matrix because
aliases do not alter approval semantics.
