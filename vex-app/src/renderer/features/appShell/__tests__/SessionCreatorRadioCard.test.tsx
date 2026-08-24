/**
 * RadioCard (New-session modal grids) — pins the tokens-v2 selection law:
 * the checked card is marked by the accent trust bar (check-not-fill), the
 * control stays a real native radio for AT, and selection never restyles
 * the title away from primary ink (theme-safe in chronos AND celeris).
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
        index="01"
        title="Chat"
        description="Talk first"
      />
      <RadioCard
        name="mode"
        value="b"
        checked={value === "b"}
        onChange={() => setValue("b")}
        index="02"
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

  it("marks selection with the accent trust bar only on the checked card (check-not-fill law)", () => {
    const { container } = render(<Grid />);
    // The marker is the single accent-filled bar element; unchecked cards draw none.
    expect(container.querySelectorAll(".bg-accent-primary")).toHaveLength(1);
    fireEvent.click(screen.getByText("Mission"));
    expect(container.querySelectorAll(".bg-accent-primary")).toHaveLength(1);
  });

  it("caution register colors only the checked caution card's consequence line", () => {
    render(<Grid />);
    // Unchecked caution card: consequence line stays muted ink.
    expect(screen.getByText("Run autonomously").className).not.toContain("text-warning");
    fireEvent.click(screen.getByText("Mission"));
    expect(screen.getByText("Run autonomously").className).toContain("text-warning");
  });
});
