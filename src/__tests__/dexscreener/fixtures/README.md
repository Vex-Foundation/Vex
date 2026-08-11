# DexScreener `/token-pairs/v1` captures

Live-captures discipline (`rules/90-vex-project.md`): a fixture encodes a shape
the provider actually sent, not one we imagined.

## `token-pairs-usdc-base.json`

Captured 2026-08-10 from
`GET https://api.dexscreener.com/token-pairs/v1/base/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
(USDC on Base). The provider returned 30 pools; 21 hold USDC on the BASE side
and 9 on the QUOTE side. Three are kept, deliberately mixed:

1. `aerodrome` AERO/USDC - USDC on the QUOTE side, deepest pool of the three.
   `priceUsd` 0.4168 is AERO's price, so USDC is `0.4168 / 0.4168 = 1`.
2. `uniswap` USDC/USDbC - USDC on the BASE side, `priceUsd` 0.9999 read directly.
3. `aerodrome` VELVET/USDC - USDC on the QUOTE side again.

Sanitisation: only the `info` blob (CDN image URLs, socials) was dropped and
replaced with `null`. Every price, liquidity, volume, txn and address field is
the provider's own value, unedited.

## `token-pairs-usdc-base-outlier.json`

The same three captured pools with ONE edited field, and it is edited on
purpose: pool 1's `priceUsd` is raised from `0.4168` to `4168.0`, which makes
its normalized USDC price 10,000x the median of the other two. That reproduces
the measured cross-pool mispricing incident (BONK, 2026-07-26: rank 1 by depth
priced 4,892x the median of the token's other 29 pools) on a base/quote MIXED
population, which no single live capture of a healthy token can provide.
Nothing else in the file is synthetic.
