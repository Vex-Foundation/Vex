/**
 * SWAP/BRIDGE LEG PARSING — money-path honesty (rules/90).
 *
 * Four laws are pinned here. FAIL CLOSED: truncated, malformed, or
 * half-present payloads produce NO legs, because an arrow pointing at nothing
 * reads as a completed leg that never happened. NEVER GUESS AN AMOUNT: a raw
 * base-unit integer carries no decimals to read it by, so it renders no number
 * at all rather than a possible thousandfold error. OUTCOME IS PART OF THE
 * CLAIM: an `executed` pair needs BOTH a persisted `success === true` AND a
 * proven MUTATING operation (a successful quote is a preview, not a trade),
 * and only a succeeded pair may read the untrusted OUTPUT. BOUNDED PARSING: an
 * oversized output is never handed to `JSON.parse` at all.
 */

import { describe, expect, it } from "vitest";
import { resolveToolLegs, resolveToolSingleLeg } from "../ToolLedger/toolLegs.js";
import type { ToolOperation } from "../ToolLedger/toolOperation.js";

/**
 * Thin call-through. The operation identity (quote vs execution) is its own
 * axis, pinned in its own describe below; every case that is not ABOUT it
 * reads a proven MUTATING act — the only kind that may claim "executed".
 */
function legsFor(
  toolArgs: string | null,
  output: string | null,
  success: boolean | null | undefined,
  operation: ToolOperation = "mutating",
) {
  return resolveToolLegs(toolArgs, output, success, operation);
}

const SWAP_ARGS = '{"tokenIn":"SOL","tokenOut":"USDC","amountIn":"1.5"}';

describe("resolveToolLegs - fail-closed parsing", () => {
  it.each([
    ["null args and output", null, null],
    ["truncated JSON", '{"tokenIn":"SOL","tokenOut":"USD', null],
    ["not JSON at all", "tokenIn=SOL", null],
    ["a JSON array", '["SOL","USDC"]', null],
    ["only ONE side present", '{"tokenIn":"SOL"}', null],
    ["non-string tokens", '{"tokenIn":1,"tokenOut":2}', null],
  ])("returns null for %s", (_label, args, output) => {
    expect(legsFor(args, output, true)).toBeNull();
  });
});

describe("resolveToolLegs - amounts are never invented", () => {
  it("renders a dotted-decimal human amount", () => {
    const legs = legsFor(SWAP_ARGS, '{"amountOut":"240.31"}', true);
    expect(legs?.from.amount).toBe("1.5");
    expect(legs?.to.amount).toBe("240.31");
  });

  it("renders NO amount for a raw base-unit integer (no decimals to read it by)", () => {
    const legs = legsFor(
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
    const legs = legsFor(
      '{"tokenIn":"SOL","tokenOut":"USDC","amountIn":"1.5garbage"}',
      '{"amountOut":"240.31<script>"}',
      true,
    );
    expect(legs?.from.amount).toBeNull();
    expect(legs?.to.amount).toBeNull();
  });

  it("still names both tokens when neither amount can be proven", () => {
    const legs = legsFor('{"tokenIn":"SOL","tokenOut":"USDC"}', null, true);
    expect(legs?.from.token.text).toBe("SOL");
    expect(legs?.to.token.text).toBe("USDC");
    expect(legs?.from.amount).toBeNull();
    expect(legs?.to.amount).toBeNull();
  });
});

describe("resolveToolLegs - execution outcome gates the claim", () => {
  it("marks a proven success as executed", () => {
    expect(legsFor(SWAP_ARGS, null, true)?.outcome).toBe("executed");
  });

  it("marks a persisted failure as failed", () => {
    expect(legsFor(SWAP_ARGS, null, false)?.outcome).toBe("failed");
  });

  it.each([
    ["null (legacy / unpaired row)", null],
    ["undefined (never merged a result)", undefined],
  ])("treats UNKNOWN outcome %s as requested, never executed", (_l, success) => {
    expect(legsFor(SWAP_ARGS, null, success)?.outcome).toBe("requested");
  });
});

// An AMBIGUOUS broadcast — the tx went out, the receipt did not come back —
// is persisted `success: false` on purpose (the model must not treat ambiguity
// as success and must abort the remaining legs). Calling that "Failed" in the
// UI is a lie the user can see: the same row's prose says it is pending. The
// engine's `displayStatus` projection splits the display without touching the
// model-facing outcome.
describe("resolveToolLegs - pending is not failed", () => {
  it("marks success:false + displayStatus 'pending' as pending", () => {
    expect(
      resolveToolLegs(SWAP_ARGS, null, false, "mutating", "pending")?.outcome,
    ).toBe("pending");
  });

  it("still marks a plain persisted failure as failed", () => {
    expect(
      resolveToolLegs(SWAP_ARGS, null, false, "mutating", null)?.outcome,
    ).toBe("failed");
  });

  it.each(["quote", "unproven", "mutating"] as const)(
    "reports pending for a %s act too",
    (operation) => {
      expect(
        resolveToolLegs(SWAP_ARGS, null, false, operation, "pending")?.outcome,
      ).toBe("pending");
    },
  );

  it("never upgrades a SUCCEEDED act - pending only ever splits success:false", () => {
    expect(
      resolveToolLegs(SWAP_ARGS, null, true, "mutating", "pending")?.outcome,
    ).toBe("executed");
  });

  it("does NOT let an UNKNOWN outcome become pending", () => {
    expect(
      resolveToolLegs(SWAP_ARGS, null, null, "mutating", "pending")?.outcome,
    ).toBe("requested");
  });

  it("reads the ARGS only - a pending act's untrusted output supplies nothing", () => {
    const legs = resolveToolLegs(
      SWAP_ARGS,
      '{"tokenIn":"ATTACK","tokenOut":"EVIL","amountOut":"240.31"}',
      false,
      "mutating",
      "pending",
    );
    expect(legs?.from.token.text).toBe("SOL");
    expect(legs?.to.token.text).toBe("USDC");
    expect(legs?.to.amount).toBeNull();
  });
});

// `success` means THE CALL succeeded, not that funds moved. A successful
// swap_quote is a preview; only a proven MUTATING operation may claim
// "executed" (rules/90 money-path honesty).
describe("resolveToolLegs - operation identity gates the executed claim", () => {
  it("marks a successful QUOTE as a quote, never executed", () => {
    expect(resolveToolLegs(SWAP_ARGS, null, true, "quote")?.outcome).toBe(
      "quote",
    );
  });

  it("marks a successful UNPROVEN operation as completed, never executed", () => {
    expect(resolveToolLegs(SWAP_ARGS, null, true, "unproven")?.outcome).toBe(
      "completed",
    );
  });

  it.each(["quote", "unproven"] as const)(
    "still reports a %s act's persisted failure as failed",
    (operation) => {
      expect(resolveToolLegs(SWAP_ARGS, null, false, operation)?.outcome).toBe(
        "failed",
      );
    },
  );

  it.each(["quote", "unproven"] as const)(
    "still reports a %s act's UNKNOWN outcome as requested",
    (operation) => {
      expect(resolveToolLegs(SWAP_ARGS, null, null, operation)?.outcome).toBe(
        "requested",
      );
    },
  );

  it("lets a successful quote read its own output numbers", () => {
    const legs = resolveToolLegs(
      SWAP_ARGS,
      '{"amountOut":"240.31"}',
      true,
      "quote",
    );
    expect(legs?.to.amount).toBe("240.31");
  });
});

describe("resolveToolLegs - untrusted output is trusted only when executed", () => {
  it("prefers the executed OUTPUT's out-amount (what happened) over the args", () => {
    const legs = legsFor(
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
    "IGNORES the output entirely for a %s act - hostile text cannot invent a leg",
    (_label, success) => {
      // Args prove nothing at all; only the output is token-shaped.
      const legs = legsFor(
        '{"note":"hi"}',
        '{"tokenIn":"SOL","tokenOut":"USDC","amountIn":"9.9"}',
        success,
      );
      expect(legs).toBeNull();
    },
  );

  it("takes the ARGS' tokens for an unproven act even when the output disagrees", () => {
    const legs = legsFor(
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
    const legs = legsFor(SWAP_ARGS, oversized, true);
    // Args still carry the pair; the unparsed output contributes nothing.
    expect(legs?.from.amount).toBe("1.5");
    expect(legs?.to.amount).toBeNull();
  });
});

describe("resolveToolLegs - shapes and provenance", () => {
  it("reads the execute_tool wrapper's nested params (one level only)", () => {
    const legs = legsFor(
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
    const legs = legsFor(
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

/**
 * MORPHO VAULT - the two-sided case, and the live defect this pins closed. A
 * vault supply moves an asset OUT of the wallet and vault SHARES back in, so it
 * really is a pair, and the handler now emits the same `tokenIn`/`tokenOut` +
 * `amountIn`/`amountOut` root keys the swap reader already knows. Before those
 * keys existed the payload named only a vault address and a raw amount, and a
 * settled deposit rendered NO leg line at all.
 */
describe("resolveToolLegs - Morpho vault execute output", () => {
  const DEPOSIT_ARGS =
    '{"vaultAddress":"0xbeef0e0834849acc03f0089f01f4f1eeb06873c9","chain":"base","depositAmountRaw":"200000"}';
  const DEPOSIT_OUTPUT =
    '{"toolId":"morpho.vault.deposit","status":"confirmed","tokenIn":"USDC","amountIn":"0.2","tokenOut":"steakUSDC","amountOut":"0.192836490590443813","summary":"Deposited 0.2 USDC and received 0.192836490590443813 steakUSDC."}';

  it("renders the settled deposit as a pair, with NO change to the reader", () => {
    const legs = legsFor(DEPOSIT_ARGS, DEPOSIT_OUTPUT, true);
    expect(legs?.outcome).toBe("executed");
    expect(legs?.from.token.text).toBe("USDC");
    expect(legs?.from.amount).toBe("0.2");
    expect(legs?.to.token.text).toBe("STEAKUSDC");
    expect(legs?.to.amount).toBe("0.192836");
  });

  it("falls back to the lower-case ADDRESS form when a symbol is unknown", () => {
    const legs = legsFor(
      DEPOSIT_ARGS,
      '{"tokenIn":"0xbeef0e0834849acc03f0089f01f4f1eeb06873c9","tokenOut":"0xdead0e0834849acc03f0089f01f4f1eeb06873c9"}',
      true,
    );
    // An address is truncated by the shared grammar and NEVER wears a brand.
    expect(legs?.from.token.text).toContain("…");
    expect(legs?.from.token.iconSymbol).toBeNull();
  });

  it("shows NO legs for the same deposit while it is unproven - args carry no tokens", () => {
    expect(legsFor(DEPOSIT_ARGS, DEPOSIT_OUTPUT, null)).toBeNull();
    expect(legsFor(DEPOSIT_ARGS, DEPOSIT_OUTPUT, false)).toBeNull();
  });
});

/**
 * MORPHO BLUE MARKET - the one-sided case. A market operation moves exactly one
 * token in one direction, so the pair reader must decline it and the single-leg
 * reader must report the direction it actually had. A mirror leg invented to
 * make the row look like a swap would claim a movement that never happened.
 */
describe("resolveToolSingleLeg - one token, one direction", () => {
  const MARKET_ARGS = '{"marketId":"0xfeed","chain":"base"}';
  const SENT_OUTPUT =
    '{"toolId":"morpho.market.supplyCollateral","status":"confirmed","tokenIn":"WETH","amountIn":"0.05"}';
  const RECEIVED_OUTPUT =
    '{"toolId":"morpho.market.borrow","status":"confirmed","tokenOut":"USDC","amountOut":"120.5"}';

  function singleFor(
    toolArgs: string | null,
    output: string | null,
    success: boolean | null | undefined,
    operation: ToolOperation = "mutating",
  ) {
    return resolveToolSingleLeg(toolArgs, output, success, operation);
  }

  it("reads a SENT leg from the from-side keys alone", () => {
    const single = singleFor(MARKET_ARGS, SENT_OUTPUT, true);
    expect(single?.direction).toBe("sent");
    expect(single?.outcome).toBe("executed");
    expect(single?.leg.token.text).toBe("WETH");
    expect(single?.leg.amount).toBe("0.05");
  });

  it("reads a RECEIVED leg from the to-side keys alone", () => {
    const single = singleFor(MARKET_ARGS, RECEIVED_OUTPUT, true);
    expect(single?.direction).toBe("received");
    expect(single?.leg.token.text).toBe("USDC");
    expect(single?.leg.amount).toBe("120.5");
  });

  it("declines a payload that has BOTH sides - that is a pair, not a single leg", () => {
    expect(
      singleFor(MARKET_ARGS, '{"tokenIn":"USDC","tokenOut":"steakUSDC"}', true),
    ).toBeNull();
    // ... and the PAIR reader is the one that reports it.
    expect(
      resolveToolLegs(MARKET_ARGS, '{"tokenIn":"USDC","tokenOut":"steakUSDC"}', true, "mutating")
        ?.to.token.text,
    ).toBe("STEAKUSDC");
  });

  it.each([
    ["neither side present", '{"marketId":"0xfeed"}'],
    ["a non-string token", '{"tokenIn":42}'],
    ["truncated JSON", '{"tokenIn":"WET'],
    ["not JSON at all", "tokenIn=WETH"],
  ])("fails closed to null for %s", (_label, output) => {
    expect(singleFor(MARKET_ARGS, output, true)).toBeNull();
  });

  it("never parses an OVERSIZED output", () => {
    const oversized = `{"tokenIn":"WETH","amountIn":"0.05","pad":"${"x".repeat(21_000)}"}`;
    expect(oversized.length).toBeGreaterThan(20_000);
    expect(singleFor(MARKET_ARGS, oversized, true)).toBeNull();
  });

  it("IGNORES the output for an unproven or failed act - hostile text invents nothing", () => {
    expect(singleFor(MARKET_ARGS, SENT_OUTPUT, null)).toBeNull();
    expect(singleFor(MARKET_ARGS, SENT_OUTPUT, false)).toBeNull();
  });

  it("carries the same outcome ladder a pair does", () => {
    expect(singleFor(MARKET_ARGS, SENT_OUTPUT, true, "quote")?.outcome).toBe("quote");
    expect(singleFor(MARKET_ARGS, SENT_OUTPUT, true, "unproven")?.outcome).toBe(
      "completed",
    );
    expect(
      resolveToolSingleLeg('{"tokenIn":"WETH"}', null, false, "mutating", "pending")
        ?.outcome,
    ).toBe("pending");
    expect(
      resolveToolSingleLeg('{"tokenIn":"WETH"}', null, false, "mutating", null)?.outcome,
    ).toBe("failed");
  });

  it("prints NO amount for a raw base-unit integer", () => {
    const single = singleFor(
      MARKET_ARGS,
      '{"tokenIn":"WETH","amountIn":"50000000000000000"}',
      true,
    );
    expect(single?.leg.token.text).toBe("WETH");
    expect(single?.leg.amount).toBeNull();
  });
});
