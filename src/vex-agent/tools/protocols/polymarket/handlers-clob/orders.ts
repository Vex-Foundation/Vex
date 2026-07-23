/**
 * Polymarket CLOB handlers — order/trading (authenticated).
 *
 * Buy/sell place EIP-712-signed orders; cancel variants and order lookups
 * require the selected/signing wallet. HMAC-SHA256 auth + order signing.
 */

import { getPolyClobClient } from "@tools/polymarket/clob/client.js";
import { buildClobOrder, signClobOrder } from "@tools/polymarket/clob/signing.js";
import { requirePolyClobCredentials } from "@tools/polymarket/auth.js";
import { getPolyGammaClient } from "@tools/polymarket/gamma/client.js";
import { USDC_E_DECIMALS } from "@tools/polymarket/constants.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import { parseClobTokenIds } from "@tools/polymarket/helpers.js";
import { type Hex, getAddress } from "viem";
import type { OrderBookSummary } from "@tools/polymarket/clob/types.js";
import type { ProtocolHandler } from "../../types.js";
import { str, num, ok, fail } from "../../handler-helpers.js";
import { splitIds } from "./helpers.js";

function usdcToBaseUnits(amount: number): string {
  return Math.round(amount * 10 ** USDC_E_DECIMALS).toString();
}
function calcAmounts(side: "BUY" | "SELL", amount: number, price: number): { makerAmount: string; takerAmount: string } {
  if (side === "BUY") {
    return { makerAmount: usdcToBaseUnits(amount * price), takerAmount: usdcToBaseUnits(amount) };
  }
  return { makerAmount: usdcToBaseUnits(amount), takerAmount: usdcToBaseUnits(amount * price) };
}

/**
 * Positive finite level price, or null. Used by best-bid/ask so a single
 * garbage level cannot poison min/max over the book.
 */
function positiveLevelPrice(level: { price: string } | undefined): number | null {
  if (!level) return null;
  const n = Number(level.price);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Best ask = lowest sell offer. Min over levels (sort-order independent).
 * Polymarket REST books have historically arrived worst-first; never trust
 * index 0 / last without min/max.
 */
export function bestAskFromBook(
  asks: OrderBookSummary["asks"] | undefined,
): number | null {
  if (!asks?.length) return null;
  let best: number | null = null;
  for (const level of asks) {
    const p = positiveLevelPrice(level);
    if (p === null) continue;
    if (best === null || p < best) best = p;
  }
  return best;
}

/**
 * Best bid = highest buy offer. Max over levels (sort-order independent).
 */
export function bestBidFromBook(
  bids: OrderBookSummary["bids"] | undefined,
): number | null {
  if (!bids?.length) return null;
  let best: number | null = null;
  for (const level of bids) {
    const p = positiveLevelPrice(level);
    if (p === null) continue;
    if (best === null || p > best) best = p;
  }
  return best;
}

/**
 * Omit-price "market" take price from the order book.
 *
 * BUY must take the **best ask**; SELL must take the **best bid**.
 * Do NOT use `getPrice(side)` for this: on the live CLOB, `getPrice("BUY")`
 * returns the best **bid** and `getPrice("SELL")` the best **ask** — the
 * resting side, not the taking side. Using those prices posts a passive
 * limit that does not cross the spread (market intent → wrong-side rest).
 */
export function marketTakePriceFromBook(
  book: Pick<OrderBookSummary, "bids" | "asks">,
  side: "BUY" | "SELL",
): number | null {
  return side === "BUY" ? bestAskFromBook(book.asks) : bestBidFromBook(book.bids);
}

// ── Trading (authenticated) ───────────────────────────────────

export const ORDERS_HANDLERS: Record<string, ProtocolHandler> = {
  "polymarket.clob.buy": async (p, ctx) => {
    const conditionId = str(p, "conditionId"), outcomeRaw = str(p, "outcome");
    const amount = num(p, "amount");
    if (!conditionId || !outcomeRaw || amount == null) return fail("Missing required: conditionId, outcome, amount");
    if (amount <= 0) return fail("Amount must be positive");

    const outcome = outcomeRaw.toUpperCase() === "YES" ? "YES" : "NO";
    const market = await getPolyGammaClient().resolveMarket(conditionId);
    const tokens = parseClobTokenIds(market.clobTokenIds);
    const tokenId = outcome === "YES" ? tokens.yes : tokens.no;
    if (!tokenId) return fail(`No ${outcome} token found for market ${conditionId}`);

    const clob = getPolyClobClient();
    let price = num(p, "price") ?? null;
    if (price === null) {
      // Market buy = take best ask from the book (not getPrice("BUY") / bid).
      const ob = await clob.getOrderBook(tokenId);
      price = marketTakePriceFromBook(ob, "BUY");
    }
    if (!price || price <= 0) return fail(`Cannot determine price for ${outcome} token — price is ${price}. Market may be illiquid or closed.`);
    const shares = amount / price;

    if (p.dryRun === true) {
      return ok({ dryRun: true, conditionId, outcome, amount, price, shares: shares.toFixed(2), tokenId, question: market.question });
    }

    // Session order (5D-protocols p3 / B-core-2 reorder): resolve the selected
    // address (no decrypt) -> require creds for it -> only THEN resolve+decrypt
    // the signing key -> assert it matches. Missing creds fail BEFORE the key is
    // ever decrypted; the assert guards against resolver drift.
    let address: string;
    try {
      address = resolveSelectedAddress(ctx.walletResolution, ctx.walletPolicy, "eip155");
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    const creds = requirePolyClobCredentials(address);

    let signer: ChainWallet;
    try {
      signer = resolveSigningWallet(ctx.walletResolution, ctx.walletPolicy, "eip155");
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");
    if (getAddress(signer.address) !== getAddress(address)) {
      return fail("Resolved signer does not match the selected wallet.");
    }
    const feeRate = await clob.getFeeRate(tokenId);
    const { makerAmount, takerAmount } = calcAmounts("BUY", shares, price);
    const orderData = buildClobOrder({ maker: signer.address, signer: signer.address, tokenId, makerAmount, takerAmount, side: "BUY", feeRateBps: String(feeRate.base_fee) });
    const signature = await signClobOrder(signer.privateKey as Hex, orderData, market.negRisk ?? false);

    const result = await clob.postOrder({ address: signer.address }, {
      order: { ...orderData, signature },
      owner: creds.apiKey,
      orderType: (str(p, "orderType") || "GTC") as "GTC" | "FOK" | "GTD" | "FAK",
      deferExec: p.deferExec === true ? true : undefined,
    });

    const isMatched = result.status === "matched";
    // Lean output literal (money-moving correctness): build from result+params
    // instead of spreading the whole SendOrderResponse. Drop the empty `errorMsg`
    // field; surface an explicit `filled` boolean derived from order status.
    const buyOutput = {
      orderID: result.orderID,
      status: result.status,
      success: result.success,
      filled: isMatched,
      conditionId,
      outcome,
      amount,
      price,
      ...(result.makingAmount !== undefined ? { makingAmount: result.makingAmount } : {}),
      ...(result.takingAmount !== undefined ? { takingAmount: result.takingAmount } : {}),
      ...(result.transactionsHashes?.length ? { transactionsHashes: result.transactionsHashes } : {}),
      ...(result.tradeIDs?.length ? { tradeIDs: result.tradeIDs } : {}),
      ...(result.errorMsg ? { errorMsg: result.errorMsg } : {}),
    };

    // The venue rejected the order (bad signature, insufficient balance,
    // market closed, etc.). Fail the ToolResult and skip _tradeCapture — an
    // order the CLOB never accepted must not be recorded as a resting/open
    // order. Same class of bug as relay.bridge: venue truth must drive
    // tool-result truth, not just ride along in the output text.
    if (!result.success) {
      return {
        success: false,
        output: JSON.stringify(buyOutput, null, 2),
        data: { ...result, conditionId },
      };
    }

    return {
      success: true,
      output: JSON.stringify(buyOutput, null, 2),
      data: { ...result, conditionId, _tradeCapture: {
        type: isMatched ? "prediction" : "order",
        chain: "polygon",
        status: isMatched ? "executed" : "open",
        inputToken: "USDC", outputToken: `${outcome}@${conditionId.slice(0, 8)}`,
        inputAmount: String(amount), walletAddress: signer.address, tradeSide: "buy",
        positionKey: isMatched ? `polymarket:${conditionId}:${outcome}` : result.orderID,
        instrumentKey: `polymarket:${conditionId}:${outcome}`,
        ...(isMatched ? { inputValueUsd: String(amount), unitPriceUsd: String(price), valuationSource: "polymarket_exact" } : { valuationSource: "none" }),
        settlementAssetKey: "USDC",
        meta: { dex: "polymarket", conditionId, outcome, price, orderID: result.orderID, contracts: String(shares), tokenId },
      } },
    };
  },

  "polymarket.clob.sell": async (p, ctx) => {
    const conditionId = str(p, "conditionId"), outcomeRaw = str(p, "outcome");
    const shares = num(p, "amount");
    if (!conditionId || !outcomeRaw || shares == null) return fail("Missing required: conditionId, outcome, amount");
    if (shares <= 0) return fail("Amount must be positive");

    const outcome = outcomeRaw.toUpperCase() === "YES" ? "YES" : "NO";
    const market = await getPolyGammaClient().resolveMarket(conditionId);
    const tokens = parseClobTokenIds(market.clobTokenIds);
    const tokenId = outcome === "YES" ? tokens.yes : tokens.no;
    if (!tokenId) return fail(`No ${outcome} token found for market ${conditionId}`);

    const clob = getPolyClobClient();
    let price = num(p, "price") ?? null;
    if (price === null) {
      // Market sell = take best bid from the book (not getPrice("SELL") / ask).
      const ob = await clob.getOrderBook(tokenId);
      price = marketTakePriceFromBook(ob, "SELL");
    }
    if (!price || price <= 0) return fail(`Cannot determine price for ${outcome} token — price is ${price}. Market may be illiquid or closed.`);

    if (p.dryRun === true) {
      return ok({ dryRun: true, conditionId, outcome, shares, price, usdcValue: (shares * price).toFixed(2), tokenId, question: market.question });
    }

    // Session order (5D-protocols p3 / B-core-2 reorder): resolve the selected
    // address (no decrypt) -> require creds for it -> only THEN resolve+decrypt
    // the signing key -> assert it matches. Missing creds fail BEFORE the key is
    // ever decrypted; the assert guards against resolver drift.
    let address: string;
    try {
      address = resolveSelectedAddress(ctx.walletResolution, ctx.walletPolicy, "eip155");
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    const creds = requirePolyClobCredentials(address);

    let signer: ChainWallet;
    try {
      signer = resolveSigningWallet(ctx.walletResolution, ctx.walletPolicy, "eip155");
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    if (signer.family !== "eip155") return fail("Resolved wallet family mismatch.");
    if (getAddress(signer.address) !== getAddress(address)) {
      return fail("Resolved signer does not match the selected wallet.");
    }
    const feeRate = await clob.getFeeRate(tokenId);
    const { makerAmount, takerAmount } = calcAmounts("SELL", shares, price);
    const orderData = buildClobOrder({ maker: signer.address, signer: signer.address, tokenId, makerAmount, takerAmount, side: "SELL", feeRateBps: String(feeRate.base_fee) });
    const signature = await signClobOrder(signer.privateKey as Hex, orderData, market.negRisk ?? false);

    const result = await clob.postOrder({ address: signer.address }, { order: { ...orderData, signature }, owner: creds.apiKey, orderType: (str(p, "orderType") || "GTC") as "GTC" | "FOK" | "GTD" | "FAK", deferExec: p.deferExec === true ? true : undefined });

    const isMatched = result.status === "matched";
    // Lean output literal (money-moving correctness, P1-10): mirror the buy
    // handler — build from result+params instead of spreading the whole
    // SendOrderResponse. Drop the empty `errorMsg`; surface an explicit
    // `filled` boolean derived from order status. `amount` carries the sell
    // size (shares), matching the buy handler's `amount` field.
    const sellOutput = {
      orderID: result.orderID,
      status: result.status,
      success: result.success,
      filled: isMatched,
      conditionId,
      outcome,
      amount: shares,
      price,
      ...(result.makingAmount !== undefined ? { makingAmount: result.makingAmount } : {}),
      ...(result.takingAmount !== undefined ? { takingAmount: result.takingAmount } : {}),
      ...(result.transactionsHashes?.length ? { transactionsHashes: result.transactionsHashes } : {}),
      ...(result.tradeIDs?.length ? { tradeIDs: result.tradeIDs } : {}),
      ...(result.errorMsg ? { errorMsg: result.errorMsg } : {}),
    };

    // Same rejection guard as clob.buy: the venue rejected the order, so the
    // ToolResult must fail and no _tradeCapture goes out. Mirrors the repo's
    // own clob.cancel precedent a few lines below ("reports success=false
    // when the requested order lands in not_canceled").
    if (!result.success) {
      return {
        success: false,
        output: JSON.stringify(sellOutput, null, 2),
        data: { ...result, conditionId },
      };
    }

    return {
      success: true,
      output: JSON.stringify(sellOutput, null, 2),
      data: { ...result, conditionId, _tradeCapture: {
        type: isMatched ? "prediction" : "order",
        chain: "polygon",
        status: isMatched ? "closed" : "open",
        outputToken: "USDC", inputToken: `${outcome}@${conditionId.slice(0, 8)}`,
        inputAmount: String(shares), walletAddress: signer.address, tradeSide: "sell",
        positionKey: isMatched ? `polymarket:${conditionId}:${outcome}` : result.orderID,
        instrumentKey: `polymarket:${conditionId}:${outcome}`,
        ...(isMatched ? { outputValueUsd: String(shares * price), unitPriceUsd: String(price), valuationSource: "polymarket_exact" } : { valuationSource: "none" }),
        settlementAssetKey: "USDC",
        meta: { dex: "polymarket", conditionId, outcome, price, orderID: result.orderID, contracts: String(shares), tokenId },
      } },
    };
  },

  "polymarket.clob.cancel": async (p, ctx) => {
    const orderId = str(p, "orderId");
    if (!orderId) return fail("Missing required: orderId");
    let address: string;
    try {
      address = resolveSelectedAddress(ctx.walletResolution, ctx.walletPolicy, "eip155");
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    const result = await getPolyClobClient().cancelOrder({ address }, orderId);
    // Correctness guard (money-moving): the CLOB returns 200 even when the
    // requested order was NOT cancelled — it lands in `not_canceled` with a
    // reason. Treat that as a failure instead of reporting silent success.
    const cancelReason = result.not_canceled?.[orderId];
    const cancelled = cancelReason === undefined;
    if (!cancelled) {
      return {
        success: false,
        output: JSON.stringify({ ...result, orderId, cancelled: false, reason: cancelReason }, null, 2),
        data: { ...result, orderId, cancelled: false },
      };
    }
    return { success: true, output: JSON.stringify({ ...result, orderId, cancelled: true }, null, 2), data: { ...result, orderId, cancelled: true, _tradeCapture: { type: "order", chain: "polygon", status: "cancelled", walletAddress: address, positionKey: orderId, meta: { action: "cancel" } } } };
  },

  "polymarket.clob.cancelOrders": async (p, ctx) => {
    const raw = str(p, "orderIds");
    if (!raw) return fail("Missing required: orderIds");
    const ids = splitIds(raw);
    if (ids.length === 0) return fail("No valid order IDs provided");
    let address: string;
    try {
      address = resolveSelectedAddress(ctx.walletResolution, ctx.walletPolicy, "eip155");
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    const result = await getPolyClobClient().cancelOrders({ address }, ids);
    // Same not_canceled correctness guard as clob.cancel, extended to N ids:
    // the venue can return 200 while rejecting every requested cancellation.
    // A total rejection (nothing cancelled, venue reported reasons) is a real
    // failure — no _tradeCapture. A partial success keeps the ledger trace for
    // the ids that DID cancel (captureItems only ever covers result.canceled).
    if (result.canceled.length === 0 && Object.keys(result.not_canceled).length > 0) {
      return { success: false, output: JSON.stringify(result, null, 2), data: { ...result } };
    }
    const captureItems = result.canceled.map(oid => ({
      type: "order" as const, chain: "polygon" as const, status: "cancelled" as const,
      walletAddress: address, positionKey: oid, meta: { action: "cancel" },
    }));
    return {
      success: true,
      output: JSON.stringify(result, null, 2),
      data: {
        ...result,
        ...(result.canceled.length > 0
          ? { _tradeCapture: { type: "order", chain: "polygon", status: "cancelled", walletAddress: address, meta: { action: "cancelOrders", count: result.canceled.length } }, _tradeCaptureItems: captureItems }
          : {}),
      },
    };
  },

  "polymarket.clob.cancelAll": async (_p, ctx) => {
    let address: string;
    try {
      address = resolveSelectedAddress(ctx.walletResolution, ctx.walletPolicy, "eip155");
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    const result = await getPolyClobClient().cancelAll({ address });
    // Same not_canceled correctness guard as cancelOrders. "Nothing to cancel"
    // (both canceled and not_canceled empty — no open orders) is a legitimate
    // no-op success, not a failure; a total rejection (venue reported reasons,
    // nothing cancelled) is.
    if (result.canceled.length === 0 && Object.keys(result.not_canceled).length > 0) {
      return { success: false, output: JSON.stringify(result, null, 2), data: { ...result } };
    }
    const captureItems = result.canceled.map(oid => ({
      type: "order" as const, chain: "polygon" as const, status: "cancelled" as const,
      walletAddress: address, positionKey: oid, meta: { action: "cancel" },
    }));
    return {
      success: true,
      output: JSON.stringify(result, null, 2),
      data: {
        ...result,
        ...(captureItems.length > 0
          ? { _tradeCapture: { type: "order", chain: "polygon", status: "cancelled", walletAddress: address, meta: { action: "cancelAll", count: result.canceled.length } }, _tradeCaptureItems: captureItems }
          : {}),
      },
    };
  },

  "polymarket.clob.cancelMarket": async (p, ctx) => {
    const market = str(p, "market"), assetId = str(p, "assetId");
    if (!market || !assetId) return fail("Missing required: market, assetId");
    let address: string;
    try {
      address = resolveSelectedAddress(ctx.walletResolution, ctx.walletPolicy, "eip155");
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    const result = await getPolyClobClient().cancelMarketOrders({ address }, market, assetId);
    // Same not_canceled correctness guard as cancelOrders/cancelAll.
    if (result.canceled.length === 0 && Object.keys(result.not_canceled).length > 0) {
      return { success: false, output: JSON.stringify(result, null, 2), data: { ...result, conditionId: market } };
    }
    const captureItems = result.canceled.map(oid => ({
      type: "order" as const, chain: "polygon" as const, status: "cancelled" as const,
      walletAddress: address, positionKey: oid, meta: { action: "cancelMarket", conditionId: market, assetId },
    }));
    return {
      success: true,
      output: JSON.stringify(result, null, 2),
      data: {
        ...result,
        conditionId: market,
        ...(captureItems.length > 0
          ? { _tradeCapture: { type: "order", chain: "polygon", status: "cancelled", walletAddress: address, meta: { action: "cancelMarket", conditionId: market, assetId } }, _tradeCaptureItems: captureItems }
          : {}),
      },
    };
  },

  "polymarket.clob.orders": async (p, ctx) => {
    let address: string;
    try {
      address = resolveSelectedAddress(ctx.walletResolution, ctx.walletPolicy, "eip155");
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    return ok(await getPolyClobClient().getOrders({ address }, {
      id: str(p, "id") || undefined,
      market: str(p, "market") || undefined,
      asset_id: str(p, "assetId") || undefined,
      next_cursor: str(p, "cursor") || undefined,
    }));
  },

  "polymarket.clob.order": async (p, ctx) => {
    const orderId = str(p, "orderId");
    if (!orderId) return fail("Missing required: orderId");
    let address: string;
    try {
      address = resolveSelectedAddress(ctx.walletResolution, ctx.walletPolicy, "eip155");
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    return ok(await getPolyClobClient().getOrder({ address }, orderId));
  },
};
