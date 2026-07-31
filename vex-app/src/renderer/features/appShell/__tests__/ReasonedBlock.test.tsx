/**
 * PERSISTED REASONING block (contract C1).
 *
 * The load-bearing case is NULL vs PRESENT: until Lane ENGINE lands (and
 * forever, for legacy rows and providers that emit no reasoning) `reasoning`
 * is null, and the block must render NOTHING — an empty "Reasoned" affordance
 * that opens onto nothing is a worse lie than an absent one.
 *
 * Also pins that the stamp matches the island's post-thinking stamp, and that
 * a count we do not have is OMITTED rather than estimated.
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { ReasonedBlock } from "../ReasonedBlock.js";

describe("ReasonedBlock", () => {
  it.each([
    ["null (legacy row / provider emitted none)", null],
    ["undefined (row model has no field)", undefined],
    ["an empty string", ""],
  ])("renders NOTHING for %s", (_label, reasoning) => {
    const { container } = render(
      createElement(ReasonedBlock, { reasoning: reasoning as string | null }),
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders the collapsed stamp when reasoning is present", () => {
    const { container } = render(
      createElement(ReasonedBlock, { reasoning: "I weighed the options" }),
    );
    expect(container.querySelector('[data-vex-reasoning="persisted"]')).not.toBeNull();
    const btn = screen.getByRole("button", { name: /Reasoned/ });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    // Collapsed by default — a long trace never buries the answer.
    expect(container.textContent).not.toContain("I weighed the options");
  });

  it("expands through aria-controls and renders the trace as MARKDOWN", () => {
    const { container } = render(
      createElement(ReasonedBlock, { reasoning: "weighed the **ledger**" }),
    );
    const btn = screen.getByRole("button", { name: /Reasoned/ });
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const body = document.getElementById(btn.getAttribute("aria-controls")!);
    expect(body).not.toBeNull();
    expect(body?.querySelector("strong")?.textContent).toBe("ledger");
  });

  it("omits a token count we do not have, and prints one we do", () => {
    const bare = render(createElement(ReasonedBlock, { reasoning: "t" }));
    expect(screen.getByRole("button", { name: /Reasoned/ }).textContent).toBe(
      "Reasoned",
    );
    bare.unmount();

    render(createElement(ReasonedBlock, { reasoning: "t", tokens: 1234 }));
    // Identical grammar to the island's post-thinking stamp.
    expect(
      screen.getByRole("button", { name: /Reasoned/ }).textContent,
    ).toContain("Reasoned · 1.2K tokens");
  });

  it("never renders markup from the trace (safe React elements only)", () => {
    const { container } = render(
      createElement(ReasonedBlock, {
        reasoning: '<img src=x onerror="alert(1)">',
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Reasoned/ }));
    expect(container.querySelector("img")).toBeNull();
  });
});
