# `src/tools/morpho` - Morpho read client

Provider client for Morpho's keyless GraphQL API. Two lanes: MARKETS (filtered
Blue market discovery and one market's full state) and VAULTS (filtered
discovery across both vault generations, and one vault's full state with roles,
timelocks, allocations and gating). Read-only.

This module never imports `src/vex-agent/**`. The agent layer that consumes it
lives at `src/vex-agent/tools/protocols/morpho/`.

## Public API

| Export | From | Purpose |
| --- | --- | --- |
| `getMorphoClient()` | `client.ts` | Process-wide singleton, keyed on `services.morphoApiUrl` |
| `MorphoClient` | `client.ts` | `getMarketPage`, `getMarket`, `getMarketCuration`, `getVaultPage`, `getVault`, `getVaultCuration`, `getMarketPositionPage`, `getVaultPositionPage`, `getVaultV2Position`, `getVaultV2UserVaults`, `getActivityPage`, `getChains`, `describeBudget` |
| `runMorphoGraphqlRequest` | `client/transport.ts` | The one outbound path: budget/cache, POST, HTTP and GraphQL error mapping, then the validator |
| `MORPHO_CHAINS`, `resolveMorphoChainId`, `morphoChainSlug`, `describeUnsupportedChain` | `chains.ts` | Chain policy |
| `MORPHO_MARKET_SORTS`, `MORPHO_LOOKBACKS`, `requireMarketId`, `lltvPercentToWad` | `request.ts` | Market request contract |
| `MORPHO_VAULT_V1_SORTS`, `MORPHO_VAULT_V2_SORTS`, `vaultSortSupported`, `requireVaultAddress`, `feePercentToWad` | `request.ts` | Vault request contract |
| `MORPHO_MARKET_POSITION_SORTS`, `MORPHO_POSITION_SCOPES`, `requireUserAddress` | `request.ts` | Position request contract |
| `MORPHO_ACTIVITY_TYPES`, `MORPHO_ACTIVITY_SORTS`, `MORPHO_MAX_ACTIVITY_LIMIT`, `clampActivityLimit` | `request.ts` | Activity request contract |
| `MorphoBudget` | `budget.ts` | Request budget + circuit breaker (injectable for tests) |
| `mapMorphoHttpError`, `mapMorphoGraphqlError`, `sanitizeMorphoCause` | `errors.ts` | Error contract |
| `MorphoMarket`, `MorphoMarketDetail`, `MorphoMarketPage`, `MorphoVault`, `MorphoVaultDetail`, `MorphoVaultPage` | `types.ts` | Validated shapes |
| `MorphoMarketPosition`, `MorphoVaultPosition`, `MorphoVaultV2Coverage`, `MorphoMarketTransaction`, `MorphoSignedAmount` | `types.ts` (from `types-positions.ts`) | Position and activity shapes |

## Endpoint

One endpoint, `POST https://api.morpho.org/graphql`, configured as
`services.morphoApiUrl`. `queries.ts` holds the market lane
(`VexMorphoMarkets`, `VexMorphoMarket`, `VexMorphoMarketCuration`,
`VexMorphoChains`); `queries-vaults.ts` holds the vault lane
(`VexMorphoVaultsV1`, `VexMorphoVaultsV2`, `VexMorphoVaultV1`,
`VexMorphoVaultV2`, `VexMorphoVaultV1Curation`, `VexMorphoVaultV2Curation`);
`queries-positions.ts` and `queries-activity.ts` hold theirs.

Six vault documents rather than three because `Vault` and `VaultV2` are separate
GraphQL types with separate filter inputs and separate order-by enums; nothing
about them can be shared.

THE TWO CURATION DOCUMENTS ARE NOT LIKE THE OTHERS. They are the only reads a
SIGNING decision consumes, so they are tiny, served UNCACHED (`ttlMs: 0`), select
the subject's own identity beside the flag so the answer can be proved to be
about it, and read `listed` STRICTLY where every other document reads it as a
tolerant display field. See `client/curation.ts` and `client/vault-curation.ts`.

There is NO API key and therefore no `requiresEnv` on the tools. Gating a
keyless integration behind an env var would hide it from every user who never
needed one (the Relay precedent).

The `/v0` REST surface is deliberately unused. It reads single entities and
timeseries only, with no lists, no USD and no rewards, and everything batch 1
needs is in GraphQL.

## Chain policy

Vex reads Morpho on the INTERSECTION of Morpho's chains and Vex's own registries
(`kyberswap/chains.ts` plus `evm-chains/registry.ts`) - nine chains, listed in
`chains.ts` with the full derivation. Slugs match the KyberSwap registry exactly,
so a chain is spelled the same to a Morpho tool as to every other EVM tool.

Five chains Morpho serves are out of scope: World Chain, Stable, Tempo, Arc and
Katana. A caller naming one is refused BY NAME with that reason, because "Vex
does not read Katana" and "Morpho has no markets on Katana" are different
answers.

The table is explicit rather than computed at load: the intersection is a product
decision about where Vex operates, and it must not widen silently the day a swap
registry grows.

## Rate-limit policy

Morpho allows roughly 750 requests per minute, but answers sustained abuse with
`Retry-After: 604800` - a SEVEN-DAY block. Keyless means there is no per-user
quota to isolate that damage. `budget.ts` therefore layers three defences and is
wired from the first request, not added after an incident:

1. a token bucket at 60 req/min, well under the published ceiling;
2. a circuit breaker that OPENS on a ban-length `Retry-After` or on three
   consecutive 429s, after which nothing leaves the process at all;
3. a TTL cache plus in-flight dedupe: 5 seconds on market reads, matching
   Morpho's own upstream cache window, and 15 seconds on vault reads. The vault
   TTL is longer because a `version: both` screen is TWO requests and the V2 list
   document measured 317,750 complexity at 50 rows against a market list's
   23,750 - roughly thirteen times the server work per call.

The breaker's refusal is `MORPHO_BUDGET_EXHAUSTED` and carries no `httpStatus`,
so it is distinguishable from Morpho's own `MORPHO_RATE_LIMITED`.

There is ONE client instance per process. A second would double the request rate
against a single per-IP ceiling.

## Provider facts (live probe, 2026-08-14)

- `extensions.warnings[]` does not exist. The previous field generation is
  already REMOVED, not deprecated: `whitelisted`, `uniqueKey` and `priceUsd` are
  hard validation errors. `extensions` carries `complexity` and
  `maximumComplexity` only, both logged.
- The `BigInt` scalar arrives as a JSON number below 2^53 and a JSON string
  above it, in the same response. `requireBigIntString` accepts both and rejects
  a number past `MAX_SAFE_INTEGER` rather than laundering lost precision.
- APYs are fractions (0.0412 = 4.12%). `supplyApy` excludes rewards,
  `netSupplyApy` includes them, and a reward APR is a third basis in a different
  token.
- `MarketState` exposes NO field with arguments. Averaged APYs are fixed field
  names (`weeklyNetSupplyApy` and siblings), which is why `includeHistory` maps a
  `lookback` onto a field-name prefix locally instead of calling the REST
  timeseries. One request, one budget, one error contract.
- `publicAllocatorSharedLiquidity` returns one row per withdraw-market pair, so
  one vault appears many times. The validator sums per vault; reporting rows
  verbatim double-counts.
- The oracle price scale is `36 + loanDecimals - collateralDecimals`, verified
  numerically against the fixture rather than taken from documentation.
- `marketById` takes `chainId: Int!` - a market id is chain-scoped.
- Morpho Blue is permissionless. Unlisted markets in the capture show 297,995%
  net supply APY on 0.04 USD with `oracle_unusable` at RED.

### Vault lane (same probe)

- V1 (`Vault` / MetaMorpho) nests every number and role under `state`; V2
  (`VaultV2`) is FLAT. One document cannot cover both.
- A vault `netApy` is `apy` AFTER the vault fee. Steakhouse USDC: apy 0.041208,
  fee 0.25, netApy 0.030750. This is why a vault APY (net) and a market APY
  (gross) are different bases and must never be ranked against each other.
- `VaultFilters` has `search` and `assetSymbol_in`; `VaultV2sFilters` (note the
  `s`) has neither. `VaultOrderBy` has `Name`, `Fee` and `Curator`;
  `VaultV2OrderBy` has none of them. A predicate or sort one generation cannot
  serve is refused BY NAME at the agent boundary.
- V1 fee filters are Float FRACTIONS (`fee_lte: 0.05`); V2 fee filters are
  BigInt WAD (`performanceFee_gte: "150000000000000000"` returned 474 vaults
  whose smallest reported `performanceFee` was 0.15). The V2 fee OUTPUT is a
  plain fraction, so input and output scales differ on the same field name.
- V1 has one `state.timelock`. V2 has a per-function `timelocks[]` table with
  durations from 0 to 604,800 seconds on a single vault, some `abdicatedAt`.
- Only V2 has gating. `gatesConfig.{sendShares,receiveAssets}` guard the
  WITHDRAWAL direction and `{receiveShares,sendAssets}` guard the DEPOSIT
  direction; a non-null `address` means a contract can refuse that transfer.
  Live gated vaults exist on Base.
- `VaultV2CapData` is a UNION (`AdapterCapData | CollateralCapData |
  MarketV1CapData`). Only the last names a market, so only it is an allocation.
- A missing vault is HTTP 200 with `data: null` and
  `errors[{status: "NOT_FOUND"}]` - the same envelope as a removed field, which
  is why `client.ts` carries an explicit `notFound` hook per request.
- `VaultState` exposes no named averaging windows the way `MarketState` does:
  there is only `avgNetApy` / `avgNetApyExcludingRewards`, over a window Morpho
  does not name. `morpho.vault.get` therefore has NO `lookback` param, and the
  `VaultHistory` timeseries fields are deliberately unused.

### Position and activity lanes (same probe)

- A `MarketPosition` row exists for every market an address has EVER touched. A
  bare `userAddress_in` read of `0x...dEaD` returns 2,002 rows. A wallet's real
  footprint is the UNION of rows with collateral, with supply, or with debt, and
  GraphQL filters are ANDed, so that union is three reads rather than one
  predicate.
- `healthFactor` is `null` on every supply-only position: no debt, nothing to
  liquidate. That null is CORRECT and the row survives. A row WITH borrow shares
  and no health factor is dropped and counted instead.
- `margin`, `borrowPnl` and vault `pnl` are SIGNED `BigInt` scalars and arrive
  negative on a losing position (`margin: -23633633` live). The unsigned money
  reader refuses a negative by design, so `validation/positions.ts` carries
  `readSignedBigIntString` for exactly these fields.
- There is NO per-user list of V2 vault positions. `vaultPositions` resolves
  `vault` to the V1 `Vault` type, `VaultV2sFilters` has no user predicate, and
  `vaultV2PositionByAddress` needs one address AND one vault. The only honest
  composition is: scan `vaultV2transactions` for the wallet's vaults, then read
  each position, and REPORT the sweep's coverage.
- `MarketTransactionData` is a UNION of three members keyed by `__typename`.
  Which asset an amount is in depends on the member: a transfer moves the LOAN
  asset, a collateral transfer the COLLATERAL asset, and a liquidation both
  (`repaidAssets`/`badDebtAssets` loan, `seizedAssets` collateral). One live row
  carried `repaidAssets: 12004` at 6 decimals beside
  `seizedAssets: "38708708374333048"` at 18.
- No transaction row carries USD, and `market.loanAsset.price.usd` is TODAY's
  mark rather than the price at the block, so the activity lane emits no USD.
- `pageInfo.count` can be less than `limit` mid-list (first 3 requested, 2
  returned, 220 total). `hasMore` is derived from skip plus returned against
  `countTotal`, never from a page looking full.
- `VaultV2TransactionOrderBy` spells the time member `Time`, not `Timestamp`.
- `marketPositions` filters match an address case-insensitively; the responses
  return it checksum-cased.

## The on-chain half (batch 4)

Everything above is the keyless GraphQL API. `wallet-reads.ts`, `evm-client.ts`
and the address table in `constants.ts` are a SECOND transport: a direct
Multicall3 read over a keyless public RPC, used by `morpho.wallet.balance` to
report token balances and the allowances granted to Morpho's own contracts.

- **Addresses are pinned, dated and cross-checked.** `MORPHO_CONTRACTS` was
  extracted on 2026-08-14 from `@morpho-org/morpho-ts@2.9.0`
  (`lib/cjs/addresses.js`), and the Ethereum and Base values were cross-checked
  against the ones recorded independently in `morpho-integration.plan.md` before
  use. Vex does not depend on that package at runtime: a registry that changed
  under a transitive upgrade would move a security-relevant spender set with no
  review. Re-extraction is a deliberate, dated edit.
- **Permit2 is genuinely absent on Monad (143) and HyperEVM (999).** That is
  carried as `null` and refused BY NAME. Never fill it in with the canonical
  address: an allowance read against a contract that is not deployed answers
  zero, and "no Permit2 approval" for a contract nobody could have approved is a
  lie that reads as safety.
- **Multicall3 is live at the canonical address on all nine chains**, verified by
  `eth_getCode` on 2026-08-14 including Monad and HyperEVM, which the repository
  had never proven it on.
- **Two unlimited flags, not one.** `unlimited` is an EXACT match with
  `type(uint256).max`. `effectivelyUnlimited` is at or above 2^255 and also
  catches a max approval that has been partly drawn. A live Base wallet held
  exactly that case: an approval ending `911329639935` against a maximum ending
  `913129639935`, 1,800 USDC already taken, remainder still around 1e71. Exact
  matching alone reported it as bounded, which under-warns.

## Do-nots

- Do not import `src/vex-agent/**` from this module.
- Do not report a failed on-chain read as a zero balance or a zero allowance.
  `multicall({allowFailure: true})` answers per contract, so unknowns are kept in
  their own fields. An unknown approval rendered as zero reads as safety.
- Do not guess a contract address for a chain the pinned registry does not
  cover, and do not read an allowance for the native coin: it is moved as
  `msg.value` and is never pulled by a spender.
- Do not construct a second `MorphoClient`; use `getMorphoClient()`.
- Do not bypass the budget or shorten the breaker to make a call succeed.
- Do not parse a money value through `parseFloat` or `Number`. Amounts are
  decimal strings and BigInt.
- Do not return a raw amount without the decimals of the asset it is denominated
  in.
- Do not emit a base APY under a net name, or add a reward APR to a net APY.
- Do not rank a vault APY against a market APY: the first is net of the vault
  fee, the second is gross.
- Do not apply a V1-only vault predicate while V2 is in scope. Half a filtered
  result set presented as a whole one is worse than a refusal.
- Do not quote a USD figure from a market carrying an oracle warning.
- Do not widen the chain table because another registry grew; that is a product
  decision.
- Do not make a Morpho read a hard dependency of a money path. There is no SLA.
- Do not add a field to a query without re-running the live introspection in
  `queries.ts`'s header note; the schema removes fields on a live schedule.

## Fixtures and tests

Verbatim captures: `src/__tests__/vex-agent/tools/protocols/morpho/fixtures.ts`
(markets), `vault-fixtures.ts` (vaults) and `position-fixtures.ts` (positions and
activity), each with probe date, regeneration commands and shape facts inline. Raw probe artifacts: `agents_dm/morpho-probe/`.
Batch 4 adds `rewards-fixtures.ts` (the live Merkl bodies behind
`morpho.rewards.get`) and `wallet-balance.test.ts`, whose stub reads are the
verbatim live Base capture of 2026-08-14.
Provider-layer tests: `src/__tests__/morpho/` and `src/__tests__/merkl/`.
The reward distributor itself is a separate module: `src/tools/merkl/`
([Merkl.md](../merkl/Merkl.md)).
Agent-layer tests: `src/__tests__/vex-agent/tools/protocols/morpho/`.
