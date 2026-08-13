/**
 * STAGE F, the venue branches: the rows the status sweep confirmed before their
 * handler could prove an amount.
 *
 * Three questions are pinned here, and each has cost a real row its amounts:
 *
 * 1. A bridge deposit's proof must be REBUILT, never assumed: the mined signed
 *    transaction supplies the sender and the call target, and this execution's
 *    own earlier allowance rows - re-read from their own `approve` transactions
 *    and replayed in order - supply the token-bound spenders. A spender approved
 *    for another token, or one whose allowance was reset to zero, authorizes
 *    nothing, and a transfer above the effective allowance is not the deposit.
 * 2. A Trench BUY's input is the value the transaction ACTUALLY carried, read
 *    from chain. The persisted `declaredValueRaw` is what we meant to sign, and
 *    a disagreement between the two is a discrepancy, not a settlement.
 * 3. A read that does not answer DEFERS. It must never be stamped with the
 *    decoder version, because that would exclude the row until the decoder
 *    changes - a permanent loss caused by a transport hiccup.
 *
 * TIMING, stated because it is invisible in the code: this lane must reach a row
 * inside the outbox's 15-minute confirmed-hold grace. Before the grace expires
 * the terminal event has not been sent, so a fill still travels with it. AFTER
 * the terminal (id, status) pair has been enqueued and pushed, a local late fill
 * repairs the LOCAL row only: the server silently drops duplicate terminal
 * events, so the amounts of an already-reported event cannot be corrected from
 * this client at all.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex } from "viem";
import { TRENCH_DIAMOND_ABI } from "@tools/trench-express/abi.js";

import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";

const mockListCandidates = vi.fn();
const mockFill = vi.fn();
const mockDeclined = vi.fn();
const mockNoteVersion = vi.fn();
const mockListLegs = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listAmountCorrectionCandidates: (...a: unknown[]) => mockListCandidates(...a),
    fillExecutedAmountsOnConfirmed: (...a: unknown[]) => mockFill(...a),
    noteSettlementDeclined: (...a: unknown[]) => mockDeclined(...a),
    noteSettlementDecodeVersion: (...a: unknown[]) => mockNoteVersion(...a),
    listActivityLegsByExecutionId: (...a: unknown[]) => mockListLegs(...a),
  };
});

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { repairMissingExecutedAmounts } = await import("@vex-agent/sync/executed-amount-fallback.js");

const WALLET = "0x1111111111111111111111111111111111111111";
const TOKEN = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";
const OTHER_TOKEN = "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984";
const DEPOSITORY = "0x2222222222222222222222222222222222222222";
const SPENDER = "0x4444444444444444444444444444444444444444";
const DIAMOND = "0x3857c6c4FE93Abb40945dfc8B9d690384cBae014";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const DEPOSIT_HASH = "0xdeb0517";
const APPROVE_HASH = "0xa9930f7";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** The Diamond's own `Bought`/`Sold` event, encoded from the verified ABI. */
function curveEventLog(name: "Bought" | "Sold", v1: bigint, v2: bigint): { address: string; topics: string[]; data: string } {
  const [topic0] = encodeEventTopics({ abi: TRENCH_DIAMOND_ABI, eventName: name }) as [Hex];
  return {
    address: DIAMOND,
    topics: [topic0],
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [getAddress(WALLET), getAddress(TOKEN), v1, v2, 0n],
    ),
  };
}

function padded(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}
function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
function transferLog(from: string, to: string, amount: bigint, token = TOKEN) {
  return { address: token, topics: [TRANSFER_TOPIC, padded(from), padded(to)], data: word(amount) };
}
function approveCalldata(spender: string, amount: bigint): string {
  return `0x095ea7b3${padded(spender).slice(2)}${amount.toString(16).padStart(64, "0")}`;
}

function depositRow(over: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  return {
    id: 11,
    protocolExecutionId: 500,
    eventIndex: 2,
    eventRole: "bridge_deposit",
    protocol: "relay",
    chainId: 8453,
    chainFamily: "eip155",
    status: "confirmed",
    txHash: DEPOSIT_HASH,
    walletAddress: WALLET,
    tokenInAddress: TOKEN,
    tokenOutAddress: NATIVE,
    amountInRaw: "1000000",
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

function allowanceLeg(over: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
  return {
    id: 10,
    protocolExecutionId: 500,
    eventIndex: 1,
    eventRole: "allowance",
    protocol: "relay",
    chainId: 8453,
    status: "confirmed",
    txHash: APPROVE_HASH,
    walletAddress: WALLET,
    ...over,
  } as AgentActivityEvent;
}

/** Deps whose transaction reads are keyed by hash; anything else reads as unreadable. */
function deps(args: {
  logs: unknown;
  transactions?: Record<string, { from: string; to: string | null; input: string; valueRaw: string }>;
}) {
  return {
    fetchReceiptLogs: vi.fn().mockResolvedValue(args.logs),
    fetchTransaction: vi.fn(async ({ txHash }: { txHash: string }) =>
      args.transactions?.[txHash] ?? null),
  };
}

const depositTx = { from: WALLET, to: DEPOSITORY, input: "0xdeadbeef", valueRaw: "0" };

beforeEach(() => {
  vi.clearAllMocks();
  mockFill.mockResolvedValue({ outcome: "applied", row: depositRow() });
  mockDeclined.mockResolvedValue({ applied: true });
  mockListLegs.mockResolvedValue([]);
});

describe("the crash-window bridge deposit", () => {
  it("fills the amount its receipt proves, paid to the call target", async () => {
    mockListCandidates.mockResolvedValue([depositRow()]);

    const result = await repairMissingExecutedAmounts(deps({
      logs: [transferLog(WALLET, DEPOSITORY, 999_000n)],
      transactions: { [DEPOSIT_HASH]: depositTx },
    }));

    expect(result).toMatchObject({ checked: 1, filled: 1 });
    expect(mockFill).toHaveBeenCalledWith({
      id: 11,
      expectedTxHash: DEPOSIT_HASH,
      expectedChainId: 8453,
      amounts: { executedAmountInRaw: "999000" },
    });
  });

  it("works for khalani rows too - the rule is the venue-independent one", async () => {
    mockListCandidates.mockResolvedValue([depositRow({ protocol: "khalani" })]);

    await repairMissingExecutedAmounts(deps({
      logs: [transferLog(WALLET, DEPOSITORY, 999_000n)],
      transactions: { [DEPOSIT_HASH]: depositTx },
    }));

    expect(mockFill).toHaveBeenCalledWith(expect.objectContaining({
      amounts: { executedAmountInRaw: "999000" },
    }));
  });

  it("admits a spender this execution approved for the INPUT token", async () => {
    mockListCandidates.mockResolvedValue([depositRow()]);
    mockListLegs.mockResolvedValue([allowanceLeg(), depositRow()]);

    await repairMissingExecutedAmounts(deps({
      logs: [transferLog(WALLET, SPENDER, 800_000n)],
      transactions: {
        [DEPOSIT_HASH]: depositTx,
        [APPROVE_HASH]: { from: WALLET, to: TOKEN, input: approveCalldata(SPENDER, 900_000n), valueRaw: "0" },
      },
    }));

    expect(mockFill).toHaveBeenCalledWith(expect.objectContaining({
      amounts: { executedAmountInRaw: "800000" },
    }));
  });

  it("declines a transfer above that spender's effective allowance", async () => {
    mockListCandidates.mockResolvedValue([depositRow()]);
    mockListLegs.mockResolvedValue([allowanceLeg(), depositRow()]);

    const result = await repairMissingExecutedAmounts(deps({
      logs: [transferLog(WALLET, SPENDER, 950_000n)],
      transactions: {
        [DEPOSIT_HASH]: depositTx,
        [APPROVE_HASH]: { from: WALLET, to: TOKEN, input: approveCalldata(SPENDER, 900_000n), valueRaw: "0" },
      },
    }));

    expect(result).toMatchObject({ declined: 1, filled: 0 });
    expect(mockFill).not.toHaveBeenCalled();
    expect(mockDeclined).toHaveBeenCalledWith(11, "amounts_undecodable");
    expect(mockNoteVersion).toHaveBeenCalled();
  });

  it("declines a spender approved only for a DIFFERENT token", async () => {
    mockListCandidates.mockResolvedValue([depositRow()]);
    mockListLegs.mockResolvedValue([allowanceLeg(), depositRow()]);

    await repairMissingExecutedAmounts(deps({
      logs: [transferLog(WALLET, SPENDER, 800_000n)],
      transactions: {
        [DEPOSIT_HASH]: depositTx,
        [APPROVE_HASH]: { from: WALLET, to: OTHER_TOKEN, input: approveCalldata(SPENDER, 900_000n), valueRaw: "0" },
      },
    }));

    expect(mockFill).not.toHaveBeenCalled();
    expect(mockDeclined).toHaveBeenCalledWith(11, "amounts_undecodable");
  });

  it("declines a spender whose allowance a later approval reset to zero", async () => {
    mockListCandidates.mockResolvedValue([depositRow()]);
    mockListLegs.mockResolvedValue([
      allowanceLeg(),
      allowanceLeg({ id: 10.5 as unknown as number, eventIndex: 1.5, eventRole: "allowance_reset", txHash: "0xreset" }),
      depositRow(),
    ]);

    await repairMissingExecutedAmounts(deps({
      logs: [transferLog(WALLET, SPENDER, 800_000n)],
      transactions: {
        [DEPOSIT_HASH]: depositTx,
        [APPROVE_HASH]: { from: WALLET, to: TOKEN, input: approveCalldata(SPENDER, 900_000n), valueRaw: "0" },
        "0xreset": { from: WALLET, to: TOKEN, input: approveCalldata(SPENDER, 0n), valueRaw: "0" },
      },
    }));

    expect(mockFill).not.toHaveBeenCalled();
    expect(mockDeclined).toHaveBeenCalledWith(11, "amounts_undecodable");
  });

  it("ignores an approval that is NOT part of this execution's pre-deposit legs", async () => {
    mockListCandidates.mockResolvedValue([depositRow()]);
    // Same execution, but signed AFTER the deposit: it cannot have authorized it.
    mockListLegs.mockResolvedValue([depositRow(), allowanceLeg({ eventIndex: 3 })]);

    await repairMissingExecutedAmounts(deps({
      logs: [transferLog(WALLET, SPENDER, 800_000n)],
      transactions: {
        [DEPOSIT_HASH]: depositTx,
        [APPROVE_HASH]: { from: WALLET, to: TOKEN, input: approveCalldata(SPENDER, 900_000n), valueRaw: "0" },
      },
    }));

    expect(mockFill).not.toHaveBeenCalled();
    expect(mockDeclined).toHaveBeenCalledWith(11, "amounts_undecodable");
  });

  it("DEFERS when the signed transaction cannot be read - it never burns eligibility", async () => {
    mockListCandidates.mockResolvedValue([depositRow()]);

    const result = await repairMissingExecutedAmounts(deps({
      logs: [transferLog(WALLET, DEPOSITORY, 999_000n)],
      transactions: {},
    }));

    expect(result).toMatchObject({ deferred: 1, declined: 0, filled: 0 });
    expect(mockDeclined).not.toHaveBeenCalled();
    expect(mockNoteVersion).not.toHaveBeenCalled();
  });

  it("DEFERS when an approval transaction of the execution cannot be read", async () => {
    mockListCandidates.mockResolvedValue([depositRow()]);
    mockListLegs.mockResolvedValue([allowanceLeg(), depositRow()]);

    const result = await repairMissingExecutedAmounts(deps({
      logs: [transferLog(WALLET, DEPOSITORY, 999_000n)],
      transactions: { [DEPOSIT_HASH]: depositTx },
    }));

    expect(result).toMatchObject({ deferred: 1 });
    expect(mockDeclined).not.toHaveBeenCalled();
    expect(mockNoteVersion).not.toHaveBeenCalled();
  });

  it("declines when the mined transaction was sent by another wallet", async () => {
    mockListCandidates.mockResolvedValue([depositRow()]);

    await repairMissingExecutedAmounts(deps({
      logs: [transferLog(WALLET, DEPOSITORY, 999_000n)],
      transactions: { [DEPOSIT_HASH]: { ...depositTx, from: SPENDER } },
    }));

    expect(mockFill).not.toHaveBeenCalled();
    expect(mockDeclined).toHaveBeenCalledWith(11, "amounts_undecodable");
  });

  it("declines a NATIVE deposit leg - no ERC-20 transfer can prove it", async () => {
    mockListCandidates.mockResolvedValue([depositRow({ tokenInAddress: NATIVE })]);

    await repairMissingExecutedAmounts(deps({
      logs: [],
      transactions: { [DEPOSIT_HASH]: { ...depositTx, valueRaw: "5000" } },
    }));

    expect(mockFill).not.toHaveBeenCalled();
    expect(mockDeclined).toHaveBeenCalledWith(11, "amounts_undecodable");
  });
});

describe("the three interleavings of the two writers", () => {
  it("handler-first: the row is already complete, so the lane never looks at it", async () => {
    mockListCandidates.mockResolvedValue([
      depositRow({ executedAmountInRaw: "999000" }),
    ]);

    const result = await repairMissingExecutedAmounts(deps({
      logs: [transferLog(WALLET, DEPOSITORY, 999_000n)],
      transactions: { [DEPOSIT_HASH]: depositTx },
    }));

    // `roleLegsIncomplete` is the authoritative decision, and a bridge deposit
    // with its input leg present is complete.
    expect(result).toMatchObject({ checked: 0, filled: 0 });
    expect(mockFill).not.toHaveBeenCalled();
  });

  it("repair-first: the amounts land through the late-fill CAS and nothing else", async () => {
    mockListCandidates.mockResolvedValue([depositRow()]);

    await repairMissingExecutedAmounts(deps({
      logs: [transferLog(WALLET, DEPOSITORY, 999_000n)],
      transactions: { [DEPOSIT_HASH]: depositTx },
    }));

    expect(mockFill).toHaveBeenCalledTimes(1);
    // The lane owns amounts only: it never writes a status and never declines a
    // row it just filled.
    expect(mockDeclined).not.toHaveBeenCalled();
  });

  it("conflicting decoders: the writer quarantines and the lane reports it, never merges", async () => {
    mockListCandidates.mockResolvedValue([depositRow()]);
    mockFill.mockResolvedValue({ outcome: "conflict", row: depositRow() });

    const result = await repairMissingExecutedAmounts(deps({
      logs: [transferLog(WALLET, DEPOSITORY, 999_000n)],
      transactions: { [DEPOSIT_HASH]: depositTx },
    }));

    expect(result).toMatchObject({ conflicted: 1, filled: 0 });
    expect(mockDeclined).not.toHaveBeenCalled();
  });
});

describe("the trench branch", () => {
  function trenchBuyRow(over: Partial<AgentActivityEvent> = {}): AgentActivityEvent {
    return depositRow({
      id: 21,
      eventRole: "swap",
      protocol: "trench",
      chainId: 4663,
      tokenInAddress: NATIVE,
      tokenOutAddress: TOKEN,
      amountInRaw: "500000000000000",
      ...over,
    });
  }

  /** The `Bought` proof plus the token delivery the wallet actually received. */
  function boughtLogs(tokensOut: bigint) {
    return [curveEventLog("Bought", 500_000_000_000_000n, tokensOut), transferLog(DIAMOND, WALLET, tokensOut)];
  }

  it("takes the buy input from the ACTUAL signed value and the output from the receipt", async () => {
    mockListCandidates.mockResolvedValue([trenchBuyRow()]);

    await repairMissingExecutedAmounts(deps({
      logs: boughtLogs(197_913_781_308_210_736_292_461n),
      transactions: { [DEPOSIT_HASH]: { from: WALLET, to: DIAMOND, input: "0x", valueRaw: "500000000000000" } },
    }));

    expect(mockFill).toHaveBeenCalledWith(expect.objectContaining({
      amounts: {
        executedAmountInRaw: "500000000000000",
        executedAmountOutRaw: "197913781308210736292461",
      },
    }));
  });

  it("proves a sell from the receipt's own token leg and the Sold event that matches it", async () => {
    mockListCandidates.mockResolvedValue([sellRow()]);

    await repairMissingExecutedAmounts(deps({
      logs: [
        transferLog(WALLET, DIAMOND, 900_000n),
        curveEventLog("Sold", 784_080_000_000_000n, 900_000n),
      ],
      transactions: { [DEPOSIT_HASH]: { from: WALLET, to: DIAMOND, input: "0x", valueRaw: "0" } },
    }));

    expect(mockFill).toHaveBeenCalledWith(expect.objectContaining({
      amounts: {
        executedAmountInRaw: "900000",
        executedAmountOutRaw: "784080000000000",
      },
    }));
  });

  function sellRow() {
    return trenchBuyRow({ tokenInAddress: TOKEN, tokenOutAddress: NATIVE, amountInRaw: "1000000" });
  }
  const sellLogs = [
    transferLog(WALLET, DIAMOND, 900_000n),
    curveEventLog("Sold", 784_080_000_000_000n, 900_000n),
  ];

  it("declines a BUY whose transaction was sent by another wallet", async () => {
    mockListCandidates.mockResolvedValue([trenchBuyRow()]);

    await repairMissingExecutedAmounts(deps({
      logs: boughtLogs(1_000n),
      transactions: { [DEPOSIT_HASH]: { from: SPENDER, to: DIAMOND, input: "0x", valueRaw: "500000000000000" } },
    }));

    expect(mockFill).not.toHaveBeenCalled();
    expect(mockDeclined).toHaveBeenCalledWith(21, "amounts_undecodable");
  });

  it("declines a BUY whose transaction called something other than the trench diamond", async () => {
    mockListCandidates.mockResolvedValue([trenchBuyRow()]);

    await repairMissingExecutedAmounts(deps({
      logs: boughtLogs(1_000n),
      transactions: { [DEPOSIT_HASH]: { from: WALLET, to: DEPOSITORY, input: "0x", valueRaw: "500000000000000" } },
    }));

    expect(mockFill).not.toHaveBeenCalled();
    expect(mockDeclined).toHaveBeenCalledWith(21, "amounts_undecodable");
  });

  it("declines a SELL whose transaction was sent by another wallet", async () => {
    mockListCandidates.mockResolvedValue([sellRow()]);

    await repairMissingExecutedAmounts(deps({
      logs: sellLogs,
      transactions: { [DEPOSIT_HASH]: { from: SPENDER, to: DIAMOND, input: "0x", valueRaw: "0" } },
    }));

    expect(mockFill).not.toHaveBeenCalled();
    expect(mockDeclined).toHaveBeenCalledWith(21, "amounts_undecodable");
  });

  it("declines a SELL whose transaction called something other than the trench diamond", async () => {
    mockListCandidates.mockResolvedValue([sellRow()]);

    await repairMissingExecutedAmounts(deps({
      logs: sellLogs,
      transactions: { [DEPOSIT_HASH]: { from: WALLET, to: DEPOSITORY, input: "0x", valueRaw: "0" } },
    }));

    expect(mockFill).not.toHaveBeenCalled();
    expect(mockDeclined).toHaveBeenCalledWith(21, "amounts_undecodable");
  });

  it("DEFERS a sell whose signed transaction cannot be read", async () => {
    mockListCandidates.mockResolvedValue([sellRow()]);

    const result = await repairMissingExecutedAmounts(deps({ logs: sellLogs, transactions: {} }));

    expect(result).toMatchObject({ deferred: 1, declined: 0, filled: 0 });
    expect(mockDeclined).not.toHaveBeenCalled();
    expect(mockNoteVersion).not.toHaveBeenCalled();
  });

  it("declines when the mined transaction's value is above the quoted input", async () => {
    mockListCandidates.mockResolvedValue([trenchBuyRow()]);

    await repairMissingExecutedAmounts(deps({
      logs: boughtLogs(1_000n),
      transactions: { [DEPOSIT_HASH]: { from: WALLET, to: DIAMOND, input: "0x", valueRaw: "600000000000000" } },
    }));

    expect(mockFill).not.toHaveBeenCalled();
    expect(mockDeclined).toHaveBeenCalledWith(21, "amounts_undecodable");
  });

  it("declines when the persisted declared value disagrees with the mined transaction", async () => {
    mockListCandidates.mockResolvedValue([trenchBuyRow({
      routeProvenance: {
        settlementDecode: {
          v: 1, decoder: "trench_trade", chainId: 4663,
          routerAddress: DIAMOND, declaredValueRaw: "400000000000000",
        },
      },
    })]);

    await repairMissingExecutedAmounts(deps({
      logs: boughtLogs(1_000n),
      transactions: { [DEPOSIT_HASH]: { from: WALLET, to: DIAMOND, input: "0x", valueRaw: "500000000000000" } },
    }));

    expect(mockFill).not.toHaveBeenCalled();
    expect(mockDeclined).toHaveBeenCalledWith(21, "amounts_undecodable");
  });

  it("DEFERS a buy whose signed transaction cannot be read", async () => {
    mockListCandidates.mockResolvedValue([trenchBuyRow()]);

    const result = await repairMissingExecutedAmounts(deps({
      logs: boughtLogs(1_000n),
      transactions: {},
    }));

    expect(result).toMatchObject({ deferred: 1 });
    expect(mockNoteVersion).not.toHaveBeenCalled();
  });

  it("declines a sell the receipt does not prove both legs of", async () => {
    mockListCandidates.mockResolvedValue([sellRow()]);

    await repairMissingExecutedAmounts(deps({
      logs: [transferLog(WALLET, DIAMOND, 900_000n)],
      transactions: { [DEPOSIT_HASH]: { from: WALLET, to: DIAMOND, input: "0x", valueRaw: "0" } },
    }));

    expect(mockFill).not.toHaveBeenCalled();
    expect(mockDeclined).toHaveBeenCalledWith(21, "amounts_undecodable");
  });
});
