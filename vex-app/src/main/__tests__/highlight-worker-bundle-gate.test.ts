/**
 * Negative proof for the Studio highlight-worker build gate.
 *
 * Two failures this gate exists to stop, and neither announces itself:
 *
 *  - a CSP that drops `worker-src`, at which point the directive falls back to
 *    `default-src` and nothing pins it. The app keeps working, and the next
 *    person to widen `default-src` widens worker sources with it.
 *  - a build whose worker chunk was never emitted (a `worker.format` regression
 *    back to `iife`, or the option removed). `new Worker(new URL(...))` then
 *    fails at runtime, the port answers `worker_unavailable`, and every file in
 *    the viewer renders as plain text with a small grey chip. The product looks
 *    finished and is not.
 *
 * The matcher is pure, so both RED cases are provable on synthetic input rather
 * than by producing a deliberately broken build. It lives here beside
 * `zod-locale-bundle-gate.test.ts`, which is the established home for tests of
 * the post-build gates in `scripts/`.
 */

import { describe, expect, it } from "vitest";

import {
  evaluateHighlightWorkerBundle,
  HIGHLIGHT_PORT_MARKER,
} from "../../../scripts/check-privileged-bundles.mjs";

const GOOD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; " +
  "base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

const WORKER_CHUNK = "highlight.worker-C-1Hp9s1.js";

/** A renderer bundle that can reach the highlighter port. */
const REACHING = [`console.warn(${JSON.stringify(HIGHLIGHT_PORT_MARKER)},e)`];

/** A renderer bundle that cannot. This is the tree as it stands before B4. */
const NOT_REACHING = ["const a=1;export{a};"];

describe("evaluateHighlightWorkerBundle", () => {
  it("PASSES a real build: worker-src pinned, port reachable, chunk emitted", () => {
    const verdict = evaluateHighlightWorkerBundle({
      csp: GOOD_CSP,
      assetFileNames: ["index-CDa5F5Rt.js", WORKER_CHUNK, "typescript-CYezAmCg.js"],
      bundleSources: REACHING,
    });
    expect(verdict).toEqual({ ok: true, violations: [] });
  });

  it("FAILS when the CSP declares no worker-src at all", () => {
    const verdict = evaluateHighlightWorkerBundle({
      csp: GOOD_CSP.replace(" worker-src 'self';", ""),
      assetFileNames: [WORKER_CHUNK],
      bundleSources: REACHING,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toEqual([expect.stringContaining("declares no `worker-src`")]);
  });

  it.each([
    "worker-src 'self' blob:",
    "worker-src blob:",
    "worker-src *",
    "worker-src 'self' https://cdn.example.com",
  ])("FAILS when worker-src is widened to `%s`", (directive) => {
    const verdict = evaluateHighlightWorkerBundle({
      csp: GOOD_CSP.replace("worker-src 'self'", directive),
      assetFileNames: [WORKER_CHUNK],
      bundleSources: REACHING,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toEqual([
      expect.stringContaining("worker-src must be exactly 'self'"),
    ]);
  });

  it("FAILS when the port is reachable but no worker chunk was emitted", () => {
    const verdict = evaluateHighlightWorkerBundle({
      csp: GOOD_CSP,
      assetFileNames: ["index-CDa5F5Rt.js", "typescript-CYezAmCg.js"],
      bundleSources: REACHING,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toEqual([
      expect.stringContaining("`highlight.worker-<hash>.js` chunk was emitted"),
    ]);
  });

  it("does not accept a chunk that merely looks like the worker", () => {
    const verdict = evaluateHighlightWorkerBundle({
      csp: GOOD_CSP,
      // A grammar chunk, and a source map. Neither is the worker entry.
      assetFileNames: ["highlight.worker-C-1Hp9s1.js.map", "highlighter-Abc123.js"],
      bundleSources: REACHING,
    });
    expect(verdict.ok).toBe(false);
  });

  it("is VACUOUS while the Studio surface is not mounted (the tree today)", () => {
    // The viewer is unreachable from the app entry until stage B4, so no worker
    // chunk can exist and demanding one would fail every build. The CSP half
    // still runs - that is the half that is load-bearing right now.
    const verdict = evaluateHighlightWorkerBundle({
      csp: GOOD_CSP,
      assetFileNames: ["index-CDa5F5Rt.js"],
      bundleSources: NOT_REACHING,
    });
    expect(verdict).toEqual({ ok: true, violations: [] });
  });

  it("still pins the CSP when the port is unreachable", () => {
    const verdict = evaluateHighlightWorkerBundle({
      csp: GOOD_CSP.replace("worker-src 'self'", "worker-src blob:"),
      assetFileNames: ["index-CDa5F5Rt.js"],
      bundleSources: NOT_REACHING,
    });
    expect(verdict.ok).toBe(false);
  });

  it("reports BOTH failures at once rather than stopping at the first", () => {
    const verdict = evaluateHighlightWorkerBundle({
      csp: GOOD_CSP.replace(" worker-src 'self';", ""),
      assetFileNames: ["index-CDa5F5Rt.js"],
      bundleSources: REACHING,
    });
    expect(verdict.violations).toHaveLength(2);
  });
});
