/**
 * STAGE F — the amount-correction fallback, and the boundary it must not cross.
 *
 * The acceptance case is the owner's own class of row: CONFIRMED, mined
 * `success`, and showing a QUOTE labelled "estimated" forever because the
 * decoder of the day declined that receipt shape and nothing ever asked again.
 *
 * What is pinned here:
 *
 * 1. **A LEGACY row is repaired.** It carries no `settlementDecode` hint — only
 *    `{routeID, checksum}` — so a hint-gated fallback would have excluded the
 *    exact transaction that motivated this workstream. Inputs come from
 *    validated columns plus repo constants, and nothing is guessed.
 * 2. **The role contract is IMPORTED, not restated.** A `yield_claim` has no
 *    input leg and is COMPLETE; the SQL prefilter must not be the decision.
 * 3. **The marker is written only after a COMPLETED decline** — never before the
 *    attempt (crash poison) and never on a fill.
 * 4. **An unreadable receipt is not a decline.** Nothing was learned, so the row
 *    keeps its eligibility rather than burning it on a transport failure.
 * 5. **A conflict is SURFACED, never merged.** Two readings of the same money
 *    disagreeing is a defect to report, not to resolve by last-write-wins.
 * 6. **An unmapped protocol declines BY NAME** rather than falling through to a
 *    "generic" decode — which was disproven on the owner's own swap.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";

const mockListCandidates = vi.fn();
const mockFill = vi.fn();
const mockDeclined = vi.fn();
const mockNoteVersion = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listAmountCorrectionCandidates: (...a: unknown[]) => mockListCandidates(...a),
    fillExecutedAmountsOnConfirmed: (...a: unknown[]) => mockFill(...a),
    noteSettlementDeclined: (...a: unknown[]) => mockDeclined(...a),
    noteSettlementDecodeVersion: (...a: unknown[]) => mockNoteVersion(...a),
  };
});

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { repairMissingExecutedAmounts, SETTLEMENT_DECODER_SET_VERSION } = await import(
  "@vex-agent/sync/executed-amount-fallback.js"
);

const FIXTURE = JSON.parse(
  readFileSync(
    new URL(
      "../../tools/kyberswap/fixtures/base-native-settlement-receipts.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as Record<string, { from: string; to: string; logs: { address: string; topics: string[]; data: string }[] }>;

const KYBER = FIXTURE.kyber_usdc_to_native_eth_base;
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/** A confirmed row with no executed amounts — and, like the owner's, NO decode hint. */
function legacyRow(over: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  return {
    id: 7,
    eventRole: "swap",
    protocol: "kyberswap",
    chainId: 8453,
    chainFamily: "eip155",
    status: "confirmed",
    txHash: "0x70d262092f63618a37f1c5ce61f0092f78b9fdece49c5f22416c32a915c3ed65",
    walletAddress: KYBER.from,
    tokenInAddress: BASE_USDC,
    tokenOutAddress: NATIVE,
    executedAmountInRaw: null,
    executedAmountOutRaw: null,
    tokenIn2Address: null,
    tokenOut2Address: null,
    executedAmountIn2Raw: null,
    executedAmountOut2Raw: null,
    // The owner's own row's provenance: a route id and a checksum, nothing more.
    routeProvenance: { routeID: "abc", checksum: "def" },
    ...over,
  } as AgentActivityEvent;
}

function deps(logs: unknown = KYBER.logs) {
  return { fetchReceiptLogs: vi.fn().mockResolvedValue(logs) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFill.mockResolvedValue({ outcome: "applied", row: legacyRow() });
  mockDeclined.mockResolvedValue({ applied: true });
});

describe("the legacy amountless-confirmed row — the acceptance case", () => {
  it("decodes and FILLS it, with no persisted decode hint at all", async () => {
    mockListCandidates.mockResolvedValue([legacyRow()]);

    const result = await repairMissingExecutedAmounts(deps());

    expect(result).toMatchObject({ checked: 1, filled: 1, declined: 0 });
    expect(mockFill).toHaveBeenCalledWith({
      id: 7,
      // Bound to the row's OWN hash and chain: a decode of the wrong
      // transaction can never land on it.
      expectedTxHash: legacyRow().txHash,
      expectedChainId: 8453,
      amounts: {
        executedAmountInRaw: "4000000",
        executedAmountOutRaw: "2149469568496706",
      },
    });
  });

  it("does NOT mark the decode version on a successful fill", async () => {
    mockListCandidates.mockResolvedValue([legacyRow()]);

    await repairMissingExecutedAmounts(deps());

    // The row stops being a candidate because its legs are now complete. A
    // second, redundant reason could outlive the first.
    expect(mockNoteVersion).not.toHaveBeenCalled();
  });
});

describe("the role contract is imported, never restated", () => {
  it("skips a yield_claim whose OUTPUT leg is present — it legitimately has no input leg", async () => {
    mockListCandidates.mockResolvedValue([
      legacyRow({ eventRole: "yield_claim", executedAmountOutRaw: "123" }),
    ]);

    const result = await repairMissingExecutedAmounts(deps());

    expect(result.checked).toBe(0);
    expect(mockFill).not.toHaveBeenCalled();
    expect(mockDeclined).not.toHaveBeenCalled();
  });
});

describe("declines are named, and only then marked", () => {
  it("declines by name for a protocol with no wired decoder — never a generic decode", async () => {
    mockListCandidates.mockResolvedValue([legacyRow({ protocol: "jupiter" })]);

    const result = await repairMissingExecutedAmounts(deps());

    expect(result.declined).toBe(1);
    expect(mockDeclined).toHaveBeenCalledWith(7, "amounts_undecodable");
    expect(mockNoteVersion).toHaveBeenCalledWith(7, SETTLEMENT_DECODER_SET_VERSION);
  });

  it("declines when the receipt's evidence does not establish both legs", async () => {
    mockListCandidates.mockResolvedValue([legacyRow()]);

    const result = await repairMissingExecutedAmounts(deps([]));

    expect(result.declined).toBe(1);
    expect(mockDeclined).toHaveBeenCalledWith(7, "amounts_undecodable");
  });

  it("an UNREADABLE receipt is NOT a decline — the row keeps its eligibility", async () => {
    mockListCandidates.mockResolvedValue([legacyRow()]);

    const result = await repairMissingExecutedAmounts(deps(null));

    expect(result).toMatchObject({ declined: 0, deferred: 1 });
    // Marking here would burn the row's eligibility on a transport failure.
    expect(mockNoteVersion).not.toHaveBeenCalled();
    expect(mockDeclined).not.toHaveBeenCalled();
  });
});

describe("a disagreement about money is surfaced, never merged", () => {
  it("reports a conflict and writes no amount", async () => {
    mockListCandidates.mockResolvedValue([legacyRow()]);
    mockFill.mockResolvedValue({ outcome: "conflict", row: legacyRow() });

    const result = await repairMissingExecutedAmounts(deps());

    expect(result.conflicted).toBe(1);
    expect(result.filled).toBe(0);
  });
});

describe("the candidate query is asked for the CURRENT decoder set", () => {
  it("passes the version, so a decoder change makes declined rows eligible again", async () => {
    mockListCandidates.mockResolvedValue([]);

    await repairMissingExecutedAmounts(deps(), 5);

    expect(mockListCandidates).toHaveBeenCalledWith(5, SETTLEMENT_DECODER_SET_VERSION);
  });
});
