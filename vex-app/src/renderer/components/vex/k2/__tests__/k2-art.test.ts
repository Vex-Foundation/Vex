/**
 * The art K2 ships (`public/art/vex-k2/`): the wide drawing's eight maps at 134 x 201 cells, its
 * metadata, the token's sheet layout and its four sprite sheets; the app drawing's fifteen maps
 * (`app/`, the emotions' and the morning coffee's among them) at 162 x 217 cells, its metadata and
 * the coffee's geometry (`app/coffee.json`); all at their exact byte sizes. A re-export, a
 * swapped file, a stray file or a metadata the loader would refuse shows up here before it shows
 * up as a missing or half drawn portrait. Dimensions are read from the file headers (PNG IHDR,
 * WebP VP8X, VP8L or VP8).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isK2Meta, isTokenSheet } from "../k2-assets.js";
import { isCoffeeGeo } from "../k2-coffee.js";
import { TOKEN_SHEET } from "../k2-rig.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(here, "..", "..", "..", "..", "public", "art", "vex-k2");

const fileOf = (name: string) => path.join(ART, name);
const APP_DIR = "app";

function pngSize(b: Buffer): [number, number] {
  expect(b.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

function webpSize(b: Buffer): [number, number] {
  expect(b.subarray(0, 4).toString("ascii")).toBe("RIFF");
  expect(b.subarray(8, 12).toString("ascii")).toBe("WEBP");
  const chunk = b.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X") return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  if (chunk === "VP8L") {
    const bits = b.readUInt32LE(21);
    return [1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)];
  }
  return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
}

const readJson = (name: string): unknown => JSON.parse(readFileSync(fileOf(name), "utf8"));

const MAPS: readonly (readonly [string, number])[] = [
  ["asleep.png", 15_955],
  ["base.png", 15_708],
  ["blow.png", 15_791],
  ["giggle.png", 16_408],
  ["hover.png", 16_847],
  ["palm.png", 15_813],
  ["rub.png", 16_946],
  ["yawn.png", 16_200],
];

/** The app drawing (`app/`): her base, the wake's, the gestures', the emotions' and the coffee's maps. */
const APP_MAPS: readonly (readonly [string, number])[] = [
  ["approve.png", 15_479],
  ["asleep.png", 14_644],
  ["base.png", 14_512],
  ["blow.png", 14_629],
  ["coffeeHold.png", 14_919],
  ["coffeeSip.png", 14_681],
  ["concern.png", 14_465],
  ["focus.png", 14_469],
  ["giggle.png", 15_610],
  ["hover.png", 16_021],
  ["palm.png", 15_170],
  ["pout.png", 14_474],
  ["rub.png", 16_529],
  ["think.png", 15_040],
  ["yawn.png", 15_425],
];

const SPRITES: readonly (readonly [string, number, number, number])[] = [
  ["token-flat-1x.webp", 100, 100, 2_298],
  ["token-flat-2x.webp", 200, 200, 4_116],
  ["token-wake-1x.webp", 800, 400, 59_824],
  ["token-wake-2x.webp", 1600, 800, 135_800],
];

describe("the K2 art", () => {
  it("is exactly her maps, her metadata, the token's sheet and the app drawing (no phone drawing, no gesture notes)", () => {
    expect(readdirSync(ART).sort()).toEqual(
      [
        ...MAPS.map(([n]) => n),
        ...SPRITES.map(([n]) => n),
        "meta.json",
        "token.json",
        APP_DIR,
      ].sort(),
    );
    expect(readdirSync(fileOf(APP_DIR)).sort()).toEqual(
      [...APP_MAPS.map(([n]) => n), "coffee.json", "meta.json"].sort(),
    );
  });

  it.each(MAPS)("%s is a 134 x 201 cell map of %i bytes, RGB at 8 bits", (name, bytes) => {
    const b = readFileSync(fileOf(name));
    expect(pngSize(b)).toEqual([134, 201]);
    // bit depth 8, colour type 2 (RGB): the loader reads R, G and B as data
    expect([b[24], b[25]]).toEqual([8, 2]);
    expect(statSync(fileOf(name)).size).toBe(bytes);
  });

  it.each(APP_MAPS)("app/%s is a 162 x 217 cell map of %i bytes, RGB at 8 bits", (name, bytes) => {
    const file = fileOf(path.join(APP_DIR, name));
    const b = readFileSync(file);
    expect(pngSize(b)).toEqual([162, 217]);
    expect([b[24], b[25]]).toEqual([8, 2]);
    expect(statSync(file).size).toBe(bytes);
  });

  it("the app drawing's metadata is what the loader accepts, on its maps' grid, with no source notes", () => {
    const meta = readJson(path.join(APP_DIR, "meta.json"));
    expect(isK2Meta(meta)).toBe(true);
    if (!isK2Meta(meta)) return;
    expect([meta.gw, meta.gh, meta.pitch, meta.k, meta.bx, meta.by]).toEqual([162, 217, 3, 1, 0, 0]);
    expect(meta.shoulder).toBe(317);
    expect(Object.keys(meta)).not.toContain("source");
    expect(statSync(fileOf(path.join(APP_DIR, "meta.json"))).size).toBe(3_621);
  });

  it("the app drawing's coffee geometry is what the guard accepts, with no converter notes, its lift in whole two-row steps", () => {
    const geo = readJson(path.join(APP_DIR, "coffee.json"));
    expect(isCoffeeGeo(geo)).toBe(true);
    if (!isCoffeeGeo(geo)) return;
    expect(Object.keys(geo)).not.toContain("info");
    expect(geo.lift[0]).toBe(0);
    expect(geo.lift[1] % 2).toBe(0);
    expect(statSync(fileOf(path.join(APP_DIR, "coffee.json"))).size).toBe(185);
  });

  it("her metadata is what the loader accepts, on the maps' own grid", () => {
    const meta = readJson("meta.json");
    expect(isK2Meta(meta)).toBe(true);
    if (!isK2Meta(meta)) return;
    expect([meta.gw, meta.gh, meta.pitch, meta.k]).toEqual([134, 201, 3, 1]);
    expect(statSync(fileOf("meta.json")).size).toBe(3_041);
  });

  it("the token's sheet layout is what the loader accepts, and the rig's copy of it agrees", () => {
    const sheet = readJson("token.json");
    expect(isTokenSheet(sheet)).toBe(true);
    if (!isTokenSheet(sheet)) return;
    expect(sheet.td).toBe(TOKEN_SHEET.td);
    expect(sheet.box).toBe(TOKEN_SHEET.box);
    expect(sheet.flat.cy).toBe(TOKEN_SHEET.flatCy);
    expect(sheet.flat.ry).toBe(TOKEN_SHEET.flatRy);
    expect(sheet.cols).toBe(8);
    expect(sheet.frames).toHaveLength(30);
    expect(statSync(fileOf("token.json")).size).toBe(3_261);
  });

  it.each(SPRITES)("%s is %i x %i, %i bytes", (name, w, h, bytes) => {
    expect(webpSize(readFileSync(fileOf(name)))).toEqual([w, h]);
    expect(statSync(fileOf(name)).size).toBe(bytes);
  });

  it("the sprite sheets are the layout's frames at 1.25 and 2.5 device px per css px", () => {
    const sheet = readJson("token.json");
    if (!isTokenSheet(sheet)) throw new Error("token.json does not match");
    for (const res of ["1x", "2x"] as const) {
      const side = Math.round(sheet.box * sheet.ratios[res]);
      expect(webpSize(readFileSync(fileOf(`token-flat-${res}.webp`)))).toEqual([side, side]);
      const rows = Math.ceil(sheet.frames.length / sheet.cols);
      expect(webpSize(readFileSync(fileOf(`token-wake-${res}.webp`)))).toEqual([
        sheet.cols * side,
        rows * side,
      ]);
    }
  });

  it("the guards refuse a file the converter did not write", () => {
    const meta = readJson("meta.json");
    if (typeof meta !== "object" || meta === null) throw new Error("meta.json is not an object");
    expect(isK2Meta({})).toBe(false);
    expect(isK2Meta({ ...meta, gw: "134" })).toBe(false);
    expect(isK2Meta({ ...meta, eyes: [{}] })).toBe(false);
    expect(isK2Meta({ ...meta, shoulder: "317" })).toBe(false);
    expect(isTokenSheet({ td: 58, box: 80, cols: 8 })).toBe(false);
  });

  it("the wide drawing and the token weigh 338,008 bytes, the app drawing with the coffee's maps and geometry 229,873", () => {
    const sum = (dir: string): number =>
      readdirSync(dir).reduce((acc, n) => {
        const st = statSync(path.join(dir, n));
        return st.isFile() ? acc + st.size : acc;
      }, 0);
    expect(sum(ART)).toBe(338_008);
    expect(sum(fileOf(APP_DIR))).toBe(229_873);
  });
});
