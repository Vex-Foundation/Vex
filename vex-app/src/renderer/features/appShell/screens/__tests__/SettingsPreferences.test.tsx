/**
 * SettingsPreferences - the Appearance theme switcher, the composer
 * Enter-key row, and the notifications toggle on the Settings register.
 *
 * Pins:
 *   - clicking a theme cube writes the persisted preference AND stamps the
 *     resolved theme onto `documentElement[data-vex-theme]`,
 *   - cube selection follows the PREFERENCE, never the resolved theme
 *     ("system" stays pressed while the OS resolves the paint),
 *   - the Enter-key choice round-trips through the composer submission
 *     policy's public API,
 *   - the notifications row round-trips through the typed uiStore slot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { useUiStore } from "../../../../stores/uiStore.js";
import {
  getSubmitKeyBehavior,
  resetSubmitKeyBehaviorForTest,
} from "../../../../lib/composer-submission-policy.js";
import { SettingsPreferences } from "../SettingsScreen/SettingsPreferences.js";

// The Background row (SettingsBackdropRow, its own suite) reads the backdrop
// through TanStack Query on mount; the group therefore renders under a
// QueryClient with the bridge stubbed to "shipped artwork".
const shellBackdropReadMock = vi.fn();

function renderGroup(ui: ReactElement): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(async () => {
  window.localStorage.clear();
  await resetSubmitKeyBehaviorForTest();
  useUiStore.getState().setThemePreference("chronos");
  shellBackdropReadMock.mockReset();
  shellBackdropReadMock.mockResolvedValue({ ok: true, data: { backdrop: null } });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { shellBackdrop: { read: shellBackdropReadMock } },
  });
});

afterEach(() => {
  cleanup();
  useUiStore.getState().setThemePreference("chronos");
});

function cube(id: string): HTMLButtonElement {
  const el = document.querySelector(`[data-vex-theme-cube="${id}"]`);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`cube ${id} missing`);
  return el;
}

describe("SettingsPreferences", () => {
  it("a theme cube click persists the preference and stamps the resolved theme on the document root", () => {
    renderGroup(<SettingsPreferences />);
    fireEvent.click(cube("celeris"));
    expect(useUiStore.getState().themePreference).toBe("celeris");
    expect(document.documentElement.dataset["vexTheme"]).toBe("celeris");
    fireEvent.click(cube("chronos"));
    expect(document.documentElement.dataset["vexTheme"]).toBe("chronos");
  });

  it("cube selection follows the persisted preference, never the resolved theme", () => {
    renderGroup(<SettingsPreferences />);
    fireEvent.click(cube("system"));
    // jsdom matchMedia is absent -> system resolves to chronos, yet the
    // SYSTEM cube must stay the pressed one.
    expect(useUiStore.getState().theme).toBe("chronos");
    expect(cube("system").getAttribute("aria-pressed")).toBe("true");
    expect(cube("chronos").getAttribute("aria-pressed")).toBe("false");
  });

  it("the Enter-key choice round-trips through the submission policy's public API", () => {
    renderGroup(<SettingsPreferences />);
    const modEnter = screen.getByRole("button", { name: "Ctrl/Cmd+Enter sends" });
    expect(getSubmitKeyBehavior()).toBe("enter");
    fireEvent.click(modEnter);
    expect(getSubmitKeyBehavior()).toBe("mod-enter");
    expect(modEnter.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Enter sends" }));
    expect(getSubmitKeyBehavior()).toBe("enter");
  });

  it("mounts the Background row between Appearance and the Enter key, reading the backdrop once", async () => {
    renderGroup(<SettingsPreferences />);
    const rows = Array.from(
      document.querySelectorAll(
        "[data-vex-settings-appearance], [data-vex-settings-backdrop], [data-vex-settings-enter]",
      ),
    ).map((row) => row.getAttributeNames().find((name) => name.startsWith("data-vex-settings-")));
    expect(rows).toEqual([
      "data-vex-settings-appearance",
      "data-vex-settings-backdrop",
      "data-vex-settings-enter",
    ]);
    expect(await screen.findByRole("button", { name: "Choose image" })).not.toBeNull();
    expect(shellBackdropReadMock).toHaveBeenCalledTimes(1);
  });

  it("the notifications row reads the typed uiStore slot and a click round-trips through its setter", () => {
    useUiStore.setState({ notificationsEnabled: true });

    renderGroup(<SettingsPreferences />);
    const toggle = screen.getByRole("switch", { name: "Notifications" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(useUiStore.getState().notificationsEnabled).toBe(false);
  });
});
