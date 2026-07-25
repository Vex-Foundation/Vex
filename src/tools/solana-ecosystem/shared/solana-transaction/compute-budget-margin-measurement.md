# Solana compute-unit safety margin — measurement

Evidence for `SOLANA_COMPUTE_UNIT_SAFETY_MARGIN_PERCENT = 110` in
`./compute-budget-sufficiency.ts`. This file exists because a comment is not
evidence: the margin decides whether Vex signs or refuses a real transaction, so
the numbers behind it are checked in and reproducible.

Contrast worth stating: `src/tools/evm-chains/gas-limit-headroom.ts` justifies
its 200% headroom in a comment only. We are deliberately setting a higher bar
here. Do **not** "fix" the EVM module to match — that is a separate decision.

## What was measured

- **Date:** 2026-07-25
- **Network:** Solana mainnet-beta, `https://api.mainnet-beta.solana.com`
- **Provider:** Jupiter `lite-api.jup.ag/swap/v1` `/quote` + `/swap`, with
  `dynamicComputeUnitLimit: true` (the setting that makes Jupiter bake a
  `SetComputeUnitLimit` into the response)
- **Taker:** `5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9` — a publicly
  documented Binance hot wallet, used READ-ONLY as a quote/simulation subject.
  No signature was produced for it and nothing was sent.
- **Sample:** 4 pairs x 3–4 fresh quotes x 5 simulations per quote =
  **13 quotes, 65 simulations**
- **Cost:** zero. `/quote`, `/swap` and `simulateTransaction` are all free.

Two questions the margin depends on:

- **Q1 DRIFT** — for the SAME transaction bytes, how far does `unitsConsumed`
  move across slots? This is the real gap between "we simulated it" and "it
  executes a slot or two later".
- **Q2 SLACK** — how much headroom does Jupiter itself leave between the limit
  it declares and the units its own transaction consumes? Refusing above this
  would reject healthy Jupiter transactions.

## Per-quote results

`drift = maxConsumed / minConsumed` over the 5 simulations of one quote.
`slack = declaredLimit / maxConsumed`.

| Pair | Quote | Declared limit | min consumed | max consumed | drift | slack | err |
|---|---|---|---|---|---|---|---|
| SOL→USDC 1 SOL | q0 | 88,353 | 72,128 | 72,297 | 1.0023x | 1.2221x | none |
| SOL→USDC 1 SOL | q1 | 39,926 | 32,941 | 32,949 | 1.0002x | 1.2118x | none |
| SOL→USDC 1 SOL | q2 | 76,160 | 61,837 | 62,282 | 1.0072x | 1.2228x | none |
| SOL→USDC 1 SOL | q3 | 39,918 | 32,941 | 33,428 | 1.0148x | 1.1941x | none |
| SOL→JUP 1 SOL | q0 | 173,546 | 140,052 | 140,092 | 1.0003x | 1.2388x | none |
| SOL→JUP 1 SOL | q1 | 182,795 | 147,522 | 151,958 | 1.0301x | 1.2029x | none |
| SOL→JUP 1 SOL | q2 | 182,571 | 147,518 | 151,817 | 1.0291x | 1.2026x | none |
| SOL→BONK 5 SOL | q0 | 53,722 | 43,536 | 44,307 | 1.0177x | 1.2125x | none |
| SOL→BONK 5 SOL | q1 | 54,686 | 44,307 | 44,307 | 1.0000x | 1.2343x | none |
| SOL→BONK 5 SOL | q2 | 54,686 | 44,307 | 44,307 | 1.0000x | 1.2343x | none |
| USDC→SOL 500 | q0 | 88,471 | 71,841 | 72,147 | 1.0043x | 1.2263x | none |
| USDC→SOL 500 | q1 | 96,573 | 77,787 | 82,888 | **1.0656x** | **1.1651x** | none |
| USDC→SOL 500 | q2 | 101,105 | 78,466 | 82,083 | 1.0461x | 1.2317x | none |

Cross-quote spread — how much the ROUTE itself moves between quotes for the
same pair and size, which is why a refusal is retry-with-a-fresh-quote rather
than terminal:

| Pair | min | max | ratio |
|---|---|---|---|
| SOL→USDC 1 SOL | 32,941 | 72,297 | 2.1947x |
| SOL→JUP 1 SOL | 140,052 | 151,958 | 1.0850x |
| SOL→BONK 5 SOL | 43,536 | 44,307 | 1.0177x |
| USDC→SOL 500 | 71,841 | 82,888 | 1.1538x |

## Derivation

- **Lower bound — worst same-bytes drift: 1.0656x** (USDC→SOL q1; median across
  the 13 quotes is ~1.005x). A margin below this can be defeated by ordinary
  slot-to-slot variation alone, so the gate would admit a transaction that then
  starves.
- **Upper bound — tightest Jupiter declared slack: 1.1651x** (USDC→SOL q1, the
  same quote). A margin above this refuses transactions Jupiter itself
  considers correctly provisioned.

**Admissible window: [1.066, 1.165].**

`1.10` sits inside it with room on both sides:

- 3.2% of protective headroom above the worst measured drift
- 5.9% below the tightest measured provider slack

### Why not EVM's 200%

Different lever. On EVM we CHOOSE the gas limit and the sender pays for gas
USED, so generosity is nearly free and a bigger multiplier only buys safety.
Here the limit is baked into provider bytes we cannot rewrite without
invalidating a signature; the margin is only a REFUSAL THRESHOLD. An
over-generous margin buys no headroom at all — it just refuses healthy trades.

### Scope: this measures the MARGIN, not the default-budget rule

Every transaction sampled here carried an explicit `SetComputeUnitLimit` from
Jupiter, so these numbers say nothing about the budget Solana grants a
transaction that declares none. That is a separate, source-derived rule
(SIMD-0170) implemented in `inferDefaultComputeUnitBudget` and pinned by its own
tests. Changing one does not invalidate the other.

### What this margin does NOT claim

Simulation is an admission gate, not a guarantee. It runs against a node's
current bank with the blockhash replaced on the node's copy, while execution
happens at a later slot against different account state. The margin is sized to
the drift we measured; it cannot cover an arbitrary change in account state
between simulation and execution.

## Reproducing

```bash
pnpm run measure:solana-cu-margin
# optional: MEASURE_RPC_URL=<your rpc> pnpm run measure:solana-cu-margin
```

Source: `src/vex-agent/scripts/measure-solana-compute-unit-margin.ts`.

The script performs live READ-ONLY calls only — Jupiter quote/build (free) and
`simulateTransaction` (free). It never signs, never broadcasts, never spends,
and holds no key material. It is not part of the test suite and is never run by
`pnpm test`; it takes several minutes because it deliberately sleeps between
simulations to let the slot advance.

Re-run it before changing the margin, and update the tables above with the new
numbers rather than editing the constant alone.
