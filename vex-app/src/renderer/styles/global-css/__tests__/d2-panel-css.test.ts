/**
 * D2'S PANEL as CSS text (docs/design/H3-DESKTOP.md sections 6.3, 6.5 and
 * 6.6; owner decision 2026-11-10, "the chat takes that space"). Vex has no
 * track in the shell's frame: her panel is a box over the chat's top right,
 * as tall as what it holds, and everything readable in the chat stands in
 * the room left of it. Pinned here:
 *
 *   1. the conversation column is centred and wide in the chat less her
 *      panel's room, and that room is the frame's `--vex-panel-w`, never her
 *      shown choice;
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

/**
 * The conversation column's rule (owner decision 2026-11-10: "a central wide
 * space for the chat"), as the sheet states it, in numbers: centred in the
 * room (the chat less her panel's room), the room less a gutter each side
 * (40 x zoom from 1280 up, 24 under it), capped at 1120 x zoom.
 */
function column(chat: number, panel: number, zoom: number, wide: boolean): { x: number; w: number } {
  const room = chat - panel;
  const gutter = wide ? 40 * zoom : 24;
  const w = Math.max(0, Math.min(1120 * zoom, room - 2 * gutter));
  return { x: (room - w) / 2, w };
}

describe("the conversation column fills the centre of the room (section 6.6)", () => {
  it("is centred in the chat less her panel's room, the room less two gutters, capped at 1120 x zoom", () => {
    const reading = shell.slice(shell.indexOf("--vex-read-room"));
    expect(reading).toMatch(/^--vex-read-room: calc\(var\(--vex-chat-track\) - var\(--vex-panel-w, 0px\)\);/);
    const block = reading.slice(0, reading.indexOf("}")).replace(/\s+/g, " ");
    expect(block).toContain("--vex-read-gutter: 24px;");
    expect(block).toContain("--vex-read-cap: calc(1120px * var(--vex-zoom));");
    expect(block).toContain(
      "--vex-read-w: max(0px, min(var(--vex-read-cap), calc(var(--vex-read-room) - 2 * var(--vex-read-gutter))));",
    );
    expect(block).toContain("--vex-read-x: calc((var(--vex-read-room) - var(--vex-read-w)) / 2);");
    // The left-anchored 712 column is gone.
    expect(shell).not.toContain("--vex-read-span");
  });

  it("takes the 40 x zoom gutter from 1280 up (the wide tier) and 24 under it, the band included", () => {
    expect(rule(shell, '.vex-shell-frame[data-vex-frame="h3"][data-vex-tier="wide"]')).toBe(
      "--vex-read-gutter: calc(40px * var(--vex-zoom));",
    );
    // No band rule of its own: under 1024 she has no panel (0), so the rule
    // above gives 24 and the chat less 48, centred.
    expect(shell).not.toContain('.vex-shell-frame[data-vex-frame="h3"][data-vex-tier="band"] {');
  });

  it("reads the plates' numbers: 40 and 832 at 1440, 40 and 672 at 1280, 24 and 620 at 1024, the band's 24", () => {
    expect(column(1192, 280, 1, true)).toEqual({ x: 40, w: 832 });
    expect(column(1032, 280, 1, true)).toEqual({ x: 40, w: 672 });
    expect(column(948, 280, 1, false)).toEqual({ x: 24, w: 620 });
    expect(column(924, 0, 1, false)).toEqual({ x: 24, w: 876 });
    // The owner's 2000 window: the cap, centred.
    const owner = column(2000 - 248, 280, 2000 / 1760, true);
    expect(owner.w).toBeCloseTo(1272.7, 1);
    expect(owner.x).toBeCloseTo(99.6, 1);
  });

  it("never reads her shown or hidden choice: the room is the frame's solve alone", () => {
    expect(shell).not.toMatch(/data-vex-shown[^{]*\{[^}]*--vex-read/);
    expect(shell).not.toMatch(/data-vex-panel[^{]*\{[^}]*--vex-read/);
  });

  it("stands the card and the approvals stack on the column's width, no wider", () => {
    expect(
      rule(
        sheet("chat-transcript.css"),
        '.vex-shell-frame[data-vex-frame="h3"] .vex-shell-centre [data-vex-area="approvals-region"]',
      ),
    ).toBe("margin-inline: 0;");
  });

});

/** A sheet with its whitespace collapsed, for selectors written over lines. */
const flat = (name: string): string => sheet(name).replace(/\s+/g, " ");
const SHELL_DOCK =
  '[data-vex-area="session-panel"][data-vex-session-surface="shell"] [data-vex-composer-dock]';

describe("the composer is a framed box on the column (section 6.5; owner decision 2026-11-10)", () => {
  it("stands the dock on the conversation column: the reading column's x, width and zoom", () => {
    // The dock is a `.vex-reading-col` (SessionPanel), so the column's rule
    // places it, as it places the transcript.
    expect(rule(sheet("chat-transcript.css"), '.vex-shell-frame[data-vex-frame="h3"] .vex-shell-centre .vex-reading-col')).toBe(
      "zoom: var(--vex-zoom); width: calc(var(--vex-read-w) / var(--vex-zoom)); margin-inline: calc(var(--vex-read-x) / var(--vex-zoom)) 0;",
    );
    // No rule of the dock's own runs it across the chat any more.
    expect(rule(flat("composer.css"), `.vex-shell-frame[data-vex-frame="h3"] ${SHELL_DOCK}`)).toBe(
      "align-self: flex-start; max-width: none; padding: 0 0 16px;",
    );
  });

  it("lifts the box 24 off the window's foot from 1280 up, 16 under it, and 16 from the chat's sides under 1024", () => {
    expect(rule(flat("composer.css"), `.vex-shell-frame[data-vex-frame="h3"][data-vex-tier="wide"] ${SHELL_DOCK}`)).toBe(
      "padding-bottom: 24px;",
    );
    expect(rule(flat("composer.css"), `.vex-shell-frame[data-vex-frame="h3"][data-vex-tier="band"] ${SHELL_DOCK}`)).toBe(
      "width: calc(var(--vex-chat-track) - 32px); margin-inline: 16px 0;",
    );
  });

  it("sits the live-step row and the queue on the box's top rule, in its chosen rule", () => {
    expect(
      rule(
        flat("composer.css"),
        '.vex-shell-frame[data-vex-frame="h3"] [data-vex-composer-dock] :is([data-vex-area="composer-mission-strip"] > .border-rule, [data-vex-area="composer-queue-dock"])',
      ),
    ).toBe("border-color: var(--vex-alias-rule-chosen);");
    // The old full-width rule that stood its words on the column is gone.
    expect(sheet("composer.css")).not.toContain('[data-vex-area="composer-mission-strip"] > :last-child');
  });
});

describe("the docked approval band takes the box's seat (section 6.5; owner decision 2026-11-10)", () => {
  const SHELL = '.vex-shell-frame[data-vex-frame="h3"] [data-vex-session-surface="shell"]';
  const approval = sheet("approval.css");

  it("stands its dock on the conversation column, zoomed as the column is, lifted as the box is", () => {
    expect(rule(approval, `${SHELL} .vex-appr-dock`)).toBe(
      "align-self: flex-start; width: calc(var(--vex-read-w) / var(--vex-zoom)); " +
        "margin-inline: calc(var(--vex-read-x) / var(--vex-zoom)) 0; padding-bottom: 16px;",
    );
    expect(rule(sheet("chat-transcript.css"), '.vex-shell-frame[data-vex-frame="h3"] .vex-shell-centre .vex-appr-dock')).toBe(
      "zoom: var(--vex-zoom);",
    );
    expect(
      rule(approval, '.vex-shell-frame[data-vex-frame="h3"][data-vex-tier="wide"] [data-vex-session-surface="shell"] .vex-appr-dock'),
    ).toBe("padding-bottom: 24px;");
    expect(
      rule(approval, '.vex-shell-frame[data-vex-frame="h3"][data-vex-tier="band"] [data-vex-session-surface="shell"] .vex-appr-dock'),
    ).toBe("width: calc(var(--vex-chat-track) - 32px); margin-inline: 16px 0;");
  });

  it("frames the band as the box: the card ground in the chosen rule, the decision row the box's 56", () => {
    expect(rule(approval, `${SHELL} .vex-appr__foot[data-docked]`)).toBe(
      "background: var(--vex-alias-card); border: 1px solid var(--vex-alias-rule-chosen);",
    );
    expect(rule(approval, `${SHELL} .vex-appr__foot[data-docked] > .vex-appr__reason-row`)).toBe("background: transparent;");
    expect(rule(approval, `${SHELL} .vex-appr__foot[data-docked] > button`)).toBe("height: 56px;");
    // The reason field on top, then the clip cue's place and the decision row:
    // the grid of the docked row is unchanged.
    expect(rule(approval, ".vex-appr__foot[data-docked]")).toContain(
      'grid-template-areas: "reason reason reason" "fail fail fail" "reject gate approve";',
    );
  });

  it("lays the clip cue over the box's top rule, its sides continuing the frame", () => {
    expect(rule(approval, `${SHELL} .vex-appr__foot[data-docked] > .vex-appr__more-cue`)).toBe(
      "right: -1px; bottom: calc(100% + 1px); left: -1px; border-inline: 1px solid var(--vex-alias-rule-chosen); " +
        "border-top-color: var(--vex-alias-rule-chosen);",
    );
  });

  it("leaves the desk chat's dock alone: the dock's own rule and the docked row's keys are as before", () => {
    expect(rule(approval, ".vex-appr-dock")).toBe("--vex-appr-inset: 24px; container-type: inline-size;");
    expect(rule(approval, ".vex-appr__foot[data-docked] > button")).toContain("height: var(--vex-h3-bottom-h);");
    expect(rule(approval, ".vex-appr__foot[data-docked]")).toContain("background: var(--vex-alias-bg-base);");
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

  it("the slash menu and the context panel rise from the box on the column, never under her", () => {
    // The box stands on the conversation column, which ends where her room
    // starts (section 6.6): neither needs a rule of her panel's width.
    expect(sheet("composer.css")).not.toContain(`${PANEL} .vex-slash`);
    expect(rule(sheet("composer.css"), ".vex-composer-box > .vex-slash")).toBe(
      "right: -1px; bottom: calc(100% + 1px); left: -1px; border-inline: 1px solid var(--vex-alias-rule-chosen);",
    );
    expect(sheet("console.css")).not.toContain('[data-vex-panel="shown"] .vex-composer-strip__context');
  });

  it("the chat's scrollbar track starts under her panel", () => {
    expect(
      rule(sheet("chat-transcript.css"), `${PANEL} [data-vex-conversation-scroll]::-webkit-scrollbar-track`),
    ).toBe("margin-top: var(--vex-panel-h, 0px);");
  });
});
