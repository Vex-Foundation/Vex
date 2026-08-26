/**
 * The agent registry's SAFETY properties, at the location of risk.
 *
 * Four questions, each of which has a wrong answer that ships silently:
 *
 *   1. Does every canonical id have a record? (a missing one would make an
 *      agent selectable and then do nothing)
 *   2. Does every timeout mechanism outlast a Vex approval - measured against
 *      `APPROVAL_TTL_MS` itself, not a copied number - and does every mechanism
 *      that CANNOT say "yes" declare that honestly?
 *   3. Does an unsupported id produce a typed unsupported outcome and NO
 *      renderer? (exhaustiveness is proven by the compiler; the SHAPE is proven
 *      here)
 *   4. Are the never-written fields actually absent from every byte Vex
 *      AUTHORS? (they must be; a foreign occurrence in the user's file is a
 *      different question, answered by the golden suite, which proves it is
 *      preserved rather than removed)
 */

import { describe, it, expect } from "vitest";

import { STUDIO_AGENT_IDS } from "../../../lib/studio-agent-ids.js";
import { APPROVAL_TTL_MS } from "@vex-agent/engine/core/approval-runtime/enqueue.js";
import {
  STUDIO_AGENTS,
  STUDIO_AGENT_LIST,
  isWritableStudioAgent,
  studioTimeoutSeconds,
  type StudioAgent,
  type StudioWritableAgent,
} from "@vex-agent/studio/agents.js";
import { renderStudioAgentConfig } from "@vex-agent/studio/installer/render/index.js";

import { STUDIO_TEST_FACTS } from "./render-fixtures.js";

const writable = STUDIO_AGENT_LIST.filter(isWritableStudioAgent);

/**
 * THE BYTES VEX ITSELF AUTHORS for one agent.
 *
 * The fresh render is exactly that: every character of it came from the
 * renderer. It is the right surface for an ABSENCE audit, and the merged file
 * deliberately is not - a merged file legitimately contains the user's foreign
 * `[permission]` section, which Vex must PRESERVE, not remove. The golden suite
 * proves that preservation; this proves Vex never writes such a field itself.
 */
function vexAuthoredBytes(agent: StudioWritableAgent): string {
  const fresh = renderStudioAgentConfig(agent, STUDIO_TEST_FACTS);
  if (fresh.status !== "rendered") {
    throw new Error(`${agent.id}: fresh render returned ${fresh.status}`);
  }
  return fresh.text;
}

describe("the Studio agent registry", () => {
  it("has one record per canonical id, and no extra", () => {
    expect(Object.keys(STUDIO_AGENTS).sort()).toEqual([...STUDIO_AGENT_IDS].sort());
    expect(STUDIO_AGENT_LIST.map((agent) => agent.id)).toEqual([...STUDIO_AGENT_IDS]);
  });

  it("keys every record by its own id", () => {
    for (const id of STUDIO_AGENT_IDS) {
      expect(STUDIO_AGENTS[id].id).toBe(id);
    }
  });

  it("declares exactly cline and warp unsupported", () => {
    const unsupported = STUDIO_AGENT_LIST
      .filter((agent) => agent.configMode === "unsupported")
      .map((agent) => agent.id);
    expect(unsupported).toEqual(["cline", "warp"]);
  });

  it("declares exactly kimi launch-scoped", () => {
    const launch = STUDIO_AGENT_LIST
      .filter((agent) => agent.configMode === "launch")
      .map((agent) => agent.id);
    expect(launch).toEqual(["kimi"]);
  });
});

describe("the unsupported outcome", () => {
  it("carries a reason and a return condition, and no writable columns", () => {
    for (const agent of STUDIO_AGENT_LIST) {
      if (agent.configMode !== "unsupported") continue;

      expect(agent.reason.length).toBeGreaterThan(40);
      expect(agent.supportReturnsWhen.length).toBeGreaterThan(10);
      // No config path, dialect or renderer exists on this variant AT ALL, so
      // there is nothing for a caller to accidentally write.
      expect("configPath" in agent).toBe(false);
      expect("dialect" in agent).toBe(false);
      expect("ownedPaths" in agent).toBe(false);
    }
  });

  it("is excluded from the writable set by the type predicate", () => {
    const asAgents: readonly StudioAgent[] = STUDIO_AGENT_LIST;
    const narrowed = asAgents.filter(isWritableStudioAgent);
    expect(narrowed.map((agent) => agent.id)).not.toContain("cline");
    expect(narrowed.map((agent) => agent.id)).not.toContain("warp");
    expect(narrowed).toHaveLength(13);
  });

  it("has no renderer: `renderStudioAgentConfig` accepts only writable records", () => {
    // The compile-time proof is the signature. This is the runtime half: every
    // record the predicate admits renders, and the two it rejects are exactly
    // the unsupported ids, so no third path can quietly appear.
    for (const agent of writable) {
      expect(renderStudioAgentConfig(agent, STUDIO_TEST_FACTS).status).toBe("rendered");
    }
  });
});

describe("every timeout mechanism against the approval TTL", () => {
  const approvalSeconds = APPROVAL_TTL_MS / 1000;

  it("uses a one-hour approval TTL, which is what the margins are sized against", () => {
    expect(approvalSeconds).toBe(3600);
  });

  it("outlasts an approval wherever Vex can influence it", () => {
    for (const agent of writable) {
      const seconds = studioTimeoutSeconds(agent.timeout);
      if (seconds === null) continue;
      expect(
        seconds,
        `${agent.id}: ${agent.timeout.kind} must outlast a full approval wait`,
      ).toBeGreaterThan(approvalSeconds);
      // 3900 s / 65 min is the authored margin: five minutes past the TTL.
      expect(seconds).toBeGreaterThanOrEqual(3900);
    }
  });

  it("writes 3900 seconds, in the field's own unit, wherever it writes at all", () => {
    for (const agent of writable) {
      if (agent.timeout.kind !== "server-entry-field") continue;
      const { unit, value, seconds } = agent.timeout;
      expect(seconds).toBe(3900);
      expect(value).toBe(unit === "ms" ? 3_900_000 : 3900);
    }
  });

  it("says so honestly when Vex cannot influence the timeout", () => {
    const unresolved = writable.filter((agent) => studioTimeoutSeconds(agent.timeout) === null);
    expect(unresolved.map((agent) => agent.id).sort()).toEqual([
      "amp",
      "cursor",
      "kimi",
      "kiro",
    ]);

    for (const agent of unresolved) {
      if (agent.timeout.kind === "unverified") {
        // A named owed probe, not an assumption that the client waits forever.
        expect(agent.timeout.probe).toContain("A-test");
      } else if (agent.timeout.kind === "user-global-config") {
        // The documented default is INSUFFICIENT and the user must act.
        expect(agent.timeout.documentedDefaultSeconds).toBeLessThan(approvalSeconds);
        expect(agent.timeout.userAction).toContain("3900000");
      } else {
        throw new Error(`${agent.id}: unexpected unresolved mechanism ${agent.timeout.kind}`);
      }
    }
  });

  it("never writes a client-process environment variable into the bridge child", () => {
    // Claude's bound lives in `MCP_TOOL_TIMEOUT`, a variable of the CLIENT's own
    // process. Recording it must never turn into writing it: no rendered
    // artifact may mention it, and no entry may carry an `env` map at all.
    for (const agent of writable) {
      const text = vexAuthoredBytes(agent);
      expect(text).not.toContain("MCP_TOOL_TIMEOUT");
      expect(text).not.toContain("CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT");
      expect(text).not.toMatch(/^\s*"?env"?\s*[:=]/m);
      expect(text).not.toMatch(/^\s*"?environment"?\s*[:=]/m);
    }
  });
});

describe("never-written fields", () => {
  it("are absent from every byte Vex authors, for every agent", () => {
    for (const agent of writable) {
      const text = vexAuthoredBytes(agent);
      for (const field of agent.neverWritten) {
        expect(text, `${agent.id} must never emit ${field}`).not.toContain(field);
      }
    }
  });

  it("are recorded as bare tokens, so the absence assertion is meaningful", () => {
    // A record that wrote "`amp.mcpPermissions` with action \"allow\"" would make
    // the assertion above test a sentence that trivially never appears. Bare
    // tokens keep it honest; the full spellings live in the matrix document.
    for (const agent of STUDIO_AGENT_LIST) {
      for (const field of agent.neverWritten) {
        expect(field, `${agent.id}: ${field}`).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      }
    }
  });

  it("are absent CROSS-AGENT too, so no dialect leaks another's policy field", () => {
    // The dangerous ones are worth asserting globally rather than per row: a
    // renderer bug that emitted `autoApprove` into Kiro would be caught above,
    // but one that emitted it into Cursor would not.
    const globallyForbidden = [
      "autoApprove",
      "trust",
      "permission",
      "approval_policy",
      "hasTrustDialogAccepted",
      "enableAllProjectMcpServers",
      "folderTrust",
      "allow",
    ];
    for (const agent of writable) {
      const text = vexAuthoredBytes(agent);
      for (const name of globallyForbidden) {
        expect(text, `${agent.id} fresh config must not contain ${name}`).not.toContain(name);
      }
    }
  });

  it("records the cline `type` trap even though cline has no writer", () => {
    // An omitted `type` means legacy SSE in Cline's dialect, the inverse of
    // Claude's default. The fact is recorded now so a future writer cannot be
    // built on the wrong assumption.
    expect(STUDIO_AGENTS.cline.neverWritten).toContain("type");
    expect(STUDIO_AGENTS.cline.configMode).toBe("unsupported");
  });
});
