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

## What the captures established (2026-07-25, 11 probes)

Across base / ethereum / arbitrum / polygon / bsc, 1–3 hops, 1–5 paths,
native-in and native-out, at 25 / 50 / 100 bps — every build:

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
