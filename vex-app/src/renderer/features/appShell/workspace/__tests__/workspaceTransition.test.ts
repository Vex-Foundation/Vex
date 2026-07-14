/**
 * The "liquid pour" transition props (design spec §5). The reduced-motion
 * branch is a hard accessibility contract, so it is pinned directly here rather
 * than left to a framer render.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspaceTransition } from "../workspaceTransition.js";

describe("buildWorkspaceTransition", () => {
  it("full motion: a droplet clip-path reveal that contracts back on exit", () => {
    const props = buildWorkspaceTransition(false);
    expect(props.initial).toEqual({ clipPath: "circle(0% at 88% 8%)", opacity: 1 });
    expect(props.animate).toEqual({ clipPath: "circle(150% at 88% 8%)", opacity: 1 });
    expect(props.exit).toEqual({ clipPath: "circle(0% at 88% 8%)", opacity: 1 });
    // Only clip-path / opacity animate — no layout props, no blur.
    expect(props.transition).toEqual({ duration: 0.62, ease: [0.76, 0, 0.24, 1] });
  });

  it("reduced motion: a single 120ms opacity crossfade, no mask, no travel", () => {
    const props = buildWorkspaceTransition(true);
    expect(props.initial).toEqual({ opacity: 0 });
    expect(props.animate).toEqual({ opacity: 1 });
    expect(props.exit).toEqual({ opacity: 0 });
    expect(props.transition).toEqual({ duration: 0.12 });
    // No clip-path anywhere under reduced motion.
    expect(JSON.stringify(props)).not.toContain("clipPath");
  });
});
