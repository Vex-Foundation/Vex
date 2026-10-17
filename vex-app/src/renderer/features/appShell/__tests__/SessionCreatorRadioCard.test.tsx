/**
 * RadioCard (new-session form grids, Studio project dialogs) - pins the R3
 * selection law (docs/design/R3-MINIMAL.md section 12): the checked card is
 * marked by the solid swatch and the 1.5px blue frame (a state is a fill, not
 * a wash), the control stays a real native radio for AT, and selection never
 * restyles the title away from primary ink (theme-safe in chronos AND
 * celeris).
 */

import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState, type JSX } from "react";
import { RadioCard } from "../SessionCreator/RadioCard.js";

function Grid(): JSX.Element {
  const [value, setValue] = useState("a");
  return (
    <div role="radiogroup" aria-label="Mode">
      <RadioCard
        name="mode"
        value="a"
        checked={value === "a"}
        onChange={() => setValue("a")}
        title="Chat"
        description="Talk first"
        tag="Funds require approval"
      />
      <RadioCard
        name="mode"
        value="b"
        checked={value === "b"}
        onChange={() => setValue("b")}
        title="Mission"
        description="Run autonomously"
        caution
      />
    </div>
  );
}

describe("SessionCreator RadioCard", () => {
  it("keeps a native radio group: exactly one checked, clicking the other card moves the check", () => {
    render(<Grid />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByText("Mission"));
    expect((radios[1] as HTMLInputElement).checked).toBe(true);
    expect((radios[0] as HTMLInputElement).checked).toBe(false);
  });

  it("marks selection with the solid swatch and the blue frame on the checked card only", () => {
    const { container } = render(<Grid />);
    const cards = Array.from(container.querySelectorAll("[data-vex-radio-card]"));
    expect(cards).toHaveLength(2);
    const swatchStates = (): (string | null)[] =>
      cards.map((card) => card.querySelector("[data-s]")?.getAttribute("data-s") ?? null);

    expect(swatchStates()).toEqual(["done", "idle"]);
    expect(cards[0]?.hasAttribute("data-checked")).toBe(true);
    expect(cards[0]?.className).toContain("border-accent-primary");
    expect(cards[1]?.hasAttribute("data-checked")).toBe(false);
    expect(cards[1]?.className).not.toContain("border-accent-primary");

    fireEvent.click(screen.getByText("Mission"));
    expect(swatchStates()).toEqual(["idle", "done"]);
    expect(cards[1]?.hasAttribute("data-checked")).toBe(true);
  });

  it("draws square cards with no wash, no ring and no ordinal", () => {
    const { container } = render(<Grid />);
    const html = container.innerHTML;
    expect(html).not.toContain("rounded");
    expect(html).not.toContain("ring-");
    expect(html).not.toContain("bg-accent");
  });

  it("keeps the title in primary ink whichever card is checked", () => {
    render(<Grid />);
    const title = (): string => screen.getByText("Chat").className;
    expect(title()).toContain("text-ink-primary");
    fireEvent.click(screen.getByText("Mission"));
    expect(title()).toContain("text-ink-primary");
  });

  it("shows the quiet tag beside the title", () => {
    render(<Grid />);
    expect(screen.getByText("Funds require approval")).toBeTruthy();
  });

  it("caution register steps only the checked caution card's consequence line up to primary ink", () => {
    render(<Grid />);
    // Unchecked caution card: the consequence line stays ink 2.
    expect(screen.getByText("Run autonomously").className).toContain("text-ink-secondary");
    fireEvent.click(screen.getByText("Mission"));
    expect(screen.getByText("Run autonomously").className).toContain("text-ink-primary");
    expect(screen.getByText("Run autonomously").className).not.toContain("text-warning");
  });
});
