/**
 * THE APPROVAL-RESUME AUTHORITY RACE, end to end.
 *
 * THE DEFECT THIS PINS. On an approval resume the approval gate is skipped
 * (`context.approved` is true) while the prequote gate RERUNS, and the gate
 * deliberately selected the newest executable row for the identity. A quote Q2
 * recorded while the card sat in the queue therefore became the row the resumed
 * dispatch was gated on, even though a person read Q1 - and Jupiter derives
 * BOTH its fee policy and its approved native-cost ceiling from that row
 * (`swap-execute-handler.ts`), so the substitution silently replaced the two
 * numbers the card disclosed. Jupiter seals no route snapshot, so the atomic
 * claim that fences the EVM venues never protected it.
 *
 * The experiments drive the REAL runtime gate chain (`executeProtocolTool` ->
 * `evaluatePrequoteGateDecision` -> `evaluatePrequoteGate`) and the REAL
 * approval envelope round-trip (`buildApprovalToolCall` ->
 * `readApprovalPrequoteAuthority`), with only the DB, the wallet resolver, the
 * Jupiter token resolver and the catalog/handler surface faked - those are the
 * external boundaries, not the subject. The scripted rows are what a concurrent
 * quote would have written.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import { SOL_MINT } from "@tools/solana-ecosystem/shared/solana-constants.js";
import { JUPITER_SWAP_LANDING_MODE } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/constants.js";
import { SOLANA_SYNTHETIC_CHAIN_ID } from "../../../../../constants/solana-chain.js";
import { SPENDABILITY_CARD_VERSION } from "@vex-agent/tools/protocols/quote-authority/spendability-contract.js";
import type { ProtocolToolManifest } from "@vex-agent/tools/protocols/types.js";
import type { SwapPrequote } from "@vex-agent/db/repos/swap-prequotes.js";
import type { ToolResult } from "@vex-agent/tools/types.js";

// ── Mock surface: the boundaries only ─────────────────────────────────────

vi.mock("@vex-agent/tools/protocols/capture-validator.js", () => ({
  isPreviewExecution: vi.fn(() => false),
  validateCaptureContract: vi.fn(() => true),
}));

vi.mock("@vex-agent/tools/protocols/catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/tools/protocols/catalog.js")>();
  return { ...actual, getProtocolManifest: vi.fn(), getProtocolHandler: vi.fn() };
});

vi.mock("@vex-agent/tools/protocols/lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vex-agent/tools/protocols/lifecycle.js")>();
  return { ...actual, isExecutableNamespace: vi.fn(() => true) };
});

vi.mock("@vex-agent/tools/protocols/capture-pipeline.js", () => ({
  extractExternalRefs: vi.fn(() => ({})),
  populateCaptureItems: vi.fn(),
}));
vi.mock("@vex-agent/db/repos/executions.js", () => ({ recordExecution: vi.fn().mockResolvedValue(0) }));
vi.mock("@vex-agent/db/repos/sync.js", () => ({
  getJobsForNamespace: vi.fn().mockResolvedValue([]),
  enqueueRun: vi.fn(),
}));
vi.mock("@vex-agent/db/params.js", () => ({ sanitizeJsonbValue: (v: unknown) => v }));

const mockFindLatest = vi.fn<(s: string, h: string, k: string) => Promise<SwapPrequote | null>>();
const mockExistsFail = vi.fn<(s: string, h: string, k: string) => Promise<boolean>>();
vi.mock("@vex-agent/db/repos/swap-prequotes.js", () => ({
  create: vi.fn(),
  findLatestFreshByMatch: (s: string, h: string, k: string) => mockFindLatest(s, h, k),
  existsFreshFailByMatch: (s: string, h: string, k: string) => mockExistsFail(s, h, k),
}));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: vi.fn(() => "SoLWaLLeT111111111111111111111111111111111"),
}));
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js", () => ({
  requireJupiterResolvedToken: async (q: string) => ({ address: q }),
}));

// ── Dynamic imports after mocks ───────────────────────────────────────────

const { executeProtocolTool } = await import("@vex-agent/tools/protocols/runtime.js");
const { findFreshMatchedPrequote } = await import(
  "@vex-agent/tools/protocols/swap-prequote.js"
);
const catalog = await import("@vex-agent/tools/protocols/catalog.js");
const {
  buildApprovalToolCall,
  readApprovalPrequoteAuthority,
} = await import("@vex-agent/engine/core/approval-runtime/tool-call-envelope.js");

// ── Fixtures ──────────────────────────────────────────────────────────────

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const WALLET = "SoLWaLLeT111111111111111111111111111111111";
const MINT_IN = "FooMintCaseSensitiveABC123";
const SWAP_PARAMS = { tokenIn: MINT_IN, tokenOut: SOL_MINT, amountIn: "1" };
const OBSERVED_AT = "2026-08-31T12:00:00.000Z";

function jupiterManifest(): ProtocolToolManifest {
  return {
    toolId: "solana.swap.execute",
    publicName: "solana__swap_execute",
    namespace: "solana",
    lifecycle: "active",
    description: "swap",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      { key: "tokenIn", type: "string", required: true, description: "" },
      { key: "tokenOut", type: "string", required: true, description: "" },
      { key: "amountIn", type: "string", required: true, description: "" },
    ],
    exampleParams: {},
  };
}

/** The fee-bearing disclosure the card states for a Jupiter swap. */
function feePreview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    inAmountRaw: "1000000",
    outAmountRaw: "990000",
    otherAmountThresholdRaw: "980000",
    feeBps: 25,
    feeAmountRaw: "2500",
    feeAmountDecimal: "0.0025",
    feeMint: MINT_IN,
    feeAccount: "TreasuryAta1111111111111111111111111111111",
    feeAccountExists: true,
    ataRentLamports: 2039280,
    tipLamports: 100000,
    priorityFeeStrategy: "auto",
    priorityFeeLamportsEstimate: 50000,
    priorityFeeIsUpperBound: false,
    landingMode: JUPITER_SWAP_LANDING_MODE,
    ...overrides,
  };
}

/**
 * The quote-time spendability statement. `nativeRequiredRaw` is the APPROVED
 * NATIVE CEILING the Jupiter execute binds its pre-sign cost check to, so
 * changing it is changing what the person consented to spend.
 */
function spendability(nativeRequiredRaw: string): Record<string, unknown> {
  return {
    cardVersion: SPENDABILITY_CARD_VERSION,
    source: {
      asset: { chainId: SOLANA_SYNTHETIC_CHAIN_ID, address: MINT_IN, symbol: "FOO" },
      wallet: WALLET,
      blockTag: "pending",
      observedAt: OBSERVED_AT,
      required: { raw: "1000000", human: "1", decimals: 6, symbol: "FOO" },
      current: { raw: "5000000", human: "5", decimals: 6, symbol: "FOO" },
    },
    native: {
      asset: { chainId: SOLANA_SYNTHETIC_CHAIN_ID, address: SOL_MINT, symbol: "SOL" },
      wallet: WALLET,
      blockTag: "pending",
      observedAt: OBSERVED_AT,
      required: { raw: nativeRequiredRaw, human: null, decimals: 9, symbol: "SOL" },
      current: { raw: "1000000000", human: "1", decimals: 9, symbol: "SOL" },
    },
  };
}

function row(overrides: Partial<SwapPrequote> = {}): SwapPrequote {
  return {
    prequoteId: "prequote-Q1",
    sessionId: SESSION_ID,
    matchHash: "h".repeat(64),
    kind: "swap",
    family: "solana",
    provider: "jupiter",
    chainId: null,
    walletAddress: WALLET,
    tokenIn: MINT_IN,
    tokenOut: SOL_MINT,
    amount: "1",
    slippageBps: 50,
    safetyVerdict: "pass",
    safetyDetail: { feePreview: feePreview(), spendability: spendability("2189280") },
    routeRef: null,
    eligibilityKind: "executable",
    claimedAt: null,
    claimedBy: null,
    createdAt: "2026-08-31T10:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const handlerSpy = vi.fn(async () => ({ success: true, output: "broadcast" }));

const restrictedCtx = {
  sessionPermission: "restricted" as const,
  approved: false,
  sessionId: SESSION_ID,
  walletResolution: { source: "default" as const },
  walletPolicy: { kind: "none" as const },
};

/**
 * The whole enqueue-side half, as production runs it: the gate's typed
 * `prequoteAuthority` channel goes into the stored `approval_queue.tool_call`
 * envelope, and comes back out of it. Nothing is hand-assembled - a test that
 * built the block itself would prove the fence works on a value production
 * might never store.
 */
async function approveQ1(): Promise<{
  readonly pending: ToolResult;
  readonly boundAuthority: ReturnType<typeof readApprovalPrequoteAuthority>;
}> {
  const pending = await executeProtocolTool(
    { toolId: "solana.swap.execute", params: SWAP_PARAMS },
    restrictedCtx,
  );
  expect(pending.pendingApproval).toBe(true);
  const envelope = buildApprovalToolCall(
    "solana__swap_execute",
    SWAP_PARAMS,
    undefined,
    undefined,
    pending.prequoteAuthority,
  );
  return { pending, boundAuthority: readApprovalPrequoteAuthority(envelope) };
}

/** The resumed dispatch: approved, with the approval's own host-side evidence. */
function resumeCtx(authority: ReturnType<typeof readApprovalPrequoteAuthority>) {
  return {
    ...restrictedCtx,
    approved: true,
    approvalId: "approval-1",
    approvedPrequoteAuthority: authority,
  };
}

beforeEach(() => {
  vi.mocked(catalog.getProtocolManifest).mockReset().mockReturnValue(jupiterManifest());
  vi.mocked(catalog.getProtocolHandler).mockReset().mockReturnValue(handlerSpy);
  handlerSpy.mockClear();
  mockFindLatest.mockReset().mockResolvedValue(row());
  mockExistsFail.mockReset().mockResolvedValue(false);
});

describe("Q1 card -> enqueue -> executable Q2 -> approve/resume", () => {
  it("stores WHICH row the card was built from, and the digest of what it disclosed", async () => {
    const { pending, boundAuthority } = await approveQ1();
    expect(pending.prequoteAuthority?.prequoteId).toBe("prequote-Q1");
    expect(boundAuthority).not.toBeNull();
    expect(boundAuthority?.prequoteId).toBe("prequote-Q1");
    expect(boundAuthority?.disclosureDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(boundAuthority?.disclosureDigest).toBe(pending.prequoteAuthority?.disclosureDigest);
  });

  it("REFUSES the resume when a newer EXECUTABLE Q2 replaced the approved row", async () => {
    const { boundAuthority } = await approveQ1();

    // A concurrent quote lands while the card waits. Q2 is impeccable: fresh,
    // executable, and it even discloses a LOWER fee - which is exactly why the
    // old newest-row selection accepted it. It is still not the quote anybody
    // approved.
    mockFindLatest.mockResolvedValue(
      row({
        prequoteId: "prequote-Q2",
        safetyDetail: {
          feePreview: feePreview({ tipLamports: 10 }),
          spendability: spendability("2100000"),
        },
      }),
    );

    const resumed = await executeProtocolTool(
      { toolId: "solana.swap.execute", params: SWAP_PARAMS },
      resumeCtx(boundAuthority),
    );

    expect(resumed.success).toBe(false);
    expect(resumed.pendingApproval).toBeUndefined();
    expect(resumed.output).toMatch(/no longer the current one/i);
    // Nothing was built, signed or broadcast: the handler never ran.
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it("REFUSES the resume when the approved row itself now states a different native ceiling", async () => {
    const { boundAuthority } = await approveQ1();

    // Same row id, rewritten content: the ceiling the card disclosed
    // (0.00218928 SOL) is now four times higher. The id alone would have waved
    // this through.
    mockFindLatest.mockResolvedValue(
      row({ safetyDetail: { feePreview: feePreview(), spendability: spendability("8000000") } }),
    );

    const resumed = await executeProtocolTool(
      { toolId: "solana.swap.execute", params: SWAP_PARAMS },
      resumeCtx(boundAuthority),
    );

    expect(resumed.success).toBe(false);
    expect(resumed.output).toMatch(/is not what the approval card stated/i);
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it("REFUSES the resume when the fee preview the card disclosed changed", async () => {
    const { boundAuthority } = await approveQ1();
    mockFindLatest.mockResolvedValue(
      row({
        safetyDetail: {
          // A different treasury fee account is precisely the substitution the
          // handler's `assertFeePolicyUnchanged` exists to catch; the card's
          // digest catches it one step earlier, before anything is built.
          feePreview: feePreview({ feeAccount: "OtherAta11111111111111111111111111111111111" }),
          spendability: spendability("2189280"),
        },
      }),
    );
    const resumed = await executeProtocolTool(
      { toolId: "solana.swap.execute", params: SWAP_PARAMS },
      resumeCtx(boundAuthority),
    );
    expect(resumed.success).toBe(false);
    expect(resumed.output).toMatch(/is not what the approval card stated/i);
    expect(handlerSpy).not.toHaveBeenCalled();
  });

  it("ALLOWS the resume when the approved row is still current and still says the same thing", async () => {
    const { boundAuthority } = await approveQ1();
    const resumed = await executeProtocolTool(
      { toolId: "solana.swap.execute", params: SWAP_PARAMS },
      resumeCtx(boundAuthority),
    );
    expect(resumed.success).toBe(true);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });

  it("REFUSES a resume whose approval names no row at all - fail closed, never pick one", async () => {
    const resumed = await executeProtocolTool(
      { toolId: "solana.swap.execute", params: SWAP_PARAMS },
      resumeCtx(null),
    );
    expect(resumed.success).toBe(false);
    expect(resumed.output).toMatch(/does not record WHICH quote/i);
    expect(handlerSpy).not.toHaveBeenCalled();
  });
});

describe("a FRESH call keeps the newest-executable-row behaviour", () => {
  it("a full-permission dispatch with no approval runs on the newest row", async () => {
    mockFindLatest.mockResolvedValue(row({ prequoteId: "prequote-Q2" }));
    const result = await executeProtocolTool(
      { toolId: "solana.swap.execute", params: SWAP_PARAMS },
      { ...restrictedCtx, sessionPermission: "full", approved: true },
    );
    expect(result.success).toBe(true);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
  });

  it("a restricted, not-yet-approved call still produces a card for the newest row", async () => {
    mockFindLatest.mockResolvedValue(row({ prequoteId: "prequote-Q2" }));
    const pending = await executeProtocolTool(
      { toolId: "solana.swap.execute", params: SWAP_PARAMS },
      restrictedCtx,
    );
    expect(pending.pendingApproval).toBe(true);
    expect(pending.prequoteAuthority?.prequoteId).toBe("prequote-Q2");
    expect(handlerSpy).not.toHaveBeenCalled();
  });
});

describe("the handler's own re-read applies the same fence", () => {
  // Jupiter has no atomic claim lane, so `findFreshMatchedPrequote` is the
  // LAST reader between the gate and the signature. The gate ran earlier; a
  // quote recorded in that window would otherwise still hand the execute a fee
  // policy and a native ceiling nobody approved.

  it("returns the bound row when it is still the current one", async () => {
    const { boundAuthority } = await approveQ1();
    const matched = await findFreshMatchedPrequote(
      "solana.swap.execute",
      SESSION_ID,
      SWAP_PARAMS,
      resumeCtx(boundAuthority),
    );
    expect(matched.ok).toBe(true);
    if (!matched.ok) return;
    expect(matched.prequote.prequoteId).toBe("prequote-Q1");
    expect(matched.spendability?.native.required.raw).toBe("2189280");
  });

  it("refuses a Q2 that landed between the gate and the re-read", async () => {
    const { boundAuthority } = await approveQ1();
    mockFindLatest.mockResolvedValue(row({ prequoteId: "prequote-Q2" }));
    const matched = await findFreshMatchedPrequote(
      "solana.swap.execute",
      SESSION_ID,
      SWAP_PARAMS,
      resumeCtx(boundAuthority),
    );
    expect(matched.ok).toBe(false);
    if (matched.ok) return;
    expect(matched.reason).toBe("approval_row_superseded");
  });

  it("refuses a rewritten ceiling on the bound row", async () => {
    const { boundAuthority } = await approveQ1();
    mockFindLatest.mockResolvedValue(
      row({ safetyDetail: { feePreview: feePreview(), spendability: spendability("8000000") } }),
    );
    const matched = await findFreshMatchedPrequote(
      "solana.swap.execute",
      SESSION_ID,
      SWAP_PARAMS,
      resumeCtx(boundAuthority),
    );
    expect(matched.ok).toBe(false);
    if (matched.ok) return;
    expect(matched.reason).toBe("approved_disclosure_changed");
  });

  it("leaves a non-approval dispatch on the newest row", async () => {
    mockFindLatest.mockResolvedValue(row({ prequoteId: "prequote-Q2" }));
    const matched = await findFreshMatchedPrequote(
      "solana.swap.execute",
      SESSION_ID,
      SWAP_PARAMS,
      { ...restrictedCtx, sessionPermission: "full", approved: true },
    );
    expect(matched.ok).toBe(true);
    if (!matched.ok) return;
    expect(matched.prequote.prequoteId).toBe("prequote-Q2");
  });
});
