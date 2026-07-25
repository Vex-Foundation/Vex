# Jupiter Tokens in `src/tools`

Local source-of-truth for Jupiter Tokens API V2 under `src/tools/solana-ecosystem/jupiter/jupiter-tokens`.

## Verified From
- `https://dev.jup.ag/docs/llms.txt`
- `https://dev.jup.ag/docs/tokens/index.md`
- `https://dev.jup.ag/docs/tokens/token-information.md`
- `https://dev.jup.ag/guides/how-to-get-token-information.md`
- `https://dev.jup.ag/openapi-spec/tokens/v2/tokens.yaml`
- Verified on `2026-03-30`

## Covered Endpoints
- `GET /tokens/v2/search`
- `GET /tokens/v2/tag`
- `GET /tokens/v2/{category}/{interval}`
- `GET /tokens/v2/recent`

## Design Rules
- `client.ts` mirrors Jupiter HTTP endpoints directly.
- `service.ts` keeps full upstream responses and adds token-resolution helpers for other Jupiter shelves.
- `types.ts` preserves the full `MintInformation` shape, including market, audit, social, and stats fields.
- No `lite-api.jup.ag` fallback.
- All requests require `x-api-key`.

## Local Notes
- Batch mint lookup uses `search?query=mint1,mint2,...` because Jupiter does not expose a dedicated `/tokens/v2/{mints}` endpoint.
- `resolveJupiterToken()` is a convenience helper for internal Jupiter shelves. Resolution order:
  1. well-known Solana tokens,
  2. local file cache,
  3. Jupiter Tokens API V2.
- Fail loud on API/auth issues. Only return `undefined` when the token truly is not found.
- `/tag` accepts three values: `lst`, `verified`, `stocks` (tokenized equities, e.g. Ondo, Remora). `stocks` was added 2026-07-23 (W1-G) — it existed upstream from the start but was unmodeled in `JupiterTokenTag`.
- `token-filters.ts` applies Vex-side `minOrganicScore`/`verifiedOnly`/`minLiquidity` thresholds to an already-fetched array. Jupiter has no server-side equivalent on any read endpoint — these are Vex's own filters, never sent to the wire (W1-G).
- The protocol layer's `projectJupiterToken(s)` (`vex-agent/tools/protocols/solana-jupiter/projectors.ts`) accepts a `statsInterval` option to keep a single stats window instead of all four, shrinking the common-case payload for `solana.tokens.search`/`solana.tokens.trending` (W1-G).

## Related
- `content/` for Jupiter Token Content API
- `../jupiter-swaps/` for swap execution and instruction building
