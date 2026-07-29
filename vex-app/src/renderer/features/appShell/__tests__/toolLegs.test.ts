/**
 * SWAP/BRIDGE LEG PARSING — money-path honesty (rules/90).
 *
 * Two laws are pinned here. First, FAIL CLOSED: truncated (the 2000-char DTO
 * cap), malformed, or half-present payloads produce NO legs, because an arrow
 * pointing at nothing reads as a completed leg that never happened. Second,
 * NEVER GUESS AN AMOUNT: a raw base-unit integer carries no decimals to read
 * it by, so it renders no number at all rather than a possible thousandfold
 * error — the token still names itself, which is honest.
 */

import { describe, expect, it } from "vitest";
import { resolveToolLegs } from "../ToolLedger/toolLegs.js";

describe("resolveToolLegs — fail-closed parsing", () => {
  it.each([
    ["null args and output", null, null],
    ["truncated JSON", '{"tokenIn":"SOL","tokenOut":"USD', null],
    ["not JSON at all", "tokenIn=SOL", null],
    ["a JSON array", '["SOL","USDC"]', null],
    ["only ONE side present", '{"tokenIn":"SOL"}', null],
    ["non-string tokens", '{"tokenIn":1,"tokenOut":2}', null],
  ])("returns null for %s", (_label, args, output) => {
    expect(resolveToolLegs(args, output)).toBeNull();
  });
});

describe("resolveToolLegs — amounts are never invented", () => {
  it("renders a dotted-decimal human amount", () => {
    const legs = resolveToolLegs(
      '{"tokenIn":"SOL","tokenOut":"USDC","amountIn":"1.5"}',
      '{"amountOut":"240.31"}',
    );
    expect(legs?.from.amount).toBe("1.5");
    expect(legs?.to.amount).toBe("240.31");
  });

  it("renders NO amount for a raw base-unit integer (no decimals to read it by)", () => {
    const legs = resolveToolLegs(
      '{"tokenIn":"SOL","tokenOut":"USDC","amountIn":"1500000000"}',
      null,
    );
    expect(legs).not.toBeNull();
    expect(legs?.from.amount).toBeNull();
    // The token still names itself — an omitted number is honest.
    expect(legs?.from.token.text).toBe("SOL");
  });

  it("still names both tokens when neither amount can be proven", () => {
    const legs = resolveToolLegs('{"tokenIn":"SOL","tokenOut":"USDC"}', null);
    expect(legs?.from.token.text).toBe("SOL");
    expect(legs?.to.token.text).toBe("USDC");
    expect(legs?.from.amount).toBeNull();
    expect(legs?.to.amount).toBeNull();
  });
});

describe("resolveToolLegs — shapes and provenance", () => {
  it("reads the execute_tool wrapper's nested params (one level only)", () => {
    const legs = resolveToolLegs(
      '{"toolId":"kyberswap.swap.quote","params":{"tokenIn":"ETH","tokenOut":"USDC","amountIn":"0.25"}}',
      null,
    );
    expect(legs?.from.token.text).toBe("ETH");
    expect(legs?.to.token.text).toBe("USDC");
    expect(legs?.from.amount).toBe("0.25");
  });

  it("prefers the OUTPUT's out-amount (what happened) over the args (what was asked)", () => {
    const legs = resolveToolLegs(
      '{"tokenIn":"SOL","tokenOut":"USDC","amountOut":"999.0"}',
      '{"amountOut":"240.31"}',
    );
    expect(legs?.to.amount).toBe("240.31");
  });

  it("truncates a raw mint through the shared token-display grammar", () => {
    const mint = "So11111111111111111111111111111111111111112";
    const legs = resolveToolLegs(
      `{"inputMint":"${mint}","outputMint":"7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"}`,
      null,
    );
    // A KNOWN mint is the only path to a brand ticker + mark.
    expect(legs?.from.token.text).toBe("SOL");
    expect(legs?.from.token.iconSymbol).toBe("SOL");
    // An unknown mint gets a truncated address and NO brand mark.
    expect(legs?.to.token.text).toContain("…");
    expect(legs?.to.token.iconSymbol).toBeNull();
  });
});
