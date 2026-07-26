/**
 * Bridge leg DTO — the per-leg audit shape a `kind: "bridge"` row carries in
 * BOTH renderer-facing feeds (`portfolio-moves` MOVES + `token-history`), so a
 * multi-leg bridge shows as ONE logical row while every leg's chain + hash +
 * status stays available for audit (Agent Scan Phase 2, REVISION 3 B8 /
 * REVISION 2 R14).
 *
 * A bridge execution in `agent_activity` (migration 045) fans out into per-leg
 * rows keyed by `(protocol_execution_id, event_index)`:
 *   - `allowance_reset` / `allowance` — Vex-signed EVM approvals;
 *   - `bridge_deposit`                — the Vex-signed origin leg;
 *   - `bridge_fee`                    — the Vex integrator-fee transfer
 *                                       (migration 050; recorded as
 *                                       `allowance` before that), the FINAL
 *                                       Vex-signed origin leg — taken only
 *                                       after the deposit, so its own status
 *                                       is what says whether Vex was paid;
 *   - `bridge_fill_expected`          — the LOGICAL row (one per execution): it
 *                                       carries the route endpoints + requested
 *                                       amounts + `provider_order_id`, and is
 *                                       what every feed paginates on. `legs[]`
 *                                       INCLUDES this canonical row (REVISION 4);
 *   - `bridge_fill_observed`          — extra destination fills a multi-fill
 *                                       order reports (externally observed);
 *   - `bridge_refund`                 — origin-side refund evidence.
 *
 * OWNER RULE (2026-07-23): tool/feed outputs are NEVER truncated — every leg
 * and every hash is preserved. `bridgeLegsSchema` is bounded (a DTO array must
 * be) but the bound is far above any real bridge's leg count, so a genuine
 * bridge never loses a leg; a pathological >bound row fails validation LOUDLY
 * rather than silently truncating.
 *
 * RENDERER-SAFE (non-negotiable): a leg carries only the chain identity + the
 * on-chain `txHash` (a public reference), NEVER a raw provider payload and
 * NEVER a pre-built explorer URL. The renderer resolves the explorer link
 * itself through the curated `shared/explorer-links.ts` allowlist, keyed by the
 * leg's `chainFamily` (a `solana`-family leg → the `solana` explorer path, NOT
 * the numeric provider-native chain id, which differs across providers —
 * Khalani 20011000000 vs Relay 792703809).
 */

import { z } from "zod";

/** Upper bound on legs per bridge DTO row — far above any real bridge (see OWNER RULE note). */
export const BRIDGE_LEGS_MAX = 64;

const LEG_REF_MAX_LENGTH = 128;

/** The bridge `event_role` vocabulary (closed set) — migration 045, widened by 050 with `bridge_fee`. */
export const bridgeLegRoleSchema = z.enum([
  "allowance_reset",
  "allowance",
  "bridge_deposit",
  "bridge_fee",
  "bridge_fill_expected",
  "bridge_fill_observed",
  "bridge_refund",
]);
export type BridgeLegRole = z.infer<typeof bridgeLegRoleSchema>;

/** Chain family discriminator (migration 045 `chain_family`). */
export const bridgeChainFamilySchema = z.enum(["eip155", "solana"]);
export type BridgeChainFamily = z.infer<typeof bridgeChainFamilySchema>;

/**
 * One bridge leg. `status` is a TOLERANT string (the SQL collapses
 * `definitively_failed` → `failed`, but a closed re-declared enum here would
 * risk an empty-feed-on-drift bug — same doctrine as `token-history`'s
 * `failureCode`/`captureStatus`). `chainId` is the LEG's own execution chain
 * (provider-native), interpreted together with `chainFamily`.
 */
export const bridgeLegSchema = z
  .object({
    role: bridgeLegRoleSchema,
    /** The leg's OWN execution chain id (provider-native; pair with `chainFamily`). */
    chainId: z.number().int(),
    chainFamily: bridgeChainFamilySchema,
    /** On-chain reference (EVM tx hash / Solana signature); `null` for a planned or hashless-failed leg. */
    txHash: z.string().min(1).max(LEG_REF_MAX_LENGTH).nullable(),
    /** Lifecycle status of the leg's own row (tolerant string; SQL collapses `definitively_failed`→`failed`). */
    status: z.string().max(32).nullable(),
    /** The closed `failure_code` enum when the leg failed (`bridge_refunded` distinguishes a returned-funds leg). */
    failureCode: z.string().max(64).nullable(),
  })
  .strict();
export type BridgeLeg = z.infer<typeof bridgeLegSchema>;

/** A bridge row's legs — bounded (OWNER RULE: never truncated below a real bridge's count). */
export const bridgeLegsSchema = z.array(bridgeLegSchema).max(BRIDGE_LEGS_MAX);
export type BridgeLegs = z.infer<typeof bridgeLegsSchema>;

/**
 * Coerce the DB layer's `jsonb_agg(...)` legs value (already parsed to a JS
 * array by node-postgres) into typed `BridgeLeg`s. The source rows are our own
 * `agent_activity` rows whose `event_role`/`chain_family` are DB-CHECK-
 * constrained to the exact vocab above, so a well-formed leg always parses; a
 * leg the schema rejects (only possible on a future migration-045 role added
 * WITHOUT updating `bridgeLegRoleSchema` in lockstep — see the parity test) is
 * dropped rather than crashing the whole feed. `null`/non-array → `[]`.
 */
export function coerceBridgeLegs(raw: unknown): BridgeLeg[] {
  if (!Array.isArray(raw)) return [];
  const legs: BridgeLeg[] = [];
  for (const item of raw) {
    const parsed = bridgeLegSchema.safeParse(item);
    if (parsed.success) legs.push(parsed.data);
  }
  return legs;
}

/**
 * Which amount a bridge row's displayed quantity was derived from (BINDING Q2):
 * `"executed"` = independently-verified on-chain amount; `"estimated"` = the
 * quoted amount shown explicitly as an estimate (no verified fill yet, or a
 * fill whose transfer/value evidence could not be decoded). `null` = no honest
 * amount to show (a failed/refunded attempt). The renderer marks an
 * `"estimated"` quantity so it never reads as settled truth.
 */
export const bridgeAmountBasisSchema = z.enum(["executed", "estimated"]);
export type BridgeAmountBasis = z.infer<typeof bridgeAmountBasisSchema>;
