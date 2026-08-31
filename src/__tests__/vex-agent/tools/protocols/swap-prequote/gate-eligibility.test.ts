/**
 * The COMMON execute gate must reject a quote that authorized nothing (WP2-S),
 * and must carry the quote-time spendability facts to the approval card.
 *
 * THE DEFECT THIS PINS. `eligibility_kind` was a predicate in exactly one
 * place: the atomic CLAIM (migration 095). The claim lane exists only for the
 * venues that record a route snapshot, so an ineligible row blocked a KyberSwap
 * or Uniswap execute at claim time and blocked NOTHING for Jupiter, which has
 * no claim lane at all. The gate itself never read the column - grep found zero
 * references. So the newest quote for a Solana identity could say "the wallet
 * cannot pay for this" and the execute would still run.
 *
 * The experiments below therefore drive the REAL gate over the REAL recorder's
 * own output; only the DB is faked, because it is the external boundary and not
 * the subject. The second half follows one executable quote all the way to the
 * rendered approval card, which is the surface a person actually consents from.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { getProtocolManifest } from "@vex-agent/tools/protocols/catalog.js";
import type {
  CreatePrequoteInput,
  PrequoteEligibilityKind,
  SwapPrequote,
} from "@vex-agent/db/repos/swap-prequotes.js";
import type { ToolResult } from "@vex-agent/tools/types.js";
import { SPENDABILITY_CARD_VERSION } from "@vex-agent/tools/protocols/quote-authority/spendability-contract.js";

// ── Mocks: the DB only ────────────────────────────────────────────────────

type CreateMock = Mock<(input: CreatePrequoteInput) => Promise<void>>;
type FindMock = Mock<(s: string, h: string, k: string) => Promise<SwapPrequote | null>>;
type ExistsMock = Mock<(s: string, h: string, k: string) => Promise<boolean>>;

let mockCreate: CreateMock;
let mockFindLatest: FindMock;
let mockExistsFail: ExistsMock;

function resetMocks() {
  mockCreate = vi.fn<(input: CreatePrequoteInput) => Promise<void>>().mockResolvedValue(undefined);
  mockFindLatest = vi
    .fn<(s: string, h: string, k: string) => Promise<SwapPrequote | null>>()
    .mockResolvedValue(null);
  mockExistsFail = vi
    .fn<(s: string, h: string, k: string) => Promise<boolean>>()
    .mockResolvedValue(false);
}
resetMocks();

vi.mock("@vex-agent/db/repos/swap-prequotes.js", () => ({
  create: (input: CreatePrequoteInput) => mockCreate(input),
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
const { evaluateApprovalGate } = await import("@vex-agent/tools/protocols/runtime/gates.js");
const { buildApprovalIntentPreview } = await import(
  "@vex-agent/engine/core/approval-runtime/enqueue.js"
);

// ── Fixtures ──────────────────────────────────────────────────────────────

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const TOKEN_IN = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_OUT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EVM_PARAMS = { chain: "base", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "1" };
const SOLANA_MINT = "FooMintCaseSensitiveABC123";
const SOL_PARAMS = { tokenIn: SOLANA_MINT, tokenOut: SOL_MINT, amountIn: "1" };

const OBSERVED_AT = "2026-08-31T12:00:00.000Z";

/** The handoff a venue will produce once WP2-E0/K/U/J read the chain. */
const SPENDABILITY_HANDOFF = {
  cardVersion: SPENDABILITY_CARD_VERSION,
  source: {
    asset: { chainId: 8453, address: TOKEN_IN, symbol: "AAA" },
    wallet: "0xwallet",
    blockTag: "pending" as const,
    observedAt: OBSERVED_AT,
    required: { raw: "1000000", human: "1", decimals: 6, symbol: "AAA" },
    current: { raw: "5000000", human: "5", decimals: 6, symbol: "AAA" },
  },
  native: {
    asset: { chainId: 8453, address: "0xeeee", symbol: "ETH" },
    wallet: "0xwallet",
    blockTag: "pending" as const,
    observedAt: OBSERVED_AT,
    required: { raw: "500000000000000", human: "0.0005", decimals: 18, symbol: "ETH" },
    current: { raw: "1000000000000000000", human: "1", decimals: 18, symbol: "ETH" },
  },
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
    slippageBps: 50,
    safetyVerdict: "pass",
    safetyDetail: {},
    routeRef: null,
    eligibilityKind: "executable",
    claimedAt: null,
    claimedBy: null,
    createdAt: "2026-08-31T10:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  resetMocks();
});

// ── The gate rejects every non-executable latest row ──────────────────────

const INELIGIBLE: readonly PrequoteEligibilityKind[] = [
  "unpriceable_output",
  "excessive_impact",
  "oversize_snapshot",
  "provider_usd_invalid",
  "insufficient_balance",
  "balance_unavailable",
  "gas_reserve_insufficient",
];

describe("the common gate refuses a quote that authorized nothing", () => {
  for (const eligibilityKind of INELIGIBLE) {
    it(`blocks a kyberswap execute whose newest row is ${eligibilityKind}`, async () => {
      mockFindLatest.mockResolvedValue(row({ eligibilityKind }));
      const decision = await prequoteModule.evaluatePrequoteGate(
        "kyberswap.swap.execute",
        EVM_PARAMS,
        ctx(),
      );
      expect(decision.kind).toBe("block");
      if (decision.kind !== "block") return;
      expect(decision.reason).toBe("not_executable");
      expect(decision.message).toContain(`Recorded eligibility: ${eligibilityKind}.`);
    });

    it(`blocks a JUPITER execute whose newest row is ${eligibilityKind} - it has no claim lane`, async () => {
      mockFindLatest.mockResolvedValue(
        row({ eligibilityKind, family: "solana", provider: "jupiter", chainId: null }),
      );
      const decision = await prequoteModule.evaluatePrequoteGate(
        "solana.swap.execute",
        SOL_PARAMS,
        ctx(),
      );
      expect(decision.kind).toBe("block");
      if (decision.kind !== "block") return;
      expect(decision.reason).toBe("not_executable");
    });
  }

  it("allows an executable row - the guardrail refuses only what it must", async () => {
    mockFindLatest.mockResolvedValue(row());
    const decision = await prequoteModule.evaluatePrequoteGate(
      "kyberswap.swap.execute",
      EVM_PARAMS,
      ctx(),
    );
    expect(decision.kind).toBe("allow");
  });

  it("a confirmed-scam row still blocks as safety_fail - guardrail #1 keeps priority", async () => {
    // An ineligible AND flagged row must name the scam, not the balance: the
    // remedies are opposite (do not retry, versus fund and retry).
    mockExistsFail.mockResolvedValue(true);
    mockFindLatest.mockResolvedValue(row({ eligibilityKind: "insufficient_balance", safetyVerdict: "fail" }));
    const decision = await prequoteModule.evaluatePrequoteGate(
      "kyberswap.swap.execute",
      EVM_PARAMS,
      ctx(),
    );
    expect(decision.kind).toBe("block");
    if (decision.kind === "block") expect(decision.reason).toBe("safety_fail");
  });

  it("the block message leaks no row contents, address or hash", async () => {
    mockFindLatest.mockResolvedValue(row({ eligibilityKind: "insufficient_balance" }));
    const decision = await prequoteModule.evaluatePrequoteGate(
      "kyberswap.swap.execute",
      EVM_PARAMS,
      ctx(),
    );
    if (decision.kind !== "block") throw new Error("expected a block");
    expect(decision.message).not.toContain(TOKEN_IN);
    expect(decision.message).not.toContain("0xwallet");
    expect(decision.message).not.toContain("prequote-row-1");
    expect(decision.message).not.toContain("h".repeat(16));
  });
});

// ── Recorder -> row -> gate -> approval card ──────────────────────────────

describe("the quote-time spendability facts reach the approval card", () => {
  /** Run the REAL recorder over a kyberswap quote carrying the handoff. */
  async function recordWithSpendability(
    spendability: unknown,
  ): Promise<CreatePrequoteInput> {
    await prequoteModule.recordPrequoteFromQuote(
      "kyberswap.swap.quote",
      EVM_PARAMS,
      {
        chain: "base",
        chainId: 8453,
        tokenIn: { address: TOKEN_IN, symbol: "AAA", decimals: 6 },
        tokenOut: { address: TOKEN_OUT, symbol: "BBB", decimals: 18 },
        routeSummary: { foo: "bar" },
        routerAddress: "0xrouter",
        safety: {
          tokenIn: { isHoneypot: false, isFOT: false, tax: 0 },
          tokenOut: { isHoneypot: false, isFOT: false, tax: 0 },
        },
      },
      ctx(),
      { eligibilityKind: "executable", routeSnapshot: null, spendability } as ToolResult["quoteAuthority"],
    );
    const call = mockCreate.mock.calls[0];
    if (call === undefined) throw new Error("the recorder wrote no row");
    return call[0];
  }

  /** Push an allow decision through the real approval gate and card builder. */
  async function cardFor(safetyDetail: Record<string, unknown>): Promise<Record<string, unknown>> {
    mockFindLatest.mockResolvedValue(row({ safetyDetail }));
    const decision = await prequoteModule.evaluatePrequoteGate(
      "kyberswap.swap.execute",
      EVM_PARAMS,
      ctx(),
    );
    if (decision.kind !== "allow") throw new Error("expected an allow");
    const manifest = getProtocolManifest("kyberswap.swap.execute");
    if (!manifest) throw new Error("kyberswap.swap.execute manifest missing");
    const pending = evaluateApprovalGate(
      manifest,
      { toolId: "kyberswap.swap.execute" },
      EVM_PARAMS,
      ctx({ approved: false, sessionPermission: "restricted" }),
      decision.verdict,
      decision.fotTax,
      decision.termLock,
      decision.feePreview,
      undefined,
      decision.quoteBinding,
      decision.spendability,
      undefined,
    );
    if (pending === undefined) throw new Error("expected a pending-approval result");
    const preview = buildApprovalIntentPreview({
      toolName: "kyberswap.swap.execute",
      toolArgs: EVM_PARAMS,
      result: pending,
    });
    return preview.criticalArgs;
  }

  it("the recorder validates the handoff and persists it in the bounded safety block", async () => {
    const input = await recordWithSpendability(SPENDABILITY_HANDOFF);
    expect(input.safetyDetail.spendability).toEqual(SPENDABILITY_HANDOFF);
    // The quote's own safety block is preserved beside it, not replaced.
    expect(input.safetyDetail.tokenIn).toBeDefined();
  });

  it("a malformed handoff is dropped, and the row is still written", async () => {
    const input = await recordWithSpendability({ cardVersion: "spendability-v1", source: "nope" });
    expect(input.safetyDetail.spendability).toBeUndefined();
    expect(input.safetyDetail.tokenIn).toBeDefined();
    expect(input.eligibilityKind).toBe("executable");
  });

  it("the card states Required, Current and the total native debit, and dates them", async () => {
    const input = await recordWithSpendability(SPENDABILITY_HANDOFF);
    const criticalArgs = await cardFor(input.safetyDetail);
    const line = String(criticalArgs.spendability);
    expect(line).toContain(SPENDABILITY_CARD_VERSION);
    expect(line).toContain("required 1 AAA");
    expect(line).toContain("held 5 AAA");
    expect(line).toContain("required 0.0005 ETH");
    expect(line).toContain(OBSERVED_AT);
    // The person is told what the number is NOT: a sign-time guarantee.
    expect(line).toContain("re-read before signing");
  });

  it("a forged spendability block in the row does not reach the card", async () => {
    // The card's figures come from a payload this build can re-validate. A
    // shape the schema rejects yields NO line at all - never a partial one.
    const criticalArgs = await cardFor({ spendability: { cardVersion: "spendability-v1", source: {}, native: {} } });
    expect(criticalArgs.spendability).toBeUndefined();
  });

  it("a row from a venue that measures no balances simply carries no line", async () => {
    const criticalArgs = await cardFor({});
    expect(criticalArgs.spendability).toBeUndefined();
    // The rest of the card is untouched.
    expect(criticalArgs.safety).toBe("pass");
  });
});
