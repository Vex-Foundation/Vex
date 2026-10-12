import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Counter } from "../counter.js";

describe("Counter", () => {
  it("sets the figure in parentheses, italic serif, as decoration", () => {
    const { container } = render(<Counter value="07" className="text-[112px]" />);
    const counter = container.querySelector("[data-vex-counter]");
    expect(counter?.textContent).toBe("(07)");
    expect(counter?.getAttribute("aria-hidden")).toBe("true");
    expect(counter?.className).toContain("font-serif");
    expect(counter?.className).toContain("italic");
    expect(counter?.className).toContain("text-[112px]");
    // Never hung out of its box, never bold.
    expect(counter?.className).toContain("[hanging-punctuation:none]");
    expect(counter?.className).toContain("font-normal");
  });

  it("lets a caller expose a counter that is the only place its number appears", () => {
    const { container } = render(<Counter value="12" aria-hidden={false} />);
    expect(container.querySelector("[data-vex-counter]")?.getAttribute("aria-hidden")).toBe("false");
  });
});
