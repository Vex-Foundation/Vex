/**
 * Where K2 stands (`k2-rig.ts`), without a canvas. Regressions this catches: a stage that no longer
 * draws the wide drawing as on its own frame (scale 1 at 900 px, anchored at 652 of 900), loses the
 * wake still's token (97.5 px, its foot at 776 of 900) or lets her scale run past its bounds; a bust that leaves the app drawing, loses its cut under the
 * necklace, its 0.6 scale, its short beam or its token's foot; an approval bust whose cut does not
 * drop for the palm; a host too small for her dots that still draws; any placement that pushes
 * her hair or her token out of the plate at the sidebar's three widths; and an upright coin (the
 * token toggle's rest) off the token's place, cut by the canvas, the host or the welcome's stage,
 * outside its button's box, or (on the welcome) no larger than the flat token.
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
  STAGE_TOKEN,
  STAND_BOB,
  STAND_DROP,
  TOKEN_SHEET,
  tokenBox,
  tokenFlat,
  tokenStand,
  tokenStandInk,
  toHost,
  UPRIGHT_INK,
  WELCOME_STAND_SCALE,
} from "../k2-rig.js";
import { LIFT } from "../k2-token.js";

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
  test("at 720 x 900 the wide drawing stands as drawn: scale 1, anchored at 652 of 900, centred", () => {
    const { fit, R, tx } = placed("stage", 720, 900);
    expect(R.drawing).toBe("wide");
    expect(fit.s).toBe(1);
    expect(fit.ox).toBeCloseTo(360 - DRAWING.token.x, 6);
    expect(fit.oy).toBeCloseTo(0, 6);
    expect(tx).toBeCloseTo(360, 6);
    expect(R.cut).toBeNull();
    expect(R.beam.top).toBeNull();
    expect(R.shift).toEqual([0, 0]);
  });

  test("the token stands where the wake still puts it: 97.5 px, the flat face at 743, the foot at 776", () => {
    const { fit, R, ty, foot, flatMapY } = placed("stage", 720, 900);
    expect(R.token).toEqual({ x: STAGE_TOKEN.x, y: STAGE_TOKEN.y, d: STAGE_TOKEN.d });
    expect(R.token.d * fit.s).toBeCloseTo(APP.coin * APP.w, 6);
    expect(R.token.d * fit.s).toBeCloseTo(97.5, 6);
    expect(toHost(fit, 0, flatMapY)[1]).toBeCloseTo(742.85, 2);
    expect(foot).toBeCloseTo(776, 6);
    expect(ty).toBeLessThan(foot);
    // the canvas reaches under the token's foot
    expect(canvasBox(fit).bottom).toBeGreaterThan(foot);
    // a lower plate scales the whole composition with her
    const low = placed("stage", 720, 720);
    expect(low.foot).toBeCloseTo(776 * 0.8, 6);
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

  test("the welcome's stage is the same bust; only its upright coin (and the canvas reaching it) differ", () => {
    const welcome = fitOf("welcome", 284, 284);
    const sidebar = fitOf("sidebar", 284, 284);
    expect(welcome.s).toBe(sidebar.s);
    expect(welcome.ox).toBe(sidebar.ox);
    expect(welcome.oy).toBe(sidebar.oy);
    const { stand: ws, canvas: wc, cut: wCut, ...wRest } = welcome.rig;
    const { stand: ss, canvas: sc, cut: sCut, ...sRest } = sidebar.rig;
    expect(wRest).toEqual(sRest);
    // the cut's top is a function per rig: compare what it gives
    const { top: wTop, ...wCutRest } = wCut ?? { top: () => -1 };
    const { top: sTop, ...sCutRest } = sCut ?? { top: () => -2 };
    expect(wCutRest).toEqual(sCutRest);
    expect(wTop(0)).toBe(sTop(0));
    expect(ws.scale).toBeGreaterThan(ss.scale);
    expect(wc.slice(0, 3)).toEqual(sc.slice(0, 3));
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

describe("the token toggle's coin", () => {
  const FITS: readonly [K2PlacementName, number, number][] = [
    ["welcome", 320, 284],
    ["welcome", 280, 268],
    ["welcome", 320, 240],
    ["sidebar", 256, 280],
    ["sidebar", 224, 236],
    ["stage", 720, 900],
  ];

  test("the upright coin stands face on at the token's place, its foot near the flat coin's, inside the button's box", () => {
    for (const [name, w, h] of FITS) {
      const f = fitOf(name, w, h);
      const t = f.rig.token;
      const sd = t.d * f.rig.stand.scale;
      const up = tokenStand(f);
      const ink = tokenStandInk(f);
      const flat = tokenFlat(f);
      const [cx] = toHost(f, t.x, t.y);
      expect((up.left + up.right) / 2).toBeCloseTo(cx, 5);
      expect(up.right - up.left).toBeCloseTo(sd * f.s, 5);
      expect(up.bottom - up.top).toBeCloseTo(sd * f.s, 5);
      const [, cy] = toHost(f, t.x, t.y + sd * f.rig.stand.drop);
      expect((up.top + up.bottom) / 2).toBeCloseTo(cy, 5);
      // its foot within a quarter of the coin of the flat coin's foot
      expect(Math.abs(up.bottom - flat.bottom)).toBeLessThanOrEqual(sd * f.s * 0.25);
      // what it draws (rim, lift, bob) holds the disc
      expect(ink.left).toBeLessThanOrEqual(up.left);
      expect(ink.top).toBeLessThanOrEqual(up.top);
      expect(ink.right).toBeGreaterThanOrEqual(up.right);
      expect(ink.bottom).toBeGreaterThanOrEqual(up.bottom);
      const box = tokenBox(f);
      expect(box.left).toBeLessThanOrEqual(Math.min(ink.left, flat.left));
      expect(box.top).toBeLessThanOrEqual(Math.min(ink.top, flat.top));
      expect(box.right).toBeGreaterThanOrEqual(Math.max(ink.right, flat.right));
      expect(box.bottom).toBeGreaterThanOrEqual(Math.max(ink.bottom, flat.bottom));
    }
  });

  test("the canvas reaches the upright coin's foot, and the bust's coin stays inside its host", () => {
    for (const [name, w, h] of FITS) {
      const f = fitOf(name, w, h);
      const up = tokenStand(f);
      expect(canvasBox(f).bottom).toBeGreaterThanOrEqual(up.bottom - 1e-9);
      if (name !== "stage") {
        expect(up.bottom).toBeLessThanOrEqual(h + 0.5);
        expect(up.top).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("the sidebar and the stage keep the flat token's size and the wake's drop", () => {
    for (const name of ["sidebar", "stage"] as const) {
      const f = name === "stage" ? fitOf(name, 720, 900) : fitOf(name, 256, 280);
      expect(f.rig.stand).toEqual({ scale: 1, drop: STAND_DROP });
    }
  });

  test("the welcome's upright coin is one and a half coins across (the owner: clearly larger)", () => {
    for (const palm of [false, true]) {
      const f = fitOf("welcome", 320, 284, palm);
      expect(f.rig.stand.scale).toBe(WELCOME_STAND_SCALE);
      expect(WELCOME_STAND_SCALE).toBeGreaterThanOrEqual(1.5);
      const up = tokenStand(f);
      const flat = tokenFlat(f);
      expect(up.right - up.left).toBeCloseTo((flat.right - flat.left) * 1.5, 5);
      // about 88 px across on the full stage (the flat token is about 58; 83 with the palm's 0.57)
      expect(up.right - up.left).toBeGreaterThan(palm ? 80 : 85);
    }
  });

  test("on the welcome the whole upright coin (rim, lift, bob) stays inside her host at every stage size", () => {
    const sizes: readonly [number, number][] = [[320, 284], [320, 268], [280, 268], [320, 240]];
    for (const [w, h] of sizes) {
      for (const palm of [false, true]) {
        const f = fitOf("welcome", w, h, palm);
        const ink = tokenStandInk(f);
        expect(ink.bottom).toBeLessThanOrEqual(h);
        expect(ink.top).toBeGreaterThanOrEqual(0);
        expect(ink.left).toBeGreaterThanOrEqual(0);
        expect(ink.right).toBeLessThanOrEqual(w);
        // it stands on the flat coin's foot, and the canvas reaches it
        expect(ink.bottom).toBeCloseTo(toHost(f, 0, f.rig.tokenFoot)[1], 5);
        expect(canvasBox(f).bottom).toBeGreaterThanOrEqual(ink.bottom - 1e-9);
      }
    }
  });

  test("the drawn extent covers the sheet's face-on ink at rest, lifted and bobbing", () => {
    const f = fitOf("welcome", 320, 284);
    const t = f.rig.token;
    const sd = t.d * f.rig.stand.scale;
    const q = sd / TOKEN_SHEET.td;
    const cy = t.y + sd * f.rig.stand.drop;
    const ink = tokenStandInk(f);
    const host = (y: number): number => toHost(f, 0, y)[1];
    // at rest, bobbing down: the sheet's ink bottom (63.6 of the 80 frame, centre at 34)
    const restBottom = cy + (UPRIGHT_INK.bottom - 34) * q + STAND_BOB * sd;
    expect(ink.bottom).toBeGreaterThanOrEqual(host(restBottom) - 1e-9);
    // lifted under the pointer and bobbing up: the ink top, grown, raised
    const liftTop = cy - (34 - UPRIGHT_INK.top) * q * (1 + LIFT.grow) - LIFT.rise * sd - STAND_BOB * sd;
    expect(ink.top).toBeLessThanOrEqual(host(liftTop) + 1e-9);
  });

  test("on the welcome's full stage the coin's box is about 99 px high, its foot inside the stage", () => {
    const box = tokenBox(fitOf("welcome", 320, 284));
    expect(box.bottom - box.top).toBeGreaterThan(92);
    expect(box.bottom - box.top).toBeLessThan(106);
    expect(box.bottom).toBeLessThanOrEqual(284);
    expect((box.left + box.right) / 2).toBeCloseTo(160, 0);
  });
});
