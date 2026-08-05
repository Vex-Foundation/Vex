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
import { buildVexingParticles, scatterRadiusOf } from "../particles.js";

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

  it("seats the cloud RADIALLY about the mark's centre, inside the box — no square rim", () => {
    // THE B2 BUG: seats used to be scattered around each particle's OWN target
    // by up to 1.2x the half-diagonal, so the cloud was the letterform's
    // bounding box dilated — and the parts that overflowed were CLIPPED by the
    // canvas rect, which is the square edge the owner could see. A single
    // radial cloud that fits inside the box cannot be clipped, so it has no
    // edge of any shape.
    installFake2d();
    const p = buildVexingParticles(loadedImage())!;
    const cx = p.width / 2;
    const cy = p.height / 2;
    const limit = scatterRadiusOf(p.width, p.height);

    let maxRadius = 0;
    for (let i = 0; i < p.count; i++) {
      const r = Math.hypot((p.outX[i] ?? 0) - cx, (p.outY[i] ?? 0) - cy);
      expect(r).toBeLessThanOrEqual(limit + 1e-6);
      maxRadius = Math.max(maxRadius, r);
    }
    // …and it genuinely fills that disc rather than hugging the letterform.
    expect(maxRadius).toBeGreaterThan(limit * 0.8);
  });

  it("feathers the cloud: seats near the rim are dimmer and smaller than the core", () => {
    installFake2d();
    const p = buildVexingParticles(loadedImage())!;
    const cx = p.width / 2;
    const cy = p.height / 2;
    const limit = scatterRadiusOf(p.width, p.height);

    let coreAlpha = 0;
    let rimAlpha = 0;
    let coreCount = 0;
    let rimCount = 0;
    let coreSize = 0;
    let rimSize = 0;
    for (let i = 0; i < p.count; i++) {
      const r = Math.hypot((p.outX[i] ?? 0) - cx, (p.outY[i] ?? 0) - cy);
      if (r < limit * 0.3) {
        coreAlpha += p.seatAlphaIdx[i] ?? 0;
        coreSize += p.sizePx[i] ?? 0;
        coreCount += 1;
      } else if (r > limit * 0.9) {
        rimAlpha += p.seatAlphaIdx[i] ?? 0;
        rimSize += p.sizePx[i] ?? 0;
        rimCount += 1;
      }
    }
    expect(coreCount).toBeGreaterThan(0);
    expect(rimCount).toBeGreaterThan(0);
    expect(coreAlpha / coreCount).toBeGreaterThan(rimAlpha / rimCount);
    expect(coreSize / coreCount).toBeGreaterThan(rimSize / rimCount);
  });

  it("keeps every seat alpha inside the sampler's 3-level bucket vocabulary", () => {
    // The batched draw is ≤9 fills because there are 3 colours x 3 alphas.
    installFake2d();
    const p = buildVexingParticles(loadedImage())!;
    for (let i = 0; i < p.count; i++) {
      expect(p.seatAlphaIdx[i]).toBeGreaterThanOrEqual(0);
      expect(p.seatAlphaIdx[i]).toBeLessThanOrEqual(2);
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
    expect(Array.from(a.seatAlphaIdx)).toEqual(Array.from(b.seatAlphaIdx));
    expect(Array.from(a.colorIdx)).toEqual(Array.from(b.colorIdx));
  });

  it("returns null when the mark cannot be sampled — the caller falls back", () => {
    // No 2D context (the jsdom default) → the sampler declines, and so must we.
    expect(buildVexingParticles(loadedImage())).toBeNull();
  });
});
