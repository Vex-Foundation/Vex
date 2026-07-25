# Provider gas-limit ceiling — measurement

Evidence for `GAS_LIMIT_PROVIDER_CEILING_PERCENT = 400` and
`GAS_LIMIT_PROVIDER_CEILING_MIN_GAS = 3_000_000` in `./gas-limit-headroom.ts`. This file exists because a comment is not evidence:
the ceiling decides whether Vex signs or refuses a real bridge leg, so the
numbers behind it are checked in and reproducible. Same bar the Solana
compute-unit margin set in `agents_dm/parked/compute-budget-margin-measurement.md`
(parked 2026-07-25 when the gate it justified was removed by owner decision —
the bar it set for evidence stands, the gate does not).

Note the asymmetry with the 200% HEADROOM in the same module: that number is
still justified by a comment plus one on-chain forensic. Only the ceiling added
here carries a measurement file. Raising the headroom's bar is a separate
decision — do not treat this file as covering it.

## Why a ceiling was needed

`gasLimitForProviderHintedCall` signed `max(providerGas, ownEstimate x 2)`. The
floor was added on 2026-07-24 because a provider's number can be far too LOW
(KyberSwap quoted 356,167 for a call that measurably needed ~1,634,838). Fixing
that direction left the inverse unbounded: nothing capped how far a provider
could RAISE the limit Vex signs. Khalani is the only caller of the
provider-hinted variant, so this blocked every funded Khalani bridge.

## What was measured

- **Date:** 2026-07-25
- **Chain:** Base mainnet (`https://mainnet.base.org`)
- **Provider:** Khalani / Hyperstream (`https://api.hyperstream.dev`),
  `POST /v1/quotes` then `POST /v1/deposit/build` with
  `depositMethod: CONTRACT_CALL`
- **Routes:** Base -> Arbitrum, both a NATIVE-token pair and an ERC-20 pair. The
  native pair is measured directly because its deposit leg can be
  `eth_estimateGas`-ed with no allowance in place. The ERC-20 pair needs an
  `eth_estimateGas` state override on USDC's `allowed` mapping (storage slot 10)
  to price its deposit leg before the approval lands — without it every ERC-20
  row reverts `ERC20: transfer amount exceeds allowance` and the flat-constant
  route below stays invisible.
- **Subjects:** two public Base accounts holding native ETH, used READ-ONLY as
  estimation subjects. Nothing was signed and nothing was sent.
- **Sample:** 2 subjects x 2 amounts x every route the quote returned on the
  NATIVE pair (8 comparable legs), plus all three routes of the ERC-20 pair
  (Base USDC -> Arbitrum USDC) priced with an `eth_estimateGas` STATE OVERRIDE
  that grants the allowance, since an ERC-20 deposit leg cannot otherwise be
  estimated before its approval has landed. **11 legs, 9 with a provider figure.**
- **Cost:** zero. Quote, build and `eth_estimateGas` are all free.

## Results

| subject | amount | route | leg | provider gas | own `eth_estimateGas` | provider/own |
|---|---|---|---|---|---|---|
| coinbase-hot-4663 | 0.003 ETH | Hyperstream | deposit | 150,182 | 125,152 | 1.200x |
| coinbase-hot-4663 | 0.003 ETH | DeBridge | deposit | 146,049 | 146,049 | 1.000x |
| coinbase-hot-4663 | 0.03 ETH | Hyperstream | deposit | 150,166 | 125,139 | 1.200x |
| coinbase-hot-4663 | 0.03 ETH | DeBridge | deposit | 146,061 | 146,061 | 1.000x |
| base-fee-vault | 0.003 ETH | Hyperstream | deposit | 149,919 | 124,933 | 1.200x |
| base-fee-vault | 0.003 ETH | DeBridge | deposit | 145,390 | 145,390 | 1.000x |
| base-fee-vault | 0.03 ETH | Hyperstream | deposit | 149,919 | 124,933 | 1.200x |
| base-fee-vault | 0.03 ETH | DeBridge | deposit | 145,402 | 145,402 | 1.000x |
| coinbase-hot-4663 (ERC-20, allowance overridden) | 5 USDC | Hyperstream | deposit | **none** | 157,931 | — |
| coinbase-hot-4663 (ERC-20, allowance overridden) | 5 USDC | Across | deposit | **none** | 84,734 | — |
| coinbase-hot-4663 (ERC-20, allowance overridden) | 5 USDC | DeBridge | deposit | 640,000 | 184,057 | **3.477x** |

**Max provider/own ratio observed: 3.477x.**

Four findings, and the last one changed the shape of the rule:

- **Hyperstream applies a flat 20% buffer** on its native route — 1.200x to
  three decimals on all four rows, across two subjects and two amounts.
- **DeBridge's native route returns the node's own unbuffered estimate.**
  Exactly 1.000x, byte-identical to our `eth_estimateGas`. That is itself the
  reason a FLOOR must exist: signing that figure verbatim would be signing the
  bare estimate that burned four Base transactions on 2026-07-24.
- **Most routes supply no `gas` field at all.** Hyperstream's and Across's
  ERC-20 legs carry none, so the provider-hint path is dormant on the most
  common route and the ceiling is an outer bound on the rarer case.
- **DeBridge's ERC-20 leg quotes a FLAT CONSTANT: 640,000**, against a measured
  184,057 — **3.477x**. It does not vary with size. This is the finding that
  made a pure ratio unworkable; see the derivation.

## Derivation

The rule is deliberately TWO-PART — a ratio **and** an absolute exemption:

```
refuse when providerGas > ownEstimate x 4  AND  providerGas > 3,000,000
```

### Why a ratio alone does not work

A pure ratio is strictest exactly where the stakes are lowest, because it scales
with its denominator. Two measured facts break it:

1. **Providers quote flat constants.** DeBridge's ERC-20 leg asks for 640,000
   whatever the trade size. Its ratio to our estimate is therefore whatever the
   estimator happens to say that block — not a property of the provider at all.
2. **Our own estimate is the volatile half.** The same calldata moved **2.07x**
   across twelve consecutive Base blocks (804,028–1,660,619, the forensic
   already recorded in `gas-limit-headroom.ts`, caused by how many liquidity
   ticks a route crosses in a given block).

Combining them: the measured 3.477x becomes `640,000 / (184,057 / 2.07)` =
**~7.2x** whenever our estimate lands at the low end of its own swing. A 4x
ceiling would refuse a real, already-quoted DeBridge bridge on nothing but
estimator noise — a stranded autonomous mission, not a saved dollar. Widening
the ratio to cover 7.2x would instead make it decoration on large calls, where
the exposure actually matters.

### The two bounds, and why each number is what it is

**Relative: 400%.** Our own headroomed floor is already 2x the fresh estimate;
400% grants the provider exactly that much room again. Above that, the figure is
no longer extra headroom for the call we priced — it describes a different
transaction from the one we just measured against current chain state.

**Absolute exemption: 3,000,000 gas.** The harm being bounded is ABSOLUTE, so
the gate should not fire where the absolute exposure is immaterial. 3,000,000 is:

- **4.7x above the largest provider figure ever observed** on any Khalani route
  (640,000), so no measured route can reach it;
- **above the largest gas limit Vex has ever signed on any venue** (2,052,472 —
  the headroomed Base KyberSwap swap, whose call measurably needed ~1,634,838);
- small enough that a genuinely large over-ask still trips the ratio.

Checked against every measurement above, plus the constructed 7.2x case, the
combined rule admits all of them and refuses none.

### What this ceiling does NOT claim

It is not calibrated against a provider figure that legitimately exceeded BOTH
bounds, because **no such figure has ever been observed**. Every measured route
sits far below the 3,000,000 exemption, so on today's evidence the gate is
dormant on all of them — it is an outer bound against a provider that changes
behaviour, not a routine check. The ~7.2x worst honest ratio is CONSTRUCTED from
two measurements (a flat 640,000 quote and a 2.07x estimator swing), not observed
as one event.

If a real route is ever refused by this gate, that is new evidence: re-run the
probe, add the row, and revisit the numbers rather than raising them ad hoc. The
3,000,000 exemption in particular is the number most likely to need revisiting —
it is derived from the largest figures on record, and records only grow.

It also does not bound cost directly. The sender pays for gas USED, not the
limit; the gate bounds the exposure a call could burn and the
`value + gas * maxFeePerGas` balance needed to broadcast at all.

## Reproducing

```bash
pnpm run measure:khalani-gas-ratio
# optional overrides:
# KHALANI_API_URL=… BASE_RPC_URL=… pnpm run measure:khalani-gas-ratio
```

Source: `src/vex-agent/scripts/measure-khalani-provider-gas-ratio.ts`.

The script performs live READ-ONLY calls only — Khalani quote/build (free) and
`eth_estimateGas` (free). It never signs, never broadcasts, never spends, and
holds no key material. It is not part of the test suite and is never run by
`pnpm test`.

Re-run it before changing either constant, and update the table above with the
new numbers rather than editing a constant alone.
