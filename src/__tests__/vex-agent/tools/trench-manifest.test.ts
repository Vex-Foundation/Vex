import { describe, it, expect } from "vitest";
import { TRENCH_TOOLS } from "../../../vex-agent/tools/protocols/trench/manifest.js";
import { TRENCH_HANDLERS } from "../../../vex-agent/tools/protocols/trench/handlers.js";

describe("trench manifest", () => {
  const READ_ONLY_IDS = ["trench.launch_preview", "trench.search", "trench.tokens", "trench.trade_quote", "trench.trades"];

  it("registers the P1 read tools plus the P2 money-path tools", () => {
    expect(TRENCH_TOOLS.map((t) => t.toolId).sort()).toEqual([
      "trench.launch_preview",
      "trench.search",
      "trench.tokens",
      "trench.trade_execute",
      "trench.trade_quote",
      "trench.trades",
    ]);
  });

  it("every tool is on the trench namespace and active", () => {
    for (const t of TRENCH_TOOLS) {
      expect(t.namespace).toBe("trench");
      expect(t.lifecycle).toBe("active");
    }
  });

  it("read tools are read-only; trade_execute is a user-wallet broadcast", () => {
    for (const t of TRENCH_TOOLS) {
      if (t.toolId === "trench.trade_execute") {
        expect(t.mutating, `${t.toolId} mutating`).toBe(true);
        expect(t.actionKind, `${t.toolId} actionKind`).toBe("user_wallet_broadcast");
      } else {
        expect(READ_ONLY_IDS).toContain(t.toolId);
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
