/**
 * Mission-run prompt — the `mission_stop(summary=...)` authoring guidance.
 *
 * The `summary` the agent passes to `mission_stop` is the ONLY prose a user
 * ever reads about their run. Without explicit guidance the model writes it
 * in trader shorthand ("flattened TP1, -17bps round-trip"), which is
 * unreadable for the non-technical operator the mission UI is built for.
 *
 * These assertions pin the contract of that guidance: bulleted, jargon-free,
 * and — critically — SILENT on the run's gain or loss.
 *
 * That last rule is not a style preference. A fork build rendered Mission #9
 * with a ledger PnL of -$0.57 above the agent's own bullet claiming it
 * "ended down about 33 cents — basically flat". The model had netted the
 * trade legs but not the gas, understating a real loss by ~42%. Prose that
 * confidently misreports the user's money is worse than the raw metrics it
 * replaces, so the division of labour is absolute: NUMBERS COME FROM THE
 * LEDGER, PROSE COMES FROM THE AGENT.
 *
 * They are deliberately behavioural (what the instruction must require)
 * rather than a snapshot of the exact wording, so copy edits stay cheap.
 */

import { describe, expect, it } from "vitest";

import type { EngineContext } from "../../../../vex-agent/engine/types.js";
import { buildMissionRunPrompt } from "../../../../vex-agent/engine/prompts/mission-run.js";

function missionContext(): EngineContext {
  return {
    sessionId: "session-1",
    sessionKind: "mission",
    sessionPermission: "restricted",
    missionId: "mission-1",
    missionRunId: "run-1",
    isSubagent: false,
    loadedDocuments: new Map(),
  };
}

describe("mission-run prompt — mission_stop summary guidance", () => {
  it("tells the agent the summary is the user-facing mission summary", () => {
    const prompt = buildMissionRunPrompt(missionContext());

    expect(prompt).toContain("user-facing Mission Summary");
    expect(prompt).toContain("NON-technical");
  });

  it("requires 3-6 short bullets, one beat per line, never a paragraph", () => {
    const prompt = buildMissionRunPrompt(missionContext());

    expect(prompt).toContain("3-6 short BULLET POINTS");
    expect(prompt).toContain('starting with "- "');
    expect(prompt).toContain("do NOT write a paragraph");
  });

  it("names the beats the summary must cover, in order", () => {
    const prompt = buildMissionRunPrompt(missionContext());

    // what you looked for -> what you bought and why -> how much (vs the cap)
    // -> the plan in plain words -> how the run ended.
    expect(prompt).toContain("what you were looking for");
    expect(prompt).toContain("what you actually bought and WHY you picked it");
    expect(prompt).toContain("how that compares to the cap");
    expect(prompt).toContain("automatic sell levels");
    expect(prompt).toContain("how the run ENDED");
  });

  it("forbids the agent from stating any gain-or-loss figure", () => {
    const prompt = buildMissionRunPrompt(missionContext());

    expect(prompt).toContain("NEVER state how much the mission made or lost");
    // Every denomination is closed off, or the model just switches units.
    expect(prompt).toContain("not in dollars, not in ETH, not as a percentage");
    // ...including the qualitative dodge that produced the Mission #9 defect.
    expect(prompt).toContain("about even");
    expect(prompt).toContain("break-even");
  });

  it("tells the agent WHY it cannot compute PnL — gas settles after it stops", () => {
    const prompt = buildMissionRunPrompt(missionContext());

    // A bare prohibition invites rationalisation; the reason is what makes it
    // stick. Gas is precisely what the Mission #9 summary omitted.
    expect(prompt).toContain("gas and fees settle after you stop");
    expect(prompt).toContain("anything you compute here will be wrong");
  });

  it("points the agent at the ledger figure as the authoritative one", () => {
    const prompt = buildMissionRunPrompt(missionContext());

    expect(prompt).toContain("the exact figure from the ledger");
    expect(prompt).toContain("leave every gain-or-loss number to the system");
  });

  it("never invites a model-computed net PnL anywhere in the guidance", () => {
    const prompt = buildMissionRunPrompt(missionContext());

    // Regression guard on the ORIGINAL wording of this guidance, which asked
    // for outcomes "always framed in DOLLARS, with the net gain or loss" and
    // exemplified "- Ended about even — down 17 cents to trading fees". That
    // instruction is what produced the -$0.57-reported-as-33-cents defect.
    for (const invitation of [
      "net gain or loss",
      "with the net gain",
      "down 17 cents to trading fees",
      "framed in DOLLARS",
    ]) {
      expect(prompt).not.toContain(invitation);
    }
  });

  it("bans the internal trading jargon that leaks into raw model prose", () => {
    const prompt = buildMissionRunPrompt(missionContext());

    expect(prompt).toContain("NO jargon or internal terms");
    for (const banned of ["bps", "TP", "SL", "flatten", "round-trip", "slippage", "basis points"]) {
      expect(prompt).toContain(banned);
    }
    expect(prompt).toContain("no chain IDs");
  });

  it("gives concrete plain-language exemplars the model can imitate", () => {
    const prompt = buildMissionRunPrompt(missionContext());

    expect(prompt).toContain("Looked at 12 trending coins");
    expect(prompt).toContain("well under your $20 limit");
    expect(prompt).toContain("Set an automatic take-profit and a safety stop");
    expect(prompt).toContain("Sold it back when your 15-minute timer ran out");
  });

  it("owns an unprofitable run in words, without quantifying it", () => {
    const prompt = buildMissionRunPrompt(missionContext());

    expect(prompt).toContain("one short, honest line");
    expect(prompt).toContain("Own an unprofitable run plainly");
    expect(prompt).toContain("never quantify it");
    // The sanctioned way to describe a loss: cause, not amount.
    expect(prompt).toContain("the safety stop sold it");
  });

  it("keeps the guidance attached to the mission_stop rule block", () => {
    const prompt = buildMissionRunPrompt(missionContext());

    const stopRuleIdx = prompt.indexOf("mission_stop(reason=");
    const guidanceIdx = prompt.indexOf("user-facing Mission Summary");
    const contractRuleIdx = prompt.indexOf("For any non-success reason");

    expect(stopRuleIdx).toBeGreaterThan(-1);
    expect(guidanceIdx).toBeGreaterThan(stopRuleIdx);
    expect(guidanceIdx).toBeLessThan(contractRuleIdx);
  });
});
