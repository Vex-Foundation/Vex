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
  runInNewContext(BOOT_SOURCE, { window: win, document });
  return { theme: document.documentElement.dataset["vexTheme"], getItem };
}

/** The persisted shape older releases wrote. */
const stored = (themePreference: string, version = 22): string =>
  JSON.stringify({ state: { themePreference }, version });

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-vex-theme");
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
