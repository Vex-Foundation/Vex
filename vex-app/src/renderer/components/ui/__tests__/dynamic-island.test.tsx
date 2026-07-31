/**
 * THE FREEZE, proven at the config level.
 *
 * The island's stillness while a signature is pending is a TRUST property, not
 * decoration: a shell that keeps springing reads as progress that is not
 * happening. Motion configs are asserted directly (`resolveIslandMotion`) plus
 * the shell's rendered `data-vex-island-still` seam — never pixels, which say
 * nothing about what a spring would have done.
 */

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { createElement } from "react";
import {
  DynamicIsland,
  DynamicIslandProvider,
  resolveIslandMotion,
} from "../dynamic-island.js";

describe("resolveIslandMotion", () => {
  it("springs a content change when nothing is frozen or reduced", () => {
    const motion = resolveIslandMotion(false, false, true);
    expect(motion.still).toBe(false);
    expect(motion.enterOffset).toBe(4);
    expect(motion.transition).not.toEqual({ duration: 0 });
  });

  it("makes EVERY transition a hard cut while frozen", () => {
    const motion = resolveIslandMotion(false, true, true);
    expect(motion.still).toBe(true);
    expect(motion.enterOffset).toBe(0);
    expect(motion.transition).toEqual({ duration: 0 });
  });

  it("reduced motion freezes it too, frozen or not", () => {
    for (const frozen of [false, true]) {
      expect(resolveIslandMotion(true, frozen, true).transition).toEqual({
        duration: 0,
      });
    }
  });

  it("an unchanged view never enters with an offset", () => {
    expect(resolveIslandMotion(false, false, false).enterOffset).toBe(0);
  });
});

describe("DynamicIsland shell", () => {
  function shell(frozen: boolean): Element | null {
    // Children ride in the props object (not createElement's rest args) so
    // the required `children` prop is seen by the typechecker.
    const { container } = render(
      createElement(DynamicIslandProvider, {
        initialSize: "row",
        frozen,
        children: createElement(DynamicIsland, { id: "t", children: "body" }),
      }),
    );
    return container.querySelector("#t");
  }

  it("marks the shell still when its consumer declares the freeze", () => {
    expect(shell(true)?.hasAttribute("data-vex-island-still")).toBe(true);
  });

  it("leaves the shell free to morph otherwise", () => {
    expect(shell(false)?.hasAttribute("data-vex-island-still")).toBe(false);
  });
});
