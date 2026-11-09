/**
 * THE TURN'S TRACE CARD (docs/design/H3-DESKTOP.md section 1.7; VEX Cloud's
 * built trace, `components/chat/trace/TraceCard.tsx`): one head per turn over
 * every step of the turn, on the card ground in the 1px rule.
 *
 *   div[data-vex-trace-group][data-shut]?   one group of steps at its place in the turn
 *   ├─ TraceHead                            only on the turn's first group
 *   └─ div[data-vex-trace-body]             hidden="until-found" while the turn is folded
 *
 * A turn's steps sit in several rows (a thought, a call, a fold of calls,
 * each persisted on its own); each row's step parts are a group, and the head
 * stands over the first. The fold hides every group of the turn at once: the
 * steps go, the answer, a receipt, a mission's result and an analysis stay.
 *
 * Fold. `turnFold.ts` decides open or shut. A shut group is
 * `hidden="until-found"`, set imperatively (React writes `hidden` as a
 * boolean), so find in page still reaches its steps and `beforematch` opens
 * the turn. A fold never hides focus: a group holding focus as it would hide
 * opens the turn instead. Nothing slides: the chevron turns, the body goes
 * at once.
 *
 * The head. While the turn runs: the running node, "Working" (muted), the
 * steps so far; the live frame at the transcript's tail keeps the clock, so
 * the turn never shows two. Settled: H3's dot grid, "Thought for 2.8s" only
 * after a turn watched live (`TurnIsland/turnClock.ts`), else "Thought", and
 * "{n} steps". A stopped or failed turn's head is a label ("Stopped",
 * "Failed"): no key, no chevron, its steps stay in view. The head carries no
 * summary of the trace.
 *
 * Silent: no live region; the live frame announces the run.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  type JSX,
  type ReactNode,
  type RefObject,
} from "react";
import { LineChevronDown } from "../../../components/icons/line/index.js";
import { ThinkGlyph } from "../ReasonedBlock.js";
import { stepsLabel } from "../reasoning-stamp.js";
import { StepNode } from "../ToolLedger/StepNode.js";
import { formatToolDuration } from "../ToolLedger/toolDuration.js";
import { useTurnFoldView } from "./turnFold.js";
import type { TurnOutcome } from "./turnSteps.js";

/** What the head of a turn says, as primitives (the rows' memo holds). */
export interface TraceHeadFacts {
  readonly steps: number;
  readonly outcome: TurnOutcome;
  /** The live turn clock's reading, after a turn watched live. */
  readonly thoughtMs: number | null;
}

function TraceHead({
  anchorId,
  facts,
  open,
  running,
  onToggle,
}: {
  readonly anchorId: number;
  readonly facts: TraceHeadFacts;
  readonly open: boolean;
  readonly running: boolean;
  readonly onToggle: (anchorId: number) => void;
}): JSX.Element {
  const count = stepsLabel(facts.steps);
  const time = formatToolDuration(facts.thoughtMs);
  const tone = running
    ? "run"
    : facts.outcome === "completed"
      ? "done"
      : facts.outcome;
  const glyph =
    tone === "run" ? (
      <StepNode state="running" />
    ) : tone === "failed" ? (
      <StepNode state="failed" />
    ) : (
      <ThinkGlyph />
    );
  const label =
    tone === "run" ? (
      "Working"
    ) : tone === "stopped" ? (
      "Stopped"
    ) : tone === "failed" ? (
      "Failed"
    ) : time === null ? (
      "Thought"
    ) : (
      <>
        Thought for <span className="vex-reasoned__figure">{time}</span>
      </>
    );
  // A label head adds the turn's time after its count, where one was measured.
  const total = (tone === "stopped" || tone === "failed") && time !== null ? time : null;
  const end = (
    <span data-vex-turn-steps="" className="vex-trace-head__end">
      {count}
      {total === null ? null : (
        <>
          {count === null ? null : <span aria-hidden="true"> · </span>}
          <span data-vex-trace-total="">{total}</span>
        </>
      )}
    </span>
  );
  // The key's name, said as one phrase: "Thought for 2.8s, 5 steps".
  const name = [
    tone === "run" ? "Working" : time === null ? "Thought" : `Thought for ${time}`,
    count,
  ]
    .filter((part) => part !== null)
    .join(", ");
  const parts = (
    <>
      <span aria-hidden className="vex-step__fill">
        {glyph}
      </span>
      <span data-vex-trace-label="" className="vex-trace-head__label">
        {label}
      </span>
      {end}
    </>
  );
  if (tone === "stopped" || tone === "failed") {
    return (
      <div data-vex-trace-head="" data-vex-thinking-head="" data-tone={tone} className="vex-trace-head">
        {parts}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-vex-trace-head=""
      data-vex-thinking-head=""
      data-tone={tone}
      aria-expanded={open}
      aria-label={name}
      onClick={(event) => {
        event.currentTarget.focus();
        onToggle(anchorId);
      }}
      className="vex-trace-head"
    >
      {parts}
      <LineChevronDown size={16} className="vex-trace-head__chev" />
    </button>
  );
}

/**
 * Hides the body while the turn is folded (see the header). A body holding
 * focus asks to open instead; `beforematch` (find in page) opens it.
 */
function useFoldHide(
  body: RefObject<HTMLDivElement | null>,
  hidden: boolean,
  onReveal: () => void,
): void {
  const revealRef = useRef(onReveal);
  revealRef.current = onReveal;
  useLayoutEffect(() => {
    const element = body.current;
    if (element === null) return;
    if (!hidden) {
      element.removeAttribute("hidden");
      return;
    }
    if (element.contains(element.ownerDocument.activeElement)) {
      revealRef.current();
      return;
    }
    element.setAttribute("hidden", "until-found");
  }, [body, hidden]);
  useEffect(() => {
    const element = body.current;
    if (element === null) return;
    const reveal = (): void => revealRef.current();
    element.addEventListener("beforematch", reveal);
    return () => element.removeEventListener("beforematch", reveal);
  }, [body]);
}

/**
 * One group of a turn's steps. Outside a whole turn (no `anchorId`, or a row
 * drawn with no transcript around it) it is its children alone.
 */
export function TraceGroup({
  anchorId,
  head = null,
  children,
}: {
  readonly anchorId: number | undefined;
  /** Set on the turn's first group only. */
  readonly head?: TraceHeadFacts | null;
  readonly children: ReactNode;
}): JSX.Element {
  const fold = useTurnFoldView();
  if (fold === null || anchorId === undefined) return <>{children}</>;
  return (
    <FoldedGroup
      anchorId={anchorId}
      head={head}
      shut={fold.shut.has(anchorId)}
      running={fold.runningAnchorId === anchorId}
      onToggle={fold.toggle}
      onReveal={fold.reveal}
    >
      {children}
    </FoldedGroup>
  );
}

function FoldedGroup({
  anchorId,
  head,
  shut,
  running,
  onToggle,
  onReveal,
  children,
}: {
  readonly anchorId: number;
  readonly head: TraceHeadFacts | null;
  readonly shut: boolean;
  readonly running: boolean;
  readonly onToggle: (anchorId: number) => void;
  readonly onReveal: (anchorId: number) => void;
  readonly children: ReactNode;
}): JSX.Element {
  const body = useRef<HTMLDivElement>(null);
  useFoldHide(body, shut, () => onReveal(anchorId));
  return (
    <div data-vex-trace-group="" data-shut={shut ? "" : undefined}>
      {head === null ? null : (
        <TraceHead
          anchorId={anchorId}
          facts={head}
          open={!shut}
          running={running}
          onToggle={onToggle}
        />
      )}
      <div ref={body} data-vex-trace-body="">
        {children}
      </div>
    </div>
  );
}
