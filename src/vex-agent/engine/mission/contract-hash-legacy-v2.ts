/**
 * Frozen Hyperliquid mission-risk material for `CONTRACT_HASH_VERSION` 2.
 *
 * Hyperliquid was removed from the live agent runtime (Agent Scan Phase 3).
 * V2 was the mission-contract shape while it was live — any mission accepted
 * during that window may still carry a non-null Hyperliquid risk envelope
 * inside its `constraints_json.hyperliquidRisk`. `commitMissionStart`,
 * `renewMission`, `assertAcceptedContract`, and `getContractStatus` all
 * recompute the canonical hash from the mission's RECORDED version to check
 * it hasn't drifted since acceptance — for a V2 mission that recomputation
 * MUST still reproduce the exact original hash, or a legitimately accepted
 * mission would be treated as tampered (see `contract-hash.ts` header).
 *
 * This module is a BYTE-IDENTICAL, standalone copy of the risk schema and
 * normalization rules that used to live in `src/lib/hyperliquid-policy.ts`
 * (`hyperliquidMissionRiskSchema`). It has ZERO imports from any live
 * Hyperliquid module by design — it exists purely as frozen compatibility
 * material so old hashes stay reproducible after that code is gone. Do not
 * add fields, change validation, or wire this into any mission-WRITING path:
 * new drafts are always `CONTRACT_HASH_VERSION` 3 and can never populate a
 * Hyperliquid risk envelope again.
 */
import { z } from "zod";

/** Frozen copy of the schema formerly at `src/lib/hyperliquid-policy.ts` (`hyperliquidMissionRiskSchema`). */
const legacyHyperliquidRiskV2Schema = z.object({
  leverageCap: z.number().int().min(1),
  perOrderNotionalPct: z.number().min(1).max(50),
  totalNotionalPct: z.number().min(10).max(200),
  marketAllowlist: z.array(z.string().trim().min(1).max(64)).min(1).max(100).optional(),
}).strict();

export type LegacyHyperliquidRiskV2 = z.infer<typeof legacyHyperliquidRiskV2Schema>;

/**
 * V2 canonical contract material — the frozen V1-shaped base fields plus the
 * risk envelope. Field-for-field identical to the original
 * `CanonicalContractMaterialV2Schema` this replaces.
 */
export const CanonicalContractMaterialLegacyV2Schema = z.object({
  v: z.literal(2),
  goal: z.string().nullable(),
  capitalSource: z.string().nullable(),
  startingCapital: z.string().nullable(),
  riskProfile: z.string().nullable(),
  deadline: z.string().nullable(),
  allowedWallets: z.array(z.string()),
  allowedChains: z.array(z.string()),
  allowedProtocols: z.array(z.string()),
  successCriteria: z.array(z.string()),
  stopConditions: z.array(z.string()),
  hyperliquidRisk: legacyHyperliquidRiskV2Schema.nullable(),
}).strict();

export type CanonicalContractMaterialLegacyV2 = z.infer<typeof CanonicalContractMaterialLegacyV2Schema>;

/**
 * Normalize raw, untrusted `constraints_json.hyperliquidRisk` into the frozen
 * V2 shape used at hash time. Invalid or absent input normalizes to `null` —
 * matches the original combined behavior (the old `missionToDraft` dropped an
 * invalid risk value to `null` via `safeParse` before hashing ever saw it).
 */
export function normalizeLegacyHyperliquidRiskV2(value: unknown): LegacyHyperliquidRiskV2 | null {
  if (value === null || value === undefined) return null;
  const parsed = legacyHyperliquidRiskV2Schema.safeParse(value);
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    ...(parsed.data.marketAllowlist === undefined
      ? {}
      : { marketAllowlist: [...new Set(parsed.data.marketAllowlist.map((coin) => coin.trim().toUpperCase()))].sort() }),
  };
}
