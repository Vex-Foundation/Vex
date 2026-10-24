# Watchlist and price alerts (F01)

The user follows tokens and sets price alerts that notify once. Nothing here
trades, signs or touches a wallet. Every price read is the keyless DexScreener
public read the `token_price` wake watch already uses, so it works while the
vault is locked.

## Modules

| File | Owns |
| --- | --- |
| `condition.ts` | Conditions, value rules, the stored trigger level, the fire rule |
| `price-source.ts` | `priceTokens(assets, { signal?, readPools? })`, `quoteFromPools`, `assetKeyOf` |
| `service.ts` | Every rule and limit; the one entry point for tools and IPC |
| `price-alert-bus.ts` | The in-process fired event, emitted after the claim commits |
| `../db/repos/price-alerts.ts` | Rows, the advisory lock, the single-shot claim |
| `../db/migrations/184_watchlist_price_alerts.sql` | `watchlist_items`, `price_alerts` |

## Service

All functions take an optional last `deps: AlertServiceDeps` (repo, price
source, clock) for tests. Refusals are values: `{ ok: false, reason, message }`.

| Function | Result |
| --- | --- |
| `readWatchlist({ signal?, firedLimit? })` | `WatchlistSnapshot`: `items` (with `quote` and `priceStatus` `priced` / `no_price` / `unavailable`), `activeAlerts`, `firedAlerts` (newest first, 50 by default), `limits`, `pricedAt` |
| `addToWatchlist({ chain, tokenAddress, label? })` | `{ ok: true, item, created }` or a refusal |
| `removeFromWatchlist({ assetKey })` | `{ ok: true, assetKey }` or `not_found` |
| `setPriceAlert({ chain, tokenAddress, condition, value, note?, label?, origin, sessionId? })` | `{ ok: true, status: "created" \| "already_set", alert, priceUsd }` or a refusal |
| `cancelPriceAlert({ alertId })` | `{ ok: true, alert }` or `not_found` |
| `acknowledgeFired({ alertIds, clear })` | `{ ok: true, acknowledged, cleared }` |

Limits: `WATCHLIST_LIMIT = 30`, `ACTIVE_ALERT_LIMIT = 20`, `NOTE_MAX_CHARS = 140`,
`LABEL_MAX_CHARS = 80`, `MAX_MOVE_PCT = "1000"`; a fall must be below 100%.

Refusal codes (`ALERT_REFUSAL_REASONS`): `unsupported_chain`, `invalid_address`,
`invalid_value`, `invalid_note`, `invalid_label`, `no_price`, `already_past`,
`too_many_alerts`, `watchlist_full`, `not_found`.

## The poller's pieces

The poller (not in this module yet) reads `listActiveForPoll(20)`, prices the
distinct assets with `priceTokens`, and for each alert where
`alertFires(price, parse(triggerPrice), direction)` holds calls
`claimTriggered(id, priceUsd, now)`. Only a non-null claim is announced, with
`emitPriceAlertFired(...)`. A provider failure ends the tick; the alert stays
active.

## Bus

`emitPriceAlertFired(event)` and `onPriceAlertFired(listener)` (returns the
unsubscribe). Event type `engine.alerts.price_alert_fired`, payload
`PriceAlertFiredEvent`: `alertId`, `assetKey`, `chain`, `label`, `condition`,
`value`, `direction`, `triggerPrice`, `triggeredPrice`, `triggeredAt`, `note`.

## App contract

DTO schemas live in `vex-app/src/shared/schemas/alerts.ts`:
`watchlistSnapshotSchema`, `editWatchlistInputSchema` /
`editWatchlistResultSchema`, `setPriceAlertInputSchema` /
`setPriceAlertResultSchema`, `cancelPriceAlertInputSchema` /
`cancelPriceAlertResultSchema`, `acknowledgeFiredInputSchema` /
`acknowledgeFiredResultSchema`, `alertRefusalSchema`, and
`priceAlertFiredEventSchema`. The edit result carries `action`, which the IPC
handler adds to the service's `addToWatchlist` / `removeFromWatchlist` result.

Planned channels: `CH.alerts.getWatchlist`, `CH.alerts.editWatchlist`,
`CH.alerts.setPriceAlert`, `CH.alerts.cancelPriceAlert`,
`CH.alerts.acknowledgeFired`, and the event `EV.alerts.priceAlertFired`.
`vex-app/src/main/ipc/__tests__/alerts-contract.test.ts` proves the service's
output parses with these schemas.
