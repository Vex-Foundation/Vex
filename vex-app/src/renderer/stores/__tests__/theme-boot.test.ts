/**
 * Pre-paint theme boot (`public/theme-boot.js`).
 *
 * The script cannot be imported: CSP keeps it a separate classic script that
 * runs before the bundle, so it is read from disk and executed in a jsdom
 * context the way the browser runs it. It duplicates the resolve + write
 * pair from `stores/uiStore/theme.ts` by contract, and this spec is what
 * keeps the two honest - the drift it catches is a theme FLASH on boot, or
 * (before round 2) a dark first paint for a light-mode user.
 *
 * Covered: the `system` default with no payload, the OS resolve in both
 * directions, an explicit preference overriding the OS, closed-union
 * coercion of a tampered payload, an unparseable payload, and the
 * matchMedia-unavailable safe-fail that mirrors `systemPrefersDark()`.
 */

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_THEME_PREFERENCE,
  resolveTheme,
  type VexTheme,
} from "../uiStore/theme.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BOOT_SOURCE = readFileSync(
  path.join(here, "..", "..", "public", "theme-boot.js"),
  "utf8",
);

/**
 * Run the boot script against a stubbed storage payload and OS scheme.
 * @param payload - raw `vex-ui` localStorage value, or null for a fresh install.
 * @param prefersDark - OS scheme; `undefined` removes matchMedia entirely.
 * @returns the theme the script stamped on documentElement.
 */
function runBoot(
  payload: string | null,
  prefersDark: boolean | undefined,
): string | undefined {
  document.documentElement.removeAttribute("data-vex-theme");
  document.documentElement.style.removeProperty("color-scheme");
  const win = {
    localStorage: { getItem: vi.fn(() => payload) },
    ...(prefersDark === undefined
      ? {}
      : { matchMedia: vi.fn(() => ({ matches: prefersDark })) }),
  };
  runInNewContext(BOOT_SOURCE, { window: win, document });
  return document.documentElement.dataset["vexTheme"];
}

/** The persisted shape the script reads. */
const stored = (themePreference: string): string =>
  JSON.stringify({ state: { themePreference }, version: 13 });

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-vex-theme");
  document.documentElement.style.removeProperty("color-scheme");
});

describe("theme-boot pre-paint stamp", () => {
  it("defaults to 'system' and follows a LIGHT OS on a fresh install", () => {
    expect(DEFAULT_THEME_PREFERENCE).toBe("system");
    expect(runBoot(null, false)).toBe("celeris");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("defaults to 'system' and follows a DARK OS on a fresh install", () => {
    expect(runBoot(null, true)).toBe("chronos");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it.each([
    ["celeris", true, "celeris"],
    ["celeris", false, "celeris"],
    ["chronos", true, "chronos"],
    ["chronos", false, "chronos"],
  ] as const)(
    "an explicit '%s' ignores the OS scheme (prefersDark=%s)",
    (preference, prefersDark, expected) => {
      expect(runBoot(stored(preference), prefersDark)).toBe(expected);
    },
  );

  it("coerces a tampered preference to the default instead of stamping it", () => {
    expect(runBoot(stored("neon-hack"), false)).toBe("celeris");
    expect(runBoot(stored("robinhood"), true)).toBe("chronos");
  });

  it("survives an unparseable payload", () => {
    expect(runBoot("{not json", false)).toBe("celeris");
  });

  it("reports DARK when matchMedia is unavailable, like systemPrefersDark()", () => {
    // The safe fail for an ink-rooted app: an unknowable OS scheme must not
    // paint the light plate under a dark window.
    expect(runBoot(null, undefined)).toBe("chronos");
  });

  it.each([
    [true, "chronos"],
    [false, "celeris"],
  ] as const)(
    "agrees with resolveTheme() for the default preference (prefersDark=%s)",
    (prefersDark, expected: VexTheme) => {
      expect(runBoot(null, prefersDark)).toBe(
        resolveTheme(DEFAULT_THEME_PREFERENCE, prefersDark),
      );
      expect(runBoot(null, prefersDark)).toBe(expected);
    },
  );
});
