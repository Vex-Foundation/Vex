/**
 * Internal-tool error hygiene — the model-facing rejection contract.
 *
 * Every string asserted here was UNPINNED before this suite: the 2026-07-30
 * audit found the tools free to answer "Too small: expected string to have >=1
 * characters" to a call that named five parameters, and nothing failed. These
 * are the properties that must survive, not the exact prose:
 *
 *   - a rejection LOCATES the field (zod 4 never does it for us);
 *   - a supplied param is never silently discarded (`rules/90`);
 *   - a wrong TYPE is never reported as MISSING;
 *   - no user/model VALUE is echoed back (`rules/06`);
 *   - no message tells the agent to run a CLI it does not have.
 */

import { describe, expect, it, vi } from "vitest";
import { makeTestContext } from "../_test-context.js";

vi.mock("@vex-agent/tools/protocols/runtime.js", () => ({
  executeProtocolTool: vi.fn(async () => ({ success: true, output: "{}" })),
  discoverProtocolCapabilities: vi.fn(async () => ({ tools: [] })),
}));

const aliases = await import("@vex-agent/tools/internal/action-aliases.js");
const { handleWalletBalances } = await import("@vex-agent/tools/internal/wallet/read.js");
const { handleWalletTrackToken } = await import("@vex-agent/tools/internal/wallet/track.js");
const { handleLoopDefer } = await import("@vex-agent/tools/internal/loop-defer.js");
const { handleChainRead } = await import("@vex-agent/tools/internal/chain-read.js");
const { parseWebResearchRequest } = await import(
  "@vex-agent/tools/internal/web-research/search-options.js"
);
const { parseDiscoverToolsArgs } = await import(
  "@vex-agent/tools/dispatcher/discover-tools-args.js"
);
const { validatePrepareParams, validateConfirmParams } = await import(
  "@vex-agent/tools/internal/wallet/send/validation.js"
);
const { executeProtocolTool } = await import("@vex-agent/tools/protocols/runtime.js");

const ctx = makeTestContext();

const VALID_BRIDGE = {
  fromChain: "base",
  fromToken: "0xfrom",
  toChain: "arbitrum",
  toToken: "0xto",
  amountRaw: "1000000",
} as const;

describe("bridge_quote — a refused param is answered BY NAME, before normalization", () => {
  // THE ordering invariant. `bridge_quote` runs an empty-value normalization
  // pre-pass so `recipient: ""` no longer costs a turn. Applied FIRST it would
  // also delete `refundTo: ""` — and the agent's attempt to redirect where a
  // failed bridge returns the user's money would vanish without a word. The
  // refusal therefore runs BEFORE the normalization, and this proves the order.
  it.each(["bridge_quote", "bridge_quote_relay"] as const)(
    "%s refuses an EMPTY refundTo by name rather than normalizing it away",
    async (tool) => {
      // A Robinhood route: `bridge_quote_relay`'s route-bound reveal gate runs
      // BEFORE the param policy (availability first), and the local-chain
      // carve-out is what lets this reach the refusal on both aliases.
      const args = { ...VALID_BRIDGE, fromChain: "robinhood", refundTo: "" };
      const result = tool === "bridge_quote"
        ? await aliases.handleBridgeQuote(args, ctx)
        : await aliases.handleBridgeQuoteRelay(args, ctx);

      expect(result.success).toBe(false);
      expect(result.output).toContain("refundTo");
      expect(result.output).toContain("not an accepted parameter");
    },
  );

  it("still refuses a populated refundTo by name", async () => {
    const result = await aliases.handleBridgeQuote(
      { ...VALID_BRIDGE, refundTo: "0xattacker" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("refundTo");
    // The attacker's address is never echoed back.
    expect(result.output).not.toContain("0xattacker");
  });

  it("refuses a fee param by name (the value-based rule is unchanged)", async () => {
    const result = await aliases.handleBridgeQuote(
      { ...VALID_BRIDGE, referrerFeeBps: 50 },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("referrerFeeBps");
  });

  it("normalizes an empty OPTIONAL away instead of burning the call", async () => {
    vi.mocked(executeProtocolTool).mockClear();
    const result = await aliases.handleBridgeQuote(
      { ...VALID_BRIDGE, recipient: "", tradeType: "" },
      ctx,
    );
    expect(result.success).toBe(true);
    // Dropped, not forwarded as an empty destination.
    const forwarded = vi.mocked(executeProtocolTool).mock.calls[0]?.[0].params;
    expect(forwarded).not.toHaveProperty("recipient");
    expect(forwarded).not.toHaveProperty("tradeType");
  });

  it("names a required field that arrived empty, with the absent rule", async () => {
    const result = await aliases.handleBridgeQuote({ ...VALID_BRIDGE, fromChain: "" }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain("fromChain");
    expect(result.output).toContain("means ABSENT");
  });
});

describe("action aliases — every rejection locates its field", () => {
  it("swap_quote names each missing param instead of repeating one message", async () => {
    const result = await aliases.handleSwapQuote({}, ctx);
    expect(result.success).toBe(false);
    for (const field of ["chain", "tokenIn", "tokenOut", "amountIn"]) {
      expect(result.output).toContain(`${field}:`);
    }
  });

  it("token_check names the field", async () => {
    const result = await aliases.handleTokenCheck({ chain: "base" }, ctx);
    expect(result.output).toContain("address:");
  });

  it("bridge_status names the field", async () => {
    const result = await aliases.handleBridgeStatus({ limit: "5" }, ctx);
    expect(result.output).toContain("limit:");
  });
});

describe("wallet_balances — the live failure", () => {
  it("names limit and explains that it only applies to the concise format", async () => {
    const result = await handleWalletBalances({ limit: 0 }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain("limit:");
    expect(result.output).toContain("concise");
  });

  it("names chainIds on a wrong type", async () => {
    const result = await handleWalletBalances({ chainIds: 8453 }, ctx);
    expect(result.output).toContain("chainIds:");
  });
});

describe("a wrong TYPE is never reported as MISSING", () => {
  it("chain_read tells a numeric chain it is the wrong type, not absent", async () => {
    // token_find returns the chain id as a NUMBER, so this is the form the
    // agent holds.
    const result = await handleChainRead(
      { action: "tx_receipt", chain: 8453, txHash: "0xabc" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("chain");
    expect(result.output).not.toContain("Missing required");
    expect(result.output).toContain("number");
  });

  it("chain_read still says MISSING when the key really is absent", async () => {
    const result = await handleChainRead({ action: "tx_receipt" }, ctx);
    expect(result.output).toContain("Missing required: chain");
  });

  it("wallet_send_prepare names ONE field, and a number amountIn as a number", () => {
    const validation = validatePrepareParams({ walletFamily: "eip155", to: "0xdead", amountIn: 907.42 });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.result.output).toContain("amountIn");
    expect(validation.result.output).not.toContain("Missing required: walletFamily, to, amountIn");
    // The amount itself is never echoed.
    expect(validation.result.output).not.toContain("907.42");
  });

  it("wallet_send_confirm names the absent field only", () => {
    const validation = validateConfirmParams({ walletFamily: "eip155" });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.result.output).toContain("intentId");
    expect(validation.result.output).not.toContain("walletFamily,");
  });
});

describe("discover_tools — a supplied param is never silently discarded", () => {
  it("coerces the lossless string spelling of limit", () => {
    const parsed = parseDiscoverToolsArgs({ query: "swap", limit: "10" });
    expect(parsed).toEqual({ ok: true, args: { query: "swap", limit: 10, list: false } });
  });

  it("coerces the string spelling of list", () => {
    const parsed = parseDiscoverToolsArgs({ namespace: "khalani", list: "true" });
    expect(parsed.ok && parsed.args.list).toBe(true);
  });

  it("REJECTS an over-max limit BY NAME rather than silently clamping it", () => {
    // Owner clarification 2026-08-03: the agent sizes its own working set, but
    // the ceiling is real (it bounds the injected function-schema set). A
    // silent clamp would hand back fewer tools than asked for, with no signal.
    const parsed = parseDiscoverToolsArgs({ query: "swap", limit: 50 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("limit 50");
    expect(parsed.message).toContain("maximum of 20");
    expect(parsed.message).toContain("NOT run");
  });

  it("accepts the maximum limit itself (the boundary is not off by one)", () => {
    const parsed = parseDiscoverToolsArgs({ query: "swap", limit: 20 });
    expect(parsed.ok && parsed.args.limit).toBe(20);
  });

  it("REJECTS a wrong-typed limit by name instead of dropping it", () => {
    const parsed = parseDiscoverToolsArgs({ query: "swap", limit: "ten" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("limit");
    expect(parsed.message).toContain("NOT applied");
  });

  it("REJECTS a wrong-typed query by name", () => {
    const parsed = parseDiscoverToolsArgs({ query: 42 });
    expect(parsed.ok).toBe(false);
  });

  it("treats an empty value as absent rather than rejecting it", () => {
    expect(parseDiscoverToolsArgs({ query: "swap", namespace: "" }))
      .toEqual({ ok: true, args: { query: "swap", list: false } });
  });

  it("keeps list:false — a boolean false is a value, not a blank", () => {
    expect(parseDiscoverToolsArgs({ query: "swap", list: false }).ok).toBe(true);
  });
});

describe("web_research — an empty query reads as absent", () => {
  it("lets the exactly-one-of rule speak instead of a size complaint", () => {
    const parsed = parseWebResearchRequest({ query: "" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.message).toContain("exactly one of");
  });

  it("fetches the page when the model filled the unused query with an empty string", () => {
    const parsed = parseWebResearchRequest({ query: "", url: "https://example.com" });
    expect(parsed).toEqual({ success: true, request: { mode: "page", url: "https://example.com" } });
  });

  it("locates a wrong-typed search param", () => {
    const parsed = parseWebResearchRequest({ query: "x", maxResults: "5" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.message).toContain("maxResults:");
  });
});

describe("path prefixes on the remaining tools", () => {
  it("wallet_track_token names the field", async () => {
    const result = await handleWalletTrackToken({ chain: "robinhood" }, ctx);
    expect(result.output).toContain("action:");
  });

  it("loop_defer names the field", async () => {
    const result = await handleLoopDefer({}, ctx);
    expect(result.output).toContain("reason:");
  });
});
