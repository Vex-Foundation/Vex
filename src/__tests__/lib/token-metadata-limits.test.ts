/**
 * ONE DEFINITION OF THE METADATA CAPS.
 *
 * The caps used to be hand-typed in three places: the launch validator, the
 * launch preview, and the IPC form schema. This pins the VALUES, exactly as
 * they were measured, so a "shared module" refactor cannot quietly move a limit
 * a launch is refused at.
 *
 * WHAT THIS TEST LOST WITH TRENCH EXPRESS. It used to drive
 * `trench/handlers/launch/validate.ts` at each cap, which was the evidence that
 * the agent-runtime surface read this module rather than a leftover copy.
 * Migration 108 retired that protocol and its validator; the surviving consumer
 * is the pools.fun IPC schema, which lives in `vex-app` and cannot be imported
 * from a root test. Its own suite covers it there, so what remains here is the
 * definition itself - and the deliberate name/symbol asymmetry, which is a
 * product decision no measurement would restore if it were tidied away.
 */

import { describe, it, expect } from "vitest";

import {
  TOKEN_METADATA_NAME_MAX,
  TOKEN_METADATA_SYMBOL_MAX,
  TOKEN_METADATA_IMAGE_ONCHAIN_MAX_BYTES,
} from "../../lib/token-metadata-limits.js";

describe("token metadata caps", () => {
  it("keeps the measured values unchanged by the retirement", () => {
    expect(TOKEN_METADATA_NAME_MAX).toBe(18);
    expect(TOKEN_METADATA_SYMBOL_MAX).toBe(16);
    expect(TOKEN_METADATA_IMAGE_ONCHAIN_MAX_BYTES).toBe(20_480);
  });

  it("keeps the symbol cap DELIBERATELY tighter than the name cap it was measured with", () => {
    // The measurement put both at 18. Vex refuses a symbol past 16 on purpose;
    // this pins the difference so it cannot be "tidied" away.
    expect(TOKEN_METADATA_SYMBOL_MAX).toBeLessThan(TOKEN_METADATA_NAME_MAX);
  });
});
