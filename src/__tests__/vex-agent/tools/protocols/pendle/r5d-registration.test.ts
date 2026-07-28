/**
 * R5d card D6 — every tool the R5d families added is REGISTERED end to end.
 *
 * A Pendle write is only reachable if five separate, independently-owned files
 * agree about it, and each one fails differently when it is the one left out:
 *
 *   - manifest composed into `PENDLE_TOOLS`  → otherwise the model never sees it
 *   - handler in `PENDLE_HANDLERS`           → otherwise the model sees a tool it cannot call
 *   - `discovery.embeddingText`              → otherwise dense retrieval cannot find it
 *   - a navigation facet                     → otherwise it falls outside `Paths` guidance
 *   - a `MUTATION_MATRIX` row                → otherwise its capture contract is unclassified
 *   - a `LEGACY_TOOL_PRODUCTS` row           → otherwise a failed broadcast is filed under no product
 *
 * The family cards build the modules; this card wires them in, so this file is
 * the wiring's own regression guard. It is deliberately a LIST, not a derived
 * set: deriving the expected ids from the manifest would make the test pass by
 * construction the moment a family shipped unregistered, which is exactly the
 * failure it exists to catch.
 *
 * SCOPE (card E5, 2026-07-28): all seven R5d writes have now shipped their
 * family modules and are wired in — the SY pair (D3), the dual-LP pair (E3),
 * and the three term-mobility tools (E4). The per-id list below is the wiring
 * lock; the sweep at the bottom is the second half of the same guard, catching
 * a FUTURE Pendle tool that lands with a manifest and nothing else.
 */

import { describe, expect, it } from "vitest";

import { PENDLE_TOOLS } from "@vex-agent/tools/protocols/pendle/manifest.js";
import { PENDLE_HANDLERS } from "@vex-agent/tools/protocols/pendle/handlers.js";
import { MUTATION_MATRIX } from "@vex-agent/tools/protocols/mutation-matrix.js";
import { getMatchingFacetsForTool } from "@vex-agent/tools/protocols/descriptions.js";
import { LEGACY_TOOL_PRODUCTS } from "@vex-agent/db/repos/transactions-failure-tools.js";

/** Every mutating toolId added by an R5d family card that has actually shipped. */
const R5D_TOOL_IDS = [
  // D3 — SY wrap / unwrap.
  "pendle.sy.mint",
  "pendle.sy.redeem",
  // E3 — dual-leg LP: one action, two output instruments.
  "pendle.lp.removeDual",
  "pendle.lp.addKeepYt",
  // E4 — term mobility: move a position between maturities or between types.
  "pendle.pt.rollover",
  "pendle.lp.transfer",
  "pendle.lp.toPt",
] as const;

describe("R5d — new Pendle writes are registered end to end", () => {
  for (const toolId of R5D_TOOL_IDS) {
    describe(toolId, () => {
      it("is composed into PENDLE_TOOLS as a mutating wallet broadcast", () => {
        const tool = PENDLE_TOOLS.find((t) => t.toolId === toolId);
        expect(tool, `${toolId} is missing from PENDLE_TOOLS`).toBeDefined();
        expect(tool!.namespace).toBe("pendle");
        expect(tool!.lifecycle).toBe("active");
        expect(tool!.mutating).toBe(true);
        expect(tool!.actionKind).toBe("user_wallet_broadcast");
      });

      it("has a handler — a manifest without one is a tool the model cannot call", () => {
        expect(typeof PENDLE_HANDLERS[toolId]).toBe("function");
      });

      it("carries a retrieval passage — without one dense discovery cannot find it", () => {
        const tool = PENDLE_TOOLS.find((t) => t.toolId === toolId)!;
        expect(tool.discovery?.embeddingText?.length ?? 0).toBeGreaterThan(0);
        expect(tool.discovery?.chains?.length ?? 0).toBeGreaterThan(0);
        // paramKeywords is derived at metadata-compile time; a hand-authored one
        // would drift from the params it claims to mirror.
        expect(tool.discovery?.paramKeywords).toBeUndefined();
      });

      it("matches at least one navigation facet", () => {
        expect(getMatchingFacetsForTool("pendle", toolId).length).toBeGreaterThan(0);
      });

      it("is classified in the mutation matrix as an uncaptured yield write", () => {
        const contract = MUTATION_MATRIX.get(toolId);
        expect(contract, `${toolId} has no MUTATION_MATRIX row`).toBeDefined();
        // capture:"none" — the handler writes durable truth straight to
        // agent_activity, so the legacy proj_activity pipeline must not also run.
        expect(contract!.capture).toBe("none");
        expect(contract!.expectedType).toBe("yield");
        expect(contract!.previewSupport).toBe(true);
      });

      it("maps to the yield product for failed-broadcast bookkeeping", () => {
        expect(LEGACY_TOOL_PRODUCTS.get(toolId)).toBe("yield");
      });
    });
  }

  // ── The sweep half ─────────────────────────────────────────────────
  //
  // The per-id block above cannot catch a tool nobody remembered to add to it.
  // These four derive from the LIVE manifest instead, so any Pendle tool that
  // lands from here on is held to the same wiring contract without editing a
  // list. They are not redundant with the block above: that one proves the
  // SEVEN R5d ids exist at all, this one proves nothing in the registry is
  // half-wired.

  it("every registered Pendle tool has a handler", () => {
    const missing = PENDLE_TOOLS.filter((t) => typeof PENDLE_HANDLERS[t.toolId] !== "function").map((t) => t.toolId);
    expect(missing, "manifest without a handler — the model sees a tool it cannot call").toEqual([]);
  });

  it("every registered Pendle tool carries a retrieval passage", () => {
    const missing = PENDLE_TOOLS.filter((t) => (t.discovery?.embeddingText?.length ?? 0) === 0).map((t) => t.toolId);
    expect(missing, "no embeddingText — dense discovery cannot find it").toEqual([]);
  });

  it("every registered Pendle tool matches a navigation facet", () => {
    const orphans = PENDLE_TOOLS.filter((t) => getMatchingFacetsForTool("pendle", t.toolId).length === 0).map(
      (t) => t.toolId,
    );
    expect(orphans, "no facet — the tool falls outside `Paths` guidance").toEqual([]);
  });

  it("every MUTATING Pendle tool has a matrix row and a failure product", () => {
    const mutating = PENDLE_TOOLS.filter((t) => t.mutating).map((t) => t.toolId);
    const noMatrixRow = mutating.filter((id) => MUTATION_MATRIX.get(id) === undefined);
    const noProduct = mutating.filter((id) => LEGACY_TOOL_PRODUCTS.get(id) !== "yield");
    expect(noMatrixRow, "no MUTATION_MATRIX row — capture contract unclassified").toEqual([]);
    expect(noProduct, "no LEGACY_TOOL_PRODUCTS row — a failed broadcast is filed under no product").toEqual([]);
  });

  it("declares a dryRun param — R5d writes carry their quote inside the tool", () => {
    for (const toolId of R5D_TOOL_IDS) {
      const tool = PENDLE_TOOLS.find((t) => t.toolId === toolId)!;
      expect(
        tool.params.some((p) => p.key === "dryRun"),
        `${toolId} must expose dryRun: the quote-then-execute gate is in-tool for R5d writes`,
      ).toBe(true);
    }
  });
});
