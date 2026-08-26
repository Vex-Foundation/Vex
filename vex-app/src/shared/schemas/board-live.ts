/**
 * BOARD LIVE - the IPC contract for refreshing an open board's CARD METRICS
 * while the reader holds it LIVE.
 *
 * WHAT THIS IS AND, MORE IMPORTANTLY, WHAT IT IS NOT. A board is a durable
 * document: the agent composed it, its figures were fetched once, and both of
 * its clocks are persisted. LIVE does not edit that document. It is a
 * user-held, per-window LEASE over a poll in the main process whose only
 * product is a stream of freshly projected rows that the renderer draws OVER
 * the persisted spec for as long as the toggle is on. Turning the toggle off,
 * navigating, closing the window or quitting the app all end the lease and the
 * board goes back to the figures it was composed with. Nothing here is
 * persisted, and the default on every mount is OFF.
 *
 * THE CHART IS NOT LIVE IN THIS CONTRACT, deliberately and visibly. There is
 * no push channel for candles, and the renderer's candle feed can append and
 * update bars but cannot retract them, so a live candle stream without a
 * reconciliation contract would leave bars on screen that the toggle could not
 * take back. The chart therefore keeps its own "chart as of" clock and stays
 * an honest snapshot. Live candles are a declared future gate with a named
 * prerequisite (a bounded-window reconciliation contract), not an oversight.
 *
 * FOUR PROPERTIES THE SHAPES BELOW ENFORCE:
 *
 *  - EXACT-KEY ATOMICITY. A tick carries a row for EVERY pool that was
 *    subscribed and for no other, keyed `chain:pairAddress`. Main rejects a
 *    partial, duplicated or over-full provider answer as a whole rather than
 *    publishing a board whose cards come from two different epochs.
 *  - ONE OWNER PER LEASE. `leaseId` rides every event and every unsubscribe.
 *    Main refuses an unsubscribe from a window that does not own the lease.
 *  - MONOTONIC GENERATION. Every event carries the lease's generation so a
 *    renderer holding an older request can discard an answer that arrived
 *    after it moved on, rather than painting it.
 *  - MONEY IS TEXT. Rows reuse the board's own `boardHydratedRowSchema`, whose
 *    money fields are decimal STRINGS. A live figure and a composed figure are
 *    therefore the same shape, produced by the same projector, and a card
 *    cannot change precision when the toggle flips.
 */

import { z } from "zod";
import {
  BOARD_MAX_POOLS,
  boardHydratedRowSchema,
  boardPoolInputSchema,
} from "@vex-lib/board/index.js";

/**
 * One pool to keep live.
 *
 * The board's own pool shape minus `caption`: a caption is the agent's prose
 * and has no business crossing this boundary, so the strict object rejects it
 * by name rather than dropping it silently.
 */
export const boardLivePoolSchema = boardPoolInputSchema
  .omit({ caption: true })
  .strict();
export type BoardLivePool = z.infer<typeof boardLivePoolSchema>;

/** Opaque lease handle. Minted by main; the renderer only echoes it back. */
export const boardLiveLeaseIdSchema = z.string().uuid();

/**
 * The RENDERER's own name for one subscribe attempt, minted before the call.
 *
 * WHY A SECOND IDENTITY EXISTS AT ALL. A lease id is minted by main and is not
 * handed back until the FIRST fetch has settled, which can be up to the attempt
 * deadline. Between the click that starts a subscribe and that response there
 * is a window in which the renderer holds no handle, so a reader who toggles
 * off, switches session or unmounts inside it had no way to say which exchange
 * to stop: main kept fetching for a board nobody was watching. This id is
 * minted by the caller, so it exists from the first instant and a cancel can be
 * addressed the moment the decision is made.
 *
 * It is a HANDLE, never a credential. Ownership is still decided by the sending
 * webContents, exactly as it is for a lease id, so naming another window's
 * request id gets the same typed refusal.
 */
export const boardLiveRequestIdSchema = z.string().uuid();

export const boardLiveSubscribeInputSchema = z
  .object({
    pools: z.array(boardLivePoolSchema).min(1).max(BOARD_MAX_POOLS),
    /** Minted by the renderer so this attempt is cancellable before it answers. */
    requestId: boardLiveRequestIdSchema,
  })
  .strict();
export type BoardLiveSubscribeInput = z.infer<
  typeof boardLiveSubscribeInputSchema
>;

/**
 * One card's freshly projected figures.
 *
 * `key` is `chain:pairAddress` lowercased, which is the same identity the
 * provider's batch channel resolves against, so the renderer pairs a row to a
 * card by identity and never by array position. Position pairing would put the
 * wrong figures on a card the moment the provider reordered its answer, which
 * it does: the channel ranks its rows.
 */
export const boardLiveRowSchema = z
  .object({
    key: z.string().min(3).max(200),
    row: boardHydratedRowSchema,
  })
  .strict();
export type BoardLiveRow = z.infer<typeof boardLiveRowSchema>;

/**
 * Why a lease ended. Terminal and final: no event follows one of these.
 *
 *  - `unsubscribed`   the reader turned the toggle off, or the board unmounted;
 *  - `superseded`     another board claimed the single lease;
 *  - `dropped`        the poll failed permanently or exhausted its attempts;
 *  - `renderer-gone`  the window was destroyed, crashed, or navigated away;
 *  - `shutdown`       the app is quitting.
 *
 * The renderer treats all five the same way (return to the persisted snapshot)
 * but SAYS which one happened, because "you turned this off" and "we could not
 * keep up with the provider" are different facts about the same board.
 */
export const BOARD_LIVE_CLOSE_REASONS = [
  "unsubscribed",
  "superseded",
  "dropped",
  "renderer-gone",
  "shutdown",
] as const;
export type BoardLiveCloseReason = (typeof BOARD_LIVE_CLOSE_REASONS)[number];

/**
 * Why a lease is degraded, which is a RECOVERABLE state: the poll is backing
 * off and the last good rows stay on screen with their own timestamp.
 *
 *  - `provider`   the provider refused or the channel failed;
 *  - `incomplete` the answer did not cover exactly the subscribed pools, so
 *                 the whole tick was rejected rather than published in part;
 *  - `timeout`    the attempt did not finish inside its deadline.
 */
export const BOARD_LIVE_DEGRADE_REASONS = [
  "provider",
  "incomplete",
  "timeout",
] as const;
export type BoardLiveDegradeReason = (typeof BOARD_LIVE_DEGRADE_REASONS)[number];

/**
 * A settled set of rows and the clock they were read at.
 *
 * `fetchedAtMs` moves ONLY with a tick that reconciled exactly. A degraded
 * lease keeps the last good pair unchanged, so the age a reader sees is the
 * age of the figures in front of them and never the age of the last attempt.
 */
export const boardLiveSnapshotSchema = z
  .object({
    fetchedAtMs: z.number().int().nonnegative(),
    rows: z.array(boardLiveRowSchema).min(1).max(BOARD_MAX_POOLS),
  })
  .strict();
export type BoardLiveSnapshot = z.infer<typeof boardLiveSnapshotSchema>;

/**
 * A main-pushed lease event.
 *
 * Emitted ONLY while the lease is in main's registry, and delivered only to
 * the window that owns it. `generation` increases with every published
 * transition on the lease.
 */
export const boardLiveEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("tick"),
      leaseId: boardLiveLeaseIdSchema,
      generation: z.number().int().nonnegative(),
      snapshot: boardLiveSnapshotSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("degraded"),
      leaseId: boardLiveLeaseIdSchema,
      generation: z.number().int().nonnegative(),
      reason: z.enum(BOARD_LIVE_DEGRADE_REASONS),
      /** The last exactly-reconciled rows, or null when none ever landed. */
      lastGood: boardLiveSnapshotSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("closed"),
      leaseId: boardLiveLeaseIdSchema,
      generation: z.number().int().nonnegative(),
      reason: z.enum(BOARD_LIVE_CLOSE_REASONS),
    })
    .strict(),
]);
export type BoardLiveEvent = z.infer<typeof boardLiveEventSchema>;

/**
 * The subscribe response, which CARRIES THE FIRST SNAPSHOT.
 *
 * That is the whole reason this is a request rather than a fire-and-forget
 * nudge. If the first rows arrived only as an event, a renderer would have to
 * have its listener attached before the call it has not made yet, and the
 * window between the two would be a real race with a real symptom: a board
 * that says "connecting" forever because it missed the only tick that was
 * going to arrive within the first five seconds. The renderer still registers
 * its listener BEFORE invoking (for every LATER tick), but correctness does
 * not depend on that ordering.
 *
 * `unsupported` is the honest answer in a build with no site bridge: there is
 * no WebSocket channel to poll, and this is a capability fact, not a failure.
 */
export const boardLiveSubscribeResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("subscribed"),
      leaseId: boardLiveLeaseIdSchema,
      generation: z.number().int().nonnegative(),
      snapshot: boardLiveSnapshotSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("unsupported"),
      /** Reader-facing sentence naming what is missing and what to do. */
      detail: z.string().min(1).max(400),
    })
    .strict(),
]);
export type BoardLiveSubscribeResult = z.infer<
  typeof boardLiveSubscribeResultSchema
>;

/**
 * Release by EITHER identity, and exactly one of them.
 *
 * `leaseId` is the ordinary case: the subscribe answered, the renderer holds
 * main's handle. `requestId` is the pre-response case: the subscribe has not
 * answered yet, so the only name both sides share is the one the renderer
 * minted. Two strict members rather than one object with two optional fields,
 * so "neither" and "both" are rejected at the boundary instead of being
 * resolved by a precedence rule nobody can see.
 */
export const boardLiveUnsubscribeInputSchema = z.union([
  z.object({ leaseId: boardLiveLeaseIdSchema }).strict(),
  z.object({ requestId: boardLiveRequestIdSchema }).strict(),
]);
export type BoardLiveUnsubscribeInput = z.infer<
  typeof boardLiveUnsubscribeInputSchema
>;

/**
 * The unsubscribe outcome.
 *
 * `closed` means this caller owned the lease and it is now gone. `not-owner`
 * is a TYPED REFUSAL, not an error: another window owns that lease and it was
 * left untouched. `unknown` means no such lease exists, which is the ordinary
 * answer when a terminal event and a cleanup race - and it is deliberately not
 * a failure, so an idempotent cleanup can call this twice.
 */
export const boardLiveUnsubscribeResultSchema = z
  .object({
    outcome: z.enum(["closed", "not-owner", "unknown"]),
  })
  .strict();
export type BoardLiveUnsubscribeResult = z.infer<
  typeof boardLiveUnsubscribeResultSchema
>;

/**
 * Whether live is reachable at all in this build.
 *
 * Asked BEFORE the toggle renders, so a build with no site bridge shows a
 * disabled control with an honest label instead of a control that fails on its
 * first click. Hiding it would be worse than disabling it: the reader would
 * never learn the capability exists.
 */
export const boardLiveCapabilitySchema = z
  .object({
    supported: z.boolean(),
    /** Why not, when `supported` is false. Null when it is supported. */
    detail: z.string().min(1).max(400).nullable(),
  })
  .strict();
export type BoardLiveCapability = z.infer<typeof boardLiveCapabilitySchema>;
