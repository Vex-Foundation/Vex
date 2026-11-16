/**
 * Her device gate (`kimm-gates.ts`), ported from VEX Cloud's `apps/web/src/components/kimm/kimm-gates.test.ts` (owner
 * decision 2026-11-15) for desktop's one rule.
 *
 * Regressions this catches:
 *   - H3's `<= 4` back in the gate: a 4 GB, 4 core device must pass (4 passes, under 4 is still);
 *   - a fact the renderer does not report counted as a failure (no `deviceMemory`, no `connection`);
 *   - reduced motion or Save-Data loading her 160 MB of textures for a figure that should not move;
 *   - a GPU without WebGL2 or 4096 textures let through;
 *   - the GPU probe keeping its WebGL context alive;
 *   - a jsdom-like window without `matchMedia` throwing instead of reading as "no reduced motion".
 */

import { describe, expect, test } from "vitest";
import {
  type KimmDevice,
  type KimmDeviceWindow,
  type KimmGpuContext,
  type KimmGpuDocument,
  kimmGateReasons,
  probeGpu,
  readKimmDevice,
} from "../kimm-gates.js";

const DESK: KimmDevice = {
  saveData: false,
  deviceMemory: 8,
  hardwareConcurrency: 8,
  reducedMotion: false,
  webgl2: true,
  maxTextureSize: 16384,
};

describe("kimm-gates", () => {
  test("a capable desktop passes", () => {
    expect(kimmGateReasons(DESK)).toEqual([]);
  });

  test("4 GB and 4 cores pass; under 4 keeps her still", () => {
    expect(kimmGateReasons({ ...DESK, deviceMemory: 4, hardwareConcurrency: 4 })).toEqual([]);
    expect(kimmGateReasons({ ...DESK, deviceMemory: 2, hardwareConcurrency: 2 })).toEqual(["low-memory", "few-cores"]);
  });

  test("an unreported fact is not a failure", () => {
    expect(
      kimmGateReasons({
        ...DESK,
        deviceMemory: undefined,
        hardwareConcurrency: undefined,
        webgl2: undefined,
        maxTextureSize: undefined,
      }),
    ).toEqual([]);
  });

  test("every term keeps her still, each named", () => {
    expect(kimmGateReasons({ ...DESK, saveData: true })).toEqual(["save-data"]);
    expect(kimmGateReasons({ ...DESK, webgl2: false })).toEqual(["no-webgl2"]);
    expect(kimmGateReasons({ ...DESK, maxTextureSize: 2048 })).toEqual(["small-textures"]);
    expect(kimmGateReasons({ ...DESK, maxTextureSize: 4096 })).toEqual([]);
    expect(kimmGateReasons({ ...DESK, reducedMotion: true })).toEqual(["reduced-motion"]);
  });

  test("the renderer's facts are read from navigator and the reduced motion query", () => {
    const queries: string[] = [];
    const win: KimmDeviceWindow = {
      navigator: {
        connection: { saveData: true },
        deviceMemory: 4,
        hardwareConcurrency: 0,
      },
      matchMedia: (query: string) => {
        queries.push(query);
        return { matches: query === "(prefers-reduced-motion: reduce)" };
      },
    };
    expect(readKimmDevice(win)).toEqual({
      saveData: true,
      deviceMemory: 4,
      hardwareConcurrency: undefined,
      reducedMotion: true,
    });
    expect(queries).toEqual(["(prefers-reduced-motion: reduce)"]);
  });

  test("a window without matchMedia reads as no reduced motion", () => {
    const win: KimmDeviceWindow = { navigator: {} };
    expect(readKimmDevice(win)).toEqual({
      saveData: false,
      deviceMemory: undefined,
      hardwareConcurrency: undefined,
      reducedMotion: false,
    });
  });

  test("the GPU probe reads WebGL2's texture size and loses its context", () => {
    let lost = 0;
    const gl: KimmGpuContext = {
      MAX_TEXTURE_SIZE: 3379,
      getParameter: (name: number) => (name === 3379 ? 8192 : 0),
      getExtension: (name: string) =>
        name === "WEBGL_lose_context"
          ? {
              loseContext: () => {
                lost += 1;
              },
            }
          : null,
    };
    const doc = (context: KimmGpuContext | null): KimmGpuDocument => ({
      createElement: () => ({ getContext: () => context }),
    });
    expect(probeGpu(doc(gl))).toEqual({ webgl2: true, maxTextureSize: 8192 });
    expect(lost).toBe(1);
    expect(probeGpu(doc(null))).toEqual({ webgl2: false, maxTextureSize: undefined });
    const throwing: KimmGpuDocument = {
      createElement: () => ({
        getContext: () => {
          throw new Error("no gl");
        },
      }),
    };
    expect(probeGpu(throwing)).toEqual({ webgl2: false, maxTextureSize: undefined });
  });
});
