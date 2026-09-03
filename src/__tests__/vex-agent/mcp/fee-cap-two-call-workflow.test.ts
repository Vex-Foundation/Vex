/**
 * THE TWO-CALL FEE-CAP WORKFLOW must be reachable over MCP (clarity finding I5).
 *
 * The three prepare tools document one workflow: call once WITHOUT the caps to
 * receive a refusal that names them and carries the current network estimate as
 * a labelled hint, then call again with caps you chose. The handler has always
 * done exactly that (`transaction/fee-bounds.ts`). The SCHEMA contradicted it:
 * `gasLimit` and the two Solana compute caps sat in `required`, and the MCP SDK
 * VALIDATES the published input schema before the handler runs - so over MCP the
 * first call of the documented workflow was rejected by the transport and the
 * hint was unreachable, leaving a coding agent to invent a gas limit, which is
 * precisely the number Vex refuses to invent on the user's behalf.
 *
 * These assertions pin both halves: the caps are optional IN THE SCHEMA, and
 * refusing without them is still what the parser does, with the hints attached.
 * A regression that re-adds `gasLimit` to `required` fails here by name.
 */

import { describe, it, expect } from "vitest";

import { buildStudioInventory } from "@vex-agent/mcp/inventory/index.js";
import { getToolDef } from "@vex-agent/tools/registry.js";
import {
  parseEvmFeeBounds,
  parseSolanaFeeBounds,
} from "@vex-agent/tools/internal/wallet/transaction/fee-bounds.js";

const inventory = buildStudioInventory();

const EVM_ESTIMATES = {
  suggestedGasLimit: "21000",
  suggestedMaxFeePerGasWei: "1500000000",
  suggestedMaxPriorityFeePerGasWei: "100000000",
  suggestedGasPriceWei: "1400000000",
  supportsEip1559: true,
} as const;

const SOLANA_ESTIMATES = {
  suggestedComputeUnitLimit: "200000",
  suggestedComputeUnitPriceMicroLamports: "5000",
} as const;

/** The published `required` list, read from the surface an external agent gets. */
function exportedRequired(publicName: string): readonly string[] {
  const tool = inventory.find((row) => row.publicName === publicName);
  if (tool === undefined) throw new Error(`${publicName} is not exported`);
  const schema = tool.inputSchema as { required?: readonly string[] };
  return schema.required ?? [];
}

describe("the fee caps are optional in the schema and required in effect", () => {
  const CAP_PARAMS = [
    "gasLimit",
    "maxFeePerGasWei",
    "maxPriorityFeePerGasWei",
    "gasPriceWei",
    "computeUnitLimit",
    "computeUnitPriceMicroLamports",
  ];

  it.each([
    ["WalletEvmTransactionPrepare", ["chain", "to"]],
    ["WalletWrapPrepare", ["chain", "direction", "amountRaw"]],
    ["WalletSolanaTransactionPrepare", ["transactionBase64"]],
  ] as const)("%s requires only its non-cap arguments", (name, expected) => {
    expect(exportedRequired(name)).toEqual(expected);
    for (const cap of CAP_PARAMS) {
      expect(exportedRequired(name)).not.toContain(cap);
    }
  });

  it("still DECLARES every cap, so the second call has a documented contract", () => {
    const evm = inventory.find((t) => t.publicName === "WalletEvmTransactionPrepare");
    const properties = (evm?.inputSchema as { properties: Record<string, unknown> }).properties;
    for (const cap of ["gasLimit", "maxFeePerGasWei", "maxPriorityFeePerGasWei", "gasPriceWei"]) {
      expect(properties).toHaveProperty(cap);
    }
  });

  it("keeps the in-app ToolDef and the exported schema in agreement", () => {
    // One schema, two surfaces: a divergence here would mean the in-app agent
    // and an external agent were told different contracts for the same call.
    for (const name of [
      "WalletEvmTransactionPrepare",
      "WalletWrapPrepare",
      "WalletSolanaTransactionPrepare",
    ]) {
      const def = getToolDef(name);
      expect((def?.parameters as { required?: readonly string[] }).required)
        .toEqual(exportedRequired(name));
    }
  });

  it("documents the two-call workflow on the surface an external agent reads", () => {
    // WHERE the sentence lives moved and the assertion moved with it. The
    // description states the WORKFLOW ("TWO CALLS: call once WITHOUT the
    // caps..."); the per-parameter descriptions carry the reason it is shaped
    // that way ("REQUIRED IN EFFECT, optional in the schema"), which is where a
    // caller looking at one cap actually reads it. Both travel in `tools/list`,
    // so an agent that never calls `vex_ToolDescribe` still gets both halves.
    for (const name of [
      "WalletEvmTransactionPrepare",
      "WalletWrapPrepare",
      "WalletSolanaTransactionPrepare",
    ]) {
      const tool = inventory.find((t) => t.publicName === name);
      expect(tool?.description).toContain("TWO CALLS");
      const properties = (tool?.inputSchema as {
        properties: Record<string, { description?: string }>;
      }).properties;
      const capDescriptions = CAP_PARAMS
        .flatMap((cap) => (properties[cap] === undefined ? [] : [properties[cap].description ?? ""]));
      expect(capDescriptions.length).toBeGreaterThan(0);
      for (const text of capDescriptions) {
        expect(text).toContain("optional in the schema");
      }
    }
  });
});

describe("a call without caps is refused BY NAME and carries the estimate as a hint", () => {
  it("refuses an EVM prepare with no caps at all", () => {
    const outcome = parseEvmFeeBounds({}, EVM_ESTIMATES);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.code).toBe("missing_fee_bounds");
      expect(outcome.refusal.message).toContain("gasLimit");
      expect(outcome.refusal.details).toMatchObject({
        hintSuggestedGasLimit: "21000",
        hintSuggestedMaxFeePerGasWei: "1500000000",
      });
      // The hint is a hint, and the refusal says so rather than implying Vex
      // chose a limit for the user.
      expect(outcome.refusal.message).toContain("HINTS ONLY");
    }
  });

  it("refuses an EVM prepare that supplies a price but no gas limit", () => {
    const outcome = parseEvmFeeBounds({ gasPriceWei: "1400000000" }, EVM_ESTIMATES);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.code).toBe("missing_fee_bounds");
  });

  it("accepts the second call, with the caps the first call named", () => {
    const outcome = parseEvmFeeBounds(
      {
        gasLimit: "21000",
        maxFeePerGasWei: "1500000000",
        maxPriorityFeePerGasWei: "100000000",
      },
      EVM_ESTIMATES,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toMatchObject({ mode: "eip1559", maxTotalFeeWei: "31500000000000" });
    }
  });

  it("refuses BOTH pricing modes at once rather than preferring one", () => {
    const outcome = parseEvmFeeBounds(
      { gasLimit: "21000", gasPriceWei: "1", maxFeePerGasWei: "2" },
      EVM_ESTIMATES,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.message).toContain("exactly one pricing mode");
  });

  it("refuses a Solana prepare with no compute caps, and accepts them together", () => {
    const missing = parseSolanaFeeBounds({}, 1, SOLANA_ESTIMATES);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.refusal.code).toBe("missing_fee_bounds");
      expect(missing.refusal.message).toContain("computeUnitLimit");
      expect(missing.refusal.details).toMatchObject({
        hintSuggestedComputeUnitLimit: "200000",
      });
    }

    const supplied = parseSolanaFeeBounds(
      { computeUnitLimit: "200000", computeUnitPriceMicroLamports: "5000" },
      1,
      SOLANA_ESTIMATES,
    );
    expect(supplied.ok).toBe(true);
    if (supplied.ok) expect(supplied.value.mode).toBe("solana");
  });

  it("refuses a Solana prepare that supplies only one of the pair", () => {
    const outcome = parseSolanaFeeBounds({ computeUnitLimit: "200000" }, 1, SOLANA_ESTIMATES);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.code).toBe("missing_fee_bounds");
  });
});
