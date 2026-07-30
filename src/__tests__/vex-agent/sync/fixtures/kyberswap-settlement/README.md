# KyberSwap settlement fixtures — a real Arbitrum MetaAggregationRouterV2 receipt

| fixture | shape |
| --- | --- |
| `native-in-eth-to-rain-arbitrum.json` | **native tokenIn** (0.0026 ETH, `tx.value = 2600000000000000`) → ERC-20 out (RAIN `0x25118290e6a5f4139381d072181157035864099d`, `373036464521201391922`), 10 logs, `status: 0x1` |

Captured 2026-07-30 from `https://arb1.arbitrum.io/rpc`
(`eth_getTransactionReceipt`), router
`0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` (`META_AGGREGATION_ROUTER_V2`).

## The shape fact this receipt pins

There is **no log the wallet is a party to on the input side**. The router
wraps the native input itself: the two WETH (`0x82af4944…`) `Transfer` logs move
between the router, the pool and the zero address — never from the wallet. The
only wallet-touching log in the whole receipt is the single RAIN credit.

So the executed native input can NEVER be decoded from these logs. It is a
certainty of the transaction itself (`tx.value`, KyberSwap being exact-input),
which is exactly what `agent_activity.amount_in_raw` already persists for a
native-in Kyber swap row — see `handlers/swap/execute-plan.ts`'s C21 note. This
receipt is the evidence for that seam
(`../../repair-native-in-real-decoders.test.ts`).

## Sanitisation — deliberately stricter than the Pendle fixtures

This transaction was signed by **Vex's own owner wallet**, not a stranger's, so
the Pendle folder's "retain the tx hash for re-derivability" trade is not
available here: a retained hash re-derives the very address the substitution
removes.

* the signing wallet is replaced, in EVERY encoding it appears in (padded
  `Transfer` topics AND the padded occurrences inside the routers' own event
  `data` words), by the same synthetic
  `0xfa4efa4efa4efa4efa4efa4efa4efa4efa4efa4e` the Pendle fixtures use;
* `transactionHash`, `blockHash`, `from`, `logsBloom`, gas and block fields are
  **not retained at all** — only `status` and the `logs` the decoder reads.

Everything kept is the node's own bytes: token addresses, topics, amounts, log
order. Re-capturing from a different transaction fails loudly, because the
amounts above are asserted as literals in the test.
