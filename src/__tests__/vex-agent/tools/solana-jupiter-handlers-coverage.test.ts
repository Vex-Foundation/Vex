import { describe, it, expect } from "vitest";

import { SOLANA_JUPITER_HANDLERS } from "../../../vex-agent/tools/protocols/solana-jupiter/handlers.js";
import { SOLANA_JUPITER_TOOLS } from "../../../vex-agent/tools/protocols/solana-jupiter/manifest.js";

// Structural handler ↔ manifest parity, split out of the original combined
// solana-jupiter-handlers.test.ts. Domain behavior (tokens/predict/swap/
// lend/prices) lives in the sibling solana-jupiter-handlers-*.test.ts files.
describe("solana-jupiter handlers — coverage", () => {
  // ── Handler coverage — every manifest has a handler ──────────────

  it("has a handler for every manifest toolId", () => {
    const handlerKeys = new Set(Object.keys(SOLANA_JUPITER_HANDLERS));
    const manifestIds = SOLANA_JUPITER_TOOLS.map(t => t.toolId);

    const missing = manifestIds.filter(id => !handlerKeys.has(id));
    expect(missing).toEqual([]);
  });

  it("has no extra handlers without manifests", () => {
    const manifestIds = new Set(SOLANA_JUPITER_TOOLS.map(t => t.toolId));
    const handlerKeys = Object.keys(SOLANA_JUPITER_HANDLERS);

    const extra = handlerKeys.filter(key => !manifestIds.has(key));
    expect(extra).toEqual([]);
  });

  it("handler count matches manifest count", () => {
    expect(Object.keys(SOLANA_JUPITER_HANDLERS)).toHaveLength(SOLANA_JUPITER_TOOLS.length);
  });

  // ── Handler type — all are async functions ────────────────────────

  it("every handler is a function", () => {
    for (const [toolId, handler] of Object.entries(SOLANA_JUPITER_HANDLERS)) {
      expect(typeof handler).toBe("function");
    }
  });
});
