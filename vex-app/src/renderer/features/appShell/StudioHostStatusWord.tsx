/**
 * The Studio shell's one live status surface - the centre of the status strip
 * while `runtimeMode === "studio"`, in the seat `DeskRuleTapeState` occupies in
 * agent mode.
 *
 * It reads `EV.studio.hostStatus` through `useStudioHostStatus`, which is
 * event-driven: main pushes every transition, so this is a LEVEL and never a
 * poll. The hook subscribes on mount and unsubscribes on unmount, which is
 * exactly why the strip is mounted once by the frame rather than once per
 * shell - two mounts would be two subscriptions.
 *
 * ## Why the word became a pill with a card
 *
 * `LOCKED` sat alone in the strip: a colour, a word, and nothing else. Rule 08
 * wants three things from a state a user cannot act through - what could not be
 * completed, why, and the next action - and the cause sentence existed only as
 * an accessible description, so a sighted user hovering the word learned
 * nothing at all. The pill keeps the word (and its live announcement), adds the
 * state dot, and opens a card carrying the headline, the cause sentence from
 * `studio-copy.ts`, and the next step.
 *
 * The card is a DISCLOSURE, not a dialog: it traps nothing, it is opened by
 * hover, by click and by Enter or Space, Escape closes it and returns focus to
 * the pill, and its own control (when there is one) is the next element in the
 * tab order because it follows the pill in the DOM.
 *
 * ## The seam
 *
 * `StudioHostStatusPill` is pure: it takes a resolved view and two callbacks
 * and knows nothing about queries, stores or the bridge. That is what lets a
 * table test render the card for EVERY wire cause - the states section 6 of the
 * UX audit recorded as unreachable, because nothing in the renderer could drive
 * them. `studioHostStatusView` is the one mapping from wire status to view, so
 * the test and the app cannot diverge.
 *
 * Only real authority becomes a button: `Unlock Vex` (the unlock screen is a
 * route the renderer owns) and `Check again` (a re-read of this very query).
 * Restart and reinstall are instructions, because the renderer has neither
 * authority and a button that cannot do what it says is worse than a sentence.
 */

import { useCallback, useEffect, useId, useRef, useState, type JSX } from "react";
import type {
  StudioHostState,
  StudioHostStatus,
  StudioHostUnavailableCause,
} from "@shared/schemas/studio.js";
import { Button } from "../../components/ui/button.js";
import { StateDot, type StateDotState } from "../../components/ui/state-dot.js";
import { useDismissOutside } from "../../lib/use-dismiss-outside.js";
import { usePointerGrace } from "../../lib/pointer-grace.js";
import { useStudioHostStatus } from "../../lib/api/studio.js";
import {
  StudioHostStatusPreview,
  STUDIO_HOST_PREVIEW_ENABLED,
} from "./StudioHostStatusPreview.js";
import { useUiStore } from "../../stores/uiStore.js";
import { cn } from "../../lib/utils.js";
import {
  STUDIO_HOST_CARD_LABEL,
  STUDIO_HOST_CAUSE_NEXT_STEPS,
  STUDIO_HOST_CAUSE_SENTENCES,
  STUDIO_HOST_LOADING_HEADLINE,
  STUDIO_HOST_LOCKED_REASON,
  STUDIO_HOST_RECHECK_LABEL,
  STUDIO_HOST_STARTING_REASON,
  STUDIO_HOST_STATUS_LOADING,
  STUDIO_HOST_STATUS_UNKNOWN,
  STUDIO_HOST_STATUS_UNKNOWN_DETAIL,
  STUDIO_HOST_UNKNOWN_HEADLINE,
  STUDIO_HOST_UNLOCK_LABEL,
  studioHostConnectionsLine,
  studioHostHeadline,
  studioHostPillLabel,
  studioHostStatusWord,
  type StudioHostCardButton,
} from "./studio/studio-copy.js";

/** Hover dwell before the card opens, matching the house `HoverCard`'s intent. */
const OPEN_DELAY_MS = 300;

/**
 * Everything the pill renders, resolved from one wire status (or from the two
 * states the wire does not describe: a read in flight and a read that failed).
 */
export interface StudioHostStatusView {
  readonly word: string;
  readonly tone: "lit" | "warning" | "quiet";
  readonly dot: StateDotState;
  readonly headline: string;
  /** Why, in one sentence. Null only while the first read is in flight. */
  readonly reason: string | null;
  readonly instruction: string | null;
  readonly button: StudioHostCardButton | null;
  /** Present only when the host answered; carried for the e2e selectors. */
  readonly state: StudioHostState | null;
  readonly cause: StudioHostUnavailableCause | null;
  readonly atCapacity: boolean;
}

/** The first read has not answered. Not a failure and not a state of the host. */
export const STUDIO_HOST_VIEW_LOADING: StudioHostStatusView = {
  word: STUDIO_HOST_STATUS_LOADING,
  tone: "quiet",
  dot: "ongoing",
  headline: STUDIO_HOST_LOADING_HEADLINE,
  reason: null,
  instruction: null,
  button: null,
  state: null,
  cause: null,
  atCapacity: false,
};

/** The read itself failed: Vex knows nothing about the host, which is its own fact. */
export const STUDIO_HOST_VIEW_UNKNOWN: StudioHostStatusView = {
  word: STUDIO_HOST_STATUS_UNKNOWN,
  tone: "quiet",
  dot: "warning",
  headline: STUDIO_HOST_UNKNOWN_HEADLINE,
  reason: STUDIO_HOST_STATUS_UNKNOWN_DETAIL,
  instruction: null,
  button: "recheck",
  state: null,
  cause: null,
  atCapacity: false,
};

/** The one mapping from a wire status to what the pill shows. */
export function studioHostStatusView(
  status: StudioHostStatus,
): StudioHostStatusView {
  const word = studioHostStatusWord(
    status.state,
    status.connectionCount,
    status.atCapacity,
  );
  const headline = studioHostHeadline(status.state, status.atCapacity);
  const nextStep =
    status.cause === null ? null : STUDIO_HOST_CAUSE_NEXT_STEPS[status.cause];

  if (status.state === "running") {
    return {
      word,
      tone: status.atCapacity ? "warning" : "lit",
      dot: status.atCapacity ? "warning" : "done",
      headline,
      reason: studioHostConnectionsLine(
        status.connectionCount,
        status.maxConnections,
      ),
      instruction: null,
      button: null,
      state: status.state,
      cause: null,
      atCapacity: status.atCapacity,
    };
  }
  if (status.state === "starting") {
    return {
      word,
      tone: "lit",
      dot: "ongoing",
      headline,
      reason: STUDIO_HOST_STARTING_REASON,
      instruction: null,
      button: null,
      state: status.state,
      cause: null,
      atCapacity: false,
    };
  }
  if (status.state === "locked") {
    return {
      word,
      tone: "warning",
      dot: "warning",
      headline,
      reason: STUDIO_HOST_LOCKED_REASON,
      instruction: null,
      // The one state with a real route out of it that the renderer owns.
      button: "unlock",
      state: status.state,
      cause: null,
      atCapacity: false,
    };
  }
  return {
    word,
    tone: "warning",
    dot: "error",
    headline,
    reason: status.cause === null ? null : STUDIO_HOST_CAUSE_SENTENCES[status.cause],
    instruction: nextStep?.instruction ?? null,
    button: nextStep?.button ?? null,
    state: status.state,
    cause: status.cause,
    atCapacity: false,
  };
}

export function StudioHostStatusWord(): JSX.Element {
  // Diagnostic viewer (VITE_VEX_STUDIO_HOST_PREVIEW=1, dev builds only): every
  // state and every wire cause from local statuses, no bridge, no IPC. The
  // live path below is untouched by it.
  if (STUDIO_HOST_PREVIEW_ENABLED) return <StudioHostStatusPreview />;
  return <StudioHostStatusLive />;
}

function StudioHostStatusLive(): JSX.Element {
  const query = useStudioHostStatus();
  const openUnlock = useUiStore((state) => state.openUnlock);
  const result = query.data;

  // Three distinct states, never collapsed into one (rule 04, error layers):
  // the read has not answered yet, the read FAILED, and the host answered.
  const view =
    result === undefined
      ? STUDIO_HOST_VIEW_LOADING
      : !result.ok
        ? STUDIO_HOST_VIEW_UNKNOWN
        : studioHostStatusView(result.data);

  return (
    <StudioHostStatusPill
      view={view}
      // `appShell` rather than the current view: the unlock screen returns to
      // the shell the user left, and Studio is a mode of the shell.
      onUnlock={() => openUnlock("appShell")}
      onRecheck={() => {
        void query.refetch();
      }}
    />
  );
}

export interface StudioHostStatusPillProps {
  readonly view: StudioHostStatusView;
  readonly onUnlock: () => void;
  readonly onRecheck: () => void;
}

/**
 * The rendered pill and its card. PURE - drive it with any view (that is the
 * seam the per-cause tests and the diagnostic preview use).
 */
export function StudioHostStatusPill({
  view,
  onUnlock,
  onRecheck,
}: StudioHostStatusPillProps): JSX.Element {
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dwellRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A card opened by a press stays until it is dismissed; one opened by hover
  // follows the pointer out. Without the distinction, a click on the pill would
  // open a card that vanished the moment the pointer moved to its button.
  const pressedOpenRef = useRef(false);
  const [open, setOpen] = useState(false);
  const cardId = useId();

  const clearDwell = (): void => {
    if (dwellRef.current !== null) {
      clearTimeout(dwellRef.current);
      dwellRef.current = null;
    }
  };

  const close = useCallback(() => {
    pressedOpenRef.current = false;
    setOpen(false);
  }, []);
  const { arm: armClose, cancel: cancelClose } = usePointerGrace(close);
  const dismiss = useCallback(
    (next: boolean) => {
      if (!next) close();
    },
    [close],
  );
  useDismissOutside(rootRef, open, dismiss);
  // The dwell timer's owner: a pending open dies with the pill rather than
  // waking a component nobody is looking at (rule 05).
  useEffect(
    () => () => {
      if (dwellRef.current !== null) clearTimeout(dwellRef.current);
    },
    [],
  );

  return (
    <span
      ref={rootRef}
      className="relative inline-flex"
      onPointerEnter={() => {
        cancelClose();
        if (open) return;
        clearDwell();
        dwellRef.current = setTimeout(() => {
          dwellRef.current = null;
          setOpen(true);
        }, OPEN_DELAY_MS);
      }}
      onPointerLeave={() => {
        clearDwell();
        // A pressed-open card is dismissed by Escape, an outside press or the
        // pill itself, never by the pointer wandering off.
        if (open && !pressedOpenRef.current) armClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        clearDwell();
        cancelClose();
        close();
        // Focus returns to the control the user opened, which is where a
        // keyboard user expects to be after dismissing a disclosure.
        triggerRef.current?.focus();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        // The WORD FIRST, then what it is about. An `aria-label` REPLACES the
        // element's text, so a name of "Vex Studio host status" alone left a
        // screen-reader user hearing the control and never the state, and left
        // the visible word out of the name a voice-control user has to speak
        // (WCAG 2.5.3, label in name). The live region below still carries the
        // transition; this is what focusing the pill says.
        aria-label={studioHostPillLabel(view.word)}
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        data-vex-studio-host-state={view.state ?? undefined}
        data-vex-studio-host-cause={view.cause ?? undefined}
        data-vex-studio-host-at-capacity={view.atCapacity ? "true" : undefined}
        className={cn(
          "vex-micro inline-flex items-center gap-1.5 rounded-capsule px-2 py-1 tracking-[0.24em]",
          "hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          view.tone === "warning"
            ? "text-warning"
            : view.tone === "lit"
              ? "text-[var(--vex-accent-text)]"
              : "text-[var(--vex-text-3)]",
        )}
        onClick={() => {
          clearDwell();
          cancelClose();
          if (open) {
            close();
            return;
          }
          pressedOpenRef.current = true;
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          // Cancels the browser's own activation, so the click this key would
          // otherwise synthesize cannot toggle the card a second time.
          event.preventDefault();
          clearDwell();
          cancelClose();
          if (open) {
            close();
            return;
          }
          pressedOpenRef.current = true;
          setOpen(true);
        }}
      >
        <StateDot state={view.dot} size={8} />
        {view.word}
      </button>

      {/* The live announcement: a screen reader hears the state, its reason AND
        * its next step on every transition, without having to find and open the
        * card. The instruction belongs here because the cause sentences no
        * longer carry their own remedy - the card prints each fact once, and a
        * listener who never opens it must still hear all three. */}
      <span role="status" className="sr-only">
        {[view.word, view.reason, view.instruction]
          .filter((line): line is string => line !== null)
          .join(". ")}
      </span>

      {open ? (
        <div
          id={cardId}
          role="group"
          aria-label={STUDIO_HOST_CARD_LABEL}
          data-vex-area="studio-host-status-card"
          className="vex-surface-enter absolute top-full left-1/2 z-50 mt-2 flex w-[320px] max-w-[80vw] -translate-x-1/2 flex-col gap-2 rounded-xl border border-line-2 bg-surface-overlay p-3 text-left shadow-lg"
        >
          <p className="text-[13px] leading-[20px] font-medium text-ink-primary">
            {view.headline}
          </p>
          {view.reason !== null ? (
            <p className="text-[12px] leading-[18px] text-ink-secondary">
              {view.reason}
            </p>
          ) : null}
          {view.instruction !== null ? (
            <p
              data-vex-host-next-step="instruction"
              className="text-[12px] leading-[18px] text-ink-primary"
            >
              {view.instruction}
            </p>
          ) : null}
          {view.button !== null ? (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              data-vex-host-next-step="button"
              onClick={() => {
                if (view.button === "unlock") onUnlock();
                else onRecheck();
                close();
                triggerRef.current?.focus();
              }}
            >
              {view.button === "unlock"
                ? STUDIO_HOST_UNLOCK_LABEL
                : STUDIO_HOST_RECHECK_LABEL}
            </Button>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}
