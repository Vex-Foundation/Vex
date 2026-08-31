/**
 * SessionWelcomeHero — the rebrand hero contract (accepted mockup,
 * 2026-08-20): vx mark pair themed by CSS, micro-label date eyebrow carrying the
 * honest build-stage disclosure, the display headline, the LIVE Agent | Studio
 * runtime-mode radiogroup, and the retirement of the BACKED BY footer.
 *
 * CONTRACT CHANGE, stage B4a: the two tests below used to pin the OPPOSITE
 * contract - a disabled Studio button wearing a lock and an "coming soon"
 * title, and an inert `<span aria-current>` for Agent. Vex Studio now ships, so
 * both segments are radios that write `runtimeMode`. The tests are rewritten to
 * the new contract rather than relaxed: they still assert exactly one current
 * segment, they still assert the mark, and they now assert the store write that
 * the old pair asserted must NOT happen.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { greetingPoolForHour } from "../../../lib/greeting.js";
import { useUiStore } from "../../../stores/uiStore.js";

// The hero reads the Vex-setup displayName through the SAME profile hook
// SidebarProfile uses; stubbed per case so both headline forms are provable
// without a query provider.
const useUserProfileMock = vi.fn();
vi.mock("../../../lib/api/user-profile.js", () => ({
  useUserProfile: () => useUserProfileMock(),
}));

const { SessionWelcomeHero } = await import("../SessionWelcomeHero.js");

function profileWithName(displayName: string | null): void {
  useUserProfileMock.mockReturnValue({
    data: { ok: true, data: { displayName } },
  });
}

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
  profileWithName(null);
});

describe("SessionWelcomeHero", () => {
  it("renders the vx mark inline on currentColor ink - no theme-swapped image pair", () => {
    // Owner rule 2026-08-21: the standalone mark is WHITE everywhere in
    // chronos and BRAND BLUE in celeris. One inline SVG on the brand-mark
    // token carries both - no img assets, no theme-attribute variants, no JS
    // theme read; the flip lives in tokens.css.
    const { container } = render(<SessionWelcomeHero />);
    expect(container.querySelector("img")).toBeNull();
    const markBox = container.querySelector('span[aria-hidden="true"]');
    expect(markBox).not.toBeNull();
    expect(markBox?.className).toContain("text-brand-mark");
    expect(markBox?.querySelector("svg path")).not.toBeNull();
  });

  it("speaks the date in the micro-label eyebrow and keeps the honest preview disclosure as its tooltip", () => {
    const { container } = render(<SessionWelcomeHero />);
    const eyebrow = container.querySelector(".vex-micro-label");
    expect(eyebrow).not.toBeNull();
    // A date, uppercase, e.g. "WEDNESDAY · AUG 20" — pinned by grammar, not
    // by today's value.
    expect(eyebrow?.textContent).toMatch(/^[A-Z]+ · [A-Z]{3} \d{1,2}$/);
    expect(eyebrow?.getAttribute("title")).toContain("Preview build (v0.0.0-test)");
    expect(eyebrow?.getAttribute("title")).toContain("Self-custodial");
  });

  it("draws the headline from the current bucket's NAMELESS pool while no displayName is set", () => {
    render(<SessionWelcomeHero />);
    const heading = screen.getByRole("heading", { level: 1 });
    const nameless = greetingPoolForHour(new Date().getHours())
      .filter((variant) => !variant.withName)
      .map((variant) => variant.text);
    expect(nameless).toContain(heading.textContent);
  });

  it("with a set displayName the whole bucket is eligible and {name} is substituted", () => {
    profileWithName("desu");
    render(<SessionWelcomeHero />);
    const heading = screen.getByRole("heading", { level: 1 });
    const eligible = greetingPoolForHour(new Date().getHours()).map((variant) =>
      variant.text.replace("{name}", "desu"),
    );
    expect(eligible).toContain(heading.textContent);
    expect(heading.textContent).not.toContain("{name}");
  });

  it("fails closed to the nameless draw while the profile read is unresolved or failed", () => {
    useUserProfileMock.mockReturnValue({ data: undefined });
    render(<SessionWelcomeHero />);
    const heading = screen.getByRole("heading", { level: 1 });
    const nameless = greetingPoolForHour(new Date().getHours())
      .filter((variant) => !variant.withName)
      .map((variant) => variant.text);
    expect(nameless).toContain(heading.textContent);
  });

  it("freezes the draw per mount - re-rendering never changes the headline", () => {
    const randSpy = vi.spyOn(Math, "random");
    const view = render(<SessionWelcomeHero />);
    const first = screen.getByRole("heading", { level: 1 }).textContent;
    view.rerender(<SessionWelcomeHero />);
    view.rerender(<SessionWelcomeHero />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(first);
    // One draw for the whole mount, not one per render.
    expect(randSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("switches the shell to Studio, with no lock and no roadmap copy", () => {
    render(<SessionWelcomeHero />);
    const studio = screen.getByRole("radio", { name: "Studio" });
    expect(studio).toHaveProperty("disabled", false);
    expect(studio.getAttribute("aria-checked")).toBe("false");
    // The lock glyph and the "coming soon" title are GONE, not merely hidden.
    expect(studio.querySelector("svg")).toBeNull();
    expect(studio.getAttribute("title")).toBeNull();

    fireEvent.click(studio);
    expect(useUiStore.getState().runtimeMode).toBe("studio");
  });

  it("marks exactly one segment as the current runtime mode, both ways", () => {
    render(<SessionWelcomeHero />);
    const group = screen.getByRole("radiogroup", { name: "Runtime mode" });
    expect(group).not.toBeNull();

    const agent = screen.getByRole("radio", { name: "Agent" });
    expect(agent.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Studio" }).getAttribute("aria-checked")).toBe(
      "false",
    );

    fireEvent.click(screen.getByRole("radio", { name: "Studio" }));
    expect(screen.getByRole("radio", { name: "Agent" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(screen.getByRole("radio", { name: "Studio" }).getAttribute("aria-checked")).toBe(
      "true",
    );

    // And back: the segment is a switch in both directions.
    fireEvent.click(screen.getByRole("radio", { name: "Agent" }));
    expect(useUiStore.getState().runtimeMode).toBe("agent");
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
