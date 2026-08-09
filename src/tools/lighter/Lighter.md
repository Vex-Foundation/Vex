# Lighter Module Map

**Last updated: 2026-08-09**

Lighter support starts as Core + Robinhood Chain read-only market data.
Milestone 4 adds the safety boundary for later read-only account visibility:
Vex may recognize read-only auth tokens and authenticated account-read endpoint
paths, but it still has no API private keys, signer client, order execution,
deposit, withdrawal, transfer, or other state-changing path. The Vex agent
protocol surface consumes this module through read-only tools under the
`lighter` namespace.

## Sources

- Core docs: https://apidocs.lighter.xyz/
- RHC docs: https://apidocs.rh.lighter.xyz/
- Core REST base: `https://mainnet.zklighter.elliot.ai`
- RHC REST base: `https://api.rh.lighter.xyz`
- Core WebSocket base: `wss://mainnet.zklighter.elliot.ai/stream`
- RHC WebSocket base: `wss://api.rh.lighter.xyz/stream`

## File Map

| File | Role |
|------|------|
| `constants.ts` | Public base URLs, endpoint paths, explicit environment names, limits |
| `types.ts` | TypeScript request and response shapes for Phase 1 market reads |
| `validation.ts` | Runtime validators for the public REST responses |
| `errors.ts` | Lighter HTTP/provider failures mapped to `LIGHTER_*` `VexError`s |
| `throttle.ts` | Per-process public REST throttle, small TTL cache, in-flight dedupe |
| `client.ts` | Read-only REST client and singleton |

Agent-facing files live under `src/vex-agent/tools/protocols/lighter/`:

| File | Role |
|------|------|
| `manifest.ts` | Aggregates the `lighter.*` protocol manifests |
| `manifests/read.ts` | Six read-only market-data tool schemas |
| `handlers.ts` | Aggregates handler maps for the namespace |
| `handlers/read.ts` | Calls the public client and projects bounded results |
| `params.ts` | Agent-layer param readers and stricter output caps |
| `projectors.ts` | Compact model-facing result projection |
| `../embeddings/lighter/market-data.ts` | Discovery passages and aliases |

## Phase 1 REST Surface

| Client method | Endpoint | Notes |
|---------------|----------|-------|
| `getStatus(environment)` | `GET /` | Public status |
| `getSystemConfig(environment)` | `GET /api/v1/systemConfig` | Public system config |
| `getAccount(environment, params)` | `GET /api/v1/account` | Public by index/L1 address; private auth boundary applies before account tools expose it |
| `getReadOnlyTokens(environment, params)` | `GET /api/v1/tokens` | Auth-gated read-only token inventory candidate |
| `getMarkets(environment, params)` | `GET /api/v1/orderBooks` | Optional `market_id`, `filter` |
| `getMarketDetails(environment, params)` | `GET /api/v1/orderBookDetails` | Required `market_id`; optional `filter` |
| `getOrderBookOrders(environment, params)` | `GET /api/v1/orderBookOrders` | Required `market_id`; `limit` 1-250 |
| `getRecentTrades(environment, params)` | `GET /api/v1/recentTrades` | Required `market_id`; `limit` 1-100 |
| `getAccountTrades(environment, params)` | `GET /api/v1/trades` | Auth-gated account trade history candidate |
| `getCandles(environment, params)` | `GET /api/v1/candles` | Required market, resolution, epoch-ms timestamp range, bounded `count_back` |

## Milestone 4 Auth Boundary

Milestone 4 is the read-only credential and request boundary, not account-tool
activation and not trading. It must use Lighter read-only auth tokens only:
`ro:{account_index}:{single|all}:{expiry_unix}:{random_hex}`. Normal Lighter
API keys can read and write, so API private keys and signer-client material are
explicitly excluded from this milestone.

Allowed:

- read-only token format validation;
- environment-scoped vault labels for read-only tokens;
- credential status metadata, such as configured capability and token expiry;
- authenticated REST request helpers that receive token material only through a
  privileged provider function;
- live probes of auth-gated account-read endpoints when real read-only tokens
  are present.

Not allowed:

- API private keys;
- signer-client initialization;
- auth-token generation from API private keys inside Vex;
- `sendTx`, order create, cancel, modify, deposit, withdrawal, transfer, or
  nonce handling;
- returning raw auth tokens to renderer, preload, agent output, logs, errors,
  test snapshots, docs, or telemetry.

## Agent Tools

Every tool requires `environment: "core" | "rhc"` and is registered as
`mutating: false`, `actionKind: "read"`.

| Tool | Client calls | Returns |
|------|--------------|---------|
| `lighter.system` | `getStatus`, `getSystemConfig` | Status, network id, public pool/config fields |
| `lighter.markets` | `getMarkets` | Deterministically ordered, paged market rows with count/truncation disclosure |
| `lighter.market.get` | `getMarketDetails` | One-market detail rows for a numeric `marketId` |
| `lighter.orderbook` | `getOrderBookOrders` | Bounded asks/bids sorted by best price with provider totals and truncation flags |
| `lighter.recentTrades` | `getRecentTrades` | Bounded public trade tape rows plus cursor disclosure |
| `lighter.candles` | `getCandles` | Newest candle rows up to the agent output cap |

Every successful agent response includes provenance:

| Field | Meaning |
|-------|---------|
| `source` | Always `live_lighter_public_api` for these tools |
| `provenance.provider` | `lighter` |
| `provenance.dataPlane` | `provider_public_rest`, not a mock, fixture, or local simulator |
| `provenance.environment` | Explicit `core` or `rhc` |
| `provenance.endpointPaths` | Public Lighter REST paths used for the read |
| `provenance.retrievedAt` | Time Vex produced the tool response |
| `provenance.cacheStatus` | `fresh_or_short_cache`; the bytes are from live provider reads and may be served from Vex's short in-process cache |
| `provenance.maxDataAgeMs` | Current maximum cache age for repeated identical reads |
| `provenance.independentOnchainVerification` | `false` until a later phase adds independent chain/RPC verification |

## Safety Notes

- Every call requires an explicit `environment`: `core` or `rhc`.
- The agent tools never infer an environment from chain, symbol, or conversation
  context; the selected environment is always echoed in the result.
- The module never reads environment variables, local secret vault entries, API
  keys, auth tokens, private keys, wallets, or signer state.
- Agent handlers call only the public read client. There is no renderer, preload,
  wallet, vault, approval, order, deposit, withdrawal, transfer, or signing path
  in the Lighter namespace.
- Market list projections sort active markets first, then by ascending
  `market_id`, before applying the agent page and limit. Broad lists return
  `page`, `lastPage`, `nextPage`, `sorting`, and a truncation note so the agent
  can walk the live provider list instead of depending on provider row order.
  A page past the live result set fails clearly with the last valid page number
  instead of returning an empty list that could be mistaken for no markets.
- Order book projections sort asks by ascending numeric price and bids by
  descending numeric price before applying the agent output limit. Vex does not
  rely on provider row order for top-of-book reasoning.
- Core order book rows can expose `order_index` values larger than JavaScript's
  safe integer range; Core and RHC recent-trade rows can do the same for order
  ids such as `trade_id`, `ask_id`, and `bid_id`. Phase 1 treats Lighter's
  `*_id_str` fields as canonical for recent trades: agent output exposes those
  digit-only strings as the primary ids, keeps unsafe numeric provider fields
  as `null`, and marks the numeric precision when JavaScript cannot represent
  the number exactly.
- Candle timestamps are JavaScript epoch milliseconds. Seconds-scale Unix
  timestamps are rejected before a provider request is sent.
- Candle ranges are bounded by Vex before the provider request. In Phase 1,
  broad ranges are rejected if they can exceed the requested `countBack` at the
  selected resolution. This is a Vex-owned safety and output-size policy, not a
  claim about Lighter's full candle query semantics.
- Agent candle output is capped independently of provider response validation;
  the response discloses provider row count and truncation instead of silently
  emitting a huge payload.
- Provider error bodies are redacted and length-bounded before they enter a
  `VexError`.
- Lighter public market data is live provider API data, not mock data. Do not
  describe it as independently on-chain verified unless a later verifier proves
  the same rows through a chain/RPC source.

## Verification

- Client foundation: `pnpm test src/__tests__/lighter/lighter-client.test.ts src/__tests__/lighter/lighter-throttle.test.ts`
- Auth boundary: `pnpm test src/__tests__/lighter/lighter-auth-token.test.ts src/__tests__/lighter/lighter-credentials.test.ts`
- Agent discovery: `pnpm test src/__tests__/vex-agent/tools/lighter-discovery.test.ts`
- Agent handlers: `pnpm test src/__tests__/vex-agent/tools/lighter-handlers.test.ts`
- Protocol guardrails: manifest lint, embedding lint, registry completeness, and
  namespace list-mode tests.
- Live market-data proof: `pnpm run test:lighter:live` runs the gated
  `VEX_LIGHTER_LIVE=1` smoke against real Core and RHC public APIs through
  `executeProtocolTool`, including provenance assertions on every Lighter tool
  response.
- Live read-only auth proof: `pnpm run test:lighter:live:auth` runs the gated
  `VEX_LIGHTER_AUTH_LIVE=1` smoke against real Core and RHC account endpoints.
  It requires `LIGHTER_CORE_READ_ONLY_AUTH_TOKEN` and
  `LIGHTER_RHC_READ_ONLY_AUTH_TOKEN` to be present through the encrypted local
  secret vault or process environment. If either real token is absent, expired,
  or malformed, the live auth proof fails rather than substituting fixtures,
  mocks, or simulated provider responses.

## Live Verification Notes

2026-08-09 local time (`2026-08-09T00:09Z`): `pnpm run test:lighter:live`
passed against real public Lighter infrastructure, including provenance
assertions on every successful Lighter tool response.

| Environment | Network id | Latest selected market | Reads proven |
|-------------|------------|------------------------|--------------|
| Core | 1 | `0` / `ETH` | system, markets, market detail, order book, recent trades, candles |
| RHC | 1 | `0` / `ETH` | system, markets, market detail, order book, recent trades, candles |

The live smoke selected active markets from `lighter.markets`, then reused the
selected `marketId` for detail, depth, recent trades, and 1-minute candles.
Both environments returned 10 ask rows, 10 bid rows, 10 recent trade rows, and
12 candle rows within the configured live smoke limits. The latest proof
selected ETH on both Core and RHC after market-list output was hardened to sort
before paging.
