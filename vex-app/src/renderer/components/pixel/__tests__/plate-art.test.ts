/**
 * The print art the app still ships (`public/art/`): the day and night
 * plateau prints at 2560 x 1440 at their exact byte sizes, behind the Vex
 * sidebar's plate and the pre-shell stage (docs/design/R3-MINIMAL.md sections
 * 5.1 and 10), plus the grain tile laid over them. A re-export or a swapped
 * file shows up here before it shows up as a misplaced print. The eagle and
 * the far birds left with the flock; the K2 hologram's own assets are pinned
 * by `components/vex/k2/__tests__/k2-art.test.ts`. Dimensions are read from
 * the JPEG frame header.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "..", "..", "..", "public");

/** The URLs the plate and the stage load the print and the grain from. */
const PRINT_ART = {
  day: "/art/plateau.jpg",
  night: "/art/plateau-night.jpg",
  grain: "/art/grain.svg",
} as const;

const fileOf = (url: string) => path.join(PUBLIC, ...url.split("/").filter(Boolean));

function jpegSize(b: Buffer): [number, number] {
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) throw new Error("bad JPEG marker");
    const marker = b[i + 1] ?? 0;
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + len;
  }
  throw new Error("no JPEG frame header");
}

describe("the print art", () => {
  it.each([
    [PRINT_ART.day, 2560, 1440, 150_801],
    [PRINT_ART.night, 2560, 1440, 102_175],
  ])("%s is %i x %i, %i bytes", (url, w, h, bytes) => {
    expect(jpegSize(readFileSync(fileOf(url)))).toEqual([w, h]);
    expect(statSync(fileOf(url)).size).toBe(bytes);
  });

  it("the grain is the fractal noise tile the prints are laid under", () => {
    const svg = readFileSync(fileOf(PRINT_ART.grain), "utf8");
    expect(svg).toContain("feTurbulence");
    expect(svg).toContain("width='220' height='220'");
  });

  it("no longer ships the eagle or the far birds", () => {
    expect(existsSync(fileOf("/art/eagle.png"))).toBe(false);
    expect(existsSync(fileOf("/art/birds"))).toBe(false);
  });
});
