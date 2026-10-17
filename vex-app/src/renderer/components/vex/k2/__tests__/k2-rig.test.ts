/**
 * Where K2 stands (`k2-rig.ts`), without a canvas. Regressions this catches: a stage that no longer
 * draws her as on her own frame (scale 1 at 900 px, the token at 652 of 900) or lets her scale run
 * past its bounds; a fit that does not land the token on the placement's anchor; a bust that loses
 * its cut, its 0.6 scale, its short beam or its token's foot; and any placement that pushes her
 * hair, her figure or her token out of the plate at the sidebar's three widths.
 */
import { describe, expect, test } from "vitest";
import {
  boxToHost,
  BUST,
  canvasBox,
  DRAWING,
  fitOf,
  type K2PlacementName,
  placementFor,
  TOKEN_SHEET,
  toHost,
} from "../k2-rig.js";

const FLAT_DROP = (TOKEN_SHEET.flatCy - (TOKEN_SHEET.box / 2 - 6)) / TOKEN_SHEET.td;

function placed(name: K2PlacementName, w: number, h: number) {
  const p = placementFor(name, w, h);
  const fit = fitOf(name, p);
  const [tx, ty] = toHost(fit, fit.token.x, fit.token.y);
  const hairTop = toHost(fit, 0, DRAWING.hairTop)[1];
  const figure = boxToHost(fit, DRAWING.figure);
  const face = boxToHost(fit, DRAWING.face);
  // the flat face's centre on her map, and in the host
  const flatMapY = fit.token.y + FLAT_DROP * fit.token.d;
  const flatY = toHost(fit, 0, flatMapY)[1];
  return { p, fit, tx, ty, hairTop, figure, face, flatMapY, flatY };
}

describe("the stage", () => {
  test("at 720 x 900 she stands as drawn: scale 1, the token at 652 of 900, centred", () => {
    const { p, fit, tx, ty } = placed("stage", 720, 900);
    expect(p.s).toBe(1);
    expect(p.D).toBe(DRAWING.token.d);
    expect(p.ax).toBe(360);
    expect(p.ay).toBeCloseTo(652, 6);
    expect(tx).toBeCloseTo(360, 6);
    expect(ty).toBeCloseTo(652, 6);
    expect(fit.token).toEqual(DRAWING.token);
    expect(fit.cut).toBeNull();
  });

  test("her scale follows the plate's height between 0.6 and 1.2", () => {
    expect(placementFor("stage", 720, 1080).s).toBeCloseTo(1.2, 6);
    expect(placementFor("stage", 720, 1400).s).toBe(1.2);
    expect(placementFor("stage", 720, 720).s).toBeCloseTo(0.8, 6);
    expect(placementFor("stage", 720, 300).s).toBe(0.6);
  });

  test("the token keeps the drawing's diameter on her map at every scale", () => {
    for (const h of [720, 900, 1080]) {
      const { fit } = placed("stage", 720, h);
      expect(fit.token.d).toBeCloseTo(DRAWING.token.d, 6);
    }
  });

  test("her hair, her figure and her token stay inside the plate", () => {
    for (const [w, h] of [
      [720, 720],
      [720, 900],
      [720, 1080],
    ] as const) {
      const { hairTop, figure, fit } = placed("stage", w, h);
      expect(hairTop).toBeGreaterThan(0);
      expect(figure.left).toBeGreaterThan(0);
      expect(figure.right).toBeLessThan(w);
      expect(toHost(fit, 0, DRAWING.tokenFoot)[1]).toBeLessThan(h);
    }
  });
});

describe("the bust", () => {
  test("in the sidebar's 256 x 280 plate: scale 0.6, cut under her necklace, her face about 86 px", () => {
    const { p, fit, face } = placed("sidebar", 256, 280);
    expect(p.s).toBe(BUST.s);
    expect(fit.cut).toEqual(BUST.cut);
    expect(fit.token.d).toBeCloseTo(BUST.coin, 6);
    expect(p.D).toBeCloseTo(BUST.coin * BUST.s, 6);
    expect(face.right - face.left).toBeCloseTo(86.4, 6);
  });

  test("a short beam: the flat face sits half a coin and half its ellipse under the cut", () => {
    const { fit, flatMapY } = placed("sidebar", 256, 280);
    const d = fit.token.d;
    expect(flatMapY - BUST.cut.y).toBeCloseTo(
      BUST.gap * d + (TOKEN_SHEET.flatRy / 2) * (d / TOKEN_SHEET.td),
      6,
    );
    expect(fit.token.x).toBe(BUST.x);
  });

  test("the token's foot stands 8 px over the plate's foot, centred", () => {
    for (const w of [256, 240, 224]) {
      const { p, flatY, tx } = placed("sidebar", w, 280);
      expect(flatY + BUST.foot * p.D).toBeCloseTo(280 - BUST.air, 6);
      expect(tx).toBeCloseTo(w / 2, 6);
    }
  });

  test("her hair, her figure and her token stay inside the plate at 256, 240 and 224 wide", () => {
    for (const w of [256, 240, 224]) {
      const { hairTop, figure } = placed("sidebar", w, 280);
      expect(hairTop).toBeGreaterThanOrEqual(BUST.top);
      expect(figure.left).toBeGreaterThan(0);
      expect(figure.right).toBeLessThan(w);
    }
  });

  test("a lower host shrinks her so her hair keeps its room over her", () => {
    const { p, hairTop } = placed("sidebar", 256, 200);
    expect(p.s).toBeLessThan(BUST.s);
    expect(hairTop).toBeCloseTo(BUST.top, 6);
  });

  test("the welcome's stage is the same bust", () => {
    const side = placed("sidebar", 284, 284);
    const welcome = placed("welcome", 284, 284);
    expect(welcome.p).toEqual(side.p);
    expect(welcome.fit).toEqual(side.fit);
  });
});

test("the canvas box follows the fit: her drawing's canvas through the same transform", () => {
  const { fit } = placed("sidebar", 256, 280);
  const box = canvasBox(fit);
  const [left, top] = toHost(fit, DRAWING.canvas[0], DRAWING.canvas[1]);
  expect(box.left).toBeCloseTo(left, 6);
  expect(box.top).toBeCloseTo(top, 6);
  expect(box.right - box.left).toBeCloseTo((DRAWING.canvas[2] - DRAWING.canvas[0]) * fit.s, 6);
});
