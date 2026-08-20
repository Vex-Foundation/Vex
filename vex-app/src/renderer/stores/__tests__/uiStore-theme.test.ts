/**
 * Behavior tests for the uiStore theme runtime (uiStore/theme.ts):
 *   1. resolveTheme matrix - explicit preference wins; "system" follows the
 *      OS scheme.
 *   2. coerceThemePreference - legal values pass, everything else (retired
 *      "vex"/"robinhood", garbage, non-strings) degrades to the default.
 *   3. setThemePreference - one call updates the store AND documentElement
 *      (data-vex-theme + color-scheme).
 *   4. Rehydrate - a v8 payload's `theme` seeds `themePreference`; a
 *      tampered current-version payload coerces instead of crashing.
 *   5. The vex-studio `runtimeMode` seam defaults to "agent" and is not
 *      persisted.
 */

import { afterEach, describe, expect, it } from "vitest";
import { useUiStore } from "../uiStore.js";
import {
  applyThemeToDocument,
  coerceThemePreference,
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

  it("degrades everything else to the default", () => {
    expect(coerceThemePreference("robinhood")).toBe("chronos");
    expect(coerceThemePreference("vex")).toBe("chronos");
    expect(coerceThemePreference("neon-hack")).toBe("chronos");
    expect(coerceThemePreference(undefined)).toBe("chronos");
    expect(coerceThemePreference(null)).toBe("chronos");
    expect(coerceThemePreference(42)).toBe("chronos");
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

  it("migrates a v8 payload: old `theme` seeds `themePreference`", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: { theme: "chronos", sidebarOpen: false },
        version: 8,
      }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().themePreference).toBe("chronos");
    expect(useUiStore.getState().theme).toBe("chronos");
    expect(useUiStore.getState().sidebarOpen).toBe(false);
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
    expect(useUiStore.getState().themePreference).toBe("chronos");
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
