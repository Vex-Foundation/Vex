/**
 * `launchFormToParameters` must never SILENTLY ERASE a forbidden character.
 *
 * The function trims name, symbol, description and every link, which is what
 * made a leading or trailing newline invisible: the user typed it, the trim
 * removed it, and a launch went out carrying text that had never been checked
 * against the on-chain metadata policy.
 *
 * The renderer is untrusted UI and main stays authoritative, so this gate is
 * about the user SEEING why the form will not price rather than about trust.
 * Returning `null` is how this form says "not priceable yet", which keeps both
 * the preview and Deploy disarmed.
 */

import { describe, it, expect } from "vitest";

import {
  EMPTY_LAUNCH_FORM,
  launchFormToParameters,
  type LaunchFormValues,
} from "../LaunchForm.js";

const VALID: LaunchFormValues = {
  ...EMPTY_LAUNCH_FORM,
  name: "Moon",
  symbol: "MOON",
  description: "a launch",
  links: ["https://vex.example"],
  imageId: "img_01",
  prebuyEth: "0.01",
};

const FORBIDDEN = [
  ["leading newline", "\nMoon"],
  ["trailing newline", "Moon\n"],
  ["interior newline", "Mo\non"],
  ["leading tab", "\tMoon"],
  ["trailing tab", "Moon\t"],
  ["double quote", 'Mo"on'],
  ["DEL", "Moon\u007F"],
] as const;

describe("launchFormToParameters refuses forbidden metadata text", () => {
  it("prices a clean form", () => {
    const parameters = launchFormToParameters(VALID);
    expect(parameters).not.toBeNull();
    expect(parameters?.name).toBe("Moon");
  });

  for (const [label, value] of FORBIDDEN) {
    it(`refuses a ${label} in name, symbol or description instead of trimming it away`, () => {
      expect(launchFormToParameters({ ...VALID, name: value })).toBeNull();
      expect(launchFormToParameters({ ...VALID, symbol: value })).toBeNull();
      expect(launchFormToParameters({ ...VALID, description: value })).toBeNull();
    });

    it(`refuses a ${label} in any link row`, () => {
      expect(
        launchFormToParameters({ ...VALID, links: [`https://vex.example/${value}`] }),
      ).toBeNull();
      expect(
        launchFormToParameters({
          ...VALID,
          links: ["https://ok.example", `https://vex.example/${value}`],
        }),
      ).toBeNull();
    });
  }

  it("still trims ordinary surrounding whitespace", () => {
    const parameters = launchFormToParameters({ ...VALID, name: "  Moon  " });
    expect(parameters?.name).toBe("Moon");
  });

  it("PRESERVES emoji, accented letters and ordinary punctuation", () => {
    const parameters = launchFormToParameters({
      ...VALID,
      name: "Moon Café 🚀",
      description: "Vex's token - it's fine, ¡olé!",
    });
    expect(parameters?.name).toBe("Moon Café 🚀");
    expect(parameters?.description).toBe("Vex's token - it's fine, ¡olé!");
  });
});
