# Indexify — Solana Social-Index ("Stacks") Client

> Client for `api.indexify.finance` (docs 0.1.12-beta, howto.indexify.finance).
> Indexify bundles Solana tokens into creator-curated, USDC-denominated baskets
> ("stacks"), indexed from $1.00 at inception, with creator revenue share.
>
> **Last updated: 2026-08-26 (initial integration)**

## The one fact that shapes everything: custodial execution

Indexify is a **custodial API venue** — the first in this tree. Trades execute
**server-side** against the account's Indexify-embedded wallet, authorized by
an `ix_` API key alone (`X-API-KEY`, from `INDEXIFY_API_KEY`, read per call and
never cached, logged, or echoed into errors):

```
POST /api/txn.php?action=swap  { stack_id, amount, cue }  →  { order_id }
```

No transaction is built, simulated, or signed on our side; the venue fans one
order out into per-token Solana swaps whose hashes appear later on its order
ledger (`orders.php`, `transaction_history.php`). Consequences:

- The POST is the **commit point**. Handlers do not pass the abort signal to a
  mutating call, and a transport failure there is reported as AMBIGUOUS with
  the instruction to re-read orders before retrying.
- Settlement truth is the venue's own queryable ledger + the runtime's
  `protocol_executions` audit rows. There is **no wallet-shaped
  `agent_activity` lane** for this venue — faking one with a row that claims a
  local broadcast would be worse than the explicit gap. A custodial-venue
  activity vocabulary is a deliberate follow-up.
- Sells are sized as a **percent of holdings (1–100)**, never in dollars —
  `cue: toUSDC` reinterprets `amount` as a percent. The tool surface splits
  the two into `amountIn` vs `sellPercent` so this can never be confused.

## Exposure policy (enforced structurally — the client wraps NONE of these)

- `txn.php?action=export_key` — returns the raw private key.
- `txn.php?action=withdraw_usdc` — sends funds to an arbitrary address.
- `user_info.php?action=delete_account` — irreversible; its documented 200
  response also contains `private_key`.
- Every profile / social-link / notification / chat / follow write.
- `stack_info.php` `close` / `edit_allocation` / `update`, `rebalance`, and
  limit orders (`limit_orders.php`) — deferred, each needs its own pass.

## Measured docs-vs-wire defects (probe 2026-08-26)

| # | Defect |
|---|--------|
| 1 | `deanon.php` fully documented, returns web-server `404 File not found` — not deployed |
| 2 | `stack_info?action=trending` requires `limit` AND `offset` together (docs say optional) — client always sends both |
| 3 | Raw stack rows ~3.6 KB each (docs suggest nothing) — handlers project; caps are hard |
| 4 | `txn.php?action=balance` documented, answers `{"error":"Invalid action"}` — per-mint balances unavailable |
| 5 | `fee.php?action=min_buy` docs claim micro-USDC; wire serves human USDC (`5` = $5) |
| 6 | `stack_info?action=fetch` docs say auth optional; live it 401s keyless — `fetchStack` sends the key `if-present` and `indexify.stack` is requiresEnv-gated |
| 7 | `user_info?action=public_profile` docs type `created_at` as string; wire serves a unix-seconds number |

## Files

```
constants.ts   — base URL/env names, endpoints, caps, enums, exposure policy
types.ts       — wire-shaped domain types (fat rows; projection is the handlers' job)
validation.ts  — Zod validators; strict identity, tolerant display (rule 90)
errors.ts      — HTTP/transport → INDEXIFY_* VexErrors; ALL provider text scrubbed
client.ts      — the API client; auth per call, singleton via getIndexifyClient()
```

Consumed by `src/vex-agent/tools/protocols/indexify/` (13 tools: 10 reads,
`trade_execute`, `order_resolve`, `stack_create`).

## Facts worth not re-measuring

- Rate limit: 10 rps leaky bucket, burst 100, per IP; 429/503 on overflow.
- Fees: 1% platform + creator fee (live bounds 0–0.5%, default 0.5%); gas sponsored.
- Minimum buy: $5 (human USDC, live).
- Stack create: `stackTokenInfo` maps mint → INTEGER percent, sum exactly 100,
  max 12 tokens; `socialLinks` is required but accepts empty-string members;
  creation is free and public immediately at `app.indexify.finance/stack/<slug>`.
- Orders: `PENDING → SUCCESS | FAILED | PARTIAL`; PARTIAL resolves via
  acknowledge / retry / sell_all, and `partial_details.available_actions` is
  the authority on which are currently offered.
- `usdc_balance` returns `{balance, reserved}` — `reserved` is undocumented
  but real (USDC held by in-flight orders).
