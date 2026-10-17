/**
 * BOARD CHROME - the Board page's head controls (docs/design/R3-MINIMAL.md
 * section 9.4: Snapshot, the Live data switch, the live word, the pin), and
 * the ONE holder of the live lease.
 *
 * WHY THE LEASE LIVES HERE. `selectBoardLiveOwnerKey` derives that only a
 * bound board may hold one (A1), and this component is mounted exactly as
 * long as a board is bound and its page is up. Holding it here rather than in the grid
 * means the toggle and the subscription are the same object's business, and a
 * board with no grid rendered (a spotlight view) keeps its lease without any
 * special case. The figures are PUBLISHED to `board-live-overlay` so the grid
 * and the transcript's preview card can paint them without opening a second
 * subscription - which is the invariant the store exists to protect.
 *
 * INTENT AND STATE ARE TWO THINGS, and the reconciler below is what joins
 * them. `liveRequested` in the store is the reader's DECISION, durable across
 * a spotlight round trip; `useBoardLive` owns the LEASE, which is a handle
 * with a lifetime. The hook exposes a toggle rather than a setter, so this
 * compares the two facts and toggles on a difference. It never toggles toward
 * an unsupported build: that mode is not retryable, and a reconciler that
 * treated it as "not held yet" would loop.
 *
 * THE WORD IS DRIVEN BY THE FETCH, NOT BY THE SWITCH (the chart contract's
 * own rule). A reader who flips Live on and reads "Live" before a single tick
 * has landed has been told something untrue. So the switch reports the
 * request, "Connecting" or "Reconnecting" the lease, and "Live" only
 * `live-connected`. The same state is spoken once in a polite live region.
 *
 * PIN IS NOT SELECTION. Pinning binds the Board page to this board and
 * deliberately does not follow a newer one: the page opens the pinned board,
 * else the latest (A1/A3).
 */

import { useEffect, useMemo, useRef, type JSX } from "react";
import { LinePin } from "../../../components/icons/line/index.js";
import { Swatch } from "../../../components/ui/swatch.js";
import { useBoardLive } from "../../../lib/api/board-live.js";
import { cn } from "../../../lib/utils.js";
import { formatBoardUtcClock } from "./boardFormat.js";
import {
  isBoardLiveHeld,
  useBoardLiveOverlayStore,
} from "./board-live-overlay.js";
import {
  boardKeyOf,
  type BoardHeaderSlotProps,
} from "./board-surface-contracts.js";
import {
  registerBoardSurfaceTeardown,
  useBoardSurfaceStore,
} from "./board-surface-store.js";

/** The helper line under the switch. Frozen copy, one line per state. */
export const BOARD_LIVE_HELPER_OFF = "Refreshes in real time";
export const BOARD_LIVE_HELPER_ON = "Streaming market data";

export function BoardModalChrome({ board }: BoardHeaderSlotProps): JSX.Element {
  const boardKey = boardKeyOf(board);
  const liveRequested = useBoardSurfaceStore((s) => s.liveRequested);
  const setBoardLive = useBoardSurfaceStore((s) => s.setBoardLive);
  const pinnedBoard = useBoardSurfaceStore((s) => s.pinnedBoard);
  const pinBoard = useBoardSurfaceStore((s) => s.pinBoard);
  const unpinBoard = useBoardSurfaceStore((s) => s.unpinBoard);

  // The hook's stability contract: the pool identity must not change for a
  // mounted board, so it is derived from the persisted spec and nothing else.
  const pools = useMemo(
    () =>
      board.spec.pools.map((pool) => ({
        chain: pool.chain,
        pairAddress: pool.pairAddress,
      })),
    [board.spec],
  );
  const live = useBoardLive(pools);
  const held = isBoardLiveHeld(live.mode);
  const unsupported = live.mode === "live-unsupported";
  const publish = useBoardLiveOverlayStore((s) => s.publishBoardLive);

  // RECONCILE INTENT ONTO THE LEASE - ON A CHANGE OF INTENT, NEVER ON A
  // DIFFERENCE.
  //
  // THE DEFECT THIS SHAPE EXISTS TO AVOID, because the naive version is very
  // nearly right. Comparing `liveRequested` against `held` on every render and
  // toggling whenever they differ turns a provider that keeps failing into an
  // unbounded retry loop: the lease closes to `live-off`, the intent is still
  // on, the next render sees a difference and asks again, forever. Retry needs
  // an explicit policy and this surface has none, so intent is applied ONCE
  // per decision. A lease that ends on its own is handled below by returning
  // the decision to off, WITH the reason on screen - not by re-asking.
  const appliedIntent = useRef<boolean | null>(null);
  useEffect(() => {
    if (appliedIntent.current === liveRequested) return;
    if (liveRequested && (unsupported || !live.canToggle)) return;
    appliedIntent.current = liveRequested;
    if (liveRequested !== held) live.toggle();
  }, [liveRequested, held, unsupported, live]);

  // A LEASE THAT ENDED ON ITS OWN RETURNS THE DECISION TO OFF.
  //
  // A terminal close or an unsupported build is a fact about this board, not a
  // transient the reader should have to notice. Leaving the switch on would
  // show a control claiming a lease nobody holds; turning it off silently
  // would hide why. So the intent goes off and the lease's own sentence stays
  // in the helper line underneath.
  useEffect(() => {
    if (!liveRequested) return;
    if (live.mode !== "live-off" && !unsupported) return;
    if (appliedIntent.current !== true) return;
    setBoardLive(false);
  }, [liveRequested, live.mode, unsupported, setBoardLive]);

  // THE LEASE IS CUT BY THE STORE'S OWN CLOSE PATH, NOT ONLY BY REACT.
  //
  // `openBoardModal` documents that rebinding is a close: it runs the
  // `spotlight` and `modal` teardowns and invalidates both generations BEFORE
  // the new board is bound. The live lease was the one feed that was NOT in
  // that registry, so the one thing the rebind could not cut was the network
  // conversation with the most authority behind it. Registering here puts the
  // lease under the same close path as every other feed, which is what makes
  // "released before B subscribes" a store-ordering fact rather than a
  // consequence of React's commit order.
  //
  // Idempotent both ways: `toggle` is a no-op when nothing is held, and the
  // React cleanup below still runs for the unmount paths the store never sees.
  // `cut` rather than `toggle`, and the difference is the whole safety of it:
  // `toggle` on a board that holds nothing would SUBSCRIBE, so wiring a toggle
  // into a close path would start a lease during a teardown. `cut` only ever
  // stops.
  const cutLive = useRef(live.cut);
  cutLive.current = live.cut;
  useEffect(
    () =>
      registerBoardSurfaceTeardown("modal", `board-live:${boardKey}`, () => {
        cutLive.current();
      }),
    [boardKey],
  );

  // PUBLISH, and CLEAR ON UNMOUNT. The cleanup is what stops a closed board's
  // last tick from being painted under the next board that opens: the store
  // guards on the key too, so this is belt and braces on a value that must
  // never outlive its surface.
  useEffect(() => {
    publish({
      boardKey,
      mode: live.mode,
      rowsByKey: live.rowsByKey,
      fetchedAtMs: live.fetchedAtMs,
      notice: live.notice,
      canToggle: live.canToggle,
    });
  }, [
    publish,
    boardKey,
    live.mode,
    live.rowsByKey,
    live.fetchedAtMs,
    live.notice,
    live.canToggle,
  ]);
  useEffect(
    () => () => {
      publish(null);
    },
    [publish],
  );

  const pinned = pinnedBoard !== null && boardKeyOf(pinnedBoard) === boardKey;
  const connected = live.mode === "live-connected";
  // HOLDING A LEASE IS NOT A LANDED TICK. `held` decides whether this is the
  // live path at all; the mode decides what is said: a lease asking for a
  // socket and a lease whose socket dropped are not figures arriving now.
  const liveState: BoardLiveState = !held
    ? "snapshot"
    : connected
      ? "live"
      : live.mode === "live-degraded"
        ? "reconnecting"
        : "connecting";
  const clock = formatBoardUtcClock(
    live.fetchedAtMs ?? board.spec.hydration.marketDataFetchedAt,
  );

  return (
    <div data-vex-area="board-chrome" data-live-state={liveState} className="vex-bd-chrome">
      <div className="vex-bd-chrome__row">
        <span
          data-vex-area="board-mode-snapshot"
          data-on={held ? "false" : "true"}
          className="vex-bd-chrome__word"
        >
          Snapshot
        </span>
        <LiveSwitch
          labelId={`board-live-label-${boardKey}`}
          checked={liveRequested}
          disabled={unsupported || (!live.canToggle && !held)}
          title={
            unsupported
              ? "Live figures need the market data channel, which this build does not mount."
              : undefined
          }
          onChange={(next) => {
            setBoardLive(next);
          }}
        />
        <span
          id={`board-live-label-${boardKey}`}
          data-vex-area="board-mode-live"
          data-on={held ? "true" : "false"}
          className="vex-bd-chrome__word"
        >
          Live data
        </span>
        {/* Status by fill, always with its word: a solid square is figures
          * arriving, the dot screen a socket still connecting or dropped. The
          * word is the meaning; nothing is said while the board is a snapshot
          * (the switch says that). */}
        {connected ? (
          <span data-vex-area="board-live-dot" className="vex-bd-chrome__live">
            <Swatch state="done" size={9} />
            Live
          </span>
        ) : held ? (
          <span data-vex-area="board-live-state" className="vex-bd-chrome__live">
            <Swatch state="listening" size={9} />
            {liveState === "reconnecting" ? "Reconnecting" : "Connecting"}
          </span>
        ) : null}
        <button
          type="button"
          data-vex-area="board-pin"
          aria-pressed={pinned}
          aria-label={pinned ? "Unpin this board" : "Pin this board"}
          title={
            pinned
              ? "Unpin this board"
              : "Pin this board: the Board page keeps opening it until you unpin it"
          }
          onClick={() => {
            if (pinned) unpinBoard();
            else pinBoard(board);
          }}
          className="vex-bd-key"
        >
          <LinePin size={16} />
        </button>
      </div>
      <p data-vex-area="board-live-helper" className="vex-bd-chrome__helper">
        {/* The lease's own sentence wins when it has one to say: an
          * unsupported build or a terminal close is a fact about THIS board,
          * and it must not be overwritten by the ordinary helper copy. */}
        {live.notice ?? (held ? BOARD_LIVE_HELPER_ON : BOARD_LIVE_HELPER_OFF)}
      </p>
      {/* The live state is a fact about the figures on the page, so it is
        * SPOKEN as well as painted: whether prices are updating changes what
        * they mean. */}
      <p aria-live="polite" className="sr-only" data-vex-area="board-live-region">
        {liveRegionText(board.title, liveState, clock)}
      </p>
    </div>
  );
}

/** What the board's figures are doing right now, in the four words the page uses. */
type BoardLiveState = "snapshot" | "connecting" | "reconnecting" | "live";

/** The polite announcement for a live state change (the old rail's sentences). */
export function liveRegionText(
  title: string,
  state: BoardLiveState,
  clock: string | null,
): string {
  switch (state) {
    case "live":
      return `${title}: live figures`;
    case "connecting":
      return `${title}: connecting to live figures, still showing figures${clock === null ? "" : ` read at ${clock}`}`;
    case "reconnecting":
      return `${title}: reconnecting, figures may be behind${clock === null ? "" : `, last read at ${clock}`}`;
    case "snapshot":
      return `${title}: snapshot figures${clock === null ? "" : ` read at ${clock}`}`;
  }
}

/**
 * The Live data switch: the kit switch (docs/design/R3-MINIMAL.md section
 * 1.5, `.vex-switch`, 32 x 18).
 *
 * `role="switch"` with `aria-checked`, because this is a persistent on/off
 * state rather than an action - which is exactly the distinction the owner
 * drew between this control and the tile's Spotlight BUTTON. A real `<button>`
 * underneath, so it is in the tab order and Enter and Space operate it with no
 * key handler of ours. The name comes from the visible "Live data" text
 * through `aria-labelledby`, so the label and the control cannot drift apart.
 */
function LiveSwitch({
  labelId,
  checked,
  disabled,
  title,
  onChange,
}: {
  readonly labelId: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly title?: string | undefined;
  readonly onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      disabled={disabled}
      title={title}
      data-vex-area="board-live-switch"
      onClick={() => {
        onChange(!checked);
      }}
      className={cn("vex-switch", disabled && "cursor-not-allowed opacity-50")}
    />
  );
}
