/**
 * VexStatus: Vex with the avatar off (docs/design/R3-MINIMAL.md section 5.1),
 * the flat token in a state ring beside or over the host's word.
 * Regressions this catches:
 *  - a state without a ring, or two states (other than listening and waking,
 *    both "in progress on the dot screen") drawn alike;
 *  - a warning state (concerned, error) ringed in the blue, or a calm one in
 *    ink;
 *  - the awaiting badge, the error's four breaks or the sleeping dashes lost;
 *  - a token or ring announced to assistive tech (the word carries the state);
 *  - the word dropped, or laid out on the wrong side of the token;
 *  - a ring that moves (it must swap at once, with nothing to collapse under
 *    reduced motion).
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { STATUS_RINGS, VexStatus, VexStatusToken } from "../VexStatus.js";
import { VEX_STATES } from "../vex-state.js";

describe("the status ring table", () => {
  it("draws every state, each its own way (listening and waking share the dot screen's ring)", () => {
    expect(Object.keys(STATUS_RINGS).sort()).toEqual([...VEX_STATES].sort());
    const looks = new Map<string, string[]>();
    for (const state of VEX_STATES) {
      const key = JSON.stringify(STATUS_RINGS[state]);
      looks.set(key, [...(looks.get(key) ?? []), state]);
    }
    const shared = [...looks.values()].filter((states) => states.length > 1);
    expect(shared).toEqual([["listening", "waking"]]);
  });

  it("rings the two warning states in ink and every other state in the blue", () => {
    for (const state of VEX_STATES) {
      const warning = state === "concerned" || state === "error";
      expect(STATUS_RINGS[state].ink).toBe(warning ? "ink" : "blue");
    }
  });

  it("keeps every ring visible and every arc on the circle", () => {
    for (const state of VEX_STATES) {
      const ring = STATUS_RINGS[state];
      expect(ring.base > 0 || ring.arcs.length > 0).toBe(true);
      for (const arc of ring.arcs) {
        expect(arc.len).toBeGreaterThan(0);
        expect(arc.len).toBeLessThan(360);
        expect(arc.alpha).toBeGreaterThan(0);
        expect(arc.alpha).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("VexStatusToken", () => {
  it("is the 44px flat token in a ring 56px across, hidden from assistive tech", () => {
    const { container } = render(<VexStatusToken state="ready" />);
    const token = container.querySelector("[data-vex-status-token]");
    expect(token?.getAttribute("aria-hidden")).toBe("true");
    expect(token?.querySelector("[data-vex-vx-token] svg")?.getAttribute("width")).toBe("44");
    const ring = token?.querySelector("[data-vex-status-ring]");
    expect(ring?.getAttribute("data-vex-status-ring")).toBe("ready");
    expect(ring?.getAttribute("width")).toBe("56");
    expect(ring?.getAttribute("class")).toContain("text-accent-primary");
  });

  it("waiting for approval: a full ring and the badge", () => {
    const { container } = render(<VexStatusToken state="awaiting" />);
    expect(container.querySelectorAll("[data-vex-status-ring] circle")).toHaveLength(2);
    expect(container.querySelector("[data-vex-status-badge]")).not.toBeNull();
  });

  it("error: an ink ring broken in four, no full circle", () => {
    const { container } = render(<VexStatusToken state="error" />);
    const ring = container.querySelector("[data-vex-status-ring]");
    expect(ring?.getAttribute("class")).toContain("text-ink-primary");
    const arcs = ring?.querySelectorAll("circle") ?? [];
    expect(arcs).toHaveLength(4);
    for (const arc of Array.from(arcs)) {
      expect(arc.getAttribute("stroke-dasharray")).toBe("60 300");
    }
  });

  it("sleeping: a dashed ring", () => {
    const { container } = render(<VexStatusToken state="sleeping" />);
    const circles = container.querySelectorAll("[data-vex-status-ring] circle");
    expect(circles).toHaveLength(1);
    expect(circles[0]?.getAttribute("stroke-dasharray")).toBe("4.5 7.5");
  });

  it("working: a faint ring and one long arc from the top", () => {
    const { container } = render(<VexStatusToken state="working" />);
    const circles = container.querySelectorAll("[data-vex-status-ring] circle");
    expect(circles).toHaveLength(2);
    expect(circles[1]?.getAttribute("stroke-dasharray")).toBe("115 245");
    expect(circles[1]?.getAttribute("transform")).toBe("rotate(-90 28 28)");
  });

  it("never moves: no animation or transition on the ring", () => {
    for (const state of VEX_STATES) {
      const { container, unmount } = render(<VexStatusToken state={state} />);
      const ring = container.querySelector("[data-vex-status-ring]");
      expect(ring?.getAttribute("class") ?? "").not.toMatch(/animate|transition/);
      expect(ring?.querySelector("animate, animateTransform")).toBeNull();
      unmount();
    }
  });
});

describe("VexStatus", () => {
  it("row: the token beside the host's word (the Vex sidebar)", () => {
    const { container } = render(
      <VexStatus state="working">
        <p>This chat: Working</p>
      </VexStatus>,
    );
    const root = container.querySelector("[data-vex-status]");
    expect(root?.getAttribute("data-vex-status")).toBe("working");
    expect(root?.getAttribute("data-vex-status-layout")).toBe("row");
    expect(root?.className).toContain("flex");
    expect(root?.className).not.toContain("flex-col");
    expect(root?.firstElementChild?.hasAttribute("data-vex-status-token")).toBe(true);
    expect(container.querySelector("[data-vex-status-word]")?.textContent).toBe(
      "This chat: Working",
    );
  });

  it("stack: the token over the host's word (the welcome)", () => {
    const { container } = render(
      <VexStatus state="ready" layout="stack">
        <p>Ready</p>
      </VexStatus>,
    );
    const root = container.querySelector("[data-vex-status]");
    expect(root?.getAttribute("data-vex-status-layout")).toBe("stack");
    expect(root?.className).toContain("flex-col");
    expect(root?.textContent).toBe("Ready");
  });
});
