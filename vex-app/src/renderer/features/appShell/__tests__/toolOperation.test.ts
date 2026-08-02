/**
 * OPERATION IDENTITY (quote vs execution) — the renderer-side mirror of the
 * engine's action-alias registry (`src/vex-agent/tools/registry/action-aliases.ts`).
 *
 * Pins the two laws that keep a preview from reading as a trade: the exact
 * names of the read-only and mutating aliases (including `bridge`, whose name
 * carries no `bridge_` prefix), and the fail-closed direction — an unrecognised
 * money-shaped tool, and every `execute_tool` whose args do not PROVE a quote,
 * is `unproven` and therefore always labelled. Mutating identity is never
 * derived from untrusted args.
 */

import { describe, expect, it } from "vitest";
import { resolveToolOperation } from "../ToolLedger/toolOperation.js";

describe("resolveToolOperation — engine alias mirror", () => {
  it.each([
    "swap_quote",
    "swap_quote_uniswap",
    "bridge_quote",
    "bridge_quote_relay",
  ])("reads %s as a read-only quote", (name) => {
    expect(resolveToolOperation(name, null, null)).toBe("quote");
  });

  it.each([
    "swap_execute",
    "swap_execute_uniswap",
    "bridge",
    "bridge_execute_relay",
  ])("reads %s as a mutating operation", (name) => {
    expect(resolveToolOperation(name, null, null)).toBe("mutating");
  });

  it("reads an UNKNOWN swap/bridge-family name as unproven, never mutating", () => {
    expect(resolveToolOperation("swap_execute_futureswap", null, null)).toBe(
      "unproven",
    );
    expect(resolveToolOperation("bridge_settle_somewhere", null, null)).toBe(
      "unproven",
    );
  });

  it("gives a non-money tool NO operation at all (no legs)", () => {
    expect(resolveToolOperation("wallet_balances", null, null)).toBeNull();
    expect(resolveToolOperation("web_research", null, null)).toBeNull();
  });
});

describe("resolveToolOperation — execute_tool reads args ONE way only", () => {
  it("gives an uncurated (unproven-venue) wrapper no operation", () => {
    expect(
      resolveToolOperation("execute_tool", null, '{"toolId":"kyberswap.swap.execute"}'),
    ).toBeNull();
  });

  it("admits a quote segment from a curated wrapper — a DOWNGRADE of the claim", () => {
    expect(
      resolveToolOperation(
        "execute_tool",
        "kyberswap",
        '{"toolId":"kyberswap.swap.quote","params":{}}',
      ),
    ).toBe("quote");
  });

  it.each([
    ['an execute toolId', '{"toolId":"kyberswap.swap.execute"}'],
    ["a bare bridge toolId", '{"toolId":"khalani.bridge"}'],
    ["a malformed payload", '{"toolId":"kyberswap.swap.exec'],
    ["a non-string toolId", '{"toolId":42}'],
    ["no args at all", null],
  ])(
    "never upgrades %s to mutating — it stays unproven (and therefore labelled)",
    (_label, args) => {
      expect(resolveToolOperation("execute_tool", "kyberswap", args)).toBe(
        "unproven",
      );
    },
  );
});
