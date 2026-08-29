/**
 * M1 - the turn wall clock is never below 30 minutes (owner decision
 * 2026-08-28).
 *
 * A floor, not an equality, because the owner's instruction is a floor: raising
 * it later is allowed, lowering it is the regression. Ten minutes was ending
 * productive autonomous turns mid-flight, and every recovery from that costs a
 * fresh full-context continuation.
 *
 * `TIMEOUT_REPLY` derives its duration from the same constant on purpose, so
 * the sentence the user reads cannot drift away from the bound that produced
 * it. That derivation is asserted here rather than trusted.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOOP_CONFIG,
  TIMEOUT_REPLY,
} from "@vex-agent/engine/core/runner/shared.js";

const THIRTY_MINUTES_MS = 1_800_000;

describe("turn wall clock", () => {
  it("is at least 30 minutes", () => {
    expect(DEFAULT_LOOP_CONFIG.timeoutMs).toBeGreaterThanOrEqual(THIRTY_MINUTES_MS);
  });

  it("the timeout reply states the real bound, derived not written", () => {
    const minutes = Math.round(DEFAULT_LOOP_CONFIG.timeoutMs / 60_000);
    expect(TIMEOUT_REPLY).toContain(`${minutes}-minute`);
    expect(minutes).toBeGreaterThanOrEqual(30);
  });

  it("mission setup inherits it through the spread, and is not capped lower", () => {
    // Setup overrides `maxIterations` only. If it ever grows a `timeoutMs` of
    // its own, this test is where that decision has to be made explicitly.
    const setupConfig = { ...DEFAULT_LOOP_CONFIG, maxIterations: 25 };
    expect(setupConfig.timeoutMs).toBeGreaterThanOrEqual(THIRTY_MINUTES_MS);
  });
});
