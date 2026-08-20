/**
 * Chronos Gate backdrop — the drifting dither sky inside one curtain
 * panel. Each panel clips a full-viewport sky layer anchored to its own
 * edge, so the two halves compose one seamless image until the curtain
 * splits them apart.
 */

import type { JSX } from "react";
import { cn } from "../../../lib/utils.js";

export function GateBackdrop({
  edge,
}: {
  /** Which window edge this panel hugs (anchors the sky slice). */
  readonly edge: "top" | "bottom";
}): JSX.Element {
  return (
    <div
      aria-hidden
      className={cn(
        "absolute inset-x-0 h-screen overflow-hidden",
        edge === "top" ? "top-0" : "bottom-0",
      )}
    >
      <div className="chronos-sky" />
    </div>
  );
}
