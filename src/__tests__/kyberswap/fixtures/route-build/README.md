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

Where a capture records `includedSources`, that filter is how a specific route
shape is reproduced deterministically — the default router picks whichever venue
is cheapest at the time. Captures WITHOUT it are default-routed, i.e. exactly
what `kyberswap.swap.execute` requests.

`sender`/`recipient` are the test's throwaway address, not a real wallet. No
transaction was ever signed or broadcast for these captures.

## The captures

| File | Shape it pins |
|---|---|
| `base-usdc-to-native-50bps.json` | ERC-20 in, native out, single path |
| `base-native-to-usdc-50bps.json` | NATIVE in — the source-transfer list is empty and the input rides in `transactionValue` |
| `arbitrum-usdc-to-usdt-split-100bps.json` | a 6-path split routed through the executor |
| `robinhood-virtual-to-native-pool-receiver-50bps.json` | the input sent DIRECTLY to a route pool, not to the executor |
| `ethereum-usdc-to-weth-pool-split-50bps.json` | three pools each funded with their own hop's share |
| `ethereum-usdc-to-weth-executor-split-50bps.json` | 9 paths of real address pools, yet the build still uses the executor |
| `arbitrum-usdc-to-usdt-nonaddress-pools-50bps.json` | a route whose `pool` fields are NOT addresses |

They exist because the source-side binding branches on exactly these questions,
and a guard that got any of them wrong would refuse honest swaps.

The first three were captured 2026-07-25 06:28 with `routeSummary` trimmed to
`amountIn`/`amountOut`. Everything captured afterwards stores the summary
WHOLE, because `routeSummary.route` is now an input to the guard.

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

### CORRECTION, 2026-07-25 evening — the 21 probes were not the whole picture

The claim above is true of every build in that pass and **false in general**. It
was calibrated on routes the aggregator happened to serve through its executor;
a live 44.58 VIRTUAL → ETH swap on Robinhood 4663 was then refused pre-sign for
sending the input to `0xd95e…91D3`, which is the route's own UniswapV2 pair
(`token0`/`token1` are WETH/VIRTUAL, `getReserves()` returns the V2 triple,
`fee()` reverts).

A re-measurement of **278 builds** across ethereum / base / arbitrum / bsc /
robinhood, on the default source set and on filtered ones, found exactly two
ERC-20 shapes and no others:

| Shape | Count | `srcReceivers` | `srcAmounts` |
|---|---|---|---|
| executor | 159 / 228 | `[callTarget]` | `[net]` |
| route pools | 69 / 228 | first-hop pool of each path | that hop's own `swapAmount` |

Zero builds mixed the two, named a pool that was not a path's FIRST hop, or
named an address absent from both sets. The total was `amount - floor(amount *
25 / 10000)` in all 228.

The route form is the UniswapV2 optimistic-transfer pattern — a V2 pair swaps
against tokens it already holds, so transferring straight to the pair is the
protocol's shape and saves a hop. It is not chain-specific: SHIB→WETH and
PEPE→WETH on **Ethereum mainnet** produce it on the default source set, exactly
as 4663 does.

Two facts worth keeping, both from real responses:

- `route[].pool` is **not always an address**. `uniswap-v4` reports a 32-byte
  pool ID and PMM/RFQ legs report identifiers like `pmm_13_0x…_0x…`
  (see `arbitrum-usdc-to-usdt-nonaddress-pools-50bps.json`). Reading the split
  therefore fails as a unit, leaving the executor form the only accepted one.
- The route's first-hop `swapAmount`s sum to the input net of fee, so binding
  each pool to its own hop reproduces the total bound rather than relaxing it.

The rounding direction is load-bearing and was measured, not assumed: at
`amountIn = 10000001` the provider embeds `9975001`
(`amount - floor(amount * 25 / 10000)`), whereas
`floor(amount * 9975 / 10000)` would give `9975000`. Probes at `10000399`,
`1000` and `100` agree. This matches the router's `_takeFee`, which floors the
FEE and assigns the remainder.
