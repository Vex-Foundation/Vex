/**
 * PasswordStrength: presentational only (the zxcvbn estimate is tested in
 * `useMasterPasswordStrength.test.ts`). Verifies the verdict words, the
 * "Checking…" override, feedback only while blocked, the four cells and the
 * verdict's fill.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PasswordStrength, strengthCells } from "../PasswordStrength.js";

afterEach(() => {
  cleanup();
});

function fillOf(container: HTMLElement): string | null {
  return (
    container.querySelector(".vex-state-word")?.getAttribute("data-s") ?? null
  );
}

describe("PasswordStrength", () => {
  it("renders the weak, fair, good and strong words", () => {
    for (const label of ["weak", "fair", "good", "strong"] as const) {
      const { getByText, unmount } = render(
        <PasswordStrength
          length={10}
          ready
          score={0}
          label={label}
          blocked={label === "weak" || label === "fair"}
        />,
      );
      expect(getByText(new RegExp(`^${label}$`, "i"))).toBeTruthy();
      unmount();
    }
  });

  it("keeps the rule line beside the verdict", () => {
    const { getByText } = render(
      <PasswordStrength length={0} ready score={0} label="weak" blocked />,
    );
    expect(getByText('10 characters minimum. Must score at least "Good".')).toBeTruthy();
  });

  it("shows 'Checking…' instead of the word while not ready and the field is non-empty", () => {
    const { getByText, queryByText, container } = render(
      <PasswordStrength length={5} ready={false} score={0} label="weak" blocked />,
    );
    expect(getByText(/Checking…/i)).toBeTruthy();
    expect(queryByText(/^weak$/i)).toBeNull();
    expect(fillOf(container)).toBe("listening");
  });

  it("does not show 'Checking…' when the field is empty, even if not ready", () => {
    const { queryByText, container } = render(
      <PasswordStrength length={0} ready={false} score={0} label="weak" blocked />,
    );
    expect(queryByText(/Checking…/i)).toBeNull();
    expect(fillOf(container)).toBe("idle");
  });

  it("paints a refused password with the target and an accepted one solid", () => {
    const refused = render(
      <PasswordStrength length={11} ready score={2} label="fair" blocked />,
    );
    expect(fillOf(refused.container)).toBe("warning");
    refused.unmount();
    const accepted = render(
      <PasswordStrength length={16} ready score={3} label="good" blocked={false} />,
    );
    expect(fillOf(accepted.container)).toBe("done");
  });

  it("shows the zxcvbn warning text when blocked", () => {
    const { getByText } = render(
      <PasswordStrength
        length={11}
        ready
        score={0}
        label="weak"
        blocked
        warning="This is a commonly used password."
        suggestions={["Add more words that are less common."]}
      />,
    );
    expect(getByText(/commonly used password/i)).toBeTruthy();
  });

  it("falls back to the first suggestion when there is no warning", () => {
    const { getByText } = render(
      <PasswordStrength
        length={11}
        ready
        score={1}
        label="weak"
        blocked
        warning={null}
        suggestions={["Add more words that are less common."]}
      />,
    );
    expect(getByText(/add more words/i)).toBeTruthy();
  });

  it("shows no feedback once the password meets the gate (blocked=false)", () => {
    const { queryByText } = render(
      <PasswordStrength
        length={32}
        ready
        score={4}
        label="strong"
        blocked={false}
        warning={null}
        suggestions={[]}
      />,
    );
    expect(queryByText(/add more words|commonly used/i)).toBeNull();
  });

  it("shows no feedback for an empty field even if blocked is true", () => {
    const { queryByText } = render(
      <PasswordStrength
        length={0}
        ready
        score={0}
        label="weak"
        blocked
        warning="should not show"
      />,
    );
    expect(queryByText(/should not show/i)).toBeNull();
  });

  it("reaches one cell per score point, one at least once anything is typed", () => {
    expect(strengthCells(0, 0)).toBe(0);
    expect(strengthCells(3, 0)).toBe(1);
    expect(strengthCells(12, 1)).toBe(1);
    expect(strengthCells(12, 2)).toBe(2);
    expect(strengthCells(12, 3)).toBe(3);
    expect(strengthCells(12, 4)).toBe(4);
    const { container } = render(
      <PasswordStrength length={14} ready score={3} label="good" blocked={false} />,
    );
    const cells = container.querySelectorAll(".vex-wz-meter > i");
    expect(cells).toHaveLength(4);
    expect(container.querySelectorAll(".vex-wz-meter > i[data-on]")).toHaveLength(3);
  });
});
