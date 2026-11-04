/**
 * The Settings page sheet in H3 cells (docs/design/H3-DESKTOP.md sections 1.4,
 * 2.3 and 2.4; R3-MINIMAL.md section 9.6 before it), read as text: jsdom does
 * not lay out CSS, so the values the design fixes are pinned where they are
 * written. `settings.css` is the page's own sheet, imported by
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

  it("is a nav of 264 (210 under 1180) beside the section", () => {
    expect(rule(settings, ".vex-set")).toContain("grid-template-columns: 264px minmax(0, 1fr)");
    const narrow = /@media \(max-width: 1179px\) \{([\s\S]*?)\n\}/.exec(settings)?.[1] ?? "";
    expect(narrow).toContain("grid-template-columns: 210px minmax(0, 1fr)");
    expect(narrow).toContain("padding: 22px 28px 56px");
    expect(rule(settings, ".vex-set__nav")).toContain("padding: 22px 0 24px");
    expect(rule(settings, ".vex-set__body")).toContain("padding: 28px 44px 56px");
    expect(rule(settings, ".vex-set__col")).toContain("max-width: 680px");
  });

  it("sizes the rows and heads as H3 fixes them", () => {
    // The nav on H3's 40 pitch, its labels and group heads in caps.
    const item = rule(settings, ".vex-set__item");
    expect(item).toContain("height: 40px");
    expect(item).toMatch(/font-size: 13px;[\s\S]*text-transform: uppercase/);
    expect(rule(settings, ".vex-set__group")).toMatch(/font-size: 12px;[\s\S]*text-transform: uppercase/);
    // A section's name is H3's card sentence; its blocks the 13 caps head.
    expect(rule(settings, ".vex-set__title")).toMatch(/font-size: 20px;[\s\S]*font-weight: 400/);
    expect(rule(settings, ".vex-set__sh-title")).toMatch(
      /font-size: 13px;[\s\S]*font-weight: 600;[\s\S]*text-transform: uppercase/,
    );
    expect(rule(settings, ".vex-set__lead")).toMatch(/max-width: 620px;[\s\S]*font-size: 15px/);
    expect(rule(settings, ".vex-pref__title")).toMatch(/font-size: 15px;[\s\S]*font-weight: 400/);
    expect(rule(settings, ".vex-pref__help")).toContain("font-size: 13px");
    expect(rule(settings, ".vex-pref")).toContain("padding: 16px 20px");
    // The rows sit in one framed cell.
    expect(rule(settings, ".vex-prefs__list")).toContain("border: 1px solid var(--vex-alias-rule)");
    expect(rule(settings, ".vex-set__kvl")).toContain("border: 1px solid var(--vex-alias-rule)");
  });

  it("keeps the nav flush under the H3 frame, whose padding rule it outranks by loading later", () => {
    const frame = rule(settings, '.vex-ov[data-frame="h3"]:has([data-vex-settings-page])');
    expect(frame).toContain("--vex-ov-pad: 0px");
    expect(frame).toContain("--vex-ov-top: 0px");
  });

  it("selects a row with H3's selected-row fill and ink", () => {
    // H3's selected nav row (docs/design/H3-DESKTOP.md section 2.1): the one
    // fill that fades, from its alias, never spelled here.
    expect(rule(settings, ".vex-set")).toContain("--set-sel: var(--vex-alias-row-selected)");
    // One room: the day wash retired with Celeris.
    expect(settings).not.toContain('[data-vex-theme="celeris"]');
    const selected = rule(settings, '.vex-set__item[aria-current="page"]');
    expect(selected).toContain("background: var(--set-sel)");
    expect(selected).toContain("font-weight: 400");
    expect(selected).toContain("color: var(--vex-alias-accent-primary)");
  });

  it("draws H3's switch: 36 x 20, a light border, a 12 x 12 thumb, never the blue", () => {
    expect(rule(settings, ".vex-switch")).toMatch(/width: 36px;\s*height: 20px/);
    expect(rule(settings, ".vex-switch::after")).toMatch(
      /top: 3px;\s*left: 3px;\s*width: 12px;\s*height: 12px/,
    );
    const on = rule(settings, '.vex-switch[aria-checked="true"]::after');
    expect(on).toContain("translateX(16px)");
    expect(on).toContain("background: var(--vex-alias-label-primary)");
    // The blue is for primary keys only (section 2.4).
    expect(settings).not.toContain("button-accent");
  });

  it("draws the Lock Vex row's chord in mono 12 muted", () => {
    expect(rule(settings, ".vex-pref__chord")).toMatch(
      /font-family: var\(--font-mono\);[\s\S]*font-size: 12px;[\s\S]*var\(--vex-alias-label-tertiary\)/,
    );
  });

  it("keeps to the language: tokens only, radius 0, no shadow, blur or gradient, caps tracked", () => {
    expect(settings).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(settings).not.toMatch(/border-radius|box-shadow|backdrop-filter|filter:|gradient/);
    expect(settings).not.toMatch(/Departure|px-font/i);
    // H3 sets labels in caps (section 2.3), every one at the one tracking.
    const caps = [...settings.matchAll(/\{([^}]*text-transform:\s*uppercase[^}]*)\}/g)];
    expect(caps.length).toBeGreaterThan(0);
    for (const [, body] of caps) {
      expect(body).toContain("letter-spacing: var(--tracking-label)");
    }
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
