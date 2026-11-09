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

  it("is a nav of 248, Cloud's (210 under 1180), beside the section", () => {
    expect(rule(settings, ".vex-set")).toContain("grid-template-columns: 248px minmax(0, 1fr)");
    const narrow = /@media \(max-width: 1179px\) \{([\s\S]*?)\n\}/.exec(settings)?.[1] ?? "";
    expect(narrow).toContain("grid-template-columns: 210px minmax(0, 1fr)");
    expect(narrow).toContain("padding: 24px 24px 56px");
    expect(rule(settings, ".vex-set__nav")).toContain("padding: 22px 0 24px");
    // The page kit: the body 24 in, its column at most 760.
    expect(rule(settings, ".vex-set__body")).toContain("padding: 24px 24px 56px");
    expect(rule(settings, ".vex-set__col")).toContain("max-width: 760px");
  });

  it("sizes the rows and heads as H3 fixes them", () => {
    // The nav is Cloud's built nav (owner decision 2026-11-09): 36 rows, the
    // name in sentence case 14, the group words 11 caps at 12 24 6.
    const item = rule(settings, ".vex-set__item");
    expect(item).toContain("height: 36px");
    expect(item).toContain("padding: 0 20px 0 24px");
    expect(item).toContain("font-size: 14px");
    expect(item).not.toContain("text-transform: uppercase");
    const group = rule(settings, ".vex-set__group");
    expect(group).toMatch(/padding: 12px 24px 6px;\s*font-size: 11px;[\s\S]*text-transform: uppercase/);
    expect(rule(settings, ".vex-set__icon")).toContain("color: var(--vex-alias-label-tertiary)");
    const hover = rule(settings, ".vex-set__item:hover");
    expect(hover).toContain("background: var(--set-sel)");
    expect(hover).toContain("color: var(--vex-alias-label-primary)");
    // A block's head is Cloud's 12 caps (600), 12 above its content.
    expect(rule(settings, ".vex-set__sh-title")).toMatch(
      /font-size: 12px;[\s\S]*font-weight: 600;[\s\S]*text-transform: uppercase/,
    );
    expect(rule(settings, ".vex-set__sh")).toContain("margin: 0 0 12px");
    // A block is Cloud's PageBox: a frame on the card ground, 16 in, its head a 44 band.
    const box = rule(settings, "section.vex-set__sec:not([data-vex-user-mcp])");
    expect(box).toMatch(/padding: 0 16px 16px;\s*border: 1px solid var\(--vex-alias-rule\);\s*background: var\(--vex-alias-card\);/);
    expect(
      rule(settings, "section.vex-set__sec:not([data-vex-user-mcp]) > :is(.vex-set__sh, .vex-set__sh-title):first-child"),
    ).toMatch(/min-height: 44px;[\s\S]*margin: 0 -16px 12px;[\s\S]*border-bottom: 1px solid var\(--vex-alias-rule\);/);
    // The lead is the page kit's (C3-E-05): 14 / 1.5 at most 760.
    expect(rule(settings, ".vex-set__lead")).toMatch(/max-width: 760px;[\s\S]*font-size: 14px;[\s\S]*line-height: 1.5;/);
    expect(rule(settings, ".vex-pref__title")).toMatch(/font-size: 15px;[\s\S]*font-weight: 400/);
    expect(rule(settings, ".vex-pref__help")).toContain("font-size: 13px");
    // Cloud's built preference row: at least 64, padding 12 16, the note at most 520.
    expect(rule(settings, ".vex-pref")).toMatch(/min-height: 64px;\s*padding: 12px 16px;/);
    expect(rule(settings, ".vex-pref__help")).toContain("max-width: 520px");
    expect(rule(settings, ".vex-prefs__list")).toContain("background: var(--vex-alias-card)");
    expect(rule(settings, ".vex-pref__title[data-vex-pref-row-press]::after")).toMatch(/position: absolute;\s*inset: 0;/);
    expect(settings).toMatch(/\.vex-pref:has\(\[role="switch"\]\):hover \{\s*background: var\(--vex-alias-interactive-hover\);/);
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

  it("boxes each MCP server on the card ground with a 44 head and 10 16 tool rows (Cloud's built MCP page)", () => {
    expect(rule(settings, ".vex-mcp-box")).toContain("background: var(--vex-alias-card)");
    expect(rule(settings, ".vex-mcp-box__h")).toContain("min-height: 44px");
    expect(rule(settings, ".vex-mcp-tool")).toContain("padding: 10px 16px");
    expect(rule(settings, ".vex-mcp-tools__h")).toMatch(/font-size: 11px;[\s\S]*text-transform: uppercase/);
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
