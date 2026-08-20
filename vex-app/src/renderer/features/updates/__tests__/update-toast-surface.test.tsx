/**
 * UpdateToastSurface + ToastHost: the sticky update toast renders the
 * per-state actions through the host, action clicks reach the right
 * handler, Escape keeps its snooze/dismiss semantics, and the transient
 * showToast slot coexists with the sticky one.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToastHost } from "../../../components/ui/toast-host.js";
import { clearStickyToast, showToast } from "../../../lib/toast.js";
import {
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
  render(
    <>
      <UpdateToastSurface status={status} busy={busy} handlers={handlers} />
      <ToastHost />
    </>,
  );
  return handlers;
}

const AVAILABLE = {
  kind: "available",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  severity: "normal",
} as ToastableUpdateStatus;

const CRITICAL = {
  ...AVAILABLE,
  severity: "critical",
} as ToastableUpdateStatus;

afterEach(() => {
  cleanup();
  clearStickyToast();
});

describe("UpdateToastSurface through ToastHost", () => {
  it("available renders Later / Update now / Release notes and each click reaches its handler", () => {
    const handlers = renderSurface(AVAILABLE);
    expect(screen.getByRole("status")).toBeTruthy();
    fireEvent.click(screen.getByText("Update now"));
    expect(handlers.onUpdateNow).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Later"));
    expect(handlers.onLater).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Release notes"));
    expect(handlers.onReleaseNotes).toHaveBeenCalledTimes(1);
  });

  it("critical available drops Later, announces as role=alert, and Escape never snoozes it", () => {
    const handlers = renderSurface(CRITICAL);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Later")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(handlers.onLater).not.toHaveBeenCalled();
  });

  it("Escape snoozes a non-critical available toast", () => {
    const handlers = renderSurface(AVAILABLE);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(handlers.onLater).toHaveBeenCalledTimes(1);
  });

  it("downloading renders a live progressbar and Cancel; busy disables Cancel", () => {
    const downloading = {
      kind: "downloading",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      percent: 40,
    } as ToastableUpdateStatus;
    const handlers = renderSurface(downloading, true);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "40",
    );
    const cancel = screen.getByText("Cancel");
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(cancel);
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });

  it("downloaded offers Restart & install wired to onRestart", () => {
    const handlers = renderSurface({
      kind: "downloaded",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
    } as ToastableUpdateStatus);
    fireEvent.click(screen.getByText("Restart & install"));
    expect(handlers.onRestart).toHaveBeenCalledTimes(1);
  });

  it("error keeps the dismiss X accessible name and Escape dismisses; unmount clears the host", () => {
    const error = {
      kind: "error",
      currentVersion: "1.0.0",
      message: "Update failed. Check your connection and try again.",
      retryable: true,
    } as ToastableUpdateStatus;
    const handlers = makeHandlers();
    const view = render(
      <>
        <UpdateToastSurface status={error} busy={false} handlers={handlers} />
        <ToastHost />
      </>,
    );
    fireEvent.click(screen.getByLabelText("Dismiss update notification"));
    expect(handlers.onDismissError).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(handlers.onDismissError).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(screen.queryByText("Update failed")).toBeNull();
  });

  it("the transient showToast banner coexists with the sticky update toast", () => {
    renderSurface(AVAILABLE);
    act(() => {
      showToast("Session exported.");
    });
    expect(screen.getByText("Session exported.")).toBeTruthy();
    expect(screen.getByText("Update now")).toBeTruthy();
  });
});
