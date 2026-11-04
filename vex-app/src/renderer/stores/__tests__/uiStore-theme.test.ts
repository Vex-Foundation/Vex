/**
 * Behavior tests for the uiStore theme runtime (uiStore/theme.ts). H3 is
 * DARK ONLY (the H3 revamp plan, decision 6): Celeris and the "system"
 * choice retired, so the contract is one room everywhere:
 *   1. coerceThemePreference - every value, the retired `celeris` and
 *      `system` included, lands on `chronos`;
 *   2. the store starts in the one room, offers no setter that could leave
 *      it, and stamps it on documentElement (`data-vex-theme` and a dark
 *      `color-scheme`);
 *   3. migration v23 REWRITES every stored choice to `chronos` (so an older
 *      release reading the payload after a downgrade finds dark too) and
 *      drops the pre-v9 `theme` key; the rehydrate coercion covers a
 *      tampered current-version payload;
 *   4. the vex-studio `runtimeMode` seam defaults to "agent" on a fresh
 *      install and IS persisted as of v17 (the last Studio location).
 */

import { afterEach, describe, expect, it } from "vitest";
import { useUiStore } from "../uiStore.js";
import { migrateUiState } from "../uiStore/persistence.js";
import {
  applyThemeToDocument,
  coerceThemePreference,
  DEFAULT_THEME_PREFERENCE,
  VEX_THEME,
} from "../uiStore/theme.js";

const STORAGE_KEY = "vex-ui";

afterEach(() => {
  window.localStorage.clear();
  useUiStore.setState({ theme: "chronos", themePreference: "chronos" });
  applyThemeToDocument("chronos");
});

describe("coerceThemePreference", () => {
  it("lands every value on the one room", () => {
    expect(VEX_THEME).toBe("chronos");
    expect(DEFAULT_THEME_PREFERENCE).toBe("chronos");
    for (const value of [
      "chronos",
      "celeris",
      "system",
      "robinhood",
      "vex",
      "neon-hack",
      undefined,
      null,
      42,
      { theme: "celeris" },
    ]) {
      expect(coerceThemePreference(value)).toBe("chronos");
    }
  });
});

describe("uiStore theme runtime", () => {
  it("starts in the one room and stamps it, dark, on the document root", () => {
    document.documentElement.removeAttribute("data-vex-theme");
    applyThemeToDocument(useUiStore.getState().theme);
    expect(useUiStore.getState().theme).toBe("chronos");
    expect(useUiStore.getState().themePreference).toBe("chronos");
    expect(document.documentElement.dataset["vexTheme"]).toBe("chronos");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("offers no setter that could leave the room", () => {
    expect("setThemePreference" in useUiStore.getState()).toBe(false);
  });

  it("persists the slot (never the room itself), holding the one room", () => {
    useUiStore.getState().setSidebarOpen(true);
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(parsed.state.themePreference).toBe("chronos");
    expect("theme" in parsed.state).toBe(false);
    expect(parsed.version).toBe(24);
  });

  it.each(["celeris", "system", "chronos"])(
    "v23 rewrites a stored '%s' to chronos, in the payload itself",
    (choice) => {
      const migrated = migrateUiState({ themePreference: choice, sidebarOpen: false }, 22) as Record<
        string,
        unknown
      >;
      expect(migrated["themePreference"]).toBe("chronos");
      expect(migrated["sidebarOpen"]).toBe(false);
    },
  );

  it("v23 drops the pre-v9 `theme` key with the choice it held", () => {
    const migrated = migrateUiState({ theme: "celeris", sidebarOpen: true }, 8) as Record<
      string,
      unknown
    >;
    expect("theme" in migrated).toBe(false);
    expect(migrated["themePreference"]).toBe("chronos");
  });

  it("rehydrates a saved Celeris into the dark room", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { themePreference: "celeris" }, version: 22 }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().themePreference).toBe("chronos");
    expect(useUiStore.getState().theme).toBe("chronos");
    expect(document.documentElement.dataset["vexTheme"]).toBe("chronos");
  });

  it("rehydrates the retired system choice into the dark room", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { themePreference: "system" }, version: 13 }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().themePreference).toBe("chronos");
    expect(useUiStore.getState().theme).toBe("chronos");
  });

  it("migrates a v8 payload's old `theme` through every hop to the dark room", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: { theme: "celeris", sidebarOpen: false },
        version: 8,
      }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().themePreference).toBe("chronos");
    expect(useUiStore.getState().theme).toBe("chronos");
    expect(useUiStore.getState().sidebarOpen).toBe(false);
  });

  it("coerces a tampered current-version preference on rehydrate", async () => {
    // A current-version payload skips `migrate`; the merge coercion is the
    // guard that remains.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { themePreference: "celeris" }, version: 23 }),
    );
    await useUiStore.persist.rehydrate();
    expect(useUiStore.getState().themePreference).toBe("chronos");
    expect(useUiStore.getState().theme).toBe("chronos");
    expect(document.documentElement.dataset["vexTheme"]).toBe("chronos");
  });
});

describe("runtimeMode seam", () => {
  it("defaults to 'agent' and is written as the last Studio location", () => {
    expect(useUiStore.getState().runtimeMode).toBe("agent");
    useUiStore.getState().setSidebarOpen(true);
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    // v17: the mode is persisted, so a relaunch returns to the shell the user
    // left. The coercion that keeps the untrusted payload safe is pinned in
    // `uiStore-persist-hardening.test.ts`.
    expect(parsed.state.runtimeMode).toBe("agent");
    useUiStore.getState().setRuntimeMode("studio");
    const afterSwitch = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "{}",
    );
    expect(afterSwitch.state.runtimeMode).toBe("studio");
  });
});
