/**
 * The card-versus-snapshot plan agreement, WIRED into the real execute gate.
 *
 * `prequote/sealed-plan-agreement.test.ts` proves the two pure halves: the
 * reader that restores the plan a snapshot sealed, and the equality that holds
 * it against the plan the card would state. Both were inert until the gate
 * called them, and an unreachable check refuses nothing. These experiments
 * therefore drive the REAL `evaluatePrequoteGate` over a REAL sealed snapshot
 * and a REAL persisted spendability preview, with only the DB faked, and assert
 * the gate's own decision.
 *
 * The rows that must keep passing are asserted too, because the block is
 * fail-closed: Jupiter seals no snapshot at all, so a Solana row has one
 * artifact and no contradiction, and refusing it would take out the whole
 * Solana execute path.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { SwapPrequote } from "@vex-agent/db/repos/swap-prequotes.js";
import {
  buildBoundDebitPlan,
  canonicalizeDebitPlan,
  type BoundDebitPlan,
} from "@vex-agent/tools/protocols/quote-authority/debit-plan.js";
import {
  ROUTE_SNAPSHOT_VERSION,
  encodeRouteSnapshotRaw,
  sealRouteSnapshot,
} from "@vex-agent/tools/protocols/quote-authority/snapshot.js";
import { SPENDABILITY_CARD_VERSION } from "@vex-agent/tools/protocols/quote-authority/spendability-contract.js";

// ── Mocks: the DB only ────────────────────────────────────────────────────

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
  resolveSelectedAddress: () => "0xwallet",
}));

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js", () => ({
  requireJupiterResolvedToken: async (q: string) => ({ address: q }),
}));

const prequoteModule = await import("@vex-agent/tools/protocols/swap-prequote.js");

// ── Fixtures ──────────────────────────────────────────────────────────────

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const TOKEN_IN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_OUT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EVM_PARAMS = { chain: "base", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1" };
const SOL_PARAMS = { tokenIn: "FooMintCaseSensitiveABC123", tokenOut: SOL_MINT, amountIn: "1" };
const OBSERVED_AT = "2026-09-01T12:00:00.000Z";

const FEE_CAP = {
  mode: "eip1559" as const,
  maxFeePerGasWei: 11_210_000n,
  maxPriorityFeePerGasWei: 1_210_000n,
};

/** What the card would state: reset, approve, swap. */
const CARD_PLAN: BoundDebitPlan = buildBoundDebitPlan({
  legs: [
    { role: "allowance_reset", pricing: "measured" as const },
    { role: "allowance", pricing: "measured" as const },
    { role: "swap", pricing: "measured" as const },
  ],
  feeCap: FEE_CAP,
});

/** One more transaction than the card mentions: the fee transfer. */
const SEALED_PLAN_WITH_FEE_LEG: BoundDebitPlan = buildBoundDebitPlan({
  legs: [
    { role: "allowance_reset", pricing: "measured" as const },
    { role: "allowance", pricing: "measured" as const },
    { role: "swap", pricing: "measured" as const },
    { role: "swap_fee", pricing: "measured" as const },
  ],
  feeCap: FEE_CAP,
});

const ROUTE_SUMMARY = {
  tokenIn: TOKEN_IN,
  amountIn: "12000000000000000",
  tokenOut: TOKEN_OUT,
  amountOut: "21335790672285165158400",
  routeID: "r1",
  checksum: "c1",
  route: [[{ pool: "0xpool", exchange: "orvex-cl", swapAmount: "12000000000000000" }]],
} as const;

/**
 * A KyberSwap `route_ref` sealed through the REAL codec, digest and all, then
 * round-tripped through JSON exactly as the JSONB column does: the gate reads
 * what comes back OUT of the row, never the in-memory object.
 */
function kyberRouteRef(plan: BoundDebitPlan): Record<string, unknown> {
  const encoded = encodeRouteSnapshotRaw(ROUTE_SUMMARY);
  if (!encoded.ok) throw new Error("fixture route must encode");
  const sealed = sealRouteSnapshot({
    v: ROUTE_SNAPSHOT_VERSION,
    provider: "kyberswap",
    raw: encoded.raw,
    approvedAmountOutRaw: ROUTE_SUMMARY.amountOut,
    approvedMinOutRaw: "20269000000000000000000",
    approvedAmountOutHuman: "21335.79",
    approvedMinOutHuman: "20269.0",
    tokenOutSymbol: "CCF",
    effectiveSlippageBps: 50,
    expiresAt: "2099-01-01T00:00:00.000Z",
    eligibility: { kind: "executable", priceImpactFraction: 0.001, adverse: false },
    debitPlan: plan,
  });
  return JSON.parse(JSON.stringify(sealed, bigintToString));
}

/** The persisted spendability preview, carrying the plan the CARD would state. */
function persistedSpendability(plan: BoundDebitPlan | undefined): Record<string, unknown> {
  return {
    cardVersion: SPENDABILITY_CARD_VERSION,
    source: {
      asset: { chainId: 8453, address: TOKEN_IN, symbol: "AAA" },
      wallet: "0xwallet",
      blockTag: "pending",
      observedAt: OBSERVED_AT,
      required: { raw: "1000000", human: "1", decimals: 6, symbol: "AAA" },
      current: { raw: "5000000", human: "5", decimals: 6, symbol: "AAA" },
    },
    native: {
      asset: { chainId: 8453, address: "0xeeee", symbol: "ETH" },
      wallet: "0xwallet",
      blockTag: "pending",
      observedAt: OBSERVED_AT,
      required: { raw: "500000000000000", human: "0.0005", decimals: 18, symbol: "ETH" },
      current: { raw: "1000000000000000000", human: "1", decimals: 18, symbol: "ETH" },
    },
    ...(plan === undefined ? {} : { debitPlan: JSON.parse(JSON.stringify(plan, bigintToString)) }),
  };
}

/** JSONB has no bigint. The recorder's own codec writes atomic strings. */
function bigintToString(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString(10) : value;
}

function ctx(): ProtocolExecutionContext {
  return {
    sessionPermission: "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: SESSION_ID,
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
    slippageBps: 50,
    safetyVerdict: "pass",
    safetyDetail: {},
    routeRef: null,
    eligibilityKind: "executable",
    claimedAt: null,
    claimedBy: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  resetMocks();
});

describe("the execute gate refuses a row whose two plans disagree", () => {
  it("blocks when the sealed plan carries a leg the card never stated", async () => {
    mockFindLatest.mockResolvedValue(row({
      safetyDetail: { spendability: persistedSpendability(CARD_PLAN) },
      routeRef: kyberRouteRef(SEALED_PLAN_WITH_FEE_LEG),
    }));

    const decision = await prequoteModule.evaluatePrequoteGate(
      "kyberswap.swap.execute",
      EVM_PARAMS,
      ctx(),
    );

    expect(decision.kind).toBe("block");
    if (decision.kind !== "block") return;
    // The bounded LOG reason must name this class, not the fail-closed
    // catch-all: an operator reading `gate_error` learns nothing about which
    // of the two descriptions was wrong.
    expect(decision.reason).toBe("card_plan_disagreement");
    // The agent-facing message keeps the helper's detail: both canonical plans.
    expect(decision.message).toContain(canonicalizeDebitPlan(CARD_PLAN));
    expect(decision.message).toContain(canonicalizeDebitPlan(SEALED_PLAN_WITH_FEE_LEG));
  });

  it("allows the same row when the two plans are the same plan", async () => {
    mockFindLatest.mockResolvedValue(row({
      safetyDetail: { spendability: persistedSpendability(CARD_PLAN) },
      routeRef: kyberRouteRef(CARD_PLAN),
    }));

    const decision = await prequoteModule.evaluatePrequoteGate(
      "kyberswap.swap.execute",
      EVM_PARAMS,
      ctx(),
    );

    expect(decision.kind).toBe("allow");
  });
});

describe("a row with only one of the two plans passes through", () => {
  it("allows a Solana row, which seals no route snapshot at all", async () => {
    // Jupiter has no claim lane and records `route_ref: null`. Its card plan is
    // absent too (the Solana preview states two balance legs and no leg set),
    // so there is nothing to contradict. A block here would take out every
    // Solana execute.
    mockFindLatest.mockResolvedValue(row({
      family: "solana",
      provider: "jupiter",
      chainId: null,
      tokenIn: SOL_PARAMS.tokenIn,
      tokenOut: SOL_MINT,
      safetyDetail: { spendability: persistedSpendability(undefined) },
      routeRef: null,
    }));

    const decision = await prequoteModule.evaluatePrequoteGate(
      "solana.swap.execute",
      SOL_PARAMS,
      ctx(),
    );

    expect(decision.kind).toBe("allow");
  });

  it("allows an EVM row that seals a plan but persisted no card plan", async () => {
    mockFindLatest.mockResolvedValue(row({
      safetyDetail: { spendability: persistedSpendability(undefined) },
      routeRef: kyberRouteRef(SEALED_PLAN_WITH_FEE_LEG),
    }));

    const decision = await prequoteModule.evaluatePrequoteGate(
      "kyberswap.swap.execute",
      EVM_PARAMS,
      ctx(),
    );

    expect(decision.kind).toBe("allow");
  });

  it("allows a row whose snapshot seal no longer covers its contents", async () => {
    // A tampered snapshot yields no readable plan, so the comparison has one
    // artifact. The row's OWN authority is refused elsewhere (the restorer at
    // claim/binding time), not turned into a disagreement it is not.
    const sealed = kyberRouteRef(CARD_PLAN);
    mockFindLatest.mockResolvedValue(row({
      safetyDetail: { spendability: persistedSpendability(CARD_PLAN) },
      routeRef: { ...sealed, debitPlan: JSON.parse(JSON.stringify(SEALED_PLAN_WITH_FEE_LEG, bigintToString)) },
    }));

    const decision = await prequoteModule.evaluatePrequoteGate(
      "kyberswap.swap.execute",
      EVM_PARAMS,
      ctx(),
    );

    expect(decision.kind).toBe("allow");
  });
});
