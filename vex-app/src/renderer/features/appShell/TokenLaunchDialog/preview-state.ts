/**
 * The pricing-readiness ladder, shared by every launch lane.
 *
 * Resolved in ONE place so no rung can be skipped, and shared across platforms
 * for the same reason the phase union is: "we could not price this" and "your
 * input is wrong" are different sentences, and a lane that blurs them blames the
 * user for our own failed read.
 */

import type { PreviewState } from "../token-launch/LaunchPreviewCard.js";

/**
 * `unavailable` outranks `error` when the bridge is not mounted at all: that is
 * our side not being ready, and phrasing it as a failed read would blame the
 * user's input for something their input did not cause.
 */
export function resolvePreviewState(input: {
  readonly bridgeMounted: boolean;
  readonly hasInput: boolean;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly result: { readonly ok: boolean } | undefined;
}): PreviewState {
  if (!input.bridgeMounted) return "unavailable";
  if (!input.hasInput) return "idle";
  if (input.loading) return "loading";
  if (input.failed) return "error";
  if (input.result === undefined) return "loading";
  return input.result.ok ? "ready" : "error";
}
