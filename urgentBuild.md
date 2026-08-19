# Lighter Urgent Build Plan

## Objective

Launch a production-safe Lighter trading experience quickly without claiming or
exposing capabilities that Vex cannot yet manage end to end. Each phase is a
separate release boundary. A phase is complete only after its code paths pass
the relevant local checks and every network-dependent capability has either
live provider evidence or is explicitly kept behind a release gate.

## Phase 1 — Safe Basic-Trading Launch

Launch scope: IOC market orders on Lighter Core and Robinhood Chain for users
whose target Lighter account is already funded. Both perpetual and spot market
resolution are supported, but spot funding/onboarding is not yet described as
seamless.

- Fix post-approval spot revalidation so preview and execution resolve markets
  from the same perpetual-plus-spot provider response.
- Correct terminal-order classification so a canceled or expired order with a
  positive fill is reported as partially filled, never as "no position opened."
- Align conversational routing with the runtime's Robinhood Chain default and
  keep the selected environment stable from onboarding through execution.
- Refuse resting limit and post-only orders until Vex can cancel and modify
  them. Phase 1 permits IOC market orders only.
- Remove stale UI copy that says managed RHC key registration is unavailable.
- Restore a green Lighter release gate, including the pinned Core gateway
  implementation in deposit fixtures.
- Verify focused TypeScript, Go signer, Electron boundary, app Lighter, protocol
  Lighter, build, and live public Core/RHC market-data checks.

Phase 1 does not claim that Vex can fund a spot account, manage resting orders,
set leverage, or place conditional orders.

## Phase 2 — Complete Order Lifecycle

- Add exact, approval-gated cancel-one, modify, and cancel-all operations using
  provider order identity preserved as exact strings.
- Add durable cancel/modify intents, nonce reservation, pre-submit provider
  revalidation, ambiguous-outcome repair, and WebSocket reconciliation.
- Add reduce-only position close with a fresh position read and resulting-fill
  report.
- Re-enable limit and post-only creation only after cancel and modify have real
  provider/live proof.
- Stream and reconcile account orders, trades, and positions so Vex reports the
  executed amount, remaining amount, average fill, and resulting position.

## Phase 3 — Seamless Spot and Perpetual Funding/Risk

- Add approval-gated transfers between the user's own perpetual and spot
  buckets, followed by exact balance reconciliation.
- Add spot-route onboarding, deposits, supported-asset withdrawals, balances,
  locked balances, and average entry prices.
- Add leverage, cross/isolated margin selection, and isolated-margin add/remove
  flows with separate approvals.
- Derive market-order worst price from live depth and an explicit slippage cap;
  do not rely on model arithmetic.
- Show market type, mark/index price, fee tier, funding rate, initial margin,
  estimated liquidation price, and before/after position on trade approvals.
- Add account limits, PnL/performance, funding history, and margin-health reads.

## Phase 4 — Advanced Lighter Products

- Add take-profit, stop-loss, TP/SL limit, grouped/bracket, and TWAP orders.
- Add Universal Deposit Address and supported multi-chain deposit routes where
  Vex can keep builder credentials server-side and reconcile the full route.
- Evaluate fast withdrawals, subaccounts, account-tier management, maker-only
  keys, public pools, staking, integrator approvals, and RFQ individually.
- Ship only products that preserve local-key custody, exact approval disclosure,
  durable recovery, and real provider/live verification.

## Release Rules

- Never call API acceptance final execution; require sequencer/order/trade
  evidence.
- Never retry a signed transaction blindly after an ambiguous outcome.
- Never expose private keys, auth tokens, decrypted vault data, or signing
  authority to renderer, preload, transcripts, logs, telemetry, or provider
  error messages.
- Never move funds or change account state without an exact Vex approval card.
- Mocks and fixtures are regression guardrails only, not production proof.
