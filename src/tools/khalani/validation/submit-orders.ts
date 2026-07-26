/**
 * Khalani submit + orders validators (codex-002 Phase 2).
 *
 * Houses the strict `orderSchema` / `parseOrder` together with its lenient
 * sub-schemas (token metadata, timestamps, provider status) which are used
 * only by the order shape. Moved verbatim from `validation.ts` — identical
 * never-throw fallbacks (null / undefined / {} / []) and identical strict
 * required-field messages.
 */

import { z } from "zod";
import { VexError, ErrorCodes } from "../../../errors.js";
import type {
  KhalaniOrder,
  KhalaniProviderStatus,
  OrdersResponse,
  SubmitResponse,
} from "../types.js";
import {
  asNumber,
  asOptionalString,
  asString,
  asStringArray,
  isRecordValue,
  parseOrThrow,
} from "./_shared.js";

// ---------------------------------------------------------------------------
// Token metadata (lenient: null on bad input)
// ---------------------------------------------------------------------------

/**
 * Mirrors `parseTokenMeta`: non-record OR symbol-not-string OR
 * decimals-not-number → `null`. Otherwise `{symbol, decimals, logoURI?}`.
 * Modelled lenient — never throws.
 */
const tokenMetaSchema: z.ZodType<KhalaniOrder["fromTokenMeta"]> = z
  .unknown()
  .transform((v) => {
    if (!isRecordValue(v)) return null;
    if (typeof v.symbol !== "string" || typeof v.decimals !== "number") return null;
    const logoURI = typeof v.logoURI === "string" && v.logoURI.length > 0 ? v.logoURI : undefined;
    return { symbol: v.symbol, decimals: v.decimals, logoURI };
  });

// ---------------------------------------------------------------------------
// Timestamps (lenient: filter non-string values; empty → undefined)
// ---------------------------------------------------------------------------

const timestampsSchema: z.ZodType<Record<string, string> | undefined> = z
  .unknown()
  .transform((v) => {
    if (!isRecordValue(v)) return undefined;
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(v)) {
      if (typeof value === "string") {
        result[key] = value;
      }
    }
    return Object.keys(result).length > 0 ? result : undefined;
  });

// ---------------------------------------------------------------------------
// Provider status (lenient: undefined on bad input)
// ---------------------------------------------------------------------------

const providerStatusSchema: z.ZodType<KhalaniProviderStatus | undefined> = z
  .unknown()
  .transform((v) => {
    if (!isRecordValue(v)) return undefined;
    if (typeof v.provider !== "string" || typeof v.nativeStatus !== "string") return undefined;
    return {
      provider: v.provider,
      nativeStatus: v.nativeStatus,
      substatus: typeof v.substatus === "string" ? v.substatus : undefined,
      metadata: isRecordValue(v.metadata) ? v.metadata : undefined,
    };
  });

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

const orderSchema: z.ZodType<KhalaniOrder> = z
  .object(
    {
      id: asString("order.id"),
      type: asString("order.type"),
      quoteId: asString("order.quoteId"),
      routeId: asString("order.routeId"),
      fromChainId: asNumber("order.fromChainId"),
      fromToken: asString("order.fromToken"),
      toChainId: asNumber("order.toChainId"),
      toToken: asString("order.toToken"),
      srcAmount: asString("order.srcAmount"),
      destAmount: asString("order.destAmount"),
      status: asString("order.status"),
      author: asString("order.author"),
      // recipient/refundTo/fillerAddress: string or null (non-string → null).
      recipient: z.unknown().transform((v) => (typeof v === "string" ? v : null)),
      refundTo: z.unknown().transform((v) => (typeof v === "string" ? v : null)),
      fillerAddress: z.unknown().transform((v) => (typeof v === "string" ? v : null)),
      depositTxHash: asString("order.depositTxHash"),
      externalOrderId: asOptionalString,
      createdAt: asString("order.createdAt"),
      updatedAt: asString("order.updatedAt"),
      tradeType: asString("order.tradeType"),
      stepsCompleted: asStringArray,
      // transactions: preserved raw record, else {}.
      transactions: z
        .unknown()
        .transform((v) => (isRecordValue(v) ? v : {})),
      timestamps: timestampsSchema,
      providerStatus: providerStatusSchema,
      fromTokenMeta: tokenMetaSchema,
      toTokenMeta: tokenMetaSchema,
    },
    { message: "Invalid Khalani response: order must be an object" },
  )
  .transform((o) => ({
    id: o.id,
    type: o.type,
    quoteId: o.quoteId,
    routeId: o.routeId,
    fromChainId: o.fromChainId,
    fromToken: o.fromToken,
    toChainId: o.toChainId,
    toToken: o.toToken,
    srcAmount: o.srcAmount,
    destAmount: o.destAmount,
    status: o.status as KhalaniOrder["status"],
    author: o.author,
    recipient: o.recipient,
    refundTo: o.refundTo,
    fillerAddress: o.fillerAddress,
    depositTxHash: o.depositTxHash,
    externalOrderId: o.externalOrderId,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    tradeType: o.tradeType as KhalaniOrder["tradeType"],
    stepsCompleted: o.stepsCompleted,
    transactions: o.transactions as KhalaniOrder["transactions"],
    timestamps: o.timestamps,
    providerStatus: o.providerStatus,
    fromTokenMeta: o.fromTokenMeta,
    toTokenMeta: o.toTokenMeta,
  }));

function parseOrder(raw: unknown): KhalaniOrder {
  return parseOrThrow(orderSchema, raw);
}

// ---------------------------------------------------------------------------
// Exported validators
// ---------------------------------------------------------------------------

export function validateSubmitResponse(raw: unknown): SubmitResponse {
  if (!isRecordValue(raw)) {
    throw new VexError(ErrorCodes.KHALANI_API_ERROR, "Invalid Khalani response: expected submit response");
  }
  return parseOrThrow(
    z.object({
      orderId: asString("submit.orderId"),
      txHash: asString("submit.txHash"),
    }),
    raw,
  );
}

export function validateOrdersResponse(raw: unknown): OrdersResponse {
  if (!isRecordValue(raw) || !Array.isArray(raw.data)) {
    throw new VexError(ErrorCodes.KHALANI_API_ERROR, "Invalid Khalani response: expected orders wrapper");
  }
  return {
    data: raw.data.map(parseOrder),
    cursor: typeof raw.cursor === "number" ? raw.cursor : undefined,
  };
}

export function validateOrderResponse(raw: unknown): KhalaniOrder {
  return parseOrder(raw);
}
