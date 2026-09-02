/**
 * The repair sweep judges a repaired fill against the floor the human approved
 * - and can repair a UNISWAP row at all.
 *
 * ## The two gaps this file pins
 *
 * 1. `venue-dispatch.ts` had no `uniswap` branch. Every Uniswap row that
 *    confirmed without amounts - the crash window between broadcast and decode,
 *    or a receipt this process never watched - declined forever with "no
 *    settlement decoder is wired", while the venue's own decoder sat exported
 *    and unused two directories away.
 * 2. Neither venue's REPAIRED settlement was assessed against
 *    `approvedMinOutRaw`, although both immediate paths do it. The fills nobody
 *    was watching were exactly the fills nobody checked.
 *
 * The decode is REAL on the Uniswap side: the amounts below are read from
 * `Transfer` logs by `decodeUniswapExecutedLegs`, the same function the
 * immediate path runs. Only the database, the RPC and the sibling venue's
 * decoder are mocked.
 *
 * The allowance boundary is pinned deliberately: `assessApprovedFloor` tolerates
 * exactly one raw unit (KyberSwap's measured `/route/build` rederivation lands
 * one wei under), so a fill at floor-minus-one is SILENT and a fill two under is
 * named. A tolerance that quietly widened would fail the second case.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";

const mockListCandidates = vi.fn();
const mockFill = vi.fn();
const mockDeclined = vi.fn();
const mockNoteVersion = vi.fn();
const mockListLegs = vi.fn();
const mockTouch = vi.fn();
const mockDecodeKyber = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listAmountCorrectionCandidates: (...a: unknown[]) => mockListCandidates(...a),
    fillExecutedAmountsOnConfirmed: (...a: unknown[]) => mockFill(...a),
    noteSettlementDeclined: (...a: unknown[]) => mockDeclined(...a),
    noteSettlementDecodeVersion: (...a: unknown[]) => mockNoteVersion(...a),
    listActivityLegsByExecutionId: (...a: unknown[]) => mockListLegs(...a),
    touchAmountCorrectionChecked: (...a: unknown[]) => mockTouch(...a),
  };
});

// The SIBLING venue's decoder is a boundary here, not the subject: this file is
// about the floor assessment that runs after ANY venue decoded.
vi.mock("@tools/kyberswap/evm-utils.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, decodeKyberSwapSettlement: (...a: unknown[]) => mockDecodeKyber(...a) };
});

const warn = vi.fn();
vi.mock("@utils/logger.js", () => {
  const stub = { warn: (...a: unknown[]) => warn(...a), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { repairMissingExecutedAmounts } = await import("@vex-agent/sync/executed-amount-fallback.js");

const WALLET = "0x1111111111111111111111111111111111111111";
const TOKEN_IN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TOKEN_OUT = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";
const TX = "0x5wapped";
const CHAIN_ID = 8453;

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const AMOUNT_IN = 1_000_000n;
/** What the fill actually delivered. */
const DELIVERED = 900_000n;

function padded(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}
function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
function transferLog(from: string, to: string, amount: bigint, token: string) {
  return { address: token, topics: [TRANSFER_TOPIC, padded(from), padded(to)], data: word(amount) };
}

/** The receipt of a plain ERC-20 -> ERC-20 swap by this wallet. */
const SWAP_LOGS = [
  transferLog(WALLET, "0x2222222222222222222222222222222222222222", AMOUNT_IN, TOKEN_IN),
  transferLog("0x2222222222222222222222222222222222222222", WALLET, DELIVERED, TOKEN_OUT),
];

function swapRow(over: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  return {
    id: 77,
    protocolExecutionId: 900,
    eventIndex: 0,
    eventRole: "swap",
    protocol: "uniswap",
    chainId: CHAIN_ID,
    chainFamily: "eip155",
    status: "confirmed",
    txHash: TX,
    walletAddress: WALLET,
    tokenInAddress: TOKEN_IN,
    tokenOutAddress: TOKEN_OUT,
    tokenOutSymbol: "TKN",
    amountInRaw: AMOUNT_IN.toString(),
    executedAmountInRaw: null,
    executedAmountOutRaw: null,
    tokenIn2Address: null,
    tokenOut2Address: null,
    executedAmountIn2Raw: null,
    executedAmountOut2Raw: null,
    routeProvenance: null,
    ...over,
  } as AgentActivityEvent;
}

function deps(logs: unknown) {
  return {
    fetchReceiptLogs: vi.fn().mockResolvedValue(logs),
    fetchTransaction: vi.fn(async () => null),
    fetchReceiptStatus: vi.fn().mockResolvedValue("success" as const),
  };
}

/** The one structured warn this feature emits, or `undefined`. */
function floorWarn(): [string, Record<string, unknown>] | undefined {
  return warn.mock.calls.find((c) => c[0] === "sync.amount_fallback.fill_below_approved_floor") as
    [string, Record<string, unknown>] | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFill.mockResolvedValue({ outcome: "applied", row: swapRow() });
  mockDeclined.mockResolvedValue({ applied: true });
  mockListLegs.mockResolvedValue([]);
  mockNoteVersion.mockResolvedValue(undefined);
});

describe("the uniswap venue branch", () => {
  it("repairs a uniswap row from its own receipt instead of declining it unwired", async () => {
    mockListCandidates.mockResolvedValue([swapRow()]);

    const result = await repairMissingExecutedAmounts(deps(SWAP_LOGS));

    expect(result).toMatchObject({ checked: 1, filled: 1, declined: 0 });
    expect(mockFill).toHaveBeenCalledWith({
      id: 77,
      expectedTxHash: TX,
      expectedChainId: CHAIN_ID,
      amounts: {
        executedAmountInRaw: AMOUNT_IN.toString(),
        executedAmountOutRaw: DELIVERED.toString(),
      },
    });
    expect(mockDeclined).not.toHaveBeenCalled();
  });

  it("declines by name when the receipt proves only one leg", async () => {
    mockListCandidates.mockResolvedValue([swapRow()]);

    const result = await repairMissingExecutedAmounts(deps([SWAP_LOGS[0]]));

    expect(result).toMatchObject({ filled: 0, declined: 1 });
    expect(mockDeclined).toHaveBeenCalledWith(77, "amounts_undecodable");
  });
});

describe("the approved floor, on the REPAIR path", () => {
  it("names a uniswap fill that landed below the floor the human approved", async () => {
    mockListCandidates.mockResolvedValue([swapRow({
      routeProvenance: { approvedMinOutRaw: "950000" },
    })]);

    await repairMissingExecutedAmounts(deps(SWAP_LOGS));

    const emitted = floorWarn();
    expect(emitted).toBeDefined();
    expect(emitted?.[1]).toMatchObject({ id: 77, protocol: "uniswap", shortfallRaw: "50000" });
    expect(String(emitted?.[1].verdict)).toContain("below the approved floor");
    expect(String(emitted?.[1].verdict)).toContain("TKN");
    // DETECTION ONLY: the amounts were still written, and nothing was declined.
    expect(mockFill).toHaveBeenCalled();
    expect(mockDeclined).not.toHaveBeenCalled();
  });

  it("names a kyberswap fill the same way - the rule is venue-independent", async () => {
    mockDecodeKyber.mockReturnValue({
      amountInRaw: AMOUNT_IN.toString(),
      amountOutRaw: DELIVERED.toString(),
    });
    mockListCandidates.mockResolvedValue([swapRow({
      protocol: "kyberswap",
      routeProvenance: { approvedMinOutRaw: "950000" },
    })]);

    await repairMissingExecutedAmounts(deps(SWAP_LOGS));

    const emitted = floorWarn();
    expect(emitted?.[1]).toMatchObject({ protocol: "kyberswap", shortfallRaw: "50000" });
  });

  it("is SILENT at the floor minus one raw unit - the measured rederivation allowance", async () => {
    mockListCandidates.mockResolvedValue([swapRow({
      routeProvenance: { approvedMinOutRaw: (DELIVERED + 1n).toString() },
    })]);

    await repairMissingExecutedAmounts(deps(SWAP_LOGS));

    expect(floorWarn()).toBeUndefined();
  });

  it("names it two raw units under, so the allowance cannot quietly widen", async () => {
    mockListCandidates.mockResolvedValue([swapRow({
      routeProvenance: { approvedMinOutRaw: (DELIVERED + 2n).toString() },
    })]);

    await repairMissingExecutedAmounts(deps(SWAP_LOGS));

    expect(floorWarn()?.[1]).toMatchObject({ shortfallRaw: "2" });
  });

  it("stays silent for a row that never recorded a floor", async () => {
    mockListCandidates.mockResolvedValue([swapRow({ routeProvenance: { version: "v2" } })]);

    await repairMissingExecutedAmounts(deps(SWAP_LOGS));

    expect(floorWarn()).toBeUndefined();
    expect(mockFill).toHaveBeenCalled();
  });
});
