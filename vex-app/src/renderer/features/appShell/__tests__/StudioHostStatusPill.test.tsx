/**
 * The host status pill and the card behind it.
 *
 * The audit's section 6 recorded that no renderer seam could drive the
 * unavailable causes, so nine of the ten had never been seen by anybody. The
 * pill is pure - it takes a resolved view - so this suite walks
 * `studioHostUnavailableCauseSchema.options` itself (the same reconciliation
 * discipline `studio-host-cause-copy.test.ts` uses) and renders the card for
 * EVERY cause the wire can carry, asserting the three things rule 08 asks of an
 * error surface: what is not available, why, and the next step.
 *
 * The keyboard cases are the other half. The card is a disclosure, not a
 * dialog: Enter and Space open it, it traps nothing, Escape closes it and
 * returns focus to the pill.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  studioHostUnavailableCauseSchema,
  STUDIO_MAX_CONNECTIONS_WIRE,
  type StudioHostStatus,
} from "@shared/schemas/studio.js";
import {
  StudioHostStatusPill,
  studioHostStatusView,
  STUDIO_HOST_VIEW_LOADING,
  STUDIO_HOST_VIEW_UNKNOWN,
  type StudioHostStatusView,
} from "../StudioHostStatusWord.js";
import {
  STUDIO_HOST_CARD_LABEL,
  STUDIO_HOST_CAUSE_NEXT_STEPS,
  STUDIO_HOST_CAUSE_SENTENCES,
  STUDIO_HOST_RECHECK_LABEL,
  STUDIO_HOST_UNLOCK_LABEL,
  studioHostPillLabel,
} from "../studio/studio-copy.js";
import { makeHostStatus } from "../studio/__tests__/studio-fixtures.js";

function mount(
  view: StudioHostStatusView,
  handlers: { onUnlock?: () => void; onRecheck?: () => void } = {},
): { pill: HTMLElement } {
  render(
    <StudioHostStatusPill
      view={view}
      onUnlock={handlers.onUnlock ?? (() => undefined)}
      onRecheck={handlers.onRecheck ?? (() => undefined)}
    />,
  );
  // Named by the WORD first: an aria-label replaces the element's text, so the
  // pill's name has to carry the state a sighted user reads on it (WCAG 2.5.3).
  return {
    pill: screen.getByRole("button", { name: studioHostPillLabel(view.word) }),
  };
}

/** Open by press, which is the path a keyboard and a pointer user share. */
function openCard(pill: HTMLElement): HTMLElement {
  fireEvent.click(pill);
  return screen.getByRole("group", { name: STUDIO_HOST_CARD_LABEL });
}

describe("every wire cause has a card", () => {
  it.each(studioHostUnavailableCauseSchema.options)(
    "%s says what is not available, why, and the next step",
    (cause) => {
      const status: StudioHostStatus = makeHostStatus({
        state: "unavailable",
        cause,
      });
      const { pill } = mount(studioHostStatusView(status));
      // The word alone is what the audit found on screen; the card is the rest.
      expect(pill.textContent).toContain("Unavailable");
      const card = openCard(pill);

      // 1. what is not available
      expect(card.textContent).toContain("Vex Studio is not serving calls.");
      // 2. why - the ONE cause sentence, not a second wording of it
      expect(card.textContent).toContain(STUDIO_HOST_CAUSE_SENTENCES[cause]);

      // 3. the next step, exactly as the table declares it
      const step = STUDIO_HOST_CAUSE_NEXT_STEPS[cause];
      const instruction = within(card).queryByText(step.instruction ?? "");
      if (step.instruction === null) {
        expect(
          card.querySelector('[data-vex-host-next-step="instruction"]'),
        ).toBeNull();
      } else {
        expect(instruction).not.toBeNull();
      }
      if (step.button === null) {
        expect(
          card.querySelector('[data-vex-host-next-step="button"]'),
        ).toBeNull();
      } else {
        expect(
          within(card).getByRole("button", {
            name:
              step.button === "unlock"
                ? STUDIO_HOST_UNLOCK_LABEL
                : STUDIO_HOST_RECHECK_LABEL,
          }),
        ).not.toBeNull();
      }
    },
  );

  it("carries the cause on the pill so a screenshot pass can name it", () => {
    const { pill } = mount(
      studioHostStatusView(
        makeHostStatus({ state: "unavailable", cause: "front_unavailable" }),
      ),
    );
    expect(pill.getAttribute("data-vex-studio-host-cause")).toBe(
      "front_unavailable",
    );
  });
});

describe("the states that are not causes", () => {
  it("locked offers the unlock route, which is authority the renderer has", () => {
    const onUnlock = vi.fn();
    const { pill } = mount(
      studioHostStatusView(makeHostStatus({ state: "locked" })),
      { onUnlock },
    );
    const card = openCard(pill);
    expect(card.textContent).toContain("while Vex is locked");
    fireEvent.click(
      within(card).getByRole("button", { name: STUDIO_HOST_UNLOCK_LABEL }),
    );
    expect(onUnlock).toHaveBeenCalledTimes(1);
    // Acting closes the card and hands focus back, so the strip is not left
    // with an open card over a screen that just changed.
    expect(
      screen.queryByRole("group", { name: STUDIO_HOST_CARD_LABEL }),
    ).toBeNull();
    expect(document.activeElement).toBe(pill);
  });

  it("running reports its connection figure and offers nothing to fix", () => {
    const { pill } = mount(
      studioHostStatusView(makeHostStatus({ connectionCount: 2 })),
    );
    const card = openCard(pill);
    expect(card.textContent).toContain(
      `2 of ${String(STUDIO_MAX_CONNECTIONS_WIRE)} connections in use.`,
    );
    expect(card.querySelector('[data-vex-host-next-step="button"]')).toBeNull();
  });

  it("a FAILED read offers the re-read, and a read in flight offers nothing", () => {
    const onRecheck = vi.fn();
    const { pill } = mount(STUDIO_HOST_VIEW_UNKNOWN, { onRecheck });
    fireEvent.click(
      within(openCard(pill)).getByRole("button", {
        name: STUDIO_HOST_RECHECK_LABEL,
      }),
    );
    expect(onRecheck).toHaveBeenCalledTimes(1);

    render(
      <StudioHostStatusPill
        view={STUDIO_HOST_VIEW_LOADING}
        onUnlock={() => undefined}
        onRecheck={() => undefined}
      />,
    );
    const loading = screen.getByRole("button", {
      name: studioHostPillLabel(STUDIO_HOST_VIEW_LOADING.word),
    });
    expect(
      openCard(loading).querySelector('[data-vex-host-next-step="button"]'),
    ).toBeNull();
  });

  it("announces the state and its reason without the card being opened", () => {
    mount(studioHostStatusView(makeHostStatus({ state: "locked" })));
    const live = screen.getByRole("status");
    expect(live.textContent).toContain("Locked");
    expect(live.textContent).toContain("Vex is locked");
  });
});

describe("keyboard and focus", () => {
  it("opens on Enter and on Space, once per press", () => {
    const { pill } = mount(studioHostStatusView(makeHostStatus()));
    fireEvent.keyDown(pill, { key: "Enter" });
    expect(
      screen.getByRole("group", { name: STUDIO_HOST_CARD_LABEL }),
    ).not.toBeNull();
    expect(pill.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(pill, { key: "Enter" });
    expect(
      screen.queryByRole("group", { name: STUDIO_HOST_CARD_LABEL }),
    ).toBeNull();

    fireEvent.keyDown(pill, { key: " " });
    expect(
      screen.getByRole("group", { name: STUDIO_HOST_CARD_LABEL }),
    ).not.toBeNull();
  });

  it("Escape closes the card and returns focus to the pill", () => {
    const { pill } = mount(
      studioHostStatusView(makeHostStatus({ state: "locked" })),
    );
    const card = openCard(pill);
    const action = within(card).getByRole("button", {
      name: STUDIO_HOST_UNLOCK_LABEL,
    });
    // Nothing is trapped: the card's own control is reachable and focusable,
    // and it follows the pill in the DOM rather than stealing focus on open.
    expect(document.activeElement).not.toBe(action);
    action.focus();
    expect(document.activeElement).toBe(action);

    fireEvent.keyDown(action, { key: "Escape" });
    expect(
      screen.queryByRole("group", { name: STUDIO_HOST_CARD_LABEL }),
    ).toBeNull();
    expect(document.activeElement).toBe(pill);
  });

  it("does not open on an unrelated key", () => {
    const { pill } = mount(studioHostStatusView(makeHostStatus()));
    fireEvent.keyDown(pill, { key: "a" });
    expect(
      screen.queryByRole("group", { name: STUDIO_HOST_CARD_LABEL }),
    ).toBeNull();
  });
});
