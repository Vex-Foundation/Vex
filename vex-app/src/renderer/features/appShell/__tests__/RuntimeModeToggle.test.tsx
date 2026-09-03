/**
 * The `Agent | Studio` capsule's KEYBOARD model.
 *
 * Why this suite exists now: the capsule used to live only on the two welcome
 * screens, where a user who could not operate it still had the rest of the hero
 * to reach for. It is in the Studio RAIL now (finding I9), and there it is the
 * only rendered way back to the agent shell from inside a project. A control
 * with that job has to answer the keyboard, and it answered nothing at all: two
 * tab stops, no arrow keys, and Space on whichever segment the user happened to
 * land on.
 *
 * The contract asserted here is the WAI-ARIA radiogroup one, which is also the
 * roving-tabindex half of VS Code's list model (`listWidget.ts`: focus is a
 * trait, and exactly one element is the tab stop): the GROUP is one tab stop,
 * the arrow keys move within it, and moving selects.
 */

import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RuntimeModeToggle } from "../RuntimeModeToggle.js";

/** Render at a mode and hand back the change spy plus the two segments. */
function mount(runtimeMode: "agent" | "studio") {
  const onChange = vi.fn();
  render(<RuntimeModeToggle runtimeMode={runtimeMode} onChange={onChange} />);
  return {
    onChange,
    agent: screen.getByRole("radio", { name: "Agent" }),
    studio: screen.getByRole("radio", { name: "Studio" }),
  };
}

describe("the runtime mode capsule", () => {
  it("is ONE tab stop: only the checked segment is reachable by Tab", () => {
    const a = mount("agent");
    expect(a.agent.tabIndex).toBe(0);
    expect(a.studio.tabIndex).toBe(-1);
    expect(a.agent.getAttribute("aria-checked")).toBe("true");
    expect(a.studio.getAttribute("aria-checked")).toBe("false");
  });

  it("moves the tab stop with the CHOICE, not with the pointer", () => {
    const b = mount("studio");
    expect(b.studio.tabIndex).toBe(0);
    expect(b.agent.tabIndex).toBe(-1);
  });

  it("arrow keys move focus AND select, in both directions and on both axes", () => {
    // Right/Down and Left/Up both work: the capsule is horizontal, but a user
    // whose muscle memory is a vertical list should not find it inert.
    for (const key of ["ArrowRight", "ArrowDown"]) {
      const c = mount("agent");
      fireEvent.keyDown(c.agent, { key });
      expect(c.onChange).toHaveBeenCalledWith("studio");
      expect(document.activeElement).toBe(c.studio);
      cleanup();
    }
    for (const key of ["ArrowLeft", "ArrowUp"]) {
      const c = mount("studio");
      fireEvent.keyDown(c.studio, { key });
      expect(c.onChange).toHaveBeenCalledWith("agent");
      expect(document.activeElement).toBe(c.agent);
      cleanup();
    }
  });

  it("wraps at both ends rather than dead-ending", () => {
    const c = mount("studio");
    fireEvent.keyDown(c.studio, { key: "ArrowRight" });
    expect(c.onChange).toHaveBeenCalledWith("agent");
  });

  it("ignores keys it does not own, so a chord still reaches the shell", () => {
    const c = mount("agent");
    for (const key of ["Tab", "a", "Escape", "Home"]) {
      fireEvent.keyDown(c.agent, { key });
    }
    expect(c.onChange).not.toHaveBeenCalled();
  });

  it("still switches on a click", () => {
    const c = mount("agent");
    fireEvent.click(c.studio);
    expect(c.onChange).toHaveBeenCalledWith("studio");
  });

  it("names the group, so the choice is not two unexplained words", () => {
    mount("agent");
    expect(screen.getByRole("radiogroup", { name: "Runtime mode" })).not.toBeNull();
  });
});
