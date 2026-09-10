# Swap quality measurements, 2026-09-09

Read-only captures from the configured RPCs and public DexScreener price reader.
No key was decrypted, no signature was produced, and no transaction was broadcast.

- `fee-drift.json`: five sequential head samples on each of 4663 and 8453,
  captured from 15:15:29 to 15:18:18 UTC. Wei per gas, hexadecimal block numbers
  and timestamps. Reproduce with
  `pnpm exec tsx src/vex-agent/scripts/measure-swap-fee-drift.ts`.
- `dex-base.json`, `dex-robinhood.json`: complete validated pair arrays from
  `readTokensPairs` for Base USDC and Robinhood VIRTUAL. The regression tests
  alter prices and token identities explicitly; the fixtures preserve actual
  provider field shapes and nullability.
- `latency-baseline.json`: Uniswap handlers using the supported older snapshot
  shape without a bound route hint, so execute repeats full route discovery.
- `latency-after.json`: all four venue/chain handlers using the accepted path
  refresh and the same pinned RPC transport for execution reads and preparation.

The latency harness uses live provider/RPC calls with a sequential queue and
250 ms pacing between HTTP requests. Its database and approval-row storage are
isolated in-memory test seams; the account signer always throws before creating
bytes. `signerReached: true` means the final guards passed and that disabled
signer was reached. `success: false` is the expected stop, not a mined failure.
The harness blocks every non-read JSON-RPC method and cannot stage a signature.
It tests native-input swaps of 0.0001 ETH at 1000 bps, Base to USDC and Robinhood
to VIRTUAL. It does not measure an allowance confirmation or human approval wait.

Reproduce sequentially, never alongside another live probe:

```sh
VEX_SWAP_QUALITY_LIVE=1 VEX_SWAP_QUALITY_ROUTE_BASELINE=1 pnpm exec vitest run --maxWorkers=3 src/__tests__/tools/evm-chains/swap-quality-live.test.ts
VEX_SWAP_QUALITY_LIVE=1 pnpm exec vitest run --maxWorkers=3 src/__tests__/tools/evm-chains/swap-quality-live.test.ts
```

Each handler expands to 12-29 HTTP reads in these captures. That exceeds a
literal handful of RPC methods, but each scenario ran once, serially and paced.
Quote/build endpoints received one request per necessary stage. Development
reruns corrected a harness export name and a route address checksum defect;
only the successful final measurements are archived here. The baseline ran
alongside fixture tests, so CPU load and provider/cache variation can affect
wall-clock comparisons; the removed route calls and phase timings are the
stronger evidence. The final after capture ran without fixture-test load.

`output-diagnostics.json` records read-only counterfactual-floor refusals and
subsequent output observations on both chains. The approved path is never
signed with the diagnostic floor. These were captured on September 9.

`latency-resume.json` records the September 10 verification pass with three
Vitest workers and no simultaneous verifier. All four paths reached the
explicitly disabled signer after real pre-sign reads; nothing was signed or
broadcast. The original before/after captures remain unchanged for comparison.
