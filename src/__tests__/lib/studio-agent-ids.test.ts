/**
 * PARITY PIN for the canonical Studio agent roster.
 *
 * The roster is a DURABLE value: it is stored in a project's agent scope, so a
 * silent re-spelling or reordering is a data problem, not a refactor. It lives
 * in `src/lib/studio-agent-ids.ts` because the root tsconfig compiles only
 * `src` - the engine cannot import a vex-app module - while vex-app CAN import
 * this one through its existing `@vex-lib/*` alias, which is what
 * `vex-app/src/shared/schemas/projects.ts` now does.
 *
 * That import makes drift impossible in one direction but invisible in the
 * other: an edit here would silently change the app's request validation. So
 * BOTH sides pin the same literal list. This file is one half; the other is
 * `vex-app/src/shared/schemas/__tests__/projects.test.ts`. Changing the roster
 * means editing the module and both pins deliberately.
 */

import { describe, it, expect } from "vitest";

import {
  STUDIO_AGENT_IDS,
  isStudioAgentId,
  type StudioAgentId,
} from "../../lib/studio-agent-ids.js";

/** The reviewed roster, in picker order. Duplicated ON PURPOSE - it is the pin. */
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
] as const;

describe("the canonical Studio agent roster", () => {
  it("is exactly the reviewed list, in order", () => {
    expect([...STUDIO_AGENT_IDS]).toEqual([...PINNED_ROSTER]);
  });

  it("has fifteen ids and no duplicates", () => {
    expect(STUDIO_AGENT_IDS).toHaveLength(15);
    expect(new Set(STUDIO_AGENT_IDS).size).toBe(STUDIO_AGENT_IDS.length);
  });

  it("narrows an untrusted string only when it is a member", () => {
    const candidate: string = "codex";
    expect(isStudioAgentId(candidate)).toBe(true);
    if (isStudioAgentId(candidate)) {
      const narrowed: StudioAgentId = candidate;
      expect(narrowed).toBe("codex");
    }

    expect(isStudioAgentId("cody")).toBe(false);
    expect(isStudioAgentId("")).toBe(false);
    // Not a member merely because `Array.prototype` has the name.
    expect(isStudioAgentId("length")).toBe(false);
  });
});
