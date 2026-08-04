/**
 * The vexing scene's per-particle constants.
 *
 * These are DERIVED from the shared `sigil-sampler` (the one source of truth
 * for the letterform), so what is worth pinning here is what this module adds:
 * a scatter seat every particle can be thrown back out to, a bounded stagger,
 * and determinism — the same monogram must produce the same constellation on
 * every mount, or the loop would flicker into a different shape each cycle.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVexingParticles } from "../particles.js";

/** Minimal 2D-context double (mirrors VexSigil.test.tsx): the offscreen
 * sample answers a fully-opaque block, so every grid cell is a target. */
function installFake2d(): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    (contextId: string) =>
      contextId === "2d"
        ? ({
            setTransform: vi.fn(),
            clearRect: vi.fn(),
            drawImage: vi.fn(),
            getImageData: vi.fn(
              (_x: number, _y: number, w: number, h: number) => ({
                data: new Uint8ClampedArray(w * h * 4).fill(255),
                width: w,
                height: h,
              }),
            ),
            beginPath: vi.fn(),
            rect: vi.fn(),
            fill: vi.fn(),
          } as unknown as CanvasRenderingContext2D)
        : null,
  );
}

function loadedImage(): HTMLImageElement {
  return { naturalWidth: 500, naturalHeight: 500 } as HTMLImageElement;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildVexingParticles", () => {
  it("lands in the sampler's 1500–3000 particle band", () => {
    installFake2d();
    const built = buildVexingParticles(loadedImage());
    expect(built).not.toBeNull();
    expect(built!.count).toBeGreaterThanOrEqual(1500);
    expect(built!.count).toBeLessThanOrEqual(3000);
    expect(built!.width).toBeGreaterThan(0);
    expect(built!.height).toBeGreaterThan(0);
  });

  it("gives every particle a scatter seat away from its letterform target", () => {
    installFake2d();
    const p = buildVexingParticles(loadedImage())!;
    for (let i = 0; i < p.count; i++) {
      const dx = (p.outX[i] ?? 0) - (p.targetX[i] ?? 0);
      const dy = (p.outY[i] ?? 0) - (p.targetY[i] ?? 0);
      expect(Math.hypot(dx, dy)).toBeGreaterThan(0);
    }
  });

  it("bounds the stagger to [0,1) of the act", () => {
    installFake2d();
    const p = buildVexingParticles(loadedImage())!;
    for (let i = 0; i < p.count; i++) {
      const d = p.delay[i] ?? -1;
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(1);
    }
  });

  it("is deterministic — the same mark builds the identical constellation twice", () => {
    installFake2d();
    const a = buildVexingParticles(loadedImage())!;
    const b = buildVexingParticles(loadedImage())!;
    expect(a.count).toBe(b.count);
    expect(Array.from(a.targetX)).toEqual(Array.from(b.targetX));
    expect(Array.from(a.outX)).toEqual(Array.from(b.outX));
    expect(Array.from(a.outY)).toEqual(Array.from(b.outY));
    expect(Array.from(a.delay)).toEqual(Array.from(b.delay));
    expect(Array.from(a.colorIdx)).toEqual(Array.from(b.colorIdx));
  });

  it("returns null when the mark cannot be sampled — the caller falls back", () => {
    // No 2D context (the jsdom default) → the sampler declines, and so must we.
    expect(buildVexingParticles(loadedImage())).toBeNull();
  });
});
