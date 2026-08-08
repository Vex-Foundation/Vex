# Lighter Module Map

**Last updated: 2026-08-08**

Lighter support starts as Core + Robinhood Chain read-only market data. This
module has no credentials, no auth tokens, no signing helpers, and no
state-changing order/deposit/withdrawal/transfer paths. The Vex agent protocol
surface consumes this module through read-only tools under the `lighter`
namespace.

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
| `getMarkets(environment, params)` | `GET /api/v1/orderBooks` | Optional `market_id`, `filter` |
| `getMarketDetails(environment, params)` | `GET /api/v1/orderBookDetails` | Required `market_id`; optional `filter` |
| `getOrderBookOrders(environment, params)` | `GET /api/v1/orderBookOrders` | Required `market_id`; `limit` 1-250 |
| `getRecentTrades(environment, params)` | `GET /api/v1/recentTrades` | Required `market_id`; `limit` 1-100 |
| `getCandles(environment, params)` | `GET /api/v1/candles` | Required market, resolution, epoch-ms timestamp range, bounded `count_back` |

## Agent Tools

Every tool requires `environment: "core" | "rhc"` and is registered as
`mutating: false`, `actionKind: "read"`.

| Tool | Client calls | Returns |
|------|--------------|---------|
| `lighter.system` | `getStatus`, `getSystemConfig` | Status, network id, public pool/config fields |
| `lighter.markets` | `getMarkets` | Bounded market rows with count/truncation disclosure |
| `lighter.market.get` | `getMarketDetails` | One-market detail rows for a numeric `marketId` |
| `lighter.orderbook` | `getOrderBookOrders` | Bounded asks/bids with provider totals and truncation flags |
| `lighter.recentTrades` | `getRecentTrades` | Bounded public trade tape rows plus cursor disclosure |
| `lighter.candles` | `getCandles` | Newest candle rows up to the agent output cap |

## Safety Notes

- Every call requires an explicit `environment`: `core` or `rhc`.
- The agent tools never infer an environment from chain, symbol, or conversation
  context; the selected environment is always echoed in the result.
- The module never reads environment variables, local secret vault entries, API
  keys, auth tokens, private keys, wallets, or signer state.
- Agent handlers call only the public read client. There is no renderer, preload,
  wallet, vault, approval, order, deposit, withdrawal, transfer, or signing path
  in the Lighter namespace.
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

## Verification

- Client foundation: `pnpm test src/__tests__/lighter/lighter-client.test.ts src/__tests__/lighter/lighter-throttle.test.ts`
- Agent discovery: `pnpm test src/__tests__/vex-agent/tools/lighter-discovery.test.ts`
- Agent handlers: `pnpm test src/__tests__/vex-agent/tools/lighter-handlers.test.ts`
- Protocol guardrails: manifest lint, embedding lint, registry completeness, and
  namespace list-mode tests.
