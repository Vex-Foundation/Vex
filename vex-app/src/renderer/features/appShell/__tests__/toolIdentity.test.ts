/**
 * PROTOCOL IDENTITY (contract C5) — the rules a friendly tool card's mark and
 * title rest on.
 *
 * The two things pinned hardest here are the FAIL-CLOSED paths: a truncated
 * `toolArgs` payload (the DTO caps the sanitized JSON at 2000 chars, so a big
 * call arrives unparseable) and any malformed/lookalike shape must yield NO
 * protocol at all. A half-read namespace would put some other venue's logo
 * next to the user's money, which is the exact provenance lie
 * `lib/protocol-marks.ts` exists to prevent.
 */

import { describe, expect, it } from "vitest";
import {
  isDottedProtocolToolId,
  resolveToolIdentity,
} from "../ToolLedger/toolIdentity.js";

/**
 * Main normalizes an injected protocol call from `kyberswap__swap__quote` to
 * its dotted `toolId` before the DTO is built, so the renderer now meets the
 * dotted form as the tool NAME — the same grammar its `execute_tool` path
 * already speaks. These blocks pin that lane, and the fail-closed guard for a
 * name main could NOT canonicalize.
 */
describe("isDottedProtocolToolId", () => {
  it.each(["kyberswap.swap.quote", "relay.bridge", "dexscreener.tokenPairs"])(
    "accepts %s",
    (id) => {
      expect(isDottedProtocolToolId(id)).toBe(true);
    },
  );

  it.each([
    ["no dot", "execute_tool"],
    ["an empty segment", "kyberswap..quote"],
    ["a trailing dot", "kyberswap."],
    ["a leading dot", ".quote"],
    ["whitespace", "kyberswap.swap quote"],
    ["empty", ""],
  ])("rejects %s", (_label, id) => {
    expect(isDottedProtocolToolId(id)).toBe(false);
  });
});

describe("resolveToolIdentity — dotted protocol toolIds (the canonicalized lane)", () => {
  it.each([
    ["kyberswap.swap.quote", "kyberswap", "KyberSwap · Swap quote", "swap"],
    ["kyberswap.swap.execute", "kyberswap", "KyberSwap · Swap", "swap"],
    ["uniswap.swap.execute", "uniswap", "Uniswap · Swap", "swap"],
    ["solana.swap.quote", "solana", "Solana · Swap quote", "swap"],
    ["relay.quote.get", "relay", "Relay · Bridge quote", "bridge"],
    ["relay.bridge", "relay", "Relay · Bridge", "bridge"],
    ["khalani.quote.get", "khalani", "Khalani · Bridge quote", "bridge"],
    ["trench.launch_execute", "trench", "Trench Express · Launch", "tool"],
    ["pendle.markets", "pendle", "Pendle · Markets", "tool"],
    ["virtuals.agents.list", "virtuals", "Virtuals · Agents list", "tool"],
  ])("resolves %s to the %s mark", (toolId, protocol, title, category) => {
    expect(resolveToolIdentity(toolId, null)).toEqual({ protocol, title, category });
  });

  it("gives khalani.bridge the BRIDGE category — the `khalani_` prefix rule must not eat it", () => {
    expect(resolveToolIdentity("khalani.bridge", null)).toEqual({
      protocol: "khalani",
      title: "Khalani · Bridge",
      category: "bridge",
    });
  });

  it("stops collapsing distinct dexscreener acts into one title", () => {
    const search = resolveToolIdentity("dexscreener.search", null);
    const trending = resolveToolIdentity("dexscreener.trending", null);
    expect(search.protocol).toBe("dexscreener");
    expect(trending.protocol).toBe("dexscreener");
    expect(search.title).not.toBe(trending.title);
  });

  it("does not categorise a protocol SEARCH as a web act", () => {
    expect(resolveToolIdentity("trench.search", null).category).toBe("market");
    expect(resolveToolIdentity("solana.predict.search", null).category).not.toBe("web");
  });

  it("preserves camelCase — an incidental toLowerCase would lose the map", () => {
    expect(resolveToolIdentity("dexscreener.tokenPairs", null).protocol).toBe(
      "dexscreener",
    );
  });

  it("gives an UNCURATED dotted namespace no venue at all", () => {
    const identity = resolveToolIdentity("kyberswapp.swap.quote", null);
    expect(identity.protocol).toBeNull();
    expect(identity.title).toBe("Kyberswapp swap quote");
  });

  it.each(["khalani__unknown", "dexscreener__unknown", "kyberswapp__swap__quote"])(
    "refuses a venue to %s — a name main could not canonicalize is unknown, not branded",
    (name) => {
      const identity = resolveToolIdentity(name, null);
      expect(identity.protocol).toBeNull();
      expect(identity.category).toBe("tool");
    },
  );
});

/**
 * The wrapper's namespace read is fail-closed at every step. Asserted through
 * the resolver itself (the parser is an implementation detail): a truncated
 * payload — the 2000-char DTO cap makes a big call unparseable — an array, a
 * primitive, a missing/empty/non-string `toolId`, or a namespace that is not a
 * plain lower-case identifier must all yield NO venue at all.
 */
describe("resolveToolIdentity — the wrapper's namespace read is fail-closed", () => {
  it.each([
    ["null args", null],
    ["empty string", ""],
    ["not JSON", "kyberswap"],
    ["a JSON array", '["kyberswap"]'],
    ["a JSON primitive", '"kyberswap"'],
    ["no toolId key", '{"params":{}}'],
    ["non-string toolId", '{"toolId":42}'],
    ["empty toolId", '{"toolId":""}'],
    ["a hostile namespace", '{"toolId":"../../etc.passwd"}'],
    ["TRUNCATED JSON", '{"toolId":"kyberswap.swap.quote","params":{"amount":"10'],
  ])("gives NO venue for %s", (_label, args) => {
    const identity = resolveToolIdentity("execute_tool", args);
    expect(identity.protocol).toBeNull();
    expect(identity.title).toBe("Execute tool");
  });
});

describe("resolveToolIdentity — named tools (prefix map is primary)", () => {
  it("names the venue when the tool name names it", () => {
    expect(resolveToolIdentity("swap_execute_uniswap", null)).toEqual({
      protocol: "uniswap",
      title: "Swap · Uniswap",
      category: "swap",
    });
    expect(resolveToolIdentity("bridge_execute_relay", null)).toEqual({
      protocol: "relay",
      title: "Bridge · Relay",
      category: "bridge",
    });
  });

  it("keeps a venue-less swap honest — no venue, no borrowed mark", () => {
    const identity = resolveToolIdentity("swap_execute", null);
    expect(identity.protocol).toBeNull();
    expect(identity.title).toBe("Swap");
    expect(identity.category).toBe("swap");
  });

  it("maps khalani_* to khalani", () => {
    const identity = resolveToolIdentity("khalani_tokens_top", null);
    expect(identity.protocol).toBe("khalani");
    expect(identity.category).toBe("market");
  });

  it("maps wallet_*/chain_read to the wallet category with human titles", () => {
    expect(resolveToolIdentity("wallet_send_confirm", null)).toEqual({
      protocol: null,
      title: "Transfer · confirm",
      category: "wallet",
    });
    expect(resolveToolIdentity("chain_read", null).title).toBe("Chain read");
  });

  it("maps memory-shaped tools to a single human title", () => {
    expect(resolveToolIdentity("long_memory_suggest", null)).toEqual({
      protocol: null,
      title: "Memory recall",
      category: "memory",
    });
    expect(resolveToolIdentity("session_memory_search", null).category).toBe(
      "memory",
    );
  });

  it("maps web_research to the web category", () => {
    expect(resolveToolIdentity("web_research", null)).toEqual({
      protocol: null,
      title: "Web research",
      category: "web",
    });
  });

  it("humanizes an unknown tool instead of printing raw snake_case", () => {
    expect(resolveToolIdentity("some_new_tool", null)).toEqual({
      protocol: null,
      title: "Some new tool",
      category: "tool",
    });
  });

  it("never consults args for a NAMED tool — identity cannot be spoofed by payload", () => {
    const spoofed = resolveToolIdentity(
      "wallet_balances",
      '{"toolId":"uniswap.swap.quote"}',
    );
    expect(spoofed.protocol).toBeNull();
  });
});

describe("resolveToolIdentity — generic wrappers", () => {
  // The curated presentation map is shared with the dotted lane, so the legacy
  // wrapper now reports the same (more accurate) `swap` category the dotted
  // `kyberswap.swap.quote` does. Category is presentational — glyph and a data
  // attribute; `resolveToolOperation`, not the category, gates the money legs.
  it("derives the venue from the toolId namespace", () => {
    expect(resolveToolIdentity("execute_tool", '{"toolId":"kyberswap.swap.quote"}')).toEqual({
      protocol: "kyberswap",
      title: "KyberSwap · Swap quote",
      category: "swap",
    });
  });

  it("uses the curated LABEL, so an uncurated namespace still reads honestly", () => {
    const identity = resolveToolIdentity(
      "execute_tool",
      '{"toolId":"virtuals.agents.list"}',
    );
    expect(identity.protocol).toBe("virtuals");
    expect(identity.title).toBe("Virtuals · Agents list");
  });

  it("FAILS CLOSED on truncated args — the wrapper's own name, no venue", () => {
    const identity = resolveToolIdentity(
      "execute_tool",
      '{"toolId":"kyberswap.swap.quote","params":{"amount":"10',
    );
    expect(identity.protocol).toBeNull();
    expect(identity.title).toBe("Execute tool");
  });

  it.each([
    ["a lookalike of a curated venue", '{"toolId":"kyberswapp.swap.quote"}'],
    ["an arbitrary valid namespace", '{"toolId":"totally_new_venue.do.thing"}'],
    ["a bare namespace with no action", '{"toolId":"evil"}'],
  ])(
    "gives NO venue to %s — a syntactically valid namespace is not provenance",
    (_label, args) => {
      const identity = resolveToolIdentity("execute_tool", args);
      expect(identity.protocol).toBeNull();
      // The wrapper's own honest name — never an attacker-named venue title.
      expect(identity.title).toBe("Execute tool");
    },
  );

  it.each([
    ["trench.tokens", "Trench Express · Token list", "market"],
    ["trench.search", "Trench Express · Token search", "market"],
    ["trench.trades", "Trench Express · Trade tape", "market"],
    ["trench.trade_quote", "Trench Express · Trade quote", "swap"],
    ["trench.trade_execute", "Trench Express · Trade", "swap"],
    ["trench.launch_preview", "Trench Express · Launch preview", "tool"],
    ["trench.launch_request_form", "Trench Express · Launch form", "tool"],
    ["trench.launch_execute", "Trench Express · Launch", "tool"],
    ["trench.my_launches", "Trench Express · My launches", "tool"],
    ["trench.images", "Trench Express · Image locker", "tool"],
  ])("titles the Trench act %s as %s", (toolId, title, category) => {
    expect(resolveToolIdentity("execute_tool", `{"toolId":"${toolId}"}`)).toEqual({
      protocol: "trench",
      title,
      category,
    });
  });

  // All SIXTEEN Morpho ids (nine reads, two previews, and the five that move
  // funds), pinned exactly like the Trench set above: a manifest nobody mirrors
  // here must show up as a failing row rather than as a humanized guess. The
  // camelCase Blue ids are load-bearing: lower-casing one would lose the map.
  it.each([
    ["morpho.markets.discover", "Morpho · Market list", "market"],
    ["morpho.market.get", "Morpho · Market detail", "market"],
    ["morpho.markets.activity", "Morpho · Market activity", "market"],
    ["morpho.vaults.discover", "Morpho · Vault list", "market"],
    ["morpho.vault.get", "Morpho · Vault detail", "market"],
    ["morpho.rewards.get", "Morpho · Rewards", "market"],
    ["morpho.positions.get", "Morpho · Positions", "wallet"],
    ["morpho.wallet.balance", "Morpho · Wallet balance", "wallet"],
    ["morpho.vault.quote", "Morpho · Vault quote", "tool"],
    ["morpho.vault.deposit", "Morpho · Vault deposit", "tool"],
    ["morpho.vault.withdraw", "Morpho · Vault withdrawal", "tool"],
    ["morpho.market.quote", "Morpho · Market preview", "tool"],
    ["morpho.market.supplyCollateral", "Morpho · Supply collateral", "tool"],
    ["morpho.market.withdrawCollateral", "Morpho · Withdraw collateral", "tool"],
    ["morpho.market.borrow", "Morpho · Borrow", "tool"],
    ["morpho.market.repay", "Morpho · Repay", "tool"],
  ])("titles the Morpho act %s as %s", (toolId, title, category) => {
    expect(resolveToolIdentity("execute_tool", `{"toolId":"${toolId}"}`)).toEqual({
      protocol: "morpho",
      title,
      category,
    });
  });

  it.each([
    ["pools.tokens", "pools.fun · Token list", "market"],
    ["pools.search", "pools.fun · Token search", "market"],
    ["pools.candles", "pools.fun · Candles", "market"],
    ["pools.token", "pools.fun · Token detail", "market"],
    ["pools.my_launches", "pools.fun · My launches", "tool"],
    ["pools.launch_preview", "pools.fun · Launch preview", "tool"],
    ["pools.launch_request_form", "pools.fun · Launch form", "tool"],
    ["pools.launch_execute", "pools.fun · Launch", "tool"],
    ["pools.claim_fees", "pools.fun · Claim fees", "tool"],
  ])("titles the pools.fun act %s as %s", (toolId, title, category) => {
    expect(resolveToolIdentity("execute_tool", `{"toolId":"${toolId}"}`)).toEqual({
      protocol: "pools",
      title,
      category,
    });
  });

  it("titles a Morpho act reached through the DOTTED lane identically", () => {
    expect(resolveToolIdentity("morpho.vault.deposit", null)).toEqual({
      protocol: "morpho",
      title: "Morpho · Vault deposit",
      category: "tool",
    });
  });

  it("titles a DOTTED pools act the same way as the wrapped one", () => {
    expect(resolveToolIdentity("pools.candles", null)).toEqual({
      protocol: "pools",
      title: "pools.fun · Candles",
      category: "market",
    });
  });

  it("gives NO venue to a pools lookalike namespace", () => {
    const identity = resolveToolIdentity("execute_tool", '{"toolId":"poolsfun.tokens"}');
    expect(identity.protocol).toBeNull();
    expect(identity.title).toBe("Execute tool");
  });

  it("falls back to the humanizer for an unmirrored trench id — venue proven, action not curated", () => {
    expect(resolveToolIdentity("execute_tool", '{"toolId":"trench.new_thing"}')).toEqual({
      protocol: "trench",
      title: "Trench Express · New thing",
      category: "tool",
    });
  });

  it("labels discover_tools as discovery with no venue when args prove none", () => {
    expect(resolveToolIdentity("discover_tools", null)).toEqual({
      protocol: null,
      title: "Tool discovery",
      category: "discovery",
    });
  });

  // `describe_tools` fetches the FULL manifests for ids a ranked discovery
  // already returned, so it belongs to the same act family. The CATEGORY is the
  // assertion that matters: a title row alone would still leave it filed as a
  // generic "tool" and it would lose the discovery glyph.
  it("files describe_tools under DISCOVERY, not as a generic tool", () => {
    expect(resolveToolIdentity("describe_tools", null)).toEqual({
      protocol: null,
      title: "Tool manifests",
      category: "discovery",
    });
  });

  it("keeps describe_tools venue-less even when its args name toolIds", () => {
    const identity = resolveToolIdentity(
      "describe_tools",
      '{"toolIds":["kyberswap.swap.quote","relay.bridge"]}',
    );
    expect(identity.protocol).toBeNull();
    expect(identity.category).toBe("discovery");
  });
});
