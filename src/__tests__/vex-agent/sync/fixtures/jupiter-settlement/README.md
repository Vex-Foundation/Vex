# Jupiter settlement fixtures - real Solana-mainnet `getTransaction` results

Three VERBATIM `getTransaction` RESULTS (the JSON-RPC envelope unwrapped, so a
fixture is exactly what `SolanaActivitySweepDeps.getFinalizedTransaction`
returns) for real Vex-signed Jupiter swaps on Solana mainnet, captured
**2026-08-12** with `encoding: "json"`, `commitment: "finalized"`,
`maxSupportedTransactionVersion: 0`.

They exist so the SPL balance-delta decoder
(`src/vex-agent/sync/solana-activity-repair/spl-balance-delta.ts` and
`.../executed-amounts.ts`) is proven against the balance layouts the chain
actually produced, not against hand-built ones that can only confirm the test
author's mental model (rules/90: a fixture must be a real provider response).

The signing wallet in all three is `AeyBYFtgm85BrsZMKrAWdc2qGQqYvwfkt88dZdfYEndS`
- a public mainnet address that already appears on every one of these
transactions on chain. No key material, provider credential or private datum is
present: these are the same public bytes any explorer serves.

| fixture | signature | route | what it pins |
| --- | --- | --- | --- |
| `swap-sol-to-usdc-3SC5Mi5L.json` | `3SC5Mi5L...` | native SOL -> USDC, `wrapAndUnwrapSol` | the wallet's wSOL ATA is created AND closed inside the transaction, so it appears in NEITHER `preTokenBalances` NOR `postTokenBalances`: the input leg has no SPL evidence and the swap falls back to a status-only confirm. The USDC output side is a fresh ATA (absent in pre, `1103883` in post). |
| `swap-usdc-to-sol-3ewjUYAG.json` | `3ewjUYAG...` | USDC -> native SOL | mirror case: the USDC input delta is unambiguous (`13383433` -> `10383433`), the native output leg has no wSOL entry at all, so no amounts are written. |
| `swap-jupusd-to-usdc-3g3NAiBJ.json` | `3g3NAiBJ...` | JupUSD -> USDC, multi-hop, 16 token balances | the only fully provable shape: both legs are ordinary SPL ATAs the wallet keeps open (`4840851` -> `256851` in, `19848523` -> `24421314` out) among 16 balance entries owned mostly by pools. |

## Reuse for lend and prediction rows

The lend/prediction decode path is exercised against these SAME bodies, with no
synthesized variant. Nothing about the decode is swap-specific: it is bounded by
the wallet OWNER and by the MINTS the row declares, so what makes a case
lend-shaped or prediction-shaped is the row (its `event_role`, `kind`, and
`token_in_address`/`token_out_address`), not the transaction. A prediction claim
that declares only an output mint reads `swap-jupusd-to-usdc-3g3NAiBJ.json` as a
single credited leg; a deposit that declares a mint the wallet never moved in it
reads the same body as no evidence at all. The two shapes real captures cannot
contain - two wallet-owned accounts moving one mint, and disagreeing decimals -
are built inline in `solana-executed-amounts.test.ts` in this exact entry shape.

The lamport arrays (`meta.preBalances` / `meta.postBalances`) are retained
deliberately, as the evidence for what the decoder must NOT do: the fee payer's
own lamport delta in `swap-sol-to-usdc-3SC5Mi5L.json` is -21,814,146 for a swap
whose input was a fraction of that, because it also carries the network fee
(`meta.fee` = 1,735,586), the Jupiter tip and two ATA rent deposits.
