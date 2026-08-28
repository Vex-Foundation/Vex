/**
 * WHICH QUOTE an approval authorized, bound into the stored envelope.
 *
 * ## The defect this file pins
 *
 * The approval card states a quote - its id, its digest, the floor the fill may
 * not go below, and when the authority lapses. None of that was stored anywhere
 * the DISPATCH could read: the envelope carried the tool name and the arguments,
 * and the resumed execute then claimed whichever quote for that trade was newest
 * by the time the human clicked Approve. Approve Q1, execute Q2.
 *
 * Binding it into the envelope is what makes the fix hold on BOTH lanes at once:
 * the agent lane digests the envelope, the Studio lane digests the envelope
 * inside its authority preimage, so neither can dispatch a call whose bound quote
 * was swapped after the approval was granted.
 *
 * The block is also PRIVATE: it is a sibling of the call, never a member of the
 * arguments, so nothing about it reaches model context on resume.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolResult } from "@vex-agent/tools/types.js";
import type { ProjectScope } from "@vex-agent/mcp/project-scope.js";
import { buildProjectToolContext } from "@vex-agent/mcp/project-context.js";

const enqueueWith = vi.fn();
const createWith = vi.fn();
const rejectWith = vi.fn();
const updateStatus = vi.fn();

vi.mock("@vex-agent/db/repos/approvals.js", () => ({ enqueueWith, rejectWith }));
vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({ createWith }));
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({ updateStatus }));
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async (fn: (client: object) => Promise<unknown>) => fn({ query: vi.fn() }),
  executeWith: vi.fn().mockResolvedValue(1),
  queryWith: vi.fn().mockResolvedValue([]),
  queryOneWith: vi.fn().mockResolvedValue(null),
  queryOne: vi.fn().mockResolvedValue(null),
  query: vi.fn().mockResolvedValue([]),
  execute: vi.fn().mockResolvedValue(1),
}));

const { enqueueApprovalIntentWithGate } = await import(
  "@vex-agent/engine/core/approval-runtime/enqueue.js"
);
const {
  buildApprovalToolCall,
  computeRequestDigest,
  readApprovalQuoteAuthority,
} = await import("@vex-agent/engine/core/approval-runtime/tool-call-envelope.js");
const { APPROVED_QUOTE_AUTHORITY_VERSION, approvedQuoteAuthorityFrom } = await import(
  "@vex-agent/tools/protocols/quote-authority/approved-authority.js"
);

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

/** The card binding the gate produced for the quote the human was shown. */
function quoteBinding(overrides: Record<string, unknown> = {}) {
  return {
    cardVersion: "kyber-quote-v1",
    snapshotId: "prequote-q1",
    digest: "a".repeat(64),
    approvedAmountOutHuman: "1",
    approvedMinOutHuman: "0.99",
    approvedMinOutRaw: "990000000000000000",
    tokenOutSymbol: "TKN",
    effectiveSlippageBps: 100,
    expiresAt: "2026-08-28T10:00:00.000Z",
    ...overrides,
  };
}

function resultWithQuote(binding: ReturnType<typeof quoteBinding> | undefined): ToolResult {
  return {
    success: false,
    output: "approval required",
    pendingApproval: true,
    actionKind: "user_wallet_broadcast",
    ...(binding === undefined
      ? {}
      : { prequote: { verdict: "pass" as const, quoteBinding: binding } }),
  };
}

function scope(): ProjectScope {
  return {
    projectId: PROJECT_ID,
    scopeVersion: 4,
    permission: "restricted",
    backingSessionId: SESSION_ID,
    wallets: { evm: null, solana: null },
  };
}

/** Enqueue through the SHARED seam, on either lane, with a clear gate. */
async function enqueue(
  origin: "agent" | "studio_mcp",
  binding: ReturnType<typeof quoteBinding> | undefined,
) {
  await enqueueApprovalIntentWithGate(
    {
      sessionId: SESSION_ID,
      missionId: null,
      missionRunId: null,
      permission: "restricted",
      toolName: "kyberswap__swap__execute",
      toolArgs: { chain: "base", amountIn: "10" },
      toolCallId: "call-1",
      result: resultWithQuote(binding),
      toolContext: buildProjectToolContext(scope()),
      intentActionKind: "user_wallet_broadcast",
      origin,
      ...(origin === "studio_mcp" ? { projectId: PROJECT_ID, scopeVersion: 4 } : {}),
    },
    async () => ({ kind: "clear" }),
  );
  const envelope = enqueueWith.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
  if (envelope === undefined) throw new Error("no envelope was stored");
  const intent = createWith.mock.calls[0]?.[1] as { requestDigest: string } | undefined;
  if (intent === undefined) throw new Error("no intent row was written");
  return { envelope, requestDigest: intent.requestDigest };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the stored envelope names the approved quote", () => {
  for (const origin of ["agent", "studio_mcp"] as const) {
    it(`binds id, digest, floor and expiry on the ${origin} lane`, async () => {
      const { envelope } = await enqueue(origin, quoteBinding());

      expect(envelope.quoteAuthority).toEqual({
        v: APPROVED_QUOTE_AUTHORITY_VERSION,
        snapshotId: "prequote-q1",
        digest: "a".repeat(64),
        approvedMinOutRaw: "990000000000000000",
        expiresAt: "2026-08-28T10:00:00.000Z",
      });
      // ...and the resume reads back exactly that.
      expect(readApprovalQuoteAuthority(envelope)?.snapshotId).toBe("prequote-q1");
    });

    it(`the ${origin} lane's request digest COVERS the bound quote`, async () => {
      const first = await enqueue(origin, quoteBinding());
      vi.clearAllMocks();
      const second = await enqueue(origin, quoteBinding({ snapshotId: "prequote-q2" }));

      expect(second.requestDigest).not.toBe(first.requestDigest);
    });
  }

  it("is PRIVATE - it is a sibling of the call, never an argument", async () => {
    const { envelope } = await enqueue("agent", quoteBinding());

    const args = envelope.args as Record<string, unknown>;
    expect(JSON.stringify(args)).not.toContain("prequote-q1");
    expect(JSON.stringify(args)).not.toContain("quoteAuthority");
  });

  it("a call with no matched quote stores no binding, and nothing else changes", async () => {
    const { envelope } = await enqueue("agent", undefined);

    expect(envelope.quoteAuthority).toBeUndefined();
    expect(readApprovalQuoteAuthority(envelope)).toBeNull();
  });
});

describe("reading a stored binding back", () => {
  const authority = approvedQuoteAuthorityFrom({
    snapshotId: "prequote-q1",
    digest: "b".repeat(64),
    approvedMinOutRaw: "5",
    expiresAt: "2026-08-28T10:00:00.000Z",
  });

  it("round-trips through the envelope for a non-protocol lane too", () => {
    const envelope = buildApprovalToolCall("wallet_send", { amount: "1" }, undefined, authority);
    expect(readApprovalQuoteAuthority(envelope)).toEqual(authority);
  });

  it("changes the digest, so a co-edited envelope cannot agree with it", () => {
    const bound = buildApprovalToolCall("wallet_send", { amount: "1" }, undefined, authority);
    const unbound = buildApprovalToolCall("wallet_send", { amount: "1" });
    expect(computeRequestDigest(bound)).not.toBe(computeRequestDigest(unbound));
  });

  it("reads a malformed or absent block as null rather than throwing", () => {
    expect(readApprovalQuoteAuthority({ quoteAuthority: { snapshotId: 7 } })).toBeNull();
    expect(readApprovalQuoteAuthority({ quoteAuthority: null })).toBeNull();
    expect(readApprovalQuoteAuthority({})).toBeNull();
  });
});
