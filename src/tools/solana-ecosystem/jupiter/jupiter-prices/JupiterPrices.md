# Jupiter Prices in `src/tools`

Local source-of-truth for Jupiter Price API V3 under `src/tools/solana-ecosystem/jupiter/jupiter-prices`.

## Verified From
- `https://dev.jup.ag/docs/llms.txt`
- `https://dev.jup.ag/guides/how-to-get-token-price.md`
- `https://dev.jup.ag/openapi-spec/price/v3/price.yaml`
- Verified on `2026-03-30`

## Covered Endpoints
- `GET /price/v3`

## Design Rules
- `client.ts` mirrors Jupiter HTTP exactly and returns the mint-keyed response body unchanged.
- `service.ts` preserves the full upstream payload and adds optional token-resolution helpers for internal Jupiter shelves.
- `types.ts` keeps the full documented per-mint price payload: `createdAt`, `liquidity`, `usdPrice`, `blockId`, `decimals`, `priceChange24h`.
- No `lite-api.jup.ag` fallback.
- All requests require `x-api-key`.

## Local Notes
- `ids` accepts up to 50 mint addresses per request.
- Tokens without a reliable price are omitted from the response. The local service represents that explicitly via `found: false` instead of inventing fallback values.
- Price API returns current USD prices only. Historical prices are out of scope for this shelf.
- Query-based helpers resolve symbols and names through `../jupiter-tokens/` before fetching prices.
- `getJupiterPricesForTokenQueries` is wired to the agent-facing `solana.prices` tool's `queries` param (`../../../../vex-agent/tools/protocols/solana-jupiter/handlers/core.ts`), alongside the raw `mints` param backed by `getJupiterPricesByMint`. Both branches diff the request against the response and report unpriced entries via an explicit `missing` list — Jupiter's `/price/v3` silently omits ids it cannot price rather than erroring, so the handler never lets that omission pass through unexplained.

## Related
- `../jupiter-tokens/` for metadata and token resolution
- `../jupiter-swaps/` for swap quotes and execution that may consume price data later

