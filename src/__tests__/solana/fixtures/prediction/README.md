# Prediction fixtures — provenance

Tracked copies of sanitized, real live-API recordings from
`agents_dm/agentscan-phase3/fixtures/` (git-ignored source location — see
`agents_dm/agentscan-phase3/deltas/W0-D.md` for the full recording session
log). Copied here byte-for-byte (source file name in parens below) so
committed tests never depend on an ignored path.

All requests were **keyless** (no `x-api-key` sent) against
`https://api.jup.ag/prediction/v1`, recorded 2026-07-23. No sanitization was
required for any of these four files — every field is public prediction-market
metadata (titles, prices, volumes, rules text); no wallet/owner/position data
appears in the Event/Market/Orderbook shape.

| File | Source | Endpoint | Notes |
|---|---|---|---|
| `events-limit1-includemarkets.json` | `prediction-events-limit1-includemarkets.json` | `GET /events?end=1&includeMarkets=true` | Byte-identical to the source's sibling `prediction-events-limit1-lean.json` (`includeMarkets` omitted) — see `JupiterPredictionUnits.md`'s `includeMarkets` caveat. Only one copy is tracked here since the two are identical; do not assume `includeMarkets` gates payload size from this fixture alone. |
| `events-search.json` | `prediction-events-search.json` | `GET /events/search?query=trump&limit=2` | 10 events, all with empty `markets: []` — good coverage for the "no nested markets" event shape, `beginAt` as a non-null numeric string, and an empty `subcategory` edge case. |
| `market-detail.json` | `prediction-market-detail.json` | `GET /markets/POLY-2470848` | Single standalone Market object (includes `eventId`, absent when the same market is nested under an event). |
| `orderbook.json` | `prediction-orderbook.json` | `GET /orderbook/POLY-2470848` | Same market as `market-detail.json`. Confirms the 4-key `yes`/`no`/`yes_dollars`/`no_dollars` shape. |

## Authenticated position/history recordings (2026-07-25)

The four `/events`-family files above are the whole reason the 2026-07-25
outage went unnoticed: `GET /positions` and `GET /history` return
`{"data": [], ...}` for a wallet with no positions, so **the pre-2026-07-25
fixture set encoded only the empty-list case** and no row ever reached the
row-level schemas. The two files below close that gap — they are the first
recordings taken while the gate wallet actually held an open position
(`POLY-1654958`, an unresolved "Fed Decision in July?" market).

| File | Endpoint | Notes |
|---|---|---|
| `positions-open.json` | `GET /positions?ownerPubkey=…` | One real open YES position. Carries the two shapes that broke the schema: `eventMetadata.closeTime` as a unix-SECONDS **number** (`1785283200`) and `marketMetadata.result` as **`null`** (the market is still open). Also records three fields the schema does not model and that survive via `.passthrough()`: `integratorFeeUsd`, `maxSlippageBps`, `source`. |
| `history-rows.json` | `GET /history?ownerPubkey=…` | Three rows (`order_closed` / `order_filled` / `order_created`) carrying the same two shapes on every row, plus an undeclared `status: null`. |

**Sanitization** (unlike the four public files above, these DO contain
wallet-scoped data): every account/signature identity — `pubkey`, `owner`,
`ownerPubkey`, `market`, `marketIdHash`, `signature`, `orderPubkey`,
`positionPubkey`, `keeperPubkey`, `externalOrderId`, `orderId` — was replaced
with a deterministic placeholder of the same length and alphabet, so the
recorded SHAPE is exact while no real address or transaction signature is
tracked in git. Market/event metadata, amounts, and timestamps are byte-exact
as received; the position was ~$4.67 of exposure, and the amounts are
load-bearing for the money-conversion assertions.

**Regeneration**: re-run `GET /positions` / `GET /history` for a wallet with an
open position (an API key is required — these endpoints are authenticated),
then re-apply the identity scrub. Both files are point-in-time snapshots: the
market will eventually resolve, at which point `marketMetadata.result` becomes
a non-null string. That is the *other* branch of the same tolerant field, so
capturing a resolved row later would strengthen this fixture set.

**Regeneration**: re-run the `curl` calls in `agents_dm/agentscan-phase3/deltas/W0-D.md`
against the URLs above and re-copy the sanitized output here. These are
point-in-time snapshots (prices/volumes will drift, the specific market may
resolve) — treat them as **shape** ground truth for schema/unit pinning, not
as values to assert unchanged indefinitely.
