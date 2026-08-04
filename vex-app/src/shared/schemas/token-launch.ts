/**
 * Token-launch IPC contract (C5) — the boundary between the untrusted renderer
 * and the process that can sign.
 *
 * THE LAW OF THIS FILE. The renderer never holds keys, never signs, and never
 * names an amount that becomes a spend. It sends the FORM the user filled and,
 * on submit, the `previewId` and `intentId` it was given. MAIN reconstructs the
 * money — it re-reads the creation fee on-chain, recomposes `msg.value`, and
 * binds the C0 authorization record. A renderer-supplied fee or value would be
 * exactly the "model/UI input reaching the money path" rule 90 forbids, so there
 * is deliberately no field for one here and every object is `.strict()`.
 *
 * WHY THE PREVIEW REPLY KEEPS ITS NUMBERS SEPARATE. `creationFeeWei`,
 * `prebuyWei`, `msgValueWei`, `vexFeeWei` and the three gas fields are separate
 * raw wei decimal strings, and there is NO pre-formatted total. The consented
 * amount is exactly `msgValueWei`; gas is an ESTIMATE the network charges
 * separately. Summing them would present an estimate as a commitment — the user
 * would "authorize" a number nobody can promise. The dialog shows two facts:
 * "You authorize X" and "Network fee ~Y (estimated)".
 *
 * Amounts are STRINGS because they are wei and routinely exceed
 * `Number.MAX_SAFE_INTEGER`; structured clone would carry a `bigint`, but a
 * JSON-safe decimal string is what the rest of the repo's DTOs use and what
 * survives logging. Every one travels with a known unit (wei) by name.
 */

import { z } from "zod";

/** A raw wei amount: non-negative decimal digits only. No sign, point or exponent. */
const weiStringSchema = z
  .string()
  .regex(/^\d+$/, "must be a raw non-negative integer amount in wei");

/** Opaque ids. The renderer never parses them; it echoes what it was given. */
const opaqueIdSchema = z.string().min(1).max(128);

// MEASURED ON-CHAIN limits (bisected via free eth_estimateGas, 2026-08-02):
// the Diamond's create() reverts past name 18, symbol 18, description 512,
// links 4 (hardcoded in facet bytecode — not readable from storage). The form
// caps at the chain's real limits so the user hears it while typing, not at
// signing time; symbol stays deliberately tighter at 16.
export const TOKEN_LAUNCH_NAME_MAX = 18;
export const TOKEN_LAUNCH_SYMBOL_MAX = 16;
export const TOKEN_LAUNCH_DESCRIPTION_MAX = 512;
export const TOKEN_LAUNCH_LINKS_MAX = 4;

/**
 * The form the user filled. Note what is NOT here: no fee, no value, no
 * recipient, no deadline, no gas. The renderer describes the TOKEN; main decides
 * the money.
 */
export const tokenLaunchFormSchema = z
  .object({
    name: z.string().trim().min(1).max(TOKEN_LAUNCH_NAME_MAX),
    symbol: z.string().trim().min(1).max(TOKEN_LAUNCH_SYMBOL_MAX),
    description: z.string().trim().max(TOKEN_LAUNCH_DESCRIPTION_MAX).default(""),
    links: z.array(z.string().url().startsWith("https://").max(128)).max(TOKEN_LAUNCH_LINKS_MAX).default([]),
    imageId: opaqueIdSchema,
    /**
     * The prebuy as a plain decimal ETH string, exactly as typed. Main parses it
     * to wei — the renderer never does the conversion, because a decimals slip
     * in the UI is a thousandfold spend error.
     */
    prebuy: z.string().regex(/^\d+(\.\d+)?$/, "must be a plain decimal amount of ETH").default("0"),
  })
  .strict();
export type TokenLaunchForm = z.infer<typeof tokenLaunchFormSchema>;

// ── preview ─────────────────────────────────────────────────────────────────

export const tokenLaunchPreviewInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    form: tokenLaunchFormSchema,
  })
  .strict();
export type TokenLaunchPreviewInput = z.infer<typeof tokenLaunchPreviewInputSchema>;

export const tokenLaunchPreviewResultSchema = z
  .object({
    /** Binds the anchored block AND the fee read there. Echoed back on submit. */
    previewId: opaqueIdSchema,
    creationFeeWei: weiStringSchema,
    prebuyWei: weiStringSchema,
    /** The CONSENTED figure: creationFee + prebuy, exactly. */
    msgValueWei: weiStringSchema,
    /** Vex's 25 bps fee — a SEPARATE transaction after the launch confirms. */
    vexFeeWei: weiStringSchema,
    /** False when the fee floored to dust: then no leg is signed and no row written. */
    vexFeeCharged: z.boolean(),
    /** ESTIMATES. Never summed into `msgValueWei` — see the header. */
    estimatedGasLimit: weiStringSchema,
    estimatedGasPriceWei: weiStringSchema,
    /**
     * Gas for EVERY transaction this consent causes: the launch, plus — when
     * `vexFeeCharged` — the separate fee transfer, budgeted main-side on the
     * same constant the pre-sign balance gate uses. Budgeting only the launch
     * would under-state the cost of a consent that sends two transactions, so
     * main MUST include the fee leg here; the renderer displays this figure and
     * never derives a second one (coordinator ruling 2026-08-02).
     */
    estimatedNetworkFeeWei: weiStringSchema,
    /** The block the fee was read at, for auditability. */
    anchorBlockNumber: weiStringSchema,
    predictedTokenAddress: z.string().nullable(),
    chainId: z.number().int(),
    imageId: opaqueIdSchema,
    expiresAt: z.string(),
    note: z.string(),
  })
  .strict();
export type TokenLaunchPreviewResult = z.infer<typeof tokenLaunchPreviewResultSchema>;

// ── submit ──────────────────────────────────────────────────────────────────

/**
 * The Deploy click.
 *
 * `previewId` is REQUIRED: it is how a submit against numbers the user is no
 * longer looking at is caught. Main re-derives the fee and refuses with
 * `tokenLaunch.preview_stale` if anything the preview anchored has moved —
 * deliberately broader than "the fee changed", so a different anchored value
 * cannot slip through under a fee-specific name.
 */
export const tokenLaunchSubmitInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    /** Present when an AGENT asked for the form (§C3b); absent for a user-origin launch. */
    intentId: opaqueIdSchema.nullable().default(null),
    previewId: opaqueIdSchema,
    form: tokenLaunchFormSchema,
  })
  .strict();
export type TokenLaunchSubmitInput = z.infer<typeof tokenLaunchSubmitInputSchema>;

export const tokenLaunchSubmitResultSchema = z
  .object({
    intentId: opaqueIdSchema,
    /**
     * `pending` is NOT a failure: an ambiguous broadcast may still settle and may
     * already have created the token. The dialog must never invite a retry on it.
     */
    status: z.enum(["confirmed", "pending", "reverted", "confirmed_pending_identity"]),
    txHash: z.string().nullable(),
    tokenAddress: z.string().nullable(),
    msgValueWei: weiStringSchema,
    message: z.string(),
  })
  .strict();
export type TokenLaunchSubmitResult = z.infer<typeof tokenLaunchSubmitResultSchema>;

// ── cancel ──────────────────────────────────────────────────────────────────

/**
 * The user dismissed the dialog.
 *
 * Only reachable from `awaiting_user_form`, so a cancel can never race an
 * in-flight signature. When an agent asked for the form, this ALSO resumes its
 * turn with an honest "the user dismissed it" result rather than leaving it
 * parked forever.
 */
export const tokenLaunchCancelInputSchema = z
  .object({
    sessionId: z.string().uuid(),
    intentId: opaqueIdSchema,
  })
  .strict();
export type TokenLaunchCancelInput = z.infer<typeof tokenLaunchCancelInputSchema>;

export const tokenLaunchCancelResultSchema = z
  .object({
    /** False when there was nothing live to cancel — already deployed, expired or gone. */
    cancelled: z.boolean(),
    /** True when an agent's parked turn was resumed as part of this cancel. */
    resumedAgentTurn: z.boolean(),
  })
  .strict();
export type TokenLaunchCancelResult = z.infer<typeof tokenLaunchCancelResultSchema>;

// ── my launches ─────────────────────────────────────────────────────────────

export const tokenLaunchMyLaunchesInputSchema = z
  .object({
    /** Server-resolved wallet scope; the renderer never names an address. */
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();
export type TokenLaunchMyLaunchesInput = z.infer<typeof tokenLaunchMyLaunchesInputSchema>;

export const launchedTokenDtoSchema = z
  .object({
    /**
     * WHERE THIS ROW CAME FROM, and therefore what it may claim.
     *
     * `launched` — a proven identity from `launched_tokens`.
     * `in_flight` — a broadcast launch whose token identity is NOT proven yet,
     * merged in from `token_launch_intents` (OD-3). Before this, such a launch
     * was invisible: the identity index is written only on confirm, so a user
     * who had just paid for a launch saw nothing at all.
     *
     * A BOUNDED OPEN STRING, per the tolerant-reader law: a future lifecycle
     * must not blank the list on an older renderer.
     */
    lifecycle: z.string().max(32),
    /**
     * NULL for an `in_flight` row, and modelled as null rather than an empty
     * string ON PURPOSE: a launch with no proven token address must never render
     * as a token, and `""` is exactly the value that would slip through a
     * truthiness check into a token link.
     */
    tokenAddress: z.string().nullable(),
    name: z.string(),
    symbol: z.string(),
    createTxHash: z.string(),
    chainId: z.number().int(),
    createdAt: z.string(),
    /** Raw units — ALWAYS read with `initialBuyDecimals`. Both null together. */
    initialBuyRaw: weiStringSchema.nullable(),
    initialBuyDecimals: z.number().int().nullable(),
  })
  .strict();
export type LaunchedTokenDto = z.infer<typeof launchedTokenDtoSchema>;

export const tokenLaunchMyLaunchesResultSchema = z
  .object({ launches: z.array(launchedTokenDtoSchema) })
  .strict();
export type TokenLaunchMyLaunchesResult = z.infer<typeof tokenLaunchMyLaunchesResultSchema>;

// ── getAwaiting (§C3b — the form the AGENT asked for) ───────────────────────

/**
 * "Is a launch form waiting for this session?"
 *
 * READ-ONLY and session-scoped. This is how the desktop learns WHAT to prefill
 * after the push event tells it THAT something is waiting: the event carries
 * ids only, and the row is the source of truth for the draft.
 *
 * Session scope is not cosmetic. `sessionId` is not ambient in main, and the
 * repo's read is session-predicated, so another session's awaiting form MISSES
 * even when its id is known.
 */
export const tokenLaunchGetAwaitingInputSchema = z
  .object({ sessionId: z.string().uuid() })
  .strict();
export type TokenLaunchGetAwaitingInput = z.infer<typeof tokenLaunchGetAwaitingInputSchema>;

/**
 * The agent's DRAFT, as the dialog should show it.
 *
 * WHAT IS NOT HERE IS THE POINT. No fee, no `msg.value`, no gas, no wallet
 * address, no consent record — this describes the TOKEN the agent proposed and
 * nothing that becomes a spend. The money is still derived main-side by
 * `preview` and re-derived on `submit`; this DTO cannot short-circuit either.
 *
 * `prebuy` is a plain decimal ETH string in the SAME shape the form field takes,
 * converted main-side from the row's raw wei + decimals. The renderer never does
 * that conversion (rule 90: a decimals slip in the UI is a thousandfold error),
 * and it never sees the raw amount it might be tempted to.
 */
export const awaitingLaunchFormDtoSchema = z
  .object({
    intentId: opaqueIdSchema,
    /**
     * Always `agent_requested_form` today — a user-origin launch never sits in
     * `awaiting_user_form`. Carried so the dialog can state WHO asked, and so a
     * future origin cannot silently render as an agent request.
     */
    origin: z.literal("agent_requested_form"),
    name: z.string(),
    symbol: z.string(),
    description: z.string(),
    links: z.array(z.string()),
    imageId: opaqueIdSchema,
    prebuy: z.string().regex(/^\d+(\.\d+)?$/, "must be a plain decimal amount of ETH"),
    /** When the form window lapses. After this the agent is resumed as expired. */
    expiresAt: z.string(),
    createdAt: z.string(),
  })
  .strict();
export type AwaitingLaunchFormDto = z.infer<typeof awaitingLaunchFormDtoSchema>;

/**
 * `null` — not an error — when nothing is waiting. "No form is open" is the
 * ORDINARY state of a session, and dressing it as a failure would make the
 * renderer's own idle poll/refetch look like an outage.
 *
 * Exactly ONE form is returned even though the repo read can hand back several:
 * the dialog is a single modal, and the newest request is the one the user was
 * just asked about. The older rows stay live and surface as the newest in turn.
 */
export const tokenLaunchGetAwaitingResultSchema = z
  .object({ awaiting: awaitingLaunchFormDtoSchema.nullable() })
  .strict();
export type TokenLaunchGetAwaitingResult = z.infer<typeof tokenLaunchGetAwaitingResultSchema>;

// ── the push event (main → renderer) ────────────────────────────────────────

/** Literal kept in sync with the engine `LAUNCH_FORM_EVENT_TYPE`. */
export const LAUNCH_FORM_EVENT_TYPE = "engine.launch.form" as const;

export const launchFormEventKindSchema = z.enum(["requested"]);
export type LaunchFormEventKind = z.infer<typeof launchFormEventKindSchema>;

/**
 * Renderer-facing launch-form event.
 *
 * Mirrors the engine's `LaunchFormEvent`
 * (`src/vex-agent/engine/runtime/launch-form-bus.ts`), emitted only AFTER the
 * `awaiting_user_form` insert has COMMITTED. The renderer treats it purely as an
 * invalidation signal — it reconstructs no draft from the payload and instead
 * re-reads `tokenLaunch.getAwaiting`, with the DB as source of truth.
 *
 * Bounded to ids, an enum and a timestamp: no token name, symbol, description or
 * amount rides this event.
 */
export const launchFormEventSchema = z
  .object({
    type: z.literal(LAUNCH_FORM_EVENT_TYPE),
    sessionId: z.string().uuid(),
    intentId: opaqueIdSchema,
    kind: launchFormEventKindSchema,
    occurredAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type LaunchFormEvent = z.infer<typeof launchFormEventSchema>;
