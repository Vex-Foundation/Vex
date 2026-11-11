/**
 * HER GLYPH FIELD (docs/design/H3-DESKTOP.md sections 1.5, 3.2 and 3.5; plan
 * row S4-17): VEX Cloud's live field, ' VEX' on its blue horizon, behind her
 * figure. The drawing is the Gradient ASCII port (`gradient-ascii.ts`,
 * WebGL2 on a canvas it adds to this box), reached through a dynamic import
 * so it never joins the first JS, as Cloud reaches it. Its recipe and its
 * gate are `kimm-field.ts`. It is the named exception MOTION-POLICY.md gives
 * it, bound four ways:
 *
 *   - IT RUNS ONLY WHILE HER SECTION IS OPEN (`open`) IN A CHAT: closed, the
 *     field holds its frame in the strip (section 3.2), and opening starts it
 *     again from that frame; on a page (`hold`) it holds its frame open too,
 *     as VEX Cloud's field runs only in a chat's section.
 *   - THE RUN GATE (`lib/motion/run-gate.ts`): only while the field is on
 *     screen and the window is shown; a hidden window, a column scrolled or
 *     folded away, or the inspect view over her paints no frame. (The port
 *     also stops itself when hidden or off screen.)
 *   - THE STILL FRAME (`lib/motion/use-still-frame.ts`): under reduced motion
 *     or Save-Data it draws one frame and no ticker runs; the band
 *     (`mode` "frame") draws one frame too.
 *   - ONE FRAME AT A TIME: the port clamps a frame's step to 50ms, so a
 *     stalled window resumes where it stopped, and it draws at most twice
 *     the CSS pixel.
 *
 * Running or holding is the port's `setStill`, so a switch never remounts it
 * and the frame held is the frame it stood at. Where WebGL2 or a shader is
 * missing the port draws nothing and her ground keeps the baked frame
 * (kimm.css). `onDrawn` says when the field has painted (two frames after
 * its first, as Cloud waits, so nothing flashes), for her ground to give the
 * baked frame up. Decorative: `aria-hidden`, and the box takes no pointer.
 */

import { useEffect, useRef, useState, type JSX } from "react";
import { RunGate } from "../../../lib/motion/run-gate.js";
import { useStillFrame } from "../../../lib/motion/use-still-frame.js";
import type { GradientAsciiHandle } from "./gradient-ascii.js";
import { kimmFieldOptions, kimmFieldRuns, type KimmFieldMode } from "./kimm-field.js";

export interface KimmFieldProps {
  /** Her section is open: the field runs; closed, it holds its frame. */
  readonly open: boolean;
  /** `live` in her section, `frame` (one still frame) in her band. */
  readonly mode?: KimmFieldMode;
  /**
   * Hold the frame it stands at though her section is open: on a page, where
   * VEX Cloud paints one frame and runs the field only in a chat's section
   * (`kimm-field.ts`, `kimmFieldMode`). Held through `setStill`, so a page
   * opened or closed never remounts the port.
   */
  readonly hold?: boolean;
  /** The field has painted (true) or is gone (false). */
  readonly onDrawn?: (drawn: boolean) => void;
}

/** Run `fn` two animation frames from now (Cloud's `afterTwoFrames`); returns the cancel. */
function afterTwoFrames(fn: () => void): () => void {
  let second = 0;
  const first = requestAnimationFrame(() => {
    second = requestAnimationFrame(fn);
  });
  return () => {
    cancelAnimationFrame(first);
    cancelAnimationFrame(second);
  };
}

export function KimmField({ open, mode = "live", hold = false, onDrawn }: KimmFieldProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<GradientAsciiHandle | null>(null);
  const still = useStillFrame();
  const [onScreen, setOnScreen] = useState(false);
  const running = kimmFieldRuns({ mode, open: open && !hold, still, onScreen });
  const runningRef = useRef(running);
  const drawnRef = useRef(onDrawn);
  useEffect(() => {
    drawnRef.current = onDrawn;
  }, [onDrawn]);

  // The run gate: on screen and the window shown.
  useEffect(() => {
    const box = boxRef.current;
    if (box === null) return undefined;
    const gate = new RunGate(box, setOnScreen);
    return () => gate.destroy();
  }, []);

  // Running or holding its frame, without a remount.
  useEffect(() => {
    runningRef.current = running;
    handleRef.current?.setStill(!running);
  }, [running]);

  // The port: mounted once per mode, holding one frame, then running if the
  // gate says so by then.
  useEffect(() => {
    const box = boxRef.current;
    if (box === null) return undefined;
    let cancelled = false;
    let cancelFrames = (): void => undefined;
    void import("./gradient-ascii.js").then(({ mountGradientAscii }) => {
      if (cancelled) return;
      const handle = mountGradientAscii(box, kimmFieldOptions(mode, false, window.devicePixelRatio));
      handleRef.current = handle;
      if (runningRef.current) handle.setStill(false);
      if (!handle.drawn) return;
      cancelFrames = afterTwoFrames(() => {
        if (!cancelled) drawnRef.current?.(true);
      });
    });
    return () => {
      cancelled = true;
      cancelFrames();
      if (handleRef.current !== null) {
        handleRef.current.dispose();
        handleRef.current = null;
        drawnRef.current?.(false);
      }
    };
  }, [mode]);

  return (
    <div
      ref={boxRef}
      aria-hidden="true"
      data-vex-area="kimm-field"
      data-kimm-field-running={running ? "true" : "false"}
      className="vex-kimm__field"
    />
  );
}
