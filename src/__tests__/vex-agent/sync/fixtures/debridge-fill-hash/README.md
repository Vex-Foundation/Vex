# deBridge (DLN) order fixtures — bridge fill-hash recovery

Real `GET https://stats-api.dln.trade/api/Orders/{orderId}` responses, captured
2026-07-26 while diagnosing Khalani orders that reach `status: "filled"` with
`transactions = {deposit}` only — no fill hash under any field. Both are
`state: "ClaimedUnlock"` fulfilments of live mainnet USDC bridges:

| fixture | source | direction | note |
| --- | --- | --- | --- |
| `dln-order-solana-destination.json` | execution 191 (logical row #81) | Base → Solana | `actualFulfillAmount` is legitimately `null`; fill hash is a base58 signature |
| `dln-order-evm-destination.json` | execution 229 (logical row #96) | Solana → Base | `actualFulfillAmount` present; fill hash is `0x`+64 hex |

Execution 216 (row #36) has the same shape as 191 and is covered by the same
code path; it is not duplicated here.

## Sanitisation

Shapes are byte-for-byte the provider's. Every **identity-bearing** node —
`orderId`, `makerSrc`, `receiverDst`, the `*AuthoritySrc` / `*BeneficiarySrc` /
`*Dst` address nodes, `taker`, `transactionHash`, `blockHash`, `initiator` — was
replaced in **all three encodings** (`stringValue`, `bytesValue`/`Base64Value`,
`bytesArrayValue`) with deterministic synthetic values of the same syntax class
and length, so no encoded copy of a real wallet, signature, or order id
survives. The same original value always maps to the same replacement, so
cross-field identity relationships in the capture are preserved.

Kept verbatim because they are financially meaningful and non-identifying:
`state`, give/take `chainId`, `tokenAddress`, `amount` / `finalAmount` /
`actualFulfillAmount`, token metadata, block numbers and timestamps, fee fields.

Regenerate from a fresh capture with
`agents_dm/verify/sanitize-dln-fixtures.mjs` (git-ignored; reads the raw dumps
in `agents_dm/verify/fixtures-bridge-hashless/`). The synthetic identities are
asserted as literals in
`../../bridge-activity-repair-debridge-lookup.test.ts` — regenerating from a
different capture is meant to fail loudly so a human re-checks the fixture.
