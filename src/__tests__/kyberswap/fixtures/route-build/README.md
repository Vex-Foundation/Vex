# KyberSwap `/route/build` captures

Real, unedited responses from KyberSwap's aggregator API, used by
`../../kyberswap-swap-calldata-guard.test.ts` so the calldata decoder is proven
against bytes the provider actually produced — never a hand-rolled struct that
would merely re-assert the test's own assumptions.

## Regenerating

Each file records the exact `request` it was captured with. To refresh one:

```
GET  https://aggregator-api.kyberswap.com/<chain>/api/v1/routes?<request query fields>
POST https://aggregator-api.kyberswap.com/<chain>/api/v1/route/build
     { routeSummary, sender, recipient, slippageTolerance }
```

with header `x-client-id: Vex`. The fee query fields (`feeAmount=25`,
`isInBps=true`, `chargeFeeBy=currency_in`, `feeReceiver=<VEX_TREASURY_EVM>`)
must match `src/tools/kyberswap/constants.ts`, because the fixture is what pins
the fee line the guard asserts.

`sender`/`recipient` are the test's throwaway address, not a real wallet. No
transaction was ever signed or broadcast for these captures.

## The three captures

| File | Shape it pins |
|---|---|
| `base-usdc-to-native-50bps.json` | ERC-20 in, native out, single path |
| `base-native-to-usdc-50bps.json` | NATIVE in — the source-transfer list is empty and the input rides in `transactionValue` |
| `arbitrum-usdc-to-usdt-split-100bps.json` | a 6-path split — proves a split route still uses ONE source receiver |

The last two exist because the source-side binding branches on exactly those
two questions, and a guard that got either wrong would refuse honest swaps.

## What the captures established (2026-07-25, 21 probes)

Across base / ethereum / arbitrum / polygon / bsc, 1–3 hops, 1–19 paths,
native-in and native-out, at 25 / 50 / 100 / 200 / 300 bps — every build:

- decoded as `swap(SwapExecutionParams)`, selector `0xe21fd0e9`;
- carried `feeReceivers == [VEX_TREASURY_EVM]`, `feeAmounts == [25]`,
  `flags == 640` (`0x280` = `0x200 | _FEE_IN_BPS`), `approveTarget == 0x0`;
- returned `data.amountOut === routeSummary.amountOut - 1` (the build
  re-simulates the summary it is handed);
- derived `minReturnAmount === floor(data.amountOut * (10000 - slippageBps) /
  10000)` EXACTLY.

That last pair is why the floor comparison carries
`KYBER_BUILD_REDERIVATION_ALLOWANCE_RAW` (one output unit): a floor computed
from `routeSummary.amountOut` is deterministically one unit above the floor an
honest build embeds.

### The source-transfer list (`srcReceivers` / `srcAmounts`)

Measured in the same pass, because `swap()` executes this list verbatim as
`transferFrom(msg.sender, srcReceivers[i], srcAmounts[i])` and bounds only the
total. Every ERC-20-input build, at every path count up to 19:

- `srcReceivers == [callTarget]` — exactly one entry, the executor being called.
  A split route does NOT lengthen it; the split happens inside the executor.
- `srcAmounts == [amount - floor(amount * 25 / 10000)]`, the input net of the
  integrator fee.

Every NATIVE-input build left BOTH arrays empty.

The rounding direction is load-bearing and was measured, not assumed: at
`amountIn = 10000001` the provider embeds `9975001`
(`amount - floor(amount * 25 / 10000)`), whereas
`floor(amount * 9975 / 10000)` would give `9975000`. Probes at `10000399`,
`1000` and `100` agree. This matches the router's `_takeFee`, which floors the
FEE and assigns the remainder.
