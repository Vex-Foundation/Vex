/**
 * The parameter boundary of the two curve trade tools.
 *
 * Everything here happens BEFORE a chain read, a session lookup or a key, and
 * that ordering is the point: a caller whose fee override is present, whose
 * tolerance is out of range, or whose chain has no curve must learn it from a
 * sentence, and no such call may reach a durable row or a signing path.
 */

import { describe, expect, it } from "vitest";

import {
  checkForbiddenTradeParams,
  parseTradeAmount,
  readTradeParams,
  resolveTradeChain,
} from "@vex-agent/tools/protocols/virtuals/handlers/trade/params.js";
import { VEX_MAX_SLIPPAGE_BPS, VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

const TOKEN = "0x1984edF491D3399FBc09E6d0856E01fF3721f952";
const TOOL = "virtuals.trade.quote";

function baseParams(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { chain: "base", token: TOKEN, side: "buy", amountIn: "0.5", ...extra };
}

describe("checkForbiddenTradeParams", () => {
  for (const key of ["fee", "feeBps", "feeReceiver", "feeRecipient", "feeAmount", "vexFee", "vexFeeBps", "vexFeeReceiver"]) {
    it(`rejects "${key}" BY NAME rather than dropping it`, () => {
      const reason = checkForbiddenTradeParams({ [key]: "anything" });
      expect(reason).not.toBeNull();
      expect(reason).toContain(`"${key}"`);
      expect(reason).toMatch(/fixed product constants/);
    });
  }

  it("treats PRESENCE as the violation, whatever the key carries", () => {
    // An empty string, a null or an explicit undefined is still an attempted
    // override, and a silent drop would hide it.
    expect(checkForbiddenTradeParams({ feeBps: undefined })).not.toBeNull();
    expect(checkForbiddenTradeParams({ feeReceiver: null })).not.toBeNull();
    expect(checkForbiddenTradeParams({ fee: "" })).not.toBeNull();
  });

  it("passes a clean parameter set", () => {
    expect(checkForbiddenTradeParams(baseParams())).toBeNull();
  });

  it("is enforced on the tool boundary, not only as a helper", () => {
    const read = readTradeParams(baseParams({ feeBps: 0 }), TOOL);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain('"feeBps"');
  });
});

describe("resolveTradeChain - the typed hand-offs", () => {
  it("resolves the two chains Vex signs curve trades on", () => {
    expect(resolveTradeChain("base")).toMatchObject({ kind: "curve" });
    expect(resolveTradeChain("robinhood")).toMatchObject({ kind: "curve" });
    // Numeric ids and the provider's own uppercase spelling resolve too.
    expect(resolveTradeChain("8453")).toMatchObject({ kind: "curve" });
    expect(resolveTradeChain("ROBINHOOD")).toMatchObject({ kind: "curve" });
  });

  it("hands Solana to the Jupiter tools and says why", () => {
    const solana = resolveTradeChain("solana");
    expect(solana.kind).toBe("handoff");
    if (solana.kind === "handoff") {
      expect(solana.useInstead).toContain("solana__swap");
      // The reason must name the REAL mechanism, or an agent will keep looking
      // for a Virtuals-specific Solana path that does not exist.
      expect(solana.reason).toMatch(/Meteora/);
      expect(solana.reason).toMatch(/Jupiter/);
    }
  });

  it("says Ethereum has no curve at all, and names nothing that could trade one", () => {
    const eth = resolveTradeChain("ethereum");
    expect(eth.kind).toBe("handoff");
    if (eth.kind === "handoff") {
      expect(eth.useInstead).toBeNull();
      expect(eth.reason).toMatch(/no bonding curve on Ethereum/);
    }
  });

  it("refuses a chain Virtuals does not index, with the legal set", () => {
    const bad = resolveTradeChain("arbitrum");
    expect(bad.kind).toBe("invalid");
    if (bad.kind === "invalid") expect(bad.reason).toContain("base");
  });

  it("surfaces the hand-off through the tool boundary as a refusal that names the tool", () => {
    const read = readTradeParams(baseParams({ chain: "solana" }), TOOL);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.handoff?.useInstead).toContain("solana__swap");
  });
});

describe("readTradeParams", () => {
  it("requires the four load-bearing parameters", () => {
    for (const key of ["chain", "token", "side", "amountIn"]) {
      const params = baseParams();
      delete params[key];
      const read = readTradeParams(params, TOOL);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.reason).toMatch(/Missing required/);
    }
  });

  it("refuses a token that is not a contract address, and says where to find one", () => {
    const read = readTradeParams(baseParams({ token: "CULTOS" }), TOOL);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toMatch(/preToken/);
  });

  it("refuses a side that is not buy or sell", () => {
    const read = readTradeParams(baseParams({ side: "long" }), TOOL);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain('"side"');
  });

  it("defaults the slippage to the ONE product default when omitted", () => {
    const read = readTradeParams(baseParams(), TOOL);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.params.slippageBps).toBe(VEX_DEFAULT_SLIPPAGE_BPS);
  });

  it("REFUSES a tolerance above Vex's cap rather than clamping it", () => {
    // Silently lowering a price-protection parameter hides the caller's mistake
    // exactly where it costs money; silently raising one is unthinkable.
    const read = readTradeParams(baseParams({ slippageBps: VEX_MAX_SLIPPAGE_BPS + 1 }), TOOL);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain(String(VEX_MAX_SLIPPAGE_BPS));
  });

  it("accepts the cap itself", () => {
    const read = readTradeParams(baseParams({ slippageBps: VEX_MAX_SLIPPAGE_BPS }), TOOL);
    expect(read.ok).toBe(true);
  });

  describe("acceptAntiSniperTaxPct - consent to a bound", () => {
    it("defaults to null, which REFUSES any active window", () => {
      const read = readTradeParams(baseParams(), TOOL);
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.params.acceptAntiSniperTaxPct).toBeNull();
    });

    it("accepts a whole percent inside 1..98", () => {
      for (const value of [1, 40, 98]) {
        const read = readTradeParams(baseParams({ acceptAntiSniperTaxPct: value }), TOOL);
        expect(read.ok).toBe(true);
        if (read.ok) expect(read.params.acceptAntiSniperTaxPct).toBe(value);
      }
    });

    it("refuses 0 and 99, and says that omitting it is how you refuse the window", () => {
      // 0 is refused because omitting the parameter already means that, and 99
      // is a bound the router's clamp can never reach beside a non-zero
      // protocol tax - it would read as "accept anything".
      for (const value of [0, 99, 100, -1]) {
        const read = readTradeParams(baseParams({ acceptAntiSniperTaxPct: value }), TOOL);
        expect(read.ok).toBe(false);
        if (!read.ok) expect(read.reason).toMatch(/between 1 and 98/);
      }
    });

    it("refuses a fractional or non-numeric bound", () => {
      for (const value of [1.5, "40", true]) {
        const read = readTradeParams(baseParams({ acceptAntiSniperTaxPct: value }), TOOL);
        expect(read.ok).toBe(false);
      }
    });
  });

  it("carries simulateOnly through only when it is literally true", () => {
    expect(readTradeParams(baseParams({ simulateOnly: true }), TOOL)).toMatchObject({
      ok: true,
      params: { simulateOnly: true },
    });
    expect(readTradeParams(baseParams({ simulateOnly: "true" }), TOOL)).toMatchObject({
      ok: true,
      params: { simulateOnly: false },
    });
  });
});

describe("parseTradeAmount - the one place a decimal becomes atomic units", () => {
  const partial = (() => {
    const read = readTradeParams(baseParams({ amountIn: "0.5" }), TOOL);
    if (!read.ok) throw new Error("fixture params must parse");
    return read.params;
  })();

  it("parses at the token's own decimals, exactly", () => {
    const parsed = parseTradeAmount(partial, 18);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.params.amountInRaw).toBe(500_000_000_000_000_000n);
  });

  it("refuses more decimal places than the token supports rather than truncating", () => {
    const tooPrecise = { ...partial, amountInHuman: "0.0000001" };
    const parsed = parseTradeAmount(tooPrecise, 6);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/decimal places/);
  });

  it("refuses anything that is not a plain decimal - no scientific notation, no sign", () => {
    for (const amount of ["1e18", "-1", "0x10", "", " ", "1,5"]) {
      const parsed = parseTradeAmount({ ...partial, amountInHuman: amount }, 18);
      expect(parsed.ok).toBe(false);
    }
  });

  it("refuses a zero amount", () => {
    const parsed = parseTradeAmount({ ...partial, amountInHuman: "0" }, 18);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/greater than zero/);
  });
});
