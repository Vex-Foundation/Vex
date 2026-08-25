/**
 * Vex Studio project contract schemas (stage P).
 *
 * The agent roster is a SET expressed as an array. The length cap alone does
 * not make it one: a duplicated id passes the cap while denoting a roster that
 * cannot exist, so the uniqueness refinement is the part that carries the
 * contract. Pinned here because the roster later selects instruction files and
 * installer behaviour, where a repeated id would mean a repeated install.
 */

import { describe, expect, it } from "vitest";
import {
  STUDIO_AGENT_IDS,
  projectCreateInputSchema,
  projectUpdateScopeInputSchema,
  studioAgentIdSchema,
  studioAgentsSchema,
} from "../projects.js";

/**
 * PARITY PIN, app half.
 *
 * `../projects.js` no longer authors the roster: it re-exports
 * `@vex-lib/studio-agent-ids.js`, which the engine's agent registry
 * (`src/vex-agent/studio/agents.ts`) reads too, because the root tsconfig
 * compiles only `src` and a second hand-kept copy would be a second source of
 * truth for a DURABLE stored value.
 *
 * The import removes drift in one direction and hides it in the other: an edit
 * in the lib would silently change this package's request validation. So both
 * sides pin the same literal list. The engine half is
 * `src/__tests__/lib/studio-agent-ids.test.ts`. Changing the roster means
 * editing the module and BOTH pins deliberately.
 */
const PINNED_ROSTER = [
  "claude-code",
  "codex",
  "gemini-cli",
  "opencode",
  "grok-build",
  "kimi",
  "qwen-code",
  "copilot-cli",
  "cursor",
  "amp",
  "kiro",
  "mistral-vibe",
  "cline",
  "droid",
  "warp",
];

describe("the canonical agent roster reaching the app schemas", () => {
  it("is exactly the reviewed list, in order", () => {
    expect([...STUDIO_AGENT_IDS]).toEqual(PINNED_ROSTER);
  });

  it("is the enum the request schema validates against", () => {
    expect(studioAgentIdSchema.options).toEqual(PINNED_ROSTER);
    expect(studioAgentIdSchema.safeParse("warp").success).toBe(true);
    expect(studioAgentIdSchema.safeParse("oz").success).toBe(false);
  });
});

describe("studioAgentsSchema", () => {
  it("accepts an empty roster and the full distinct roster", () => {
    expect(studioAgentsSchema.parse([])).toEqual([]);
    expect(studioAgentsSchema.parse([...STUDIO_AGENT_IDS])).toEqual([
      ...STUDIO_AGENT_IDS,
    ]);
  });

  it("rejects a duplicated agent id rather than silently de-duplicating it", () => {
    const outcome = studioAgentsSchema.safeParse(["codex", "codex"]);
    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.error.issues[0]?.message).toMatch(/at most once/i);
  });

  it("still rejects an unknown agent id", () => {
    expect(studioAgentsSchema.safeParse(["not-an-agent"]).success).toBe(false);
  });

  it("rejects a roster longer than the closed id list", () => {
    const tooMany = [...STUDIO_AGENT_IDS, "codex"];
    expect(studioAgentsSchema.safeParse(tooMany).success).toBe(false);
  });

  it("carries the same refusal through both project inputs", () => {
    const create = projectCreateInputSchema.safeParse({
      name: "My App",
      permission: "restricted",
      agents: ["codex", "codex"],
      wallets: { evm: null, solana: null },
    });
    expect(create.success).toBe(false);

    const update = projectUpdateScopeInputSchema.safeParse({
      projectId: "11111111-1111-4111-8111-111111111111",
      expectedScopeVersion: 1,
      agents: ["claude-code", "claude-code"],
    });
    expect(update.success).toBe(false);
  });
});
