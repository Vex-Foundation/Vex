# Jupiter Prediction API

Wire-first local reference for `src/tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api`.

See `JupiterPredictionUnits.md` for the field-by-field money/quantity unit
matrix (micro-USD string vs. micro-USD number vs. whole-dollar vs. the
contracts-micro family) plus the fixture-corrected `Market` object shape.

## Base URL
- `https://api.jup.ag/prediction/v1`

## Read Endpoints Implemented
- `GET /events`
- `GET /events/search`
- `GET /events/{eventId}`
- `GET /events/suggested/{pubkey}`
- `GET /events/{eventId}/markets`
- `GET /events/{eventId}/markets/{marketId}`
- `GET /markets/{marketId}`
- `GET /orderbook/{marketId}`
- `GET /trading-status`
- `GET /orders`
- `GET /orders/{orderPubkey}`
- `GET /orders/status/{orderPubkey}`
- `GET /positions`
- `GET /positions/{positionPubkey}`
- `GET /history`
- `GET /profiles/{ownerPubkey}`
- `GET /profiles/{ownerPubkey}/pnl-history`
- `GET /trades`
- `GET /leaderboards`
- `GET /vault-info`

## Transaction Endpoints Implemented
- `POST /orders`
- `DELETE /positions/{positionPubkey}`
- `DELETE /positions`
- `POST /positions/{positionPubkey}/claim`

## Local Behavior
- `client.ts` maps directly to indexed HTTP endpoints.
- `service.ts` preserves raw upstream payloads and adds signing helpers for transaction responses.
- Solana address validation is applied only to actual public-key fields like `ownerPubkey`, `positionPubkey`, `orderPubkey`, and `marketPubkey`.
- Opaque Jupiter identifiers like `eventId` and `marketId` are treated as non-empty strings, not Solana addresses.

## Explicit Deferrals
- `DELETE /orders` pending-order cancellation
- social relationship routes like follow, unfollow, followers, and following
- legacy command and handler rewiring
