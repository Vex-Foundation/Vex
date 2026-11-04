/**
 * The first run's status row (`SetupStatusCard.tsx`, docs/design/H3-DESKTOP.md sections 2.2 and
 * 4.9): every tone is a row with the title and H3's status (a square and an ink word), a failure
 * the same row with the red square, and the role follows the tone because these rows are the only
 * thing that reports a pre-shell branch.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SetupStatusCard } from "../SetupStatusCard.js";

afterEach(cleanup);

describe("SetupStatusCard", () => {
  it.each([
    ["ok", "Ready", "done", "status"],
    ["info", "Note", "none", "status"],
    ["muted", "Waiting", "none", "status"],
    ["warn", "Attention", "ink", "alert"],
    ["error", "Failed", "failed", "alert"],
  ] as const)("draws %s as a row with the word %s beside the %s square and a %s role", (tone, word, square, role) => {
    const { container, getByRole, getByText } = render(
      <SetupStatusCard tone={tone} title="Title" detail="Detail line" />,
    );
    const card = getByRole(role);
    expect(card.className).toContain("vex-fr-card");
    expect(card.getAttribute("data-tone")).toBe(tone);
    expect(getByText("Title")).toBeTruthy();
    expect(getByText("Detail line")).toBeTruthy();
    expect(getByText(word)).toBeTruthy();
    expect(container.querySelector(`.vex-pre-sq[data-sq="${square}"]`)).not.toBeNull();
    // No R3 fill and no hatched callout: the square is the one mark.
    expect(container.querySelector(".vex-swatch")).toBeNull();
    expect(container.querySelector(".vex-callout")).toBeNull();
  });

  it("takes the word and the fill the screen names, as H3's square", () => {
    const { container, getByText } = render(
      <SetupStatusCard tone="muted" state="done" word="Up to date" title="Schema already up to date" />,
    );
    expect(getByText("Up to date")).toBeTruthy();
    expect(container.querySelector('.vex-pre-sq[data-sq="done"]')).not.toBeNull();
  });

  it("omits the detail line when there is none", () => {
    const { container } = render(<SetupStatusCard tone="ok" title="The local runtime is ready" />);
    expect(container.querySelector(".vex-fr-card__detail")).toBeNull();
  });
});
