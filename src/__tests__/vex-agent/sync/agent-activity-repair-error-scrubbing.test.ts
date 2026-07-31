/**
 * agent-activity-repair — provider exception logging (FIX5-SPINE, Codex
 * final-review round 4 finding 2).
 *
 * `repairPendingActivity`'s `checkReceiptByHash` catch block used to log a bare
 * `redact(err.message)` — that only redacts KNOWN SECRET SHAPES (keys/JWTs/mnemonics/addresses), not
 * the structured provider internals (URLs, request/response bodies, auth
 * headers) `summarizeProtocolError` exists to strip. It now routes through the
 * canonical `summarizeProtocolError(err).message` boundary. The sibling
 * decoder-throw catch is gone with the settlement decoders themselves — the
 * sweep is status-only and decodes nothing. This
 * is a mocked-dependency unit test (no DB, no signer) — the dedicated W0
 * integration suite (`src/__tests__/integration/agent-scan/repair-sweep.int.test.ts`)
 * covers the sweep's DB-level behavior separately and is not touched here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import logger from "@utils/logger.js";
import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";

const mockListPendingOlderThan = vi.fn();
const mockConfirmActivityEvent = vi.fn();
const mockFailActivityEvent = vi.fn();
const mockTouchLastChecked = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  listPendingOlderThan: (...args: unknown[]) => mockListPendingOlderThan(...args),
  confirmActivityEvent: (...args: unknown[]) => mockConfirmActivityEvent(...args),
  failActivityEvent: (...args: unknown[]) => mockFailActivityEvent(...args),
  confirmActivityEventStatusOnly: vi.fn(),
  touchLastChecked: (...args: unknown[]) => mockTouchLastChecked(...args),
}));

const { repairPendingActivity } = await import("@vex-agent/sync/agent-activity-repair.js");

function candidateEvent(overrides: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  return {
    id: 1,
    protocolExecutionId: 42,
    eventIndex: 0,
    eventRole: "swap",
    recordVersion: 1,
    kind: "swap",
    protocol: "kyberswap",
    chainId: 8453,
    chainSlug: "base",
    status: "pending",
    failureCode: null,
    failureReason: null,
    tokenInAddress: "0xIN",
    tokenInSymbol: "USDC",
    tokenInDecimals: 6,
    amountInHuman: "10",
    amountInRaw: "10000000",
    tokenOutAddress: "0xOUT",
    tokenOutSymbol: "WETH",
    tokenOutDecimals: 18,
    amountOutHuman: null,
    amountOutRaw: null,
    executedAmountInHuman: null,
    executedAmountInRaw: null,
    executedAmountOutHuman: null,
    executedAmountOutRaw: null,
    usdInEst: null,
    usdOutEst: null,
    usdFeeEst: null,
    usdSource: null,
    txHash: "0xHASH",
    fromAddress: "0xFROM",
    nonce: 1,
    walletAddress: "0xWALLET",
    sessionId: "00000000-0000-4000-8000-000000000001",
    routeProvenance: null,
    submitAttemptedAt: "2026-07-23T09:00:00.000Z",
    broadcastAt: "2026-07-23T09:00:01.000Z",
    confirmedAt: null,
    lastCheckedAt: null,
    createdAt: "2026-07-23T09:00:00.000Z",
    updatedAt: "2026-07-23T09:00:01.000Z",
    ...overrides,
  };
}

// Canary text carrying every shape summarizeProtocolError must strip: a
// credential-bearing URL, an Authorization/Bearer header, and a JSON body.
const CANARY_MESSAGE =
  'Provider 500 https://user:p4ssw0rd@api.provider.io/v1?key=SECRET123 '
  + 'Authorization: Bearer ROUND_CANARY_9f2a body={"error":{"code":401}}';
const CANARY_FRAGMENTS = [
  "p4ssw0rd", "SECRET123", "api.provider.io", "https://",
  "ROUND_CANARY_9f2a", "Bearer", '"error"', '"code"',
];

describe("agent-activity-repair — provider error scrubbing (FIX5-SPINE)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("lookup_failed: a thrown receipt-lookup error is logged through summarizeProtocolError, never raw", async () => {
    mockListPendingOlderThan.mockResolvedValueOnce([candidateEvent()]);
    const deps = {
      checkReceiptByHash: vi.fn().mockRejectedValueOnce(new Error(CANARY_MESSAGE)),
    };

    const result = await repairPendingActivity(deps);
    expect(result.stillPending).toBe(1);

    const call = warnSpy.mock.calls.find((c) => c[0] === "agent_activity.repair.lookup_failed");
    expect(call).toBeDefined();
    const payload = call?.[1] as Record<string, unknown> | undefined;
    expect(typeof payload?.error).toBe("string");
    for (const fragment of CANARY_FRAGMENTS) {
      expect(payload?.error).not.toContain(fragment);
    }
  });

});
