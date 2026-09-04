/**
 * THE PLAN is exhaustive over the roster (stage A5b item 8).
 *
 * The property that matters: for EVERY canonical agent id, selecting it
 * produces either an artifact to render or an explicit `unsupported` entry.
 * Never silence. A future id added to the roster without a registry record, or
 * with a config mode nothing handles, fails here rather than disappearing from
 * a user's project without a word.
 */

import { describe, expect, it } from "vitest";

import { STUDIO_AGENTS, isWritableStudioAgent } from "@vex-agent/studio/agents.js";
import { STUDIO_AGENT_IDS, type StudioAgentId } from "@shared/schemas/projects.js";
import {
  STUDIO_GENERATOR_REVISION,
  agentArtifactKey,
  buildStudioPlan,
  studioGeneratorFingerprint,
} from "../installer/plan.js";

const ALL_IDS = [...STUDIO_AGENT_IDS] as StudioAgentId[];

describe("plan coverage", () => {
  it.each(ALL_IDS)("%s produces an artifact or an explicit unsupported entry", (id) => {
    const plan = buildStudioPlan({ selectedAgentIds: [id], previouslyWritten: new Set() });
    const agent = STUDIO_AGENTS[id];

    if (isWritableStudioAgent(agent)) {
      const artifact = plan.artifacts.find((item) => item.agentId === id);
      expect(artifact, `${id} must plan an artifact`).toBeDefined();
      expect(artifact?.relativePath).toBe(agent.configPath);
      expect(artifact?.key).toBe(agentArtifactKey(id));
      expect(plan.unsupported).toEqual([]);
    } else {
      expect(plan.artifacts.some((item) => item.agentId === id)).toBe(false);
      const entry = plan.unsupported.find((item) => item.agentId === id);
      expect(entry, `${id} must produce an unsupported outcome`).toBeDefined();
      expect(entry?.reason.length).toBeGreaterThan(0);
      expect(entry?.supportReturnsWhen.length).toBeGreaterThan(0);
    }
  });

  it("always plans the four instruction artifacts, whatever is selected", () => {
    for (const selection of [[], ALL_IDS]) {
      const plan = buildStudioPlan({
        selectedAgentIds: selection,
        previouslyWritten: new Set(),
      });
      expect(plan.artifacts.map((a) => a.key)).toEqual(
        expect.arrayContaining(["agents-md", "vex-guide", "claude-md", "protocols-doc"]),
      );
    }
  });

  it("plans a REMOVE for a deselected agent Vex previously wrote for", () => {
    const plan = buildStudioPlan({
      selectedAgentIds: [],
      previouslyWritten: new Set([agentArtifactKey("codex")]),
    });
    const removal = plan.artifacts.find((item) => item.agentId === "codex");
    expect(removal?.operation).toBe("remove");
  });

  it("plans NOTHING for an agent that was never written and is not selected", () => {
    const plan = buildStudioPlan({ selectedAgentIds: [], previouslyWritten: new Set() });
    expect(plan.artifacts.every((item) => item.kind !== "agent-config")).toBe(true);
  });

  it("ignores a provenance key for an id that is no longer in the roster", () => {
    const plan = buildStudioPlan({
      selectedAgentIds: [],
      previouslyWritten: new Set(["agent:retired-tool", "not-an-agent-key"]),
    });
    expect(plan.artifacts.every((item) => item.kind !== "agent-config")).toBe(true);
  });
});

describe("the generator fingerprint", () => {
  it("carries the Vex version AND the renderer revision", () => {
    expect(studioGeneratorFingerprint("1.2.3")).toBe(`1.2.3+${STUDIO_GENERATOR_REVISION}`);
  });

  it("changes when either half changes", () => {
    expect(studioGeneratorFingerprint("1.2.3")).not.toBe(studioGeneratorFingerprint("1.2.4"));
  });
});
