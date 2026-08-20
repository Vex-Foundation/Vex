/**
 * SessionWelcomeHero — the rebrand hero contract (accepted mockup,
 * 2026-08-20): vx mark pair themed by CSS, Doto date eyebrow carrying the
 * honest build-stage disclosure, the display headline, the reserved
 * Agent | Studio toggle (Studio disabled + lock, runtimeMode read-only),
 * and the retirement of the BACKED BY footer (studio seam #2).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useUiStore } from "../../../stores/uiStore.js";
import { SessionWelcomeHero } from "../SessionWelcomeHero.js";

/** The five retired rotator quips — must never render again. */
const RETIRED_QUIPS = [
  "Signed. Sealed. Executed.",
  "Your rules. My moves.",
  "Propose. Enforce. Prove.",
  "The desk is open.",
  "VEX is listening.",
] as const;

beforeEach(() => {
  useUiStore.setState({ runtimeMode: "agent" });
});

describe("SessionWelcomeHero", () => {
  it("renders the vx mark pair: white for chronos, brand color revealed only under the celeris theme attribute", () => {
    const { container } = render(<SessionWelcomeHero />);
    const marks = Array.from(container.querySelectorAll("img"));
    expect(marks.map((img) => img.getAttribute("src"))).toEqual([
      "/brand/vex-mark-white.svg",
      "/brand/vex-mark-color.svg",
    ]);
    // Theme selection is pure CSS on the html attribute — the white mark
    // hides under celeris, the color mark shows only there. No JS theme read.
    expect(marks[0]?.className).toContain("[[data-vex-theme=celeris]_&]:hidden");
    expect(marks[1]?.className).toContain("hidden");
    expect(marks[1]?.className).toContain("[[data-vex-theme=celeris]_&]:block");
    for (const mark of marks) {
      expect(mark.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("speaks the date in the Doto eyebrow and keeps the honest preview disclosure as its tooltip", () => {
    const { container } = render(<SessionWelcomeHero />);
    const eyebrow = container.querySelector(".font-doto");
    expect(eyebrow).not.toBeNull();
    // A date, uppercase, e.g. "WEDNESDAY · AUG 20" — pinned by grammar, not
    // by today's value.
    expect(eyebrow?.textContent).toMatch(/^[A-Z]+ · [A-Z]{3} \d{1,2}$/);
    expect(eyebrow?.getAttribute("title")).toContain("Preview build (v0.0.0-test)");
    expect(eyebrow?.getAttribute("title")).toContain("Self-custodial");
  });

  it("renders the headline as the stage's one heading", () => {
    render(<SessionWelcomeHero />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("What should I execute?");
  });

  it("reserves the Studio seat: disabled, wearing the lock, and never writing runtimeMode", () => {
    render(<SessionWelcomeHero />);
    const studio = screen.getByRole("button", {
      name: "Studio mode (coming soon)",
    });
    expect(studio).toHaveProperty("disabled", true);
    expect(studio.querySelector("svg")).not.toBeNull();
    fireEvent.click(studio);
    expect(useUiStore.getState().runtimeMode).toBe("agent");
  });

  it("marks the Agent segment as the current runtime mode without offering a switch", () => {
    render(<SessionWelcomeHero />);
    const group = screen.getByRole("group", { name: "Runtime mode" });
    const agent = Array.from(group.querySelectorAll("span")).find(
      (el) => el.textContent === "Agent",
    );
    expect(agent?.getAttribute("aria-current")).toBe("true");
    // Agent is a state readout, not a control — no button, no store write.
    expect(agent?.tagName).toBe("SPAN");
  });

  it("retires the BACKED BY footer band entirely (studio seam #2)", () => {
    render(<SessionWelcomeHero />);
    expect(screen.queryByText(/Backed by/i)).toBeNull();
    expect(screen.queryByAltText("Virtuals")).toBeNull();
  });

  it("retired compositions stay dead: quips, PREVIEW wordmark, sigil, integrations rail", () => {
    const { container } = render(<SessionWelcomeHero />);
    for (const quip of RETIRED_QUIPS) {
      expect(screen.queryByText(quip)).toBeNull();
    }
    expect(screen.queryByText(/^PREVIEW · v/)).toBeNull();
    expect(container.querySelector("[data-vex-sigil]")).toBeNull();
    expect(screen.queryByText(/Executes through/i)).toBeNull();
  });
});
