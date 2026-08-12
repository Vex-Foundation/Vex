/**
 * relay.bridge - what the confirmed origin DEPOSIT declares it moved.
 *
 * An ERC-20 route's executed amount comes from the receipt's `Transfer` logs and
 * from nothing else; a native route's comes from the value Vex itself signed; a
 * receipt that proves neither confirms the row WITHOUT amounts and records the
 * decline by name, so the row can still be reported instead of waiting forever.
 * The status-only race (a repair sweep confirmed the row first) routes the
 * proven amounts through the late-fill CAS.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const WALLET = "0x1111111111111111111111111111111111111111";
const TOKEN = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";
const DEPOSITORY = "0x2222222222222222222222222222222222222222";
const NATIVE = "0x0000000000000000000000000000000000000000";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function padded(address: string): string {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}
function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
function transferLog(from: string, to: string, amount: bigint, token = TOKEN) {
  return { address: token, topics: [TRANSFER_TOPIC, padded(from), padded(to)], data: word(amount) };
}

const mockPlanStepTx = vi.fn();
vi.mock("@tools/relay/execute.js", () => ({
  planRelayStepTx: (...a: unknown[]) => mockPlanStepTx(...a),
}));

const mockSign = vi.fn();
vi.mock("@tools/kyberswap/evm/staged-broadcast.js", () => ({
  signStageBroadcast: (...a: unknown[]) => mockSign(...a),
}));

const mockConfirm = vi.fn();
const mockFill = vi.fn(async (..._a: unknown[]) => ({ outcome: "applied" }));
const mockDecline = vi.fn(async (..._a: unknown[]) => ({ applied: true }));
vi.mock("@vex-agent/db/repos/agent-activity.js", async (importOriginal) => ({
  confirmActivityEvent: (...a: unknown[]) => mockConfirm(...a),
  fillExecutedAmountsOnConfirmed: (...a: unknown[]) => mockFill(...a),
  noteSettlementDeclined: (...a: unknown[]) => mockDecline(...a),
  // The real evidence matrix: the point of these assertions is WHICH amounts a
  // leg may claim, so stubbing it would test the stub.
  provenLegAmounts: (await importOriginal<Record<string, unknown>>()).provenLegAmounts,
  markActivityBroadcast: async () => ({ applied: true }),
  markBroadcastAccepted: async () => ({ applied: true }),
  failActivityEvent: async () => undefined,
}));

vi.mock("../../../../vex-agent/tools/protocols/relay/handlers/bridge/recording.js", () => ({
  abortRemaining: async () => undefined,
  attachRequestIdBestEffort: async () => undefined,
  maybeAutoPin: async () => undefined,
}));

const { runOriginBroadcasts } = await import(
  "@vex-agent/tools/protocols/relay/handlers/bridge/broadcast.js"
);

const DEPOSIT_ROW_ID = 200;

function legs(originCurrency: string) {
  return {
    originChainId: 8453,
    destinationChainId: 4663,
    originCurrency,
    destinationCurrency: NATIVE,
    amount: "1000000",
    requestedAmount: "1002500",
    feeSplit: { charged: true, bridgedRaw: 1_000_000n, totalRaw: 1_002_500n, feeRaw: 2_500n },
    feeSkipReason: null,
    tradeType: "EXACT_INPUT",
    slippageBps: 50,
  };
}

/** `approve(spender, amount)` calldata, as an approve step's tx would carry it. */
function approveCalldata(spender: string, amount = (1n << 256n) - 1n): string {
  return `0x095ea7b3${padded(spender).slice(2)}${amount.toString(16).padStart(64, "0")}`;
}

async function runDeposit(args: {
  originCurrency: string;
  logs: ReadonlyArray<{ address: string; topics: string[]; data: string }>;
  value?: bigint;
  /** Approve steps signed BEFORE the deposit, in order, with the token each approves. */
  approval?: { token: string; spender: string; amount?: bigint };
  approvals?: ReadonlyArray<{ token: string; spender: string; amount?: bigint }>;
}) {
  const depositTx = { to: DEPOSITORY, data: "0xdeadbeef", ...(args.value === undefined ? {} : { value: args.value }) };
  const approvals = args.approvals ?? (args.approval ? [args.approval] : []);
  for (const approval of approvals) {
    mockPlanStepTx.mockReturnValueOnce({
      to: approval.token,
      data: approveCalldata(approval.spender, approval.amount),
    });
  }
  mockPlanStepTx.mockReturnValue(depositTx);
  mockSign.mockResolvedValue({
    kind: "confirmed",
    txHash: "0xhash",
    receipt: { blockNumber: 12n, logs: args.logs },
  });
  return runOriginBroadcasts({
    signable: [
      ...approvals.map(() => ({ stepId: "approve", role: "allowance" as const, chainId: 8453, step: {} as never })),
      { stepId: "deposit", role: "bridge_deposit" as const, chainId: 8453, step: {} as never },
    ],
    legRows: [...approvals.map((_, index) => ({ id: 190 + index })), { id: DEPOSIT_ROW_ID }],
    logicalRowId: 300,
    executionId: 100,
    requestId: "req-1",
    legs: legs(args.originCurrency) as never,
    clients: { publicClient: {}, walletClient: {} } as never,
    expectedFrom: WALLET as `0x${string}`,
    walletAddress: WALLET,
    feeLegIndex: -1,
    from: {} as never,
    to: {} as never,
    feeNotTaken: {} as never,
    pending: () => ({ success: false, output: "pending" }),
  });
}

describe("relay.bridge deposit amounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockResolvedValue({ applied: true, row: { status: "confirmed", txHash: "0xhash" } });
    mockFill.mockResolvedValue({ outcome: "applied" });
    mockDecline.mockResolvedValue({ applied: true });
  });

  it("declares the ERC-20 amount its receipt proves", async () => {
    const run = await runDeposit({
      originCurrency: TOKEN,
      logs: [transferLog(WALLET, DEPOSITORY, 999_000n)],
    });
    expect(run.kind).toBe("confirmed");
    expect(mockConfirm).toHaveBeenCalledWith(DEPOSIT_ROW_ID, { executedAmountInRaw: "999000" });
    expect(mockDecline).not.toHaveBeenCalled();
  });

  it("declares the native value Vex signed, which IS the principal", async () => {
    const run = await runDeposit({ originCurrency: NATIVE, logs: [], value: 5_000n });
    expect(run.kind).toBe("confirmed");
    expect(mockConfirm).toHaveBeenCalledWith(DEPOSIT_ROW_ID, { executedAmountInRaw: "5000" });
  });

  it("declines an amount above the quote and records the decline by name", async () => {
    await runDeposit({
      originCurrency: TOKEN,
      logs: [transferLog(WALLET, DEPOSITORY, 1_000_001n)],
    });
    expect(mockConfirm).toHaveBeenCalledWith(DEPOSIT_ROW_ID, {});
    expect(mockDecline).toHaveBeenCalledWith(DEPOSIT_ROW_ID, "amounts_undecodable");
  });

  it("declines a transfer paid to somebody the bridge never authorized", async () => {
    await runDeposit({
      originCurrency: TOKEN,
      logs: [transferLog(WALLET, "0x3333333333333333333333333333333333333333", 900_000n)],
    });
    expect(mockConfirm).toHaveBeenCalledWith(DEPOSIT_ROW_ID, {});
    expect(mockDecline).toHaveBeenCalledWith(DEPOSIT_ROW_ID, "amounts_undecodable");
  });

  it("declines two indistinguishable candidate transfers", async () => {
    await runDeposit({
      originCurrency: TOKEN,
      logs: [transferLog(WALLET, DEPOSITORY, 400_000n), transferLog(WALLET, DEPOSITORY, 600_000n)],
    });
    expect(mockConfirm).toHaveBeenCalledWith(DEPOSIT_ROW_ID, {});
    expect(mockDecline).toHaveBeenCalledWith(DEPOSIT_ROW_ID, "amounts_undecodable");
  });

  it("admits a spender this bridge approved FOR THE ORIGIN CURRENCY", async () => {
    const spender = "0x4444444444444444444444444444444444444444";
    await runDeposit({
      originCurrency: TOKEN,
      approval: { token: TOKEN, spender },
      logs: [transferLog(WALLET, spender, 700_000n)],
    });
    expect(mockConfirm).toHaveBeenCalledWith(DEPOSIT_ROW_ID, { executedAmountInRaw: "700000" });
  });

  it("declines a transfer to a spender that was only approved for a DIFFERENT token", async () => {
    const spender = "0x4444444444444444444444444444444444444444";
    await runDeposit({
      originCurrency: TOKEN,
      approval: { token: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", spender },
      logs: [transferLog(WALLET, spender, 700_000n)],
    });
    expect(mockConfirm).toHaveBeenCalledWith(DEPOSIT_ROW_ID, {});
    expect(mockDecline).toHaveBeenCalledWith(DEPOSIT_ROW_ID, "amounts_undecodable");
  });

  it("declines a transfer above the spender's effective allowance", async () => {
    const spender = "0x4444444444444444444444444444444444444444";
    await runDeposit({
      originCurrency: TOKEN,
      approval: { token: TOKEN, spender, amount: 500_000n },
      logs: [transferLog(WALLET, spender, 700_000n)],
    });
    expect(mockConfirm).toHaveBeenCalledWith(DEPOSIT_ROW_ID, {});
    expect(mockDecline).toHaveBeenCalledWith(DEPOSIT_ROW_ID, "amounts_undecodable");
  });

  it("declines a spender whose allowance was reset to zero after the grant", async () => {
    const spender = "0x4444444444444444444444444444444444444444";
    await runDeposit({
      originCurrency: TOKEN,
      approvals: [
        { token: TOKEN, spender, amount: 900_000n },
        { token: TOKEN, spender, amount: 0n },
      ],
      logs: [transferLog(WALLET, spender, 700_000n)],
    });
    expect(mockConfirm).toHaveBeenCalledWith(DEPOSIT_ROW_ID, {});
    expect(mockDecline).toHaveBeenCalledWith(DEPOSIT_ROW_ID, "amounts_undecodable");
  });

  it("routes proven amounts through the late-fill CAS when a sweep confirmed the row first", async () => {
    mockConfirm.mockResolvedValue({ applied: false, row: { status: "confirmed", txHash: "0xhash" } });
    await runDeposit({
      originCurrency: TOKEN,
      logs: [transferLog(WALLET, DEPOSITORY, 999_000n)],
    });
    expect(mockFill).toHaveBeenCalledWith({
      id: DEPOSIT_ROW_ID,
      expectedTxHash: "0xhash",
      expectedChainId: 8453,
      amounts: { executedAmountInRaw: "999000" },
    });
  });

  it("does not late-fill a row that is not confirmed", async () => {
    mockConfirm.mockResolvedValue({ applied: false, row: { status: "pending", txHash: "0xhash" } });
    await runDeposit({
      originCurrency: TOKEN,
      logs: [transferLog(WALLET, DEPOSITORY, 999_000n)],
    });
    expect(mockFill).not.toHaveBeenCalled();
  });
});
