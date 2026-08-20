/**
 * SetupTour — smoke coverage for the diagnostic screen navigator
 * (decree D: `VITE_VEX_SETUP_TOUR=1`, build-time, dev only).
 *
 * Pins:
 *   - flag ABSENT → renders nothing (the production shape),
 *   - flag "1" → the bottom-left navigator lists every pre-shell view +
 *     appShell + "Reload boot",
 *   - clicking a view key dismisses the boot gate (idempotent, dev-only)
 *     and flips `currentView` — renderer view-routing ONLY, no IPC.
 *
 * The flag is read at module scope, so each case stubs the env and
 * re-imports through a fresh module registry. The uiStore is imported
 * from the SAME fresh registry — a statically imported instance would be
 * a different store than the one the re-imported component mutates.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

type UiStoreModule = typeof import("../../../stores/uiStore.js");
type SetupTourModule = typeof import("../SetupTour.js");

async function importFresh(
  flag: string,
): Promise<{ SetupTour: SetupTourModule["SetupTour"]; store: UiStoreModule["useUiStore"] }> {
  vi.resetModules();
  vi.stubEnv("VITE_VEX_SETUP_TOUR", flag);
  const [{ SetupTour }, { useUiStore }] = await Promise.all([
    import("../SetupTour.js"),
    import("../../../stores/uiStore.js"),
  ]);
  useUiStore.setState({ currentView: "splash", setupGateActive: true });
  return { SetupTour, store: useUiStore };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  window.localStorage.clear();
});

describe("SetupTour", () => {
  it("renders nothing when VITE_VEX_SETUP_TOUR is not '1' (production shape)", async () => {
    const { SetupTour } = await importFresh("");
    const { container } = render(<SetupTour />);
    expect(container.querySelector("[data-vex-setup-tour]")).toBeNull();
  });

  it("docks the navigator with every tour view and Reload boot when enabled", async () => {
    const { SetupTour } = await importFresh("1");
    render(<SetupTour />);

    expect(screen.getByText("Setup tour")).not.toBeNull();
    for (const view of [
      "systemCheck",
      "dockerBootstrap",
      "composeBootstrap",
      "migrations",
      "wizard",
      "unlock",
      "appShell",
    ]) {
      expect(screen.getByRole("button", { name: view })).not.toBeNull();
    }
    expect(screen.getByRole("button", { name: "Reload boot" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Replay gate" })).not.toBeNull();
  });

  it("a view key dismisses the boot gate and flips currentView (view-routing only)", async () => {
    const { SetupTour, store } = await importFresh("1");
    render(<SetupTour />);

    expect(store.getState().setupGateActive).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "unlock" }));
    expect(store.getState().currentView).toBe("unlock");
    expect(store.getState().setupGateActive).toBe(false);
  });

  it("Replay gate re-arms the gate and bumps the replay nonce each click", async () => {
    const { SetupTour, store } = await importFresh("1");
    render(<SetupTour />);

    // Start from a dismissed gate — the realistic state when the owner wants
    // to preview the cold open again mid-session.
    store.setState({ setupGateActive: false });
    const before = store.getState().prologueReplayNonce;

    fireEvent.click(screen.getByRole("button", { name: "Replay gate" }));
    expect(store.getState().setupGateActive).toBe(true);
    expect(store.getState().prologueReplayNonce).toBe(before + 1);

    // Repeatable: the nonce is the gate's remount key, so a second click
    // must produce a NEW value or the replay would silently no-op.
    fireEvent.click(screen.getByRole("button", { name: "Replay gate" }));
    expect(store.getState().prologueReplayNonce).toBe(before + 2);
  });

  it("does not persist the prologue version key — the preview stays repeatable", async () => {
    const { SetupTour } = await importFresh("1");
    render(<SetupTour />);
    fireEvent.click(screen.getByRole("button", { name: "Replay gate" }));
    expect(window.localStorage.getItem("vex-prologue-version")).toBeNull();
  });
});
