/**
 * SettingsPreferences - the Appearance theme switcher, the composer
 * Enter-key row, and the presence-gated notifications toggle on the
 * Settings register.
 *
 * Pins:
 *   - clicking a theme cube writes the persisted preference AND stamps the
 *     resolved theme onto `documentElement[data-vex-theme]`,
 *   - cube selection follows the PREFERENCE, never the resolved theme
 *     ("system" stays pressed while the OS resolves the paint),
 *   - the Enter-key choice round-trips through the composer submission
 *     policy's public API,
 *   - the notifications row renders on the merged store slot and
 *     round-trips through its setter.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useUiStore } from "../../../../stores/uiStore.js";
import {
  getSubmitKeyBehavior,
  resetSubmitKeyBehaviorForTest,
} from "../../../../lib/composer-submission-policy.js";
import { SettingsPreferences } from "../SettingsScreen/SettingsPreferences.js";

beforeEach(async () => {
  window.localStorage.clear();
  await resetSubmitKeyBehaviorForTest();
  useUiStore.getState().setThemePreference("chronos");
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
    render(<SettingsPreferences />);
    fireEvent.click(cube("celeris"));
    expect(useUiStore.getState().themePreference).toBe("celeris");
    expect(document.documentElement.dataset["vexTheme"]).toBe("celeris");
    fireEvent.click(cube("chronos"));
    expect(document.documentElement.dataset["vexTheme"]).toBe("chronos");
  });

  it("cube selection follows the persisted preference, never the resolved theme", () => {
    render(<SettingsPreferences />);
    fireEvent.click(cube("system"));
    // jsdom matchMedia is absent -> system resolves to chronos, yet the
    // SYSTEM cube must stay the pressed one.
    expect(useUiStore.getState().theme).toBe("chronos");
    expect(cube("system").getAttribute("aria-pressed")).toBe("true");
    expect(cube("chronos").getAttribute("aria-pressed")).toBe("false");
  });

  it("the Enter-key choice round-trips through the submission policy's public API", () => {
    render(<SettingsPreferences />);
    const modEnter = screen.getByRole("button", { name: "Ctrl/Cmd+Enter sends" });
    expect(getSubmitKeyBehavior()).toBe("enter");
    fireEvent.click(modEnter);
    expect(getSubmitKeyBehavior()).toBe("mod-enter");
    expect(modEnter.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Enter sends" }));
    expect(getSubmitKeyBehavior()).toBe("enter");
  });

  it("the notifications row renders on the merged store slot and a click round-trips through its setter", () => {
    // The errors lane's slot is merged: the row is always present and the
    // probe resolves the real typed slot (default true).
    useUiStore.setState({ notificationsEnabled: true });

    render(<SettingsPreferences />);
    const toggle = screen.getByRole("switch", { name: "Notifications" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(useUiStore.getState().notificationsEnabled).toBe(false);
  });
});
