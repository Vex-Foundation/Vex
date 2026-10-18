/**
 * SetupTour — smoke coverage for the diagnostic screen navigator
 * (decree D: `VITE_VEX_SETUP_TOUR=1`, build-time, dev only).
 *
 * Pins:
 *   - flag ABSENT → renders nothing (the production shape),
 *   - flag "1" → the bottom-left navigator lists every pre-shell view +
 *     appShell + "Reload boot" (the runtime screens only once main says it
 *     runs the native runtime: never in an e2e door run),
 *   - clicking a view key dismisses the boot gate (idempotent, dev-only)
 *     and flips `currentView` — renderer view-routing only.
 *
 * The flag is read at module scope, so each case stubs the env and
 * re-imports through a fresh module registry. The uiStore and React Query
 * are imported from the SAME fresh registry — a statically imported
 * instance would be a different store (or query context) than the one the
 * re-imported component uses.
 */

import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type UiStoreModule = typeof import("../../../stores/uiStore.js");
type SetupTourModule = typeof import("../SetupTour.js");

const runtime = vi.fn();

async function importFresh(flag: string): Promise<{
  SetupTour: SetupTourModule["SetupTour"];
  store: UiStoreModule["useUiStore"];
  wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  client: InstanceType<typeof import("@tanstack/react-query").QueryClient>;
}> {
  vi.resetModules();
  vi.stubEnv("VITE_VEX_SETUP_TOUR", flag);
  const [{ SetupTour }, { useUiStore }, { QueryClient, QueryClientProvider }] = await Promise.all([
    import("../SetupTour.js"),
    import("../../../stores/uiStore.js"),
    import("@tanstack/react-query"),
  ]);
  useUiStore.setState({ currentView: "splash", setupGateActive: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { readonly children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client }, children);
  return { SetupTour, store: useUiStore, wrapper, client };
}

beforeEach(() => {
  window.localStorage.clear();
  runtime.mockReset().mockResolvedValue({ ok: true, data: { native: true } });
  Object.defineProperty(window, "vex", { configurable: true, value: { system: { runtime } } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  window.localStorage.clear();
  Reflect.deleteProperty(window, "vex");
});

describe("SetupTour", () => {
  it("renders nothing when VITE_VEX_SETUP_TOUR is not '1' (production shape)", async () => {
    const { SetupTour, wrapper } = await importFresh("");
    const { container } = render(<SetupTour />, { wrapper });
    expect(container.querySelector("[data-vex-setup-tour]")).toBeNull();
    // Not even the runtime mode is read.
    expect(runtime).not.toHaveBeenCalled();
  });

  it("docks the navigator with every tour view, in order, and Reload boot when enabled", async () => {
    const { SetupTour, wrapper } = await importFresh("1");
    const { container } = render(<SetupTour />, { wrapper });

    expect(screen.getByText("Setup tour")).not.toBeNull();
    await screen.findByRole("button", { name: "runtimeBootstrap" });
    const viewKeys = [...container.querySelectorAll("[data-vex-setup-tour] button:not([data-vex-tour-prologue])")]
      .map((button) => button.textContent)
      .filter((label) => label !== "Reload boot");
    expect(viewKeys).toEqual([
      "systemCheck",
      "runtimeMigration",
      "runtimeBootstrap",
      "migrations",
      "wizard",
      "unlock",
      "appShell",
    ]);
    expect(screen.getByRole("button", { name: "Reload boot" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Replay gate" })).not.toBeNull();
  });

  it("in an e2e door run leaves out the runtime screens: no runtime is started", async () => {
    runtime.mockResolvedValue({ ok: true, data: { native: false } });
    const { SetupTour, wrapper, client } = await importFresh("1");
    render(<SetupTour />, { wrapper });

    // The answer has landed (and rendered) before its effect is asserted.
    await waitFor(() => expect(client.getQueryData(["system", "runtime"])).toBeDefined());
    expect(screen.queryByRole("button", { name: "runtimeBootstrap" })).toBeNull();
    expect(screen.queryByRole("button", { name: "runtimeMigration" })).toBeNull();
    for (const view of ["systemCheck", "migrations", "wizard", "unlock", "appShell"]) {
      expect(screen.getByRole("button", { name: view })).not.toBeNull();
    }
  });

  it("lists only the other views until the runtime mode is known", async () => {
    runtime.mockReturnValue(new Promise(() => {}));
    const { SetupTour, wrapper } = await importFresh("1");
    render(<SetupTour />, { wrapper });
    expect(screen.getByRole("button", { name: "systemCheck" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "runtimeBootstrap" })).toBeNull();
  });

  it("a view key dismisses the boot gate and flips currentView (view-routing only)", async () => {
    const { SetupTour, store, wrapper } = await importFresh("1");
    render(<SetupTour />, { wrapper });

    expect(store.getState().setupGateActive).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "unlock" }));
    expect(store.getState().currentView).toBe("unlock");
    expect(store.getState().setupGateActive).toBe(false);
  });

  it("Replay gate re-arms the gate and bumps the replay nonce each click", async () => {
    const { SetupTour, store, wrapper } = await importFresh("1");
    render(<SetupTour />, { wrapper });

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

  it("does not persist the prologue version key - the preview stays repeatable", async () => {
    const { SetupTour, wrapper } = await importFresh("1");
    render(<SetupTour />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Replay gate" }));
    expect(window.localStorage.getItem("vex-prologue-version")).toBeNull();
  });
});
