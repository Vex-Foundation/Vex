/**
 * An approval authorizes ONE quote, and the execute claims THAT one.
 *
 * ## The defect this file pins
 *
 * The approval card names a quote (id, digest, floor, expiry). The claim used to
 * ignore all of it and select the NEWEST executable row for the trade identity -
 * so a quote recorded between "the card was shown" and "the human clicked
 * Approve" became the row that executed. Approve Q1, fill Q2, and nothing in the
 * chain noticed: same session, same identity, a perfectly valid row.
 *
 * The tests below drive the real claim seam with a stubbed repo, so what is
 * asserted is the DECISION (which row, and what refusal when it is not
 * claimable) rather than the SQL. The predicate half - "the bound row must still
 * be the current one" - is exercised against real Postgres in
 * `integration/repos/swap-prequotes-claim.int.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { SwapPrequote } from "@vex-agent/db/repos/swap-prequotes.js";
import { approvedQuoteAuthorityFrom } from "@vex-agent/tools/protocols/quote-authority/approved-authority.js";
import {
  encodeRouteSnapshotRaw,
  ROUTE_SNAPSHOT_VERSION,
  sealRouteSnapshot,
} from "@vex-agent/tools/protocols/quote-authority/snapshot.js";
import { buildBoundDebitPlan } from "@vex-agent/tools/protocols/quote-authority/debit-plan.js";

const mockClaimBound = vi.fn();
const mockClaimForExecute = vi.fn();
const mockFindLatestExecutable = vi.fn();
const mockFindLatestFresh = vi.fn();
const mockDiagnose = vi.fn();

vi.mock("@vex-agent/db/repos/swap-prequotes.js", () => ({
  claimBoundForExecute: (...a: unknown[]) => mockClaimBound(...a),
  claimForExecute: (...a: unknown[]) => mockClaimForExecute(...a),
  findLatestExecutableByMatch: (...a: unknown[]) => mockFindLatestExecutable(...a),
  findLatestFreshByMatch: (...a: unknown[]) => mockFindLatestFresh(...a),
  diagnoseUnclaimable: (...a: unknown[]) => mockDiagnose(...a),
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => "0xWALLET",
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

import { claimSwapExecutionSnapshot } from "@vex-agent/tools/protocols/prequote/claim.js";

const TOKEN_IN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TOKEN_OUT = "0x17f31d221a86c091a32d398653f5306fc4d93c0d";
const EXPIRES_AT = "2026-08-28T10:00:00.000Z";
const APPROVED_MIN_OUT = "990000000000000000";
const Q1 = "prequote-q1";

const ROUTE_SUMMARY = {
  tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT,
  amountIn: "10000000", amountOut: "1000000000000000000",
  routeID: "r1", checksum: "c1", route: [],
};
const ENCODED = encodeRouteSnapshotRaw(ROUTE_SUMMARY);
if (!ENCODED.ok) throw new Error("fixture route must encode");
const RAW = ENCODED.raw;
/** The one-leg transaction set this fixture's quote bound. */
const PLAN = buildBoundDebitPlan({
  legs: [{ role: "swap", pricing: "measured" as const }],
  feeCap: { mode: "legacy", gasPriceWei: 1_000n },
});

function routeRef(overrides: Record<string, unknown> = {}) {
  return {
    ...sealRouteSnapshot({
      v: ROUTE_SNAPSHOT_VERSION,
      provider: "kyberswap",
      raw: RAW,
      approvedAmountOutRaw: "1000000000000000000",
      approvedMinOutRaw: APPROVED_MIN_OUT,
      approvedAmountOutHuman: "1",
      approvedMinOutHuman: "0.99",
      tokenOutSymbol: "TKN",
      effectiveSlippageBps: 100,
      expiresAt: EXPIRES_AT,
      eligibility: { kind: "executable", priceImpactFraction: 0.001, adverse: false },
      debitPlan: PLAN,
    }),
    ...overrides,
  };
}

/** The digest the card would have named for that row. */
const DIGEST = routeRef().digest;

/** A claimed row as the repo returns it. Only the fields the claim reads matter. */
function row(overrides: Partial<SwapPrequote> = {}): SwapPrequote {
  return {
    prequoteId: Q1,
    sessionId: "session-1",
    matchHash: "h".repeat(64),
    kind: "swap",
    family: "eip155",
    provider: "kyberswap",
    chainId: 8453,
    walletAddress: "0xWALLET",
    tokenIn: TOKEN_IN,
    tokenOut: TOKEN_OUT,
    amount: "10",
    slippageBps: 100,
    safetyVerdict: "pass",
    safetyDetail: {},
    routeRef: routeRef(),
    eligibilityKind: "executable",
    claimedAt: "2026-08-28T09:00:00.000Z",
    claimedBy: "execute",
    createdAt: "2026-08-28T09:00:00.000Z",
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

/** The binding the approval card recorded for Q1. */
function authority(overrides: Partial<ReturnType<typeof approvedQuoteAuthorityFrom>> = {}) {
  return {
    ...approvedQuoteAuthorityFrom({
      snapshotId: Q1,
      digest: DIGEST,
      approvedMinOutRaw: APPROVED_MIN_OUT,
      expiresAt: EXPIRES_AT,
    }),
    ...overrides,
  };
}

/**
 * A dispatch context. `approvalId` is what makes it an APPROVAL RESUME - the
 * host-side fact the fail-closed branch keys on - so the live-turn case omits
 * it, exactly as the runtime does.
 */
function ctx(
  bound: ReturnType<typeof authority> | null,
  opts: { readonly approvalResume?: boolean } = {},
): ProtocolExecutionContext {
  const approvalResume = opts.approvalResume ?? true;
  return {
    sessionPermission: approvalResume ? "restricted" : "full",
    approved: true,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    sessionId: "session-1",
    ...(approvalResume ? { approvalId: "approval-1" } : {}),
    approvedQuoteAuthority: bound,
  };
}

const PARAMS = {
  chain: "base", tokenIn: TOKEN_IN, tokenOut: TOKEN_OUT, amountIn: "10", slippageBps: 100,
};

function claim(
  bound: ReturnType<typeof authority> | null,
  opts: { readonly approvalResume?: boolean } = {},
) {
  return claimSwapExecutionSnapshot(
    "kyberswap.swap.execute", "session-1", PARAMS, ctx(bound, opts), "execute-1",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClaimBound.mockResolvedValue(row());
  mockClaimForExecute.mockResolvedValue(row());
  mockFindLatestExecutable.mockResolvedValue(row({ prequoteId: "prequote-q2", claimedAt: null }));
  mockFindLatestFresh.mockResolvedValue(null);
  mockDiagnose.mockResolvedValue("superseded");
});

describe("a bound approval claims exactly the row it named", () => {
  it("claims Q1 by id and never asks which row is newest", async () => {
    const result = await claim(authority());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prequoteId).toBe(Q1);
    // The identity of the trade is still asserted at the row, so a bound id from
    // another trade matches nothing.
    expect(mockClaimBound).toHaveBeenCalledTimes(1);
    const [sessionId, prequoteId, matchHash, kind] = mockClaimBound.mock.calls[0] as string[];
    expect(sessionId).toBe("session-1");
    expect(prequoteId).toBe(Q1);
    expect(typeof matchHash).toBe("string");
    expect(kind).toBe("swap");
    // THE DEFECT, as an absence: the newest-row selector is not consulted at all
    // on a bound claim, and the unbound claim is never reached.
    expect(mockFindLatestExecutable).not.toHaveBeenCalled();
    expect(mockClaimForExecute).not.toHaveBeenCalled();
  });

  it("refuses `superseded` when a newer quote arrived after the approval", async () => {
    // The repo's currency predicate is what fails; the diagnosis names why.
    mockClaimBound.mockResolvedValue(null);
    mockDiagnose.mockResolvedValue("superseded");

    const result = await claim(authority());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.kind).toBe("superseded");
      expect(result.refusal.message).toContain("Nothing was signed");
      expect(result.refusal.message).toContain("kyberswap__swap_quote");
    }
  });

  for (const [reason, kind] of [
    ["already_claimed", "already_claimed"],
    ["expired", "expired"],
    ["not_executable", "not_executable"],
    ["missing", "missing_snapshot"],
  ] as const) {
    it(`maps an unclaimable bound row (${reason}) to the typed refusal ${kind}`, async () => {
      mockClaimBound.mockResolvedValue(null);
      mockDiagnose.mockResolvedValue(reason);

      const result = await claim(authority());

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal.kind).toBe(kind);
    });
  }
});

describe("the bound row's CONTENT must be the content that was approved", () => {
  it("refuses a snapshot whose digest is not the approved one", async () => {
    const result = await claim(authority({ digest: "f".repeat(64) }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.kind).toBe("digest_mismatch");
  });

  it("refuses a snapshot whose floor is not the approved floor", async () => {
    const result = await claim(authority({ approvedMinOutRaw: "1" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.kind).toBe("digest_mismatch");
  });

  it("refuses a row whose expiry is not the deadline the card stated", async () => {
    const result = await claim(authority({ expiresAt: "2026-08-29T10:00:00.000Z" }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.kind).toBe("digest_mismatch");
  });

  it("accepts the same instant spelled differently - the check is on time, not text", async () => {
    const result = await claim(authority({ expiresAt: "2026-08-28T10:00:00Z" }));

    expect(result.ok).toBe(true);
  });
});

describe("an UNBOUND claim is unchanged when no approval is in play", () => {
  it("selects the newest executable row, as every full-permission execute does", async () => {
    const result = await claim(null, { approvalResume: false });

    expect(result.ok).toBe(true);
    expect(mockFindLatestExecutable).toHaveBeenCalledTimes(1);
    expect(mockClaimForExecute).toHaveBeenCalledTimes(1);
    expect(mockClaimBound).not.toHaveBeenCalled();
  });
});

/**
 * An approval that names no quote FAILS CLOSED (owner decision 2026-08-28).
 *
 * The alternative is the newest-executable fallback, and under an approval that
 * is precisely the substitution the binding exists to prevent: a human
 * authorized one fill, and a dispatch that cannot say which one must not choose
 * for them. Only approvals written before the binding existed can be in this
 * state, and the refusal names it and says how to get out of it.
 */
describe("an approval that names no quote is refused", () => {
  it("refuses `unbound_approval` and claims NOTHING", async () => {
    const result = await claim(null);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.kind).toBe("unbound_approval");
      expect(result.refusal.message).toContain("predates quote binding");
      // Recoverable, like every other refusal in this vocabulary.
      expect(result.refusal.message).toContain("Nothing was signed");
      expect(result.refusal.message).toContain("kyberswap__swap_quote");
    }
    // No row was read for a candidate and no row was consumed, by either claim.
    expect(mockFindLatestExecutable).not.toHaveBeenCalled();
    expect(mockClaimForExecute).not.toHaveBeenCalled();
    expect(mockClaimBound).not.toHaveBeenCalled();
  });
});
