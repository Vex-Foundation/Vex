/**
 * Her panel on the lock screen (`KimmPanel.tsx`, docs/design/H3-DESKTOP.md
 * section 4.13): her glyph field over the tall baked frame, her still for the
 * mood only while her figure stands, never another mood's figure where a
 * file is missing, and nothing in it to focus or press.
 *
 * jsdom paints no canvas, so her live field draws nothing here; its box is
 * still mounted and reports whether it would run.
 */

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KimmArtProvider } from "../kimm-art-context.js";
import { KIMM_SHIPPED_ART, type KimmArt, type KimmArtSet } from "../kimm-assets.js";
import { KimmPanel } from "../KimmPanel.js";

const MISSING: KimmArt = { state: "missing", file: "art/kimm/absent.webp" };

function panelOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-vex-area='kimm-panel']");
  if (el === null) throw new Error("her panel is missing");
  return el;
}

afterEach(() => {
  cleanup();
});

describe("KimmPanel", () => {
  it("stands her still for the mood on her field, decorative", () => {
    const { container } = render(<KimmPanel mood="hi" figure />);
    const panel = panelOf(container);
    expect(panel.getAttribute("aria-hidden")).toBe("true");
    expect(panel.getAttribute("data-kimm-mood")).toBe("hi");
    expect(panel.getAttribute("data-kimm-figure")).toBe("shown");
    const figure = panel.querySelector("img.vex-kimm-panel__figure");
    expect(figure?.getAttribute("src")).toBe("/art/kimm/still-hi.webp");
    expect(figure?.getAttribute("alt")).toBe("");
    expect(panel.querySelector("[data-vex-area='kimm-field']")).not.toBeNull();
    expect(panel.querySelector(".vex-kimm-panel__ground")).not.toBeNull();
    expect(panel.style.getPropertyValue("--vex-kimm-baked-wide")).toBe(
      'url("/art/kimm/field-still-wide.webp")',
    );
    expect(panel.querySelector("button, a, input, [tabindex]")).toBeNull();
  });

  it("stands as D2's portrait card in the card seat, its field holding on a page", () => {
    // docs/design/H3-DESKTOP.md section 6.3: the top of Vex's column.
    const view = render(<KimmPanel mood="think" figure seat="card" />);
    const panel = panelOf(view.container);
    expect(panel.getAttribute("data-kimm-seat")).toBe("card");
    expect(panel.classList.contains("vex-kimm-panel--card")).toBe(true);
    expect(panel.querySelector("img.vex-kimm-panel__figure")?.getAttribute("src")).toBe("/art/kimm/still-think.webp");
    view.rerender(<KimmPanel mood="think" figure seat="card" hold />);
    // Held, her figure stands and the field keeps one frame.
    expect(panel.querySelector("img")).not.toBeNull();
    expect(panel.querySelector("[data-vex-area='kimm-field']")?.getAttribute("data-kimm-field-running")).toBe("false");
  });

  it("is the lock screen's panel by default", () => {
    const { container } = render(<KimmPanel mood="hi" figure />);
    expect(panelOf(container).getAttribute("data-kimm-seat")).toBe("lock");
    expect(panelOf(container).classList.contains("vex-kimm-panel--card")).toBe(false);
  });

  it("keeps the field without her figure when her figure is hidden", () => {
    const { container } = render(<KimmPanel mood="rest" figure={false} />);
    const panel = panelOf(container);
    expect(panel.getAttribute("data-kimm-figure")).toBe("hidden");
    expect(panel.querySelector("img")).toBeNull();
    const field = panel.querySelector("[data-vex-area='kimm-field']");
    expect(field).not.toBeNull();
    expect(field?.getAttribute("data-kimm-field-running")).toBe("false");
  });

  it("draws the field alone for a mood whose still is missing, never another mood's figure", () => {
    const art: KimmArtSet = {
      ...KIMM_SHIPPED_ART,
      sections: { ...KIMM_SHIPPED_ART.sections, rest: MISSING },
    };
    const { container } = render(
      <KimmArtProvider art={art}>
        <KimmPanel mood="rest" figure />
      </KimmArtProvider>,
    );
    const panel = panelOf(container);
    expect(panel.getAttribute("data-kimm-art")).toBe("missing");
    expect(panel.querySelector("img")).toBeNull();
    expect(panel.querySelector("[data-vex-area='kimm-field']")).not.toBeNull();
  });
});
