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
  // Codex round 4 (2026-08-02): the active manifests advertised a 64-character
  // name while `create()` reverts `invalid name` past 18 and both validators
  // enforce 18. A tool contract that promises a longer field than the chain
  // accepts teaches the model to compose launches that revert on-chain.
  it("advertises the chain's real 18-character name cap, never a looser one", () => {
    for (const t of TRENCH_TOOLS) {
      const nameParam = t.params?.find((p) => p.key === "name");
      if (nameParam === undefined) continue;
      expect(nameParam.description, `${t.toolId} name cap`).toMatch(/1-18 chars/);
      expect(nameParam.description, `${t.toolId} name cap`).not.toMatch(/64/);
    }
  });

  // U1: the dry-run now has TWO pricing modes and the manifest must send the
  // agent to the one that is accurate. `imageByteLength` alone still simulates
  // EMPTY bytes, so its caveat stays; `imageId` is the param that prices the
  // real image, and the caveat must NOT be repeated over it as if it applied.
  it("keeps the empty-image caveat on imageByteLength and points at imageId instead", () => {
    const preview = TRENCH_TOOLS.find((t) => t.toolId === "trench.launch_preview");
    const imageParam = preview?.params?.find((p) => p.key === "imageByteLength");
    expect(imageParam?.description).toMatch(/EXCLUDES image bytes/);
    expect(imageParam?.description).toMatch(/pass imageId instead/i);
    expect(imageParam?.description).not.toMatch(/preview its gas impact/);
  });

  it("advertises imageId as the way to price the REAL image bytes", () => {
    const preview = TRENCH_TOOLS.find((t) => t.toolId === "trench.launch_preview");
    const imageIdParam = preview?.params?.find((p) => p.key === "imageId");
    expect(imageIdParam?.type).toBe("string");
    expect(imageIdParam?.required).toBeUndefined();
    expect(imageIdParam?.description).toMatch(/REFUSES/);
    expect(imageIdParam?.description).toMatch(/digest mismatch/i);
  });

  // The stale copy said "Simulated with an empty image" unconditionally. That
  // is now only one of two modes, and stating it as the rule teaches the agent
  // to distrust an estimate that is in fact exact.
  it("does not state the empty-image simulation as unconditional in the tool description", () => {
    const preview = TRENCH_TOOLS.find((t) => t.toolId === "trench.launch_preview");
    expect(preview?.description).not.toMatch(/Simulated with an empty image/i);
    expect(preview?.description).toMatch(/imagePriced/);
    expect(preview?.description).toMatch(/balanceVerdict/);
  });
});
