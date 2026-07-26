/**
 * Jupiter Prediction `history` response schemas (codex-002).
 */

import { z } from "zod";
import {
  eventMetadataSchema,
  marketMetadataSchema,
  paginationSchema,
} from "./_shared.js";

// ── History ────────────────────────────────────────────────────────

const historyEventSchema = z
  .object({
    id: z.number(),
    eventType: z.string(),
    signature: z.string(),
    slot: z.string(),
    timestamp: z.number(),
    orderPubkey: z.string(),
    positionPubkey: z.string(),
    marketId: z.string(),
    ownerPubkey: z.string(),
    keeperPubkey: z.string(),
    externalOrderId: z.string(),
    orderId: z.string(),
    isBuy: z.boolean(),
    isYes: z.boolean(),
    contracts: z.string(),
    contractsMicro: z.string().optional(),
    contractsDecimal: z.string().optional(),
    filledContracts: z.string(),
    filledContractsMicro: z.string().optional(),
    filledContractsDecimal: z.string().optional(),
    contractsSettled: z.string(),
    contractsSettledMicro: z.string().optional(),
    contractsSettledDecimal: z.string().optional(),
    maxFillPriceUsd: z.string(),
    avgFillPriceUsd: z.string(),
    maxBuyPriceUsd: z.string().nullable(),
    minSellPriceUsd: z.string().nullable(),
    depositAmountUsd: z.string(),
    totalCostUsd: z.string(),
    feeUsd: z.string().nullable(),
    grossProceedsUsd: z.string(),
    netProceedsUsd: z.string(),
    transferAmountToken: z.string().nullable(),
    realizedPnl: z.string().nullable(),
    realizedPnlBeforeFees: z.string().nullable(),
    payoutAmountUsd: z.string(),
    eventId: z.string(),
    marketMetadata: marketMetadataSchema,
    eventMetadata: eventMetadataSchema,
  })
  .passthrough();

export const jupiterPredictionHistoryResponseSchema = z
  .object({
    data: z.array(historyEventSchema),
    pagination: paginationSchema,
  })
  .passthrough();
