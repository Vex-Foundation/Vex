/**
 * UpdateLayer (updater redesign Part A). Verifies the defensive no-op when
 * the updater bridge is absent, that the bottom-right `UpdateToast` renders
 * for an `available` status, that "Later" snoozes ONLY the current version
 * while a NEWER version pushed over `onStatus` still surfaces (item 2 —
 * snooze must not suppress discovery of a newer release), that "Try again"
 * on `blockedByOperation` re-invokes the correct action per `blockedAction`,
 * and the error-toast dismiss/re-surface behavior.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";
import type { UpdateStatus } from "@shared/schemas/updater.js";

// Isolate from the icon layer (toast glyphs render nothing) —
// same convention as the appShell modal tests.
vi.mock("../../../components/icons/VexIcon.js", () => ({
  VexIcon: () => null,
}));

const { UpdateLayer } = await import("../UpdateLayer.js");

interface UpdaterBridgeStub {
  readonly getStatus: ReturnType<typeof vi.fn>;
  readonly onStatus: ReturnType<typeof vi.fn>;
  readonly checkNow: ReturnType<typeof vi.fn>;
  readonly startUpdateNow: ReturnType<typeof vi.fn>;
  readonly cancelDownload: ReturnType<typeof vi.fn>;
  readonly restartAndInstallNow: ReturnType<typeof vi.fn>;
  readonly openReleaseNotes: ReturnType<typeof vi.fn>;
}

/** Captures the callback passed to `onStatus` so tests can push new statuses. */
function stubUpdater(initial: UpdateStatus): {
  readonly bridge: UpdaterBridgeStub;
  push: (status: UpdateStatus) => void;
} {
  let pushStatus: ((status: UpdateStatus) => void) | null = null;
  const bridge: UpdaterBridgeStub = {
    getStatus: vi.fn().mockResolvedValue({ ok: true, data: initial }),
    onStatus: vi.fn((cb: (status: UpdateStatus) => void) => {
      pushStatus = cb;
      return () => {};
    }),
    checkNow: vi.fn().mockResolvedValue({ ok: true, data: initial }),
    startUpdateNow: vi
      .fn()
      .mockResolvedValue({ ok: true, data: { started: true } }),
    cancelDownload: vi
      .fn()
      .mockResolvedValue({ ok: true, data: { cancelled: true } }),
    restartAndInstallNow: vi
      .fn()
      .mockResolvedValue({ ok: true, data: { restarting: true } }),
    openReleaseNotes: vi
      .fn()
      .mockResolvedValue({ ok: true, data: { opened: true } }),
  };
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { updater: bridge },
  });
  return {
    bridge,
    push: (status: UpdateStatus) => {
      pushStatus?.(status);
    },
  };
}

function withClient(children: ReactNode): ReactNode {
  return createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    children,
  );
}

afterEach(() => {
  // @ts-expect-error — test cleanup
  delete window.vex;
});

describe("UpdateLayer", () => {
  it("renders nothing when the updater bridge is absent", () => {
    const { container } = render(<UpdateLayer />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the toast when an update is available", async () => {
    stubUpdater({
      kind: "available",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      severity: "normal",
    });
    render(withClient(<UpdateLayer />));
    expect(await screen.findByText("Vex 1.1.0 available")).toBeTruthy();
  });

  it("Later snoozes the current version, but a NEWER version pushed over onStatus still surfaces", async () => {
    const { push } = stubUpdater({
      kind: "available",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      severity: "normal",
    });
    render(withClient(<UpdateLayer />));
    await screen.findByText("Vex 1.1.0 available");

    fireEvent.click(screen.getByText("Later"));
    await waitFor(() =>
      expect(screen.queryByText("Vex 1.1.0 available")).toBeNull(),
    );

    // Same version re-pushed (e.g. a redundant ambient re-check) stays snoozed.
    push({
      kind: "available",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      severity: "normal",
    });
    await waitFor(() =>
      expect(screen.queryByText("Vex 1.1.0 available")).toBeNull(),
    );

    // A NEWER version must still surface despite the 1.1.0 snooze.
    push({
      kind: "available",
      currentVersion: "1.0.0",
      latestVersion: "1.2.0",
      severity: "normal",
    });
    expect(await screen.findByText("Vex 1.2.0 available")).toBeTruthy();
  });

  it('Try again re-invokes startUpdateNow when blockedAction is "download"', async () => {
    const { bridge } = stubUpdater({
      kind: "blockedByOperation",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      reason: "A database migration is still running.",
      blockedAction: "download",
      severity: "normal",
      wasDownloaded: false,
    });
    render(withClient(<UpdateLayer />));
    fireEvent.click(await screen.findByText("Try again"));
    await waitFor(() =>
      expect(bridge.startUpdateNow).toHaveBeenCalledTimes(1),
    );
    expect(bridge.restartAndInstallNow).not.toHaveBeenCalled();
  });

  it('Try again re-invokes restartAndInstallNow when blockedAction is "install"', async () => {
    const { bridge } = stubUpdater({
      kind: "blockedByOperation",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      reason: "A wallet operation is still in progress.",
      blockedAction: "install",
      severity: "normal",
      wasDownloaded: true,
    });
    render(withClient(<UpdateLayer />));
    fireEvent.click(await screen.findByText("Try again"));
    await waitFor(() =>
      expect(bridge.restartAndInstallNow).toHaveBeenCalledTimes(1),
    );
    expect(bridge.startUpdateNow).not.toHaveBeenCalled();
  });

  it("error: Try again calls checkNow", async () => {
    const { bridge } = stubUpdater({
      kind: "error",
      currentVersion: "1.0.0",
      message: "Update failed. Check your connection and try again.",
      retryable: true,
    });
    render(withClient(<UpdateLayer />));
    fireEvent.click(await screen.findByText("Try again"));
    await waitFor(() => expect(bridge.checkNow).toHaveBeenCalledTimes(1));
  });

  it("dismissing the error toast hides it; a fresh error (after leaving the error state) reappears", async () => {
    const { push } = stubUpdater({
      kind: "error",
      currentVersion: "1.0.0",
      message: "Update failed. Check your connection and try again.",
      retryable: true,
    });
    render(withClient(<UpdateLayer />));
    await screen.findByLabelText("Dismiss update notification");
    fireEvent.click(screen.getByLabelText("Dismiss update notification"));
    await waitFor(() =>
      expect(screen.queryByText("Update failed")).toBeNull(),
    );

    // Transition away from `error` and back — a fresh occurrence must reappear
    // even though the redacted message text is identical every time. The two
    // pushes are separated by a real `waitFor` flush (not just two
    // back-to-back synchronous calls) so React commits the intermediate
    // `checking` state before the second push arrives — matching how two
    // distinct main-process IPC events actually land as separate renderer
    // ticks, not a single batched update.
    push({ kind: "checking", currentVersion: "1.0.0" });
    await waitFor(() =>
      expect(screen.queryByLabelText("Dismiss update notification")).toBeNull(),
    );
    push({
      kind: "error",
      currentVersion: "1.0.0",
      message: "Update failed. Check your connection and try again.",
      retryable: true,
    });
    expect(
      await screen.findByLabelText("Dismiss update notification"),
    ).toBeTruthy();
  });
});
