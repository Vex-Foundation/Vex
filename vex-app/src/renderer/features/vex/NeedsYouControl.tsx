/**
 * "NEEDS YOU · N": the title bar's control for everything that waits for the
 * user's decision (docs/design/R3-MINIMAL.md sections 3 and 5), on every
 * screen and in every mode, whether Vex is shown or not, WHILE THERE IS
 * SOMETHING TO SAY. It opens a flat panel under itself with the same
 * `NeedsYouList` the Vex sidebar draws, so the two can never count or word it
 * differently.
 *
 * Four honest states, never collapsed into one another. Two of them draw the
 * control: something (the target swatch, an ink frame and the count), and a
 * read that FAILED ("Needs you · ?" with Retry). A failed read is never drawn
 * as 0: an empty control after a failed read would be a false all-clear on
 * the surface that exists to say a signature is waiting. Still checking and
 * nothing (a read that came back 0) draw no control, so an empty "Needs you
 * · 0" never takes room in the title bar; an open panel stays until closed.
 *
 * The list never decides. Review opens the thing:
 *   - an approval whose card is already on screen (its session open in the
 *     centre, no page over it) is scrolled into view and its Reject takes the
 *     focus, the safer choice first;
 *   - any other approval opens the Needs you page (route `needsYou`) on its
 *     full card, in whichever mode the user is in; the card's Reject takes
 *     the focus there;
 *   - a mission that needs Recover, its contract or its form opens its
 *     session, where those controls live.
 *
 * Chrome: an anchored panel, no portal, no veil, a 1.5px ink frame; outside
 * press and Escape close it, focus moves into it on open and back to the
 * control on close.
 */

import { useCallback, useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { Swatch, type SwatchState } from "../../components/ui/swatch.js";
import { cn } from "../../lib/utils.js";
import { useUiStore } from "../../stores/uiStore.js";
import { NeedsYouList } from "./needs-you/NeedsYouList.js";
import { NEEDS_YOU_UNKNOWN_COPY, type NeedsYouItem, type NeedsYouStatus } from "./needs-you.js";
import { useNeedsYou } from "./useVexPresence.js";
import { VEX_STATE_FILL } from "./vex-state.js";

/** The approvals read is capped at 100 rows; the count says "99+" past 99. */
const MAX_COUNT = 99;

/** The count as the control prints it; `null` while there is none to print. */
export function needsYouCountLabel(status: NeedsYouStatus, count: number | null): string | null {
  if (status === "unknown") return "?";
  if (count === null) return null;
  return count > MAX_COUNT ? `${String(MAX_COUNT)}+` : String(count);
}

/** The control's fill: checking, failed, nothing, or something waiting. */
function needsYouFill(status: NeedsYouStatus, count: number | null): SwatchState {
  if (status === "loading") return VEX_STATE_FILL.waking;
  if (status === "unknown") return VEX_STATE_FILL.concerned;
  return count !== null && count > 0 ? VEX_STATE_FILL.awaiting : VEX_STATE_FILL.ready;
}

/**
 * The inline card of an approval, when it is on screen right now: its session
 * is the open one in the agent shell and no page covers the centre.
 */
function inlineApprovalCard(approvalId: string): HTMLElement | null {
  const cards = document.querySelectorAll<HTMLElement>(
    "[data-vex-area='approvals-region'] [data-approval-id]",
  );
  for (const card of cards) {
    if (card.getAttribute("data-approval-id") === approvalId) return card;
  }
  return null;
}

export function NeedsYouControl(): JSX.Element | null {
  const model = useNeedsYou();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();

  const setRuntimeMode = useUiStore((s) => s.setRuntimeMode);
  const setActiveSessionId = useUiStore((s) => s.setActiveSessionId);
  const setShellRoute = useUiStore((s) => s.setShellRoute);

  const closePanel = useCallback((): void => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect((): (() => void) | undefined => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  useEffect((): void => {
    if (open) panelRef.current?.focus();
  }, [open]);

  /**
   * Open a session in the agent shell: mode first, then the selection, then
   * the page over the centre closes, in one click handler (one commit). The
   * same navigation the approval card's "Open session" makes.
   */
  const openSession = (sessionId: string): void => {
    setRuntimeMode("agent");
    setActiveSessionId(sessionId);
    setShellRoute({ kind: "none" });
  };

  const review = (item: NeedsYouItem): void => {
    setOpen(false);
    if (item.kind === "approval" && item.approvalId !== null) {
      const state = useUiStore.getState();
      const onScreen =
        state.runtimeMode === "agent" &&
        state.shellRoute.kind === "none" &&
        item.sessionId !== null &&
        state.activeSessionId === item.sessionId;
      const card = onScreen ? inlineApprovalCard(item.approvalId) : null;
      if (card !== null) {
        if (typeof card.scrollIntoView === "function") card.scrollIntoView({ block: "nearest" });
        card.querySelector<HTMLElement>("[autofocus]:not([disabled])")?.focus();
        return;
      }
      // The page's card takes the focus; the control is where it rests until
      // the page has painted.
      triggerRef.current?.focus();
      setShellRoute({ kind: "needsYou", origin: null, approvalId: item.approvalId });
      return;
    }
    if (item.kind === "withdrawal") {
      // The funding page holds its Cancel and "It was me" keys.
      triggerRef.current?.focus();
      setShellRoute({ kind: "vexCloudFunding", origin: null });
      return;
    }
    if (item.sessionId !== null) {
      openSession(item.sessionId);
      return;
    }
    triggerRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    }
  };

  const { status, count } = model;
  const countLabel = needsYouCountLabel(status, count);
  const pending = status === "unknown" || (count !== null && count > 0);
  const heading = countLabel === null ? "Needs you" : `Needs you · ${countLabel}`;

  // Nothing waits, or the read has not answered yet: no control.
  if (!pending && !open) return null;

  return (
    <div ref={rootRef} className="vex-tb-needs" onKeyDown={onKeyDown}>
      <div className="vex-tb-needs__frame" data-state={status} data-pending={pending || undefined}>
        <button
          ref={triggerRef}
          type="button"
          className="vex-tb-needs__key"
          data-vex-area="needs-you-control"
          data-state={status}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={() => {
            if (open) closePanel();
            else setOpen(true);
          }}
        >
          <Swatch
            state={needsYouFill(status, count)}
            className={cn(
              status === "ready" && count === 0 ? "text-ink-tertiary" : "text-accent-primary",
            )}
          />
          <span>Needs you{countLabel === null ? null : " · "}</span>
          {countLabel === null ? null : <span className="vex-tb-count">{countLabel}</span>}
        </button>
        {status === "unknown" ? (
          <button
            type="button"
            className="vex-tb-needs__retry"
            data-vex-area="needs-you-retry"
            disabled={model.retrying}
            aria-label={model.retrying ? "Checking approvals again" : "Retry checking approvals"}
            onClick={model.retry}
          >
            {model.retrying ? "Checking" : "Retry"}
          </button>
        ) : null}
      </div>
      {/* The read's state in words, for assistive technology: the visible
       * control is a count, this says what an absent or unknown count means. */}
      {status === "loading" ? (
        <span role="status" className="sr-only" data-vex-area="needs-you-status" data-state="loading">
          Checking for pending approvals
        </span>
      ) : null}
      {status === "unknown" ? (
        <span role="status" className="sr-only" data-vex-area="needs-you-status" data-state="unknown">
          {NEEDS_YOU_UNKNOWN_COPY}
        </span>
      ) : null}

      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Needs you"
          data-vex-area="needs-you-panel"
          tabIndex={-1}
          className="vex-tb-pop vex-tb-pop--needs vex-no-drag"
        >
          <p className="vex-tb-pop__head">{heading}</p>
          <NeedsYouList model={model} variant="panel" onReview={review} />
        </div>
      ) : null}
    </div>
  );
}
