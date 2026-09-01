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
| 8 | ~~`stack_info?action=edit_allocation` answers 401 to the API key~~ **RESOLVED 2026-09-02**: the Indexify team enabled API-key reallocation in production; verified live on stack 28440 (same-weights edit, version 1→2). The Z500 sync needed zero changes |
| 9 | `edit_allocation`'s success response reports `version` as the PREVIOUS version, not the resulting one (measured 2026-09-02: response said 1, read-back showed 2) — confirm applied state via `version_history` read-back, never the response field. The Z500 runner already does |

## Token registration and the dev environment (2026-09-02)

`token_info.php?action=new` with `{token_address}` registers a token into
the venue's catalogue — the team's prescribed lever for getting Z500 coins
"into the system". Measured behavior:

- 200 → the registered token row; the venue resolves the pool itself and
  auto-creates the token's company stack.
- 400 `"Token already exists in database"` → benign idempotency signal.
- 400 market-cap floor → the venue enforces a **$10k minimum against LIVE
  data** ("Token market cap ($9,441.21) is below minimum threshold of
  $10,000") — never pre-judge locally; the venue is the authority.
- 404 `"Token not found on CoinGecko"` → mint unresolvable on their sources.
- OBSERVED: the endpoint accepted a keyless call — registration appears to
  require no auth server-side (reported to the team; we send the key anyway).

`stack_info?action=create` now AUTO-REGISTERS unknown mints in the
allocation, failing the whole create with a 400 naming the first offending
mint — but registrations processed BEFORE the failure persist (non-atomic;
verified on dev: a failed create left its first token registered).

A **dev environment** exists at `https://api-dev.indexify.finance` with its
own account and key (dev embedded wallet `6s82…PLnx`); the production key is
invalid there and vice versa. Dev keys never enter this repo — point
`IndexifyClient` at the dev base URL and supply the dev key via
`INDEXIFY_API_KEY` for ad-hoc testing only.

## Files

```
constants.ts   — base URL/env names, endpoints, caps, enums, exposure policy
types.ts       — wire-shaped domain types (fat rows; projection is the handlers' job)
validation.ts  — Zod validators; strict identity, tolerant display (rule 90)
errors.ts      — HTTP/transport → INDEXIFY_* VexErrors; ALL provider text scrubbed
client.ts      — the API client; auth per call, singleton via getIndexifyClient()
```

Consumed by `src/vex-agent/tools/protocols/indexify/` (13 tools: 10 reads,
`trade_execute`, `order_resolve`, `stack_create`), and by the Z500
allocation-sync workflow (`src/vex-agent/sync/z500-allocation-sync/`,
spec `indexiy-ansem.md`), which uses four client methods that are
DELIBERATELY NOT agent tools: `versionHistory`, `tradability`,
`fetchStack`, and `editAllocation` — the one allocation mutation, pinned by
the workflow to stack 28440. The client still wraps NO `rebalance`, and a
test asserts that absence.

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
