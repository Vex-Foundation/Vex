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
  parseToolIdNamespace,
  resolveToolIdentity,
} from "../ToolLedger/toolIdentity.js";

describe("parseToolIdNamespace — fail-closed", () => {
  it("reads the namespace before the first dot", () => {
    expect(parseToolIdNamespace('{"toolId":"kyberswap.swap.quote"}')).toBe(
      "kyberswap",
    );
    expect(parseToolIdNamespace('{"toolId":"solana.swap.quote"}')).toBe("solana");
  });

  it("returns null for TRUNCATED JSON (the 2000-char DTO cap) — never guesses the tail", () => {
    const truncated = '{"toolId":"kyberswap.swap.quote","params":{"amount":"10';
    expect(parseToolIdNamespace(truncated)).toBeNull();
  });

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
  ])("returns null for %s", (_label, args) => {
    expect(parseToolIdNamespace(args)).toBeNull();
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
  it("derives the venue from the toolId namespace", () => {
    expect(resolveToolIdentity("execute_tool", '{"toolId":"kyberswap.swap.quote"}')).toEqual({
      protocol: "kyberswap",
      title: "KyberSwap · Swap quote",
      category: "tool",
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

  it("labels discover_tools as discovery with no venue when args prove none", () => {
    expect(resolveToolIdentity("discover_tools", null)).toEqual({
      protocol: null,
      title: "Tool discovery",
      category: "discovery",
    });
  });
});
