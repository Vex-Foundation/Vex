/**
 * The prequote identity and the safety extraction for the Virtuals curve.
 *
 * ## Why this venue needed its own identity branch
 *
 * Every other EVM venue on this gate derives its identity from `tokenIn` and
 * `tokenOut`. A curve has ONE pair and a `side` parameter that decides which way
 * round it is traded, so a generic builder reading `tokenIn`/`tokenOut` would
 * read two EMPTY strings and hash a buy and a sell IDENTICALLY. That is the
 * defect this branch exists to prevent, and the assertion that matters most here
 * is that a buy quote and a sell execute of the same agent do NOT collide.
 *
 * ## Why the recorder and the gate must agree
 *
 * The recorder hashes what the QUOTE ANSWERED (`safety/extract/virtuals.ts`,
 * from `spend.token` / `receive.token`); the gate hashes what the EXECUTE ASKED
 * FOR (`gate/identity.ts`, from `side` + the deployment table). If those two
 * derivations disagree the execute can never match its own quote - so both are
 * driven here and their hashes compared.
 *
 * ## Why the verdict is `unknown`
 *
 * The sibling venues borrow an aggregator's honeypot / fee-on-transfer audit. No
 * such audit exists for a curve agent token, and claiming `pass` for an
 * unaudited token would be worse than saying nothing.
 */

import { describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { definedValue } from "../../../../_test-value-guards.js";

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => WALLET,
}));

const WALLET = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x1984edF491D3399FBc09E6d0856E01fF3721f952";
const SESSION = "00000000-0000-4000-8000-000000000001";

const { computeGateMatch } = await import("@vex-agent/tools/protocols/prequote/gate/identity.js");
const { EXECUTE_GATE_TOOLS, PREQUOTE_QUOTE_TOOLS, PREQUOTE_QUOTE_WRITES } = await import(
  "@vex-agent/tools/protocols/prequote/registry.js"
);
const { computePrequoteMatchHash } = await import("@vex-agent/tools/protocols/prequote/identity/hash.js");
const { extractQuote } = await import("@vex-agent/tools/protocols/prequote/safety/extract.js");
const { virtualsCurveDeployment } = await import("@tools/virtuals/curve/index.js");
const { canonSlippageBps, readParamSlippageBps } = await import(
  "@vex-agent/tools/protocols/prequote/slippage.js"
);

const BASE = definedValue(virtualsCurveDeployment("base"), "the base curve deployment");
const ROBINHOOD = definedValue(virtualsCurveDeployment("robinhood"), "the robinhood curve deployment");

const CONTEXT: ProtocolExecutionContext = {
  sessionPermission: "full",
  approved: true,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
  sessionId: SESSION,
};

function registration(toolId: string) {
  const found = EXECUTE_GATE_TOOLS[toolId];
  if (found === undefined) throw new Error(`${toolId} is not registered on the execute gate`);
  return found;
}

const EXECUTE = registration("virtuals.trade.execute");

function executeParams(over: Record<string, unknown> = {}) {
  return { chain: "base", token: TOKEN, side: "buy", amountIn: "0.5", proposalId: "x", ...over };
}

async function match(over: Record<string, unknown> = {}) {
  return await computeGateMatch(EXECUTE, SESSION, executeParams(over), CONTEXT);
}

/**
 * The swap identity a curve trade SHOULD hash to, written out in full rather
 * than read back from the gate. `provider: "virtuals"` is the venue binding that
 * stops a KyberSwap or Uniswap quote from authorizing this execute; `recipient`
 * is the selected wallet because BondingV5 credits `msg.sender` and the tool
 * exposes no recipient parameter at all.
 */
function expectedHash(o: {
  readonly chainId: number;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amount: string;
  readonly params?: Record<string, unknown>;
}): string {
  return computePrequoteMatchHash({
    kind: "swap",
    sessionId: SESSION,
    family: "eip155",
    provider: "virtuals",
    chainId: o.chainId,
    walletAddress: WALLET,
    tokenIn: o.tokenIn,
    tokenOut: o.tokenOut,
    amount: o.amount,
    recipient: WALLET,
    approveExact: false,
    // Through the SAME canonicaliser the gate uses, over the SAME params. A
    // hand-written "" here would still match today and would stop matching the
    // moment the canonical form of an omitted tolerance changed, which is
    // exactly the drift this expectation exists to catch.
    slippageBps: canonSlippageBps(readParamSlippageBps(o.params ?? executeParams())),
  });
}

describe("the venue is registered on both halves of the gate", () => {
  it("records a `swap` prequote under the virtuals provider - no new kind, no migration", () => {
    expect(PREQUOTE_QUOTE_TOOLS["virtuals.trade.quote"]).toEqual({
      kind: "swap", family: "eip155", provider: "virtuals",
    });
    expect(PREQUOTE_QUOTE_WRITES["virtuals.trade.quote"]).toEqual([{ kind: "swap" }]);
  });

  it("gates the execute against that same provider, so no other venue's quote can authorize it", () => {
    expect(EXECUTE).toEqual({ kind: "swap", family: "eip155", provider: "virtuals" });
  });
});

describe("the curve identity is the fixed pair, oriented by side", () => {
  it("orients a BUY as VIRTUAL in, agent token out", async () => {
    const gate = await match({ side: "buy" });
    expect(gate.family).toBe("eip155");
    expect(gate.matchHash).toBe(
      expectedHash({ chainId: BASE.chainId, tokenIn: BASE.virtual, tokenOut: TOKEN, amount: "0.5" }),
    );
  });

  it("orients a SELL the other way round", async () => {
    const gate = await match({ side: "sell" });
    expect(gate.matchHash).toBe(
      expectedHash({ chainId: BASE.chainId, tokenIn: TOKEN, tokenOut: BASE.virtual, amount: "0.5" }),
    );
  });

  it("HASHES A BUY AND A SELL DIFFERENTLY - the defect this branch exists to prevent", async () => {
    const buy = await match({ side: "buy" });
    const sell = await match({ side: "sell" });
    expect(buy.matchHash).not.toBe(sell.matchHash);
  });

  it("separates the two chains, so a Base quote cannot authorize a Robinhood execute", async () => {
    const base = await match({ chain: "base" });
    const robinhood = await match({ chain: "robinhood" });
    expect(base.matchHash).not.toBe(robinhood.matchHash);
    expect(BASE.chainId).not.toBe(ROBINHOOD.chainId);
  });

  it("separates amounts and tokens", async () => {
    const half = await match({ amountIn: "0.5" });
    expect((await match({ amountIn: "0.6" })).matchHash).not.toBe(half.matchHash);
    expect((await match({ token: "0xa8AbABD1747026E262eFef94e1C9384386964df9" })).matchHash)
      .not.toBe(half.matchHash);
  });

  it("binds the SELECTED wallet as the recipient - a curve credits msg.sender and takes no recipient param", async () => {
    // BondingV5 credits `msg.sender`, so there is nothing a caller could set to
    // redirect the output, and the identity says so by construction.
    const gate = await match();
    expect(gate.matchHash).toBe(
      expectedHash({ chainId: BASE.chainId, tokenIn: BASE.virtual, tokenOut: TOKEN, amount: "0.5" }),
    );
    expect(gate.bridgeRecipient).toBeUndefined();
  });
});

describe("an un-gateable identity fails closed rather than defaulting", () => {
  it("throws on a chain with no curve rather than falling back to a default chain", async () => {
    await expect(match({ chain: "solana" })).rejects.toThrow();
    await expect(match({ chain: "" })).rejects.toThrow();
  });

  it("throws on a missing or malformed token", async () => {
    await expect(match({ token: "CULTOS" })).rejects.toThrow();
    await expect(match({ token: undefined })).rejects.toThrow();
  });

  it("throws on a missing side rather than assuming buy", async () => {
    await expect(match({ side: undefined })).rejects.toThrow();
    await expect(match({ side: "BUY" })).rejects.toThrow();
  });
});

// -- the recorder side ----------------------------------------------------

/** The subset of the quote's answer the extractor reads. */
function quoteAnswer(over: Record<string, unknown> = {}) {
  return {
    chainId: BASE.chainId,
    side: "buy",
    agent: { token: TOKEN },
    spend: { token: BASE.virtual },
    receive: { token: TOKEN },
    floors: { slippageBps: 100 },
    curveTax: {
      protocolTaxPct: 1,
      antiSniper: { type: 0, effectivePct: 0, windowActive: false, appliesToThisSide: false },
    },
    ...over,
  };
}

/**
 * The recorder's row for an answer, or a failed test naming the answer that
 * produced no row. `extractQuote` returns `null` for anything it cannot
 * validate, and a case asserting past that would be asserting nothing.
 */
function extractedRow(answer: Parameters<typeof extractQuote>[2]) {
  return definedValue(
    extractQuote("virtuals.trade.quote", { amountIn: "0.5" }, answer),
    "the extracted prequote row",
  );
}

/**
 * The four identity fields the EXECUTE gate rehashes. Each is optional on the
 * recorded row, and a row missing any of them could not be matched at all, so
 * they are proven here rather than assumed.
 */
function recordedIdentity(row: ReturnType<typeof extractedRow>) {
  return {
    chainId: definedValue(row.chainId, "the recorded chainId"),
    tokenIn: definedValue(row.tokenIn, "the recorded tokenIn"),
    tokenOut: definedValue(row.tokenOut, "the recorded tokenOut"),
    amount: definedValue(row.amount, "the recorded amount"),
  };
}

describe("the recorder extracts the same identity the gate will compute", () => {
  it("is wired to the quote tool id", () => {
    expect(extractQuote("virtuals.trade.quote", { amountIn: "0.5" }, quoteAnswer())).not.toBeNull();
    expect(extractQuote("virtuals.some.other", { amountIn: "0.5" }, quoteAnswer())).toBeNull();
  });

  it("produces a hash the EXECUTE gate reproduces exactly", async () => {
    const extracted = extractedRow(quoteAnswer());
    const recorded = expectedHash(recordedIdentity(extracted));
    expect(recorded).toBe((await match({ side: "buy" })).matchHash);
  });

  it("produces a DIFFERENT hash for a sell answer, matching the sell gate", async () => {
    const sellAnswer = quoteAnswer({ side: "sell", spend: { token: TOKEN }, receive: { token: BASE.virtual } });
    const extracted = extractedRow(sellAnswer);
    const recorded = expectedHash(recordedIdentity(extracted));
    expect(recorded).toBe((await match({ side: "sell" })).matchHash);
    expect(recorded).not.toBe((await match({ side: "buy" })).matchHash);
  });

  it("reports the verdict as UNKNOWN and says why, rather than borrowing a pass", () => {
    const extracted = extractedRow(quoteAnswer());
    expect(extracted.verdict).toBe("unknown");
    const detail = extracted.safetyDetail as Record<string, unknown>;
    expect(detail.venue).toBe("virtuals-curve");
    expect(String(detail.auditNote)).toContain("unknown rather than pass");
  });

  it("records the curve's own tax and the anti-sniper window, which ARE measured", () => {
    const answer = quoteAnswer({
      curveTax: {
        protocolTaxPct: 1,
        antiSniper: { type: 1, effectivePct: 59, windowActive: true, appliesToThisSide: true },
      },
    });
    const detail = extractedRow(answer).safetyDetail as Record<string, unknown>;
    expect(detail).toMatchObject({
      curveProtocolTaxPct: 1,
      antiSniperType: 1,
      antiSniperPct: 59,
      antiSniperWindowActive: true,
      antiSniperAppliesToThisSide: true,
    });
  });

  it("writes NO ROW at all when the answer's shape cannot be validated", () => {
    // Fail closed: a row with invented identity is worse than no row.
    expect(extractQuote("virtuals.trade.quote", { amountIn: "0.5" }, { ...quoteAnswer(), chainId: -1 })).toBeNull();
    expect(extractQuote("virtuals.trade.quote", { amountIn: "0.5" }, {})).toBeNull();
    expect(extractQuote("virtuals.trade.quote", {}, quoteAnswer())).toBeNull();
    expect(extractQuote("virtuals.trade.quote", { amountIn: "  " }, quoteAnswer())).toBeNull();
  });

  it("echoes the slippage the quote actually applied, so the gate binds the same bound", () => {
    const extracted = extractedRow(quoteAnswer({ floors: { slippageBps: 250 } }));
    expect(extracted.slippageBps).toBe(250);
  });
});

describe("the addresses the two sides derive are the same addresses", () => {
  it("uses the deployment table's VIRTUAL on both sides, not a params-supplied one", () => {
    const extracted = extractedRow(quoteAnswer());
    expect(getAddress(definedValue(extracted.tokenIn, "the extracted tokenIn"))).toBe(getAddress(BASE.virtual));
  });
});
