# KyberSwap Module Map — Multi-Chain EVM Swaps, Limit Orders & Liquidity

> **Last updated: 2026-04-03**
>
> **LLM maintainers:** If you modify any file in this folder, update this document to reflect the change — add/remove endpoints, update types, fix stale references.
>
> **Docs:** https://docs.kyberswap.com/

This document maps every `.ts` file in `src/tools/kyberswap/` and `src/commands/kyberswap/` to the data it provides for token swaps, limit orders, liquidity provisioning, token discovery, and portfolio tracking across 19 EVM chains and 400+ DEXs.

---

## What KyberSwap Does

KyberSwap is multi-chain DeFi infrastructure providing:
- **Aggregator**: Best-rate token swaps across 400+ DEXs on 18 chains
- **Limit Orders**: Gasless off-chain relay, on-chain settlement limit orders (EIP-712 signed)
- **ZaaS (Zap as a Service)**: One-click liquidity provisioning for concentrated LP positions
- **Token API**: Token search, honeypot/fee-on-transfer safety checks

All EVM-only. No Solana support in KyberSwap.

---

## Base URLs & Auth

| Service | Base URL | Auth |
|---------|----------|------|
| Aggregator | `https://aggregator-api.kyberswap.com` | `X-Client-Id: Vex` |
| Token API | `https://token-api.kyberswap.com` | `X-Client-Id: Vex` |
| Common Service | `https://common-service.kyberswap.com` | None |
| Limit Order | `https://limit-order.kyberswap.com` | None |
| ZaaS | `https://zap-api.kyberswap.com` | `X-Client-Id: Vex` (rate: 10 req/10s) |

---

## File Map

### Core (`src/tools/kyberswap/`)

| File | Role |
|------|------|
| `types.ts` | Shared types: `KyberChainSlug`, `KyberChainId`, `KyberChainInfo`, `KyberChainFeatures` |
| `constants.ts` | URLs, contract addresses, native token address, spender allowlist, per-service timeouts |
| `chains.ts` | 18-chain static registry with feature matrix, aliases, slug/ID resolution, dynamic chain cache |
| `errors.ts` | `mapKyberTransportError()` — remap HTTP/timeout to `KYBER_` error codes |
| `evm-utils.ts` | Multi-chain viem clients, ERC-20/721/1155 approval (USDT reset, NFT `isApprovedForAll`), spender validation, tx sending, NFT mint extraction (with contract filter), ERC-1155 position extraction |

### Aggregator (`src/tools/kyberswap/aggregator/`)

| File | Role |
|------|------|
| `client.ts` | `KyberAggregatorClient` — `getRoute()` + `buildRoute()`, singleton |
| `types.ts` | `SwapRouteParams`, `SwapRouteSummary`, `SwapRouteResponse`, `SwapBuildRequest`, `SwapBuildResponse` |
| `validation.ts` | Runtime validators for route and build responses |
| `errors.ts` | `mapAggregatorError()` — maps KyberSwap error codes (4001-4221) to typed errors |

### Limit Order (`src/tools/kyberswap/limit-order/`)

| File | Role |
|------|------|
| `client.ts` | `KyberLimitOrderClient` — maker flows: sign, create, query, cancel, contract-address |
| `taker-client.ts` | `KyberLimitOrderTakerClient` — taker flows: pairs, query, operator-sig, fill, batch-fill |
| `signing.ts` | EIP-712 signing via viem `signTypedData` (post-confirmation only) |
| `types.ts` | `LimitOrder`, `LimitOrderStatus`, EIP-712 types, cancel/fill requests, `TradingPair`, `ContractAddresses` |
| `validation.ts` | Runtime validators for all LO response shapes |
| `errors.ts` | `mapLimitOrderError()` — signature, allowance, 404, rate limit detection |

### Token API (`src/tools/kyberswap/token-api/`)

| File | Role |
|------|------|
| `client.ts` | `KyberTokenApiClient` — `searchTokens()` + `getHoneypotFotInfo()`, singleton |
| `types.ts` | `KyberToken`, `KyberTokenSearchResponse`, `HoneypotFotInfo` |
| `validation.ts` | Runtime validators for token search and honeypot responses |

### ZaaS (`src/tools/kyberswap/zaas/`)

| File | Role |
|------|------|
| `client.ts` | `KyberZaasClient` — zap in/out/migrate (route + build for each), singleton. Build uses `ZapBuildOutRequest`/`ZapBuildMigrateRequest` (with `burnNft?`) |
| `types.ts` | `ZapInRouteParams`, `ZapOutRouteParams`, `ZapMigrateRouteParams`, `ZapRouteResponse` (incl. `poolDetails`, `positionDetails`, `gas`), `ZapBuildOutRequest`, `ZapBuildMigrateRequest`, `ZapDetails`, `ZapAction` |
| `validation.ts` | Runtime validators for zap route and build responses (preserves `poolDetails`/`positionDetails`/`gas`/`gasUsd`) |
| `errors.ts` | `mapZaasError()` — 400/404/429/5xx mapping |
| `zap-dexes/types.ts` | 5-axis position model: `PositionRefKind`, `ApprovalStandard`, `ApprovalTargetKind`, `CaptureKind`, `PositionKeyStrategy`, `ZapDexEntry` |
| `zap-dexes/chains/*.ts` | Per-chain DEX catalogs with 5-axis tuples. Source of truth for approval routing, capture, and positionKey strategy |
| `zap-dexes/index.ts` | `getZapDexConfig(chain)`, `getSupportedZapChains()` — catalog lookup |

### Common Service (`src/tools/kyberswap/common/`)

| File | Role |
|------|------|
| `client.ts` | `KyberCommonClient` — `getSupportedChains()` with 1h cache, singleton |
| `validation.ts` | Runtime validator for supported chains response |

### Commands (`src/commands/kyberswap/`)

| File | Role |
|------|------|
| `index.ts` | Commander registration: `kyberswap` with 5 subcommands |
| `helpers.ts` | Chain/token resolution, token metadata lookup via Token API, USD/gas formatting |
| `chains.ts` | `kyberswap chains` — list 18 chains with feature availability |
| `tokens.ts` | `kyberswap tokens search` / `tokens check` — token search + honeypot/FOT safety |
| `swap.ts` | `kyberswap swap sell` / `swap quote` — aggregator swap + quote |
| `limit-order.ts` | Subcommand assembly for create/list/cancel/hard-cancel/fill |
| `limit-order-create.ts` | `kyberswap limit-order create` — gasless EIP-712 signed order |
| `limit-order-list.ts` | `kyberswap limit-order list` — query maker's orders |
| `limit-order-cancel.ts` | `kyberswap limit-order cancel` (gasless) + `hard-cancel` (on-chain) |
| `limit-order-fill.ts` | `kyberswap limit-order fill` — fill order as taker (on-chain) |
| `zap.ts` | Subcommand assembly for search/in/out/migrate |
| `zap-search.ts` | `kyberswap zap search` — find best pools via DexScreener |
| `zap-in.ts` | `kyberswap zap in` — add liquidity to concentrated LP |
| `zap-out.ts` | `kyberswap zap out` — remove liquidity from LP |
| `zap-migrate.ts` | `kyberswap zap migrate` — migrate LP between pools/DEXes |

---

## Portfolio Data Sources

### Token Discovery & Balances

| Source | Function | Returns | Useful for |
|--------|----------|---------|------------|
| `token-api/client.ts` | `searchTokens(chainIds, opts)` | Token list: address, symbol, name, decimals, marketCap, isWhitelisted, isVerified, isStable | Token resolution, portfolio display, autocomplete |
| `token-api/client.ts` | `getHoneypotFotInfo(chainId, address)` | `{ isHoneypot, isFOT, tax }` | Safety check before swap/trade. Red flag if honeypot=true |
| `helpers.ts` | `resolveTokenMetadata(input, chainId)` | `{ address, symbol, name, decimals, isNative }` | Converting human amounts to/from atomic for any token |

**Token resolution chain** (`helpers.ts`):
1. `"native"` / `"eth"` → sentinel `0xEeee...eEeE` with 18 decimals
2. Valid hex address → search Token API by address for metadata
3. Symbol string → search Token API by name, pick best match (whitelisted first)

### Open Positions (Locked Value)

| Domain | Source | Function | Data |
|--------|--------|----------|------|
| **Limit Orders** | `limit-order/client.ts` | `getOrders({ chainId, maker, status })` | Active/filled/cancelled orders: makingAmount, takingAmount, filledMakingAmount, filledTakingAmount, status, expiry |
| **Limit Orders** | `limit-order/client.ts` | `getActiveMakingAmount(chainId, makerAsset, maker)` | Total active making amount locked in open orders (for allowance checks) |
| **Limit Orders** | `limit-order/taker-client.ts` | `getTakerOrders({ chainId })` | Available orders to fill as taker |
| **Limit Orders** | `limit-order/taker-client.ts` | `getTradingPairs(chainId)` | Supported trading pairs per chain |

### Transaction History Sources

| Domain | Source | Function | Returns |
|--------|--------|----------|---------|
| **Swap** | `aggregator/client.ts` | `getRoute()` | Quote: amountIn/Out, amountInUsd/OutUsd, gas, gasUsd, route paths, exchanges |
| **Swap** | `aggregator/client.ts` | `buildRoute()` | Built tx: amountIn/Out, amountInUsd/OutUsd, gas, gasUsd, encoded calldata, routerAddress |
| **Swap execution** | `swap.ts` | `swap sell --yes` | txHash, chain, tokenIn/Out, amounts, USD values, router |
| **Limit Order** | `limit-order/client.ts` | `createOrder()` | orderId |
| **Limit Order** | `limit-order-cancel.ts` | `cancel --yes` | orderId, method (gasless) |
| **Limit Order** | `limit-order-cancel.ts` | `hard-cancel --yes` | orderId, txHash, method (hard-cancel) |
| **Limit Order** | `limit-order-fill.ts` | `fill --yes` | orderId, txHash |
| **Zap In** | `zap-in.ts` | `zap in --yes` | txHash, pool, DEX, tokenIn, amountIn |
| **Zap Out** | `zap-out.ts` | `zap out --yes` | txHash, position, tokenOut |
| **Zap Migrate** | `zap-migrate.ts` | `zap migrate --yes` | txHash, position, from/to pool |

### Market Data

| Source | Function | Data |
|--------|----------|------|
| `aggregator/client.ts` | `getRoute()` | Real-time swap pricing between any pair on any of 18 chains (amountInUsd, amountOutUsd) |
| `token-api/client.ts` | `searchTokens()` | Token marketCap, isStable flag |
| `zap-search.ts` → DexScreener | `zap search` | Pool liquidity (USD), 24h volume, price per pair |
| `common/client.ts` | `getSupportedChains()` | Live chain availability status (active/inactive/new) |

---

## Chain Support (20 chains)

| Chain | ID | Slug | Swap | LO | Zap |
|-------|-----|------|:----:|:--:|:---:|
| Ethereum | 1 | `ethereum` | Y | Y | Y |
| BSC | 56 | `bsc` | Y | Y | Y |
| Arbitrum | 42161 | `arbitrum` | Y | Y | Y |
| Polygon | 137 | `polygon` | Y | Y | Y |
| Optimism | 10 | `optimism` | Y | Y | Y |
| Avalanche | 43114 | `avalanche` | Y | Y | Y |
| Base | 8453 | `base` | Y | Y | Y |
| Linea | 59144 | `linea` | Y | Y | Y |
| Mantle | 5000 | `mantle` | Y | Y | - |
| Sonic | 146 | `sonic` | Y | Y | Y |
| Berachain | 80094 | `berachain` | Y | Y | Y |
| Ronin | 2020 | `ronin` | Y | Y | Y |
| Unichain | 130 | `unichain` | Y | Y | - |
| HyperEVM | 999 | `hyperevm` | Y | Y | - |
| Plasma | 9745 | `plasma` | Y | Y | - |
| Etherlink | 42793 | `etherlink` | Y | Y | - |
| Monad | 143 | `monad` | Y | Y | - |
| MegaETH | 4326 | `megaeth` | Y | Y | - |
| Scroll | 534352 | `scroll` | - | - | Y |
| zkSync | 324 | `zksync` | - | - | Y |

**Aliases**: `eth`→ethereum, `arb`→arbitrum, `poly`/`matic`→polygon, `op`→optimism, `avax`→avalanche, `bera`→berachain, `zk`/`era`→zksync

---

## API Endpoints (complete)

### Aggregator (2 endpoints)

| Function | Endpoint | Method |
|----------|----------|--------|
| `getRoute(chain, params)` | `/{chain}/api/v1/routes` | GET |
| `buildRoute(chain, body)` | `/{chain}/api/v1/route/build` | POST |

**Route params**: `tokenIn`, `tokenOut`, `amountIn`, `includedSources`, `excludedSources`, `excludeRFQSources`, `onlyScalableSources`, `onlyDirectPools`, `onlySinglePath`, `gasInclude`, `gasPrice`, `origin`, `feeAmount`, `chargeFeeBy`, `isInBps`, `feeReceiver`

**Build body**: `routeSummary`, `sender`, `recipient`, `slippageTolerance`, `deadline`, `origin`, `permit` (EIP-2612), `source`, `referral`, `enableGasEstimation`, `ignoreCappedSlippage`

### Token API (2 endpoints)

| Function | Endpoint | Method |
|----------|----------|--------|
| `searchTokens(chainIds, opts)` | `/api/v1/public/tokens` | GET |
| `getHoneypotFotInfo(chainId, addr)` | `/api/v1/public/tokens/honeypot-fot-info` | GET |

### Common Service (1 endpoint)

| Function | Endpoint | Method |
|----------|----------|--------|
| `getSupportedChains()` | `/api/v1/aggregator/supported-chains` | GET |

### Limit Order — Maker (9 endpoints)

| Function | Endpoint | Method |
|----------|----------|--------|
| `getContractAddresses()` | `/read-ks/api/v1/configs/contract-address` | GET |
| `getSignMessage(body)` | `/write/api/v1/orders/sign-message` | POST |
| `createOrder(body)` | `/write/api/v1/orders` | POST |
| `getOrders(params)` | `/read-ks/api/v1/orders` | GET |
| `getActiveMakingAmount(...)` | `/read-ks/api/v1/orders/active-making-amount` | GET |
| `getCancelSignMessage(body)` | `/write/api/v1/orders/cancel-sign` | POST |
| `cancelOrders(body)` | `/write/api/v1/orders/cancel` | POST |
| `encodeCancelBatch(ids)` | `/read-ks/api/v1/encode/cancel-batch-orders` | POST |
| `encodeIncreaseNonce(chainId)` | `/read-ks/api/v1/encode/increase-nonce` | POST |

### Limit Order — Taker (5 endpoints)

| Function | Endpoint | Method |
|----------|----------|--------|
| `getTradingPairs(chainId)` | `/read-partner/api/v1/orders/pairs` | GET |
| `getTakerOrders(params)` | `/read-partner/api/v1/orders` | GET |
| `getOperatorSignature(chainId, ids)` | `/read-partner/api/v1/orders/operator-signature` | GET |
| `encodeFillOrder(body)` | `/read-ks/api/v1/encode/fill-order-to` | POST |
| `encodeFillBatchOrders(body)` | `/read-ks/api/v1/encode/fill-batch-orders-to` | POST |

### ZaaS (6 endpoints)

| Function | Endpoint | Method |
|----------|----------|--------|
| `getZapInRoute(chain, params)` | `/{chain}/api/v1/in/route` | GET |
| `buildZapIn(chain, body)` | `/{chain}/api/v1/in/route/build` | POST |
| `getZapOutRoute(chain, params)` | `/{chain}/api/v1/out/route` | GET |
| `buildZapOut(chain, body)` | `/{chain}/api/v1/out/route/build` | POST |
| `getZapMigrateRoute(chain, params)` | `/{chain}/api/v1/migrate/route` | GET |
| `buildZapMigrate(chain, body)` | `/{chain}/api/v1/migrate/route/build` | POST |

---

## Value Formats

### Aggregator

| Field | Format | Example | To display |
|-------|--------|---------|------------|
| `routeSummary.amountIn` / `amountOut` | **Atomic** (string) | `"1000000"` = 1 USDC | `formatUnits(BigInt(amount), decimals)` |
| `routeSummary.amountInUsd` / `amountOutUsd` | **USD string** | `"100.50"` | Parse to number, display as `$100.50` |
| `routeSummary.gas` | **Gas units** (string) | `"150000"` | Display as-is or with gasUsd |
| `routeSummary.gasUsd` | **USD string** | `"0.45"` | Display as gas cost |
| `slippageTolerance` (build param) | **Basis points** (number) | `50` = 0.5% | Divide by 100 for % |

### Limit Orders

| Field | Format | Example | To display |
|-------|--------|---------|------------|
| `makingAmount` / `takingAmount` | **Atomic** (string) | `"1000000"` | Divide by `10^token.decimals` |
| `filledMakingAmount` / `filledTakingAmount` | **Atomic** (string) | `"500000"` | Divide by respective decimals |
| `expiredAt` | **Unix timestamp** (seconds) | `1706123456` | `new Date(expiredAt * 1000)` |

### Token API

| Field | Format | Example | To display |
|-------|--------|---------|------------|
| `token.decimals` | **Integer** | `6` (USDC) | Use for amount conversion |
| `token.marketCap` | **Number** (USD) | `25000000000` | Display as `$25B` |
| `honeypot.tax` | **Percentage** (number) | `5` = 5% | Display as `5% tax` |

### ZaaS

| Field | Format | Example | To display |
|-------|--------|---------|------------|
| `zapDetails.initialAmountUsd` | **USD string** | `"1000.00"` | Input value |
| `zapDetails.finalAmountUsd` | **USD string** | `"998.50"` | Output value after fees |
| `zapDetails.priceImpact` | **Float** | `0.0015` = 0.15% | Multiply by 100 for % |
| `buildResponse.data.value` | **Wei** (string) | `"0"` or `"1000000000000000000"` | Native token value for tx |

### Native Token Address (all chains)

```
0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE
```

Always 18 decimals for native tokens on any EVM chain.

---

## Contract Addresses (all chains, same address)

| Contract | Address | Used for |
|----------|---------|----------|
| MetaAggregationRouterV2 | `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` | Swap execution |
| InputScalingHelperV2 | `0x2f577A41BeC1BE1152AeEA12e73b7391d15f655D` | Route amount scaling |
| DSLOProtocol | `0xcab2FA2eeab7065B45CBcF6E3936dDE2506b4f6C` | Limit orders (all 18 chains) |
| LimitOrderProtocol | `0x227B0c196eA8db17A665EA6824D972A64202E936` | Legacy LO (ETH, BSC, ARB, POLY, OP, AVAX only) |
| WETHUnwrapper | `0x37334Cd06DFEcd2e9b3937a6dA17853d637A5b94` | WETH unwrapping for LO |
| KSZapRouterPosition | `0x0e97c887b61ccd952a53578b04763e7134429e05` | Zap execution |
| KSZapValidatorV2 | `0xa16f32442209c6b978431818aa535bcc9ad2863e` | Zap validation |
| KSZapRouterPermit | `0x638d935eEcD1646991A8b2CE9C2A2B7B840CCaBb` | Zap with permit (not Linea/Sonic/Ronin) |

**Spender allowlist** (security): Before any `approve()`, the spender is validated against: MetaAggregationRouterV2, DSLOProtocol, KSZapRouterPosition, KSZapRouterPermit.

---

## Error Handling

### Aggregator Error Codes

| Code | Error | Retryable |
|------|-------|-----------|
| 4001, 4002 | `KYBER_MALFORMED_PARAMS` — bad request params | No |
| 4005, 4007 | `KYBER_FEE_EXCEEDS_AMOUNT` — fee > swap amount | No |
| 4008, 4010 | `KYBER_ROUTE_NOT_FOUND` — no route available | No |
| 4009 | `KYBER_AMOUNT_TOO_LARGE` — amount exceeds limit | No |
| 4011 | `KYBER_TOKEN_NOT_FOUND` — unknown token | No |
| 4221 | `KYBER_WETH_NOT_CONFIGURED` — WETH not set up | No |
| 429 | `KYBER_RATE_LIMITED` | Yes |
| 5xx | `KYBER_API_ERROR` | Yes |

### Limit Order Error Detection

| Pattern | Error | Retryable |
|---------|-------|-----------|
| HTTP 404 | `KYBER_LO_ORDER_NOT_FOUND` | No |
| 400 + "signature" | `KYBER_LO_SIGNATURE_INVALID` | No |
| 400 + "allowance"/"balance" | `KYBER_LO_INSUFFICIENT_ALLOWANCE` | No |
| 400 (other) | `KYBER_MALFORMED_PARAMS` | No |
| 429 | `KYBER_RATE_LIMITED` | Yes |
| 5xx | `KYBER_API_ERROR` | Yes |

### ZaaS Error Mapping

| HTTP | Error | Retryable |
|------|-------|-----------|
| 400 | `KYBER_MALFORMED_PARAMS` | No |
| 404 | `KYBER_ZAP_ROUTE_NOT_FOUND` | No |
| 429 | `KYBER_RATE_LIMITED` | Yes |
| 5xx | `KYBER_API_ERROR` | Yes |

### All KyberSwap Error Codes (from `errors.ts`)

```
KYBER_API_ERROR               KYBER_TIMEOUT
KYBER_RATE_LIMITED            KYBER_UNSUPPORTED_CHAIN
KYBER_ROUTE_NOT_FOUND         KYBER_TOKEN_NOT_FOUND
KYBER_BUILD_FAILED            KYBER_MALFORMED_PARAMS
KYBER_FEE_EXCEEDS_AMOUNT      KYBER_AMOUNT_TOO_LARGE
KYBER_WETH_NOT_CONFIGURED     KYBER_TOKEN_SEARCH_FAILED
KYBER_HONEYPOT_CHECK_FAILED   KYBER_LO_SIGN_FAILED
KYBER_LO_CREATE_FAILED        KYBER_LO_CANCEL_FAILED
KYBER_LO_FILL_FAILED          KYBER_LO_ORDER_NOT_FOUND
KYBER_LO_INSUFFICIENT_ALLOWANCE  KYBER_LO_SIGNATURE_INVALID
KYBER_ZAP_ROUTE_NOT_FOUND     KYBER_ZAP_BUILD_FAILED
KYBER_ZAP_UNSUPPORTED_DEX     KYBER_ZAP_INVALID_POSITION
```

---

## Execution Flows

### Swap Sell (Aggregator)

```
1. resolveChain(input) → slug
2. requireFeature(slug, "aggregator")
3. resolveTokenMetadata(tokenIn/Out) → { address, decimals, symbol }
4. parseUnits(humanAmount, decimals) → atomic amountIn
5. client.getRoute(slug, { tokenIn, tokenOut, amountIn }) → routeSummary + routerAddress
6. verifyRouterAddress(routerAddress, META_AGGREGATION_ROUTER_V2)
7. ensureKyberAllowance(token, router, amount) — USDT-safe reset
8. client.buildRoute(slug, { routeSummary, sender, recipient, slippageTolerance, permit? })
9. sendKyberTransaction({ to: routerAddress, data, value })
```

### Limit Order Create

```
1. resolveChain(input) → slug
2. requireFeature(slug, "limitOrder")
3. resolveTokenMetadata(makerAsset/takerAsset) → address + decimals
4. parseUnits(amount, token.decimals) → atomic amounts
5. client.getSignMessage({ chainId, makerAsset, takerAsset, maker, amounts, expiredAt })
   → unsigned EIP-712 message with salt
6. [--yes check]
7. signEip712Message(privateKey, eip712) → signature
8. client.createOrder({ ...params, salt, signature }) → orderId
```

### Limit Order Cancel (Gasless)

```
1. client.getCancelSignMessage({ chainId, maker, orderIds }) → unsigned EIP-712
2. signEip712Message(privateKey, eip712) → signature
3. client.cancelOrders({ ...eip712, signature })
   → Operator signature lapses within ~5 minutes
```

### Limit Order Cancel (Hard / On-Chain)

```
1. client.encodeCancelBatch([orderId]) → { encodedData }
2. sendKyberTransaction({ to: DSLO_PROTOCOL, data: encodedData })
```

### Limit Order Fill (Taker)

```
1. takerClient.getOperatorSignature(chainId, [orderId]) → operatorSignatures
2. takerClient.encodeFillOrder({ orderId, takingAmount, thresholdAmount, target, operatorSignature })
   → { encodedData, routerAddress }
3. sendKyberTransaction({ to: routerAddress ?? DSLO_PROTOCOL, data: encodedData })
```

### Zap In (Liquidity Add)

```
1. resolveChain + requireFeature("zaas")
2. resolveTokenAddress(tokenIn)
3. zaasClient.getZapInRoute(slug, { dex, pool.id, tokensIn, amountsIn, slippage, ... })
   → { route, routerAddress, zapDetails }
4. verifyRouterAddress(routerAddress, KS_ZAP_ROUTER_POSITION)
5. ensureKyberAllowance(tokenIn, routerAddress, amount)
6. zaasClient.buildZapIn(slug, { sender, recipient, route })
   → { callData, routerAddress, value }
7. sendKyberTransaction({ to, data: callData, value })
```

### Zap Out / Migrate — same pattern as Zap In with respective route/build endpoints.

---

## CLI Commands

```
kyberswap chains

kyberswap tokens search <query> --chain <chain> [--whitelisted] [--limit <n>]
kyberswap tokens check <address> --chain <chain>

kyberswap swap sell <tokenIn> <tokenOut>
  --chain <chain> --amount-in <amount>
  [--slippage-bps <bps>] [--recipient <addr>] [--permit <hex>]
  [--approve-exact] [--dry-run] [--yes]

kyberswap swap quote <tokenIn> <tokenOut>
  --chain <chain> --amount-in <amount>

kyberswap limit-order create
  --chain <chain> --maker-asset <token> --taker-asset <token>
  --making-amount <amount> --taking-amount <amount> --expires <duration>
  [--dry-run] [--yes]

kyberswap limit-order list --chain <chain> [--status <status>]

kyberswap limit-order cancel <orderId> --chain <chain> --yes
kyberswap limit-order hard-cancel <orderId> --chain <chain> --yes
kyberswap limit-order fill <orderId>
  --chain <chain> --taking-amount <amount> --threshold <amount>
  [--dry-run] [--yes]

kyberswap zap search <token> --chain <chain> [--limit <n>]
kyberswap zap in
  --chain <chain> --dex <dex> --pool <addr> --token-in <token> --amount-in <amount>
  [--tick-lower <n>] [--tick-upper <n>] [--position <id>]
  [--slippage-bps <bps>] [--approve-exact] [--dry-run] [--yes]

kyberswap zap out
  --chain <chain> --dex <dex> --pool <addr> --position <id> --token-out <token>
  [--liquidity <amount>] [--slippage-bps <bps>] [--dry-run] [--yes]

kyberswap zap migrate
  --chain <chain> --dex-from <dex> --dex-to <dex>
  --pool-from <addr> --pool-to <addr> --position <id>
  [--tick-lower <n>] [--tick-upper <n>] [--liquidity <amount>]
  [--slippage-bps <bps>] [--dry-run] [--yes]
```

**Headless mode** (`VEX_HEADLESS=1`): All commands output structured JSON via `writeJsonSuccess()`.
**`--dry-run`**: Preview without executing (no wallet needed for quote-only commands).
**`--yes`**: Required for any on-chain transaction or order creation.

---

## Security Features

- **Spender allowlist**: Every `approve()` validates the spender against known KyberSwap contracts
- **Router address verification**: API-returned router address checked against hardcoded constants before tx
- **USDT-safe approval**: Resets allowance to 0 before new approval if current > 0 and < required
- **EIP-712 post-confirmation**: Private key signing only after `--yes` flag confirmed
- **Honeypot detection**: `tokens check` command warns about honeypot/fee-on-transfer tokens

---

## UI/UX Dashboard Recipe

```
1. WALLET HOLDINGS
   (Not from KyberSwap — use chain-specific balance providers)
   KyberSwap Token API provides metadata (symbol, decimals, marketCap)
   for displaying token info alongside balances from other sources.

2. OPEN POSITIONS
   limit-order list --chain <chain>  → active limit orders with fill progress
   getActiveMakingAmount()           → total locked in open orders

3. SWAP / TRADE
   swap quote <in> <out> --chain <chain> --amount-in <amount>
     → real-time price, route, gas estimate
   swap sell  <in> <out> --chain <chain> --amount-in <amount> --yes
     → execute swap

4. LIMIT ORDERS
   limit-order create ... --yes      → place order
   limit-order list --chain <chain>  → view orders
   limit-order cancel <id> --yes     → gasless cancel
   limit-order fill <id> --yes       → fill as taker

5. LIQUIDITY
   zap search <token> --chain <chain>  → find pools
   zap in ... --yes                     → add liquidity
   zap out ... --yes                    → remove liquidity
   zap migrate ... --yes                → move between pools

6. SAFETY
   tokens check <address> --chain <chain>  → honeypot/FOT check
   tokens search <query> --chain <chain>   → verify token legitimacy
```

---

## Limit Order Fee Schedule

Fees charged by KyberSwap per token volatility category:

| Category | Fee |
|----------|-----|
| Super Stable (USDC/USDT/DAI pairs) | 0.01% |
| Stable (stablecoin ↔ stablecoin) | 0.02% |
| Normal (major tokens) | 0.1% |
| Exotic (low-cap tokens) | 0.3% |
| High Volatility | 0.5% |
| Super High Volatility | 1.0% |

---

## ZaaS Fee Schedule

Fees charged by protocol per pair type:

| Pair Type | Fee |
|-----------|-----|
| Stable | 0.01% |
| Correlated | 0.025% |
| Common | 0.1% |
| Exotic | 0.25% |

Partner fees configurable via `feeAddress` + `feePcm` parameters.
