/**
 * L kimm-fit (PLAN WP3.5; SK KIMM.md 4 table, lines 150-155, and 10, lines 276-278; H3 `stage.js:39-41, 96, 107-109`):
 * Kimm's framing as the measured pages framed her.
 *
 * Regressions this catches:
 * - the landing span off its rule (4040 at a 748 column, 3000 from 1260 up, the 3731.25 of the embed test);
 * - the arc fit off the embed's three passes (s 0.18414, hair top 218.1, arc 1.031 in a 720 x 900 box; s 0.1455 and
 *   hair top 176.1 after the resize) or the face off the box's centre line;
 * - the arc's scale off `clamp(s x 5.6, 0.55, 1.15)` (0.756 at s 0.135, 1.15 at the 2560 s 0.33297);
 * - her section losing its 52 px headroom and 0.92 fill on a tall section, or not growing on the short stub.
 *
 * Ported from VEX Cloud's `apps/web/src/components/kimm/kimm-fit.test.ts` (owner decision 2026-11-15) without the
 * phone rules, which desktop does not port. Desktop's own seats close the file: her live figure takes the frame of
 * the still each seat of `KimmPanel` draws (kimm.css), so she fades in where her still stood.
 */
import { describe, expect, test } from "vitest";
import {
  fitKimm,
  KIMM_STILL_HAIR_PX,
  KIMM_STILL_UNITS_PER_PX,
  kimmSeatFit,
  kimmStillFrame,
  KM,
  landingSpan,
  sectionFitOptions,
  sectionSpan,
} from "../kimm-fit.js";

describe("kimm-fit", () => {
  test("the landing span runs from 4300 to 3000 units by the column's height", () => {
    expect(landingSpan(620)).toBe(4300);
    expect(landingSpan(748)).toBeCloseTo(4040, 6);
    expect(landingSpan(900)).toBeCloseTo(3731.25, 6);
    expect(landingSpan(1288)).toBe(3000);
    expect(landingSpan(400)).toBe(4300);
  });

  test("the arc fit reproduces the tested embed in a 720 x 900 box and after the 1100 x 760 resize", () => {
    const fit = fitKimm(720, 900, { arc: { top: 12, height: 194 } });
    expect(fit.span).toBeCloseTo(3731.25, 6);
    expect(fit.s).toBeCloseTo(0.18414, 4);
    expect(Math.abs(fit.head - 218.1)).toBeLessThan(0.1);
    expect(fit.head).toBeCloseTo(12 + 194 * (fit.arc?.k ?? 0) + 6, 9);
    expect(fit.arc?.k).toBeCloseTo(1.031, 3);
    expect(fit.arc?.top).toBe(12);
    expect(fit.faceX).toBe(360);
    expect(fit.x + KM.face * fit.s).toBeCloseTo(360, 9);
    expect(fit.y + KM.head * fit.s).toBeCloseTo(fit.head, 9);
    const resized = fitKimm(550, 760, { arc: {} });
    expect(resized.s).toBeCloseTo(0.1455, 4);
    expect(Math.abs(resized.head - 176.1)).toBeLessThan(0.1);
  });

  test("the arc scales with her: 0.756 on a laptop, 1.15 on a 2560 screen", () => {
    const laptop = fitKimm(694.2, 708.4, { span: 4040, arc: {} });
    expect(laptop.s).toBeCloseTo(0.13457, 3);
    expect(laptop.arc?.k).toBeCloseTo(0.756, 2);
    const wide = fitKimm(1256, 1240, { span: 3000, arc: {} });
    expect(wide.arc?.k).toBe(1.15);
    expect(wide.head).toBeCloseTo(12 + 194 * 1.15 + 6, 9);
    expect(wide.s).toBeCloseTo(0.33297, 5);
  });

  test("without an arc she stands under the headroom, limited by her widest pose", () => {
    const fit = fitKimm(432, 563, { headroom: 52, span: 3963 });
    expect(fit.s).toBeCloseTo((432 * 0.92) / 3300, 9);
    expect(fit.head).toBe(52);
    expect(fit.arc).toBeNull();
    const tall = fitKimm(2000, 700, { headroom: 0, span: 4300 });
    expect(tall.s).toBeCloseTo(700 / 4300, 9);
  });

  test("her section keeps the landing span on a tall section and shortens it under 620", () => {
    expect(sectionSpan(900)).toBe(landingSpan(900));
    expect(sectionSpan(620)).toBe(4300);
    expect(sectionSpan(400)).toBe(3000);
    expect(sectionSpan(510)).toBeCloseTo(3650, 6);
  });

  test("her section's fit: 52 px over her hair and 0.92 of the width from 380 tall, growing on the short stub", () => {
    const options = sectionFitOptions();
    const tall = fitKimm(432, 563, options);
    expect(tall.head).toBe(52);
    expect(tall.span).toBeCloseTo(sectionSpan(563), 9);
    expect(tall.s).toBeCloseTo(
      Math.min((563 - 52) / sectionSpan(563), (432 * 0.92) / 3300),
      9,
    );
    const stub = fitKimm(432, 75, options);
    expect(stub.head).toBe(4);
    expect(stub.span).toBe(1700);
  });

});

describe("desktop's seats", () => {
  test("one still pixel is 0.88 x 3300 / (0.92 x 720) units, her hair 4 px under the still in Cloud's 432 section", () => {
    expect(KIMM_STILL_UNITS_PER_PX).toBeCloseTo(4.38406, 4);
    expect(KIMM_STILL_HAIR_PX).toBeCloseTo(7.5758, 3);
  });

  test("the card seat in Cloud's own 432 x 563 section lands on Cloud's section fit: 52 over her hair, 0.92 of the width", () => {
    const seat = fitKimm(432, 563, kimmSeatFit("card"));
    const cloud = fitKimm(432, 563, sectionFitOptions());
    expect(seat.s).toBeCloseTo(cloud.s, 9);
    expect(seat.head).toBeCloseTo(52, 9);
    expect(seat.faceX).toBe(216);
  });

  test("the card seat (280 x 359) frames her as the card's still: 48 from the top, 88% of the width", () => {
    expect(kimmStillFrame("card", 280, 359)).toEqual({ top: 48, width: 0.88 * 280 });
    const fit = fitKimm(280, 359, kimmSeatFit("card"));
    const k = (0.88 * 280) / 720;
    expect(fit.s).toBeCloseTo(k / KIMM_STILL_UNITS_PER_PX, 9);
    expect(fit.head).toBeCloseTo(48 + KIMM_STILL_HAIR_PX * k, 9);
    expect(fit.x + KM.face * fit.s).toBeCloseTo(140, 9);
    expect(fit.y + KM.head * fit.s).toBeCloseTo(fit.head, 9);
  });

  test("the lock seat frames her as the lock screen's still: on the foot, the panel's height less 64, her width free", () => {
    expect(kimmStillFrame("lock", 720, 900).top).toBe(64);
    expect(kimmStillFrame("lock", 720, 900).width).toBeCloseTo((836 * 720) / 1032, 9);
    const wide = fitKimm(720, 900, kimmSeatFit("lock"));
    const k = 836 / 1032;
    expect(wide.s).toBeCloseTo(k / KIMM_STILL_UNITS_PER_PX, 9);
    expect(wide.s).toBeCloseTo(0.18478, 4);
    expect(wide.head).toBeCloseTo(64 + KIMM_STILL_HAIR_PX * k, 9);
    // The still is sized by the panel's height alone, so a narrow panel (the 400 at the 1000 floor) cuts her as it
    // cuts the still, never shrinks her.
    const narrow = fitKimm(400, 900, kimmSeatFit("lock"));
    expect(narrow.s).toBeCloseTo(wide.s, 9);
    expect(narrow.x + KM.face * narrow.s).toBeCloseTo(200, 9);
  });
});
