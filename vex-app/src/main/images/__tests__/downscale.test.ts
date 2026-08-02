/**
 * Auto-downscale (C2) — the ladder.
 *
 * The cap is GAS on an irreversible transaction, so the properties pinned here
 * are about what the user pays and what they are told:
 *
 *  - an image that already fits is returned BYTE-IDENTICAL and is never
 *    re-encoded (re-encoding would degrade it for nothing and would change the
 *    digest a launch authorization is compared against);
 *  - an oversized image comes back under the budget, at the FIRST — therefore
 *    best-looking — rung that fits, not the smallest one;
 *  - the re-encoded result is SQUARE, center-cropped: Trench renders token
 *    images in 1:1 tiles exclusively (owner observation, screenshot evidence),
 *    so what is stored is what the venue's tile will show — no edge loss
 *    discovered only at launch time;
 *  - an image is never scaled UP to fill a square;
 *  - a file `nativeImage` cannot decode (SVG, a fake header) is refused, never
 *    rasterized silently;
 *  - when every rung misses, it says so — honest failure stays reachable.
 *
 * `nativeImage` is stubbed: these tests own the LADDER's decisions, not
 * Chromium's encoder. The stub reports a byte length as a function of the
 * requested dimension and quality, which is what the ladder actually reacts to.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface StubSize {
  width: number;
  height: number;
}

/** Bytes the fake encoder claims for a given size + quality. Set per test. */
let encodedSizeFor: (size: StubSize, quality: number) => number;
let sourceSize: StubSize;
let decodable = true;
/** Every rung attempt: what was scaled to, what was cropped out, at what quality. */
const resizeCalls: Array<{
  size: StubSize;
  quality: number;
  crop: { x: number; y: number; width: number; height: number };
}> = [];

function makeImage(size: StubSize) {
  return {
    isEmpty: () => !decodable,
    getSize: () => size,
    resize: (options: { width: number; height: number }) => {
      const scaled = { width: options.width, height: options.height };
      return {
        isEmpty: () => false,
        getSize: () => scaled,
        crop: (box: { x: number; y: number; width: number; height: number }) => {
          const cropped = { width: box.width, height: box.height };
          return {
            isEmpty: () => false,
            getSize: () => cropped,
            toJPEG: (quality: number) => {
              resizeCalls.push({ size: scaled, quality, crop: box });
              return Buffer.alloc(encodedSizeFor(cropped, quality));
            },
          };
        },
        toJPEG: (quality: number) => Buffer.alloc(encodedSizeFor(scaled, quality)),
      };
    },
    toJPEG: (quality: number) => Buffer.alloc(encodedSizeFor(size, quality)),
  };
}

vi.mock("electron", () => ({
  nativeImage: {
    createFromBuffer: () => makeImage(sourceSize),
  },
}));

const { downscaleLockerImage, DOWNSCALE_TARGET_BYTES } = await import("../downscale.js");

beforeEach(() => {
  decodable = true;
  sourceSize = { width: 4032, height: 3024 };
  // Plausible default: bytes scale with pixel count and with quality.
  encodedSizeFor = (size, quality) =>
    Math.round(size.width * size.height * 0.06 * (quality / 100));
  resizeCalls.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("an image that already fits", () => {
  it("is returned byte-identical and never re-encoded", () => {
    sourceSize = { width: 400, height: 300 };
    const original = new Uint8Array([1, 2, 3, ...new Uint8Array(9_000)]);

    const outcome = downscaleLockerImage(original);

    expect(outcome.kind).toBe("unchanged");
    if (outcome.kind !== "unchanged") throw new Error("unreachable");
    // Identity, not equality: the very same bytes go to the store and the hash.
    expect(outcome.bytes).toBe(original);
    expect(resizeCalls).toHaveLength(0);
  });

  it("is still optimized when its DIMENSIONS are out of bounds, small though it is", () => {
    // Beyond LOCKER_IMAGE_MAX_DIMENSION (8192) but heavily compressed: under
    // the byte cap and still outside what the locker will store.
    sourceSize = { width: 9000, height: 100 };
    encodedSizeFor = () => 5_000;

    const outcome = downscaleLockerImage(new Uint8Array(9_000));

    expect(outcome.kind).toBe("optimized");
  });
});

describe("an oversized image", () => {
  it("comes back under the byte budget", () => {
    const outcome = downscaleLockerImage(new Uint8Array(3_000_000));

    expect(outcome.kind).toBe("optimized");
    if (outcome.kind !== "optimized") throw new Error("unreachable");
    expect(outcome.bytes.byteLength).toBeLessThanOrEqual(DOWNSCALE_TARGET_BYTES);
    expect(outcome.originalByteLength).toBe(3_000_000);
  });

  it("stops at the FIRST rung that fits, not the smallest", () => {
    // Only rungs at or below 400px come in under budget.
    encodedSizeFor = (size) => (size.width <= 400 ? 15_000 : 40_000);

    const outcome = downscaleLockerImage(new Uint8Array(3_000_000));

    expect(outcome.kind).toBe("optimized");
    if (outcome.kind !== "optimized") throw new Error("unreachable");
    // 512 and 448 were tried and missed; 400 fit and the search ended there.
    expect(resizeCalls.map((call) => call.crop.width)).toEqual([512, 448, 400]);
    expect(outcome.width).toBe(400);
  });

  it("center-crops to a SQUARE, because Trench renders 1:1 tiles only", () => {
    // Owner observation with screenshot evidence: the venue's token tiles are
    // exclusively 1:1. Storing a 2:1 photo would mean the edges the user was
    // shown vanish at launch time, on an irreversible transaction.
    sourceSize = { width: 4000, height: 2000 };
    encodedSizeFor = () => 10_000;

    const outcome = downscaleLockerImage(new Uint8Array(3_000_000));

    expect(outcome.kind).toBe("optimized");
    if (outcome.kind !== "optimized") throw new Error("unreachable");
    expect(outcome.width).toBe(512);
    expect(outcome.height).toBe(512);
  });

  it("scales the SHORTER side onto the rung, then crops the overflow equally", () => {
    sourceSize = { width: 4000, height: 2000 };
    encodedSizeFor = () => 10_000;

    downscaleLockerImage(new Uint8Array(3_000_000));

    const first = resizeCalls[0];
    // Shorter side (2000) scaled to 512 → 1024x512; the extra 512px of width
    // is removed 256 from each end, so the subject stays centred.
    expect(first?.size).toEqual({ width: 1024, height: 512 });
    expect(first?.crop).toEqual({ x: 256, y: 0, width: 512, height: 512 });
  });

  it("crops a PORTRAIT image vertically, from the centre", () => {
    sourceSize = { width: 1000, height: 3000 };
    encodedSizeFor = () => 10_000;

    downscaleLockerImage(new Uint8Array(3_000_000));

    const first = resizeCalls[0];
    expect(first?.size).toEqual({ width: 512, height: 1536 });
    expect(first?.crop).toEqual({ x: 0, y: 512, width: 512, height: 512 });
  });

  it("never scales an image UP to fill a rung's square", () => {
    // Small dimensions, absurd byte length (e.g. a bloated PNG). The square is
    // bounded by the SHORTER side — inventing pixels to fill a tile is worse
    // than a smaller, honest image.
    sourceSize = { width: 300, height: 300 };
    encodedSizeFor = (size) => (size.width <= 300 ? 12_000 : 99_000);

    const outcome = downscaleLockerImage(new Uint8Array(500_000));

    expect(outcome.kind).toBe("optimized");
    if (outcome.kind !== "optimized") throw new Error("unreachable");
    expect(outcome.width).toBe(300);
    expect(resizeCalls[0]?.crop.width).toBe(300);
  });
});

describe("what it refuses", () => {
  it("refuses a file it cannot decode rather than rasterizing it", () => {
    decodable = false;
    const outcome = downscaleLockerImage(new Uint8Array(4_000));
    expect(outcome.kind).toBe("undecodable");
    expect(resizeCalls).toHaveLength(0);
  });

  it("reports exhaustion when every rung is still over budget", () => {
    encodedSizeFor = () => 90_000;

    const outcome = downscaleLockerImage(new Uint8Array(3_000_000));

    expect(outcome.kind).toBe("exhausted");
    if (outcome.kind !== "exhausted") throw new Error("unreachable");
    expect(outcome.smallestByteLength).toBe(90_000);
    // Every rung was genuinely attempted before giving up.
    expect(resizeCalls.length).toBeGreaterThanOrEqual(6);
  });
});
