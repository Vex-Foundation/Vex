/**
 * BOARD SPOTLIGHT - the IPC contract for the five reads behind the spotlight's
 * lower sections: smart money, the trade tape, momentum, other pools, and the
 * promotion plus narrative context.
 *
 * WHAT THE RENDERER MAY NAME. A chain slug and a pool address. That is the
 * whole of it. There is no host, route, deadline, cadence, page size, sort key
 * or window on any input here, because every one of those is main's and lives
 * as a constant in `main/market/board-spotlight-service.ts` and
 * `main/market/board-tape-service.ts`. A channel with no knob is a channel a
 * compromised renderer cannot turn.
 *
 * EVERY SECTION IS A DESIGNED STATE, NEVER A MISSING ELEMENT. The owner's
 * mockup shows these as cards with medallions, and a chain the provider does
 * not cover must render the SAME card with an honest sentence rather than a
 * hole in the layout. So each read answers with a discriminated union whose
 * `unavailable` and `absent` arms are ordinary successes, and a `Result` error
 * on these channels means only invalid input or an untrusted sender.
 *
 * WHAT THE LIVE PROBES FIXED IN THESE SHAPES
 * (`board-v3-probes/PROBES.md`, captured 2026-08-26):
 *
 *  - P3: `top_traders_list` RECOMPUTES every money figure over its lookback
 *    window rather than filtering by it (measured 28x difference for one
 *    wallet between a 30-day and a 1-day window). So the window travels ON the
 *    answer and the panel is labelled with it. The provider also cannot see
 *    transfers or other venues, so nothing here is named profit, accumulation,
 *    or smart money in the analytic sense.
 *  - P4: `boostsActive` is a column on the PAIR ROW (ETHCATE carried 10) and
 *    that same pair was ABSENT from the bounded 30-row `spotlight` feed at the
 *    same moment. Promotion therefore reads the row, and non-membership in a
 *    global feed is never evidence of zero boosts.
 *  - P6: `profile.metaIds` on the pair-details document joins to the narrative
 *    `id` (NOT the slug, which matches zero pairs). An EMPTY array is the
 *    COMMON case: both probed memecoin subjects returned `[]`.
 *  - P2: a trade's identity is the exact triple
 *    `blockNumber:transactionIndex:eventIndex`, and `pagination.nextCursor`
 *    walks BACKWARD into history.
 *
 * MONEY IS TEXT WHERE IT IS A FIGURE THE READER SEES. Volumes and amounts that
 * are provider decimal strings stay strings all the way to the canvas, exactly
 * as the board's hydrated row does, so a sub-cent size keeps every digit. The
 * provider's own doubles (a USD volume it computed itself) stay numbers and are
 * named as such, because rounding them into strings here would invent
 * precision the provider never had.
 */

import { z } from "zod";
import { boardPoolInputSchema } from "@vex-lib/board/index.js";

/**
 * The pool a spotlight read is about: the same POSITIVE PICK the live and
 * details channels take. Identity crosses; the pool document does not.
 */
export const boardSpotlightSubjectSchema = boardPoolInputSchema
  .pick({ chain: true, pairAddress: true })
  .strict();
export type BoardSpotlightSubject = z.infer<typeof boardSpotlightSubjectSchema>;

/**
 * Why a spotlight read produced nothing usable.
 *
 * The same three families every board channel uses, and they are not collapsed:
 * `absent` is settled (asking again now answers the same way), `unavailable` is
 * unknown (nothing was learned and asking again may work).
 */
export const boardSpotlightUnavailableReasons = [
  "transport",
  "provider",
  "busy",
  "not_mounted",
  "cancelled",
] as const;

export const boardSpotlightUnavailableSchema = z
  .object({
    kind: z.literal("unavailable"),
    reason: z.enum(boardSpotlightUnavailableReasons),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* Smart money - the 30-day pair-local cash flow leaderboard           */
/* ------------------------------------------------------------------ */

/**
 * One wallet's aggregate over this pair, inside the answer's own window.
 *
 * NAMES SAY WHAT THE COLUMN MEASURES. `netCashFlowUsd` is
 * `soldUsd - boughtUsd` on THIS pair: cost basis and transfers are invisible to
 * a venue, so it is not profit and it is not a position. The endpoint module's
 * own header records both corrections and this contract carries them forward.
 */
export const boardTopTraderSchema = z
  .object({
    /** The wallet, provider-spelled. Never re-cased: it is an identity. */
    maker: z.string().min(1).max(128),
    /** A provider display label when it sent one. Issuer-independent. */
    label: z.string().max(120).nullable(),
    buys: z.number().int().min(0).nullable(),
    sells: z.number().int().min(0).nullable(),
    /** Dollars in and dollars out, as the provider computed them. */
    boughtUsd: z.number().nullable(),
    soldUsd: z.number().nullable(),
    /** `soldUsd - boughtUsd`. NOT profit. */
    netCashFlowUsd: z.number().nullable(),
    /** 1-based position in the provider's own ranking, FROZEN at read time. */
    providerRank: z.number().int().min(1),
  })
  .strict();
export type BoardTopTrader = z.infer<typeof boardTopTraderSchema>;

/**
 * The leaderboard as one panel.
 *
 * `lookbackDays` and `windowLabel` are on the answer rather than assumed by the
 * surface, because the figures are RECOMPUTED over that window (P3). A panel
 * that displayed 30-day cash flow under a heading that said anything else would
 * be off by the 28x the probe measured.
 */
export const boardTopTradersPanelSchema = z
  .object({
    kind: z.literal("traders"),
    rows: z.array(boardTopTraderSchema).max(100),
    /** How many rows the provider's bounded leaderboard returned in total. */
    rowsAvailable: z.number().int().min(0),
    lookbackDays: z.number().int().min(1).max(30),
    /** The heading this panel must be shown under. Frozen copy. */
    windowLabel: z.string().min(1).max(80),
    /**
     * The honesty line. The provider cannot see transfers or other venues, so
     * this panel is a statement about one pool and nothing more.
     */
    semanticsNote: z.string().min(1).max(400),
    fetchedAtMs: z.number().int().nonnegative(),
  })
  .strict();

export const boardTopTradersOutcomeSchema = z.discriminatedUnion("kind", [
  boardTopTradersPanelSchema,
  boardSpotlightUnavailableSchema,
]);
export type BoardTopTradersOutcome = z.infer<typeof boardTopTradersOutcomeSchema>;

/* ------------------------------------------------------------------ */
/* Momentum - the view-time window sidecar                             */
/* ------------------------------------------------------------------ */

/**
 * The four windows the provider reports per pair, in its own order.
 *
 * Read from the endpoint's `SCREEN_WINDOWS` vocabulary rather than spelled
 * here, and pinned to it by test: a hand-written window name is a defect even
 * when it happens to be correct.
 */
export const boardMomentumWindows = ["m5", "h1", "h6", "h24"] as const;
export type BoardMomentumWindow = (typeof boardMomentumWindows)[number];

/**
 * One window's figures, plus the DURATION-NORMALIZED rates that make windows
 * comparable to each other.
 *
 * WHY NORMALIZE AT ALL. A raw h24 volume is always larger than a raw m5 volume
 * and says nothing about acceleration. Dividing each window by its own length
 * in hours turns four incomparable totals into four rates on one axis, which is
 * the only way "is this move speeding up" can be read off the row. The formulas
 * are frozen in `main/market/board-spotlight-service.ts` and stated there.
 */
export const boardMomentumRowSchema = z
  .object({
    window: z.enum(boardMomentumWindows),
    /** The window's length in hours. m5 is 1/12, h24 is 24. */
    hours: z.number().positive(),
    /** Totals exactly as the provider reported them for this window. */
    volumeUsd: z.number().nullable(),
    volumeBuyUsd: z.number().nullable(),
    volumeSellUsd: z.number().nullable(),
    buys: z.number().int().min(0).nullable(),
    sells: z.number().int().min(0).nullable(),
    priceChangePct: z.number().nullable(),
    /** `volumeUsd / hours`. Comparable across windows; null when the input is. */
    volumeUsdPerHour: z.number().nullable(),
    /** `(buys + sells) / hours`. */
    tradesPerHour: z.number().nullable(),
    /**
     * `volumeBuyUsd / (volumeBuyUsd + volumeSellUsd) * 100`.
     *
     * A SHARE, so it needs no normalization and is directly comparable. Null
     * when either side is missing or both are zero, never 50: a missing split
     * and an even split are different facts.
     */
    buySharePct: z.number().min(0).max(100).nullable(),
  })
  .strict();
export type BoardMomentumRow = z.infer<typeof boardMomentumRowSchema>;

export const boardMomentumPanelSchema = z
  .object({
    kind: z.literal("momentum"),
    /** One row per window, always all four, in the provider's own order. */
    rows: z.array(boardMomentumRowSchema).length(4),
    fetchedAtMs: z.number().int().nonnegative(),
  })
  .strict();

export const boardMomentumOutcomeSchema = z.discriminatedUnion("kind", [
  boardMomentumPanelSchema,
  boardSpotlightUnavailableSchema,
]);
export type BoardMomentumOutcome = z.infer<typeof boardMomentumOutcomeSchema>;

/* ------------------------------------------------------------------ */
/* Other pools                                                         */
/* ------------------------------------------------------------------ */

/** One other pool the same token trades in. */
export const boardOtherPoolSchema = z
  .object({
    chain: z.string().min(1).max(32),
    pairAddress: z.string().min(1).max(128),
    dexId: z.string().max(64).nullable(),
    quoteTokenSymbol: z.string().max(512).nullable(),
    liquidityUsd: z.number().nullable(),
    volumeH24Usd: z.number().nullable(),
  })
  .strict();
export type BoardOtherPool = z.infer<typeof boardOtherPoolSchema>;

/**
 * The other-pools bar.
 *
 * THE COUNT IS "SEEN", NOT "EXISTS", and the wording is load-bearing. The
 * provider answers an address query out of a bounded RELEVANCE window shared
 * with other tokens, and it offers no continuation. So `poolsSeen` is what this
 * window contained, `providerCapped` says the window was full and more exist,
 * and no field here claims to know how many pools the token trades in.
 */
export const boardOtherPoolsPanelSchema = z
  .object({
    kind: z.literal("other-pools"),
    /** Pools of this token in the window, EXCLUDING the one on screen. */
    pools: z.array(boardOtherPoolSchema).max(30),
    /** How many other pools this bounded window contained. */
    poolsSeen: z.number().int().min(0),
    /** True when the provider filled its window, so matches beyond it exist. */
    providerCapped: z.boolean(),
    /** Rows the relevance window returned that trade a DIFFERENT token. */
    unrelatedRowsDropped: z.number().int().min(0),
    /**
     * Rows removed by the display cap after ranking, so the bar can say the
     * list is shortened rather than pretending it is the whole window.
     */
    withheldByLimit: z.number().int().min(0),
    /** Frozen copy naming what the count is and is not. */
    windowNote: z.string().min(1).max(400),
    fetchedAtMs: z.number().int().nonnegative(),
  })
  .strict();

export const boardOtherPoolsOutcomeSchema = z.discriminatedUnion("kind", [
  boardOtherPoolsPanelSchema,
  boardSpotlightUnavailableSchema,
]);
export type BoardOtherPoolsOutcome = z.infer<typeof boardOtherPoolsOutcomeSchema>;

/* ------------------------------------------------------------------ */
/* Context - promotion and narrative                                   */
/* ------------------------------------------------------------------ */

/** One narrative this token sits in, joined by id. */
export const boardNarrativeSchema = z
  .object({
    /** The opaque provider id. NOT the slug: the slug matches zero pairs. */
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    slug: z.string().max(200),
  })
  .strict();
export type BoardNarrative = z.infer<typeof boardNarrativeSchema>;

/**
 * Promotion and narrative, read together because both are context about how a
 * token got in front of the reader rather than about the pool's own trade.
 *
 * `boostsActive` comes from the PAIR ROW (P4). Null means the row carried no
 * boost column, which is the ordinary answer and is NOT zero.
 *
 * `narratives` empty is the COMMON case (P6) and renders as a designed "no
 * narrative" state of the same element, never as a missing element.
 * `unjoinedMetaIds` names ids the pair carried that the catalog did not
 * resolve, so a catalog that lags is visible instead of silently shrinking the
 * list.
 */
export const boardSpotlightContextPanelSchema = z
  .object({
    kind: z.literal("context"),
    boostsActive: z.number().int().min(0).nullable(),
    /** Frozen copy: bought visibility is not demand. */
    promotionNote: z.string().min(1).max(400),
    narratives: z.array(boardNarrativeSchema).max(32),
    unjoinedMetaIds: z.array(z.string().max(64)).max(32),
    fetchedAtMs: z.number().int().nonnegative(),
  })
  .strict();

export const boardSpotlightContextOutcomeSchema = z.discriminatedUnion("kind", [
  boardSpotlightContextPanelSchema,
  boardSpotlightUnavailableSchema,
]);
export type BoardSpotlightContextOutcome = z.infer<
  typeof boardSpotlightContextOutcomeSchema
>;

/* ------------------------------------------------------------------ */
/* The tape                                                            */
/* ------------------------------------------------------------------ */

/** Rows the tape's ring holds. Bounded by the surface, stated on the wire. */
export const BOARD_TAPE_RING_SIZE = 30;

/** One trade on the tape. */
export const boardTapeRowSchema = z
  .object({
    /** `blockNumber:transactionIndex:eventIndex`, the exact provider triple. */
    id: z.string().min(3).max(80),
    side: z.enum(["buy", "sell", "add", "remove"]).nullable(),
    blockNumber: z.number().int().min(0),
    timestampMs: z.number().int().nonnegative().nullable(),
    /** Provider decimal strings. Never floats: a tape shows real sizes. */
    volumeUsd: z.string().max(64).nullable(),
    amountBase: z.string().max(64).nullable(),
    priceUsd: z.string().max(64).nullable(),
    /** The wallet, provider-spelled. */
    maker: z.string().max(128).nullable(),
    /**
     * True on the OLDEST row of a batch the poll could not join to what it
     * already held.
     *
     * An honest gap marker, never a silent one: the poll ran out of pages or
     * out of its tick deadline before it reached the block it had already
     * published, so trades between the two are missing and the reader is told
     * where.
     */
    gapBefore: z.boolean(),
  })
  .strict();
export type BoardTapeRow = z.infer<typeof boardTapeRowSchema>;

/**
 * One tick of the tape.
 *
 * ATOMIC BY CONTRACT. `rows` is the WHOLE ring after this tick, not a delta, so
 * a renderer cannot assemble a half-published batch. The watermark advances
 * only on a published tick, and a tick that could not be published leaves both
 * the ring and the watermark exactly as they were.
 *
 * `droppedIncompleteIdentity` counts rows the provider sent without the full
 * triple. They are REFUSED rather than shown, because a row that cannot be
 * deduplicated would reappear on every later tick, and the count is surfaced in
 * the data notes so the refusal is visible rather than silent.
 */
export const boardTapeTickSchema = z
  .object({
    kind: z.literal("tape"),
    rows: z.array(boardTapeRowSchema).max(BOARD_TAPE_RING_SIZE),
    /** Highest FULLY published block. The next poll's overlap anchor. */
    watermark: z.number().int().min(0).nullable(),
    /** Rows this tick added to the ring. */
    appended: z.number().int().min(0),
    /** Rows refused this tick for carrying an incomplete identity. */
    droppedIncompleteIdentity: z.number().int().min(0),
    /** Provider pages this tick spent, including the head page. */
    pagesFetched: z.number().int().min(0),
    /** True when the poll could not reach the block it had already published. */
    gapBefore: z.boolean(),
    fetchedAtMs: z.number().int().nonnegative(),
  })
  .strict();

export const boardTapeOutcomeSchema = z.discriminatedUnion("kind", [
  boardTapeTickSchema,
  boardSpotlightUnavailableSchema,
]);
export type BoardTapeOutcome = z.infer<typeof boardTapeOutcomeSchema>;

/* ------------------------------------------------------------------ */
/* Channel inputs and results                                          */
/* ------------------------------------------------------------------ */

const subjectInput = z.object({ subject: boardSpotlightSubjectSchema }).strict();

export const boardTopTradersInputSchema = subjectInput;
export type BoardTopTradersInput = z.infer<typeof boardTopTradersInputSchema>;

export const boardTopTradersResultSchema = z
  .object({
    subject: boardSpotlightSubjectSchema,
    outcome: boardTopTradersOutcomeSchema,
  })
  .strict();
export type BoardTopTradersResult = z.infer<typeof boardTopTradersResultSchema>;

export const boardMomentumInputSchema = subjectInput;
export type BoardMomentumInput = z.infer<typeof boardMomentumInputSchema>;

export const boardMomentumResultSchema = z
  .object({
    subject: boardSpotlightSubjectSchema,
    outcome: boardMomentumOutcomeSchema,
  })
  .strict();
export type BoardMomentumResult = z.infer<typeof boardMomentumResultSchema>;

export const boardOtherPoolsInputSchema = subjectInput;
export type BoardOtherPoolsInput = z.infer<typeof boardOtherPoolsInputSchema>;

export const boardOtherPoolsResultSchema = z
  .object({
    subject: boardSpotlightSubjectSchema,
    outcome: boardOtherPoolsOutcomeSchema,
  })
  .strict();
export type BoardOtherPoolsResult = z.infer<typeof boardOtherPoolsResultSchema>;

export const boardSpotlightContextInputSchema = subjectInput;
export type BoardSpotlightContextInput = z.infer<
  typeof boardSpotlightContextInputSchema
>;

export const boardSpotlightContextResultSchema = z
  .object({
    subject: boardSpotlightSubjectSchema,
    outcome: boardSpotlightContextOutcomeSchema,
  })
  .strict();
export type BoardSpotlightContextResult = z.infer<
  typeof boardSpotlightContextResultSchema
>;

/**
 * The tape poll input.
 *
 * `reset` is the ONLY control the renderer holds, and it is not a knob on the
 * provider: it says "I am entering this spotlight, forget the ring you were
 * holding for it". Without it, re-entering a spotlight would show the trades
 * from the previous visit as if they had just arrived. The watermark, the page
 * budget, the deadline and the cadence are all main's.
 */
export const boardTapePollInputSchema = z
  .object({
    subject: boardSpotlightSubjectSchema,
    reset: z.boolean(),
  })
  .strict();
export type BoardTapePollInput = z.infer<typeof boardTapePollInputSchema>;

export const boardTapePollResultSchema = z
  .object({
    subject: boardSpotlightSubjectSchema,
    outcome: boardTapeOutcomeSchema,
  })
  .strict();
export type BoardTapePollResult = z.infer<typeof boardTapePollResultSchema>;

/** The identity two sides pair a spotlight read on. Lowercased: providers vary case. */
export function boardSpotlightKey(subject: BoardSpotlightSubject): string {
  return `${subject.chain}:${subject.pairAddress}`.toLowerCase();
}
