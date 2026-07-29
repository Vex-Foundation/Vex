/**
 * SWAP/BRIDGE LEG PARSING — money-path honesty (rules/90).
 *
 * Four laws are pinned here. FAIL CLOSED: truncated, malformed, or
 * half-present payloads produce NO legs, because an arrow pointing at nothing
 * reads as a completed leg that never happened. NEVER GUESS AN AMOUNT: a raw
 * base-unit integer carries no decimals to read it by, so it renders no number
 * at all rather than a possible thousandfold error. OUTCOME IS PART OF THE
 * CLAIM: only a persisted `success === true` yields an `executed` pair, and
 * only an executed pair may read the untrusted OUTPUT. BOUNDED PARSING: an
 * oversized output is never handed to `JSON.parse` at all.
 */

import { describe, expect, it } from "vitest";
import { resolveToolLegs } from "../ToolLedger/toolLegs.js";

const SWAP_ARGS = '{"tokenIn":"SOL","tokenOut":"USDC","amountIn":"1.5"}';

describe("resolveToolLegs — fail-closed parsing", () => {
  it.each([
    ["null args and output", null, null],
    ["truncated JSON", '{"tokenIn":"SOL","tokenOut":"USD', null],
    ["not JSON at all", "tokenIn=SOL", null],
    ["a JSON array", '["SOL","USDC"]', null],
    ["only ONE side present", '{"tokenIn":"SOL"}', null],
    ["non-string tokens", '{"tokenIn":1,"tokenOut":2}', null],
  ])("returns null for %s", (_label, args, output) => {
    expect(resolveToolLegs(args, output, true)).toBeNull();
  });
});

describe("resolveToolLegs — amounts are never invented", () => {
  it("renders a dotted-decimal human amount", () => {
    const legs = resolveToolLegs(SWAP_ARGS, '{"amountOut":"240.31"}', true);
    expect(legs?.from.amount).toBe("1.5");
    expect(legs?.to.amount).toBe("240.31");
  });

  it("renders NO amount for a raw base-unit integer (no decimals to read it by)", () => {
    const legs = resolveToolLegs(
      '{"tokenIn":"SOL","tokenOut":"USDC","amountIn":"1500000000"}',
      null,
      true,
    );
    expect(legs).not.toBeNull();
    expect(legs?.from.amount).toBeNull();
    // The token still names itself — an omitted number is honest.
    expect(legs?.from.token.text).toBe("SOL");
  });

  it("renders NO amount for numeric junk with a valid prefix", () => {
    const legs = resolveToolLegs(
      '{"tokenIn":"SOL","tokenOut":"USDC","amountIn":"1.5garbage"}',
      '{"amountOut":"240.31<script>"}',
      true,
    );
    expect(legs?.from.amount).toBeNull();
    expect(legs?.to.amount).toBeNull();
  });

  it("still names both tokens when neither amount can be proven", () => {
    const legs = resolveToolLegs('{"tokenIn":"SOL","tokenOut":"USDC"}', null, true);
    expect(legs?.from.token.text).toBe("SOL");
    expect(legs?.to.token.text).toBe("USDC");
    expect(legs?.from.amount).toBeNull();
    expect(legs?.to.amount).toBeNull();
  });
});

describe("resolveToolLegs — execution outcome gates the claim", () => {
  it("marks a proven success as executed", () => {
    expect(resolveToolLegs(SWAP_ARGS, null, true)?.outcome).toBe("executed");
  });

  it("marks a persisted failure as failed", () => {
    expect(resolveToolLegs(SWAP_ARGS, null, false)?.outcome).toBe("failed");
  });

  it.each([
    ["null (legacy / unpaired row)", null],
    ["undefined (never merged a result)", undefined],
  ])("treats UNKNOWN outcome %s as requested, never executed", (_l, success) => {
    expect(resolveToolLegs(SWAP_ARGS, null, success)?.outcome).toBe("requested");
  });
});

describe("resolveToolLegs — untrusted output is trusted only when executed", () => {
  it("prefers the executed OUTPUT's out-amount (what happened) over the args", () => {
    const legs = resolveToolLegs(
      '{"tokenIn":"SOL","tokenOut":"USDC","amountOut":"999.0"}',
      '{"amountOut":"240.31"}',
      true,
    );
    expect(legs?.to.amount).toBe("240.31");
  });

  it.each([
    ["pending / unknown", null],
    ["failed", false],
  ])(
    "IGNORES the output entirely for a %s act — hostile text cannot invent a leg",
    (_label, success) => {
      // Args prove nothing at all; only the output is token-shaped.
      const legs = resolveToolLegs(
        '{"note":"hi"}',
        '{"tokenIn":"SOL","tokenOut":"USDC","amountIn":"9.9"}',
        success,
      );
      expect(legs).toBeNull();
    },
  );

  it("takes the ARGS' tokens for an unproven act even when the output disagrees", () => {
    const legs = resolveToolLegs(
      '{"tokenIn":"SOL","tokenOut":"USDC"}',
      '{"tokenIn":"WBTC","tokenOut":"WBTC","amountOut":"5.0"}',
      null,
    );
    expect(legs?.from.token.text).toBe("SOL");
    expect(legs?.to.token.text).toBe("USDC");
    expect(legs?.to.amount).toBeNull();
  });

  it("skips parsing an OVERSIZED output rather than blocking the renderer", () => {
    const oversized = `{"amountOut":"240.31","pad":"${"x".repeat(21_000)}"}`;
    expect(oversized.length).toBeGreaterThan(20_000);
    const legs = resolveToolLegs(SWAP_ARGS, oversized, true);
    // Args still carry the pair; the unparsed output contributes nothing.
    expect(legs?.from.amount).toBe("1.5");
    expect(legs?.to.amount).toBeNull();
  });
});

describe("resolveToolLegs — shapes and provenance", () => {
  it("reads the execute_tool wrapper's nested params (one level only)", () => {
    const legs = resolveToolLegs(
      '{"toolId":"kyberswap.swap.quote","params":{"tokenIn":"ETH","tokenOut":"USDC","amountIn":"0.25"}}',
      null,
      true,
    );
    expect(legs?.from.token.text).toBe("ETH");
    expect(legs?.to.token.text).toBe("USDC");
    expect(legs?.from.amount).toBe("0.25");
  });

  it("truncates a raw mint through the shared token-display grammar", () => {
    const mint = "So11111111111111111111111111111111111111112";
    const legs = resolveToolLegs(
      `{"inputMint":"${mint}","outputMint":"7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"}`,
      null,
      true,
    );
    // A KNOWN mint is the only path to a brand ticker + mark.
    expect(legs?.from.token.text).toBe("SOL");
    expect(legs?.from.token.iconSymbol).toBe("SOL");
    // An unknown mint gets a truncated address and NO brand mark.
    expect(legs?.to.token.text).toContain("…");
    expect(legs?.to.token.iconSymbol).toBeNull();
  });
});
