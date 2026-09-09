/**
 * The Settings "Lighter Points" contract: one row per wallet with a Lighter
 * account registered through the app, plus the reason for anything missing.
 *
 * STRICT ON PURPOSE. Every field here crosses the main -> renderer boundary and
 * is re-parsed on the way out (rule 90's IPC list), so a shape the main process
 * did not intend never reaches the view. Points are DISPLAY numbers, not money:
 * they are the provider's own doubles, never summed, converted or compared
 * against a balance.
 */

import { z } from "zod";

import { lighterIntegrationEnvironmentSchema } from "./lighter-integration.js";

const lighterPointsWalletAddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/);

/** Why the read-only authorization for one wallet could not be minted. */
const lighterPointsAuthUnavailableReasonSchema = z.enum([
  "vault_locked",
  "signer_failed",
  "unknown",
]);

/** Why one of the four provider reads has no value. */
const lighterPointsReadUnavailableReasonSchema = z.enum([
  "provider_unavailable",
  "provider_refused",
  "provider_timeout",
]);

const readUnavailableSchema = z
  .object({
    kind: z.literal("unavailable"),
    reason: lighterPointsReadUnavailableReasonSchema,
    detail: z.string().max(2_000),
  })
  .strict();

const points = z.number().finite();

const lighterPointsRankSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("rank"),
      points,
      /** The provider's own board position (`entry`), never the row id. */
      position: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ kind: z.literal("rank_unavailable") }).strict(),
  readUnavailableSchema,
]);

const lighterPointsLiveSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("value"), value: points }).strict(),
  readUnavailableSchema,
]);

const lighterReferralSummarySchema = z
  .object({
    totalPoints: points,
    lastWeekPoints: points,
    rewardPoints: points,
    lastWeekRewardPoints: points,
    /** The provider's decimal string ("0.1000"), passed through unchanged. */
    multiplier: z.string().min(1).max(64),
    referralCount: z.number().int().nonnegative(),
  })
  .strict();

const lighterPointsReferralSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("value"), value: lighterReferralSummarySchema }).strict(),
  readUnavailableSchema,
]);

const lighterPointsRowSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("credential_missing_here"),
    walletAddress: lighterPointsWalletAddressSchema,
    environment: lighterIntegrationEnvironmentSchema,
    accountIndex: z.number().int().nonnegative(),
    apiKeyIndex: z.number().int().min(4).max(254).nullable(),
    tradingKeyRegistered: z.boolean(),
    observedAt: z.string().datetime(),
  }).strict().refine((row) => !row.tradingKeyRegistered || row.apiKeyIndex !== null, {
    message: "A recorded trading key requires its API-key index.",
  }),
  z
    .object({
      kind: z.literal("points"),
      walletAddress: lighterPointsWalletAddressSchema,
      environment: lighterIntegrationEnvironmentSchema,
      accountIndex: z.number().int().nonnegative(),
      allTime: lighterPointsRankSchema,
      weekly: lighterPointsRankSchema,
      livePoints: lighterPointsLiveSchema,
      referral: lighterPointsReferralSchema,
      observedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      walletAddress: lighterPointsWalletAddressSchema,
      environment: lighterIntegrationEnvironmentSchema,
      accountIndex: z.number().int().nonnegative(),
      reason: lighterPointsAuthUnavailableReasonSchema,
      detail: z.string().max(2_000),
      observedAt: z.string().datetime(),
    })
    .strict(),
]);

export const readLighterPointsInputSchema = z.object({}).strict();

export const lighterPointsResultSchema = z
  .object({
    rows: z.array(lighterPointsRowSchema).max(100).readonly(),
    /**
     * How many wallets with a resolved account exist. Equal to `rows.length`
     * unless the bounded page left some out, which is the one case the view
     * has to be able to say out loud.
     */
    walletCount: z.number().int().nonnegative(),
    observedAt: z.string().datetime(),
  })
  .strict();

export type LighterPointsRank = z.infer<typeof lighterPointsRankSchema>;
export type LighterPointsReferral = z.infer<typeof lighterPointsReferralSchema>;
export type LighterPointsRow = z.infer<typeof lighterPointsRowSchema>;
export type LighterPointsResult = z.infer<typeof lighterPointsResultSchema>;
