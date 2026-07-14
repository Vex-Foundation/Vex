/**
 * UpdateToast (updater redesign Part A) — presentational bottom-right toast
 * that replaces the retired `UpdateBanner` + `UpdateModal`. Asserts each
 * `UpdateStatus.kind` renders the documented actions, severity="critical"
 * makes `available` sticky (no Later, role="alert"), and the dismiss/Escape
 * affordances fire the right callback.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { UpdateStatus } from "@shared/schemas/updater.js";
import { UpdateToast, type ToastableUpdateStatus } from "../UpdateToast.js";

vi.mock("@hugeicons/react", () => ({
  HugeiconsIcon: () => null,
}));

function renderToast(status: ToastableUpdateStatus) {
  const props = {
    status,
    busy: false,
    onLater: vi.fn(),
    onUpdateNow: vi.fn(),
    onCancel: vi.fn(),
    onRestart: vi.fn(),
    onTryAgain: vi.fn(),
    onReleaseNotes: vi.fn(),
    onDismissError: vi.fn(),
  };
  render(<UpdateToast {...props} />);
  return props;
}

const AVAILABLE: UpdateStatus = {
  kind: "available",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  severity: "normal",
};
const AVAILABLE_CRITICAL: UpdateStatus = {
  kind: "available",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  severity: "critical",
};
const DOWNLOADING: UpdateStatus = {
  kind: "downloading",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  percent: 40,
};
const DOWNLOADED: UpdateStatus = {
  kind: "downloaded",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
};
const BLOCKED_DOWNLOAD: UpdateStatus = {
  kind: "blockedByOperation",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  reason: "A database migration is still running.",
  blockedAction: "download",
  severity: "normal",
  wasDownloaded: false,
};
const BLOCKED_INSTALL: UpdateStatus = {
  kind: "blockedByOperation",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  reason: "A wallet operation is still in progress.",
  blockedAction: "install",
  severity: "normal",
  wasDownloaded: true,
};
const ERROR: UpdateStatus = {
  kind: "error",
  currentVersion: "1.0.0",
  message: "Update failed. Check your connection and try again.",
  retryable: true,
};

describe("UpdateToast — available", () => {
  it("renders Later, Update now, and Release notes; role=status", () => {
    renderToast(AVAILABLE as ToastableUpdateStatus);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(
      screen.getByText(
        "Downloads the update now. Restart whenever you're ready.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Later")).toBeTruthy();
    expect(screen.getByText("Update now")).toBeTruthy();
    const releaseNotes = screen.getByText("Release notes");
    expect(releaseNotes.className).toContain("mr-auto");
    expect(releaseNotes.className).toContain("px-0");
  });

  it("fires onUpdateNow / onLater / onReleaseNotes from their buttons", () => {
    const props = renderToast(AVAILABLE as ToastableUpdateStatus);
    fireEvent.click(screen.getByText("Update now"));
    expect(props.onUpdateNow).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Later"));
    expect(props.onLater).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Release notes"));
    expect(props.onReleaseNotes).toHaveBeenCalledTimes(1);
  });

  it("critical severity: no Later button, role=alert, stronger copy", () => {
    renderToast(AVAILABLE_CRITICAL as ToastableUpdateStatus);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Later")).toBeNull();
    expect(screen.getByText("Update now")).toBeTruthy();
    expect(screen.getByText(/Critical update/)).toBeTruthy();
  });

  it("Escape snoozes a non-critical available toast", () => {
    const props = renderToast(AVAILABLE as ToastableUpdateStatus);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onLater).toHaveBeenCalledTimes(1);
  });

  it("Escape does NOT snooze a critical available toast", () => {
    const props = renderToast(AVAILABLE_CRITICAL as ToastableUpdateStatus);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onLater).not.toHaveBeenCalled();
  });
});

describe("UpdateToast — downloading", () => {
  it("renders a progressbar at the right value and a Cancel button", () => {
    renderToast(DOWNLOADING as ToastableUpdateStatus);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "40",
    );
    expect(screen.getByText("Cancel")).toBeTruthy();
  });

  it("fires onCancel from the Cancel button", () => {
    const props = renderToast(DOWNLOADING as ToastableUpdateStatus);
    fireEvent.click(screen.getByText("Cancel"));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("UpdateToast — downloaded", () => {
  it("renders Later + Restart & install, no dismiss (X)", () => {
    renderToast(DOWNLOADED as ToastableUpdateStatus);
    expect(screen.getByText("Later")).toBeTruthy();
    expect(screen.getByText("Restart & install")).toBeTruthy();
    expect(
      screen.queryByLabelText("Dismiss update notification"),
    ).toBeNull();
  });

  it("fires onRestart from the Restart & install button", () => {
    const props = renderToast(DOWNLOADED as ToastableUpdateStatus);
    fireEvent.click(screen.getByText("Restart & install"));
    expect(props.onRestart).toHaveBeenCalledTimes(1);
  });

  it("Escape snoozes a downloaded toast", () => {
    const props = renderToast(DOWNLOADED as ToastableUpdateStatus);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onLater).toHaveBeenCalledTimes(1);
  });
});

describe("UpdateToast — blockedByOperation", () => {
  it("surfaces the reason and a Try again button (download-blocked)", () => {
    renderToast(BLOCKED_DOWNLOAD as ToastableUpdateStatus);
    expect(
      screen.getByText("A database migration is still running."),
    ).toBeTruthy();
    expect(screen.getByText("Try again")).toBeTruthy();
  });

  it("fires onTryAgain from the Try again button (install-blocked)", () => {
    const props = renderToast(BLOCKED_INSTALL as ToastableUpdateStatus);
    fireEvent.click(screen.getByText("Try again"));
    expect(props.onTryAgain).toHaveBeenCalledTimes(1);
  });

  it("Escape does nothing for a blocked toast (no dismiss affordance)", () => {
    const props = renderToast(BLOCKED_DOWNLOAD as ToastableUpdateStatus);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onLater).not.toHaveBeenCalled();
    expect(props.onDismissError).not.toHaveBeenCalled();
  });
});

describe("UpdateToast — error", () => {
  it("renders the message, Open download page, Try again, and a dismiss (X)", () => {
    renderToast(ERROR as ToastableUpdateStatus);
    expect(
      screen.getByText("Update failed. Check your connection and try again."),
    ).toBeTruthy();
    expect(screen.getByText("Open download page")).toBeTruthy();
    expect(screen.getByText("Try again")).toBeTruthy();
    expect(screen.getByLabelText("Dismiss update notification")).toBeTruthy();
  });

  it("fires onDismissError from the X button and from Escape", () => {
    const props = renderToast(ERROR as ToastableUpdateStatus);
    fireEvent.click(screen.getByLabelText("Dismiss update notification"));
    expect(props.onDismissError).toHaveBeenCalledTimes(1);
  });

  it("Escape dismisses the error toast", () => {
    const props = renderToast(ERROR as ToastableUpdateStatus);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onDismissError).toHaveBeenCalledTimes(1);
  });

  it("fires onTryAgain / onReleaseNotes from their buttons", () => {
    const props = renderToast(ERROR as ToastableUpdateStatus);
    fireEvent.click(screen.getByText("Try again"));
    expect(props.onTryAgain).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Open download page"));
    expect(props.onReleaseNotes).toHaveBeenCalledTimes(1);
  });
});
