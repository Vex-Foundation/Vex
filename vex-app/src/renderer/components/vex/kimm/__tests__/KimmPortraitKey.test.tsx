/**
 * Her portrait in the Vex key (`KimmPortraitKey`, docs/design/H3-DESKTOP.md
 * section 1.6, plan row S4-03): closed, her mood's cell of the key's sprite,
 * scaled so the cell fills the box; open, the fold glyph whatever her art;
 * with no art, the fallback the key passes and never a placeholder face; it
 * follows her mood, and every Vex state reaches a mood her sprite draws.
 */

import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { kimmMoodOf } from "../../../../features/vex/kimm-mood.js";
import { VEX_STATES } from "../../../../features/vex/vex-state.js";
import { KimmArtProvider } from "../kimm-art-context.js";
import {
  KIMM_MOODS,
  KIMM_SHIPPED_ART,
  type KimmArtSet,
  type KimmMood,
  type KimmPixelBox,
} from "../kimm-assets.js";
import { KIMM_KEY_CELL_PX, KimmPortraitKey } from "../KimmPortraitKey.js";

/** A sprite of six 100 x 120 cells in one row, the shape her real sheet may take. */
const CELL_W = 100;
const CELL_H = 120;
const SHEET = { src: "/art/kimm/key-moods.webp", width: CELL_W * 6, height: CELL_H };

function cellOf(mood: KimmMood): KimmPixelBox {
  const i = KIMM_MOODS.indexOf(mood);
  return [i * CELL_W, 0, (i + 1) * CELL_W, CELL_H];
}

const READY: KimmArtSet = {
  ...KIMM_SHIPPED_ART,
  portraits: {
    hi: { state: "ready", sheet: SHEET, cell: cellOf("hi") },
    think: { state: "ready", sheet: SHEET, cell: cellOf("think") },
    offer: { state: "ready", sheet: SHEET, cell: cellOf("offer") },
    held: { state: "ready", sheet: SHEET, cell: cellOf("held") },
    refused: { state: "ready", sheet: SHEET, cell: cellOf("refused") },
    rest: { state: "ready", sheet: SHEET, cell: cellOf("rest") },
  },
};

function withArt(art: KimmArtSet, node: ReactNode): ReactNode {
  return <KimmArtProvider art={art}>{node}</KimmArtProvider>;
}

function cell(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-vex-area='kimm-portrait-key']");
  if (el === null) throw new Error("portrait cell missing");
  return el;
}

afterEach(cleanup);

describe("KimmPortraitKey", () => {
  it("is the key's 76px portrait cell, decorative: the key's name is the action", () => {
    const { container } = render(withArt(READY, <KimmPortraitKey mood="hi" open={false} />));
    const el = cell(container);
    expect(KIMM_KEY_CELL_PX).toBe(76);
    expect(el.style.width).toBe("76px");
    expect(el.style.height).toBe("76px");
    expect(el.getAttribute("aria-hidden")).toBe("true");
  });

  it("closed, draws her mood's cell scaled to fill the box from the sheet", () => {
    const { container } = render(withArt(READY, <KimmPortraitKey mood="offer" open={false} />));
    const img = cell(container).querySelector("img");
    expect(img?.getAttribute("src")).toBe(SHEET.src);
    // offer is the third cell: 200..300 across, scaled 76/100 and 76/120.
    expect(parseFloat(img?.style.width ?? "")).toBeCloseTo(600 * 0.76);
    expect(parseFloat(img?.style.height ?? "")).toBeCloseTo(120 * (76 / 120));
    expect(parseFloat(img?.style.left ?? "")).toBeCloseTo(-200 * 0.76);
    expect(parseFloat(img?.style.top ?? "")).toBeCloseTo(0);
    expect(cell(container).getAttribute("data-kimm-mood")).toBe("offer");
  });

  it("follows the mood: a new mood is a new cell on the same sheet", () => {
    const view = render(withArt(READY, <KimmPortraitKey mood="hi" open={false} />));
    const leftOf = (): number =>
      parseFloat(cell(view.container).querySelector("img")?.style.left ?? "NaN");
    expect(leftOf()).toBeCloseTo(0);
    view.rerender(withArt(READY, <KimmPortraitKey mood="rest" open={false} />));
    expect(leftOf()).toBeCloseTo(-500 * 0.76);
    expect(cell(view.container).querySelector("img")?.getAttribute("src")).toBe(SHEET.src);
  });

  it("scales to the size the key gives it", () => {
    const { container } = render(
      withArt(READY, <KimmPortraitKey mood="think" open={false} size={22} />),
    );
    const img = cell(container).querySelector("img");
    expect(cell(container).style.width).toBe("22px");
    expect(parseFloat(img?.style.left ?? "")).toBeCloseTo(-100 * 0.22);
  });

  it("open, shows the fold glyph whatever her art, and none of her face", () => {
    for (const art of [READY, KIMM_SHIPPED_ART]) {
      const { container, unmount } = render(
        withArt(art, <KimmPortraitKey mood="hi" open fallback={<i data-token="" />} />),
      );
      const el = cell(container);
      expect(el.getAttribute("data-kimm-key")).toBe("open");
      expect(el.querySelector("svg")).not.toBeNull();
      expect(el.querySelector("img")).toBeNull();
      expect(el.querySelector("[data-token]")).toBeNull();
      unmount();
    }
  });

  it("closed with no art, shows the key's fallback and never a placeholder face", () => {
    const { container } = render(
      <KimmPortraitKey mood="hi" open={false} fallback={<i data-token="" />} />,
    );
    const el = cell(container);
    expect(el.getAttribute("data-kimm-art")).toBe("missing");
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("[data-token]")).not.toBeNull();
  });

  it("closed with no art and no fallback, draws nothing", () => {
    const { container } = render(<KimmPortraitKey mood="refused" open={false} />);
    expect(cell(container).childElementCount).toBe(0);
  });

  it("reaches a drawn cell for every Vex state", () => {
    for (const state of VEX_STATES) {
      const { container, unmount } = render(
        withArt(READY, <KimmPortraitKey mood={kimmMoodOf(state)} open={false} />),
      );
      expect(cell(container).getAttribute("data-kimm-art"), state).toBe("ready");
      unmount();
    }
  });
});
