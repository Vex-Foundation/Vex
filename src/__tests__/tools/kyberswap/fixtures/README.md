# Base native-settlement receipt fixtures: provenance

`base-native-settlement-receipts.json` holds two REAL Base (chain 8453)
transaction receipts, captured on **2026-07-25** by live
`eth_getTransactionReceipt` calls against `https://mainnet.base.org`:

| key | tx hash | what it is |
| --- | --- | --- |
| `kyber_usdc_to_native_eth_base` | `0x70d262092f63618a37f1c5ce61f0092f78b9fdece49c5f22416c32a915c3ed65` | KyberSwap USDC to native ETH |
| `uniswap_native_eth_to_usdc_base` | `0x8ca61ccf606c55b21608bf2e29b9e2b902ae0d51aeb608a931ae9dab283bb09c` | Uniswap SwapRouter02 native ETH to USDC |

Sanitisation: none was applied, and none is possible without destroying the
evidence. Every field is chain-public data that anyone can re-fetch from those
two hashes: block numbers, contract addresses, gas, and raw ERC-20 event logs.
The owner's wallet (`0x33ef…d2fa`) appears as each receipt's `from` and inside
the `Transfer` topics. It is load-bearing, because the decoder correlates the
wallet's own net delta against `Swapped.dstReceiver`, and both tx hashes were
already committed in the sibling tests before this file moved into the
repository, so the address was already derivable from the tree.

**Every amount, address, topic and log index is byte-exact.** They are the
evidence under test and must never be rounded, reordered, or replaced with an
empty collection.

What it pins:

- `kyber_withdrawal_src` is the Kyber **executor** `0x8f10…f996`, **not** the
  router, which is precisely why the old router-bound rule made
  `decodeKyberSwapSettlement` return `null` for a perfectly good receipt.
- `kyber_wallet_usdc_debit_raw` is `4000000` = `3990000` (`Swapped.spentAmount`)
  + `10000` (`Fee.totalFee`). This is the fixture's own proof that
  `spentAmount` must NEVER be used as `executedAmountIn`: doing so under-reports
  what the user actually paid by exactly the Vex fee.
- `uniswap_weth_deposit_dst` is SwapRouter02 `0x2626…e481`, which IS in the
  registered router set, and is why that receipt decoded while the Kyber one did
  not.

The file's `_notes` object carries the same capture metadata inline and is not
consumed by the decoder under test.

Read by:

- `src/__tests__/tools/kyberswap/native-out-correlated-decode.test.ts`
- `src/__tests__/vex-agent/sync/executed-amount-fallback.test.ts`

It previously lived at `agents_dm/verify/fixture-base-native-settlement-receipts.json`.
`agents_dm/` is git-ignored, so CI checkouts had no such file and both tests
died with `ENOENT`. The fixture belongs in the repository next to the tests that
depend on it.
