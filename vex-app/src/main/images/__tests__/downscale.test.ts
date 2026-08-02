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
 *  - the result carries the dimensions of what was actually produced;
 *  - an aspect ratio is preserved, and an image is never scaled UP;
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
const resizeCalls: Array<{ size: StubSize; quality: number }> = [];

function makeImage(size: StubSize) {
  return {
    isEmpty: () => !decodable,
    getSize: () => size,
    resize: (options: { width: number; height: number }) => {
      const resized = { width: options.width, height: options.height };
      return {
        isEmpty: () => false,
        getSize: () => resized,
        toJPEG: (quality: number) => {
          resizeCalls.push({ size: resized, quality });
          return Buffer.alloc(encodedSizeFor(resized, quality));
        },
        resize: () => makeImage(resized),
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
    expect(resizeCalls.map((call) => call.size.width)).toEqual([512, 448, 400]);
    expect(outcome.width).toBe(400);
  });

  it("preserves the aspect ratio and reports the dimensions actually produced", () => {
    sourceSize = { width: 4000, height: 2000 };
    encodedSizeFor = () => 10_000;

    const outcome = downscaleLockerImage(new Uint8Array(3_000_000));

    expect(outcome.kind).toBe("optimized");
    if (outcome.kind !== "optimized") throw new Error("unreachable");
    expect(outcome.width).toBe(512);
    expect(outcome.height).toBe(256);
  });

  it("never scales an image UP to reach a rung", () => {
    // Small dimensions, absurd byte length (e.g. a bloated PNG).
    sourceSize = { width: 300, height: 300 };
    encodedSizeFor = (size) => (size.width <= 300 ? 12_000 : 99_000);

    const outcome = downscaleLockerImage(new Uint8Array(500_000));

    expect(outcome.kind).toBe("optimized");
    expect(resizeCalls[0]?.size).toEqual({ width: 300, height: 300 });
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
