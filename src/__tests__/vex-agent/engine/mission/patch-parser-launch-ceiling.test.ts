/**
 * C6 — THE MODEL MUST NEVER BE ABLE TO SET ITS OWN LAUNCH SPEND CEILING.
 *
 * If you are here because you added `maxLaunchValueRaw` to an allowlist in
 * `patch-parser.ts` and this test went red: that is the test doing its job.
 * DO NOT delete it and DO NOT add the key.
 *
 * `maxLaunchValueRaw` / `maxLaunchValueDecimals` are the hard ceiling on what
 * an unattended mission may spend creating a token with real funds, and
 * `maxLaunchCount` (C6b) is the hard cap on how many it may create. Rule 90:
 * "fee, limit, and destination parameters must never originate from model
 * input." A cap the model can raise is not a cap — and it is WORSE than no cap,
 * because the contract surface would show the user a limit that does not bind.
 *
 * The ceiling is host-authored only. The model READS it (via
 * `draftToPromptContext`) and picks an amount up to it.
 */

import { describe, it, expect } from "vitest";

import {
  MODEL_FORBIDDEN_KEYS,
  extractMissionPatch,
} from "@vex-agent/engine/mission/patch-parser.js";
import { draftToPromptContext } from "@vex-agent/engine/mission/mapper.js";
import type { Mission } from "@vex-agent/db/repos/missions.js";

describe("patch-parser — the launch ceiling is host-authored only (C6 / rule 90)", () => {
  it("names every ceiling field as forbidden to model input", () => {
    expect([...MODEL_FORBIDDEN_KEYS].sort()).toEqual([
      // C6b added the count cap: a model that could raise how MANY tokens it
      // may mint is as unbounded as one that could raise the per-launch spend.
      "maxLaunchCount",
      "maxLaunchValueDecimals",
      "maxLaunchValueRaw",
    ]);
  });

  it("DROPS a model attempt to set its own maxLaunchCount", () => {
    const patch = extractMissionPatch({ goal: "launch tokens", maxLaunchCount: 99 });

    expect(patch).toEqual({ goal: "launch tokens" });
    expect(patch).not.toHaveProperty("maxLaunchCount");
  });

  it("DROPS a model attempt to set its own maxLaunchValueRaw", () => {
    const patch = extractMissionPatch({
      goal: "launch a token",
      maxLaunchValueRaw: "999999999999999999999",
      maxLaunchValueDecimals: 18,
    });

    expect(patch).not.toBeNull();
    expect(patch).toEqual({ goal: "launch a token" });
    expect(patch).not.toHaveProperty("maxLaunchValueRaw");
    expect(patch).not.toHaveProperty("maxLaunchValueDecimals");
  });

  it("drops the ceiling even when it is the ONLY key the model sent", () => {
    // Nothing survives the allowlist, so there is no patch at all — the model
    // cannot even produce an empty-but-present ceiling write.
    const patch = extractMissionPatch({ maxLaunchValueRaw: "1", maxLaunchValueDecimals: 18 });
    expect(patch).toBeNull();
    expect(extractMissionPatch({ maxLaunchCount: 3 })).toBeNull();
  });

  it("still lets the model READ the ceiling it is bound by", () => {
    const mission = {
      id: "m1",
      title: "Launch",
      goal: "launch a token",
      riskProfile: null,
      allowedWallets: [],
      allowedChains: [],
      allowedProtocols: [],
      successCriteriaJson: [],
      stopConditionsJson: [],
      capitalSourceJson: {},
      constraintsJson: {
        maxLaunchValueRaw: "2000000000000000",
        maxLaunchValueDecimals: 18,
        maxLaunchCount: 2,
      },
      approvedAt: null,
    } as unknown as Mission;

    const prompt = draftToPromptContext(mission);
    expect(prompt).toContain("Max launch value");
    expect(prompt).toContain("2000000000000000");
    expect(prompt).toContain("refused, not clamped");
    // C6b — the count cap is disclosed to the model for the same reason: it
    // should pick a bounded plan, not discover the refusal at signing time.
    expect(prompt).toContain("Max launch count");
    expect(prompt).toContain("Launches still settling count");
  });
});
