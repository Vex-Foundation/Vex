import { describe, it, expect } from "vitest";
import { TRENCH_TOOLS } from "../../../vex-agent/tools/protocols/trench/manifest.js";
import { TRENCH_HANDLERS } from "../../../vex-agent/tools/protocols/trench/handlers.js";

describe("trench manifest", () => {
  /** Pure reads — no writes of any kind. */
  const READ_ONLY_IDS = [
    "trench.images",
    "trench.launch_preview",
    "trench.my_launches",
    "trench.search",
    "trench.tokens",
    "trench.trade_quote",
    "trench.trades",
  ];

  /** The only two tools that SIGN. */
  const BROADCAST_IDS = ["trench.launch_execute", "trench.trade_execute"];

  /** Writes local state but never spends: drafts the launch intent and parks
   *  the turn. Mutating so the taxonomy stays honest, `local_write` so the
   *  approval gate correctly does NOT raise a card for opening a form. */
  const LOCAL_WRITE_IDS = ["trench.launch_request_form"];

  it("registers the whole namespace: reads, the money path, and the launch flow", () => {
    expect(TRENCH_TOOLS.map((t) => t.toolId).sort()).toEqual(
      [...READ_ONLY_IDS, ...LOCAL_WRITE_IDS, ...BROADCAST_IDS].sort(),
    );
  });

  it("every tool is on the trench namespace and active", () => {
    for (const t of TRENCH_TOOLS) {
      expect(t.namespace).toBe("trench");
      expect(t.lifecycle).toBe("active");
    }
  });

  it("read tools are read-only; only the two execute tools broadcast", () => {
    for (const t of TRENCH_TOOLS) {
      if (BROADCAST_IDS.includes(t.toolId)) {
        expect(t.mutating, `${t.toolId} mutating`).toBe(true);
        expect(t.actionKind, `${t.toolId} actionKind`).toBe("user_wallet_broadcast");
      } else if (LOCAL_WRITE_IDS.includes(t.toolId)) {
        // Writes local state, never spends — and must NOT be a broadcast kind.
        expect(t.actionKind, `${t.toolId} actionKind`).toBe("local_write");
      } else {
        expect(READ_ONLY_IDS).toContain(t.toolId);
        // NOTHING outside BROADCAST_IDS may spend. That is the invariant.
        expect(t.mutating, `${t.toolId} mutating`).toBe(false);
        expect(t.actionKind, `${t.toolId} actionKind`).toBe("read");
      }
    }
  });

  it("declares no requiresEnv (keyless public API)", () => {
    for (const t of TRENCH_TOOLS) {
      expect(t.requiresEnv).toBeUndefined();
    }
  });

  it("every tool carries a discovery embeddingText", () => {
    for (const t of TRENCH_TOOLS) {
      expect(t.discovery?.embeddingText, `${t.toolId} embeddingText`).toBeTruthy();
    }
  });

  it("read-tool descriptions declare read-only; no tool implies a token/VEX pair", () => {
    for (const t of TRENCH_TOOLS) {
      if (READ_ONLY_IDS.includes(t.toolId)) {
        expect(t.description, `${t.toolId} read-only`).toMatch(/Read-only\.?/i);
      }
      expect(t.description).not.toMatch(/VEX pair/i);
    }
  });

  it("has a handler for every manifest toolId and no extras", () => {
    const ids = new Set(TRENCH_TOOLS.map((t) => t.toolId));
    const keys = new Set(Object.keys(TRENCH_HANDLERS));
    expect([...ids].filter((id) => !keys.has(id))).toEqual([]);
    expect([...keys].filter((k) => !ids.has(k))).toEqual([]);
  });
});
