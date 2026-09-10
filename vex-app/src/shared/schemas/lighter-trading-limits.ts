/**
 * The Settings "Lighter trading setup" contract: the agent's capital share, the
 * live leverage overview, and the PREPARE/CONFIRM proposal for a leverage
 * change.
 *
 * STRICT ON PURPOSE. Every field here crosses the main -> renderer boundary and
 * is re-parsed on the way out (rule 90's IPC list). The renderer's input is a
 * SELECTOR only: it names the wallet, market, leverage and mode it wants, and
 * main resolves and freezes everything else. A confirmation therefore cannot
 * carry a renderer-supplied snapshot of the terms, only the id of a proposal
 * main itself issued.
 *
 * Margin fractions travel on the provider's own 10000 scale, as integers.
 * Leverage is a DISPLAY string derived from that integer, never the other way
 * around: the integer is what gets signed.
 */

import { z } from "zod";

import { lighterIntegrationEnvironmentSchema } from "./lighter-integration.js";

const walletAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

/** Provider 10000 scale: 10000 is 1x, 200 is 50x. */
const initialMarginFractionSchema = z.number().int().min(1).max(10_000);

/** Two-decimal display, derived from the integer above. */
const leverageDisplaySchema = z.string().regex(/^\d{1,5}\.\d{2}$/);

const marginModeSchema = z.enum(["cross", "isolated"]);

const decimalStringSchema = z.string().regex(/^-?\d+(\.\d+)?$/);

export const lighterTradingLimitsSchema = z
  .object({
    environment: lighterIntegrationEnvironmentSchema,
    walletAddress: walletAddressSchema,
    /** Null means no ceiling. The owner withdrew the strict-default option. */
    agentCapitalSharePercent: z.number().int().min(1).max(100).nullable(),
    /**
     * NULL means no row is stored yet, which is exactly the value the first
     * write must send as `expectedRevision`. A sentinel number would let a
     * caller send it back as a real revision and lose the first-write check.
     */
    revision: z.number().int().min(1).nullable(),
  })
  .strict();

export const getLighterTradingLimitsInputSchema = z
  .object({
    environment: lighterIntegrationEnvironmentSchema,
    walletAddress: walletAddressSchema,
  })
  .strict();

export const setLighterTradingLimitsInputSchema = z
  .object({
    environment: lighterIntegrationEnvironmentSchema,
    walletAddress: walletAddressSchema,
    agentCapitalSharePercent: z.number().int().min(1).max(100).nullable(),
    /** Null on the FIRST write only; a stored row makes that write fail. */
    expectedRevision: z.number().int().min(1).nullable(),
  })
  .strict();

const openPositionSchema = z
  .object({
    size: decimalStringSchema,
    side: z.enum(["long", "short"]),
  })
  .strict();

const currentLeverageSchema = z
  .object({
    initialMarginFraction: initialMarginFractionSchema,
    leverageDisplay: leverageDisplaySchema,
    marginMode: marginModeSchema,
    /**
     * Where the current terms came from. A market with no position row has
     * never had leverage set, so the market's own default applies; saying so is
     * the difference between "2.00x" and "2.00x, the market default".
     */
    source: z.enum(["position_row", "market_default"]),
  })
  .strict();

const marketMaximumSchema = z
  .object({
    initialMarginFraction: initialMarginFractionSchema,
    leverageDisplay: leverageDisplaySchema,
  })
  .strict();

export const lighterLeverageOverviewSchema = z
  .object({
    environment: lighterIntegrationEnvironmentSchema,
    walletAddress: walletAddressSchema,
    accountIndex: z.number().int().nonnegative(),
    vaultState: z.enum(["unlocked", "locked"]),
    markets: z
      .array(
        z
          .object({
            marketId: z.number().int().min(0).max(254),
            symbol: z.string().min(1).max(64),
            current: currentLeverageSchema,
            max: marketMaximumSchema,
            openPosition: openPositionSchema.nullable(),
          })
          .strict(),
      )
      .max(256)
      .readonly(),
    /**
     * What this list does NOT show, and why. A bound that reports itself, never
     * a silent cut: the renderer's market picker reaches the rest.
     */
    omitted: z
      .object({
        count: z.number().int().nonnegative(),
        reason: z.string().min(1).max(400),
      })
      .strict(),
    /**
     * Leverage changes on this account that Vex has not resolved: they may hold
     * a nonce reservation and their outcome is not known.
     *
     * THE DURABLE OWNER of "which proposals still need Reconcile". Component
     * state loses them on remount and on restart, which is exactly when a
     * person comes back to look; this list comes from the intents table, so the
     * Reconcile action stays reachable for as long as the intent is unresolved.
     */
    unresolved: z
      .array(
        z
          .object({
            intentId: z.string().min(1).max(200),
            marketId: z.number().int().min(0).max(254),
            symbol: z.string().min(1).max(64),
            executionState: z.enum([
              "signing",
              "signed",
              "submission_staged",
              "submitted",
              "ambiguous",
            ]),
            updatedAt: z.string().datetime(),
          })
          .strict(),
      )
      .max(50)
      .readonly(),
  })
  .strict();

export const getLighterLeverageOverviewInputSchema = z
  .object({
    environment: lighterIntegrationEnvironmentSchema,
    walletAddress: walletAddressSchema,
  })
  .strict();

/** The renderer's whole input: a selector. Nothing else is accepted. */
export const prepareLighterLeverageInputSchema = z
  .object({
    environment: lighterIntegrationEnvironmentSchema,
    walletAddress: walletAddressSchema,
    marketId: z.number().int().min(0).max(254),
    /** A whole multiplier, or the market's maximum resolved by main. */
    leverage: z.union([z.number().int().min(1).max(10_000), z.literal("max")]),
    marginMode: marginModeSchema,
  })
  .strict();

const leverageProposalSchema = z
  .object({
    kind: z.literal("proposal"),
    proposalId: z.string().min(1).max(200),
    environment: lighterIntegrationEnvironmentSchema,
    walletAddress: walletAddressSchema,
    accountIndex: z.number().int().nonnegative(),
    apiKeyIndex: z.number().int().min(4).max(254),
    marketId: z.number().int().min(0).max(254),
    symbol: z.string().min(1).max(64),
    current: currentLeverageSchema,
    target: z
      .object({
        initialMarginFraction: initialMarginFractionSchema,
        leverageDisplay: leverageDisplaySchema,
        marginMode: marginModeSchema,
      })
      .strict(),
    marketMinInitialMarginFraction: initialMarginFractionSchema,
    openPosition: openPositionSchema.nullable(),
    /** Shown beside the decision, echoed in the result, never bound. */
    observations: z
      .object({
        liquidationPrice: decimalStringSchema.nullable(),
        openOrders: z
          .object({
            count: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    expiresAt: z.string().datetime(),
  })
  .strict();

const alreadyConfiguredSchema = z
  .object({
    kind: z.literal("already_configured"),
    current: currentLeverageSchema,
  })
  .strict();

export const lighterLeverageProposalSchema = z.discriminatedUnion("kind", [
  leverageProposalSchema,
  alreadyConfiguredSchema,
]);

export const confirmLighterLeverageInputSchema = z
  .object({ proposalId: z.string().min(1).max(200) })
  .strict();

export const reconcileLighterLeverageInputSchema = confirmLighterLeverageInputSchema;

/**
 * The five honest outcomes. `ambiguous` is NOT a failure: bytes may have
 * reached Lighter, the nonce stays reserved, and the card offers Reconcile.
 */
export const applyLighterLeverageResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      intentId: z.string().min(1).max(200),
      /**
       * The account read taken AFTER the proof. Observation, not the proof,
       * which is why it is NULLABLE: the transaction proof establishes what
       * Lighter did, and a failed account read afterwards leaves the outcome
       * standing with its observation missing rather than withdrawing it.
       */
      observed: currentLeverageSchema.nullable(),
      /** Present only when something about the outcome needs saying, such as an
       * observation that could not be taken. */
      note: z.string().min(1).max(400).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal("refused"),
      intentId: z.string().min(1).max(200).nullable(),
      reason: z.string().min(1).max(400),
    })
    .strict(),
  z
    .object({
      status: z.literal("ambiguous"),
      intentId: z.string().min(1).max(200),
      reason: z.string().min(1).max(400),
    })
    .strict(),
  z
    .object({
      status: z.literal("rejected"),
      intentId: z.string().min(1).max(200),
      /**
       * The provider's RAW execution status, exposed rather than mapped so the
       * first live run can pin what a type-20 failure status actually is. Null
       * when the outcome was settled with no transaction record at all, which
       * is the expiry-with-unconsumed-nonce case.
       */
      providerStatus: z.number().int().nullable(),
      reason: z.string().min(1).max(400),
    })
    .strict(),
  z
    .object({
      status: z.literal("expired"),
      intentId: z.string().min(1).max(200),
      reason: z.string().min(1).max(400),
    })
    .strict(),
]);

export type LighterTradingLimits = z.infer<typeof lighterTradingLimitsSchema>;
export type GetLighterTradingLimitsInput = z.infer<typeof getLighterTradingLimitsInputSchema>;
export type SetLighterTradingLimitsInput = z.infer<typeof setLighterTradingLimitsInputSchema>;
export type LighterLeverageOverview = z.infer<typeof lighterLeverageOverviewSchema>;
export type GetLighterLeverageOverviewInput = z.infer<
  typeof getLighterLeverageOverviewInputSchema
>;
export type PrepareLighterLeverageInput = z.infer<typeof prepareLighterLeverageInputSchema>;
export type LighterLeverageProposal = z.infer<typeof lighterLeverageProposalSchema>;
export type ConfirmLighterLeverageInput = z.infer<typeof confirmLighterLeverageInputSchema>;
export type ReconcileLighterLeverageInput = z.infer<typeof reconcileLighterLeverageInputSchema>;
export type ApplyLighterLeverageResult = z.infer<typeof applyLighterLeverageResultSchema>;
