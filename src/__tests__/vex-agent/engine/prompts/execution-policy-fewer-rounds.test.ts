/**
 * Kairos Phase 5 prompt rules in `# Execution Policy`, rendered in every mode:
 *   - B-4 act, don't narrate: every response calls the next tool(s) or
 *     delivers the answer; waiting for approval or a reply is a valid end;
 *   - T-2 batch independent reads into one response.
 */
import { describe, expect, it } from "vitest";

import {
  buildPermissionPrompt,
  type ExecutionPhase,
} from "../../../../vex-agent/engine/prompts/execution-policy.js";

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
