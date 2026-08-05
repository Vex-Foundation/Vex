/**
 * The attribution sweep's CONTRACT.
 *
 *   1. IT NEVER SIGNS. Its whole dependency surface is one keyless POST; the
 *      signature is produced once, by the launch handler, while the launch's own
 *      signing clients are open.
 *   2. A ROW WITH NO SIGNATURE IS A NAMED GAP, not a retry. Retrying it would be
 *      a loop that can only fail; hiding it would be worse.
 *   3. EVERY OUTCOME IS NAMED AND LOGGED with the provider's own words. A
 *      generic failure makes a 403 from the wrong wallet indistinguishable from
 *      a network blip (owner decree 2026-08-02).
 *   4. NOTHING THROWS OUT. It shares the sync worker's drain with balance and
 *      activity sync.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockClaim = vi.fn();
const mockMarkAttributed = vi.fn();
const mockCountGap = vi.fn();

vi.mock("@vex-agent/db/repos/launched-tokens.js", () => ({
  claimAttributionCandidates: (...a: unknown[]) => mockClaim(...a),
  markAttributed: (...a: unknown[]) => mockMarkAttributed(...a),
  countUnsignedAttributionGap: (...a: unknown[]) => mockCountGap(...a),
}));

const warn = vi.fn();
const info = vi.fn();
vi.mock("@utils/logger.js", () => ({
  default: { warn: (...a: unknown[]) => warn(...a), info: (...a: unknown[]) => info(...a), debug: vi.fn(), error: vi.fn() },
}));

const {
  attributeLaunchedTokens,
  LAUNCH_ATTRIBUTION_BATCH_LIMIT,
  LAUNCH_ATTRIBUTION_RETRY_SECONDS,
} = await import("../../../vex-agent/sync/launch-attribution.js");

const SIGNATURE = `0x${"ab".repeat(65)}`;

function candidate(id: number) {
  return {
    id,
    chainId: 4663,
    tokenAddress: `0x${String(id).padStart(40, "0")}`,
    attestSignature: SIGNATURE,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClaim.mockResolvedValue([]);
  mockMarkAttributed.mockResolvedValue(true);
  mockCountGap.mockResolvedValue(0);
});

describe("candidate selection", () => {
  it("claims Trench-chain rows only, in a bounded batch, with the retry window", async () => {
    await attributeLaunchedTokens({ attribute: vi.fn() });
    expect(mockClaim).toHaveBeenCalledWith({
      chainId: 4663,
      limit: LAUNCH_ATTRIBUTION_BATCH_LIMIT,
      retryAfterSeconds: LAUNCH_ATTRIBUTION_RETRY_SECONDS,
    });
  });

  it("is a no-op with no eligible rows — no POST, no writes", async () => {
    const attribute = vi.fn();
    const result = await attributeLaunchedTokens({ attribute });
    expect(attribute).not.toHaveBeenCalled();
    expect(mockMarkAttributed).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 0, attributed: 0 });
  });

  it("logs the backlog when the batch came back full", async () => {
    mockClaim.mockResolvedValue(
      Array.from({ length: LAUNCH_ATTRIBUTION_BATCH_LIMIT }, (_v, i) => candidate(i + 1)),
    );
    await attributeLaunchedTokens({ attribute: vi.fn().mockResolvedValue({ kind: "attributed" }) });
    expect(info).toHaveBeenCalledWith("trench.launch_attribution.batch_full", expect.anything());
  });
});

describe("outcomes", () => {
  it("marks a confirmed badge attributed", async () => {
    mockClaim.mockResolvedValue([candidate(1)]);
    const attribute = vi.fn().mockResolvedValue({ kind: "attributed" });

    const result = await attributeLaunchedTokens({ attribute });

    expect(attribute).toHaveBeenCalledWith({
      tokenAddress: candidate(1).tokenAddress,
      attestSignature: SIGNATURE,
    });
    expect(mockMarkAttributed).toHaveBeenCalledWith(1);
    expect(result).toMatchObject({ checked: 1, attributed: 1, rejected: 0, transportFailed: 0 });
  });

  it("logs a refusal with the provider's own status and words, and marks nothing", async () => {
    mockClaim.mockResolvedValue([candidate(1)]);
    const attribute = vi.fn().mockResolvedValue({
      kind: "rejected",
      status: 403,
      detail: "signature is not from the creator",
    });

    const result = await attributeLaunchedTokens({ attribute });

    expect(mockMarkAttributed).not.toHaveBeenCalled();
    expect(result).toMatchObject({ rejected: 1 });
    expect(warn).toHaveBeenCalledWith("trench.launch_attribution.rejected", {
      id: 1,
      status: 403,
      detail: "signature is not from the creator",
    });
  });

  it("counts an ambiguous transport failure separately from a refusal", async () => {
    mockClaim.mockResolvedValue([candidate(1)]);
    const result = await attributeLaunchedTokens({
      attribute: vi.fn().mockResolvedValue({ kind: "transport_failed", detail: "HTTP_TIMEOUT" }),
    });
    expect(result).toMatchObject({ rejected: 0, transportFailed: 1 });
  });

  it("contains a throwing dependency — one bad row never aborts the batch", async () => {
    mockClaim.mockResolvedValue([candidate(1), candidate(2)]);
    const attribute = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ kind: "attributed" });

    const result = await attributeLaunchedTokens({ attribute });

    expect(result).toMatchObject({ checked: 2, attributed: 1, transportFailed: 1 });
  });
});

describe("the unsigned gap", () => {
  it("is counted and named once per pass, and never retried", async () => {
    mockCountGap.mockResolvedValue(3);
    const attribute = vi.fn();

    const result = await attributeLaunchedTokens({ attribute });

    expect(attribute).not.toHaveBeenCalled();
    expect(result.unsignedGap).toBe(3);
    const gapLogs = info.mock.calls.filter((c) => c[0] === "trench.launch_attribution.unsigned_gap");
    expect(gapLogs).toHaveLength(1);
    expect(gapLogs[0]![1]).toMatchObject({ count: 3 });
  });

  it("says nothing when there is no gap", async () => {
    await attributeLaunchedTokens({ attribute: vi.fn() });
    expect(info).not.toHaveBeenCalledWith(
      "trench.launch_attribution.unsigned_gap",
      expect.anything(),
    );
  });
});
