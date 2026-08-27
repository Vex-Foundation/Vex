# Per-chain quote-policy captures - live, verbatim, never hand-written

Each `{slug}.json` is the VERBATIM response body of
`https://api.dexscreener.com/tokens/v1/{slug}/{wrappedNative}`, captured
2026-08-26. Each `{slug}-stable-pools.json` is the body of
`https://api.dexscreener.com/token-pairs/v1/{slug}/{stable}` for the four
chains whose stablecoin never appears as a sane BASE token and had to be
confirmed from the quote side.

`evm-chain-quote-policy.test.ts` re-derives every address in the policy table
from these files, so an address that never appeared in a provider response
cannot survive in the table. Rule 10 section 3: every field a projection reads
must be present in a committed capture.

Requests were sequential, at most two per chain, with a pause between them.
The archive with URL and timestamp per file lives outside the repo under
`scratchpad/board-v4-probes/quote-policy-{slug}.provenance.json`.

Prices and liquidity here are a frozen moment and will not match the live
market again; the tests assert the RULE and the address identities, never a
market number in isolation.

Public market data only. No wallet, no owner address, no credential.

Two Khalani EVM chains have NO capture and NO table row, deliberately: 16661
(0G) and 5734951 (Jovay) are absent from DexScreener's own chain catalog and
answered an empty array. See the module doc comment.
