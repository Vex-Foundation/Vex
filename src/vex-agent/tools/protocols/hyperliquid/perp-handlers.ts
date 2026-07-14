import { Decimal } from "decimal.js";

import type { HyperliquidExchangeClient, PerpOpenPreflightInput } from "@tools/hyperliquid/exchange.js";
import type {
  DecimalString,
  HyperliquidExchangeResult,
  HyperliquidLimitOrder,
  HyperliquidTriggerOrder,
} from "@tools/hyperliquid/types.js";
import type { ProtocolExecutionContext, ProtocolHandler } from "../types.js";
import { buildPositionProtectionSnapshot, type PositionProtectionSnapshot } from "./protection-snapshot.js";
import { selectPerpOpenPath } from "./open-path.js";
import { builderForOrders } from "./builder-fee.js";
import {
  absolutePositionSize,
  buySell,
  capturePerp,
  capturePerpSafely,
  cloid,
  consolidationFailureMeta,
  decimal,
  exchangeOk,
  exchangeResult,
  fail,
  longShort,
  optionalDecimal,
  requiredBoolean,
  requiredNumber,
  requiredString,
  signingAddress,
  signingClients,
} from "./handler-shared.js";
import logger from "@utils/logger.js";

export const HYPERLIQUID_PERP_HANDLERS: Record<string, ProtocolHandler> = {
  "hyperliquid.perp.open": openPerp,
  "hyperliquid.perp.close": closePerp,
  "hyperliquid.perp.setTpsl": setTpsl,
  "hyperliquid.perp.modifyOrder": modifyOrder,
  "hyperliquid.perp.cancelOrders": cancelOrders,
  "hyperliquid.perp.setLeverage": setLeverage,
  "hyperliquid.perp.adjustMargin": adjustMargin,
  "hyperliquid.perp.twap": twap,
};

async function openPerp(params: Record<string, unknown>, context: ProtocolExecutionContext) {
  const coin = requiredString(params, "coin"); const side = longShort(params); const price = decimal(params, "price"); const size = decimal(params, "size");
  const { info, meta, exchange } = await signingClients(context); const address = await signingAddress(context);
  const asset = (await meta.get()).perpsByCoin.get(coin); if (!asset) return fail(`Unknown Hyperliquid Core market "${coin}".`);
  const leverage = requiredNumber(params, "leverage");
  const marginMode = requiredString(params, "marginMode");
  if (marginMode !== "isolated" && marginMode !== "cross") return fail("marginMode must be isolated or cross.");
  const entry: HyperliquidLimitOrder = { a: asset.asset, b: side === "long", p: price, s: size, r: false, t: { limit: { tif: "Gtc" } }, ...(cloid(params) ? { c: cloid(params) } : {}) };
  const stopPrice = optionalDecimal(params, "slPrice");
  const mustProtect = context.hyperliquidPolicy?.kind === "available" && context.hyperliquidPolicy.snapshot.policy.requireStopLoss;
  let result: HyperliquidExchangeResult;
  let orderExchange: HyperliquidExchangeClient | undefined;
  const openPath = selectPerpOpenPath(mustProtect, stopPrice !== undefined);
  const usedStop = openPath === "normalTpsl";
  let stop: HyperliquidTriggerOrder | undefined;
  let takeProfit: HyperliquidTriggerOrder | undefined;
  if (usedStop) {
    if (stopPrice === undefined) return fail("A stop-loss is required by the resolved Hyperliquid policy.");
    stop = { a: asset.asset, b: side !== "long", p: stopPrice, s: size, r: true, t: { trigger: { isMarket: true, triggerPx: stopPrice, tpsl: "sl" } } };
    const tpPrice = optionalDecimal(params, "tpPrice");
    takeProfit = tpPrice === undefined ? undefined : { a: asset.asset, b: side !== "long", p: tpPrice, s: size, r: true, t: { trigger: { isMarket: true, triggerPx: tpPrice, tpsl: "tp" } } };
  } else {
    if (mustProtect) return fail("A stop-loss is required by the resolved Hyperliquid policy.");
  }
  const openExecution = await preflightConfigureAndSubmitPerpOpen(
    exchange,
    { asset: asset.asset, leverage, marginMode, preflight: { entry, leverage, ...(stop === undefined ? {} : { stopLoss: stop }), ...(takeProfit === undefined ? {} : { takeProfit }) } },
    async () => {
      // Builder allowance work starts only after the complete bundle has passed
      // local validation and leverage setup. An invalid entry signs nothing.
      orderExchange = exchange.withBuilder(builderForOrders(info, exchange, address, context));
      return stop === undefined
        ? orderExchange.openPosition({ entry })
        : orderExchange.openWithStopLoss({ entry, stopLoss: stop, ...(takeProfit === undefined ? {} : { takeProfit }) });
    },
  );
  if (openExecution.phase === "leverage_setup") {
    return exchangeResult(openExecution.result, {
      coin,
      side,
      phase: "leverage_setup",
      _tradeCapture: await capturePerp(info, address, coin, context, false),
    });
  }
  result = openExecution.result;
  if (orderExchange === undefined) throw new Error("Perp entry submission completed without an order client.");
  const compensation = usedStop && stopPrice !== undefined ? await compensateRejectedStop(result, orderExchange, info, address, asset.asset, coin, stopPrice) : { steps: [] as string[], unprotected: false };
  const rejectedChildWasCompensated = result.kind === "orders"
    && result.statuses[1]?.kind === "rejected"
    && (result.statuses[0]?.kind === "accepted_filled" || result.statuses[0]?.kind === "partially_filled")
    && !compensation.unprotected;
  const consolidation = rejectedChildWasCompensated
    ? { state: "complete" as const, steps: [] as string[] }
    : usedStop && stopPrice !== undefined && !compensation.unprotected
      ? await consolidateConfirmedOpen(result, orderExchange, info, address, asset.asset, coin, stopPrice)
      : { state: "not_needed" as const, steps: [] as string[] };
  const unprotectedByChoice = !usedStop;
  const containmentFailed = compensation.unprotected || consolidation.state === "pending";
  const capture = await capturePerpSafely(info, address, coin, context, false, containmentFailed || unprotectedByChoice, {
    synchronousConsolidation: consolidation.state,
    ...(containmentFailed ? { protectionState: compensation.unprotected ? "unprotected" : "unknown" } : {}),
  });
  return exchangeResult(result, {
    coin,
    side,
    usedStop,
    compensation: [...compensation.steps, ...consolidation.steps],
    ...(containmentFailed ? {
      protectionState: compensation.unprotected ? "unprotected" : "unknown",
      actionableError: "Entry may be filled while stop-loss protection is unknown or incomplete. Verify the position and run perp.setTpsl before any other Hyperliquid action.",
    } : {}),
    _tradeCapture: capture,
  }, containmentFailed);
}

export async function applyOpenLeverage(
  exchange: Pick<HyperliquidExchangeClient, "updateLeverage">,
  asset: number,
  leverage: number,
  marginMode: string,
): Promise<HyperliquidExchangeResult> {
  if (marginMode !== "isolated" && marginMode !== "cross") {
    return { kind: "batch_error", message: "marginMode must be isolated or cross.", raw: null };
  }
  return exchange.updateLeverage({ asset, leverage, isCross: marginMode === "cross" });
}

/**
 * Preserve the open action's side-effect ordering in one testable boundary:
 * exact order validation first, then the advertised leverage/margin setup,
 * and only then the signed entry submission (including builder allowance work).
 */
export async function preflightConfigureAndSubmitPerpOpen(
  exchange: Pick<HyperliquidExchangeClient, "preflightPerpOpen" | "updateLeverage">,
  input: {
    readonly asset: number;
    readonly leverage: number;
    readonly marginMode: string;
    readonly preflight: PerpOpenPreflightInput;
  },
  submit: () => Promise<HyperliquidExchangeResult>,
): Promise<{ readonly phase: "leverage_setup" | "entry"; readonly result: HyperliquidExchangeResult }> {
  await exchange.preflightPerpOpen(input.preflight);
  const leverageResult = await applyOpenLeverage(exchange, input.asset, input.leverage, input.marginMode);
  if (!exchangeOk(leverageResult)) return { phase: "leverage_setup", result: leverageResult };
  return { phase: "entry", result: await submit() };
}

export async function consolidateConfirmedOpen(
  result: HyperliquidExchangeResult,
  exchange: OpenCompensationExchange,
  info: OpenCompensationInfo,
  address: string,
  asset: number,
  coin: string,
  stopPrice: DecimalString,
): Promise<{ readonly state: "not_needed" | "complete" | "pending"; readonly steps: string[] }> {
  if (result.kind !== "orders") return { state: "not_needed", steps: [] };
  const entry = result.statuses[0];
  const child = result.statuses[1];
  if (entry?.kind !== "accepted_filled" && entry?.kind !== "partially_filled") {
    return { state: "not_needed", steps: [] };
  }
  if (child?.kind !== "accepted_resting" || child.oid === undefined) {
    return { state: "pending", steps: ["filled entry stop child could not be identified for consolidation"] };
  }
  try {
    const [state, orders] = await Promise.all([info.clearinghouseState(address), info.frontendOpenOrders(address)]);
    const snapshot = buildPositionProtectionSnapshot(state, orders, coin);
    if (new Decimal(snapshot.positionSize).isZero()) return { state: "not_needed", steps: [] };
    const replacement = await exchange.setPositionTpsl({
      a: asset,
      b: new Decimal(snapshot.positionSize).lt(0),
      p: stopPrice,
      s: absolutePositionSize(snapshot.positionSize),
      r: true,
      t: { trigger: { isMarket: true, triggerPx: stopPrice, tpsl: "sl" } },
    });
    if (!exchangeOk(replacement)) return { state: "pending", steps: ["full-position stop placement failed"] };
    const [placedState, placedOrders] = await Promise.all([info.clearinghouseState(address), info.frontendOpenOrders(address)]);
    if (buildPositionProtectionSnapshot(placedState, placedOrders, coin).fullPositionStops.length !== 1) {
      return { state: "pending", steps: ["full-position stop was not confirmed before child cancellation"] };
    }
    const cancelled = await exchange.cancel({ cancels: [{ a: asset, o: child.oid }] });
    if (!exchangeOk(cancelled)) return { state: "pending", steps: ["full-position stop placed; fixed-size child cancellation failed"] };
    const [finalState, finalOrders] = await Promise.all([info.clearinghouseState(address), info.frontendOpenOrders(address)]);
    return buildPositionProtectionSnapshot(finalState, finalOrders, coin).state === "PROTECTED"
      ? { state: "complete", steps: ["full-position stop confirmed before fixed-size child cancellation"] }
      : { state: "pending", steps: ["post-cancellation protection verification was not PROTECTED"] };
  } catch (cause) {
    logger.warn("hyperliquid.post_submit_containment_failed", { step: "open_stop_consolidation", cause });
    return { state: "pending", steps: ["live protection verification failed during full-position stop consolidation"] };
  }
}

async function closePerp(params: Record<string, unknown>, context: ProtocolExecutionContext) {
  const coin = requiredString(params, "coin"); const { info, meta, exchange } = await signingClients(context); const address = await signingAddress(context);
  const asset = (await meta.get()).perpsByCoin.get(coin); if (!asset) return fail(`Unknown Hyperliquid Core market "${coin}".`);
  const orderExchange = exchange.withBuilder(builderForOrders(info, exchange, address, context));
  const result = await orderExchange.closePosition({ asset: asset.asset, side: buySell(params), size: decimal(params, "size"), markPrice: decimal(params, "markPrice"), slippageBps: requiredNumber(params, "slippageBps"), ...(cloid(params) ? { cloid: cloid(params) } : {}) });
  return exchangeResult(result, { coin, _tradeCapture: await capturePerp(info, address, coin, context, true) });
}

async function setTpsl(params: Record<string, unknown>, context: ProtocolExecutionContext) {
  const coin = requiredString(params, "coin"); const { info, meta, exchange } = await signingClients(context); const address = await signingAddress(context);
  const [state, orders] = await Promise.all([info.clearinghouseState(address), info.frontendOpenOrders(address)]);
  const snapshot = buildPositionProtectionSnapshot(state, orders, coin); if (new Decimal(snapshot.positionSize).isZero()) return fail("Cannot set a full-position stop when no position is open.");
  const asset = (await meta.get()).perpsByCoin.get(coin); if (!asset) return fail(`Unknown Hyperliquid Core market "${coin}".`);
  const orderExchange = exchange.withBuilder(builderForOrders(info, exchange, address, context));
  const price = decimal(params, "slPrice"); const replacement = await orderExchange.setPositionTpsl({ a: asset.asset, b: new Decimal(snapshot.positionSize).lt(0), p: price, s: absolutePositionSize(snapshot.positionSize), r: true, t: { trigger: { isMarket: true, triggerPx: price, tpsl: "sl" } } });
  let consolidation = { staleStopsCancelled: false, consolidationPending: !exchangeOk(replacement) };
  let containmentFailed = !exchangeOk(replacement);
  try {
    consolidation = await cancelStaleStopsAfterReplacement(replacement, orderExchange, asset.asset, snapshot);
  } catch (cause) {
    logger.warn("hyperliquid.post_submit_containment_failed", { step: "set_tpsl_stale_stop_cancellation", cause });
    containmentFailed = true;
    consolidation = { staleStopsCancelled: false, consolidationPending: true };
  }
  let failureMeta: Record<string, unknown> = {};
  if (consolidation.consolidationPending) {
    try {
      failureMeta = await consolidationFailureMeta(`hyperliquid:perp:${coin}:${address}`);
    } catch (cause) {
      logger.warn("hyperliquid.post_submit_containment_failed", { step: "set_tpsl_failure_metadata", cause });
      containmentFailed = true;
    }
  }
  const capture = await capturePerpSafely(info, address, coin, context, false, containmentFailed || consolidation.consolidationPending, {
    ...failureMeta,
    ...(containmentFailed || consolidation.consolidationPending ? { protectionState: "unknown" } : {}),
  });
  return exchangeResult(replacement, {
    coin,
    staleStopsCancelled: consolidation.staleStopsCancelled,
    consolidationPending: consolidation.consolidationPending,
    ...(containmentFailed || consolidation.consolidationPending ? {
      protectionState: "unknown",
      actionableError: "Stop-loss replacement outcome is not fully verified. Verify the position and run perp.setTpsl before any other Hyperliquid action.",
    } : {}),
    _tradeCapture: capture,
  }, containmentFailed || consolidation.consolidationPending);
}

export async function cancelStaleStopsAfterReplacement(
  replacement: HyperliquidExchangeResult,
  exchange: Pick<HyperliquidExchangeClient, "cancel">,
  asset: number,
  snapshot: PositionProtectionSnapshot,
): Promise<{ readonly staleStopsCancelled: boolean; readonly consolidationPending: boolean }> {
  if (!exchangeOk(replacement)) return { staleStopsCancelled: false, consolidationPending: false };
  const staleStops = [...snapshot.fullPositionStops, ...snapshot.fixedSizeStops];
  if (staleStops.length === 0) return { staleStopsCancelled: true, consolidationPending: false };
  const cancellation = await exchange.cancel({ cancels: staleStops.map((stop) => ({ a: asset, o: stop.oid })) });
  const staleStopsCancelled = exchangeOk(cancellation);
  return { staleStopsCancelled, consolidationPending: !staleStopsCancelled };
}

async function modifyOrder(params: Record<string, unknown>, context: ProtocolExecutionContext) {
  const coin = requiredString(params, "coin"); const { info, meta, exchange } = await signingClients(context); const address = await signingAddress(context); const asset = (await meta.get()).perpsByCoin.get(coin); if (!asset) return fail(`Unknown Hyperliquid Core market "${coin}".`);
  const orderExchange = exchange.withBuilder(builderForOrders(info, exchange, address, context));
  const result = await orderExchange.modify({ oid: requiredNumber(params, "oid"), order: { a: asset.asset, b: buySell(params) === "buy", p: decimal(params, "price"), s: decimal(params, "size"), r: requiredBoolean(params, "reduceOnly"), t: { limit: { tif: "Gtc" } } } });
  return exchangeResult(result, { coin, _tradeCapture: await capturePerp(info, address, coin, context, false) });
}

async function cancelOrders(params: Record<string, unknown>, context: ProtocolExecutionContext) {
  const coin = requiredString(params, "coin"); const { info, meta, exchange } = await signingClients(context); const address = await signingAddress(context); const asset = (await meta.get()).perpsByCoin.get(coin); if (!asset) return fail(`Unknown Hyperliquid Core market "${coin}".`);
  const result = await exchange.cancel({ cancels: [{ a: asset.asset, o: requiredNumber(params, "oid") }] });
  return exchangeResult(result, { coin, _tradeCapture: await capturePerp(info, address, coin, context, false) });
}

async function setLeverage(params: Record<string, unknown>, context: ProtocolExecutionContext) {
  const coin = requiredString(params, "coin"); const { info, meta, exchange } = await signingClients(context); const address = await signingAddress(context); const asset = (await meta.get()).perpsByCoin.get(coin); if (!asset) return fail(`Unknown Hyperliquid Core market "${coin}".`);
  const result = await exchange.updateLeverage({ asset: asset.asset, leverage: requiredNumber(params, "leverage"), isCross: requiredString(params, "marginMode") === "cross" });
  return exchangeResult(result, { coin, _tradeCapture: await capturePerp(info, address, coin, context, false) });
}

async function adjustMargin(params: Record<string, unknown>, context: ProtocolExecutionContext) {
  const coin = requiredString(params, "coin"); const { info, meta, exchange } = await signingClients(context); const address = await signingAddress(context); const asset = (await meta.get()).perpsByCoin.get(coin); if (!asset) return fail(`Unknown Hyperliquid Core market "${coin}".`);
  const result = await exchange.updateIsolatedMargin({ asset: asset.asset, isBuy: longShort(params) === "long", ntli: requiredNumber(params, "ntli") });
  return exchangeResult(result, { coin, _tradeCapture: await capturePerp(info, address, coin, context, false) });
}

async function twap(params: Record<string, unknown>, context: ProtocolExecutionContext) {
  const coin = requiredString(params, "coin"); const { info, meta, exchange } = await signingClients(context); const address = await signingAddress(context); const asset = (await meta.get()).perpsByCoin.get(coin); if (!asset) return fail(`Unknown Hyperliquid Core market "${coin}".`);
  const orderExchange = exchange.withBuilder(builderForOrders(info, exchange, address, context));
  const result = await orderExchange.twapOrder({ twap: { a: asset.asset, b: buySell(params) === "buy", s: decimal(params, "size"), r: false, m: requiredNumber(params, "minutes"), t: params.randomize === true } });
  return exchangeResult(result, { coin, _tradeCapture: await capturePerp(info, address, coin, context, false) });
}


export interface OpenCompensationExchange {
  cancel(input: { readonly cancels: readonly { readonly a: number; readonly o: number }[] }): Promise<HyperliquidExchangeResult>;
  setPositionTpsl(order: HyperliquidTriggerOrder): Promise<HyperliquidExchangeResult>;
}

export interface OpenCompensationInfo {
  clearinghouseState(user: string): Promise<unknown>;
  frontendOpenOrders(user: string): Promise<unknown>;
}

export async function compensateRejectedStop(result: HyperliquidExchangeResult, exchange: OpenCompensationExchange, info: OpenCompensationInfo, address: string, asset: number, coin: string, stopPrice: DecimalString): Promise<{ steps: string[]; unprotected: boolean }> {
  if (result.kind !== "orders" || result.statuses[1]?.kind !== "rejected") return { steps: [], unprotected: false };
  const entry = result.statuses[0]; const steps = ["atomic stop-loss child rejected"];
  try {
    if (entry?.kind === "accepted_resting" && entry.oid !== undefined) { const cancelled = await exchange.cancel({ cancels: [{ a: asset, o: entry.oid }] }); steps.push(exchangeOk(cancelled) ? "resting entry cancelled" : "resting entry cancellation failed"); return { steps, unprotected: !exchangeOk(cancelled) }; }
    if (entry?.kind !== "accepted_filled" && entry?.kind !== "partially_filled") return { steps, unprotected: false };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const [state, orders] = await Promise.all([info.clearinghouseState(address), info.frontendOpenOrders(address)]);
      const snapshot = buildPositionProtectionSnapshot(state, orders, coin);
      const full = await exchange.setPositionTpsl({ a: asset, b: new Decimal(snapshot.positionSize).lt(0), p: stopPrice, s: absolutePositionSize(snapshot.positionSize), r: true, t: { trigger: { isMarket: true, triggerPx: stopPrice, tpsl: "sl" } } });
      steps.push(exchangeOk(full) ? `full-position stop placed on retry ${attempt}` : `full-position stop retry ${attempt} failed`);
      if (!exchangeOk(full)) continue;
      const [verifiedState, verifiedOrders] = await Promise.all([info.clearinghouseState(address), info.frontendOpenOrders(address)]);
      if (buildPositionProtectionSnapshot(verifiedState, verifiedOrders, coin).state === "PROTECTED") return { steps, unprotected: false };
      steps.push(`full-position stop retry ${attempt} was not visible in live protection state`);
    }
  } catch (cause) {
    logger.warn("hyperliquid.post_submit_containment_failed", { step: "rejected_stop_compensation", cause });
    steps.push("live recovery state could not be verified");
  }
  steps.push("UNPROTECTED: immediately propose a reduce-only close"); return { steps, unprotected: true };
}
