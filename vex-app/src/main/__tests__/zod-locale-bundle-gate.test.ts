/**
 * Negative proof for the post-build zod-locale gate.
 *
 * The gate previously accepted a bundle on the strength of zod's English
 * locale PHRASE alone. That phrase is not unique: it rides along in any chunk
 * that merely contains the locale module, so an artifact whose `config(en())`
 * registration had been tree-shaken out still passed. The load-bearing
 * assertion is the marker emitted by our own owner module, in all THREE bundle
 * sets, and these cases prove the gate now fails without it.
 *
 * Synthetic bundle text on purpose: the matcher is pure (no fs), so the RED
 * cases are provable without producing a deliberately broken build.
 */

import { describe, expect, it } from "vitest";

import { evaluateZodLocaleBundles } from "../../../scripts/check-privileged-bundles.mjs";

const MARKER = "vex-zod-locale:en";
const LOCALE_PHRASE = "Too big: expected ";

function bundle(name: string, ...sources: string[]) {
  return { name, sources };
}

describe("evaluateZodLocaleBundles", () => {
  it("FAILS when the locale phrase is present but the unique marker is not", () => {
    const verdict = evaluateZodLocaleBundles([
      bundle("dist/main", `const m=${JSON.stringify(LOCALE_PHRASE)};`),
      bundle("dist/preload/index.cjs", `const m=${JSON.stringify(LOCALE_PHRASE)};`),
      bundle("dist/renderer/assets", `const m=${JSON.stringify(LOCALE_PHRASE)};`),
    ]);

    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toHaveLength(3);
    for (const violation of verdict.violations) {
      expect(violation).toContain(MARKER);
      expect(violation).toContain("which alone proves nothing");
    }
  });

  it("FAILS when the marker is in main and preload but not in the renderer", () => {
    const registered = `${JSON.stringify(MARKER)};${JSON.stringify(LOCALE_PHRASE)}`;
    const verdict = evaluateZodLocaleBundles([
      bundle("dist/main", registered),
      bundle("dist/preload/index.cjs", registered),
      bundle("dist/renderer/assets", `const m=${JSON.stringify(LOCALE_PHRASE)};`),
    ]);

    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toEqual([
      expect.stringContaining("dist/renderer/assets"),
    ]);
  });

  it("PASSES when every bundle set carries the marker and the locale module", () => {
    const registered = `${JSON.stringify(MARKER)};${JSON.stringify(LOCALE_PHRASE)}`;
    const verdict = evaluateZodLocaleBundles([
      bundle("dist/main", "unrelated chunk", registered),
      bundle("dist/preload/index.cjs", registered),
      bundle("dist/renderer/assets", registered),
    ]);

    expect(verdict).toEqual({ ok: true, violations: [] });
  });

  it("FAILS when a required bundle set was never scanned", () => {
    const registered = `${JSON.stringify(MARKER)};${JSON.stringify(LOCALE_PHRASE)}`;
    const verdict = evaluateZodLocaleBundles([
      bundle("dist/main", registered),
      bundle("dist/preload/index.cjs", registered),
    ]);

    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toEqual([
      "dist/renderer/assets: bundle set was not scanned at all",
    ]);
  });

  it("FAILS when a required bundle set exists but emitted no files", () => {
    const registered = `${JSON.stringify(MARKER)};${JSON.stringify(LOCALE_PHRASE)}`;
    const verdict = evaluateZodLocaleBundles([
      bundle("dist/main", registered),
      bundle("dist/preload/index.cjs", registered),
      bundle("dist/renderer/assets"),
    ]);

    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toEqual([
      "dist/renderer/assets: no built files to scan",
    ]);
  });
});
