# Jupiter Prediction API — Field Unit Matrix

Companion to `JupiterPredictionApi.md`. Classifies every money/quantity field
in `types/` + `schemas/` by unit, so a caller never has to guess whether a
number is dollars, micro-dollars, or a contract count. Ground truth is, in
order: recorded live fixtures (`src/__tests__/solana/fixtures/prediction/`,
copied from `agents_dm/agentscan-phase3/fixtures/prediction-*.json`,
2026-07-23) > `developers.jup.ag/docs/prediction` + the OpenAPI spec > the
pre-existing hand-written types. Where fixtures contradicted the prior
assumption baked into our types, the fixture wins and the correction is
called out explicitly below.

This is the unit REFERENCE for the domain. The agent-facing conversions it
describes are implemented in
`src/vex-agent/tools/protocols/solana-jupiter/predict-projector.ts` (W1-B:
exact-decimal dollar strings + `*Micro` raw siblings, string math only) —
when this table and that projector disagree, fix the disagreement, don't
pick a side silently.

## Unit categories

- **micro-USD string** — base-10 integer string, `1,000,000` native units =
  `$1.00`. On-chain `u64`/`u128`/`i128` scale: can exceed
  `Number.MAX_SAFE_INTEGER`. Parse with `BigInt` or a decimal library —
  **never** `parseFloat`/`Number`.
- **micro-USD number** — same `1,000,000 = $1.00` scale, but delivered as a
  JS `number` instead of a string. Still an exact integer count of
  micro-dollars; do not treat it as an already-divided dollar amount.
- **whole-dollar number** — already denominated in whole US dollars; no
  further scaling needed.
- **contracts-micro family** — quantity fields following the docs'
  three-parallel-representation pattern: a bare legacy field (floored whole
  number string, "must not be used for accounting" per the docs), a `*Micro`
  sibling (exact integer string, `1,000,000` = 1 contract), and a `*Decimal`
  sibling (exact decimal string). Only the bare legacy field has ever been
  observed on the wire by this repo; the `*Micro`/`*Decimal` siblings below
  are modeled from docs alone (marked accordingly) and are optional in the
  schema/types until a live response confirms them.

## Confidence key

- **fixture-confirmed** — read directly off a recorded live response.
- **docs-only** — stated in `developers.jup.ag` narrative pages or the
  OpenAPI spec; no live fixture available to cross-check (mutation/auth-only
  endpoints were out of `W0-D`'s fixture-recording scope).
- **inferred** — not directly documented; reasoned from field naming/position
  and a single fixture data point. Flagged for a second live check before
  relying on it elsewhere.

## Market pricing (`schemas/_shared.ts` → `marketPricingSchema`)

Confirmed against `prediction-market-detail.json` / the nested market inside
`prediction-events-limit1-includemarkets.json` (same market,
`POLY-2470848`).

| Field | Unit | Confidence | Evidence |
|---|---|---|---|
| `buyYesPriceUsd` | micro-USD number | fixture-confirmed | `1000000` on a market where "Yes" is priced near-certain — `1,000,000 / 1e6 = $1.00`, consistent with a near-$1 per-share price. |
| `sellYesPriceUsd` | micro-USD number | fixture-confirmed | `999000` → `$0.999`. |
| `buyNoPriceUsd` | micro-USD number | fixture-confirmed | `1000` → `$0.001`. |
| `sellNoPriceUsd` | micro-USD number | fixture-confirmed | `0` → `$0.00`. |
| `volume` | **whole-dollar number** | corroborated 2026-07-25 (was: inferred, single data point) | `26003599` matches the parent event's `volumeUsd` (`"26003599000000"`, micro-USD string) divided by `1e6` **exactly**. This is the opposite scale from the 4 price fields in the same object — the sub-object is NOT uniformly scaled. See the corroboration note below. |

**`volume` corroboration (2026-07-25)** — the original evidence was weaker than
it looked: that fixture's event had exactly ONE market, so "market volume ==
event volume / 1e6" was structurally guaranteed and proved nothing about the
scale. Re-checked against a live FIVE-market event (`POLY-287395`): the SUM of
the per-market `pricing.volume` values is `91,233,533` against an event
`volumeUsd` of `"91195237000000"` (= `91,195,237` whole dollars) — a 0.04%
spread attributable to snapshot skew between the event aggregate and the
per-market counters. The magnitudes agree, so the whole-dollar classification
now rests on independent multi-market evidence rather than a coincidence.

**Correction to prior assumption**: an earlier (pre-fixture) read of this
sub-object assumed all 5 fields were plain decimal dollars (e.g. `0.65` for
$0.65). That assumption is wrong for the 4 price fields per the fixture
evidence above — fixtures win over that prior assumption per this card's own
rule.

## Event-level volume (`schemas/_shared.ts` → `eventSchema`, `schemas/events.ts`)

| Field | Unit | Confidence | Evidence |
|---|---|---|---|
| `volumeUsd` | micro-USD string | fixture-confirmed | `"26003599000000"`, `"112898000000"`, etc. across all 3 event fixtures — always a long digit string ending in the expected zero-padding for a `×1e6` scale. |
| `volume24hr` | micro-USD string | fixture-confirmed (new field; was previously absent from our types) | `"8151817000000"`, `"33000000"`, `"0"` — same string-integer shape as `volumeUsd`. |

## Display timestamps — `closeTime` (`close-time.ts`)

| Field | Unit | Confidence | Evidence |
|---|---|---|---|
| `eventMetadata.closeTime` (`/events*`) | ISO-8601 UTC **string** | fixture-confirmed | `"2026-07-20T03:59:00Z"` and siblings across all 4 event fixtures. |
| `eventMetadata.closeTime` (`/positions`, `/history`) | unix **SECONDS** number | live-confirmed 2026-07-25 | `1785283200` → `2026-07-29T00:00:00Z` as seconds. Read as milliseconds the same value is `1970-01-21`, impossible for an open market. |
| `marketMetadata.closeTime` / `openTime` | unix **SECONDS** number | live-confirmed 2026-07-25 | `1785283200` / `1773965564` on the same position row. |
| `marketSchema.closeTime` / `openTime` (FLAT Market) | unix **SECONDS** number | fixture + live | Deliberately kept STRICTLY numeric — verified across 50+ live markets and pinned by `jupiter-prediction-schemas.test.ts`. |

**One field, two serializations.** `eventMetadata.closeTime` is the same field
name emitted in two different forms by two different upstream serializers, and
both feed the SAME `eventMetadataSchema`. Modeling only the string form is what
broke `solana.predict.positions` / `.history` on 2026-07-25 the first time the
wallet held a real position. `close-time.ts` owns the tolerant wire contract
(a CLOSED `number | string` union) and the normaliser that restates either form
as an unambiguous ISO-8601 instant; `predict-projector.ts` applies it to
`/history`, the only projection that forwards these metadata objects whole.

## Order / Position / History quantity fields (contracts family)

No live order/position/history fixture was available in this batch (those
endpoints require an authenticated wallet with open positions — explicitly
out of `W0-D`'s scope, "no personal position data"). The bare `contracts` /
`filledContracts` / `contractsSettled` / `newContracts` /
`totalActiveContracts` fields were already modeled (string, legacy/floored
per docs). The `*Micro`/`*Decimal` siblings the docs describe
(`recon-docs-prediction.md` §2) are added as **optional, docs-only** fields
in this card so the SDK can accept them once a live response confirms they
exist — they are not yet fixture-confirmed.

| Field family | Bare field unit | `*Micro` unit | `*Decimal` unit | Confidence |
|---|---|---|---|---|
| `contracts` (Order, Position, History, CreateOrderDetails, ClaimPositionDetails) | contracts-micro legacy (floored whole number string) | contracts-micro string, `1,000,000` = 1 contract | exact decimal string | docs-only |
| `filledContracts` (Order, History) | contracts-micro legacy | contracts-micro string | exact decimal string | docs-only |
| `contractsSettled` (History) | contracts-micro legacy | contracts-micro string | exact decimal string | docs-only |
| `newContracts` (CreateOrderDetails) | contracts-micro legacy | contracts-micro string | exact decimal string | docs-only |
| `totalActiveContracts` (Profile) | contracts-micro legacy | contracts-micro string | exact decimal string | docs-only |

## Order/Position/History USD fields (unresolved — not this card's fix)

`sizeUsd`, `valueUsd`, `avgPriceUsd`, `markPriceUsd`, `pnlUsd`, `payoutUsd`,
`feesPaidUsd`, `costUsd`, `feeUsd`, and siblings on Order/Position/History/
transaction-response schemas are typed `z.string()` today with no fixture
available to confirm their scale (same auth-gated gap as the contracts
family above). Per the docs' blanket "all USD fields are micro-USD" claim
and the request-side evidence already in the handler
(`handlers/predict.ts:196`, `Math.round(amount * 1_000_000)` before sending a
buy order), these are very likely micro-USD strings — but this card does not
change their type (still `z.string()`, matching the wire) or add a converted
sibling, since that is output/behavior work reserved for the `W1-B` money
convention card, not a types/schemas/validation contract repair. Flagging
here so `W1-B` does not have to re-derive this from scratch.

## Market object shape (not a unit issue, but load-bearing for the above)

The wire `Market` object (`GET /markets/{marketId}`, and nested under
`GET /events`'s `markets[]`) is **flat** — confirmed by 3 independent live
captures (`prediction-events-limit1-includemarkets.json`,
`prediction-events-limit1-lean.json` — byte-identical to the first —, and
`prediction-market-detail.json`). It does **not** nest a `metadata`
sub-object as the pre-fixture types assumed. `provider`, `title`, `team`,
`outcomes`, `clobTokenIds`, `marketOptions`, `sportsMarketType`,
`sportsLine`, and the undocumented `gameNumber` are new top-level fields
added to `JupiterPredictionMarket` in this card. See
`types/events-markets.ts` for the full per-field optionality rationale
(only `provider: "polymarket"` markets have been observed).

## `includeMarkets` — live behavior (CORRECTED)

An earlier probe concluded the param was a live no-op ("byte-identical
responses"). That was WRONG — a rate-limit artifact of keyless 0.5-RPS
back-to-back calls. The coordinator re-verified on 2026-07-23 with 4s
spacing: `includeMarkets=false` returns the event WITHOUT `markets[]`
(897 B vs 2361 B on the same event); omitting the param behaves like
`true` (server default). The provider param works and MAY be passed
upstream as a transport optimization (P1); the agent-facing lean default
is still implemented as Vex-side projection (W1-C), so agent behavior does
not depend on the provider honoring the param.
