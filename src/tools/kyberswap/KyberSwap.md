# KyberSwap Module Map — Multi-Chain EVM Aggregator Swaps

> **Last updated: 2026-07-22 (Agent Scan Phase 1 — limit orders, ZaaS/zap, and the phantom
> `src/commands/kyberswap/` CLI references removed; staged swap.execute documented)**
>
> **LLM maintainers:** If you modify any file in this folder, update this document to reflect the change — add/remove endpoints, update types, fix stale references.
>
> **Docs:** https://docs.kyberswap.com/

This document maps every `.ts` file in `src/tools/kyberswap/` to the data it provides for
token swaps, token discovery, and safety checks across 19 EVM chains and 400+ DEXs. The
agent-facing tools (`kyberswap.swap.quote` / `kyberswap.swap.execute`, plus `kyberswap.tokens.check`
and `kyberswap.chains.supported`) live in `src/vex-agent/tools/protocols/kyberswap/handlers/swap.ts`
and consume the clients documented here. There is no `src/commands/kyberswap/` CLI tree in
this repo — that directory does not exist; this doc previously described one, which was stale
drift flagged during the Agent Scan Phase 1 pass. KyberSwap is reached only through the
vex-agent tool surface.

---

## What KyberSwap Does

KyberSwap is multi-chain DeFi infrastructure. Vex uses only its swap surface:
- **Aggregator**: Best-rate token swaps across 400+ DEXs on 19 chains
- **Token API**: Token search, honeypot/fee-on-transfer safety checks

Limit orders and ZaaS (Zap as a Service — one-click concentrated-LP liquidity provisioning)
were part of KyberSwap's product but have been deleted from Vex's integration entirely
(Agent Scan Phase 1, plan §4.2): `kyberswap.limitOrder.*` (10 tools) and
`kyberswap.zap.*`/zap-dexes catalog are gone, along with `src/tools/kyberswap/limit-order/`
and `src/tools/kyberswap/zaas/`. Scroll (534352) and zkSync (324) were dropped from the chain
registry with them — both chains had `aggregator: false`; ZaaS was their only executable Vex
feature.

All EVM-only. No Solana support in KyberSwap.

---

## Base URLs & Auth

| Service | Base URL | Auth |
|---------|----------|------|
| Aggregator | `https://aggregator-api.kyberswap.com` | `X-Client-Id: Vex` |
| Token API | `https://token-api.kyberswap.com` | `X-Client-Id: Vex` |
| Common Service | `https://common-service.kyberswap.com` | None |

---

## File Map

### Core (`src/tools/kyberswap/`)

| File | Role |
|------|------|
| `types.ts` | Shared types: `KyberChainSlug`, `KyberChainId`, `KyberChainInfo`, `KyberChainFeatures` |
| `constants.ts` | URLs, Vex integrator fee (25bps, `KYBERSWAP_FEE_*`), native token address, spender allowlist (1 entry: MetaAggregationRouterV2), per-service timeouts |
| `chains.ts` | 19-chain static registry, single `aggregator` feature flag, alias/slug/ID resolution, dynamic chain cache |
| `errors.ts` | `mapKyberTransportError()` — remap generic HTTP/timeout transport errors to `KYBER_TIMEOUT`/`KYBER_API_ERROR` |
| `evm-utils.ts` | Barrel re-export over `evm/*` (below) |

### EVM primitives (`src/tools/kyberswap/evm/`)

| File | Role |
|------|------|
| `config.ts` | Per-chain viem clients (`getKyberEvmClients`/`getKyberPublicClient`), `ERC20_ABI`, `DEFAULT_RPC` |
| `erc20.ts` | `readErc20Metadata`, `validateKyberSpender`, `verifyRouterAddress`, `sendKyberTransactionWithReceipt` (generalized receipt-truth primitive — preserved, currently zero production callers) |
| `nft.ts` | `ensureErc721Approval`/`ensureErc1155ApprovalForAll` — dead code post-zap-deletion (preserved per the Agent Scan card, not yet removed) |
| `receipt-logs.ts` | `extractMintedNftId` — shared with the generic `chain_read` tool's `erc721_mint` action; do NOT delete even though its `zaas`-era sibling (`extractErc1155Position`) is gone |
| `allowance-plan.ts` | **NEW** (Agent Scan §11.1) — `planKyberAllowance()`: pure on-chain READ deciding needsReset/needsApprove (USDT-safe: a short allowance is topped up to exactly the required amount, never `maxUint256`); `buildApproveCalldata()` encodes the `approve(spender,amount)` call for the staged broadcast primitive below |
| `staged-broadcast.ts` | **NEW** — `signStageBroadcast()`: sign locally → compute the tx hash from the signed payload → `onHashStaged` hook (persist BEFORE broadcast) → `sendRawTransaction` → bounded receipt wait. Returns `{kind:"confirmed"\|"reverted"\|"ambiguous"}` — `ambiguous` covers both a send-time failure and a receipt-wait failure and is NEVER treated as a definitive failure |
| `swap-settlement.ts` | **NEW** — `decodeKyberSwapSettlement()`: pure receipt Transfer-delta decoder for executed in/out amounts. ERC-20 legs sum `Transfer` logs for that leg's contract; native tokenIn uses the signed tx's own declared value (Kyber is exact-input — a certainty, not a decode); native tokenOut decodes the chain's wrapped-native `Withdrawal` event (best-effort — declines rather than guesses if absent) |

### Aggregator (`src/tools/kyberswap/aggregator/`)

| File | Role |
|------|------|
| `client.ts` | `KyberAggregatorClient` — `getRoute()` + `buildRoute()`, singleton |
| `types.ts` | `SwapRouteParams`, `SwapRouteSummary`, `SwapRouteResponse`, `SwapBuildRequest`, `SwapBuildResponse` |
| `validation.ts` | Runtime validators for route and build responses |
| `errors.ts` | `mapAggregatorError()` — maps KyberSwap error codes (4001-4221) to typed errors |

### Token API (`src/tools/kyberswap/token-api/`)

| File | Role |
|------|------|
| `client.ts` | `KyberTokenApiClient` — `searchTokens()` + `getHoneypotFotInfo()`, singleton |
| `types.ts` | `KyberToken`, `KyberTokenSearchResponse`, `HoneypotFotInfo` |
| `validation.ts` | Runtime validators for token search and honeypot responses |

### Common Service (`src/tools/kyberswap/common/`)

| File | Role |
|------|------|
| `client.ts` | `KyberCommonClient` — `getSupportedChains()` with 1h cache, singleton |
| `validation.ts` | Runtime validator for supported chains response |

(`limit-order/` and `zaas/` [+ `zaas/zap-dexes/`] directories, and everything they backed, are
DELETED — Agent Scan Phase 1. There never was a `src/commands/kyberswap/` CLI tree consuming
these clients in the current repo.)

---

## Portfolio / Discovery Data Sources

### Token Discovery & Safety

| Source | Function | Returns | Useful for |
|--------|----------|---------|------------|
| `token-api/client.ts` | `searchTokens(chainIds, opts)` | Token list: address, symbol, name, decimals, marketCap, isWhitelisted, isVerified, isStable | Token resolution, portfolio display, autocomplete |
| `token-api/client.ts` | `getHoneypotFotInfo(chainId, address)` | `{ isHoneypot, isFOT, tax }` | Safety check before swap. `kyberswap.swap.quote` surfaces this per leg (informational, never aborts); `kyberswap.swap.execute` hard-aborts ONLY on a confirmed honeypot (FoT/high-tax is warn-only; a check that throws fails soft — proceeds) |
| `helpers.ts` | `resolveTokenMetadataStrict(input, chainId)` | `{ address, symbol, name, decimals, isNative }` | ERC-20/native metadata for both quote and execute — address-only (or the native sentinel/keyword); symbols are NEVER resolved via Kyber's DEX search here (a bare symbol can match the wrong contract), so callers must resolve a symbol with the agent's own `token_find` first |

### Transaction Sources

| Domain | Source | Function | Returns |
|--------|--------|----------|---------|
| Swap quote | `aggregator/client.ts` | `getRoute()` | Quote: amountIn/Out, amountInUsd/OutUsd, gas, gasUsd, route paths, exchanges |
| Swap build | `aggregator/client.ts` | `buildRoute()` | Built tx: amountIn/Out, amountInUsd/OutUsd, gas, gasUsd, encoded calldata, routerAddress |
| Swap execution (recorded) | `kyberswap.swap.execute` handler | staged sign→persist→broadcast→confirm | An `agent_activity` row per broadcast event (allowance_reset/allowance/swap), executed amounts from receipt decoding — see "Execution Flows" below |

### Market Data

| Source | Function | Data |
|--------|----------|------|
| `aggregator/client.ts` | `getRoute()` | Real-time swap pricing between any pair on any of 19 chains (amountInUsd, amountOutUsd) |
| `token-api/client.ts` | `searchTokens()` | Token marketCap, isStable flag |
| `common/client.ts` | `getSupportedChains()` | Live chain availability status (active/inactive/new) |

---

## Chain Support (19 chains, aggregator-only)

| Chain | ID | Slug |
|-------|-----|------|
| Ethereum | 1 | `ethereum` |
| BSC | 56 | `bsc` |
| Arbitrum | 42161 | `arbitrum` |
| Polygon | 137 | `polygon` |
| Optimism | 10 | `optimism` |
| Avalanche | 43114 | `avalanche` |
| Base | 8453 | `base` |
| Linea | 59144 | `linea` |
| Mantle | 5000 | `mantle` |
| Sonic | 146 | `sonic` |
| Berachain | 80094 | `berachain` |
| Ronin | 2020 | `ronin` |
| Unichain | 130 | `unichain` |
| HyperEVM | 999 | `hyperevm` |
| Plasma | 9745 | `plasma` |
| Monad | 143 | `monad` |
| MegaETH | 4326 | `megaeth` |
| Robinhood Chain | 4663 | `robinhood` |

Every listed chain has `aggregator: true` — `kyberswap.chains.supported` never advertises a
chain Vex cannot actually execute a swap on. Robinhood Chain is provisional per KyberSwap's own
docs ("initial observation period"); live aggregator + on-chain support verified 2026-07-13.
Scroll (534352) and zkSync (324) were REMOVED from this registry (Agent Scan Phase 1) — both
only ever had ZaaS/zap support in Vex, which is deleted.
Etherlink (42793) was REMOVED on 2026-08-17 (owner decision): a swap venue with zero bridge
reach, served by neither Khalani nor Relay, so funds could enter no route back out.

**Aliases**: `eth`→ethereum, `arb`→arbitrum, `poly`/`matic`→polygon, `op`→optimism,
`avax`→avalanche, `bera`→berachain. (`zk`/`era`→zksync removed with the chain.)

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

(Limit Order Maker (9 endpoints), Limit Order Taker (5 endpoints), and ZaaS (6 endpoints)
sections REMOVED — Agent Scan Phase 1, the clients that called them are deleted.)

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

### Token API

| Field | Format | Example | To display |
|-------|--------|---------|------------|
| `token.decimals` | **Integer** | `6` (USDC) | Use for amount conversion |
| `token.marketCap` | **Number** (USD) | `25000000000` | Display as `$25B` |
| `honeypot.tax` | **Percentage** (number) | `5` = 5% | Display as `5% tax` |

### Native Token Address (all chains)

```
0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE
```

Always 18 decimals for native tokens on any EVM chain.

---

## Contract Addresses (all chains, same address)

| Contract | Address | Used for |
|----------|---------|----------|
| MetaAggregationRouterV2 | `0x6131B5fae19EA4f9D964eAc0408E4408b66337b5` | Swap execution — the ONLY entry in the spender allowlist |
| InputScalingHelperV2 | `0x2f577A41BeC1BE1152AeEA12e73b7391d15f655D` | Route amount scaling (present in `constants.ts`; pre-existing, currently unreferenced elsewhere — not a live wiring point) |

(DSLOProtocol, LimitOrderProtocol, WETHUnwrapper, KSZapRouterPosition, KSZapValidatorV2,
KSZapRouterPermit — all limit-order/zap-only contracts — REMOVED with those integrations.)

**Spender allowlist** (security): before any `approve()`, the spender is validated against
`KYBER_KNOWN_SPENDERS` — MetaAggregationRouterV2 only.

---

## Error Handling

### Aggregator Error Codes

| Code | Error | Retryable | Notes |
|------|-------|-----------|-------|
| 4001, 4002 | `KYBER_MALFORMED_PARAMS` — bad request params | No | |
| 4005, 4007 | `KYBER_FEE_EXCEEDS_AMOUNT` — fee > swap amount | No | |
| 4008, 4010 | `KYBER_ROUTE_NOT_FOUND` — no route available | No | Reveal-eligible: an eligible Kyber failure (this code, or the chain not being Kyber-supported at all) flips a session-scoped reveal for the hidden `swap_quote_uniswap`/`swap_execute_uniswap` pair |
| 4009 | `KYBER_AMOUNT_TOO_LARGE` — amount exceeds limit | No | |
| 4011 | `KYBER_TOKEN_NOT_FOUND` — unknown token | No | Reveal-eligible ONLY after the caller's own token address/native validation + on-chain metadata resolution both already succeeded for both tokens |
| 4221 | `KYBER_WETH_NOT_CONFIGURED` — WETH not set up | No | NOT reveal-eligible (a config anomaly, not "route not found") |
| 429 | `KYBER_RATE_LIMITED` | Yes | |
| 5xx | `KYBER_API_ERROR` | Yes | |

### All KyberSwap Error Codes (from `src/errors.ts`)

```
KYBER_API_ERROR               KYBER_TIMEOUT
KYBER_RATE_LIMITED            KYBER_UNSUPPORTED_CHAIN
KYBER_ROUTE_NOT_FOUND         KYBER_TOKEN_NOT_FOUND
KYBER_BUILD_FAILED            KYBER_MALFORMED_PARAMS
KYBER_FEE_EXCEEDS_AMOUNT      KYBER_AMOUNT_TOO_LARGE
KYBER_WETH_NOT_CONFIGURED     KYBER_TOKEN_SEARCH_FAILED
KYBER_HONEYPOT_CHECK_FAILED
```

(The 13 `KYBER_LO_*`/`KYBER_ZAP_*` codes that used to sit alongside these were removed from
`src/errors.ts` with the limit-order/zap integrations — Agent Scan Phase 1.)

---

## Execution Flows

### `kyberswap.swap.quote` (read-only)

```
1. resolveChainSlug(input) → slug; requireFeature(slug, "aggregator")
2. resolveTokenMetadataStrict(tokenIn/Out, chainId) → { address, decimals, symbol }
3. parseUnits(humanAmount, decimals) → atomic amountIn
4. client.getRoute(slug, { tokenIn, tokenOut, amountIn, ...VEX_INTEGRATOR_FEE_ROUTE_PARAMS })
   → routeSummary + routerAddress            (in parallel: honeypot/FoT safety check per leg,
                                                informational only, never aborts the quote)
5. Returns a `summary` string FIRST (amounts, symbols, USD estimate, gas estimate, price
   impact) then the machine fields — one JSON object, still `JSON.parse`-able
```

### `kyberswap.swap.execute` (mutating, staged broadcast — Agent Scan §11.1)

```
1. Reject any dryRun:true call outright — a belt-and-suspenders guard alongside the
   mutation-matrix row's `previewSupport: false` (this tool never supports a preview
   broadcast; `dryRun` is not part of its param schema either)
2. resolveTokenMetadataStrict both legs; on failure record a hashless
   createAgentActivityPreBroadcastFailure row (no wallet/chain known yet beyond the request)
3. resolveSigningWallet (decrypts the key) — now every subsequent failure can be durably
   recorded with a real wallet_address
4. Honeypot gate: a CONFIRMED honeypot on either non-native leg hard-aborts (records a
   pre-broadcast failure + reveal-on-eligible-failure suffix); FoT/high-tax only warns
5. getRoute + verifyRouterAddress(routerAddress, META_AGGREGATION_ROUTER_V2)
6. ensureErc20Balance (non-native tokenIn)
7. planKyberAllowance (read-only) → decides whether an allowance_reset and/or allowance
   broadcast is needed before the swap
8. buildRoute + verifyRouterAddress again on the build response
9. Build the EVENTS PLAN (allowance_reset? / allowance? / swap, in that order) and call
   createAgentActivityIntent ONCE — atomic: one protocol_executions intent row + all planned
   agent_activity event rows, created BEFORE anything is signed
10. For each planned event, in order, via signStageBroadcast: sign locally → persist
    tx_hash/from/nonce (markActivityBroadcast) → broadcast → markBroadcastAccepted → wait for
    a bounded receipt
    - a REVERTED receipt fails that event (mined_revert) and stops — no further events attempted
    - an AMBIGUOUS outcome (send or receipt-wait failure) stops the WHOLE sequence untouched —
      the row stays pending for the repair sweep; this attempt is NEVER retried automatically
11. On a confirmed swap event: decodeKyberSwapSettlement() from the mined receipt →
    confirmActivityEvent with the REAL executed amounts (never the quoted estimate). If the
    decoder declines (native-tokenIn crash-window edge case, or an undecodable receipt), the
    row is returned as `confirmed_pending_amounts` and left for the repair sweep, which
    finalizes its STATUS only — the executed amounts stay unknown for that row
12. pinTrackedToken on the ACQUIRED (token-out) leg only, on a local chain, fail-soft
    (a rejected pin never fails the swap result)
13. Returns a `summary` string FIRST (amounts, symbols, tx hash, USD estimates) then the
    machine fields incl. `_executionId` and `_explorerRefs` (chain + tx hash, for the
    desktop app's explorer link — metadata-only, model-invisible)
```

`kyberswap.swap.execute` decodes its OWN mined receipt, at broadcast time, with the pure
decoder in `src/tools/kyberswap/evm/swap-settlement.ts`. It no longer registers that decoder
anywhere: the per-protocol settlement-decoder registry the sync-layer repair sweep used to
look decoders up in was removed on 2026-07-30 (owner decree).

The repair sweep (`src/vex-agent/sync/agent-activity-repair.ts`) is now STATUS-ONLY — it asks
the chain whether a pending row's tx hash succeeded or reverted and writes the status alone,
never re-broadcasting and never decoding. It exists precisely because the old decoder-gated
sweep could not finalize a receipt shape its decoder declined: a CAT→native-ETH swap on
Robinhood Chain (4663) was mined `success` on-chain and sat `pending` forever, because a
native-out leg arrives as a wrapped-native burn with no `Withdrawal` event to the router.

A row the sweep confirms keeps NULL `executed_*` columns, and Agent Scan renders its QUOTED
amounts explicitly labelled "estimated" rather than presenting a quote as a settlement.

---

## Security Features

- **Spender allowlist**: every `approve()` validates the spender against
  `KYBER_KNOWN_SPENDERS` (MetaAggregationRouterV2 only)
- **Router address verification**: the API-returned router address is checked against the
  hardcoded constant before ANY calldata built against it is signed (both at quote-route and
  at build time)
- **USDT-safe approval**: `planKyberAllowance` resets a non-zero-but-short allowance to 0
  before approving a new amount; never approves `maxUint256`
- **Honeypot detection**: `kyberswap.tokens.check` (agent tool) and the execute handler's own
  pre-swap gate both call `getHoneypotFotInfo` — a CONFIRMED honeypot hard-aborts the swap; a
  failed/unavailable check fails soft (proceeds, logged)
- **Staged broadcast durability**: every signed transaction's hash is persisted BEFORE it is
  sent to the network (`markActivityBroadcast`), so a crash between signing and broadcast
  leaves a discoverable, repairable `pending` row instead of a silently lost transaction
