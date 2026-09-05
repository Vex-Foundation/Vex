/**
 * The notification center: the flank stays empty when idle, the panel lists
 * what is retained, dismissal is per row, the retention cap REPORTS what it
 * evicted, a detached action renders inert with its reason, and the anchored
 * panel keeps the keyboard contract its two flank neighbours already have
 * (Escape closes, focus returns to the trigger).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NotificationCenter } from "../NotificationCenter.js";
import { HISTORY_CAP, notifications } from "../../../lib/notifications/index.js";
import type { NotificationInput } from "../../../lib/notifications/types.js";

function input(overrides: Partial<NotificationInput> = {}): NotificationInput {
  return {
    severity: "info",
    scope: { kind: "global" },
    source: "studio.watcher",
    message: "hello",
    ...overrides,
  };
}

/** The trigger's accessible name contains "notification", and so does every
 * row's dismiss label - so the badge is addressed by its area attribute. */
function badge(): HTMLButtonElement | null {
  return document.querySelector('[data-vex-area="notification-center-badge"]');
}

function openPanel(): void {
  fireEvent.click(badge() as HTMLButtonElement);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  act(() => {
    notifications.reset();
  });
  vi.useRealTimers();
});

describe("NotificationCenter", () => {
  it("renders nothing while there is nothing to say", () => {
    const { container } = render(<NotificationCenter />);
    expect(container.innerHTML).toBe("");
  });

  it("lists what is retained, including a toast that already purged", () => {
    render(<NotificationCenter />);
    act(() => {
      notifications.notify(input({ message: "Watcher stopped", severity: "error" }));
      notifications.notify(input({ message: "Indexing finished" }));
    });
    act(() => vi.advanceTimersByTime(60_000));
    openPanel();

    const rows = document.querySelectorAll('[data-vex-area="notification-row"]');
    expect({
      badge: badge()?.textContent,
      rows: [...rows].map((row) => row.getAttribute("data-severity")),
      messages: [...rows].map((row) => row.textContent?.includes("Watcher stopped")),
    }).toEqual({
      badge: "NOTICES 2",
      rows: ["info", "error"],
      messages: [false, true],
    });
  });

  it("dismisses one row and closes when the list empties", () => {
    render(<NotificationCenter />);
    act(() => {
      notifications.notify(input({ message: "only" }));
    });
    openPanel();
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss notification: only" }),
    );

    expect({
      retained: notifications.getSnapshot().items.length,
      badge: badge(),
    }).toEqual({ retained: 0, badge: null });
  });

  it("states how many notifications the retention cap dropped", () => {
    render(<NotificationCenter />);
    act(() => {
      for (let index = 0; index < HISTORY_CAP + 2; index += 1) {
        notifications.notify(input({ message: `m${index}` }));
      }
    });
    openPanel();

    expect(
      document.querySelector('[data-vex-area="notification-center-dropped"]')
        ?.textContent,
    ).toBe("2 older notifications dropped by the retention cap");
  });

  it("renders a detached action inert and says why", () => {
    render(<NotificationCenter />);
    let ran = 0;
    act(() => {
      const handle = notifications.notify(
        input({
          severity: "error",
          message: "Create failed",
          actions: [
            { id: "retry", label: "Retry", rank: "primary", run: () => (ran += 1) },
          ],
        }),
      );
      handle.disposeActions("the dialog was closed");
    });
    openPanel();
    const action = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(action);

    expect({
      disabled: (action as HTMLButtonElement).disabled,
      ran,
      reason: document
        .querySelector('[data-vex-area="notification-row"]')
        ?.textContent?.includes("No longer available - the dialog was closed"),
    }).toEqual({ disabled: true, ran: 0, reason: true });
  });

  it("closes on Escape and restores focus to the trigger", () => {
    render(<NotificationCenter />);
    act(() => {
      notifications.notify(input({ message: "focus me" }));
    });
    const trigger = badge() as HTMLButtonElement;
    fireEvent.click(trigger);
    const panel = screen.getByRole("dialog", { name: "Notifications" });
    fireEvent.keyDown(panel, { key: "Escape" });

    expect({
      panel: screen.queryByRole("dialog", { name: "Notifications" }),
      focused: document.activeElement === trigger,
    }).toEqual({ panel: null, focused: true });
  });
});
