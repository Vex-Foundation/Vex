/**
 * D2'S PANEL as CSS text (docs/design/H3-DESKTOP.md sections 6.3, 6.5 and
 * 6.6; owner decision 2026-11-10, "the chat takes that space"). Vex has no
 * track in the shell's frame: her panel is a box over the chat's top right,
 * as tall as what it holds, and everything readable in the chat stands in
 * the room left of it. Pinned here:
 *
 *   1. the reading column is solved in the chat less her panel's room, and
 *      that room is the frame's `--vex-panel-w`, never her shown choice;
 *   2. her panel's place: the chat's track, the body row, at its right end
 *      and its top, 280 wide, over the chat and under the chats panel, never
 *      down past the chat's composer group (`--vex-panel-floor`);
 *   3. hidden, her panel draws no ground and no rule; shown, its foot is
 *      ruled and its bars are a 48 strip, with no bars cell in the bottom row;
 *   4. a page, Studio's centre, the slash menu, the context panel and the
 *      chat's scrollbar keep clear of her.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const sheet = (name: string): string =>
  readFileSync(path.join(here, "..", name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open)).replace(/\s+/g, " ").trim();
}

const shell = sheet("shell.css");
const vexSidebar = sheet("vex-sidebar.css");
const PANEL = '.vex-shell-frame[data-vex-frame="h3"][data-vex-seat="column"]';

describe("the reading column clears her panel (section 6.6)", () => {
  it("solves read-x and read-w in the chat less her panel's room", () => {
    // The frame's rule that declares the room, read to its end.
    const reading = shell.slice(shell.indexOf("--vex-read-room"));
    expect(reading).toMatch(/^--vex-read-room: calc\(var\(--vex-chat-track\) - var\(--vex-panel-w, 0px\)\);/);
    const block = reading.slice(0, reading.indexOf("}")).replace(/\s+/g, " ");
    expect(block).toContain(
      "--vex-read-x: clamp( 24px, calc(var(--vex-read-room) - var(--vex-read-span) - 24px), calc(100px * var(--vex-zoom)) );",
    );
    expect(block).toContain(
      "--vex-read-w: min(var(--vex-read-span), calc(var(--vex-read-room) - var(--vex-read-x) - 24px));",
    );
  });

  it("never reads her shown or hidden choice: the room is the frame's solve alone", () => {
    expect(shell).not.toMatch(/data-vex-shown[^{]*\{[^}]*--vex-read/);
    expect(shell).not.toMatch(/data-vex-panel[^{]*\{[^}]*--vex-read/);
  });

  it("keeps the band's own line: 24 in and the chat less 48", () => {
    expect(rule(shell, '.vex-shell-frame[data-vex-frame="h3"][data-vex-tier="band"]')).toBe(
      "--vex-read-x: 24px; --vex-read-w: calc(var(--vex-chat-track) - 48px);",
    );
  });
});

describe("her panel's place (section 6.3)", () => {
  it("has no track: she stands in the chat's, the chat running to the right edge", () => {
    expect(rule(shell, '.vex-shell-frame[data-vex-frame="h3"] > .vex-shell-vex')).toBe("grid-column: 2;");
  });

  it("is a box at the chat's top right under the header, 280 wide, as tall as what it holds", () => {
    expect(rule(shell, `${PANEL} > .vex-shell-vex`)).toBe(
      "z-index: 15; display: flex; flex-direction: column; grid-row: 2; justify-self: end; align-self: start; " +
        "width: var(--vex-panel-w); height: auto; " +
        "max-height: calc(100% - max(0px, var(--vex-panel-floor, 0px) - var(--vex-h3-foot)));",
    );
  });

  it("stands over the chat (10) and under the chats panel (19), its scrim (18) and the chats column (20)", () => {
    const z = Number(/z-index: (\d+)/.exec(rule(shell, `${PANEL} > .vex-shell-vex`))?.[1]);
    expect(z).toBeGreaterThan(10);
    expect(z).toBeLessThan(18);
  });

  it("starts under the offline row, as a page does", () => {
    expect(rule(shell, `${PANEL}:has(.vex-shell-centre > .vex-connection-banner) > .vex-shell-vex`)).toBe(
      "margin-top: 40px; max-height: calc(100% - 40px - max(0px, var(--vex-panel-floor, 0px) - var(--vex-h3-foot)));",
    );
  });

  it("runs on to the window's foot where no composer row stands under her: Studio, a page", () => {
    expect(
      rule(
        shell,
        `${PANEL}:has(> .vex-shell-centre :is([data-vex-area="studio-center"], .vex-ov)) > .vex-shell-vex`,
      ),
    ).toBe("grid-row: 2 / -1;");
  });

  it("has no bars cell in the bottom row any more", () => {
    expect(shell).not.toContain(".vex-shell-tagline");
  });
});

describe("her panel's box (sections 6.3 and 6.5)", () => {
  it("is as tall as its body, its foot ruled; hidden it draws no ground and no rule", () => {
    expect(rule(vexSidebar, '.vex-shell-frame[data-vex-frame="h3"] .vex-vs[data-vex-seat="column"]')).toBe(
      "flex: 0 1 auto; height: auto; border-bottom: 1px solid var(--vex-alias-rule-quiet);",
    );
    expect(
      rule(vexSidebar, '.vex-shell-frame[data-vex-frame="h3"] .vex-vs[data-vex-seat="column"][data-vex-shown="false"]'),
    ).toBe("border: 0; background: none;");
  });

  it("ends in her bars, a 48 strip with no words", () => {
    expect(rule(vexSidebar, ".vex-col__bars")).toBe("flex: none; height: 48px; overflow: hidden;");
  });

  it("lets the card give way first: it shrinks to 160 before the body scrolls", () => {
    expect(rule(vexSidebar, ".vex-col__card")).toBe(
      "flex: 0 1 auto; height: calc(var(--vex-d2-vex-w) / 0.78); min-height: 160px;",
    );
    expect(rule(vexSidebar, ".vex-col")).toContain("overflow-y: auto;");
  });

  it("lays a page's strip across the chat's whole track", () => {
    expect(rule(vexSidebar, '.vex-shell-frame[data-vex-frame="h3"][data-vex-seat="strip"] > .vex-shell-vex')).toContain(
      "grid-column: 2 / -1;",
    );
  });
});

describe("what else stands in the chat keeps clear of her (section 6.3)", () => {
  it("a page and Studio's centre keep her room at their right, shown or hidden", () => {
    expect(rule(sheet("overlay.css"), `${PANEL} .vex-shell-centre .vex-ov`)).toBe(
      "padding-right: var(--vex-panel-w);",
    );
    expect(rule(shell, `${PANEL} [data-vex-area="studio-center"]`)).toBe("padding-right: var(--vex-panel-w);");
  });

  it("the slash menu stands in the room; the context panel opens left of her while she shows", () => {
    expect(rule(sheet("composer.css"), `${PANEL} .vex-slash`)).toBe("right: var(--vex-panel-w);");
    expect(
      rule(
        sheet("console.css"),
        '.vex-shell-frame[data-vex-frame="h3"][data-vex-panel="shown"] .vex-composer-strip__context [role="dialog"]',
      ),
    ).toBe("right: var(--vex-panel-w);");
  });

  it("the chat's scrollbar track starts under her panel", () => {
    expect(
      rule(sheet("chat-transcript.css"), `${PANEL} [data-vex-conversation-scroll]::-webkit-scrollbar-track`),
    ).toBe("margin-top: var(--vex-panel-h, 0px);");
  });
});
