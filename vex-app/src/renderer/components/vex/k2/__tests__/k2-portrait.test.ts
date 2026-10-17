/**
 * K2's portrait (`k2-portrait.ts`) on a small synthetic drawing, without a canvas: the parts the app
 * drawing adds. Regressions this catches: a cut that leaves dots below it or does not thin her
 * toward it and the frame's edges; a mood change that does not dissolve from the drawing it leaves;
 * the eye modes of the moods (narrowed, half lidded, worried, closed asleep) that do not lower the
 * lids, or a still frame that drops a mood's eyes or keeps a gesture's; a frown without its corners
 * turned down or a pout without its short stroke.
 */
import { describe, expect, test } from "vitest";
import {
  Dots,
  type K2Map,
  type K2Meta,
  type Palette,
  Portrait,
  type PortraitFrame,
} from "../k2-portrait.js";
import { type FaceState, NO_FACE } from "../k2-time.js";

const GW = 60;
const GH = 80;
const N = GW * GH;
const P = 3;
const CLS = {
  none: 0,
  hair: 1,
  skin: 2,
  tee: 3,
  acc: 4,
  eye: 5,
  cloud: 6,
  hand: 7,
  line: 8,
} as const;
const COL = { white: 0, ink: 1, blue_w: 2, blue_i: 3 } as const;

const eye = (x0: number, outer: number) => ({
  top: [
    [x0, 64],
    [x0 + 15, 58],
    [x0 + 30, 64],
  ] as [number, number][],
  bot: [
    [x0, 66],
    [x0 + 15, 76],
    [x0 + 30, 66],
  ] as [number, number][],
  iris: [x0 + 15, 67, 6, 7] as [number, number, number, number],
  pupil: [x0 + 15, 67, 2, 3] as [number, number, number, number],
  hl: [x0 + 11, 62, 1.5] as [number, number, number],
  hl2: [x0 + 19, 71] as [number, number],
  gmax: [3, 1.5, 3] as [number, number, number],
  lash: 3.4,
  outer,
});

const META: K2Meta = {
  pitch: P,
  bx: 0,
  by: 0,
  gw: GW,
  gh: GH,
  k: 1,
  eyes: [eye(50, -1), eye(100, 1)],
  face: {
    mouth: [
      [80, 120],
      [100, 120],
    ],
    lip: [
      [86, 123],
      [94, 123],
    ],
    nose: [[88, 100]],
  },
  cls: CLS,
  col: COL,
  flags: { ring: 1, strand: 4, in: 8 },
  ycut: new Array(2 * GW + 2).fill(1e5),
  rise: 34,
  rest: [-300, 100],
  glance: [90, 70],
  streamMaxX: 1e4,
};

/** A drawing: every cell lit in one colour, the eyes' boxes in the eye class. */
function drawing(col: number): K2Map {
  const cls = new Uint8Array(N).fill(CLS.tee);
  for (let j = 0; j < GH; j++)
    for (let i = 0; i < GW; i++) {
      const x = i * P + (j & 1) * P * 0.5;
      const y = j * P;
      const inEye =
        y >= 56 && y <= 78 && ((x >= 48 && x <= 82) || (x >= 98 && x <= 132));
      if (inEye) cls[j * GW + i] = CLS.eye;
    }
  return {
    tone: new Float32Array(N).fill(0.9),
    cls,
    flags: new Uint8Array(N),
    col: new Uint8Array(N).fill(col),
    tip: new Float32Array(N),
  };
}

const PAL: Palette = {
  white: "#fff",
  wA: 0.96,
  ink: "#000",
  blue: "#00f",
  blueArea: "#00c",
  rimHair: "#fff",
  rimTone: 0.4,
  blush: "#000",
};

function portrait(): Portrait {
  const p = new Portrait(META, {
    base: drawing(COL.white),
    hover: drawing(COL.white),
  });
  p.addMap("focus", drawing(COL.white));
  p.addMap("pout", drawing(COL.ink));
  return p;
}

function frame(
  face: FaceState,
  more: Partial<PortraitFrame> = {},
): PortraitFrame {
  return {
    t: 0,
    still: false,
    dark: false,
    hp: 0,
    rise: 0,
    face,
    gp: face.gp,
    smirk: false,
    gust: 0,
    sway: 0,
    lid: 0,
    eyes: face.eyes,
    gaze: { x: 90, y: 70 },
    asm: 1,
    cut: null,
    ...more,
  };
}

function dots(p: Portrait, fr: PortraitFrame): Dots {
  const d = new Dots();
  p.emit(fr, PAL, d, "all");
  return d;
}

/** The (x, y) of an ink's dots inside a band of y. */
function inBand(d: Dots, ink: keyof Dots["lists"], y0: number, y1: number) {
  const out: [number, number][] = [];
  const l = d.lists[ink];
  for (let n = 0; n < l.length; n += 3) {
    const y = l[n + 1] ?? 0;
    if (y >= y0 && y <= y1) out.push([l[n] ?? 0, y]);
  }
  return out;
}

const allY = (d: Dots) =>
  Object.values(d.lists).flatMap((l) => l.filter((_, n) => n % 3 === 1));

describe("the cut", () => {
  const cut = {
    top: () => 150,
    band: 30,
    gain: 0.95,
    shrink: 0.45,
    side: 18,
    width: GW * P + P / 2,
    bottom: 180,
  };

  test("no dot of her below the cut, fewer and smaller across the band", () => {
    const p = portrait();
    const free = dots(p, frame(NO_FACE));
    const cutd = dots(p, frame(NO_FACE, { cut }));
    expect(Math.max(...allY(free))).toBeGreaterThan(200);
    expect(Math.max(...allY(cutd))).toBeLessThan(180);
    const band = (d: Dots) => inBand(d, "white", 156, 174).length;
    expect(band(cutd)).toBeLessThan(band(free) * 0.6);
    expect(band(cutd)).toBeGreaterThan(0);
  });

  test("the frame's edges thin out", () => {
    const p = portrait();
    const edge = (d: Dots) =>
      inBand(d, "white", 90, 140).filter(([x]) => x < 6).length;
    const free = dots(p, frame(NO_FACE));
    const cutd = dots(p, frame(NO_FACE, { cut }));
    expect(edge(cutd)).toBeLessThan(edge(free) * 0.5);
  });
});

describe("a mood change", () => {
  test("dissolves from the drawing it leaves: all of it at the start, none at the end", () => {
    const p = portrait();
    const at = (gp: number) =>
      inBand(
        dots(
          p,
          frame({
            ...NO_FACE,
            map: "focus",
            gp,
            from: { map: "pout", hand: null },
          }),
        ),
        "ink",
        150,
        230,
      ).length;
    const cells = inBand(dots(p, frame(NO_FACE)), "white", 150, 230).length;
    expect(at(0)).toBe(cells);
    expect(at(1)).toBe(0);
    expect(at(0.5)).toBeGreaterThan(cells * 0.3);
    expect(at(0.5)).toBeLessThan(cells * 0.7);
  });

  test("without a drawing to leave she dissolves from her base", () => {
    const p = portrait();
    const d = dots(p, frame({ ...NO_FACE, map: "focus", gp: 0.5 }));
    expect(inBand(d, "ink", 150, 230)).toEqual([]);
  });
});

describe("the mood eyes", () => {
  const iris = (eyes: FaceState["eyes"], more: Partial<PortraitFrame> = {}) =>
    inBand(dots(portrait(), frame({ ...NO_FACE, eyes }, more)), "blue", 56, 80)
      .length;

  test("narrowed, half lidded and worried lids cover more of her irises; asleep none show", () => {
    const open = iris("open");
    expect(open).toBeGreaterThan(0);
    expect(iris("wide")).toBe(open);
    expect(iris("narrow")).toBeLessThan(open);
    expect(iris("half")).toBeLessThan(open);
    expect(iris("map")).toBe(0);
  });

  test("the worried lid comes down and tilts: her lash line sits lower than when open", () => {
    const lash = (eyes: FaceState["eyes"]) => {
      const ink = inBand(
        dots(portrait(), frame({ ...NO_FACE, eyes })),
        "ink",
        56,
        80,
      );
      return ink.reduce((a, [, y]) => a + y, 0) / ink.length;
    };
    expect(lash("worried")).toBeGreaterThan(lash("open"));
    expect(lash("half")).toBeGreaterThan(lash("worried"));
  });

  test("a still frame keeps a mood's eyes, and drops a gesture's", () => {
    expect(iris("map", { still: true, held: true })).toBe(0);
    expect(iris("map", { still: true })).toBe(iris("open"));
  });
});

describe("the mood mouths", () => {
  const mouth = (m: FaceState["mouth"]) =>
    inBand(dots(portrait(), frame({ ...NO_FACE, mouth: m })), "ink", 110, 130);

  test("the frown turns its corners down one row", () => {
    const row = mouth("calm").filter(([, y]) => y === 120).length;
    const frown = mouth("frown");
    expect(frown.filter(([, y]) => y === 120)).toHaveLength(row);
    expect(frown.filter(([, y]) => y === 123)).toHaveLength(2);
    expect(mouth("calm").filter(([, y]) => y === 123)).toEqual([]);
  });

  test("the pout is a short full stroke with a fuller lip under it", () => {
    const pout = mouth("pout");
    expect(pout.filter(([, y]) => y === 120)).toHaveLength(3);
    expect(pout.filter(([, y]) => y === 123)).toHaveLength(1);
  });
});
