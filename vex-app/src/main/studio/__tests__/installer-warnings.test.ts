/**
 * The warnings that make "the file was written" an honest answer.
 *
 * Each of these is a way a perfectly correct config still does nothing, and
 * every one of them is silent in the client. Telling the user is the whole
 * point; asserting it here is what stops a future refactor from dropping the
 * telling.
 */

import { describe, expect, it } from "vitest";

import {
  STUDIO_AGENTS,
  isWritableStudioAgent,
  type StudioWritableAgent,
} from "@vex-agent/studio/agents.js";
import type { StudioAgentId } from "@shared/schemas/projects.js";
import type { StudioArtifactOutcome } from "@shared/schemas/studio-installer.js";
import { buildStudioPlan } from "../installer/plan.js";
import { collectStudioWarnings, detectForeignAuthority } from "../installer/warnings.js";

/** Narrow a registry record to the writable variant without an unsafe cast. */
function writable(id: keyof typeof STUDIO_AGENTS): StudioWritableAgent {
  const agent = STUDIO_AGENTS[id];
  if (!isWritableStudioAgent(agent)) throw new Error(`${id} has no writer`);
  return agent;
}

function written(agentId: StudioAgentId, path: string): StudioArtifactOutcome {
  return {
    status: "written",
    kind: "agent-config",
    agentId,
    path,
    change: "created",
  };
}

describe("registry-derived warnings", () => {
  it("says a Codex config is inert until the folder is trusted", () => {
    const plan = buildStudioPlan({ selectedAgentIds: ["codex"], previouslyWritten: new Set() });
    const warnings = collectStudioWarnings(plan, [written("codex", ".codex/config.toml")]);
    const inert = warnings.find((w) => w.kind === "inert_until");
    expect(inert?.agentId).toBe("codex");
    expect(inert?.detail).toContain("trusts this project");
  });

  it("tells the user the exact command Kimi must be launched with", () => {
    const plan = buildStudioPlan({ selectedAgentIds: ["kimi"], previouslyWritten: new Set() });
    const warnings = collectStudioWarnings(plan, [written("kimi", ".vex/mcp/kimi.json")]);
    const launch = warnings.find((w) => w.kind === "launch_required");
    expect(launch?.detail).toContain("--mcp-config-file");
    expect(launch?.detail).toContain(".vex/mcp/kimi.json");
  });

  it("surfaces Kimi's user-global 60 s timeout as a user action", () => {
    const plan = buildStudioPlan({ selectedAgentIds: ["kimi"], previouslyWritten: new Set() });
    const warnings = collectStudioWarnings(plan, [written("kimi", ".vex/mcp/kimi.json")]);
    const timeout = warnings.find((w) => w.kind === "user_global_timeout");
    expect(timeout?.detail).toContain("~/.kimi/config.toml");
    expect(timeout?.detail).toContain("3900000");
  });

  it("admits an UNVERIFIED timeout rather than assuming none exists", () => {
    const plan = buildStudioPlan({ selectedAgentIds: ["cursor"], previouslyWritten: new Set() });
    const warnings = collectStudioWarnings(plan, [written("cursor", ".cursor/mcp.json")]);
    expect(warnings.some((w) => w.kind === "timeout_unverified")).toBe(true);
  });

  it("warns about NOTHING for an agent whose write refused", () => {
    const plan = buildStudioPlan({ selectedAgentIds: ["codex"], previouslyWritten: new Set() });
    const warnings = collectStudioWarnings(plan, [
      {
        status: "refused",
        kind: "agent-config",
        agentId: "codex",
        path: ".codex/config.toml",
        reason: "malformed_toml",
        detail: "nope",
      },
    ]);
    expect(warnings.filter((w) => w.agentId === "codex")).toEqual([]);
  });
});

describe("foreign authority found in the bytes", () => {
  it("reports a foreign [permission] section beside our entry", () => {
    const warning = detectForeignAuthority(
      "[permission]\nallow = [\"shell\"]\n\n[mcp_servers.vex]\ncommand = \"/x\"\n",
      writable("grok-build"),
    );
    expect(warning?.kind).toBe("foreign_authority_section");
    expect(warning?.detail).toContain("permission");
    expect(warning?.detail).toContain("never removes them");
  });

  it("reports Kiro's autoApprove", () => {
    const warning = detectForeignAuthority(
      "{\"mcpServers\":{\"other\":{\"autoApprove\":[\"*\"]}}}",
      writable("kiro"),
    );
    expect(warning?.kind).toBe("foreign_authority_section");
    expect(warning?.detail).toContain("autoApprove");
  });

  it("does not report a mention inside a comment", () => {
    expect(
      detectForeignAuthority(
        "# no permission rules here\ntheme = \"dark\"\n",
        writable("grok-build"),
      ),
    ).toBeNull();
  });

  it("is silent on a clean file", () => {
    expect(
      detectForeignAuthority(
        "{\"mcpServers\":{\"vex\":{\"command\":\"/x\"}}}",
        writable("claude-code"),
      ),
    ).toBeNull();
  });
});
