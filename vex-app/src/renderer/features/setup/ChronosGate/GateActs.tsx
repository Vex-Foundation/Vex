/**
 * Chronos Gate acts — the presentational content of the boot choreography
 * (design-language §6a). Act I: diamond wipes cross over the sky. Act II:
 * the vx mark enters as a blur echo, then sharpens. Act III: the white
 * diamond seal stamps, the CHRONOS GATE label appears, and the 2px
 * progress line reports the REAL launch pipeline. All timing lives in the
 * stylesheet keyframes (global-css/chronos-gate.css); reduced motion
 * lands the Act III resting frame instantly.
 */

import type { CSSProperties, JSX } from "react";
import type { SetupStatusLine } from "../useSetupOrchestrator.js";
import { STAGE_PROGRESS } from "./gate-timeline.js";

function SealStar(): JSX.Element {
  // The four-pointed star from the seal in the VEX 2 frames.
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M12 1.5 L14.4 9.6 L22.5 12 L14.4 14.4 L12 22.5 L9.6 14.4 L1.5 12 L9.6 9.6 Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function GateActs({
  status,
}: {
  readonly status: SetupStatusLine;
}): JSX.Element {
  return (
    <>
      {/* Act I — the gate opens: two diamond edges cross the sky. */}
      <div aria-hidden className="chronos-wipe chronos-wipe--down" />
      <div aria-hidden className="chronos-wipe chronos-wipe--up" />

      {/* Act II — the mark: soft echo first, sharp on top. */}
      <div aria-hidden className="chronos-mark select-none">
        <img
          src="/brand/vex-mark-white.svg"
          alt=""
          draggable={false}
          className="chronos-mark__echo w-full"
        />
        <img
          src="/brand/vex-mark-white.svg"
          alt=""
          draggable={false}
          className="chronos-mark__sharp w-full"
        />
      </div>

      {/* Act III — the seal stamps, one ripple lets go. */}
      <div aria-hidden className="chronos-seal">
        <span className="chronos-seal__star">
          <SealStar />
        </span>
      </div>
      <div aria-hidden className="chronos-seal-ripple" />

      {/* Act III chrome — label + the real pipeline's progress line. */}
      <div className="absolute inset-x-0 top-[72%] flex flex-col items-center gap-4">
        <span aria-hidden className="chronos-gate-label">
          Chronos Gate
        </span>
        <div aria-hidden className="chronos-progress">
          <span
            className="chronos-progress__fill"
            // Single custom-property write via CSSOM (CSP-safe); the CSS
            // transition rides the resulting scaleX change.
            style={
              {
                "--chronos-progress": STAGE_PROGRESS[status.key],
              } as CSSProperties
            }
          />
        </div>
        <p
          role="status"
          aria-live="polite"
          className="chronos-gate-status vex-micro text-white/80"
        >
          {status.label}
        </p>
      </div>
    </>
  );
}
