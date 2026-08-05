/**
 * W9d — direction-inapplicable token params are refused BY NAME.
 *
 * `pendle.lp.quote` and `pendle.py.quote` both declare `tokenIn` AND
 * `tokenOut` because each `direction` consumes a different one. The other was
 * SILENTLY IGNORED: a remove quote carrying `tokenIn` quoted an exit to the
 * market's underlying and never said the token the agent named had been
 * discarded. `market.get`'s XOR on the same namespace IS enforced, so the
 * surface enforced the rule in one place and dropped it in another.
 *
 * The mirror defect is the ABSENT param: an add/mint with no `tokenIn` reached
 * `resolveInputToken("")` and surfaced as `Pendle input token "" is not a valid
 * address` — our own missing-parameter refusal reported as a bad address.
 *
 * Both refusals fire BEFORE any provider call, so nothing here needs a network,
 * a wallet or a market: reaching one of those would itself be the regression.
 */

import { describe, expect, it } from "vitest";

import { pendleLpQuote } from "@vex-agent/tools/protocols/pendle/handlers/lp/quote.js";
import { pendlePyQuote } from "@vex-agent/tools/protocols/pendle/handlers/py/quote.js";
import type { ToolResult } from "@vex-agent/tools/types.js";
import { makeProtocolContext } from "../../_test-context.js";

/**
 * A session with NO selected EVM wallet: every refusal asserted here fires at
 * or before wallet resolution, so the quote fails closed without a wallet, a
 * market or a provider call — reaching one of those would itself be the
 * regression this file guards.
 */
const CTX = makeProtocolContext({
  walletResolution: { source: "session", evm: null, solana: null },
});

const MARKET = "0x34280882267ffa6383b363e278b027be083bbe3b";
const PT = "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c";
const TOKEN = "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0";

async function refusal(result: Promise<ToolResult>): Promise<string> {
  const r = await result;
  expect(r.success).toBe(false);
  return r.output;
}

describe("pendle.lp.quote — direction-conditional token params", () => {
  it("refuses `tokenOut` on an ADD by name, naming the direction that would take it", async () => {
    const message = await refusal(
      pendleLpQuote({ chain: "ethereum", direction: "add", market: MARKET, amountIn: "1", tokenIn: TOKEN, tokenOut: TOKEN }, CTX),
    );

    expect(message).toContain("`tokenOut`");
    expect(message).toContain("'add'");
    expect(message).toContain("'remove'");
  });

  it("refuses `tokenIn` on a REMOVE by name", async () => {
    const message = await refusal(
      pendleLpQuote({ chain: "ethereum", direction: "remove", market: MARKET, amountIn: "1", tokenIn: TOKEN }, CTX),
    );

    expect(message).toContain("`tokenIn`");
    expect(message).toContain("'remove'");
  });

  it("names the MISSING `tokenIn` on an ADD instead of reporting an empty address", async () => {
    const message = await refusal(
      pendleLpQuote({ chain: "ethereum", direction: "add", market: MARKET, amountIn: "1" }, CTX),
    );

    expect(message).toContain("Missing `tokenIn`");
    expect(message).not.toContain("is not a valid address");
  });
});

describe("pendle.py.quote — direction-conditional token params", () => {
  it("refuses `tokenOut` on a MINT by name", async () => {
    const message = await refusal(
      pendlePyQuote({ chain: "ethereum", direction: "mint", pt: PT, amountIn: "1", tokenIn: TOKEN, tokenOut: TOKEN }, CTX),
    );

    expect(message).toContain("`tokenOut`");
    expect(message).toContain("'mint'");
    expect(message).toContain("'redeem'");
  });

  it("refuses `tokenIn` on a REDEEM by name", async () => {
    const message = await refusal(
      pendlePyQuote({ chain: "ethereum", direction: "redeem", pt: PT, amountIn: "1", tokenIn: TOKEN }, CTX),
    );

    expect(message).toContain("`tokenIn`");
    expect(message).toContain("'redeem'");
  });

  it("names the MISSING `tokenIn` on a MINT instead of reporting an empty address", async () => {
    const message = await refusal(
      pendlePyQuote({ chain: "ethereum", direction: "mint", pt: PT, amountIn: "1" }, CTX),
    );

    expect(message).toContain("Missing `tokenIn`");
    expect(message).not.toContain("is not a valid address");
  });

  it("leaves the OPTIONAL `tokenOut` on a redeem alone — it defaults to the underlying", async () => {
    // No refusal for the applicable param: the call proceeds past the param
    // gate and fails later, on the provider path this test does not stub.
    const r = await pendlePyQuote({ chain: "ethereum", direction: "redeem", pt: PT, amountIn: "1" }, CTX);
    expect(r.success).toBe(false);
    expect(r.output).not.toContain("does not apply to direction");
  });
});
