/**
 * BOARD SURFACE STORE - the one owner of "which board, which view, whose
 * lease" for the board surfaces.
 *
 * Book-local Zustand in the shape of `book/inspect/inspect-store.ts`: UI state
 * only, NEVER persisted (a board selection is session data, not a preference)
 * and deliberately not a `uiStore` slot.
 *
 * WHAT THIS STORE OWNS: selection, view, the ephemeral per-board surface state
 * (filter, scroll, selected pool), the live-lease intent, the unseen dot, the
 * teardown registry and the generations that fence async results.
 *
 * WHAT IT DOES NOT OWN: board documents. A historical transcript row renders
 * from its OWN `row.board`; the refs held here are selections that happen to
 * carry their spec along so a header can render without a second lookup.
 *
 * FOUR IDENTITIES, deliberately separate (A1):
 *  - `latestBoard`  the most recently composed board in this session;
 *  - `pinnedBoard`  what the BOOK sidebar shows, which a newer board must NOT
 *                   silently replace (the unseen dot is how the reader learns
 *                   a newer one exists);
 *  - `modalBoard`   the board the open modal is bound to;
 *  - the live lease, DERIVED from `modalBoard` + `liveRequested` rather than
 *    stored, so a lease can never survive the surface that asked for it.
 */

import { create } from "zustand";
import type { SettledIdsTracker } from "../SessionTranscript/settledIds.js";
import {
  boardKeyOf,
  type BoardArrival,
  type BoardExitReason,
  type BoardKey,
  type BoardLiveChannelOwner,
  type BoardRef,
  type BoardSafetyState,
  type BoardSurfaceView,
} from "./board-surface-contracts.js";

/**
 * The modal's filter bar (A2): a chain and a safety state, both optional.
 * Keyed by board identity, so switching boards never inherits a filter that
 * would hide every card on the new one.
 */
export interface BoardFilter {
  readonly chain: string | null;
  readonly safety: BoardSafetyState | null;
}

export const BOARD_FILTER_NONE: BoardFilter = { chain: null, safety: null };

/** Which surface's resources a teardown belongs to. */
export type BoardTeardownScope = BoardLiveChannelOwner;

/** Where the exit came from, and what survives it. */
export interface BoardExitIntent {
  readonly reason: BoardExitReason;
  /**
   * The session whose boards survive this exit, or null when none do.
   *
   * A session switch passes the session being switched TO; leaving the shell
   * or going home passes null.
   */
  readonly keepSessionId: string | null;
}

/* ------------------------------------------------------------------ */
/* Teardown registry                                                   */
/* ------------------------------------------------------------------ */

/**
 * Live surfaces register how to cut themselves; exits run the registry.
 *
 * Module-level rather than inside the reactive state because a Map of
 * callbacks is not something any component renders, and putting it in the
 * store would rerender every subscriber whenever a channel armed itself.
 *
 * The store is still the OWNER: nothing else invokes these callbacks, and
 * every transition that cuts a feed goes through one of its actions.
 */
const teardowns = new Map<BoardTeardownScope, Map<string, () => void>>([
  ["modal", new Map()],
  ["spotlight", new Map()],
]);

/**
 * Teardown callbacks that threw, most recent run first.
 *
 * A cleanup failure must not stop the remaining cleanups, and must not be
 * swallowed either. Kept for tests and reported to the console once per run.
 */
export interface BoardTeardownFailure {
  readonly scope: BoardTeardownScope;
  readonly id: string;
  readonly error: unknown;
}

let lastTeardownFailures: readonly BoardTeardownFailure[] = [];

export function readBoardTeardownFailures(): readonly BoardTeardownFailure[] {
  return lastTeardownFailures;
}

/**
 * Register a surface's cut-it-now callback.
 *
 * Returns the unregister function, which the caller runs on unmount. The
 * callback must be idempotent: an exit and a React unmount can both reach it.
 */
export function registerBoardSurfaceTeardown(
  scope: BoardTeardownScope,
  id: string,
  teardown: () => void,
): () => void {
  const scoped = teardowns.get(scope);
  if (scoped === undefined) return () => {};
  scoped.set(id, teardown);
  return () => {
    if (scoped.get(id) === teardown) scoped.delete(id);
  };
}

/** Test seam: how many teardowns are armed in a scope right now. */
export function countBoardSurfaceTeardowns(scope: BoardTeardownScope): number {
  return teardowns.get(scope)?.size ?? 0;
}

function runTeardowns(scopes: readonly BoardTeardownScope[]): void {
  const failures: BoardTeardownFailure[] = [];
  for (const scope of scopes) {
    const scoped = teardowns.get(scope);
    if (scoped === undefined) continue;
    // Snapshot before running: a teardown is allowed to unregister itself.
    for (const [id, teardown] of Array.from(scoped.entries())) {
      try {
        teardown();
      } catch (error) {
        failures.push({ scope, id, error });
      }
    }
  }
  lastTeardownFailures = failures;
  for (const failure of failures) {
    console.error(
      `board surface teardown failed (${failure.scope}/${failure.id})`,
      failure.error,
    );
  }
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

interface BoardSurfaceData {
  readonly latestBoard: BoardRef | null;
  readonly pinnedBoard: BoardRef | null;
  readonly modalBoard: BoardRef | null;
  /**
   * The board whose arrival the reader has not acknowledged, or null.
   *
   * Settable through ONE path: {@link BoardSurfaceState.noteBoardRow} called
   * with a `live-append` arrival. A historical mount, a re-render and an
   * older page loaded by pagination all pass `settled` and cannot light it.
   */
  readonly unseenBoardKey: BoardKey | null;
  /** The identity the ephemeral block below belongs to. */
  readonly surfaceKey: BoardKey | null;
  readonly view: BoardSurfaceView;
  /**
   * The pool the spotlight is (or was last) about.
   *
   * Independent of `view` on purpose: going back to the grid must not forget
   * which token the reader was studying.
   */
  readonly selectedPoolIndex: number;
  readonly filter: BoardFilter;
  readonly scrollTop: number;
  /**
   * Is the Ask VEX side panel open?
   *
   * Ephemeral in the strongest sense: it does not survive a close, because
   * an unsent question the reader walked away from is not state worth
   * restoring next to a board whose figures have moved on.
   */
  readonly askPanelOpen: boolean;
  /** The live TOGGLE's intent. The lease itself is derived; see the selector. */
  readonly liveRequested: boolean;
  /** Fences board-wide results. Bumped by every cut. */
  readonly modalGeneration: number;
  /** Fences spotlight results. Bumped by leaving, closing or changing token. */
  readonly spotlightGeneration: number;
}

interface BoardSurfaceActions {
  /**
   * Record a board row the transcript rendered.
   *
   * `arrival` is the ONLY thing that decides whether the unseen dot lights.
   * Derive it with {@link boardArrivalOf} rather than guessing.
   */
  readonly noteBoardRow: (board: BoardRef, arrival: BoardArrival) => void;
  /**
   * The reader has now SEEN this board: clear its unseen dot.
   *
   * Key-guarded, because there are two clear paths and both must be about
   * the same board (A13): the BOOK's Board tab becoming selected with this
   * board visible in the ActiveBoard module, and this board's modal opening
   * from anywhere. A dot for a DIFFERENT board is left alone.
   */
  readonly acknowledgeBoardSeen: (key: BoardKey) => void;
  /** Pin a board into the BOOK. A newer board never overwrites this. */
  readonly pinBoard: (board: BoardRef) => void;
  readonly unpinBoard: () => void;
  readonly openBoardModal: (board: BoardRef) => void;
  /**
   * THE ONE CLOSE PATH. X, Esc, backdrop, a session switch and app teardown
   * all arrive here: generations bump and every feed is cut BEFORE the modal
   * state clears, so nothing is left polling behind a closed dialog.
   */
  readonly closeBoardModal: () => void;
  readonly setBoardView: (view: BoardSurfaceView) => void;
  readonly selectBoardPool: (poolIndex: number) => void;
  /** Grid -> spotlight in one transition. */
  readonly openBoardSpotlight: (poolIndex: number) => void;
  readonly setBoardAskOpen: (open: boolean) => void;
  readonly setBoardFilter: (filter: BoardFilter) => void;
  readonly setBoardScrollTop: (scrollTop: number) => void;
  /** The live toggle. Switching it OFF cuts the feeds immediately. */
  readonly setBoardLive: (requested: boolean) => void;
  /** Session switch / home / shell exit: cut everything, then forget. */
  readonly exitBoardSurfaces: (intent: BoardExitIntent) => void;
}

export type BoardSurfaceState = BoardSurfaceData & BoardSurfaceActions;

const EPHEMERAL_DEFAULTS = {
  view: "grid",
  selectedPoolIndex: 0,
  filter: BOARD_FILTER_NONE,
  scrollTop: 0,
  liveRequested: false,
  askPanelOpen: false,
} as const satisfies Pick<
  BoardSurfaceData,
  | "view"
  | "selectedPoolIndex"
  | "filter"
  | "scrollTop"
  | "liveRequested"
  | "askPanelOpen"
>;

/**
 * Ephemeral state for `board`, reset when the identity changed.
 *
 * Returns the fields to merge, so an open on the SAME board restores the
 * filter, the scroll offset and the selected token exactly as they were.
 */
function identityState(
  state: BoardSurfaceData,
  board: BoardRef,
): Partial<BoardSurfaceData> {
  const key = boardKeyOf(board);
  if (state.surfaceKey === key) return {};
  return { surfaceKey: key, ...EPHEMERAL_DEFAULTS };
}

/** Is `next` at least as recent as `current`? Clock first, row id as tiebreak. */
function isAtLeastAsRecent(next: BoardRef, current: BoardRef): boolean {
  if (next.createdAt !== current.createdAt) return next.createdAt > current.createdAt;
  return next.messageId >= current.messageId;
}

export const useBoardSurfaceStore = create<BoardSurfaceState>((set, get) => ({
  latestBoard: null,
  pinnedBoard: null,
  modalBoard: null,
  unseenBoardKey: null,
  surfaceKey: null,
  ...EPHEMERAL_DEFAULTS,
  modalGeneration: 0,
  spotlightGeneration: 0,

  noteBoardRow: (board, arrival) =>
    set((state) => {
      const key = boardKeyOf(board);
      const latest =
        state.latestBoard === null || isAtLeastAsRecent(board, state.latestBoard)
          ? board
          : state.latestBoard;
      if (arrival !== "live-append") return { latestBoard: latest };
      // A live arrival the reader is already looking at is not unseen.
      const alreadyOpen = state.modalBoard !== null && boardKeyOf(state.modalBoard) === key;
      return {
        latestBoard: latest,
        unseenBoardKey: alreadyOpen ? state.unseenBoardKey : key,
      };
    }),

  acknowledgeBoardSeen: (key) =>
    set((state) => (state.unseenBoardKey === key ? { unseenBoardKey: null } : {})),

  pinBoard: (board) => set({ pinnedBoard: board }),
  unpinBoard: () => set({ pinnedBoard: null }),

  openBoardModal: (board) => {
    const key = boardKeyOf(board);
    const bound = get().modalBoard;
    // REBINDING IS A CLOSE. Opening a different board while one is up (the
    // BOOK's Open board while a modal is already open) leaves the previous
    // board's channels reading a pair nobody is looking at, so the feeds are
    // cut and both generations are invalidated BEFORE the new binding lands.
    const rebinding = bound !== null && boardKeyOf(bound) !== key;
    if (rebinding) runTeardowns(["spotlight", "modal"]);
    set((state) => ({
      ...identityState(state, board),
      modalBoard: board,
      // A13 clear path (b): opening this board's modal, from anywhere, is
      // the reader seeing it.
      unseenBoardKey: state.unseenBoardKey === key ? null : state.unseenBoardKey,
      ...(rebinding
        ? {
            modalGeneration: state.modalGeneration + 1,
            spotlightGeneration: state.spotlightGeneration + 1,
          }
        : {}),
    }));
  },

  closeBoardModal: () => {
    // Cut first, clear second. A teardown that ran after the state cleared
    // would be a poll racing an unmounted surface.
    runTeardowns(["spotlight", "modal"]);
    set((state) => ({
      modalBoard: null,
      askPanelOpen: false,
      modalGeneration: state.modalGeneration + 1,
      spotlightGeneration: state.spotlightGeneration + 1,
    }));
  },

  setBoardView: (view) => {
    const previous = get().view;
    if (previous === view) return;
    // Leaving the spotlight cuts ITS channels only: the grid's batch lease
    // belongs to the modal and is still being watched.
    if (previous === "spotlight") {
      runTeardowns(["spotlight"]);
      set((state) => ({ view, spotlightGeneration: state.spotlightGeneration + 1 }));
      return;
    }
    set({ view });
  },

  selectBoardPool: (poolIndex) => {
    const state = get();
    if (state.selectedPoolIndex === poolIndex) return;
    // A different token is a different subject: every spotlight channel is
    // reading the old pair and must be cut, not repointed mid-flight.
    if (state.view === "spotlight") {
      runTeardowns(["spotlight"]);
      set((current) => ({
        selectedPoolIndex: poolIndex,
        spotlightGeneration: current.spotlightGeneration + 1,
      }));
      return;
    }
    set({ selectedPoolIndex: poolIndex });
  },

  openBoardSpotlight: (poolIndex) => {
    get().selectBoardPool(poolIndex);
    get().setBoardView("spotlight");
  },

  setBoardAskOpen: (open) => set({ askPanelOpen: open }),
  setBoardFilter: (filter) => set({ filter }),
  setBoardScrollTop: (scrollTop) => set({ scrollTop }),

  setBoardLive: (requested) => {
    if (get().liveRequested === requested) return;
    if (!requested) {
      runTeardowns(["spotlight", "modal"]);
      set((state) => ({
        liveRequested: false,
        modalGeneration: state.modalGeneration + 1,
        spotlightGeneration: state.spotlightGeneration + 1,
      }));
      return;
    }
    set({ liveRequested: true });
  },

  exitBoardSurfaces: ({ keepSessionId }) => {
    // Converges on the ONE close action: an exit is a close plus forgetting
    // what belonged to the surface being left.
    get().closeBoardModal();
    set((state) => {
      const keeps = (ref: BoardRef | null): BoardRef | null =>
        ref !== null && ref.sessionId === keepSessionId ? ref : null;
      const unseenKept =
        state.unseenBoardKey !== null &&
        keepSessionId !== null &&
        state.unseenBoardKey.startsWith(`${keepSessionId}:`);
      const surfaceKept =
        state.surfaceKey !== null &&
        keepSessionId !== null &&
        state.surfaceKey.startsWith(`${keepSessionId}:`);
      return {
        latestBoard: keeps(state.latestBoard),
        pinnedBoard: keeps(state.pinnedBoard),
        unseenBoardKey: unseenKept ? state.unseenBoardKey : null,
        ...(surfaceKept
          ? {}
          : { surfaceKey: null, ...EPHEMERAL_DEFAULTS }),
      };
    });
  },
}));

/* ------------------------------------------------------------------ */
/* Derivations                                                         */
/* ------------------------------------------------------------------ */

/**
 * WHO HOLDS THE LIVE LEASE, or null when nobody does.
 *
 * Derived rather than stored: one field cannot desync from another that does
 * not exist. A lease requires an OPEN modal and a requested toggle, so
 * closing the modal releases it by construction.
 */
export function selectBoardLiveOwnerKey(state: BoardSurfaceState): BoardKey | null {
  if (state.modalBoard === null || !state.liveRequested) return null;
  return boardKeyOf(state.modalBoard);
}

/** Are the spotlight's channels (candles, tape, traders) allowed to run? */
export function selectSpotlightChannelsActive(state: BoardSurfaceState): boolean {
  return state.modalBoard !== null && state.view === "spotlight";
}

/**
 * Decide how a board row reached the screen.
 *
 * The transcript already keeps a {@link SettledIdsTracker} to separate live
 * arrivals from history and pagination; this reads the same bookkeeping so
 * the unseen dot and the print animation can never disagree about what "new"
 * means.
 *
 * FAILS CLOSED: no tracker, or a tracker for another session, means the
 * provenance is unknown, and unknown provenance never lights the dot.
 */
export function boardArrivalOf(
  tracker: SettledIdsTracker | null,
  sessionId: string,
  messageId: number,
): BoardArrival {
  if (tracker === null || tracker.sessionId !== sessionId) return "settled";
  return tracker.ids.has(messageId) ? "settled" : "live-append";
}
