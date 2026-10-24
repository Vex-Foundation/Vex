/**
 * The price alert poller (F01): every 30 seconds, price the tokens with an
 * active alert and fire each alert whose level was reached.
 *
 * One tick:
 *   1. `listActiveForPoll(ACTIVE_ALERT_LIMIT)`. Nothing active is one cheap
 *      query and no provider call.
 *   2. Price the distinct tokens once each (`priceTokens`, keyless
 *      DexScreener). A token that could not be priced is skipped; its alert
 *      stays active and is read again next tick.
 *   3. For each alert whose price is at or past its stored trigger level in
 *      its direction, `claimTriggered`: a single `UPDATE ... WHERE status =
 *      'active'` that commits on its own. A null claim means the alert was
 *      cancelled or already fired, and nothing is announced.
 *   4. Only after a claim returns its row, `emitPriceAlertFired`.
 *
 * Shape copied from `startPriceWatchPoller`: a `setTimeout` chain with one
 * tick in flight, jitter, and a `stop()` that aborts first and then drains.
 * It needs no vault, no signer and no inference, so it runs while locked.
 */

import logger from "@utils/logger.js";
import { describeFailureForLog } from "@utils/error-summary.js";
import { parseBoundedDecimal } from "@tools/dexscreener/token-watch-price/decimal.js";
import * as alertRepo from "../db/repos/price-alerts.js";
import type { PriceAlertRow } from "../db/repos/price-alerts.js";
import { alertFires } from "./condition.js";
import { emitPriceAlertFired } from "./price-alert-bus.js";
import { assetKeyOf, priceTokens } from "./price-source.js";
import { ACTIVE_ALERT_LIMIT } from "./service.js";

export const PRICE_ALERT_POLL_INTERVAL_MS = 30_000;
export const PRICE_ALERT_POLL_JITTER_MS = 2_000;

export interface PriceAlertExecutorDeps {
  readonly listActiveForPoll: typeof alertRepo.listActiveForPoll;
  readonly claimTriggered: typeof alertRepo.claimTriggered;
  readonly priceTokens: typeof priceTokens;
  readonly emit: typeof emitPriceAlertFired;
  readonly now: () => Date;
}

export interface PriceAlertExecutorOptions {
  readonly intervalMs?: number;
  readonly jitterMs?: number;
  readonly deps?: PriceAlertExecutorDeps;
}

export interface PriceAlertExecutorHandle {
  stop(): Promise<void>;
}

/** What one tick did, for the log and the tests. */
export interface PriceAlertTickReport {
  readonly active: number;
  readonly priced: number;
  readonly failed: number;
  readonly fired: number;
  /** Claims that returned no row: cancelled or fired elsewhere first. */
  readonly lostClaims: number;
}

export function buildProductionPriceAlertDeps(): PriceAlertExecutorDeps {
  return {
    listActiveForPoll: alertRepo.listActiveForPoll,
    claimTriggered: alertRepo.claimTriggered,
    priceTokens,
    emit: emitPriceAlertFired,
    now: () => new Date(),
  };
}

/** Fire every active alert whose level its token's price has reached. */
export async function runPriceAlertTick(
  deps: PriceAlertExecutorDeps,
  signal?: AbortSignal,
): Promise<PriceAlertTickReport> {
  const active = await deps.listActiveForPoll(ACTIVE_ALERT_LIMIT);
  if (active.length === 0) return { active: 0, priced: 0, failed: 0, fired: 0, lostClaims: 0 };

  const { quotes, failed } = await deps.priceTokens(
    active.map((alert) => ({ chain: alert.chain, address: alert.address })),
    signal === undefined ? {} : { signal },
  );
  if (failed.length > 0) {
    logger.warn("alerts.price_alert.price_read_failed", { failed: failed.length, active: active.length });
  }

  let fired = 0;
  let lostClaims = 0;
  for (const alert of active) {
    if (signal?.aborted === true) break;
    const quote = quotes.get(assetKeyOf({ chain: alert.chain, address: alert.address }));
    if (quote === undefined || !fires(alert, quote.priceUsd)) continue;

    const claimed = await deps.claimTriggered(alert.id, quote.priceUsd, deps.now());
    if (claimed === null) {
      lostClaims += 1;
      continue;
    }
    fired += 1;
    deps.emit(firedEvent(claimed));
  }
  return { active: active.length, priced: quotes.size, failed: failed.length, fired, lostClaims };
}

function fires(alert: PriceAlertRow, priceUsd: string): boolean {
  const price = parseBoundedDecimal(priceUsd);
  const level = parseBoundedDecimal(alert.triggerPrice);
  if (price === null || level === null) return false;
  return alertFires(price, level, alert.direction);
}

function firedEvent(row: PriceAlertRow): Parameters<typeof emitPriceAlertFired>[0] {
  return {
    alertId: row.id,
    assetKey: row.assetKey,
    chain: row.chain,
    label: row.label,
    condition: row.condition,
    value: row.value,
    direction: row.direction,
    triggerPrice: row.triggerPrice,
    // The claim stored both; a claimed row always carries them.
    triggeredPrice: row.triggeredPrice ?? "",
    triggeredAt: row.triggeredAt ?? "",
    note: row.note,
  };
}

// ── Scheduler ──────────────────────────────────────────────────────

export function startPriceAlertExecutor(
  options: PriceAlertExecutorOptions = {},
): PriceAlertExecutorHandle {
  const intervalMs = options.intervalMs ?? PRICE_ALERT_POLL_INTERVAL_MS;
  const jitterMs = options.jitterMs ?? PRICE_ALERT_POLL_JITTER_MS;
  const deps = options.deps ?? buildProductionPriceAlertDeps();
  const aborter = new AbortController();

  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const runOne = async (): Promise<void> => {
    try {
      const report = await runPriceAlertTick(deps, aborter.signal);
      if (report.fired > 0 || report.lostClaims > 0) {
        logger.info("alerts.price_alert.tick", { ...report });
      }
    } catch (err) {
      // A tick failure never kills the loop: the alert stays active and the
      // next tick reads it again.
      logger.warn("alerts.price_alert.tick_failed", { error: describeFailureForLog(err) });
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    inFlight = runOne().finally(() => {
      inFlight = null;
      if (!stopped) {
        timer = setTimeout(schedule, intervalMs + Math.floor(Math.random() * (jitterMs + 1)));
      }
    });
  };

  timer = setTimeout(schedule, intervalMs);
  logger.info("alerts.price_alert.executor_started", { intervalMs });

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      // Abort BEFORE draining: the in-flight tick drops its price reads at
      // once instead of sitting out a 5 s provider deadline.
      aborter.abort();
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          // Already logged inside runOne.
        }
      }
      logger.info("alerts.price_alert.executor_stopped");
    },
  };
}
