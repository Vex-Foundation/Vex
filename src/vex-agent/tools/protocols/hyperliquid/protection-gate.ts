import { Decimal } from "decimal.js";

import { HyperliquidInfoClient } from "@tools/hyperliquid/info.js";
import { HyperliquidMetaCache } from "@tools/hyperliquid/meta-cache.js";
import { resolveHyperliquidNetwork } from "@tools/hyperliquid/constants.js";
import { normalizeProviderDecimal, parseDecimalString } from "@tools/hyperliquid/validation.js";
import logger from "@utils/logger.js";
import type { HyperliquidPolicy } from "../../../../lib/hyperliquid-policy.js";
import { getProtocolManifest } from "../catalog.js";
import type { ProtocolExecutionContext } from "../types.js";
import { buildPositionProtectionSnapshot, hasStandingFullPositionStop, isSoleProtectiveOrder, parseLiveProtectionState, stopIsBeyondLiquidation, type PositionProtectionSnapshot } from "./protection-snapshot.js";

export type StopLossVerdict = "protected_required" | "unprotected_by_user_choice";
export type ProtectionGateDecision =
  | { readonly kind: "allow"; readonly snapshot: PositionProtectionSnapshot; readonly stopLossVerdict: StopLossVerdict; readonly notionalUsd?: string; readonly estimatedLiquidationPx?: string }
  | { readonly kind: "block"; readonly message: string };

/**
 * Runs only in the protocol runtime fixed sequence. It validates state before
 * approval and signing and does not expose an alternate entry point.
 */
export async function evaluateHyperliquidProtectionGate(
  toolId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<ProtectionGateDecision | null> {
  if (!toolId.startsWith("hyperliquid.perp.")) return null;
  // Reads (perp.positions, perp.orders, perp.fills, ...) need no protection or
  // policy verification and must never be blocked by a transient live-state
  // hiccup — the agent has to be able to list positions/orders even when the
  // info API is degraded. Only mutating perp actions cross the safety gate
  // below. Data-driven off the manifest so new read tools inherit this.
  const manifest = getProtocolManifest(toolId);
  if (manifest && !manifest.mutating) return null;
  if (context.hyperliquidPolicy?.kind !== "available") return { kind: "block", message: "Hyperliquid trading policy is unavailable." };
  const coin = stringParam(params, "coin");
  if (!coin) return { kind: "block", message: "Hyperliquid perp action requires a coin." };
  let address: string;
  try { address = (await import("../../internal/wallet/resolve.js")).resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"); }
  catch { return { kind: "block", message: "A selected EVM wallet is required for Hyperliquid trading." }; }

  try {
    const info = new HyperliquidInfoClient({ network: resolveHyperliquidNetwork() });
    // Transient Hyperliquid info-API failures (a rate-limit or single blip after
    // a burst of calls) were failing this gate closed and blocking legitimate
    // opens. Retry the read block ONCE after a short pause; a second failure
    // still falls through to the fail-closed catch below, so the conservative
    // stance is preserved. Reads only — nothing here signs or mutates.
    const readLiveState = () => Promise.all([
      info.clearinghouseState(address),
      info.frontendOpenOrders(address),
      new HyperliquidMetaCache(info).get(),
    ]);
    let live: Awaited<ReturnType<typeof readLiveState>>;
    try {
      live = await readLiveState();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
      live = await readLiveState();
    }
    const [state, orders, metadata] = live;
    const asset = metadata.perpsByCoin.get(coin);
    if (!asset) return { kind: "block", message: `"${coin}" is not a validator-operated Hyperliquid core perp market.` };
    const snapshot = buildPositionProtectionSnapshot(state, orders, coin);
    const policy = context.hyperliquidPolicy.snapshot.policy;
    if (policy.marketAllowlist !== null && !policy.marketAllowlist.includes(coin)) {
      return { kind: "block", message: `"${coin}" is outside this mission's accepted Hyperliquid market allowlist.` };
    }
    const invariant = evaluateProtectionInvariant(toolId, params, snapshot, policy.requireStopLoss);
    if (invariant.kind === "block") return invariant;
    const flatRisk = toolId === "hyperliquid.perp.open" && snapshot.state === "FLAT"
      ? evaluateFlatOpenLiquidation(params, state, asset.maxLeverage, policy.maintenanceHeadroomFloor)
      : { kind: "allow" as const };
    if (flatRisk.kind === "block") return flatRisk;
    const policyParams = toolId === "hyperliquid.perp.twap" && stringParam(params, "price") === undefined
      ? await withMidPrice(params, info, coin)
      : params;
    const policyDecision = evaluatePerpPolicy(policyParams, state, asset.maxLeverage, policy);
    if (policyDecision.kind === "block") return policyDecision;
    const slippage = await validateL2Slippage(toolId, policyParams, info, policy.maxSlippageEstPct);
    if (slippage.kind === "block") return slippage;
    return {
      kind: "allow",
      snapshot,
      stopLossVerdict: invariant.stopLossVerdict,
      ...(policyDecision.notionalUsd ? { notionalUsd: policyDecision.notionalUsd } : {}),
      ...("estimatedLiquidationPx" in flatRisk && flatRisk.estimatedLiquidationPx
        ? { estimatedLiquidationPx: flatRisk.estimatedLiquidationPx }
        : {}),
    };
  } catch (err) {
    // Bounded diagnostics only — never log params, addresses, or amounts.
    logger.warn("hyperliquid.protection_gate.error", {
      toolId,
      coin,
      errorClass: err instanceof Error ? err.constructor.name : "unknown",
      cause: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
    });
    return { kind: "block", message: "Hyperliquid live protection and policy state could not be verified. Retry when account data is available." };
  }
}

/**
 * Conservative flat-account estimate used before HyperCore can report a live
 * liquidation price. Research assumption from the approved plan: maintenance
 * margin rate is half the initial-margin rate at the asset's max leverage.
 * Thus mmr=1/(2*maxLeverage), and isolated liquidation is approximated from
 * entry*(1 ∓ 1/leverage ± mmr). This is a safety gate, not a quoted guarantee.
 */
export function evaluateFlatOpenLiquidation(
  params: Record<string, unknown>,
  state: unknown,
  assetMaxLeverage: number,
  maintenanceHeadroomFloor: number,
): { readonly kind: "allow"; readonly estimatedLiquidationPx: string } | { readonly kind: "block"; readonly message: string } {
  const side = stringParam(params, "side");
  const priceRaw = stringParam(params, "price");
  const sizeRaw = stringParam(params, "size");
  const slRaw = stringParam(params, "slPrice");
  const leverage = numberParam(params, "leverage");
  if ((side !== "long" && side !== "short") || priceRaw === undefined || sizeRaw === undefined || leverage === undefined) {
    return { kind: "block", message: "Cannot estimate liquidation without side, price, size, and leverage." };
  }
  try {
    const price = new Decimal(parseDecimalString(priceRaw));
    const size = new Decimal(parseDecimalString(sizeRaw));
    const mmr = new Decimal(1).div(new Decimal(assetMaxLeverage).mul(2));
    const initialMarginRate = new Decimal(1).div(leverage);
    const liquidation = side === "long"
      ? price.mul(new Decimal(1).minus(initialMarginRate).plus(mmr))
      : price.mul(new Decimal(1).plus(initialMarginRate).minus(mmr));
    if (liquidation.lte(0)) return { kind: "block", message: "Estimated liquidation price is invalid for this leverage." };
    if (slRaw !== undefined) {
      const stop = new Decimal(parseDecimalString(slRaw));
      if ((side === "long" && stop.lte(liquidation)) || (side === "short" && stop.gte(liquidation))) {
        return { kind: "block", message: "Stop-loss is beyond the conservative estimated liquidation price." };
      }
    }
    const accountValue = accountValueUsd(state);
    if (accountValue === null) return { kind: "block", message: "Cannot verify maintenance headroom for a new position." };
    const maintenanceRequired = price.mul(size).mul(mmr);
    if (accountValue.lt(maintenanceRequired.mul(maintenanceHeadroomFloor))) {
      return { kind: "block", message: "New position would breach the configured maintenance-margin headroom floor." };
    }
    return { kind: "allow", estimatedLiquidationPx: liquidation.toFixed() };
  } catch {
    return { kind: "block", message: "Could not compute a conservative initial liquidation estimate." };
  }
}

/** Phase-5 egress callers will use this collateral invariant. No transfer manifest exists yet. */
export function validateCollateralSensitiveAction(
  snapshots: readonly PositionProtectionSnapshot[],
  maintenanceHeadroom: string,
  maintenanceRequired: string,
  floor: number,
): string | null {
  if (snapshots.some((snapshot) => snapshot.state === "UNPROTECTED" || snapshot.state === "PARTIAL")) return "Collateral action is blocked while an open perp lacks full stop-loss coverage.";
  try {
    const headroom = finiteNonNegativeRiskDecimal(maintenanceHeadroom, "Maintenance headroom");
    const required = finiteNonNegativeRiskDecimal(maintenanceRequired, "Maintenance margin");
    if (headroom.lt(required.mul(floor))) return "Collateral action would breach the configured maintenance-margin headroom floor.";
  } catch {
    return "Collateral action is blocked because risk values must be finite non-negative decimals.";
  }
  return null;
}

/**
 * Collateral-reducing operations share the protection invariant. We only
 * permit an outbound amount when the post-transfer account value still clears
 * the configured maintenance floor and every open position has full coverage.
 * The provider exposes no hypothetical-liq endpoint, so this gate refuses an
 * action if the current state cannot prove those conservative conditions.
 */
export async function evaluateHyperliquidCollateralGate(
  toolId: string,
  params: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<{ readonly kind: "allow" } | { readonly kind: "block"; readonly message: string } | null> {
  const reducesPerpCollateral = toolId === "hyperliquid.transfer.usdClass"
    ? params.toPerp === false
    : toolId === "hyperliquid.withdraw" || toolId === "hyperliquid.transfer.send"
      || (toolId === "hyperliquid.vault.transfer" && params.isDeposit === true);
  if (!reducesPerpCollateral) return null;
  if (context.hyperliquidPolicy?.kind !== "available") {
    return { kind: "block", message: "Hyperliquid trading policy is unavailable." };
  }
  const rawAmount = stringParam(params, "amount");
  if (rawAmount === undefined) return { kind: "block", message: "Collateral action requires a canonical amount." };
  try {
    const amount = new Decimal(parseDecimalString(rawAmount));
    const wallet = await import("../../internal/wallet/resolve.js");
    const address = wallet.resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155");
    const info = new HyperliquidInfoClient({ network: resolveHyperliquidNetwork() });
    const [state, orders] = await Promise.all([info.clearinghouseState(address), info.frontendOpenOrders(address)]);
    const live = parseLiveProtectionState(state, orders);
    const openPositions = positionsFromState(live.clearinghouseState);
    if (openPositions.length === 0) return { kind: "allow" };
    const snapshots = openPositions.map((position) => buildPositionProtectionSnapshot(live.clearinghouseState, live.frontendOpenOrders, position.coin));
    const accountValue = accountValueUsd(live.clearinghouseState);
    const maintenance = maintenanceMarginUsd(live.clearinghouseState);
    if (accountValue === null || maintenance === null) {
      return { kind: "block", message: "Cannot verify post-transfer maintenance headroom while perpetual positions are open." };
    }
    const postActionValue = accountValue.minus(amount);
    const failure = validateCollateralSensitiveAction(
      snapshots,
      postActionValue.toFixed(),
      maintenance.toFixed(),
      context.hyperliquidPolicy.snapshot.policy.maintenanceHeadroomFloor,
    );
    return failure === null ? { kind: "allow" } : { kind: "block", message: failure };
  } catch {
    return { kind: "block", message: "Collateral action is blocked because protected perp margin could not be verified." };
  }
}

export function evaluateProtectionInvariant(toolId: string, params: Record<string, unknown>, snapshot: PositionProtectionSnapshot, requireStopLoss: boolean): { kind: "allow"; stopLossVerdict: StopLossVerdict } | { kind: "block"; message: string } {
  if (toolId === "hyperliquid.perp.open") {
    const side = stringParam(params, "side");
    const price = stringParam(params, "price");
    const size = stringParam(params, "size");
    const slPrice = stringParam(params, "slPrice");
    if (side !== "long" && side !== "short") return { kind: "block", message: "Perp open side must be long or short." };
    if (!price || !size) return { kind: "block", message: "Perp open requires canonical price and size." };
    try { parseDecimalString(price); parseDecimalString(size); } catch { return { kind: "block", message: "Perp price and size must be canonical positive decimal strings." }; }
    if (!new Decimal(snapshot.positionSize).isZero() && !hasStandingFullPositionStop(snapshot)) {
      return { kind: "block", message: "Scale-in is blocked until the existing position has a consolidated full-position stop-loss. Use perp.setTpsl first." };
    }
    if (slPrice === undefined) {
      return requireStopLoss
        ? { kind: "block", message: "A stop-loss is required by the current Hyperliquid policy." }
        : { kind: "allow", stopLossVerdict: "unprotected_by_user_choice" };
    }
    try { parseDecimalString(slPrice); } catch { return { kind: "block", message: "Stop-loss price must be a canonical positive decimal string." }; }
    if ((side === "long" && new Decimal(slPrice).gte(price)) || (side === "short" && new Decimal(slPrice).lte(price))) {
      return { kind: "block", message: "Stop-loss must be below a long entry or above a short entry." };
    }
    if (snapshot.state !== "FLAT" && stopIsBeyondLiquidation(snapshot, slPrice)) return { kind: "block", message: "Stop-loss is beyond the estimated liquidation price." };
    return { kind: "allow", stopLossVerdict: "protected_required" };
  }
  if (toolId === "hyperliquid.perp.modifyOrder" && params.reduceOnly !== true && !new Decimal(snapshot.positionSize).isZero() && !hasStandingFullPositionStop(snapshot)) {
    return { kind: "block", message: "A non-reduce-only order is blocked until the existing position has a consolidated full-position stop-loss." };
  }
  if (toolId === "hyperliquid.perp.twap" && !hasStandingFullPositionStop(snapshot)) return { kind: "block", message: "TWAP requires a standing full-position reduce-only stop-loss." };
  if (toolId === "hyperliquid.perp.cancelOrders" && isSoleProtectiveOrder(snapshot, numberParam(params, "oid") ?? -1)) return { kind: "block", message: "Refusing to cancel the sole protective stop for this open position." };
  if (toolId === "hyperliquid.perp.setTpsl") {
    const slPrice = stringParam(params, "slPrice");
    if (!slPrice) return { kind: "block", message: "A replacement full-position stop-loss price is required." };
    try { parseDecimalString(slPrice); } catch { return { kind: "block", message: "Stop-loss price must be a canonical positive decimal string." }; }
    if (stopIsBeyondLiquidation(snapshot, slPrice)) return { kind: "block", message: "Stop-loss is beyond the estimated liquidation price." };
  }
  if ((toolId === "hyperliquid.perp.setLeverage" || toolId === "hyperliquid.perp.adjustMargin") && snapshot.state !== "FLAT" && !hasStandingFullPositionStop(snapshot)) {
    return { kind: "block", message: "Leverage or margin cannot change until this open position has a full-position stop-loss." };
  }
  return { kind: "allow", stopLossVerdict: "protected_required" };
}

export function evaluatePerpPolicy(params: Record<string, unknown>, state: unknown, assetMaxLeverage: number, policy: HyperliquidPolicy): { kind: "allow"; notionalUsd?: string } | { kind: "block"; message: string } {
  const leverage = numberParam(params, "leverage");
  if (leverage !== undefined) {
    const cap = Math.min(policy.leverageCapDefault, assetMaxLeverage);
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > cap) return { kind: "block", message: `Leverage must be an integer from 1 to ${cap}x for this policy and market.` };
  }
  const size = stringParam(params, "size");
  const price = stringParam(params, "price");
  if (size === undefined || price === undefined) return { kind: "allow" };
  try {
    const notional = new Decimal(parseDecimalString(size)).mul(parseDecimalString(price));
    const accountValue = accountValueUsd(state);
    if (accountValue === null) return { kind: "block", message: "Cannot verify account value for perpetual risk limits." };
    const perOrderCap = accountValue.mul(policy.perOrderNotionalPct).div(100);
    if (notional.gt(perOrderCap)) return { kind: "block", message: `Order notional exceeds the ${policy.perOrderNotionalPct}% per-order cap.` };
    const totalCap = accountValue.mul(policy.totalNotionalPct).div(100);
    if (existingPositionNotional(state).plus(notional).gt(totalCap)) return { kind: "block", message: `Total perp notional would exceed the ${policy.totalNotionalPct}% cap.` };
    const maintenance = maintenanceMarginUsd(state);
    if (maintenance === null) return { kind: "block", message: "Cannot verify maintenance margin for perpetual risk limits." };
    if (accountValue.lt(maintenance.mul(policy.maintenanceHeadroomFloor))) return { kind: "block", message: "Account does not meet the configured maintenance-margin headroom floor." };
    return { kind: "allow", notionalUsd: notional.toFixed() };
  } catch { return { kind: "block", message: "Policy could not validate canonical notional values." }; }
}

async function validateL2Slippage(toolId: string, params: Record<string, unknown>, info: HyperliquidInfoClient, maxSlippagePct: number): Promise<{ kind: "allow" } | { kind: "block"; message: string }> {
  if (toolId !== "hyperliquid.perp.open" && toolId !== "hyperliquid.perp.twap") return { kind: "allow" };
  const coin = stringParam(params, "coin"); const size = stringParam(params, "size"); const price = stringParam(params, "price"); const side = stringParam(params, "side");
  const expectedSides = toolId === "hyperliquid.perp.open" ? ["long", "short"] : ["buy", "sell"];
  if (!coin || !size || !price || !expectedSides.includes(side ?? "")) return { kind: "block", message: "Cannot estimate order-book slippage without coin, side, size, and price." };
  const book = await info.l2Book(coin);
  // hl_open submits a GTC LIMIT order at `price` (perp-handlers openPerp): its
  // fills can never be worse than that limit, and depth priced beyond it simply
  // rests, so the walk is capped at the limit. hl_twap is a MARKET sweep
  // (twapOrder, no limit) whose `price` is only the mid reference synthesized by
  // withMidPrice, so its walk is uncapped and slippage is measured against that
  // mid. Passing null here selects the uncapped-sweep semantics.
  const limitPrice = toolId === "hyperliquid.perp.open" ? price : null;
  const estimate = estimateSlippagePct(book, size, price, side === "long" || side === "buy" ? "buy" : "sell", limitPrice);
  if (estimate === null) return { kind: "block", message: "Insufficient L2 liquidity to safely estimate this order's slippage." };
  return estimate.gt(maxSlippagePct) ? { kind: "block", message: `Estimated L2 slippage ${estimate.toFixed()}% exceeds the ${maxSlippagePct}% policy cap.` } : { kind: "allow" };
}

async function withMidPrice(params: Record<string, unknown>, info: HyperliquidInfoClient, coin: string): Promise<Record<string, unknown>> {
  const mids = asRecord(await info.allMids());
  const mid = stringParam(mids ?? {}, coin);
  if (mid === undefined) throw new Error("No Hyperliquid mid price for TWAP market.");
  // Venue wire value: an allMids price legitimately carries trailing zeros
  // ("20.0"). Normalize to canonical form here, because the price then flows
  // into policy and slippage checks that DO require canonical model/user input.
  // Passing the raw venue string onward would make those checks throw.
  return { ...params, price: normalizeProviderDecimal(mid, "Hyperliquid mid price") };
}

/**
 * Adverse-only L2 slippage estimate for a perp order, in percent.
 *
 * Two order shapes flow through here, distinguished by `limitPrice`:
 *  - LIMIT order (hl_open, `limitPrice` = the limit): a resting GTC limit can
 *    never fill worse than its limit, and any depth priced beyond the limit
 *    simply RESTS — it is not slippage. The walk therefore consumes only levels
 *    at-or-better than the limit (buy: px <= limit; sell: px >= limit). If the
 *    fillable depth is short of `size`, the remainder rests; if NOTHING is
 *    fillable within the limit the whole order rests and slippage is 0. Because
 *    every consumed level is at-or-better than the limit, the crossing average
 *    is at-or-better than the reference and adverse slippage is 0 by
 *    construction — the limit price itself is the protection.
 *  - MARKET sweep (hl_twap, `limitPrice` = null): the sweep crosses the book,
 *    so the walk is uncapped and the average is measured against `referencePrice`
 *    (the mid synthesized by withMidPrice). This is where a genuine positive
 *    estimate can arise and the policy cap still bites.
 *
 * Slippage is ADVERSE-ONLY and directional: buy => max(0, avg - reference),
 * sell => max(0, reference - avg), each over `reference`. It is NOT an absolute
 * deviation. The previous `abs()` form treated a favorable (price-improving)
 * fill as slippage: in the 2026-07-13 CASHCAT incident a buy limit of 0.154
 * into a book with best ask ~0.15063 was scored 2.1883% and blocked despite the
 * fill being BETTER than the limit. That single flaw produced four consecutive
 * false-positive blocks with non-monotonic readings (smaller orders scored as
 * more slippage). Malformed/unreadable books still return null so the caller
 * fails closed.
 */
export function estimateSlippagePct(book: unknown, size: string, referencePrice: string, side: "buy" | "sell", limitPrice: string | null): Decimal | null {
  const root = asRecord(book); const levels = Array.isArray(root?.levels) ? root.levels : null;
  if (levels === null || levels.length < 2) return null;
  const selected = side === "buy" ? levels[1] : levels[0];
  if (!Array.isArray(selected)) return null;
  // `size`, `referencePrice`, and `limitPrice` are model/user params — canonical.
  const orderSize = new Decimal(parseDecimalString(size));
  const reference = new Decimal(parseDecimalString(referencePrice));
  const limit = limitPrice === null ? null : new Decimal(parseDecimalString(limitPrice));
  let remaining = orderSize; let paid = new Decimal(0); let filled = new Decimal(0);
  for (const level of selected) {
    const record = asRecord(level);
    // Book px/sz are VENUE wire values and legitimately carry trailing zeros
    // (e.g. "1509.0" on a szDecimals=0 market like CASHCAT), which canonical
    // parsing rejects; parse them leniently. A level we would need to consume
    // but cannot read is a malformed book — fail closed with null rather than
    // silently under-reporting fillable depth.
    const levelPx = venueNonNegativeDecimal(stringParam(record ?? {}, "px"));
    const levelSz = venueNonNegativeDecimal(stringParam(record ?? {}, "sz"));
    if (levelPx === null || levelSz === null) return null;
    // Depth priced beyond a limit order's limit rests; stop the walk there.
    if (limit !== null && (side === "buy" ? levelPx.gt(limit) : levelPx.lt(limit))) break;
    const take = Decimal.min(remaining, levelSz);
    paid = paid.plus(take.mul(levelPx)); filled = filled.plus(take); remaining = remaining.minus(take);
    if (remaining.isZero()) break;
  }
  if (filled.isZero()) {
    // Limit order with nothing fillable at-or-better than the limit: the whole
    // order rests, no adverse fill, slippage 0. A market sweep against a book
    // with no liquidity on the crossing side cannot be estimated — fail closed.
    return limit === null ? null : new Decimal(0);
  }
  const average = paid.div(filled);
  const adverse = side === "buy" ? average.minus(reference) : reference.minus(average);
  return Decimal.max(0, adverse).div(reference).mul(100);
}

/** Lenient parse for a single venue-emitted decimal (trailing zeros allowed); null when absent or malformed. */
function venueNonNegativeDecimal(value: string | undefined): Decimal | null {
  if (value === undefined) return null;
  try {
    const decimal = new Decimal(value);
    return decimal.isFinite() && decimal.gte(0) ? decimal : null;
  } catch {
    return null;
  }
}

function accountValueUsd(state: unknown): Decimal | null { const summary = asRecord(asRecord(state)?.marginSummary) ?? asRecord(asRecord(state)?.crossMarginSummary); const value = stringParam(summary ?? {}, "accountValue"); return value === undefined ? null : finiteNonNegativeRiskDecimal(value, "Account value"); }
function maintenanceMarginUsd(state: unknown): Decimal | null { const summary = asRecord(asRecord(state)?.marginSummary) ?? asRecord(asRecord(state)?.crossMarginSummary); const value = stringParam(summary ?? {}, "totalMarginUsed"); return value === undefined ? null : finiteNonNegativeRiskDecimal(value, "Maintenance margin"); }
function existingPositionNotional(state: unknown): Decimal {
  const positions = unknownArray(asRecord(state)?.assetPositions);
  return positions.reduce<Decimal>((total, item) => {
    const position = asRecord(asRecord(item)?.position) ?? asRecord(item);
    const size = stringParam(position ?? {}, "szi");
    if (size === undefined || new Decimal(size).isZero()) return total;
    const value = stringParam(position ?? {}, "positionValue");
    if (value === undefined) throw new Error("Open position is missing position value.");
    return total.plus(finiteNonNegativeRiskDecimal(value, "Position value"));
  }, new Decimal(0));
}
function positionsFromState(state: unknown): readonly { readonly coin: string }[] {
  const records = unknownArray(asRecord(state)?.assetPositions);
  const positions: { coin: string }[] = [];
  for (const item of records) {
    const position = asRecord(asRecord(item)?.position) ?? asRecord(item);
    const coin = stringParam(position ?? {}, "coin");
    const size = stringParam(position ?? {}, "szi");
    if (coin !== undefined && size !== undefined && !new Decimal(size).isZero()) positions.push({ coin });
  }
  return positions;
}
function finiteNonNegativeRiskDecimal(value: string, label: string): Decimal {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error(`${label} must be a finite non-negative decimal.`);
  const decimal = new Decimal(value);
  if (!decimal.isFinite() || decimal.lt(0)) throw new Error(`${label} must be a finite non-negative decimal.`);
  return decimal;
}
function stringParam(params: Record<string, unknown>, key: string): string | undefined { return typeof params[key] === "string" ? params[key] : undefined; }
function numberParam(params: Record<string, unknown>, key: string): number | undefined { return typeof params[key] === "number" ? params[key] : undefined; }
function asRecord(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function unknownArray(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }
