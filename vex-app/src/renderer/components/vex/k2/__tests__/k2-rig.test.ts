/**
 * Where K2 stands (`k2-rig.ts`), without a canvas. Regressions this catches: a stage that no longer
 * draws the wide drawing as on its own frame (scale 1 at 900 px, the token at 652 of 900) or lets
 * her scale run past its bounds; a bust that leaves the app drawing, loses its cut under the
 * necklace, its 0.6 scale, its short beam or its token's foot; an approval bust whose cut does not
 * drop for the palm; a host too small for her dots that still draws; and any placement that pushes
 * her hair or her token out of the plate at the sidebar's three widths.
 */
import { describe, expect, test } from "vitest";
import {
  APP,
  beamScreen,
  boxToHost,
  BUST,
  canvasBox,
  DRAWING,
  type Fit,
  fitFor,
  type K2PlacementName,
  TOKEN_SHEET,
  toHost,
} from "../k2-rig.js";

const FLAT_DROP = (TOKEN_SHEET.flatCy - (TOKEN_SHEET.box / 2 - 6)) / TOKEN_SHEET.td;

function fitOf(name: K2PlacementName, w: number, h: number, palm = false): Fit {
  const fit = fitFor(name, w, h, palm);
  if (fit === null) throw new Error(`no fit for ${name} ${w} x ${h}`);
  return fit;
}

function placed(name: K2PlacementName, w: number, h: number, palm = false) {
  const fit = fitOf(name, w, h, palm);
  const R = fit.rig;
  const [tx, ty] = toHost(fit, R.token.x, R.token.y);
  const hairTop = toHost(fit, 0, R.hairTop)[1];
  const foot = toHost(fit, 0, R.tokenFoot)[1];
  const face = boxToHost(fit, R.face);
  // the flat face's centre on her map
  const flatMapY = R.token.y + FLAT_DROP * R.token.d;
  return { fit, R, tx, ty, hairTop, foot, face, flatMapY };
}

describe("the stage", () => {
  test("at 720 x 900 the wide drawing stands as drawn: scale 1, the token at 652 of 900, centred", () => {
    const { fit, R, tx, ty } = placed("stage", 720, 900);
    expect(R.drawing).toBe("wide");
    expect(fit.s).toBe(1);
    expect(R.token).toEqual(DRAWING.token);
    expect(tx).toBeCloseTo(360, 6);
    expect(ty).toBeCloseTo(652, 6);
    expect(R.cut).toBeNull();
    expect(R.beam.top).toBeNull();
    expect(R.shift).toEqual([0, 0]);
  });

  test("her scale follows the plate's height between 0.6 and 1.2", () => {
    expect(fitOf("stage", 720, 1080).s).toBeCloseTo(1.2, 6);
    expect(fitOf("stage", 720, 1400).s).toBe(1.2);
    expect(fitOf("stage", 720, 720).s).toBeCloseTo(0.8, 6);
    expect(fitOf("stage", 720, 300).s).toBe(0.6);
  });

  test("her hair, her figure and her token stay inside the plate", () => {
    for (const h of [720, 900, 1080]) {
      const { fit, hairTop, foot } = placed("stage", 720, h);
      const figure = boxToHost(fit, DRAWING.figure);
      expect(hairTop).toBeGreaterThan(0);
      expect(figure.left).toBeGreaterThan(0);
      expect(figure.right).toBeLessThan(720);
      expect(foot).toBeLessThan(h);
    }
  });
});

describe("the bust", () => {
  test("in the sidebar's 256 x 280 plate: the app drawing at 0.6, cut under her necklace, her face 84 px", () => {
    const { fit, R, face } = placed("sidebar", 256, 280);
    expect(R.drawing).toBe("app");
    expect(fit.s).toBe(BUST.s);
    expect(R.cut?.bottom).toBe(BUST.cut.y);
    expect(R.cut?.band).toBe(BUST.cut.band);
    expect(R.cut?.top(100)).toBe(BUST.cut.y - BUST.cut.band);
    expect(R.token.d).toBeCloseTo(APP.coin * APP.w, 6);
    expect(face.right - face.left).toBeCloseTo(84, 6);
    expect(R.shift).toEqual(APP.shift);
  });

  test("a short beam: the flat face sits half a coin and half its ellipse under the cut", () => {
    const { R, flatMapY } = placed("sidebar", 256, 280);
    const d = R.token.d;
    expect(flatMapY - BUST.cut.y).toBeCloseTo(
      BUST.gap * d + (TOKEN_SHEET.flatRy / 2) * (d / TOKEN_SHEET.td),
      6,
    );
    expect(R.token.x).toBe(APP.w / 2);
    // the beam rises to 10 map px over the top of her dissolve
    expect(R.beam.top).toBe(BUST.cut.y - BUST.cut.band - 10);
  });

  test("the token's foot stands 8 px over the plate's foot, centred (to the whole px)", () => {
    for (const w of [256, 240, 224]) {
      const { foot, tx } = placed("sidebar", w, 280);
      expect(Math.abs(foot - (280 - BUST.padBottom))).toBeLessThanOrEqual(0.5);
      expect(Math.abs(tx - w / 2)).toBeLessThanOrEqual(0.5);
      expect(Number.isInteger(fitOf("sidebar", w, 280).ox)).toBe(true);
    }
  });

  test("her hair keeps its room at the top of the plate at 256, 240 and 224 wide", () => {
    for (const w of [256, 240, 224]) {
      const { hairTop } = placed("sidebar", w, 280);
      expect(hairTop).toBeGreaterThanOrEqual(BUST.padTop - 0.5);
    }
  });

  test("a lower host shrinks her so her hair keeps its room over her", () => {
    const { fit, hairTop } = placed("sidebar", 256, 200);
    expect(fit.s).toBeLessThan(BUST.s);
    expect(Math.abs(hairTop - BUST.padTop)).toBeLessThanOrEqual(0.5);
  });

  test("a host too small for her dots draws nothing", () => {
    expect(fitFor("sidebar", 256, 60)).toBeNull();
    expect(fitFor("welcome", 0, 280)).toBeNull();
    expect(fitFor("stage", 720, 0)).toBeNull();
  });

  test("the welcome's stage is the same bust", () => {
    expect(fitOf("welcome", 284, 284)).toEqual(fitOf("sidebar", 284, 284));
  });

  test("the approval palm drops the cut to 412 through a 44 px dissolve and shrinks her to 0.57", () => {
    const { fit, R, hairTop } = placed("sidebar", 256, 280, true);
    expect(R.palm).toBe(true);
    // the 280 plate is a little low for the palm's taller bust: her hair keeps its room
    expect(fit.s).toBeLessThan(BUST.palmS);
    expect(fit.s).toBeGreaterThan(0.56);
    expect(Math.abs(hairTop - BUST.padTop)).toBeLessThanOrEqual(0.5);
    expect(fitOf("welcome", 284, 300, true).s).toBe(BUST.palmS);
    expect(R.cut?.bottom).toBe(BUST.palmCut.y);
    expect(R.cut?.band).toBe(BUST.palmCut.band);
    // one rig per bust: a fit compares by identity
    expect(fitOf("sidebar", 240, 280, true).rig).toBe(R);
    expect(fitOf("sidebar", 240, 280).rig).not.toBe(R);
    // the stage has no palm cut
    expect(fitOf("stage", 720, 900, true).rig.cut).toBeNull();
  });
});

test("the beam's screen: pitch 5 on the stage, 5 at scale 0.96 on the bust, never under 2.6", () => {
  expect(beamScreen(fitOf("stage", 720, 900))).toEqual({ pitch: 5, rmax: 2.2 });
  const bust = beamScreen(fitOf("sidebar", 256, 280));
  expect(bust.pitch).toBeCloseTo((5 * 0.6) / 0.96, 6);
  expect(bust.rmax).toBeCloseTo(bust.pitch * 0.44, 6);
  expect(beamScreen(fitOf("sidebar", 256, 120)).pitch).toBe(2.6);
});

test("the canvas box follows the fit: the rig's canvas through the same transform", () => {
  const fit = fitOf("sidebar", 256, 280);
  const box = canvasBox(fit);
  const [left, top] = toHost(fit, fit.rig.canvas[0], fit.rig.canvas[1]);
  expect(box.left).toBeCloseTo(left, 6);
  expect(box.top).toBeCloseTo(top, 6);
  expect(box.right - box.left).toBeCloseTo((fit.rig.canvas[2] - fit.rig.canvas[0]) * fit.s, 6);
});
