/**
 * Pre-paint theme boot (`public/theme-boot.js`).
 *
 * The script cannot be imported: CSP keeps it a separate classic script that
 * runs before the bundle, so it is read from disk and executed in a jsdom
 * context the way the browser runs it. It mirrors `stores/uiStore/theme.ts`
 * by contract, and this spec is what keeps the two honest - the drift it
 * catches is a theme FLASH on boot.
 *
 * H3 is DARK ONLY. The contract is that the script stamps the one room
 * whatever the machine says: on a fresh install, over every payload an older
 * release could have written (an explicit Celeris, the retired "system", a
 * tampered value, an unparseable one), under a light OS and without
 * matchMedia - and that it does not read the payload at all, since every
 * stored choice now coerces to the same room in the store.
 */

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coerceThemePreference, VEX_THEME } from "../uiStore/theme.js";
import { stampSaveData } from "../../lib/motion/use-still-frame.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BOOT_SOURCE = readFileSync(
  path.join(here, "..", "..", "public", "theme-boot.js"),
  "utf8",
);

/**
 * Run the boot script against a stubbed storage payload and OS scheme.
 * @param payload - raw `vex-ui` localStorage value, or null for a fresh install.
 * @param prefersDark - OS scheme; `undefined` removes matchMedia entirely.
 * @returns the theme the script stamped, and the storage stub to inspect.
 */
function runBoot(
  payload: string | null,
  prefersDark: boolean | undefined,
  navigator?: unknown,
): { theme: string | undefined; getItem: ReturnType<typeof vi.fn> } {
  document.documentElement.removeAttribute("data-vex-theme");
  document.documentElement.style.removeProperty("color-scheme");
  const getItem = vi.fn(() => payload);
  const win = {
    localStorage: { getItem },
    ...(prefersDark === undefined
      ? {}
      : { matchMedia: vi.fn(() => ({ matches: prefersDark })) }),
  };
  runInNewContext(BOOT_SOURCE, {
    window: win,
    document,
    ...(navigator === undefined ? {} : { navigator }),
  });
  return { theme: document.documentElement.dataset["vexTheme"], getItem };
}

/** A connection whose Save-Data preference the test can flip and announce. */
function connectionOf(saveData: boolean | undefined): {
  saveData: boolean | undefined;
  addEventListener: (type: string, listener: () => void) => void;
  fire: () => void;
} {
  const listeners: Array<() => void> = [];
  return {
    saveData,
    addEventListener: (type, listener) => {
      if (type === "change") listeners.push(listener);
    },
    fire: () => {
      for (const listener of listeners) listener();
    },
  };
}

/** The persisted shape older releases wrote. */
const stored = (themePreference: string, version = 22): string =>
  JSON.stringify({ state: { themePreference }, version });

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-vex-theme");
  document.documentElement.removeAttribute("data-still");
  document.documentElement.style.removeProperty("color-scheme");
});

describe("theme-boot pre-paint stamp (dark only)", () => {
  it.each([
    ["a fresh install", null],
    ["an explicit Celeris", stored("celeris")],
    ["the retired system choice", stored("system")],
    ["an explicit Chronos", stored("chronos")],
    ["a pre-v13 Chronos", stored("chronos", 12)],
    ["a tampered value", stored("neon-hack")],
    ["an unparseable payload", "{not json"],
  ])("stamps the one dark room over %s, whatever the OS says", (_case, payload) => {
    for (const prefersDark of [true, false, undefined]) {
      expect(runBoot(payload, prefersDark).theme).toBe("chronos");
      expect(document.documentElement.style.colorScheme).toBe("dark");
    }
  });

  it("reads nothing from storage: there is no choice left to read", () => {
    expect(runBoot(stored("celeris"), false).getItem).not.toHaveBeenCalled();
  });

  it("agrees with the store: the room it stamps is the one every payload coerces to", () => {
    expect(runBoot(null, false).theme).toBe(VEX_THEME);
    for (const value of ["celeris", "system", "chronos", "robinhood", undefined, 42]) {
      expect(coerceThemePreference(value)).toBe(VEX_THEME);
    }
  });
});

describe("theme-boot pre-paint stamp (Save-Data)", () => {
  // docs/design/H3-DESKTOP.md section 3.7: Save-Data reaches CSS as
  // `data-still` on <html>, stamped before first paint by the same rule as
  // `stampSaveData` (lib/motion/use-still-frame.ts).
  const still = (): boolean => document.documentElement.hasAttribute("data-still");

  it("stamps data-still before first paint when the connection asks to save data", () => {
    runBoot(null, true, { connection: connectionOf(true) });
    expect(still()).toBe(true);
    expect(document.documentElement.getAttribute("data-still")).toBe("");
  });

  it.each([
    ["no navigator", undefined],
    ["no connection", {}],
    ["Save-Data off", { connection: connectionOf(false) }],
    ["Save-Data unknown", { connection: connectionOf(undefined) }],
  ])("leaves motion on with %s", (_case, navigator) => {
    document.documentElement.setAttribute("data-still", "");
    runBoot(null, true, navigator);
    expect(still()).toBe(false);
  });

  it("follows the connection when its preference changes", () => {
    const connection = connectionOf(false);
    runBoot(null, true, { connection });
    expect(still()).toBe(false);
    connection.saveData = true;
    connection.fire();
    expect(still()).toBe(true);
    connection.saveData = false;
    connection.fire();
    expect(still()).toBe(false);
  });

  it("agrees with stampSaveData for every connection state", () => {
    for (const saveData of [true, false, undefined]) {
      runBoot(null, true, { connection: connectionOf(saveData) });
      const fromBoot = still();
      document.documentElement.removeAttribute("data-still");
      stampSaveData(document.documentElement, { saveData });
      expect(still(), String(saveData)).toBe(fromBoot);
    }
  });
});
