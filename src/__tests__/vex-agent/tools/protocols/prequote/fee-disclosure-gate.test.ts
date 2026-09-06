/**
 * The gate half of the fee channel: what a row without a fee statement
 * authorizes, what the row-disclosure digest covers, and what the executor's
 * own re-read gets back.
 *
 * THE DEFECT THIS CLOSES. A fee-bearing execute used to reach a person's
 * approval card with a fee number the card had recomputed from its arguments,
 * while the executor decided the real disposition afterwards. Once the fee is a
 * statement ON THE QUOTE, a row that carries no statement is an authority that
 * says nothing about the money Vex takes, and the only safe answer is to refuse
 * it. Every experiment here drives the REAL gate; only the DB is faked, because
 * it is the external boundary and not the subject.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { SwapPrequote } from "@vex-agent/db/repos/swap-prequotes.js";
import { rowVexFee } from "./vex-fee-fixtures.js";

type FindMock = Mock<(s: string, h: string, k: string) => Promise<SwapPrequote | null>>;
type ExistsMock = Mock<(s: string, h: string, k: string) => Promise<boolean>>;

let mockFindLatest: FindMock;
let mockExistsFail: ExistsMock;

function resetMocks() {
  mockFindLatest = vi
    .fn<(s: string, h: string, k: string) => Promise<SwapPrequote | null>>()
    .mockResolvedValue(null);
  mockExistsFail = vi
    .fn<(s: string, h: string, k: string) => Promise<boolean>>()
    .mockResolvedValue(false);
}
resetMocks();

vi.mock("@vex-agent/db/repos/swap-prequotes.js", () => ({
  create: async () => undefined,
  findLatestFreshByMatch: (s: string, h: string, k: string) => mockFindLatest(s, h, k),
  existsFreshFailByMatch: (s: string, h: string, k: string) => mockExistsFail(s, h, k),
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: (_r: unknown, _p: unknown, family: unknown) =>
    family === "solana" ? "SoLDestWa11et" : "0xwallet",
}));

vi.mock("@tools/khalani/chains.js", () => ({
  getCachedKhalaniChains: async () => [],
  resolveChainId: (input: string) => (input.toLowerCase() === "solana" ? 20011000000 : 8453),
  getChainFamily: (chainId: number) => (chainId === 20011000000 ? "solana" : "eip155"),
}));

const gate = await import("@vex-agent/tools/protocols/swap-prequote.js");
const { digestPrequoteDisclosure } = await import(
  "@vex-agent/tools/protocols/prequote/approved-row-authority.js"
);

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const TOKEN_IN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_OUT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SWAP_PARAMS = { chain: "base", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1" };
const BRIDGE_PARAMS = {
  fromChain: "base",
  fromToken: TOKEN_IN,
  toChain: "solana",
  toToken: "DestMintCaseSensitiveABC123",
  amountRaw: "1000000",
};
const PENDLE_PARAMS = {
  chain: "base",
  market: "0xcccccccccccccccccccccccccccccccccccccccc",
  tokenIn: TOKEN_IN,
  amountIn: "1",
};

function ctx(overrides: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: SESSION_ID,
    ...overrides,
  };
}

function row(overrides: Partial<SwapPrequote> = {}): SwapPrequote {
  return {
    prequoteId: "prequote-row-1",
    sessionId: SESSION_ID,
    matchHash: "h".repeat(64),
    kind: "swap",
    family: "eip155",
    provider: "kyberswap",
    chainId: 8453,
    walletAddress: "0xwallet",
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amount: "1",
    slippageBps: null,
    safetyVerdict: "pass",
    safetyDetail: { vexFee: rowVexFee({ collection: "inside_route" }) },
    routeRef: null,
    eligibilityKind: "executable",
    claimedAt: null,
    claimedBy: null,
    createdAt: "2026-09-04T10:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  resetMocks();
});

describe("a fee-bearing execute whose matched row states no fee", () => {
  it("is BLOCKED, and the agent is told to quote again", async () => {
    mockFindLatest.mockResolvedValue(row({ safetyDetail: {} }));
    const decision = await gate.evaluatePrequoteGate("kyberswap.swap.execute", SWAP_PARAMS, ctx());
    expect(decision.kind).toBe("block");
    if (decision.kind !== "block") return;
    expect(decision.reason).toBe("fee_disclosure_missing");
    expect(decision.message).toContain("no Vex fee statement");
    expect(decision.message).toContain("Nothing was signed");
    // The way out is named, and it is not a retry of the same execute.
    expect(decision.message).toMatch(/quote/i);
    // Bounded structural message only: no row contents reach the agent.
    expect(decision.message).not.toContain(TOKEN_IN);
    expect(decision.message).not.toContain("prequote-row-1");
  });

  it("is BLOCKED when the persisted block is present but no longer parses", async () => {
    // A block edited in the store, or written by a build whose schema differs,
    // reads as ABSENT rather than as partially believable.
    mockFindLatest.mockResolvedValue(
      row({ safetyDetail: { vexFee: { ...rowVexFee(), feeAmountRaw: "not-a-number" } } }),
    );
    const decision = await gate.evaluatePrequoteGate("kyberswap.swap.execute", SWAP_PARAMS, ctx());
    expect(decision.kind === "block" && decision.reason).toBe("fee_disclosure_missing");
  });

  it("is BLOCKED on the bridge lane too, with the bridge's own wording", async () => {
    mockFindLatest.mockResolvedValue(
      row({ kind: "bridge", provider: "khalani", safetyDetail: { bridge: true } }),
    );
    const decision = await gate.evaluatePrequoteGate("khalani.bridge", BRIDGE_PARAMS, ctx());
    expect(decision.kind).toBe("block");
    if (decision.kind !== "block") return;
    expect(decision.reason).toBe("fee_disclosure_missing");
    expect(decision.message).toContain("Bridge blocked");
  });

  it("ALLOWS the same execute once the row carries the statement", async () => {
    mockFindLatest.mockResolvedValue(row());
    const decision = await gate.evaluatePrequoteGate("kyberswap.swap.execute", SWAP_PARAMS, ctx());
    expect(decision.kind).toBe("allow");
    if (decision.kind !== "allow") return;
    expect(decision.vexFee).toEqual(rowVexFee({ collection: "inside_route" }));
  });
});

describe("a venue that carries no Vex fee at all", () => {
  it("is NOT blocked for want of a fee statement (Pendle)", async () => {
    // Pendle charges no Vex fee, so demanding one would refuse every PT buy.
    mockFindLatest.mockResolvedValue(
      row({ kind: "swap", provider: "pendle", safetyDetail: {}, tokenOut: TOKEN_OUT }),
    );
    const decision = await gate.evaluatePrequoteGate("pendle.pt.buy", PENDLE_PARAMS, ctx());
    expect(decision.kind === "block" && decision.reason).not.toBe("fee_disclosure_missing");
  });
});

describe("the row-disclosure digest covers the fee statement", () => {
  it("changes when the fee statement changes", async () => {
    const base = { verdict: "pass", vexFee: rowVexFee() };
    const cheaper = { verdict: "pass", vexFee: rowVexFee({ feeAmountRaw: "2400", netAmountRaw: "997600" }) };
    const elsewhere = { verdict: "pass", vexFee: rowVexFee({ receiver: "0xattacker" }) };
    expect(digestPrequoteDisclosure(base)).not.toBe(digestPrequoteDisclosure(cheaper));
    expect(digestPrequoteDisclosure(base)).not.toBe(digestPrequoteDisclosure(elsewhere));
  });

  it("is stable across the fields the projection deliberately drops", async () => {
    // The venue's USD estimate and prose note never enter the block, so a
    // change in either cannot invalidate an approval a person already decided.
    const withEstimate = { ...rowVexFee(), feeUsdEstimate: undefined, note: undefined };
    expect(digestPrequoteDisclosure({ verdict: "pass", vexFee: withEstimate })).toBe(
      digestPrequoteDisclosure({ verdict: "pass", vexFee: rowVexFee() }),
    );
  });

  it("refuses an approval resume whose row's fee statement moved", async () => {
    const approvedDisclosure = digestPrequoteDisclosure({ verdict: "pass", vexFee: rowVexFee({ collection: "inside_route" }) });
    mockFindLatest.mockResolvedValue(
      row({ safetyDetail: { vexFee: rowVexFee({ collection: "inside_route", receiver: "0xattacker" }) } }),
    );
    const decision = await gate.evaluatePrequoteGate("kyberswap.swap.execute", SWAP_PARAMS, ctx({
      approvalId: "approval-1",
      approvedPrequoteAuthority: {
        v: "prequote-authority-v1",
        prequoteId: "prequote-row-1",
        disclosureDigest: approvedDisclosure,
      },
    }));
    expect(decision.kind === "block" && decision.reason).toBe("approved_disclosure_changed");
  });
});

describe("findFreshMatchedPrequote", () => {
  it("returns the parsed statement for a BRIDGE row, not only for a swap", async () => {
    // Round 2's bridge executors re-derive their fee leg and hold it to this
    // block; before this lane the reader refused every non-swap kind outright.
    mockFindLatest.mockResolvedValue(
      row({ kind: "bridge", provider: "khalani", safetyDetail: { bridge: true, vexFee: rowVexFee() } }),
    );
    const matched = await gate.findFreshMatchedPrequote(
      "khalani.bridge",
      SESSION_ID,
      BRIDGE_PARAMS,
      ctx(),
    );
    expect(matched.ok).toBe(true);
    if (!matched.ok) return;
    expect(matched.vexFee).toEqual(rowVexFee());
  });

  it("returns the statement for a swap row as well", async () => {
    mockFindLatest.mockResolvedValue(row());
    const matched = await gate.findFreshMatchedPrequote(
      "kyberswap.swap.execute",
      SESSION_ID,
      SWAP_PARAMS,
      ctx(),
    );
    expect(matched.ok && matched.vexFee).toEqual(rowVexFee({ collection: "inside_route" }));
  });

  it("still refuses a tool that is not a gated execute at all", async () => {
    const matched = await gate.findFreshMatchedPrequote(
      "kyberswap.swap.quote",
      SESSION_ID,
      SWAP_PARAMS,
      ctx(),
    );
    expect(matched).toEqual({ ok: false, reason: "not_gated" });
  });
});
