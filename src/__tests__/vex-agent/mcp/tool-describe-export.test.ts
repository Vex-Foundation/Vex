/**
 * `vex_ToolDescribe` - the whole-contract reader, and the property that is its
 * entire reason for existing.
 *
 * THE LOAD-BEARING CASE is the last one: every tool in `tools/list`, walked
 * through this tool, must come back with a description that equals the tool's
 * own description BYTE FOR BYTE. A reader that paraphrases, re-wraps or trims
 * would be worse than the client truncation it exists to answer, because the
 * agent would have no way to tell which of the two texts is the contract.
 *
 * The rest pins the answers a caller can act on: the prefixed name a client
 * shows is accepted, an unknown name is answered with the nearest catalogue
 * names rather than a guess, the approval-card answer follows the two real
 * gates, the result shape and the fee are SERVED from the tool's own authored
 * fields, and a fact nobody has authored is still reported ABSENT instead of
 * invented - which on the fee means unknown, never free.
 */

import { describe, it, expect } from "vitest";

import {
  EXPORTED_TOOL_DESCRIBE_PUBLIC_NAME,
  EXPORTED_TOOL_DESCRIBE_DESCRIPTION,
  MCP_CLIENT_NAME_PREFIX,
  describeExportedTool,
} from "@vex-agent/mcp/tool-describe-export.js";
import { buildStudioInventory } from "@vex-agent/mcp/inventory/index.js";
import { admitStudioCall } from "@vex-agent/mcp/admission.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";

const inventory = buildStudioInventory();

function contractOf(name: string) {
  const outcome = describeExportedTool({ name });
  if (!outcome.ok) throw new Error(`expected a contract for ${name}: ${outcome.message}`);
  return outcome.contract;
}

describe("vex_ToolDescribe returns one tool's whole contract", () => {
  it("returns the description and the schema of a hot-set tool", () => {
    const contract = contractOf("SwapExecute");
    const tool = inventory.find((t) => t.publicName === "SwapExecute");
    expect(contract.name).toBe("SwapExecute");
    expect(contract.lane).toBe("internal");
    expect(contract.alwaysLoad).toBe(true);
    expect(contract.description).toBe(tool?.description);
    expect(contract.inputSchema).toEqual(tool?.inputSchema);
    expect(contract.actionKind).toBe("user_wallet_broadcast");
    expect(contract.riskLevel).toBe("high");
    expect(contract.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
  });

  it("says a fund-moving call blocks on the approval card in a restricted project", () => {
    expect(contractOf("SwapExecute").approvalCard.raisedInRestrictedProject).toBe(true);
    expect(contractOf("SwapExecute").approvalCard.note).toContain("waits");
  });

  it("says a read and a local write raise no card", () => {
    // `WalletTrackToken` writes a Vex-local bookmark and signs nothing: the
    // in-app gate keys on `ToolDef.mutating`, which is false for it.
    expect(contractOf("WalletTrackToken").approvalCard.raisedInRestrictedProject).toBe(false);
    expect(contractOf("TokenFind").approvalCard.raisedInRestrictedProject).toBe(false);
  });

  it("names the quotes that authorize a gated protocol execute", () => {
    const gate = contractOf("kyberswap__swap_execute").quoteGate;
    expect(gate).toMatchObject({ status: "gated", prequoteKind: "swap" });
    if (gate.status === "gated") {
      expect(gate.authorizedBy).toContain("kyberswap__swap_quote");
      // A quote from another provider can never authorize this execute.
      expect(gate.authorizedBy).not.toContain("uniswap__swap_quote");
    }
  });

  it("reports an ungated protocol tool as ungated rather than unknown", () => {
    expect(contractOf("kyberswap__swap_quote").quoteGate).toMatchObject({ status: "ungated" });
  });

  it("answers the quote-gate question in ONE shape, whichever lane is asked", () => {
    // The finding this pins (pass 2, A-2): the answer used to arrive as
    // `{gated}` for a protocol tool and `{known:false, reason}` for an internal
    // one, two shapes with NO field in common, so a caller had to know the lane
    // before it could read the answer. Every arm now carries `status` and a
    // `note`, and every exported tool is checked, not a chosen three.
    const statuses = new Set<string>();
    for (const row of buildStudioInventory()) {
      const outcome = describeExportedTool({ name: row.publicName });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) continue;
      const gate = outcome.contract.quoteGate;
      expect(typeof gate.status).toBe("string");
      expect(gate.note.length).toBeGreaterThan(0);
      statuses.add(gate.status);
    }
    // All three arms are live, so the assertion above is not vacuous.
    expect([...statuses].sort()).toEqual(["gated", "ungated", "venue_resolved_per_call"]);
  });

  it("serves the result shape and the fee the description gave up", () => {
    // This case is the inversion of what it asserted when the tool shipped:
    // both facts were reported ABSENT because nothing machine-readable carried
    // them, which made "Full contract: vex_ToolDescribe" a promise the reader
    // could not keep. They are fields now (`ToolDef.returns`,
    // `ToolDef.vexFee`), and the byte-for-byte proof that the moved text
    // survived the move lives in `tools/tool-contract-fields.test.ts`.
    const contract = contractOf("BridgeExecute");
    expect(contract.returns.known).toBe(true);
    if (contract.returns.known) expect(contract.returns.text).toContain("RETURNS status, summary");
    expect(contract.vexFee.known).toBe(true);
    if (contract.vexFee.known && contract.vexFee.charged) {
      expect(contract.vexFee.bps).toBe(25);
      expect(contract.vexFee.when).toContain("AFTER the deposit lands");
    }
    // The internal alias resolves its venue per call, so the registries cannot
    // answer for it - and it says so instead of naming a venue.
    expect(contract.quoteGate).toMatchObject({ status: "venue_resolved_per_call" });
  });

  it("answers a read-only tool `charged: false`, derived from its action kind", () => {
    // The second half of A-2: a protocol read moves nothing, yet answered "Vex
    // will not say" because no `vexFee` was authored on it - 95 of the exported
    // tools were in that state. The derivation can only ever say "nothing", and
    // only for the class that spends nothing.
    const contract = contractOf("dexscreener__pairs_search");
    expect(contract.actionKind).toBe("read");
    expect(contract.vexFee.known).toBe(true);
    if (contract.vexFee.known) {
      expect(contract.vexFee.charged).toBe(false);
      if (!contract.vexFee.charged) expect(contract.vexFee.reason).toContain("READ-ONLY");
    }
  });

  it("does NOT derive a fee for a tool that can spend", () => {
    // The line the derivation must not cross. A `user_wallet_broadcast` with no
    // authored fee is a fact nobody wrote down, and reading silence as free on
    // that lane would be an invented answer about the user's money.
    const contract = contractOf("morpho__market_borrow");
    expect(contract.actionKind).toBe("user_wallet_broadcast");
    expect(contract.vexFee.known).toBe(false);
  });

  it("still reports an UNAUTHORED fact as absent, and never as free", () => {
    // The protocol lane authors these fields incrementally, so absence is a
    // live state and not a hypothetical. Reporting an unauthored fee as
    // "charges nothing" would be an invented answer about the user's money.
    const unauthored = buildStudioInventory().find((row) => {
      const outcome = describeExportedTool({ name: row.publicName });
      return outcome.ok && !outcome.contract.vexFee.known;
    });
    expect(unauthored, "no unauthored tool left to prove the absent arm").toBeDefined();
    if (unauthored === undefined) return;
    const { vexFee } = contractOf(unauthored.publicName);
    expect(vexFee.known).toBe(false);
    if (!vexFee.known) expect(vexFee.reason).toContain("NOT A STATEMENT THAT IT IS FREE");
  });

  it("accepts the prefixed name a client shows and strips the prefix", () => {
    const prefixed = contractOf(`${MCP_CLIENT_NAME_PREFIX}dexscreener__pairs_search`);
    expect(prefixed.name).toBe("dexscreener__pairs_search");
    expect(prefixed).toEqual(contractOf("dexscreener__pairs_search"));
  });

  it("carries the provider key a tool needs, by NAME", () => {
    const contract = contractOf("solana__swap_execute");
    expect(contract.requiresEnv).toBe("JUPITER_API_KEY");
  });

  it("answers an unknown name with the nearest catalogue names, never a guess", () => {
    const outcome = describeExportedTool({ name: "pairs_search" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toContain("no exported tool is named");
      expect(outcome.message).toContain("dexscreener__pairs_search");
      expect(outcome.message).toContain("Nothing was executed");
    }
  });

  it("refuses an unknown argument and a missing name by name", () => {
    const unknown = describeExportedTool({ name: "TokenFind", limit: 3 });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.message).toContain("`limit`");
    const missing = describeExportedTool({});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain("`name`");
  });

  it("describes itself, and says first that it runs nothing", () => {
    const contract = contractOf(EXPORTED_TOOL_DESCRIBE_PUBLIC_NAME);
    expect(contract.description).toBe(EXPORTED_TOOL_DESCRIBE_DESCRIPTION);
    expect(contract.annotations.readOnlyHint).toBe(true);
    expect(contract.approvalCard.raisedInRestrictedProject).toBe(false);
    expect(EXPORTED_TOOL_DESCRIBE_DESCRIPTION).toContain("READ-ONLY");
    // The sentence that explains why the tool exists at all.
    expect(EXPORTED_TOOL_DESCRIBE_DESCRIPTION).toContain("never truncated");
  });

  it("returns EVERY tool's own description, byte for byte", () => {
    for (const tool of inventory) {
      const contract = contractOf(tool.publicName);
      expect(contract.description).toBe(tool.description);
      expect(contract.descriptionCharacters).toBe([...tool.description].length);
      expect(contract.inputSchema).toEqual(tool.inputSchema);
      expect(contract.title).toBe(tool.title);
    }
  });
});

describe("admission routes vex_ToolDescribe without dispatching anything", () => {
  // A context that would THROW if any lane touched it: the point of the
  // assertion is that this tool answers from the inventory and never reaches
  // the dispatcher, a wallet, a provider or an approval gate.
  const hostileContext = new Proxy({} as InternalToolContext, {
    get(_target, property) {
      throw new Error(`vex_ToolDescribe must not read the tool context (read: ${String(property)})`);
    },
  });

  it("answers from the inventory alone", async () => {
    const admission = await admitStudioCall(
      {
        name: EXPORTED_TOOL_DESCRIBE_PUBLIC_NAME,
        args: { name: `${MCP_CLIENT_NAME_PREFIX}WalletSendConfirm` },
        toolCallId: "studio-test-describe",
      },
      hostileContext,
    );
    expect(admission.result.success).toBe(true);
    expect(admission.result.actionKind).toBe("read");
    const parsed = JSON.parse(admission.result.output) as { name: string; description: string };
    expect(parsed.name).toBe("WalletSendConfirm");
    expect(parsed.description).toBe(
      inventory.find((t) => t.publicName === "WalletSendConfirm")?.description,
    );
  });

  it("returns the refusal whole for an unknown name, and dispatches nothing", async () => {
    const admission = await admitStudioCall(
      { name: EXPORTED_TOOL_DESCRIBE_PUBLIC_NAME, args: { name: "NoSuchTool" }, toolCallId: "t" },
      hostileContext,
    );
    expect(admission.result.success).toBe(false);
    expect(admission.result.output).toContain("no exported tool is named");
  });
});
