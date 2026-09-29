/**
 * Kairos Phase 5 prompt rules in `# Execution Policy`, rendered in every mode:
 *   - B-4 act, don't narrate: every response calls the next tool(s) or
 *     delivers the answer; waiting for approval or a reply is a valid end;
 *   - T-2 batch independent reads into one response.
 * Plus the B-1 mission-run wording: never abandon; defer when idle.
 */
import { describe, expect, it } from "vitest";

import {
  buildPermissionPrompt,
  type ExecutionPhase,
} from "../../../../vex-agent/engine/prompts/execution-policy.js";
import { buildMissionRunPrompt } from "../../../../vex-agent/engine/prompts/mission-run.js";
import { makeContext } from "./_prompt-stack-helpers.js";

const PHASES: readonly ExecutionPhase[] = ["agent", "mission_setup", "mission_run"];
const PERMISSIONS = ["restricted", "full"] as const;

const MODES = PHASES.flatMap((phase) =>
  PERMISSIONS.map((permission) => ({ phase, permission })),
);

describe("execution policy: fewer rounds rules", () => {
  it.each(MODES)("$phase / $permission carries both rules once", ({ phase, permission }) => {
    const prompt = buildPermissionPrompt({ phase, permission });
    expect(prompt.split("- Act, don't narrate:")).toHaveLength(2);
    expect(prompt.split("- Batch independent reads:")).toHaveLength(2);
  });

  it("act rule names the valid end states, so it never reads as always call a tool", () => {
    const prompt = buildPermissionPrompt({ phase: "agent", permission: "restricted" });
    expect(prompt).toContain("every response either calls the next tool(s) or delivers the\n  answer");
    expect(prompt).toContain("Waiting for the\n  user's approval or reply is a valid end.");
  });

  it("batching advice is limited to independent reads, never mutations", () => {
    const prompt = buildPermissionPrompt({ phase: "mission_run", permission: "full" });
    expect(prompt).toContain("issue them together\n  in one response");
    expect(prompt).toContain("mutating calls go one step at a time");
  });
});

describe("mission run prompt: honest idle (B-1)", () => {
  const prompt = buildMissionRunPrompt(
    makeContext({ sessionKind: "mission", missionId: "m-1", missionRunId: "r-1" }),
  );

  it("says never abandon, and defer with a reason when nothing is actionable", () => {
    expect(prompt).toContain("never abandon the mission");
    expect(prompt).toContain("when nothing is actionable now, call `LoopDefer` with a reason");
    expect(prompt).toContain("A chat response does not stop or pause the run");
    expect(prompt).not.toContain("never stop");
  });

  it("leaves the MissionStop contract as it was", () => {
    expect(prompt).toContain(
      "Valid reasons: goal_reached, deadline_reached, capital_depleted, max_loss_hit, no_viable_opportunity, emergency_stop",
    );
    expect(prompt).toContain("Never use MissionStop to express uncertainty");
    expect(prompt).toContain("Do NOT just write about stopping");
  });
});
