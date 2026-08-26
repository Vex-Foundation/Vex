# DexScreener pricing fixtures - live captures, not hand-written

Every file here is the VERBATIM response body of one live request to
`https://api.dexscreener.com`, captured 2026-08-26 for the quote-tier pricing
rule (`src/tools/dexscreener/best-liquidity-price.ts`). Rule 10: the live
endpoint is the specification, and a projection may only be tested against
bytes the provider actually sent.

| File | URL |
| --- | --- |
| `tokens-v1-solana-jup.json` | `/tokens/v1/solana/JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN` |
| `token-pairs-v1-solana-jup.json` | `/token-pairs/v1/solana/JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN` |
| `tokens-v1-solana-wsol.json` | `/tokens/v1/solana/So11111111111111111111111111111111111111112` |
| `tokens-v1-robinhood-vex.json` | `/tokens/v1/robinhood/0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b` |
| `token-pairs-v1-robinhood-vex.json` | `/token-pairs/v1/robinhood/0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b` |
| `tokens-v1-arbitrum-usdc.json` | `/tokens/v1/arbitrum/0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| `tokens-v1-base-weth.json` | `/tokens/v1/base/0x4200000000000000000000000000000000000006` |

Prices and liquidity in these files are a frozen moment and will not match the
live market again; the tests assert the RULE (which pool won, and why), never a
market number in isolation.

Public market data only. No wallet, no address of the owner's, no credential.
