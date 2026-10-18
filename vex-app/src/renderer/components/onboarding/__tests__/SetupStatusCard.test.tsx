/**
 * The first run's status stanza (`SetupStatusCard.tsx`): a calm tone is a card with the title and
 * the state word (a fill and a word), a failure is the ink callout, and the role follows the tone
 * because these cards are the only thing that reports a pre-shell branch.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SetupStatusCard } from "../SetupStatusCard.js";

afterEach(cleanup);

describe("SetupStatusCard", () => {
  it.each([
    ["ok", "Ready", "done", "status"],
    ["info", "Note", "idle", "status"],
    ["muted", "Waiting", "idle", "status"],
    ["warn", "Attention", "warning", "alert"],
  ] as const)("draws %s as a card with the word %s on the %s fill and a %s role", (tone, word, fill, role) => {
    const { container, getByRole, getByText } = render(
      <SetupStatusCard tone={tone} title="Title" detail="Detail line" />,
    );
    const card = getByRole(role);
    expect(card.className).toContain("vex-fr-card");
    expect(getByText("Title")).toBeTruthy();
    expect(getByText("Detail line")).toBeTruthy();
    expect(getByText(word)).toBeTruthy();
    expect(container.querySelector(`.vex-swatch[data-s="${fill}"]`)).not.toBeNull();
    expect(container.querySelector(".vex-callout")).toBeNull();
  });

  it("takes the word and the fill the screen names, as the Paused card does", () => {
    const { container, getByText } = render(
      <SetupStatusCard tone="warn" state="sleeping" word="Paused" title="Docker stopped" />,
    );
    expect(getByText("Paused")).toBeTruthy();
    expect(container.querySelector('.vex-swatch[data-s="sleeping"]')).not.toBeNull();
  });

  it("draws a failure as the ink callout with the ink cross, never a hue, and interrupts", () => {
    const { container, getByRole, getByText } = render(
      <SetupStatusCard tone="error" title="Compose up failed" detail="docker daemon stopped mid-run." />,
    );
    const alert = getByRole("alert");
    expect(alert.className).toContain("vex-callout");
    expect(alert.getAttribute("data-vex-callout")).toBe("error");
    expect(getByText("Compose up failed")).toBeTruthy();
    expect(getByText("docker daemon stopped mid-run.")).toBeTruthy();
    expect(container.querySelector('.vex-swatch[data-s="error"]')).not.toBeNull();
    expect(container.querySelector(".vex-fr-card")).toBeNull();
  });

  it("omits the detail line when there is none", () => {
    const { container } = render(<SetupStatusCard tone="ok" title="Docker is ready" />);
    expect(container.querySelector(".vex-fr-card__detail")).toBeNull();
  });
});
