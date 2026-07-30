# Uniswap settlement fixtures — a real Base SwapRouter02 receipt

| fixture | shape |
| --- | --- |
| `native-in-base-swaprouter02.json` | **native tokenIn** (`tx.value = 230000000000000`) → ERC-20 out (`0x55365c9e68e70122020184f4441b498e8bf06ac6`, `5806404302237278686`), 4 logs, `status: 0x1` |

Captured 2026-07-30 from `https://mainnet.base.org`
(`eth_getTransactionReceipt`), chain 8453, router
`0x2626664c2603336E57B271c5C0b26F421741e481` (`v3.swapRouter02`), WETH
`0x4200000000000000000000000000000000000006`.

## The shape fact this receipt pins

Unlike the KyberSwap sibling folder's native-in capture, this receipt DOES
evidence its native input leg: the router wraps the value itself and WETH emits
`Deposit(address indexed dst, uint256 wad)` with `dst` = the router and `wad`
exactly equal to `tx.value`. That is why the Uniswap decoder records
`token_in_address = NULL` for a native leg and reads the Deposit event bound to
the registered routers — and why Uniswap does NOT share KyberSwap's native-in
repair gap. `../../repair-native-in-real-decoders.test.ts` is the proof, taken
through the real registered decoder and the real finalizer.

## Sanitisation

ONE substitution: the third-party EOA that sent the transaction is replaced, in
every encoding it appears in, by the stable synthetic
`0xfa4efa4efa4efa4efa4efa4efa4efa4efa4efa4e` (the same placeholder the Pendle
fixtures use). `transactionHash` is retained so the capture is re-derivable;
as in the Pendle folder, that means the substitution keeps a stranger's address
out of this repository without making the transaction unattributable — it is
public chain data about a wallet Vex has never held keys for. Only `status`,
`transactionHash` and the `logs` the decoder reads are kept; every other
receipt field was dropped.
