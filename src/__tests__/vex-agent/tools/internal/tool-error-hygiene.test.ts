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
const { parseToolSearchArgs } = await import(
  "@vex-agent/tools/dispatcher/tool-search-args.js"
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
    expect(result.output).toContain("tokenAddress:");
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

describe("ToolSearch — a supplied param is never silently discarded", () => {
  it("coerces the lossless string spelling of limit", () => {
    const parsed = parseToolSearchArgs({ query: "swap", limit: "10" });
    expect(parsed).toEqual({ ok: true, args: { mode: "query", query: "swap", limit: 10 } });
  });

  it("REJECTS the retired `list` argument by name rather than coercing it", () => {
    // `list: true` is how the retired discovery tool asked for a namespace
    // listing. A bare `namespace` IS the listing now, so the old spelling is
    // answered by name with the mode that replaced it rather than silently
    // honoured — a stale call must learn the new grammar, not work by accident.
    const parsed = parseToolSearchArgs({ namespace: "khalani", list: "true" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("`list` is retired");
  });

  it("REJECTS an over-max limit BY NAME rather than silently clamping it", () => {
    // Owner clarification 2026-08-03: the agent sizes its own working set, but
    // the ceiling is real (it bounds the injected function-schema set). A
    // silent clamp would hand back fewer tools than asked for, with no signal.
    const parsed = parseToolSearchArgs({ query: "swap", limit: 50 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("limit 50");
    expect(parsed.message).toContain("maximum of 20");
    expect(parsed.message).toContain("NOT run");
  });

  it("accepts the maximum limit itself (the boundary is not off by one)", () => {
    const parsed = parseToolSearchArgs({ query: "swap", limit: 20 });
    // Narrow through the mode discriminator rather than reaching for `limit`
    // on the union: `limit` is a QUERY-mode field, and the union is what makes
    // "a select carrying a limit" unrepresentable in the first place.
    expect(parsed.ok && parsed.args.mode === "query" && parsed.args.limit).toBe(20);
  });

  // The parser used to accept every one of these and let discovery floor,
  // clamp or default them, so the agent silently got a differently-sized
  // answer than it asked for. Reject-not-clamp applies to the VALUE too.
  it.each([
    ["zero", 0],
    ["a negative", -3],
    ["a fraction", 2.5],
    ["NaN", Number.NaN],
    ["negative infinity", Number.NEGATIVE_INFINITY],
  ])("REJECTS %s limit BY NAME with the legal range", (_label, limit) => {
    const parsed = parseToolSearchArgs({ query: "swap", limit });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("limit must be a whole number between 1 and 20");
    expect(parsed.message).toContain("default 5");
    expect(parsed.message).toContain("NOT run");
  });

  it("REJECTS the string spelling of an out-of-range limit the same way", () => {
    const parsed = parseToolSearchArgs({ query: "swap", limit: "0" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("between 1 and 20");
  });

  it("accepts the minimum limit itself (the lower boundary is not off by one)", () => {
    expect(parseToolSearchArgs({ query: "swap", limit: 1 }).ok).toBe(true);
  });

  it("REJECTS positive infinity through the over-max lane, still by name", () => {
    const parsed = parseToolSearchArgs({ query: "swap", limit: Number.POSITIVE_INFINITY });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("maximum of 20");
  });

  it("REJECTS a wrong-typed limit by name instead of dropping it", () => {
    const parsed = parseToolSearchArgs({ query: "swap", limit: "ten" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("limit");
    expect(parsed.message).toContain("NOT run");
  });

  it("REJECTS a wrong-typed query by name", () => {
    const parsed = parseToolSearchArgs({ query: 42 });
    expect(parsed.ok).toBe(false);
  });

  it("treats an empty value as absent rather than rejecting it", () => {
    expect(parseToolSearchArgs({ query: "swap", namespace: "" }))
      .toEqual({ ok: true, args: { mode: "query", query: "swap" } });
  });

  it("names `list: false` too — a boolean false is a value, not a blank", () => {
    // `dropEmptyModelValues` keeps `false`, so the retired key is still SEEN
    // and still answered. Silently ignoring it would be the discard this
    // module exists to prevent, even when the value is the harmless one.
    const parsed = parseToolSearchArgs({ query: "swap", list: false });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("`list` is retired");
  });

  it("REJECTS an undeclared argument by name instead of discarding it", () => {
    // `additionalProperties: false` on the schema is the PROVIDER's check, and
    // provider paths exist that dispatch an arbitrary JSON root verbatim. This
    // parser is the enforcement, so an undeclared key must be named rather than
    // dropped into a result that looks like it honoured the whole call.
    const parsed = parseToolSearchArgs({ query: "swap on base", bogus: true });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("unknown argument");
    expect(parsed.message).toContain("`bogus`");
    expect(parsed.message).toContain("NOT run");
  });

  it("names an undeclared argument sent ALONGSIDE valid ones, and runs neither", () => {
    // The valid keys must not buy the call a pass: a partially-honoured search
    // is the silent discard wearing a success envelope.
    const parsed = parseToolSearchArgs({
      query: "bridge to base",
      namespace: "khalani",
      limit: 5,
      sortBy: "relevance",
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("`sortBy`");
  });

  it("names EVERY undeclared argument at once, not just the first", () => {
    const parsed = parseToolSearchArgs({ query: "swap", bogus: true, alsoBogus: 1 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("`bogus`");
    expect(parsed.message).toContain("`alsoBogus`");
  });

  it("names an undeclared `false` too — the retired-key rule, applied generally", () => {
    const parsed = parseToolSearchArgs({ query: "swap", verbose: false });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("`verbose`");
  });

  it("still treats an EMPTY undeclared value as absent, per this boundary's policy", () => {
    // "An empty value is absent" is the stated rule for every key here, and an
    // unknown key carrying nothing communicated no intent there was to discard.
    // Pinned so the sweep above cannot drift into rejecting blanks.
    expect(parseToolSearchArgs({ query: "swap", bogus: "" }))
      .toEqual({ ok: true, args: { mode: "query", query: "swap" } });
  });

  it("answers a RETIRED key with its migration message, not the generic sweep", () => {
    // Ordering matters: the retired shapes teach the new spelling. Collapsing
    // them into "unknown argument" would lose the migration.
    const parsed = parseToolSearchArgs({ namespace: "khalani", list: true });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("`list` is retired");
    expect(parsed.message).not.toContain("unknown argument");
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
