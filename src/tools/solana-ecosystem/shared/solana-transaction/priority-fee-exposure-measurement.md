# Solana priority-fee exposure — measurement

Evidence for the shared pre-sign priority-fee CEILING that phase-3 item 6b
requires: a bound on `SetComputeUnitPrice x effective compute-unit limit` for
every opaque provider-built Solana transaction Vex signs.

**STATUS: evidence landed, gate NOT landed.** The measurement below is complete
and reproducible. The gate itself was stopped before implementation — see
"Why the gate is not here yet". Read that section before using these numbers.

> **UPDATE 2026-07-25 — the blocker named in "Why the gate is not here yet" is
> gone, and so is the module it referred to.** The pre-sign compute-budget
> SUFFICIENCY gate (`./compute-budget-sufficiency.ts`, the first row of the
> table below) was removed entirely by owner decision: the chain already
> enforces the compute limit atomically, so refusing a starved transaction only
> saved a network fee of ~15,023 lamports while risking a far larger blocked
> trade. Reasoning and the measurement it rested on are parked in
> `agents_dm/parked/compute-budget-margin-measurement.md`.
>
> Consequences for the 6b plan below, which nobody has re-approved:
> - Steps 1 and 2 are void as written. `readDeclaredComputeUnitLimit` and
>   `inferDefaultComputeUnitBudget` no longer exist anywhere, so there is
>   nothing to extract and no second owner to worry about — a new
>   `./compute-budget-directives.ts` would now be the FIRST and only home for
>   the SIMD-0170 default-budget rule. That rule is recoverable from this
>   repository's history (it was deleted, not lost) and from the Agave sources
>   this file and the parked measurement both cite.
> - Step 4's ordering note ("call it BEFORE the sufficiency gate") no longer
>   applies; there is no other pre-sign check to order against.
> - Nothing else changes. This is a PRICE bound on SOL that actually leaves the
>   wallet, which is a different question from the one the removed gate asked,
>   and the owner's decision on that gate says nothing about this one.

## What the gate would bound, and why it is a different bound from the others

Three compute-budget bounds already exist or are proposed, and they are easy to
confuse:

| Bound | Owner | What it refuses |
|---|---|---|
| Sufficiency | `./compute-budget-sufficiency.ts` | a transaction whose declared budget cannot cover its simulated consumption |
| `/build` fee ceiling | `jupiter-swaps/build-response-guard.ts` | a Jupiter `/build` RESPONSE whose `limit x price` exceeds the exposure cap |
| **Priority-fee ceiling (missing)** | shared pre-sign path | ANY transaction whose `limit x price` exceeds the cap — including the four opaque-blob paths `/build` never touches |

Solana charges the priority fee on **REQUESTED** units, not consumed ones, so
an extreme price drains SOL whatever the transaction actually does. The
sufficiency gate bounds CONSUMPTION and says nothing about price. The `/build`
guard bounds price, but only on the one lane that goes through `/build`.

The four lanes with no price bound today, all funnelling through
`prepare.ts`'s `prepareVersionedTx`:

- Khalani's Solana bridge leg (`khalani/bridge-executor/leg-signing.ts`)
- Jupiter Lend Earn (`solana-jupiter/handlers/lend.ts`)
- Jupiter Lend Borrow `/operate` (`solana-jupiter/handlers/lend-borrow.ts`)
- Jupiter Prediction (`solana-jupiter/predict-execute.ts`)

## What was measured

- **Date:** 2026-07-25
- **Network:** Solana mainnet-beta (`https://api.mainnet-beta.solana.com`)
- **Provider:** Jupiter `lite-api.jup.ag/swap/v1` `/quote` + `/swap`, with
  `dynamicComputeUnitLimit: true` and `prioritizationFeeLamports.maxLamports`
  set to **100,000,000** — deliberately far above anything expected, so the
  provider is never the party being clamped. What it attaches is what it
  CHOSE, not what we allowed.
- **Taker:** `5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9`, a publicly
  documented Binance hot wallet, used READ-ONLY as a quote subject. No
  signature was produced and nothing was sent.
- **Cost:** zero. `/quote`, `/swap` and `getRecentPrioritizationFees` are free.

### 1. What Jupiter actually attaches

Two runs, ~2 hours apart, at each documented priority level.

| run | pair | level | CU limit | price (µLamports/CU) | decoded lamports | Jupiter's own figure |
|---|---|---|---|---|---|---|
| A | SOL→USDC 1 SOL | medium | 148,548 | 234,008 | 34,762 | 34,761 |
| A | SOL→JUP 1 SOL | medium | 191,555 | 186,859 | 35,794 | 35,793 |
| A | SOL→USDC 1 SOL | high | 154,220 | 244,711 | 37,740 | 37,739 |
| A | SOL→JUP 1 SOL | high | 191,566 | 340,274 | 65,185 | 65,184 |
| A | SOL→USDC 1 SOL | veryHigh | 148,595 | 416,922 | 61,953 | 61,952 |
| A | SOL→JUP 1 SOL | veryHigh | 267,338 | 1,029,333 | **275,180** | 275,179 |
| B | SOL→USDC 1 SOL | medium | 39,926 | 222,677 | 8,891 | 8,890 |
| B | SOL→JUP 1 SOL | medium | 212,148 | 63,868 | 13,550 | 13,549 |
| B | SOL→USDC 1 SOL | high | 100,378 | 63,940 | 6,419 | 6,418 |
| B | SOL→JUP 1 SOL | high | 237,782 | 90,438 | 21,505 | 21,504 |
| B | SOL→USDC 1 SOL | veryHigh | 147,668 | 248,894 | 36,754 | 36,753 |
| B | SOL→JUP 1 SOL | veryHigh | 237,782 | 117,143 | 27,855 | 27,854 |

**Worst provider-chosen priority fee observed: 275,180 lamports** (0.000275
SOL), at the most aggressive level with 100,000,000 lamports of room available.

**The decode is validated against the provider's own arithmetic.** Our
`ceil(limit x price / 1e6)` matches Jupiter's `prioritizationFeeLamports` field
to within 1 lamport on all twelve rows — the difference is rounding direction,
and ours rounds UP. This is the single most useful result here: it means the
formula a gate would use is the same one the provider bills by, not a guess.

### 2. What the network is charging

`getRecentPrioritizationFees` — the minimum prioritization fee among
transactions that landed in each of 150 recent slots touching that account.
Rightmost column applies the observed maximum at Solana's transaction-wide
maximum of 1,400,000 CU: the worst exposure congestion alone can construct.

| run | account | p50 | p90 | p95 | p99 | max | max at 1,400,000 CU |
|---|---|---|---|---|---|---|---|
| B | USDC mint | 0 | 20,915 | 200,000 | 940,514 | 2,089,273 | 2,924,983 |
| B | Jupiter v6 aggregator | 0 | 0 | 0 | 68,744 | 85,835 | 120,169 |
| B | Jupiter Lend lending | 0 | 0 | 0 | 0 | 0 | 0 |
| A1 | USDC mint | 0 | 0 | 87,468 | 714,285 | 714,285 | 1,000,000 |
| A2 | USDC mint | 0 | 0 | 31,400 | 714,285 | 2,564,896 | 3,590,855 |
| A3 | USDC mint | 0 | 0 | 172,938 | 2,568,058 | 2,570,434 | 3,598,608 |
| A4 | USDC mint | 0 | 18,460 | 714,285 | 8,280,557 | **10,000,000** | **14,000,000** |

Runs A1–A4 are the same account sampled 45 seconds apart. Note how far the
distribution moves in three minutes: p95 went 87,468 → 31,400 → 172,938 →
714,285. **Priority prices are volatile on a timescale of seconds**, which is
what makes "retry / re-quote" a genuinely actionable instruction for a refused
transaction rather than a polite fiction.

## Derivation

Two bounds.

- **Lower bound (autonomy) — never refuse a legitimate transaction.**
  - Worst provider-chosen fee actually observed: **275,180 lamports**.
  - Worst congestion-constructed exposure at the transaction-wide max CU:
    **14,000,000 lamports** (run A4), though the typical figure is
    1,000,000–3,600,000. Note this is a CONSTRUCTED worst case: it multiplies
    the single hottest observed slot-minimum price by the absolute maximum
    compute-unit limit. The Jupiter Lend program — one of the four lanes this
    gate protects — reported a maximum of **0** across 600 sampled slots.
- **Upper bound (protection) — how much incidental cost is tolerable per
  transaction.** No measurement fixes this; it is an owner risk choice. One has
  already been made: `JUPITER_SWAP_MAX_PRIORITY_FEE_LAMPORTS = 10,000,000`
  (0.01 SOL), owner-reviewed and live on the `/build` swap lane.

**Recommendation: reuse 10,000,000 lamports as ONE shared cap**, hoisted into
this directory and re-exported by `jupiter-swaps/constants.ts` — the same
direction already taken for `SOLANA_MAX_COMPUTE_UNITS_PER_TRANSACTION`. A second,
different number for the four opaque lanes would fork a policy that has one
owner, which is precisely how `gas-limit-headroom.ts` says venues drift apart.
Reusing it also makes the gate a provable no-op on the `/build` lane, where the
same bound is already enforced upstream.

That cap sits **36x above the worst provider-chosen fee observed** and **3.4x
above the typical congestion-constructed worst case**.

### The honest caveat, stated rather than buried

Run A4's constructed worst case (14,000,000 lamports) **exceeds** the 10,000,000
cap. Anything relying on this measurement must know that:

- It requires the hottest account on Solana at its most congested observed
  minute AND a transaction requesting the full 1,400,000 CU. None of the four
  protected lanes is a 1,400,000-CU transaction; the measured Jupiter builds
  requested 39,926–267,338.
- Using the SIMD-0170 default budget (`inferDefaultComputeUnitBudget`) rather
  than 1,400,000 for the no-explicit-limit case shrinks this materially. That
  matters: computing the effective limit correctly is what keeps the gate from
  refusing legitimate transactions, and it is the reason the gate should NOT
  simply copy `build-response-guard.ts`'s conservative 1,400,000 substitution.
- If it does fire on a legitimate transaction, the refusal is recoverable — the
  price is provider- and congestion-chosen, and the A1–A4 rows show it moving
  by an order of magnitude within minutes. "Re-quote, prices move by the
  minute" is a true statement here, not a stock phrase.

## Why the gate is not here yet

Implementing the ceiling correctly requires the transaction's EFFECTIVE
compute-unit limit, which is `declaredLimit ?? inferDefaultComputeUnitBudget(message)`.
Both `readDeclaredComputeUnitLimit` and `inferDefaultComputeUnitBudget` are
private to `./compute-budget-sufficiency.ts`, whose own doc states the
SIMD-0170 rule "deliberately" lives in exactly one function. Re-implementing
either in a new module would create a second copy of a rule the codebase
declares single-owner, and substituting 1,400,000 instead would over-state
exposure and refuse legitimate transactions (see the caveat above).

The correct shape is therefore a small extraction, NOT an addition:

1. Move `readDeclaredComputeUnitLimit` (returning price as well as limit) and
   `inferDefaultComputeUnitBudget` into a new `./compute-budget-directives.ts`,
   keeping the duplicate-directive refusal and its current error code and
   wording unchanged.
2. Have `./compute-budget-sufficiency.ts` consume it — a ~20-line change, no
   behaviour change.
3. Add `./priority-fee-ceiling.ts` owning `SOLANA_MAX_PRIORITY_FEE_LAMPORTS`
   and `assertPriorityFeeWithinCeiling(message)`, with a new error code
   (`SOLANA_TX_PRIORITY_FEE_EXCESSIVE` — NOT the sufficiency code; these two
   bound opposite things and must stay distinguishable to the agent).
4. Call it from `prepare.ts` BEFORE the sufficiency gate: it is byte-only and
   free, so it should not cost an RPC round-trip to reach.
5. Re-export the cap from `jupiter-swaps/constants.ts` so
   `JUPITER_SWAP_MAX_PRIORITY_FEE_LAMPORTS` stops being an independent number.

Step 1 was blocked at implementation time: `compute-budget-sufficiency.ts` had
+155/-25 uncommitted lines from a concurrently running workstream. Editing it
would have destroyed that work. The extraction is mechanical and safe once that
file is free.

Budget for the refusal string: `summarizeProtocolError` joins message and hint
and truncates the pair at **200 characters**, so the price, the effective limit,
the resulting lamports, the cap, and "nothing was signed" must all appear
early — see `evm-chains/gas-limit-headroom.ts` for the same constraint solved.

## Reproducing

```bash
pnpm run measure:solana-priority-fee
# optional: MEASURE_RPC_URL=<your rpc> pnpm run measure:solana-priority-fee
```

Source: `src/vex-agent/scripts/measure-solana-priority-fee-exposure.ts`.

READ-ONLY live calls only — Jupiter quote/build and
`getRecentPrioritizationFees`, all free. Never signs, never broadcasts, never
spends, holds no key material. Not part of the test suite; never run by
`pnpm test`.

Re-run it before choosing or changing the cap, and update the tables above with
the new numbers rather than editing the constant alone.
