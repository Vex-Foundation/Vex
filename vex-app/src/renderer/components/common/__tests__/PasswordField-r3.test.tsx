/**
 * The password field and the input under it in the R3 grammar (the d3x
 * wizard step 1 render, docs/design/R3-MINIMAL.md section 1.5): a 42 high
 * field, and the reveal key as the word "Show" or "Hide" in the blue, square,
 * with the kit's focus outline. Its accessible names and its press are
 * unchanged.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Input } from "../../ui/input.js";
import { PasswordField } from "../PasswordField.js";

afterEach(() => {
  cleanup();
});

describe("Input", () => {
  it("is 42 high, the spec's field", () => {
    render(<Input aria-label="Name" />);
    const input = screen.getByRole("textbox", { name: "Name" });
    expect(input.className).toContain("h-[42px]");
    expect(input.className).not.toContain("h-11");
  });
});

describe("PasswordField", () => {
  it("reveals with a sentence case word in the blue, square, and hides again", () => {
    render(<PasswordField aria-label="Master password" />);
    const key = screen.getByRole("button", { name: "Show password" });
    expect(key.textContent).toBe("Show");
    expect(key.className).toContain("text-accent-primary");
    expect(key.className).not.toMatch(/rounded/);
    expect(key.className).not.toContain("vex-micro");
    fireEvent.click(key);
    const hide = screen.getByRole("button", { name: "Hide password" });
    expect(hide.textContent).toBe("Hide");
    expect(hide.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("Master password").getAttribute("type")).toBe("text");
  });

  it("is 42 high like every field", () => {
    render(<PasswordField aria-label="Master password" />);
    expect(screen.getByLabelText("Master password").className).toContain("h-[42px]");
  });
});
