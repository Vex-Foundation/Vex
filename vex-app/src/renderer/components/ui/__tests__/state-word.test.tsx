/**
 * StateWord: a state is a fill AND a word. Pins:
 *   - the word always renders, beside exactly one swatch of the same state;
 *   - the swatch takes the one blue and a caller can ink it;
 *   - the scope and the timer render only when given;
 *   - the live region is opt-in and polite.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StateWord } from "../state-word.js";

afterEach(cleanup);

function root(container: HTMLElement): HTMLElement {
  const node = container.querySelector<HTMLElement>(".vex-state-word");
  if (node === null) throw new Error("missing .vex-state-word");
  return node;
}

describe("StateWord", () => {
  it("renders the word beside one swatch of the same state", () => {
    const { container } = render(<StateWord state="awaiting" word="Waiting for approval" />);
    const node = root(container);
    expect(node.textContent).toBe("Waiting for approval");
    const swatches = node.querySelectorAll(".vex-swatch");
    expect(swatches).toHaveLength(1);
    expect(swatches[0]?.getAttribute("data-s")).toBe("awaiting");
    expect(node.getAttribute("data-s")).toBe("awaiting");
  });

  it("paints the swatch in the one blue unless the caller inks it", () => {
    const { container, rerender } = render(<StateWord state="done" word="Done" />);
    expect(root(container).querySelector(".vex-swatch")?.className).toContain("text-accent-primary");
    rerender(<StateWord state="awaiting" word="Waiting for approval" swatchClassName="text-ink-primary" />);
    const className = root(container).querySelector(".vex-swatch")?.className ?? "";
    expect(className).toContain("text-ink-primary");
    expect(className).not.toContain("text-accent-primary");
  });

  it("renders the scope before the word and the timer after it", () => {
    const { container } = render(
      <StateWord state="done" word="Working" scope="This chat:" timer="0:02" size={12} />,
    );
    const node = root(container);
    expect(node.querySelector(".vex-state-word__scope")?.textContent).toBe("This chat: ");
    expect(node.querySelector(".vex-state-word__timer")?.textContent).toBe("0:02");
    expect(node.textContent).toBe("This chat: Working0:02");
    expect((node.querySelector(".vex-swatch") as HTMLElement).style.width).toBe("12px");
  });

  it("leaves out an absent scope and timer", () => {
    const { container } = render(<StateWord state="idle" word="Ready" />);
    const node = root(container);
    expect(node.querySelector(".vex-state-word__scope")).toBeNull();
    expect(node.querySelector(".vex-state-word__timer")).toBeNull();
  });

  it("is not a live region unless asked, and then a polite one", () => {
    const { container, rerender } = render(<StateWord state="idle" word="Ready" />);
    expect(root(container).hasAttribute("aria-live")).toBe(false);
    rerender(<StateWord state="thinking" word="Thinking" live />);
    expect(root(container).getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText("Thinking")).toBeTruthy();
  });

  it("forwards attributes to the root", () => {
    const { container } = render(<StateWord state="sleeping" word="Sleeping" data-vex-area="probe" />);
    expect(root(container).getAttribute("data-vex-area")).toBe("probe");
  });
});
