# Direct Uniswap swaps

`uniswap__swap_quote` and `uniswap__swap_execute` price and trade against Uniswap
V2 and V3 pools directly, without KyberSwap, and serve as the same-chain fallback
when KyberSwap is unavailable in the user's region or refuses at its edge. Use a
fresh Uniswap quote before execution, with matching parameters and the applicable
approval; a KyberSwap quote cannot authorize a Uniswap execute. Supported chains
come from [deployments.ts](./deployments.ts): Robinhood Chain (4663), Ethereum (1),
Base (8453), Arbitrum One (42161), Optimism (10), Polygon (137), and BNB Chain (56).
Vex's direct venue supports V2 and V3 only, with no Uniswap v4 support yet. A token
whose only liquidity is in v4 pools cannot be traded here; tell the user about
that gap instead of retrying a region-blocked KyberSwap request. This matters on
Robinhood Chain, where the owner's 2026-09-09 sample found 17 of 25 new pools on
v4; KyberSwap itself was measured routing v4 pools on both Robinhood Chain and
Base. Direct v4 support is a separate implementation arc.
