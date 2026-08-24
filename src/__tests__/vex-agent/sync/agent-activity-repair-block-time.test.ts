/**
 * THE SETTLING BLOCK'S OWN TIME (migration 078), captured where the sweep
 * already has the receipt.
 *
 * Why this matters more than it looks: AgentScan compares the confirmation time
 * we report against the block time it reads itself, and strikes the install when
 * they differ by more than its tolerance — three strikes quarantine the whole
 * install. Our `confirmed_at` is the time we OBSERVED the settlement, so a sweep
 * that confirms after a restart is an honest row with a dishonest-looking clock.
 * The block time is the only anchor that cannot drift, and the receipt already
 * names the block it came from.
 *
 * The rules pinned here: the block time is read from the receipt's own block,
 * a block we cannot read costs the report its precision and NOTHING else (the
 * row still terminalizes), and the write happens only after the confirm
 * actually applied.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  observeEvmTransaction,
  type JsonRpcClient,
} from "@vex-agent/sync/agent-activity-repair/observation.js";

const INPUT = {
  chainId: 8453,
  txHash: "0x24501ef985a280e3c1a81526264dac1cb950ba437a83d9143c25dc55aab83415",
  fromAddress: "0x1111111111111111111111111111111111111111",
  nonce: 7,
};

/** A node that answers a mined receipt, and whatever `blockAnswer` says for the block. */
function nodeWith(blockAnswer: unknown, receipt: unknown = { status: "0x1", blockNumber: "0x1a2b3c" }): {
  client: JsonRpcClient;
  methods: string[];
} {
  const methods: string[] = [];
  const client: JsonRpcClient = {
    request: async (args) => {
      methods.push(args.method);
      if (args.method === "eth_getTransactionReceipt") return receipt;
      if (args.method === "eth_getBlockByNumber") {
        if (blockAnswer instanceof Error) throw blockAnswer;
        return blockAnswer;
      }
      return null;
    },
  };
  return { client, methods };
}

describe("observation — the settling block's time", () => {
  it("reads the timestamp of the receipt's OWN block", async () => {
    const blockSeconds = Math.floor(Date.parse("2026-08-12T09:15:28.000Z") / 1000);
    const { client, methods } = nodeWith({ timestamp: `0x${blockSeconds.toString(16)}` });
    const observation = await observeEvmTransaction(client, INPUT);

    expect(observation.kind).toBe("mined");
    if (observation.kind !== "mined") throw new Error("unreachable");
    expect(observation.status).toBe("success");
    expect(observation.blockTimeIso).toBe("2026-08-12T09:15:28.000Z");
    expect(methods).toEqual(["eth_getTransactionReceipt", "eth_getBlockByNumber"]);
  });

  it("still terminalizes when the block cannot be read", async () => {
    for (const answer of [null, {}, { timestamp: "not-a-quantity" }, new Error("rpc down")]) {
      const { client } = nodeWith(answer);
      const observation = await observeEvmTransaction(client, INPUT);
      expect(observation.kind).toBe("mined");
      if (observation.kind !== "mined") throw new Error("unreachable");
      expect(observation.status).toBe("success");
      expect(observation.blockTimeIso).toBeNull();
    }
  });

  it("asks for no block when the receipt names none", async () => {
    const { client, methods } = nodeWith({ timestamp: "0x1" }, { status: "0x1" });
    const observation = await observeEvmTransaction(client, INPUT);
    expect(observation).toEqual({ kind: "mined", status: "success", blockTimeIso: null });
    expect(methods).toEqual(["eth_getTransactionReceipt"]);
  });

  it("spends no block lookup on a receipt it could not read at all", async () => {
    const { client, methods } = nodeWith({ timestamp: "0x1" }, { status: "0x7" });
    const observation = await observeEvmTransaction(client, INPUT);
    expect(observation).toEqual({ kind: "unreadable_receipt" });
    expect(methods).toEqual(["eth_getTransactionReceipt"]);
  });
});

const mockConfirmStatusOnly = vi.fn();
const mockNoteSettledBlockTime = vi.fn();

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  claimDuePendingEvm: vi.fn(),
  confirmActivityEventStatusOnly: (...args: unknown[]) => mockConfirmStatusOnly(...args),
  noteSettledBlockTime: (...args: unknown[]) => mockNoteSettledBlockTime(...args),
  failActivityEvent: vi.fn(),
  touchLastChecked: vi.fn(),
  clearVerificationStall: vi.fn(),
  notePendingReason: vi.fn(),
  noteNonInclusionObserved: vi.fn(),
  clearNonInclusionClock: vi.fn(),
  markSupersededUnproven: vi.fn(),
  releaseEvmClaim: vi.fn(),
  nextEvmCheckInMs: () => 5_000,
  EVM_CLAIM_LEASE_MS: 30_000,
}));

vi.mock("@utils/logger.js", () => {
  const stub = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
  return { default: stub, logger: stub };
});

const { resolveEvmPendingRow } = await import("@vex-agent/sync/agent-activity-repair.js");

const ROW = {
  id: 42,
  chainId: 8453,
  txHash: INPUT.txHash,
  eventRole: "swap" as const,
  fromAddress: INPUT.fromAddress,
  nonce: 7,
  submitAttemptedAt: new Date(0).toISOString(),
  // The lane reads it only to settle a LINKED wallet transaction intent; this
  // row has none, so the settlement is a no-op lookup.
  protocolExecutionId: 1,
};

async function resolveWith(blockTimeIso: string | null): Promise<void> {
  await resolveEvmPendingRow(
    ROW,
    { observeTransaction: async () => ({ kind: "mined", status: "success", blockTimeIso }) },
    { claimToken: "token-1", allowTerminalize: true },
  );
}

describe("the sweep records the block time it read", () => {
  beforeEach(() => {
    mockConfirmStatusOnly.mockReset();
    mockNoteSettledBlockTime.mockReset();
    mockConfirmStatusOnly.mockResolvedValue({ applied: true, row: { id: ROW.id } });
  });

  it("writes it after the confirm applied", async () => {
    await resolveWith("2026-08-12T09:15:28.000Z");
    expect(mockNoteSettledBlockTime).toHaveBeenCalledWith(42, "2026-08-12T09:15:28.000Z");
  });

  it("writes nothing when no block time was read", async () => {
    await resolveWith(null);
    expect(mockConfirmStatusOnly).toHaveBeenCalledTimes(1);
    expect(mockNoteSettledBlockTime).not.toHaveBeenCalled();
  });

  it("writes nothing when the confirm did not apply — someone else owns this row's outcome", async () => {
    mockConfirmStatusOnly.mockResolvedValue({
      applied: false,
      row: { id: ROW.id, status: "confirmed" },
      reason: "claim_lost",
    });
    await resolveWith("2026-08-12T09:15:28.000Z");
    expect(mockNoteSettledBlockTime).not.toHaveBeenCalled();
  });
});
