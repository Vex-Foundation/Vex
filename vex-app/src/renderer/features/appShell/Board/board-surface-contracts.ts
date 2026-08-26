/**
 * BOARD SURFACE CONTRACTS - the frozen vocabulary of the board surfaces.
 *
 * This module is TYPES plus a handful of pure functions, and nothing else: no
 * React state, no network, no store. Four surfaces (transcript preview card,
 * modal grid, spotlight, BOOK sidebar) and two later builders read the same
 * names from here, so a change to what a board IS lands in one file rather
 * than in five components.
 *
 * Direction of dependency is one-way: `board-surface-store.ts` imports this
 * module for its vocabulary; this module imports nothing from the store.
 *
 * What is deliberately NOT here: any implementation the later waves own. The
 * safety classifier is a SIGNATURE and a frozen chip table (T4 writes the
 * function); the live scheduler is a channel DESCRIPTOR (T4 writes the
 * scheduler). Freezing the shapes now is what lets those builders land
 * without renegotiating with the surfaces.
 */

import type { ComponentType } from "react";
import type { BoardHydratedRow, BoardSpecV1 } from "@vex-lib/board/index.js";
import type { BoardDataMode } from "../../../lib/api/board-live.js";

/* ------------------------------------------------------------------ */
/* Board identity                                                      */
/* ------------------------------------------------------------------ */

/**
 * A board as every surface refers to it.
 *
 * The spec rides ALONG rather than being looked up: a historical transcript
 * row owns its own `row.board` document and must render from it even when the
 * store's selection points somewhere else entirely. The store owns SELECTION
 * and ephemeral surface state, never the documents.
 */
export interface BoardRef {
  readonly sessionId: string;
  /** Transcript message row the board was persisted on. */
  readonly messageId: number;
  readonly spec: BoardSpecV1;
  /** `spec.title`, carried so a header can render without re-reading the spec. */
  readonly title: string;
  /** `hydration.analysisCreatedAt`: when the agent composed this board. */
  readonly createdAt: number;
}

/**
 * The identity two boards are compared by.
 *
 * Session-scoped on purpose: message ids are per-session, so `12` in one
 * session and `12` in another are different boards and must not share a
 * filter, a scroll offset or an unseen dot.
 */
export type BoardKey = string;

export function boardKeyOf(ref: BoardRef): BoardKey {
  return `${ref.sessionId}:${String(ref.messageId)}`;
}

/** Build a `BoardRef` from the two facts a transcript row already holds. */
export function boardRefOf(
  sessionId: string,
  messageId: number,
  spec: BoardSpecV1,
): BoardRef {
  return {
    sessionId,
    messageId,
    spec,
    title: spec.title,
    createdAt: spec.hydration.analysisCreatedAt,
  };
}

/** Which view the modal is showing. Independent of the selected pool. */
export type BoardSurfaceView = "grid" | "spotlight";

/**
 * Why every board surface is being torn down.
 *
 * Named rather than boolean because the three exits differ in what survives:
 * a session switch keeps the boards of the session being switched TO, while
 * leaving the shell keeps nothing.
 */
export type BoardExitReason = "session-switch" | "home" | "app-shell-exit";

/**
 * How a board row reached the screen.
 *
 * The ONLY input that may light the sidebar's unseen dot. A historical mount
 * and an older page loaded by pagination are both `settled`; only a row that
 * arrived while the reader was watching is a `live-append`.
 */
export type BoardArrival = "live-append" | "settled";

/* ------------------------------------------------------------------ */
/* Pair subject (A6)                                                   */
/* ------------------------------------------------------------------ */

/** Which side of the pair the board's subject token sits on. */
export type PairOrientation = "base" | "quote";

/**
 * ONE canonical description of "the pair this surface is about".
 *
 * Every later read - candles, trades, top traders, pair details, other pools -
 * is addressed by this sidecar rather than by five slightly different tuples,
 * which is what keeps a spotlight chart and a spotlight tape from quietly
 * describing two different pools.
 *
 * Every string is PROVIDER-SPELLED and passed through untouched. `ammId` is
 * DexScreener's `dexId`; normalising its case here would break the joins the
 * provider itself performs on it.
 */
export interface PairSubject {
  /** Provider chain slug, e.g. `base`, `solana`. */
  readonly chain: string;
  readonly pairAddress: string;
  /** AMM the pool belongs to, or null when the row carried none. */
  readonly ammId: string | null;
  readonly baseTokenSymbol: string | null;
  readonly baseTokenName: string | null;
  readonly quoteTokenSymbol: string | null;
  /**
   * Which token of the pair the board is talking about.
   *
   * Always `base` for a board composed today (the spec names a pool and the
   * card headlines its base token). The field exists so a consumer never has
   * to ASSUME that, and so a quote-oriented subject can be expressed later
   * without changing every call site.
   */
  readonly orientation: PairOrientation;
}

/** The key a per-pair cache, map or live channel is filed under. */
export function pairSubjectKey(subject: PairSubject): string {
  return `${subject.chain}:${subject.pairAddress}`;
}

/**
 * Derive the subject from a pool the agent named plus its hydrated row.
 *
 * The row may be null (a degraded card whose figures never landed); the pool
 * coordinates alone are still a valid subject, because they are what every
 * later read is addressed by.
 */
export function pairSubjectFromPool(
  pool: BoardSpecV1["pools"][number],
  row: BoardHydratedRow | null,
): PairSubject {
  return {
    chain: pool.chain,
    pairAddress: pool.pairAddress,
    ammId: row?.dexId ?? null,
    baseTokenSymbol: row?.baseTokenSymbol ?? null,
    baseTokenName: row?.baseTokenName ?? null,
    quoteTokenSymbol: row?.quoteTokenSymbol ?? null,
    orientation: "base",
  };
}

/* ------------------------------------------------------------------ */
/* Safety classifier (A5) - ONE OWNER, in `shared/`                    */
/* ------------------------------------------------------------------ */

/**
 * The safety vocabulary, the frozen chip table and the classifier itself are
 * RE-EXPORTED from `@shared/board/safety-classifier.js` rather than declared
 * here.
 *
 * A0 froze this seam and left the body to T4. The body has to live in
 * `shared/` because it is the only tree both the privileged main process and
 * this renderer may import, and declaring the shapes in both places would be a
 * second source of truth for a security decision. So the shapes moved to the
 * owner of the function, and this gate's public surface is unchanged: every
 * consumer still imports these names from the Board contracts module.
 *
 * `spec.analysis` is deliberately not an input. Model prose never steers the
 * chip's colour.
 */
export {
  BOARD_SAFETY_CHIP,
  BOARD_SAFETY_STATES,
  boardSafetyVerdict,
  classifyBoardSafety,
  countBoardSafety,
  describeBoardSafetyCounts,
} from "@shared/board/safety-classifier.js";

export type {
  BoardSafetyAttempt,
  BoardSafetyBucket,
  BoardSafetyCheck,
  BoardSafetyClassification,
  BoardSafetyCounts,
  BoardSafetyDetails,
  BoardSafetyEvidence,
  BoardSafetyFailure,
  BoardSafetyLastGood,
  BoardSafetyState,
  BoardSafetyTone,
  BoardSafetyVerdict,
  ClassifyBoardSafety,
} from "@shared/board/safety-classifier.js";

export {
  CONCENTRATION_PCT,
  NEW_PAIR_SECONDS,
  TAX_HARD_PCT,
  TAX_RISK_PCT,
  safetyChecksFromBundle,
  showsNewPairChip,
} from "@shared/board/safety-checks.js";

/* ------------------------------------------------------------------ */
/* Ask VEX intent (A4)                                                 */
/* ------------------------------------------------------------------ */

/**
 * The board facts pinned into an Ask VEX question at the moment it is sent.
 *
 * FROZEN AT PRESS TIME. A live board is moving; a question about "this token"
 * whose figures were re-read on the way to the engine would be a question
 * about a different board than the one the reader was looking at.
 */
export interface BoardAskContext {
  readonly boardTitle: string;
  readonly tokenSymbol: string | null;
  readonly tokenName: string | null;
  readonly chain: string;
  readonly pairAddress: string;
  readonly ammId: string | null;
  /** Price as a decimal string, never a float. Null when none was reported. */
  readonly priceUsd: string | null;
  readonly dataMode: BoardDataMode;
  /** The clock the figures above were read at, ms epoch UTC. */
  readonly observedAtMs: number;
}

/**
 * A question the board surface handed to the RESIDENT composer.
 *
 * There is no second submit path: the modal never calls the chat API. It
 * parks this envelope, the composer that already owns the mutex, the mission
 * gate, steering, the queue and retry consumes it, and the answer lands in
 * the main transcript like any other turn.
 *
 * Consume-once: the composer clears the envelope before dispatching, and
 * `intentId` gives it a stable key so StrictMode's double effect cannot send
 * the same question twice.
 */
export interface BoardAskIntent {
  readonly sessionId: string;
  readonly boardKey: BoardKey;
  readonly intentId: string;
  readonly context: BoardAskContext;
  /**
   * The exact text to submit, context envelope included.
   *
   * Built by {@link buildBoardAskMessage} so the context the reader saw as a
   * chip is INSIDE the message that gets persisted: logged by construction,
   * never a hidden prompt layer the transcript cannot reproduce.
   */
  readonly message: string;
}

/** The four questions the panel offers before the reader edits one. */
export const BOARD_ASK_QUICK_QUESTIONS: readonly string[] = [
  "Why is it moving?",
  "Check the risks",
  "Compare with another token",
  "Show entry and exit scenarios",
];

function utcMinuteStamp(ms: number): string {
  const at = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${String(at.getUTCFullYear())}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}` +
    ` ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`
  );
}

/** Is this mode a live lease, or the persisted snapshot? */
function isLiveMode(mode: BoardDataMode): boolean {
  return mode === "live-connecting" || mode === "live-connected" || mode === "live-degraded";
}

/**
 * THE FROZEN ASK VEX ENVELOPE.
 *
 * Plain text, one fact per line, no truncation anywhere (the pair address is
 * printed whole - an elided address is not an address). Unknown facts say so
 * in words rather than vanishing, because a missing line reads as "not
 * relevant" while "not reported" is the truth.
 *
 * The exact bytes are pinned by test: this string is persisted into the
 * transcript and read back by the model, so it is a contract, not copy.
 */
export function buildBoardAskMessage(
  context: BoardAskContext,
  question: string,
): string {
  const symbol = context.tokenSymbol ?? "unknown symbol";
  const named =
    context.tokenName !== null && context.tokenName !== context.tokenSymbol
      ? `${symbol} (${context.tokenName})`
      : symbol;
  const pair =
    context.ammId !== null
      ? `${context.pairAddress} on ${context.ammId}`
      : context.pairAddress;
  const price =
    context.priceUsd !== null ? `${context.priceUsd} USD` : "not reported";
  const reading = isLiveMode(context.dataMode) ? "live" : "snapshot";
  return [
    "[Board context]",
    `Board: ${context.boardTitle}`,
    `Token: ${named} on ${context.chain}`,
    `Pair: ${pair}`,
    `Price: ${price}`,
    `Figures: ${reading}, read at ${utcMinuteStamp(context.observedAtMs)}`,
    "",
    question,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Live scheduler channels (A7) - ONE OWNER, in `shared/`              */
/* ------------------------------------------------------------------ */

/**
 * The channel vocabulary, the in-flight cap, the cadences and the priority
 * table are RE-EXPORTED from `@shared/board/live-channels.js` rather than
 * declared here, for the same reason the safety classifier is: the scheduler
 * that runs these channels is a main-process owner, main cannot import the
 * renderer, and two declarations of "which channels exist" would be two
 * answers to "was this result still wanted" - the exact question the
 * generation fence exists to settle.
 *
 * The DESCRIPTOR stays here, because it is the shape a SURFACE hands the
 * scheduler and it names `PairSubject`, which is this module's own.
 */
export {
  BOARD_LIVE_CHANNEL_IDS,
  BOARD_LIVE_CHANNEL_OWNER,
  BOARD_LIVE_CHANNEL_PRIORITY,
  BOARD_LIVE_MAX_IN_FLIGHT,
  CADENCE_CARDS_MS,
  CADENCE_DETAILS_MS,
  CADENCE_TAPE_MS,
  CADENCE_TRADERS_MS,
  chartCadenceMsFor,
} from "@shared/board/live-channels.js";

export type {
  BoardLiveChannelId,
  BoardLiveChannelOwner,
} from "@shared/board/live-channels.js";

import type {
  BoardLiveChannelId as LiveChannelId,
  BoardLiveChannelOwner as LiveChannelOwner,
} from "@shared/board/live-channels.js";

/**
 * One scheduled read, as the board-wide scheduler sees it.
 *
 * The four fields below are exactly what makes a result attributable: which
 * channel, how often, who yields under the in-flight cap, and which generation
 * the answer belongs to.
 */
export interface BoardLiveChannelDescriptor {
  readonly id: LiveChannelId;
  readonly owner: LiveChannelOwner;
  /** Poll interval; null for a one-shot read that never repeats. */
  readonly cadenceMs: number | null;
  /** Lower number runs first when the in-flight cap is contended. */
  readonly priority: number;
  /**
   * The board generation this channel was armed under.
   *
   * A result carrying an older generation is DROPPED rather than published:
   * the surface that asked for it is gone.
   */
  readonly generation: number;
  /** The pair the channel reads, or null for a board-wide channel. */
  readonly subject: PairSubject | null;
}

/* ------------------------------------------------------------------ */
/* Surface slots and the preview card's props                          */
/* ------------------------------------------------------------------ */

/**
 * What the modal's header controls are handed.
 *
 * The host paints the header FRAME (product name, subtitle, close control);
 * the controls that belong to the product (Snapshot / Live data, pin, filter)
 * mount here, so adding one never edits the host.
 */
export interface BoardHeaderSlotProps {
  readonly board: BoardRef;
}

/**
 * What the line UNDER the model's title is handed.
 *
 * ADDITIVE to A0's three slots, and it exists because the subtitle has an
 * exact place in the design that the header's right cluster cannot reach: it
 * sits directly beneath the title, on the left. The grid used to carry it in
 * a sticky bar of its own, which put a fact the HOST owns (this board's pool
 * count and the clock its figures were read at) inside a view that can be
 * replaced by the spotlight. Here it belongs to the frame, so it is the same
 * line whichever view is showing.
 */
export interface BoardSubtitleSlotProps {
  readonly board: BoardRef;
}

/** What the modal's grid view is handed. */
export interface BoardGridSlotProps {
  readonly board: BoardRef;
}

/** What the modal's spotlight view is handed. */
export interface BoardSpotlightSlotProps {
  readonly board: BoardRef;
  /** Which pool of `board.spec.pools` the spotlight is about. */
  readonly poolIndex: number;
}

/** What the modal's Ask VEX side panel is handed. */
export interface BoardAskSlotProps {
  readonly board: BoardRef;
  readonly poolIndex: number;
}

/**
 * A component the host mounts into one of its slots.
 *
 * The host renders the frame, the header, the close paths and the unmount
 * discipline; the slots render the product. Neither knows the other's
 * internals, which is what lets T1, T2 and T3 land in parallel.
 */
export type BoardSurfaceSlot<P> = ComponentType<P>;

/** What a surface may read about the live lease without owning it. */
export interface BoardLiveReadout {
  readonly mode: BoardDataMode;
  /** True when THIS board is the one holding the single live lease. */
  readonly isLiveOwner: boolean;
  /** Clock of the last landed tick, or null when none has landed. */
  readonly lastTickAtMs: number | null;
}

/**
 * The transcript row's compact board card (T1 writes the component).
 *
 * Frozen here so the one-line change site in `TranscriptMessage.tsx` is a
 * one-line change: the row already holds its own persisted spec, the open
 * action is the store's, and the live readout is a read, never a lease.
 */
export interface BoardPreviewCardProps {
  readonly board: BoardRef;
  readonly onOpen: (board: BoardRef) => void;
  readonly live: BoardLiveReadout;
}
