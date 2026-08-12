/**
 * khalani.bridge - what the confirmed DEPOSIT leg declares it moved.
 *
 * PERMIT2 is blocked in the planner, so the live variants are the Vex-built
 * `TRANSFER` and the provider `CONTRACT_CALL`. Both prove their ERC-20 amount
 * from the RECEIPT: Vex-built calldata narrows which log is ours, but it cannot
 * promise the token emitted the standard `Transfer` the amount must be read
 * from. A Vex-built NATIVE transfer is proven by the value Vex signed. Anything
 * else confirms without amounts and records the decline by name.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { planKhalaniDepositLegs } from "@tools/khalani/bridge-executor.js";
import type { KhalaniChain } from "@tools/khalani/types.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const TOKEN = "0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31";
const DEPOSITORY = "0x2222222222222222222222222222222222222222";
const STRANGER = "0x3333333333333333333333333333333333333333";
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

const CHAIN: KhalaniChain = { id: 8453, name: "Base", type: "eip155" } as KhalaniChain;

const mockSignStage = vi.fn();
vi.mock("@tools/khalani/bridge-executor.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  signStageKhalaniLeg: (...a: unknown[]) => mockSignStage(...a),
}));

const mockConfirm = vi.fn();
const mockFill = vi.fn(async (..._a: unknown[]) => ({ outcome: "applied" }));
const mockDecline = vi.fn(async (..._a: unknown[]) => ({ applied: true }));
vi.mock("@vex-agent/db/repos/agent-activity.js", async (importOriginal) => ({
  confirmActivityEvent: (...a: unknown[]) => mockConfirm(...a),
  fillExecutedAmountsOnConfirmed: (...a: unknown[]) => mockFill(...a),
  noteSettlementDeclined: (...a: unknown[]) => mockDecline(...a),
  provenLegAmounts: (await importOriginal<Record<string, unknown>>()).provenLegAmounts,
  failActivityEvent: async () => undefined,
}));

vi.mock("../../../../vex-agent/tools/protocols/khalani/handlers/bridge-execute/staging.js", () => ({
  khalaniStageHooksFor: () => ({ onHashStaged: async () => undefined, onAccepted: async () => undefined }),
}));

const { runKhalaniBridgeLegs } = await import(
  "@vex-agent/tools/protocols/khalani/handlers/bridge-execute/legs.js"
);

const DEPOSIT_ROW_ID = 42;

function transferPlanLegs(token: string, amount: string) {
  return planKhalaniDepositLegs(
    { kind: "TRANSFER", depositAddress: DEPOSITORY, amount, token, chainId: 8453 },
    CHAIN,
  );
}

function contractCallPlanLegs(approvals: unknown[] = []) {
  return planKhalaniDepositLegs(
    {
      kind: "CONTRACT_CALL",
      approvals: [...approvals, {
        type: "eip1193_request",
        deposit: true,
        request: { method: "eth_sendTransaction", params: [{ to: DEPOSITORY, data: "0xabcdef" }] },
      }] as never,
    },
    CHAIN,
  );
}

/** `approve(spender, 2^256-1)` on `token` - the approval leg of a CONTRACT_CALL plan. */
function approvalOf(token: string, spender: string, amount = (1n << 256n) - 1n) {
  return {
    type: "eip1193_request",
    request: {
      method: "eth_sendTransaction",
      params: [{
        to: token,
        data: `0x095ea7b3${padded(spender).slice(2)}${amount.toString(16).padStart(64, "0")}`,
      }],
    },
  };
}

async function runLoop(args: {
  stagedLegs: ReturnType<typeof transferPlanLegs>;
  logs: ReadonlyArray<{ address: string; topics: string[]; data: string }> | null;
  quotedAmountRaw?: string;
  fromToken?: string;
}) {
  mockSignStage.mockResolvedValue({
    kind: "confirmed", txHash: "0xhash", settledAtBlock: 12n, receiptLogs: args.logs,
  });
  return runKhalaniBridgeLegs({
    executionId: 1,
    stagedLegs: args.stagedLegs,
    bridgeLegCount: args.stagedLegs.length,
    // One row per planned leg, in order: the deposit is always the last.
    intentLegs: args.stagedLegs.map((leg, index) => (
      leg.isDeposit
        ? { id: DEPOSIT_ROW_ID, eventRole: "bridge_deposit" }
        : { id: 900 + index, eventRole: "allowance" }
    )) as never,
    sourceChain: CHAIN,
    fromToken: args.fromToken ?? TOKEN,
    quotedAmountRaw: args.quotedAmountRaw ?? "1000000",
    chains: [CHAIN],
    signer: { family: "eip155", address: WALLET, privateKey: `0x${"ab".repeat(32)}` } as never,
    fromChainId: 8453,
    fromChainName: "base",
    sessionId: "s1",
    params: {},
    pendingBase: {} as never,
    recordedLegs: [],
  });
}

describe("khalani.bridge deposit amounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockResolvedValue({ applied: true, row: { status: "confirmed", txHash: "0xhash" } });
    mockFill.mockResolvedValue({ outcome: "applied" });
    mockDecline.mockResolvedValue({ applied: true });
  });

  it("declares a Vex-built TRANSFER's amount from the receipt log that matches the plan", async () => {
    const run = await runLoop({
      stagedLegs: transferPlanLegs(TOKEN, "1000000"),
      logs: [transferLog(WALLET, DEPOSITORY, 1_000_000n)],
    });
    expect(run.outcome).toBe("confirmed");
    expect(mockConfirm).toHaveBeenCalledWith(DEPOSIT_ROW_ID, { executedAmountInRaw: "1000000" });
    expect(mockDecline).not.toHaveBeenCalled();
  });

  it("declines a Vex-built TRANSFER whose token emitted no standard Transfer log", async () => {
    await runLoop({ stagedLegs: transferPlanLegs(TOKEN, "1000000"), logs: [] });
    expect(mockConfirm).toHaveBeenCalledWith(DEPOSIT_ROW_ID, {});
    expect(mockDecline).toHaveBeenCalledWith(DEPOSIT_ROW_ID, "amounts_undecodable");
  });

  it("declines a Vex-built TRANSFER whose only log paid a stranger", async () => {
    await runLoop({
      stagedLegs: transferPlanLegs(TOKEN, "1000000"),
      logs: [transferLog(WALLET, STRANGER, 1_000_000n)],
    });
    expect(mockDecline).toHaveBeenCalledWith(DEPOSIT_ROW_ID, "amounts_undecodable");
  });

  it("takes a fee-on-transfer shortfall while one candidate remains", async () => {
    await runLoop({
      stagedLegs: transferPlanLegs(TOKEN, "1000000"),
      logs: [transferLog(WALLET, STRANGER, 10_000n), transferLog(WALLET, DEPOSITORY, 990_000n)],
    });
    expect(mockConfirm).toHaveBeenCalledWith(DEPOSIT_ROW_ID, { executedAmountInRaw: "990000" });
  });

  it("stamps a native TRANSFER from the value Vex signed", async () => {
    await runLoop({
      stagedLegs: transferPlanLegs("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "7000"),
      logs: [],
    });
    expect(mockConfirm).toHaveBeenCalledWith(DEPOSIT_ROW_ID, { executedAmountInRaw: "7000" });
  });

  it("proves a CONTRACT_CALL deposit from the transfer into the call target", async () => {
    await runLoop({
      stagedLegs: contractCallPlanLegs(),
      logs: [transferLog(WALLET, DEPOSITORY, 800_000n)],
    });
    expect(mockConfirm).toHaveBeenCalledWith(DEPOSIT_ROW_ID, { executedAmountInRaw: "800000" });
  });

  it("declines a CONTRACT_CALL deposit whose transfer exceeds the quoted bound", async () => {
    await runLoop({
      stagedLegs: contractCallPlanLegs(),
      logs: [transferLog(WALLET, DEPOSITORY, 1_500_000n)],
    });
    expect(mockConfirm).toHaveBeenCalledWith(DEPOSIT_ROW_ID, {});
    expect(mockDecline).toHaveBeenCalledWith(DEPOSIT_ROW_ID, "amounts_undecodable");
  });

  it("admits a spender this bridge approved FOR THE INPUT TOKEN", async () => {
    await runLoop({
      stagedLegs: contractCallPlanLegs([approvalOf(TOKEN, STRANGER)]),
      logs: [transferLog(WALLET, STRANGER, 700_000n)],
    });
    expect(mockConfirm).toHaveBeenCalledWith(DEPOSIT_ROW_ID, { executedAmountInRaw: "700000" });
  });

  it("declines a transfer to a spender that was only approved for a DIFFERENT token", async () => {
    const otherToken = "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984";
    await runLoop({
      stagedLegs: contractCallPlanLegs([approvalOf(otherToken, STRANGER)]),
      logs: [transferLog(WALLET, STRANGER, 700_000n)],
    });
    expect(mockConfirm).toHaveBeenCalledWith(DEPOSIT_ROW_ID, {});
    expect(mockDecline).toHaveBeenCalledWith(DEPOSIT_ROW_ID, "amounts_undecodable");
  });

  it("declines a transfer above the spender's effective allowance", async () => {
    await runLoop({
      stagedLegs: contractCallPlanLegs([approvalOf(TOKEN, STRANGER, 500_000n)]),
      logs: [transferLog(WALLET, STRANGER, 700_000n)],
    });
    expect(mockConfirm).toHaveBeenCalledWith(DEPOSIT_ROW_ID, {});
    expect(mockDecline).toHaveBeenCalledWith(DEPOSIT_ROW_ID, "amounts_undecodable");
  });

  it("declines a spender whose allowance the plan reset to zero after granting it", async () => {
    await runLoop({
      stagedLegs: contractCallPlanLegs([
        approvalOf(TOKEN, STRANGER, 900_000n),
        approvalOf(TOKEN, STRANGER, 0n),
      ]),
      logs: [transferLog(WALLET, STRANGER, 700_000n)],
    });
    expect(mockConfirm).toHaveBeenCalledWith(DEPOSIT_ROW_ID, {});
    expect(mockDecline).toHaveBeenCalledWith(DEPOSIT_ROW_ID, "amounts_undecodable");
  });

  it("routes proven amounts through the late-fill CAS when a sweep confirmed the row first", async () => {
    mockConfirm.mockResolvedValue({ applied: false, row: { status: "confirmed", txHash: "0xhash" } });
    await runLoop({
      stagedLegs: transferPlanLegs(TOKEN, "1000000"),
      logs: [transferLog(WALLET, DEPOSITORY, 1_000_000n)],
    });
    expect(mockFill).toHaveBeenCalledWith({
      id: DEPOSIT_ROW_ID,
      expectedTxHash: "0xhash",
      expectedChainId: 8453,
      amounts: { executedAmountInRaw: "1000000" },
    });
  });
});
