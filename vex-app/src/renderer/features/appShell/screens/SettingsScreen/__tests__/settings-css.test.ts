/**
 * The Settings page sheet (docs/design/R3-MINIMAL.md section 9.6), read as
 * text: jsdom does not lay out CSS, so the values the design fixes are pinned
 * where they are written. `settings.css` is the page's own sheet, imported by
 * the manifest; the sheets it replaced no longer carry its rules.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const styles = resolve(here, "../../../../../styles");
const read = (rel: string): string => readFileSync(resolve(styles, rel), "utf8");

const settings = read("global-css/settings.css");
const overlay = read("global-css/overlay.css");
const manifest = read("globals.css");

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) throw new Error(`no rule for ${selector}`);
  return match[1] ?? "";
}

describe("settings.css", () => {
  it("is imported by the manifest as a plain unlayered import, after the page sheet", () => {
    const imports = manifest.split("\n").filter((line) => line.startsWith("@import"));
    const overlayAt = imports.indexOf('@import "./global-css/overlay.css";');
    expect(overlayAt).toBeGreaterThan(-1);
    expect(imports[overlayAt + 1]).toBe('@import "./global-css/settings.css";');
  });

  it("is a nav of 236 (210 under 1180) beside the section", () => {
    expect(rule(settings, ".vex-set")).toContain("grid-template-columns: 236px minmax(0, 1fr)");
    const narrow = /@media \(max-width: 1179px\) \{([\s\S]*?)\n\}/.exec(settings)?.[1] ?? "";
    expect(narrow).toContain("grid-template-columns: 210px minmax(0, 1fr)");
    expect(narrow).toContain("padding: 22px 28px 56px");
    expect(rule(settings, ".vex-set__nav")).toContain("padding: 22px 12px 24px 14px");
    expect(rule(settings, ".vex-set__body")).toContain("padding: 28px 44px 56px");
    expect(rule(settings, ".vex-set__col")).toContain("max-width: 680px");
  });

  it("sizes the rows and heads as the design fixes them", () => {
    expect(rule(settings, ".vex-set__item")).toContain("height: 34px");
    expect(rule(settings, ".vex-set__group")).toMatch(/font-size: 12px;[\s\S]*font-weight: 500/);
    expect(rule(settings, ".vex-set__title")).toMatch(/font-size: 22px;[\s\S]*font-weight: 500/);
    expect(rule(settings, ".vex-set__lead")).toMatch(/max-width: 620px;[\s\S]*font-size: 14px/);
    expect(rule(settings, ".vex-pref__title")).toMatch(/font-size: 14\.5px;[\s\S]*font-weight: 500/);
    expect(rule(settings, ".vex-pref__help")).toContain("font-size: 13px");
    expect(rule(settings, ".vex-pref")).toContain("padding: 14px 0");
  });

  it("selects a row with the blue 500 wash the left sidebar uses", () => {
    expect(rule(settings, ".vex-set")).toContain("--set-sel: rgba(163, 171, 255, 0.1)");
    expect(rule(settings, '[data-vex-theme="celeris"] .vex-set')).toContain(
      "--set-sel: rgba(0, 0, 192, 0.075)",
    );
    const selected = rule(settings, '.vex-set__item[aria-current="page"]');
    expect(selected).toContain("background: var(--set-sel)");
    expect(selected).toContain("font-weight: 500");
    expect(selected).toContain("color: var(--vex-alias-accent-primary)");
  });

  it("draws the switch 32 x 18 with a 10 x 10 thumb at a 3px inset", () => {
    expect(rule(settings, ".vex-switch")).toMatch(/width: 32px;\s*height: 18px/);
    expect(rule(settings, ".vex-switch::after")).toMatch(
      /top: 3px;\s*left: 3px;\s*width: 10px;\s*height: 10px/,
    );
  });

  it("draws the Lock Vex row's chord in mono 12 muted", () => {
    expect(rule(settings, ".vex-pref__chord")).toMatch(
      /font-family: var\(--font-mono\);[\s\S]*font-size: 12px;[\s\S]*var\(--vex-alias-label-tertiary\)/,
    );
  });

  it("keeps to the language: tokens only, radius 0, no shadow, blur, gradient or caps", () => {
    expect(settings).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(settings).not.toMatch(/border-radius|box-shadow|backdrop-filter|filter:|gradient/);
    expect(settings).not.toMatch(/text-transform:\s*uppercase/);
    expect(settings).not.toMatch(/Departure|px-font/i);
  });

  it("no longer shares its rules with the page sheet", () => {
    for (const gone of [
      ".vex-reg",
      ".vex-prefs",
      ".vex-pref",
      ".vex-tile",
      ".vex-switch",
      ".vex-sbtn",
      ".vex-backdrop-preview",
      ".vex-ov-frame",
      ".vex-ov__group",
    ]) {
      expect(overlay.includes(gone), `${gone} moved out of overlay.css`).toBe(false);
    }
    // The choice and the group label stay: the sessions library draws with them.
    expect(overlay).toContain(".vex-seg {");
    expect(overlay).toContain(".vex-ov-label {");
  });
});
