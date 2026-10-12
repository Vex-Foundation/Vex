/**
 * The art the plate ships (`public/art/`), pinned to the art table of
 * `docs/design/V10-SPREAD.md section 9`: the day and night prints
 * at 2560 x 1440, the Desktop eagle at 480 x 369, the five far birds 192
 * wide, at their exact byte sizes, plus the print's grain tile. A re-export
 * or a swapped file shows up here before it shows up as a misplaced eagle.
 * Dimensions are read from the file headers (JPEG SOF, PNG IHDR, WebP VP8X,
 * VP8L or VP8).
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLATE_ART, spritesFor } from "../flock-engine.js";
import { DESK_AGENT_STATES } from "../agent-state.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "..", "..", "..", "public");

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

function sizeOf(url: string): [number, number] {
  const b = readFileSync(fileOf(url));
  if (url.endsWith(".jpg")) return jpegSize(b);
  if (url.endsWith(".png")) return pngSize(b);
  return webpSize(b);
}

const birds = [1, 3, 6, 7, 8].map((n) => `${PLATE_ART.birds}bird-${n}.webp`);

describe("the plate art", () => {
  it.each([
    [PLATE_ART.day, 2560, 1440, 150_801],
    [PLATE_ART.night, 2560, 1440, 102_175],
    [PLATE_ART.eagle, 480, 369, 77_840],
  ])("%s is %i x %i, %i bytes", (url, w, h, bytes) => {
    expect(sizeOf(url)).toEqual([w, h]);
    expect(statSync(fileOf(url)).size).toBe(bytes);
  });

  it("the five far birds are 192 wide, 41,530 bytes together", () => {
    let total = 0;
    for (const url of birds) {
      expect(sizeOf(url)[0]).toBe(192);
      total += statSync(fileOf(url)).size;
    }
    expect(total).toBe(41_530);
  });

  it("the grain is the fractal noise tile the prints are laid under", () => {
    const svg = readFileSync(fileOf(PLATE_ART.grain), "utf8");
    expect(svg).toContain("feTurbulence");
    expect(svg).toContain("width='220' height='220'");
  });

  it("every sprite a state can ask for ships", () => {
    const wanted = new Set<string>();
    for (const state of DESK_AGENT_STATES)
      for (const layout of ["page", "stage"] as const)
        for (const moving of [false, true]) for (const u of spritesFor(state, layout, moving)) wanted.add(u);
    for (const url of wanted) expect(statSync(fileOf(url)).size).toBeGreaterThan(0);
    expect([...wanted].filter((u) => u.startsWith(PLATE_ART.birds)).sort()).toEqual([...birds].sort());
  });
});
