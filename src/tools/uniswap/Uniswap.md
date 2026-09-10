# Uniswap direct venue

KyberSwap is the usual first choice. On Robinhood Chain, quote both venues when
both price the pair and prefer direct Uniswap when it has a route. KyberSwap's
index drops quiet pools there and its USD reference can lag. Direct Uniswap
covers V2, V3 and v4 on verified deployments; other DEX liquidity can be absent.
Each execution requires that venue's matching approved quote.

The same tool pair, `uniswap__swap_quote` and `uniswap__swap_execute`, covers all seven verified chains below. V2 uses Router02, V3 uses SwapRouter02, and v4 uses UniversalRouter 2.1.1 plus transaction-based Permit2 allowances. Execution remains exact input and approval-bound. V4 routes are single hop; versions are not mixed in one call.

| Chain | ID | Registered versions | Native asset | Wrapped native |
| --- | --- | --- | --- | --- |
| Ethereum | 1 | V2, V3, V4 | ETH | 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 |
| Base | 8453 | V2, V3, V4 | ETH | 0x4200000000000000000000000000000000000006 |
| Robinhood Chain | 4663 | V2, V3, V4 | ETH | 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 |
| Arbitrum One | 42161 | V2, V3, V4 | ETH | 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1 |
| OP Mainnet | 10 | V2, V3, V4 | ETH | 0x4200000000000000000000000000000000000006 |
| Polygon PoS | 137 | V2, V3, V4 | POL | 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270 |
| BNB Smart Chain | 56 | V2, V3, V4 | BNB | 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c |

The authoritative addresses and their verification comments live in [deployments.ts](deployments.ts). Native inputs use the `native` keyword, including POL and BNB. ERC-20 inputs use contract addresses. The encoder gets the wrapper from the deployment table; `WRAP_ETH` and `UNWRAP_WETH` are protocol command names on all chains. The viem client uses the shared native-currency registry for the correct symbol, name and decimals.

Quotes compare eligible V2/V3/v4 candidates. A known wallet enables V2 gas estimation; missing gas or conversion data produces an explicit gross-output ranking label. The approved minimum remains the output floor. Fees follow the existing fixed Vex policy and separate post-success transfer.


## Regional fallback

Use the direct Uniswap venue as the same-chain fallback when KyberSwap is
unavailable in the user's region or refuses at its edge. A fresh Uniswap quote
with matching parameters and the applicable approval is required; a KyberSwap
quote cannot authorize Uniswap execution. The direct venue prices V2, V3 and v4
pools on its seven verified chains. A token can still have no usable route when
its liquidity sits on another DEX or outside the supported discovery paths.
Explain that limitation instead of retrying region-blocked KyberSwap unchanged.
This also covers v4 liquidity on Robinhood Chain and Base, which KyberSwap was
measured routing on 2026-09-09; v4 is now part of the direct venue too.

## V4 discovery limitation

Deployment coverage does not imply that every pool is discoverable. For the requested pair, the venue probes hookless PoolKeys at fee/tick-spacing pairs 100/1, 500/10, 3000/60 and 10000/200. Native currency is address zero. StateView must show a nonzero initialized price, and the existing PositionManager key/hash binding must pass before a candidate is quoted.

DexScreener's token-pairs endpoint supplies additional pools, including hooked pools. Its deepest three matching pools are considered alongside the four canonical probes, deduplicated by pool ID. Hooked pools remain DexScreener-discovered only. Unindexed hooked pools and nonstandard hookless keys outside those four combinations can still be missed. A DexScreener failure does not prevent the canonical on-chain probes.

[V4.md](V4.md) contains the binding and settlement invariants, chain verification evidence, live results and known limitations. The latest seven-chain deployment fixture and its test pin code lengths, poolManager identities, router domains, spender registration and native wrapping. The coordinator executed v4 swaps on Polygon, BNB Chain, Optimism and Arbitrum on 2026-09-10; V4.md records their hashes and separate fee outcomes.

## Native settlement evidence

V4 native input can be recorded as `native_balance_delta_bound`: the wallet's isolated-block balance decrease after subtracting this transaction's gas and OP-stack L1 fee. It is a lower bound because unrelated internal credits in the same block may reduce it. The quote's Vex fee is a ceiling; the final native fee uses at most the lesser of the requested input and this bound, at the disclosed bps. Missing required evidence withholds that fee. Hookless event proof remains available and is cross-checked when balance evidence is available.

For hooked native output, the swap status can be confirmed with proven ERC-20 input while the received native amount stays unknown. The output column is NULL with `native_output_unproven_hooked`; the pool's Swap amount is an estimate only. The existing ERC-20 input fee may still be collected. Historical amount repair does not collect, retry or modify fee rows. History views label lower bounds explicitly and do not round them upward.
