/**
 * MissionNextStepBar: the mission's next step in a chat, drawn as one ruled
 * bar on the reading column (docs/design/H3-DESKTOP.md section 5.10; owner
 * decision 2026-11-10, "Next-step bar").
 *
 *   left   the blinking state square, a caps eyebrow (the state) and one
 *          line in ink 2 saying what happens next; a quiet secondary action
 *          may stand under the line, never blue
 *   right  the action as Vex's blue key with the arrow glyph, a full height
 *          cell at least 200 wide on the bar's right edge
 *
 * A look only. Which key is drawn, its accessible name, when it is held and
 * what a press does are the caller's (`MissionControls`), passed through
 * unchanged.
 *
 * THE ONE BLUE. A money card waiting in this chat owns the view's blue
 * (section 2.4, "One blue cell in view at a time"), so the caller passes
 * `blue={false}` while one waits and the key stands as the ink key, with no
 * rise.
 *
 * THE RISE. The first time the bar appears for a given state of a given
 * mission, the key's blue rises once from its foot over the push step
 * (`--vex-duration-vex-open` on `--vex-ease-push`, MOTION-POLICY.md), as a
 * layer under the word, then rests. It is decided once, at the bar's first
 * layout, and remembered for the app's run (`risen`), so a re-render, a
 * remount or a return to the chat never plays it again. Reduced motion and
 * Save-Data skip it (the key simply stands blue), and so do a held key and
 * an ink key. The layer leaves on its own `animationend`: no timer is paired
 * with the duration.
 */

import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { Button } from "../../../components/ui/button.js";
import { StateSquare } from "../../../components/ui/state-square.js";
import { Glyph } from "../../../components/icons/glyph/Glyph.js";
import { prefersStillFrame } from "../../../lib/motion/use-still-frame.js";

/** Which next step the bar stands for (`data-vex-next-step`). */
export type MissionNextStep = "review" | "start" | "renew";

export interface MissionNextStepBarProps {
  readonly step: MissionNextStep;
  /**
   * Who the rise is remembered for: the session and the mission the step
   * belongs to. With the step it names one first appearance.
   */
  readonly riseKey: string;
  /** The state, in sentence case; the label style sets it in caps. */
  readonly eyebrow: string;
  /** What happens next, one sentence. */
  readonly line: string;
  /** The key's visible word, in sentence case. */
  readonly label: string;
  /** The key's accessible name, as the caller has always given it. */
  readonly ariaLabel: string;
  readonly onAction: () => void;
  readonly disabled?: boolean;
  /** False while a money card waits in this chat: the key falls back to ink. */
  readonly blue: boolean;
  /** A quiet secondary action under the line. */
  readonly secondary?: ReactNode;
}

/** The first appearances that have already played their rise, this run. */
const risen = new Set<string>();

/** Test seam: forget every first appearance. */
export function resetNextStepRiseMemory(): void {
  risen.clear();
}

export function MissionNextStepBar({
  step,
  riseKey,
  eyebrow,
  line,
  label,
  ariaLabel,
  onAction,
  disabled = false,
  blue,
  secondary,
}: MissionNextStepBarProps): JSX.Element {
  const eyebrowId = useId();
  const [rising, setRising] = useState(false);
  // The decision is taken once per mount, at the first layout: before the
  // first paint, so a rising key never flashes its resting blue first.
  const decided = useRef(false);
  const memoryKey = `${riseKey}:${step}`;

  useLayoutEffect(() => {
    if (decided.current) return;
    decided.current = true;
    const first = !risen.has(memoryKey);
    risen.add(memoryKey);
    if (first && blue && !disabled && !prefersStillFrame()) setRising(true);
    // Read once, at the first layout only: later changes never start a rise.
  }, []);

  // An approval arriving mid-rise takes the blue: the layer goes with it.
  const showRise = rising && blue && !disabled;
  // The layer leaves on its own `animationend`, read natively: React names
  // the event by feature detection, which misses where `AnimationEvent` is
  // absent (jsdom), so the plain DOM listener is the one reading both.
  const riseLayer = useCallback((layer: HTMLSpanElement | null) => {
    if (layer === null) return;
    layer.addEventListener("animationend", () => setRising(false), { once: true });
  }, []);

  return (
    <div
      data-vex-area="mission-next-step"
      data-vex-next-step={step}
      role="group"
      aria-labelledby={eyebrowId}
      className="vex-next-step"
    >
      <div className="vex-next-step__row">
        <div className="vex-next-step__body">
          <p className="vex-next-step__eyebrow">
            <StateSquare state="ongoing" />
            <span id={eyebrowId}>{eyebrow}</span>
          </p>
          <p className="vex-next-step__line">{line}</p>
          {secondary === undefined ? null : (
            <div className="vex-next-step__more">{secondary}</div>
          )}
        </div>
        <Button
          variant={blue ? "primary" : "ink"}
          size="lg"
          disabled={disabled}
          onClick={onAction}
          aria-label={ariaLabel}
          data-vex-rise={showRise ? "" : undefined}
          className="vex-next-step__key"
        >
          {showRise ? (
            <span
              aria-hidden="true"
              data-vex-next-step-rise=""
              className="vex-next-step__rise"
              ref={riseLayer}
            />
          ) : null}
          <span>{label}</span>
          <Glyph name="arrow-right" size={16} className="vex-next-step__arrow" />
        </Button>
      </div>
    </div>
  );
}
