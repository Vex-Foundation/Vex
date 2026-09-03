/**
 * WHAT THE ALWAYS-LOADED DESCRIPTIONS PROMISE, pinned sentence by sentence.
 *
 * Every case here answers a question a real Claude Code session asked and got
 * wrong from the text it was given (clarity review 2026-09-03, sections 3 and
 * 4). They are contract assertions, not style checks: each one names the
 * finding it closes, and reverting the sentence turns the case red.
 *
 *   I1  the approval contract over MCP: the call BLOCKS, it does not "come
 *       back asking for approval"
 *   I6  a bridge destination cannot be redirected by a parameter, `recipient`
 *       included (BRIDGE-1 lands the rejection; this pins the sentence)
 *   I7  which quote authorizes which execute, per pair
 *   I11 the Vex fee is named where it applies and its absence where it does not
 *   A12 BridgeStatus follows Khalani order ids, and a Relay request is read
 *       elsewhere
 *   A13 TokenFind names the app-local-chain lookup
 *   A14 mission_baseline is absent over MCP
 *   A17 the Solana swap lane names its provider key
 *   A21 WalletTrackToken raises no card; `fromAddress` redirects nothing
 */

import { describe, it, expect } from "vitest";

import { buildStudioInventory } from "@vex-agent/mcp/inventory/index.js";
import { CANONICAL_MCP_APPROVAL_SENTENCE } from "@vex-agent/tools/protocols/conventions.js";

const inventory = buildStudioInventory();

function description(publicName: string): string {
  const tool = inventory.find((row) => row.publicName === publicName);
  if (tool === undefined) throw new Error(`${publicName} is not exported`);
  return tool.description;
}

describe("I1 - the approval contract over MCP is stated, and the in-app wording is gone", () => {
  const GATED = [
    "SwapExecute",
    "SwapExecuteUniswap",
    "BridgeExecute",
    "BridgeExecuteRelay",
    "WalletSendConfirm",
    "WalletEvmTransactionConfirm",
    "WalletSolanaTransactionConfirm",
    "WalletWrapConfirm",
  ];

  it.each(GATED)("%s says the call waits and returns the settled outcome", (name) => {
    expect(description(name)).toContain(CANONICAL_MCP_APPROVAL_SENTENCE);
  });

  it.each(GATED)("%s no longer says it comes back asking for approval", (name) => {
    expect(description(name)).not.toContain("comes back asking for approval");
    expect(description(name)).not.toContain("returns pending approval");
  });

  it("names the broker's own outcome words, so the wire vocabulary is the read one", () => {
    for (const word of ["declined", "expired", "refused", "dispatch_failed", "indeterminate"]) {
      expect(CANONICAL_MCP_APPROVAL_SENTENCE).toContain(word);
    }
    expect(CANONICAL_MCP_APPROVAL_SENTENCE).toContain("never call it twice while you wait");
  });
});

describe("I6 - nothing a caller sends can redirect a bridge", () => {
  it("BridgeExecute derives route, refund and destination, and names every rejected field", () => {
    const text = description("BridgeExecute");
    expect(text).toContain(
      "The route, the refund address and the destination are derived from the source and the "
      + "selected destination wallet",
    );
    for (const field of [
      "`refundTo`",
      "`referrer`",
      "`referrerFeeBps`",
      "`routeId`",
      "`depositMethod`",
      "`recipient`",
    ]) {
      expect(text).toContain(field);
    }
    expect(text).toContain("rejected by name");
  });

  it("no bridge tool advertises a recipient parameter any more", () => {
    for (const name of ["BridgeQuote", "BridgeExecute", "BridgeQuoteRelay", "BridgeExecuteRelay"]) {
      const tool = inventory.find((row) => row.publicName === name);
      const properties = (tool?.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(Object.keys(properties)).not.toContain("recipient");
    }
  });

  it("A21 - fromAddress cannot make the session wallet sign for another source", () => {
    expect(description("BridgeExecute")).toContain("the session wallet signs only for itself");
  });
});

describe("I7 - each execute names the exact quote that authorizes it", () => {
  it("BridgeQuote authorizes BridgeExecute whichever venue it routed to", () => {
    expect(description("BridgeQuote")).toContain(
      "THIS quote authorizes BridgeExecute whichever venue it routed to",
    );
    expect(description("BridgeExecute")).toContain(
      "That quote authorizes THIS tool whichever venue it chose",
    );
  });

  it("the Relay pair forces Relay and authorizes only its own execute", () => {
    expect(description("BridgeQuoteRelay")).toContain("authorizes BridgeExecuteRelay ONLY");
    expect(description("BridgeExecuteRelay")).toContain(
      "that quote is the only one that authorizes this tool",
    );
  });

  it("the swap pairs say the same, and name the namespaced executes", () => {
    expect(description("SwapQuote")).toContain("authorizes SwapExecute ONLY");
    expect(description("SwapExecute")).toContain(
      "a SwapQuoteUniswap or a namespaced quote authorizes its own execute, never this one",
    );
    expect(description("SwapQuoteUniswap")).toContain(
      "this quote authorizes SwapExecuteUniswap and nothing else",
    );
    expect(description("SwapExecuteUniswap")).toContain(
      "the only quote that authorizes this tool",
    );
  });
});

describe("I11 - the Vex fee is stated where it applies and where it does not", () => {
  it("labels SwapQuote's extraFee as the Vex fee", () => {
    expect(description("SwapQuote")).toContain(
      "extraFee - THE VEX FEE, 25 bps of the input token",
    );
    expect(description("SwapQuote")).toContain("the same 25 bps Vex fee, taken inside the Jupiter route");
  });

  it("SwapExecute names the fee it charges", () => {
    expect(description("SwapExecute")).toContain("Vex charges 25 bps of the input token");
  });

  it("the send pair states that it charges no Vex fee", () => {
    expect(description("WalletSendPrepare")).toContain("VEX CHARGES NO FEE on this path");
    expect(description("WalletSendConfirm")).toContain("Vex charges NO fee on this path");
  });

  it("the wrap pair keeps its no-fee statement", () => {
    expect(description("WalletWrapPrepare")).toContain("VEX CHARGES NO FEE on this path");
    expect(description("WalletWrapConfirm")).toContain("VEX CHARGES NO FEE");
  });
});

describe("the advisories the review raised", () => {
  it("A12 - BridgeStatus follows Khalani ids, and says where a Relay request is read", () => {
    const text = description("BridgeStatus");
    expect(text).toContain("It follows KHALANI order ids only");
    expect(text).toContain("A Relay bridge has NO status tool");
    expect(description("BridgeExecuteRelay")).toContain("BridgeStatus does NOT read it");
  });

  it("A13 - TokenFind names the app-local-chain lookup and the Relay-only bridge", () => {
    const text = description("TokenFind");
    expect(text).toContain("dexscreener namespace's pair search");
    expect(text).toContain("Robinhood Chain is bridged by Relay only");
  });

  it("A14 - mission_baseline is marked absent over MCP", () => {
    expect(description("AgentScan")).toContain(
      "in-app missions only; ABSENT over MCP",
    );
  });

  it("A17 - the Solana swap lane names JUPITER_API_KEY as its precondition", () => {
    for (const name of ["SwapQuote", "SwapExecute"]) {
      expect(description(name)).toContain("JUPITER_API_KEY");
      expect(description(name)).toContain("configuration_unavailable");
    }
  });

  it("A21 - WalletTrackToken says it raises no approval card", () => {
    expect(description("WalletTrackToken")).toContain("NO approval card");
  });
});

describe("the moved RETURNS tails point at the tool that carries them", () => {
  // The six descriptions the client was cutting, plus the two that grew past
  // the bound while gaining the approval sentence. Each ends its result
  // sentence with the reader whose RESULT no client truncates.
  const POINTS_AT_DESCRIBE = [
    "AgentScan",
    "TwitterAccount",
    "WebResearch",
    "BridgeExecute",
    "SwapExecute",
    "WalletEvmTransactionPrepare",
    "WalletEvmTransactionConfirm",
    "WalletWrapPrepare",
    "WalletWrapConfirm",
  ];

  it.each(POINTS_AT_DESCRIBE)("%s names vex_ToolDescribe for the whole contract", (name) => {
    expect(description(name)).toContain("Full contract: vex_ToolDescribe");
  });

  it("vex_ToolSearch maps a publicName to the name the client shows", () => {
    const text = description("vex_ToolSearch");
    expect(text).toContain("mcp__vex__<publicName>");
    expect(text).toContain("For the whole contract of any tool call vex_ToolDescribe");
    // The sentence that was false in Claude Code (finding I4).
    expect(text).not.toContain("there is no select or activation step");
    // The bounded-answer route, with no cursor to invent.
    expect(text).toContain("there is NO CURSOR");
  });
});
