/**
 * HER WIPE, ON WEB ANIMATIONS (docs/design/H3-DESKTOP.md sections 3.1, 3.2
 * and 3.4): the motion `KimmSection` plays when her section opens or closes,
 * as VEX Cloud's mockup plays it (its `js/stage.js`, "the motion"). Each leg
 * is a set of Web Animations started at the press, so every part of it runs
 * on one clock from one edge:
 *
 *   - THE CLIP. Her section's bottom inset runs from where it stands to where
 *     the leg goes: 0 open, the box less the strip closed (547 at 1440 x 900),
 *     on the push curve, 720ms to open and 420ms to close. Only clip-path
 *     moves, so her box, the column and a waiting card never do (section 3.6).
 *   - THE SCAN HEAD. A 1px line keyed to the clip's edge on both legs: a
 *     layer as tall as her box, its foot line the edge, moved up by the inset
 *     on the same curve and duration. It holds its full light until 92% of
 *     the leg and then fades linearly to nothing (`KIMM_SCAN_FADE_AT`), so it
 *     is never left standing at her foot or at the strip.
 *
 * Between legs the sheet holds her (kimm.css: the open and closed insets, the
 * head unlit), and a leg's last frame is that resting state, so cancelling a
 * finished leg changes no pixel.
 *
 * A LEG STARTS FROM THE EDGE WHERE IT STANDS. A press during a motion reads
 * the running leg's inset (`KimmWipe.inset`), and the new leg starts there,
 * so the edge never jumps and goes no deeper after the press. A leg covers
 * its share of the distance in that share of its direction's duration: a
 * whole leg takes 720 or 420, a turned one only what is left of it.
 *
 * NO LAYOUT, NO WIPE. A box that is not laid out (the inspect view over her
 * column, a test's DOM) or an engine without Web Animations starts nothing:
 * `startKimmWipe` returns null and the caller ends the phase on the leg's
 * duration instead. Reduced motion and Save-Data never reach here
 * (`KimmSection` lands her at once, MOTION-POLICY.md).
 *
 * The durations and the curve are the motion vocabulary's
 * (`DURATION_VEX_OPEN_MS`, `DURATION_VEX_CLOSE_MS`, `EASE_PUSH`), and the
 * strip's height is the sheet's own `--vex-h3-strip-h`, read from her box, so
 * no number here repeats one in a stylesheet.
 */

import { DURATION_VEX_CLOSE_MS, DURATION_VEX_OPEN_MS, EASE_PUSH } from "../../../lib/motion/index.js";

/** The share of a leg the scan head holds its full light for, before it fades out. */
export const KIMM_SCAN_FADE_AT = 0.92;

/** The push curve, as Web Animations spells an easing. */
export const KIMM_PUSH_EASING = `cubic-bezier(${EASE_PUSH.join(", ")})`;

/** Her section's clip at a bottom inset, in px. */
export function kimmClipAt(inset: number): string {
  return `inset(0px 0px ${String(inset)}px 0px)`;
}

/** The scan head's layer at a bottom inset: its foot line on the clip's edge. */
export function kimmScanAt(inset: number): string {
  return `translateY(${String(-inset)}px)`;
}

/**
 * How long a leg takes: its direction's duration (720 to open, 420 to
 * close) for the share of the distance it covers.
 */
export function kimmLegMs(open: boolean, from: number, to: number, distance: number): number {
  const base = open ? DURATION_VEX_OPEN_MS : DURATION_VEX_CLOSE_MS;
  return (base * Math.abs(to - from)) / distance;
}

/** One leg of her wipe, running. */
export interface KimmWipe {
  /** Opening (true) or closing. */
  readonly open: boolean;
  /** The leg's duration in ms. */
  readonly ms: number;
  /** The clip's bottom inset now, in px: where a press would turn it around. */
  inset(): number;
  /** Settles true when the clip's animation ends, false if the leg is cancelled. */
  readonly finished: Promise<boolean>;
  /** Stop every animation of the leg; the sheet's resting state takes over. */
  cancel(): void;
}

/** A px length from a computed custom property, or NaN. */
function px(el: Element, property: string): number {
  return Number.parseFloat(getComputedStyle(el).getPropertyValue(property));
}

/**
 * Start a leg on her section's box: to open (`open`) or to close, from the
 * inset `from` where a running leg stands, or from rest. Null when nothing
 * can be drawn (no Web Animations, a box not laid out, nothing to cover).
 */
export function startKimmWipe(box: HTMLElement, open: boolean, from: number | null): KimmWipe | null {
  if (typeof box.animate !== "function") return null;
  const height = box.getBoundingClientRect().height;
  const strip = px(box, "--vex-h3-strip-h");
  if (!Number.isFinite(strip) || !(height > strip)) return null;
  const distance = height - strip;
  const to = open ? 0 : distance;
  const start = Math.min(distance, Math.max(0, from ?? (open ? distance : 0)));
  const ms = kimmLegMs(open, start, to, distance);
  if (!(ms > 0)) return null;

  const timing: KeyframeAnimationOptions = { duration: ms, easing: KIMM_PUSH_EASING, fill: "both" };
  const clip = box.animate([{ clipPath: kimmClipAt(start) }, { clipPath: kimmClipAt(to) }], timing);
  const animations: Animation[] = [clip];
  const scan = box.querySelector<HTMLElement>(".vex-kimm__scan");
  if (scan !== null) {
    animations.push(
      scan.animate([{ transform: kimmScanAt(start) }, { transform: kimmScanAt(to) }], timing),
      scan.animate([{ opacity: 1 }, { opacity: 1, offset: KIMM_SCAN_FADE_AT }, { opacity: 0 }], {
        duration: ms,
        easing: "linear",
        fill: "both",
      }),
    );
  }

  return {
    open,
    ms,
    inset: () => {
      const progress = clip.effect?.getComputedTiming().progress;
      if (typeof progress !== "number") return clip.playState === "finished" ? to : start;
      return start + (to - start) * progress;
    },
    finished: clip.finished.then(
      () => true,
      () => false,
    ),
    cancel: () => {
      for (const animation of animations) animation.cancel();
    },
  };
}
