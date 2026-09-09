# Uniswap direct venue

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

## V4 discovery limitation

Deployment coverage does not imply that every pool is discoverable. The production adapter uses DexScreener's `token-pairs/v1/{chain}/{token}` endpoint, filters Uniswap v4 pools for the requested pair and considers the deepest three. Every selected pool must pass a PositionManager PoolKey lookup and full keccak pool-ID check before quoting.

On 2026-09-09, the four new chains' supplied native/USDC samples quoted successfully on-chain, but token-pairs returned 30 entries with none of these samples, and direct pool lookup returned null. Thus the production handler selected existing V2/V3 routes for those pairs. A pool missing only from public search may be found by token-pairs; a pool missing from token-pairs and direct lookup needs provider indexing or an explicitly authorized additional discovery source. Fixed fallback seeds have not been added under the existing DexScreener-only rule.

[V4.md](V4.md) contains the binding and settlement invariants, chain verification evidence, live results and known limitations. The latest seven-chain deployment fixture and its test pin code lengths, poolManager identities, router domains, spender registration and native wrapping. No live execute was run for the four new chains.
