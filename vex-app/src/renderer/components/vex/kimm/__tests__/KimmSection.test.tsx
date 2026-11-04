/**
 * Kimm's section (`KimmSection`, docs/design/H3-DESKTOP.md sections 1.5, 3
 * and 3.6): the box laid over Vex's column, her figure for her mood, and the
 * corner key. What is pinned here, row by row of the plan (S4-04 on):
 *
 *  - OPEN AND STILL (S4-04): her figure for her mood when its art is there,
 *    her ground alone when it is missing (never another mood's figure, never
 *    a placeholder); the figure is decorative; the corner key is named for
 *    the action and its press writes the choice; its tooltip spells the
 *    chord; the box's geometry is the sheet's (`kimm.css`), never the
 *    column's flow.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KimmArtProvider } from "../kimm-art-context.js";
import { KIMM_SHIPPED_ART, type KimmArtSet } from "../kimm-assets.js";
import { KimmSection } from "../KimmSection.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const KIMM_CSS = readFileSync(
  path.join(here, "..", "..", "..", "..", "styles", "global-css", "kimm.css"),
  "utf8",
);

/** One rule's body in the sheet, comments stripped. */
function rule(selector: string): string {
  const css = KIMM_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) throw new Error(`no rule for ${selector}`);
  return match[1] ?? "";
}

const FIGURE = { src: "/art/kimm/section-offer.webp", width: 860, height: 1206 };

const OFFER_ONLY: KimmArtSet = {
  ...KIMM_SHIPPED_ART,
  sections: { ...KIMM_SHIPPED_ART.sections, offer: { state: "ready", ...FIGURE } },
};

function withArt(art: KimmArtSet, node: ReactNode): ReactNode {
  return <KimmArtProvider art={art}>{node}</KimmArtProvider>;
}

function section(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-vex-area='kimm-section']");
  if (el === null) throw new Error("her section is missing");
  return el;
}

afterEach(cleanup);

describe("KimmSection, open and still (S4-04)", () => {
  it("draws her figure for her mood, decorative, from the art she is handed", () => {
    render(withArt(OFFER_ONLY, <KimmSection mood="offer" onOpenChange={() => undefined} />));
    const figure = section().querySelector<HTMLImageElement>(".vex-kimm__figure");
    expect(figure?.getAttribute("src")).toBe(FIGURE.src);
    expect(figure?.getAttribute("alt")).toBe("");
    expect(figure?.closest("[aria-hidden='true']")).not.toBeNull();
    expect(section().getAttribute("data-kimm-art")).toBe("ready");
    expect(section().getAttribute("data-kimm-mood")).toBe("offer");
  });

  it("shows her ground alone for a mood whose art is missing: never another mood's figure", () => {
    render(withArt(OFFER_ONLY, <KimmSection mood="think" onOpenChange={() => undefined} />));
    expect(section().querySelector(".vex-kimm__ground")).not.toBeNull();
    expect(section().querySelector("img")).toBeNull();
    expect(section().getAttribute("data-kimm-art")).toBe("missing");
  });

  it("draws no figure at all from the art as the app ships it today", () => {
    render(<KimmSection mood="hi" onOpenChange={() => undefined} />);
    expect(section().querySelector("img")).toBeNull();
  });

  it("names her corner key for the action, spells the chord, and writes the choice", () => {
    const onOpenChange = vi.fn();
    render(
      <KimmSection
        mood="hi"
        onOpenChange={onOpenChange}
        shortcut={{ label: "Ctrl+Shift+B", aria: "Control+Shift+B" }}
      />,
    );
    const key = screen.getByRole("button", { name: "Hide Vex" });
    expect(key.getAttribute("title")).toBe("Hide Vex (Ctrl+Shift+B)");
    expect(key.getAttribute("aria-keyshortcuts")).toBe("Control+Shift+B");
    fireEvent.click(key);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("is a box laid over the column, out of its flow, sized by the window alone", () => {
    const box = rule(".vex-kimm");
    expect(box).toMatch(/position:\s*absolute/);
    expect(box).toMatch(/top:\s*var\(--vex-kimm-top\)/);
    expect(box).toMatch(/--vex-kimm-top:\s*148px/);
    expect(box).toMatch(/bottom:\s*1px/);
    expect(box).toMatch(/left:\s*0/);
    expect(box).toMatch(/right:\s*0/);
    // Nothing in her box is sized by her state: no width, height or margin.
    expect(box).not.toMatch(/(?:^|[\s;])(?:width|height|margin)[^-]/);
  });

  it("keeps her corner key a 56-high cell in her top right", () => {
    const key = rule(".vex-kimm__key");
    expect(key).toMatch(/top:\s*0/);
    expect(key).toMatch(/right:\s*0/);
    expect(key).toMatch(/height:\s*var\(--vex-h3-strip-h\)/);
    expect(key).toMatch(/width:\s*138px/);
  });
});
