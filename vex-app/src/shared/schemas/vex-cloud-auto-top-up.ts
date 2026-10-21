/**
 * `vex:vexCloud:*` low-balance alert and auto top-up standing rule (backend
 * plan 4.4, owner decision D12).
 *
 * THE FORM IS THE APPROVAL, as for a deposit. Creating, editing, pausing,
 * resuming or revoking a rule is two calls: `prepareAutoTopUp` returns a
 * PROPOSAL minted in main that carries every bound the rule will hold (source
 * wallet, VEX per top-up, trigger, daily count, 30-day cap, expiry, the
 * destination it will pay), and `submitAutoTopUp` names its id AND echoes
 * those bounds; main refuses by name when anything differs. A rule exists
 * only after the user approved such a card; no agent, mission or model
 * output can create, broaden or reuse one.
 *
 * Money travels whole: raw wei (VEX, 18 decimals) beside its unit. The text
 * amounts are what the user typed, parsed in main.
 */

import { z } from "zod";
import { VEX_CLOUD_CHAIN_ID, VEX_DECIMALS, VEX_SYMBOL } from "../vex-cloud-money.js";
import { evmAddressSchema } from "./wallets.js";

const isoTimestampSchema = z.string().datetime({ offset: true });
const rawIntegerSchema = z.string().regex(/^[0-9]{1,78}$/, "must be a raw non-negative integer");
const txHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const proposalIdSchema = z.string().uuid();
const amountTextSchema = z.string().min(1).max(64);
const ruleIdSchema = z.string().regex(/^vxrule-[0-9a-f-]{36}$/);
const tokenWordSchema = z.string().regex(/^[a-z0-9_]{1,64}$/);

export const ALERT_PERCENT_MIN = 1;
export const ALERT_PERCENT_MAX = 90;
export const ALERT_PERCENT_DEFAULT = 20;
export const AUTO_TOP_UP_MAX_PER_DAY = 24;
export const AUTO_TOP_UP_MAX_DAYS = 90;

const alertPercentSchema = z.number().int().min(ALERT_PERCENT_MIN).max(ALERT_PERCENT_MAX);

// ── alert ────────────────────────────────────────────────────────────────

export const vexCloudAlertGetInputSchema = z.object({}).strict();

export const vexCloudAlertSchema = z
  .object({
    alertPercent: alertPercentSchema,
    /** The last observation, or `null` before the first account read of this account. */
    observation: z
      .object({
        balanceWei: rawIntegerSchema,
        referenceWei: rawIntegerSchema,
        thresholdWei: rawIntegerSchema,
        belowAlert: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type VexCloudAlert = z.infer<typeof vexCloudAlertSchema>;

export const vexCloudAlertSetInputSchema = z.object({ alertPercent: alertPercentSchema }).strict();
export type VexCloudAlertSetInput = z.infer<typeof vexCloudAlertSetInputSchema>;

// ── rule view ────────────────────────────────────────────────────────────

export const autoTopUpSuspendReasonSchema = z.enum([
  "user_paused",
  "vault_locked",
  "app_quitting",
  "execution_not_ready",
  "cap_reached",
  "deposit_address_mismatch",
  "balance_read_failing",
  "account_changed",
]);

export const vexCloudAutoTopUpExecutionSchema = z
  .object({
    executionId: z.string().regex(/^vxexec-[0-9a-f-]{36}$/),
    authority: z.enum(["auto_top_up_poller", "auto_top_up_agent"]),
    amountWei: rawIntegerSchema,
    status: z.enum(["asked", "submitted", "confirmed", "reverted", "unknown", "refused"]),
    refusalKind: tokenWordSchema.nullable(),
    txHash: txHashSchema.nullable(),
    askedAt: isoTimestampSchema,
    decidedAt: isoTimestampSchema.nullable(),
  })
  .strict();

export const vexCloudAutoTopUpRuleSchema = z
  .object({
    ruleId: ruleIdSchema,
    version: z.number().int().min(1),
    state: z.enum(["active", "suspended", "revoked", "expired"]),
    suspendedReason: autoTopUpSuspendReasonSchema.nullable(),
    sourceWallet: evmAddressSchema,
    amountWei: rawIntegerSchema,
    maxPerDay: z.number().int().min(1).max(AUTO_TOP_UP_MAX_PER_DAY),
    monthlyCapWei: rawIntegerSchema,
    trigger: z.literal("below_alert_percent"),
    expiresAt: isoTimestampSchema,
    approvedAt: isoTimestampSchema,
    usedLast24Hours: z.number().int().min(0),
    usedLast30DaysWei: rawIntegerSchema,
    /** Newest first, at most 10; the full record is durable in main. */
    recentExecutions: z.array(vexCloudAutoTopUpExecutionSchema).max(10).readonly(),
  })
  .strict();
export type VexCloudAutoTopUpRule = z.infer<typeof vexCloudAutoTopUpRuleSchema>;

export const vexCloudAutoTopUpGetInputSchema = z.object({}).strict();
export const vexCloudAutoTopUpGetResultSchema = z
  .object({ rule: vexCloudAutoTopUpRuleSchema.nullable() })
  .strict();
export type VexCloudAutoTopUpGetResult = z.infer<typeof vexCloudAutoTopUpGetResultSchema>;

// ── prepare / submit ─────────────────────────────────────────────────────

const ruleFieldsSchema = z
  .object({
    sourceWallet: evmAddressSchema,
    amountText: amountTextSchema,
    maxPerDay: z.number().int().min(1).max(AUTO_TOP_UP_MAX_PER_DAY),
    monthlyCapText: amountTextSchema,
    expiresInDays: z.number().int().min(1).max(AUTO_TOP_UP_MAX_DAYS),
  })
  .strict();

export const vexCloudPrepareAutoTopUpInputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), fields: ruleFieldsSchema }).strict(),
  z.object({ action: z.literal("edit"), ruleId: ruleIdSchema, expectedVersion: z.number().int().min(1), fields: ruleFieldsSchema }).strict(),
  z.object({ action: z.literal("pause"), ruleId: ruleIdSchema, expectedVersion: z.number().int().min(1) }).strict(),
  z.object({ action: z.literal("resume"), ruleId: ruleIdSchema, expectedVersion: z.number().int().min(1) }).strict(),
  z.object({ action: z.literal("revoke"), ruleId: ruleIdSchema, expectedVersion: z.number().int().min(1) }).strict(),
]);
export type VexCloudPrepareAutoTopUpInput = z.infer<typeof vexCloudPrepareAutoTopUpInputSchema>;

/** Every bound the rule will hold after the change, shown whole on the card. */
export const vexCloudAutoTopUpBoundsSchema = z
  .object({
    sourceWallet: evmAddressSchema,
    amountWei: rawIntegerSchema,
    maxPerDay: z.number().int().min(1).max(AUTO_TOP_UP_MAX_PER_DAY),
    monthlyCapWei: rawIntegerSchema,
    trigger: z.literal("below_alert_percent"),
    alertPercent: alertPercentSchema,
    expiresAt: isoTimestampSchema,
  })
  .strict();
export type VexCloudAutoTopUpBounds = z.infer<typeof vexCloudAutoTopUpBoundsSchema>;

export const vexCloudAutoTopUpProposalSchema = z
  .object({
    proposalId: proposalIdSchema,
    action: z.enum(["create", "edit", "pause", "resume", "revoke"]),
    ruleId: ruleIdSchema.nullable(),
    expectedVersion: z.number().int().min(1).nullable(),
    actor: z.literal("user"),
    chainId: z.literal(VEX_CLOUD_CHAIN_ID),
    token: z
      .object({ address: evmAddressSchema, symbol: z.literal(VEX_SYMBOL), decimals: z.literal(VEX_DECIMALS) })
      .strict(),
    /** The pinned deposit address every top-up pays, equal to the backend's at prepare. */
    depositAddress: evmAddressSchema,
    bounds: vexCloudAutoTopUpBoundsSchema,
    /** USD estimates at the current rate, micro-USD, or `null` ("Not available"). */
    amountUsdMicroEstimate: rawIntegerSchema.nullable(),
    monthlyCapUsdMicroEstimate: rawIntegerSchema.nullable(),
    minimumWei: rawIntegerSchema,
    minimumMicroUsd: rawIntegerSchema,
    preparedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
  })
  .strict();
export type VexCloudAutoTopUpProposal = z.infer<typeof vexCloudAutoTopUpProposalSchema>;

export const vexCloudSubmitAutoTopUpInputSchema = z
  .object({
    proposalId: proposalIdSchema,
    /** The action and bounds the user saw on the card; main refuses by name when anything differs. */
    action: z.enum(["create", "edit", "pause", "resume", "revoke"]),
    bounds: vexCloudAutoTopUpBoundsSchema,
  })
  .strict();
export type VexCloudSubmitAutoTopUpInput = z.infer<typeof vexCloudSubmitAutoTopUpInputSchema>;

export const vexCloudSubmitAutoTopUpResultSchema = z.object({ rule: vexCloudAutoTopUpRuleSchema }).strict();
export type VexCloudSubmitAutoTopUpResult = z.infer<typeof vexCloudSubmitAutoTopUpResultSchema>;
