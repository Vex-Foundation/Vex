/**
 * BOARD MODAL CHROME - the header controls, and the ONE holder of the live
 * lease.
 *
 * WHY THE LEASE LIVES HERE. `selectBoardLiveOwnerKey` derives that only an
 * open modal may hold one (A1), and this component is mounted exactly as long
 * as a board is bound to that modal. Holding it here rather than in the grid
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
 * THE DOT IS DRIVEN BY THE FETCH, NOT BY THE SWITCH (the chart contract's own
 * rule). A reader who flips Live on and sees a green LIVE dot before a single
 * tick has landed has been told something untrue. So the switch reports the
 * request and the dot reports `live-connected`.
 *
 * PIN IS NOT SELECTION. Pinning binds the BOOK to this board and deliberately
 * does not follow a newer one; the unseen dot is how the reader learns a newer
 * board exists (A1/A3).
 */

import { useEffect, useMemo, useRef, type JSX } from "react";
import { IconBookOpen } from "../../../components/icons/index.js";
import { useBoardLive } from "../../../lib/api/board-live.js";
import { cn } from "../../../lib/utils.js";
import {
  isBoardLiveHeld,
  useBoardLiveOverlayStore,
} from "./board-live-overlay.js";
import {
  boardKeyOf,
  type BoardHeaderSlotProps,
} from "./board-surface-contracts.js";
import { useBoardSurfaceStore } from "./board-surface-store.js";

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

  return (
    <div
      data-vex-area="board-chrome"
      className="flex flex-col items-end gap-1"
    >
      <div className="flex items-center gap-3">
        <span
          data-vex-area="board-mode-snapshot"
          className={cn(
            "text-[13px] leading-[18px]",
            held ? "text-ink-tertiary" : "text-ink-secondary",
          )}
        >
          Snapshot
        </span>
        <span aria-hidden className="h-4 w-px bg-line-2" />
        <span
          id={`board-live-label-${boardKey}`}
          data-vex-area="board-mode-live"
          className={cn(
            "text-[13px] leading-[18px]",
            held ? "text-ink-primary" : "text-ink-secondary",
          )}
        >
          Live data
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
        {connected ? (
          <span
            data-vex-area="board-live-dot"
            className="flex items-center gap-1.5 text-[13px] font-semibold leading-[18px] text-success"
          >
            <span
              aria-hidden
              className="h-[7px] w-[7px] rounded-full bg-success motion-safe:animate-pulse"
            />
            LIVE
          </span>
        ) : null}
        <button
          type="button"
          data-vex-area="board-pin"
          aria-pressed={pinned}
          aria-label={pinned ? "Unpin this board" : "Pin this board to the sidebar"}
          onClick={() => {
            if (pinned) unpinBoard();
            else pinBoard(board);
          }}
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
            pinned
              ? "border-accent-primary/50 bg-accent-wash text-accent-primary"
              : "border-line-2 text-ink-tertiary hover:bg-interactive-hover hover:text-ink-primary",
          )}
        >
          <IconBookOpen size={15} />
        </button>
      </div>
      <p
        data-vex-area="board-live-helper"
        className="text-[13px] leading-[18px] text-ink-tertiary"
      >
        {/* The lease's own sentence wins when it has one to say: an
          * unsupported build or a terminal close is a fact about THIS board,
          * and it must not be overwritten by the ordinary helper copy. */}
        {live.notice ?? (held ? BOARD_LIVE_HELPER_ON : BOARD_LIVE_HELPER_OFF)}
      </p>
    </div>
  );
}

/**
 * The Live data switch.
 *
 * `role="switch"` with `aria-checked`, because this is a persistent on/off
 * state rather than an action - which is exactly the distinction the owner
 * drew between this control and the card's Spotlight BUTTON. A real `<button>`
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
      className={cn(
        "relative inline-flex h-[22px] w-[42px] shrink-0 items-center rounded-capsule border transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        checked
          ? "border-transparent bg-accent-brand"
          : "border-line-2 bg-surface-3",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <span
        aria-hidden
        className={cn(
          // The knob's fill is SEMANTIC, not a white literal. On the accent
          // track it is the ink that belongs on an accent button, which the
          // light theme repoints to a dark value because its accent fill is
          // pale; off, it is the neutral tertiary ink. A hardcoded white would
          // be invisible on the light theme's own track.
          "block h-[16px] w-[16px] rounded-full transition-transform duration-150 motion-reduce:transition-none",
          checked ? "bg-ink-on-button-accent" : "bg-ink-tertiary",
          checked ? "translate-x-[23px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
}
