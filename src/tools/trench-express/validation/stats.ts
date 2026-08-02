/**
 * Wallet-stats validator for `/api/stats` (undocumented XP/faction layer).
 *
 * Every field is display-grade telemetry, so the whole shape is tolerant.
 */

import { z } from "zod";
import type { TrenchWalletStats } from "../types.js";
import { displayBoolean, displayNumber, displayString, parseOrThrow } from "./_shared.js";

const walletStatsSchema: z.ZodType<TrenchWalletStats> = z.object({
  volume: displayNumber,
  trades: displayNumber,
  xp: displayNumber,
  faction: displayString,
  factionXp: displayNumber,
  factionLocked: displayBoolean,
});

/** Validate a `/api/stats` object response. */
export function validateWalletStats(raw: unknown): TrenchWalletStats {
  return parseOrThrow(walletStatsSchema, raw);
}
