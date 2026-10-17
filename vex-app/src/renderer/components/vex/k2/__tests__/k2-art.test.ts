/**
 * The art K2 ships (`public/art/vex-k2/`): her eight maps at 134 x 201 cells, her metadata, the
 * token's sheet layout and its four sprite sheets, at their exact byte sizes. A re-export, a
 * swapped file, a stray file or a metadata the loader would refuse shows up here before it shows
 * up as a missing or half drawn portrait. Dimensions are read from the file headers (PNG IHDR,
 * WebP VP8X, VP8L or VP8).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isK2Meta, isTokenSheet } from "../k2-assets.js";
import { TOKEN_SHEET } from "../k2-rig.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(here, "..", "..", "..", "..", "public", "art", "vex-k2");

const fileOf = (name: string) => path.join(ART, name);

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

const SPRITES: readonly (readonly [string, number, number, number])[] = [
  ["token-flat-1x.webp", 100, 100, 2_298],
  ["token-flat-2x.webp", 200, 200, 4_116],
  ["token-wake-1x.webp", 800, 400, 59_824],
  ["token-wake-2x.webp", 1600, 800, 135_800],
];

describe("the K2 art", () => {
  it("is exactly her maps, her metadata and the token's sheet (no phone drawing, no gesture notes)", () => {
    expect(readdirSync(ART).sort()).toEqual(
      [...MAPS.map(([n]) => n), ...SPRITES.map(([n]) => n), "meta.json", "token.json"].sort(),
    );
  });

  it.each(MAPS)("%s is a 134 x 201 cell map of %i bytes, RGB at 8 bits", (name, bytes) => {
    const b = readFileSync(fileOf(name));
    expect(pngSize(b)).toEqual([134, 201]);
    // bit depth 8, colour type 2 (RGB): the loader reads R, G and B as data
    expect([b[24], b[25]]).toEqual([8, 2]);
    expect(statSync(fileOf(name)).size).toBe(bytes);
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
    expect(isTokenSheet({ td: 58, box: 80, cols: 8 })).toBe(false);
  });

  it("all of it weighs under 340 KB", () => {
    const total = readdirSync(ART).reduce((sum, n) => sum + statSync(fileOf(n)).size, 0);
    expect(total).toBe(338_008);
  });
});
