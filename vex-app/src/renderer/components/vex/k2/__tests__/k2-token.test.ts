/**
 * The token's states (`k2-token.ts`), with the shipped sheet layout and stubbed bitmaps (jsdom has
 * no decoder). Regressions this catches: a coin that does not lift under the pointer or stays up
 * after it leaves; a sleep dim that brightens, goes past its floor or leaks its filter into her
 * dots; the poses loaded when only the flat coin is needed, or not loaded for the reverse flip; a
 * failed pose sheet that takes the coin away instead of leaving it flat; and a reverse flip that
 * draws other poses than the turn to flat.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type CoinCanvas,
  frameFor,
  LIFT,
  liftOf,
  type TokenSheet,
  TokenSprite,
  TOKEN_DIM,
  tokenBrightness,
} from "../k2-token.js";
import { isTokenSheet } from "../k2-assets.js";

const here = dirname(fileURLToPath(import.meta.url));
const raw: unknown = JSON.parse(
  readFileSync(join(here, "../../../../public/art/vex-k2/token.json"), "utf8"),
);
if (!isTokenSheet(raw)) throw new Error("token.json does not match the sheet layout");
const SHEET: TokenSheet = raw;

/** Serves the sheet's layout and blank bitmaps, recording every file asked for. */
function stubArt(fail: readonly string[] = []): string[] {
  const asked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const file = url.split("/").pop() ?? "";
      asked.push(file);
      if (fail.includes(file)) return new Response(null, { status: 404 });
      if (file === "token.json") return new Response(JSON.stringify(SHEET));
      return new Response(new Blob([new Uint8Array([0])]));
    }),
  );
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 1, height: 1, close: () => undefined })),
  );
  return asked;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const FLAT = { flip: 1, press: 0, tiltX: 0, tiltY: 0 };
const FACE_ON = { flip: 0, press: 0, tiltX: 0, tiltY: 0 };

describe("the hover lift", () => {
  test("rises over 220 ms once the pointer is on the coin and sinks over 260 ms after", () => {
    expect(liftOf(false, -1, -1)).toBe(0);
    expect(liftOf(true, 0, -1)).toBe(0);
    expect(liftOf(true, LIFT.up / 2, -1)).toBeGreaterThan(0.5);
    expect(liftOf(true, LIFT.up, -1)).toBe(1);
    expect(liftOf(true, 5000, -1)).toBe(1);
    expect(liftOf(false, -1, 0)).toBe(1);
    expect(liftOf(false, -1, LIFT.down / 2)).toBeLessThan(0.5);
    expect(liftOf(false, -1, LIFT.down)).toBe(0);
  });

  test("raises the coin by 3.5% of its diameter and grows it by 2.5%", async () => {
    stubArt();
    const coin = new TokenSprite();
    await coin.load(false, 1);
    const rest = coin.place(100, 200, 58, 0, FLAT);
    const up = coin.place(100, 200, 58, 0, { ...FLAT, lift: 1 });
    expect(rest).not.toBeNull();
    expect(up?.size).toBeCloseTo((rest?.size ?? 0) * (1 + LIFT.grow), 5);
    // centred on the same point, then lifted
    const mid = (p: typeof rest) => (p?.x ?? 0) + (p?.size ?? 0) / 2;
    expect(mid(up)).toBeCloseTo(mid(rest), 5);
    const drop = (p: typeof rest) => (p?.y ?? 0) + ((SHEET.box / 2 - 6) / SHEET.box) * (p?.size ?? 0);
    expect(drop(rest) - drop(up)).toBeCloseTo(LIFT.rise * 58, 5);
  });
});

describe("the sleep dim", () => {
  test("darkens the coin to 0.775 at the deepest sleep, never past it, never brighter", () => {
    expect(tokenBrightness(0)).toBe(1);
    expect(tokenBrightness(1)).toBeCloseTo(1 - 0.5 * TOKEN_DIM, 5);
    expect(tokenBrightness(1)).toBeCloseTo(0.775, 5);
    expect(tokenBrightness(2)).toBeCloseTo(0.775, 5);
    expect(tokenBrightness(-1)).toBe(1);
    expect(tokenBrightness(0.5)).toBeGreaterThan(tokenBrightness(1));
  });

  test("paints through a brightness filter only while dimmed, and leaves the context as it was", async () => {
    stubArt();
    const coin = new TokenSprite();
    await coin.load(false, 1);
    const placed = coin.place(100, 200, 58, 0, FLAT);
    if (placed === null) throw new Error("no coin placed");
    const calls: string[] = [];
    let filter = "none";
    const ctx: CoinCanvas = {
      save: () => calls.push("save"),
      restore: () => {
        calls.push("restore");
        filter = "none";
      },
      drawImage: () => calls.push(`draw:${filter}`),
      get filter() {
        return filter;
      },
      set filter(v: string) {
        filter = v;
      },
    };
    coin.paint(ctx, placed);
    expect(calls).toEqual(["draw:none"]);
    calls.length = 0;
    coin.paint(ctx, placed, 1);
    expect(calls).toEqual(["save", "draw:brightness(0.775)", "restore"]);
    expect(filter).toBe("none");
  });
});

describe("the poses and the reverse flip", () => {
  test("the flat coin alone loads without the poses; the poses load once, on demand", async () => {
    const asked = stubArt();
    const coin = new TokenSprite();
    await coin.load(false, 1);
    expect(asked).toEqual(["token.json", "token-flat-1x.webp"]);
    // without its poses a face-on coin is drawn flat
    expect(coin.place(100, 200, 58, 0, FACE_ON)?.n).toBe(-1);
    await coin.loadPoses();
    await coin.loadPoses();
    expect(asked.filter((f) => f === "token-wake-1x.webp")).toHaveLength(1);
    expect(coin.place(100, 200, 58, 0, FACE_ON)?.n).toBeGreaterThanOrEqual(0);
    expect(coin.place(100, 200, 58, 0, FLAT)?.n).toBe(-1);
  });

  test("the wake or an episode loads the poses with the coin, at the screen's density", async () => {
    const asked = stubArt();
    await new TokenSprite().load(true, 2);
    expect([...asked].sort()).toEqual(["token-flat-2x.webp", "token-wake-2x.webp", "token.json"]);
  });

  test("a pose sheet that fails leaves the coin flat, not gone", async () => {
    stubArt(["token-wake-1x.webp"]);
    const coin = new TokenSprite();
    await coin.load(true, 1);
    expect(coin.ready).toBe(true);
    expect(coin.place(100, 200, 58, 0, FACE_ON)?.n).toBe(-1);
  });

  test("turning back face-on runs the turn to flat backward, pose for pose", () => {
    const steps = Array.from({ length: 25 }, (_, n) => n / 24);
    const forward = steps.map((f) => frameFor(SHEET.frames, f, 0, 0, 0));
    const backward = [...steps].reverse().map((f) => frameFor(SHEET.frames, f, 0, 0, 0));
    expect(backward).toEqual([...forward].reverse());
    // it ends face-on and starts flat
    expect(backward[0]).toBe(-1);
    expect(SHEET.frames[backward.at(-1) ?? -1]?.kind).toBe("tilt");
  });
});
