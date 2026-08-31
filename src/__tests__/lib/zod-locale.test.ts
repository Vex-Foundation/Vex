/**
 * zod's English locale is registered as a MODULE-LEVEL side effect inside zod
 * itself, and zod 4.4.3 declares `"sideEffects": false`, so a bundler is free
 * to drop it. `src/lib/zod-locale.ts` is the one owner that re-registers it
 * explicitly and self-checks the result. These tests cover the classifier and
 * the injection seam; the BUILT bundles are covered by the
 * "zod english locale registered in privileged bundles" gate in
 * vex-app/scripts/check-privileged-bundles.mjs, which is the only place that
 * can prove tree-shaking did not take the call away again.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ZOD_LOCALE_MARKER,
  probeZodLocale,
  readZodLocaleSampleMessage,
  registerZodLocale,
} from "../../lib/zod-locale.js";

describe("zod locale registration", () => {
  it("is idempotent and leaves zod parsing localized", () => {
    registerZodLocale();
    registerZodLocale();

    const parsed = z.array(z.string()).max(0).safeParse(["x"]);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).not.toBe("Invalid input");
    expect(parsed.error.issues[0]?.message).toContain("expected array to have");
  });

  it("reads a real failing parse as its sample message", () => {
    registerZodLocale();
    expect(readZodLocaleSampleMessage()).toContain("expected array to have");
  });
});

describe("probeZodLocale", () => {
  it("reports a localized runtime when the sample message names the constraint", () => {
    registerZodLocale();
    const probe = probeZodLocale(
      () => "Too big: expected array to have <=0 items",
    );
    expect(probe.localized).toBe(true);
    expect(probe.marker).toBe(ZOD_LOCALE_MARKER);
    expect(probe.sampleMessage).toBe("Too big: expected array to have <=0 items");
  });

  /**
   * THE OWNERSHIP RULE THE POST-BUILD GATE RESTS ON. The marker is written by
   * `registerZodLocale` and by nothing else, so a process (or a bundle) that
   * only probes cannot produce it. Before this, the probe named the literal
   * itself, which is why a bundle with registration tree-shaken away still
   * carried the marker and passed
   * `vex-app/scripts/check-privileged-bundles.mjs`.
   *
   * A fresh module instance is the only way to observe the unregistered state,
   * because registration is process-global by design.
   */
  it("reports NO marker until registerZodLocale has run", async () => {
    vi.resetModules();
    const fresh = await import("../../lib/zod-locale.js");

    expect(fresh.probeZodLocale(() => "Invalid input").marker).toBeNull();

    fresh.registerZodLocale();
    expect(fresh.probeZodLocale(() => "Invalid input").marker).toBe(
      ZOD_LOCALE_MARKER,
    );
  });

  /**
   * The probe's own sample value must not be the marker: if it were, a bundle
   * that reaches only `readZodLocaleSampleMessage` would carry the literal and
   * the gate would be vacuous again.
   */
  it("does not carry the marker in the value it parses", () => {
    expect(readZodLocaleSampleMessage.toString()).not.toContain(
      ZOD_LOCALE_MARKER,
    );
  });

  it("reports a MISSING locale when zod falls back to the generic core message", () => {
    const probe = probeZodLocale(() => "Invalid input");
    expect(probe.localized).toBe(false);
    expect(probe.sampleMessage).toBe("Invalid input");
  });

  it("reports a missing locale when the probe schema produced no issue at all", () => {
    const probe = probeZodLocale(() => "");
    expect(probe.localized).toBe(false);
  });
});
