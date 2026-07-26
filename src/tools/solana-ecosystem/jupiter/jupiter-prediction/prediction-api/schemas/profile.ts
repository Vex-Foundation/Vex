/**
 * Jupiter Prediction `profile` / PnL response schemas (codex-002).
 */

import { z } from "zod";

// ── Profile / PnL ──────────────────────────────────────────────────

export const jupiterPredictionProfileResponseSchema = z
  .object({
    ownerPubkey: z.string(),
    realizedPnlUsd: z.string(),
    totalVolumeUsd: z.string(),
    predictionsCount: z.string(),
    correctPredictions: z.string(),
    wrongPredictions: z.string(),
    totalActiveContracts: z.string(),
    totalActiveContractsMicro: z.string().optional(),
    totalActiveContractsDecimal: z.string().optional(),
    totalPositionsValueUsd: z.string(),
  })
  .passthrough();

const pnlHistoryPointSchema = z
  .object({
    timestamp: z.number(),
    realizedPnlUsd: z.string(),
  })
  .passthrough();

export const jupiterPredictionPnlHistoryResponseSchema = z
  .object({
    ownerPubkey: z.string(),
    history: z.array(pnlHistoryPointSchema),
  })
  .passthrough();
