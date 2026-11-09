/**
 * The loader gate: VEX Cloud's `LoaderGate` (`components/brand/loader-gate.tsx`,
 * its CTR/brand contract section 3, SK STYLE 5.13, DG-3 `boot.html`), ported
 * as a desktop primitive (owner approval 2026-11-08; docs/design/H3-DESKTOP.md
 * section 5.9). A true and calm load: a count of what has really arrived and
 * never more, no spinner, no figure, nothing that moves except the fill and
 * the head cell.
 *
 *   div.vex-gate[role=status]         fixed, the gate's ground; two rows: the plate and the foot line
 *     div.vex-gate__main > __col      the mark over the word, centred; the note hangs under it, out of flow
 *       span.vex-gate__mark           200 wide at 1440 (clamp(120px, 14vw, 200px)), the mark's own 176 x 140
 *         span.vex-gate__base         the mark at 8% white
 *         span.vex-gate__fill         the mark in white, clipped from the right: clip-path inset(0 X% 0 0)
 *       p.vex-gate__word              the label, 11 caps, muted (gone when the start failed)
 *       div.vex-gate__note            the slow line or a failure (`children`)
 *     div.vex-gate__cells             n = max(18, round(width / 22)) upright cells, 3 apart: off 3%, lit 20%, head 42%
 *
 * The count (`loader-gate-model.ts`): the bar walks toward `progress` at one
 * speed and waits where it stands. A full bar rests 320ms, then the gate
 * fades and `onDone` fires; the component then renders nothing. After
 * `ceilingMs` (12 s) the bar completes whatever has arrived. Under reduced
 * motion and Save-Data: no walk (the bar is where `progress` is), no rest, no
 * fade; the gate still leaves only when `progress` reaches 1.
 *
 * NOT MOUNTED. Desktop's boot is the approved wake plate (`ChronosGate`,
 * section 4.9), which this does not replace; where the gate stands is the
 * owner's call. The clip is a single CSSOM property write (`style.clipPath`),
 * CSP-safe (MOTION-POLICY.md).
 */

import { memo, useEffect, useRef, useState, type HTMLAttributes, type JSX, type ReactNode } from "react";
import { prefersStillFrame } from "../../lib/motion/use-still-frame.js";
import { DURATION_GATE_FADE_MS } from "../../lib/motion/index.js";
import { VexMark } from "../common/VexMark.js";
import {
  advanceGate,
  cellState,
  fillClip,
  GATE_CEILING_MS,
  GATE_HOLD_MS,
  GATE_READY,
  GATE_START,
  gateCellCount,
  litCells,
  raiseGoal,
} from "./loader-gate-model.js";

type GatePhase = "loading" | "ready" | "out" | "done";

/** The fade is a CSS transition; a timer a little longer than it backs the `transitionend` a hidden window never fires. */
const FADE_SLACK_MS = 120;

export interface LoaderGateProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "className" | "style" | "role" | "aria-label"> {
  /** The word under the mark and the status name ("Loading"). */
  readonly label: string;
  /** What has arrived, 0 to 1. Omitted, the bar stands at its first mark. Never ahead of this, never backwards. */
  readonly progress?: number;
  /** The start failed: the count stops where it stood, the word and the status role go, `children` is the failure. */
  readonly failed?: boolean;
  /** The bar completes after this long whatever has arrived (default 12 s). */
  readonly ceilingMs?: number;
  /** The gate has faded out; the component renders nothing from here. */
  readonly onDone?: () => void;
  /** The slow line or the failure, hung under the mark. */
  readonly children?: ReactNode;
}

/** How many cells the window draws; none until mounted. */
function useCellCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const measure = (): void => setCount(gateCellCount(window.innerWidth));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return count;
}

const Cells = memo(function Cells({ count, lit }: { readonly count: number; readonly lit: number }): JSX.Element {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        // The cells are positions, not data.
        <i key={index} className="vex-gate__cell" data-state={cellState(index, lit)} />
      ))}
    </>
  );
});

export function LoaderGate({
  label,
  progress,
  failed = false,
  ceilingMs = GATE_CEILING_MS,
  onDone,
  children,
  ...rest
}: LoaderGateProps): JSX.Element | null {
  const rootRef = useRef<HTMLDivElement>(null);
  // A gate that mounts failed stands at the count it was told.
  const [first] = useState(() => (failed ? raiseGoal(GATE_START, progress) : GATE_START));
  const [shown, setShown] = useState(first);
  const [phase, setPhase] = useState<GatePhase>("loading");
  const cells = useCellCount();
  const goal = useRef(first);
  const walked = useRef(first);
  const ceiling = useRef(false);
  const finished = useRef(onDone);

  useEffect(() => {
    goal.current = raiseGoal(goal.current, progress);
  }, [progress]);

  useEffect(() => {
    finished.current = onDone;
  }, [onDone]);

  // The ceiling: past it the bar completes whatever has arrived.
  useEffect(() => {
    if (failed || ceilingMs <= 0) return;
    const timer = window.setTimeout(() => {
      ceiling.current = true;
    }, ceilingMs);
    return () => window.clearTimeout(timer);
  }, [failed, ceilingMs]);

  // The count: one steady walk toward the goal, a frame at a time, until the bar is full.
  useEffect(() => {
    if (failed || phase !== "loading") return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      const seconds = (now - last) / 1000;
      last = now;
      const target = ceiling.current ? 1 : goal.current;
      const next = advanceGate(walked.current, target, seconds, prefersStillFrame());
      // A full bar is full: the last half percent would leave the mark's tip clipped.
      const value = next >= GATE_READY ? 1 : next;
      if (value !== walked.current) {
        walked.current = value;
        setShown(value);
      }
      if (value === 1) {
        setPhase("ready");
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [failed, phase]);

  // A full bar rests, then the gate goes out.
  useEffect(() => {
    if (failed || phase !== "ready") return;
    const timer = window.setTimeout(() => setPhase("out"), prefersStillFrame() ? 0 : GATE_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [failed, phase]);

  // A failure that arrives during the fade stops it: the gate stands, with the failure on it.
  useEffect(() => {
    if (failed && phase === "out") setPhase("ready");
  }, [failed, phase]);

  // The fade ends: the gate is done. With no motion it is done at once.
  useEffect(() => {
    if (failed || phase !== "out") return;
    const finish = (): void => setPhase("done");
    if (prefersStillFrame()) {
      finish();
      return;
    }
    const root = rootRef.current;
    const onEnd = (event: TransitionEvent): void => {
      if (event.target === root && event.propertyName === "opacity") finish();
    };
    root?.addEventListener("transitionend", onEnd);
    const timer = window.setTimeout(finish, DURATION_GATE_FADE_MS + FADE_SLACK_MS);
    return () => {
      root?.removeEventListener("transitionend", onEnd);
      window.clearTimeout(timer);
    };
  }, [failed, phase]);

  useEffect(() => {
    if (phase === "done") finished.current?.();
  }, [phase]);

  if (phase === "done") return null;

  return (
    <div
      {...rest}
      ref={rootRef}
      {...(failed ? {} : { role: "status", "aria-label": label })}
      className="vex-gate"
      data-vex-gate-phase={phase}
      data-failed={failed ? "" : undefined}
    >
      <div className="vex-gate__main">
        <div className="vex-gate__col">
          <span className="vex-gate__mark" aria-hidden="true">
            <span className="vex-gate__base">
              <VexMark className="vex-gate__svg" />
            </span>
            <span className="vex-gate__fill" style={{ clipPath: fillClip(shown) }}>
              <VexMark className="vex-gate__svg" />
            </span>
          </span>
          {failed ? null : <p className="vex-gate__word">{label}</p>}
          {children === undefined || children === null ? null : (
            <div className="vex-gate__note">{children}</div>
          )}
        </div>
      </div>
      <div className="vex-gate__cells" aria-hidden="true" data-drawn={cells > 0 ? "" : undefined}>
        <Cells count={cells} lit={litCells(shown, cells)} />
      </div>
    </div>
  );
}
