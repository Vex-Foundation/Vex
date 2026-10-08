import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LOCK_BUTTON } from "../lock-button.js";

// This flag enters the renderer; its source must stay independent of privileged code.
describe("lock feature flag isolation", () => {
  it("shares a dependency-free literal with the engine", () => {
    const source = readFileSync(new URL("../../../../src/lib/lock-button.ts", import.meta.url), "utf8");
    expect(source).toMatch(/export const LOCK_BUTTON = (true|false);/);
    expect(source).not.toMatch(/\bimport\b|\brequire\s*\(/);
    expect(typeof LOCK_BUTTON).toBe("boolean");
  });
});
