/**
 * UpdateCard: the updater's one surface (docs/design/R3-MINIMAL.md sections 4
 * and 12), replacing the sticky toast. What this pins:
 *
 *  - the per-state copy and action row reach the right handler;
 *  - a progress tick moves the bar and the percent and does not speak again,
 *    a state change speaks once, severity routed as the stack's announcer did;
 *  - Escape keeps its per-state meaning (snooze, dismiss the error, nothing);
 *  - a critical update has no Later, a running download no way out but Cancel,
 *    a failure a visible Dismiss;
 *  - the card stands in the sidebar's slot, and floats where there is none;
 *  - nothing is raised on the notification model any more.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { notifications } from "../../../lib/notifications/index.js";
import { UpdateCard, type UpdateCardHandlers } from "../UpdateCard.js";
import { setUpdateCardSlot } from "../update-card-slot.js";
import type { ToastableUpdateStatus } from "../update-toast-model.js";

function makeHandlers(): UpdateCardHandlers {
  return {
    onLater: vi.fn(),
    onUpdateNow: vi.fn(),
    onCancel: vi.fn(),
    onRestart: vi.fn(),
    onTryAgain: vi.fn(),
    onReleaseNotes: vi.fn(),
    onDismissError: vi.fn(),
  };
}

function renderCard(status: ToastableUpdateStatus, busy = false) {
  const handlers = makeHandlers();
  const view = render(<UpdateCard status={status} busy={busy} handlers={handlers} />);
  return { handlers, view };
}

const AVAILABLE = {
  kind: "available",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  severity: "normal",
} as ToastableUpdateStatus;

const CRITICAL = { ...AVAILABLE, severity: "critical" } as ToastableUpdateStatus;

const DOWNLOADING = {
  kind: "downloading",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  percent: 40,
} as ToastableUpdateStatus;

const DOWNLOADED = {
  kind: "downloaded",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
} as ToastableUpdateStatus;

const BLOCKED = {
  kind: "blockedByOperation",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  reason: "A mission is still running. Finish or stop it, then restart.",
  blockedAction: "install",
  severity: "normal",
  wasDownloaded: true,
} as ToastableUpdateStatus;

const ERROR = {
  kind: "error",
  currentVersion: "1.0.0",
  message: "Update failed. Check your connection and try again.",
  retryable: true,
} as ToastableUpdateStatus;

afterEach(() => {
  cleanup();
  setUpdateCardSlot(null);
  notifications.reset();
});

/** The words the live regions currently hold. */
function spoken(): string {
  return [...document.querySelectorAll("[data-vex-live-region] > [role]")]
    .map((node) => node.textContent ?? "")
    .join("|");
}

describe("UpdateCard", () => {
  it("available names the version, says the sentence and routes every key to its handler", () => {
    const { handlers } = renderCard(AVAILABLE);
    expect(screen.getByText("Vex 1.1.0 available")).toBeTruthy();
    expect(
      screen.getByText("Downloads the update. You choose when to restart."),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Release notes"));
    expect(handlers.onReleaseNotes).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Later"));
    expect(handlers.onLater).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Update now"));
    expect(handlers.onUpdateNow).toHaveBeenCalledTimes(1);
  });

  it("draws Release notes as the link at the right and the other actions as keys", () => {
    renderCard(AVAILABLE);
    const link = screen.getByText("Release notes");
    expect(link.className).toContain("vex-upd__link");
    expect(screen.getByText("Later").getAttribute("data-vex-button")).toBe("quiet");
    expect(screen.getByText("Update now").getAttribute("data-vex-button")).toBe("primary");
    // The link is last in the row, after the keys.
    const row = link.parentElement;
    expect(row?.lastElementChild).toBe(link);
  });

  it("downloaded and blocked say their own words", () => {
    const first = renderCard(DOWNLOADED);
    expect(screen.getByText("Ready to install")).toBeTruthy();
    expect(screen.getByText("Vex 1.1.0 is ready. Restart to finish installing.")).toBeTruthy();
    fireEvent.click(screen.getByText("Restart & install"));
    expect(first.handlers.onRestart).toHaveBeenCalledTimes(1);
    cleanup();

    const second = renderCard(BLOCKED);
    expect(screen.getByText("Install blocked")).toBeTruthy();
    expect(
      screen.getByText("A mission is still running. Finish or stop it, then restart."),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Try again"));
    expect(second.handlers.onTryAgain).toHaveBeenCalledTimes(1);
  });

  it("downloading shows the quiet bar and the percent, and Cancel", () => {
    const { handlers } = renderCard(DOWNLOADING);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    expect(bar.querySelector("i")?.getAttribute("style")).toContain("width: 40%");
    expect(screen.getByText("40%")).toBeTruthy();
    fireEvent.click(screen.getByText("Cancel"));
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });

  it("busy disables the mutating key so a second click cannot reach the handler", () => {
    const { handlers } = renderCard(DOWNLOADING, true);
    const cancel = screen.getByText("Cancel") as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    fireEvent.click(cancel);
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });

  it("a failure offers Open download page, Try again and a visible Dismiss", () => {
    const { handlers } = renderCard(ERROR);
    expect(screen.getByText("Update failed")).toBeTruthy();
    fireEvent.click(screen.getByText("Open download page"));
    expect(handlers.onReleaseNotes).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Try again"));
    expect(handlers.onTryAgain).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Dismiss"));
    expect(handlers.onDismissError).toHaveBeenCalledTimes(1);
  });

  it("takes the 1.5px ink frame for a critical update and a failure only", () => {
    const frame = (): string | null =>
      document.querySelector('[data-vex-area="update-card"]')?.getAttribute("data-heavy") ?? null;
    renderCard(AVAILABLE);
    expect(frame()).toBeNull();
    cleanup();
    renderCard(CRITICAL);
    expect(frame()).toBe("");
    cleanup();
    renderCard(ERROR);
    expect(frame()).toBe("");
    cleanup();
    renderCard(BLOCKED);
    expect(frame()).toBeNull();
  });
});

describe("what leaving means", () => {
  it("Escape snoozes an ordinary available update and a downloaded one", () => {
    const first = renderCard(AVAILABLE);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(first.handlers.onLater).toHaveBeenCalledTimes(1);
    cleanup();
    const second = renderCard(DOWNLOADED);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(second.handlers.onLater).toHaveBeenCalledTimes(1);
  });

  it("Escape dismisses a failure", () => {
    const { handlers } = renderCard(ERROR);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(handlers.onDismissError).toHaveBeenCalledTimes(1);
  });

  it("a critical update has no Later and Escape does nothing", () => {
    const { handlers } = renderCard(CRITICAL);
    expect(screen.queryByText("Later")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(handlers.onLater).not.toHaveBeenCalled();
    expect(screen.getByText("Update now")).toBeTruthy();
  });

  it("a running download and a blocked step cannot be waved away", () => {
    const first = renderCard(DOWNLOADING);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(first.handlers.onLater).not.toHaveBeenCalled();
    expect(first.handlers.onCancel).not.toHaveBeenCalled();
    expect(screen.queryByText("Dismiss")).toBeNull();
    cleanup();
    const second = renderCard(BLOCKED);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(second.handlers.onLater).not.toHaveBeenCalled();
    expect(screen.queryByText("Dismiss")).toBeNull();
  });

  it("unmounting snoozes and dismisses nothing", () => {
    const { handlers, view } = renderCard(AVAILABLE);
    view.unmount();
    expect(handlers.onLater).not.toHaveBeenCalled();
    expect(handlers.onDismissError).not.toHaveBeenCalled();
    expect(document.querySelector('[data-vex-area="update-card"]')).toBeNull();
  });
});

describe("announcement", () => {
  it("speaks the title and the sentence once, politely for an ordinary update", () => {
    renderCard(AVAILABLE);
    expect(spoken()).toContain(
      "Info: Vex 1.1.0 available. Downloads the update. You choose when to restart.",
    );
  });

  it("speaks a critical update and a failure assertively", () => {
    renderCard(CRITICAL);
    expect(spoken()).toContain("Warning: Critical update - Vex 1.1.0.");
    cleanup();
    renderCard(ERROR);
    expect(spoken()).toContain("Error: Update failed. Update failed. Check your connection");
  });

  it("a progress tick moves the percent and does not speak again", () => {
    const handlers = makeHandlers();
    const view = render(<UpdateCard status={DOWNLOADING} busy={false} handlers={handlers} />);
    const before = spoken();
    expect(before).toContain("Downloading Vex 1.1.0");
    view.rerender(
      <UpdateCard
        status={{ ...DOWNLOADING, percent: 91 } as ToastableUpdateStatus}
        busy={false}
        handlers={handlers}
      />,
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("91");
    expect(screen.getByText("91%")).toBeTruthy();
    expect(spoken()).toBe(before);
    expect(spoken()).not.toContain("91");
  });

  it("a state change replaces the card's words and speaks the new state", () => {
    const handlers = makeHandlers();
    const view = render(<UpdateCard status={AVAILABLE} busy={false} handlers={handlers} />);
    view.rerender(<UpdateCard status={DOWNLOADING} busy={false} handlers={handlers} />);
    expect(screen.getByText("Downloading Vex 1.1.0")).toBeTruthy();
    expect(screen.queryByText("Vex 1.1.0 available")).toBeNull();
    expect(spoken()).toContain("Downloading Vex 1.1.0");
    // Replacing the state is not the user snoozing.
    expect(handlers.onLater).not.toHaveBeenCalled();
  });
});

describe("where the card stands", () => {
  it("portals into the sidebar's slot when one is mounted", () => {
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    setUpdateCardSlot(slot);
    renderCard(AVAILABLE);
    const card = slot.querySelector('[data-vex-area="update-card"]');
    expect(card).not.toBeNull();
    expect(card?.hasAttribute("data-floating")).toBe(false);
    slot.remove();
  });

  it("floats over the window where no sidebar offers a slot, and moves in when one appears", () => {
    renderCard(AVAILABLE);
    const floating = document.querySelector('[data-vex-area="update-card"]');
    expect(floating?.parentElement).toBe(document.body);
    expect(floating?.hasAttribute("data-floating")).toBe(true);

    // The shell mounting under a pre-shell prompt gives the card its place.
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    act(() => {
      setUpdateCardSlot(slot);
    });
    const placed = slot.querySelector('[data-vex-area="update-card"]');
    expect(placed).not.toBeNull();
    expect(placed?.hasAttribute("data-floating")).toBe(false);
    expect(document.querySelectorAll('[data-vex-area="update-card"]')).toHaveLength(1);
    slot.remove();
  });

  it("raises nothing on the notification model", () => {
    renderCard(AVAILABLE);
    expect(notifications.getSnapshot().items).toHaveLength(0);
  });
});
