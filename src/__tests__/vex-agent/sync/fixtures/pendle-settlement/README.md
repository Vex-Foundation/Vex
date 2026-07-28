# Pendle settlement fixtures — real Ethereum-mainnet Router receipts

Three VERBATIM `eth_getTransactionReceipt` results for real Pendle Router
(`0x888888888889758F76e7103c6CbF23ABbF58F946`) transactions on chain 1,
captured **2026-07-27**. They exist so the Pendle settlement decoder
(`src/vex-agent/sync/pendle-settlement-decoder.ts`) is proven against log
layouts the chain actually produced, not against hand-built logs that can only
ever confirm the test author's mental model (rules/90, "Verification
Discipline": a fixture must be non-empty and must be a real provider response).

| fixture | tx | selector | shape |
| --- | --- | --- | --- |
| `py-mint-reusd.json` | `0x286f172db9963e6084fcb0f9c1a23918314a0afaf23fe0badf85d6825157cd5c` | `0xd0f42385` `mintPyFromToken` | 1 in → **2 out** (PT + YT), 9 logs |
| `py-redeem-reusd.json` | `0x52b4c116005b5d3bdafec6b79b97de4e4e67f2c354ba1169c662af9ff5d2d18b` | `0x47f1de22` `redeemPyToToken` | **2 in** (PT + YT) → 1 out, 11 logs |
| `claim-interest-and-rewards-ynrwax.json` | `0xb1208bc66c01100673ed39e1ff430749208f5cfe3f72f1030aec44e8b2a64e8e` | `0x60fc8466` `multicall` wrapping the claim | **0 in → 2 credits**, 14 logs |

Coordinates behind them:

* mint/redeem — reUSD market, PT `0xecfafdc7741323a945a163ed068b5a3c43483957`,
  YT `0xa8bd3b21291ace53927b35563fc80615919e63d7`, token
  `0x5086bf358635b81d8c47c66d1c8b9e567db70c72`.
* claim — ynRWAx market, YT `0x2263fdec108939ae8fd0ab41901fa9755203b232`;
  credits are the underlying `0x01ba69727e2860b37bc1a2bd56999c1afb4c15d8`
  (`RedeemInterests`) and PENDLE `0x808507121b80c02388fad14726482e061b8da827`
  (`RedeemRewards`, topic `0x78d61a0c…`).

## Shape facts these receipts pin

* A `mintPyFromToken` credits PT and YT in **equal raw amounts**
  (`79998655357` each) while the input token moves at a completely different
  magnitude (`73304758069703379880585`, 18 decimals against the PY pair's 6).
  This is exactly the "raw amounts must travel with their decimals" hazard
  rules/90 names — a decoder that compared the legs numerically would be wrong.
* A `redeemPyToToken` burns PT and YT in equal raw amounts and pays ONE token,
  so the second leg is on the **input** side. Migration 053 constraint 7
  (exactly one populated second side) is a real shape, not a theory.
* The claim moves **nothing out of the wallet**. Its two credits arrive from
  different contracts, several logs apart, interleaved with SY plumbing
  transfers that the wallet is not a party to — the reason the decoder nets
  per-token wallet deltas instead of reading a positional log.
* The Pendle Router does NOT emit a single canonical "swap" event these can be
  read from: the mint's own summary event is `0x3193c546…` on the Router, the
  redeem's is `0x5f2e0499…`, and the claim has none at all. ERC-20 `Transfer`
  net-delta accounting is the only layout common to all three.

## Capture

```sh
# eth.drpc.org is a keyless archive endpoint; the bundled publicnode RPC in
# src/tools/pendle/chains.ts refuses archive `eth_getLogs` without a token,
# which is how these transactions were located in the first place.
curl -s -X POST -H 'content-type: application/json' https://eth.drpc.org \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["<tx hash from the table above>"]}' \
  | jq .result
```

## Sanitisation

ONE substitution per fixture: the third-party EOA that sent the transaction is
replaced, in **every** encoding it appears in (the receipt's `from`, and the
32-byte-padded `from`/`to` topics of every `Transfer` log), by the stable
synthetic `0xfa4efa4efa4efa4efa4efa4efa4efa4efa4efa4e` — the same placeholder
the Pendle read-surface fixtures use. Every other byte is the node's, untouched:
amounts, token addresses, topics, log order, `logIndex`, gas, block numbers.

Two honesty notes, so nobody mistakes this for anonymisation:

* `transactionHash` / `blockHash` are RETAINED, because the capture command
  above is worthless without them and the amounts would not be re-derivable.
  The substitution therefore keeps a stranger's address out of this repository;
  it does not make the transactions unattributable. They are public chain data
  about wallets Vex has never held keys for.
* `logsBloom` is retained verbatim and is therefore a bloom over the ORIGINAL
  addresses — it no longer matches the sanitised body. Nothing reads it; do not
  start.

The synthetic wallet and the decoded amounts are asserted as literals in
`../../pendle-settlement-receipts.test.ts`, so re-capturing from a different
transaction fails loudly instead of quietly re-baselining.
