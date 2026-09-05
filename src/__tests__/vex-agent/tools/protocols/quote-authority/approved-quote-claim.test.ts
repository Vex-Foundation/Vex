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

const mockFindClaimable = vi.fn();
const mockClaimVerified = vi.fn();
const mockFindLatestExecutable = vi.fn();
const mockFindLatestFresh = vi.fn();
const mockDiagnose = vi.fn();

vi.mock("@vex-agent/db/repos/swap-prequotes.js", () => ({
  findClaimableForExecute: (...a: unknown[]) => mockFindClaimable(...a),
  claimVerifiedRowForExecute: (...a: unknown[]) => mockClaimVerified(...a),
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

import {
  commitPrequoteClaim,
  readSwapExecutionSnapshot,
} from "@vex-agent/tools/protocols/prequote/claim.js";

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
  return readSwapExecutionSnapshot(
    "kyberswap.swap.execute", "session-1", PARAMS, ctx(bound, opts),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindClaimable.mockResolvedValue(row({ claimedAt: null, claimedBy: null }));
  mockClaimVerified.mockResolvedValue(row());
  mockFindLatestExecutable.mockResolvedValue(row({ prequoteId: "prequote-q2", claimedAt: null }));
  mockFindLatestFresh.mockResolvedValue(null);
  mockDiagnose.mockResolvedValue("superseded");
});

describe("a bound approval reads exactly the row it named", () => {
  it("reads Q1 by id, consumes NOTHING, and never asks which row is newest", async () => {
    const result = await claim(authority());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prequoteId).toBe(Q1);
    // The identity of the trade is still asserted at the row, so a bound id from
    // another trade matches nothing.
    expect(mockFindClaimable).toHaveBeenCalledTimes(1);
    const [sessionId, prequoteId, matchHash, kind] = mockFindClaimable.mock.calls[0] as string[];
    expect(sessionId).toBe("session-1");
    expect(prequoteId).toBe(Q1);
    expect(typeof matchHash).toBe("string");
    expect(kind).toBe("swap");
    // As an absence: reading the authority spends nothing, so
    // a divergence the caller finds next leaves the quote reusable.
    expect(mockClaimVerified).not.toHaveBeenCalled();
    expect(mockFindLatestExecutable).not.toHaveBeenCalled();
  });

  it("refuses `superseded` when a newer quote arrived after the approval", async () => {
    // The repo's currency predicate is what fails; the diagnosis names why.
    mockFindClaimable.mockResolvedValue(null);
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
      mockFindClaimable.mockResolvedValue(null);
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

describe("an UNBOUND read is unchanged when no approval is in play", () => {
  it("selects the newest executable row, as every full-permission execute does", async () => {
    const result = await claim(null, { approvalResume: false });

    expect(result.ok).toBe(true);
    expect(mockFindLatestExecutable).toHaveBeenCalledTimes(1);
    expect(mockFindClaimable).not.toHaveBeenCalled();
    // Still nothing consumed by the read itself.
    expect(mockClaimVerified).not.toHaveBeenCalled();
  });
});

/**
 * THE ORDERING THE MONEY PATH REQUIRES (review finding, 2026-09-04).
 *
 * The quote is consumed by a SECOND, explicit call, so every divergence the
 * executor finds between the read and the commit leaves `claimed_at` null and
 * the quote reusable. MetaMask's `#approveTransaction` behaves the same way: a
 * failed attempt releases its reservation and the transaction stays usable.
 */
describe("the commit is the only thing that consumes a quote", () => {
  it("claims the exact row that was read, asserting its disclosure block", async () => {
    const read = await claim(authority());
    if (!read.ok) throw new Error("fixture read must succeed");

    const committed = await commitPrequoteClaim(read.claim, "execute-1");

    expect(committed.ok).toBe(true);
    expect(mockClaimVerified).toHaveBeenCalledTimes(1);
    const [arg] = mockClaimVerified.mock.calls[0] as [Record<string, unknown>];
    expect(arg.prequoteId).toBe(Q1);
    expect(arg.sessionId).toBe("session-1");
    expect(arg.kind).toBe("swap");
    expect(typeof arg.matchHash).toBe("string");
    expect(arg.expectedDisclosure).toEqual({});
    expect(arg.claimedBy).toBe("execute-1");
  });

  it("refuses typed when the row's disclosure moved between the read and the claim", async () => {
    const read = await claim(authority());
    if (!read.ok) throw new Error("fixture read must succeed");
    mockClaimVerified.mockResolvedValue(null);
    mockDiagnose.mockResolvedValue("disclosure_changed");

    const committed = await commitPrequoteClaim(read.claim, "execute-1");

    expect(committed.ok).toBe(false);
    if (!committed.ok) {
      expect(committed.refusal.kind).toBe("disclosure_changed");
      expect(committed.refusal.message).toContain("Nothing was signed");
      expect(committed.refusal.message).toContain("kyberswap__swap_quote");
    }
  });

  it("refuses `already_claimed` when a concurrent execute won the same row", async () => {
    const read = await claim(authority());
    if (!read.ok) throw new Error("fixture read must succeed");
    mockClaimVerified.mockResolvedValue(null);
    mockDiagnose.mockResolvedValue("already_claimed");

    const committed = await commitPrequoteClaim(read.claim, "execute-1");

    expect(committed.ok).toBe(false);
    if (!committed.ok) expect(committed.refusal.kind).toBe("already_claimed");
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
    // No row was read for a candidate and no row was consumed.
    expect(mockFindLatestExecutable).not.toHaveBeenCalled();
    expect(mockFindClaimable).not.toHaveBeenCalled();
    expect(mockClaimVerified).not.toHaveBeenCalled();
  });
});
