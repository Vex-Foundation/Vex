/**
 * UpdateToastSurface as the notification model's first sticky client.
 *
 * What this proves, and each of these was either a defect class in the retired
 * sticky slot or a property the migration had to preserve:
 *
 *  - the per-state action row reaches the right handler through the model's
 *    action contract;
 *  - a progress tick updates ONE notification in place rather than raising a
 *    new one (the retired slot re-set its entry on every tick);
 *  - a state change replaces it, and the model holds exactly one update
 *    notification at any time;
 *  - Escape keeps its per-state snooze / dismiss / do-nothing semantics;
 *  - the toast the user CAN dismiss carries the state's escape meaning, and
 *    the one they cannot has no dismiss control AND is refused by the model;
 *  - unmount closes it without snoozing anything.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToastHost } from "../../../components/ui/toast-host.js";
import { notifications } from "../../../lib/notifications/index.js";
import {
  UPDATE_NOTIFICATION_ID,
  UpdateToastSurface,
  type UpdateToastHandlers,
} from "../UpdateToastSurface.js";
import type { ToastableUpdateStatus } from "../update-toast-model.js";

function makeHandlers(): UpdateToastHandlers {
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

function renderSurface(status: ToastableUpdateStatus, busy = false) {
  const handlers = makeHandlers();
  const view = render(
    <>
      <UpdateToastSurface status={status} busy={busy} handlers={handlers} />
      <ToastHost />
    </>,
  );
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

const ERROR = {
  kind: "error",
  currentVersion: "1.0.0",
  message: "Update failed. Check your connection and try again.",
  retryable: true,
} as ToastableUpdateStatus;

afterEach(() => {
  cleanup();
  notifications.reset();
});

function updateItems() {
  return notifications
    .getSnapshot()
    .items.filter((item) => item.id === UPDATE_NOTIFICATION_ID);
}

describe("UpdateToastSurface on the notification model", () => {
  it("available renders its title, body and action row, and each click reaches its handler", () => {
    const { handlers } = renderSurface(AVAILABLE);
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

  it("raises exactly ONE notification and keeps it sticky rather than letting it purge", () => {
    renderSurface(AVAILABLE);
    const items = updateItems();
    expect(items).toHaveLength(1);
    expect(items[0]?.sticky).toBe(true);
    expect(items[0]?.severity).toBe("info");
    expect(items[0]?.source).toBe("updater");
  });

  it("a progress tick updates the SAME notification in place and never re-announces the sentence", () => {
    const handlers = makeHandlers();
    const view = render(
      <>
        <UpdateToastSurface status={DOWNLOADING} busy={false} handlers={handlers} />
        <ToastHost />
      </>,
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");
    const before = updateItems()[0];
    const announcedBefore = before?.message;

    view.rerender(
      <>
        <UpdateToastSurface
          status={{ ...DOWNLOADING, percent: 91 } as ToastableUpdateStatus}
          busy={false}
          handlers={handlers}
        />
        <ToastHost />
      </>,
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("91");
    const after = updateItems();
    expect(after).toHaveLength(1);
    // Same createdAt proves it is the same notification, not a replacement.
    expect(after[0]?.createdAt).toBe(before?.createdAt);
    expect(after[0]?.message).toBe(announcedBefore);
  });

  it("a state change replaces the notification instead of stacking a second one", () => {
    const handlers = makeHandlers();
    const view = render(
      <>
        <UpdateToastSurface status={AVAILABLE} busy={false} handlers={handlers} />
        <ToastHost />
      </>,
    );
    view.rerender(
      <>
        <UpdateToastSurface status={DOWNLOADING} busy={false} handlers={handlers} />
        <ToastHost />
      </>,
    );
    expect(updateItems()).toHaveLength(1);
    expect(screen.getByText("Downloading Vex 1.1.0")).toBeTruthy();
    expect(screen.queryByText("Vex 1.1.0 available")).toBeNull();
    // Replacing must not be read as the user snoozing.
    expect(handlers.onLater).not.toHaveBeenCalled();
  });

  it("busy disables the mutating action so a second click cannot reach the handler", () => {
    const { handlers } = renderSurface(DOWNLOADING, true);
    const cancel = screen.getByText("Cancel") as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    fireEvent.click(cancel);
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });

  it("dismissing a snoozable toast IS the snooze; Escape means the same thing", () => {
    const { handlers } = renderSurface(AVAILABLE);
    fireEvent.click(
      screen.getByLabelText("Dismiss notification: Vex 1.1.0 available"),
    );
    expect(handlers.onLater).toHaveBeenCalledTimes(1);

    cleanup();
    notifications.reset();
    const second = renderSurface(AVAILABLE);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(second.handlers.onLater).toHaveBeenCalledTimes(1);
  });

  it("dismissing the error toast dismisses the error, by click or by Escape", () => {
    const { handlers } = renderSurface(ERROR);
    expect(updateItems()[0]?.severity).toBe("error");
    fireEvent.click(screen.getByLabelText("Dismiss notification: Update failed"));
    expect(handlers.onDismissError).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(handlers.onDismissError).toHaveBeenCalledTimes(2);
  });

  it("a critical update offers no dismiss control AND the model refuses a user close", () => {
    const { handlers } = renderSurface(CRITICAL);
    expect(screen.queryByText("Later")).toBeNull();
    expect(
      screen.queryByLabelText(/^Dismiss notification/),
    ).toBeNull();
    // Not merely hidden: asking the model directly is refused too.
    notifications.close(UPDATE_NOTIFICATION_ID, "user");
    expect(updateItems()).toHaveLength(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(handlers.onLater).not.toHaveBeenCalled();
    // A critical update announces assertively, which is what the retired
    // `role="alert"` did.
    expect(updateItems()[0]?.severity).toBe("warning");
  });

  it("a running download cannot be dismissed away from its Cancel button", () => {
    renderSurface(DOWNLOADING);
    expect(screen.queryByLabelText(/^Dismiss notification/)).toBeNull();
    notifications.close(UPDATE_NOTIFICATION_ID, "user");
    expect(updateItems()).toHaveLength(1);
  });

  it("unmount closes the notification without snoozing anything", () => {
    const { handlers, view } = renderSurface(AVAILABLE);
    view.unmount();
    expect(updateItems()).toHaveLength(0);
    expect(handlers.onLater).not.toHaveBeenCalled();
    expect(handlers.onDismissError).not.toHaveBeenCalled();
  });

  it("an ordinary showToast message coexists with the update toast in one stack", async () => {
    const { showToast } = await import("../../../lib/toast.js");
    renderSurface(AVAILABLE);
    showToast("Session exported.");
    expect(await screen.findByText("Session exported.")).toBeTruthy();
    expect(screen.getByText("Update now")).toBeTruthy();
  });
});
