/**
 * Behavior tests for the uiStore theme runtime (uiStore/theme.ts):
 *   1. resolveTheme matrix - explicit preference wins; "system" follows the
 *      OS scheme.
 *   2. coerceThemePreference - legal values pass, everything else (retired
 *      "vex"/"robinhood", garbage, non-strings) degrades to the default,
 *      which is now "system" (ratified 2026-08-21).
 *   3. setThemePreference - one call updates the store AND documentElement
 *      (data-vex-theme + color-scheme).
 *   4. Rehydrate - a v8 payload's `theme` seeds `themePreference`; the v13
 *      hop re-defaults a SEEDED `chronos` to `system` exactly once while an
 *      explicit `celeris` survives; a tampered current-version payload
 *      coerces instead of crashing.
 *
 * jsdom does not implement `matchMedia`, so `systemPrefersDark()` takes its
 * documented safe-fail branch and reports DARK: `system` resolves to
 * `chronos` throughout this file, deterministically.
 *   5. The vex-studio `runtimeMode` seam defaults to "agent" and is not
 *      persisted.
 */

import { afterEach, describe, expect, it } from "vitest";
import { useUiStore } from "../uiStore.js";
import {
  applyThemeToDocument,
  coerceThemePreference,
  DEFAULT_THEME_PREFERENCE,
  resolveTheme,
} from "../uiStore/theme.js";

const STORAGE_KEY = "vex-ui";

afterEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ theme: "chronos", themePreference: "chronos" });
  applyThemeToDocument("chronos");
});

describe("resolveTheme", () => {
  it("explicit preferences ignore the system scheme", () => {
    expect(resolveTheme("chronos", true)).toBe("chronos");
    expect(resolveTheme("chronos", false)).toBe("chronos");
    expect(resolveTheme("celeris", true)).toBe("celeris");
    expect(resolveTheme("celeris", false)).toBe("celeris");
  });

  it("'system' follows the OS scheme", () => {
    expect(resolveTheme("system", true)).toBe("chronos");
    expect(resolveTheme("system", false)).toBe("celeris");
  });
});

describe("coerceThemePreference", () => {
  it("keeps legal values", () => {
    expect(coerceThemePreference("chronos")).toBe("chronos");
    expect(coerceThemePreference("celeris")).toBe("celeris");
    expect(coerceThemePreference("system")).toBe("system");
  });

  it("degrades everything else to the default ('system')", () => {
    expect(DEFAULT_THEME_PREFERENCE).toBe("system");
    expect(coerceThemePreference("robinhood")).toBe("system");
    expect(coerceThemePreference("vex")).toBe("system");
    expect(coerceThemePreference("neon-hack")).toBe("system");
    expect(coerceThemePreference(undefined)).toBe("system");
    expect(coerceThemePreference(null)).toBe("system");
    expect(coerceThemePreference(42)).toBe("system");
  });
});

describe("uiStore theme runtime", () => {
  it("setThemePreference resolves and stamps documentElement in one step", () => {
    useUiStore.getState().setThemePreference("celeris");
    const state = useUiStore.getState();
    expect(state.themePreference).toBe("celeris");
    expect(state.theme).toBe("celeris");
    expect(document.documentElement.dataset["vexTheme"]).toBe("celeris");
    expect(document.documentElement.style.colorScheme).toBe("light");

    useUiStore.getState().setThemePreference("chronos");
    expect(useUiStore.getState().theme).toBe("chronos");
    expect(document.documentElement.dataset["vexTheme"]).toBe("chronos");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("persists themePreference (not the resolved theme)", () => {
    useUiStore.getState().setThemePreference("system");
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(parsed.state.themePreference).toBe("system");
    expect("theme" in parsed.state).toBe(false);
  });

  it("migrates a v8 payload: old `theme` seeds `themePreference`, then v13 re-defaults the seeded chronos", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: { theme: "chronos", sidebarOpen: false },
        version: 8,
      }),
    );
    await useUiStore.persist.rehydrate();
    // v9 seeds themePreference from `theme`; v13 rewrites that SEEDED
    // chronos to `system` once. The resolved theme is still chronos here
    // only because jsdom's absent matchMedia reports dark.
    expect(useUiStore.getState().themePreference).toBe("system");
    expect(useUiStore.getState().theme).toBe("chronos");
    expect(useUiStore.getState().sidebarOpen).toBe(false);
  });

  it("v13 rewrites a persisted 'chronos' to 'system' exactly once", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { themePreference: "chronos" }, version: 12 }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().themePreference).toBe("system");

    // The re-default is a version hop, not a policy: once the user picks
    // chronos deliberately at v13 the choice sticks across rehydrates.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { themePreference: "chronos" }, version: 13 }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().themePreference).toBe("chronos");
  });

  it("v13 leaves an explicit 'celeris' untouched", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { themePreference: "celeris" }, version: 12 }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().themePreference).toBe("celeris");
    expect(useUiStore.getState().theme).toBe("celeris");
  });

  it("coerces a tampered current-version preference on rehydrate", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: { themePreference: "neon-hack" },
        version: 9,
      }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().themePreference).toBe("system");
    expect(useUiStore.getState().theme).toBe("chronos");
  });

  it("rehydrates a legal persisted 'celeris' preference", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { themePreference: "celeris" }, version: 9 }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().theme).toBe("celeris");
    expect(document.documentElement.dataset["vexTheme"]).toBe("celeris");
  });
});

describe("runtimeMode seam", () => {
  it("defaults to 'agent' and stays out of the persist payload", () => {
    expect(useUiStore.getState().runtimeMode).toBe("agent");
    useUiStore.getState().setSidebarOpen(true);
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect("runtimeMode" in parsed.state).toBe(false);
  });
});
